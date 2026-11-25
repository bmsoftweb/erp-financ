import { Router, type Request } from 'express';
import Decimal from 'decimal.js';
import { z } from 'zod';
import { masterPool as pool, transacao } from './db.js';
import { falha, rota, idOuNull } from './http.js';
import type { SessionData } from './session.js';
import { empresaDe, usuarioDe, exigir, contaDoUsuario, conferirClassificacao, auditar, ladoDe, type Db } from './comum.js';
import { idZ, textoZ, validar } from './titulos.js';
import { baixar } from './baixas.js';
import { lancarDireto, MOV_PESSOA, saldoEm } from './caixa.js';
import { marcarExtrato } from './bancos.js';
import { parear, sugerir, type RegraConc } from './sugestoes.js';

/**
 * Conciliação bancária. O extrato (OFX) é importado no erp-bancos (ban_extratos / ban_extrato_lancamentos); aqui só se
 * LÊ a linha pendente da ban_conta_id ligada à conta financeira, grava os pares em fin_conciliacoes (N:N) e muda a
 * situação da linha pelo serviço do erp-bancos. Desfazer marca desfeita_em e não mexe na baixa.
 */

async function contaConciliavel(db: Db, s: SessionData, id: number) {
  const conta = await contaDoUsuario(db, s, id);
  if (!conta.ban_conta_id) falha(`"${conta.nome}" não está ligada a uma conta do BMBancos (Cadastros › Contas financeiras).`);
  return conta;
}

/** Linhas do extrato ainda pendentes, sem par ativo aqui */
async function linhasExtrato(db: Db, empresa: number, banConta: number, ids?: number[]) {
  const [l]: any = await db.query(
    `SELECT e.id, DATE_FORMAT(e.data_lancamento, '%Y-%m-%d') AS data, e.valor, e.tipo, e.documento, e.historico, e.fitid
       FROM ban_extrato_lancamentos e
      WHERE e.empresa_id = ? AND e.conta_id = ? AND e.situacao = 'pendente' ${ids ? 'AND e.id IN (?)' : ''}
        AND NOT EXISTS (SELECT 1 FROM fin_conciliacoes x WHERE x.extrato_lancamento_id = e.id AND x.desfeita_em IS NULL)
      ORDER BY e.data_lancamento, e.id`,
    [empresa, banConta, ...(ids ? [ids] : [])],
  );
  return l.map((x: any) => ({ ...x, valor: new Decimal(x.valor).toFixed(2) }));
}

/** Movimentos sem conciliação. Movimento estornado e o estorno dele se anulam e ficam de fora. */
async function movimentosLivres(db: Db, contaId: number, ids?: number[], travar = false) {
  const [l]: any = await db.query(
    `SELECT m.id, DATE_FORMAT(m.data, '%Y-%m-%d') AS data, IF(m.tipo = 'entrada', m.valor, -m.valor) AS valor, m.documento, m.historico, m.origem,
            pe.id AS pessoa_id, pe.nome AS pessoa_nome, pe.cpf_cnpj
       FROM fin_movimentos m ${MOV_PESSOA}
      WHERE m.conta_financeira_id = ? AND m.conciliado_em IS NULL AND m.estorno_de_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM fin_movimentos e WHERE e.estorno_de_id = m.id) ${ids ? 'AND m.id IN (?)' : ''}
      ORDER BY m.data, m.id ${travar ? 'FOR UPDATE' : ''}`,
    [contaId, ...(ids ? [ids] : [])],
  );
  return l.map((x: any) => ({ ...x, valor: new Decimal(x.valor).toFixed(2), cpf_cnpj: x.cpf_cnpj ? String(x.cpf_cnpj).replace(/\D/g, '') : null, pessoa_id: x.pessoa_id ? Number(x.pessoa_id) : null }));
}

async function regrasDaConta(db: Db, empresa: number, contaId: number): Promise<RegraConc[]> {
  const [l]: any = await db.query(
    'SELECT * FROM fin_regras_conciliacao WHERE empresa_id = ? AND ativo = 1 AND (conta_financeira_id IS NULL OR conta_financeira_id = ?) ORDER BY prioridade, id',
    [empresa, contaId],
  );
  return l.map((r: any) => ({ ...r, pessoa_id: r.pessoa_id ? Number(r.pessoa_id) : null, plano_conta_id: r.plano_conta_id ? Number(r.plano_conta_id) : null, centro_custo_id: r.centro_custo_id ? Number(r.centro_custo_id) : null }));
}

