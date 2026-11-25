import Decimal from 'decimal.js';

/**
 * Sugestões de conciliação (função pura, testada em sugestoes.test.ts), na ordem do escopo:
 *  1. identificador exato (documento do movimento no documento/histórico do extrato) + mesmo valor
 *  2. mesmo valor + data ±3 dias + CPF/CNPJ da pessoa no histórico; depois mesmo valor ±3 dias com candidato único
 *  3. soma de vários movimentos (mesmo sinal, ±3 dias) = uma linha
 *  4. regras do usuário por prioridade (menor número primeiro): casam movimento da pessoa da regra ou viram
 *     lançamento direto com a conta e o centro da regra
 * Cada linha e cada movimento entram em uma sugestão só. Valores com sinal: entrada +, saída −.
 */

export interface LinhaExtrato { id: number; data: string; valor: string; documento: string | null; historico: string | null }
export interface MovConc { id: number; data: string; valor: string; documento: string | null; cpf_cnpj: string | null; pessoa_id: number | null }
export interface RegraConc {
  id: number; nome: string; campo: 'historico' | 'documento' | 'valor'; operador: 'contem' | 'igual' | 'comeca_com' | 'regex' | 'entre';
  texto: string; sentido: 'entrada' | 'saida' | 'ambos'; plano_conta_id: number | null; centro_custo_id: number | null; pessoa_id: number | null;
}
export interface Sugestao { extrato: number[]; movimentos: number[]; motivo: string; regra_id?: number; plano_conta_id?: number; centro_custo_id?: number }

