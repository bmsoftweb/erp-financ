import crypto from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { masterPool as pool, hojeSql } from './db.js';
import { falha, iguais, rota, rotaModulo, rotaPublica } from './http.js';
import type { SessionData } from './session.js';
import { auditar, empresaDe, exigir, pessoaDaEmpresa, usuarioDe, type Db } from './comum.js';
import { totalDoDia } from './calculo.js';
import { bancosBruto } from './bancos.js';
import { validar, textoZ, sincronizarOrigens } from './titulos.js';
import { processarFila } from './recebimento.js';
import { enviadorDe, ErroProvedor } from './enviador.js';
import { dentroDoHorario, renderizar, telefoneWhatsApp, variaveisDesconhecidas, variaveisDoGrupo, variaveisUsadas, type ParcelaMensagem, type Variaveis } from './mensagens.js';

/**
 * Fase 4: régua de cobrança (só receber).
 *  1. rodarRegua: para cada etapa ativa, as parcelas que caem na janela dela viram fin_cobranca_envios 'pendente'
 *     (INSERT IGNORE + único (parcela, etapa, canal): a mesma etapa nunca sai duas vezes).
 *  2. enviarPendentes: agrupa por cliente/etapa/canal/vencimento, monta o texto com as variáveis e envia pelo
 *     EnviadorMensagem. Parcela que deixou de estar em aberto tem o envio cancelado antes de sair.
 * Agendador: GET /api/financ/cron/cobranca (Vercel Cron, Bearer CRON_SECRET) a cada 15 min; a régua só roda em
 * horário comercial, a fila de eventos do BMBancos roda sempre.
 */

type Canal = 'whatsapp' | 'email';
const sistema = (empresa: number): SessionData => ({ isLoggedIn: true, empresaId: empresa, userName: 'cobranca', role: 'sistema' });
const agoraBrasilia = async () => {
  const [[r]]: any = await pool.query("SELECT DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i') AS agora");
  return String(r.agora);
};

// Título que não é cobrado: provisório e o recebível do adquirente de cartão
const TITULO_COBRAVEL = "t.provisorio = 0 AND t.origem <> 'cartao_adquirente'";

// ------------------------------------------------------------------ dados da mensagem

/** Link público do boleto (PDF), assinado; vazio sem FINANC_URL_PUBLICA */
const assinaturaLink = (parcela: number) => crypto.createHmac('sha256', process.env.SESSION_SECRET!).update(`boleto:${parcela}`).digest('hex').slice(0, 32);
const linkBoleto = (parcela: number) => {
  const base = (process.env.FINANC_URL_PUBLICA || '').replace(/\/+$/, '');
  return base ? `${base}/api/financ/publico/boleto/${parcela}.${assinaturaLink(parcela)}` : '';
};

/** Parcelas com tudo o que as variáveis pedem: valor atualizado (mesma função da baixa), boleto e Pix ativos */
async function parcelasMensagem(db: Db, ids: number[], hoje: string): Promise<Map<number, ParcelaMensagem & { status: string }>> {
  if (!ids.length) return new Map();
  const [l]: any = await db.query(
    `SELECT p.*, t.numero_documento, pe.nome,
            b.linha_digitavel, b.pix_emv AS boleto_pix, v.id AS vinculo_id,
            (SELECT x.pix_emv FROM fin_pix_cobrancas x WHERE x.parcela_id = p.id AND x.status = 'ativa' AND x.expira_em > NOW() ORDER BY x.id DESC LIMIT 1) AS pix_emv
       FROM fin_receber_parcelas p JOIN fin_receber_titulos t ON t.id = p.titulo_id JOIN cad_pessoas pe ON pe.id = t.pessoa_id
       LEFT JOIN fin_receber_parcela_boletos v ON v.parcela_id = p.id AND v.ativo = 1
       LEFT JOIN ban_boletos b ON b.id = v.boleto_id
      WHERE p.id IN (?)`,
    [ids],
  );
  return new Map(l.map((p: any) => {
    const base = Number(p.manter_encargos_original) ? p.vencimento_original : p.vencimento;
    const aberta = p.status === 'aberta' || p.status === 'parcial';
    return [Number(p.id), {
      status: p.status,
      nome: p.nome, documento: p.numero_documento || p.documento || `Título ${p.titulo_id}`, numero: p.numero, total_parcelas: p.total_parcelas,
      vencimento: String(p.vencimento).slice(0, 10), valor_original: p.valor_original,
      valor_atualizado: aberta
        ? totalDoDia({ saldo: p.saldo, vencimento: String(base).slice(0, 10), dataPagamento: hoje, carenciaDias: p.carencia_dias, multaPct: p.multa_pct, jurosMesPct: p.juros_mes_pct, descontoPct: p.desconto_pct, descontoAte: p.desconto_ate })
        : p.saldo,
      linha_digitavel: aberta ? p.linha_digitavel : null,
      pix_copia_cola: aberta ? p.pix_emv || p.boleto_pix : null,
      link: aberta && p.vinculo_id ? linkBoleto(Number(p.id)) : null,
    }];
  }));
}

