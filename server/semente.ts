import type { Db } from './comum.js';

/**
 * Cadastros padrão de uma empresa: plano de contas gerencial, centros de custo, formas de pagamento, conta Caixa e
 * fin_parametros (multa 2%, juros 1% a.m.) com as contas padrão (só com o plano vazio), e a régua de cobrança padrão
 * com os modelos de mensagem (só sem modelos).
 * Também cria as permissões do módulo em sys_permissoes (modulo FIN). Tela: Parâmetros › Criar cadastros padrão.
 */

type Conta = [codigo: string, descricao: string, tipo: 'receita' | 'despesa' | 'transferencia', param?: string];

// Sintéticas = as que têm filhas; as folhas são analíticas
const PLANO: Conta[] = [
  ['1', 'Receitas', 'receita'],
  ['1.1', 'Receita de vendas', 'receita'],
  ['1.1.01', 'Venda de mercadorias', 'receita', 'conta_venda_id'],
  ['1.1.02', 'Prestação de serviços', 'receita'],
  ['1.2', 'Outras receitas operacionais', 'receita'],
  ['1.2.01', 'Receitas diversas', 'receita'],
  ['2', 'Deduções da receita', 'despesa'],
  ['2.1', 'Deduções', 'despesa'],
  ['2.1.01', 'Impostos sobre vendas', 'despesa'],
  ['2.1.02', 'Devoluções e abatimentos', 'despesa'],
  ['3', 'Custos', 'despesa'],
  ['3.1', 'Custo das mercadorias', 'despesa'],
  ['3.1.01', 'Compra de mercadorias', 'despesa', 'conta_compra_id'],
  ['3.1.02', 'Fretes sobre compras', 'despesa'],
  ['4', 'Despesas operacionais', 'despesa'],
  ['4.1', 'Despesas administrativas', 'despesa'],
  ['4.1.01', 'Aluguel e condomínio', 'despesa'],
  ['4.1.02', 'Energia, água e telefone', 'despesa'],
  ['4.1.03', 'Material de escritório', 'despesa'],
  ['4.1.04', 'Serviços de terceiros', 'despesa'],
  ['4.2', 'Despesas com pessoal', 'despesa'],
  ['4.2.01', 'Salários', 'despesa'],
  ['4.2.02', 'Encargos sociais', 'despesa'],
  ['4.3', 'Despesas comerciais', 'despesa'],
  ['4.3.01', 'Comissões', 'despesa'],
  ['4.3.02', 'Marketing', 'despesa'],
  ['4.4', 'Outras despesas', 'despesa'],
  ['4.4.01', 'Quebra de caixa', 'despesa', 'conta_quebra_caixa_id'],
  ['5', 'Receitas financeiras', 'receita'],
  ['5.1', 'Receitas financeiras', 'receita'],
  ['5.1.01', 'Juros recebidos', 'receita', 'conta_juros_recebidos_id'],
  ['5.1.02', 'Multas recebidas', 'receita', 'conta_multas_recebidas_id'],
  ['5.1.03', 'Descontos obtidos', 'receita', 'conta_desconto_obtido_id'],
  ['5.1.04', 'Rendimentos de aplicações', 'receita'],
  ['6', 'Despesas financeiras', 'despesa'],
  ['6.1', 'Despesas financeiras', 'despesa'],
  ['6.1.01', 'Juros pagos', 'despesa', 'conta_juros_pagos_id'],
  ['6.1.02', 'Multas pagas', 'despesa', 'conta_multas_pagas_id'],
  ['6.1.03', 'Descontos concedidos', 'despesa', 'conta_desconto_concedido_id'],
  ['6.1.04', 'Tarifas bancárias', 'despesa', 'conta_tarifas_bancarias_id'],
  ['6.1.05', 'Taxas de cartão', 'despesa', 'conta_taxas_cartao_id'],
  ['6.1.06', 'Custo de antecipação de recebíveis', 'despesa', 'conta_antecipacao_id'],
  ['6.1.07', 'IOF', 'despesa'],
  ['7', 'Transferências', 'transferencia'],
  ['7.1', 'Transferências entre contas', 'transferencia'],
];

const CENTROS = [['1', 'Administrativo'], ['2', 'Comercial'], ['3', 'Loja 1']];

