import { Router, type Request } from 'express';
import Decimal from 'decimal.js';
import { z } from 'zod';
import { masterPool as pool, transacao, hojeSql } from './db.js';
import { falha, rota } from './http.js';
import type { SessionData } from './session.js';
import {
  LADOS, ladoDe, empresaDe, usuarioDe, parametros, contaParam, exigir, conferirPeriodo, auditar, contaDoUsuario, type Db, type Lado,
} from './comum.js';
import { calcularBaixa, totalDoDia, valorParaPrincipal, round2, type EntradaBaixa, type ResultadoBaixa } from './calculo.js';
import { distribuir } from './rateio.js';
import { sessaoAberta } from './caixa.js';
import { atualizarStatusTitulo, cancelarTitulo, dataZ, dinheiroZ, idZ, textoZ, validar } from './titulos.js';
import { instruirBoletos, processarAgora } from './eventos.js';

/**
 * Baixa (inclusive parcial, com juros e multa proporcionais), estorno e baixa em lote, iguais para receber e pagar.
 * Tudo em transação com a parcela travada (FOR UPDATE). Nada muda saldo de conta sem fin_movimentos, e cada movimento
 * é classificado em fin_lancamentos (conta do plano + centro de custo).
 */

const valorZ = z.union([z.string(), z.number()]).transform(String).refine((v) => /^\d{1,13}(\.\d{1,2})?$/.test(v), 'valor inválido');
const simZ = z.union([z.boolean(), z.number()]).nullish().transform((v) => !!v);

const schemaBaixa = z.object({
  data_pagamento: dataZ,
  /** data_credito (receber) ou data_debito (pagar); sem ela, a do pagamento */
  data_conta: dataZ.nullish(),
  conta_financeira_id: idZ.nullish(),
  forma_pagamento_id: idZ.nullish(),
  /** P; sem ele (e sem principal), quita: paga o total do dia */
  valor_pago: dinheiroZ.nullish(),
  /** Cálculo inverso: principal que se quer amortizar */
  principal: dinheiroZ.nullish(),
  valor_tarifa: valorZ.nullish(),
  dispensa: valorZ.nullish(),
  motivo_dispensa: textoZ(255),
  multa_informada: valorZ.nullish(),
  juros_informados: valorZ.nullish(),
  usar_credito: simZ,
  observacoes: textoZ(5000),
});
type DadosBaixa = z.output<typeof schemaBaixa>;
/** Dados de baixa montados no servidor (retorno do banco, Pix, cartão) passam pela mesma validação da tela */
export const validarBaixa = (corpo: z.input<typeof schemaBaixa>) => validar(schemaBaixa, corpo);

interface Opcoes {
  origem?: string;
  loteId?: number;
  /** Lote: o movimento é um só, gravado depois */
  semMovimento?: boolean;
  banOcorrenciaId?: number;
  /** Compensação: baixa sem conta financeira e sem movimento */
  semConta?: boolean;
  /** Cartão: a parcela do cliente vira recebível do adquirente; a receita só entra quando o adquirente paga */
  semLancamento?: boolean;
  /** Antecipação de cartão: o custo (valor_tarifa) vai para esta conta do plano, não para tarifas bancárias */
  tarifa?: { conta: number; natureza: 'antecipacao' };
}

/** Entrada da função de cálculo a partir da parcela gravada e dos parâmetros */
export function entradaDe(p: any, params: any, d: { data_pagamento: string; dispensa?: string | null; multa_informada?: string | null; juros_informados?: string | null }): Omit<EntradaBaixa, 'valorPago'> {
  const informados = d.multa_informada != null || d.juros_informados != null;
  return {
    saldo: p.saldo,
    vencimento: String(Number(p.manter_encargos_original) ? p.vencimento_original : p.vencimento).slice(0, 10),
    dataPagamento: d.data_pagamento,
    carenciaDias: Number(p.carencia_dias || 0),
    multaPct: p.multa_pct,
    jurosMesPct: p.juros_mes_pct,
    descontoPct: p.desconto_pct,
    descontoAte: p.desconto_ate ? String(p.desconto_ate).slice(0, 10) : null,
    modo: params.modo_imputacao,
    multaInformada: informados ? d.multa_informada ?? 0 : null,
    jurosInformados: informados ? d.juros_informados ?? 0 : null,
    dispensa: d.dispensa ?? 0,
  };
}

