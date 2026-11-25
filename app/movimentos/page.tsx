import React, { useCallback, useEffect, useState } from 'react';
import { ArrowLeftRight, CheckCircle2, PlusCircle, Undo2 } from 'lucide-react';
import { useRefreshDaTela } from '@/components/LayoutApp';
import { ListaCrm } from '@/components/ListaCrm';
import { BotaoAcao, Vazio } from '@/components/MenuAcoes';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { AvisoErro } from '@/components/AvisoErro';
import { DateField } from '@/components/DateField';
import { NumberField } from '@/components/NumberField';
import { Janela } from '@/components/Janela';
import { Campo, GradeCampos, INPUT_CLASS } from '@/components/FormCrm';
import { api, dataBr, hojeIso, moeda } from '@/lib/api';
import { carregarApoio, inicioMes, opcoesCentro, opcoesPlano, ORIGEM_MOV, somar, type Apoio } from '@/lib/financ';

const BOTAO = 'h-[34px] flex items-center gap-1.5 px-3 rounded-lg text-xs font-semibold cursor-pointer border border-stone-300 dark:border-stone-700 text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800';
const ESTORNAVEL = ['lancamento_direto', 'transferencia', 'caixa'];

/** Movimento de contas: extrato do sistema com saldo, lançamento direto, transferência e estorno */
export default function MovimentosPage() {
  const hoje = hojeIso();
  const [conta, setConta] = useState<number | ''>('');
  const [de, setDe] = useState(inicioMes(hoje));
  const [ate, setAte] = useState(hoje);
  const [dados, setDados] = useState<{ saldo_anterior: string; saldo_final: string; linhas: any[] }>({ saldo_anterior: '0', saldo_final: '0', linhas: [] });
  const [carregando, setCarregando] = useState(true);
  const [apoio, setApoio] = useState<Apoio | null>(null);
  const [direto, setDireto] = useState(false);
  const [transferir, setTransferir] = useState(false);
  const [estornar, setEstornar] = useState<any>(null);
  const [erro, setErro] = useState('');
  const [ok, setOk] = useState('');

  const carregar = useCallback(async () => {
    try {
      const q = new URLSearchParams({ ...(conta ? { conta: String(conta) } : {}), ...(de ? { de } : {}), ...(ate ? { ate } : {}) });
      setDados(await api(`/api/financ/movimentos?${q}`));
    } catch (e: any) {
      setErro(e.message);
    } finally {
      setCarregando(false);
    }
  }, [conta, de, ate]);
  useEffect(() => void carregar(), [carregar]);
  useEffect(() => void carregarApoio().then(setApoio).catch((e) => setErro(e.message)), []);
  useRefreshDaTela(carregar);
  const feito = (m: string) => (setOk(m), void carregar());

  const linhas = dados.linhas;
  const riscado = (r: any) => (r.estornado || r.estorno_de_id ? 'line-through text-stone-400' : '');
  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0">
      <ListaCrm
        className="flex-1"
        id="movimentos"
        linhas={linhas}
        carregando={carregando}
        chave={(r) => r.id}
        ordenavel={false}
        vazio="Nenhum movimento no período."
        rodape={(k) => (k === 'entrada' ? moeda(somar(linhas.filter((l) => l.tipo === 'entrada').map((l) => l.valor))) : k === 'saida' ? moeda(somar(linhas.filter((l) => l.tipo === 'saida').map((l) => l.valor))) : k === 'saldo' ? moeda(dados.saldo_final) : null)}
        barraExtra={(
          <div className="flex flex-wrap items-center gap-2">
            <select value={conta} onChange={(e) => setConta(e.target.value ? Number(e.target.value) : '')} className={`${INPUT_CLASS} w-52`} title="Conta financeira">
              <option value="">Todas as contas</option>
              {apoio?.contas.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
            </select>
            <div className="w-36" title="De"><DateField value={de} onChange={setDe} placeholder="De" /></div>
            <div className="w-36" title="Até"><DateField value={ate} onChange={setAte} placeholder="até" /></div>
            <span className="text-xs text-stone-500">Saldo anterior <b className="tabular-nums">R$ {moeda(dados.saldo_anterior)}</b> · final <b className={`tabular-nums ${Number(dados.saldo_final) < 0 ? 'text-rose-600' : ''}`}>R$ {moeda(dados.saldo_final)}</b></span>
            <button type="button" onClick={() => setDireto(true)} title="Lançamento direto" data-dica-desc="Tarifa, rendimento, IOF: entrada ou saída com conta do plano e centro de custo" className={BOTAO}><PlusCircle className="w-4 h-4" /> Lançamento direto</button>
            <button type="button" onClick={() => setTransferir(true)} title="Transferência" data-dica-desc="Saída numa conta e entrada na outra, sem efeito no DRE" className={BOTAO}><ArrowLeftRight className="w-4 h-4" /> Transferência</button>
          </div>
        )}
        colunas={[
          { key: 'data', label: 'Data', alinhar: 'centro', largura: 92, render: (r) => dataBr(r.data) },
          { key: 'conta_nome', label: 'Conta', largura: 140 },
          { key: 'historico', label: 'Histórico', largura: 280, render: (r) => <span className={riscado(r)}>{r.historico}</span> },
          { key: 'pessoa_nome', label: 'Pessoa', largura: 180 },
          { key: 'documento', label: 'Documento', largura: 110 },
          { key: 'origem', label: 'Origem', largura: 120, render: (r) => ORIGEM_MOV[r.origem] ?? r.origem },
          { key: 'classificacao', label: 'Conta do plano', largura: 200 },
          { key: 'entrada', label: 'Entrada', alinhar: 'numero', largura: 110, render: (r) => (r.tipo === 'entrada' ? moeda(r.valor) : '') },
          { key: 'saida', label: 'Saída', alinhar: 'numero', largura: 110, render: (r) => (r.tipo === 'saida' ? moeda(r.valor) : '') },
          { key: 'saldo', label: 'Saldo', alinhar: 'numero', largura: 120, render: (r) => <span className={Number(r.saldo) < 0 ? 'text-rose-600' : ''}>{moeda(r.saldo)}</span> },
          { key: 'conciliado_em', label: 'Conc.', alinhar: 'centro', largura: 60, render: (r) => (r.conciliado_em ? <CheckCircle2 className="w-4 h-4 text-emerald-600 inline" /> : '') },
          { key: 'usuario_login', label: 'Usuário', largura: 100 },
        ]}
        acoes={(r) =>
          ESTORNAVEL.includes(r.origem) && !r.estornado && !r.estorno_de_id && !r.conciliado_em
            ? <BotaoAcao icone={Undo2} titulo="Estornar" tom="perigo" descricao={r.origem === 'transferencia' ? 'Estorna as duas pontas da transferência' : 'Linha inversa na mesma data; nada é apagado'} onClick={() => setEstornar({ ...r, motivo: '' })} />
            : <Vazio icone={Undo2} titulo="Estornar" />}
      />

      {direto && apoio && <DiretoDialog apoio={apoio} conta={conta} onFechar={() => setDireto(false)} onFeito={() => (setDireto(false), feito('Lançamento gravado.'))} />}
      {transferir && apoio && <TransferenciaDialog apoio={apoio} conta={conta} onFechar={() => setTransferir(false)} onFeito={() => (setTransferir(false), feito('Transferência gravada.'))} />}
      {estornar && (
        <ConfirmDialog
          titulo="Estornar movimento"
          mensagem={`${dataBr(estornar.data)} · ${estornar.historico} · R$ ${moeda(estornar.valor)}${estornar.origem === 'transferencia' ? ' (as duas contas da transferência)' : ''}`}
          confirmar="Estornar"
          onConfirmar={async () => {
            await api(`/api/financ/movimentos/${estornar.id}/estornar`, 'POST', { motivo: estornar.motivo });
            setEstornar(null);
            feito('Movimento estornado.');
          }}
          onCancelar={() => setEstornar(null)}
        >
          <Campo rotulo="Motivo"><input autoFocus maxLength={200} value={estornar.motivo} onChange={(e) => setEstornar({ ...estornar, motivo: e.target.value })} onFocus={(e) => e.target.select()} className={INPUT_CLASS} data-obrigatorio /></Campo>
        </ConfirmDialog>
      )}
      {erro && <AvisoErro mensagem={erro} onFechar={() => setErro('')} />}
      {ok && <AvisoErro tom="sucesso" mensagem={ok} onFechar={() => setOk('')} />}
    </div>
  );
}