function montar(t: { canal: Canal; assunto: string | null; corpo: string; template_whatsapp: string | null; idioma: string }, v: Variaveis) {
  return {
    assunto: t.assunto ? renderizar(t.assunto, v) : null,
    texto: renderizar(t.corpo, v),
    modelo: t.canal === 'whatsapp' && t.template_whatsapp
      ? { nome: t.template_whatsapp, idioma: t.idioma || 'pt_BR', parametros: variaveisUsadas(t.corpo).map((nome) => ({ nome, valor: (v as any)[nome] ?? '' })) }
      : null,
  };
}

// ------------------------------------------------------------------ régua

/**
 * Janela de cada etapa, em dias desde o vencimento (emissão: desde a criação; pagamento: desde a baixa que quitou).
 * Começa no dia da etapa e tolera 3 dias (fim de semana e feriado sem job); antes do vencimento nunca passa do
 * dia −1 e o "vence hoje" (0) só sai no próprio dia, para a mensagem não mentir.
 */
const janela = (evento: string, dias: number): [number, number] =>
  evento === 'vencimento' && dias < 0 ? [dias, Math.min(dias + 3, -1)] : evento === 'vencimento' && dias === 0 ? [0, 0] : [dias, dias + 3];

export async function rodarRegua(empresa: number) {
  const hoje = await hojeSql(pool);
  // Parou de valer: quitada, cancelada ou renegociada (o recibo é o único que sai de parcela quitada)
  const [canc]: any = await pool.query(
    `UPDATE fin_cobranca_envios e JOIN fin_receber_parcelas p ON p.id = e.parcela_id LEFT JOIN fin_regua_etapas r ON r.id = e.etapa_id
        SET e.status = 'cancelado', e.erro = CONCAT('Parcela ', p.status), e.status_em = NOW()
      WHERE e.empresa_id = ? AND e.status = 'pendente'
        AND IF(r.evento = 'pagamento', p.status <> 'quitada', p.status NOT IN ('aberta','parcial'))`,
    [empresa],
  );
  const [etapas]: any = await pool.query(
    `SELECT r.*, m.ativo AS modelo_ativo FROM fin_regua_etapas r JOIN fin_templates m ON m.id = r.template_id
      WHERE r.empresa_id = ? AND r.ativo = 1 AND m.ativo = 1`,
    [empresa],
  );
  let criados = 0;
  for (const e of etapas) {
    const [de, ate] = janela(e.evento, Number(e.dias_relativos));
    const dataRef = e.evento === 'emissao' ? 'DATE(p.criado_em)'
      : e.evento === 'pagamento' ? `(SELECT MAX(b.data_pagamento) FROM fin_receber_baixas b WHERE b.parcela_id = p.id AND b.estornada_em IS NULL AND b.estorno_de_id IS NULL)`
      : 'p.vencimento';
    const status = e.evento === 'pagamento' ? "p.status = 'quitada'" : "p.status IN ('aberta','parcial')";
    const optout = e.canal === 'whatsapp' ? 'pf.optout_whatsapp' : 'pf.optout_email';
    const destino = e.canal === 'whatsapp' ? 'pe.whatsapp' : "COALESCE(NULLIF(pe.email_cobranca, ''), pe.email_principal)";
    const [cand]: any = await pool.query(
      `SELECT p.id, t.pessoa_id, ${destino} AS destino
         FROM fin_receber_parcelas p JOIN fin_receber_titulos t ON t.id = p.titulo_id JOIN cad_pessoas pe ON pe.id = t.pessoa_id
         LEFT JOIN fin_pessoas_financeiro pf ON pf.empresa_id = p.empresa_id AND pf.pessoa_id = t.pessoa_id
        WHERE p.empresa_id = ? AND ${status} AND ${TITULO_COBRAVEL}
          AND COALESCE(pf.perfil_cobranca, 'padrao') = ? AND COALESCE(${optout}, 0) = 0
          AND DATEDIFF(?, ${dataRef}) BETWEEN ? AND ?
          AND NOT EXISTS (SELECT 1 FROM fin_cobranca_envios x WHERE x.parcela_id = p.id AND x.etapa_id = ? AND x.canal = ?)`,
      [empresa, e.perfil, hoje, de, ate, e.id, e.canal],
    );
    for (const c of cand) {
      const dest = e.canal === 'whatsapp' ? telefoneWhatsApp(c.destino) : /^\S+@\S+\.\S+$/.test(String(c.destino ?? '').trim()) ? String(c.destino).trim() : null;
      // Sem destino fica registrado como falha (aparece na tela de envios) e a etapa não tenta de novo
      const [r]: any = await pool.query('INSERT IGNORE INTO fin_cobranca_envios SET ?', [{
        empresa_id: empresa, parcela_id: c.id, pessoa_id: c.pessoa_id, canal: e.canal, destino: dest ?? String(c.destino ?? '').slice(0, 150),
        etapa_id: e.id, template_id: e.template_id, status: dest ? 'pendente' : 'falhou',
        erro: dest ? null : e.canal === 'whatsapp' ? 'Cliente sem WhatsApp válido no cadastro' : 'Cliente sem email de cobrança no cadastro',
      }]);
      criados += r.affectedRows;
    }
  }
  return { criados, cancelados: canc.affectedRows };
}