function valorPagoDe(e: Omit<EntradaBaixa, 'valorPago'>, d: Pick<DadosBaixa, 'valor_pago' | 'principal'>): string {
  if (d.valor_pago) return d.valor_pago;
  if (d.principal) return valorParaPrincipal(e, d.principal);
  return totalDoDia(e);
}

async function parcelaTravada(c: Db, lado: Lado, empresa: number, id: number): Promise<any> {
  const L = LADOS[lado];
  const [[p]]: any = await c.query(
    `SELECT p.*, t.pessoa_id, t.data_competencia, t.numero_documento, t.status AS titulo_status, t.origem AS titulo_origem
       FROM ${L.parcelas} p JOIN ${L.titulos} t ON t.id = p.titulo_id WHERE p.id = ? AND p.empresa_id = ? FOR UPDATE`,
    [id, empresa],
  );
  return p ?? falha('Parcela não encontrada.', 404);
}

/** Crédito do cliente / adiantamento ao fornecedor: extrato + saldo em fin_pessoas_financeiro */
async function movimentarCredito(c: Db, s: SessionData, lado: Lado, pessoaId: number, natureza: 'entrada' | 'uso' | 'estorno', valor: Decimal, baixaId: number, historico: string) {
  const L = LADOS[lado];
  const empresa = empresaDe(s);
  const delta = natureza === 'entrada' ? valor : valor.neg();
  await c.query(`INSERT INTO fin_pessoas_financeiro (empresa_id, pessoa_id, usuario_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE id = id`, [empresa, pessoaId, usuarioDe(s)]);
  const [[f]]: any = await c.query(`SELECT ${L.saldoCredito} AS saldo FROM fin_pessoas_financeiro WHERE empresa_id = ? AND pessoa_id = ? FOR UPDATE`, [empresa, pessoaId]);
  const novo = new Decimal(f.saldo).plus(delta);
  if (novo.lt(0)) falha(`${lado === 'receber' ? 'Crédito do cliente' : 'Adiantamento ao fornecedor'} insuficiente (disponível ${new Decimal(f.saldo).toFixed(2)}).`);
  await c.query(`UPDATE fin_pessoas_financeiro SET ${L.saldoCredito} = ? WHERE empresa_id = ? AND pessoa_id = ?`, [novo.toFixed(2), empresa, pessoaId]);
  await c.query('INSERT INTO fin_pessoa_creditos SET ?', [{ empresa_id: empresa, pessoa_id: pessoaId, tipo: lado, natureza, valor: valor.toFixed(2), [L.fkBaixa]: baixaId, historico, usuario_id: usuarioDe(s) }]);
}

/**
 * Classificação da baixa (fin_lancamentos): principal nas contas do rateio, encargos e desconto nas contas padrão
 * com os centros do rateio (mesma proporção), tarifa no centro de tarifas. Soma = líquido do movimento − excedente.
 */
