import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { masterPool as pool } from './db.js';

/**
 * EnviadorMensagem: a régua só conhece esta interface; trocar de provedor é trocar a implementação aqui.
 *  - WhatsApp: API oficial (Cloud API da Meta), WHATSAPP_CLOUD_TOKEN + WHATSAPP_CLOUD_PHONE_ID. Com modelo aprovado
 *    (fin_templates.template_whatsapp) vai como template com parâmetros nomeados; sem ele, texto livre (a Meta só
 *    aceita dentro da janela de 24 h de conversa).
 *  - Email: SMTP da empresa no BM-Master (sys_empresas_smtp, finalidade 'financeiro' ou, sem ela, 'padrao').
 *  - COBRANCA_SIMULAR=1: não envia nada, devolve um id falso (desenvolvimento e teste-banco).
 * ponytail: um número de WhatsApp por instalação (env); por empresa quando alguma pedir número próprio.
 */

export interface Mensagem {
  destino: string;
  assunto?: string | null;
  texto: string;
  /** WhatsApp: modelo aprovado na Meta e os valores das variáveis, na ordem do corpo */
  modelo?: { nome: string; idioma: string; parametros: { nome: string; valor: string }[] } | null;
}
export interface EnviadorMensagem {
  enviar(empresa: number, m: Mensagem): Promise<{ id: string | null }>;
}

/** Provedor sem configuração, fora do ar ou recusando a credencial: o envio fica pendente para a próxima rodada */
export class ErroProvedor extends Error {}

const simulado: EnviadorMensagem = {
  async enviar() {
    return { id: `simulado-${crypto.randomUUID()}` };
  },
};

const whatsappCloud: EnviadorMensagem = {
  async enviar(_empresa, m) {
    const token = process.env.WHATSAPP_CLOUD_TOKEN;
    const numero = process.env.WHATSAPP_CLOUD_PHONE_ID;
    if (!token || !numero) throw new ErroProvedor('WhatsApp não configurado (WHATSAPP_CLOUD_TOKEN e WHATSAPP_CLOUD_PHONE_ID no .env).');
    const corpo = m.modelo
      ? {
          messaging_product: 'whatsapp', to: m.destino, type: 'template',
          template: {
            name: m.modelo.nome, language: { code: m.modelo.idioma },
            // A Meta recusa parâmetro vazio
            components: m.modelo.parametros.length ? [{ type: 'body', parameters: m.modelo.parametros.map((p) => ({ type: 'text', parameter_name: p.nome, text: p.valor || '-' })) }] : [],
          },
        }
      : { messaging_product: 'whatsapp', to: m.destino, type: 'text', text: { body: m.texto } };
    let r: Response;
    try {
      r = await fetch(`https://graph.facebook.com/${process.env.WHATSAPP_CLOUD_VERSAO || 'v21.0'}/${numero}/messages`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(corpo), signal: AbortSignal.timeout(30_000),
      });
    } catch (e: any) {
      throw new ErroProvedor(`WhatsApp: Meta inacessível (${e?.message ?? e}).`);
    }
    const d: any = await r.json().catch(() => ({}));
    if (r.ok) return { id: d.messages?.[0]?.id ?? null };
    const msg = `WhatsApp: ${d.error?.message ?? `erro ${r.status}`}${d.error?.code ? ` (código ${d.error.code})` : ''}`;
    // 401/403, token vencido (190) e falha da Meta: tenta de novo depois; o resto é deste destinatário/mensagem
    if (r.status >= 500 || r.status === 401 || r.status === 403 || d.error?.code === 190) throw new ErroProvedor(msg);
    throw new Error(msg);
  },
};

const email: EnviadorMensagem = {
  async enviar(empresa, m) {
    const [[s]]: any = await pool.query(
      `SELECT host, porta, usuario, senha, remetente, responder_para, usa_ssl, usa_tls FROM sys_empresas_smtp
        WHERE empresa_id = ? AND finalidade IN ('financeiro', 'padrao') ORDER BY finalidade = 'padrao' LIMIT 1`,
      [empresa],
    );
    if (!s?.host) throw new ErroProvedor('Email não configurado: grave o SMTP da empresa no BM-Master (Grupos › Empresas › Configurações › E-mail).');
    const porta = Number(s.porta) || (s.usa_ssl ? 465 : 587);
    const transporte = nodemailer.createTransport({
      host: s.host, port: porta, secure: !!s.usa_ssl || porta === 465, requireTLS: !!s.usa_tls && !s.usa_ssl,
      auth: s.usuario ? { user: s.usuario, pass: s.senha ?? '' } : undefined, connectionTimeout: 15_000,
    });
    try {
      const r = await transporte.sendMail({ from: s.remetente || s.usuario || undefined, to: m.destino, replyTo: s.responder_para || undefined, subject: m.assunto || 'Cobrança', text: m.texto });
      return { id: r.messageId ?? null };
    } catch (e: any) {
      // Servidor fora, sem login ou recusando a conexão: tenta de novo; recusa do endereço marca só este envio
      if (['ECONNECTION', 'ETIMEDOUT', 'EAUTH', 'ESOCKET', 'EDNS', 'ECONNREFUSED'].includes(e?.code)) throw new ErroProvedor(`Email: ${e?.message ?? e}`);
      throw new Error(`Email recusado: ${e?.message ?? e}`);
    }
  },
};

export function enviadorDe(canal: 'whatsapp' | 'email'): EnviadorMensagem {
  if (process.env.COBRANCA_SIMULAR === '1') return simulado;
  return canal === 'whatsapp' ? whatsappCloud : email;
}