/**
 * Envia os pendentes. Mesmo cliente + etapa + canal + destino + vencimento = uma mensagem (agrupamento).
 * Provedor fora ou sem configuração: o grupo continua pendente para a próxima rodada; recusa do destinatário: falhou.
 */
export async function enviarPendentes(empresa: number, ids?: number[]) {
  const hoje = await hojeSql(pool);
  const [l]: any = await pool.query(
    `SELECT e.*, m.assunto, m.corpo, m.template_whatsapp, m.idioma, p.vencimento, r.evento
       FROM fin_cobranca_envios e JOIN fin_templates m ON m.id = e.template_id JOIN fin_receber_parcelas p ON p.id = e.parcela_id
       LEFT JOIN fin_regua_etapas r ON r.id = e.etapa_id
      WHERE e.empresa_id = ? AND e.status = 'pendente' AND (e.agendado_para IS NULL OR e.agendado_para <= NOW()) ${ids ? 'AND e.id IN (?)' : ''}
      ORDER BY e.id LIMIT 500`,
    ids ? [empresa, ids] : [empresa],
  );
  const grupos = new Map<string, any[]>();
  for (const e of l) {
    const k = e.etapa_id ? `${e.pessoa_id}|${e.etapa_id}|${e.canal}|${e.destino}|${String(e.vencimento).slice(0, 10)}` : `manual|${e.id}`;
    grupos.set(k, [...(grupos.get(k) ?? []), e]);
  }
  const dados = await parcelasMensagem(pool, [...new Set(l.map((e: any) => Number(e.parcela_id)))] as number[], hoje);
  const r = { enviados: 0, falhas: 0, adiados: 0, erros: [] as string[] };
  const fora = new Set<Canal>();
  for (const g of grupos.values()) {
    const canal: Canal = g[0].canal;
    if (fora.has(canal)) { r.adiados += g.length; continue; }
    // Reserva o grupo: outra rodada ao mesmo tempo não pega os mesmos envios
    const [res]: any = await pool.query(
      "UPDATE fin_cobranca_envios SET agendado_para = NOW() + INTERVAL 10 MINUTE WHERE id IN (?) AND status = 'pendente' AND (agendado_para IS NULL OR agendado_para <= NOW())",
      [g.map((e) => e.id)],
    );
    if (res.affectedRows !== g.length) continue;
    const ps = g.map((e) => dados.get(Number(e.parcela_id))!);
    const pagamento = g[0].evento === 'pagamento';
    const valendo = g.filter((_e, i) => (pagamento ? ps[i].status === 'quitada' : ps[i].status === 'aberta' || ps[i].status === 'parcial' || !g[0].etapa_id));
    const sairam = g.filter((e) => !valendo.includes(e));
    if (sairam.length) {
      await pool.query("UPDATE fin_cobranca_envios SET status = 'cancelado', erro = 'Parcela não está mais em aberto', status_em = NOW() WHERE id IN (?)", [sairam.map((e) => e.id)]);
    }
    if (!valendo.length) continue;
    const ids = valendo.map((e) => e.id);
    const msg = montar({ canal, assunto: g[0].assunto, corpo: g[0].corpo, template_whatsapp: g[0].template_whatsapp, idioma: g[0].idioma },
      variaveisDoGrupo(valendo.map((e) => dados.get(Number(e.parcela_id))!)));
    try {
      const { id } = await enviadorDe(canal).enviar(empresa, { destino: g[0].destino, ...msg });
      await pool.query(
        "UPDATE fin_cobranca_envios SET status = 'enviado', erro = NULL, mensagem_externa_id = ?, agrupamento = ?, enviado_em = NOW(), status_em = NOW(), agendado_para = NULL WHERE id IN (?)",
        [id, ids.length > 1 ? crypto.randomUUID() : null, ids],
      );
      r.enviados += ids.length;
    } catch (e: any) {
      const erro = String(e?.message ?? e).slice(0, 255);
      r.erros.push(erro);
      if (e instanceof ErroProvedor) {
        // Volta em 30 min; os outros grupos do mesmo canal nem tentam nesta rodada
        fora.add(canal);
        await pool.query('UPDATE fin_cobranca_envios SET erro = ?, agendado_para = NOW() + INTERVAL 30 MINUTE WHERE id IN (?)', [erro, ids]);
        r.adiados += ids.length;
      } else {
        await pool.query("UPDATE fin_cobranca_envios SET status = 'falhou', erro = ?, status_em = NOW(), agendado_para = NULL WHERE id IN (?)", [erro, ids]);
        r.falhas += ids.length;
      }
    }
  }
  return r;
}

