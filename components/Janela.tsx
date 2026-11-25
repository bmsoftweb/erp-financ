import React, { useEffect, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { AvisoErro } from './AvisoErro';

/**
 * Janela modal do financeiro (baixa, lote, detalhe do título): mesmo visual do ConfirmDialog, mais larga.
 * O erro lançado em onConfirmar aparece no aviso do canto, com a janela aberta. Esc fecha.
 */
export const Janela: React.FC<{
  titulo: string;
  subtitulo?: React.ReactNode;
  largura?: string;
  onFechar: () => void;
  onConfirmar?: () => Promise<void> | void;
  confirmar?: string;
  tom?: 'normal' | 'perigo' | 'verde';
  desabilitado?: boolean;
  rodapeExtra?: React.ReactNode;
  children: React.ReactNode;
}> = ({ titulo, subtitulo, largura = 'max-w-3xl', onFechar, onConfirmar, confirmar = 'Confirmar', tom = 'normal', desabilitado, rodapeExtra, children }) => {
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState('');

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && !ocupado && !document.querySelector('[data-calendario]') && onFechar();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [ocupado, onFechar]);

  const executar = async () => {
    if (!onConfirmar) return;
    setOcupado(true);
    setErro('');
    try {
      await onConfirmar();
    } catch (e: any) {
      setErro(e.message || 'Não foi possível concluir.');
    } finally {
      setOcupado(false);
    }
  };
  const cor = tom === 'perigo' ? 'bg-rose-600 hover:bg-rose-700' : tom === 'verde' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-blue-600 hover:bg-blue-700';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-stone-950/70 backdrop-blur-xs" onClick={ocupado ? undefined : onFechar} aria-hidden="true" />
      <div role="dialog" aria-modal="true" className={`relative z-10 w-full ${largura} max-h-[92vh] flex flex-col bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-2xl shadow-2xl`}>
        <div className="flex items-start justify-between gap-3 px-5 py-3 border-b border-stone-200 dark:border-stone-800">
          <div className="min-w-0">
            <h2 className="text-sm font-bold">{titulo}</h2>
            {subtitulo && <div className="text-xs text-stone-500 dark:text-stone-400 mt-0.5">{subtitulo}</div>}
          </div>
          <button type="button" onClick={onFechar} disabled={ocupado} title="Fechar" className="p-1 rounded text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 cursor-pointer"><X className="w-4 h-4" /></button>
        </div>
        <div className="overflow-auto p-5">{children}</div>
        {(onConfirmar || rodapeExtra) && (
          <div className="flex items-center justify-end gap-2.5 px-5 py-3 border-t border-stone-200 dark:border-stone-800">
            {rodapeExtra}
            <span className="flex-1" />
            <button type="button" onClick={onFechar} disabled={ocupado} className="px-4 py-2 rounded-lg text-xs font-semibold text-stone-600 dark:text-stone-300 border border-stone-300 dark:border-stone-700 hover:bg-stone-100 dark:hover:bg-stone-800 cursor-pointer disabled:opacity-40">
              {onConfirmar ? 'Cancelar' : 'Fechar'}
            </button>
            {onConfirmar && (
              <button type="button" onClick={executar} disabled={ocupado || desabilitado} className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold text-white cursor-pointer disabled:opacity-50 ${cor}`}>
                {ocupado && <Loader2 className="w-4 h-4 animate-spin" />}
                {confirmar}
              </button>
            )}
          </div>
        )}
      </div>
      {erro && <AvisoErro mensagem={erro} onFechar={() => setErro('')} />}
    </div>
  );
};

/** Linha rótulo/valor dos quadros de resumo */
export const Info: React.FC<{ rotulo: string; children: React.ReactNode; forte?: boolean; cor?: string }> = ({ rotulo, children, forte, cor = '' }) => (
  <div className="flex items-center justify-between gap-3 py-1 border-b border-stone-100 dark:border-stone-800 last:border-0">
    <span className="text-xs text-stone-500 dark:text-stone-400">{rotulo}</span>
    <span className={`text-xs tabular-nums ${forte ? 'font-bold text-sm' : 'font-semibold'} ${cor}`}>{children}</span>
  </div>
);
