import { Router } from 'express';
import Decimal from 'decimal.js';
import { z } from 'zod';
import { masterPool as pool, transacao, hojeSql } from './db.js';
import { falha, rota } from './http.js';
import type { SessionData } from './session.js';
import { empresaDe, usuarioDe, ehAdmin, auditar, filtroContas, conferirClassificacao, PERMISSOES, type Db } from './comum.js';
import { dataZ, idZ, textoZ, validar } from './titulos.js';
import { semearEmpresa } from './semente.js';

/**
 * Cadastros do financeiro: plano de contas e centros de custo (árvore pelo código 1, 1.1, 1.1.01), contas
 * financeiras, formas de pagamento e parâmetros. Excluir inativa (cadastros com movimento ficam).
 */

const simZ = z.union([z.boolean(), z.number()]).nullish().transform((v) => (v === false || v === 0 ? 0 : 1));
const valorZ = z.union([z.string(), z.number()]).transform(String).refine((v) => /^-?\d{1,13}(\.\d{1,2})?$/.test(v), 'valor inválido');
const pctZ = z.union([z.string(), z.number()]).transform(String).refine((v) => /^\d{1,3}(\.\d{1,4})?$/.test(v) && Number(v) <= 100, 'percentual inválido');
const repetido = (msg: string) => (e: any) => (e?.code === 'ER_DUP_ENTRY' ? falha(msg) : Promise.reject(e));

const soAdmin = (s: SessionData) => (ehAdmin(s) ? undefined : falha('Só administradores alteram este cadastro.', 403));

// ------------------------------------------------------------------ árvores (plano de contas e centros de custo)

function arvore(r: Router, caminho: string, tabela: 'fin_plano_contas' | 'fin_centros_custo') {
  const plano = tabela === 'fin_plano_contas';
  const flag = plano ? 'analitica' : 'analitico';
  const coluna = plano ? 'plano_conta_id' : 'centro_custo_id';
  const nome = plano ? 'Conta' : 'Centro de custo';
  const schema = z.object({
    codigo: z.string().trim().regex(/^\d{1,4}(\.\d{1,4}){0,5}$/, 'use números separados por ponto (ex.: 1.1.01)'),
    descricao: z.string().trim().min(1, 'informe a descrição').max(120),
    tipo: z.enum(['receita', 'despesa', 'transferencia']).nullish(),
    [flag]: simZ,
    ativo: simZ,
  });

  const emUso = async (db: Db, id: number) => {
    const [[u]]: any = await db.query(
      `SELECT (SELECT COUNT(*) FROM fin_receber_titulo_rateios WHERE ${coluna} = ?) + (SELECT COUNT(*) FROM fin_pagar_titulo_rateios WHERE ${coluna} = ?)
            + (SELECT COUNT(*) FROM fin_lancamentos WHERE ${coluna} = ?) AS n`,
      [id, id, id],
    );
    return Number(u.n) > 0;
  };

  r.get(`/${caminho}`, rota(async (_req, _res, s) => {
    const [linhas] = await pool.query(`SELECT * FROM ${tabela} WHERE empresa_id = ? ORDER BY codigo`, [empresaDe(s)]);
    return linhas;
  }));

  r.post(`/${caminho}`, rota(async (req, res, s) => {
    soAdmin(s);
    const d: any = validar(schema, req.body);
    const empresa = empresaDe(s);
    return transacao(async (c) => {
      let pai: any = null;
      if (d.codigo.includes('.')) {
        const codPai = d.codigo.slice(0, d.codigo.lastIndexOf('.'));
        [[pai]] = (await c.query(`SELECT * FROM ${tabela} WHERE empresa_id = ? AND codigo = ? FOR UPDATE`, [empresa, codPai])) as any;
        if (!pai) falha(`Cadastre antes o código ${codPai}.`);
        if (Number(pai[flag])) {
          if (await emUso(c, pai.id)) falha(`${pai.codigo} ${pai.descricao} já tem lançamentos: não pode ganhar subcontas.`);
          await c.query(`UPDATE ${tabela} SET ${flag} = 0 WHERE id = ?`, [pai.id]);
        }
      }
      const tipo = plano ? (pai?.tipo ?? d.tipo ?? falha('Informe o tipo da conta.')) : undefined;
      const [ins]: any = await c.query(`INSERT INTO ${tabela} SET ?`, [{ empresa_id: empresa, codigo: d.codigo, descricao: d.descricao, ...(plano ? { tipo } : {}), pai_id: pai?.id ?? null, [flag]: 1, ativo: d.ativo, usuario_id: usuarioDe(s) }])
        .catch(repetido(`Código ${d.codigo} já cadastrado.`));
      await auditar(c, s, req, tabela, ins.insertId, 'criar', null, d);
      res.status(201);
      return { id: ins.insertId };
    });
  }));

  r.patch(`/${caminho}/:id`, rota(async (req, _res, s) => {
    soAdmin(s);
    const d: any = validar(schema.partial({ codigo: true }), req.body);
    return transacao(async (c) => {
      const [[a]]: any = await c.query(`SELECT * FROM ${tabela} WHERE id = ? AND empresa_id = ? FOR UPDATE`, [req.params.id, empresaDe(s)]);
      if (!a) falha(`${nome} não encontrado(a).`, 404);
      const [[filhos]]: any = await c.query(`SELECT COUNT(*) n FROM ${tabela} WHERE pai_id = ?`, [a.id]);
      if (d[flag] && Number(filhos.n)) falha(`${a.codigo} tem subcontas: continua sintética.`);
      if (!d[flag] && Number(a[flag]) && (await emUso(c, a.id))) falha(`${a.codigo} já tem lançamentos: continua analítica.`);
      const novo = { descricao: d.descricao, [flag]: d[flag], ativo: d.ativo, ...(plano && !a.pai_id && d.tipo ? { tipo: d.tipo } : {}) };
      await c.query(`UPDATE ${tabela} SET ? WHERE id = ?`, [novo, a.id]);
      await auditar(c, s, req, tabela, a.id, 'alterar', a, novo);
    });
  }));

  r.delete(`/${caminho}/:id`, rota(async (req, _res, s) => {
    soAdmin(s);
    const [res]: any = await pool.query(`UPDATE ${tabela} SET ativo = 0 WHERE id = ? AND empresa_id = ?`, [req.params.id, empresaDe(s)]);
    if (!res.affectedRows) falha(`${nome} não encontrado(a).`, 404);
    await auditar(pool, s, req, tabela, Number(req.params.id), 'cancelar', { ativo: 1 }, { ativo: 0 });
  }));
}

