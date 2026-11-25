// Conciliação (sugestões e pares) e datas da recorrência: npx tsx server/sugestoes.test.ts
import assert from 'node:assert/strict';
import { parear, regraCasa, sugerir, type LinhaExtrato, type MovConc, type RegraConc } from './sugestoes.js';
import { ocorrencias, somarMeses } from './datas.js';

const e = (id: number, data: string, valor: string, historico = '', documento: string | null = null): LinhaExtrato => ({ id, data, valor, historico, documento });
const m = (id: number, data: string, valor: string, x: Partial<MovConc> = {}): MovConc => ({ id, data, valor, documento: null, cpf_cnpj: null, pessoa_id: null, ...x });
const regra = (x: Partial<RegraConc>): RegraConc => ({ id: 1, nome: 'Tarifa', campo: 'historico', operador: 'contem', texto: 'TARIFA', sentido: 'saida', plano_conta_id: 50, centro_custo_id: 7, pessoa_id: null, ...x });

const extrato = [
  e(1, '2026-11-10', '1500.00', 'PIX RECEBIDO 12345678000199 LOJA X'),
  e(2, '2026-11-10', '-89.90', 'PAGTO BOLETO', 'NF4471'),
  e(3, '2026-11-11', '300.00', 'DEP DINHEIRO'),
  e(4, '2026-11-12', '-12.50', 'TARIFA PACOTE SERVICOS'),
  e(5, '2026-11-20', '777.77', 'TED SEM PAR'),
];
const movs = [
  m(10, '2026-11-09', '1500.00', { cpf_cnpj: '12345678000199', pessoa_id: 3 }), // 2: valor, data ±3 e CNPJ
  m(11, '2026-11-10', '1500.00'), // mesmo valor, sem CNPJ: fica livre
  m(12, '2026-11-10', '-89.90', { documento: 'NF-4471' }), // 1: identificador (NF-4471 ~ NF4471)
  m(13, '2026-11-11', '100.00'), // 3: 100 + 200 = 300
  m(14, '2026-11-11', '200.00'),
];
const s = sugerir(extrato, movs, [regra({})]);
assert.deepEqual(s.find((x) => x.extrato[0] === 2), { extrato: [2], movimentos: [12], motivo: 'Identificador igual' });
assert.deepEqual(s.find((x) => x.extrato[0] === 1)?.movimentos, [10]);
assert.equal(s.find((x) => x.extrato[0] === 1)?.motivo, 'Valor, data e CPF/CNPJ');
assert.deepEqual(s.find((x) => x.extrato[0] === 3)?.movimentos, [13, 14]);
assert.deepEqual(s.find((x) => x.extrato[0] === 4), { extrato: [4], movimentos: [], motivo: 'Regra: Tarifa (lançamento direto)', regra_id: 1, plano_conta_id: 50, centro_custo_id: 7 });
assert.equal(s.find((x) => x.extrato.includes(5)), undefined);
assert.ok(!s.some((x) => x.movimentos.includes(11)));

// valor + data com candidato único; dois candidatos no mesmo valor não sugerem nada
assert.deepEqual(sugerir([e(1, '2026-11-10', '50.00')], [m(9, '2026-11-12', '50.00')], [])[0].movimentos, [9]);
assert.equal(sugerir([e(1, '2026-11-10', '50.00'), e(2, '2026-11-10', '50.00')], [m(9, '2026-11-12', '50.00')], []).length, 0);
assert.equal(sugerir([e(1, '2026-11-10', '50.00')], [m(9, '2026-11-14', '50.00')], []).length, 0); // 4 dias

// regras
assert.equal(regraCasa(regra({}), e(1, '2026-11-01', '12.50', 'TARIFA')), false); // sentido saída
assert.equal(regraCasa(regra({ campo: 'valor', operador: 'entre', texto: '10,00;20,00', sentido: 'ambos' }), e(1, '2026-11-01', '-12.50')), true);
assert.equal(regraCasa(regra({ operador: 'comeca_com', texto: 'tarifa' }), e(1, '2026-11-01', '-1.00', 'Tarifa DOC')), true);
assert.equal(regraCasa(regra({ operador: 'regex', texto: '^IOF\\b' }), e(1, '2026-11-01', '-1.00', 'IOF S/ SALDO')), true);
assert.equal(regraCasa(regra({ operador: 'regex', texto: '([' }), e(1, '2026-11-01', '-1.00', 'X')), false);

// pares N:N
assert.deepEqual(parear([{ id: 1, valor: '300.00' }], [{ id: 13, valor: '100.00' }, { id: 14, valor: '200.00' }]), [
  { extrato: 1, movimento: 13, valor: '100.00' }, { extrato: 1, movimento: 14, valor: '200.00' },
]);
assert.deepEqual(parear([{ id: 1, valor: '98.00' }], [{ id: 5, valor: '100.00' }, { id: 6, valor: '-2.00' }]).map((p) => p.valor), ['100.00', '2.00']);
assert.deepEqual(parear([{ id: 1, valor: '60.00' }, { id: 2, valor: '40.00' }], [{ id: 7, valor: '30.00' }, { id: 8, valor: '70.00' }]), [
  { extrato: 1, movimento: 7, valor: '30.00' }, { extrato: 1, movimento: 8, valor: '30.00' }, { extrato: 2, movimento: 8, valor: '40.00' },
]);
assert.throws(() => parear([{ id: 1, valor: '100.00' }], [{ id: 5, valor: '99.99' }]), /precisam bater/);

// datas
assert.equal(somarMeses('2026-01-31', 1), '2026-02-28');
assert.equal(somarMeses('2026-11-15', 3), '2027-02-15');
assert.deepEqual(ocorrencias({ inicio: '2026-01-31', dia_vencimento: 31, periodicidade: 'mensal' }, '2026-01-01', '2026-04-30'), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
assert.deepEqual(ocorrencias({ inicio: '2026-11-20', dia_vencimento: 10, periodicidade: 'mensal', fim: '2027-01-31' }, '2026-11-01', '2027-06-30'), ['2026-12-10', '2027-01-10']);
assert.deepEqual(ocorrencias({ inicio: '2026-11-02', dia_vencimento: 1, periodicidade: 'semanal' }, '2026-11-05', '2026-11-20'), ['2026-11-09', '2026-11-16']);

console.log('sugestoes.test: ok');
