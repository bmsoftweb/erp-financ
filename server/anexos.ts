import { Router } from 'express';
import { del } from '@vercel/blob';
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { masterPool as pool, transacao } from './db.js';
import { falha, rota } from './http.js';
import type { SessionData } from './session.js';
import { LADOS, ladoDe, empresaDe, usuarioDe, auditar, type Lado } from './comum.js';

/**
 * Anexos do título (nota, boleto, comprovante) no Vercel Blob, como no erp-crm: o navegador manda o arquivo direto
 * para o Blob (sem o limite de 4,5 MB da Vercel); aqui só se libera o envio e se grava fin_anexos.
 *  - caminho financ/<empresa>/<lado>/<título>/<arquivo>-<sufixo aleatório> (público, endereço não adivinhável)
 *  - precisa de BLOB_READ_WRITE_TOKEN
 */

const MAX_ANEXO = 25 * 1024 * 1024;
const URL_BLOB = /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\/([^\s"'<>?]+)/i;
const prefixo = (empresa: number, lado: Lado, titulo: number) => `financ/${empresa}/${lado}/${titulo}/`;

async function tituloDaEmpresa(s: SessionData, lado: Lado, id: number) {
  const [[t]]: any = await pool.query(`SELECT id FROM ${LADOS[lado].titulos} WHERE id = ? AND empresa_id = ?`, [id, empresaDe(s)]);
  return t ? Number(t.id) : falha('Título não encontrado.', 404);
}

export function createAnexosRouter() {
  const r = Router();

  r.get('/:lado/titulos/:id/anexos', rota(async (req, _res, s) => {
    const lado = ladoDe(req.params.lado);
    const id = await tituloDaEmpresa(s, lado, Number(req.params.id));
    const [l] = await pool.query(
      `SELECT a.id, a.nome, a.url, a.tipo_mime, a.tamanho_bytes, a.criado_em, u.login AS usuario_login
         FROM fin_anexos a LEFT JOIN sys_usuarios u ON u.id = a.usuario_id
        WHERE a.empresa_id = ? AND a.entidade = ? AND a.entidade_id = ? ORDER BY a.id`,
      [empresaDe(s), `${lado}_titulo`, id],
    );
    return l;
  }));

  /** Libera o envio direto do navegador: o caminho tem de ser o do título do clientPayload; até 25 MB */
  r.post('/anexos/upload', rota(async (req, _res, s) => {
    if (!process.env.BLOB_READ_WRITE_TOKEN) falha('Storage não configurado: crie o Blob em Vercel › Storage e ligue ao projeto (BLOB_READ_WRITE_TOKEN).', 503);
    return handleUpload({
      request: req,
      body: req.body as HandleUploadBody,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const p = JSON.parse(clientPayload || '{}');
        const lado = ladoDe(p.lado);
        const id = await tituloDaEmpresa(s, lado, Number(p.titulo_id));
        if (!pathname.startsWith(prefixo(empresaDe(s), lado, id))) falha('Caminho do anexo inválido.');
        return { maximumSizeInBytes: MAX_ANEXO, addRandomSuffix: true };
      },
    });
  }));

  /** Grava o anexo já enviado (o endereço tem de estar na pasta do título) */
  r.post('/:lado/titulos/:id/anexos', rota(async (req, res, s) => {
    const lado = ladoDe(req.params.lado);
    const id = await tituloDaEmpresa(s, lado, Number(req.params.id));
    const url = String(req.body?.url ?? '');
    const caminho = URL_BLOB.exec(url)?.[1];
    if (!caminho || !decodeURIComponent(caminho).startsWith(prefixo(empresaDe(s), lado, id))) falha('Endereço do anexo inválido.');
    const dados = {
      empresa_id: empresaDe(s), entidade: `${lado}_titulo`, entidade_id: id, url,
      nome: String(req.body?.nome ?? '').trim().slice(0, 200) || 'anexo',
      tipo_mime: String(req.body?.tipo ?? '').slice(0, 100) || null,
      tamanho_bytes: Math.max(0, Math.trunc(Number(req.body?.tamanho) || 0)),
      usuario_id: usuarioDe(s),
    };
    const anexoId = await transacao(async (c) => {
      const [ins]: any = await c.query('INSERT INTO fin_anexos SET ?', [dados]);
      await auditar(c, s, req, LADOS[lado].titulos, id, 'anexar', null, { anexo_id: ins.insertId, nome: dados.nome });
      return Number(ins.insertId);
    });
    res.status(201);
    return { id: anexoId };
  }));

  /** Remove o anexo (registro e arquivo do Blob) */
  r.delete('/:lado/titulos/:id/anexos/:anexo', rota(async (req, _res, s) => {
    const lado = ladoDe(req.params.lado);
    const id = await tituloDaEmpresa(s, lado, Number(req.params.id));
    const [[a]]: any = await pool.query('SELECT id, nome, url FROM fin_anexos WHERE id = ? AND empresa_id = ? AND entidade = ? AND entidade_id = ?', [req.params.anexo, empresaDe(s), `${lado}_titulo`, id]);
    if (!a) falha('Anexo não encontrado.', 404);
    await transacao(async (c) => {
      await c.query('DELETE FROM fin_anexos WHERE id = ?', [a.id]);
      await auditar(c, s, req, LADOS[lado].titulos, id, 'remover_anexo', { anexo_id: a.id, nome: a.nome }, null);
    });
    // Falha aqui não desfaz a exclusão: só fica o arquivo órfão no Blob
    await del(a.url).catch((e) => console.error(`Anexos: não apagou do Blob: ${e.message}`));
  }));

  return r;
}
