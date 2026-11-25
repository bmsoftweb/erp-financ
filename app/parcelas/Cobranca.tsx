import React, { useCallback, useEffect, useState } from 'react';
import { Copy, CreditCard, FileDown, MessageSquare, QrCode, Receipt, RefreshCw } from 'lucide-react';
import { Janela } from '@/components/Janela';
import { AvisoErro } from '@/components/AvisoErro';
import { DateField } from '@/components/DateField';
import { CampoPesquisa } from '@/components/CampoPesquisa';
import { PesquisaCatalogo } from '@/components/PesquisaCatalogo';
import { Campo, GradeCampos, INPUT_CLASS } from '@/components/FormCrm';
import { api, dataBr, hojeIso, moeda } from '@/lib/api';
import { Etiqueta, type Apoio } from '@/lib/financ';
import { MensagensParcela } from './Mensagens';

type Aba = 'boleto' | 'pix' | 'cartao' | 'mensagens';
const SIT_BOLETO: Record<string, string> = {
  emitido: 'bg-stone-100 text-stone-700', processando: 'bg-amber-100 text-amber-800', registrado: 'bg-blue-100 text-blue-800',
  liquidado: 'bg-emerald-100 text-emerald-800', baixado: 'bg-stone-200 text-stone-600', cancelado: 'bg-stone-200 text-stone-600', rejeitado: 'bg-rose-100 text-rose-800',
};
const SIT_PIX: Record<string, string> = { ativa: 'bg-blue-100 text-blue-800', concluida: 'bg-emerald-100 text-emerald-800', removida: 'bg-stone-200 text-stone-600', expirada: 'bg-stone-200 text-stone-600' };
const BOTAO = 'h-[34px] inline-flex items-center gap-1.5 px-3 rounded-lg text-xs font-semibold cursor-pointer disabled:opacity-40';
const SEC = `${BOTAO} border border-stone-300 dark:border-stone-700 text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800`;

function Copiar({ texto, rotulo }: { texto: string; rotulo: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button type="button" title={`Copiar ${rotulo}`} className={SEC} onClick={() => void navigator.clipboard.writeText(texto).then(() => (setOk(true), setTimeout(() => setOk(false), 1500)))}>
      <Copy className="w-4 h-4" /> {ok ? 'Copiado' : rotulo}
    </button>
  );
}

/**
 * Cobrança da parcela a receber: boleto/bolecode e Pix pelo BMBancos (o financeiro só guarda o vínculo) e venda no
 * cartão (parcela quitada, recebível contra o adquirente); Mensagens: envio avulso e histórico da régua.
 */
