import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FastForward } from 'lucide-react';
import Decimal from 'decimal.js';
import { useRefreshDaTela } from '@/components/LayoutApp';
import { ListaCrm } from '@/components/ListaCrm';
import { AvisoErro } from '@/components/AvisoErro';
import { DateField } from '@/components/DateField';
import { NumberField } from '@/components/NumberField';
import { Toggle } from '@/components/Toggle';
import { Janela } from '@/components/Janela';
import { Campo, GradeCampos, INPUT_CLASS } from '@/components/FormCrm';
import { api, dataBr, hojeIso, moeda } from '@/lib/api';
import { carregarApoio, Etiqueta, inicioMes, type Apoio } from '@/lib/financ';

const MOD: Record<string, string> = { credito: 'Crédito', debito: 'Débito' };
const STATUS: Record<string, string> = { aberto: 'bg-blue-100 text-blue-800', parcial: 'bg-amber-100 text-amber-800', quitado: 'bg-emerald-100 text-emerald-800', cancelado: 'bg-stone-200 text-stone-600' };

/** Vendas no cartão (transações) e recebíveis em aberto contra os adquirentes, com antecipação */
export default function CartaoPage() {
  const [visao, setVisao] = useState<'transacoes' | 'recebiveis'>('recebiveis');
  const [de, setDe] = useState(inicioMes(hojeIso()));
  const [ate, setAte] = useState(hojeIso());
  const [linhas, setLinhas] = useState<any[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [marcadas, setMarcadas] = useState<Set<number>>(new Set());
  const [apoio, setApoio] = useState<Apoio | null>(null);
  const [antecipar, setAntecipar] = useState(false);
  const [erro, setErro] = useState('');
  const [ok, setOk] = useState('');

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      setLinhas(visao === 'recebiveis' ? await api('/api/financ/cartao/recebiveis') : await api(`/api/financ/cartao/transacoes?de=${de}&ate=${ate}`));
      setMarcadas(new Set());
    } catch (e: any) {
      setErro(e.message);
    } finally {
      setCarregando(false);
    }
  }, [visao, de, ate]);
  useEffect(() => void carregar(), [carregar]);
  useEffect(() => void carregarApoio().then(setApoio).catch((e) => setErro(e.message)), []);
  useRefreshDaTela(carregar);

  const selecionadas = useMemo(() => linhas.filter((l) => marcadas.has(l.id)), [linhas, marcadas]);
  const alternar = (id: number) => setMarcadas((m) => { const n = new Set(m); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const BOTAO = 'h-[34px] flex items-center gap-1.5 px-3 rounded-lg text-xs font-semibold cursor-pointer';

  const barra = (
    <div className="flex flex-wrap items-center gap-2">
      <select value={visao} onChange={(e) => setVisao(e.target.value as any)} className={`${INPUT_CLASS} w-48`} title="Visão">
        <option value="recebiveis">Recebíveis em aberto</option>
        <option value="transacoes">Vendas no cartão</option>
      </select>
      {visao === 'transacoes' && (
        <>
          <div className="w-36" title="Venda de"><DateField value={de} onChange={setDe} /></div>
          <div className="w-36" title="Venda até"><DateField value={ate} onChange={setAte} /></div>
        </>
      )}
      {visao === 'recebiveis' && selecionadas.length > 0 && (
        <button type="button" onClick={() => setAntecipar(true)} title="Antecipar" data-dica-desc="Baixa os recebíveis marcados pelo saldo; a diferença para o que caiu na conta é o custo da antecipação" className={`${BOTAO} text-white bg-emerald-600 hover:bg-emerald-700`}>
          <FastForward className="w-4 h-4" /> Antecipar {selecionadas.length}
        </button>
      )}
    </div>
  );

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0">
      {visao === 'recebiveis' ? (
        <ListaCrm
          key="recebiveis"
          className="flex-1"
          id="cartao_recebiveis"
          linhas={linhas}
          carregando={carregando}
          chave={(r) => r.id}
          vazio="Nenhum recebível de cartão em aberto."
          barraExtra={barra}
          rodape={(k) => (k === 'saldo' ? moeda(linhas.reduce((a, l) => a.plus(l.saldo), new Decimal(0)).toFixed(2)) : null)}
          colunas={[
            { key: 'marcar', label: '', largura: 34, alinhar: 'centro', render: (r) => <span onClick={(e) => e.stopPropagation()}><Toggle size="sm" checked={marcadas.has(r.id)} onChange={() => alternar(r.id)} title="Incluir na antecipação" /></span> },
            { key: 'vencimento', label: 'Repasse', alinhar: 'centro', largura: 100, render: (r) => dataBr(r.vencimento) },
            { key: 'adquirente_nome', label: 'Adquirente', largura: 160 },
            { key: 'bandeira', label: 'Bandeira', largura: 110 },
            { key: 'modalidade', label: 'Modalidade', largura: 90, render: (r) => MOD[r.modalidade] },
            { key: 'parcela', label: 'Parc.', alinhar: 'centro', largura: 60, render: (r) => `${r.numero}/${r.total_parcelas}` },
            { key: 'numero_documento', label: 'Documento', largura: 130 },
            { key: 'saldo', label: 'Saldo', alinhar: 'numero', largura: 110, render: (r) => moeda(r.saldo) },
            { key: 'historico', label: 'Histórico', largura: 320 },
          ]}
        />
      ) : (
        <ListaCrm
          key="transacoes"
          className="flex-1"
          id="cartao_transacoes"
          linhas={linhas}
          carregando={carregando}
          chave={(r) => r.id}
          vazio="Nenhuma venda no cartão no período."
          barraExtra={barra}
          rodape={(k) => (['valor_bruto', 'valor_taxa', 'valor_liquido'].includes(k) ? moeda(linhas.reduce((a, l) => a.plus(l[k]), new Decimal(0)).toFixed(2)) : null)}
          colunas={[
            { key: 'data_venda', label: 'Venda', alinhar: 'centro', largura: 100, render: (r) => dataBr(r.data_venda) },
            { key: 'cliente_nome', label: 'Cliente', largura: 200 },
            { key: 'cliente_documento', label: 'Documento', largura: 120 },
            { key: 'adquirente_nome', label: 'Adquirente', largura: 150 },
            { key: 'bandeira', label: 'Bandeira', largura: 100 },
            { key: 'modalidade', label: 'Modalidade', largura: 90, render: (r) => MOD[r.modalidade] },
            { key: 'parcelas', label: 'Parc.', alinhar: 'numero', largura: 60 },
            { key: 'nsu', label: 'NSU', largura: 110 },
            { key: 'valor_bruto', label: 'Bruto', alinhar: 'numero', largura: 100, render: (r) => moeda(r.valor_bruto) },
            { key: 'taxa_pct', label: 'Taxa %', alinhar: 'numero', largura: 70, render: (r) => moeda(r.taxa_pct) },
            { key: 'valor_taxa', label: 'Taxa', alinhar: 'numero', largura: 90, render: (r) => moeda(r.valor_taxa) },
            { key: 'valor_liquido', label: 'Líquido', alinhar: 'numero', largura: 100, render: (r) => moeda(r.valor_liquido) },
            { key: 'recebivel_status', label: 'Recebível', largura: 96, render: (r) => (r.recebivel_status ? <Etiqueta texto={r.recebivel_status} cor={STATUS[r.recebivel_status] ?? ''} /> : '') },
          ]}
        />
      )}
      {antecipar && apoio && <AnteciparDialog parcelas={selecionadas} apoio={apoio} onFechar={() => setAntecipar(false)} onFeito={(m) => (setAntecipar(false), setOk(m), void carregar())} />}
      {erro && <AvisoErro mensagem={erro} onFechar={() => setErro('')} />}
      {ok && <AvisoErro tom="sucesso" mensagem={ok} onFechar={() => setOk('')} />}
    </div>
  );
}

