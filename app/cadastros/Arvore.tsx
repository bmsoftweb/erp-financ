import React, { useCallback, useEffect, useState } from 'react';
import { CornerDownRight, Pencil, Trash2 } from 'lucide-react';
import { useRefreshDaTela } from '@/components/LayoutApp';
import { ListaCrm } from '@/components/ListaCrm';
import { FormCrm, Campo, INPUT_CLASS } from '@/components/FormCrm';
import { BotaoAcao, SeparadorAcoes, Vazio } from '@/components/MenuAcoes';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { AvisoErro } from '@/components/AvisoErro';
import { Toggle } from '@/components/Toggle';
import { api } from '@/lib/api';
import { nivel } from '@/lib/financ';

interface No { id?: number; codigo: string; descricao: string; tipo?: string | null; analitica?: number | boolean; analitico?: number | boolean; ativo: number | boolean; pai_id?: number | null }

const TIPOS: Record<string, string> = { receita: 'Receita', despesa: 'Despesa', transferencia: 'Transferência' };

/** Próximo código livre abaixo de um pai: 1.1 → 1.1.01, 1.1.02… */
function proximoCodigo(pai: No, linhas: No[]) {
  const filhos = linhas.filter((l) => l.codigo.startsWith(`${pai.codigo}.`) && nivel(l.codigo) === nivel(pai.codigo) + 1);
  const n = filhos.reduce((m, l) => Math.max(m, Number(l.codigo.split('.').pop())), 0) + 1;
  return `${pai.codigo}.${String(n).padStart(nivel(pai.codigo) >= 1 ? 2 : 1, '0')}`;
}

