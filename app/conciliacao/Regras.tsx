import React, { useCallback, useEffect, useState } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { useRefreshDaTela } from '@/components/LayoutApp';
import { ListaCrm } from '@/components/ListaCrm';
import { BotaoAcao, SeparadorAcoes } from '@/components/MenuAcoes';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { AvisoErro } from '@/components/AvisoErro';
import { Toggle } from '@/components/Toggle';
import { Janela } from '@/components/Janela';
import { CampoPesquisa } from '@/components/CampoPesquisa';
import { PesquisaCatalogo } from '@/components/PesquisaCatalogo';
import { Campo, GradeCampos, INPUT_CLASS } from '@/components/FormCrm';
import { api } from '@/lib/api';
import { carregarApoio, opcoesCentro, opcoesPlano, type Apoio } from '@/lib/financ';

export const CAMPOS: Record<string, string> = { historico: 'Histórico', documento: 'Documento', valor: 'Valor' };
export const OPERADORES: Record<string, string> = { contem: 'contém', igual: 'igual a', comeca_com: 'começa com', regex: 'expressão regular', entre: 'entre (mín;máx)' };
export const SENTIDOS: Record<string, string> = { ambos: 'Entradas e saídas', entrada: 'Só entradas', saida: 'Só saídas' };

export interface Regra {
  id?: number; nome: string; conta_financeira_id: number | null; campo: string; operador: string; texto: string; sentido: string;
  plano_conta_id: number | null; centro_custo_id: number | null; pessoa_id: number | null; pessoa_nome?: string | null; prioridade: number; ativo: number;
}
export const regraNova = (x: Partial<Regra> = {}): Regra => ({ nome: '', conta_financeira_id: null, campo: 'historico', operador: 'contem', texto: '', sentido: 'ambos', plano_conta_id: null, centro_custo_id: null, pessoa_id: null, prioridade: 100, ativo: 1, ...x });

/** Regras de conciliação: casam linhas do extrato por histórico, documento ou valor, por prioridade (menor primeiro) */
export default function RegrasPage() {
  const [linhas, setLinhas] = useState<any[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [apoio, setApoio] = useState<Apoio | null>(null);
  const [editar, setEditar] = useState<Regra | null>(null);
  const [excluir, setExcluir] = useState<any>(null);
  const [erro, setErro] = useState('');
  const [ok, setOk] = useState('');

  const carregar = useCallback(async () => {
    try {
      setLinhas(await api('/api/financ/regras-conciliacao'));
    } catch (e: any) {
      setErro(e.message);
    } finally {
      setCarregando(false);
    }
  }, []);
  useEffect(() => void carregar(), [carregar]);
  useEffect(() => void carregarApoio().then(setApoio).catch((e) => setErro(e.message)), []);
  useRefreshDaTela(carregar);
  const feito = (m: string) => (setOk(m), void carregar());

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0">
      <ListaCrm
        className="flex-1"
        id="regras_conciliacao"
        linhas={linhas}
        carregando={carregando}
        chave={(r) => r.id}
        onNovo={() => setEditar(regraNova())}
        rotuloNovo="Nova regra"
        onEditar={(r) => setEditar(r)}
        vazio="Nenhuma regra. Crie aqui ou salve uma conciliação manual como regra."
        colunas={[
          { key: 'prioridade', label: 'Prior.', alinhar: 'numero', largura: 60 },
          { key: 'nome', label: 'Nome', largura: 180 },
          { key: 'condicao', label: 'Condição', largura: 280, render: (r) => `${CAMPOS[r.campo]} ${OPERADORES[r.operador]} "${r.texto}"` },
          { key: 'sentido', label: 'Sentido', largura: 120, render: (r) => SENTIDOS[r.sentido] },
          { key: 'conta_nome', label: 'Conta', largura: 130, render: (r) => r.conta_nome ?? 'Todas' },
          { key: 'pessoa_nome', label: 'Pessoa', largura: 170 },
          { key: 'plano_nome', label: 'Conta do plano', largura: 190 },
          { key: 'centro_nome', label: 'Centro', largura: 140 },
          { key: 'ativo', label: 'Ativa', alinhar: 'centro', largura: 60, render: (r) => (Number(r.ativo) ? 'Sim' : 'Não') },
        ]}
        acoes={(r) => (
          <>
            <BotaoAcao icone={Pencil} titulo="Editar" descricao="Condição, prioridade e o que a regra faz" onClick={() => setEditar(r)} />
            <SeparadorAcoes />
            <BotaoAcao icone={Trash2} titulo="Excluir" tom="perigo" descricao="Apaga a regra (pede confirmação)" onClick={() => setExcluir(r)} />
          </>
        )}
      />
      {editar && apoio && <RegraDialog apoio={apoio} inicial={editar} onFechar={() => setEditar(null)} onFeito={() => (setEditar(null), feito('Regra gravada.'))} />}
      {excluir && (
        <ConfirmDialog
          titulo="Excluir regra"
          mensagem={`Excluir a regra "${excluir.nome}"? As conciliações já feitas por ela continuam.`}
          confirmar="Excluir"
          onConfirmar={async () => {
            await api(`/api/financ/regras-conciliacao/${excluir.id}`, 'DELETE');
            setExcluir(null);
            feito('Regra excluída.');
          }}
          onCancelar={() => setExcluir(null)}
        />
      )}
      {erro && <AvisoErro mensagem={erro} onFechar={() => setErro('')} />}
      {ok && <AvisoErro tom="sucesso" mensagem={ok} onFechar={() => setOk('')} />}
    </div>
  );
}

