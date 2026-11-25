import type { Request } from 'express';
import type { PoolConnection } from 'mysql2/promise';
import { masterPool as pool } from './db.js';
import { falha } from './http.js';
import type { SessionData } from './session.js';

/** Conexão ou pool: o que tiver query() */
export type Db = Pick<PoolConnection, 'query'>;

export type Lado = 'receber' | 'pagar';

/**
 * Contas a receber e a pagar ficam em tabelas separadas, com o mesmo desenho. Tudo que muda entre os dois lados
 * está aqui, para os serviços (titulos.ts, baixas.ts) serem um só.
 */
export const LADOS = {
  receber: {
    titulos: 'fin_receber_titulos', rateios: 'fin_receber_titulo_rateios', parcelas: 'fin_receber_parcelas', baixas: 'fin_receber_baixas',
    dataConta: 'data_credito', dataPrevista: 'data_prevista_credito', fkBaixa: 'receber_baixa_id', fkOutraBaixa: 'pagar_baixa_id',
    movTipo: 'entrada', sinal: 1, saldoCredito: 'saldo_credito_receber',
    contaPadrao: 'conta_venda_id', contaJuros: 'conta_juros_recebidos_id', contaMulta: 'conta_multas_recebidas_id', contaDesconto: 'conta_desconto_concedido_id',
    origemDoc: 'venda', fkDoc: 'venda_id', fkDocParcela: 'venda_parcela_id', nome: 'a receber', pessoa: 'cliente',
  },
  pagar: {
    titulos: 'fin_pagar_titulos', rateios: 'fin_pagar_titulo_rateios', parcelas: 'fin_pagar_parcelas', baixas: 'fin_pagar_baixas',
    dataConta: 'data_debito', dataPrevista: 'data_prevista_pagamento', fkBaixa: 'pagar_baixa_id', fkOutraBaixa: 'receber_baixa_id',
    movTipo: 'saida', sinal: -1, saldoCredito: 'saldo_credito_pagar',
    contaPadrao: 'conta_compra_id', contaJuros: 'conta_juros_pagos_id', contaMulta: 'conta_multas_pagas_id', contaDesconto: 'conta_desconto_obtido_id',
    origemDoc: 'compra', fkDoc: 'entrada_id', fkDocParcela: 'entrada_parcela_id', nome: 'a pagar', pessoa: 'fornecedor',
  },
} as const;

export function ladoDe(v: unknown): Lado {
  if (v !== 'receber' && v !== 'pagar') falha('Use receber ou pagar.', 404);
  return v as Lado;
}

export const empresaDe = (s: SessionData): number => Number(s.empresaId ?? 1);
export const usuarioDe = (s: SessionData): number | null => (s.userId ? Number(s.userId) : null);

// ------------------------------------------------------------------ parâmetros

export async function parametros(db: Db, empresa: number): Promise<any> {
  const [[p]]: any = await db.query('SELECT * FROM fin_parametros WHERE empresa_id = ?', [empresa]);
  return p ?? { empresa_id: empresa, multa_pct: 2, juros_mes_pct: 1, carencia_dias: 0, desconto_pct: 0, desconto_dias: 0, modo_imputacao: 'proporcional' };
}

/** Conta padrão de fin_parametros obrigatória para a operação */
export function contaParam(p: any, campo: string, nome: string): number {
  return p[campo] ? Number(p[campo]) : falha(`Configure a conta "${nome}" em Parâmetros.`);
}

// ------------------------------------------------------------------ permissões

/**
 * Permissões do financeiro em sys_permissoes (modulo FIN) + sys_perfil_permissao do perfil do usuário.
 * Admin e super podem tudo; o usuário comum só o que o perfil dele libera.
 */
export const PERMISSOES = {
  baixar: { recurso: 'baixas', acao: 'CRIAR', nome: 'Baixar parcelas' },
  estornar: { recurso: 'baixas', acao: 'EXCLUIR', nome: 'Estornar baixas' },
  dispensar: { recurso: 'encargos', acao: 'APROVAR', nome: 'Dispensar encargos' },
  aprovar: { recurso: 'pagamentos', acao: 'APROVAR', nome: 'Aprovar pagamentos' },
  periodo: { recurso: 'periodo_fechado', acao: 'EDITAR', nome: 'Alterar período fechado' },
  contas: { recurso: 'contas_financeiras', acao: 'VISUALIZAR', nome: 'Ver todas as contas financeiras' },
  movimentar: { recurso: 'movimentos', acao: 'CRIAR', nome: 'Lançamento direto, transferência e caixa' },
  conciliar: { recurso: 'conciliacao', acao: 'CRIAR', nome: 'Conciliar extrato' },
  cobrar: { recurso: 'cobranca', acao: 'CRIAR', nome: 'Régua de cobrança e envio de mensagens' },
} as const;
export type Permissao = keyof typeof PERMISSOES;

export const ehAdmin = (s: SessionData) => s.role === 'admin' || s.role === 'super' || s.role === 'sistema';

