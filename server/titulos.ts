import { Router, type Request } from 'express';
import Decimal from 'decimal.js';
import { z } from 'zod';
import { masterPool as pool, transacao, hojeSql } from './db.js';
import { falha, rota, rotaModulo } from './http.js';
import type { SessionData } from './session.js';
import {
  LADOS, ladoDe, empresaDe, usuarioDe, parametros, contaParam, exigir, conferirPeriodo, auditar, pessoaDaEmpresa,
  conferirClassificacao, somarDias, type Db, type Lado,
} from './comum.js';
import { distribuir, fecha100 } from './rateio.js';
import { totalDoDia, diasAtraso } from './calculo.js';
import { instruirBoletos, processarAgora } from './eventos.js';

/**
 * Títulos e parcelas a receber e a pagar (um serviço só, parametrizado pelo lado; tabelas em comum.ts/LADOS).
 * Todo título nasce com rateio completo (conta analítica + centro analítico, 100%) e a soma das parcelas = total.
 */

export const dataZ = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'data inválida (aaaa-mm-dd)');
export const dinheiroZ = z.union([z.string(), z.number()]).transform(String).refine((v) => /^\d{1,13}(\.\d{1,2})?$/.test(v) && Number(v) > 0, 'valor inválido');
export const pctZ = z.union([z.string(), z.number()]).transform(String).refine((v) => /^\d{1,3}(\.\d{1,4})?$/.test(v) && Number(v) > 0 && Number(v) <= 100, 'percentual inválido');
export const idZ = z.coerce.number().int().positive();
export const textoZ = (max: number) => z.string().trim().max(max).nullish().transform((v) => v || null);

const schemaTitulo = z.object({
  pessoa_id: idZ,
  origem: z.enum(['venda', 'compra', 'avulsa', 'recorrente', 'renegociacao', 'adiantamento', 'cartao_adquirente']).default('avulsa'),
  origem_id: idZ.nullish(),
  numero_documento: textoZ(60),
  data_emissao: dataZ,
  data_competencia: dataZ.nullish(),
  valor_total: dinheiroZ,
  historico: textoZ(255),
  observacoes: textoZ(5000),
  provisorio: z.union([z.boolean(), z.number()]).nullish().transform((v) => (v ? 1 : 0)),
  rateios: z.array(z.object({ plano_conta_id: idZ, centro_custo_id: idZ, percentual: pctZ })).default([]),
  parcelas: z.array(z.object({
    vencimento: dataZ,
    valor: dinheiroZ,
    documento: textoZ(60),
    forma_pagamento: textoZ(30),
    forma_pagamento_id: idZ.nullish(),
    conta_financeira_id: idZ.nullish(),
    origem_parcela_id: idZ.nullish(),
    linha_digitavel: textoZ(60),
    codigo_barras: z.string().regex(/^\d{44}$/, 'código de barras com 44 dígitos').nullish(),
    pix_copia_cola: textoZ(500),
  })).min(1, 'Informe ao menos uma parcela.').max(360),
});
export type DadosTitulo = z.input<typeof schemaTitulo>;

/** Lê o corpo com o schema: a primeira mensagem vai para o usuário */
export function validar<T extends z.ZodTypeAny>(schema: T, corpo: unknown): z.output<T> {
  const r = schema.safeParse(corpo);
  if (!r.success) {
    const e = r.error.issues[0];
    falha(`${e.path.join('.') || 'dados'}: ${e.message}`);
  }
  return (r as z.SafeParseSuccess<z.output<T>>).data;
}

// ------------------------------------------------------------------ origem: venda e nota de entrada

/** Título a receber montado da venda (ven_vendas + ven_venda_parcelas): o erp-vendas só manda o id */
async function deVenda(db: Db, empresa: number, vendaId: number): Promise<DadosTitulo> {
  const [[v]]: any = await db.query('SELECT id, numero, pessoa_id, data_emissao, valor_total, status FROM ven_vendas WHERE id = ? AND empresa_id = ?', [vendaId, empresa]);
  if (!v) falha('Venda não encontrada nesta empresa.', 404);
  if (v.status === 'cancelada' || v.status === 'rejeitada') falha(`Venda ${v.numero} ${v.status}: não gera título.`);
  if (!v.pessoa_id) falha(`Venda ${v.numero} sem cliente.`);
  // "Sem pagamento" (tPag 90, NFC-e dos 180 dias) não é conta a receber
  const [ps]: any = await db.query("SELECT id, numero, vencimento, forma_pagamento, valor FROM ven_venda_parcelas WHERE venda_id = ? AND forma_pagamento <> 'Sem pagamento' ORDER BY numero", [vendaId]);
  if (!ps.length) falha(`Venda ${v.numero} sem parcelas a receber.`);
  return {
    pessoa_id: v.pessoa_id, origem: 'venda', origem_id: v.id, numero_documento: `Venda ${v.numero}`,
    data_emissao: String(v.data_emissao).slice(0, 10), valor_total: ps.reduce((a: Decimal, p: any) => a.plus(p.valor), new Decimal(0)).toFixed(2),
    historico: `Venda ${v.numero}`,
    parcelas: ps.map((p: any) => ({ vencimento: String(p.vencimento).slice(0, 10), valor: String(p.valor), documento: `${v.numero}/${p.numero}`, forma_pagamento: p.forma_pagamento, origem_parcela_id: p.id })),
  };
}

