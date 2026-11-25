import { Router, type Request } from 'express';
import Decimal from 'decimal.js';
import { z } from 'zod';
import { masterPool as pool, transacao, hojeSql } from './db.js';
import { falha, rota, rotaModulo } from './http.js';
import type { SessionData } from './session.js';
import { auditar, contaParam, empresaDe, exigir, parametros, usuarioDe, type Db } from './comum.js';
import { round2 } from './calculo.js';
import { distribuir, planoRecebivel } from './rateio.js';
import { baixar, validarBaixa } from './baixas.js';
import { criarTitulo, dataZ, dinheiroZ, idZ, textoZ, validar } from './titulos.js';

/**
 * Cartão: a parcela do cliente é quitada sem conta e sem lançamento (vira recebível) e nasce um título a receber
 * contra o adquirente (origem cartao_adquirente), uma parcela por mês, líquido da taxa de fin_taxas_cartao, com o
 * rateio do título do cliente. Quando o adquirente paga, a baixa lança a receita bruta e a taxa como despesa
 * (lancar em baixas.ts). Antecipação = baixa antecipada com o custo em conta_antecipacao_id.
 */

const pctZ = z.union([z.string(), z.number()]).transform(String).refine((v) => /^\d{1,3}(\.\d{1,4})?$/.test(v) && Number(v) < 100, 'percentual inválido');
const valorZ = z.union([z.string(), z.number()]).transform(String).refine((v) => /^\d{1,13}(\.\d{1,2})?$/.test(v), 'valor inválido');

const schemaTaxa = z.object({
  adquirente_id: idZ,
  bandeira: z.string().trim().min(1, 'informe a bandeira').max(30),
  modalidade: z.enum(['debito', 'credito']),
  parcelas_de: z.coerce.number().int().min(1).max(99),
  parcelas_ate: z.coerce.number().int().min(1).max(99),
  taxa_pct: pctZ,
  taxa_fixa: valorZ.default('0'),
  dias_repasse: z.coerce.number().int().min(0).max(400),
  ativo: z.union([z.boolean(), z.number()]).default(true).transform((v) => (v ? 1 : 0)),
}).refine((d) => d.parcelas_ate >= d.parcelas_de, { message: 'parcelas_ate: menor que parcelas_de', path: ['parcelas_ate'] });

const schemaTransacao = z.object({
  parcela_id: idZ,
  adquirente_id: idZ,
  /** Cadastro (cad_pessoas) do adquirente; sem ele, o da última transação deste adquirente */
  adquirente_pessoa_id: idZ.nullish(),
  bandeira: z.string().trim().min(1, 'informe a bandeira').max(30),
  modalidade: z.enum(['debito', 'credito']),
  parcelas: z.coerce.number().int().min(1).max(99).default(1),
  nsu: textoZ(40),
  autorizacao: textoZ(128),
  origem: z.enum(['maquininha', 'link', 'ecommerce', 'pdv']).default('maquininha'),
  data_venda: dataZ.nullish(),
  link_id: textoZ(80),
});

async function adquirente(c: Db, empresa: number, id: number) {
  const [[a]]: any = await c.query("SELECT * FROM fin_contas_financeiras WHERE id = ? AND empresa_id = ? AND tipo = 'adquirente'", [id, empresa]);
  return a ?? falha('Adquirente não encontrado (conta financeira do tipo adquirente).');
}

