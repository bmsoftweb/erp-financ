/**
 * Teste de ponta a ponta contra o servidor rodando e o banco do .env: GRAVA dados na empresa informada.
 * Uso: npx tsx server/teste-banco.ts <empresa_id> <porta> [usuario_id]
 * Monta um cookie de sessão de administrador, chama a API como a tela chama e confere o resultado direto no banco.
 */
import 'dotenv/config';
import assert from 'node:assert/strict';
import Decimal from 'decimal.js';
import crypto from 'node:crypto';
import { sealData } from 'iron-session';
import { masterPool as db } from './db.js';
import { somarDias } from './comum.js';

const [empresa, porta, usuario] = [Number(process.argv[2]), Number(process.argv[3]), Number(process.argv[4] || 3)];
if (!Number.isInteger(empresa) || !porta) {
  console.error('Uso: npx tsx server/teste-banco.ts <empresa_id> <porta> [usuario_id]');
  process.exit(1);
}

let cookie = '';
async function chamar(metodo: string, caminho: string, corpo?: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`http://localhost:${porta}/api/financ${caminho}`, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}
async function ok(metodo: string, caminho: string, corpo?: unknown) {
  const r = await chamar(metodo, caminho, corpo);
  if (r.status >= 300) throw new Error(`${metodo} ${caminho} → ${r.status}: ${r.json?.error}`);
  return r.json;
}
async function recusa(metodo: string, caminho: string, corpo: unknown, trecho: string) {
  const r = await chamar(metodo, caminho, corpo);
  assert.ok(r.status >= 400, `${caminho} deveria recusar (${trecho}), veio ${r.status}`);
  assert.ok(String(r.json?.error).includes(trecho), `mensagem "${r.json?.error}" sem "${trecho}"`);
}
/** Webhook do BMBancos assinado com FINANC_WEBHOOK_SECRET (o mesmo do servidor) */
async function webhook(corpo: unknown, assinatura?: string) {
  const bruto = JSON.stringify(corpo);
  const ass = assinatura ?? `sha256=${crypto.createHmac('sha256', process.env.FINANC_WEBHOOK_SECRET || '').update(bruto).digest('hex')}`;
  const r = await fetch(`http://localhost:${porta}/api/financ/webhooks/bancos`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Assinatura': ass }, body: bruto });
  return { status: r.status, json: (await r.json().catch(() => null)) as any };
}
const linha = async (sql: string, p: unknown[] = []) => ((await db.query(sql, p)) as any)[0][0];
const linhas = async (sql: string, p: unknown[] = []) => ((await db.query(sql, p)) as any)[0] as any[];
const soma = (xs: any[], f: (x: any) => Decimal.Value) => xs.reduce((a, x) => a.plus(f(x)), new Decimal(0)).toFixed(2);
const passo = (t: string) => console.log(`✓ ${t}`);

/** Soma dos lançamentos com sinal = líquido do movimento − excedente (critério de aceite) */
async function conferirLancamentos(lado: 'receber' | 'pagar', baixaId: number, esperado: string) {
  const ls = await linhas(`SELECT sinal, valor FROM fin_lancamentos WHERE ${lado}_baixa_id = ?`, [baixaId]);
  const s = soma(ls, (l) => new Decimal(l.valor).times(l.sinal));
  assert.equal(s, esperado, `lançamentos da baixa ${lado} #${baixaId}: ${s} ≠ ${esperado}`);
}

async function main() {
  cookie = `bm_financ_sessao=${await sealData({ isLoggedIn: true, empresaId: empresa, userId: usuario, userName: 'teste', role: 'admin' }, { password: process.env.SESSION_SECRET! })}`;

  // 1. Semente
  const sem = await ok('POST', '/parametros/semear');
  const p = await ok('GET', '/parametros');
  assert.ok(!p.semPlano && !p.semRegua, 'semente não criou plano/régua');
  passo(`semente: plano ${sem.criado ? 'criado' : 'já existia'}, régua ${sem.regua ? 'criada' : 'já existia'}`);
  const etapas = await linha("SELECT COUNT(*) n FROM fin_regua_etapas WHERE empresa_id = ? AND perfil = 'padrao'", [empresa]);
  assert.equal(Number(etapas.n), 9);

  const { hoje } = await ok('GET', '/painel');
  const contas = await ok('GET', '/contas-financeiras');
  const caixa = contas.find((c: any) => c.nome === 'Caixa');
  assert.ok(caixa, 'sem conta Caixa');
  const [pa, pb] = await linhas('SELECT id, nome FROM cad_pessoas WHERE grupo_id = (SELECT grupo_id FROM sys_empresas WHERE id = ?) AND date_delete IS NULL ORDER BY id LIMIT 2', [empresa]);
  assert.ok(pa && pb, 'precisa de 2 pessoas no grupo');
  const marca = `T${Date.now().toString(36)}`;
  const titulo = (lado: string, pessoa: number, valor: string, vencimentos: [string, string][], extra = {}) =>
    ok('POST', `/${lado}/titulos`, { pessoa_id: pessoa, numero_documento: `${marca}-${lado}-${valor}`, data_emissao: somarDias(hoje, -40), valor_total: valor, parcelas: vencimentos.map(([vencimento, v]) => ({ vencimento, valor: v })), ...extra });
  const parcelas = async (lado: string, tituloId: number) => (await ok('GET', `/${lado}/titulos/${tituloId}`)).parcelas;

  // 2. Título a receber + rateio padrão
  const t1 = await titulo('receber', pa.id, '1000.00', [[somarDias(hoje, -30), '1000.00']]);
  const [p1] = await parcelas('receber', t1.id);
  const rat = await linhas('SELECT percentual, valor FROM fin_receber_titulo_rateios WHERE titulo_id = ?', [t1.id]);
  assert.equal(rat.length, 1);
  assert.equal(Number(rat[0].percentual), 100);
  passo(`título a receber #${t1.id} com rateio 100% (conta e centro padrão)`);

  // 3. Baixa parcial (caso 1a): 1.000, 30 dias, multa 2%, juros 1% a.m., paga 500
  const sim = await ok('POST', `/receber/parcelas/${p1.id}/simular-baixa`, { data_pagamento: hoje });
  assert.equal(sim.total_dia, '1030.00');
  const b1 = await ok('POST', `/receber/parcelas/${p1.id}/baixas`, { data_pagamento: hoje, conta_financeira_id: caixa.id, valor_pago: '500.00' });
  assert.deepEqual([b1.resultado.valorMulta, b1.resultado.valorJuros, b1.resultado.valorPrincipal, b1.resultado.saldoDepois], ['9.71', '4.85', '485.44', '514.56']);
  assert.equal(b1.status, 'parcial');
  const m1 = await linha('SELECT tipo, valor, conta_financeira_id FROM fin_movimentos WHERE id = ?', [b1.movimentoId]);
  assert.deepEqual([m1.tipo, m1.valor, m1.conta_financeira_id], ['entrada', '500.00', caixa.id]);
  await conferirLancamentos('receber', b1.baixaId, '500.00');
  passo('baixa parcial 500,00: multa 9,71 · juros 4,85 · principal 485,44 · saldo 514,56 · movimento e lançamentos = 500,00');

  const sim2 = await ok('POST', `/receber/parcelas/${p1.id}/simular-baixa`, { data_pagamento: hoje });
  assert.equal(sim2.total_dia, '530.00');
  passo('total do dia do saldo que sobrou: 514,56 + 10,29 + 5,15 = 530,00');

  // 4. Estorno devolve o estado anterior
  await recusa('POST', `/receber/baixas/${b1.baixaId}/estornar`, {}, 'motivo');
  const e1 = await ok('POST', `/receber/baixas/${b1.baixaId}/estornar`, { motivo: 'teste' });
  const p1e = await linha('SELECT saldo, status FROM fin_receber_parcelas WHERE id = ?', [p1.id]);
  assert.deepEqual([p1e.saldo, p1e.status], ['1000.00', 'aberta']);
  const mov = await linhas("SELECT tipo, valor FROM fin_movimentos WHERE receber_baixa_id IN (?, ?)", [b1.baixaId, e1.estornoId]);
  assert.equal(soma(mov, (m) => new Decimal(m.valor).times(m.tipo === 'entrada' ? 1 : -1)), '0.00');
  await conferirLancamentos('receber', e1.estornoId, '-500.00');
  await recusa('POST', `/receber/baixas/${b1.baixaId}/estornar`, { motivo: 'de novo' }, 'já estornada');
  passo('estorno: saldo 1.000,00 e status aberta de volta; movimento e lançamentos inversos zeram; segundo estorno recusado');

  // 5. Idempotência pela origem
  const extra = { origem: 'recorrente', origem_id: 900000 + Math.floor(Math.random() * 99999) };
  const i1 = await chamar('POST', '/receber/titulos', { pessoa_id: pb.id, data_emissao: hoje, valor_total: '10.00', parcelas: [{ vencimento: hoje, valor: '10.00' }], ...extra });
  const i2 = await chamar('POST', '/receber/titulos', { pessoa_id: pb.id, data_emissao: hoje, valor_total: '10.00', parcelas: [{ vencimento: hoje, valor: '10.00' }], ...extra });
  assert.deepEqual([i1.status, i2.status, i2.json.id], [201, 200, i1.json.id]);
  passo('mesma origem duas vezes: 201 e depois 200 com o mesmo título');
  await recusa('POST', '/receber/titulos', { pessoa_id: pb.id, data_emissao: hoje, valor_total: '10.00', parcelas: [{ vencimento: hoje, valor: '9.99' }] }, 'Soma das parcelas');
  passo('parcelas que não somam o total: recusado');

  // 6. Compensação: receber 1.000 (30 dias) × pagar 300 da mesma pessoa
  const t2 = await titulo('pagar', pa.id, '300.00', [[somarDias(hoje, 10), '300.00']]);
  const [p2] = await parcelas('pagar', t2.id);
  const c1 = await ok('POST', '/compensacoes', { receber_parcela_id: p1.id, pagar_parcela_id: p2.id, data_pagamento: hoje });
  assert.equal(c1.valor, '300.00');
  assert.equal(c1.pagar.status, 'quitada');
  assert.deepEqual([c1.receber.resultado.valorMulta, c1.receber.resultado.valorJuros, c1.receber.resultado.valorPrincipal], ['5.83', '2.91', '291.26']);
  const br = await linha('SELECT pagar_baixa_id, conta_financeira_id, origem FROM fin_receber_baixas WHERE id = ?', [c1.receber.baixaId]);
  const bp = await linha('SELECT receber_baixa_id FROM fin_pagar_baixas WHERE id = ?', [c1.pagar.baixaId]);
  assert.deepEqual([Number(br.pagar_baixa_id), Number(bp.receber_baixa_id), br.conta_financeira_id, br.origem], [c1.pagar.baixaId, c1.receber.baixaId, null, 'compensacao']);
  assert.equal(Number((await linha('SELECT COUNT(*) n FROM fin_movimentos WHERE receber_baixa_id = ? OR pagar_baixa_id = ?', [c1.receber.baixaId, c1.pagar.baixaId])).n), 0);
  await conferirLancamentos('receber', c1.receber.baixaId, '300.00');
  await conferirLancamentos('pagar', c1.pagar.baixaId, '-300.00');
  passo('compensação 300,00: pagar quitada, receber parcial (principal 291,26), baixas ligadas, sem movimento de conta');
  await recusa('POST', '/compensacoes', { receber_parcela_id: p1.id, pagar_parcela_id: (await parcelas('pagar', (await titulo('pagar', pb.id, '50.00', [[hoje, '50.00']])).id))[0].id, data_pagamento: hoje }, 'mesma pessoa');
  passo('compensação entre pessoas diferentes: recusado');
  await ok('POST', `/pagar/baixas/${c1.pagar.baixaId}/estornar`, { motivo: 'teste compensação' });
  const [r1, r2] = [await linha('SELECT saldo, status FROM fin_receber_parcelas WHERE id = ?', [p1.id]), await linha('SELECT saldo, status FROM fin_pagar_parcelas WHERE id = ?', [p2.id])];
  assert.deepEqual([r1.saldo, r1.status, r2.saldo, r2.status], ['1000.00', 'aberta', '300.00', 'aberta']);
  passo('estorno da compensação pelo lado pagar desfaz os dois lados');

  // 7. Renegociação (exemplo do relatório): 1.000 com 30 dias + 500 com 10 dias, dispensa 11,67
  const t3 = await titulo('receber', pa.id, '500.00', [[somarDias(hoje, -10), '500.00']]);
  const [p3] = await parcelas('receber', t3.id);
  const rs = await ok('POST', '/renegociacoes/simular', { tipo: 'receber', parcelas: [p1.id, p3.id], data: hoje, dispensa: '11.67' });
  assert.deepEqual([rs.saldo, rs.encargos, rs.dispensado, rs.total], ['1500.00', '41.67', '11.67', '1530.00']);
  assert.ok(rs.rateios.reduce((a: Decimal, r: any) => a.plus(r.percentual), new Decimal(0)).eq(100));
  await recusa('POST', '/renegociacoes', { tipo: 'receber', parcelas: [p1.id, p3.id], data: hoje, dispensa: '11.67', parcelas_novas: [{ vencimento: somarDias(hoje, 30), valor: '1530.00' }] }, 'motivo');
  const rn = await ok('POST', '/renegociacoes', {
    tipo: 'receber', parcelas: [p1.id, p3.id], data: hoje, dispensa: '11.67', motivo_dispensa: 'teste',
    parcelas_novas: [{ vencimento: somarDias(hoje, 30), valor: '765.00' }, { vencimento: somarDias(hoje, 60), valor: '765.00' }],
  });
  const orig = await linhas('SELECT status FROM fin_receber_parcelas WHERE id IN (?, ?)', [p1.id, p3.id]);
  assert.ok(orig.every((o) => o.status === 'renegociada'));
  const tn = await linha('SELECT valor_total, origem, origem_id FROM fin_receber_titulos WHERE id = ?', [rn.titulo_id]);
  assert.deepEqual([tn.valor_total, tn.origem, Number(tn.origem_id)], ['1530.00', 'renegociacao', rn.id]);
  const rr = await linhas('SELECT percentual, valor FROM fin_receber_titulo_rateios WHERE titulo_id = ?', [rn.titulo_id]);
  assert.equal(soma(rr, (r) => r.percentual), '100.00');
  assert.equal(soma(rr, (r) => r.valor), '1530.00');
  passo(`renegociação #${rn.id}: título novo de 1.530,00 em 2× 765,00, rateio 100% (${rr.map((r) => r.percentual).join(' + ')}), originais renegociadas`);
  await recusa('POST', `/receber/titulos/${rn.titulo_id}/cancelar`, { motivo: 'x' }, 'Desfazer renegociação');
  await recusa('POST', `/receber/parcelas/${p1.id}/baixas`, { data_pagamento: hoje, conta_financeira_id: caixa.id, valor_pago: '10.00' }, 'renegociada');
  passo('título da renegociação não cancela direto; parcela renegociada não baixa');
  await ok('POST', `/renegociacoes/${rn.id}/desfazer`, { motivo: 'teste' });
  const volta = await linhas('SELECT status, saldo FROM fin_receber_parcelas WHERE id IN (?, ?) ORDER BY id', [p1.id, p3.id]);
  assert.deepEqual(volta.map((v) => [v.status, v.saldo]), [['aberta', '1000.00'], ['aberta', '500.00']]);
  assert.equal((await linha('SELECT status FROM fin_receber_titulos WHERE id = ?', [rn.titulo_id])).status, 'cancelado');
  await recusa('POST', `/renegociacoes/${rn.id}/desfazer`, { motivo: 'de novo' }, 'já desfeita');
  passo('desfazer: título novo cancelado, originais abertas com o saldo de antes; desfazer de novo recusado');

  // 8. Lote: 1.030 + 511,67 devidos, paga 1.200 → a mais antiga quitada, a outra parcial; um movimento só
  const lt = await ok('POST', '/receber/baixas/lote', { parcelas: [p3.id, p1.id], data_pagamento: hoje, conta_financeira_id: caixa.id, valor_total: '1200.00' });
  assert.equal(lt.baixas.length, 2);
  const [q1, q3] = [await linha('SELECT status, saldo FROM fin_receber_parcelas WHERE id = ?', [p1.id]), await linha('SELECT status, saldo FROM fin_receber_parcelas WHERE id = ?', [p3.id])];
  assert.deepEqual([q1.status, q3.status], ['quitada', 'parcial']);
  const ml = await linhas('SELECT valor FROM fin_movimentos WHERE lote_id = ?', [lt.loteId]);
  assert.deepEqual(ml.map((m) => m.valor), ['1200.00']);
  const lanc = await linhas('SELECT sinal, valor, movimento_id FROM fin_lancamentos WHERE receber_baixa_id IN (?)', [lt.baixas]);
  assert.equal(soma(lanc, (l) => new Decimal(l.valor).times(l.sinal)), '1200.00');
  assert.ok(lanc.every((l) => l.movimento_id != null));
  passo(`lote: 1.200,00 quita a de 1.030,00 e abate a outra (saldo ${q3.saldo}); um movimento de 1.200,00; lançamentos somam 1.200,00`);

  // 9. Crédito: pago a mais vira crédito do cliente e é usado em outra parcela
  const t4 = await titulo('receber', pb.id, '100.00', [[somarDias(hoje, 5), '100.00']]);
  const [p4] = await parcelas('receber', t4.id);
  const cr0 = new Decimal((await linha('SELECT saldo_credito_receber s FROM fin_pessoas_financeiro WHERE empresa_id = ? AND pessoa_id = ?', [empresa, pb.id]))?.s ?? 0);
  const b4 = await ok('POST', `/receber/parcelas/${p4.id}/baixas`, { data_pagamento: hoje, conta_financeira_id: caixa.id, valor_pago: '130.00' });
  assert.deepEqual([b4.status, b4.resultado.valorExcedente], ['quitada', '30.00']);
  await conferirLancamentos('receber', b4.baixaId, '100.00');
  const cr1 = new Decimal((await linha('SELECT saldo_credito_receber s FROM fin_pessoas_financeiro WHERE empresa_id = ? AND pessoa_id = ?', [empresa, pb.id])).s);
  assert.equal(cr1.minus(cr0).toFixed(2), '30.00');
  const t5 = await titulo('receber', pb.id, '20.00', [[somarDias(hoje, 5), '20.00']]);
  const [p5] = await parcelas('receber', t5.id);
  const b5 = await ok('POST', `/receber/parcelas/${p5.id}/baixas`, { data_pagamento: hoje, valor_pago: '20.00', usar_credito: true });
  assert.equal(b5.status, 'quitada');
  assert.equal(b5.movimentoId, null);
  const cr2 = new Decimal((await linha('SELECT saldo_credito_receber s FROM fin_pessoas_financeiro WHERE empresa_id = ? AND pessoa_id = ?', [empresa, pb.id])).s);
  assert.equal(cr2.minus(cr0).toFixed(2), '10.00');
  passo('pago a mais: 30,00 vira crédito; 20,00 usados em outra parcela, sem movimento; sobram 10,00');

  // 10. Aprovação de pagamentos acima do limite
  const params = (await ok('GET', '/parametros')).parametros;
  const campos = Object.fromEntries(Object.entries(params).filter(([k]) => !['id', 'empresa_id', 'usuario_id', 'criado_em', 'atualizado_em'].includes(k)));
  await ok('PUT', '/parametros', { ...campos, valor_aprovacao_pagamento: '200.00' });
  try {
    const t6 = await titulo('pagar', pa.id, '250.00', [[hoje, '250.00']]);
    const [p6] = await parcelas('pagar', t6.id);
    assert.equal(p6.aprovacao_status, 'pendente');
    await recusa('POST', `/pagar/parcelas/${p6.id}/baixas`, { data_pagamento: hoje, conta_financeira_id: caixa.id }, 'aguardando aprovação');
    await ok('POST', `/pagar/parcelas/${p6.id}/aprovar`, { aprovar: true });
    const b6 = await ok('POST', `/pagar/parcelas/${p6.id}/baixas`, { data_pagamento: hoje, conta_financeira_id: caixa.id });
    assert.equal(b6.status, 'quitada');
    await conferirLancamentos('pagar', b6.baixaId, '-250.00');
    passo('pagamento de 250,00 acima do limite 200,00: nasce pendente, baixa recusada, aprovado e pago');
  } finally {
    await ok('PUT', '/parametros', campos);
  }

  // 11. Cancelamento com parcela baixada é recusado; sem baixa cancela
  await recusa('POST', `/receber/titulos/${t4.id}/cancelar`, { motivo: 'x' }, 'Estorne as baixas');
  const t7 = await titulo('receber', pb.id, '40.00', [[somarDias(hoje, 15), '40.00']]);
  await ok('POST', `/receber/titulos/${t7.id}/cancelar`, { motivo: 'teste' });
  assert.equal((await linha('SELECT status FROM fin_receber_titulos WHERE id = ?', [t7.id])).status, 'cancelado');
  passo('cancelar título com baixa: recusado; sem baixa: cancelado');

  // 12. Anexos: lista do título e endereço fora da pasta do título recusado (o envio ao Blob é pelo navegador)
  assert.deepEqual(await ok('GET', `/receber/titulos/${t1.id}/anexos`), []);
  await recusa('POST', `/receber/titulos/${t1.id}/anexos`, { url: `https://x.public.blob.vercel-storage.com/financ/${empresa}/receber/${t4.id}/a.pdf`, nome: 'a.pdf' }, 'Endereço do anexo inválido');
  await recusa('GET', `/receber/titulos/999999999/anexos`, undefined, 'Título não encontrado');
  passo('anexos: lista vazia, endereço de outro título e título inexistente recusados');

  // ================================================================== fase 2
  const saldoDe = async (contaId: number, data = hoje) => (await ok('GET', `/contas-financeiras?data=${data}`)).find((c: any) => c.id === contaId).saldo as string;
  const mais = (a: string, b: string) => new Decimal(a).plus(b).toFixed(2);
  const pr = (await ok('GET', '/parametros')).parametros;

  // 13. Lançamento direto (tarifa) e estorno
  const s0 = await saldoDe(caixa.id);
  await recusa('POST', '/movimentos', { conta_financeira_id: caixa.id, data: somarDias(hoje, 1), tipo: 'saida', valor: '12.50', historico: 'x', plano_conta_id: pr.conta_tarifas_bancarias_id, centro_custo_id: pr.centro_custo_tarifas_id }, 'futuro');
  const ld = await ok('POST', '/movimentos', { conta_financeira_id: caixa.id, data: hoje, tipo: 'saida', valor: '12.50', historico: `${marca} tarifa`, plano_conta_id: pr.conta_tarifas_bancarias_id, centro_custo_id: pr.centro_custo_tarifas_id });
  assert.equal(await saldoDe(caixa.id), mais(s0, '-12.50'));
  const lld = await linha('SELECT natureza, sinal, valor, data_caixa, data_competencia FROM fin_lancamentos WHERE movimento_id = ?', [ld.id]);
  assert.deepEqual([lld.natureza, lld.sinal, lld.valor, lld.data_caixa], ['direto', -1, '12.50', hoje]);
  await ok('POST', `/movimentos/${ld.id}/estornar`, { motivo: 'teste' });
  assert.equal(await saldoDe(caixa.id), s0);
  assert.equal(soma(await linhas('SELECT l.sinal, l.valor FROM fin_lancamentos l JOIN fin_movimentos m ON m.id = l.movimento_id WHERE m.id = ? OR m.estorno_de_id = ?', [ld.id, ld.id]), (l) => new Decimal(l.valor).times(l.sinal)), '0.00');
  await recusa('POST', `/movimentos/${ld.id}/estornar`, { motivo: 'de novo' }, 'já estornado');
  await recusa('POST', `/movimentos/${b4.movimentoId}/estornar`, { motivo: 'x' }, 'estorne pela baixa');
  passo('lançamento direto de 12,50 (tarifa): saldo −12,50 e lançamento "direto" −12,50; estorno zera os dois; data futura e movimento de baixa recusados');

  // 14. Transferência caixa → banco, sem DRE; estorno pelas duas pontas
  let banco = (await ok('GET', '/contas-financeiras')).find((c: any) => c.nome === 'Banco teste');
  if (!banco) banco = { id: (await ok('POST', '/contas-financeiras', { tipo: 'banco', nome: 'Banco teste', saldo_inicial: '0', data_saldo_inicial: somarDias(hoje, -60), ativo: 1 })).id };
  const [sc, sb] = [await saldoDe(caixa.id), await saldoDe(banco.id)];
  await recusa('POST', '/transferencias', { conta_origem_id: caixa.id, conta_destino_id: banco.id, data: hoje, valor: mais(sc, '1000000.00') }, 'insuficiente');
  const tr = await ok('POST', '/transferencias', { conta_origem_id: caixa.id, conta_destino_id: banco.id, data: hoje, valor: '100.00' });
  const mt = await linhas('SELECT id, tipo, conta_financeira_id FROM fin_movimentos WHERE transferencia_id = ? ORDER BY id', [tr.id]);
  assert.deepEqual(mt.map((m) => [m.tipo, m.conta_financeira_id]), [['saida', caixa.id], ['entrada', banco.id]]);
  assert.equal(Number((await linha('SELECT COUNT(*) n FROM fin_lancamentos WHERE movimento_id IN (?)', [mt.map((m) => m.id)])).n), 0);
  assert.deepEqual([await saldoDe(caixa.id), await saldoDe(banco.id)], [mais(sc, '-100.00'), mais(sb, '100.00')]);
  await ok('POST', `/movimentos/${mt[1].id}/estornar`, { motivo: 'teste' });
  assert.deepEqual([await saldoDe(caixa.id), await saldoDe(banco.id)], [sc, sb]);
  passo('transferência 100,00 caixa → banco: saída + entrada ligadas, sem lançamento de DRE; estorno por uma ponta desfaz as duas; caixa não fica negativo');

  // 15. Caixa: abertura, suprimento, recebimento, sangria, fechamento com quebra de 1,00
  for (const x of (await ok('GET', `/caixa/sessoes?conta=${caixa.id}`)).filter((x: any) => x.status === 'aberto')) {
    await ok('POST', `/caixa/sessoes/${x.id}/fechar`, { contagem: [{ forma: 'Dinheiro', valor: x.saldo_atual }] });
  }
  const sx = await ok('POST', '/caixa/sessoes', { conta_financeira_id: caixa.id, valor_abertura: await saldoDe(caixa.id) });
  await recusa('POST', '/caixa/sessoes', { conta_financeira_id: caixa.id, valor_abertura: '0' }, 'já está aberto');
  await recusa('POST', '/caixa/sessoes', { conta_financeira_id: banco.id, valor_abertura: '0' }, 'não é uma conta do tipo caixa');
  await ok('POST', `/caixa/sessoes/${sx.id}/suprimento`, { conta_id: banco.id, valor: '50.00' });
  const t8 = await titulo('receber', pb.id, '35.00', [[somarDias(hoje, 3), '35.00']]);
  const b8 = await ok('POST', `/receber/parcelas/${(await parcelas('receber', t8.id))[0].id}/baixas`, { data_pagamento: hoje, conta_financeira_id: caixa.id, valor_pago: '35.00' });
  assert.equal(Number((await linha('SELECT caixa_sessao_id FROM fin_movimentos WHERE id = ?', [b8.movimentoId])).caixa_sessao_id), sx.id);
  await ok('POST', `/caixa/sessoes/${sx.id}/sangria`, { conta_id: banco.id, valor: '20.00' });
  const esperado = await saldoDe(caixa.id);
  const fx = await ok('POST', `/caixa/sessoes/${sx.id}/fechar`, { contagem: [{ forma: 'Dinheiro', valor: mais(esperado, '-1.00') }] });
  assert.deepEqual([fx.esperado, fx.contado, fx.diferenca], [esperado, mais(esperado, '-1.00'), '-1.00']);
  const qb = await linha("SELECT m.tipo, m.valor, m.origem, l.natureza, l.plano_conta_id, m.historico FROM fin_movimentos m JOIN fin_lancamentos l ON l.movimento_id = m.id WHERE m.caixa_sessao_id = ? AND l.natureza = 'quebra_caixa'", [sx.id]);
  assert.deepEqual([qb.tipo, qb.valor, qb.origem, Number(qb.plano_conta_id)], ['saida', '1.00', 'caixa', Number(pr.conta_quebra_caixa_id)]);
  assert.ok(String(qb.historico).includes('operador'));
  assert.equal(await saldoDe(caixa.id), fx.contado);
  const nSessao = Number((await linha('SELECT COUNT(*) n FROM fin_movimentos WHERE caixa_sessao_id = ?', [sx.id])).n);
  assert.equal(nSessao, 4); // suprimento, recebimento, sangria, quebra
  await recusa('POST', `/caixa/sessoes/${sx.id}/sangria`, { conta_id: banco.id, valor: '1.00' }, 'já fechada');
  passo(`caixa #${sx.id}: suprimento 50,00, recebimento 35,00, sangria 20,00 ligados à sessão; contado 1,00 a menos vira quebra (saída 1,00 em Quebra de caixa, com o operador); saldo = contado`);

  // 16. Fluxo de caixa: saldo inicial, previsto e projetado
  const fq = `/fluxo-caixa?de=${hoje}&ate=${somarDias(hoje, 60)}&visao=mensal`;
  const f0 = await ok('GET', fq);
  const ativas = (await ok('GET', `/contas-financeiras?data=${somarDias(hoje, -1)}`)).filter((c: any) => Number(c.ativo));
  assert.equal(f0.saldo_inicial, soma(ativas, (c) => c.saldo));
  const fim = (f: any) => f.periodos[f.periodos.length - 1].saldo;
  const tot = (f: any, k: string) => soma(f.periodos, (p) => p[k]);
  const liquidoF = (f: any) => soma(f.periodos, (p) => new Decimal(p.liquido));
  assert.equal(fim(f0), mais(f0.saldo_inicial, liquidoF(f0)));
  await titulo('pagar', pa.id, '77.77', [[somarDias(hoje, 20), '77.77']]);
  await titulo('receber', pa.id, '55.55', [[somarDias(hoje, 25), '55.55']], { provisorio: true });
  const f1 = await ok('GET', fq);
  assert.equal(new Decimal(tot(f1, 'previsto_saidas')).minus(tot(f0, 'previsto_saidas')).toFixed(2), '77.77');
  assert.equal(new Decimal(tot(f1, 'projetado_entradas')).minus(tot(f0, 'projetado_entradas')).toFixed(2), '55.55');
  assert.equal(new Decimal(fim(f1)).minus(fim(f0)).toFixed(2), '-22.22');
  const fg = await ok('GET', `${fq}&agrupar=plano`);
  assert.ok(fg.grupos.length > 0);
  passo(`fluxo: saldo inicial ${f0.saldo_inicial} = soma das contas; a pagar 77,77 entra no previsto, provisório 55,55 no projetado; saldo final −22,22`);

  // 17. DRE (caixa e competência) bate com os lançamentos; relatórios respondem
  for (const regime of ['caixa', 'competencia']) {
    const d = await ok('GET', `/relatorios/dre?regime=${regime}&de=${hoje}&ate=${hoje}`);
    const banco2 = await linha(`SELECT COALESCE(SUM(sinal * valor), 0) AS t FROM fin_lancamentos WHERE empresa_id = ? AND data_${regime} = ?`, [empresa, hoje]);
    assert.equal(d.total, new Decimal(banco2.t).toFixed(2), `DRE ${regime}`);
  }
  const rb = await ok('GET', `/relatorios/baixas?lado=receber&de=${hoje}&ate=${hoje}`);
  const rbBanco = await linha('SELECT COALESCE(SUM(IF(estorno_de_id IS NULL, 1, -1) * valor_pago), 0) t FROM fin_receber_baixas WHERE empresa_id = ? AND data_pagamento = ?', [empresa, hoje]);
  assert.equal(soma(rb.linhas, (l) => l.valor_pago), new Decimal(rbBanco.t).toFixed(2));
  const ag = await ok('GET', '/relatorios/aging?lado=receber');
  const agBanco = await linha("SELECT COALESCE(SUM(p.saldo), 0) t FROM fin_receber_parcelas p JOIN fin_receber_titulos t ON t.id = p.titulo_id WHERE p.empresa_id = ? AND p.status IN ('aberta','parcial') AND t.provisorio = 0", [empresa]);
  assert.equal(soma(ag.linhas, (l) => l.total), new Decimal(agBanco.t).toFixed(2));
  const ep = await ok('GET', `/relatorios/extrato-pessoa?lado=receber&pessoa=${pb.id}&de=${somarDias(hoje, -60)}&ate=${hoje}`);
  assert.ok(ep.linhas.some((l: any) => l.tipo === 'baixa'));
  await ok('GET', `/relatorios/previsto-realizado?lado=pagar&de=${somarDias(hoje, -60)}&ate=${somarDias(hoje, 60)}`);
  await ok('GET', `/relatorios/baixas?lado=receber&de=${hoje}&ate=${hoje}&encargos=1`);
  passo('DRE caixa e competência = Σ lançamentos do dia; baixas e aging batem com o banco; extrato por pessoa e previsto × realizado respondem');

  // 18. Conciliação: regras e leitura do extrato do BMBancos
  const rg = await ok('POST', '/regras-conciliacao', { nome: `${marca} tarifa`, campo: 'historico', operador: 'contem', texto: 'TARIFA', sentido: 'saida', plano_conta_id: pr.conta_tarifas_bancarias_id, centro_custo_id: pr.centro_custo_tarifas_id, prioridade: 10, ativo: 1 });
  await recusa('POST', '/regras-conciliacao', { nome: 'x', campo: 'historico', operador: 'regex', texto: '([', sentido: 'ambos', plano_conta_id: pr.conta_tarifas_bancarias_id, centro_custo_id: pr.centro_custo_tarifas_id, prioridade: 1, ativo: 1 }, 'Expressão regular');
  await recusa('POST', '/regras-conciliacao', { nome: 'x', campo: 'historico', operador: 'contem', texto: 'x', sentido: 'ambos', prioridade: 1, ativo: 1 }, 'precisa de conta do plano');
  await ok('PATCH', `/regras-conciliacao/${rg.id}`, { nome: `${marca} tarifa`, campo: 'historico', operador: 'comeca_com', texto: 'TAR', sentido: 'saida', plano_conta_id: pr.conta_tarifas_bancarias_id, centro_custo_id: pr.centro_custo_tarifas_id, prioridade: 10, ativo: 0 });
  await ok('DELETE', `/regras-conciliacao/${rg.id}`);
  await recusa('GET', `/conciliacao/pendentes?conta=${caixa.id}`, undefined, 'não está ligada');
  const ligada = (await ok('GET', '/contas-financeiras')).find((c: any) => c.ban_conta_id && Number(c.ativo));
  if (ligada) {
    const pend = await ok('GET', `/conciliacao/pendentes?conta=${ligada.id}`);
    assert.ok(Array.isArray(pend.extrato) && Array.isArray(pend.movimentos) && Array.isArray(pend.sugestoes));
    passo(`conciliação: regras criar/editar/excluir; "${ligada.nome}" com ${pend.extrato.length} linha(s) pendente(s) e ${pend.sugestoes.length} sugestão(ões)`);
  } else passo('conciliação: regras criar/editar/excluir; nenhuma conta ligada ao BMBancos nesta empresa (leitura do extrato não testada)');

  // 19. Webhook: Pix pago avisado duas vezes baixa uma vez só; assinatura conferida; boleto alheio ignorado
  if ((process.env.FINANC_WEBHOOK_SECRET || '').length >= 32) {
    const tp = await titulo('receber', pa.id, '150.00', [], { parcelas: [{ vencimento: hoje, valor: '150.00', conta_financeira_id: banco.id }] });
    const [pp] = await parcelas('receber', tp.id);
    const txid = `${marca}pix${'0'.repeat(30)}`.slice(0, 30);
    // Cobrança como o gerarPix grava depois da resposta do BMBancos (o PSP não é chamado no teste)
    await db.query("INSERT INTO fin_pix_cobrancas (empresa_id, parcela_id, conta_financeira_id, txid, tipo, valor, status, expira_em) VALUES (?, ?, ?, ?, 'cob', '150.00', 'ativa', NOW() + INTERVAL 1 DAY)", [empresa, pp.id, banco.id, txid]);
    const aviso = { empresa_id: empresa, evento: 'pix', dados: { txid, endToEndId: `E${txid}`, valor: '150.00', pagoEm: `${hoje}T15:00:00Z` } };
    assert.equal((await webhook(aviso, 'sha256=errada')).status, 401);
    const w1 = await webhook(aviso);
    assert.equal(w1.status, 200, JSON.stringify(w1.json));
    assert.equal(w1.json.status, 'processado', w1.json.erro);
    const w2 = await webhook(aviso);
    assert.equal(w2.status, 200);
    assert.ok(w2.json.repetido, 'segundo aviso deveria ser repetido');
    const bp = await linhas('SELECT id, origem, valor_pago, data_pagamento FROM fin_receber_baixas WHERE parcela_id = ?', [pp.id]);
    assert.equal(bp.length, 1, 'Pix repetido baixou duas vezes');
    assert.deepEqual([bp[0].origem, bp[0].valor_pago, String(bp[0].data_pagamento).slice(0, 10)], ['pix', '150.00', hoje]);
    await conferirLancamentos('receber', bp[0].id, '150.00');
    const cobp = await linha('SELECT status, e2e_id, DATE_FORMAT(pago_em, "%H:%i") AS hora FROM fin_pix_cobrancas WHERE txid = ?', [txid]);
    assert.deepEqual([cobp.status, cobp.e2e_id, cobp.hora], ['concluida', `E${txid}`, '12:00']);
    const ev = await linha("SELECT COUNT(*) n FROM fin_eventos WHERE empresa_id = ? AND tipo = 'pix.recebido' AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.txid')) = ?", [empresa, txid]);
    assert.equal(Number(ev.n), 1);
    assert.ok((await webhook({ empresa_id: empresa, evento: 'ocorrencia', dados: { id: 1, tipo: 'liquidacao', referencia: 'VENDA-123' } })).json.ignorado);
    // Boleto FIN-P… com ocorrência que não existe no BMBancos (FK): erro gravado; reenviar não cria outro evento nem baixa
    const refB = `FIN-P${p1.id}-${900000 + Math.floor(Math.random() * 99999)}`;
    await db.query('INSERT INTO fin_receber_parcela_boletos (empresa_id, parcela_id, referencia, ativo) VALUES (?, ?, ?, 0)', [empresa, p1.id, refB]);
    const oc = { empresa_id: empresa, evento: 'ocorrencia', dados: { id: 2_000_000_000 + Math.floor(Math.random() * 1e8), tipo: 'liquidacao', referencia: refB, contaId: 0, dataOcorrencia: hoje, valorPago: '10.00' } };
    const baixasAntes = Number((await linha('SELECT COUNT(*) n FROM fin_receber_baixas WHERE parcela_id = ?', [p1.id])).n);
    const o1 = await webhook(oc);
    const o2 = await webhook(oc);
    assert.equal(o1.status, 200);
    assert.equal(o1.json.id, o2.json.id, 'reenvio criou outro evento');
    assert.equal(o2.json.status, 'erro');
    assert.equal(Number((await linha('SELECT COUNT(*) n FROM fin_receber_baixas WHERE parcela_id = ?', [p1.id])).n), baixasAntes);
    await db.query("UPDATE fin_eventos SET status = 'descartado', proxima_tentativa = NULL WHERE id = ?", [o1.json.id]);
    passo('webhook: Pix 150,00 baixado uma vez (origem pix, pago 12:00 de Brasília) mesmo avisado duas vezes; assinatura errada 401; boleto de outro módulo ignorado; ocorrência repetida = mesmo evento, sem baixa');
  } else passo('webhook NÃO testado: rode servidor e teste com FINANC_WEBHOOK_SECRET (32+ caracteres) no ambiente');

  // 20. Cartão: cliente quitado, recebível líquido em 3x, taxa como despesa no crédito, antecipação e estorno
  let adq = (await ok('GET', '/contas-financeiras')).find((c: any) => c.nome === 'Adquirente teste');
  if (!adq) adq = { id: (await ok('POST', '/contas-financeiras', { tipo: 'adquirente', nome: 'Adquirente teste', saldo_inicial: '0', data_saldo_inicial: somarDias(hoje, -60), ativo: 1 })).id };
  const tx1 = await ok('POST', '/taxas-cartao', { adquirente_id: adq.id, bandeira: marca, modalidade: 'credito', parcelas_de: 1, parcelas_ate: 12, taxa_pct: '3.99', taxa_fixa: '0', dias_repasse: 30 });
  const tx2 = await ok('POST', '/taxas-cartao', { adquirente_id: adq.id, bandeira: marca, modalidade: 'debito', parcelas_de: 1, parcelas_ate: 1, taxa_pct: '1.99', taxa_fixa: '0', dias_repasse: 1 });
  const tc = await titulo('receber', pa.id, '1000.00', [[somarDias(hoje, 10), '1000.00']]);
  const [pc] = await parcelas('receber', tc.id);
  await recusa('POST', '/cartao/transacoes', { parcela_id: pc.id, adquirente_id: adq.id, adquirente_pessoa_id: pb.id, bandeira: `${marca}x`, modalidade: 'credito', parcelas: 3 }, 'Sem taxa');
  const ct = await ok('POST', '/cartao/transacoes', { parcela_id: pc.id, adquirente_id: adq.id, adquirente_pessoa_id: pb.id, bandeira: marca, modalidade: 'credito', parcelas: 3, nsu: marca, data_venda: hoje });
  assert.deepEqual([ct.bruto, ct.taxa, ct.liquido], ['1000.00', '39.90', '960.10']);
  const pcDepois = await linha('SELECT status, saldo FROM fin_receber_parcelas WHERE id = ?', [pc.id]);
  assert.deepEqual([pcDepois.status, pcDepois.saldo], ['quitada', '0.00']);
  const bcli = await linha('SELECT origem, conta_financeira_id FROM fin_receber_baixas WHERE id = ?', [ct.baixa_id]);
  assert.deepEqual([bcli.origem, bcli.conta_financeira_id], ['cartao', null]);
  assert.equal(Number((await linha('SELECT COUNT(*) n FROM fin_lancamentos WHERE receber_baixa_id = ?', [ct.baixa_id])).n), 0, 'baixa do cliente no cartão não lança receita');
  const rec = await parcelas('receber', ct.titulo_recebivel_id);
  assert.deepEqual(rec.map((x: any) => x.valor_original), ['320.04', '320.03', '320.03']);
  assert.equal(String(rec[0].vencimento).slice(0, 10), somarDias(hoje, 30));
  assert.equal(Number(rec[0].juros_mes_pct), 0);
  const trec = await linha('SELECT origem, pessoa_id, valor_total FROM fin_receber_titulos WHERE id = ?', [ct.titulo_recebivel_id]);
  assert.deepEqual([trec.origem, trec.pessoa_id, trec.valor_total], ['cartao_adquirente', pb.id, '960.10']);
  // Adquirente paga a 1ª: receita bruta 333,34, taxa 13,30 como despesa, entram 320,04
  const br1 = await ok('POST', `/receber/parcelas/${rec[0].id}/baixas`, { data_pagamento: hoje, conta_financeira_id: banco.id });
  await conferirLancamentos('receber', br1.baixaId, '320.04');
  const ln1 = await linhas('SELECT natureza, sinal, valor, plano_conta_id FROM fin_lancamentos WHERE receber_baixa_id = ?', [br1.baixaId]);
  assert.equal(soma(ln1.filter((l) => l.natureza === 'principal'), (l) => l.valor), '333.34');
  const taxaL = ln1.find((l) => l.natureza === 'taxa_cartao');
  assert.deepEqual([taxaL?.valor, taxaL?.sinal, taxaL?.plano_conta_id], ['13.30', -1, pr.conta_taxas_cartao_id]);
  // Antecipa as outras duas: saldo 640,06, caem 630,00, custo 10,06 (5,03 cada)
  const an = await ok('POST', '/cartao/antecipar', { parcelas: [rec[1].id, rec[2].id], data: hoje, conta_financeira_id: banco.id, valor_liquido: '630.00' });
  assert.deepEqual([an.total, an.custo, an.baixas.map((b: any) => b.custo)], ['640.06', '10.06', ['5.03', '5.03']]);
  for (const b of an.baixas) {
    await conferirLancamentos('receber', b.baixa_id, '315.00');
    const ant = await linha("SELECT valor, plano_conta_id FROM fin_lancamentos WHERE receber_baixa_id = ? AND natureza = 'antecipacao'", [b.baixa_id]);
    assert.deepEqual([ant.valor, ant.plano_conta_id], ['5.03', pr.conta_antecipacao_id]);
  }
  assert.equal((await linha('SELECT status FROM fin_receber_titulos WHERE id = ?', [ct.titulo_recebivel_id])).status, 'quitado');
  await recusa('POST', `/receber/baixas/${ct.baixa_id}/estornar`, { motivo: 'teste' }, 'parcelas baixadas');
  // Débito desfeito antes do repasse: estornar a baixa do cliente cancela o recebível
  const td = await titulo('receber', pa.id, '100.00', [[somarDias(hoje, 5), '100.00']]);
  const [pd] = await parcelas('receber', td.id);
  const cd = await ok('POST', '/cartao/transacoes', { parcela_id: pd.id, adquirente_id: adq.id, bandeira: marca, modalidade: 'debito', parcelas: 1, data_venda: hoje });
  assert.deepEqual([cd.taxa, cd.liquido, cd.plano[0].vencimento], ['1.99', '98.01', somarDias(hoje, 1)]);
  await ok('POST', `/receber/baixas/${cd.baixa_id}/estornar`, { motivo: 'venda desfeita' });
  assert.equal((await linha('SELECT status FROM fin_receber_titulos WHERE id = ?', [cd.titulo_recebivel_id])).status, 'cancelado');
  assert.equal((await linha('SELECT status FROM fin_receber_parcelas WHERE id = ?', [pd.id])).status, 'aberta');
  await ok('DELETE', `/taxas-cartao/${tx1.id}`);
  await ok('DELETE', `/taxas-cartao/${tx2.id}`);
  passo('cartão 1.000,00 em 3x a 3,99%: cliente quitado sem receita, recebível 960,10 (320,04 + 2× 320,03) contra o adquirente; repasse lança 333,34 de receita e 13,30 de taxa; antecipação de 640,06 por 630,00 → custo 5,03 + 5,03; estorno recusado com repasse, aceito sem (recebível cancelado)');

  // 22. Régua de cobrança (só com COBRANCA_SIMULAR=1 aqui e no servidor: nada sai de verdade)
  if (process.env.COBRANCA_SIMULAR === '1') {
    const wa = (await linha("SELECT id FROM cad_pessoas WHERE id IN (?, ?) AND whatsapp IS NOT NULL AND whatsapp <> '' LIMIT 1", [pa.id, pb.id]))?.id;
    assert.ok(wa, 'precisa de uma das 2 pessoas com WhatsApp no cadastro');
    const cli0 = await ok('GET', `/pessoas/${wa}/cobranca`);
    await recusa('POST', '/cobranca/modelos', { canal: 'whatsapp', nome: `${marca} x`, corpo: 'Oi {{valor}}' }, 'Variável desconhecida');
    const mod = await ok('POST', '/cobranca/modelos', { canal: 'whatsapp', nome: marca, corpo: 'Olá, {{nome}}! Parcela {{parcela}} de {{documento}}: R$ {{valor_atualizado}}.\nPix: {{pix_copia_cola}}' });
    const modEmail = await ok('POST', '/cobranca/modelos', { canal: 'email', nome: marca, assunto: 'Cobrança {{documento}}', corpo: 'Olá, {{nome}}. R$ {{valor_atualizado}}' });
    const e1 = await ok('POST', '/cobranca/etapas', { perfil: marca, evento: 'vencimento', dias_relativos: 3, template_id: mod.id });
    const e2 = await ok('POST', '/cobranca/etapas', { perfil: marca, evento: 'vencimento', dias_relativos: 3, template_id: modEmail.id });
    await ok('PUT', `/pessoas/${wa}/cobranca`, { perfil_cobranca: marca, optout_whatsapp: false, optout_email: false });
    // Duas parcelas vencidas há 4 dias (janela 3..6), uma já quitada e uma fora da janela
    const venc = somarDias(hoje, -4);
    const novos = [];
    for (const [v, d] of [['100.00', venc], ['200.00', venc], ['50.00', venc], ['70.00', somarDias(hoje, -10)]]) {
      novos.push(await ok('POST', '/receber/titulos', { pessoa_id: wa, numero_documento: `${marca}-regua-${v}`, data_emissao: somarDias(hoje, -40), valor_total: v, parcelas: [{ vencimento: d, valor: v }] }));
    }
    const [ra, rb, rq, rf] = await Promise.all(novos.map(async (t: any) => (await parcelas('receber', t.id))[0]));
    const quitar = async (id: number) => ok('POST', `/receber/parcelas/${id}/baixas`, { data_pagamento: hoje, conta_financeira_id: caixa.id, valor_pago: (await ok('POST', `/receber/parcelas/${id}/simular-baixa`, { data_pagamento: hoje })).total_dia });
    await quitar(rq.id);
    const pv = await ok('POST', '/cobranca/previa', { template_id: mod.id, parcela_id: ra.id });
    const totalA = (await ok('POST', `/receber/parcelas/${ra.id}/simular-baixa`, { data_pagamento: hoje })).total_dia;
    assert.ok(pv.texto.includes(`R$ ${totalA.replace('.', ',')}.`) && !pv.texto.includes('Pix:'), `prévia: ${pv.texto}`);
    await ok('POST', '/cobranca/rodar');
    const env = async (ids: number[]) => linhas('SELECT * FROM fin_cobranca_envios WHERE parcela_id IN (?) ORDER BY parcela_id, canal', [ids]);
    const v1 = await env([ra.id, rb.id, rq.id, rf.id]);
    const waEnv = v1.filter((x) => x.canal === 'whatsapp');
    assert.deepEqual(waEnv.map((x) => [x.parcela_id, x.status]), [[ra.id, 'enviado'], [rb.id, 'enviado']], 'quitada e fora da janela não recebem');
    assert.ok(waEnv[0].agrupamento && waEnv[0].agrupamento === waEnv[1].agrupamento && waEnv[0].mensagem_externa_id === waEnv[1].mensagem_externa_id, 'mesmo cliente e vencimento = uma mensagem');
    const emEnv = v1.filter((x) => x.canal === 'email');
    assert.equal(emEnv.length, 2);
    const temEmail = !!(await linha("SELECT COALESCE(NULLIF(email_cobranca, ''), email_principal) e FROM cad_pessoas WHERE id = ?", [wa])).e;
    if (!temEmail) assert.ok(emEnv.every((x) => x.status === 'falhou' && /sem email/.test(x.erro)));
    await ok('POST', '/cobranca/rodar');
    assert.equal((await env([ra.id, rb.id, rq.id, rf.id])).length, v1.length, 'rodar de novo não repete a etapa');
    // Opt-out de WhatsApp: parcela nova na janela não recebe por WhatsApp
    await ok('PUT', `/pessoas/${wa}/cobranca`, { perfil_cobranca: marca, optout_whatsapp: true, optout_email: false });
    const tO = await ok('POST', '/receber/titulos', { pessoa_id: wa, numero_documento: `${marca}-regua-optout`, data_emissao: somarDias(hoje, -40), valor_total: '30.00', parcelas: [{ vencimento: venc, valor: '30.00' }] });
    const [ro] = await parcelas('receber', tO.id);
    await ok('POST', '/cobranca/rodar');
    assert.deepEqual((await env([ro.id])).map((x) => x.canal), ['email']);
    // Pendente de parcela que foi quitada antes de sair: cancelado
    await db.query("UPDATE fin_cobranca_envios SET status = 'pendente', agendado_para = NOW() + INTERVAL 1 HOUR WHERE parcela_id = ? AND canal = 'email'", [ro.id]);
    await quitar(ro.id);
    await ok('POST', '/cobranca/rodar');
    assert.equal((await env([ro.id]))[0].status, 'cancelado');
    // Envio avulso: destino digitado vira só dígitos com 55
    const av = await ok('POST', `/receber/parcelas/${ra.id}/mensagem`, { template_id: mod.id, destino: '(11) 98765-4321' });
    const avl = await linha('SELECT * FROM fin_cobranca_envios WHERE id = ?', [av.id]);
    assert.deepEqual([avl.status, avl.destino, avl.etapa_id], ['enviado', '5511987654321', null]);
    // Situação para o erp-vendas: vencida há 4 dias bloqueia a venda a prazo
    const sit = await ok('GET', `/pessoas/${wa}/situacao?valor=10.00`);
    assert.ok(!sit.pode_vender_a_prazo && sit.motivos.some((m: string) => m.includes('vencida')), JSON.stringify(sit.motivos));
    assert.equal((await fetch(`http://localhost:${porta}/api/financ/cron/cobranca`)).status, 401);
    // Webhook da Meta: entregue, lido, "sent" atrasado não volta, resposta "Sair" = respondido + opt-out
    const segredo = process.env.WHATSAPP_CLOUD_APP_SECRET;
    if (segredo) {
      const meta = async (value: unknown, ass?: string) => {
        const bruto = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value }] }] });
        return fetch(`http://localhost:${porta}/api/financ/webhooks/mensagens`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': ass ?? `sha256=${crypto.createHmac('sha256', segredo).update(bruto).digest('hex')}` }, body: bruto });
      };
      const ext = waEnv[0].mensagem_externa_id;
      assert.equal((await meta({ statuses: [{ id: ext, status: 'read' }] }, 'sha256=errada')).status, 401);
      await meta({ statuses: [{ id: ext, status: 'delivered' }] });
      await meta({ statuses: [{ id: ext, status: 'read' }] });
      await meta({ statuses: [{ id: ext, status: 'sent' }] });
      assert.deepEqual((await env([ra.id, rb.id])).filter((x) => x.canal === 'whatsapp' && x.etapa_id).map((x) => x.status), ['lido', 'lido']);
      await ok('PUT', `/pessoas/${wa}/cobranca`, { perfil_cobranca: marca, optout_whatsapp: false, optout_email: false });
      await meta({ messages: [{ from: waEnv[0].destino, type: 'text', text: { body: 'Sair' }, context: { id: ext } }] });
      assert.equal((await env([ra.id])).find((x) => x.etapa_id && x.canal === 'whatsapp').status, 'respondido');
      assert.equal((await ok('GET', `/pessoas/${wa}/cobranca`)).optout_whatsapp, true);
    }
    // Arruma: perfil e opt-out como estavam, etapas e modelos de teste desligados
    await ok('PUT', `/pessoas/${wa}/cobranca`, { perfil_cobranca: cli0.perfil_cobranca, optout_whatsapp: cli0.optout_whatsapp, optout_email: cli0.optout_email });
    for (const e of [e1, e2]) await ok('DELETE', `/cobranca/etapas/${e.id}`);
    for (const m of [mod, modEmail]) {
      const x = (await ok('GET', '/cobranca/modelos')).find((y: any) => y.id === m.id);
      await ok('PUT', `/cobranca/modelos/${m.id}`, { canal: x.canal, nome: x.nome, assunto: x.assunto, corpo: x.corpo, ativo: false });
    }
    passo(`régua: 2 parcelas do mesmo cliente vencidas há 4 dias = 1 WhatsApp (agrupamento) com valor atualizado ${totalA.replace('.', ',')}; quitada e fora da janela ficam de fora; rodar de novo não repete; opt-out respeitado; pendente de parcela quitada cancelado; avulso para 5511987654321; venda a prazo bloqueada por atraso${segredo ? '; webhook da Meta: lido não volta para enviado, "Sair" = respondido + opt-out' : ' (webhook da Meta NÃO testado: falta WHATSAPP_CLOUD_APP_SECRET)'}`);
  } else passo('régua NÃO testada: rode servidor e teste com COBRANCA_SIMULAR=1');

  // 23. Venda (o erp-vendas manda só o id): idempotente, cancelamento simulado não muda nada e recusa com parcela baixada
  const venda = await linha(
    `SELECT v.id, v.numero FROM ven_vendas v WHERE v.empresa_id = ? AND v.status = 'faturada' AND v.pessoa_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM ven_venda_parcelas x WHERE x.venda_id = v.id AND x.forma_pagamento <> 'Sem pagamento') ORDER BY v.id LIMIT 1`,
    [empresa],
  );
  if (venda) {
    const tv = await ok('POST', '/receber/titulos', { venda_id: venda.id });
    assert.equal((await ok('POST', '/receber/titulos', { venda_id: venda.id })).id, tv.id, 'mesma venda = mesmo título');
    const [pv] = await parcelas('receber', tv.id);
    const simular = () => chamar('POST', `/receber/titulos/venda/${venda.id}/cancelar`, { simular: true });
    assert.deepEqual((await simular()).json, { pode_cancelar: true });
    assert.equal((await linha('SELECT status FROM fin_receber_titulos WHERE id = ?', [tv.id])).status, 'aberto', 'simular não cancela');
    const bv = await ok('POST', `/receber/parcelas/${pv.id}/baixas`, { data_pagamento: hoje, conta_financeira_id: caixa.id, valor_pago: '1.00' });
    const r409 = await simular();
    assert.ok(r409.status === 409 && /parcelas baixadas/.test(r409.json?.error), JSON.stringify(r409));
    await ok('POST', `/receber/baixas/${bv.baixaId}/estornar`, { motivo: 'teste da venda' });
    assert.equal((await simular()).status, 200);
    assert.equal((await chamar('POST', '/pagar/titulos/compra/999999999/cancelar', { simular: true })).status, 404, 'nota sem título = 404');
    // Rodada: cria o que faltou desde a primeira venda que virou título (as faturadas com cliente e parcela a receber)
    const so = await ok('POST', '/origens/sincronizar');
    assert.deepEqual(so.erros, [], 'erros na sincronização das origens');
    const falta = await linha(
      `SELECT COUNT(*) n FROM ven_vendas v WHERE v.empresa_id = ? AND v.status = 'faturada' AND v.pessoa_id IS NOT NULL AND v.id >= ?
          AND EXISTS (SELECT 1 FROM ven_venda_parcelas x WHERE x.venda_id = v.id AND x.forma_pagamento <> 'Sem pagamento')
          AND NOT EXISTS (SELECT 1 FROM fin_receber_titulos t WHERE t.empresa_id = v.empresa_id AND t.origem = 'venda' AND t.origem_id = v.id)`,
      [empresa, venda.id],
    );
    assert.equal(Number(falta.n), 0, 'venda faturada sem título depois da rodada');
    passo(`venda ${venda.numero}: título #${tv.id} (o mesmo na 2ª chamada); simular cancelamento não muda nada; com baixa recusa (409), depois do estorno deixa; rodada criou ${so.criados} título(s) que faltavam`);
  } else passo('venda NÃO testada: nenhuma venda faturada com cliente e parcela a receber na empresa');

  // 21. Auditoria
  const aud = await linhas("SELECT DISTINCT acao FROM fin_auditoria WHERE empresa_id = ? AND criado_em >= NOW() - INTERVAL 1 HOUR", [empresa]);
  for (const a of ['criar', 'baixar', 'estornar', 'dispensar', 'renegociar', 'desfazer', 'aprovar', 'cancelar', 'lancar', 'transferir', 'abrir', 'fechar', 'quebra_caixa', 'excluir', 'antecipar']) assert.ok(aud.some((x) => x.acao === a), `auditoria sem ${a}`);
  passo('auditoria gravou também lançamento, transferência, abertura/fechamento de caixa, quebra e regras');

  console.log(`\nteste-banco: ok (empresa ${empresa}, documentos ${marca}-*)`);
}

main()
  .catch((e) => {
    console.error('\n✗', e.message);
    process.exitCode = 1;
  })
  .finally(() => db.end());