/** Título a pagar montado da nota de entrada lançada (com_entradas + com_entrada_parcelas, duplicatas) */
async function deEntrada(db: Db, empresa: number, entradaId: number): Promise<DadosTitulo> {
  const [[n]]: any = await db.query('SELECT id, numero, numero_nf, serie, pessoa_id, data_emissao, data_entrada, status FROM com_entradas WHERE id = ? AND empresa_id = ?', [entradaId, empresa]);
  if (!n) falha('Nota de entrada não encontrada nesta empresa.', 404);
  if (n.status !== 'lancada') falha(`Nota ${n.numero_nf ?? n.numero} não está lançada (${n.status}).`);
  if (!n.pessoa_id) falha(`Nota ${n.numero_nf ?? n.numero} sem fornecedor.`);
  const [ps]: any = await db.query('SELECT id, numero, documento, vencimento, forma_pagamento, valor FROM com_entrada_parcelas WHERE entrada_id = ? ORDER BY numero', [entradaId]);
  if (!ps.length) falha(`Nota ${n.numero_nf ?? n.numero} sem duplicatas.`);
  const doc = n.numero_nf ? `NF ${n.numero_nf}${n.serie ? `-${n.serie}` : ''}` : `Entrada ${n.numero}`;
  return {
    pessoa_id: n.pessoa_id, origem: 'compra', origem_id: n.id, numero_documento: doc,
    data_emissao: String(n.data_emissao).slice(0, 10), data_competencia: String(n.data_entrada ?? n.data_emissao).slice(0, 10),
    valor_total: ps.reduce((a: Decimal, p: any) => a.plus(p.valor), new Decimal(0)).toFixed(2), historico: doc,
    parcelas: ps.map((p: any) => ({ vencimento: String(p.vencimento).slice(0, 10), valor: String(p.valor), documento: p.documento || `${doc}/${p.numero}`, forma_pagamento: p.forma_pagamento, origem_parcela_id: p.id })),
  };
}

// ------------------------------------------------------------------ serviço

export async function atualizarStatusTitulo(db: Db, lado: Lado, tituloId: number) {
  const L = LADOS[lado];
  const [[r]]: any = await db.query(
    `SELECT SUM(status IN ('aberta','parcial','quitada')) vivas, SUM(status = 'quitada') quitadas,
            SUM(status IN ('parcial','quitada')) mexidas, SUM(status = 'renegociada') reneg
       FROM ${L.parcelas} WHERE titulo_id = ?`,
    [tituloId],
  );
  const vivas = Number(r.vivas || 0);
  const status = !vivas ? (Number(r.reneg) ? 'renegociado' : 'cancelado') : Number(r.quitadas) === vivas ? 'quitado' : Number(r.mexidas) ? 'parcial' : 'aberto';
  await db.query(`UPDATE ${L.titulos} SET status = ? WHERE id = ?`, [status, tituloId]);
}

/** Forma de pagamento pelo id ou pelo texto da venda/compra (mesmo nome em fin_formas_pagamento) */
async function formaDe(db: Db, empresa: number, id?: number | null, nome?: string | null): Promise<any> {
  if (id) {
    const [[f]]: any = await db.query('SELECT * FROM fin_formas_pagamento WHERE id = ? AND empresa_id = ?', [id, empresa]);
    return f ?? falha('Forma de pagamento não encontrada.');
  }
  if (!nome) return null;
  const [[f]]: any = await db.query('SELECT * FROM fin_formas_pagamento WHERE empresa_id = ? AND nome = ? AND ativo = 1', [empresa, nome]);
  return f ?? null;
}

/**
 * Cria o título com rateio e parcelas. Idempotente pela origem: a mesma venda/nota devolve o título que já existe.
 * Precisa de transação aberta (c).
 */
