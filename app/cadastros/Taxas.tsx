import React, { useCallback, useEffect, useState } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { useRefreshDaTela } from '@/components/LayoutApp';
import { ListaCrm } from '@/components/ListaCrm';
import { FormCrm, Campo, INPUT_CLASS } from '@/components/FormCrm';
import { BotaoAcao, SeparadorAcoes, Vazio } from '@/components/MenuAcoes';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { AvisoErro } from '@/components/AvisoErro';
import { Toggle } from '@/components/Toggle';
import { NumberField } from '@/components/NumberField';
import { api, moeda } from '@/lib/api';
import type { ContaFinanceira } from '@/lib/financ';

interface Taxa {
  id?: number; adquirente_id: number | ''; adquirente_nome?: string; bandeira: string; modalidade: string; parcelas_de: number; parcelas_ate: number;
  taxa_pct: string; taxa_fixa: string; dias_repasse: number; ativo: boolean | number;
}
const MODALIDADES: Record<string, string> = { credito: 'Crédito', debito: 'Débito' };

/** Taxas de cartão por adquirente, bandeira, modalidade e faixa de parcelas: viram despesa quando o adquirente paga */
export default function TaxasPage() {
  const [linhas, setLinhas] = useState<Taxa[]>([]);
  const [adquirentes, setAdquirentes] = useState<ContaFinanceira[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [form, setForm] = useState<Taxa | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [erroForm, setErroForm] = useState('');
  const [erro, setErro] = useState('');
  const [excluir, setExcluir] = useState<Taxa | null>(null);

  const carregar = useCallback(async () => {
    try {
      const [t, c] = await Promise.all([api<Taxa[]>('/api/financ/taxas-cartao'), api<ContaFinanceira[]>('/api/financ/contas-financeiras')]);
      setLinhas(t);
      setAdquirentes(c.filter((x) => Number(x.ativo) && x.tipo === 'adquirente'));
    } catch (e: any) {
      setErro(e.message);
    } finally {
      setCarregando(false);
    }
  }, []);
  useEffect(() => void carregar(), [carregar]);
  useRefreshDaTela(carregar);

  const muda = (campo: keyof Taxa, valor: unknown) => setForm((f) => (f ? { ...f, [campo]: valor } : f));
  const abrir = (f: Taxa) => (setErroForm(''), setForm({ ...f }));
  const sel = (e: React.FocusEvent<HTMLInputElement>) => e.target.select();

  const salvar = async () => {
    if (!form) return;
    setSalvando(true);
    setErroForm('');
    try {
      const { id, adquirente_nome: _a, ...corpo } = form;
      await api(id ? `/api/financ/taxas-cartao/${id}` : '/api/financ/taxas-cartao', id ? 'PATCH' : 'POST', { ...corpo, ativo: !!Number(corpo.ativo) });
      setForm(null);
      await carregar();
    } catch (e: any) {
      setErroForm(e.message);
    } finally {
      setSalvando(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0">
      {form ? (
        <FormCrm id="taxas_cartao" onSubmit={(e) => (e.preventDefault(), salvar())} onCancel={() => setForm(null)} saving={salvando} erro={erroForm} onFecharErro={() => setErroForm('')} rodape={form.id ? `Taxa #${form.id}` : 'Inclusão'}>
          <Campo rotulo="Adquirente" span={2}>
            <select required value={form.adquirente_id} onChange={(e) => muda('adquirente_id', e.target.value ? Number(e.target.value) : '')} className={INPUT_CLASS}>
              <option value="">{adquirentes.length ? '(escolha)' : 'Cadastre uma conta financeira do tipo adquirente'}</option>
              {adquirentes.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
            </select>
          </Campo>
          <Campo rotulo="Bandeira" dica="Mesmo texto informado na venda (ex.: Visa, Master, Elo)">
            <input autoFocus={!!form.adquirente_id} required maxLength={30} value={form.bandeira} onFocus={sel} onChange={(e) => muda('bandeira', e.target.value)} className={INPUT_CLASS} />
          </Campo>
          <Campo rotulo="Modalidade">
            <select value={form.modalidade} onChange={(e) => setForm((f) => f && { ...f, modalidade: e.target.value, ...(e.target.value === 'debito' ? { parcelas_de: 1, parcelas_ate: 1 } : {}) })} className={INPUT_CLASS}>
              {Object.entries(MODALIDADES).map(([v, r]) => <option key={v} value={v}>{r}</option>)}
            </select>
          </Campo>
          <Campo rotulo="Parcelas de"><NumberField scale={0} disabled={form.modalidade === 'debito'} value={String(form.parcelas_de)} onChange={(v) => muda('parcelas_de', Number(v) || 1)} className={INPUT_CLASS} /></Campo>
          <Campo rotulo="Parcelas até"><NumberField scale={0} disabled={form.modalidade === 'debito'} value={String(form.parcelas_ate)} onChange={(v) => muda('parcelas_ate', Number(v) || 1)} className={INPUT_CLASS} /></Campo>
          <Campo rotulo="Taxa (%)"><NumberField scale={2} value={form.taxa_pct} onChange={(v) => muda('taxa_pct', v)} className={INPUT_CLASS} /></Campo>
          <Campo rotulo="Taxa fixa (R$)"><NumberField scale={2} value={form.taxa_fixa} onChange={(v) => muda('taxa_fixa', v)} className={INPUT_CLASS} /></Campo>
          <Campo rotulo="Dias para o 1º repasse" dica="As demais parcelas caem mês a mês depois dele">
            <NumberField scale={0} value={String(form.dias_repasse)} onChange={(v) => muda('dias_repasse', Number(v) || 0)} className={INPUT_CLASS} />
          </Campo>
          <Campo rotulo="Ativa"><Toggle checked={!!Number(form.ativo)} onChange={(v) => muda('ativo', v)} /></Campo>
        </FormCrm>
      ) : (
        <ListaCrm
          className="flex-1"
          id="taxas_cartao"
          linhas={linhas}
          carregando={carregando}
          chave={(r) => r.id!}
          onNovo={() => abrir({ adquirente_id: adquirentes.length === 1 ? adquirentes[0].id : '', bandeira: '', modalidade: 'credito', parcelas_de: 1, parcelas_ate: 1, taxa_pct: '0.00', taxa_fixa: '0.00', dias_repasse: 30, ativo: true })}
          onEditar={(r) => abrir(r)}
          vazio="Nenhuma taxa de cartão."
          colunas={[
            { key: 'adquirente_nome', label: 'Adquirente', largura: 180 },
            { key: 'bandeira', label: 'Bandeira', largura: 120 },
            { key: 'modalidade', label: 'Modalidade', largura: 100, render: (r) => MODALIDADES[r.modalidade] ?? r.modalidade },
            { key: 'parcelas', label: 'Parcelas', alinhar: 'centro', largura: 80, render: (r) => (r.parcelas_de === r.parcelas_ate ? `${r.parcelas_de}x` : `${r.parcelas_de} a ${r.parcelas_ate}x`) },
            { key: 'taxa_pct', label: 'Taxa %', alinhar: 'numero', largura: 80, render: (r) => moeda(r.taxa_pct) },
            { key: 'taxa_fixa', label: 'Taxa R$', alinhar: 'numero', largura: 90, render: (r) => moeda(r.taxa_fixa) },
            { key: 'dias_repasse', label: 'Repasse D+', alinhar: 'numero', largura: 90 },
            { key: 'ativo', label: 'Ativa', alinhar: 'centro', largura: 70, render: (r) => (Number(r.ativo) ? 'Sim' : 'Não') },
          ]}
          acoes={(r) => (
            <>
              <BotaoAcao icone={Pencil} titulo="Editar" descricao="Abre a taxa para edição" onClick={() => abrir(r)} />
              <SeparadorAcoes />
              {Number(r.ativo) ? <BotaoAcao icone={Trash2} titulo="Excluir" descricao="Inativa a taxa (pede confirmação)" tom="perigo" onClick={() => setExcluir(r)} /> : <Vazio icone={Trash2} titulo="Excluir" />}
            </>
          )}
        />
      )}
      {excluir && (
        <ConfirmDialog
          titulo="Excluir taxa de cartão"
          mensagem={`Excluir a taxa de ${excluir.adquirente_nome}, ${excluir.bandeira} ${MODALIDADES[excluir.modalidade]}? Ela fica inativa; as vendas já registradas guardam a taxa usada.`}
          onConfirmar={async () => {
            await api(`/api/financ/taxas-cartao/${excluir.id}`, 'DELETE');
            setExcluir(null);
            await carregar();
          }}
          onCancelar={() => setExcluir(null)}
        />
      )}
      {erro && <AvisoErro mensagem={erro} onFechar={() => setErro('')} />}
    </div>
  );
}