/**
 * Uma rodada do agendador: títulos de venda/compra que não chegaram (empresas que já recebem da venda/compra), régua em
 * horário comercial e fila de eventos sempre
 */
export async function rodadaAgendada() {
  const agora = await agoraBrasilia();
  const comercial = dentroDoHorario(agora);
  const [empresas]: any = await pool.query(
    `SELECT DISTINCT empresa_id FROM fin_regua_etapas WHERE ativo = 1
      UNION SELECT DISTINCT empresa_id FROM fin_eventos WHERE status IN ('pendente','erro','processando')
      UNION SELECT DISTINCT empresa_id FROM fin_receber_titulos WHERE origem = 'venda'
      UNION SELECT DISTINCT empresa_id FROM fin_pagar_titulos WHERE origem = 'compra'`,
  );
  const r: Record<string, unknown> = { agora, comercial };
  for (const { empresa_id } of empresas) {
    const empresa = Number(empresa_id);
    try {
      r[empresa] = {
        origens: await sincronizarOrigens(sistema(empresa)),
        ...(comercial ? { regua: await rodarRegua(empresa), envios: await enviarPendentes(empresa) } : {}),
        fila: await processarFila(sistema(empresa)),
      };
    } catch (e: any) {
      r[empresa] = { erro: String(e?.message ?? e) };
    }
  }
  return r;
}

// ------------------------------------------------------------------ webhook do WhatsApp (Meta)

const ORDEM = "FIELD(status, 'pendente', 'enviado', 'entregue', 'lido', 'respondido')";
const STATUS_META: Record<string, string> = { sent: 'enviado', delivered: 'entregue', read: 'lido', failed: 'falhou' };

/** Status só anda para frente; falha só vale antes de entregar. Devolve as linhas alteradas. */
async function mudarStatus(externo: string, status: string, erro?: string | null) {
  const [r]: any = status === 'falhou'
    ? await pool.query("UPDATE fin_cobranca_envios SET status = 'falhou', erro = ?, status_em = NOW() WHERE mensagem_externa_id = ? AND status IN ('pendente','enviado')", [String(erro ?? 'Falha informada pelo provedor').slice(0, 255), externo])
    : await pool.query(`UPDATE fin_cobranca_envios SET status = ?, status_em = NOW() WHERE mensagem_externa_id = ? AND ${ORDEM} < FIELD(?, 'pendente', 'enviado', 'entregue', 'lido', 'respondido')`, [status, externo, status]);
  return r.affectedRows as number;
}

const PALAVRAS_SAIR = /^\s*(sair|parar|pare|cancelar|stop)\s*[.!]*\s*$/i;

