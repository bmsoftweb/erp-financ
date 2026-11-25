import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Paperclip, Trash2 } from 'lucide-react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { AvisoErro } from '@/components/AvisoErro';
import { api } from '@/lib/api';
import type { Lado } from '@/lib/financ';

interface Anexo { id: number; nome: string; url: string; tipo_mime: string | null; tamanho_bytes: number | null; criado_em: string; usuario_login: string | null }

const tamanho = (b: number | null) => (!b ? '' : b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`);

/** Anexos do título (server/anexos.ts): o arquivo vai do navegador direto para o Vercel Blob */
export function Anexos({ lado, tituloId, empresaId, onMudou }: { lado: Lado; tituloId: number; empresaId: number; onMudou: () => void }) {
  const [lista, setLista] = useState<Anexo[]>([]);
  const [enviando, setEnviando] = useState(false);
  const [remover, setRemover] = useState<Anexo | null>(null);
  const [erro, setErro] = useState('');
  const arquivo = useRef<HTMLInputElement>(null);

  const carregar = useCallback(() => api<Anexo[]>(`/api/financ/${lado}/titulos/${tituloId}/anexos`).then(setLista).catch((e) => setErro(e.message)), [lado, tituloId]);
  useEffect(() => void carregar(), [carregar]);

  const enviar = async (f: File) => {
    setEnviando(true);
    try {
      const { upload } = await import('@vercel/blob/client');
      const nome = f.name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.-]+/g, '_').slice(-120) || 'anexo';
      const blob = await upload(`financ/${empresaId}/${lado}/${tituloId}/${nome}`, f, {
        access: 'public',
        handleUploadUrl: '/api/financ/anexos/upload',
        clientPayload: JSON.stringify({ lado, titulo_id: tituloId }),
        multipart: f.size > 5 * 1024 * 1024,
      });
      await api(`/api/financ/${lado}/titulos/${tituloId}/anexos`, 'POST', { url: blob.url, nome: f.name, tipo: f.type || null, tamanho: f.size });
      await carregar();
      onMudou();
    } catch (e: any) {
      setErro(e.message || 'Não foi possível anexar.');
    } finally {
      setEnviando(false);
      if (arquivo.current) arquivo.current.value = '';
    }
  };

  return (
    <div>
      {lista.length ? (
        <ul className="mb-2 divide-y divide-stone-100 dark:divide-stone-800">
          {lista.map((a) => (
            <li key={a.id} className="flex items-center gap-3 py-1.5 text-xs">
              <Paperclip className="w-3.5 h-3.5 text-stone-400 shrink-0" />
              <a href={a.url} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline truncate">{a.nome}</a>
              <span className="text-stone-400 tabular-nums shrink-0">{tamanho(a.tamanho_bytes)}</span>
              <span className="text-stone-400 shrink-0">{new Date(a.criado_em).toLocaleString('pt-BR')} · {a.usuario_login ?? ''}</span>
              <span className="flex-1" />
              <button type="button" onClick={() => setRemover(a)} title="Remover anexo" data-dica-desc="Apaga o arquivo (pede confirmação)" className="p-1 rounded text-stone-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 cursor-pointer"><Trash2 className="w-4 h-4" /></button>
            </li>
          ))}
        </ul>
      ) : <p className="text-xs text-stone-400 mb-2">Nenhum anexo.</p>}
      <input ref={arquivo} type="file" className="hidden" onChange={(e) => e.target.files?.[0] && void enviar(e.target.files[0])} />
      <button type="button" disabled={enviando} onClick={() => arquivo.current?.click()} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-stone-600 dark:text-stone-300 border border-stone-300 dark:border-stone-700 hover:bg-stone-100 dark:hover:bg-stone-800 cursor-pointer disabled:opacity-50">
        {enviando ? <Loader2 className="w-4 h-4 animate-spin" /> : <Paperclip className="w-4 h-4" />} Anexar arquivo
      </button>
      {remover && (
        <ConfirmDialog
          titulo="Remover anexo"
          mensagem={`Remover “${remover.nome}”? O arquivo é apagado e não tem como recuperar.`}
          confirmar="Remover"
          onConfirmar={async () => {
            await api(`/api/financ/${lado}/titulos/${tituloId}/anexos/${remover.id}`, 'DELETE');
            setRemover(null);
            await carregar();
            onMudou();
          }}
          onCancelar={() => setRemover(null)}
        />
      )}
      {erro && <AvisoErro mensagem={erro} onFechar={() => setErro('')} />}
    </div>
  );
}