const schemaItem = z.object({ extrato: z.array(idZ).min(1).max(200), movimentos: z.array(idZ).min(1).max(500), regra_id: idZ.nullish(), automatica: z.boolean().nullish() });
type Item = z.output<typeof schemaItem>;

/** Grava os pares de um item (linhas × movimentos) e marca os movimentos; a linha no erp-bancos é marcada depois */
async function gravarPares(c: Db, s: SessionData, req: Request | null, conta: any, item: Item) {
  const empresa = empresaDe(s);
  const ext = [...new Set(item.extrato)];
  const mov = [...new Set(item.movimentos)];
  const linhas = await linhasExtrato(c, empresa, conta.ban_conta_id, ext);
  if (linhas.length !== ext.length) falha('Linha do extrato não encontrada, de outra conta ou já conciliada.', 409);
  const movs = await movimentosLivres(c, conta.id, mov, true);
  if (movs.length !== mov.length) falha('Movimento não encontrado, de outra conta, estornado ou já conciliado.', 409);
  if (item.regra_id) {
    const [[r]]: any = await c.query('SELECT id FROM fin_regras_conciliacao WHERE id = ? AND empresa_id = ?', [item.regra_id, empresa]);
    if (!r) falha('Regra de conciliação não encontrada.');
  }
  let pares;
  try {
    pares = parear(linhas, movs);
  } catch (e: any) {
    return falha(e.message);
  }
  for (const p of pares) {
    await c.query('INSERT INTO fin_conciliacoes SET ?', [{
      empresa_id: empresa, extrato_lancamento_id: p.extrato, movimento_id: p.movimento, valor: p.valor, regra_id: item.regra_id ?? null, automatica: item.automatica ? 1 : 0, usuario_id: usuarioDe(s),
    }]);
  }
  await c.query('UPDATE fin_movimentos SET conciliado_em = NOW(), conciliado_por = ? WHERE id IN (?)', [usuarioDe(s), mov]);
  await auditar(c, s, req, 'fin_conciliacoes', ext[0], 'conciliar', null, { conta_financeira_id: conta.id, ...item });
  return ext.map((id) => ({ id, referencia: `FIN-MOV ${mov.join(',')}`.slice(0, 80) }));
}

/**
 * Marca as linhas no erp-bancos depois de gravar aqui (ainda dentro da transação): se o erp-bancos recusar uma, as que
 * já foram marcadas voltam e a transação daqui é desfeita.
 */
async function marcarNoBancos(s: SessionData, linhas: { id: number; referencia: string }[]) {
  const feitas: number[] = [];
  try {
    for (const l of linhas) {
      await marcarExtrato(s, l.id, 'conciliar', l.referencia);
      feitas.push(l.id);
    }
  } catch (e) {
    for (const id of feitas) await marcarExtrato(s, id, 'desfazer').catch((x) => console.error(`Conciliação: não desfez a linha ${id} no BMBancos: ${x.message}`));
    throw e;
  }
}

/** Uma linha do extrato e os movimentos/linhas que estão no mesmo grupo de pares ativos */
async function grupoAtivo(c: Db, empresa: number, extratoId: number) {
  let ext = new Set([extratoId]);
  let mov = new Set<number>();
  for (let i = 0; i < 10; i++) {
    const [l]: any = await c.query(
      `SELECT id, extrato_lancamento_id, movimento_id FROM fin_conciliacoes WHERE empresa_id = ? AND desfeita_em IS NULL AND (extrato_lancamento_id IN (?) OR movimento_id IN (?)) FOR UPDATE`,
      [empresa, [...ext], [...mov, 0]],
    );
    const e2 = new Set<number>(l.map((x: any) => Number(x.extrato_lancamento_id)));
    const m2 = new Set<number>(l.map((x: any) => Number(x.movimento_id)));
    if (e2.size === ext.size && m2.size === mov.size) return { linhas: l, ext: [...ext], mov: [...mov] };
    ext = new Set([...ext, ...e2]);
    mov = m2;
  }
  return falha('Conciliação com grupo grande demais para desfazer de uma vez.');
}

