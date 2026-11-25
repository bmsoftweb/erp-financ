import React, { useEffect, useMemo, useState } from 'react';
import { Janela, Info } from '@/components/Janela';
import { Campo, GradeCampos, INPUT_CLASS } from '@/components/FormCrm';
import { NumberField } from '@/components/NumberField';
import { DateField } from '@/components/DateField';
import { api, dataBr, hojeIso, moeda } from '@/lib/api';
import type { Apoio, Lado } from '@/lib/financ';

const TH = 'px-2 py-1.5 text-[11px] font-semibold text-stone-500 dark:text-stone-400 border-b border-stone-200 dark:border-stone-800';
const TD = 'px-2 py-1 text-xs border-b border-stone-100 dark:border-stone-800';

/** 'aaaa-mm-dd' + n dias, no calendário local */
function somaDias(iso: string, n: number) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

interface Simulacao {
  saldo: string; encargos: string; dispensado: string; total: string;
  itens: { id: number; documento: string | null; numero: number; total_parcelas: number; vencimento: string; saldo: string; multa: string; juros: string; dispensado: string; total: string }[];
}

/**
 * Renegociação: as parcelas marcadas (mesma pessoa) viram um título novo com saldo + multa + juros na data, menos a
 * dispensa (precisa da permissão). As originais ficam "renegociada"; desfazer pelo título novo devolve tudo.
 */
