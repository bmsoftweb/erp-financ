import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, RotateCcw } from 'lucide-react';
import { useRefreshDaTela } from '@/components/LayoutApp';
import { ListaCrm } from '@/components/ListaCrm';
import { BotaoAcao, Vazio } from '@/components/MenuAcoes';
import { AvisoErro } from '@/components/AvisoErro';
import { INPUT_CLASS } from '@/components/FormCrm';
import { api, dataBr, moeda } from '@/lib/api';
import { Etiqueta } from '@/lib/financ';

const STATUS: Record<string, string> = {
  pendente: 'bg-blue-100 text-blue-800', processando: 'bg-amber-100 text-amber-800', processado: 'bg-emerald-100 text-emerald-800',
  erro: 'bg-rose-100 text-rose-800', descartado: 'bg-stone-200 text-stone-600',
};
const TIPOS: Record<string, string> = { 'boleto.liquidado': 'Boleto pago', 'pix.recebido': 'Pix recebido', 'boleto.instrucao': 'Instrução de boleto' };
const hora = (v?: string | null) => (v ? `${dataBr(v)} ${String(v).slice(11, 16)}` : '');

function resumo(e: any) {
  const p = typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload ?? {};
  if (e.tipo === 'boleto.liquidado') return `${p.referencia} · pago ${moeda(p.valorPago)} em ${dataBr(p.dataOcorrencia)}`;
  if (e.tipo === 'pix.recebido') return `${p.txid} · ${moeda(p.valor)}`;
  if (e.tipo === 'boleto.instrucao') return `${p.referencia}: ${String(p.tipo).replace('_', ' ')}${p.dados?.vencimento ? ` para ${dataBr(p.dados.vencimento)}` : ''}`;
  return '';
}

/** Fila de integração com o BMBancos: liquidações de boleto, Pix recebidos e instruções enviadas, com retentativa */
export default function IntegracaoPage() {
  const [status, setStatus] = useState('');
  const [linhas, setLinhas] = useState<any[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [sincronizando, setSincronizando] = useState(false);
  const [erro, setErro] = useState('');
  const [ok, setOk] = useState('');

  const carregar = useCallback(async () => {
    try {
      setLinhas(await api(`/api/financ/eventos${status ? `?status=${status}` : ''}`));
    } catch (e: any) {
      setErro(e.message);
    } finally {
      setCarregando(false);
    }
  }, [status]);
  useEffect(() => void carregar(), [carregar]);
  useRefreshDaTela(carregar);

  const sincronizar = async () => {
    setSincronizando(true);
    try {
      const r: any = await api('/api/financ/bancos/sincronizar', 'POST');
      setOk(`BMBancos: ${r.lidas} ocorrência(s) lida(s), ${r.baixadas} boleto(s) e ${r.pix} Pix baixado(s); fila: ${r.fila.processados} enviado(s).`);
      if (r.erros.length) setErro(r.erros.slice(0, 5).join('\n'));
      await carregar();
    } catch (e: any) {
      setErro(e.message);
    } finally {
      setSincronizando(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0">
      <ListaCrm
        className="flex-1"
        id="integracao_eventos"
        linhas={linhas}
        carregando={carregando}
        chave={(r) => r.id}
        vazio="Nenhum evento de integração."
        barraExtra={(
          <div className="flex flex-wrap items-center gap-2">
            <select value={status} onChange={(e) => setStatus(e.target.value)} className={`${INPUT_CLASS} w-40`} title="Situação">
              <option value="">Todas</option>
              {Object.keys(STATUS).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <button type="button" disabled={sincronizando} onClick={() => void sincronizar()} title="Buscar no BMBancos" data-dica-desc="Lê as liquidações novas dos boletos, confere os Pix em aberto e manda as instruções pendentes"
              className="h-[34px] flex items-center gap-1.5 px-3 rounded-lg text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 cursor-pointer disabled:opacity-40">
              <RefreshCw className={`w-4 h-4 ${sincronizando ? 'animate-spin' : ''}`} /> Buscar no BMBancos
            </button>
          </div>
        )}
        colunas={[
          { key: 'criado_em', label: 'Recebido', alinhar: 'centro', largura: 130, render: (r) => hora(r.criado_em) },
          { key: 'direcao', label: 'Direção', largura: 80, render: (r) => (r.direcao === 'entrada' ? 'Entrada' : 'Saída') },
          { key: 'tipo', label: 'Tipo', largura: 140, render: (r) => TIPOS[r.tipo] ?? r.tipo },
          { key: 'resumo', label: 'Resumo', largura: 320, render: resumo },
          { key: 'status', label: 'Situação', largura: 100, render: (r) => <Etiqueta texto={r.status} cor={STATUS[r.status] ?? ''} /> },
          { key: 'tentativas', label: 'Tent.', alinhar: 'numero', largura: 60 },
          { key: 'proxima_tentativa', label: 'Próxima', alinhar: 'centro', largura: 130, render: (r) => hora(r.proxima_tentativa) },
          { key: 'ultimo_erro', label: 'Último erro', largura: 320 },
          { key: 'processado_em', label: 'Processado', alinhar: 'centro', largura: 130, render: (r) => hora(r.processado_em) },
        ]}
        acoes={(r) => (r.status === 'erro' || r.status === 'pendente'
          ? <BotaoAcao icone={RotateCcw} titulo="Reprocessar" descricao="Tenta de novo agora" onClick={async () => {
              try {
                const x: any = await api(`/api/financ/eventos/${r.id}/reprocessar`, 'POST');
                x.status === 'processado' ? setOk('Evento processado.') : setErro(x.erro || `Evento ${x.status}.`);
              } catch (e: any) {
                setErro(e.message);
              }
              await carregar();
            }} />
          : <Vazio icone={RotateCcw} titulo="Reprocessar" />)}
      />
      {erro && <AvisoErro mensagem={erro} onFechar={() => setErro('')} />}
      {ok && <AvisoErro tom="sucesso" mensagem={ok} onFechar={() => setOk('')} />}
    </div>
  );
}