const schemaRegra = z.object({
  conta_financeira_id: idZ.nullish(),
  nome: z.string().trim().min(1, 'informe o nome').max(80),
  campo: z.enum(['historico', 'documento', 'valor']),
  operador: z.enum(['contem', 'igual', 'comeca_com', 'regex', 'entre']),
  texto: z.string().trim().min(1, 'informe o texto').max(255),
  sentido: z.enum(['entrada', 'saida', 'ambos']),
  plano_conta_id: idZ.nullish(),
  centro_custo_id: idZ.nullish(),
  pessoa_id: idZ.nullish(),
  prioridade: z.coerce.number().int().min(0).max(9999),
  ativo: z.union([z.boolean(), z.number()]).transform((v) => (v ? 1 : 0)),
});

async function conferirRegra(c: Db, s: SessionData, d: z.output<typeof schemaRegra>) {
  const empresa = empresaDe(s);
  if (!!d.plano_conta_id !== !!d.centro_custo_id) falha('Informe a conta do plano e o centro de custo juntos.');
  if (!d.plano_conta_id && !d.pessoa_id) falha('A regra precisa de conta do plano e centro (lançamento direto) ou de uma pessoa.');
  if (d.plano_conta_id) await conferirClassificacao(c, empresa, d.plano_conta_id, d.centro_custo_id!);
  if (d.conta_financeira_id) await contaDoUsuario(c, s, d.conta_financeira_id);
  if (d.operador === 'regex') {
    try { new RegExp(d.texto); } catch { falha('Expressão regular inválida.'); }
  }
  if (d.operador === 'entre' && (d.campo !== 'valor' || !d.texto.includes(';'))) falha('No operador "entre", use o campo valor e o texto "mínimo;máximo".');
  return { ...d, conta_financeira_id: d.conta_financeira_id ?? null, plano_conta_id: d.plano_conta_id ?? null, centro_custo_id: d.centro_custo_id ?? null, pessoa_id: d.pessoa_id ?? null };
}

