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
import { DateField } from '@/components/DateField';
import { api, dataBr, hojeIso, moeda } from '@/lib/api';
import type { ContaFinanceira } from '@/lib/financ';

const TIPOS: Record<string, string> = { caixa: 'Caixa', banco: 'Banco', carteira_digital: 'Carteira digital', adquirente: 'Adquirente (cartão)', aplicacao: 'Aplicação' };
type Form = Omit<ContaFinanceira, 'id' | 'saldo' | 'ativo'> & { id?: number; ativo: boolean | number };

/** Contas financeiras: caixa, bancos (ligados ao erp-bancos), carteiras; quem não está na lista de usuários não vê a conta */
export default function ContasPage() {
  const [linhas, setLinhas] = useState<ContaFinanceira[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [bancos, setBancos] = useState<any[]>([]);
  const [usuarios, setUsuarios] = useState<{ id: number; login: string }[]>([]);
  const [form, setForm] = useState<Form | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [erroForm, setErroForm] = useState('');
  const [erro, setErro] = useState('');
  const [excluir, setExcluir] = useState<ContaFinanceira | null>(null);

  const carregar = useCallback(async () => {
    try {
      setLinhas(await api<ContaFinanceira[]>('/api/financ/contas-financeiras'));
    } catch (e: any) {
      setErro(e.message);
    } finally {
      setCarregando(false);
    }
  }, []);
  useEffect(() => void carregar(), [carregar]);
  useEffect(() => {
    Promise.all([api<any[]>('/api/financ/ban-contas'), api<any[]>('/api/financ/usuarios')]).then(([b, u]) => (setBancos(b), setUsuarios(u))).catch((e) => setErro(e.message));
  }, []);
  useRefreshDaTela(carregar);

  const muda = (campo: keyof Form, valor: unknown) => setForm((f) => (f ? { ...f, [campo]: valor } : f));
  const abrir = (c: Form) => (setErroForm(''), setForm({ ...c }));
  const sel = (e: React.FocusEvent<HTMLInputElement>) => e.target.select();

  const salvar = async () => {
    if (!form) return;
    setSalvando(true);
    setErroForm('');
    try {
      const { id, ban_conta_descricao: _b, ...corpo } = form as Form & { ban_conta_descricao?: string };
      await api(id ? `/api/financ/contas-financeiras/${id}` : '/api/financ/contas-financeiras', id ? 'PATCH' : 'POST', { ...corpo, ativo: !!Number(corpo.ativo), chave_pix: corpo.chave_pix || null });
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
        <FormCrm id="contas" onSubmit={(e) => (e.preventDefault(), salvar())} onCancel={() => setForm(null)} saving={salvando} erro={erroForm} onFecharErro={() => setErroForm('')} rodape={form.id ? `Conta #${form.id}` : 'Inclusão'}>
          <Campo rotulo="Nome" span={2}>
            <input autoFocus required maxLength={80} value={form.nome} onFocus={sel} onChange={(e) => muda('nome', e.target.value)} className={INPUT_CLASS} />
          </Campo>
          <Campo rotulo="Tipo">
            <select required value={form.tipo} onChange={(e) => muda('tipo', e.target.value)} className={INPUT_CLASS}>
              {Object.entries(TIPOS).map(([v, r]) => <option key={v} value={v}>{r}</option>)}
            </select>
          </Campo>
          <Campo rotulo="Conta no erp-bancos" dica="Liga a conta à conciliação e aos boletos do erp-bancos">
            <select value={form.ban_conta_id ?? ''} onChange={(e) => muda('ban_conta_id', e.target.value ? Number(e.target.value) : null)} className={INPUT_CLASS}>
              <option value="">(nenhuma)</option>
              {bancos.map((b) => <option key={b.id} value={b.id}>{b.descricao} · {b.banco_codigo} ag. {b.agencia} c/c {b.conta}{b.conta_dv ? `-${b.conta_dv}` : ''}</option>)}
            </select>
          </Campo>
          <Campo rotulo="Chave Pix" span={2}>
            <input maxLength={77} value={form.chave_pix ?? ''} onFocus={sel} onChange={(e) => muda('chave_pix', e.target.value)} className={INPUT_CLASS} />
          </Campo>
          <Campo rotulo="Saldo inicial">
            <NumberField scale={2} allowNegative value={form.saldo_inicial} onChange={(v) => muda('saldo_inicial', v)} className={INPUT_CLASS} />
          </Campo>
          <Campo rotulo="Data do saldo inicial">
            <DateField required value={form.data_saldo_inicial} onChange={(v) => muda('data_saldo_inicial', v)} />
          </Campo>
          <Campo rotulo="Ativo"><Toggle checked={!!Number(form.ativo)} onChange={(v) => muda('ativo', v)} /></Campo>
          <Campo rotulo="Usuários com acesso" span={4} dica="Nenhum marcado = todos veem a conta. Administrador e quem tem a permissão Ver todas as contas sempre veem.">
            <div className="flex flex-wrap gap-x-5 gap-y-2 pt-1">
              {usuarios.map((u) => (
                <label key={u.id} className="flex items-center gap-2 text-xs">
                  <Toggle size="sm" checked={form.usuarios.includes(u.id)} onChange={(v) => muda('usuarios', v ? [...form.usuarios, u.id] : form.usuarios.filter((x) => x !== u.id))} />
                  {u.login}
                </label>
              ))}
            </div>
          </Campo>
        </FormCrm>
      ) : (
        <ListaCrm
          className="flex-1"
          id="contas"
          linhas={linhas}
          carregando={carregando}
          chave={(r) => r.id}
          onNovo={() => abrir({ nome: '', tipo: 'banco', ban_conta_id: null, chave_pix: '', saldo_inicial: '0.00', data_saldo_inicial: hojeIso(), ativo: true, usuarios: [] })}
          onEditar={(r) => abrir(r)}
          vazio="Nenhuma conta financeira."
          colunas={[
            { key: 'nome', label: 'Nome', largura: 220 },
            { key: 'tipo', label: 'Tipo', largura: 140, render: (r) => TIPOS[r.tipo] ?? r.tipo },
            { key: 'ban_conta_descricao', label: 'Conta bancária', largura: 200 },
            { key: 'data_saldo_inicial', label: 'Saldo inicial em', alinhar: 'centro', largura: 110, render: (r) => dataBr(r.data_saldo_inicial) },
            { key: 'saldo', label: 'Saldo hoje', alinhar: 'numero', largura: 120, render: (r) => <span className={Number(r.saldo) < 0 ? 'text-rose-600 font-semibold' : ''}>{moeda(r.saldo)}</span> },
            { key: 'usuarios', label: 'Acesso', largura: 110, render: (r) => (r.usuarios.length ? `${r.usuarios.length} usuário(s)` : 'Todos') },
            { key: 'ativo', label: 'Ativo', alinhar: 'centro', largura: 70, render: (r) => (Number(r.ativo) ? 'Sim' : 'Não') },
          ]}
          acoes={(r) => (
            <>
              <BotaoAcao icone={Pencil} titulo="Editar" descricao="Abre a conta para edição" onClick={() => abrir(r)} />
              {Number(r.ativo) ? <BotaoAcao icone={Trash2} titulo="Excluir" descricao="Inativa a conta (pede confirmação)" tom="perigo" onClick={() => setExcluir(r)} /> : <Vazio icone={Trash2} titulo="Excluir" />}
            </>
          )}
        />
      )}
      {excluir && (
        <ConfirmDialog
          titulo="Excluir conta financeira"
          mensagem={`Excluir “${excluir.nome}”? Ela fica inativa: some das baixas novas e os movimentos já feitos continuam nela.`}
          onConfirmar={async () => {
            await api(`/api/financ/contas-financeiras/${excluir.id}`, 'DELETE');
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