async function lancar(c: Db, lado: Lado, empresa: number, p: any, b: ResultadoBaixa & { valor_tarifa: string; data_pagamento: string }, baixaId: number, movimentoId: number | null, o: Opcoes = {}) {
  const L = LADOS[lado];
  const params = await parametros(c, empresa);
  const [rateios]: any = await c.query(`SELECT plano_conta_id, centro_custo_id, percentual FROM ${L.rateios} WHERE titulo_id = ? ORDER BY id`, [p.titulo_id]);
  if (!rateios.length) falha('Título sem rateio: não é possível baixar.');
  const pcts = rateios.map((r: any) => r.percentual);
  const linhas: { conta: number; centro: number; natureza: string; sinal: number; valor: string }[] = [];
  const porRateio = (valor: string, conta: ((r: any) => number) | null, natureza: string, sinal: number) => {
    if (new Decimal(valor).isZero()) return;
    distribuir(valor, pcts).forEach((v, i) => linhas.push({ conta: conta ? conta(rateios[i]) : rateios[i].plano_conta_id, centro: rateios[i].centro_custo_id, natureza, sinal, valor: v }));
  };
  porRateio(b.valorPrincipal, null, 'principal', L.sinal);
  if (Number(b.valorJuros)) porRateio(b.valorJuros, () => contaParam(params, L.contaJuros, lado === 'receber' ? 'Juros recebidos' : 'Juros pagos'), 'juros', L.sinal);
  if (Number(b.valorMulta)) porRateio(b.valorMulta, () => contaParam(params, L.contaMulta, lado === 'receber' ? 'Multas recebidas' : 'Multas pagas'), 'multa', L.sinal);
  if (Number(b.valorDesconto)) porRateio(b.valorDesconto, () => contaParam(params, L.contaDesconto, lado === 'receber' ? 'Descontos concedidos' : 'Descontos obtidos'), 'desconto', -L.sinal);
  const centroTarifas = () => Number(params.centro_custo_tarifas_id || params.centro_custo_padrao_id) || falha('Configure o centro de custo de tarifas em Parâmetros.');
  if (Number(b.valor_tarifa)) {
    linhas.push({
      conta: o.tarifa?.conta ?? contaParam(params, 'conta_tarifas_bancarias_id', 'Tarifas bancárias'),
      centro: centroTarifas(), natureza: o.tarifa?.natureza ?? 'tarifa', sinal: -1, valor: b.valor_tarifa,
    });
  }
  // Recebível de cartão (líquido da taxa): a receita entra bruta e a taxa vira despesa na data do crédito.
  // ponytail: taxa da parcela proporcional ao principal baixado; baixa parcial pode deixar 1 centavo de diferença
  if (p.titulo_origem === 'cartao_adquirente' && Number(b.valorPrincipal)) {
    const [[t]]: any = await c.query('SELECT valor_taxa, parcelas FROM fin_cartao_transacoes WHERE titulo_recebivel_id = ?', [p.titulo_id]);
    const taxaParcela = t ? distribuir(t.valor_taxa, Array(Number(t.parcelas)).fill(1))[p.numero - 1] ?? '0' : '0';
    const taxa = round2(new Decimal(taxaParcela).times(b.valorPrincipal).div(p.valor_original)).toFixed(2);
    if (Number(taxa)) {
      porRateio(taxa, null, 'principal', 1);
      linhas.push({ conta: contaParam(params, 'conta_taxas_cartao_id', 'Taxas de cartão'), centro: centroTarifas(), natureza: 'taxa_cartao', sinal: -1, valor: taxa });
    }
  }
  for (const l of linhas.filter((x) => Number(x.valor))) {
    await c.query('INSERT INTO fin_lancamentos SET ?', [{
      empresa_id: empresa, movimento_id: movimentoId, [L.fkBaixa]: baixaId, data_caixa: b.data_pagamento, data_competencia: String(p.data_competencia).slice(0, 10),
      plano_conta_id: l.conta, centro_custo_id: l.centro, natureza: l.natureza, sinal: l.sinal, valor: l.valor,
    }]);
  }
}

/** Valor que entra (receber: pago − tarifa) ou sai (pagar: pago + tarifa) da conta */
const liquidoDe = (lado: Lado, pago: Decimal.Value, tarifa: Decimal.Value) => (lado === 'receber' ? new Decimal(pago).minus(tarifa) : new Decimal(pago).plus(tarifa));