export async function criarTitulo(c: Db, s: SessionData, req: Request | null, lado: Lado, corpo: unknown): Promise<{ id: number; existente: boolean }> {
  const L = LADOS[lado];
  const empresa = empresaDe(s);
  const b: any = corpo ?? {};
  const origemDoc = lado === 'receber' ? b.venda_id : b.entrada_id;
  const bruto = origemDoc ? await (lado === 'receber' ? deVenda(c, empresa, Number(origemDoc)) : deEntrada(c, empresa, Number(origemDoc))) : b;
  if (origemDoc && Array.isArray(b.rateios)) bruto.rateios = b.rateios;
  const d = validar(schemaTitulo, bruto);
  if (d.origem === (lado === 'receber' ? 'compra' : 'venda') || (lado === 'pagar' && d.origem === 'cartao_adquirente')) falha(`Origem ${d.origem} não vale para contas ${L.nome}.`);
  if ((d.origem === 'venda' || d.origem === 'compra') && !d.origem_id) falha('Informe origem_id.');

  // Idempotência: (empresa, origem, origem_id) é único
  if (d.origem_id) {
    const [[ja]]: any = await c.query(`SELECT id FROM ${L.titulos} WHERE empresa_id = ? AND origem = ? AND origem_id = ? FOR UPDATE`, [empresa, d.origem, d.origem_id]);
    if (ja) return { id: ja.id, existente: true };
  }

  const competencia = d.data_competencia ?? d.data_emissao;
  await conferirPeriodo(c, s, competencia);
  await pessoaDaEmpresa(c, empresa, d.pessoa_id);
  const p = await parametros(c, empresa);

  const total = new Decimal(d.valor_total);
  const somaParcelas = d.parcelas.reduce((a, x) => a.plus(x.valor), new Decimal(0));
  if (!somaParcelas.eq(total)) falha(`Soma das parcelas (${somaParcelas.toFixed(2)}) diferente do total (${total.toFixed(2)}).`);

  // Rateio: o que veio, ou a conta padrão da operação + centro padrão
  const rateios = d.rateios.length
    ? d.rateios
    : [{ plano_conta_id: contaParam(p, L.contaPadrao, lado === 'receber' ? 'Receita de vendas' : 'Compras'), centro_custo_id: contaParam(p, 'centro_custo_padrao_id', 'Centro de custo padrão'), percentual: '100' }];
  if (!fecha100(rateios.map((r) => r.percentual))) falha('O rateio precisa somar exatamente 100%.');
  for (const r of rateios) await conferirClassificacao(c, empresa, r.plano_conta_id, r.centro_custo_id);

  const [[pf]]: any = await c.query('SELECT multa_pct, juros_mes_pct, carencia_dias FROM fin_pessoas_financeiro WHERE empresa_id = ? AND pessoa_id = ?', [empresa, d.pessoa_id]);
  const usuario = usuarioDe(s);
  const fkDoc = d.origem === L.origemDoc ? d.origem_id : null;
  const [ti]: any = await c.query(`INSERT INTO ${L.titulos} SET ?`, [{
    empresa_id: empresa, pessoa_id: d.pessoa_id, origem: d.origem, origem_id: d.origem_id ?? null, [L.fkDoc]: fkDoc,
    numero_documento: d.numero_documento, data_emissao: d.data_emissao, data_competencia: competencia, valor_total: total.toFixed(2),
    historico: d.historico, observacoes: d.observacoes, provisorio: d.provisorio, usuario_id: usuario,
  }]).catch((e: any) => (e?.code === 'ER_DUP_ENTRY' ? falha('Título desta origem já existe (gravado agora por outra chamada): repita.', 409) : Promise.reject(e)));
  const tituloId = Number(ti.insertId);

  const valores = distribuir(total, rateios.map((r) => r.percentual));
  for (const [i, r] of rateios.entries()) {
    await c.query(`INSERT INTO ${L.rateios} SET ?`, [{ titulo_id: tituloId, plano_conta_id: r.plano_conta_id, centro_custo_id: r.centro_custo_id, percentual: r.percentual, valor: valores[i] }])
      .catch((e: any) => (e?.code === 'ER_DUP_ENTRY' ? falha('Rateio com a mesma conta e centro de custo repetidos.') : Promise.reject(e)));
  }

  const limiteAprovacao = p.valor_aprovacao_pagamento == null ? null : new Decimal(p.valor_aprovacao_pagamento);
  for (const [i, x] of d.parcelas.entries()) {
    const forma = await formaDe(c, empresa, x.forma_pagamento_id, x.forma_pagamento);
    const desconto = new Decimal(p.desconto_pct || 0).gt(0);
    await c.query(`INSERT INTO ${L.parcelas} SET ?`, [{
      empresa_id: empresa, titulo_id: tituloId, numero: i + 1, total_parcelas: d.parcelas.length, documento: x.documento,
      [L.fkDocParcela]: fkDoc ? x.origem_parcela_id ?? null : null,
      vencimento: x.vencimento, vencimento_original: x.vencimento,
      [L.dataPrevista]: lado === 'receber' ? somarDias(x.vencimento, Number(forma?.dias_credito || 0)) : x.vencimento,
      valor_original: x.valor, saldo: x.valor,
      multa_pct: pf?.multa_pct ?? p.multa_pct, juros_mes_pct: pf?.juros_mes_pct ?? p.juros_mes_pct, carencia_dias: pf?.carencia_dias ?? p.carencia_dias,
      desconto_pct: desconto ? p.desconto_pct : 0, desconto_ate: desconto ? somarDias(x.vencimento, -Number(p.desconto_dias || 0)) : null,
      forma_pagamento_id: forma?.id ?? null, forma_pagamento: x.forma_pagamento ?? forma?.nome ?? null,
      conta_financeira_id: x.conta_financeira_id ?? forma?.conta_financeira_id ?? null,
      ...(lado === 'pagar'
        ? { linha_digitavel: x.linha_digitavel, codigo_barras: x.codigo_barras ?? null, pix_copia_cola: x.pix_copia_cola,
            aprovacao_status: limiteAprovacao && new Decimal(x.valor).gt(limiteAprovacao) ? 'pendente' : 'nao_requer' }
        : {}),
      usuario_id: usuario,
    }]);
  }
  await auditar(c, s, req, L.titulos, tituloId, 'criar', null, { ...d, rateios, data_competencia: competencia });
  return { id: tituloId, existente: false };
}

