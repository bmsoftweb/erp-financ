import { Router, type Request } from 'express';
import Decimal from 'decimal.js';
import { z } from 'zod';
import { masterPool as pool, transacao, hojeSql } from './db.js';
import { falha, rota } from './http.js';
import type { SessionData } from './session.js';
import { LADOS, ladoDe, empresaDe, usuarioDe, parametros, contaParam, exigir, conferirPeriodo, auditar, type Db, type Lado } from './comum.js';
import { calcularBaixa, totalDoDia } from './calculo.js';
import { distribuir, percentuais } from './rateio.js';
import { baixar, entradaDe } from './baixas.js';
import { instruirBoletos } from './eventos.js';
import { atualizarStatusTitulo, cancelarTitulo, criarTitulo, dataZ, dinheiroZ, idZ, textoZ, validar } from './titulos.js';

/**
 * Compensação (parcela a receber × a pagar da mesma pessoa, sem conta financeira) e renegociação (parcelas em aberto
 * da mesma pessoa viram um título novo; as originais ficam 'renegociada' e voltam se a renegociação for desfeita).
 */

const valorZ = z.union([z.string(), z.number()]).transform(String).refine((v) => /^\d{1,13}(\.\d{1,2})?$/.test(v), 'valor inválido');

// ------------------------------------------------------------------ compensação

const schemaCompensacao = z.object({
  receber_parcela_id: idZ,
  pagar_parcela_id: idZ,
  data_pagamento: dataZ,
  /** Sem valor: o menor dos dois totais do dia (quita a menor) */
  valor: dinheiroZ.nullish(),
  observacoes: textoZ(5000),
});

async function compensar(c: Db, s: SessionData, req: Request, corpo: unknown) {
  const d = validar(schemaCompensacao, corpo);
  const empresa = empresaDe(s);
  await exigir(s, 'baixar');
  const params = await parametros(c, empresa);
  const lados = { receber: d.receber_parcela_id, pagar: d.pagar_parcela_id };
  const totais: Record<Lado, Decimal> = { receber: new Decimal(0), pagar: new Decimal(0) };
  const pessoas: number[] = [];
  for (const lado of ['receber', 'pagar'] as Lado[]) {
    const L = LADOS[lado];
    const [[p]]: any = await c.query(
      `SELECT p.*, t.pessoa_id FROM ${L.parcelas} p JOIN ${L.titulos} t ON t.id = p.titulo_id WHERE p.id = ? AND p.empresa_id = ? FOR UPDATE`,
      [lados[lado], empresa],
    );
    if (!p) falha(`Parcela ${L.nome} não encontrada.`, 404);
    pessoas.push(Number(p.pessoa_id));
    totais[lado] = new Decimal(totalDoDia(entradaDe(p, params, d)));
  }
  if (pessoas[0] !== pessoas[1]) falha('Compensação só entre parcelas da mesma pessoa (cliente e fornecedor iguais).');
  const maximo = Decimal.min(totais.receber, totais.pagar);
  const valor = d.valor ? new Decimal(d.valor) : maximo;
  if (valor.gt(maximo)) falha(`Valor maior que o total do dia da menor parcela (${maximo.toFixed(2)}).`);

  const baixa = (lado: Lado) => baixar(c, s, req, lado, lados[lado], {
    data_pagamento: d.data_pagamento, data_conta: null, conta_financeira_id: null, forma_pagamento_id: null, valor_pago: valor.toFixed(2), principal: null,
    valor_tarifa: null, dispensa: null, motivo_dispensa: null, multa_informada: null, juros_informados: null, usar_credito: false,
    observacoes: d.observacoes ?? 'Compensação',
  }, { origem: 'compensacao', semConta: true });
  const r = await baixa('receber');
  const p = await baixa('pagar');
  await c.query('UPDATE fin_receber_baixas SET pagar_baixa_id = ? WHERE id = ?', [p.baixaId, r.baixaId]);
  await c.query('UPDATE fin_pagar_baixas SET receber_baixa_id = ? WHERE id = ?', [r.baixaId, p.baixaId]);
  return { valor: valor.toFixed(2), receber: r, pagar: p };
}

// ------------------------------------------------------------------ renegociação

