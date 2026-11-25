import crypto from 'node:crypto';
import { empresaDe, usuarioDe, type Db } from './comum.js';
import type { SessionData } from './session.js';

/**
 * fin_eventos: entrada (webhook/consulta do BMBancos) e saída (instruções ao BMBancos), com idempotência pela
 * chave_dedup e retentativa exponencial. O processamento fica em recebimento.ts; aqui só o que grava a fila,
 * para baixas.ts e titulos.ts usarem dentro da transação deles sem import circular.
 */

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

/** Evento de saída na fila (processado depois do commit por processarFila) */
export async function enfileirar(c: Db, s: SessionData, tipo: string, payload: Record<string, unknown>) {
  await c.query('INSERT INTO fin_eventos SET ?', [{
    empresa_id: empresaDe(s), direcao: 'saida', tipo, payload: JSON.stringify({ ...payload, usuario_id: usuarioDe(s) }), status: 'pendente',
  }]);
}

/** Depois do commit: manda já o que entrou na fila (o que falhar volta pela retentativa). Import tardio: sem ciclo. */
export async function processarAgora(s: SessionData) {
  await (await import('./recebimento.js')).processarFila(s).catch((e) => console.error('fila fin_eventos:', e?.message ?? e));
}

/**
 * Instrução para os boletos ativos da parcela (prorrogar → alterar_vencimento; cancelar, renegociar ou quitar fora
 * do banco → baixar). Na baixa o vínculo fica ativo = 0. Devolve quantas instruções entraram na fila.
 */
export async function instruirBoletos(c: Db, s: SessionData, parcelaId: number, tipo: 'baixar' | 'alterar_vencimento', dados: Record<string, unknown> = {}) {
  const [ativos]: any = await c.query('SELECT id, boleto_id, referencia FROM fin_receber_parcela_boletos WHERE parcela_id = ? AND ativo = 1 AND boleto_id IS NOT NULL', [parcelaId]);
  for (const b of ativos) {
    await enfileirar(c, s, 'boleto.instrucao', { boleto_id: b.boleto_id, referencia: b.referencia, tipo, dados });
    if (tipo === 'baixar') await c.query('UPDATE fin_receber_parcela_boletos SET ativo = 0 WHERE id = ?', [b.id]);
  }
  return ativos.length as number;
}