/** Parcelas com baixa ativa impedem cancelar: a lista volta na mensagem */
export async function cancelarTitulo(c: Db, s: SessionData, req: Request | null, lado: Lado, tituloId: number, motivo: string | null, desfazendo = false) {
  const L = LADOS[lado];
  const [[t]]: any = await c.query(`SELECT * FROM ${L.titulos} WHERE id = ? AND empresa_id = ? FOR UPDATE`, [tituloId, empresaDe(s)]);
  if (!t) falha('Título não encontrado.', 404);
  if (t.origem === 'renegociacao' && !desfazendo) falha('Título de renegociação: use Desfazer renegociação (as parcelas originais voltam).');
  if (t.status === 'cancelado') return { id: t.id, jaCancelado: true };
  const [ps]: any = await c.query(`SELECT id, numero, total_parcelas, status, saldo, valor_original FROM ${L.parcelas} WHERE titulo_id = ? FOR UPDATE`, [tituloId]);
  const comBaixa = ps.filter((p: any) => p.status === 'parcial' || p.status === 'quitada' || p.status === 'renegociada');
  if (comBaixa.length) {
    falha(`Título com parcelas baixadas: ${comBaixa.map((p: any) => `${p.numero}/${p.total_parcelas} (${p.status})`).join(', ')}. Estorne as baixas antes de cancelar.`, 409, 'parcelas_baixadas');
  }
  await conferirPeriodo(c, s, String(t.data_competencia));
  if (lado === 'receber') for (const p of ps.filter((x: any) => x.status === 'aberta')) await instruirBoletos(c, s, p.id, 'baixar');
  await c.query(`UPDATE ${L.parcelas} SET status = 'cancelada' WHERE titulo_id = ? AND status = 'aberta'`, [tituloId]);
  await c.query(`UPDATE ${L.titulos} SET status = 'cancelado', cancelado_em = NOW(), cancelado_por = ?, motivo_cancelamento = ? WHERE id = ?`, [usuarioDe(s), motivo, tituloId]);
  await auditar(c, s, req, L.titulos, tituloId, 'cancelar', { status: t.status }, { status: 'cancelado', motivo });
  return { id: t.id, cancelado: true };
}

// ------------------------------------------------------------------ consultas

