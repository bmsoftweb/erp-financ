import React, { useState } from 'react';
import { Plus, Trash2, Wand2 } from 'lucide-react';
import { FormCrm, Campo, INPUT_CLASS } from '@/components/FormCrm';
import { NumberField } from '@/components/NumberField';
import { DateField } from '@/components/DateField';
import { Toggle } from '@/components/Toggle';
import { CampoPesquisa } from '@/components/CampoPesquisa';
import { PesquisaCatalogo } from '@/components/PesquisaCatalogo';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { api, hojeIso, moeda } from '@/lib/api';
import { NOME_LADO, somar, type Apoio, type Lado } from '@/lib/financ';

interface Rateio { plano_conta_id: number | ''; centro_custo_id: number | ''; percentual: string }
interface Parcela { vencimento: string; valor: string; documento: string; forma_pagamento_id: number | ''; linha_digitavel: string }

const TH = 'px-1.5 py-1 text-[11px] font-semibold text-stone-500 text-left';

function somarDias(iso: string, dias: number) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d + dias);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

/** Título avulso: pessoa, valores, rateio (100%, contas e centros analíticos) e parcelas */
export function TituloForm({ lado, apoio, onCancelar, onSalvo }: { lado: Lado; apoio: Apoio; onCancelar: () => void; onSalvo: (id: number) => void }) {
  const n = NOME_LADO[lado];
  const hoje = hojeIso();
  const [pessoa, setPessoa] = useState<{ id: number; nome: string } | null>(null);
  const [pesquisa, setPesquisa] = useState(false);
  const [doc, setDoc] = useState('');
  const [emissao, setEmissao] = useState(hoje);
  const [competencia, setCompetencia] = useState(hoje);
  const [total, setTotal] = useState('');
  const [historico, setHistorico] = useState('');
  const [obs, setObs] = useState('');
  const [provisorio, setProvisorio] = useState(false);
  const [rateios, setRateios] = useState<Rateio[]>([{ plano_conta_id: '', centro_custo_id: '', percentual: '100' }]);
  const [qtd, setQtd] = useState('1');
  const [primeiro, setPrimeiro] = useState(somarDias(hoje, 30));
  const [intervalo, setIntervalo] = useState('30');
  const [forma, setForma] = useState<number | ''>('');
  const [parcelas, setParcelas] = useState<Parcela[]>([]);
  const [remover, setRemover] = useState<{ tipo: 'rateio' | 'parcela'; i: number } | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState('');

  const contas = apoio.plano.filter((c) => Number(c.analitica) && Number(c.ativo) && c.tipo === (lado === 'receber' ? 'receita' : 'despesa'));
  const outras = apoio.plano.filter((c) => Number(c.analitica) && Number(c.ativo) && !contas.includes(c));
  const centros = apoio.centros.filter((c) => Number(c.analitico) && Number(c.ativo));
  const somaPct = rateios.reduce((a, r) => a + Math.round(Number(r.percentual || 0) * 10000), 0) / 10000;
  const somaParc = somar(parcelas.map((p) => p.valor));

  /** Divide o total em centavos; o resto vai para a primeira parcela */
  const gerar = () => {
    const q = Math.max(1, Math.min(360, Number(qtd) || 1));
    const cent = Math.round(Number(total || 0) * 100);
    const base = Math.floor(cent / q);
    setParcelas(Array.from({ length: q }, (_, i) => ({
      vencimento: somarDias(primeiro, i * (Number(intervalo) || 30)),
      valor: ((i === 0 ? base + (cent - base * q) : base) / 100).toFixed(2),
      documento: doc ? (q > 1 ? `${doc}/${i + 1}` : doc) : '',
      forma_pagamento_id: forma,
      linha_digitavel: '',
    })));
  };

  const mudaRateio = (i: number, campo: keyof Rateio, v: unknown) => setRateios((rs) => rs.map((r, j) => (j === i ? { ...r, [campo]: v } : r)));
  const mudaParcela = (i: number, campo: keyof Parcela, v: unknown) => setParcelas((ps) => ps.map((p, j) => (j === i ? { ...p, [campo]: v } : p)));

  const salvar = async () => {
    setErro('');
    if (!pessoa) return setErro(`Escolha o ${n.pessoa.toLowerCase()}.`);
    if (!parcelas.length) return setErro('Gere as parcelas.');
    setSalvando(true);
    try {
      const r = await api(`/api/financ/${lado}/titulos`, 'POST', {
        pessoa_id: pessoa.id, origem: 'avulsa', numero_documento: doc || null, data_emissao: emissao, data_competencia: competencia,
        valor_total: total, historico: historico || null, observacoes: obs || null, provisorio,
        rateios: rateios.map((r) => ({ ...r, percentual: r.percentual })),
        parcelas: parcelas.map((p) => ({ vencimento: p.vencimento, valor: p.valor, documento: p.documento || null, forma_pagamento_id: p.forma_pagamento_id || null, linha_digitavel: p.linha_digitavel || null })),
      });
      onSalvo(r.id);
    } catch (e: any) {
      setErro(e.message);
    } finally {
      setSalvando(false);
    }
  };

  const sel = (e: React.FocusEvent<HTMLInputElement>) => e.target.select();
  return (
    <>
      <FormCrm id={`titulo_${lado}`} onSubmit={(e) => (e.preventDefault(), salvar())} onCancel={onCancelar} saving={salvando} erro={erro} onFecharErro={() => setErro('')} rodape={`Novo título ${n.titulo.toLowerCase().replace('contas ', '')}`}>
        <Campo rotulo={n.pessoa} span={2}>
          <CampoPesquisa autoFocus obrigatorio texto={pessoa?.nome} vazio={`Escolher ${n.pessoa.toLowerCase()}…`} onAbrir={() => setPesquisa(true)} onLimpar={() => setPessoa(null)} />
        </Campo>
        <Campo rotulo="Documento"><input maxLength={60} value={doc} onFocus={sel} onChange={(e) => setDoc(e.target.value)} className={INPUT_CLASS} /></Campo>
        <Campo rotulo="Valor total"><NumberField required scale={2} value={total} onChange={setTotal} className={INPUT_CLASS} /></Campo>
        <Campo rotulo="Emissão"><DateField required value={emissao} onChange={setEmissao} /></Campo>
        <Campo rotulo="Competência" dica="Mês do DRE por competência"><DateField required value={competencia} onChange={setCompetencia} /></Campo>
        <Campo rotulo="Provisório" dica="Previsão: entra no fluxo, não é dívida confirmada"><Toggle checked={provisorio} onChange={setProvisorio} /></Campo>
        <Campo rotulo="Histórico" span={4}><input maxLength={255} value={historico} onFocus={sel} onChange={(e) => setHistorico(e.target.value)} className={INPUT_CLASS} /></Campo>

        <Campo rotulo={`Rateio: ${somaPct.toLocaleString('pt-BR', { maximumFractionDigits: 4 })}% de 100%`} span={4}>
          <table className="w-full">
            <thead><tr><th className={TH}>Conta do plano</th><th className={TH}>Centro de custo</th><th className={`${TH} w-32 text-right`}>%</th><th className={`${TH} w-28 text-right`}>Valor</th><th className="w-8" /></tr></thead>
            <tbody>
              {rateios.map((r, i) => (
                <tr key={i}>
                  <td className="p-1">
                    <select required value={r.plano_conta_id} onChange={(e) => mudaRateio(i, 'plano_conta_id', e.target.value ? Number(e.target.value) : '')} className={INPUT_CLASS}>
                      <option value="">Escolha a conta…</option>
                      <optgroup label={lado === 'receber' ? 'Receitas' : 'Despesas'}>{contas.map((c) => <option key={c.id} value={c.id}>{c.codigo} {c.descricao}</option>)}</optgroup>
                      <optgroup label="Outras">{outras.map((c) => <option key={c.id} value={c.id}>{c.codigo} {c.descricao}</option>)}</optgroup>
                    </select>
                  </td>
                  <td className="p-1">
                    <select required value={r.centro_custo_id} onChange={(e) => mudaRateio(i, 'centro_custo_id', e.target.value ? Number(e.target.value) : '')} className={INPUT_CLASS}>
                      <option value="">Escolha o centro…</option>
                      {centros.map((c) => <option key={c.id} value={c.id}>{c.codigo} {c.descricao}</option>)}
                    </select>
                  </td>
                  <td className="p-1"><NumberField required scale={4} value={r.percentual} onChange={(v) => mudaRateio(i, 'percentual', v)} className={INPUT_CLASS} /></td>
                  <td className="p-1 text-right text-xs tabular-nums">{moeda((Number(total || 0) * Number(r.percentual || 0)) / 100)}</td>
                  <td className="p-1 text-center">
                    {rateios.length > 1 && <button type="button" title="Remover linha" onClick={() => setRemover({ tipo: 'rateio', i })} className="p-1 rounded text-stone-400 hover:text-rose-600 cursor-pointer"><Trash2 className="w-4 h-4" /></button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" onClick={() => setRateios((rs) => [...rs, { plano_conta_id: '', centro_custo_id: '', percentual: Math.max(0, 100 - somaPct).toFixed(4) }])} className="mt-1 flex items-center gap-1 text-xs font-semibold text-blue-600 cursor-pointer"><Plus className="w-3.5 h-3.5" /> Linha de rateio</button>
        </Campo>

        <Campo rotulo="Parcelas" span={4}>
          <div className="grid grid-cols-2 md:grid-cols-[6rem_10rem_7rem_1fr_auto] gap-2 items-end mb-2">
            <label className="text-[11px] text-stone-500">Quantidade<NumberField scale={0} value={qtd} onChange={setQtd} className={INPUT_CLASS} /></label>
            <label className="text-[11px] text-stone-500">1º vencimento<DateField value={primeiro} onChange={setPrimeiro} /></label>
            <label className="text-[11px] text-stone-500">Intervalo (dias)<NumberField scale={0} value={intervalo} onChange={setIntervalo} className={INPUT_CLASS} /></label>
            <label className="text-[11px] text-stone-500">Forma de pagamento
              <select value={forma} onChange={(e) => setForma(e.target.value ? Number(e.target.value) : '')} className={INPUT_CLASS}>
                <option value="">(nenhuma)</option>
                {apoio.formas.map((f) => <option key={f.id} value={f.id}>{f.nome}</option>)}
              </select>
            </label>
            <button type="button" onClick={gerar} disabled={!Number(total)} className="h-[34px] flex items-center gap-1.5 px-3 rounded-lg text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-40 cursor-pointer"><Wand2 className="w-4 h-4" /> Gerar parcelas</button>
          </div>
          {parcelas.length > 0 && (
            <table className="w-full">
              <thead><tr><th className={`${TH} w-10`}>Nº</th><th className={`${TH} w-40`}>Vencimento</th><th className={`${TH} w-36 text-right`}>Valor</th><th className={TH}>Documento</th><th className={TH}>Forma</th>{lado === 'pagar' && <th className={TH}>Linha digitável</th>}<th className="w-8" /></tr></thead>
              <tbody>
                {parcelas.map((p, i) => (
                  <tr key={i}>
                    <td className="p-1 text-xs">{i + 1}</td>
                    <td className="p-1"><DateField required value={p.vencimento} onChange={(v) => mudaParcela(i, 'vencimento', v)} /></td>
                    <td className="p-1"><NumberField required scale={2} value={p.valor} onChange={(v) => mudaParcela(i, 'valor', v)} className={INPUT_CLASS} /></td>
                    <td className="p-1"><input maxLength={60} value={p.documento} onFocus={sel} onChange={(e) => mudaParcela(i, 'documento', e.target.value)} className={INPUT_CLASS} /></td>
                    <td className="p-1">
                      <select value={p.forma_pagamento_id} onChange={(e) => mudaParcela(i, 'forma_pagamento_id', e.target.value ? Number(e.target.value) : '')} className={INPUT_CLASS}>
                        <option value="">(nenhuma)</option>
                        {apoio.formas.map((f) => <option key={f.id} value={f.id}>{f.nome}</option>)}
                      </select>
                    </td>
                    {lado === 'pagar' && <td className="p-1"><input maxLength={60} inputMode="numeric" value={p.linha_digitavel} onFocus={sel} onChange={(e) => mudaParcela(i, 'linha_digitavel', e.target.value.replace(/[^\d. ]/g, ''))} className={`${INPUT_CLASS} font-mono`} /></td>}
                    <td className="p-1 text-center">
                      {parcelas.length > 1 && <button type="button" title="Remover parcela" onClick={() => setRemover({ tipo: 'parcela', i })} className="p-1 rounded text-stone-400 hover:text-rose-600 cursor-pointer"><Trash2 className="w-4 h-4" /></button>}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr><td colSpan={2} className="p-1 text-xs font-semibold">Soma</td><td className={`p-1 text-right text-xs font-bold tabular-nums ${Math.round(somaParc * 100) !== Math.round(Number(total || 0) * 100) ? 'text-rose-600' : ''}`}>{moeda(somaParc)}</td><td colSpan={4} /></tr></tfoot>
            </table>
          )}
        </Campo>
        <Campo rotulo="Observações" span={4}><textarea rows={2} maxLength={5000} value={obs} onChange={(e) => setObs(e.target.value)} className={INPUT_CLASS} /></Campo>
      </FormCrm>

      {pesquisa && <PesquisaCatalogo tipo={n.pesquisa} titulo={`Escolher ${n.pessoa.toLowerCase()}`} onEscolher={(l: any) => (setPessoa({ id: Number(l.id), nome: l.nome }), setPesquisa(false))} onFechar={() => setPesquisa(false)} />}
      {remover && (
        <ConfirmDialog
          titulo={remover.tipo === 'rateio' ? 'Remover linha de rateio' : 'Remover parcela'}
          mensagem={remover.tipo === 'rateio' ? 'Remover esta linha do rateio? Ajuste os percentuais para fechar 100%.' : `Remover a parcela ${remover.i + 1}? Ajuste os valores para fechar o total.`}
          confirmar="Remover"
          onConfirmar={() => {
            if (remover.tipo === 'rateio') setRateios((rs) => rs.filter((_, j) => j !== remover.i));
            else setParcelas((ps) => ps.filter((_, j) => j !== remover.i));
            setRemover(null);
          }}
          onCancelar={() => setRemover(null)}
        />
      )}
    </>
  );
}