export function CobrancaDialog({ parcela, apoio, onFechar, onMudou }: { parcela: any; apoio: Apoio; onFechar: () => void; onMudou: (m: string) => void }) {
  const ligadas = apoio.contas.filter((c) => c.ban_conta_id);
  const adquirentes = apoio.contas.filter((c) => c.tipo === 'adquirente');
  const [aba, setAba] = useState<Aba>('boleto');
  const [dados, setDados] = useState<{ boletos: any[]; pix: any[] }>({ boletos: [], pix: [] });
  const [conta, setConta] = useState<number | ''>(ligadas.find((c) => c.id === parcela.conta_financeira_id)?.id ?? ligadas[0]?.id ?? '');
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState('');
  const [cartao, setCartao] = useState({ adquirente_id: (adquirentes[0]?.id ?? '') as number | '', pessoa: null as { id: number; nome: string } | null, bandeira: '', modalidade: 'credito', parcelas: '1', nsu: '', autorizacao: '', data_venda: hojeIso() });
  const [pesquisa, setPesquisa] = useState(false);

  const carregar = useCallback(async () => {
    try {
      setDados(await api(`/api/financ/receber/parcelas/${parcela.id}/cobrancas`));
    } catch (e: any) {
      setErro(e.message);
    }
  }, [parcela.id]);
  useEffect(() => void carregar(), [carregar]);

  const executar = async (fn: () => Promise<unknown>, msg?: string) => {
    setOcupado(true);
    setErro('');
    try {
      await fn();
      await carregar();
      if (msg) onMudou(msg);
    } catch (e: any) {
      setErro(e.message);
    } finally {
      setOcupado(false);
    }
  };
  const ativo = dados.boletos.find((b) => Number(b.ativo));
  const pixAtivo = dados.pix.find((p) => p.status === 'ativa');
  const mudaCartao = (x: Partial<typeof cartao>) => setCartao((c) => ({ ...c, ...x }));
  const sel = (e: React.FocusEvent<HTMLInputElement>) => e.target.select();

  const seletorConta = (
    <Campo rotulo="Conta (BMBancos)" span={2}>
      <select value={conta} onChange={(e) => setConta(e.target.value ? Number(e.target.value) : '')} className={INPUT_CLASS} data-obrigatorio="">
        {!ligadas.length && <option value="">Nenhuma conta ligada ao BMBancos</option>}
        {ligadas.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
      </select>
    </Campo>
  );

  return (
    <Janela
      titulo={`Cobrar: ${parcela.pessoa_nome}`}
      subtitulo={`${parcela.numero_documento ?? `Título ${parcela.titulo_id}`} · parcela ${parcela.numero}/${parcela.total_parcelas} · vence ${dataBr(parcela.vencimento)} · saldo ${moeda(parcela.saldo)} · total do dia ${moeda(parcela.total_dia)}`}
      largura="max-w-4xl"
      onFechar={onFechar}
    >
      <div className="flex gap-1.5 mb-4">
        {([['boleto', 'Boleto', Receipt], ['pix', 'Pix', QrCode], ['cartao', 'Cartão', CreditCard], ['mensagens', 'Mensagens', MessageSquare]] as const).map(([v, r, I]) => (
          <button key={v} type="button" onClick={() => setAba(v)} className={`${BOTAO} ${aba === v ? 'bg-blue-600 text-white' : 'border border-stone-300 dark:border-stone-700 text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800'}`}>
            <I className="w-4 h-4" /> {r}
          </button>
        ))}
      </div>

      {aba === 'boleto' && (
        <div className="space-y-4">
          <div className="flex items-end gap-3">
            <div className="flex-1"><GradeCampos>{seletorConta}</GradeCampos></div>
            <button type="button" disabled={ocupado || !conta} className={`${BOTAO} text-white bg-blue-600 hover:bg-blue-700`}
              title={ativo ? 'Reemitir' : 'Emitir boleto'} data-dica-desc={ativo ? 'Referência nova; o boleto atual é baixado no banco' : 'Pelo saldo, com a multa, os juros e o desconto da parcela'}
              onClick={() => void executar(() => api(`/api/financ/receber/parcelas/${parcela.id}/boleto`, 'POST', { conta_financeira_id: conta }), ativo ? 'Boleto reemitido.' : 'Boleto emitido.')}>
              <Receipt className="w-4 h-4" /> {ativo ? 'Reemitir boleto' : 'Emitir boleto'}
            </button>
          </div>
          {!dados.boletos.length && <p className="text-xs text-stone-500">Nenhum boleto para esta parcela.</p>}
          {dados.boletos.map((b) => (
            <div key={b.id} className={`rounded-lg border p-3 text-xs space-y-2 ${Number(b.ativo) ? 'border-blue-200 dark:border-blue-900' : 'border-stone-200 dark:border-stone-800 opacity-70'}`}>
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-semibold">{b.referencia}</span>
                {b.situacao && <Etiqueta texto={b.situacao} cor={SIT_BOLETO[b.situacao] ?? ''} />}
                {!Number(b.ativo) && <Etiqueta texto="substituído" cor="bg-stone-200 text-stone-600" />}
                <span>vence {dataBr(b.data_vencimento)}</span>
                <span className="tabular-nums">{moeda(b.valor)}</span>
                {b.data_pagamento && <span className="text-emerald-700">pago {dataBr(b.data_pagamento)}: {moeda(b.valor_pago)}</span>}
              </div>
              {b.linha_digitavel && <div className="font-mono text-[11px] break-all">{b.linha_digitavel}</div>}
              <div className="flex flex-wrap gap-2">
                {b.linha_digitavel && <Copiar texto={b.linha_digitavel} rotulo="Linha digitável" />}
                {b.pix_emv && <Copiar texto={b.pix_emv} rotulo="Pix copia e cola" />}
                {b.boleto_id && <a href={`/api/financ/boletos/${b.boleto_id}/pdf`} target="_blank" rel="noreferrer" title="PDF do boleto" className={SEC}><FileDown className="w-4 h-4" /> PDF</a>}
              </div>
            </div>
          ))}
        </div>
      )}

      {aba === 'pix' && (
        <div className="space-y-4">
          <div className="flex items-end gap-3">
            <div className="flex-1"><GradeCampos>{seletorConta}</GradeCampos></div>
            <button type="button" disabled={ocupado || !conta} className={`${BOTAO} text-white bg-blue-600 hover:bg-blue-700`}
              title="Gerar Pix" data-dica-desc="Cobrança imediata pelo total do dia, válida por 24 horas"
              onClick={() => void executar(() => api(`/api/financ/receber/parcelas/${parcela.id}/pix`, 'POST', { conta_financeira_id: conta }))}>
              <QrCode className="w-4 h-4" /> {pixAtivo ? 'Gerar de novo' : 'Gerar Pix'}
            </button>
          </div>
          {!dados.pix.length && <p className="text-xs text-stone-500">Nenhuma cobrança Pix para esta parcela.</p>}
          {dados.pix.map((p) => (
            <div key={p.id} className="rounded-lg border border-stone-200 dark:border-stone-800 p-3 text-xs space-y-2">
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-mono">{p.txid}</span>
                <Etiqueta texto={p.status} cor={SIT_PIX[p.status] ?? ''} />
                <span className="tabular-nums">{moeda(p.valor)}</span>
                <span>{p.conta_nome}</span>
                {p.status === 'ativa' && <span>expira {dataBr(p.expira_em)} {String(p.expira_em).slice(11, 16)}</span>}
                {p.pago_em && <span className="text-emerald-700">pago {dataBr(p.pago_em)} {String(p.pago_em).slice(11, 16)}</span>}
              </div>
              {p.status === 'ativa' && p.pix_emv && <div className="font-mono text-[11px] break-all">{p.pix_emv}</div>}
              {p.status === 'ativa' && (
                <div className="flex flex-wrap gap-2">
                  {p.pix_emv && <Copiar texto={p.pix_emv} rotulo="Copia e cola" />}
                  <button type="button" disabled={ocupado} title="Consultar pagamento" data-dica-desc="Pergunta ao banco; se foi pago, baixa a parcela" className={SEC}
                    onClick={() => void executar(async () => {
                      const r: any = await api(`/api/financ/pix/${p.id}/consultar`, 'POST');
                      if (r.status === 'processado') onMudou('Pix recebido: parcela baixada.');
                      else if (r.erro) throw new Error(r.erro);
                    })}>
                    <RefreshCw className="w-4 h-4" /> Consultar
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {aba === 'cartao' && (
        <div className="space-y-4">
          <p className="text-xs text-stone-500">A parcela fica quitada e nasce um título a receber contra o adquirente, uma parcela por mês, líquido da taxa cadastrada em Taxas de cartão.</p>
          <GradeCampos>
            <Campo rotulo="Adquirente" span={2}>
              <select value={cartao.adquirente_id} onChange={(e) => mudaCartao({ adquirente_id: e.target.value ? Number(e.target.value) : '' })} className={INPUT_CLASS} data-obrigatorio="">
                {!adquirentes.length && <option value="">Cadastre uma conta do tipo adquirente</option>}
                {adquirentes.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
              </select>
            </Campo>
            <Campo rotulo="Cadastro do adquirente" span={2} dica="Pessoa do título do recebível; sem ela, a da última venda neste adquirente">
              <CampoPesquisa texto={cartao.pessoa?.nome} vazio="(o da última venda)" onAbrir={() => setPesquisa(true)} onLimpar={() => mudaCartao({ pessoa: null })} />
            </Campo>
            <Campo rotulo="Bandeira"><input autoFocus required maxLength={30} value={cartao.bandeira} onFocus={sel} onChange={(e) => mudaCartao({ bandeira: e.target.value })} className={INPUT_CLASS} data-obrigatorio="" /></Campo>
            <Campo rotulo="Modalidade">
              <select value={cartao.modalidade} onChange={(e) => mudaCartao({ modalidade: e.target.value, parcelas: e.target.value === 'debito' ? '1' : cartao.parcelas })} className={INPUT_CLASS}>
                <option value="credito">Crédito</option>
                <option value="debito">Débito</option>
              </select>
            </Campo>
            <Campo rotulo="Parcelas">
              <input inputMode="numeric" disabled={cartao.modalidade === 'debito'} value={cartao.parcelas} onFocus={sel} onChange={(e) => mudaCartao({ parcelas: e.target.value.replace(/\D/g, '').slice(0, 2) })} className={`${INPUT_CLASS} text-right`} />
            </Campo>
            <Campo rotulo="Data da venda"><DateField value={cartao.data_venda} onChange={(v) => mudaCartao({ data_venda: v })} required /></Campo>
            <Campo rotulo="NSU"><input maxLength={40} value={cartao.nsu} onFocus={sel} onChange={(e) => mudaCartao({ nsu: e.target.value })} className={INPUT_CLASS} /></Campo>
            <Campo rotulo="Autorização"><input maxLength={128} value={cartao.autorizacao} onFocus={sel} onChange={(e) => mudaCartao({ autorizacao: e.target.value })} className={INPUT_CLASS} /></Campo>
          </GradeCampos>
          <div className="flex justify-end">
            <button type="button" disabled={ocupado || !cartao.adquirente_id || !cartao.bandeira.trim() || !Number(cartao.parcelas)} className={`${BOTAO} text-white bg-emerald-600 hover:bg-emerald-700`}
              onClick={() => void executar(async () => {
                const r: any = await api('/api/financ/cartao/transacoes', 'POST', {
                  parcela_id: parcela.id, adquirente_id: cartao.adquirente_id, adquirente_pessoa_id: cartao.pessoa?.id ?? null, bandeira: cartao.bandeira.trim(),
                  modalidade: cartao.modalidade, parcelas: Number(cartao.parcelas), nsu: cartao.nsu, autorizacao: cartao.autorizacao, data_venda: cartao.data_venda,
                });
                onMudou(`Cartão registrado: ${moeda(r.bruto)} − taxa ${moeda(r.taxa)} = ${moeda(r.liquido)} a receber do adquirente em ${r.plano.length}x.`);
                onFechar();
              })}>
              <CreditCard className="w-4 h-4" /> Registrar venda no cartão
            </button>
          </div>
          {pesquisa && <PesquisaCatalogo tipo="fornecedores" titulo="Cadastro do adquirente" onEscolher={(l: any) => (mudaCartao({ pessoa: { id: Number(l.id), nome: l.nome } }), setPesquisa(false))} onFechar={() => setPesquisa(false)} />}
        </div>
      )}
      {aba === 'mensagens' && <MensagensParcela parcela={parcela} onMudou={onMudou} onErro={setErro} />}
      {erro && <AvisoErro mensagem={erro} onFechar={() => setErro('')} />}
    </Janela>
  );
}