export function RenegociarDialog({ lado, parcelas, apoio, onFechar, onFeito }: { lado: Lado; parcelas: any[]; apoio: Apoio; onFechar: () => void; onFeito: (msg: string, tituloId: number) => void }) {
  const [data, setData] = useState(hojeIso());
  const [dispensa, setDispensa] = useState('');
  const [motivo, setMotivo] = useState('');
  const [qtd, setQtd] = useState('1');
  const [primeiro, setPrimeiro] = useState(somaDias(hojeIso(), 30));
  const [intervalo, setIntervalo] = useState('30');
  const [forma, setForma] = useState<number | ''>('');
  const [obs, setObs] = useState('');
  const [sim, setSim] = useState<Simulacao | null>(null);
  const [erroSim, setErroSim] = useState('');

  useEffect(() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return;
    const t = setTimeout(() => {
      api<Simulacao>('/api/financ/renegociacoes/simular', 'POST', { tipo: lado, parcelas: parcelas.map((p) => p.id), data, dispensa: Number(dispensa) ? dispensa : null })
        .then((r) => (setSim(r), setErroSim('')))
        .catch((e) => setErroSim(e.message));
    }, 250);
    return () => clearTimeout(t);
  }, [lado, parcelas, data, dispensa]);

  // Parcelas novas iguais; os centavos que sobram vão na última
  const novas = useMemo(() => {
    const n = Math.max(1, Math.min(360, Number(qtd) || 1));
    if (!sim || !/^\d{4}-\d{2}-\d{2}$/.test(primeiro)) return [];
    const centavos = Math.round(Number(sim.total) * 100);
    const base = Math.floor(centavos / n);
    return Array.from({ length: n }, (_, i) => ({
      vencimento: somaDias(primeiro, i * (Number(intervalo) || 30)),
      valor: ((i === n - 1 ? centavos - base * (n - 1) : base) / 100).toFixed(2),
      forma_pagamento_id: forma || null,
    }));
  }, [sim, qtd, primeiro, intervalo, forma]);

  const confirmar = async () => {
    const r = await api<{ id: number; titulo_id: number; total: string }>('/api/financ/renegociacoes', 'POST', {
      tipo: lado, parcelas: parcelas.map((p) => p.id), data, dispensa: Number(dispensa) ? dispensa : null, motivo_dispensa: motivo || null, observacoes: obs || null, parcelas_novas: novas,
    });
    onFeito(`Renegociação ${r.id}: título novo de R$ ${moeda(r.total)}.`, r.titulo_id);
  };

  return (
    <Janela
      titulo={`Renegociar ${parcelas.length} parcela(s): ${parcelas[0]?.pessoa_nome ?? ''}`}
      subtitulo="Saldo + multa + juros na data (sem desconto de pontualidade) viram um título novo; as parcelas originais ficam renegociadas."
      largura="max-w-5xl"
      onFechar={onFechar}
      onConfirmar={confirmar}
      confirmar={sim ? `Renegociar R$ ${moeda(sim.total)}` : 'Renegociar'}
      desabilitado={!sim || !!erroSim || !novas.length || (Number(dispensa) > 0 && !motivo.trim())}
    >
      <div className="grid md:grid-cols-[1fr_17rem] gap-5">
        <div>
          <GradeCampos>
            <Campo rotulo="Data da renegociação" dica="Encargos calculados até esta data"><DateField required value={data} onChange={setData} /></Campo>
            <Campo rotulo="Dispensar encargos (R$)" dica="Precisa da permissão Dispensar encargos"><NumberField scale={2} value={dispensa} onChange={setDispensa} className={INPUT_CLASS} /></Campo>
            {Number(dispensa) > 0 && (
              <Campo rotulo="Motivo da dispensa" span={2}><input required maxLength={255} value={motivo} onFocus={(e) => e.target.select()} onChange={(e) => setMotivo(e.target.value)} className={INPUT_CLASS} /></Campo>
            )}
            <Campo rotulo="Parcelas novas"><NumberField required scale={0} value={qtd} onChange={setQtd} className={INPUT_CLASS} /></Campo>
            <Campo rotulo="1º vencimento"><DateField required value={primeiro} onChange={setPrimeiro} /></Campo>
            <Campo rotulo="Intervalo (dias)"><NumberField required scale={0} value={intervalo} onChange={setIntervalo} className={INPUT_CLASS} /></Campo>
            <Campo rotulo="Forma de pagamento">
              <select value={forma} onChange={(e) => setForma(e.target.value ? Number(e.target.value) : '')} className={INPUT_CLASS}>
                <option value="">(nenhuma)</option>
                {apoio.formas.map((f) => <option key={f.id} value={f.id}>{f.nome}</option>)}
              </select>
            </Campo>
            <Campo rotulo="Observações" span={4}><textarea rows={2} maxLength={5000} value={obs} onChange={(e) => setObs(e.target.value)} className={INPUT_CLASS} /></Campo>
          </GradeCampos>

          {sim && (
            <table className="w-full border-collapse mt-4">
              <thead><tr><th className={`${TH} text-left`}>Parcela</th><th className={`${TH} text-center`}>Vencimento</th><th className={`${TH} text-right`}>Saldo</th><th className={`${TH} text-right`}>Multa</th><th className={`${TH} text-right`}>Juros</th><th className={`${TH} text-right`}>Dispensado</th><th className={`${TH} text-right`}>Total</th></tr></thead>
              <tbody>
                {sim.itens.map((i) => (
                  <tr key={i.id}>
                    <td className={TD}>{i.documento ?? ''} {i.numero}/{i.total_parcelas}</td>
                    <td className={`${TD} text-center`}>{dataBr(i.vencimento)}</td>
                    <td className={`${TD} text-right tabular-nums`}>{moeda(i.saldo)}</td>
                    <td className={`${TD} text-right tabular-nums`}>{moeda(i.multa)}</td>
                    <td className={`${TD} text-right tabular-nums`}>{moeda(i.juros)}</td>
                    <td className={`${TD} text-right tabular-nums`}>{moeda(i.dispensado)}</td>
                    <td className={`${TD} text-right tabular-nums font-semibold`}>{moeda(i.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="self-start space-y-3">
          <div className="rounded-xl border border-stone-200 dark:border-stone-800 p-3 bg-stone-50/60 dark:bg-stone-950/40">
            {erroSim ? <p className="text-xs text-rose-600">{erroSim}</p> : sim ? (
              <>
                <Info rotulo="Saldo das parcelas">R$ {moeda(sim.saldo)}</Info>
                <Info rotulo="Multa + juros">R$ {moeda(sim.encargos)}</Info>
                {Number(sim.dispensado) > 0 && <Info rotulo="Dispensado" cor="text-amber-600">R$ {moeda(sim.dispensado)}</Info>}
                <Info rotulo="Total renegociado" forte>R$ {moeda(sim.total)}</Info>
              </>
            ) : <p className="text-xs text-stone-400">Calculando…</p>}
          </div>
          {novas.length > 0 && (
            <div className="rounded-xl border border-stone-200 dark:border-stone-800 p-3">
              <p className="text-[11px] font-semibold text-stone-500 mb-1">Título novo</p>
              {novas.map((x, i) => <Info key={i} rotulo={`${i + 1}/${novas.length} · ${dataBr(x.vencimento)}`}>R$ {moeda(x.valor)}</Info>)}
            </div>
          )}
        </div>
      </div>
    </Janela>
  );
}

/**
 * Compensação: a parcela marcada é baixada contra uma parcela do outro lado (receber × pagar) da mesma pessoa, sem
 * conta financeira. Sem valor, compensa o menor dos dois totais do dia.
 */
export function CompensarDialog({ lado, parcela, onFechar, onFeito }: { lado: Lado; parcela: any; onFechar: () => void; onFeito: (msg: string) => void }) {
  const outroLado: Lado = lado === 'receber' ? 'pagar' : 'receber';
  const [opcoes, setOpcoes] = useState<any[] | null>(null);
  const [escolhida, setEscolhida] = useState<number | ''>('');
  const [data, setData] = useState(hojeIso());
  const [valor, setValor] = useState('');
  const [erro, setErro] = useState('');

  useEffect(() => {
    api<any[]>(`/api/financ/${outroLado}/parcelas?situacao=abertas&pessoa=${parcela.pessoa_id}`)
      .then((l) => setOpcoes(l.filter((p) => outroLado === 'receber' || (p.aprovacao_status !== 'pendente' && p.aprovacao_status !== 'reprovada'))))
      .catch((e) => setErro(e.message));
  }, [outroLado, parcela.pessoa_id]);

  const outra = opcoes?.find((p) => p.id === escolhida);
  useEffect(() => {
    if (outra) setValor(Math.min(Number(parcela.total_dia), Number(outra.total_dia)).toFixed(2));
  }, [outra, parcela.total_dia]);

  const confirmar = async () => {
    const ids = lado === 'receber' ? { receber_parcela_id: parcela.id, pagar_parcela_id: escolhida } : { receber_parcela_id: escolhida, pagar_parcela_id: parcela.id };
    const r = await api<{ valor: string }>('/api/financ/compensacoes', 'POST', { ...ids, data_pagamento: data, valor: Number(valor) ? valor : null });
    onFeito(`Compensação de R$ ${moeda(r.valor)} gravada nos dois lados.`);
  };

  return (
    <Janela
      titulo={`Compensar: ${parcela.pessoa_nome}`}
      subtitulo={`${parcela.numero_documento ?? `Título ${parcela.titulo_id}`} · parcela ${parcela.numero}/${parcela.total_parcelas} · total do dia R$ ${moeda(parcela.total_dia)}. Baixa as duas parcelas, sem passar por conta financeira.`}
      largura="max-w-2xl"
      onFechar={onFechar}
      onConfirmar={confirmar}
      confirmar="Compensar"
      tom="verde"
      desabilitado={!escolhida || !Number(valor)}
    >
      {erro && <p className="text-xs text-rose-600 mb-2">{erro}</p>}
      {opcoes && !opcoes.length ? (
        <p className="text-xs text-stone-500">Nenhuma parcela {outroLado === 'pagar' ? 'a pagar' : 'a receber'} em aberto desta pessoa.</p>
      ) : (
        <GradeCampos>
          <Campo rotulo={`Parcela ${outroLado === 'pagar' ? 'a pagar' : 'a receber'}`} span={4}>
            <select required value={escolhida} onChange={(e) => setEscolhida(e.target.value ? Number(e.target.value) : '')} className={INPUT_CLASS}>
              <option value="">{opcoes ? 'Escolha a parcela…' : 'Carregando…'}</option>
              {opcoes?.map((p) => <option key={p.id} value={p.id}>{p.numero_documento ?? `Título ${p.titulo_id}`} · {p.numero}/{p.total_parcelas} · venc. {dataBr(p.vencimento)} · total do dia R$ {moeda(p.total_dia)}</option>)}
            </select>
          </Campo>
          <Campo rotulo="Data" span={2}><DateField required value={data} onChange={setData} /></Campo>
          <Campo rotulo="Valor compensado" span={2} dica="Encargos recalculados na data"><NumberField required scale={2} value={valor} onChange={setValor} className={INPUT_CLASS} /></Campo>
        </GradeCampos>
      )}
    </Janela>
  );
}
