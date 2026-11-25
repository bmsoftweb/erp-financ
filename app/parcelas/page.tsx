import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowLeftRight, CalendarClock, CalendarDays, FileText, HandCoins, Handshake, Layers, Receipt, ShieldCheck } from 'lucide-react';
import { useRefreshDaTela } from '@/components/LayoutApp';
import { ListaCrm } from '@/components/ListaCrm';
import { BotaoAcao, Vazio } from '@/components/MenuAcoes';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { AvisoErro } from '@/components/AvisoErro';
import { DateField } from '@/components/DateField';
import { NumberField } from '@/components/NumberField';
import { Toggle } from '@/components/Toggle';
import { Janela } from '@/components/Janela';
import { Campo, GradeCampos, INPUT_CLASS } from '@/components/FormCrm';
import { api, dataBr, docBr, hojeIso, moeda } from '@/lib/api';
import { carregarApoio, Etiqueta, NOME_LADO, somar, STATUS_PARCELA, type Apoio, type Lado } from '@/lib/financ';
import { BaixaDialog } from './BaixaDialog';
import { TituloDetalhe } from './TituloDetalhe';
import { TituloForm } from './TituloForm';
import { CompensarDialog, RenegociarDialog } from './Acordos';
import { Agenda } from './Agenda';
import { CobrancaDialog } from './Cobranca';

const SITUACOES: [string, string][] = [['abertas', 'Em aberto'], ['vencidas', 'Vencidas'], ['quitadas', 'Quitadas'], ['canceladas', 'Canceladas/renegociadas'], ['todas', 'Todas']];
const APROVACAO: Record<string, string> = { nao_requer: '', pendente: 'Pendente', aprovada: 'Aprovada', reprovada: 'Reprovada' };