interface ItemReneg { parcela: any; saldo: Decimal; multa: Decimal; juros: Decimal; dispensado: Decimal; total: Decimal }

/**
 * Saldo + multa + juros de cada parcela na data (sem desconto de pontualidade), dispensa repartida pelos encargos
 * (dentro de cada parcela, primeiro dos juros) e rateio do título novo: o saldo segue o rateio do título de origem;
 * juros e multa vão para as contas de juros/multa, nos centros do mesmo rateio.
 */
async function calcularRenegociacao(db: Db, s: SessionData, lado: Lado, ids: number[], data: string, dispensa: string | null | undefined, travar: boolean) {
  const L = LADOS[lado];
  const empresa = empresaDe(s);
  const unicos = [...new Set(ids)];
  const [ps]: any = await db.query(
    `SELECT p.*, t.pessoa_id, t.numero_documento FROM ${L.parcelas} p JOIN ${L.titulos} t ON t.id = p.titulo_id
      WHERE p.id IN (?) AND p.empresa_id = ? ORDER BY p.vencimento, p.id${travar ? ' FOR UPDATE' : ''}`,
    [unicos, empresa],
  );
  if (ps.length !== unicos.length) falha('Parcela não encontrada.');
  if (new Set(ps.map((p: any) => Number(p.pessoa_id))).size > 1) falha(`Renegociação só com parcelas do mesmo ${L.pessoa}.`);
  for (const p of ps) if (p.status !== 'aberta' && p.status !== 'parcial') falha(`Parcela ${p.numero}/${p.total_parcelas} ${p.status}: não pode ser renegociada.`);

  const params = await parametros(db, empresa);
  const itens: ItemReneg[] = ps.map((p: any) => {
    const e = { ...entradaDe(p, params, { data_pagamento: data }), descontoPct: '0', descontoAte: null };
    const r = calcularBaixa({ ...e, valorPago: totalDoDia(e) });
    return { parcela: p, saldo: new Decimal(p.saldo), multa: new Decimal(r.multaDevida), juros: new Decimal(r.jurosDevidos), dispensado: new Decimal(0), total: new Decimal(0) };
  });
  const encargos = itens.reduce((a, i) => a.plus(i.multa).plus(i.juros), new Decimal(0));
  const D = new Decimal(dispensa || 0);
  if (D.gt(encargos)) falha(`Dispensa maior que os encargos (${encargos.toFixed(2)}).`);
  const partes = D.gt(0) ? distribuir(D, itens.map((i) => i.multa.plus(i.juros))) : itens.map(() => '0.00');
  itens.forEach((i, k) => {
    i.dispensado = new Decimal(partes[k]);
    const dj = Decimal.min(i.dispensado, i.juros);
    i.juros = i.juros.minus(dj);
    i.multa = i.multa.minus(i.dispensado.minus(dj));
    i.total = i.saldo.plus(i.multa).plus(i.juros);
  });

  // Rateio do título novo, por valor em cada (conta, centro)
  const pesos = new Map<string, Decimal>();
  const somar = (conta: number, centro: number, v: string) => pesos.set(`${conta}|${centro}`, (pesos.get(`${conta}|${centro}`) ?? new Decimal(0)).plus(v));
  const contaJuros = itens.some((i) => i.juros.gt(0)) ? contaParam(params, L.contaJuros, lado === 'receber' ? 'Juros recebidos' : 'Juros pagos') : 0;
  const contaMulta = itens.some((i) => i.multa.gt(0)) ? contaParam(params, L.contaMulta, lado === 'receber' ? 'Multas recebidas' : 'Multas pagas') : 0;
  for (const i of itens) {
    const [rs]: any = await db.query(`SELECT plano_conta_id, centro_custo_id, percentual FROM ${L.rateios} WHERE titulo_id = ? ORDER BY id`, [i.parcela.titulo_id]);
    if (!rs.length) falha(`Título ${i.parcela.titulo_id} sem rateio.`);
    const pcts = rs.map((r: any) => r.percentual);
    distribuir(i.saldo, pcts).forEach((v, k) => somar(rs[k].plano_conta_id, rs[k].centro_custo_id, v));
    if (i.juros.gt(0)) distribuir(i.juros, pcts).forEach((v, k) => somar(contaJuros, rs[k].centro_custo_id, v));
    if (i.multa.gt(0)) distribuir(i.multa, pcts).forEach((v, k) => somar(contaMulta, rs[k].centro_custo_id, v));
  }
  const linhas = [...pesos.entries()].filter(([, v]) => v.gt(0));
  const pct = percentuais(linhas.map(([, v]) => v));
  const rateios = linhas.map(([k], n) => ({ plano_conta_id: Number(k.split('|')[0]), centro_custo_id: Number(k.split('|')[1]), percentual: pct[n] }));

  const soma = (f: (i: ItemReneg) => Decimal) => itens.reduce((a, i) => a.plus(f(i)), new Decimal(0)).toFixed(2);
  return {
    pessoa_id: Number(ps[0].pessoa_id),
    itens,
    saldo: soma((i) => i.saldo),
    encargos: encargos.toFixed(2),
    dispensado: soma((i) => i.dispensado),
    total: soma((i) => i.total),
    rateios,
  };
}