export async function baixar(c: Db, s: SessionData, req: Request | null, lado: Lado, parcelaId: number, d: DadosBaixa, o: Opcoes = {}) {
  const L = LADOS[lado];
  const empresa = empresaDe(s);
  await exigir(s, 'baixar');
  const p = await parcelaTravada(c, lado, empresa, parcelaId);
  if (p.status !== 'aberta' && p.status !== 'parcial') falha(`Parcela ${p.numero}/${p.total_parcelas} ${p.status}: não pode ser baixada.`);
  if (lado === 'pagar' && (p.aprovacao_status === 'pendente' || p.aprovacao_status === 'reprovada')) falha(`Pagamento ${p.aprovacao_status === 'pendente' ? 'aguardando aprovação' : 'reprovado'}.`);
  const hoje = await hojeSql(c);
  if (d.data_pagamento > hoje) falha('Data do pagamento no futuro.');
  const dataConta = d.data_conta ?? d.data_pagamento;
  if (dataConta < d.data_pagamento) falha(`Data de ${lado === 'receber' ? 'crédito' : 'débito'} antes do pagamento.`);
  await conferirPeriodo(c, s, d.data_pagamento, dataConta);
  if (Number(d.dispensa || 0) > 0) {
    await exigir(s, 'dispensar');
    if (!d.motivo_dispensa) falha('Informe o motivo da dispensa dos encargos.');
  }
  if ((d.multa_informada != null || d.juros_informados != null) && lado === 'receber' && o.origem !== 'retorno_banco') falha('Encargos informados só no contas a pagar ou no retorno do banco.');

  const origem = d.usar_credito ? 'credito_pessoa' : o.origem ?? 'manual';
  const tarifa = new Decimal(d.valor_tarifa || 0);
  if ((d.usar_credito || o.semConta) && tarifa.gt(0)) falha('Uso de crédito ou compensação não tem tarifa.');
  const conta = d.usar_credito || o.semConta ? null : d.conta_financeira_id ? await contaDoUsuario(c, s, d.conta_financeira_id) : falha('Informe a conta financeira.');

  const params = await parametros(c, empresa);
  const e = entradaDe(p, params, d);
  const r = calcularBaixa({ ...e, valorPago: valorPagoDe(e, d) });
  if ((d.usar_credito || o.semConta) && Number(r.valorExcedente) > 0) falha(`Use no máximo o total devido (${r.totalDevido}).`);
  const liquido = liquidoDe(lado, r.valorPago, tarifa);
  if (liquido.lt(0)) falha('Tarifa maior que o valor pago.');

  const [bi]: any = await c.query(`INSERT INTO ${L.baixas} SET ?`, [{
    empresa_id: empresa, parcela_id: p.id, data_pagamento: d.data_pagamento, [L.dataConta]: dataConta,
    conta_financeira_id: conta?.id ?? null, forma_pagamento_id: d.forma_pagamento_id ?? p.forma_pagamento_id ?? null,
    dias_atraso: r.diasAtraso, saldo_antes: r.saldoAntes, multa_devida: r.multaDevida, juros_devidos: r.jurosDevidos, fator_proporcional: r.fator,
    valor_pago: r.valorPago, valor_principal: r.valorPrincipal, valor_multa: r.valorMulta, valor_juros: r.valorJuros, valor_desconto: r.valorDesconto,
    valor_dispensado: r.valorDispensado, valor_tarifa: tarifa.toFixed(2), valor_excedente: r.valorExcedente, saldo_depois: r.saldoDepois,
    encargos_informados: d.multa_informada != null || d.juros_informados != null ? 1 : 0, origem, lote_id: o.loteId ?? null,
    ...(lado === 'receber' ? { ban_ocorrencia_id: o.banOcorrenciaId ?? null } : {}),
    observacoes: d.observacoes, motivo_dispensa: Number(r.valorDispensado) > 0 ? d.motivo_dispensa : null, usuario_id: usuarioDe(s),
  }]).catch((err: any) => (err?.code === 'ER_DUP_ENTRY' ? falha('Ocorrência do banco já baixada.', 409, 'repetida') : Promise.reject(err)));
  const baixaId = Number(bi.insertId);

  const saldo = new Decimal(r.saldoDepois);
  const status = saldo.isZero() ? 'quitada' : 'parcial';
  await c.query(`UPDATE ${L.parcelas} SET saldo = ?, status = ? WHERE id = ?`, [saldo.toFixed(2), status, p.id]);
  await atualizarStatusTitulo(c, lado, p.titulo_id);

  let movimentoId: number | null = null;
  if (conta && !o.semMovimento && liquido.gt(0)) {
    const [mi]: any = await c.query('INSERT INTO fin_movimentos SET ?', [{
      empresa_id: empresa, conta_financeira_id: conta.id, data: dataConta, tipo: L.movTipo, valor: liquido.toFixed(2),
      historico: `${lado === 'receber' ? 'Recebimento' : 'Pagamento'} ${p.numero_documento ?? `título ${p.titulo_id}`} parc. ${p.numero}/${p.total_parcelas}`.slice(0, 255),
      documento: p.documento, origem: 'baixa', [L.fkBaixa]: baixaId, caixa_sessao_id: await sessaoAberta(c, conta.id), usuario_id: usuarioDe(s),
    }]);
    movimentoId = Number(mi.insertId);
  }
  if (!o.semLancamento) await lancar(c, lado, empresa, p, { ...r, valor_tarifa: tarifa.toFixed(2), data_pagamento: d.data_pagamento }, baixaId, movimentoId, o);
  // Quitada fora do banco: o boleto ativo é baixado lá, para o cliente não pagar duas vezes
  if (lado === 'receber' && status === 'quitada' && origem !== 'retorno_banco') await instruirBoletos(c, s, p.id, 'baixar');

  if (d.usar_credito) await movimentarCredito(c, s, lado, p.pessoa_id, 'uso', new Decimal(r.valorPago), baixaId, `Uso na parcela ${p.numero}/${p.total_parcelas} de ${p.numero_documento ?? `título ${p.titulo_id}`}`);
  if (Number(r.valorExcedente) > 0) await movimentarCredito(c, s, lado, p.pessoa_id, 'entrada', new Decimal(r.valorExcedente), baixaId, `Pago a mais na parcela ${p.numero}/${p.total_parcelas} de ${p.numero_documento ?? `título ${p.titulo_id}`}`);

  await auditar(c, s, req, L.baixas, baixaId, 'baixar', { parcela_id: p.id, saldo: p.saldo, status: p.status }, { ...r, saldo_depois: r.saldoDepois, status, origem });
  if (Number(r.valorDispensado) > 0) await auditar(c, s, req, L.parcelas, p.id, 'dispensar', null, { baixa_id: baixaId, valor_dispensado: r.valorDispensado, motivo: d.motivo_dispensa });
  return { baixaId, movimentoId, liquido: liquido.toFixed(2), resultado: r, status };
}