// Mesmos nomes de forma_pagamento das parcelas de venda e compra (TPAG do erp-vendas/erp-compras)
const FORMAS: [nome: string, tipo: string, dias: number, caixa?: boolean][] = [
  ['Dinheiro', 'dinheiro', 0, true],
  ['PIX', 'pix', 0],
  ['Boleto', 'boleto', 1],
  ['Cartão de crédito', 'cartao_credito', 30],
  ['Cartão de débito', 'cartao_debito', 1],
  ['Transferência', 'transferencia', 0],
  ['Depósito bancário', 'transferencia', 0],
  ['Cheque', 'cheque', 0],
  ['Crédito em loja', 'credito_pessoa', 0],
];

export const PERMISSOES_FIN: [recurso: string, acao: string][] = [
  ['baixas', 'CRIAR'], ['baixas', 'EXCLUIR'], ['encargos', 'APROVAR'], ['pagamentos', 'APROVAR'], ['periodo_fechado', 'EDITAR'], ['contas_financeiras', 'VISUALIZAR'],
  ['movimentos', 'CRIAR'], ['conciliacao', 'CRIAR'], ['cobranca', 'CRIAR'],
];

// Régua padrão (só receber). Variáveis do corpo: ver o comentário de fin_templates.corpo na migration
type Modelo = [chave: string, canal: 'whatsapp' | 'email', nome: string, assunto: string | null, corpo: string];
const MODELOS: Modelo[] = [
  ['emissao_wa', 'whatsapp', 'Emissão', null, 'Olá, {{nome}}! Sua parcela {{parcela}} de {{documento}}, no valor de R$ {{valor_original}}, vence em {{vencimento}}. {{link}}'],
  ['emissao_email', 'email', 'Emissão', 'Sua cobrança {{documento}} — vencimento {{vencimento}}', `Olá, {{nome}}.

Segue a parcela {{parcela}} de {{documento}}, no valor de R$ {{valor_original}}, com vencimento em {{vencimento}}.

Linha digitável: {{linha_digitavel}}
Pix copia e cola: {{pix_copia_cola}}

{{link}}`],
  ['lembrete_wa', 'whatsapp', 'Lembrete (3 dias antes)', null, 'Olá, {{nome}}! Lembrete: a parcela {{parcela}} de {{documento}} (R$ {{valor_original}}) vence em {{vencimento}}. {{link}}'],
  ['vence_hoje_wa', 'whatsapp', 'Vence hoje', null, 'Olá, {{nome}}! A parcela {{parcela}} de {{documento}} (R$ {{valor_original}}) vence hoje. Pix copia e cola: {{pix_copia_cola}}'],
  ['atraso_wa', 'whatsapp', 'Em atraso', null, 'Olá, {{nome}}. Não identificamos o pagamento da parcela {{parcela}} de {{documento}}, vencida em {{vencimento}}. Valor atualizado: R$ {{valor_atualizado}}. {{link}}'],
  ['atraso_email', 'email', 'Em atraso', 'Parcela em atraso — {{documento}}', `Olá, {{nome}}.

Não identificamos o pagamento da parcela {{parcela}} de {{documento}}, vencida em {{vencimento}}.
Valor atualizado para hoje: R$ {{valor_atualizado}}.

{{link}}

Se já pagou, desconsidere esta mensagem.`],
  ['recibo_wa', 'whatsapp', 'Recibo', null, 'Olá, {{nome}}! Recebemos o pagamento da parcela {{parcela}} de {{documento}}. Obrigado!'],
];
// [evento, dias em relação ao vencimento, modelo]
const ETAPAS: [evento: 'emissao' | 'vencimento' | 'pagamento', dias: number, modelo: string][] = [
  ['emissao', 0, 'emissao_email'], ['emissao', 0, 'emissao_wa'],
  ['vencimento', -3, 'lembrete_wa'], ['vencimento', 0, 'vence_hoje_wa'],
  ['vencimento', 3, 'atraso_wa'], ['vencimento', 3, 'atraso_email'],
  ['vencimento', 10, 'atraso_wa'], ['vencimento', 30, 'atraso_email'],
  ['pagamento', 0, 'recibo_wa'],
];

