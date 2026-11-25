// Rateio em centavos: npx tsx server/rateio.test.ts
import assert from 'node:assert/strict';
import { distribuir, fecha100, percentuais, planoRecebivel } from './rateio.js';

// 100,00 em três terços: o centavo que sobra vai para a maior linha (a primeira, no empate)
assert.deepEqual(distribuir(100, ['33.3333', '33.3333', '33.3334']), ['33.33', '33.33', '33.34']);
assert.deepEqual(distribuir('485.44', [60, 40]), ['291.26', '194.18']);
assert.deepEqual(distribuir('0.01', [50, 50]), ['0.00', '0.01']); // meio centavo arredonda para cima nas duas; a maior devolve
assert.deepEqual(distribuir(10, [100]), ['10.00']);
assert.ok(fecha100(['33.3333', '33.3333', '33.3334']));
assert.ok(!fecha100([50, '49.9999']));
// Renegociação: rateio do título novo pelos valores (saldo 1.000,00 em 60/40 + juros 30,00)
assert.deepEqual(percentuais([1, 1, 1]), ['33.3334', '33.3333', '33.3333']);
assert.deepEqual(percentuais(['600.00', '400.00', '30.00']), ['58.2524', '38.8350', '2.9126']);
assert.ok(fecha100(percentuais(['600.00', '400.00', '30.00'])));
// Cartão 1.000,00 em 3x a 3,99%: taxa 39,90; 1º repasse em D+30 (31/01 → 02/03), depois mês a mês
assert.deepEqual(planoRecebivel('1000.00', '39.90', 3, '2026-01-31', 30), [
  { vencimento: '2026-03-02', bruto: '333.34', taxa: '13.30', valor: '320.04' },
  { vencimento: '2026-04-02', bruto: '333.33', taxa: '13.30', valor: '320.03' },
  { vencimento: '2026-05-02', bruto: '333.33', taxa: '13.30', valor: '320.03' },
]);
assert.deepEqual(planoRecebivel('100.00', '1.99', 1, '2026-11-25', 1), [{ vencimento: '2026-11-26', bruto: '100.00', taxa: '1.99', valor: '98.01' }]);
console.log('rateio.test: ok');