/**
 * Estorno: linha nova com estorno_de_id, movimento e lançamentos inversos, saldo e status de volta. Só a baixa mais
 * recente da parcela. Compensação estorna as duas pontas (receber e pagar) juntas.
 */
export async function estornar(c: Db, s: SessionData, req: Request | null, lado: Lado, baixaId: number, motivo: string, par = false) {
  const L = LADOS[lado];
  const empresa = empresaDe(s);
  await exigir(s, 'estornar');
  const [[b]]: any = await c.query(`SELECT * FROM ${L.baixas} WHERE id = ? AND empresa_id = ? FOR UPDATE`, [baixaId, empresa]);
  if (!b) falha('Baixa não encontrada.', 404);
  if (b.estornada_em) falha('Baixa já estornada.');
  if (b.estorno_de_id) falha('Esta linha já é um estorno.');
  if (b.origem === 'renegociacao') falha('Baixa por renegociação: desfaça a renegociação.');
  const p = await parcelaTravada(c, lado, empresa, b.parcela_id);
  const [[ultima]]: any = await c.query(`SELECT id FROM ${L.baixas} WHERE parcela_id = ? AND estornada_em IS NULL AND estorno_de_id IS NULL ORDER BY id DESC LIMIT 1`, [p.id]);
  if (Number(ultima?.id) !== Number(b.id)) falha(`Estorne antes a baixa mais recente desta parcela (#${ultima?.id}).`);
  if (p.status === 'renegociada' || p.status === 'cancelada') falha(`Parcela ${p.status}.`);
  await conferirPeriodo(c, s, String(b.data_pagamento), String(b[L.dataConta]));

  const principal = new Decimal(b.valor_principal);
  const saldoNovo = new Decimal(p.saldo).plus(principal);
  const { id: _id, estornada_em: _e, estornada_por: _ep, criado_em: _c, atualizado_em: _a, ...copia } = b;
  const [ei]: any = await c.query(`INSERT INTO ${L.baixas} SET ?`, [{
    ...copia, ...(lado === 'receber' ? { ban_ocorrencia_id: null } : {}), [L.fkOutraBaixa]: null,
    saldo_antes: p.saldo, saldo_depois: saldoNovo.toFixed(2), estorno_de_id: b.id, observacoes: motivo, usuario_id: usuarioDe(s),
  }]);
  const estornoId = Number(ei.insertId);
  await c.query(`UPDATE ${L.baixas} SET estornada_em = NOW(), estornada_por = ? WHERE id = ?`, [usuarioDe(s), b.id]);

  const status = saldoNovo.eq(p.valor_original) ? 'aberta' : 'parcial';
  await c.query(`UPDATE ${L.parcelas} SET saldo = ?, status = ? WHERE id = ?`, [saldoNovo.toFixed(2), status, p.id]);
  await atualizarStatusTitulo(c, lado, p.titulo_id);

  // Movimento inverso: o da própria baixa ou, no lote, a parte desta baixa no movimento do lote
  let movInverso: number | null = null;
  if (b.conta_financeira_id) {
    const [[mov]]: any = await c.query(
      `SELECT id FROM fin_movimentos WHERE estorno_de_id IS NULL AND (${L.fkBaixa} = ? OR (? IS NOT NULL AND lote_id = ? AND origem = 'lote')) ORDER BY id LIMIT 1`,
      [b.id, b.lote_id, b.lote_id],
    );
    const liquido = liquidoDe(lado, b.valor_pago, b.valor_tarifa);
    if (mov && liquido.gt(0)) {
      const [mi]: any = await c.query('INSERT INTO fin_movimentos SET ?', [{
        empresa_id: empresa, conta_financeira_id: b.conta_financeira_id, data: String(b[L.dataConta]).slice(0, 10),
        tipo: L.movTipo === 'entrada' ? 'saida' : 'entrada', valor: liquido.toFixed(2), historico: `Estorno da baixa #${b.id}: ${motivo}`.slice(0, 255),
        documento: p.documento, origem: 'estorno', [L.fkBaixa]: estornoId, estorno_de_id: mov.id, lote_id: b.lote_id, usuario_id: usuarioDe(s),
      }]);
      movInverso = Number(mi.insertId);
    }
  }
  await c.query(
    `INSERT INTO fin_lancamentos (empresa_id, movimento_id, ${L.fkBaixa}, data_caixa, data_competencia, plano_conta_id, centro_custo_id, natureza, sinal, valor)
     SELECT empresa_id, ?, ?, data_caixa, data_competencia, plano_conta_id, centro_custo_id, natureza, -sinal, valor FROM fin_lancamentos WHERE ${L.fkBaixa} = ?`,
    [movInverso, estornoId, b.id],
  );

  const doc = `parcela ${p.numero}/${p.total_parcelas} de ${p.numero_documento ?? `título ${p.titulo_id}`}`;
  if (Number(b.valor_excedente) > 0) await movimentarCredito(c, s, lado, p.pessoa_id, 'estorno', new Decimal(b.valor_excedente), estornoId, `Estorno do pago a mais na ${doc}`);
  if (b.origem === 'credito_pessoa') await movimentarCredito(c, s, lado, p.pessoa_id, 'entrada', new Decimal(b.valor_pago), estornoId, `Estorno do uso de crédito na ${doc}`);

  await auditar(c, s, req, L.baixas, b.id, 'estornar', { saldo: p.saldo, status: p.status }, { estorno_id: estornoId, saldo: saldoNovo.toFixed(2), status, motivo });
  if (b.origem === 'compensacao' && !par && b[L.fkOutraBaixa]) await estornar(c, s, req, lado === 'receber' ? 'pagar' : 'receber', Number(b[L.fkOutraBaixa]), motivo, true);
  // Venda no cartão desfeita: o recebível do adquirente é cancelado (recusa se o adquirente já pagou parte)
  if (b.origem === 'cartao' && lado === 'receber') {
    const [[t]]: any = await c.query('SELECT titulo_recebivel_id FROM fin_cartao_transacoes WHERE receber_baixa_id = ?', [b.id]);
    if (t?.titulo_recebivel_id) await cancelarTitulo(c, s, req, 'receber', Number(t.titulo_recebivel_id), `Estorno da venda no cartão: ${motivo}`.slice(0, 255));
  }
  return { estornoId, saldo: saldoNovo.toFixed(2), status };
}