async function registrarTransacao(c: Db, s: SessionData, req: Request | null, corpo: unknown) {
  const empresa = empresaDe(s);
  const d = validar(schemaTransacao, corpo);
  if (d.modalidade === 'debito' && d.parcelas !== 1) falha('Débito é sempre em 1 parcela.');
  const adq = await adquirente(c, empresa, d.adquirente_id);
  const [[taxa]]: any = await c.query(
    `SELECT * FROM fin_taxas_cartao WHERE empresa_id = ? AND adquirente_id = ? AND bandeira = ? AND modalidade = ? AND ? BETWEEN parcelas_de AND parcelas_ate AND ativo = 1
      ORDER BY parcelas_de DESC LIMIT 1`,
    [empresa, adq.id, d.bandeira, d.modalidade, d.parcelas],
  );
  if (!taxa) falha(`Sem taxa para ${adq.nome}, ${d.bandeira}, ${d.modalidade} em ${d.parcelas}x (Cadastros › Taxas de cartão).`);
  const [[cli]]: any = await c.query(
    'SELECT p.id, p.numero, p.total_parcelas, t.id AS titulo_id, t.origem, t.numero_documento, t.data_competencia FROM fin_receber_parcelas p JOIN fin_receber_titulos t ON t.id = p.titulo_id WHERE p.id = ? AND p.empresa_id = ?',
    [d.parcela_id, empresa],
  );
  if (!cli) falha('Parcela não encontrada.', 404);
  if (cli.origem === 'cartao_adquirente') falha('Esta parcela já é um recebível de cartão.');
  const pessoaAdq = d.adquirente_pessoa_id ?? (await c.query(
    `SELECT t.pessoa_id FROM fin_cartao_transacoes x JOIN fin_receber_titulos t ON t.id = x.titulo_recebivel_id
      WHERE x.empresa_id = ? AND x.adquirente_id = ? ORDER BY x.id DESC LIMIT 1`, [empresa, adq.id],
  ).then(([l]: any) => l[0]?.pessoa_id)) ?? falha(`Informe o cadastro (pessoa) do adquirente ${adq.nome}: o recebível é um título contra ele.`);
  const dataVenda = d.data_venda ?? (await hojeSql(c));

  const [ins]: any = await c.query('INSERT INTO fin_cartao_transacoes SET ?', [{
    empresa_id: empresa, adquirente_id: adq.id, origem: d.origem, nsu: d.nsu, autorizacao: d.autorizacao, bandeira: d.bandeira, modalidade: d.modalidade,
    parcelas: d.parcelas, valor_bruto: '0.00', taxa_pct: taxa.taxa_pct, valor_liquido: '0.00', link_id: d.link_id, data_venda: dataVenda, usuario_id: usuarioDe(s),
  }]);
  const transacaoId = Number(ins.insertId);

  // 1. Cliente: quitado pelo total do dia, sem conta e sem lançamento (a receita entra quando o adquirente paga)
  const b = await baixar(c, s, req, 'receber', cli.id, validarBaixa({ data_pagamento: dataVenda, observacoes: `Cartão ${d.bandeira} ${d.modalidade} ${d.parcelas}x${d.nsu ? `, NSU ${d.nsu}` : ''}` }), { origem: 'cartao', semConta: true, semLancamento: true });
  const bruto = new Decimal(b.resultado.valorPago);
  const valorTaxa = round2(bruto.times(taxa.taxa_pct).div(100).plus(taxa.taxa_fixa));
  if (valorTaxa.gte(bruto)) falha('Taxa do cartão maior que o valor.');
  const plano = planoRecebivel(bruto, valorTaxa, d.parcelas, dataVenda, Number(taxa.dias_repasse));

  // 2. Recebível contra o adquirente, com o rateio do título do cliente
  const [rateios]: any = await c.query('SELECT plano_conta_id, centro_custo_id, percentual FROM fin_receber_titulo_rateios WHERE titulo_id = ? ORDER BY id', [cli.titulo_id]);
  const liquido = bruto.minus(valorTaxa).toFixed(2);
  const t = await criarTitulo(c, s, req, 'receber', {
    pessoa_id: pessoaAdq, origem: 'cartao_adquirente', origem_id: transacaoId, numero_documento: d.nsu ? `NSU ${d.nsu}` : `CARTAO-${transacaoId}`,
    data_emissao: dataVenda, data_competencia: String(cli.data_competencia).slice(0, 10), valor_total: liquido,
    historico: `${adq.nome} ${d.bandeira} ${d.modalidade} ${d.parcelas}x: ${cli.numero_documento ?? `título ${cli.titulo_id}`} parc. ${cli.numero}/${cli.total_parcelas}`.slice(0, 255),
    rateios: rateios.map((r: any) => ({ plano_conta_id: r.plano_conta_id, centro_custo_id: r.centro_custo_id, percentual: r.percentual })),
    parcelas: plano.map((x) => ({ vencimento: x.vencimento, valor: x.valor, documento: d.nsu, conta_financeira_id: adq.id })),
  });
  // Recebível de adquirente não tem encargo de atraso nem desconto
  await c.query('UPDATE fin_receber_parcelas SET multa_pct = 0, juros_mes_pct = 0, desconto_pct = 0, desconto_ate = NULL WHERE titulo_id = ?', [t.id]);
  await c.query('UPDATE fin_cartao_transacoes SET valor_bruto = ?, valor_taxa = ?, valor_liquido = ?, receber_baixa_id = ?, titulo_recebivel_id = ? WHERE id = ?', [
    bruto.toFixed(2), valorTaxa.toFixed(2), liquido, b.baixaId, t.id, transacaoId,
  ]);
  await auditar(c, s, req, 'fin_cartao_transacoes', transacaoId, 'criar', null, { ...d, bruto: bruto.toFixed(2), taxa: valorTaxa.toFixed(2), liquido, titulo_recebivel_id: t.id, plano });
  return { id: transacaoId, baixa_id: b.baixaId, titulo_recebivel_id: t.id, bruto: bruto.toFixed(2), taxa: valorTaxa.toFixed(2), liquido, plano };
}

