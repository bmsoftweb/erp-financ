import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Save, Sparkles } from 'lucide-react';
import { useRefreshDaTela } from '@/components/LayoutApp';
import { TelaCheia, SecaoCrm, GradeCampos, Campo, INPUT_CLASS } from '@/components/FormCrm';
import { AvisoErro } from '@/components/AvisoErro';
import { NumberField } from '@/components/NumberField';
import { DateField } from '@/components/DateField';
import { api } from '@/lib/api';
import type { Centro, ContaPlano } from '@/lib/financ';

const PADRAO: Record<string, any> = { multa_pct: '2.00', juros_mes_pct: '1.00', carencia_dias: 0, desconto_pct: '0.00', desconto_dias: 0, modo_imputacao: 'proporcional', valor_aprovacao_pagamento: null, periodo_fechado_ate: null };
const CAMPOS = Object.keys(PADRAO);

const CONTAS: [string, string][] = [
  ['conta_venda_id', 'Receita padrão (vendas)'], ['conta_compra_id', 'Despesa padrão (compras)'],
  ['conta_juros_recebidos_id', 'Juros recebidos'], ['conta_multas_recebidas_id', 'Multas recebidas'],
  ['conta_juros_pagos_id', 'Juros pagos'], ['conta_multas_pagas_id', 'Multas pagas'],
  ['conta_desconto_concedido_id', 'Descontos concedidos'], ['conta_desconto_obtido_id', 'Descontos obtidos'],
  ['conta_tarifas_bancarias_id', 'Tarifas bancárias'], ['conta_taxas_cartao_id', 'Taxas de cartão'],
  ['conta_quebra_caixa_id', 'Quebra de caixa'], ['conta_antecipacao_id', 'Antecipação de recebíveis'],
];