const schemaLote = z.object({
  parcelas: z.array(idZ).min(1).max(500),
  data_pagamento: dataZ,
  data_conta: dataZ.nullish(),
  conta_financeira_id: idZ,
  forma_pagamento_id: idZ.nullish(),
  /** Valor recebido/pago; sem ele, quita todas pelo total do dia */
  valor_total: dinheiroZ.nullish(),
  observacoes: textoZ(5000),
});

/** Lote: a regra da baixa parcela por parcela, por vencimento, e uma entrada/saída só na conta */
export async function baixarLote(c: Db, s: SessionData, req: Request | null, lado: Lado, corpo: unknown) {
  const L = LADOS[lado];
  const empresa = empresaDe(s);
  const d = validar(schemaLote, corpo);
  await exigir(s, 'baixar');
  const conta = await contaDoUsuario(c, s, d.conta_financeira_id);
  const ids = [...new Set(d.parcelas)];
  const [ps]: any = await c.query(`SELECT * FROM ${L.parcelas} WHERE id IN (?) AND empresa_id = ? ORDER BY vencimento, id FOR UPDATE`, [ids, empresa]);
  if (ps.length !== ids.length) falha('Parcela não encontrada.');
  const params = await parametros(c, empresa);
  const totais = ps.map((p: any) => new Decimal(totalDoDia(entradaDe(p, params, d))));
  const devido = totais.reduce((a: Decimal, t: Decimal) => a.plus(t), new Decimal(0));
  let resta = d.valor_total ? new Decimal(d.valor_total) : devido;
  if (resta.gt(devido)) falha(`Valor maior que o devido das parcelas (${devido.toFixed(2)}).`);

  const [li]: any = await c.query('INSERT INTO fin_baixa_lotes SET ?', [{ empresa_id: empresa, tipo: lado, data_pagamento: d.data_pagamento, conta_financeira_id: conta.id, valor_total: resta.toFixed(2), observacoes: d.observacoes, usuario_id: usuarioDe(s) }]);
  const loteId = Number(li.insertId);
  const baixas: number[] = [];
  let liquido = new Decimal(0);
  for (const [i, p] of ps.entries()) {
    if (resta.lte(0)) break;
    const pago = Decimal.min(resta, totais[i]);
    const r = await baixar(c, s, req, lado, p.id, { ...d, valor_pago: pago.toFixed(2), principal: null, valor_tarifa: null, dispensa: null, motivo_dispensa: null, multa_informada: null, juros_informados: null, usar_credito: false }, { origem: 'lote', loteId, semMovimento: true });
    baixas.push(r.baixaId);
    liquido = liquido.plus(r.liquido);
    resta = resta.minus(pago);
  }
  const [mi]: any = await c.query('INSERT INTO fin_movimentos SET ?', [{
    empresa_id: empresa, conta_financeira_id: conta.id, data: d.data_conta ?? d.data_pagamento, tipo: L.movTipo, valor: liquido.toFixed(2),
    historico: `Baixa em lote #${loteId} (${baixas.length} parcelas)`, origem: 'lote', lote_id: loteId, caixa_sessao_id: await sessaoAberta(c, conta.id), usuario_id: usuarioDe(s),
  }]);
  await c.query(`UPDATE fin_lancamentos SET movimento_id = ? WHERE ${L.fkBaixa} IN (?)`, [mi.insertId, baixas]);
  return { loteId, baixas, valor: liquido.toFixed(2) };
}