const schemaAntecipar = z.object({
  parcelas: z.array(idZ).min(1).max(500),
  data: dataZ,
  conta_financeira_id: idZ,
  /** O que caiu na conta; a diferença para o saldo é o custo da antecipação */
  valor_liquido: dinheiroZ,
  observacoes: textoZ(5000),
});

/** Antecipação: baixa os recebíveis pelo saldo; o custo (saldo − líquido) é repartido pelo saldo de cada um */
async function antecipar(c: Db, s: SessionData, req: Request | null, corpo: unknown) {
  const empresa = empresaDe(s);
  const d = validar(schemaAntecipar, corpo);
  const params = await parametros(c, empresa);
  const contaCusto = contaParam(params, 'conta_antecipacao_id', 'Custo de antecipação');
  const [ps]: any = await c.query(
    `SELECT p.id, p.saldo, p.status, t.origem FROM fin_receber_parcelas p JOIN fin_receber_titulos t ON t.id = p.titulo_id
      WHERE p.id IN (?) AND p.empresa_id = ? ORDER BY p.vencimento, p.id FOR UPDATE`,
    [d.parcelas, empresa],
  );
  if (ps.length !== new Set(d.parcelas).size) falha('Parcela não encontrada.');
  const ruim = ps.find((p: any) => p.origem !== 'cartao_adquirente' || (p.status !== 'aberta' && p.status !== 'parcial'));
  if (ruim) falha(`Parcela #${ruim.id}: só recebível de cartão em aberto pode ser antecipado.`);
  const total = ps.reduce((a: Decimal, p: any) => a.plus(p.saldo), new Decimal(0));
  const custo = total.minus(d.valor_liquido);
  if (custo.lt(0)) falha(`Valor líquido maior que o saldo dos recebíveis (${total.toFixed(2)}).`);
  const custos = distribuir(custo, ps.map((p: any) => p.saldo));
  const baixas = [];
  for (const [i, p] of ps.entries()) {
    const b = await baixar(c, s, req, 'receber', p.id, validarBaixa({
      data_pagamento: d.data, conta_financeira_id: d.conta_financeira_id, valor_pago: p.saldo, valor_tarifa: custos[i],
      observacoes: d.observacoes ?? 'Antecipação de recebíveis de cartão',
    }), { origem: 'cartao', tarifa: { conta: contaCusto, natureza: 'antecipacao' } });
    baixas.push({ parcela_id: p.id, baixa_id: b.baixaId, custo: custos[i] });
  }
  await auditar(c, s, req, 'fin_receber_parcelas', ps[0].id, 'antecipar', null, { ...d, total: total.toFixed(2), custo: custo.toFixed(2), baixas });
  return { total: total.toFixed(2), custo: custo.toFixed(2), baixas };
}