/** Parcelas para as listas de contas a receber/pagar, com atraso e total do dia das abertas */
async function listarParcelas(s: SessionData, lado: Lado, q: any) {
  const L = LADOS[lado];
  const empresa = empresaDe(s);
  const hoje = await hojeSql(pool);
  const where = ['p.empresa_id = ?'];
  const params: unknown[] = [empresa];
  const situacao = String(q.situacao || 'abertas');
  if (situacao === 'abertas') where.push("p.status IN ('aberta','parcial')");
  else if (situacao === 'vencidas') where.push("p.status IN ('aberta','parcial') AND p.vencimento < ?"), params.push(hoje);
  else if (situacao === 'quitadas') where.push("p.status = 'quitada'");
  else if (situacao === 'canceladas') where.push("p.status IN ('cancelada','renegociada')");
  else if (situacao === 'aprovar' && lado === 'pagar') where.push("p.aprovacao_status = 'pendente' AND p.status IN ('aberta','parcial')");
  if (/^\d{4}-\d{2}-\d{2}$/.test(q.de || '')) where.push('p.vencimento >= ?'), params.push(q.de);
  if (/^\d{4}-\d{2}-\d{2}$/.test(q.ate || '')) where.push('p.vencimento <= ?'), params.push(q.ate);
  if (Number(q.pessoa)) where.push('t.pessoa_id = ?'), params.push(Number(q.pessoa));
  if (Number(q.titulo)) where.push('p.titulo_id = ?'), params.push(Number(q.titulo));
  const [linhas]: any = await pool.query(
    `SELECT p.*, t.pessoa_id, t.numero_documento, t.historico, t.origem, t.data_emissao, t.data_competencia, t.provisorio, t.status AS titulo_status,
            pe.nome AS pessoa_nome, pe.cpf_cnpj, fp.nome AS forma_nome, cf.nome AS conta_nome
       FROM ${L.parcelas} p
       JOIN ${L.titulos} t ON t.id = p.titulo_id
       JOIN cad_pessoas pe ON pe.id = t.pessoa_id
       LEFT JOIN fin_formas_pagamento fp ON fp.id = p.forma_pagamento_id
       LEFT JOIN fin_contas_financeiras cf ON cf.id = p.conta_financeira_id
      WHERE ${where.join(' AND ')}
      ORDER BY p.vencimento, p.id LIMIT 3000`,
    params,
  );
  return linhas.map((p: any) => {
    const aberta = p.status === 'aberta' || p.status === 'parcial';
    const base = Number(p.manter_encargos_original) ? p.vencimento_original : p.vencimento;
    return {
      ...p,
      dias_atraso: aberta ? diasAtraso(base, hoje, 0) : 0,
      total_dia: aberta ? totalDoDia({ saldo: p.saldo, vencimento: base, dataPagamento: hoje, carenciaDias: p.carencia_dias, multaPct: p.multa_pct, jurosMesPct: p.juros_mes_pct, descontoPct: p.desconto_pct, descontoAte: p.desconto_ate }) : '0.00',
    };
  });
}

async function detalheTitulo(s: SessionData, lado: Lado, id: number) {
  const L = LADOS[lado];
  const empresa = empresaDe(s);
  const [[t]]: any = await pool.query(
    `SELECT t.*, pe.nome AS pessoa_nome, pe.cpf_cnpj FROM ${L.titulos} t JOIN cad_pessoas pe ON pe.id = t.pessoa_id WHERE t.id = ? AND t.empresa_id = ?`,
    [id, empresa],
  );
  if (!t) falha('Título não encontrado.', 404);
  const [rateios]: any = await pool.query(
    `SELECT r.*, pc.codigo AS conta_codigo, pc.descricao AS conta_descricao, cc.codigo AS centro_codigo, cc.descricao AS centro_descricao
       FROM ${L.rateios} r JOIN fin_plano_contas pc ON pc.id = r.plano_conta_id JOIN fin_centros_custo cc ON cc.id = r.centro_custo_id
      WHERE r.titulo_id = ? ORDER BY r.id`,
    [id],
  );
  const parcelas = await listarParcelas(s, lado, { situacao: 'todas', titulo: id });
  const [baixas]: any = await pool.query(
    `SELECT b.*, p.numero AS parcela_numero, p.total_parcelas, cf.nome AS conta_nome, u.login AS usuario_login
       FROM ${L.baixas} b JOIN ${L.parcelas} p ON p.id = b.parcela_id
       LEFT JOIN fin_contas_financeiras cf ON cf.id = b.conta_financeira_id
       LEFT JOIN sys_usuarios u ON u.id = b.usuario_id
      WHERE p.titulo_id = ? ORDER BY b.id`,
    [id],
  );
  const ids = [id, ...parcelas.map((p: any) => p.id)];
  const [historico]: any = await pool.query(
    `SELECT a.id, a.entidade, a.entidade_id, a.acao, a.antes, a.depois, a.criado_em, u.login AS usuario_login
       FROM fin_auditoria a LEFT JOIN sys_usuarios u ON u.id = a.usuario_id
      WHERE a.empresa_id = ? AND ((a.entidade = ? AND a.entidade_id = ?) OR (a.entidade = ? AND a.entidade_id IN (?))
            OR (a.entidade = ? AND a.entidade_id IN (SELECT b.id FROM ${L.baixas} b WHERE b.parcela_id IN (?))))
      ORDER BY a.id`,
    [empresa, L.titulos, id, L.parcelas, ids, L.baixas, ids],
  );
  return { titulo: t, rateios, parcelas, baixas, historico };
}

