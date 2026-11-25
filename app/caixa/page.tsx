import React, { useCallback, useEffect, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, FileText, Lock } from 'lucide-react';
import { useRefreshDaTela } from '@/components/LayoutApp';
import { ListaCrm } from '@/components/ListaCrm';
import { BotaoAcao, Vazio } from '@/components/MenuAcoes';
import { AvisoErro } from '@/components/AvisoErro';
import { NumberField } from '@/components/NumberField';
import { Janela } from '@/components/Janela';
import { Campo, GradeCampos, INPUT_CLASS } from '@/components/FormCrm';
import { api, dataBr, moeda } from '@/lib/api';
import { carregarApoio, Etiqueta, ORIGEM_MOV, somar, type Apoio } from '@/lib/financ';

const dataHora = (v: string | null) => (v ? new Date(v).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '');
const STATUS: Record<string, { rotulo: string; cor: string }> = {
  aberto: { rotulo: 'Aberto', cor: 'text-emerald-700 bg-emerald-50 dark:text-emerald-300 dark:bg-emerald-950/50' },
  fechado: { rotulo: 'Fechado', cor: 'text-stone-500 bg-stone-100 dark:text-stone-400 dark:bg-stone-800' },
};

/** Caixa: abertura com troco, suprimento, sangria e fechamento com contagem por forma (a diferença vira quebra de caixa) */
export default function CaixaPage() {
  const [linhas, setLinhas] = useState<any[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [apoio, setApoio] = useState<Apoio | null>(null);
  const [abrir, setAbrir] = useState(false);
  const [mover, setMover] = useState<{ sessao: any; acao: 'suprimento' | 'sangria' } | null>(null);
  const [fechar, setFechar] = useState<any>(null);
  const [detalhe, setDetalhe] = useState<number | null>(null);
  const [erro, setErro] = useState('');
  const [ok, setOk] = useState('');

  const carregar = useCallback(async () => {
    try {
      setLinhas(await api('/api/financ/caixa/sessoes'));
    } catch (e: any) {
      setErro(e.message);
    } finally {
      setCarregando(false);
    }
  }, []);
  useEffect(() => void carregar(), [carregar]);
  useEffect(() => void carregarApoio().then(setApoio).catch((e) => setErro(e.message)), []);
  useRefreshDaTela(carregar);
  const feito = (m: string) => (setOk(m), void carregar(), void carregarApoio().then(setApoio));
  const aberto = (r: any) => r.status === 'aberto';

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0">
      <ListaCrm
        className="flex-1"
        id="caixa_sessoes"
        linhas={linhas}
        carregando={carregando}
        chave={(r) => r.id}
        onNovo={() => setAbrir(true)}
        rotuloNovo="Abrir caixa"
        vazio="Nenhuma sessão de caixa. Abra o caixa numa conta do tipo caixa."
        colunas={[
          { key: 'id', label: 'Sessão', alinhar: 'numero', largura: 70 },
          { key: 'conta_nome', label: 'Caixa', largura: 160 },
          { key: 'status', label: 'Situação', largura: 90, render: (r) => <Etiqueta texto={STATUS[r.status]?.rotulo ?? r.status} cor={STATUS[r.status]?.cor ?? ''} /> },
          { key: 'operador_login', label: 'Operador', largura: 110 },
          { key: 'aberto_em', label: 'Aberto em', alinhar: 'centro', largura: 130, render: (r) => dataHora(r.aberto_em) },
          { key: 'valor_abertura', label: 'Troco', alinhar: 'numero', largura: 100, render: (r) => moeda(r.valor_abertura) },
          { key: 'saldo_atual', label: 'Saldo atual', alinhar: 'numero', largura: 110, render: (r) => (aberto(r) ? moeda(r.saldo_atual) : '') },
          { key: 'fechado_em', label: 'Fechado em', alinhar: 'centro', largura: 130, render: (r) => dataHora(r.fechado_em) },
          { key: 'valor_esperado', label: 'Esperado', alinhar: 'numero', largura: 100, render: (r) => (r.valor_esperado != null ? moeda(r.valor_esperado) : '') },
          { key: 'valor_contado', label: 'Contado', alinhar: 'numero', largura: 100, render: (r) => (r.valor_contado != null ? moeda(r.valor_contado) : '') },
          { key: 'diferenca', label: 'Quebra', alinhar: 'numero', largura: 90, render: (r) => (r.diferenca != null ? <span className={Number(r.diferenca) ? 'text-rose-600 font-semibold' : ''}>{moeda(r.diferenca)}</span> : '') },
          { key: 'fechado_por_login', label: 'Fechado por', largura: 110 },
        ]}
        acoes={(r) => (
          <>
            {aberto(r) ? <BotaoAcao icone={ArrowDownToLine} titulo="Suprimento" descricao="Dinheiro de outra conta (cofre, banco) para o caixa" tom="verde" onClick={() => setMover({ sessao: r, acao: 'suprimento' })} /> : <Vazio icone={ArrowDownToLine} titulo="Suprimento" />}
            {aberto(r) ? <BotaoAcao icone={ArrowUpFromLine} titulo="Sangria" descricao="Retirada do caixa para outra conta (cofre, banco)" onClick={() => setMover({ sessao: r, acao: 'sangria' })} /> : <Vazio icone={ArrowUpFromLine} titulo="Sangria" />}
            {aberto(r) ? <BotaoAcao icone={Lock} titulo="Fechar caixa" rotulo="Fechar" descricao="Contagem por forma; a diferença vira lançamento em Quebra de caixa" tom="perigo" onClick={() => setFechar(r)} /> : <Vazio icone={Lock} titulo="Fechar caixa" rotulo="Fechar" />}
            <BotaoAcao icone={FileText} titulo="Movimentos da sessão" rotulo="Detalhe" descricao="Recebimentos, suprimentos, sangrias e quebra" onClick={() => setDetalhe(r.id)} />
          </>
        )}
      />

      {abrir && apoio && <AbrirDialog apoio={apoio} onFechar={() => setAbrir(false)} onFeito={(m) => (setAbrir(false), feito(m))} />}
      {mover && apoio && <MoverDialog apoio={apoio} {...mover} onFechar={() => setMover(null)} onFeito={(m) => (setMover(null), feito(m))} />}
      {fechar && apoio && <FecharDialog apoio={apoio} sessao={fechar} onFechar={() => setFechar(null)} onFeito={(m) => (setFechar(null), feito(m))} />}
      {detalhe && <DetalheDialog id={detalhe} onFechar={() => setDetalhe(null)} />}
      {erro && <AvisoErro mensagem={erro} onFechar={() => setErro('')} />}
      {ok && <AvisoErro tom="sucesso" mensagem={ok} onFechar={() => setOk('')} />}
    </div>
  );
}