/** Lançamento direto: tarifa, rendimento, IOF (conta do plano e centro de custo obrigatórios) */
export function DiretoDialog({ apoio, conta: contaIni, onFechar, onFeito }: { apoio: Apoio; conta: number | ''; onFechar: () => void; onFeito: () => void }) {
  const [d, setD] = useState({ conta_financeira_id: contaIni, tipo: 'saida', data: hojeIso(), valor: '', historico: '', documento: '', plano_conta_id: '' as number | '', centro_custo_id: '' as number | '' });
  const mudar = (x: Partial<typeof d>) => setD({ ...d, ...x });
  return (
    <Janela
      titulo="Lançamento direto"
      subtitulo="Entra no saldo da conta e no DRE pela conta do plano e centro de custo."
      largura="max-w-2xl"
      onFechar={onFechar}
      confirmar="Lançar"
      desabilitado={!d.conta_financeira_id || !Number(d.valor) || !d.historico.trim() || !d.plano_conta_id || !d.centro_custo_id}
      onConfirmar={async () => {
        await api('/api/financ/movimentos', 'POST', { ...d, documento: d.documento || null });
        onFeito();
      }}
    >
      <GradeCampos>
        <Campo rotulo="Conta financeira" span={2}>
          <select autoFocus={!d.conta_financeira_id} required value={d.conta_financeira_id} onChange={(e) => mudar({ conta_financeira_id: e.target.value ? Number(e.target.value) : '' })} className={INPUT_CLASS}>
            <option value="">Escolha a conta…</option>
            {apoio.contas.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
          </select>
        </Campo>
        <Campo rotulo="Tipo">
          <select value={d.tipo} onChange={(e) => mudar({ tipo: e.target.value })} className={INPUT_CLASS}>
            <option value="saida">Saída</option>
            <option value="entrada">Entrada</option>
          </select>
        </Campo>
        <Campo rotulo="Data"><DateField required value={d.data} onChange={(v) => mudar({ data: v })} /></Campo>
        <Campo rotulo="Valor"><NumberField autoFocus={!!d.conta_financeira_id} required scale={2} value={d.valor} onChange={(v) => mudar({ valor: v })} className={INPUT_CLASS} /></Campo>
        <Campo rotulo="Histórico" span={2}><input required maxLength={255} value={d.historico} onChange={(e) => mudar({ historico: e.target.value })} onFocus={(e) => e.target.select()} className={INPUT_CLASS} placeholder="Ex.: Tarifa de manutenção" /></Campo>
        <Campo rotulo="Documento"><input maxLength={60} value={d.documento} onChange={(e) => mudar({ documento: e.target.value })} onFocus={(e) => e.target.select()} className={INPUT_CLASS} /></Campo>
        <Campo rotulo="Conta do plano" span={2}>
          <select required value={d.plano_conta_id} onChange={(e) => mudar({ plano_conta_id: e.target.value ? Number(e.target.value) : '' })} className={INPUT_CLASS}>
            <option value="">Escolha…</option>
            {opcoesPlano(apoio)}
          </select>
        </Campo>
        <Campo rotulo="Centro de custo" span={2}>
          <select required value={d.centro_custo_id} onChange={(e) => mudar({ centro_custo_id: e.target.value ? Number(e.target.value) : '' })} className={INPUT_CLASS}>
            <option value="">Escolha…</option>
            {opcoesCentro(apoio)}
          </select>
        </Campo>
      </GradeCampos>
    </Janela>
  );
}

/** Transferência entre contas: uma saída e uma entrada, sem DRE */
export function TransferenciaDialog({ apoio, conta, onFechar, onFeito }: { apoio: Apoio; conta: number | ''; onFechar: () => void; onFeito: () => void }) {
  const [d, setD] = useState({ conta_origem_id: conta, conta_destino_id: '' as number | '', data: hojeIso(), valor: '', historico: '' });
  const mudar = (x: Partial<typeof d>) => setD({ ...d, ...x });
  const saldo = apoio.contas.find((c) => c.id === d.conta_origem_id)?.saldo;
  return (
    <Janela
      titulo="Transferência entre contas"
      subtitulo="Saída na origem e entrada no destino na mesma data, sem lançamento no DRE."
      largura="max-w-xl"
      onFechar={onFechar}
      confirmar="Transferir"
      desabilitado={!d.conta_origem_id || !d.conta_destino_id || d.conta_origem_id === d.conta_destino_id || !Number(d.valor)}
      onConfirmar={async () => {
        await api('/api/financ/transferencias', 'POST', { ...d, historico: d.historico || null });
        onFeito();
      }}
    >
      <GradeCampos>
        <Campo rotulo="Origem" span={2} dica={saldo != null ? `Saldo hoje: R$ ${moeda(saldo)}` : undefined}>
          <select autoFocus={!d.conta_origem_id} required value={d.conta_origem_id} onChange={(e) => mudar({ conta_origem_id: e.target.value ? Number(e.target.value) : '' })} className={INPUT_CLASS}>
            <option value="">Escolha…</option>
            {apoio.contas.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
          </select>
        </Campo>
        <Campo rotulo="Destino" span={2}>
          <select autoFocus={!!d.conta_origem_id} required value={d.conta_destino_id} onChange={(e) => mudar({ conta_destino_id: e.target.value ? Number(e.target.value) : '' })} className={INPUT_CLASS}>
            <option value="">Escolha…</option>
            {apoio.contas.filter((c) => c.id !== d.conta_origem_id).map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
          </select>
        </Campo>
        <Campo rotulo="Data" span={2}><DateField required value={d.data} onChange={(v) => mudar({ data: v })} /></Campo>
        <Campo rotulo="Valor" span={2}><NumberField required scale={2} value={d.valor} onChange={(v) => mudar({ valor: v })} className={INPUT_CLASS} /></Campo>
        <Campo rotulo="Histórico" span={4}><input maxLength={255} value={d.historico} onChange={(e) => mudar({ historico: e.target.value })} onFocus={(e) => e.target.select()} className={INPUT_CLASS} placeholder="(Transferência origem → destino)" /></Campo>
      </GradeCampos>
    </Janela>
  );
}