/** Prévia da baixa (tela): multa, juros, desconto, total do dia, saldo que sobra e cálculo inverso */
async function simular(s: SessionData, lado: Lado, parcelaId: number, corpo: unknown) {
  const L = LADOS[lado];
  const empresa = empresaDe(s);
  const d = validar(schemaBaixa.pick({ data_pagamento: true, valor_pago: true, principal: true, dispensa: true, multa_informada: true, juros_informados: true }), corpo);
  const [[p]]: any = await pool.query(`SELECT p.*, t.pessoa_id FROM ${L.parcelas} p JOIN ${L.titulos} t ON t.id = p.titulo_id WHERE p.id = ? AND p.empresa_id = ?`, [parcelaId, empresa]);
  if (!p) falha('Parcela não encontrada.', 404);
  if (p.status !== 'aberta' && p.status !== 'parcial') falha(`Parcela ${p.status}.`);
  const params = await parametros(pool, empresa);
  const e = entradaDe(p, params, d);
  const [[f]]: any = await pool.query(`SELECT ${L.saldoCredito} AS saldo FROM fin_pessoas_financeiro WHERE empresa_id = ? AND pessoa_id = ?`, [empresa, p.pessoa_id]);
  return {
    ...calcularBaixa({ ...e, valorPago: valorPagoDe(e, d) }),
    total_dia: totalDoDia(e),
    credito_disponivel: round2(f?.saldo ?? 0).toFixed(2),
    modo_imputacao: params.modo_imputacao,
  };
}

export function createBaixasRouter() {
  const r = Router();

  r.post('/:lado/parcelas/:id/simular-baixa', rota(async (req, _res, s) => simular(s, ladoDe(req.params.lado), Number(req.params.id), req.body)));

  r.post('/:lado/parcelas/:id/baixas', rota(async (req, res, s) => {
    const lado = ladoDe(req.params.lado);
    const d = validar(schemaBaixa, req.body);
    const out = await transacao((c) => baixar(c, s, req, lado, Number(req.params.id), d));
    await processarAgora(s);
    res.status(201);
    return out;
  }));

  r.post('/:lado/baixas/lote', rota(async (req, res, s) => {
    const lado = ladoDe(req.params.lado);
    const out = await transacao((c) => baixarLote(c, s, req, lado, req.body));
    await processarAgora(s);
    res.status(201);
    return out;
  }));

  r.post('/:lado/baixas/:id/estornar', rota(async (req, _res, s) => {
    const lado = ladoDe(req.params.lado);
    const motivo = String(req.body?.motivo ?? '').trim();
    if (!motivo) falha('Informe o motivo do estorno.');
    return transacao((c) => estornar(c, s, req, lado, Number(req.params.id), motivo.slice(0, 255)));
  }));

  return r;
}
