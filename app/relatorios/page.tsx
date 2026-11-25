import React, { useCallback, useEffect, useState } from 'react';
import { useRefreshDaTela } from '@/components/LayoutApp';
import { ListaCrm, type ColunaLista } from '@/components/ListaCrm';
import { AvisoErro } from '@/components/AvisoErro';
import { DateField } from '@/components/DateField';
import { CampoPesquisa } from '@/components/CampoPesquisa';
import { PesquisaCatalogo } from '@/components/PesquisaCatalogo';
import { INPUT_CLASS } from '@/components/FormCrm';
import { api, dataBr, docBr, hojeIso, moeda } from '@/lib/api';
import { carregarApoio, inicioMes, somar, type Apoio } from '@/lib/financ';

type Rel = 'dre_caixa' | 'dre_competencia' | 'aging' | 'extrato' | 'baixas' | 'encargos' | 'previsto';
const RELATORIOS: Record<Rel, { nome: string; lado?: boolean; periodo: boolean }> = {
  dre_caixa: { nome: 'DRE (regime de caixa)', periodo: true },
  dre_competencia: { nome: 'DRE (regime de competência)', periodo: true },
  aging: { nome: 'Aging (vencidos por faixa)', lado: true, periodo: false },
  extrato: { nome: 'Extrato por pessoa', lado: true, periodo: true },
  baixas: { nome: 'Baixas por período', lado: true, periodo: true },
  encargos: { nome: 'Juros, multas e descontos', lado: true, periodo: true },
  previsto: { nome: 'Previsto × realizado', lado: true, periodo: true },
};
const mesBr = (m: string) => `${m.slice(5, 7)}/${m.slice(0, 4)}`;
const neg = (v: unknown) => (v == null ? '' : <span className={Number(v) < 0 ? 'text-rose-600' : ''}>{moeda(v)}</span>);
const ORIGEM_PARC: Record<string, string> = { parcela: 'Parcela', baixa: 'Baixa', estorno: 'Estorno' };