/** Inclusão/edição de regra (também o "salvar como regra" da conciliação manual) */
export function RegraDialog({ apoio, inicial, onFechar, onFeito, titulo }: { apoio: Apoio; inicial: Regra; onFechar: () => void; onFeito: () => void; titulo?: string }) {
  const [d, setD] = useState<Regra>(inicial);
  const [pesquisa, setPesquisa] = useState(false);
  const mudar = (x: Partial<Regra>) => setD({ ...d, ...x });
  const num = (v: string) => (v ? Number(v) : null);
  return (
    <Janela
      titulo={titulo ?? (d.id ? 'Editar regra de conciliação' : 'Nova regra de conciliação')}
      subtitulo="Com conta do plano e centro, a linha que casar vira lançamento direto; com pessoa, casa com o movimento dela de mesmo valor."
      largura="max-w-3xl"
      onFechar={onFechar}
      confirmar="Gravar regra"
      desabilitado={!d.nome.trim() || !d.texto.trim() || (!d.pessoa_id && (!d.plano_conta_id || !d.centro_custo_id))}
      onConfirmar={async () => {
        const { id, pessoa_nome: _p, ...corpo } = d;
        await api(id ? `/api/financ/regras-conciliacao/${id}` : '/api/financ/regras-conciliacao', id ? 'PATCH' : 'POST', corpo);
        onFeito();
      }}
    >
      <GradeCampos>
        <Campo rotulo="Nome" span={2}><input autoFocus={!d.nome} required maxLength={80} value={d.nome} onChange={(e) => mudar({ nome: e.target.value })} onFocus={(e) => e.target.select()} className={INPUT_CLASS} /></Campo>
        <Campo rotulo="Conta financeira">
          <select value={d.conta_financeira_id ?? ''} onChange={(e) => mudar({ conta_financeira_id: num(e.target.value) })} className={INPUT_CLASS}>
            <option value="">Todas</option>
            {apoio.contas.filter((c) => c.ban_conta_id).map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
          </select>
        </Campo>
        <Campo rotulo="Prioridade" dica="Menor primeiro"><input type="number" min={0} max={9999} value={d.prioridade} onChange={(e) => mudar({ prioridade: Number(e.target.value) || 0 })} onFocus={(e) => e.target.select()} className={`${INPUT_CLASS} text-right`} /></Campo>
        <Campo rotulo="Campo">
          <select value={d.campo} onChange={(e) => mudar({ campo: e.target.value, operador: e.target.value === 'valor' ? 'entre' : d.operador === 'entre' ? 'contem' : d.operador })} className={INPUT_CLASS}>
            {Object.entries(CAMPOS).map(([v, r]) => <option key={v} value={v}>{r}</option>)}
          </select>
        </Campo>
        <Campo rotulo="Operador">
          <select value={d.operador} onChange={(e) => mudar({ operador: e.target.value })} className={INPUT_CLASS}>
            {Object.entries(OPERADORES).filter(([v]) => (d.campo === 'valor' ? v === 'entre' || v === 'igual' : v !== 'entre')).map(([v, r]) => <option key={v} value={v}>{r}</option>)}
          </select>
        </Campo>
        <Campo rotulo="Texto" span={2} dica={d.campo === 'valor' ? 'Valor em módulo: 12,50 ou, no "entre", 10,00;20,00' : undefined}>
          <input autoFocus={!!d.nome && !d.texto} required maxLength={255} value={d.texto} onChange={(e) => mudar({ texto: e.target.value })} onFocus={(e) => e.target.select()} className={INPUT_CLASS} />
        </Campo>
        <Campo rotulo="Sentido">
          <select value={d.sentido} onChange={(e) => mudar({ sentido: e.target.value })} className={INPUT_CLASS}>
            {Object.entries(SENTIDOS).map(([v, r]) => <option key={v} value={v}>{r}</option>)}
          </select>
        </Campo>
        <Campo rotulo="Pessoa" span={3}>
          <CampoPesquisa texto={d.pessoa_nome ?? undefined} vazio="(nenhuma)" onAbrir={() => setPesquisa(true)} onLimpar={() => mudar({ pessoa_id: null, pessoa_nome: null })} />
        </Campo>
        <Campo rotulo="Conta do plano" span={2}>
          <select value={d.plano_conta_id ?? ''} onChange={(e) => mudar({ plano_conta_id: num(e.target.value) })} className={INPUT_CLASS} data-obrigatorio={!d.pessoa_id ? '' : undefined}>
            <option value="">(nenhuma)</option>
            {opcoesPlano(apoio)}
          </select>
        </Campo>
        <Campo rotulo="Centro de custo" span={2}>
          <select value={d.centro_custo_id ?? ''} onChange={(e) => mudar({ centro_custo_id: num(e.target.value) })} className={INPUT_CLASS} data-obrigatorio={!d.pessoa_id ? '' : undefined}>
            <option value="">(nenhum)</option>
            {opcoesCentro(apoio)}
          </select>
        </Campo>
        <Campo rotulo="Ativa"><Toggle checked={!!d.ativo} onChange={(v) => mudar({ ativo: v ? 1 : 0 })} /></Campo>
      </GradeCampos>
      {pesquisa && (
        <PesquisaCatalogo
          tipo={d.sentido === 'saida' ? 'fornecedores' : 'clientes'}
          titulo="Pessoa da regra"
          onEscolher={(l: any) => (mudar({ pessoa_id: Number(l.id), pessoa_nome: l.nome }), setPesquisa(false))}
          onFechar={() => setPesquisa(false)}
        />
      )}
    </Janela>
  );
}
