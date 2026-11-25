import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCheck, Link2, Undo2, Wand2 } from 'lucide-react';
import { useRefreshDaTela } from '@/components/LayoutApp';
import { ListaCrm } from '@/components/ListaCrm';
import { BotaoAcao } from '@/components/MenuAcoes';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { AvisoErro } from '@/components/AvisoErro';
import { Toggle } from '@/components/Toggle';
import { Janela } from '@/components/Janela';
import { Campo, GradeCampos, INPUT_CLASS } from '@/components/FormCrm';
import { api, dataBr, moeda } from '@/lib/api';
import { carregarApoio, opcoesCentro, opcoesPlano, ORIGEM_MOV, somar, type Apoio } from '@/lib/financ';
import { RegraDialog, regraNova, type Regra } from './Regras';

const CORES = ['bg-sky-100 text-sky-800', 'bg-violet-100 text-violet-800', 'bg-amber-100 text-amber-800', 'bg-emerald-100 text-emerald-800', 'bg-rose-100 text-rose-800', 'bg-lime-100 text-lime-800'];
const BOTAO = 'h-[34px] flex items-center gap-1.5 px-3 rounded-lg text-xs font-semibold cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed';
const SECUNDARIO = `${BOTAO} border border-stone-300 dark:border-stone-700 text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800`;

interface Dados { conta: { id: number; nome: string }; extrato: any[]; movimentos: any[]; sugestoes: { extrato: number[]; movimentos: number[]; motivo: string; regra_id?: number; plano_conta_id?: number; centro_custo_id?: number }[]; saldo: { data: string; extrato: string; sistema: string } | null }

const alternar = (set: Set<number>, id: number) => {
  const x = new Set(set);
  if (x.has(id)) x.delete(id);
  else x.add(id);
  return x;
};

/**
 * Conciliação bancária: extrato do BMBancos à esquerda, movimentos à direita, sugestões numeradas (o mesmo número nos
 * dois lados). Confirmação em lote, conciliação manual (com oferta de virar regra), linha sem par vira lançamento
 * direto ou baixa. Aba Conciliados para desfazer.
 */
