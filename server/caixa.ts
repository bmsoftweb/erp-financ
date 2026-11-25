import { Router, type Request } from 'express';
import Decimal from 'decimal.js';
import { z } from 'zod';
import { masterPool as pool, transacao, hojeSql } from './db.js';
import { falha, rota } from './http.js';
import type { SessionData } from './session.js';
import {
  empresaDe, usuarioDe, parametros, contaParam, exigir, conferirPeriodo, conferirClassificacao, contaDoUsuario, filtroContas, auditar, type Db,
} from './comum.js';
import { dataZ, dinheiroZ, idZ, textoZ, validar } from './titulos.js';

/**
 * Movimento de contas: lançamento direto (tarifa, rendimento, IOF), transferência, estorno de movimento e caixa
 * (abertura com troco, suprimento, sangria, fechamento com contagem e quebra). Saldo = saldo_inicial + Σ movimentos:
 * nada aqui muda saldo sem gravar fin_movimentos, e nada é apagado (estorno = linha inversa com estorno_de_id).
 */

const schemaDireto = z.object({
  conta_financeira_id: idZ,
  data: dataZ,
  tipo: z.enum(['entrada', 'saida']),
  valor: dinheiroZ,
  historico: z.string().trim().min(1, 'informe o histórico').max(255),
  documento: textoZ(60),
  plano_conta_id: idZ,
  centro_custo_id: idZ,
});
export type DadosDireto = z.output<typeof schemaDireto>;

const schemaTransferencia = z.object({
  conta_origem_id: idZ,
  conta_destino_id: idZ,
  data: dataZ,
  valor: dinheiroZ,
  historico: textoZ(255),
});

/** Pessoa do movimento de baixa (para exibir e para a conciliação casar CPF/CNPJ) */
export const MOV_PESSOA = `
  LEFT JOIN fin_receber_baixas rb ON rb.id = m.receber_baixa_id LEFT JOIN fin_receber_parcelas rp ON rp.id = rb.parcela_id LEFT JOIN fin_receber_titulos rt ON rt.id = rp.titulo_id
  LEFT JOIN fin_pagar_baixas pb ON pb.id = m.pagar_baixa_id LEFT JOIN fin_pagar_parcelas pp ON pp.id = pb.parcela_id LEFT JOIN fin_pagar_titulos pt ON pt.id = pp.titulo_id
  LEFT JOIN cad_pessoas pe ON pe.id = COALESCE(rt.pessoa_id, pt.pessoa_id)`;

/** Saldo da conta no fim do dia */
export async function saldoEm(db: Db, contaId: number, data: string): Promise<Decimal> {
  const [[x]]: any = await db.query(
    `SELECT cf.saldo_inicial + COALESCE((SELECT SUM(IF(m.tipo = 'entrada', m.valor, -m.valor)) FROM fin_movimentos m WHERE m.conta_financeira_id = cf.id AND m.data <= ?), 0) AS saldo
       FROM fin_contas_financeiras cf WHERE cf.id = ?`,
    [data, contaId],
  );
  return new Decimal(x?.saldo ?? 0);
}

/** Sessão de caixa aberta da conta (o movimento do caixa fica ligado a ela) */
export async function sessaoAberta(db: Db, contaId: number): Promise<number | null> {
  const [[x]]: any = await db.query("SELECT id FROM fin_caixa_sessoes WHERE conta_financeira_id = ? AND status = 'aberto' LIMIT 1", [contaId]);
  return x ? Number(x.id) : null;
}

async function conferirData(c: Db, s: SessionData, data: string) {
  if (data > (await hojeSql(c))) falha('Data no futuro: o movimento entra no dia em que acontece.');
  await conferirPeriodo(c, s, data);
}

/** Lançamento direto: movimento + classificação (conta do plano e centro analíticos) */
export async function lancarDireto(c: Db, s: SessionData, req: Request | null, d: DadosDireto, o: { origem?: 'lancamento_direto' | 'caixa'; natureza?: 'direto' | 'quebra_caixa'; caixaSessaoId?: number } = {}) {
  const empresa = empresaDe(s);
  await exigir(s, 'movimentar');
  const conta = await contaDoUsuario(c, s, d.conta_financeira_id);
  await conferirClassificacao(c, empresa, d.plano_conta_id, d.centro_custo_id);
  await conferirData(c, s, d.data);
  const valor = new Decimal(d.valor).toFixed(2);
  const [mi]: any = await c.query('INSERT INTO fin_movimentos SET ?', [{
    empresa_id: empresa, conta_financeira_id: conta.id, data: d.data, tipo: d.tipo, valor, historico: d.historico, documento: d.documento,
    origem: o.origem ?? 'lancamento_direto', caixa_sessao_id: o.caixaSessaoId ?? (await sessaoAberta(c, conta.id)), usuario_id: usuarioDe(s),
  }]);
  const id = Number(mi.insertId);
  await c.query('INSERT INTO fin_lancamentos SET ?', [{
    empresa_id: empresa, movimento_id: id, data_caixa: d.data, data_competencia: d.data, plano_conta_id: d.plano_conta_id, centro_custo_id: d.centro_custo_id,
    natureza: o.natureza ?? 'direto', sinal: d.tipo === 'entrada' ? 1 : -1, valor,
  }]);
  await auditar(c, s, req, 'fin_movimentos', id, o.natureza === 'quebra_caixa' ? 'quebra_caixa' : 'lancar', null, { ...d, valor });
  return id;
}