// ------------------------------------------------------------------ contas financeiras

const schemaConta = z.object({
  tipo: z.enum(['caixa', 'banco', 'carteira_digital', 'adquirente', 'aplicacao']),
  nome: z.string().trim().min(1, 'informe o nome').max(80),
  ban_conta_id: idZ.nullish(),
  chave_pix: textoZ(77),
  saldo_inicial: valorZ.default('0'),
  data_saldo_inicial: dataZ,
  ativo: simZ,
  usuarios: z.array(idZ).default([]),
});

/** Saldo de cada conta numa data: saldo_inicial + Σ movimentos até a data */
export async function contasComSaldo(s: SessionData, data?: string) {
  const ate = data ?? (await hojeSql(pool));
  const f = await filtroContas(s);
  const [linhas]: any = await pool.query(
    `SELECT cf.*, bc.descricao AS ban_conta_descricao,
            cf.saldo_inicial + COALESCE((SELECT SUM(CASE WHEN m.tipo = 'entrada' THEN m.valor ELSE -m.valor END)
                                           FROM fin_movimentos m WHERE m.conta_financeira_id = cf.id AND m.data <= ?), 0) AS saldo,
            (SELECT GROUP_CONCAT(u.usuario_id) FROM fin_conta_financeira_usuarios u WHERE u.conta_financeira_id = cf.id) AS usuarios
       FROM fin_contas_financeiras cf LEFT JOIN ban_contas bc ON bc.id = cf.ban_conta_id
      WHERE cf.empresa_id = ? AND ${f.sql} ORDER BY cf.ativo DESC, cf.nome`,
    [ate, empresaDe(s), ...f.params],
  );
  return linhas.map((l: any) => ({ ...l, saldo: new Decimal(l.saldo).toFixed(2), usuarios: l.usuarios ? String(l.usuarios).split(',').map(Number) : [] }));
}

