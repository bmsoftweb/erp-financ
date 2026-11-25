import React, { useCallback, useEffect, useState } from 'react';
import { Mail, MessageCircle, Pencil, Play, Trash2 } from 'lucide-react';
import { useRefreshDaTela } from '@/components/LayoutApp';
import { ListaCrm } from '@/components/ListaCrm';
import { FormCrm, Campo, INPUT_CLASS } from '@/components/FormCrm';
import { BotaoAcao, SeparadorAcoes, Vazio } from '@/components/MenuAcoes';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { AvisoErro } from '@/components/AvisoErro';
import { Toggle } from '@/components/Toggle';
import { NumberField } from '@/components/NumberField';
import { api, dataBr, moeda } from '@/lib/api';
import { Etiqueta } from '@/lib/financ';
import { CANAL, SIT_ENVIO, hora, nomeEtapa } from '../parcelas/Mensagens';

type Aba = 'etapas' | 'modelos' | 'envios';
const VARIAVEIS = ['nome', 'documento', 'parcela', 'vencimento', 'valor_original', 'valor_atualizado', 'linha_digitavel', 'pix_copia_cola', 'link'];
// Momento da etapa na tela → evento + sinal dos dias
const MOMENTOS: Record<string, { rotulo: string; evento: string; sinal: number }> = {
  emissao: { rotulo: 'Depois da emissão', evento: 'emissao', sinal: 1 },
  antes: { rotulo: 'Antes do vencimento', evento: 'vencimento', sinal: -1 },
  dia: { rotulo: 'No dia do vencimento', evento: 'vencimento', sinal: 0 },
  depois: { rotulo: 'Depois do vencimento', evento: 'vencimento', sinal: 1 },
  pagamento: { rotulo: 'Depois do pagamento (recibo)', evento: 'pagamento', sinal: 1 },
};
const momentoDe = (e: any) => (e.evento === 'emissao' ? 'emissao' : e.evento === 'pagamento' ? 'pagamento' : Number(e.dias_relativos) < 0 ? 'antes' : Number(e.dias_relativos) === 0 ? 'dia' : 'depois');
const BOTAO = 'h-[34px] inline-flex items-center gap-1.5 px-3 rounded-lg text-xs font-semibold cursor-pointer disabled:opacity-40';
const IconeCanal = ({ canal }: { canal: string }) => (canal === 'email' ? <Mail className="w-3.5 h-3.5 inline mr-1" /> : <MessageCircle className="w-3.5 h-3.5 inline mr-1" />);

