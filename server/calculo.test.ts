// Casos obrigatórios da baixa parcial (têm que bater no centavo): npx tsx server/calculo.test.ts
import assert from 'node:assert/strict';
import { calcularBaixa, valorParaPrincipal, totalDoDia, diasAtraso } from './calculo.js';

const base = { vencimento: '2026-03-10', multaPct: 2, jurosMesPct: 1 };

// 1a: R$ 1.000,00 vencida em 10/03, paga R$ 500,00 em 09/04 (30 dias)
const r1a = calcularBaixa({ ...base, saldo: 1000, dataPagamento: '2026-04-09', valorPago: 500 });
assert.equal(r1a.diasAtraso, 30);
assert.equal(r1a.multaDevida, '20.00');
assert.equal(r1a.jurosDevidos, '10.00');
assert.equal(r1a.totalDevido, '1030.00');
assert.equal(r1a.fator.slice(0, 8), '0.485436'); // 0,48543689 (o escopo mostra 0,485437 arredondado em 6)
assert.equal(Number(r1a.fator).toFixed(6), '0.485437');
assert.equal(r1a.valorMulta, '9.71');
assert.equal(r1a.valorJuros, '4.85');
assert.equal(r1a.valorPrincipal, '485.44');
assert.equal(r1a.saldoDepois, '514.56');

// 1b: saldo 514,56, paga tudo em 24/04 (45 dias do vencimento)
const t1b = totalDoDia({ ...base, saldo: '514.56', dataPagamento: '2026-04-24' });
assert.equal(t1b, '532.57');
const r1b = calcularBaixa({ ...base, saldo: '514.56', dataPagamento: '2026-04-24', valorPago: t1b });
assert.equal(r1b.diasAtraso, 45);
assert.equal(r1b.multaDevida, '10.29');
assert.equal(r1b.jurosDevidos, '7.72');
assert.equal(r1b.valorMulta, '10.29');
assert.equal(r1b.valorJuros, '7.72');
assert.equal(r1b.valorPrincipal, '514.56');
assert.equal(r1b.saldoDepois, '0.00');

// 2: duplicata a pagar R$ 2.000,00, 5 dias de atraso, paga R$ 1.200,00
const r2 = calcularBaixa({ ...base, saldo: 2000, dataPagamento: '2026-03-15', valorPago: 1200 });
assert.equal(r2.multaDevida, '40.00');
assert.equal(r2.jurosDevidos, '3.33');
assert.equal(r2.totalDevido, '2043.33');
assert.equal(Number(r2.fator).toFixed(6), '0.587277');
assert.equal(r2.valorMulta, '23.49');
assert.equal(r2.valorJuros, '1.96');
assert.equal(r2.valorPrincipal, '1174.55');
assert.equal(r2.saldoDepois, '825.45');

// 3a: paga R$ 300,00 antes do vencimento: sem encargos
const r3a = calcularBaixa({ ...base, saldo: 1000, dataPagamento: '2026-03-01', valorPago: 300 });
assert.equal(r3a.valorMulta, '0.00');
assert.equal(r3a.valorJuros, '0.00');
assert.equal(r3a.saldoDepois, '700.00');

// 3b: 5% de desconto por pontualidade, paga R$ 380,00 no prazo
const r3b = calcularBaixa({ ...base, saldo: 1000, dataPagamento: '2026-03-05', valorPago: 380, descontoPct: 5, descontoAte: '2026-03-10' });
assert.equal(r3b.valorPrincipal, '400.00');
assert.equal(r3b.valorDesconto, '20.00');
assert.equal(r3b.saldoDepois, '600.00');
// Desconto vencido não vale
assert.equal(calcularBaixa({ ...base, saldo: 1000, dataPagamento: '2026-03-11', valorPago: 380, descontoPct: 5, descontoAte: '2026-03-10' }).valorDesconto, '0.00');

// 4: pago acima do total devido: quita e o excedente vira crédito
const r4 = calcularBaixa({ ...base, saldo: 1000, dataPagamento: '2026-04-09', valorPago: 1100 });
assert.equal(r4.saldoDepois, '0.00');
assert.equal(r4.valorPrincipal, '1000.00');
assert.equal(r4.valorExcedente, '70.00');

// Cálculo inverso: para amortizar 485,44 em 09/04, cobrar 500,00
assert.equal(valorParaPrincipal({ ...base, saldo: 1000, dataPagamento: '2026-04-09' }, '485.44'), '500.00');
assert.equal(valorParaPrincipal({ ...base, saldo: 1000, dataPagamento: '2026-03-05', descontoPct: 5, descontoAte: '2026-03-10' }, 400), '380.00');

// Encargos primeiro (art. 354): 500 pagos quitam 20 + 10 e amortizam 470
const rEp = calcularBaixa({ ...base, saldo: 1000, dataPagamento: '2026-04-09', valorPago: 500, modo: 'encargos_primeiro' });
assert.deepEqual([rEp.valorMulta, rEp.valorJuros, rEp.valorPrincipal], ['20.00', '10.00', '470.00']);

// Encargos informados (boleto do fornecedor): distribuição usa os digitados
const rInf = calcularBaixa({ ...base, saldo: 2000, dataPagamento: '2026-03-15', valorPago: 2050, multaInformada: 40, jurosInformados: 10 });
assert.deepEqual([rInf.valorMulta, rInf.valorJuros, rInf.saldoDepois, rInf.valorExcedente], ['40.00', '10.00', '0.00', '0.00']);

// Dispensa total dos encargos: paga só o principal
const rDisp = calcularBaixa({ ...base, saldo: 1000, dataPagamento: '2026-04-09', valorPago: 1000, dispensa: 30 });
assert.deepEqual([rDisp.valorMulta, rDisp.valorJuros, rDisp.valorDispensado, rDisp.saldoDepois], ['0.00', '0.00', '30.00', '0.00']);

// Carência: dentro dela não há atraso; passou, conta desde o vencimento
assert.equal(diasAtraso('2026-03-10', '2026-03-13', 3), 0);
assert.equal(diasAtraso('2026-03-10', '2026-03-14', 3), 4);

console.log('calculo.test: ok');