export async function pode(s: SessionData, chave: Permissao): Promise<boolean> {
  if (ehAdmin(s)) return true;
  if (!s.userId) return false;
  const { recurso, acao } = PERMISSOES[chave];
  const [r]: any = await pool.query(
    `SELECT 1 FROM sys_usuarios u
       JOIN sys_perfil_permissao pp ON pp.perfil_id = u.perfil_id
       JOIN sys_permissoes p ON p.id = pp.permissao_id
      WHERE u.id = ? AND p.modulo = 'FIN' AND p.recurso = ? AND p.acao = ? AND pp.${acao.toLowerCase()} = 1 LIMIT 1`,
    [s.userId, recurso, acao],
  );
  return r.length > 0;
}

export async function exigir(s: SessionData, chave: Permissao) {
  if (!(await pode(s, chave))) falha(`Sem permissão: ${PERMISSOES[chave].nome}.`, 403);
}

/** Período fechado: nada com data ≤ periodo_fechado_ate, salvo permissão */
export async function conferirPeriodo(db: Db, s: SessionData, ...datas: (string | null | undefined)[]) {
  const p = await parametros(db, empresaDe(s));
  const ate = p.periodo_fechado_ate ? String(p.periodo_fechado_ate).slice(0, 10) : null;
  if (!ate) return;
  const fechada = datas.find((d) => d && d.slice(0, 10) <= ate);
  if (fechada && !(await pode(s, 'periodo'))) falha(`Período fechado até ${ate.split('-').reverse().join('/')}: data ${fechada.slice(0, 10).split('-').reverse().join('/')} não pode ser usada.`);
}

/**
 * Conta financeira da empresa, ativa e liberada ao usuário: conta com usuários em fin_conta_financeira_usuarios
 * só aparece para eles (e para quem tem "ver todas as contas").
 */
export async function contaDoUsuario(db: Db, s: SessionData, contaId: number): Promise<any> {
  const [[c]]: any = await db.query('SELECT * FROM fin_contas_financeiras WHERE id = ? AND empresa_id = ?', [contaId, empresaDe(s)]);
  if (!c) falha('Conta financeira não encontrada.');
  if (!Number(c.ativo)) falha(`Conta financeira "${c.nome}" inativa.`);
  if (!(await pode(s, 'contas'))) {
    const [us]: any = await db.query('SELECT usuario_id FROM fin_conta_financeira_usuarios WHERE conta_financeira_id = ?', [contaId]);
    if (us.length && !us.some((u: any) => Number(u.usuario_id) === s.userId)) falha(`Sem acesso à conta "${c.nome}".`, 403);
  }
  return c;
}

/** Filtro SQL das contas que o usuário pode ver (alias da fin_contas_financeiras) */
export async function filtroContas(s: SessionData, alias = 'cf'): Promise<{ sql: string; params: unknown[] }> {
  if (await pode(s, 'contas')) return { sql: '1=1', params: [] };
  return {
    sql: `(NOT EXISTS (SELECT 1 FROM fin_conta_financeira_usuarios x WHERE x.conta_financeira_id = ${alias}.id)
           OR EXISTS (SELECT 1 FROM fin_conta_financeira_usuarios x WHERE x.conta_financeira_id = ${alias}.id AND x.usuario_id = ?))`,
    params: [s.userId ?? 0],
  };
}

// ------------------------------------------------------------------ auditoria

export async function auditar(db: Db, s: SessionData, req: Request | null, entidade: string, id: number | string, acao: string, antes: unknown, depois: unknown) {
  await db.query('INSERT INTO fin_auditoria SET ?', [{
    empresa_id: empresaDe(s), entidade, entidade_id: id, acao,
    antes: antes == null ? null : JSON.stringify(antes), depois: depois == null ? null : JSON.stringify(depois),
    usuario_id: usuarioDe(s), ip: req ? String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].slice(0, 45) : null,
  }]);
}

// ------------------------------------------------------------------ pessoas e plano

/** Pessoa do grupo da empresa (cad_pessoas é por grupo) */
export async function pessoaDaEmpresa(db: Db, empresa: number, pessoaId: number): Promise<any> {
  const [[p]]: any = await db.query(
    `SELECT p.id, p.nome, p.bloqueado, p.limite_credito FROM cad_pessoas p JOIN sys_empresas e ON e.grupo_id = p.grupo_id
      WHERE p.id = ? AND e.id = ? AND p.date_delete IS NULL`,
    [pessoaId, empresa],
  );
  return p ?? falha('Pessoa não encontrada no cadastro do grupo.');
}

/** Conta do plano analítica e ativa + centro de custo analítico e ativo, da empresa */
export async function conferirClassificacao(db: Db, empresa: number, contaId: number, centroId: number) {
  const [[c]]: any = await db.query('SELECT codigo, descricao, analitica, ativo FROM fin_plano_contas WHERE id = ? AND empresa_id = ?', [contaId, empresa]);
  if (!c) falha('Conta do plano não encontrada.');
  if (!Number(c.analitica) || !Number(c.ativo)) falha(`Conta ${c.codigo} ${c.descricao}: use uma conta analítica ativa.`);
  const [[cc]]: any = await db.query('SELECT codigo, descricao, analitico, ativo FROM fin_centros_custo WHERE id = ? AND empresa_id = ?', [centroId, empresa]);
  if (!cc) falha('Centro de custo não encontrado.');
  if (!Number(cc.analitico) || !Number(cc.ativo)) falha(`Centro de custo ${cc.codigo} ${cc.descricao}: use um centro analítico ativo.`);
}

export { somarDias } from './datas.js';