export function createConciliacaoRouter() {
  const r = Router();

  /** Extrato pendente (esquerda), movimentos sem par (direita) e as sugestões; saldo do sistema × saldo do último extrato */
  r.get('/conciliacao/pendentes', rota(async (req, _res, s) => {
    const empresa = empresaDe(s);
    const conta = await contaConciliavel(pool, s, Number(req.query.conta));
    const [extrato, movimentos, regras] = await Promise.all([linhasExtrato(pool, empresa, conta.ban_conta_id), movimentosLivres(pool, conta.id), regrasDaConta(pool, empresa, conta.id)]);
    const [[ult]]: any = await pool.query(
      "SELECT saldo, DATE_FORMAT(COALESCE(data_saldo, data_final), '%Y-%m-%d') AS data FROM ban_extratos WHERE empresa_id = ? AND conta_id = ? AND saldo IS NOT NULL ORDER BY data_final DESC, id DESC LIMIT 1",
      [empresa, conta.ban_conta_id],
    );
    const saldo = ult ? { data: ult.data, extrato: new Decimal(ult.saldo).toFixed(2), sistema: (await saldoEm(pool, conta.id, ult.data)).toFixed(2) } : null;
    return { conta: { id: conta.id, nome: conta.nome }, extrato, movimentos, sugestoes: sugerir(extrato, movimentos, regras), saldo };
  }));

  /** Pares ativos da conta (para desfazer) */
  r.get('/conciliacoes', rota(async (req, _res, s) => {
    const conta = await contaConciliavel(pool, s, Number(req.query.conta));
    const [l]: any = await pool.query(
      `SELECT x.extrato_lancamento_id AS id, DATE_FORMAT(e.data_lancamento, '%Y-%m-%d') AS data, e.valor, e.historico, e.documento,
              GROUP_CONCAT(x.movimento_id ORDER BY x.movimento_id) AS movimentos, MAX(x.automatica) AS automatica, MAX(rg.nome) AS regra,
              MAX(x.criado_em) AS conciliado_em, MAX(u.login) AS usuario_login
         FROM fin_conciliacoes x JOIN ban_extrato_lancamentos e ON e.id = x.extrato_lancamento_id
         LEFT JOIN fin_regras_conciliacao rg ON rg.id = x.regra_id LEFT JOIN sys_usuarios u ON u.id = x.usuario_id
        WHERE x.empresa_id = ? AND x.desfeita_em IS NULL AND e.conta_id = ?
        GROUP BY x.extrato_lancamento_id, e.data_lancamento, e.valor, e.historico, e.documento
        ORDER BY e.data_lancamento DESC, x.extrato_lancamento_id DESC LIMIT 1000`,
      [empresaDe(s), conta.ban_conta_id],
    );
    return l;
  }));

  /** Confirmação (uma ou em lote): { conta_financeira_id, itens: [{ extrato: [ids], movimentos: [ids], regra_id?, automatica? }] } */
  r.post('/conciliacoes', rota(async (req, res, s) => {
    const d = validar(z.object({ conta_financeira_id: idZ, itens: z.array(schemaItem).min(1).max(500) }), req.body);
    const n = await transacao(async (c) => {
      await exigir(s, 'conciliar');
      const conta = await contaConciliavel(c, s, d.conta_financeira_id);
      const linhas = [];
      for (const item of d.itens) linhas.push(...(await gravarPares(c, s, req, conta, item)));
      await marcarNoBancos(s, linhas);
      return linhas.length;
    });
    res.status(201);
    return { conciliadas: n };
  }));

  /**
   * Linha sem par: vira lançamento direto ({ acao: 'direto', plano_conta_id, centro_custo_id, historico? }) ou baixa de
   * uma parcela, inclusive parcial ({ acao: 'baixa', lado, parcela_id }), e já fica conciliada com o movimento novo.
   */
  r.post('/conciliacoes/sem-par', rota(async (req, res, s) => {
    const d = validar(z.object({
      conta_financeira_id: idZ, extrato_id: idZ, acao: z.enum(['direto', 'baixa']), regra_id: idZ.nullish(),
      plano_conta_id: idZ.nullish(), centro_custo_id: idZ.nullish(), historico: textoZ(255), lado: z.string().nullish(), parcela_id: idZ.nullish(),
    }), req.body);
    const out = await transacao(async (c) => {
      await exigir(s, 'conciliar');
      const conta = await contaConciliavel(c, s, d.conta_financeira_id);
      const [e] = await linhasExtrato(c, empresaDe(s), conta.ban_conta_id, [d.extrato_id]);
      if (!e) falha('Linha do extrato não encontrada ou já conciliada.', 409);
      const valor = new Decimal(e.valor);
      let movimento: number | null;
      if (d.acao === 'direto') {
        movimento = await lancarDireto(c, s, req, {
          conta_financeira_id: conta.id, data: e.data, tipo: valor.gt(0) ? 'entrada' : 'saida', valor: valor.abs().toFixed(2),
          historico: (d.historico ?? e.historico ?? 'Lançamento do extrato').slice(0, 255), documento: e.documento ? String(e.documento).slice(0, 60) : null,
          plano_conta_id: d.plano_conta_id ?? falha('Informe a conta do plano.'), centro_custo_id: d.centro_custo_id ?? falha('Informe o centro de custo.'),
        });
      } else {
        const lado = ladoDe(d.lado);
        if ((lado === 'receber') !== valor.gt(0)) falha(lado === 'receber' ? 'Linha de saída não baixa conta a receber.' : 'Linha de entrada não baixa conta a pagar.');
        const r = await baixar(c, s, req, lado, d.parcela_id ?? falha('Escolha a parcela.'), {
          data_pagamento: e.data, data_conta: e.data, conta_financeira_id: conta.id, forma_pagamento_id: null, valor_pago: valor.abs().toFixed(2), principal: null,
          valor_tarifa: null, dispensa: null, motivo_dispensa: null, multa_informada: null, juros_informados: null, usar_credito: false,
          observacoes: `Extrato: ${e.historico ?? ''}`.slice(0, 5000),
        });
        movimento = r.movimentoId;
      }
      if (!movimento) return falha('A operação não gerou movimento para conciliar.');
      const linhas = await gravarPares(c, s, req, conta, { extrato: [e.id], movimentos: [movimento], regra_id: d.regra_id ?? null, automatica: false });
      await marcarNoBancos(s, linhas);
      return { movimento_id: movimento };
    });
    res.status(201);
    return out;
  }));

  /** Desfaz a conciliação da linha (e das que dividem movimento com ela): desfeita_em; baixa e movimento ficam */
  r.post('/conciliacoes/desfazer', rota(async (req, _res, s) => {
    const extratoId = idOuNull(req.body?.extrato_id) ?? falha('Informe a linha do extrato.');
    return transacao(async (c) => {
      await exigir(s, 'conciliar');
      const empresa = empresaDe(s);
      const g = await grupoAtivo(c, empresa, extratoId);
      if (!g.linhas.length) falha('Linha sem conciliação ativa.');
      const [movs]: any = await c.query('SELECT DISTINCT conta_financeira_id FROM fin_movimentos WHERE id IN (?)', [g.mov]);
      for (const m of movs) await contaDoUsuario(c, s, m.conta_financeira_id);
      await c.query('UPDATE fin_conciliacoes SET desfeita_em = NOW(), desfeita_por = ? WHERE id IN (?)', [usuarioDe(s), g.linhas.map((l: any) => l.id)]);
      await c.query('UPDATE fin_movimentos SET conciliado_em = NULL, conciliado_por = NULL WHERE id IN (?)', [g.mov]);
      await auditar(c, s, req, 'fin_conciliacoes', extratoId, 'desfazer', { extrato: g.ext, movimentos: g.mov }, null);
      const feitas: number[] = [];
      try {
        for (const id of g.ext) {
          await marcarExtrato(s, id, 'desfazer');
          feitas.push(id);
        }
      } catch (e) {
        for (const id of feitas) await marcarExtrato(s, id, 'conciliar', `FIN-MOV ${g.mov.join(',')}`.slice(0, 80)).catch(() => {});
        throw e;
      }
      return { extrato: g.ext, movimentos: g.mov };
    });
  }));

  // ---------------------------------------------------------------- regras

  r.get('/regras-conciliacao', rota(async (_req, _res, s) => {
    const [l]: any = await pool.query(
      `SELECT r.*, cf.nome AS conta_nome, CONCAT(pc.codigo, ' ', pc.descricao) AS plano_nome, CONCAT(cc.codigo, ' ', cc.descricao) AS centro_nome, pe.nome AS pessoa_nome
         FROM fin_regras_conciliacao r LEFT JOIN fin_contas_financeiras cf ON cf.id = r.conta_financeira_id
         LEFT JOIN fin_plano_contas pc ON pc.id = r.plano_conta_id LEFT JOIN fin_centros_custo cc ON cc.id = r.centro_custo_id LEFT JOIN cad_pessoas pe ON pe.id = r.pessoa_id
        WHERE r.empresa_id = ? ORDER BY r.ativo DESC, r.prioridade, r.id`,
      [empresaDe(s)],
    );
    return l;
  }));

  r.post('/regras-conciliacao', rota(async (req, res, s) => {
    const d = validar(schemaRegra, req.body);
    const id = await transacao(async (c) => {
      await exigir(s, 'conciliar');
      const dados = await conferirRegra(c, s, d);
      const [i]: any = await c.query('INSERT INTO fin_regras_conciliacao SET ?', [{ ...dados, empresa_id: empresaDe(s), usuario_id: usuarioDe(s) }]);
      await auditar(c, s, req, 'fin_regras_conciliacao', i.insertId, 'criar', null, dados);
      return Number(i.insertId);
    });
    res.status(201);
    return { id };
  }));

  r.patch('/regras-conciliacao/:id', rota(async (req, _res, s) => {
    const d = validar(schemaRegra, req.body);
    await transacao(async (c) => {
      await exigir(s, 'conciliar');
      const [[antes]]: any = await c.query('SELECT * FROM fin_regras_conciliacao WHERE id = ? AND empresa_id = ?', [req.params.id, empresaDe(s)]);
      if (!antes) falha('Regra não encontrada.', 404);
      const dados = await conferirRegra(c, s, d);
      await c.query('UPDATE fin_regras_conciliacao SET ? WHERE id = ?', [dados, antes.id]);
      await auditar(c, s, req, 'fin_regras_conciliacao', antes.id, 'editar', antes, dados);
    });
  }));

  r.delete('/regras-conciliacao/:id', rota(async (req, _res, s) => {
    await transacao(async (c) => {
      await exigir(s, 'conciliar');
      const [[antes]]: any = await c.query('SELECT * FROM fin_regras_conciliacao WHERE id = ? AND empresa_id = ?', [req.params.id, empresaDe(s)]);
      if (!antes) falha('Regra não encontrada.', 404);
      await c.query('DELETE FROM fin_regras_conciliacao WHERE id = ?', [antes.id]);
      await auditar(c, s, req, 'fin_regras_conciliacao', antes.id, 'excluir', antes, null);
    });
  }));

  return r;
}

