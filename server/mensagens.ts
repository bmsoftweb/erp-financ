import Decimal from 'decimal.js';

/**
 * Funções puras da régua de cobrança (testadas em mensagens.test.ts): variáveis do modelo, montagem do texto e
 * horário comercial. Nada aqui lê banco nem envia.
 */

export const VARIAVEIS = ['nome', 'documento', 'parcela', 'vencimento', 'valor_original', 'valor_atualizado', 'linha_digitavel', 'pix_copia_cola', 'link'] as const;
export type Variaveis = Partial<Record<(typeof VARIAVEIS)[number], string>>;
const VAR = /\{\{\s*(\w+)\s*\}\}/g;

/**
 * Troca {{variavel}} pelo valor. Linha cujas variáveis ficaram todas vazias some inteira (ex.: "Pix copia e cola: "
 * quando a parcela não tem Pix); linhas em branco repetidas viram uma.
 */
export function renderizar(corpo: string, v: Variaveis): string {
  const linhas = corpo.split('\n').flatMap((l) => {
    const usadas = [...l.matchAll(VAR)].map((m) => m[1]);
    const texto = l.replace(VAR, (_t, k: string) => (v as Record<string, string | undefined>)[k] ?? '');
    return usadas.length && usadas.every((k) => !(v as Record<string, string | undefined>)[k]) ? [] : [texto.replace(/[ \t]+$/, '')];
  });
  return linhas.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Variáveis do modelo que não existem (para avisar na tela) */
export const variaveisDesconhecidas = (corpo: string) => [...new Set([...corpo.matchAll(VAR)].map((m) => m[1]))].filter((k) => !(VARIAVEIS as readonly string[]).includes(k));

/** Variáveis usadas no corpo, na ordem em que aparecem (parâmetros do modelo aprovado no WhatsApp) */
export const variaveisUsadas = (corpo: string) => [...new Set([...corpo.matchAll(VAR)].map((m) => m[1]))];

export const moedaBr = (v: Decimal.Value) => {
  const [int, dec] = new Decimal(v).toFixed(2).split('.');
  return `${int.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${dec}`;
};
export const dataBr = (iso: string) => iso.slice(0, 10).split('-').reverse().join('/');

export interface ParcelaMensagem {
  nome: string; documento: string; numero: number; total_parcelas: number; vencimento: string; valor_original: Decimal.Value; valor_atualizado: Decimal.Value;
  linha_digitavel?: string | null; pix_copia_cola?: string | null; link?: string | null;
}

/** Parcelas do mesmo cliente numa mensagem só: valores somados, o resto listado sem repetir */
export function variaveisDoGrupo(ps: ParcelaMensagem[]): Variaveis {
  const unicos = (xs: (string | null | undefined)[], sep = ', ') => [...new Set(xs.filter(Boolean) as string[])].join(sep);
  const soma = (f: (p: ParcelaMensagem) => Decimal.Value) => moedaBr(ps.reduce((a, p) => a.plus(f(p)), new Decimal(0)));
  return {
    nome: ps[0]?.nome ?? '',
    documento: unicos(ps.map((p) => p.documento)),
    parcela: unicos(ps.map((p) => `${p.numero}/${p.total_parcelas}`)),
    vencimento: unicos(ps.map((p) => dataBr(p.vencimento))),
    valor_original: soma((p) => p.valor_original),
    valor_atualizado: soma((p) => p.valor_atualizado),
    linha_digitavel: unicos(ps.map((p) => p.linha_digitavel), '\n'),
    pix_copia_cola: unicos(ps.map((p) => p.pix_copia_cola), '\n'),
    link: unicos(ps.map((p) => p.link), '\n'),
  };
}

/**
 * Horário comercial em Brasília ('aaaa-mm-dd hh:mm'): segunda a sexta, das 8h às 18h.
 * ponytail: janela fixa; vira parâmetro quando alguma empresa pedir outro horário
 */
export function dentroDoHorario(agora: string): boolean {
  const [a, m, d] = agora.slice(0, 10).split('-').map(Number);
  const semana = new Date(Date.UTC(a, m - 1, d)).getUTCDay();
  const hora = Number(agora.slice(11, 13));
  return semana >= 1 && semana <= 5 && hora >= 8 && hora < 18;
}

/** Telefone para o WhatsApp: só dígitos, com DDI 55 quando vier DDD + número; null se não servir */
export function telefoneWhatsApp(bruto: string | null | undefined): string | null {
  let t = String(bruto ?? '').replace(/\D/g, '').replace(/^0+/, '');
  if (t.length === 10 || t.length === 11) t = `55${t}`;
  return t.length >= 12 && t.length <= 13 ? t : null;
}