async function webhookMeta(corpo: any) {
  const r = { status: 0, respostas: 0, optout: 0 };
  for (const entry of corpo?.entry ?? []) {
    for (const ch of entry?.changes ?? []) {
      const v = ch?.value ?? {};
      for (const st of v.statuses ?? []) {
        const novo = STATUS_META[st.status];
        if (novo && st.id) r.status += await mudarStatus(String(st.id), novo, st.errors?.[0]?.title || st.errors?.[0]?.message);
      }
      for (const m of v.messages ?? []) {
        // Resposta: à mensagem citada, ou à última que mandamos para esse número nos últimos 7 dias
        const [[e]]: any = await pool.query(
          `SELECT id, mensagem_externa_id, empresa_id, pessoa_id FROM fin_cobranca_envios WHERE canal = 'whatsapp' AND mensagem_externa_id IS NOT NULL
              AND ${m.context?.id ? 'mensagem_externa_id = ?' : 'destino = ? AND enviado_em > NOW() - INTERVAL 7 DAY'} ORDER BY id DESC LIMIT 1`,
          [m.context?.id ?? String(m.from ?? '')],
        );
        if (!e) continue;
        r.respostas += await mudarStatus(e.mensagem_externa_id, 'respondido');
        if (m.type === 'text' && PALAVRAS_SAIR.test(String(m.text?.body ?? ''))) {
          await pool.query(
            'INSERT INTO fin_pessoas_financeiro (empresa_id, pessoa_id, optout_whatsapp) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE optout_whatsapp = 1',
            [e.empresa_id, e.pessoa_id],
          );
          r.optout++;
        }
      }
    }
  }
  return r;
}

// ------------------------------------------------------------------ rotas

const schemaModelo = z.object({
  canal: z.enum(['whatsapp', 'email']),
  nome: z.string().trim().min(1, 'nome obrigatório').max(80),
  assunto: textoZ(200),
  corpo: z.string().trim().min(1, 'corpo obrigatório').max(10000),
  template_whatsapp: textoZ(120),
  idioma: z.string().trim().max(10).nullish().transform((v) => v || 'pt_BR'),
  ativo: z.union([z.boolean(), z.number()]).nullish().transform((v) => (v === false || v === 0 ? 0 : 1)),
});
const schemaEtapa = z.object({
  perfil: z.string().trim().max(40).nullish().transform((v) => v || 'padrao'),
  evento: z.enum(['emissao', 'vencimento', 'pagamento']),
  dias_relativos: z.coerce.number().int().min(-365).max(365),
  template_id: z.coerce.number().int().positive('escolha o modelo'),
  ordem: z.coerce.number().int().min(0).max(999).nullish().transform((v) => v ?? 0),
  ativo: z.union([z.boolean(), z.number()]).nullish().transform((v) => (v === false || v === 0 ? 0 : 1)),
});

const EXEMPLO: Variaveis = {
  nome: 'Maria da Silva', documento: 'NF 1234', parcela: '2/3', vencimento: '10/12/2026', valor_original: '350,00', valor_atualizado: '361,55',
  linha_digitavel: '34191.79001 01043.510047 91020.150008 1 10010000035000', pix_copia_cola: '00020101021226…6304ABCD', link: 'https://…/boleto',
};

