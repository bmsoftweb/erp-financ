/** Datas 'aaaa-mm-dd' sem fuso (contas em UTC só para aritmética): funções puras, testadas em datas.test.ts */

/** 'aaaa-mm-dd' + n dias */
export function somarDias(iso: string, n: number): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

const ultimoDia = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const isoDe = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** Soma meses mantendo o dia (limitado ao fim do mês): 31/01 + 1 → 28/02 */
export function somarMeses(data: string, n: number, dia = Number(data.slice(8, 10))): string {
  const total = Number(data.slice(0, 4)) * 12 + Number(data.slice(5, 7)) - 1 + n;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return isoDe(y, m, Math.min(dia, ultimoDia(y, m)));
}

/** Datas de vencimento de uma recorrência entre "de" e "ate" (inclusive) */
export function ocorrencias(r: { inicio: string; dia_vencimento: number; periodicidade: string; fim?: string | null }, de: string, ate: string): string[] {
  const meses: Record<string, number> = { mensal: 1, bimestral: 2, trimestral: 3, semestral: 6, anual: 12 };
  const fim = r.fim && r.fim < ate ? r.fim : ate;
  const out: string[] = [];
  if (meses[r.periodicidade]) {
    const passo = meses[r.periodicidade];
    let d = somarMeses(`${r.inicio.slice(0, 8)}01`, 0, r.dia_vencimento);
    if (d < r.inicio) d = somarMeses(d, passo, r.dia_vencimento);
    for (let i = 0; i < 600 && d <= fim; i++, d = somarMeses(d, passo, r.dia_vencimento)) if (d >= de) out.push(d);
  } else {
    const passo = r.periodicidade === 'semanal' ? 7 : 14;
    for (let d = r.inicio, i = 0; i < 2000 && d <= fim; i++, d = somarDias(d, passo)) if (d >= de) out.push(d);
  }
  return out;
}