export function createCartaoRouter() {
  const r = Router();

  r.get('/taxas-cartao', rota(async (_req, _res, s) => {
    const [l] = await pool.query(
      'SELECT x.*, cf.nome AS adquirente_nome FROM fin_taxas_cartao x JOIN fin_contas_financeiras cf ON cf.id = x.adquirente_id WHERE x.empresa_id = ? ORDER BY x.ativo DESC, cf.nome, x.bandeira, x.modalidade, x.parcelas_de',
      [empresaDe(s)],
    );
    return l;
  }));
  r.post('/taxas-cartao', rota(async (req, _res, s) => {
    await exigir(s, 'contas');
    const d = validar(schemaTaxa, req.body);
    await adquirente(pool, empresaDe(s), d.adquirente_id);
    const [ins]: any = await pool.query('INSERT INTO fin_taxas_cartao SET ?', [{ ...d, empresa_id: empresaDe(s), usuario_id: usuarioDe(s) }]);
    await auditar(pool, s, req, 'fin_taxas_cartao', ins.insertId, 'criar', null, d);
    return { id: ins.insertId };
  }));
  r.patch('/taxas-cartao/:id', rota(async (req, _res, s) => {
    await exigir(s, 'contas');
    const d = validar(schemaTaxa, req.body);
    await adquirente(pool, empresaDe(s), d.adquirente_id);
    const [res]: any = await pool.query('UPDATE fin_taxas_cartao SET ? WHERE id = ? AND empresa_id = ?', [d, req.params.id, empresaDe(s)]);
    if (!res.affectedRows) falha('Taxa não encontrada.', 404);
    await auditar(pool, s, req, 'fin_taxas_cartao', Number(req.params.id), 'alterar', null, d);
  }));
  // Exclusão lógica: transações antigas guardam a taxa usada
  r.delete('/taxas-cartao/:id', rota(async (req, _res, s) => {
    await exigir(s, 'contas');
    const [res]: any = await pool.query('UPDATE fin_taxas_cartao SET ativo = 0 WHERE id = ? AND empresa_id = ?', [req.params.id, empresaDe(s)]);
    if (!res.affectedRows) falha('Taxa não encontrada.', 404);
    await auditar(pool, s, req, 'fin_taxas_cartao', Number(req.params.id), 'excluir', null, null);
  }));

  r.get('/cartao/transacoes', rota(async (req, _res, s) => {
    const where = ['x.empresa_id = ?'];
    const p: unknown[] = [empresaDe(s)];
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.de || ''))) where.push('x.data_venda >= ?'), p.push(req.query.de);
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.ate || ''))) where.push('x.data_venda < ? + INTERVAL 1 DAY'), p.push(req.query.ate);
    const [l] = await pool.query(
      `SELECT x.*, cf.nome AS adquirente_nome, t.status AS recebivel_status, pe.nome AS cliente_nome, tc.numero_documento AS cliente_documento
         FROM fin_cartao_transacoes x JOIN fin_contas_financeiras cf ON cf.id = x.adquirente_id
         LEFT JOIN fin_receber_titulos t ON t.id = x.titulo_recebivel_id
         LEFT JOIN fin_receber_baixas b ON b.id = x.receber_baixa_id
         LEFT JOIN fin_receber_parcelas pc ON pc.id = b.parcela_id
         LEFT JOIN fin_receber_titulos tc ON tc.id = pc.titulo_id
         LEFT JOIN cad_pessoas pe ON pe.id = tc.pessoa_id
        WHERE ${where.join(' AND ')} ORDER BY x.data_venda DESC, x.id DESC LIMIT 3000`,
      p,
    );
    return l;
  }));

  /** Tela ou erp-vendas/PDV (chave de API) */
  r.post('/cartao/transacoes', rotaModulo(async (req, res, s) => {
    res.status(201);
    return transacao((c) => registrarTransacao(c, s, req, req.body));
  }));

  /** Recebíveis de cartão em aberto (para antecipar) */
  r.get('/cartao/recebiveis', rota(async (_req, _res, s) => {
    const [l] = await pool.query(
      `SELECT p.id, p.numero, p.total_parcelas, p.vencimento, p.saldo, p.valor_original, p.status, t.numero_documento, t.historico, x.bandeira, x.modalidade,
              x.adquirente_id, cf.nome AS adquirente_nome
         FROM fin_receber_parcelas p JOIN fin_receber_titulos t ON t.id = p.titulo_id
         JOIN fin_cartao_transacoes x ON x.titulo_recebivel_id = t.id JOIN fin_contas_financeiras cf ON cf.id = x.adquirente_id
        WHERE p.empresa_id = ? AND t.origem = 'cartao_adquirente' AND p.status IN ('aberta','parcial') ORDER BY p.vencimento, p.id`,
      [empresaDe(s)],
    );
    return l;
  }));

  r.post('/cartao/antecipar', rota(async (req, _res, s) => transacao((c) => antecipar(c, s, req, req.body))));

  return r;
}
