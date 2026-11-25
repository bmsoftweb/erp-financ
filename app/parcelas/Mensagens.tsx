import React, { useCallback, useEffect, useState } from 'react';
import { Send } from 'lucide-react';
import { Toggle } from '@/components/Toggle';
import { Campo, GradeCampos, INPUT_CLASS } from '@/components/FormCrm';
import { api, dataBr } from '@/lib/api';
import { Etiqueta } from '@/lib/financ';

export const SIT_ENVIO: Record<string, string> = {
  pendente: 'bg-blue-100 text-blue-800', enviado: 'bg-sky-100 text-sky-800', entregue: 'bg-emerald-100 text-emerald-800', lido: 'bg-emerald-100 text-emerald-800',
  respondido: 'bg-violet-100 text-violet-800', falhou: 'bg-rose-100 text-rose-800', cancelado: 'bg-stone-200 text-stone-600',
};
export const CANAL: Record<string, string> = { whatsapp: 'WhatsApp', email: 'Email' };
export const hora = (v?: string | null) => (v ? `${dataBr(v)} ${String(v).slice(11, 16)}` : '');
export const nomeEtapa = (r: { evento?: string | null; dias_relativos?: number | null; etapa_id?: number | null }) => {
  if (!r.etapa_id) return 'Avulso';
  const d = Number(r.dias_relativos);
  if (r.evento === 'emissao') return d ? `Emissão +${d}` : 'Emissão';
  if (r.evento === 'pagamento') return d ? `Pagamento +${d}` : 'Pagamento';
  return d === 0 ? 'Vencimento' : d < 0 ? `${-d} dia(s) antes` : `${d} dia(s) depois`;
};
const BOTAO = 'h-[34px] inline-flex items-center gap-1.5 px-3 rounded-lg text-xs font-semibold cursor-pointer disabled:opacity-40';