/**
 * Situação da pessoa para o erp-vendas. Com `valor` (a venda a prazo pretendida) diz se pode vender e por quê não:
 * cadastro bloqueado, parcela vencida além da carência da empresa ou limite de crédito insuficiente.
 */
async function situacaoPessoa(s: SessionData, pessoaId: number, valor?: string) {
  const empresa = empresaDe(s);
  const p = await pessoaDaEmpresa(pool, empresa, pessoaId);
  const hoje = await hojeSql(pool);
  const [[r]]: any = await pool.query(
    `SELECT COALESCE(SUM(x.saldo), 0) AS saldo_aberto, COALESCE(MAX(GREATEST(DATEDIFF(?, x.vencimento), 0)), 0) AS maior_atraso,
            COALESCE(SUM(CASE WHEN x.vencimento < ? THEN x.saldo ELSE 0 END), 0) AS saldo_vencido
       FROM fin_receber_parcelas x JOIN fin_receber_titulos t ON t.id = x.titulo_id
      WHERE x.empresa_id = ? AND t.pessoa_id = ? AND x.status IN ('aberta','parcial') AND t.provisorio = 0`,
    [hoje, hoje, empresa, pessoaId],
  );
  const [[f]]: any = await pool.query('SELECT saldo_credito_receber, saldo_credito_pagar FROM fin_pessoas_financeiro WHERE empresa_id = ? AND pessoa_id = ?', [empresa, pessoaId]);
  const limite = p.limite_credito == null ? null : new Decimal(p.limite_credito);
  const carencia = Number((await parametros(pool, empresa))?.carencia_dias ?? 0);
  const disponivel = limite && limite.gt(0) ? Decimal.max(0, limite.minus(r.saldo_aberto)) : null;
  const motivos: string[] = [];
  if (Number(p.bloqueado)) motivos.push('Cliente bloqueado no cadastro.');
  if (Number(r.maior_atraso) > carencia) motivos.push(`Parcela vencida há ${r.maior_atraso} dia(s) (R$ ${new Decimal(r.saldo_vencido).toFixed(2).replace('.', ',')} em atraso).`);
  if (valor != null && disponivel && new Decimal(valor).gt(disponivel)) motivos.push(`Limite de crédito insuficiente: disponível R$ ${disponivel.toFixed(2).replace('.', ',')}.`);
  return {
    pessoa_id: pessoaId,
    saldo_aberto: new Decimal(r.saldo_aberto).toFixed(2),
    saldo_vencido: new Decimal(r.saldo_vencido).toFixed(2),
    maior_atraso: Number(r.maior_atraso),
    credito_disponivel: new Decimal(f?.saldo_credito_receber ?? 0).toFixed(2),
    adiantamento_fornecedor: new Decimal(f?.saldo_credito_pagar ?? 0).toFixed(2),
    limite_credito: limite ? limite.toFixed(2) : null,
    limite_disponivel: disponivel ? disponivel.toFixed(2) : null,
    bloqueado: !!Number(p.bloqueado),
    pode_vender_a_prazo: !motivos.length,
    motivos,
  };
}

// ------------------------------------------------------------------ rotas

const schemaProrrogar = z.object({ vencimento: dataZ, manter_encargos_original: z.union([z.boolean(), z.number()]).nullish().transform((v) => (v ? 1 : 0)), motivo: textoZ(255) });