/** Contas a receber e a pagar: a mesma tela, pelo lado */
export default function ParcelasPage({ lado }: { lado: Lado }) {
  const n = NOME_LADO[lado];
  const [params, setParams] = useSearchParams();
  const [situacao, setSituacao] = useState(params.get('situacao') || 'abertas');
  const [de, setDe] = useState('');
  const [ate, setAte] = useState('');
  const [linhas, setLinhas] = useState<any[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [apoio, setApoio] = useState<Apoio | null>(null);
  const [marcadas, setMarcadas] = useState<Set<number>>(new Set());
  const [baixar, setBaixar] = useState<any>(null);
  const [detalhe, setDetalhe] = useState<number | null>(null);
  const [novo, setNovo] = useState(false);
  const [prorrogar, setProrrogar] = useState<any>(null);
  const [aprovar, setAprovar] = useState<any>(null);
  const [cobrar, setCobrar] = useState<any>(null);
  const [lote, setLote] = useState(false);
  const [renegociar, setRenegociar] = useState(false);
  const [compensar, setCompensar] = useState(false);
  const [agenda, setAgenda] = useState(false);
  const [erro, setErro] = useState('');
  const [ok, setOk] = useState('');

  const carregar = useCallback(async () => {
    try {
      const q = new URLSearchParams({ situacao, ...(de ? { de } : {}), ...(ate ? { ate } : {}) });
      setLinhas(await api(`/api/financ/${lado}/parcelas?${q}`));
      setMarcadas(new Set());
    } catch (e: any) {
      setErro(e.message);
    } finally {
      setCarregando(false);
    }
  }, [lado, situacao, de, ate]);
  useEffect(() => void carregar(), [carregar]);
  useEffect(() => void carregarApoio().then(setApoio).catch((e) => setErro(e.message)), []);
  useRefreshDaTela(carregar);
  useEffect(() => {
    if (params.get('situacao')) setParams({}, { replace: true });
  }, [params, setParams]);

  const feito = (msg: string) => {
    setOk(msg);
    void carregar();
  };
  const abertas = (p: any) => p.status === 'aberta' || p.status === 'parcial';
  const podeBaixar = (p: any) => abertas(p) && (lado === 'receber' || (p.aprovacao_status !== 'pendente' && p.aprovacao_status !== 'reprovada'));
  const selecionadas = useMemo(() => linhas.filter((l) => marcadas.has(l.id)), [linhas, marcadas]);
  const umaPessoa = selecionadas.length > 0 && new Set(selecionadas.map((l) => l.pessoa_id)).size === 1;
  const BOTAO = 'h-[34px] flex items-center gap-1.5 px-3 rounded-lg text-xs font-semibold cursor-pointer';
  const alternar = (id: number) => setMarcadas((m) => {
    const x = new Set(m);
    if (x.has(id)) x.delete(id);
    else x.add(id);
    return x;
  });

  if (novo && apoio) {
    return (
      <div className="flex-1 flex flex-col min-h-0 min-w-0">
        <TituloForm lado={lado} apoio={apoio} onCancelar={() => setNovo(false)} onSalvo={(id) => (setNovo(false), feito('Título gravado.'), setDetalhe(id))} />
      </div>
    );
  }

  const coluna = (key: string) => (key === 'saldo' ? moeda(somar(linhas.map((l) => l.saldo))) : key === 'total_dia' ? moeda(somar(linhas.map((l) => l.total_dia))) : key === 'valor_original' ? moeda(somar(linhas.map((l) => l.valor_original))) : null);

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0">
      {agenda ? (
        <Agenda lado={lado} onLista={() => setAgenda(false)} onDia={(d) => (setSituacao('abertas'), setDe(d), setAte(d), setAgenda(false))} />
      ) : (
      <ListaCrm
        className="flex-1"
        id={`parcelas_${lado}`}
        linhas={linhas}
        carregando={carregando}
        chave={(r) => r.id}
        onNovo={() => setNovo(true)}
        rotuloNovo="Novo título"
        vazio="Nenhuma parcela nesta situação."
        rodape={coluna}
        barraExtra={(
          <div className="flex flex-wrap items-center gap-2">
            {lado === 'pagar' && (
              <button type="button" onClick={() => setAgenda(true)} title="Agenda" data-dica-desc="Vencimentos do mês em calendário" className="h-[34px] flex items-center gap-1.5 px-3 rounded-lg text-xs font-semibold border border-stone-300 dark:border-stone-700 text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800 cursor-pointer">
                <CalendarDays className="w-4 h-4" /> Agenda
              </button>
            )}
            <select value={situacao} onChange={(e) => setSituacao(e.target.value)} className={`${INPUT_CLASS} w-48`} title="Situação">
              {SITUACOES.map(([v, r]) => <option key={v} value={v}>{r}</option>)}
              {lado === 'pagar' && <option value="aprovar">Aguardando aprovação</option>}
            </select>
            <div className="w-36" title="Vencimento de"><DateField value={de} onChange={setDe} placeholder="Vence de" /></div>
            <div className="w-36" title="Vencimento até"><DateField value={ate} onChange={setAte} placeholder="até" /></div>
            {selecionadas.length > 0 && (
              <button type="button" onClick={() => setLote(true)} className={`${BOTAO} text-white bg-emerald-600 hover:bg-emerald-700`}>
                <Layers className="w-4 h-4" /> Baixar {selecionadas.length} em lote
              </button>
            )}
            {umaPessoa && (
              <button type="button" onClick={() => setRenegociar(true)} title="Renegociar" data-dica-desc="As parcelas marcadas (mesma pessoa) viram um título novo com os encargos até a data" className={`${BOTAO} text-amber-800 border border-amber-300 bg-amber-50 hover:bg-amber-100 dark:text-amber-200 dark:border-amber-800 dark:bg-amber-950/40`}>
                <Handshake className="w-4 h-4" /> Renegociar {selecionadas.length}
              </button>
            )}
            {selecionadas.length === 1 && (
              <button type="button" onClick={() => setCompensar(true)} title="Compensar" data-dica-desc={`Baixa contra uma parcela ${lado === 'receber' ? 'a pagar' : 'a receber'} da mesma pessoa, sem conta financeira`} className={`${BOTAO} text-stone-700 border border-stone-300 hover:bg-stone-100 dark:text-stone-200 dark:border-stone-700 dark:hover:bg-stone-800`}>
                <ArrowLeftRight className="w-4 h-4" /> Compensar
              </button>
            )}
          </div>
        )}
        colunas={[
          { key: 'marcar', label: '', largura: 34, alinhar: 'centro', render: (r) => (podeBaixar(r) ? <span onClick={(e) => e.stopPropagation()}><Toggle size="sm" checked={marcadas.has(r.id)} onChange={() => alternar(r.id)} title="Incluir na baixa em lote" /></span> : null) },
          { key: 'vencimento', label: 'Vencimento', alinhar: 'centro', largura: 96, render: (r) => dataBr(r.vencimento) },
          { key: 'pessoa_nome', label: n.pessoa, largura: 240 },
          { key: 'cpf_cnpj', label: 'CPF/CNPJ', largura: 140, render: (r) => docBr(r.cpf_cnpj) },
          { key: 'numero_documento', label: 'Documento', largura: 130, render: (r) => r.documento || r.numero_documento || '' },
          { key: 'parcela', label: 'Parc.', alinhar: 'centro', largura: 60, render: (r) => `${r.numero}/${r.total_parcelas}` },
          { key: 'valor_original', label: 'Valor', alinhar: 'numero', largura: 110, render: (r) => moeda(r.valor_original) },
          { key: 'saldo', label: 'Saldo', alinhar: 'numero', largura: 110, render: (r) => moeda(r.saldo) },
          { key: 'dias_atraso', label: 'Atraso', alinhar: 'numero', largura: 70, render: (r) => (r.dias_atraso ? <span className="text-rose-600 font-semibold">{r.dias_atraso}</span> : '') },
          { key: 'total_dia', label: 'Total do dia', alinhar: 'numero', largura: 110, render: (r) => (abertas(r) ? moeda(r.total_dia) : '') },
          { key: 'forma_nome', label: 'Forma', largura: 120, render: (r) => r.forma_nome ?? r.forma_pagamento ?? '' },
          { key: 'historico', label: 'Histórico', largura: 200 },
          { key: 'status', label: 'Status', largura: 96, render: (r) => <Etiqueta texto={STATUS_PARCELA[r.status]?.rotulo ?? r.status} cor={STATUS_PARCELA[r.status]?.cor ?? ''} /> },
          ...(lado === 'pagar' ? [{ key: 'aprovacao_status', label: 'Aprovação', largura: 96, render: (r: any) => APROVACAO[r.aprovacao_status] ?? '' }] : []),
        ]}
        acoes={(r) => (
          <>
            {podeBaixar(r) ? <BotaoAcao icone={HandCoins} titulo={n.verbo} rotulo="Baixar" descricao="Baixa total ou parcial, com juros e multa proporcionais" tom="verde" onClick={() => setBaixar(r)} /> : <Vazio icone={HandCoins} titulo={n.verbo} rotulo="Baixar" />}
            <BotaoAcao icone={FileText} titulo="Título" descricao="Parcelas, rateio, baixas (estorno) e histórico" onClick={() => setDetalhe(r.titulo_id)} />
            {abertas(r) ? <BotaoAcao icone={CalendarClock} titulo="Prorrogar" descricao="Novo vencimento; o original fica gravado" onClick={() => setProrrogar({ ...r, novo: r.vencimento, manter: false, motivo: '' })} /> : <Vazio icone={CalendarClock} titulo="Prorrogar" />}
            {lado === 'receber' && (abertas(r) && r.origem !== 'cartao_adquirente' ? <BotaoAcao icone={Receipt} titulo="Cobrar" descricao="Boleto, Pix ou venda no cartão" onClick={() => setCobrar(r)} /> : <Vazio icone={Receipt} titulo="Cobrar" />)}
            {lado === 'pagar' && (r.aprovacao_status === 'pendente' ? <BotaoAcao icone={ShieldCheck} titulo="Aprovar" descricao="Aprovar ou reprovar o pagamento" onClick={() => setAprovar({ ...r, decisao: 'aprovar', motivo: '' })} /> : <Vazio icone={ShieldCheck} titulo="Aprovar" />)}
          </>
        )}
      />
      )}

      {cobrar && apoio && <CobrancaDialog parcela={cobrar} apoio={apoio} onFechar={() => setCobrar(null)} onMudou={feito} />}
      {baixar && apoio && <BaixaDialog lado={lado} parcela={baixar} apoio={apoio} onFechar={() => setBaixar(null)} onBaixada={(m) => (setBaixar(null), feito(m))} />}
      {detalhe && <TituloDetalhe lado={lado} tituloId={detalhe} onFechar={() => setDetalhe(null)} onMudou={feito} />}
      {renegociar && apoio && <RenegociarDialog lado={lado} parcelas={selecionadas} apoio={apoio} onFechar={() => setRenegociar(false)} onFeito={(m, id) => (setRenegociar(false), feito(m), setDetalhe(id))} />}
      {compensar && selecionadas[0] && <CompensarDialog lado={lado} parcela={selecionadas[0]} onFechar={() => setCompensar(false)} onFeito={(m) => (setCompensar(false), feito(m))} />}
      {lote && apoio && <LoteDialog lado={lado} parcelas={selecionadas} apoio={apoio} onFechar={() => setLote(false)} onFeito={(m) => (setLote(false), feito(m))} />}

      {prorrogar && (
        <ConfirmDialog
          titulo="Prorrogar parcela"
          mensagem={`${prorrogar.pessoa_nome} · parcela ${prorrogar.numero}/${prorrogar.total_parcelas} · vencimento atual ${dataBr(prorrogar.vencimento)}`}
          confirmar="Prorrogar"
          tom="normal"
          onConfirmar={async () => {
            await api(`/api/financ/${lado}/parcelas/${prorrogar.id}/prorrogar`, 'POST', { vencimento: prorrogar.novo, manter_encargos_original: prorrogar.manter, motivo: prorrogar.motivo || null });
            setProrrogar(null);
            feito('Parcela prorrogada.');
          }}
          onCancelar={() => setProrrogar(null)}
        >
          <div className="space-y-3">
            <Campo rotulo="Novo vencimento"><DateField required value={prorrogar.novo} onChange={(v) => setProrrogar({ ...prorrogar, novo: v })} /></Campo>
            <Campo rotulo="Encargos contam do vencimento original"><Toggle checked={prorrogar.manter} onChange={(v) => setProrrogar({ ...prorrogar, manter: v })} /></Campo>
            <Campo rotulo="Motivo"><input maxLength={255} value={prorrogar.motivo} onChange={(e) => setProrrogar({ ...prorrogar, motivo: e.target.value })} className={INPUT_CLASS} /></Campo>
          </div>
        </ConfirmDialog>
      )}
      {aprovar && (
        <ConfirmDialog
          titulo="Aprovação de pagamento"
          mensagem={`${aprovar.pessoa_nome} · parcela ${aprovar.numero}/${aprovar.total_parcelas} · R$ ${moeda(aprovar.saldo)} · vencimento ${dataBr(aprovar.vencimento)}`}
          confirmar={aprovar.decisao === 'aprovar' ? 'Aprovar' : 'Reprovar'}
          tom={aprovar.decisao === 'aprovar' ? 'normal' : 'perigo'}
          onConfirmar={async () => {
            await api(`/api/financ/pagar/parcelas/${aprovar.id}/aprovar`, 'POST', { aprovar: aprovar.decisao === 'aprovar', motivo: aprovar.motivo || null });
            setAprovar(null);
            feito(aprovar.decisao === 'aprovar' ? 'Pagamento aprovado.' : 'Pagamento reprovado.');
          }}
          onCancelar={() => setAprovar(null)}
        >
          <div className="space-y-3">
            <Campo rotulo="Decisão">
              <select value={aprovar.decisao} onChange={(e) => setAprovar({ ...aprovar, decisao: e.target.value })} className={INPUT_CLASS}>
                <option value="aprovar">Aprovar</option>
                <option value="reprovar">Reprovar</option>
              </select>
            </Campo>
            <Campo rotulo="Observação"><input maxLength={255} value={aprovar.motivo} onChange={(e) => setAprovar({ ...aprovar, motivo: e.target.value })} className={INPUT_CLASS} /></Campo>
          </div>
        </ConfirmDialog>
      )}
      {erro && <AvisoErro mensagem={erro} onFechar={() => setErro('')} />}
      {ok && <AvisoErro tom="sucesso" mensagem={ok} onFechar={() => setOk('')} />}
    </div>
  );
}

