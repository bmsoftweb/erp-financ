import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useRefreshDaTela } from '@/components/LayoutApp';
import { ListaCrm, type ColunaLista } from '@/components/ListaCrm';
import { AvisoErro } from '@/components/AvisoErro';
import { DateField } from '@/components/DateField';
import { INPUT_CLASS } from '@/components/FormCrm';
import { api, dataBr, hojeIso, moeda } from '@/lib/api';
import { carregarApoio, somar, somarDiasIso, type Apoio } from '@/lib/financ';

const neg = (v: string) => <span className={Number(v) < 0 ? 'text-rose-600 font-semibold' : ''}>{moeda(v)}</span>;
const zero = (v: string) => (Number(v) ? moeda(v) : '');

/**
 * Fluxo de caixa: realizado (movimentos) + previsto (parcelas em aberto pela data prevista) + projetado (provisórios e
 * recorrências), por dia, semana ou mês. Vencidas não pagas ficam fora do saldo, numa linha própria. Saldo negativo em vermelho.
 */
export default function FluxoPage() {
  const hoje = hojeIso();
  const [de, setDe] = useState(hoje);
  const [ate, setAte] = useState(somarDiasIso(hoje, 30));
  const [visao, setVisao] = useState('diaria');
  const [conta, setConta] = useState<number | ''>('');
  const [agrupar, setAgrupar] = useState('');
  const [dados, setDados] = useState<any>(null);
  const [carregando, setCarregando] = useState(true);
  const [apoio, setApoio] = useState<Apoio | null>(null);
  const [erro, setErro] = useState('');

  const carregar = useCallback(async () => {
    if (!de || !ate) return;
    setCarregando(true);
    try {
      const q = new URLSearchParams({ de, ate, visao, ...(conta ? { conta: String(conta) } : {}), ...(agrupar ? { agrupar } : {}) });
      setDados(await api(`/api/financ/fluxo-caixa?${q}`));
    } catch (e: any) {
      setErro(e.message);
    } finally {
      setCarregando(false);
    }
  }, [de, ate, visao, conta, agrupar]);
  useEffect(() => void carregar(), [carregar]);
  useEffect(() => void carregarApoio().then(setApoio).catch((e) => setErro(e.message)), []);
  useRefreshDaTela(carregar);

  const periodos: any[] = dados?.periodos ?? [];
  const soma = (k: string) => moeda(somar(periodos.map((p) => p[k])));
  const colGrupos: ColunaLista<any>[] = [
    { key: 'grupo', label: agrupar === 'conta' ? 'Conta financeira' : agrupar === 'plano' ? 'Conta do plano' : 'Centro de custo', largura: 240 },
    ...periodos.map((p) => ({ key: p.chave, label: p.rotulo, alinhar: 'numero' as const, largura: 100, render: (g: any) => (g.valores[p.chave] ? neg(g.valores[p.chave]) : '') })),
    { key: 'total', label: 'Total', alinhar: 'numero', largura: 110, render: (g: any) => neg(g.total) },
  ];

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0">
      <div className="flex flex-wrap items-center gap-2 p-3 pb-0">
        <div className="w-36" title="De"><DateField value={de} onChange={setDe} placeholder="De" /></div>
        <div className="w-36" title="Até"><DateField value={ate} onChange={setAte} placeholder="até" /></div>
        <select value={visao} onChange={(e) => setVisao(e.target.value)} className={`${INPUT_CLASS} w-32`} title="Visão">
          <option value="diaria">Diária</option>
          <option value="semanal">Semanal</option>
          <option value="mensal">Mensal</option>
        </select>
        <select value={conta} onChange={(e) => setConta(e.target.value ? Number(e.target.value) : '')} className={`${INPUT_CLASS} w-48`} title="Conta financeira">
          <option value="">Todas as contas</option>
          {apoio?.contas.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
        </select>
        <select value={agrupar} onChange={(e) => setAgrupar(e.target.value)} className={`${INPUT_CLASS} w-52`} title="Abrir por">
          <option value="">Sem detalhamento</option>
          <option value="conta">Por conta financeira</option>
          <option value="plano">Por conta do plano</option>
          <option value="centro">Por centro de custo</option>
        </select>
        {dados && <span className="text-xs text-stone-500">Saldo em {dataBr(somarDiasIso(dados.de, -1))}: <b className="tabular-nums">R$ {moeda(dados.saldo_inicial)}</b></span>}
      </div>
      {dados && (Number(dados.vencidas.receber) > 0 || Number(dados.vencidas.pagar) > 0) && (
        <div className="mx-3 mt-3 text-xs rounded-lg px-3 py-2 border border-stone-200 dark:border-stone-800 bg-stone-50 dark:bg-stone-900">
          Vencidas não pagas (fora do saldo abaixo): a receber <b className="tabular-nums">R$ {moeda(dados.vencidas.receber)}</b> · a pagar <b className="tabular-nums text-rose-600">R$ {moeda(dados.vencidas.pagar)}</b>
        </div>
      )}
      {dados?.negativos > 0 && (
        <div className="mx-3 mt-3 flex items-center gap-2 text-xs rounded-lg px-3 py-2 border border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          <AlertTriangle className="w-4 h-4 shrink-0" /> Saldo negativo em {dados.negativos} período(s); o primeiro em {periodos.find((p) => p.negativo)?.rotulo}.
        </div>
      )}
      <ListaCrm
        className={agrupar ? 'max-h-[45vh]' : 'flex-1'}
        id={`fluxo_${visao}`}
        linhas={periodos}
        carregando={carregando}
        chave={(r) => r.chave}
        ordenavel={false}
        paginar={false}
        vazio="Período vazio."
        rodape={(k) => (k.includes('_entradas') || k.includes('_saidas') || k === 'liquido' ? soma(k) : k === 'saldo' && periodos.length ? moeda(periodos[periodos.length - 1].saldo) : null)}
        colunas={[
          { key: 'rotulo', label: 'Período', alinhar: 'centro', largura: 150 },
          { key: 'realizado_entradas', label: 'Entradas realizadas', alinhar: 'numero', largura: 120, render: (r) => zero(r.realizado_entradas) },
          { key: 'realizado_saidas', label: 'Saídas realizadas', alinhar: 'numero', largura: 120, render: (r) => zero(r.realizado_saidas) },
          { key: 'previsto_entradas', label: 'A receber', alinhar: 'numero', largura: 110, render: (r) => zero(r.previsto_entradas) },
          { key: 'previsto_saidas', label: 'A pagar', alinhar: 'numero', largura: 110, render: (r) => zero(r.previsto_saidas) },
          { key: 'projetado_entradas', label: 'Entradas projetadas', alinhar: 'numero', largura: 120, render: (r) => zero(r.projetado_entradas) },
          { key: 'projetado_saidas', label: 'Saídas projetadas', alinhar: 'numero', largura: 120, render: (r) => zero(r.projetado_saidas) },
          { key: 'liquido', label: 'Líquido', alinhar: 'numero', largura: 110, render: (r) => neg(r.liquido) },
          { key: 'saldo', label: 'Saldo', alinhar: 'numero', largura: 120, render: (r) => neg(r.saldo) },
        ]}
      />
      {agrupar && dados && (
        <ListaCrm className="flex-1" id={`fluxo_grupos_${agrupar}`} linhas={dados.grupos} carregando={carregando} chave={(r) => r.grupo} paginar={false} vazio="Nada no período." colunas={colGrupos} />
      )}
      {erro && <AvisoErro mensagem={erro} onFechar={() => setErro('')} />}
    </div>
  );
}