/** Plano de contas e centros de custo: árvore pelo código (o pai vem do prefixo) */
export default function ArvorePage({ tipo }: { tipo: 'plano' | 'centros' }) {
  const plano = tipo === 'plano';
  const caminho = plano ? 'plano-contas' : 'centros-custo';
  const flag = plano ? 'analitica' : 'analitico';
  const nome = plano ? 'conta' : 'centro de custo';
  const [linhas, setLinhas] = useState<No[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [form, setForm] = useState<No | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [erroForm, setErroForm] = useState('');
  const [erro, setErro] = useState('');
  const [excluir, setExcluir] = useState<No | null>(null);

  const carregar = useCallback(async () => {
    try {
      setLinhas(await api<No[]>(`/api/financ/${caminho}`));
    } catch (e: any) {
      setErro(e.message);
    } finally {
      setCarregando(false);
    }
  }, [caminho]);
  useEffect(() => void carregar(), [carregar]);
  useRefreshDaTela(carregar);

  const muda = (campo: keyof No, valor: unknown) => setForm((f) => (f ? { ...f, [campo]: valor } : f));
  const abrir = (n: No) => (setErroForm(''), setForm({ ...n }));
  const raiz = (c: string) => !c.includes('.');

  const salvar = async () => {
    if (!form) return;
    setSalvando(true);
    setErroForm('');
    try {
      const corpo = { codigo: form.codigo, descricao: form.descricao, tipo: plano ? form.tipo || null : undefined, [flag]: !!Number(form[flag]), ativo: !!Number(form.ativo) };
      await api(form.id ? `/api/financ/${caminho}/${form.id}` : `/api/financ/${caminho}`, form.id ? 'PATCH' : 'POST', corpo);
      setForm(null);
      await carregar();
    } catch (e: any) {
      setErroForm(e.message);
    } finally {
      setSalvando(false);
    }
  };

  const sel = (e: React.FocusEvent<HTMLInputElement>) => e.target.select();

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0">
      {form ? (
        <FormCrm id={caminho} onSubmit={(e) => (e.preventDefault(), salvar())} onCancel={() => setForm(null)} saving={salvando} erro={erroForm} onFecharErro={() => setErroForm('')} rodape={form.id ? `${plano ? 'Conta' : 'Centro'} #${form.id}` : 'Inclusão'}>
          <Campo rotulo="Código" dica="Números separados por ponto; o pai é o código sem o último trecho (1.1.01 fica abaixo de 1.1)">
            <input required disabled={!!form.id} autoFocus={!form.id && !form.codigo} maxLength={30} value={form.codigo} onFocus={sel} onChange={(e) => muda('codigo', e.target.value.replace(/[^\d.]/g, ''))} className={INPUT_CLASS} />
          </Campo>
          <Campo rotulo="Descrição" span={2}>
            <input required autoFocus={!!form.codigo} maxLength={120} value={form.descricao} onFocus={sel} onChange={(e) => muda('descricao', e.target.value)} className={INPUT_CLASS} />
          </Campo>
          {plano && raiz(form.codigo) && (
            <Campo rotulo="Tipo" dica="As subcontas herdam o tipo do grupo">
              <select required value={form.tipo ?? ''} onChange={(e) => muda('tipo', e.target.value)} className={INPUT_CLASS}>
                <option value="">Escolha…</option>
                {Object.entries(TIPOS).map(([v, r]) => <option key={v} value={v}>{r}</option>)}
              </select>
            </Campo>
          )}
          <Campo rotulo={plano ? 'Analítica (recebe lançamentos)' : 'Analítico (recebe lançamentos)'}>
            <Toggle checked={!!Number(form[flag])} onChange={(v) => muda(flag, v)} />
          </Campo>
          <Campo rotulo="Ativo"><Toggle checked={!!Number(form.ativo)} onChange={(v) => muda('ativo', v)} /></Campo>
        </FormCrm>
      ) : (
        <ListaCrm
          className="flex-1"
          id={caminho}
          linhas={linhas}
          carregando={carregando}
          ordenavel={false}
          chave={(r) => r.id!}
          onNovo={() => abrir({ codigo: '', descricao: '', tipo: plano ? '' : undefined, [flag]: false, ativo: true })}
          rotuloNovo={plano ? 'Novo grupo' : 'Novo'}
          onEditar={abrir}
          vazio={plano ? 'Nenhuma conta. Crie os cadastros padrão em Parâmetros.' : 'Nenhum centro de custo.'}
          colunas={[
            { key: 'codigo', label: 'Código', largura: 120 },
            { key: 'descricao', label: 'Descrição', largura: 340, render: (r) => <span style={{ paddingLeft: nivel(r.codigo) * 16 }} className={Number(r[flag]) ? '' : 'font-semibold'}>{r.descricao}</span> },
            ...(plano ? [{ key: 'tipo', label: 'Tipo', largura: 110, render: (r: No) => TIPOS[r.tipo ?? ''] ?? '' }] : []),
            { key: flag, label: plano ? 'Analítica' : 'Analítico', alinhar: 'centro' as const, largura: 80, render: (r) => (Number(r[flag]) ? 'Sim' : 'Não') },
            { key: 'ativo', label: 'Ativo', alinhar: 'centro' as const, largura: 70, render: (r) => (Number(r.ativo) ? 'Sim' : 'Não') },
          ]}
          acoes={(r) => (
            <>
              <BotaoAcao icone={CornerDownRight} titulo={plano ? 'Nova subconta' : 'Novo subcentro'} descricao={`Cria abaixo de ${r.codigo}`} onClick={() => abrir({ codigo: proximoCodigo(r, linhas), descricao: '', tipo: r.tipo, [flag]: true, ativo: true })} />
              <SeparadorAcoes />
              <BotaoAcao icone={Pencil} titulo="Editar" descricao={`Abre ${plano ? 'a conta' : 'o centro'} para edição`} onClick={() => abrir(r)} />
              {Number(r.ativo) ? <BotaoAcao icone={Trash2} titulo="Excluir" descricao="Inativa (pede confirmação)" tom="perigo" onClick={() => setExcluir(r)} /> : <Vazio icone={Trash2} titulo="Excluir" />}
            </>
          )}
        />
      )}
      {excluir && (
        <ConfirmDialog
          titulo={`Excluir ${nome}`}
          mensagem={`Excluir “${excluir.codigo} ${excluir.descricao}”? Fica inativ${plano ? 'a' : 'o'}: some das escolhas novas e os lançamentos já feitos continuam com ${plano ? 'ela' : 'ele'}.`}
          onConfirmar={async () => {
            await api(`/api/financ/${caminho}/${excluir.id}`, 'DELETE');
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