/** Parâmetros do financeiro: encargos padrão, aprovação, período fechado e contas/centros usados nos lançamentos automáticos */
export default function ParametrosPage() {
  const navegar = useNavigate();
  const [p, setP] = useState<Record<string, any> | null>(null);
  const [semPlano, setSemPlano] = useState(false);
  const [semRegua, setSemRegua] = useState(false);
  const [admin, setAdmin] = useState(false);
  const [plano, setPlano] = useState<ContaPlano[]>([]);
  const [centros, setCentros] = useState<Centro[]>([]);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState('');
  const [ok, setOk] = useState('');

  const carregar = useCallback(async () => {
    try {
      const [r, pl, ce] = await Promise.all([api<any>('/api/financ/parametros'), api<ContaPlano[]>('/api/financ/plano-contas'), api<Centro[]>('/api/financ/centros-custo')]);
      setP({ ...PADRAO, ...(r.parametros ?? {}) });
      setSemPlano(r.semPlano);
      setSemRegua(r.semRegua);
      setAdmin(r.admin);
      setPlano(pl.filter((c) => Number(c.analitica) && Number(c.ativo)));
      setCentros(ce.filter((c) => Number(c.analitico) && Number(c.ativo)));
    } catch (e: any) {
      setErro(e.message);
    }
  }, []);
  useEffect(() => void carregar(), [carregar]);
  useRefreshDaTela(carregar);

  if (!p) return null;
  const muda = (campo: string, valor: unknown) => setP({ ...p, [campo]: valor });
  const id = (v: string) => (v ? Number(v) : null);

  const salvar = async () => {
    setSalvando(true);
    try {
      const corpo: Record<string, unknown> = {};
      for (const k of [...CAMPOS, ...CONTAS.map(([c]) => c), 'centro_custo_padrao_id', 'centro_custo_tarifas_id']) corpo[k] = p[k] === '' ? null : p[k];
      await api('/api/financ/parametros', 'PUT', corpo);
      setOk('Parâmetros gravados.');
      await carregar();
    } catch (e: any) {
      setErro(e.message);
    } finally {
      setSalvando(false);
    }
  };

  const semear = async () => {
    try {
      const r = await api<{ criado: boolean; regua: boolean }>('/api/financ/parametros/semear', 'POST');
      setOk([r.criado && 'plano de contas, centros de custo, Caixa e formas de pagamento', r.regua && 'régua de cobrança com os modelos de mensagem'].filter(Boolean).join(' e ').replace(/^/, 'Criados: ') + '.');
      await carregar();
    } catch (e: any) {
      setErro(e.message);
    }
  };

  const seletor = (campo: string, lista: { id: number; codigo: string; descricao: string }[]) => (
    <select disabled={!admin} value={p[campo] ?? ''} onChange={(e) => muda(campo, id(e.target.value))} className={INPUT_CLASS}>
      <option value="">(não definida)</option>
      {lista.map((c) => <option key={c.id} value={c.id}>{c.codigo} {c.descricao}</option>)}
    </select>
  );

  return (
    <TelaCheia
      rodape={admin ? 'Só administradores alteram os parâmetros.' : 'Somente leitura: só administradores alteram os parâmetros.'}
      onVoltar={() => navegar('/painel')}
      rotuloVoltar="Fechar"
      onSubmit={admin ? salvar : undefined}
      rotuloPrincipal="Salvar"
      iconePrincipal={<Save className="w-4 h-4" />}
      salvando={salvando}
      acoes={admin && (semPlano || semRegua) && (
        <button type="button" onClick={semear} className="flex items-center gap-1.5 px-4 py-2.5 rounded-lg text-xs font-semibold text-amber-800 border border-amber-300 bg-amber-50 hover:bg-amber-100 dark:text-amber-200 dark:border-amber-800 dark:bg-amber-950/40 cursor-pointer">
          <Sparkles className="w-4 h-4" /> Criar cadastros padrão
        </button>
      )}
    >
      {!semPlano && semRegua && <p className="text-xs rounded-lg border border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200 px-3 py-2">A régua de cobrança padrão (emissão, 3 dias antes, vencimento, 3, 10 e 30 dias de atraso e recibo) ainda não foi criada. “Criar cadastros padrão” cria a régua com os modelos de mensagem.</p>}
      {semPlano && <p className="text-xs rounded-lg border border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200 px-3 py-2">Esta empresa ainda não tem plano de contas. “Criar cadastros padrão” monta um plano básico, centros de custo, o Caixa e as formas de pagamento, e já preenche as contas abaixo.</p>}
      <SecaoCrm titulo="Encargos padrão (o cadastro do cliente/fornecedor pode trocar)">
        <GradeCampos>
          <Campo rotulo="Multa (%)"><NumberField disabled={!admin} scale={2} value={p.multa_pct} onChange={(v) => muda('multa_pct', v)} className={INPUT_CLASS} /></Campo>
          <Campo rotulo="Juros ao mês (%)" dica="Pro rata dia: juros/30 por dia de atraso"><NumberField disabled={!admin} scale={2} value={p.juros_mes_pct} onChange={(v) => muda('juros_mes_pct', v)} className={INPUT_CLASS} /></Campo>
          <Campo rotulo="Carência (dias)" dica="Dentro da carência não cobra multa nem juros; passou, conta desde o vencimento"><NumberField disabled={!admin} scale={0} value={String(p.carencia_dias)} onChange={(v) => muda('carencia_dias', Number(v) || 0)} className={INPUT_CLASS} /></Campo>
          <Campo rotulo="Imputação do pagamento parcial">
            <select disabled={!admin} value={p.modo_imputacao} onChange={(e) => muda('modo_imputacao', e.target.value)} className={INPUT_CLASS}>
              <option value="proporcional">Proporcional</option>
              <option value="encargos_primeiro">Encargos primeiro</option>
            </select>
          </Campo>
          <Campo rotulo="Desconto de pontualidade (%)"><NumberField disabled={!admin} scale={2} value={p.desconto_pct} onChange={(v) => muda('desconto_pct', v)} className={INPUT_CLASS} /></Campo>
          <Campo rotulo="Desconto até (dias antes do venc.)"><NumberField disabled={!admin} scale={0} value={String(p.desconto_dias)} onChange={(v) => muda('desconto_dias', Number(v) || 0)} className={INPUT_CLASS} /></Campo>
        </GradeCampos>
      </SecaoCrm>
      <SecaoCrm titulo="Controles">
        <GradeCampos>
          <Campo rotulo="Aprovar pagamentos a partir de (R$)" span={2} dica="Vazio = contas a pagar não precisam de aprovação"><NumberField disabled={!admin} scale={2} value={p.valor_aprovacao_pagamento ?? ''} onChange={(v) => muda('valor_aprovacao_pagamento', v || null)} className={INPUT_CLASS} /></Campo>
          <Campo rotulo="Período fechado até" span={2} dica="Nada com data até aqui pode ser incluído, baixado ou estornado (salvo com a permissão própria)"><DateField value={p.periodo_fechado_ate ?? ''} onChange={(v) => muda('periodo_fechado_ate', v || null)} /></Campo>
        </GradeCampos>
      </SecaoCrm>
      <SecaoCrm titulo="Contas dos lançamentos automáticos">
        <GradeCampos>
          {CONTAS.map(([campo, rotulo]) => <Campo key={campo} rotulo={rotulo} span={2}>{seletor(campo, plano)}</Campo>)}
          <Campo rotulo="Centro de custo padrão" span={2}>{seletor('centro_custo_padrao_id', centros)}</Campo>
          <Campo rotulo="Centro de custo das tarifas" span={2}>{seletor('centro_custo_tarifas_id', centros)}</Campo>
        </GradeCampos>
      </SecaoCrm>
      {erro && <AvisoErro mensagem={erro} onFechar={() => setErro('')} />}
      {ok && <AvisoErro tom="sucesso" mensagem={ok} onFechar={() => setOk('')} />}
    </TelaCheia>
  );
}