/** Transferência: uma saída + uma entrada com o mesmo transferencia_id, sem lançamento de DRE. Caixa não fica negativo. */
export async function transferir(c: Db, s: SessionData, req: Request | null, d: z.output<typeof schemaTransferencia>) {
  const empresa = empresaDe(s);
  await exigir(s, 'movimentar');
  if (d.conta_origem_id === d.conta_destino_id) falha('Escolha contas diferentes.');
  const origem = await contaDoUsuario(c, s, d.conta_origem_id);
  const destino = await contaDoUsuario(c, s, d.conta_destino_id);
  await conferirData(c, s, d.data);
  const valor = new Decimal(d.valor);
  if (origem.tipo === 'caixa') {
    const saldo = await saldoEm(c, origem.id, d.data);
    if (saldo.lt(valor)) falha(`Saldo do caixa "${origem.nome}" insuficiente (R$ ${saldo.toFixed(2)}).`);
  }
  const historico = d.historico ?? `Transferência ${origem.nome} → ${destino.nome}`;
  const [ti]: any = await c.query('INSERT INTO fin_transferencias SET ?', [{
    empresa_id: empresa, conta_origem_id: origem.id, conta_destino_id: destino.id, data: d.data, valor: valor.toFixed(2), historico, usuario_id: usuarioDe(s),
  }]);
  const id = Number(ti.insertId);
  for (const [conta, tipo] of [[origem, 'saida'], [destino, 'entrada']] as const) {
    await c.query('INSERT INTO fin_movimentos SET ?', [{
      empresa_id: empresa, conta_financeira_id: conta.id, data: d.data, tipo, valor: valor.toFixed(2), historico: historico.slice(0, 255),
      origem: 'transferencia', transferencia_id: id, caixa_sessao_id: await sessaoAberta(c, conta.id), usuario_id: usuarioDe(s),
    }]);
  }
  await auditar(c, s, req, 'fin_transferencias', id, 'transferir', null, { ...d, valor: valor.toFixed(2) });
  return id;
}

/**
 * Estorno de lançamento direto, transferência (as duas pontas) ou movimento do caixa: linha inversa na mesma data e
 * lançamentos de DRE invertidos. Movimento de baixa se estorna pela baixa; conciliado, só depois de desfazer.
 */