function AnteciparDialog({ parcelas, apoio, onFechar, onFeito }: { parcelas: any[]; apoio: Apoio; onFechar: () => void; onFeito: (m: string) => void }) {
  const total = parcelas.reduce((a, p) => a.plus(p.saldo), new Decimal(0));
  const contas = apoio.contas.filter((c) => c.tipo !== 'adquirente' || parcelas.every((p) => p.adquirente_id === c.id));
  const [data, setData] = useState(hojeIso());
  const [conta, setConta] = useState<number | ''>(contas.find((c) => c.tipo === 'banco')?.id ?? contas[0]?.id ?? '');
  const [liquido, setLiquido] = useState('');
  const custo = liquido ? total.minus(liquido) : null;
  return (
    <Janela
      titulo={`Antecipar ${parcelas.length} recebível(is)`}
      subtitulo={`Saldo ${moeda(total.toFixed(2))}. Cada recebível é baixado pelo saldo; o custo vai para Custo de antecipação, repartido pelo saldo.`}
      largura="max-w-xl"
      onFechar={onFechar}
      confirmar="Antecipar"
      tom="verde"
      desabilitado={!conta || !Number(liquido) || !custo || custo.lt(0)}
      onConfirmar={async () => {
        const r: any = await api('/api/financ/cartao/antecipar', 'POST', { parcelas: parcelas.map((p) => p.id), data, conta_financeira_id: conta, valor_liquido: liquido });
        onFeito(`Antecipados ${moeda(r.total)} por ${moeda(liquido)}: custo ${moeda(r.custo)}.`);
      }}
    >
      <GradeCampos>
        <Campo rotulo="Data"><DateField value={data} onChange={setData} required /></Campo>
        <Campo rotulo="Conta onde caiu" span={2}>
          <select value={conta} onChange={(e) => setConta(e.target.value ? Number(e.target.value) : '')} className={INPUT_CLASS} data-obrigatorio="">
            {contas.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
          </select>
        </Campo>
        <Campo rotulo="Valor líquido recebido"><NumberField autoFocus scale={2} value={liquido} onChange={setLiquido} className={INPUT_CLASS} /></Campo>
      </GradeCampos>
      {custo && (
        <p className={`mt-3 text-xs ${custo.lt(0) ? 'text-rose-600' : 'text-stone-600 dark:text-stone-300'}`}>
          {custo.lt(0) ? 'O líquido não pode passar do saldo dos recebíveis.' : `Custo da antecipação: ${moeda(custo.toFixed(2))} (${total.isZero() ? '0' : moeda(custo.div(total).times(100).toFixed(2))}% do saldo).`}
        </p>
      )}
    </Janela>
  );
}
