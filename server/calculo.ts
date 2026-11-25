import Decimal from 'decimal.js';

/**
 * Baixa parcial com juros e multa proporcionais: o núcleo do financeiro. Função pura (sem banco), a mesma para
 * receber e pagar. Teste: npx tsx server/calculo.test.ts
 *
 *   n  = dias de atraso (0 dentro da carência)
 *   M  = round2(S × m/100)               multa, só com atraso
 *   J  = round2(S × (j/100)/30 × n)      juros simples pro rata die
 *   T  = S + M + J                       total devido no dia
 *   f  = P / T
 *   multa paga = round2(M × f); juros pagos = round2(J × f); principal = P − multa − juros
 *
 * Os encargos que sobram ficam presos ao saldo de principal e são recalculados na próxima baixa.
 */

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export type ModoImputacao = 'proporcional' | 'encargos_primeiro';

export interface EntradaBaixa {
  /** S: saldo de principal da parcela */
  saldo: Decimal.Value;
  /** Base dos encargos (vencimento, ou o original se manter_encargos_original), 'aaaa-mm-dd' */
  vencimento: string;
  dataPagamento: string;
  carenciaDias?: number;
  multaPct?: Decimal.Value;
  jurosMesPct?: Decimal.Value;
  descontoPct?: Decimal.Value;
  descontoAte?: string | null;
  /** P: valor pago */
  valorPago: Decimal.Value;
  modo?: ModoImputacao;
  /** Encargos digitados (boleto do fornecedor, retorno do banco): substituem M e J calculados */
  multaInformada?: Decimal.Value | null;
  jurosInformados?: Decimal.Value | null;
  /** Encargos dispensados nesta baixa (tira primeiro dos juros, depois da multa) */
  dispensa?: Decimal.Value;
}

export interface ResultadoBaixa {
  diasAtraso: number;
  saldoAntes: string;
  multaDevida: string;
  jurosDevidos: string;
  /** T já sem a dispensa e com o desconto de pontualidade */
  totalDevido: string;
  fator: string;
  valorPago: string;
  valorPrincipal: string;
  valorMulta: string;
  valorJuros: string;
  valorDesconto: string;
  valorDispensado: string;
  valorExcedente: string;
  saldoDepois: string;
}

const D = (v: Decimal.Value | null | undefined) => new Decimal(v ?? 0);
export const round2 = (v: Decimal.Value) => new Decimal(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const txt = (v: Decimal) => v.toFixed(2);

/** Dias corridos de a até b ('aaaa-mm-dd'), sem fuso: b − a */
export function diasEntre(a: string, b: string): number {
  const ms = (s: string) => {
    const [y, m, d] = s.slice(0, 10).split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((ms(b) - ms(a)) / 86_400_000);
}

/** Dias de atraso que contam encargos: 0 até o fim da carência; depois, desde o vencimento */
export function diasAtraso(vencimento: string, dataPagamento: string, carenciaDias = 0): number {
  const n = Math.max(0, diasEntre(vencimento, dataPagamento));
  return n <= carenciaDias ? 0 : n;
}

/** Multa, juros (já sem a dispensa), desconto de pontualidade e total do dia */
function encargos(e: Omit<EntradaBaixa, 'valorPago'>) {
  const S = D(e.saldo);
  const n = diasAtraso(e.vencimento, e.dataPagamento, e.carenciaDias ?? 0);
  const informados = e.multaInformada != null || e.jurosInformados != null;
  const M = informados ? round2(D(e.multaInformada)) : n > 0 ? round2(S.times(D(e.multaPct)).div(100)) : new Decimal(0);
  const J = informados ? round2(D(e.jurosInformados)) : round2(S.times(D(e.jurosMesPct)).div(100).div(30).times(n));
  // Dispensa: até o total dos encargos, primeiro nos juros
  const disp = Decimal.min(round2(D(e.dispensa)), M.plus(J));
  const dispJ = Decimal.min(disp, J);
  const Mx = M.minus(disp.minus(dispJ));
  const Jx = J.minus(dispJ);
  const d = D(e.descontoPct);
  const comDesconto = n === 0 && !informados && d.gt(0) && !!e.descontoAte && e.dataPagamento <= e.descontoAte;
  const descontoTotal = comDesconto ? round2(S.times(d).div(100)) : new Decimal(0);
  return { S, n, M, J, disp, Mx, Jx, d: comDesconto ? d : new Decimal(0), descontoTotal, T: S.plus(Mx).plus(Jx).minus(descontoTotal) };
}

export function calcularBaixa(e: EntradaBaixa): ResultadoBaixa {
  const { S, n, M, J, disp, Mx, Jx, d, descontoTotal, T } = encargos(e);
  const P = round2(D(e.valorPago));
  if (S.lte(0)) throw new Error('Parcela sem saldo em aberto.');
  if (P.lte(0)) throw new Error('Informe o valor pago.');

  let multa: Decimal, juros: Decimal, principal: Decimal, desconto = new Decimal(0), excedente = new Decimal(0), dispensado = disp;
  const f = P.div(T);

  if (P.gte(T)) {
    // Quita tudo; o que passar vira crédito/adiantamento
    multa = Mx;
    juros = Jx;
    principal = S;
    desconto = descontoTotal;
    excedente = P.minus(T);
  } else if (d.gt(0)) {
    // Desconto de pontualidade proporcional: cada real pago amortiza 1/(1 − d) de principal
    principal = Decimal.min(S, round2(P.div(new Decimal(1).minus(d.div(100)))));
    desconto = principal.minus(P);
    multa = new Decimal(0);
    juros = new Decimal(0);
  } else if ((e.modo ?? 'proporcional') === 'encargos_primeiro') {
    // Art. 354 do Código Civil: quita multa e juros antes do principal
    multa = Decimal.min(P, Mx);
    juros = Decimal.min(P.minus(multa), Jx);
    principal = P.minus(multa).minus(juros);
  } else {
    multa = round2(Mx.times(f));
    juros = round2(Jx.times(f));
    principal = P.minus(multa).minus(juros);
    // A dispensa vale para a parte amortizada; o resto dos encargos segue preso ao saldo
    dispensado = round2(disp.times(f));
  }

  return {
    diasAtraso: n,
    saldoAntes: txt(S),
    multaDevida: txt(M),
    jurosDevidos: txt(J),
    totalDevido: txt(T),
    fator: Decimal.min(f, 1).toFixed(8),
    valorPago: txt(P),
    valorPrincipal: txt(principal),
    valorMulta: txt(multa),
    valorJuros: txt(juros),
    valorDesconto: txt(desconto),
    valorDispensado: txt(dispensado),
    valorExcedente: txt(excedente),
    saldoDepois: txt(S.minus(principal)),
  };
}

/** Cálculo inverso: quanto cobrar para amortizar X de principal (X × T / S; com desconto, X × (1 − d)) */
export function valorParaPrincipal(e: Omit<EntradaBaixa, 'valorPago'>, principal: Decimal.Value): string {
  const { S, Mx, Jx, d, T } = encargos(e);
  const X = Decimal.min(round2(D(principal)), S);
  if (X.gte(S)) return txt(T);
  if (d.gt(0)) return txt(round2(X.times(new Decimal(1).minus(d.div(100)))));
  if ((e.modo ?? 'proporcional') === 'encargos_primeiro') return txt(Mx.plus(Jx).plus(X));
  return txt(round2(X.times(T).div(S)));
}

/** Total do dia (para quitar), com os mesmos encargos da baixa */
export const totalDoDia = (e: Omit<EntradaBaixa, 'valorPago'>): string => txt(encargos(e).T);