/** Régua de cobrança padrão com os modelos; só se a empresa ainda não tem modelos */
async function semearRegua(c: Db, empresa: number, usuario: number | null): Promise<boolean> {
  const [[ja]]: any = await c.query('SELECT COUNT(*) n FROM fin_templates WHERE empresa_id = ?', [empresa]);
  if (Number(ja.n)) return false;
  const ids = new Map<string, number>();
  for (const [chave, canal, nome, assunto, corpo] of MODELOS) {
    const [r]: any = await c.query('INSERT INTO fin_templates SET ?', [{ empresa_id: empresa, canal, nome, assunto, corpo, usuario_id: usuario }]);
    ids.set(chave, r.insertId);
  }
  for (const [ordem, [evento, dias, modelo]] of ETAPAS.entries()) {
    await c.query('INSERT INTO fin_regua_etapas SET ?', [{ empresa_id: empresa, evento, dias_relativos: dias, canal: MODELOS.find((m) => m[0] === modelo)![1], template_id: ids.get(modelo), ordem: ordem + 1, usuario_id: usuario }]);
  }
  return true;
}

export async function semearEmpresa(c: Db, empresa: number, usuario: number | null): Promise<{ criado: boolean; regua: boolean }> {
  for (const [recurso, acao] of PERMISSOES_FIN) await c.query("INSERT IGNORE INTO sys_permissoes (modulo, recurso, acao) VALUES ('FIN', ?, ?)", [recurso, acao]);
  const regua = await semearRegua(c, empresa, usuario);
  const [[ja]]: any = await c.query('SELECT COUNT(*) n FROM fin_plano_contas WHERE empresa_id = ?', [empresa]);
  if (Number(ja.n)) return { criado: false, regua };

  const ids = new Map<string, number>();
  const params: Record<string, number> = {};
  for (const [codigo, descricao, tipo, param] of PLANO) {
    const pai = codigo.includes('.') ? ids.get(codigo.slice(0, codigo.lastIndexOf('.'))) ?? null : null;
    const analitica = PLANO.some(([outro]) => outro.startsWith(codigo + '.')) ? 0 : 1;
    const [r]: any = await c.query('INSERT INTO fin_plano_contas SET ?', [{ empresa_id: empresa, codigo, descricao, tipo, pai_id: pai, analitica, usuario_id: usuario }]);
    ids.set(codigo, r.insertId);
    if (param) params[param] = r.insertId;
  }
  const centros: number[] = [];
  for (const [codigo, descricao] of CENTROS) {
    const [r]: any = await c.query('INSERT INTO fin_centros_custo SET ?', [{ empresa_id: empresa, codigo, descricao, analitico: 1, usuario_id: usuario }]);
    centros.push(r.insertId);
  }
  const [[existe]]: any = await c.query("SELECT id FROM fin_contas_financeiras WHERE empresa_id = ? AND nome = 'Caixa'", [empresa]);
  const caixa = existe?.id ?? ((await c.query("INSERT INTO fin_contas_financeiras SET ?, data_saldo_inicial = CURDATE()", [{ empresa_id: empresa, tipo: 'caixa', nome: 'Caixa', saldo_inicial: 0, usuario_id: usuario }])) as any)[0].insertId;
  for (const [nome, tipo, dias, noCaixa] of FORMAS) {
    await c.query('INSERT IGNORE INTO fin_formas_pagamento SET ?', [{ empresa_id: empresa, nome, tipo, dias_credito: dias, conta_financeira_id: noCaixa ? caixa : null, usuario_id: usuario }]);
  }
  await c.query(
    `INSERT INTO fin_parametros SET ? ON DUPLICATE KEY UPDATE ${Object.keys(params).map((k) => `${k} = VALUES(${k})`).join(', ')},
       centro_custo_padrao_id = VALUES(centro_custo_padrao_id), centro_custo_tarifas_id = VALUES(centro_custo_tarifas_id)`,
    [{ empresa_id: empresa, multa_pct: 2, juros_mes_pct: 1, ...params, centro_custo_padrao_id: centros[0], centro_custo_tarifas_id: centros[0], usuario_id: usuario }],
  );
  return { criado: true, regua };
}

// Linha de comando: npx tsx server/semente.ts <empresa_id>
if (process.argv[1]?.replace(/\\/g, '/').endsWith('server/semente.ts')) {
  const empresa = Number(process.argv[2]);
  if (!Number.isInteger(empresa)) {
    console.error('Uso: npx tsx server/semente.ts <empresa_id>');
    process.exit(1);
  }
  // Sem await no topo: o build do servidor sai em CJS
  void (async () => {
    await import('dotenv/config');
    const { transacao, masterPool } = await import('./db.js');
    const r = await transacao((c) => semearEmpresa(c, empresa, null));
    console.log(`Empresa ${empresa}: ${r.criado ? 'cadastros padrão criados' : 'plano de contas já existia'}; ${r.regua ? 'régua padrão criada' : 'régua já existia'}.`);
    await masterPool.end();
  })();
}