export default function ConciliacaoPage() {
  const [apoio, setApoio] = useState<Apoio | null>(null);
  const [conta, setConta] = useState<number | ''>('');
  const [aba, setAba] = useState<'pendentes' | 'conciliados'>('pendentes');
  const [dados, setDados] = useState<Dados | null>(null);
  const [conciliados, setConciliados] = useState<any[]>([]);
  const [carregando, setCarregando] = useState(false);
  const [mE, setME] = useState<Set<number>>(new Set());
  const [mM, setMM] = useState<Set<number>>(new Set());
  const [confirmarLote, setConfirmarLote] = useState(false);
  const [semPar, setSemPar] = useState<any>(null);
  const [regra, setRegra] = useState<Regra | null>(null);
  const [desfazer, setDesfazer] = useState<any>(null);
  const [erro, setErro] = useState('');
  const [ok, setOk] = useState('');

  const contas = useMemo(() => apoio?.contas.filter((c) => c.ban_conta_id) ?? [], [apoio]);
  useEffect(() => void carregarApoio().then((a) => {
    setApoio(a);
    const ligadas = a.contas.filter((c) => c.ban_conta_id);
    if (ligadas.length === 1) setConta(ligadas[0].id);
  }).catch((e) => setErro(e.message)), []);

  const carregar = useCallback(async () => {
    if (!conta) return;
    setCarregando(true);
    try {
      if (aba === 'pendentes') {
        setDados(await api(`/api/financ/conciliacao/pendentes?conta=${conta}`));
        setME(new Set());
        setMM(new Set());
      } else setConciliados(await api(`/api/financ/conciliacoes?conta=${conta}`));
    } catch (e: any) {
      setErro(e.message);
      setDados(null);
    } finally {
      setCarregando(false);
    }
  }, [conta, aba]);
  useEffect(() => void carregar(), [carregar]);
  useRefreshDaTela(carregar);
  const feito = (m: string) => (setOk(m), void carregar());

  // número da sugestão em cada linha e movimento
  const sugE = new Map<number, number>();
  const sugM = new Map<number, number>();
  dados?.sugestoes.forEach((s, i) => (s.extrato.forEach((id) => sugE.set(id, i)), s.movimentos.forEach((id) => sugM.set(id, i))));
  const chip = (i: number | undefined) => {
    if (i == null || !dados) return null;
    const s = dados.sugestoes[i];
    return (
      <button type="button" onClick={(e) => (e.stopPropagation(), setME(new Set(s.extrato)), setMM(new Set(s.movimentos)))} title={s.motivo} data-dica-desc="Clique para marcar a sugestão nos dois lados" className={`px-1.5 rounded text-[10px] font-bold cursor-pointer ${CORES[i % CORES.length]}`}>
        {i + 1}
      </button>
    );
  };

  const somaE = somar(dados?.extrato.filter((l) => mE.has(l.id)).map((l) => l.valor) ?? []);
  const somaM = somar(dados?.movimentos.filter((l) => mM.has(l.id)).map((l) => l.valor) ?? []);
  const pares = dados?.sugestoes.filter((s) => s.movimentos.length) ?? [];
  const diretos = dados?.sugestoes.filter((s) => !s.movimentos.length) ?? [];

  const conciliarMarcados = async () => {
    try {
      await api('/api/financ/conciliacoes', 'POST', { conta_financeira_id: conta, itens: [{ extrato: [...mE], movimentos: [...mM] }] });
      const linha = dados!.extrato.find((l) => mE.has(l.id));
      const movs = dados!.movimentos.filter((m) => mM.has(m.id));
      feito('Conciliado.');
      // Conciliação manual de uma linha: oferece guardar como regra
      if (mE.size === 1 && linha) {
        const pessoa = movs.length === 1 && movs[0].pessoa_id ? movs[0] : null;
        setRegra(regraNova({ nome: String(linha.historico ?? '').slice(0, 40), conta_financeira_id: Number(conta), texto: String(linha.historico ?? '').slice(0, 30).trim(), sentido: Number(linha.valor) > 0 ? 'entrada' : 'saida', pessoa_id: pessoa?.pessoa_id ?? null, pessoa_nome: pessoa?.pessoa_nome ?? null }));
      }
    } catch (e: any) {
      setErro(e.message);
    }
  };

  const valorCel = (v: string) => <span className={Number(v) < 0 ? 'text-rose-600' : 'text-emerald-700 dark:text-emerald-400'}>{moeda(v)}</span>;

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0 p-3 gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <select value={conta} onChange={(e) => setConta(e.target.value ? Number(e.target.value) : '')} className={`${INPUT_CLASS} w-56`} title="Conta financeira ligada ao BMBancos">
          <option value="">Escolha a conta…</option>
          {contas.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
        </select>
        <select value={aba} onChange={(e) => setAba(e.target.value as any)} className={`${INPUT_CLASS} w-40`} title="Mostrar">
          <option value="pendentes">Pendentes</option>
          <option value="conciliados">Conciliados</option>
        </select>
        {aba === 'pendentes' && dados && (
          <>
            <button type="button" disabled={!dados.sugestoes.length} onClick={() => setConfirmarLote(true)} className={`${BOTAO} text-white bg-emerald-600 hover:bg-emerald-700`} title="Confirmar sugestões" data-dica-desc="Concilia de uma vez todas as sugestões numeradas">
              <Wand2 className="w-4 h-4" /> Confirmar {dados.sugestoes.length} sugestões
            </button>
            <button type="button" disabled={!mE.size || !mM.size || Math.round(somaE * 100) !== Math.round(somaM * 100)} onClick={() => void conciliarMarcados()} className={`${BOTAO} text-white bg-blue-600 hover:bg-blue-700`} title="Conciliar marcados" data-dica-desc="As linhas e os movimentos marcados precisam somar o mesmo valor">
              <Link2 className="w-4 h-4" /> Conciliar marcados
            </button>
            <button type="button" disabled={mE.size !== 1 || mM.size > 0} onClick={() => setSemPar(dados.extrato.find((l) => mE.has(l.id)))} className={SECUNDARIO} title="Linha sem par" data-dica-desc="Marque uma linha do extrato: vira lançamento direto ou baixa de parcela">
              <CheckCheck className="w-4 h-4" /> Sem par…
            </button>
            <span className="text-xs text-stone-500">
              Marcados: extrato <b className="tabular-nums">R$ {moeda(somaE)}</b> · movimentos <b className="tabular-nums">R$ {moeda(somaM)}</b>
              {(mE.size > 0 || mM.size > 0) && <> · diferença <b className={`tabular-nums ${Math.round(somaE * 100) === Math.round(somaM * 100) ? 'text-emerald-600' : 'text-rose-600'}`}>R$ {moeda(somaE - somaM)}</b></>}
            </span>
          </>
        )}
      </div>

      {aba === 'pendentes' && dados?.saldo && (
        <div className={`text-xs rounded-lg px-3 py-2 border ${dados.saldo.extrato === dados.saldo.sistema ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300' : 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300'}`}>
          Saldo em {dataBr(dados.saldo.data)}: extrato <b>R$ {moeda(dados.saldo.extrato)}</b> · sistema <b>R$ {moeda(dados.saldo.sistema)}</b>
          {dados.saldo.extrato !== dados.saldo.sistema && <> · diferença R$ {moeda(somar([dados.saldo.extrato]) - somar([dados.saldo.sistema]))}</>}
        </div>
      )}

      {!conta ? (
        <p className="text-sm text-stone-500">{contas.length ? 'Escolha a conta financeira.' : 'Nenhuma conta financeira ligada a uma conta do BMBancos (Cadastros › Contas financeiras). O extrato OFX é importado no BMBancos.'}</p>
      ) : aba === 'pendentes' ? (
        <div className="flex-1 min-h-0 grid grid-cols-1 xl:grid-cols-2 gap-3">
          <ListaCrm
            className="min-h-0"
            id="conc_extrato"
            linhas={dados?.extrato ?? []}
            carregando={carregando}
            chave={(r) => r.id}
            paginar={false}
            vazio="Nenhuma linha pendente no extrato (importe o OFX no BMBancos)."
            onClique={(r) => setME((s) => alternar(s, r.id))}
            colunas={[
              { key: 'marcar', label: '', largura: 34, alinhar: 'centro', render: (r) => <span onClick={(e) => e.stopPropagation()}><Toggle size="sm" checked={mE.has(r.id)} onChange={() => setME((s) => alternar(s, r.id))} title="Marcar" /></span> },
              { key: 'sug', label: 'Sug.', largura: 44, alinhar: 'centro', render: (r) => chip(sugE.get(r.id)) },
              { key: 'data', label: 'Data', alinhar: 'centro', largura: 88, render: (r) => dataBr(r.data) },
              { key: 'valor', label: 'Valor', alinhar: 'numero', largura: 100, render: (r) => valorCel(r.valor) },
              { key: 'historico', label: 'Histórico (extrato)', largura: 240 },
              { key: 'documento', label: 'Documento', largura: 100 },
            ]}
          />
          <ListaCrm
            className="min-h-0"
            id="conc_movimentos"
            linhas={dados?.movimentos ?? []}
            carregando={carregando}
            chave={(r) => r.id}
            paginar={false}
            vazio="Nenhum movimento sem conciliação nesta conta."
            onClique={(r) => setMM((s) => alternar(s, r.id))}
            colunas={[
              { key: 'marcar', label: '', largura: 34, alinhar: 'centro', render: (r) => <span onClick={(e) => e.stopPropagation()}><Toggle size="sm" checked={mM.has(r.id)} onChange={() => setMM((s) => alternar(s, r.id))} title="Marcar" /></span> },
              { key: 'sug', label: 'Sug.', largura: 44, alinhar: 'centro', render: (r) => chip(sugM.get(r.id)) },
              { key: 'data', label: 'Data', alinhar: 'centro', largura: 88, render: (r) => dataBr(r.data) },
              { key: 'valor', label: 'Valor', alinhar: 'numero', largura: 100, render: (r) => valorCel(r.valor) },
              { key: 'historico', label: 'Histórico (sistema)', largura: 220 },
              { key: 'pessoa_nome', label: 'Pessoa', largura: 150 },
              { key: 'origem', label: 'Origem', largura: 100, render: (r) => ORIGEM_MOV[r.origem] ?? r.origem },
              { key: 'documento', label: 'Documento', largura: 100 },
            ]}
          />
        </div>
      ) : (
        <ListaCrm
          className="flex-1"
          id="conc_feitas"
          linhas={conciliados}
          carregando={carregando}
          chave={(r) => r.id}
          vazio="Nenhuma conciliação nesta conta."
          colunas={[
            { key: 'data', label: 'Data', alinhar: 'centro', largura: 88, render: (r) => dataBr(r.data) },
            { key: 'valor', label: 'Valor', alinhar: 'numero', largura: 100, render: (r) => moeda(r.valor) },
            { key: 'historico', label: 'Histórico (extrato)', largura: 260 },
            { key: 'movimentos', label: 'Movimentos', largura: 120 },
            { key: 'automatica', label: 'Automática', alinhar: 'centro', largura: 80, render: (r) => (Number(r.automatica) ? 'Sim' : 'Não') },
            { key: 'regra', label: 'Regra', largura: 140 },
            { key: 'conciliado_em', label: 'Em', alinhar: 'centro', largura: 130, render: (r) => new Date(r.conciliado_em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) },
            { key: 'usuario_login', label: 'Usuário', largura: 100 },
          ]}
          acoes={(r) => <BotaoAcao icone={Undo2} titulo="Desfazer" tom="perigo" descricao="Volta a linha e os movimentos para pendentes; a baixa continua" onClick={() => setDesfazer(r)} />}
        />
      )}

      {confirmarLote && dados && (
        <ConfirmDialog
          titulo="Confirmar sugestões"
          tom="normal"
          mensagem={`${pares.length} par(es) extrato × movimento${diretos.length ? ` e ${diretos.length} linha(s) que viram lançamento direto pela regra` : ''}. Confirmar todos?`}
          confirmar="Confirmar"
          onConfirmar={async () => {
            if (pares.length) await api('/api/financ/conciliacoes', 'POST', { conta_financeira_id: conta, itens: pares.map((s) => ({ extrato: s.extrato, movimentos: s.movimentos, regra_id: s.regra_id ?? null, automatica: true })) });
            for (const s of diretos) {
              await api('/api/financ/conciliacoes/sem-par', 'POST', { conta_financeira_id: conta, extrato_id: s.extrato[0], acao: 'direto', plano_conta_id: s.plano_conta_id, centro_custo_id: s.centro_custo_id, regra_id: s.regra_id });
            }
            setConfirmarLote(false);
            feito(`${pares.length + diretos.length} linha(s) conciliada(s).`);
          }}
          onCancelar={() => setConfirmarLote(false)}
        />
      )}
      {semPar && apoio && (
        <SemParDialog
          apoio={apoio}
          conta={Number(conta)}
          linha={semPar}
          onFechar={() => setSemPar(null)}
          onFeito={(m, r) => {
            setSemPar(null);
            feito(m);
            if (r) setRegra(r);
          }}
        />
      )}
      {regra && apoio && <RegraDialog apoio={apoio} inicial={regra} titulo="Salvar como regra?" onFechar={() => setRegra(null)} onFeito={() => (setRegra(null), setOk('Regra gravada: as próximas linhas parecidas já vêm sugeridas.'))} />}
      {desfazer && (
        <ConfirmDialog
          titulo="Desfazer conciliação"
          mensagem={`${dataBr(desfazer.data)} · ${desfazer.historico ?? ''} · R$ ${moeda(desfazer.valor)}. A linha e os movimentos voltam a pendentes; baixas e lançamentos continuam.`}
          confirmar="Desfazer"
          onConfirmar={async () => {
            await api('/api/financ/conciliacoes/desfazer', 'POST', { extrato_id: desfazer.id });
            setDesfazer(null);
            feito('Conciliação desfeita.');
          }}
          onCancelar={() => setDesfazer(null)}
        />
      )}
      {erro && <AvisoErro mensagem={erro} onFechar={() => setErro('')} />}
      {ok && <AvisoErro tom="sucesso" mensagem={ok} onFechar={() => setOk('')} />}
    </div>
  );
}