const schemaSimular = z.object({ tipo: z.enum(['receber', 'pagar']), parcelas: z.array(idZ).min(1).max(200), data: dataZ, dispensa: valorZ.nullish() });

const schemaReneg = schemaSimular.extend({
  motivo_dispensa: textoZ(255),
  observacoes: textoZ(5000),
  parcelas_novas: z.array(z.object({ vencimento: dataZ, valor: dinheiroZ, forma_pagamento_id: idZ.nullish() })).min(1).max(360),
});

async function renegociar(c: Db, s: SessionData, req: Request, corpo: unknown) {
  const d = validar(schemaReneg, corpo);
  const lado = d.tipo;
  const L = LADOS[lado];
  const empresa = empresaDe(s);
  await exigir(s, 'baixar');
  if (Number(d.dispensa || 0) > 0) {
    await exigir(s, 'dispensar');
    if (!d.motivo_dispensa) falha('Informe o motivo da dispensa dos encargos.');
  }
  if (d.data > (await hojeSql(c))) falha('Data da renegociação no futuro.');
  await conferirPeriodo(c, s, d.data);
  const r = await calcularRenegociacao(c, s, lado, d.parcelas, d.data, d.dispensa, true);
  const novas = d.parcelas_novas.reduce((a, x) => a.plus(x.valor), new Decimal(0));
  if (!novas.eq(r.total)) falha(`Soma das parcelas novas (${novas.toFixed(2)}) diferente do total renegociado (${r.total}).`);

  const [ri]: any = await c.query('INSERT INTO fin_renegociacoes SET ?', [{
    empresa_id: empresa, tipo: lado, pessoa_id: r.pessoa_id, valor_saldo: r.saldo, valor_encargos: r.encargos, valor_dispensado: r.dispensado,
    valor_total: r.total, observacoes: [d.observacoes, Number(r.dispensado) ? `Dispensa: ${d.motivo_dispensa}` : null].filter(Boolean).join('\n') || null, usuario_id: usuarioDe(s),
  }]);
  const renegId = Number(ri.insertId);
  const t = await criarTitulo(c, s, req, lado, {
    pessoa_id: r.pessoa_id, origem: 'renegociacao', origem_id: renegId, numero_documento: `Renegociação ${renegId}`,
    data_emissao: d.data, data_competencia: d.data, valor_total: r.total,
    historico: `Renegociação ${renegId}: ${r.itens.length} parcela(s)`, observacoes: d.observacoes, rateios: r.rateios,
    parcelas: d.parcelas_novas.map((x, i) => ({ ...x, documento: `R${renegId}/${i + 1}` })),
  });
  await c.query(`UPDATE fin_renegociacoes SET ${lado}_titulo_id = ? WHERE id = ?`, [t.id, renegId]);

  for (const i of r.itens) {
    await c.query('INSERT INTO fin_renegociacao_parcelas SET ?', [{
      renegociacao_id: renegId, [`${lado}_parcela_id`]: i.parcela.id, saldo: i.saldo.toFixed(2), multa: i.multa.toFixed(2), juros: i.juros.toFixed(2), dispensado: i.dispensado.toFixed(2),
    }]);
    await c.query(`UPDATE ${L.parcelas} SET status = 'renegociada' WHERE id = ?`, [i.parcela.id]);
    if (lado === 'receber') await instruirBoletos(c, s, i.parcela.id, 'baixar');
    await auditar(c, s, req, L.parcelas, i.parcela.id, 'renegociar', { status: i.parcela.status, saldo: i.parcela.saldo }, { status: 'renegociada', renegociacao_id: renegId, titulo_novo: t.id });
  }
  for (const id of new Set(r.itens.map((i) => Number(i.parcela.titulo_id)))) await atualizarStatusTitulo(c, lado, id);
  if (Number(r.dispensado) > 0) await auditar(c, s, req, 'fin_renegociacoes', renegId, 'dispensar', null, { valor_dispensado: r.dispensado, motivo: d.motivo_dispensa });
  await auditar(c, s, req, 'fin_renegociacoes', renegId, 'criar', null, { ...d, saldo: r.saldo, encargos: r.encargos, dispensado: r.dispensado, total: r.total, titulo_id: t.id });
  return { id: renegId, titulo_id: t.id, total: r.total };
}

