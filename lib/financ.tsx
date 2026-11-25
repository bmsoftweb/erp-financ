import { api } from '@/lib/api';

export type Lado = 'receber' | 'pagar';

export const NOME_LADO: Record<Lado, { titulo: string; pessoa: string; pesquisa: 'clientes' | 'fornecedores'; pago: string; dataConta: string; verbo: string }> = {
  receber: { titulo: 'Contas a receber', pessoa: 'Cliente', pesquisa: 'clientes', pago: 'Valor recebido', dataConta: 'Data de crédito', verbo: 'Receber' },
  pagar: { titulo: 'Contas a pagar', pessoa: 'Fornecedor', pesquisa: 'fornecedores', pago: 'Valor pago', dataConta: 'Data de débito', verbo: 'Pagar' },
};

export const STATUS_PARCELA: Record<string, { rotulo: string; cor: string }> = {
  aberta: { rotulo: 'Aberta', cor: 'text-blue-700 bg-blue-50 dark:text-blue-300 dark:bg-blue-950/50' },
  parcial: { rotulo: 'Parcial', cor: 'text-amber-700 bg-amber-50 dark:text-amber-300 dark:bg-amber-950/50' },
  quitada: { rotulo: 'Quitada', cor: 'text-emerald-700 bg-emerald-50 dark:text-emerald-300 dark:bg-emerald-950/50' },
  cancelada: { rotulo: 'Cancelada', cor: 'text-stone-500 bg-stone-100 dark:text-stone-400 dark:bg-stone-800' },
  renegociada: { rotulo: 'Renegociada', cor: 'text-violet-700 bg-violet-50 dark:text-violet-300 dark:bg-violet-950/50' },
};

/** Etiqueta colorida de status */
export const Etiqueta = ({ texto, cor }: { texto: string; cor: string }) => (
  <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold ${cor}`}>{texto}</span>
);

/** Soma em centavos (sem erro de float) e volta em reais */
export const somar = (valores: unknown[]) => valores.reduce<number>((a, v) => a + Math.round(Number(v || 0) * 100), 0) / 100;

/** Listas de apoio usadas em várias telas */
export interface ContaPlano { id: number; codigo: string; descricao: string; tipo: string; analitica: number; ativo: number; pai_id: number | null }
export interface Centro { id: number; codigo: string; descricao: string; analitico: number; ativo: number; pai_id: number | null }
export interface ContaFinanceira { id: number; nome: string; tipo: string; saldo: string; ativo: number; ban_conta_id: number | null; ban_conta_descricao?: string; chave_pix?: string; saldo_inicial: string; data_saldo_inicial: string; usuarios: number[] }
export interface Forma { id: number; nome: string; tipo: string; conta_financeira_id: number | null; dias_credito: number; taxa_pct: string; taxa_fixa: string; gera_recebivel_adquirente: number; ativo: number; conta_nome?: string }

export const carregarApoio = async () => {
  const [contas, formas, plano, centros] = await Promise.all([
    api<ContaFinanceira[]>('/api/financ/contas-financeiras'),
    api<Forma[]>('/api/financ/formas-pagamento'),
    api<ContaPlano[]>('/api/financ/plano-contas'),
    api<Centro[]>('/api/financ/centros-custo'),
  ]);
  return { contas: contas.filter((c) => Number(c.ativo)), formas: formas.filter((f) => Number(f.ativo)), plano, centros };
};
export type Apoio = Awaited<ReturnType<typeof carregarApoio>>;

/** Nível na árvore pelo código: 1 → 0, 1.1 → 1, 1.1.01 → 2 */
export const nivel = (codigo: string) => codigo.split('.').length - 1;

/** Opções de conta do plano / centro de custo que recebem lançamento (analíticos e ativos) */
export const opcoesPlano = (apoio: Apoio, tipo?: string) =>
  apoio.plano.filter((c) => Number(c.analitica) && Number(c.ativo) && (!tipo || c.tipo === tipo)).map((c) => <option key={c.id} value={c.id}>{c.codigo} {c.descricao}</option>);
export const opcoesCentro = (apoio: Apoio) =>
  apoio.centros.filter((c) => Number(c.analitico) && Number(c.ativo)).map((c) => <option key={c.id} value={c.id}>{c.codigo} {c.descricao}</option>);

export const ORIGEM_MOV: Record<string, string> = {
  baixa: 'Baixa', lote: 'Baixa em lote', transferencia: 'Transferência', lancamento_direto: 'Lançamento direto', caixa: 'Caixa', estorno: 'Estorno',
};

/** Primeiro dia do mês de uma data 'aaaa-mm-dd' */
export const inicioMes = (iso: string) => `${iso.slice(0, 7)}-01`;

/** 'aaaa-mm-dd' + n dias (sem fuso) */
export const somarDiasIso = (iso: string, n: number) => {
  const d = new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)) + n));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
};