export function createTitulosRouter() {
  const r = Router();

  r.get('/:lado/parcelas', rota(async (req, _res, s) => listarParcelas(s, ladoDe(req.params.lado), req.query)));
  r.get('/:lado/titulos/:id', rota(async (req, _res, s) => detalheTitulo(s, ladoDe(req.params.lado), Number(req.params.id))));

  // erp-vendas e erp-compras (chave de API) ou a tela (título avulso). Repetir a mesma origem devolve o existente (200)
  r.post('/:lado/titulos', rotaModulo(async (req, res, s) => {
    const lado = ladoDe(req.params.lado);
    const r = await transacao((c) => criarTitulo(c, s, req, lado, req.body));
    res.status(r.existente ? 200 : 201);
    return r;
  }));

  // { motivo?, simular? }: simular só diz se pode (200 { pode_cancelar }) ou recusa com as parcelas baixadas (409)
  r.post('/receber/titulos/venda/:id/cancelar', rotaModulo(async (req, _res, s) => cancelarPorOrigem(s, req, 'receber', 'venda', Number(req.params.id), req.body?.motivo, req.body?.simular === true)));
  r.post('/pagar/titulos/compra/:id/cancelar', rotaModulo(async (req, _res, s) => cancelarPorOrigem(s, req, 'pagar', 'compra', Number(req.params.id), req.body?.motivo, req.body?.simular === true)));

  r.post('/:lado/titulos/:id/cancelar', rota(async (req, _res, s) => {
    const lado = ladoDe(req.params.lado);
    const motivo = String(req.body?.motivo ?? '').trim();
    if (!motivo) falha('Informe o motivo do cancelamento.');
    const r = await transacao((c) => cancelarTitulo(c, s, req, lado, Number(req.params.id), motivo.slice(0, 255)));
    await processarAgora(s);
    return r;
  }));

  r.post('/:lado/parcelas/:id/prorrogar', rota(async (req, _res, s) => {
    const lado = ladoDe(req.params.lado);
    const L = LADOS[lado];
    const d = validar(schemaProrrogar, req.body);
    return transacao(async (c) => {
      const [[p]]: any = await c.query(`SELECT * FROM ${L.parcelas} WHERE id = ? AND empresa_id = ? FOR UPDATE`, [req.params.id, empresaDe(s)]);
      if (!p) falha('Parcela não encontrada.', 404);
      if (p.status !== 'aberta' && p.status !== 'parcial') falha(`Parcela ${p.status}: não pode ser prorrogada.`);
      await conferirPeriodo(c, s, d.vencimento);
      const venc = String(p.vencimento).slice(0, 10);
      const dias = Math.round((Date.parse(d.vencimento) - Date.parse(venc)) / 86_400_000);
      const novo: Record<string, unknown> = {
        vencimento: d.vencimento, manter_encargos_original: d.manter_encargos_original, prorrogado_por: usuarioDe(s),
        [L.dataPrevista]: p[L.dataPrevista] ? somarDias(String(p[L.dataPrevista]), dias) : d.vencimento,
      };
      if (p.desconto_ate) novo.desconto_ate = somarDias(String(p.desconto_ate), dias);
      // vencimento_original fica com o primeiro vencimento (gravado na emissão)
      await c.query(`UPDATE ${L.parcelas} SET ?, prorrogado_em = NOW() WHERE id = ?`, [novo, p.id]);
      await auditar(c, s, req, L.parcelas, p.id, 'prorrogar', { vencimento: venc, manter_encargos_original: p.manter_encargos_original }, { ...novo, motivo: d.motivo });
      if (lado === 'receber') await instruirBoletos(c, s, p.id, 'alterar_vencimento', { vencimento: d.vencimento });
    });
    await processarAgora(s);
  }));

  r.post('/pagar/parcelas/:id/aprovar', rota(async (req, _res, s) => {
    await exigir(s, 'aprovar');
    const aprovar = req.body?.aprovar !== false;
    return transacao(async (c) => {
      const [[p]]: any = await c.query("SELECT id, aprovacao_status, status FROM fin_pagar_parcelas WHERE id = ? AND empresa_id = ? FOR UPDATE", [req.params.id, empresaDe(s)]);
      if (!p) falha('Parcela não encontrada.', 404);
      if (p.aprovacao_status !== 'pendente') falha(`Parcela ${p.aprovacao_status === 'nao_requer' ? 'não requer aprovação' : p.aprovacao_status}.`);
      const status = aprovar ? 'aprovada' : 'reprovada';
      await c.query('UPDATE fin_pagar_parcelas SET aprovacao_status = ?, aprovado_em = NOW(), aprovado_por = ? WHERE id = ?', [status, usuarioDe(s), p.id]);
      await auditar(c, s, req, 'fin_pagar_parcelas', p.id, 'aprovar', { aprovacao_status: 'pendente' }, { aprovacao_status: status, motivo: req.body?.motivo ?? null });
    });
  }));

  r.get('/pessoas/:id/situacao', rotaModulo(async (req, _res, s) => {
    const valor = req.query.valor == null || req.query.valor === '' ? undefined : String(req.query.valor);
    if (valor != null && !/^\d+(\.\d{1,2})?$/.test(valor)) falha('valor inválido (use 1234.56).');
    return situacaoPessoa(s, Number(req.params.id), valor);
  }));

  r.post('/origens/sincronizar', rotaModulo(async (_req, _res, s) => sincronizarOrigens(s)));

  return r;
}

/** Simulado: cancela e desfaz (mesmas regras), para a origem saber antes de cancelar a nota/entrada se o título deixa */
class Simulado extends Error {}