/** Linha do extrato sem par: lançamento direto ou baixa de parcela (inclusive parcial) */
function SemParDialog({ apoio, conta, linha, onFechar, onFeito }: { apoio: Apoio; conta: number; linha: any; onFechar: () => void; onFeito: (m: string, regra?: Regra) => void }) {
  const entrada = Number(linha.valor) > 0;
  const lado = entrada ? 'receber' : 'pagar';
  const [acao, setAcao] = useState<'direto' | 'baixa'>('direto');
  const [plano, setPlano] = useState<number | ''>('');
  const [centro, setCentro] = useState<number | ''>('');
  const [historico, setHistorico] = useState(String(linha.historico ?? ''));
  const [salvarRegra, setSalvarRegra] = useState(true);
  const [parcelas, setParcelas] = useState<any[]>([]);
  const [parcela, setParcela] = useState<number | ''>('');
  const valor = Math.abs(Number(linha.valor));
  useEffect(() => {
    if (acao !== 'baixa' || parcelas.length) return;
    api<any[]>(`/api/financ/${lado}/parcelas?situacao=abertas`)
      .then((l) => setParcelas(l.sort((a, b) => Math.abs(Number(a.total_dia) - valor) - Math.abs(Number(b.total_dia) - valor)).slice(0, 80)))
      .catch(() => {});
  }, [acao, lado, valor, parcelas.length]);
  return (
    <Janela
      titulo="Linha do extrato sem par"
      subtitulo={`${dataBr(linha.data)} · ${linha.historico ?? ''} · R$ ${moeda(linha.valor)}`}
      largura="max-w-2xl"
      onFechar={onFechar}
      confirmar={acao === 'direto' ? 'Lançar e conciliar' : 'Baixar e conciliar'}
      desabilitado={acao === 'direto' ? !plano || !centro : !parcela}
      onConfirmar={async () => {
        await api('/api/financ/conciliacoes/sem-par', 'POST', acao === 'direto'
          ? { conta_financeira_id: conta, extrato_id: linha.id, acao, plano_conta_id: plano, centro_custo_id: centro, historico: historico || null }
          : { conta_financeira_id: conta, extrato_id: linha.id, acao, lado, parcela_id: parcela });
        const regra = acao === 'direto' && salvarRegra
          ? regraNova({ nome: String(linha.historico ?? '').slice(0, 40), conta_financeira_id: conta, texto: String(linha.historico ?? '').slice(0, 30).trim(), sentido: entrada ? 'entrada' : 'saida', plano_conta_id: Number(plano), centro_custo_id: Number(centro) })
          : undefined;
        onFeito(acao === 'direto' ? 'Lançamento direto gravado e conciliado.' : 'Parcela baixada e conciliada.', regra);
      }}
    >
      <GradeCampos>
        <Campo rotulo="O que fazer" span={4}>
          <select autoFocus value={acao} onChange={(e) => setAcao(e.target.value as any)} className={INPUT_CLASS}>
            <option value="direto">Lançamento direto (tarifa, rendimento, IOF…)</option>
            <option value="baixa">Baixa de parcela {entrada ? 'a receber' : 'a pagar'} (valor da linha; pode ser parcial)</option>
          </select>
        </Campo>
        {acao === 'direto' ? (
          <>
            <Campo rotulo="Conta do plano" span={2}>
              <select required value={plano} onChange={(e) => setPlano(e.target.value ? Number(e.target.value) : '')} className={INPUT_CLASS}>
                <option value="">Escolha…</option>
                {opcoesPlano(apoio)}
              </select>
            </Campo>
            <Campo rotulo="Centro de custo" span={2}>
              <select required value={centro} onChange={(e) => setCentro(e.target.value ? Number(e.target.value) : '')} className={INPUT_CLASS}>
                <option value="">Escolha…</option>
                {opcoesCentro(apoio)}
              </select>
            </Campo>
            <Campo rotulo="Histórico" span={4}><input maxLength={255} value={historico} onChange={(e) => setHistorico(e.target.value)} onFocus={(e) => e.target.select()} className={INPUT_CLASS} /></Campo>
            <Campo rotulo="Oferecer salvar como regra" span={4}><Toggle checked={salvarRegra} onChange={setSalvarRegra} /></Campo>
          </>
        ) : (
          <Campo rotulo="Parcela" span={4} dica="Ordenadas pela proximidade do total do dia com o valor da linha">
            <select required value={parcela} onChange={(e) => setParcela(e.target.value ? Number(e.target.value) : '')} className={INPUT_CLASS}>
              <option value="">Escolha…</option>
              {parcelas.map((p) => (
                <option key={p.id} value={p.id}>{p.pessoa_nome} · {p.documento || p.numero_documento || `título ${p.titulo_id}`} · {p.numero}/{p.total_parcelas} · venc. {dataBr(p.vencimento)} · total do dia R$ {moeda(p.total_dia)}</option>
              ))}
            </select>
          </Campo>
        )}
      </GradeCampos>
    </Janela>
  );
}
