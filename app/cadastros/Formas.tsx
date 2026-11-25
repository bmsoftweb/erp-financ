import React, { useCallback, useEffect, useState } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { useRefreshDaTela } from '@/components/LayoutApp';
import { ListaCrm } from '@/components/ListaCrm';
import { FormCrm, Campo, INPUT_CLASS } from '@/components/FormCrm';
import { BotaoAcao, Vazio } from '@/components/MenuAcoes';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { AvisoErro } from '@/components/AvisoErro';
import { Toggle } from '@/components/Toggle';
import { NumberField } from '@/components/NumberField';
import { api, moeda } from '@/lib/api';
import type { ContaFinanceira, Forma } from '@/lib/financ';

const TIPOS: Record<string, string> = { dinheiro: 'Dinheiro', boleto: 'Boleto', pix: 'Pix', cartao_credito: 'Cartão de crédito', cartao_debito: 'Cartão de débito', transferencia: 'Transferência', cheque: 'Cheque', credito_pessoa: 'Crédito do cliente', outro: 'Outro' };
type Form = Omit<Forma, 'id' | 'ativo' | 'gera_recebivel_adquirente'> & { id?: number; ativo: boolean | number; gera_recebivel_adquirente: boolean | number };

/** Formas de pagamento: conta padrão, taxa e D+n (dias até o dinheiro cair na conta) */
export default function FormasPage() {
  const [linhas, setLinhas] = useState<Forma[]>([]);
  const [contas, setContas] = useState<ContaFinanceira[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [form, setForm] = useState<Form | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [erroForm, setErroForm] = useState('');
  const [erro, setErro] = useState('');
  const [excluir, setExcluir] = useState<Forma | null>(null);

  const carregar = useCallback(async () => {
    try {
      const [f, c] = await Promise.all([api<Forma[]>('/api/financ/formas-pagamento'), api<ContaFinanceira[]>('/api/financ/contas-financeiras')]);
      setLinhas(f);
      setContas(c.filter((x) => Number(x.ativo)));
    } catch (e: any) {
      setErro(e.message);
    } finally {
      setCarregando(false);
    }
  }, []);
  useEffect(() => void carregar(), [carregar]);
  useRefreshDaTela(carregar);

  const muda = (campo: keyof Form, valor: unknown) => setForm((f) => (f ? { ...f, [campo]: valor } : f));
  const abrir = (f: Form) => (setErroForm(''), setForm({ ...f }));
  const sel = (e: React.FocusEvent<HTMLInputElement>) => e.target.select();

  const salvar = async () => {
    if (!form) return;
    setSalvando(true);
    setErroForm('');
    try {
      const { id, conta_nome: _c, ...corpo } = form;
      await api(id ? `/api/financ/formas-pagamento/${id}` : '/api/financ/formas-pagamento', id ? 'PATCH' : 'POST', { ...corpo, ativo: !!Number(corpo.ativo), gera_recebivel_adquirente: !!Number(corpo.gera_recebivel_adquirente) });
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
        <FormCrm id="formas" onSubmit={(e) => (e.preventDefault(), salvar())} onCancel={() => setForm(null)} saving={salvando} erro={erroForm} onFecharErro={() => setErroForm('')} rodape={form.id ? `Forma #${form.id}` : 'Inclusão'}>
          <Campo rotulo="Nome">
            <input autoFocus required maxLength={30} value={form.nome} onFocus={sel} onChange={(e) => muda('nome', e.target.value)} className={INPUT_CLASS} />
          </Campo>
          <Campo rotulo="Tipo">
            <select required value={form.tipo} onChange={(e) => muda('tipo', e.target.value)} className={INPUT_CLASS}>
              {Object.entries(TIPOS).map(([v, r]) => <option key={v} value={v}>{r}</option>)}
            </select>
          </Campo>
          <Campo rotulo="Conta padrão" span={2}>
            <select value={form.conta_financeira_id ?? ''} onChange={(e) => muda('conta_financeira_id', e.target.value ? Number(e.target.value) : null)} className={INPUT_CLASS}>
              <option value="">(escolher na baixa)</option>
              {contas.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
            </select>
          </Campo>
          <Campo rotulo="Taxa (%)"><NumberField scale={2} value={form.taxa_pct} onChange={(v) => muda('taxa_pct', v)} className={INPUT_CLASS} /></Campo>
          <Campo rotulo="Taxa fixa (R$)"><NumberField scale={2} value={form.taxa_fixa} onChange={(v) => muda('taxa_fixa', v)} className={INPUT_CLASS} /></Campo>
          <Campo rotulo="Dias para crédito (D+n)" dica="Data da conta = data do pagamento + n dias (recebimentos)">
            <NumberField scale={0} value={String(form.dias_credito)} onChange={(v) => muda('dias_credito', Number(v) || 0)} className={INPUT_CLASS} />
          </Campo>
          <Campo rotulo="Gera recebível de adquirente"><Toggle checked={!!Number(form.gera_recebivel_adquirente)} onChange={(v) => muda('gera_recebivel_adquirente', v)} /></Campo>
          <Campo rotulo="Ativo"><Toggle checked={!!Number(form.ativo)} onChange={(v) => muda('ativo', v)} /></Campo>
        </FormCrm>
      ) : (
        <ListaCrm
          className="flex-1"
          id="formas"
          linhas={linhas}
          carregando={carregando}
          chave={(r) => r.id}
          onNovo={() => abrir({ nome: '', tipo: 'pix', conta_financeira_id: null, taxa_pct: '0.00', taxa_fixa: '0.00', dias_credito: 0, gera_recebivel_adquirente: false, ativo: true })}
          onEditar={(r) => abrir(r)}
          vazio="Nenhuma forma de pagamento."
          colunas={[
            { key: 'nome', label: 'Nome', largura: 180 },
            { key: 'tipo', label: 'Tipo', largura: 150, render: (r) => TIPOS[r.tipo] ?? r.tipo },
            { key: 'conta_nome', label: 'Conta padrão', largura: 180 },
            { key: 'taxa_pct', label: 'Taxa %', alinhar: 'numero', largura: 80, render: (r) => moeda(r.taxa_pct) },
            { key: 'taxa_fixa', label: 'Taxa R$', alinhar: 'numero', largura: 90, render: (r) => moeda(r.taxa_fixa) },
            { key: 'dias_credito', label: 'D+n', alinhar: 'numero', largura: 60 },
            { key: 'ativo', label: 'Ativo', alinhar: 'centro', largura: 70, render: (r) => (Number(r.ativo) ? 'Sim' : 'Não') },
          ]}
          acoes={(r) => (
            <>
              <BotaoAcao icone={Pencil} titulo="Editar" descricao="Abre a forma para edição" onClick={() => abrir(r)} />
              {Number(r.ativo) ? <BotaoAcao icone={Trash2} titulo="Excluir" descricao="Inativa a forma (pede confirmação)" tom="perigo" onClick={() => setExcluir(r)} /> : <Vazio icone={Trash2} titulo="Excluir" />}
            </>
          )}
        />
      )}
      {excluir && (
        <ConfirmDialog
          titulo="Excluir forma de pagamento"
          mensagem={`Excluir “${excluir.nome}”? Ela fica inativa: some das escolhas novas e os títulos que já a usam continuam com ela.`}
          onConfirmar={async () => {
            await api(`/api/financ/formas-pagamento/${excluir.id}`, 'DELETE');
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