/** Relatórios: DRE caixa/competência, aging, extrato por pessoa, baixas, juros e descontos, previsto × realizado */
export default function RelatoriosPage() {
  const hoje = hojeIso();
  const [rel, setRel] = useState<Rel>('dre_caixa');
  const [lado, setLado] = useState<'receber' | 'pagar'>('receber');
  const [de, setDe] = useState(inicioMes(hoje));
  const [ate, setAte] = useState(hoje);
  const [centro, setCentro] = useState<number | ''>('');
  const [pessoa, setPessoa] = useState<{ id: number; nome: string } | null>(null);
  const [pesquisa, setPesquisa] = useState(false);
  const [dados, setDados] = useState<any>(null);
  const [carregando, setCarregando] = useState(false);
  const [apoio, setApoio] = useState<Apoio | null>(null);
  const [erro, setErro] = useState('');
  const cfg = RELATORIOS[rel];

  const carregar = useCallback(async () => {
    if (rel === 'extrato' && !pessoa) return setDados(null);
    setCarregando(true);
    try {
      const q = new URLSearchParams({ lado, de, ate, data: ate, ...(centro ? { centro: String(centro) } : {}), ...(pessoa ? { pessoa: String(pessoa.id) } : {}) });
      const url = rel.startsWith('dre') ? `/relatorios/dre?regime=${rel === 'dre_caixa' ? 'caixa' : 'competencia'}&`
        : rel === 'aging' ? '/relatorios/aging?'
        : rel === 'extrato' ? '/relatorios/extrato-pessoa?'
        : rel === 'previsto' ? '/relatorios/previsto-realizado?'
        : `/relatorios/baixas?${rel === 'encargos' ? 'encargos=1&' : ''}`;
      setDados({ rel, ...(await api(`/api/financ${url}${q}`)) });
    } catch (e: any) {
      setErro(e.message);
    } finally {
      setCarregando(false);
    }
  }, [rel, lado, de, ate, centro, pessoa]);
  useEffect(() => void carregar(), [carregar]);
  useEffect(() => void carregarApoio().then(setApoio).catch((e) => setErro(e.message)), []);
  useRefreshDaTela(carregar);

  const linhas: any[] = dados?.rel === rel ? dados.linhas ?? [] : [];
  const soma = (k: string) => moeda(somar(linhas.map((l) => l[k])));
  let colunas: ColunaLista<any>[] = [];
  let rodape: ((k: string) => React.ReactNode) | undefined;
  if (rel.startsWith('dre')) {
    colunas = [
      { key: 'conta', label: 'Conta do plano', largura: 320, render: (r) => <span style={{ paddingLeft: r.nivel * 14 }} className={r.analitica ? '' : 'font-semibold'}>{r.codigo} {r.descricao}</span> },
      ...(dados?.meses ?? []).map((m: string) => ({ key: m, label: mesBr(m), alinhar: 'numero' as const, largura: 110, render: (r: any) => neg(r.valores[m]) })),
      { key: 'total', label: 'Total', alinhar: 'numero', largura: 120, render: (r) => <b>{neg(r.total)}</b> },
    ];
    rodape = (k) => (k === 'total' ? moeda(dados?.total) : dados?.resultado?.[k] != null ? moeda(dados.resultado[k]) : k === 'conta' ? 'Resultado' : null);
  } else if (rel === 'aging') {
    colunas = [
      { key: 'pessoa_nome', label: lado === 'receber' ? 'Cliente' : 'Fornecedor', largura: 240 },
      { key: 'cpf_cnpj', label: 'CPF/CNPJ', largura: 140, render: (r) => docBr(r.cpf_cnpj) },
      ...(['a_vencer', 'd1_30', 'd31_60', 'd61_90', 'd90_mais', 'total'] as const).map((k) => ({
        key: k, label: { a_vencer: 'A vencer', d1_30: '1 a 30', d31_60: '31 a 60', d61_90: '61 a 90', d90_mais: 'Mais de 90', total: 'Total' }[k], alinhar: 'numero' as const, largura: 110, render: (r: any) => (Number(r[k]) ? moeda(r[k]) : ''),
      })),
      { key: 'maior_atraso', label: 'Maior atraso', alinhar: 'numero', largura: 90 },
    ];
    rodape = (k) => (['a_vencer', 'd1_30', 'd31_60', 'd61_90', 'd90_mais', 'total'].includes(k) ? soma(k) : null);
  } else if (rel === 'extrato') {
    colunas = [
      { key: 'data', label: 'Data', alinhar: 'centro', largura: 92, render: (r) => dataBr(r.data) },
      { key: 'tipo', label: 'Lançamento', largura: 90, render: (r) => ORIGEM_PARC[r.tipo] ?? r.tipo },
      { key: 'documento', label: 'Documento', largura: 130 },
      { key: 'parcela', label: 'Parc.', alinhar: 'centro', largura: 60 },
      { key: 'vencimento', label: 'Vencimento', alinhar: 'centro', largura: 92, render: (r) => dataBr(r.vencimento) },
      { key: 'valor', label: 'Valor da parcela', alinhar: 'numero', largura: 120, render: (r) => neg(r.valor) },
      { key: 'pago', label: 'Pago', alinhar: 'numero', largura: 110, render: (r) => neg(r.pago) },
      { key: 'principal', label: 'Principal', alinhar: 'numero', largura: 110, render: (r) => neg(r.principal) },
      { key: 'encargos', label: 'Juros e multa', alinhar: 'numero', largura: 110, render: (r) => neg(r.encargos) },
      { key: 'desconto', label: 'Desconto', alinhar: 'numero', largura: 100, render: (r) => neg(r.desconto) },
      { key: 'situacao', label: 'Situação', largura: 100 },
    ];
    rodape = (k) => (['valor', 'pago', 'principal', 'encargos', 'desconto'].includes(k) ? soma(k) : null);
  } else if (rel === 'previsto') {
    colunas = [
      { key: 'mes', label: 'Mês', alinhar: 'centro', largura: 90, render: (r) => mesBr(r.mes) },
      { key: 'previsto', label: 'Previsto (vencimentos)', alinhar: 'numero', largura: 150, render: (r) => moeda(r.previsto) },
      { key: 'realizado', label: lado === 'receber' ? 'Recebido' : 'Pago', alinhar: 'numero', largura: 140, render: (r) => moeda(r.realizado) },
      { key: 'diferenca', label: 'Diferença', alinhar: 'numero', largura: 130, render: (r) => neg(r.diferenca) },
      { key: 'pct', label: '% realizado', alinhar: 'numero', largura: 100, render: (r) => (r.pct == null ? '' : `${String(r.pct).replace('.', ',')}%`) },
    ];
    rodape = (k) => (['previsto', 'realizado', 'diferenca'].includes(k) ? soma(k) : null);
  } else {
    colunas = [
      { key: 'data_pagamento', label: 'Pagamento', alinhar: 'centro', largura: 92, render: (r) => dataBr(r.data_pagamento) },
      { key: 'data_conta', label: lado === 'receber' ? 'Crédito' : 'Débito', alinhar: 'centro', largura: 92, render: (r) => dataBr(r.data_conta) },
      { key: 'pessoa_nome', label: lado === 'receber' ? 'Cliente' : 'Fornecedor', largura: 200, render: (r) => <span className={r.estorno_de_id || Number(r.estornada) ? 'line-through text-stone-400' : ''}>{r.pessoa_nome}</span> },
      { key: 'documento', label: 'Documento', largura: 120 },
      { key: 'parcela', label: 'Parc.', alinhar: 'centro', largura: 60 },
      { key: 'dias_atraso', label: 'Atraso', alinhar: 'numero', largura: 70 },
      { key: 'valor_pago', label: 'Pago', alinhar: 'numero', largura: 110, render: (r) => neg(r.valor_pago) },
      { key: 'valor_principal', label: 'Principal', alinhar: 'numero', largura: 110, render: (r) => neg(r.valor_principal) },
      { key: 'valor_multa', label: 'Multa', alinhar: 'numero', largura: 90, render: (r) => neg(r.valor_multa) },
      { key: 'valor_juros', label: 'Juros', alinhar: 'numero', largura: 90, render: (r) => neg(r.valor_juros) },
      { key: 'valor_desconto', label: 'Desconto', alinhar: 'numero', largura: 90, render: (r) => neg(r.valor_desconto) },
      { key: 'valor_dispensado', label: 'Dispensado', alinhar: 'numero', largura: 90, render: (r) => neg(r.valor_dispensado) },
      { key: 'valor_tarifa', label: 'Tarifa', alinhar: 'numero', largura: 80, render: (r) => neg(r.valor_tarifa) },
      { key: 'conta_nome', label: 'Conta', largura: 120 },
      { key: 'forma_nome', label: 'Forma', largura: 110 },
      { key: 'origem', label: 'Origem', largura: 100 },
    ];
    rodape = (k) => (k.startsWith('valor_') ? soma(k) : null);
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0">
      <ListaCrm
        className="flex-1"
        key={rel}
        id={`rel_${rel}`}
        linhas={linhas}
        carregando={carregando}
        chave={(r) => (rel.startsWith('dre') ? r.id : rel === 'aging' ? r.pessoa_id : rel === 'previsto' ? r.mes : `${r.tipo ?? 'b'}${r.ref ?? r.id}`)}
        ordenavel={!rel.startsWith('dre')}
        paginar={!rel.startsWith('dre')}
        vazio={rel === 'extrato' && !pessoa ? 'Escolha a pessoa.' : 'Nada no período.'}
        rodape={rodape}
        colunas={colunas}
        barraExtra={(
          <div className="flex flex-wrap items-center gap-2">
            <select value={rel} onChange={(e) => setRel(e.target.value as Rel)} className={`${INPUT_CLASS} w-60`} title="Relatório">
              {Object.entries(RELATORIOS).map(([k, v]) => <option key={k} value={k}>{v.nome}</option>)}
            </select>
            {cfg.lado && (
              <select value={lado} onChange={(e) => (setLado(e.target.value as any), setPessoa(null))} className={`${INPUT_CLASS} w-36`} title="Lado">
                <option value="receber">A receber</option>
                <option value="pagar">A pagar</option>
              </select>
            )}
            {cfg.periodo && <div className="w-36" title="De"><DateField value={de} onChange={setDe} placeholder="De" /></div>}
            <div className="w-36" title={cfg.periodo ? 'Até' : 'Posição em'}><DateField value={ate} onChange={setAte} placeholder={cfg.periodo ? 'até' : 'Posição em'} /></div>
            {rel.startsWith('dre') && (
              <select value={centro} onChange={(e) => setCentro(e.target.value ? Number(e.target.value) : '')} className={`${INPUT_CLASS} w-52`} title="Centro de custo">
                <option value="">Todos os centros</option>
                {apoio?.centros.filter((c) => Number(c.analitico)).map((c) => <option key={c.id} value={c.id}>{c.codigo} {c.descricao}</option>)}
              </select>
            )}
            {rel === 'extrato' && (
              <div className="w-64"><CampoPesquisa obrigatorio texto={pessoa?.nome} vazio={lado === 'receber' ? 'Escolher cliente…' : 'Escolher fornecedor…'} onAbrir={() => setPesquisa(true)} onLimpar={() => setPessoa(null)} /></div>
            )}
            {rel === 'extrato' && dados?.saldo_aberto != null && <span className="text-xs text-stone-500">Em aberto hoje: <b className="tabular-nums">R$ {moeda(dados.saldo_aberto)}</b></span>}
          </div>
        )}
      />
      {pesquisa && (
        <PesquisaCatalogo tipo={lado === 'receber' ? 'clientes' : 'fornecedores'} titulo="Pessoa do extrato" onEscolher={(l: any) => (setPessoa({ id: Number(l.id), nome: l.nome }), setPesquisa(false))} onFechar={() => setPesquisa(false)} />
      )}
      {erro && <AvisoErro mensagem={erro} onFechar={() => setErro('')} />}
    </div>
  );
}