/** Régua de cobrança: etapas (quando), modelos (o quê, com prévia) e o histórico de envios */
export default function ReguaPage() {
  const [aba, setAba] = useState<Aba>('etapas');
  const [etapas, setEtapas] = useState<any[]>([]);
  const [modelos, setModelos] = useState<any[]>([]);
  const [envios, setEnvios] = useState<any[]>([]);
  const [filtro, setFiltro] = useState({ status: '', canal: '' });
  const [carregando, setCarregando] = useState(true);
  const [etapa, setEtapa] = useState<any | null>(null);
  const [modelo, setModelo] = useState<any | null>(null);
  const [previa, setPrevia] = useState<{ assunto: string | null; texto: string; desconhecidas: string[] } | null>(null);
  const [desativar, setDesativar] = useState<any | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [rodando, setRodando] = useState(false);
  const [erroForm, setErroForm] = useState('');
  const [erro, setErro] = useState('');
  const [ok, setOk] = useState('');

  const carregar = useCallback(async () => {
    try {
      const q = new URLSearchParams(Object.entries(filtro).filter(([, v]) => v)).toString();
      const [e, m, x] = await Promise.all([
        api<any[]>('/api/financ/cobranca/etapas'), api<any[]>('/api/financ/cobranca/modelos'), api<any[]>(`/api/financ/cobranca/envios${q ? `?${q}` : ''}`),
      ]);
      setEtapas(e);
      setModelos(m);
      setEnvios(x);
    } catch (e: any) {
      setErro(e.message);
    } finally {
      setCarregando(false);
    }
  }, [filtro]);
  useEffect(() => void carregar(), [carregar]);
  useRefreshDaTela(carregar);

  // Prévia do modelo em edição, com dados de exemplo
  useEffect(() => {
    if (!modelo) return;
    const t = setTimeout(() => {
      api<any>('/api/financ/cobranca/previa', 'POST', { canal: modelo.canal, assunto: modelo.assunto, corpo: modelo.corpo, template_whatsapp: modelo.template_whatsapp })
        .then(setPrevia).catch(() => setPrevia(null));
    }, 300);
    return () => clearTimeout(t);
  }, [modelo]);

  const gravar = async (fn: () => Promise<unknown>, depois: () => void) => {
    setSalvando(true);
    setErroForm('');
    try {
      await fn();
      depois();
      await carregar();
    } catch (e: any) {
      setErroForm(e.message);
    } finally {
      setSalvando(false);
    }
  };
  const sel = (e: React.FocusEvent<HTMLInputElement>) => e.target.select();
  const mudaEtapa = (x: any) => setEtapa((f: any) => ({ ...f, ...x }));
  const mudaModelo = (x: any) => setModelo((f: any) => ({ ...f, ...x }));

  const rodar = async () => {
    setRodando(true);
    try {
      const r: any = await api('/api/financ/cobranca/rodar', 'POST');
      setOk(`Régua: ${r.criados} mensagem(ns) nova(s), ${r.enviados} enviada(s), ${r.falhas} falha(s), ${r.adiados} adiada(s), ${r.cancelados} cancelada(s).`);
      if (r.erros?.length) setErro([...new Set(r.erros)].slice(0, 3).join('\n'));
      setAba('envios');
      await carregar();
    } catch (e: any) {
      setErro(e.message);
    } finally {
      setRodando(false);
    }
  };

  const abas = (
    <div className="flex flex-wrap items-center gap-1.5">
      {([['etapas', 'Etapas'], ['modelos', 'Modelos'], ['envios', 'Envios']] as const).map(([v, r]) => (
        <button key={v} type="button" onClick={() => setAba(v)} className={`${BOTAO} ${aba === v ? 'bg-blue-600 text-white' : 'border border-stone-300 dark:border-stone-700 text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800'}`}>{r}</button>
      ))}
      <button type="button" disabled={rodando} onClick={() => void rodar()} title="Rodar a régua agora" data-dica-desc="Cria as mensagens do dia e envia as pendentes, mesmo fora do horário comercial"
        className={`${BOTAO} text-white bg-emerald-600 hover:bg-emerald-700 ml-2`}>
        <Play className="w-4 h-4" /> Rodar agora
      </button>
    </div>
  );

  if (etapa) {
    const m = MOMENTOS[etapa.momento];
    return (
      <div className="flex-1 flex flex-col min-h-0 min-w-0">
        <FormCrm id="regua_etapa" saving={salvando} erro={erroForm} onFecharErro={() => setErroForm('')} onCancel={() => setEtapa(null)} rodape={etapa.id ? `Etapa #${etapa.id}` : 'Inclusão'}
          onSubmit={(e) => {
            e.preventDefault();
            const corpo = { perfil: etapa.perfil, evento: m.evento, dias_relativos: m.sinal * Number(etapa.dias || 0), template_id: etapa.template_id, ordem: Number(etapa.ordem || 0), ativo: !!etapa.ativo };
            void gravar(() => api(etapa.id ? `/api/financ/cobranca/etapas/${etapa.id}` : '/api/financ/cobranca/etapas', etapa.id ? 'PUT' : 'POST', corpo), () => setEtapa(null));
          }}>
          <Campo rotulo="Quando" span={2}>
            <select value={etapa.momento} onChange={(e) => mudaEtapa({ momento: e.target.value, ...(e.target.value === 'dia' ? { dias: '0' } : {}) })} className={INPUT_CLASS} data-obrigatorio="">
              {Object.entries(MOMENTOS).map(([v, x]) => <option key={v} value={v}>{x.rotulo}</option>)}
            </select>
          </Campo>
          <Campo rotulo="Dias"><NumberField scale={0} disabled={etapa.momento === 'dia'} value={String(etapa.dias)} onChange={(v) => mudaEtapa({ dias: v })} className={INPUT_CLASS} /></Campo>
          <Campo rotulo="Modelo" span={2}>
            <select autoFocus={!etapa.template_id} required value={etapa.template_id} onChange={(e) => mudaEtapa({ template_id: e.target.value ? Number(e.target.value) : '' })} className={INPUT_CLASS} data-obrigatorio="">
              <option value="">(escolha)</option>
              {modelos.filter((x) => Number(x.ativo) || x.id === etapa.template_id).map((x) => <option key={x.id} value={x.id}>{CANAL[x.canal]}: {x.nome}</option>)}
            </select>
          </Campo>
          <Campo rotulo="Perfil do cliente" dica="Casa com o perfil de cobrança do cliente; 'padrao' vale para todos sem perfil próprio">
            <input maxLength={40} value={etapa.perfil} onFocus={sel} onChange={(e) => mudaEtapa({ perfil: e.target.value })} className={INPUT_CLASS} />
          </Campo>
          <Campo rotulo="Ordem"><NumberField scale={0} value={String(etapa.ordem)} onChange={(v) => mudaEtapa({ ordem: v })} className={INPUT_CLASS} /></Campo>
          <Campo rotulo="Ativa"><Toggle checked={!!etapa.ativo} onChange={(v) => mudaEtapa({ ativo: v })} /></Campo>
        </FormCrm>
      </div>
    );
  }

  if (modelo) {
    return (
      <div className="flex-1 flex flex-col min-h-0 min-w-0">
        <FormCrm id="regua_modelo" saving={salvando} erro={erroForm} onFecharErro={() => setErroForm('')} onCancel={() => setModelo(null)} rodape={modelo.id ? `Modelo #${modelo.id}` : 'Inclusão'}
          onSubmit={(e) => {
            e.preventDefault();
            const { id, criado_em: _c, atualizado_em: _a, empresa_id: _e, usuario_id: _u, ...corpo } = modelo;
            void gravar(() => api(id ? `/api/financ/cobranca/modelos/${id}` : '/api/financ/cobranca/modelos', id ? 'PUT' : 'POST', { ...corpo, ativo: !!Number(corpo.ativo) }), () => setModelo(null));
          }}>
          <Campo rotulo="Canal">
            <select value={modelo.canal} disabled={!!modelo.id} onChange={(e) => mudaModelo({ canal: e.target.value })} className={INPUT_CLASS} data-obrigatorio="">
              <option value="whatsapp">WhatsApp</option>
              <option value="email">Email</option>
            </select>
          </Campo>
          <Campo rotulo="Nome" span={2}><input autoFocus={!modelo.nome} required maxLength={80} value={modelo.nome} onFocus={sel} onChange={(e) => mudaModelo({ nome: e.target.value })} className={INPUT_CLASS} data-obrigatorio="" /></Campo>
          <Campo rotulo="Ativo"><Toggle checked={!!Number(modelo.ativo)} onChange={(v) => mudaModelo({ ativo: v })} /></Campo>
          {modelo.canal === 'email' ? (
            <Campo rotulo="Assunto" span={4}><input required maxLength={200} value={modelo.assunto ?? ''} onFocus={sel} onChange={(e) => mudaModelo({ assunto: e.target.value })} className={INPUT_CLASS} data-obrigatorio="" /></Campo>
          ) : (
            <>
              <Campo rotulo="Modelo aprovado na Meta" span={2} dica="Nome do template aprovado no WhatsApp Manager; vazio = texto livre (só dentro da janela de 24 h de conversa)">
                <input maxLength={120} value={modelo.template_whatsapp ?? ''} onFocus={sel} onChange={(e) => mudaModelo({ template_whatsapp: e.target.value })} className={INPUT_CLASS} />
              </Campo>
              <Campo rotulo="Idioma"><input maxLength={10} value={modelo.idioma ?? 'pt_BR'} onFocus={sel} onChange={(e) => mudaModelo({ idioma: e.target.value })} className={INPUT_CLASS} /></Campo>
            </>
          )}
          <Campo rotulo="Mensagem" span={4} dica={`Variáveis: ${VARIAVEIS.map((v) => `{{${v}}}`).join(' ')}. Linha com variável vazia some (ex.: Pix quando não houver).`}>
            <textarea required rows={8} value={modelo.corpo} onChange={(e) => mudaModelo({ corpo: e.target.value })} className={`${INPUT_CLASS} font-mono text-xs`} data-obrigatorio="" />
          </Campo>
          <Campo rotulo="Prévia (dados de exemplo)" span={4}>
            <div className="rounded-lg border border-stone-200 dark:border-stone-800 p-3 text-xs bg-stone-50 dark:bg-stone-900/50 min-h-[60px]">
              {previa?.desconhecidas?.length ? <div className="text-amber-700 mb-2">Variável desconhecida: {previa.desconhecidas.map((k) => `{{${k}}}`).join(', ')}</div> : null}
              {previa?.assunto && <div className="font-semibold mb-2">{previa.assunto}</div>}
              <div className="whitespace-pre-wrap">{previa?.texto}</div>
            </div>
          </Campo>
        </FormCrm>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0">
      {aba === 'etapas' && (
        <ListaCrm
          className="flex-1"
          id="regua_etapas"
          linhas={etapas}
          carregando={carregando}
          chave={(r) => r.id}
          barraExtra={abas}
          onNovo={() => setEtapa({ momento: 'depois', dias: '3', template_id: '', perfil: 'padrao', ordem: '0', ativo: true })}
          onEditar={(r) => setEtapa({ ...r, momento: momentoDe(r), dias: String(Math.abs(Number(r.dias_relativos))), ativo: !!Number(r.ativo) })}
          vazio="Nenhuma etapa. Use Parâmetros › Criar cadastros padrão para a régua sugerida."
          colunas={[
            { key: 'perfil', label: 'Perfil', largura: 100 },
            { key: 'quando', label: 'Quando', largura: 200, render: (r) => nomeEtapa({ ...r, etapa_id: r.id }) },
            { key: 'canal', label: 'Canal', largura: 110, render: (r) => <><IconeCanal canal={r.canal} />{CANAL[r.canal]}</> },
            { key: 'modelo_nome', label: 'Modelo', largura: 220 },
            { key: 'ordem', label: 'Ordem', alinhar: 'numero', largura: 70 },
            { key: 'ativo', label: 'Ativa', alinhar: 'centro', largura: 70, render: (r) => (Number(r.ativo) ? 'Sim' : 'Não') },
          ]}
          acoes={(r) => (
            <>
              <BotaoAcao icone={Pencil} titulo="Editar" descricao="Abre a etapa para edição" onClick={() => setEtapa({ ...r, momento: momentoDe(r), dias: String(Math.abs(Number(r.dias_relativos))), ativo: !!Number(r.ativo) })} />
              <SeparadorAcoes />
              {Number(r.ativo) ? <BotaoAcao icone={Trash2} titulo="Excluir" descricao="Desativa a etapa (pede confirmação)" tom="perigo" onClick={() => setDesativar(r)} /> : <Vazio icone={Trash2} titulo="Excluir" />}
            </>
          )}
        />
      )}
      {aba === 'modelos' && (
        <ListaCrm
          className="flex-1"
          id="regua_modelos"
          linhas={modelos}
          carregando={carregando}
          chave={(r) => r.id}
          barraExtra={abas}
          onNovo={() => (setPrevia(null), setModelo({ canal: 'whatsapp', nome: '', assunto: '', corpo: '', template_whatsapp: '', idioma: 'pt_BR', ativo: true }))}
          onEditar={(r) => (setPrevia(null), setModelo({ ...r }))}
          vazio="Nenhum modelo."
          colunas={[
            { key: 'canal', label: 'Canal', largura: 110, render: (r) => <><IconeCanal canal={r.canal} />{CANAL[r.canal]}</> },
            { key: 'nome', label: 'Nome', largura: 200 },
            { key: 'template_whatsapp', label: 'Modelo Meta', largura: 160 },
            { key: 'corpo', label: 'Mensagem', largura: 420, render: (r) => String(r.corpo).replace(/\s+/g, ' ') },
            { key: 'ativo', label: 'Ativo', alinhar: 'centro', largura: 70, render: (r) => (Number(r.ativo) ? 'Sim' : 'Não') },
          ]}
          acoes={(r) => <BotaoAcao icone={Pencil} titulo="Editar" descricao="Abre o modelo com a prévia" onClick={() => (setPrevia(null), setModelo({ ...r }))} />}
        />
      )}
      {aba === 'envios' && (
        <ListaCrm
          className="flex-1"
          id="regua_envios"
          linhas={envios}
          carregando={carregando}
          chave={(r) => r.id}
          barraExtra={(
            <div className="flex flex-wrap items-center gap-2">
              {abas}
              <select value={filtro.status} onChange={(e) => setFiltro((f) => ({ ...f, status: e.target.value }))} className={`${INPUT_CLASS} w-36`} title="Situação">
                <option value="">Todas</option>
                {Object.keys(SIT_ENVIO).map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <select value={filtro.canal} onChange={(e) => setFiltro((f) => ({ ...f, canal: e.target.value }))} className={`${INPUT_CLASS} w-32`} title="Canal">
                <option value="">Todos</option>
                {Object.entries(CANAL).map(([v, r]) => <option key={v} value={v}>{r}</option>)}
              </select>
            </div>
          )}
          vazio="Nenhuma mensagem."
          colunas={[
            { key: 'criado_em', label: 'Criado', alinhar: 'centro', largura: 130, render: (r) => hora(r.criado_em) },
            { key: 'pessoa_nome', label: 'Cliente', largura: 200 },
            { key: 'documento', label: 'Documento', largura: 120 },
            { key: 'parcela', label: 'Parc.', alinhar: 'centro', largura: 60, render: (r) => `${r.numero}/${r.total_parcelas}` },
            { key: 'vencimento', label: 'Vencimento', alinhar: 'centro', largura: 100, render: (r) => dataBr(r.vencimento) },
            { key: 'saldo', label: 'Saldo', alinhar: 'numero', largura: 100, render: (r) => moeda(r.saldo) },
            { key: 'etapa', label: 'Etapa', largura: 130, render: (r) => nomeEtapa(r) },
            { key: 'canal', label: 'Canal', largura: 100, render: (r) => <><IconeCanal canal={r.canal} />{CANAL[r.canal]}</> },
            { key: 'destino', label: 'Destino', largura: 180 },
            { key: 'status', label: 'Situação', largura: 100, render: (r) => <Etiqueta texto={r.status} cor={SIT_ENVIO[r.status] ?? ''} /> },
            { key: 'enviado_em', label: 'Enviado', alinhar: 'centro', largura: 130, render: (r) => hora(r.enviado_em) },
            { key: 'status_em', label: 'Atualizado', alinhar: 'centro', largura: 130, render: (r) => hora(r.status_em) },
            { key: 'erro', label: 'Erro', largura: 280 },
            { key: 'usuario_nome', label: 'Usuário', largura: 120, render: (r) => r.usuario_nome ?? (r.etapa_id ? 'régua' : '') },
          ]}
        />
      )}
      {desativar && (
        <ConfirmDialog
          titulo="Excluir etapa da régua"
          mensagem={`Desativar a etapa "${nomeEtapa({ ...desativar, etapa_id: desativar.id })}" (${CANAL[desativar.canal]})? As mensagens já enviadas continuam no histórico.`}
          onConfirmar={async () => {
            await api(`/api/financ/cobranca/etapas/${desativar.id}`, 'DELETE');
            setDesativar(null);
            await carregar();
          }}
          onCancelar={() => setDesativar(null)}
        />
      )}
      {erro && <AvisoErro mensagem={erro} onFechar={() => setErro('')} />}
      {ok && <AvisoErro tom="sucesso" mensagem={ok} onFechar={() => setOk('')} />}
    </div>
  );
}