/** Aba Mensagens da janela Cobrar: opt-out do cliente, envio avulso com prévia e o histórico da parcela */
export function MensagensParcela({ parcela, onMudou, onErro }: { parcela: any; onMudou: (m: string) => void; onErro: (m: string) => void }) {
  const [modelos, setModelos] = useState<any[]>([]);
  const [envios, setEnvios] = useState<any[]>([]);
  const [cliente, setCliente] = useState<{ perfil_cobranca: string; optout_whatsapp: boolean; optout_email: boolean; whatsapp: string | null; email: string | null } | null>(null);
  const [modelo, setModelo] = useState<number | ''>('');
  const [destino, setDestino] = useState('');
  const [previa, setPrevia] = useState<{ assunto: string | null; texto: string } | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const carregar = useCallback(async () => {
    try {
      const [m, e, c] = await Promise.all([
        api<any[]>('/api/financ/cobranca/modelos'), api<any[]>(`/api/financ/cobranca/envios?parcela=${parcela.id}`), api<any>(`/api/financ/pessoas/${parcela.pessoa_id}/cobranca`),
      ]);
      setModelos(m.filter((x) => Number(x.ativo)));
      setEnvios(e);
      setCliente(c);
    } catch (e: any) {
      onErro(e.message);
    }
  }, [parcela.id, parcela.pessoa_id, onErro]);
  useEffect(() => void carregar(), [carregar]);

  const escolhido = modelos.find((m) => m.id === modelo);
  useEffect(() => {
    if (!escolhido) return setPrevia(null);
    setDestino((escolhido.canal === 'whatsapp' ? cliente?.whatsapp : cliente?.email) ?? '');
    api<any>('/api/financ/cobranca/previa', 'POST', { template_id: escolhido.id, parcela_id: parcela.id }).then(setPrevia).catch((e) => onErro(e.message));
  }, [escolhido, cliente?.whatsapp, cliente?.email, parcela.id, onErro]);

  const gravarCliente = async (x: Partial<NonNullable<typeof cliente>>) => {
    if (!cliente) return;
    const novo = { ...cliente, ...x };
    try {
      await api(`/api/financ/pessoas/${parcela.pessoa_id}/cobranca`, 'PUT', { perfil_cobranca: novo.perfil_cobranca, optout_whatsapp: novo.optout_whatsapp, optout_email: novo.optout_email });
      setCliente(novo);
    } catch (e: any) {
      onErro(e.message);
    }
  };

  const enviar = async () => {
    setOcupado(true);
    try {
      await api(`/api/financ/receber/parcelas/${parcela.id}/mensagem`, 'POST', { template_id: modelo, destino });
      onMudou(`${CANAL[escolhido.canal]} enviado.`);
    } catch (e: any) {
      onErro(e.message);
    } finally {
      setOcupado(false);
      await carregar();
    }
  };

  return (
    <div className="space-y-4">
      {cliente && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
          <span className="text-stone-500">Régua automática para este cliente:</span>
          <Toggle checked={!cliente.optout_whatsapp} onChange={(v) => void gravarCliente({ optout_whatsapp: !v })} label={`WhatsApp${cliente.whatsapp ? ` (${cliente.whatsapp})` : ' (sem número)'}`} title="Desligado = o cliente pediu para não receber cobrança por WhatsApp" />
          <Toggle checked={!cliente.optout_email} onChange={(v) => void gravarCliente({ optout_email: !v })} label={`Email${cliente.email ? ` (${cliente.email})` : ' (sem email)'}`} title="Desligado = o cliente pediu para não receber cobrança por email" />
        </div>
      )}

      <div className="flex items-end gap-3">
        <div className="flex-1">
          <GradeCampos>
            <Campo rotulo="Modelo" span={2}>
              <select value={modelo} onChange={(e) => setModelo(e.target.value ? Number(e.target.value) : '')} className={INPUT_CLASS} data-obrigatorio="">
                <option value="">(escolha)</option>
                {modelos.map((m) => <option key={m.id} value={m.id}>{CANAL[m.canal]}: {m.nome}</option>)}
              </select>
            </Campo>
            <Campo rotulo={escolhido?.canal === 'email' ? 'Email' : 'WhatsApp (DDD + número)'} span={2}>
              <input value={destino} disabled={!escolhido} maxLength={150} onFocus={(e) => e.target.select()} onChange={(e) => setDestino(e.target.value)} className={INPUT_CLASS} data-obrigatorio="" />
            </Campo>
          </GradeCampos>
        </div>
        <button type="button" disabled={ocupado || !escolhido || !destino.trim()} onClick={() => void enviar()} title="Enviar agora" data-dica-desc="Manda já, fora da régua; fica no histórico como avulso"
          className={`${BOTAO} text-white bg-blue-600 hover:bg-blue-700`}>
          <Send className="w-4 h-4" /> Enviar
        </button>
      </div>
      {previa && (
        <div className="rounded-lg border border-stone-200 dark:border-stone-800 p-3 text-xs bg-stone-50 dark:bg-stone-900/50">
          {previa.assunto && <div className="font-semibold mb-2">{previa.assunto}</div>}
          <div className="whitespace-pre-wrap">{previa.texto}</div>
        </div>
      )}

      <div className="rounded-lg border border-stone-200 dark:border-stone-800 overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-stone-50 dark:bg-stone-900 text-stone-500">
            <tr><th className="p-2 text-center">Criado</th><th className="p-2 text-left">Etapa</th><th className="p-2 text-left">Canal</th><th className="p-2 text-left">Destino</th><th className="p-2 text-left">Situação</th><th className="p-2 text-center">Enviado</th><th className="p-2 text-left">Erro</th></tr>
          </thead>
          <tbody>
            {!envios.length && <tr><td colSpan={7} className="p-3 text-center text-stone-500">Nenhuma mensagem para esta parcela.</td></tr>}
            {envios.map((e) => (
              <tr key={e.id} className="border-t border-stone-100 dark:border-stone-800">
                <td className="p-2 text-center">{hora(e.criado_em)}</td>
                <td className="p-2">{nomeEtapa(e)}</td>
                <td className="p-2">{CANAL[e.canal]}</td>
                <td className="p-2">{e.destino}</td>
                <td className="p-2"><Etiqueta texto={e.status} cor={SIT_ENVIO[e.status] ?? ''} /></td>
                <td className="p-2 text-center">{hora(e.enviado_em)}</td>
                <td className="p-2 text-rose-700">{e.erro}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