/** Baixa em lote: um valor só, distribuído por vencimento; uma entrada/saída na conta */
function LoteDialog({ lado, parcelas, apoio, onFechar, onFeito }: { lado: Lado; parcelas: any[]; apoio: Apoio; onFechar: () => void; onFeito: (m: string) => void }) {
  const devido = somar(parcelas.map((p) => p.total_dia));
  const [data, setData] = useState(hojeIso());
  const [conta, setConta] = useState<number | ''>(apoio.contas[0]?.id ?? '');
  const [forma, setForma] = useState<number | ''>('');
  const [valor, setValor] = useState(devido.toFixed(2));
  const [obs, setObs] = useState('');
  return (
    <Janela
      titulo={`Baixa em lote: ${parcelas.length} parcela(s)`}
      subtitulo={`Total do dia (hoje): R$ ${moeda(devido)}. Com valor menor, as parcelas são quitadas por ordem de vencimento e a última fica parcial.`}
      largura="max-w-xl"
      onFechar={onFechar}
      confirmar="Confirmar lote"
      tom="verde"
      desabilitado={!conta || !Number(valor)}
      onConfirmar={async () => {
        const r = await api(`/api/financ/${lado}/baixas/lote`, 'POST', { parcelas: parcelas.map((p) => p.id), data_pagamento: data, conta_financeira_id: conta, forma_pagamento_id: forma || null, valor_total: valor, observacoes: obs || null });
        onFeito(`Lote #${r.loteId}: ${r.baixas.length} baixa(s), R$ ${moeda(r.valor)}.`);
      }}
    >
      <GradeCampos>
        <Campo rotulo="Data do pagamento" span={2}><DateField required value={data} onChange={setData} /></Campo>
        <Campo rotulo={NOME_LADO[lado].pago} span={2} dica="Encargos recalculados na data do pagamento"><NumberField required scale={2} value={valor} onChange={setValor} className={INPUT_CLASS} /></Campo>
        <Campo rotulo="Conta financeira" span={2}>
          <select required value={conta} onChange={(e) => setConta(e.target.value ? Number(e.target.value) : '')} className={INPUT_CLASS}>
            <option value="">Escolha a conta…</option>
            {apoio.contas.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
          </select>
        </Campo>
        <Campo rotulo="Forma de pagamento" span={2}>
          <select value={forma} onChange={(e) => setForma(e.target.value ? Number(e.target.value) : '')} className={INPUT_CLASS}>
            <option value="">(das parcelas)</option>
            {apoio.formas.map((f) => <option key={f.id} value={f.id}>{f.nome}</option>)}
          </select>
        </Campo>
        <Campo rotulo="Observações" span={4}><textarea rows={2} value={obs} onChange={(e) => setObs(e.target.value)} className={INPUT_CLASS} /></Campo>
      </GradeCampos>
    </Janela>
  );
}