function AbrirDialog({ apoio, onFechar, onFeito }: { apoio: Apoio; onFechar: () => void; onFeito: (m: string) => void }) {
  const caixas = apoio.contas.filter((c) => c.tipo === 'caixa');
  const [conta, setConta] = useState<number | ''>(caixas.length === 1 ? caixas[0].id : '');
  const saldo = caixas.find((c) => c.id === conta)?.saldo ?? '';
  const [troco, setTroco] = useState(saldo);
  return (
    <Janela
      titulo="Abrir caixa"
      subtitulo="Informe o troco contado na abertura. O saldo do caixa só muda com movimentos (suprimento, recebimentos, sangria)."
      largura="max-w-lg"
      onFechar={onFechar}
      confirmar="Abrir"
      tom="verde"
      desabilitado={!conta}
      onConfirmar={async () => {
        const r = await api('/api/financ/caixa/sessoes', 'POST', { conta_financeira_id: conta, valor_abertura: troco || '0' });
        onFeito(`Caixa aberto (sessão #${r.id}).`);
      }}
    >
      <GradeCampos>
        <Campo rotulo="Caixa" span={2} dica={!caixas.length ? 'Cadastre uma conta financeira do tipo caixa.' : undefined}>
          <select autoFocus={!conta} required value={conta} onChange={(e) => { const id = e.target.value ? Number(e.target.value) : ''; setConta(id); setTroco(caixas.find((c) => c.id === id)?.saldo ?? ''); }} className={INPUT_CLASS}>
            <option value="">Escolha o caixa…</option>
            {caixas.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
          </select>
        </Campo>
        <Campo rotulo="Troco" span={2} dica={conta ? `Saldo do caixa: R$ ${moeda(saldo)}` : undefined}><NumberField autoFocus={!!conta} scale={2} value={troco} onChange={setTroco} className={INPUT_CLASS} /></Campo>
      </GradeCampos>
    </Janela>
  );
}

function MoverDialog({ apoio, sessao, acao, onFechar, onFeito }: { apoio: Apoio; sessao: any; acao: 'suprimento' | 'sangria'; onFechar: () => void; onFeito: (m: string) => void }) {
  const outras = apoio.contas.filter((c) => c.id !== sessao.conta_financeira_id);
  const [conta, setConta] = useState<number | ''>(outras.length === 1 ? outras[0].id : '');
  const [valor, setValor] = useState('');
  const [hist, setHist] = useState('');
  const sup = acao === 'suprimento';
  return (
    <Janela
      titulo={`${sup ? 'Suprimento' : 'Sangria'} · ${sessao.conta_nome}`}
      subtitulo={sup ? 'Transferência de outra conta para o caixa, hoje.' : `Transferência do caixa para outra conta, hoje. Saldo do caixa: R$ ${moeda(sessao.saldo_atual)}.`}
      largura="max-w-lg"
      onFechar={onFechar}
      confirmar={sup ? 'Suprir' : 'Retirar'}
      desabilitado={!conta || !Number(valor)}
      onConfirmar={async () => {
        await api(`/api/financ/caixa/sessoes/${sessao.id}/${acao}`, 'POST', { conta_id: conta, valor, historico: hist || null });
        onFeito(sup ? 'Suprimento lançado.' : 'Sangria lançada.');
      }}
    >
      <GradeCampos>
        <Campo rotulo={sup ? 'De (conta)' : 'Para (conta)'} span={2}>
          <select autoFocus={!conta} required value={conta} onChange={(e) => setConta(e.target.value ? Number(e.target.value) : '')} className={INPUT_CLASS}>
            <option value="">Escolha…</option>
            {outras.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
          </select>
        </Campo>
        <Campo rotulo="Valor" span={2}><NumberField autoFocus={!!conta} required scale={2} value={valor} onChange={setValor} className={INPUT_CLASS} /></Campo>
        <Campo rotulo="Histórico" span={4}><input maxLength={255} value={hist} onChange={(e) => setHist(e.target.value)} onFocus={(e) => e.target.select()} className={INPUT_CLASS} /></Campo>
      </GradeCampos>
    </Janela>
  );
}

function FecharDialog({ apoio, sessao, onFechar, onFeito }: { apoio: Apoio; sessao: any; onFechar: () => void; onFeito: (m: string) => void }) {
  // Formas que caem neste caixa; sem nenhuma ligada, conta-se só o dinheiro
  const formas = apoio.formas.filter((f) => f.conta_financeira_id === sessao.conta_financeira_id).map((f) => f.nome);
  const [contagem, setContagem] = useState<{ forma: string; valor: string }[]>((formas.length ? formas : ['Dinheiro']).map((forma) => ({ forma, valor: '' })));
  const contado = somar(contagem.map((c) => c.valor));
  const diferenca = Math.round((contado - Number(sessao.saldo_atual)) * 100) / 100;
  return (
    <Janela
      titulo={`Fechar caixa · ${sessao.conta_nome} (sessão #${sessao.id})`}
      subtitulo={`Esperado (saldo do caixa): R$ ${moeda(sessao.saldo_atual)}. A diferença vira lançamento em Quebra de caixa, com o operador ${sessao.operador_login ?? ''}.`}
      largura="max-w-lg"
      onFechar={onFechar}
      confirmar="Fechar caixa"
      tom="perigo"
      onConfirmar={async () => {
        const r = await api(`/api/financ/caixa/sessoes/${sessao.id}/fechar`, 'POST', { contagem: contagem.map((c) => ({ forma: c.forma, valor: c.valor || '0' })) });
        onFeito(Number(r.diferenca) ? `Caixa fechado com quebra de R$ ${moeda(r.diferenca)}.` : 'Caixa fechado sem diferença.');
      }}
    >
      <div className="space-y-3">
        {contagem.map((c, i) => (
          <Campo key={c.forma} rotulo={`Contado em ${c.forma}`}>
            <NumberField autoFocus={i === 0} scale={2} value={c.valor} onChange={(v) => setContagem(contagem.map((x, j) => (j === i ? { ...x, valor: v } : x)))} className={INPUT_CLASS} />
          </Campo>
        ))}
        <div className="flex justify-between text-sm border-t border-stone-200 dark:border-stone-800 pt-2">
          <span>Contado <b className="tabular-nums">R$ {moeda(contado)}</b></span>
          <span>Diferença <b className={`tabular-nums ${diferenca ? 'text-rose-600' : 'text-emerald-600'}`}>R$ {moeda(diferenca)}</b></span>
        </div>
      </div>
    </Janela>
  );
}

function DetalheDialog({ id, onFechar }: { id: number; onFechar: () => void }) {
  const [x, setX] = useState<any>(null);
  const [erro, setErro] = useState('');
  useEffect(() => void api(`/api/financ/caixa/sessoes/${id}`).then(setX).catch((e) => setErro(e.message)), [id]);
  return (
    <Janela titulo={`Sessão de caixa #${id}`} subtitulo={x ? `Troco R$ ${moeda(x.valor_abertura)} · saldo atual R$ ${moeda(x.saldo_atual)}` : ''} largura="max-w-4xl" onFechar={onFechar}>
      <ListaCrm<any>
        id="caixa_movimentos"
        className="max-h-[60vh]"
        linhas={x?.movimentos ?? []}
        carregando={!x && !erro}
        chave={(r) => r.id}
        paginar={false}
        vazio="Nenhum movimento nesta sessão."
        colunas={[
          { key: 'data', label: 'Data', alinhar: 'centro', largura: 92, render: (r) => dataBr(r.data) },
          { key: 'historico', label: 'Histórico', largura: 300 },
          { key: 'origem', label: 'Origem', largura: 120, render: (r) => ORIGEM_MOV[r.origem] ?? r.origem },
          { key: 'entrada', label: 'Entrada', alinhar: 'numero', largura: 110, render: (r) => (r.tipo === 'entrada' ? moeda(r.valor) : '') },
          { key: 'saida', label: 'Saída', alinhar: 'numero', largura: 110, render: (r) => (r.tipo === 'saida' ? moeda(r.valor) : '') },
          { key: 'usuario_login', label: 'Usuário', largura: 100 },
        ]}
      />
      {erro && <AvisoErro mensagem={erro} onFechar={() => setErro('')} />}
      {x?.contagem && <p className="mt-2 text-xs text-stone-500">Contagem: {(typeof x.contagem === 'string' ? JSON.parse(x.contagem) : x.contagem).map((c: any) => `${c.forma} R$ ${moeda(c.valor)}`).join(' · ')}</p>}
    </Janela>
  );
}