async function gravarConta(c: Db, s: SessionData, id: number | null, d: z.output<typeof schemaConta>) {
  const empresa = empresaDe(s);
  if (d.ban_conta_id) {
    const [[b]]: any = await c.query('SELECT id FROM ban_contas WHERE id = ? AND empresa_id = ?', [d.ban_conta_id, empresa]);
    if (!b) falha('Conta do erp-bancos não encontrada nesta empresa.');
  }
  const { usuarios, ...campos } = d;
  const dados = { ...campos, ban_conta_id: d.ban_conta_id ?? null };
  let contaId = id;
  if (id) {
    const [r]: any = await c.query('UPDATE fin_contas_financeiras SET ? WHERE id = ? AND empresa_id = ?', [dados, id, empresa]).catch(repetido('Já existe uma conta com esse nome ou ligada a essa conta bancária.'));
    if (!r.affectedRows) falha('Conta não encontrada.', 404);
  } else {
    const [r]: any = await c.query('INSERT INTO fin_contas_financeiras SET ?', [{ ...dados, empresa_id: empresa, usuario_id: usuarioDe(s) }]).catch(repetido('Já existe uma conta com esse nome ou ligada a essa conta bancária.'));
    contaId = r.insertId;
  }
  await c.query('DELETE FROM fin_conta_financeira_usuarios WHERE conta_financeira_id = ?', [contaId]);
  for (const u of new Set(usuarios)) await c.query('INSERT INTO fin_conta_financeira_usuarios (conta_financeira_id, usuario_id) VALUES (?, ?)', [contaId, u]);
  return contaId!;
}

// ------------------------------------------------------------------ formas de pagamento

const schemaForma = z.object({
  nome: z.string().trim().min(1, 'informe o nome').max(30),
  tipo: z.enum(['dinheiro', 'boleto', 'pix', 'cartao_credito', 'cartao_debito', 'transferencia', 'cheque', 'credito_pessoa', 'outro']),
  conta_financeira_id: idZ.nullish(),
  taxa_pct: pctZ.default('0'),
  taxa_fixa: valorZ.default('0'),
  dias_credito: z.coerce.number().int().min(0).max(999).default(0),
  gera_recebivel_adquirente: simZ.default(0),
  ativo: simZ,
});

// ------------------------------------------------------------------ parâmetros

const contaOpc = idZ.nullish();
const schemaParametros = z.object({
  multa_pct: pctZ, juros_mes_pct: pctZ, carencia_dias: z.coerce.number().int().min(0).max(999),
  desconto_pct: pctZ, desconto_dias: z.coerce.number().int().min(0).max(999),
  modo_imputacao: z.enum(['proporcional', 'encargos_primeiro']),
  valor_aprovacao_pagamento: valorZ.nullish(),
  periodo_fechado_ate: dataZ.nullish(),
  conta_venda_id: contaOpc, conta_compra_id: contaOpc, conta_juros_recebidos_id: contaOpc, conta_multas_recebidas_id: contaOpc,
  conta_juros_pagos_id: contaOpc, conta_multas_pagas_id: contaOpc, conta_desconto_concedido_id: contaOpc, conta_desconto_obtido_id: contaOpc,
  conta_tarifas_bancarias_id: contaOpc, conta_taxas_cartao_id: contaOpc, conta_quebra_caixa_id: contaOpc, conta_antecipacao_id: contaOpc,
  centro_custo_padrao_id: contaOpc, centro_custo_tarifas_id: contaOpc,
});

// ------------------------------------------------------------------ rotas