export async function estornarMovimento(c: Db, s: SessionData, req: Request | null, id: number, motivo: string) {
  const empresa = empresaDe(s);
  await exigir(s, 'estornar');
  const [[m]]: any = await c.query('SELECT * FROM fin_movimentos WHERE id = ? AND empresa_id = ? FOR UPDATE', [id, empresa]);
  if (!m) falha('Movimento não encontrado.', 404);
  if (m.estorno_de_id) falha('Esta linha já é um estorno.');
  if (m.origem === 'baixa' || m.origem === 'lote') falha('Movimento de baixa: estorne pela baixa, no título.');
  const [grupo]: any = m.transferencia_id
    ? await c.query('SELECT * FROM fin_movimentos WHERE transferencia_id = ? AND estorno_de_id IS NULL FOR UPDATE', [m.transferencia_id])
    : [[m]];
  for (const g of grupo) {
    await contaDoUsuario(c, s, g.conta_financeira_id);
    const [[e]]: any = await c.query('SELECT id FROM fin_movimentos WHERE estorno_de_id = ? LIMIT 1', [g.id]);
    if (e) falha('Movimento já estornado.');
    if (g.conciliado_em) falha('Movimento conciliado: desfaça a conciliação antes de estornar.');
    if (g.caixa_sessao_id) {
      const [[cx]]: any = await c.query('SELECT status FROM fin_caixa_sessoes WHERE id = ?', [g.caixa_sessao_id]);
      if (cx?.status === 'fechado') falha(`Sessão de caixa #${g.caixa_sessao_id} já fechada.`);
    }
  }
  await conferirPeriodo(c, s, ...grupo.map((g: any) => String(g.data).slice(0, 10)));
  const estornos: number[] = [];
  for (const g of grupo) {
    const [mi]: any = await c.query('INSERT INTO fin_movimentos SET ?', [{
      empresa_id: empresa, conta_financeira_id: g.conta_financeira_id, data: String(g.data).slice(0, 10), tipo: g.tipo === 'entrada' ? 'saida' : 'entrada', valor: g.valor,
      historico: `Estorno do movimento #${g.id}: ${motivo}`.slice(0, 255), documento: g.documento, origem: 'estorno', estorno_de_id: g.id,
      transferencia_id: g.transferencia_id, caixa_sessao_id: g.caixa_sessao_id, usuario_id: usuarioDe(s),
    }]);
    await c.query(
      `INSERT INTO fin_lancamentos (empresa_id, movimento_id, data_caixa, data_competencia, plano_conta_id, centro_custo_id, natureza, sinal, valor)
       SELECT empresa_id, ?, data_caixa, data_competencia, plano_conta_id, centro_custo_id, natureza, -sinal, valor FROM fin_lancamentos WHERE movimento_id = ?`,
      [mi.insertId, g.id],
    );
    estornos.push(Number(mi.insertId));
  }
  await auditar(c, s, req, 'fin_movimentos', m.id, 'estornar', { movimentos: grupo.map((g: any) => g.id) }, { estornos, motivo });
  return { estornos };
}

// ------------------------------------------------------------------ caixa

const valorZ = z.union([z.string(), z.number()]).transform(String).refine((v) => /^\d{1,13}(\.\d{1,2})?$/.test(v), 'valor inválido');

async function sessaoTravada(c: Db, s: SessionData, id: number) {
  const [[x]]: any = await c.query('SELECT * FROM fin_caixa_sessoes WHERE id = ? AND empresa_id = ? FOR UPDATE', [id, empresaDe(s)]);
  if (!x) falha('Sessão de caixa não encontrada.', 404);
  if (x.status !== 'aberto') falha(`Sessão de caixa #${id} já fechada.`);
  return x;
}

/** Fechamento: contado (Σ contagem por forma) − esperado (saldo da conta) vira lançamento em Quebra de caixa */
export async function fecharCaixa(c: Db, s: SessionData, req: Request | null, id: number, contagem: { forma: string; valor: string }[]) {
  await exigir(s, 'movimentar');
  const sessao = await sessaoTravada(c, s, id);
  const hoje = await hojeSql(c);
  const esperado = await saldoEm(c, sessao.conta_financeira_id, hoje);
  const contado = contagem.reduce((a, x) => a.plus(x.valor), new Decimal(0));
  const diferenca = contado.minus(esperado);
  if (!diferenca.isZero()) {
    const p = await parametros(c, empresaDe(s));
    const [[op]]: any = await c.query('SELECT login FROM sys_usuarios WHERE id = ?', [sessao.operador_id]);
    await lancarDireto(c, s, req, {
      conta_financeira_id: sessao.conta_financeira_id, data: hoje, tipo: diferenca.gt(0) ? 'entrada' : 'saida', valor: diferenca.abs().toFixed(2),
      historico: `Quebra de caixa: sessão #${id}, operador ${op?.login ?? sessao.operador_id ?? '?'}`, documento: `CX-${id}`,
      plano_conta_id: contaParam(p, 'conta_quebra_caixa_id', 'Quebra de caixa'),
      centro_custo_id: Number(p.centro_custo_padrao_id) || falha('Configure o centro de custo padrão em Parâmetros.'),
    }, { origem: 'caixa', natureza: 'quebra_caixa', caixaSessaoId: id });
  }
  await c.query("UPDATE fin_caixa_sessoes SET status = 'fechado', fechado_em = NOW(), fechado_por = ?, valor_esperado = ?, valor_contado = ?, diferenca = ?, contagem = ? WHERE id = ?", [
    usuarioDe(s), esperado.toFixed(2), contado.toFixed(2), diferenca.toFixed(2), JSON.stringify(contagem), id,
  ]);
  await auditar(c, s, req, 'fin_caixa_sessoes', id, 'fechar', null, { esperado: esperado.toFixed(2), contado: contado.toFixed(2), diferenca: diferenca.toFixed(2), contagem });
  return { esperado: esperado.toFixed(2), contado: contado.toFixed(2), diferenca: diferenca.toFixed(2) };
}

