import crypto from 'node:crypto';
import { ErroHttp, falha } from './http.js';
import type { SessionData } from './session.js';

/**
 * Cliente do BMBancos (erp-bancos), como no erp-pdv: token de sessão dele (HMAC com o SESSION_SECRET de lá, aqui
 * BANCOS_SECRET) em nome do usuário logado. O BMBancos exige que o usuário seja da empresa do token.
 * O financeiro só LÊ ban_extrato_lancamentos; mudar a situação do lançamento é sempre por aqui.
 */

export const bancosConfigurado = () => !!process.env.BANCOS_URL && (process.env.BANCOS_SECRET || '').length >= 32;

function token(segredo: string, uid: number, emp: number) {
  const corpo = Buffer.from(JSON.stringify({ uid, emp, exp: Date.now() + 5 * 60_000 })).toString('base64url');
  return `${corpo}.${crypto.createHmac('sha256', segredo).update(corpo).digest('base64url')}`;
}

async function chamar(s: SessionData, caminho: string, corpo?: unknown) {
  if (!bancosConfigurado()) falha('Integração com o BMBancos não configurada (BANCOS_URL e BANCOS_SECRET no .env).', 503);
  if (!s.userId) falha('O BMBancos exige um usuário (ele registra quem fez): entre no sistema ou mande X-Usuario-Id.', 403);
  let r: Response;
  try {
    r = await fetch(`${process.env.BANCOS_URL!.replace(/\/$/, '')}/api${caminho}`, {
      method: corpo === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token(process.env.BANCOS_SECRET!, Number(s.userId), Number(s.empresaId ?? 1))}` },
      ...(corpo !== undefined && { body: JSON.stringify(corpo) }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e: any) {
    throw new ErroHttp(504, `Sem resposta do BMBancos (${e?.message ?? e}).`);
  }
  if (r.status === 401) falha('O BMBancos recusou o acesso: o usuário precisa ser da empresa da sessão, e o BANCOS_SECRET igual ao SESSION_SECRET do BMBancos.', 502);
  return r;
}

export async function bancos(s: SessionData, caminho: string, corpo?: unknown) {
  const r = await chamar(s, caminho, corpo);
  const d: any = await r.json().catch(() => ({}));
  if (!r.ok || d.success === false) falha(`BMBancos: ${d.error || `erro ${r.status}`}`, 502);
  return d;
}

/** Resposta binária (PDF do boleto) */
export async function bancosBruto(s: SessionData, caminho: string): Promise<Buffer> {
  const r = await chamar(s, caminho);
  if (!r.ok) falha(`BMBancos: ${((await r.json().catch(() => ({}))) as any).error || `erro ${r.status}`}`, 502);
  return Buffer.from(await r.arrayBuffer());
}

/** Situação do lançamento do extrato no BMBancos: conciliar (com a referência do ERP) ou desfazer */
export const marcarExtrato = (s: SessionData, id: number, acao: 'conciliar' | 'desfazer', referencia?: string) =>
  bancos(s, `/extratos/lancamentos/${id}/${acao}`, { referencia: referencia ?? null });