export function createCadastrosRouter() {
  const r = Router();
  arvore(r, 'plano-contas', 'fin_plano_contas');
  arvore(r, 'centros-custo', 'fin_centros_custo');

  r.get('/contas-financeiras', rota(async (req, _res, s) => contasComSaldo(s, /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.data)) ? String(req.query.data) : undefined)));
  r.post('/contas-financeiras', rota(async (req, res, s) => {
    soAdmin(s);
    const d = validar(schemaConta, req.body);
    const id = await transacao(async (c) => {
      const id = await gravarConta(c, s, null, d);
      await auditar(c, s, req, 'fin_contas_financeiras', id, 'criar', null, d);
      return id;
    });
    res.status(201);
    return { id };
  }));
  r.patch('/contas-financeiras/:id', rota(async (req, _res, s) => {
    soAdmin(s);
    const d = validar(schemaConta, req.body);
    await transacao(async (c) => {
      const [[a]]: any = await c.query('SELECT * FROM fin_contas_financeiras WHERE id = ? AND empresa_id = ? FOR UPDATE', [req.params.id, empresaDe(s)]);
      if (!a) falha('Conta não encontrada.', 404);
      await gravarConta(c, s, a.id, d);
      await auditar(c, s, req, 'fin_contas_financeiras', a.id, 'alterar', a, d);
    });
  }));
  r.delete('/contas-financeiras/:id', rota(async (req, _res, s) => {
    soAdmin(s);
    const [res]: any = await pool.query('UPDATE fin_contas_financeiras SET ativo = 0 WHERE id = ? AND empresa_id = ?', [req.params.id, empresaDe(s)]);
    if (!res.affectedRows) falha('Conta não encontrada.', 404);
    await auditar(pool, s, req, 'fin_contas_financeiras', Number(req.params.id), 'cancelar', { ativo: 1 }, { ativo: 0 });
  }));

  // Contas bancárias do erp-bancos (só leitura) e usuários da empresa, para o cadastro das contas financeiras
  r.get('/ban-contas', rota(async (_req, _res, s) => {
    const [l] = await pool.query("SELECT id, descricao, banco_codigo, agencia, conta, conta_dv FROM ban_contas WHERE empresa_id = ? AND ativo = 1 ORDER BY descricao", [empresaDe(s)]);
    return l;
  }));
  r.get('/usuarios', rota(async (_req, _res, s) => {
    const [l] = await pool.query(
      `SELECT DISTINCT u.id, u.login FROM sys_usuarios u LEFT JOIN sys_usuarios_empresas ue ON ue.usuario_id = u.id
        WHERE u.ativo = 1 AND (ue.empresa_id = ? OR u.empresa_id = ?) ORDER BY u.login`,
      [empresaDe(s), empresaDe(s)],
    );
    return l;
  }));

  r.get('/formas-pagamento', rota(async (_req, _res, s) => {
    const [l] = await pool.query('SELECT f.*, cf.nome AS conta_nome FROM fin_formas_pagamento f LEFT JOIN fin_contas_financeiras cf ON cf.id = f.conta_financeira_id WHERE f.empresa_id = ? ORDER BY f.ativo DESC, f.nome', [empresaDe(s)]);
    return l;
  }));
  r.post('/formas-pagamento', rota(async (req, res, s) => {
    soAdmin(s);
    const d = validar(schemaForma, req.body);
    const [ins]: any = await pool.query('INSERT INTO fin_formas_pagamento SET ?', [{ ...d, conta_financeira_id: d.conta_financeira_id ?? null, empresa_id: empresaDe(s), usuario_id: usuarioDe(s) }]).catch(repetido('Já existe uma forma com esse nome.'));
    await auditar(pool, s, req, 'fin_formas_pagamento', ins.insertId, 'criar', null, d);
    res.status(201);
    return { id: ins.insertId };
  }));
  r.patch('/formas-pagamento/:id', rota(async (req, _res, s) => {
    soAdmin(s);
    const d = validar(schemaForma, req.body);
    const [res]: any = await pool.query('UPDATE fin_formas_pagamento SET ? WHERE id = ? AND empresa_id = ?', [{ ...d, conta_financeira_id: d.conta_financeira_id ?? null }, req.params.id, empresaDe(s)]).catch(repetido('Já existe uma forma com esse nome.'));
    if (!res.affectedRows) falha('Forma não encontrada.', 404);
    await auditar(pool, s, req, 'fin_formas_pagamento', Number(req.params.id), 'alterar', null, d);
  }));
  r.delete('/formas-pagamento/:id', rota(async (req, _res, s) => {
    soAdmin(s);
    const [res]: any = await pool.query('UPDATE fin_formas_pagamento SET ativo = 0 WHERE id = ? AND empresa_id = ?', [req.params.id, empresaDe(s)]);
    if (!res.affectedRows) falha('Forma não encontrada.', 404);
  }));

  r.get('/parametros', rota(async (_req, _res, s) => {
    const empresa = empresaDe(s);
    const [[p]]: any = await pool.query('SELECT * FROM fin_parametros WHERE empresa_id = ?', [empresa]);
    const [[n]]: any = await pool.query('SELECT (SELECT COUNT(*) FROM fin_plano_contas WHERE empresa_id = ?) plano, (SELECT COUNT(*) FROM fin_templates WHERE empresa_id = ?) modelos', [empresa, empresa]);
    return { parametros: p ?? null, semPlano: !Number(n.plano), semRegua: !Number(n.modelos), admin: ehAdmin(s) };
  }));
  r.put('/parametros', rota(async (req, _res, s) => {
    soAdmin(s);
    const d = validar(schemaParametros, req.body);
    const empresa = empresaDe(s);
    await transacao(async (c) => {
      // Contas padrão: analíticas e ativas; o centro só entra na conferência junto com uma conta
      const centro = d.centro_custo_padrao_id;
      for (const [k, v] of Object.entries(d)) {
        if (k.startsWith('conta_') && v && centro) await conferirClassificacao(c, empresa, Number(v), centro);
      }
      if (d.centro_custo_tarifas_id && d.conta_tarifas_bancarias_id) await conferirClassificacao(c, empresa, d.conta_tarifas_bancarias_id, d.centro_custo_tarifas_id);
      const [[a]]: any = await c.query('SELECT * FROM fin_parametros WHERE empresa_id = ? FOR UPDATE', [empresa]);
      const dados = { ...d, valor_aprovacao_pagamento: d.valor_aprovacao_pagamento ?? null, periodo_fechado_ate: d.periodo_fechado_ate ?? null, usuario_id: usuarioDe(s) };
      await c.query('INSERT INTO fin_parametros SET ? ON DUPLICATE KEY UPDATE ?', [{ ...dados, empresa_id: empresa }, dados]);
      await auditar(c, s, req, 'fin_parametros', empresa, 'alterar', a ?? null, dados);
    });
  }));
  r.post('/parametros/semear', rota(async (_req, _res, s) => {
    soAdmin(s);
    return transacao((c) => semearEmpresa(c, empresaDe(s), usuarioDe(s)));
  }));

  // Permissões do financeiro por perfil (os perfis são do Master: sys_perfis). Coluna marcada = a da ação (aprovar, criar…)
  r.get('/permissoes', rota(async (_req, _res, s) => {
    const [perfis]: any = await pool.query('SELECT p.id, p.nome, (SELECT COUNT(*) FROM sys_usuarios u WHERE u.perfil_id = p.id) AS usuarios FROM sys_perfis p ORDER BY p.nome');
    const [marcadas]: any = await pool.query(
      `SELECT pp.perfil_id, p.recurso, p.acao FROM sys_perfil_permissao pp JOIN sys_permissoes p ON p.id = pp.permissao_id
        WHERE p.modulo = 'FIN' AND ((p.acao = 'VISUALIZAR' AND pp.visualizar = 1) OR (p.acao = 'CRIAR' AND pp.criar = 1) OR (p.acao = 'EDITAR' AND pp.editar = 1)
              OR (p.acao = 'EXCLUIR' AND pp.excluir = 1) OR (p.acao = 'APROVAR' AND pp.aprovar = 1))`,
    );
    const chave = (recurso: string, acao: string) => Object.entries(PERMISSOES).find(([, p]) => p.recurso === recurso && p.acao === acao)?.[0];
    return {
      admin: ehAdmin(s),
      itens: Object.entries(PERMISSOES).map(([k, p]) => ({ chave: k, nome: p.nome })),
      perfis: perfis.map((p: any) => ({ ...p, chaves: marcadas.filter((m: any) => Number(m.perfil_id) === Number(p.id)).map((m: any) => chave(m.recurso, m.acao)).filter(Boolean) })),
    };
  }));
  r.put('/permissoes/:perfil', rota(async (req, _res, s) => {
    soAdmin(s);
    const d = validar(z.object({ chaves: z.array(z.enum(Object.keys(PERMISSOES) as [keyof typeof PERMISSOES])) }), req.body);
    const perfil = Number(req.params.perfil);
    await transacao(async (c) => {
      const [[p]]: any = await c.query('SELECT id, nome FROM sys_perfis WHERE id = ?', [perfil]);
      if (!p) falha('Perfil não encontrado.', 404);
      const antes: string[] = [];
      for (const [k, x] of Object.entries(PERMISSOES)) {
        await c.query("INSERT IGNORE INTO sys_permissoes (modulo, recurso, acao) VALUES ('FIN', ?, ?)", [x.recurso, x.acao]);
        const [[perm]]: any = await c.query("SELECT id FROM sys_permissoes WHERE modulo = 'FIN' AND recurso = ? AND acao = ?", [x.recurso, x.acao]);
        const col = x.acao.toLowerCase();
        const [[atual]]: any = await c.query(`SELECT ${col} AS v FROM sys_perfil_permissao WHERE perfil_id = ? AND permissao_id = ?`, [perfil, perm.id]);
        if (Number(atual?.v)) antes.push(k);
        const v = d.chaves.includes(k as keyof typeof PERMISSOES) ? 1 : 0;
        await c.query(`INSERT INTO sys_perfil_permissao (perfil_id, permissao_id, ${col}) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE ${col} = VALUES(${col})`, [perfil, perm.id, v]);
      }
      await auditar(c, s, req, 'sys_perfil_permissao', perfil, 'alterar', { perfil: p.nome, chaves: antes }, { perfil: p.nome, chaves: d.chaves });
    });
  }));

  return r;
}