export function createCaixaRouter() {
  const r = Router();

  /** Extrato da conta (ou de todas as visíveis) com saldo anterior e saldo linha a linha */
  r.get('/movimentos', rota(async (req, _res, s) => {
    const empresa = empresaDe(s);
    const hoje = await hojeSql(pool);
    const de = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.de)) ? String(req.query.de) : `${hoje.slice(0, 8)}01`;
    const ate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.ate)) ? String(req.query.ate) : hoje;
    const conta = Number(req.query.conta) || null;
    if (conta) await contaDoUsuario(pool, s, conta);
    const f = await filtroContas(s);
    const filtroConta = conta ? 'AND cf.id = ?' : '';
    const [[ant]]: any = await pool.query(
      `SELECT COALESCE(SUM(cf.saldo_inicial), 0) + COALESCE((SELECT SUM(IF(m.tipo = 'entrada', m.valor, -m.valor)) FROM fin_movimentos m JOIN fin_contas_financeiras cf ON cf.id = m.conta_financeira_id
                                                     WHERE cf.empresa_id = ? AND m.data < ? AND ${f.sql} ${filtroConta}), 0) AS saldo
         FROM fin_contas_financeiras cf WHERE cf.empresa_id = ? AND ${f.sql} ${filtroConta}`,
      [empresa, de, ...f.params, ...(conta ? [conta] : []), empresa, ...f.params, ...(conta ? [conta] : [])],
    );
    const [linhas]: any = await pool.query(
      `SELECT m.id, m.data, m.tipo, m.valor, m.historico, m.documento, m.origem, m.transferencia_id, m.caixa_sessao_id, m.estorno_de_id, m.conciliado_em,
              m.conta_financeira_id, cf.nome AS conta_nome, u.login AS usuario_login, pe.nome AS pessoa_nome,
              EXISTS (SELECT 1 FROM fin_movimentos e WHERE e.estorno_de_id = m.id) AS estornado,
              (SELECT GROUP_CONCAT(DISTINCT CONCAT(pc.codigo, ' ', pc.descricao) SEPARATOR ' · ') FROM fin_lancamentos l JOIN fin_plano_contas pc ON pc.id = l.plano_conta_id WHERE l.movimento_id = m.id) AS classificacao
         FROM fin_movimentos m JOIN fin_contas_financeiras cf ON cf.id = m.conta_financeira_id LEFT JOIN sys_usuarios u ON u.id = m.usuario_id ${MOV_PESSOA}
        WHERE m.empresa_id = ? AND m.data BETWEEN ? AND ? AND ${f.sql} ${filtroConta}
        ORDER BY m.data, m.id LIMIT 5000`,
      [empresa, de, ate, ...f.params, ...(conta ? [conta] : [])],
    );
    let saldo = new Decimal(ant.saldo);
    const saldoAnterior = saldo.toFixed(2);
    const comSaldo = linhas.map((l: any) => {
      saldo = l.tipo === 'entrada' ? saldo.plus(l.valor) : saldo.minus(l.valor);
      return { ...l, estornado: !!Number(l.estornado), saldo: saldo.toFixed(2) };
    });
    return { de, ate, saldo_anterior: saldoAnterior, saldo_final: saldo.toFixed(2), linhas: comSaldo };
  }));

  r.post('/movimentos', rota(async (req, res, s) => {
    const d = validar(schemaDireto, req.body);
    const id = await transacao((c) => lancarDireto(c, s, req, d));
    res.status(201);
    return { id };
  }));

  r.post('/movimentos/:id/estornar', rota(async (req, _res, s) => {
    const motivo = String(req.body?.motivo ?? '').trim();
    if (!motivo) falha('Informe o motivo do estorno.');
    return transacao((c) => estornarMovimento(c, s, req, Number(req.params.id), motivo.slice(0, 200)));
  }));

  r.post('/transferencias', rota(async (req, res, s) => {
    const d = validar(schemaTransferencia, req.body);
    const id = await transacao((c) => transferir(c, s, req, d));
    res.status(201);
    return { id };
  }));

  // ---------------------------------------------------------------- caixa

  r.get('/caixa/sessoes', rota(async (req, _res, s) => {
    const f = await filtroContas(s);
    const conta = Number(req.query.conta) || null;
    const [l]: any = await pool.query(
      `SELECT x.*, cf.nome AS conta_nome, uo.login AS operador_login, uf.login AS fechado_por_login,
              IF(x.status = 'aberto', cf.saldo_inicial + COALESCE((SELECT SUM(IF(m.tipo = 'entrada', m.valor, -m.valor)) FROM fin_movimentos m WHERE m.conta_financeira_id = cf.id), 0), NULL) AS saldo_atual
         FROM fin_caixa_sessoes x JOIN fin_contas_financeiras cf ON cf.id = x.conta_financeira_id
         LEFT JOIN sys_usuarios uo ON uo.id = x.operador_id LEFT JOIN sys_usuarios uf ON uf.id = x.fechado_por
        WHERE x.empresa_id = ? AND ${f.sql} ${conta ? 'AND cf.id = ?' : ''}
        ORDER BY x.status = 'aberto' DESC, x.aberto_em DESC LIMIT 500`,
      [empresaDe(s), ...f.params, ...(conta ? [conta] : [])],
    );
    return l;
  }));

  r.get('/caixa/sessoes/:id', rota(async (req, _res, s) => {
    const [[x]]: any = await pool.query('SELECT * FROM fin_caixa_sessoes WHERE id = ? AND empresa_id = ?', [req.params.id, empresaDe(s)]);
    if (!x) falha('Sessão de caixa não encontrada.', 404);
    await contaDoUsuario(pool, s, x.conta_financeira_id);
    const [movimentos]: any = await pool.query(
      'SELECT m.id, m.data, m.tipo, m.valor, m.historico, m.origem, m.criado_em, u.login AS usuario_login FROM fin_movimentos m LEFT JOIN sys_usuarios u ON u.id = m.usuario_id WHERE m.caixa_sessao_id = ? ORDER BY m.id',
      [x.id],
    );
    const saldo = await saldoEm(pool, x.conta_financeira_id, await hojeSql(pool));
    return { ...x, movimentos, saldo_atual: saldo.toFixed(2) };
  }));

  /** Abertura: { conta_financeira_id, valor_abertura } — o troco contado na abertura */
  r.post('/caixa/sessoes', rota(async (req, res, s) => {
    const d = validar(z.object({ conta_financeira_id: idZ, valor_abertura: valorZ }), req.body);
    const id = await transacao(async (c) => {
      await exigir(s, 'movimentar');
      const conta = await contaDoUsuario(c, s, d.conta_financeira_id);
      if (conta.tipo !== 'caixa') falha(`"${conta.nome}" não é uma conta do tipo caixa.`);
      await c.query('SELECT id FROM fin_contas_financeiras WHERE id = ? FOR UPDATE', [conta.id]);
      const aberta = await sessaoAberta(c, conta.id);
      if (aberta) falha(`Caixa "${conta.nome}" já está aberto (sessão #${aberta}).`);
      const [i]: any = await c.query(
        "INSERT INTO fin_caixa_sessoes (empresa_id, conta_financeira_id, operador_id, aberto_em, valor_abertura, status) VALUES (?, ?, ?, NOW(), ?, 'aberto')",
        [empresaDe(s), conta.id, usuarioDe(s), new Decimal(d.valor_abertura).toFixed(2)],
      );
      await auditar(c, s, req, 'fin_caixa_sessoes', i.insertId, 'abrir', null, d);
      return Number(i.insertId);
    });
    res.status(201);
    return { id };
  }));

  /** Suprimento (outra conta → caixa) e sangria (caixa → outra conta): transferência hoje, ligada à sessão */
  for (const acao of ['suprimento', 'sangria'] as const) {
    r.post(`/caixa/sessoes/:id/${acao}`, rota(async (req, res, s) => {
      const d = validar(z.object({ conta_id: idZ, valor: dinheiroZ, historico: textoZ(255) }), req.body);
      const id = await transacao(async (c) => {
        const sessao = await sessaoTravada(c, s, Number(req.params.id));
        const caixa = sessao.conta_financeira_id;
        const hist = d.historico ?? `${acao === 'suprimento' ? 'Suprimento' : 'Sangria'} do caixa (sessão #${sessao.id})`;
        return transferir(c, s, req, {
          conta_origem_id: acao === 'suprimento' ? d.conta_id : caixa, conta_destino_id: acao === 'suprimento' ? caixa : d.conta_id,
          data: await hojeSql(c), valor: d.valor, historico: hist,
        });
      });
      res.status(201);
      return { transferencia_id: id };
    }));
  }

  /** Fechamento: { contagem: [{ forma, valor }] } */
  r.post('/caixa/sessoes/:id/fechar', rota(async (req, _res, s) => {
    const d = validar(z.object({ contagem: z.array(z.object({ forma: z.string().trim().min(1).max(40), valor: valorZ })).max(30) }), req.body);
    return transacao((c) => fecharCaixa(c, s, req, Number(req.params.id), d.contagem));
  }));

  return r;
}