async function cancelarPorOrigem(s: SessionData, req: Request | null, lado: Lado, origem: string, origemId: number, motivo: unknown, simular = false) {
  const L = LADOS[lado];
  try {
    return await transacao(async (c) => {
      const [[t]]: any = await c.query(`SELECT id FROM ${L.titulos} WHERE empresa_id = ? AND origem = ? AND origem_id = ?`, [empresaDe(s), origem, origemId]);
      if (!t) falha(`Nenhum título ${L.nome} para esta ${origem === 'venda' ? 'venda' : 'nota'}.`, 404);
      const r = await cancelarTitulo(c, s, req, lado, t.id, String(motivo ?? `Cancelamento da ${origem}`).slice(0, 255));
      if (simular) throw new Simulado();
      return r;
    });
  } catch (e) {
    if (e instanceof Simulado) return { pode_cancelar: true };
    throw e;
  } finally {
    if (!simular) await processarAgora(s);
  }
}

/**
 * Rede de segurança da integração (a venda/nota avisa na hora; se o financeiro estava fora, fica para cá): cria o título
 * da venda faturada / entrada lançada que não chegou e cancela o da venda cancelada / entrada estornada. Só olha a partir
 * da primeira venda/nota que já virou título nesta empresa (o que é de antes do financeiro não entra).
 */
export async function sincronizarOrigens(s: SessionData) {
  const empresa = empresaDe(s);
  const r = { criados: 0, cancelados: 0, erros: [] as string[] };
  const origens = [
    { lado: 'receber' as Lado, origem: 'venda', corpo: (id: number) => ({ venda_id: id }), nome: 'Venda',
      novas: `SELECT v.id, v.numero FROM ven_vendas v WHERE v.empresa_id = ? AND v.status = 'faturada' AND v.pessoa_id IS NOT NULL
                AND v.id >= (SELECT MIN(origem_id) FROM fin_receber_titulos WHERE empresa_id = ? AND origem = 'venda')
                AND EXISTS (SELECT 1 FROM ven_venda_parcelas x WHERE x.venda_id = v.id AND x.forma_pagamento <> 'Sem pagamento')
                AND NOT EXISTS (SELECT 1 FROM fin_receber_titulos t WHERE t.empresa_id = v.empresa_id AND t.origem = 'venda' AND t.origem_id = v.id)
              ORDER BY v.id LIMIT 200`,
      canceladas: `SELECT v.id, v.numero FROM fin_receber_titulos t JOIN ven_vendas v ON v.id = t.origem_id
                    WHERE t.empresa_id = ? AND t.origem = 'venda' AND t.status IN ('aberto','parcial') AND v.status = 'cancelada' LIMIT 200` },
    { lado: 'pagar' as Lado, origem: 'compra', corpo: (id: number) => ({ entrada_id: id }), nome: 'Entrada',
      novas: `SELECT n.id, n.numero FROM com_entradas n WHERE n.empresa_id = ? AND n.status = 'lancada'
                AND n.id >= (SELECT MIN(origem_id) FROM fin_pagar_titulos WHERE empresa_id = ? AND origem = 'compra')
                AND EXISTS (SELECT 1 FROM com_entrada_parcelas x WHERE x.entrada_id = n.id)
                AND NOT EXISTS (SELECT 1 FROM fin_pagar_titulos t WHERE t.empresa_id = n.empresa_id AND t.origem = 'compra' AND t.origem_id = n.id)
              ORDER BY n.id LIMIT 200`,
      canceladas: `SELECT n.id, n.numero FROM fin_pagar_titulos t JOIN com_entradas n ON n.id = t.origem_id
                    WHERE t.empresa_id = ? AND t.origem = 'compra' AND t.status IN ('aberto','parcial') AND n.status = 'estornada' LIMIT 200` },
  ];
  for (const o of origens) {
    const [novas]: any = await pool.query(o.novas, [empresa, empresa]);
    for (const x of novas) {
      try {
        if (!(await transacao((c) => criarTitulo(c, s, null, o.lado, o.corpo(x.id)))).existente) r.criados++;
      } catch (e: any) {
        r.erros.push(`${o.nome} ${x.numero}: ${e?.message ?? e}`);
      }
    }
    const [canceladas]: any = await pool.query(o.canceladas, [empresa]);
    for (const x of canceladas) {
      try {
        await cancelarPorOrigem(s, null, o.lado, o.origem, x.id, `${o.nome} ${x.numero} ${o.origem === 'venda' ? 'cancelada' : 'estornada'}`);
        r.cancelados++;
      } catch (e: any) {
        r.erros.push(`${o.nome} ${x.numero}: ${e?.message ?? e}`);
      }
    }
  }
  if (r.erros.length) console.error(`[Origens empresa ${empresa}]\n  ${r.erros.join('\n  ')}`);
  return r;
}
