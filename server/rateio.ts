import Decimal from 'decimal.js';
import { round2 } from './calculo.js';
import { somarDias, somarMeses } from './datas.js';

/**
 * Reparte um valor pelos pesos (percentuais do rateio), em centavos; a diferença de arredondamento vai para a
 * maior linha, para a soma fechar exata. Teste: npx tsx server/rateio.test.ts
 */
export function distribuir(total: Decimal.Value, pesos: Decimal.Value[]): string[] {
  if (!pesos.length) return [];
  const T = round2(total);
  const soma = pesos.reduce<Decimal>((a, p) => a.plus(p), new Decimal(0));
  if (soma.lte(0)) throw new Error('Rateio sem percentual.');
  const partes = pesos.map((p) => round2(T.times(p).div(soma)));
  const maior = pesos.reduce<number>((m, p, i) => (new Decimal(p).gt(pesos[m]) ? i : m), 0);
  const resto = T.minus(partes.reduce<Decimal>((a, p) => a.plus(p), new Decimal(0)));
  partes[maior] = partes[maior].plus(resto);
  return partes.map((p) => p.toFixed(2));
}

/** Percentuais do rateio somam exatamente 100 (4 casas)? */
export const fecha100 = (pcts: Decimal.Value[]) => pcts.reduce<Decimal>((a, p) => a.plus(p), new Decimal(0)).eq(100);

/** Percentuais (4 casas, somando 100) proporcionais aos valores; a sobra vai para o maior. Renegociação usa. */
export function percentuais(valores: Decimal.Value[]): string[] {
  const soma = valores.reduce<Decimal>((a, v) => a.plus(v), new Decimal(0));
  if (soma.lte(0)) throw new Error('Rateio sem valor.');
  const partes = valores.map((v) => new Decimal(v).times(100).div(soma).toDecimalPlaces(4, Decimal.ROUND_HALF_UP));
  const maior = valores.reduce<number>((m, v, i) => (new Decimal(v).gt(valores[m]) ? i : m), 0);
  partes[maior] = partes[maior].plus(new Decimal(100).minus(partes.reduce<Decimal>((a, p) => a.plus(p), new Decimal(0))));
  return partes.map((p) => p.toFixed(4));
}

/** Bruto em n parcelas mensais: o 1º repasse em D+dias_repasse, os demais mês a mês; taxa repartida igual */
export function planoRecebivel(bruto: Decimal.Value, taxa: Decimal.Value, n: number, dataVenda: string, diasRepasse: number) {
  const brutos = distribuir(bruto, Array(n).fill(1));
  const taxas = distribuir(taxa, Array(n).fill(1));
  const primeiro = somarDias(dataVenda, diasRepasse);
  return brutos.map((b, i) => ({ vencimento: somarMeses(primeiro, i), bruto: b, taxa: taxas[i], valor: new Decimal(b).minus(taxas[i]).toFixed(2) }));
}