export function createCobrancaRouter() {
  const r = Router();

  // -------- modelos
  r.get('/cobranca/modelos', rota(async (_req, _res, s) => (await pool.query('SELECT * FROM fin_templates WHERE empresa_id = ? ORDER BY canal, nome', [empresaDe(s)]))[0]));

  const gravarModelo = (id: number | null) => rota(async (req, _res, s) => {
    await exigir(s, 'cobrar');
    const d = validar(schemaModelo, req.body);
    const desconhecidas = variaveisDesconhecidas(`${d.assunto ?? ''} ${d.corpo}`);
    if (desconhecidas.length) falha(`Variável desconhecida: ${desconhecidas.map((k) => `{{${k}}}`).join(', ')}.`);
    if (d.canal === 'email' && !d.assunto) falha('Informe o assunto do email.');
    const empresa = empresaDe(s);
    try {
      if (id) {
        const [x]: any = await pool.query('UPDATE fin_templates SET ? WHERE id = ? AND empresa_id = ?', [{ ...d, usuario_id: usuarioDe(s) }, id, empresa]);
        if (!x.affectedRows) falha('Modelo não encontrado.', 404);
        await auditar(pool, s, req, 'fin_templates', id, 'alterar', null, d);
        return { id };
      }
      const [x]: any = await pool.query('INSERT INTO fin_templates SET ?', [{ ...d, empresa_id: empresa, usuario_id: usuarioDe(s) }]);
      await auditar(pool, s, req, 'fin_templates', x.insertId, 'criar', null, d);
      return { id: x.insertId };
    } catch (e: any) {
      if (e?.code === 'ER_DUP_ENTRY') falha(`Já existe um modelo de ${d.canal === 'email' ? 'email' : 'WhatsApp'} com o nome "${d.nome}".`, 409);
      throw e;
    }
  });
  r.post('/cobranca/modelos', (req, res) => gravarModelo(null)(req, res));
  r.put('/cobranca/modelos/:id', (req, res) => gravarModelo(Number(req.params.id))(req, res));

  // -------- etapas (excluir = desativar: os envios já feitos apontam para elas)
  r.get('/cobranca/etapas', rota(async (_req, _res, s) => (await pool.query(
    `SELECT r.*, m.nome AS modelo_nome FROM fin_regua_etapas r JOIN fin_templates m ON m.id = r.template_id
      WHERE r.empresa_id = ? ORDER BY r.perfil, r.ativo DESC, FIELD(r.evento, 'emissao', 'vencimento', 'pagamento'), r.dias_relativos, r.ordem, r.id`,
    [empresaDe(s)],
  ))[0]));

  const gravarEtapa = (id: number | null) => rota(async (req, _res, s) => {
    await exigir(s, 'cobrar');
    const d = validar(schemaEtapa, req.body);
    const empresa = empresaDe(s);
    const [[m]]: any = await pool.query('SELECT canal FROM fin_templates WHERE id = ? AND empresa_id = ?', [d.template_id, empresa]);
    if (!m) falha('Modelo não encontrado.');
    const dados = { ...d, canal: m.canal, usuario_id: usuarioDe(s) };
    if (id) {
      const [x]: any = await pool.query('UPDATE fin_regua_etapas SET ? WHERE id = ? AND empresa_id = ?', [dados, id, empresa]);
      if (!x.affectedRows) falha('Etapa não encontrada.', 404);
      await auditar(pool, s, req, 'fin_regua_etapas', id, 'alterar', null, dados);
      return { id };
    }
    const [x]: any = await pool.query('INSERT INTO fin_regua_etapas SET ?', [{ ...dados, empresa_id: empresa }]);
    await auditar(pool, s, req, 'fin_regua_etapas', x.insertId, 'criar', null, dados);
    return { id: x.insertId };
  });
  r.post('/cobranca/etapas', (req, res) => gravarEtapa(null)(req, res));
  r.put('/cobranca/etapas/:id', (req, res) => gravarEtapa(Number(req.params.id))(req, res));
  r.delete('/cobranca/etapas/:id', rota(async (req, _res, s) => {
    await exigir(s, 'cobrar');
    const [x]: any = await pool.query('UPDATE fin_regua_etapas SET ativo = 0 WHERE id = ? AND empresa_id = ?', [req.params.id, empresaDe(s)]);
    if (!x.affectedRows) falha('Etapa não encontrada.', 404);
    await auditar(pool, s, req, 'fin_regua_etapas', Number(req.params.id), 'desativar', null, null);
  }));

  /** Prévia: modelo gravado ou corpo em edição, com uma parcela real ou dados de exemplo */
  r.post('/cobranca/previa', rota(async (req, _res, s) => {
    const empresa = empresaDe(s);
    let t: any = req.body ?? {};
    if (t.template_id) {
      [[t]] = (await pool.query('SELECT * FROM fin_templates WHERE id = ? AND empresa_id = ?', [t.template_id, empresa])) as any;
      if (!t) falha('Modelo não encontrado.', 404);
    }
    let v = EXEMPLO;
    if (req.body?.parcela_id) {
      const [[p]]: any = await pool.query('SELECT id FROM fin_receber_parcelas WHERE id = ? AND empresa_id = ?', [req.body.parcela_id, empresa]);
      if (!p) falha('Parcela não encontrada.', 404);
      v = variaveisDoGrupo([(await parcelasMensagem(pool, [p.id], await hojeSql(pool))).get(Number(p.id))!]);
    }
    const corpo = String(t.corpo ?? '');
    return { ...montar({ canal: t.canal === 'email' ? 'email' : 'whatsapp', assunto: t.assunto || null, corpo, template_whatsapp: t.template_whatsapp || null, idioma: t.idioma || 'pt_BR' }, v), desconhecidas: variaveisDesconhecidas(`${t.assunto ?? ''} ${corpo}`) };
  }));

  // -------- envios
  r.get('/cobranca/envios', rota(async (req, _res, s) => {
    const q = req.query;
    const where = ['e.empresa_id = ?'];
    const p: unknown[] = [empresaDe(s)];
    if (q.status) where.push('e.status = ?'), p.push(String(q.status));
    if (q.canal) where.push('e.canal = ?'), p.push(String(q.canal));
    if (q.parcela) where.push('e.parcela_id = ?'), p.push(Number(q.parcela));
    if (q.pessoa) where.push('e.pessoa_id = ?'), p.push(Number(q.pessoa));
    if (q.de) where.push('DATE(e.criado_em) >= ?'), p.push(String(q.de));
    if (q.ate) where.push('DATE(e.criado_em) <= ?'), p.push(String(q.ate));
    const [l] = await pool.query(
      `SELECT e.id, e.parcela_id, e.pessoa_id, e.canal, e.destino, e.etapa_id, e.status, e.erro, e.agrupamento, e.agendado_para, e.enviado_em, e.status_em, e.criado_em,
              pe.nome AS pessoa_nome, m.nome AS modelo_nome, r.evento, r.dias_relativos, p.numero, p.total_parcelas, p.vencimento, p.saldo, p.titulo_id,
              COALESCE(t.numero_documento, p.documento) AS documento, u.login AS usuario_nome
         FROM fin_cobranca_envios e JOIN cad_pessoas pe ON pe.id = e.pessoa_id JOIN fin_receber_parcelas p ON p.id = e.parcela_id
         JOIN fin_receber_titulos t ON t.id = p.titulo_id LEFT JOIN fin_templates m ON m.id = e.template_id
         LEFT JOIN fin_regua_etapas r ON r.id = e.etapa_id LEFT JOIN sys_usuarios u ON u.id = e.usuario_id
        WHERE ${where.join(' AND ')} ORDER BY e.id DESC LIMIT 2000`,
      p,
    );
    return l;
  }));

  /** Rodar a régua agora (botão da tela): ignora o horário comercial, quem clicou decidiu */
  r.post('/cobranca/rodar', rotaModulo(async (req, _res, s) => {
    await exigir(s, 'cobrar');
    const empresa = empresaDe(s);
    const regua = await rodarRegua(empresa);
    const envios = await enviarPendentes(empresa);
    await auditar(pool, s, req, 'fin_cobranca_envios', 0, 'rodar_regua', null, { ...regua, ...envios });
    return { ...regua, ...envios };
  }));

  /** Envio avulso da tela (etapa_id NULL): modelo + canal, destino do cadastro ou digitado */
  r.post('/receber/parcelas/:id/mensagem', rota(async (req, _res, s) => {
    await exigir(s, 'cobrar');
    const empresa = empresaDe(s);
    const [[p]]: any = await pool.query(
      `SELECT p.id, p.status, t.pessoa_id, pe.whatsapp, COALESCE(NULLIF(pe.email_cobranca, ''), pe.email_principal) AS email
         FROM fin_receber_parcelas p JOIN fin_receber_titulos t ON t.id = p.titulo_id JOIN cad_pessoas pe ON pe.id = t.pessoa_id
        WHERE p.id = ? AND p.empresa_id = ?`,
      [req.params.id, empresa],
    );
    if (!p) falha('Parcela não encontrada.', 404);
    const [[m]]: any = await pool.query('SELECT * FROM fin_templates WHERE id = ? AND empresa_id = ? AND ativo = 1', [Number(req.body?.template_id) || 0, empresa]);
    if (!m) falha('Escolha o modelo da mensagem.');
    const bruto = String(req.body?.destino || (m.canal === 'whatsapp' ? p.whatsapp : p.email) || '').trim();
    const destino = m.canal === 'whatsapp' ? telefoneWhatsApp(bruto) : /^\S+@\S+\.\S+$/.test(bruto) ? bruto : null;
    if (!destino) falha(m.canal === 'whatsapp' ? 'Informe um WhatsApp válido (DDD + número).' : 'Informe um email válido.');
    const [x]: any = await pool.query('INSERT INTO fin_cobranca_envios SET ?', [{
      empresa_id: empresa, parcela_id: p.id, pessoa_id: p.pessoa_id, canal: m.canal, destino, template_id: m.id, status: 'pendente', usuario_id: usuarioDe(s),
    }]);
    const r = await enviarPendentes(empresa, [x.insertId]);
    const [[e]]: any = await pool.query('SELECT id, status, erro, agendado_para FROM fin_cobranca_envios WHERE id = ?', [x.insertId]);
    if (e.status === 'falhou' || (e.status === 'pendente' && e.erro)) falha(`Não enviado: ${e.erro}${e.status === 'pendente' ? ' (fica na fila e tenta de novo em 30 min)' : ''}`, 502);
    return { ...e, ...r };
  }));

  // -------- cliente: opt-out e perfil da régua (tabela do financeiro, não cad_pessoas)
  r.get('/pessoas/:id/cobranca', rota(async (req, _res, s) => {
    const empresa = empresaDe(s);
    await pessoaDaEmpresa(pool, empresa, Number(req.params.id));
    const [[f]]: any = await pool.query('SELECT perfil_cobranca, optout_whatsapp, optout_email FROM fin_pessoas_financeiro WHERE empresa_id = ? AND pessoa_id = ?', [empresa, req.params.id]);
    const [[pe]]: any = await pool.query("SELECT whatsapp, COALESCE(NULLIF(email_cobranca, ''), email_principal) AS email FROM cad_pessoas WHERE id = ?", [req.params.id]);
    return { perfil_cobranca: f?.perfil_cobranca ?? 'padrao', optout_whatsapp: !!Number(f?.optout_whatsapp), optout_email: !!Number(f?.optout_email), whatsapp: pe?.whatsapp ?? null, email: pe?.email ?? null };
  }));
  r.put('/pessoas/:id/cobranca', rota(async (req, _res, s) => {
    await exigir(s, 'cobrar');
    const empresa = empresaDe(s);
    const pessoa = Number(req.params.id);
    await pessoaDaEmpresa(pool, empresa, pessoa);
    const d = validar(z.object({
      perfil_cobranca: z.string().trim().max(40).nullish().transform((v) => v || 'padrao'),
      optout_whatsapp: z.boolean(), optout_email: z.boolean(),
    }), req.body);
    const dados = { perfil_cobranca: d.perfil_cobranca, optout_whatsapp: d.optout_whatsapp ? 1 : 0, optout_email: d.optout_email ? 1 : 0, usuario_id: usuarioDe(s) };
    await pool.query('INSERT INTO fin_pessoas_financeiro SET ? ON DUPLICATE KEY UPDATE ?', [{ ...dados, empresa_id: empresa, pessoa_id: pessoa }, dados]);
    await auditar(pool, s, req, 'fin_pessoas_financeiro', pessoa, 'alterar_cobranca', null, dados);
  }));

  // -------- agendador (Vercel Cron manda GET com Authorization: Bearer CRON_SECRET)
  r.get('/cron/cobranca', rotaPublica(async (req) => {
    const segredo = process.env.CRON_SECRET || '';
    if (segredo.length < 16 || !iguais(String(req.headers.authorization || ''), `Bearer ${segredo}`)) falha('Não autorizado.', 401);
    return rodadaAgendada();
  }));

  // -------- webhook do WhatsApp Cloud API: GET = verificação da Meta, POST = status e respostas (assinado)
  r.get('/webhooks/mensagens', (req, res) => {
    const token = process.env.WHATSAPP_CLOUD_VERIFY_TOKEN || '';
    if (req.query['hub.mode'] === 'subscribe' && token && iguais(String(req.query['hub.verify_token'] ?? ''), token)) return void res.type('text/plain').send(String(req.query['hub.challenge'] ?? ''));
    res.status(403).json({ error: 'Token de verificação inválido.' });
  });
  r.post('/webhooks/mensagens', rotaPublica(async (req: Request) => {
    const segredo = process.env.WHATSAPP_CLOUD_APP_SECRET || '';
    if (!segredo) falha('Webhook não configurado (WHATSAPP_CLOUD_APP_SECRET).', 503);
    const bruto: Buffer | undefined = (req as any).rawBody;
    const esperado = `sha256=${crypto.createHmac('sha256', segredo).update(bruto ?? '').digest('hex')}`;
    if (!bruto || !iguais(String(req.headers['x-hub-signature-256'] || ''), esperado)) falha('Assinatura inválida.', 401);
    return webhookMeta(req.body);
  }));

  // -------- link público do boleto ({{link}}): PDF pelo BMBancos com o usuário que emitiu
  r.get('/publico/boleto/:token', rotaPublica(async (req, res) => {
    const [id, ass] = String(req.params.token).split('.');
    if (!/^\d+$/.test(id) || !ass || !iguais(ass, assinaturaLink(Number(id)))) falha('Link inválido.', 404);
    const [[v]]: any = await pool.query(
      `SELECT v.boleto_id, v.empresa_id, v.usuario_id FROM fin_receber_parcela_boletos v JOIN fin_receber_parcelas p ON p.id = v.parcela_id
        WHERE v.parcela_id = ? AND v.ativo = 1 AND p.status IN ('aberta','parcial') ORDER BY v.id DESC LIMIT 1`,
      [Number(id)],
    );
    if (!v?.boleto_id) falha('Este boleto não está mais disponível. Fale com a empresa.', 404);
    const pdf = await bancosBruto({ ...sistema(Number(v.empresa_id)), userId: v.usuario_id ? Number(v.usuario_id) : undefined }, `/boletos/${v.boleto_id}/pdf`);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="boleto_${v.boleto_id}.pdf"`);
    res.end(pdf);
  }));

  return r;
}