/** Desfazer: cancela o título novo (sem baixa) e devolve as parcelas originais ao estado de antes */
async function desfazer(c: Db, s: SessionData, req: Request, id: number, motivo: string) {
  await exigir(s, 'estornar');
  const [[g]]: any = await c.query('SELECT * FROM fin_renegociacoes WHERE id = ? AND empresa_id = ? FOR UPDATE', [id, empresaDe(s)]);
  if (!g) falha('Renegociação não encontrada.', 404);
  const lado = ladoDe(g.tipo);
  const L = LADOS[lado];
  const r = await cancelarTitulo(c, s, req, lado, Number(g[`${lado}_titulo_id`]), `Renegociação desfeita: ${motivo}`.slice(0, 255), true);
  if ('jaCancelado' in r) falha('Renegociação já desfeita.');
  const [ps]: any = await c.query(
    `SELECT p.id, p.titulo_id FROM fin_renegociacao_parcelas rp JOIN ${L.parcelas} p ON p.id = rp.${lado}_parcela_id WHERE rp.renegociacao_id = ? FOR UPDATE`,
    [id],
  );
  for (const p of ps) {
    await c.query(`UPDATE ${L.parcelas} SET status = IF(saldo = valor_original, 'aberta', 'parcial') WHERE id = ? AND status = 'renegociada'`, [p.id]);
    await auditar(c, s, req, L.parcelas, p.id, 'desfazer_renegociacao', { status: 'renegociada' }, { renegociacao_id: id, motivo });
  }
  for (const t of new Set<number>(ps.map((p: any) => Number(p.titulo_id)))) await atualizarStatusTitulo(c, lado, t);
  await auditar(c, s, req, 'fin_renegociacoes', id, 'desfazer', null, { motivo });
  return { id, parcelas: ps.length };
}

export function createAcordosRouter() {
  const r = Router();
  r.post('/compensacoes', rota(async (req, res, s) => {
    const out = await transacao((c) => compensar(c, s, req, req.body));
    res.status(201);
    return out;
  }));
  r.post('/renegociacoes/simular', rota(async (req, _res, s) => {
    const d = validar(schemaSimular, req.body);
    const r = await calcularRenegociacao(pool, s, d.tipo, d.parcelas, d.data, d.dispensa, false);
    return {
      ...r,
      itens: r.itens.map((i) => ({
        id: i.parcela.id, documento: i.parcela.numero_documento, numero: i.parcela.numero, total_parcelas: i.parcela.total_parcelas, vencimento: i.parcela.vencimento,
        saldo: i.saldo.toFixed(2), multa: i.multa.toFixed(2), juros: i.juros.toFixed(2), dispensado: i.dispensado.toFixed(2), total: i.total.toFixed(2),
      })),
    };
  }));
  r.post('/renegociacoes', rota(async (req, res, s) => {
    const out = await transacao((c) => renegociar(c, s, req, req.body));
    res.status(201);
    return out;
  }));
  r.post('/renegociacoes/:id/desfazer', rota(async (req, _res, s) => {
    const motivo = String(req.body?.motivo ?? '').trim();
    if (!motivo) falha('Informe o motivo.');
    return transacao((c) => desfazer(c, s, req, Number(req.params.id), motivo));
  }));
  return r;
}
