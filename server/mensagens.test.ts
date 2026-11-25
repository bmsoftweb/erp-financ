// Régua de cobrança (funções puras): npx tsx server/mensagens.test.ts
import assert from 'node:assert/strict';
import { dentroDoHorario, moedaBr, renderizar, telefoneWhatsApp, variaveisDesconhecidas, variaveisDoGrupo, variaveisUsadas } from './mensagens.js';

const email = `Olá, {{nome}}.

Parcela {{parcela}} de {{documento}}, R$ {{valor_atualizado}}.

Linha digitável: {{linha_digitavel}}
Pix copia e cola: {{pix_copia_cola}}

{{link}}`;
// Sem boleto, sem Pix e sem link: as linhas somem e não sobra linha em branco dupla
assert.equal(renderizar(email, { nome: 'Ana', parcela: '1/3', documento: 'NF 10', valor_atualizado: '1.030,00' }), 'Olá, Ana.\n\nParcela 1/3 de NF 10, R$ 1.030,00.');
assert.equal(renderizar('Oi {{ nome }}! {{link}}', { nome: 'Ana' }), 'Oi Ana!');
assert.deepEqual(variaveisDesconhecidas('{{nome}} {{valor}} {{x}}'), ['valor', 'x']);
assert.deepEqual(variaveisUsadas('{{nome}} {{parcela}} {{nome}}'), ['nome', 'parcela']);

assert.equal(moedaBr('1234567.8'), '1.234.567,80');
assert.equal(moedaBr('0.5'), '0,50');

// Duas parcelas do mesmo cliente no mesmo dia: valores somados, documento sem repetir
const v = variaveisDoGrupo([
  { nome: 'Ana', documento: 'NF 10', numero: 1, total_parcelas: 3, vencimento: '2026-12-10', valor_original: '333.34', valor_atualizado: '343.34', linha_digitavel: '111', pix_copia_cola: null },
  { nome: 'Ana', documento: 'NF 10', numero: 2, total_parcelas: 3, vencimento: '2026-12-10', valor_original: '333.33', valor_atualizado: '343.33', linha_digitavel: '222', pix_copia_cola: null },
]);
assert.deepEqual(v, { nome: 'Ana', documento: 'NF 10', parcela: '1/3, 2/3', vencimento: '10/12/2026', valor_original: '666,67', valor_atualizado: '686,67', linha_digitavel: '111\n222', pix_copia_cola: '', link: '' });

// 27/11/2026 é sexta; 28/11 sábado
assert.ok(dentroDoHorario('2026-11-27 08:00'));
assert.ok(dentroDoHorario('2026-11-27 17:59'));
assert.ok(!dentroDoHorario('2026-11-27 18:00'));
assert.ok(!dentroDoHorario('2026-11-27 07:59'));
assert.ok(!dentroDoHorario('2026-11-28 10:00'));

assert.equal(telefoneWhatsApp('(11) 98765-4321'), '5511987654321');
assert.equal(telefoneWhatsApp('5511987654321'), '5511987654321');
assert.equal(telefoneWhatsApp('1234'), null);
console.log('mensagens.test: ok');