const centavos = (v: string) => new Decimal(v).times(100).toNumber();
const dia = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 864e5;
const distancia = (a: string, b: string) => Math.abs(dia(a) - dia(b));
const alnum = (t: string | null) => (t ?? '').normalize('NFD').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
const texto = (t: string | null) => (t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();

/** Valor da regra "entre": "10,00;20,00" ou "10.00;20.00" (em módulo) */
const faixa = (t: string) => t.split(';').map((x) => new Decimal(x.trim().replace(/\./g, x.includes(',') ? '' : '.').replace(',', '.') || '0'));

export function regraCasa(r: RegraConc, e: LinhaExtrato): boolean {
  const valor = new Decimal(e.valor);
  if (r.sentido === 'entrada' && valor.lt(0)) return false;
  if (r.sentido === 'saida' && valor.gt(0)) return false;
  if (r.campo === 'valor') {
    const [a, b] = faixa(r.texto);
    return r.operador === 'entre' ? valor.abs().gte(a) && valor.abs().lte(b ?? a) : valor.abs().eq(a);
  }
  const alvo = texto(r.campo === 'historico' ? e.historico : e.documento);
  const t = texto(r.texto);
  switch (r.operador) {
    case 'igual': return alvo === t;
    case 'comeca_com': return alvo.startsWith(t);
    case 'regex':
      try { return new RegExp(r.texto, 'i').test(r.campo === 'historico' ? e.historico ?? '' : e.documento ?? ''); } catch { return false; }
    default: return !!t && alvo.includes(t);
  }
}

export function sugerir(extrato: LinhaExtrato[], movimentos: MovConc[], regras: RegraConc[]): Sugestao[] {
  const out: Sugestao[] = [];
  const usadoE = new Set<number>();
  const usadoM = new Set<number>();
  const livres = (e: LinhaExtrato, f: (m: MovConc) => boolean) =>
    movimentos.filter((m) => !usadoM.has(m.id) && f(m)).sort((a, b) => distancia(a.data, e.data) - distancia(b.data, e.data) || a.id - b.id);
  const casar = (e: LinhaExtrato, ms: MovConc[], motivo: string, extra: Partial<Sugestao> = {}) => {
    usadoE.add(e.id);
    ms.forEach((m) => usadoM.add(m.id));
    out.push({ extrato: [e.id], movimentos: ms.map((m) => m.id), motivo, ...extra });
  };
  const pendentes = () => extrato.filter((e) => !usadoE.has(e.id));

  // 1. identificador exato
  for (const e of pendentes()) {
    const doc = alnum(e.documento);
    const hist = alnum(e.historico);
    const [m] = livres(e, (m) => centavos(m.valor) === centavos(e.valor) && alnum(m.documento).length >= 4 && (alnum(m.documento) === doc || hist.includes(alnum(m.documento))));
    if (m) casar(e, [m], 'Identificador igual');
  }
  // 2. valor + data ±3 + CPF/CNPJ; depois valor + data ±3 com candidato único
  for (const e of pendentes()) {
    const digitos = (e.historico ?? '').replace(/\D/g, '') + (e.documento ?? '').replace(/\D/g, '');
    const [m] = livres(e, (m) => centavos(m.valor) === centavos(e.valor) && distancia(m.data, e.data) <= 3 && (m.cpf_cnpj ?? '').length >= 11 && digitos.includes(m.cpf_cnpj!));
    if (m) casar(e, [m], 'Valor, data e CPF/CNPJ');
  }
  for (const e of pendentes()) {
    const ms = livres(e, (m) => centavos(m.valor) === centavos(e.valor) && distancia(m.data, e.data) <= 3);
    const rivais = pendentes().filter((x) => x.id !== e.id && centavos(x.valor) === centavos(e.valor) && ms.some((m) => distancia(m.data, x.data) <= 3));
    if (ms.length === 1 && !rivais.length) casar(e, ms, 'Valor e data');
  }
  // 3. soma de vários movimentos = uma linha (até 16 candidatos mais próximos na data)
  for (const e of pendentes()) {
    const alvo = centavos(e.valor);
    const cands = livres(e, (m) => Math.sign(centavos(m.valor)) === Math.sign(alvo) && distancia(m.data, e.data) <= 3).slice(0, 16);
    let achou: MovConc[] | null = null;
    for (let mask = 1; mask < 1 << cands.length && !achou; mask++) {
      if ((mask & (mask - 1)) === 0) continue; // um só já foi tentado acima
      let soma = 0;
      for (let i = 0; i < cands.length; i++) if (mask & (1 << i)) soma += centavos(cands[i].valor);
      if (soma === alvo) achou = cands.filter((_, i) => mask & (1 << i));
    }
    if (achou) casar(e, achou, `Soma de ${achou.length} movimentos`);
  }
  // 4. regras do usuário
  for (const e of pendentes()) {
    for (const r of regras) {
      if (!regraCasa(r, e)) continue;
      const [m] = r.pessoa_id ? livres(e, (m) => m.pessoa_id === r.pessoa_id && centavos(m.valor) === centavos(e.valor)) : [];
      if (m) casar(e, [m], `Regra: ${r.nome}`, { regra_id: r.id });
      else if (r.plano_conta_id && r.centro_custo_id) casar(e, [], `Regra: ${r.nome} (lançamento direto)`, { regra_id: r.id, plano_conta_id: r.plano_conta_id, centro_custo_id: r.centro_custo_id });
      else continue;
      break;
    }
  }
  return out;
}

/** Pares (linha × movimento, valor) de uma conciliação N:N; soma com sinal tem de bater */
export function parear(extrato: { id: number; valor: string }[], movs: { id: number; valor: string }[]): { extrato: number; movimento: number; valor: string }[] {
  const soma = (l: { valor: string }[]) => l.reduce((a, x) => a.plus(x.valor), new Decimal(0));
  if (!extrato.length || !movs.length) throw new Error('Escolha ao menos uma linha do extrato e um movimento.');
  const se = soma(extrato);
  const sm = soma(movs);
  if (!se.eq(sm)) throw new Error(`Extrato soma ${se.toFixed(2)} e os movimentos ${sm.toFixed(2)}: os valores precisam bater.`);
  if (extrato.length === 1) return movs.map((m) => ({ extrato: extrato[0].id, movimento: m.id, valor: new Decimal(m.valor).abs().toFixed(2) }));
  if (movs.length === 1) return extrato.map((e) => ({ extrato: e.id, movimento: movs[0].id, valor: new Decimal(e.valor).abs().toFixed(2) }));
  const sinais = new Set([...extrato, ...movs].map((x) => Math.sign(Number(x.valor))));
  if (sinais.size > 1) throw new Error('Vários lançamentos × vários movimentos só com entradas ou só com saídas: concilie em partes.');
  // N:M do mesmo sinal: vai consumindo os dois lados em ordem
  const out: { extrato: number; movimento: number; valor: string }[] = [];
  const re = extrato.map((e) => ({ id: e.id, resta: new Decimal(e.valor).abs() }));
  const rm = movs.map((m) => ({ id: m.id, resta: new Decimal(m.valor).abs() }));
  let i = 0;
  let j = 0;
  while (i < re.length && j < rm.length) {
    const v = Decimal.min(re[i].resta, rm[j].resta);
    if (v.gt(0)) out.push({ extrato: re[i].id, movimento: rm[j].id, valor: v.toFixed(2) });
    re[i].resta = re[i].resta.minus(v);
    rm[j].resta = rm[j].resta.minus(v);
    if (re[i].resta.isZero()) i++;
    if (rm[j].resta.isZero()) j++;
  }
  return out;
}
