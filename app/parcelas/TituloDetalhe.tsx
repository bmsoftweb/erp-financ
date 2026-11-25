import React, { useCallback, useEffect, useState } from 'react';
import { Ban, Undo2 } from 'lucide-react';
import { Janela } from '@/components/Janela';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { INPUT_CLASS } from '@/components/FormCrm';
import { api, dataBr, docBr, moeda } from '@/lib/api';
import { Etiqueta, NOME_LADO, STATUS_PARCELA, type Lado } from '@/lib/financ';
import { Anexos } from './Anexos';

const TH = 'px-2 py-1.5 text-[11px] font-semibold text-stone-500 dark:text-stone-400 border-b border-stone-200 dark:border-stone-800';
const TD = 'px-2 py-1.5 text-xs border-b border-stone-100 dark:border-stone-800';
const ACOES: Record<string, string> = { criar: 'Criação', alterar: 'Alteração', baixar: 'Baixa', estornar: 'Estorno', dispensar: 'Dispensa de encargos', prorrogar: 'Prorrogação', cancelar: 'Cancelamento', aprovar: 'Aprovação', renegociar: 'Renegociação', desfazer_renegociacao: 'Renegociação desfeita', anexar: 'Anexo incluído', remover_anexo: 'Anexo removido' };

const Secao = ({ titulo, children }: { titulo: string; children: React.ReactNode }) => (
  <section className="mb-5">
    <h3 className="text-xs font-bold uppercase tracking-wide text-stone-500 mb-1.5">{titulo}</h3>
    <div className="overflow-x-auto">{children}</div>
  </section>
);

/** Título com parcelas, rateio, baixas (estorno), anexos e histórico (fin_auditoria) */
export function TituloDetalhe({ lado, tituloId, onFechar, onMudou }: { lado: Lado; tituloId: number; onFechar: () => void; onMudou: (msg: string) => void }) {
  const [d, setD] = useState<any>(null);
  const [erro, setErro] = useState('');
  const [estornar, setEstornar] = useState<any>(null);
  const [cancelar, setCancelar] = useState(false);
  const [motivo, setMotivo] = useState('');

  const carregar = useCallback(() => api(`/api/financ/${lado}/titulos/${tituloId}`).then(setD).catch((e) => setErro(e.message)), [lado, tituloId]);
  useEffect(() => void carregar(), [carregar]);

  const confirmarEstorno = async () => {
    await api(`/api/financ/${lado}/baixas/${estornar.id}/estornar`, 'POST', { motivo });
    setEstornar(null);
    setMotivo('');
    await carregar();
    onMudou('Baixa estornada.');
  };
  const confirmarCancelar = async () => {
    const reneg = d?.titulo.origem === 'renegociacao';
    await api(reneg ? `/api/financ/renegociacoes/${d.titulo.origem_id}/desfazer` : `/api/financ/${lado}/titulos/${tituloId}/cancelar`, 'POST', { motivo });
    setCancelar(false);
    setMotivo('');
    await carregar();
    onMudou(reneg ? 'Renegociação desfeita: as parcelas originais voltaram.' : 'Título cancelado.');
  };

  const t = d?.titulo;
  // Só a baixa mais recente de cada parcela pode ser estornada
  const ultimas = new Set<number>();
  if (d) {
    const porParcela = new Map<number, number>();
    for (const b of d.baixas) if (!b.estornada_em && !b.estorno_de_id) porParcela.set(b.parcela_id, Math.max(porParcela.get(b.parcela_id) ?? 0, Number(b.id)));
    porParcela.forEach((id) => ultimas.add(id));
  }

  return (
    <Janela
      titulo={t ? `${NOME_LADO[lado].pessoa}: ${t.pessoa_nome}` : 'Título'}
      subtitulo={t && `${docBr(t.cpf_cnpj)} · ${t.numero_documento ?? `Título ${t.id}`} · emissão ${dataBr(t.data_emissao)} · competência ${dataBr(t.data_competencia)} · origem ${t.origem} · ${t.status}`}
      largura="max-w-5xl"
      onFechar={onFechar}
      rodapeExtra={t && t.status !== 'cancelado' && (
        <button type="button" onClick={() => (setMotivo(''), setCancelar(true))} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold text-rose-700 border border-rose-200 bg-rose-50 hover:bg-rose-100 dark:text-rose-300 dark:border-rose-900 dark:bg-rose-950/40 cursor-pointer">
          <Ban className="w-4 h-4" /> {t.origem === 'renegociacao' ? 'Desfazer renegociação' : 'Cancelar título'}
        </button>
      )}
    >
      {erro && <p className="text-xs text-rose-600">{erro}</p>}
      {d && (
        <>
          {t.historico && <p className="text-xs mb-3"><b>Histórico:</b> {t.historico}</p>}
          <Secao titulo="Parcelas">
            <table className="w-full border-collapse">
              <thead><tr><th className={`${TH} text-left`}>Parc.</th><th className={`${TH} text-center`}>Vencimento</th><th className={`${TH} text-center`}>Venc. original</th><th className={`${TH} text-right`}>Valor</th><th className={`${TH} text-right`}>Saldo</th><th className={`${TH} text-left`}>Forma</th><th className={`${TH} text-left`}>Status</th></tr></thead>
              <tbody>
                {d.parcelas.map((p: any) => (
                  <tr key={p.id}>
                    <td className={TD}>{p.numero}/{p.total_parcelas}</td>
                    <td className={`${TD} text-center`}>{dataBr(p.vencimento)}</td>
                    <td className={`${TD} text-center`}>{p.vencimento_original !== p.vencimento ? dataBr(p.vencimento_original) : ''}</td>
                    <td className={`${TD} text-right tabular-nums`}>{moeda(p.valor_original)}</td>
                    <td className={`${TD} text-right tabular-nums`}>{moeda(p.saldo)}</td>
                    <td className={TD}>{p.forma_nome ?? p.forma_pagamento ?? ''}</td>
                    <td className={TD}><Etiqueta texto={STATUS_PARCELA[p.status]?.rotulo ?? p.status} cor={STATUS_PARCELA[p.status]?.cor ?? ''} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Secao>

          <Secao titulo="Rateio (conta do plano × centro de custo)">
            <table className="w-full border-collapse">
              <thead><tr><th className={`${TH} text-left`}>Conta</th><th className={`${TH} text-left`}>Centro de custo</th><th className={`${TH} text-right`}>%</th><th className={`${TH} text-right`}>Valor</th></tr></thead>
              <tbody>
                {d.rateios.map((r: any) => (
                  <tr key={r.id}>
                    <td className={TD}>{r.conta_codigo} {r.conta_descricao}</td>
                    <td className={TD}>{r.centro_codigo} {r.centro_descricao}</td>
                    <td className={`${TD} text-right tabular-nums`}>{Number(r.percentual).toLocaleString('pt-BR', { maximumFractionDigits: 4 })}</td>
                    <td className={`${TD} text-right tabular-nums`}>{moeda(r.valor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Secao>

          <Secao titulo="Baixas">
            {d.baixas.length ? (
              <table className="w-full border-collapse">
                <thead><tr><th className={`${TH} text-left`}>#</th><th className={`${TH} text-left`}>Parc.</th><th className={`${TH} text-center`}>Pagamento</th><th className={`${TH} text-left`}>Conta</th><th className={`${TH} text-right`}>Pago</th><th className={`${TH} text-right`}>Principal</th><th className={`${TH} text-right`}>Multa</th><th className={`${TH} text-right`}>Juros</th><th className={`${TH} text-right`}>Desconto</th><th className={`${TH} text-right`}>Saldo depois</th><th className={`${TH} text-left`}>Situação</th><th className={TH} /></tr></thead>
                <tbody>
                  {d.baixas.map((b: any) => {
                    const estorno = !!b.estorno_de_id;
                    return (
                      <tr key={b.id} className={estorno || b.estornada_em ? 'text-stone-400' : ''}>
                        <td className={TD}>{b.id}</td>
                        <td className={TD}>{b.parcela_numero}/{b.total_parcelas}</td>
                        <td className={`${TD} text-center`}>{dataBr(b.data_pagamento)}</td>
                        <td className={TD}>{b.conta_nome ?? (b.origem === 'credito_pessoa' ? 'Crédito' : '')}</td>
                        <td className={`${TD} text-right tabular-nums`}>{estorno ? '−' : ''}{moeda(b.valor_pago)}</td>
                        <td className={`${TD} text-right tabular-nums`}>{moeda(b.valor_principal)}</td>
                        <td className={`${TD} text-right tabular-nums`}>{moeda(b.valor_multa)}</td>
                        <td className={`${TD} text-right tabular-nums`}>{moeda(b.valor_juros)}</td>
                        <td className={`${TD} text-right tabular-nums`}>{moeda(b.valor_desconto)}</td>
                        <td className={`${TD} text-right tabular-nums`}>{moeda(b.saldo_depois)}</td>
                        <td className={TD}>{estorno ? `Estorno da #${b.estorno_de_id}` : b.estornada_em ? 'Estornada' : b.origem}</td>
                        <td className={`${TD} text-center w-10`}>
                          {ultimas.has(Number(b.id)) && b.origem !== 'renegociacao' ? (
                            <button type="button" onClick={() => (setMotivo(''), setEstornar(b))} title="Estornar" data-dica-desc="Cria a baixa inversa e devolve o saldo da parcela" className="p-1 rounded text-stone-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 cursor-pointer"><Undo2 className="w-4 h-4" /></button>
                          ) : (
                            <span title="Estornar: não disponível nesta situação" className="inline-flex p-1 text-stone-200 dark:text-stone-700"><Undo2 className="w-4 h-4" /></span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : <p className="text-xs text-stone-400">Nenhuma baixa.</p>}
          </Secao>

          <Secao titulo="Anexos">
            <Anexos lado={lado} tituloId={tituloId} empresaId={Number(t.empresa_id)} onMudou={() => void carregar()} />
          </Secao>

          <Secao titulo="Histórico">
            {d.historico.map((h: any) => (
              <p key={h.id} className="text-xs py-0.5"><span className="text-stone-400 tabular-nums">{new Date(h.criado_em).toLocaleString('pt-BR')}</span> · <b>{ACOES[h.acao] ?? h.acao}</b> ({h.entidade.replace(/^fin_(receber|pagar)_/, '')} #{h.entidade_id}) · {h.usuario_login ?? 'sistema'}</p>
            ))}
          </Secao>
        </>
      )}

      {estornar && (
        <ConfirmDialog titulo={`Estornar a baixa #${estornar.id}`} mensagem={`Estornar R$ ${moeda(estornar.valor_pago)} de ${dataBr(estornar.data_pagamento)}? A baixa não é apagada: entra uma linha inversa, o movimento da conta é revertido e a parcela volta ao saldo anterior.${estornar.origem === 'compensacao' ? ' Compensação: a baixa do outro lado (receber/pagar) também é estornada.' : ''}`} confirmar="Estornar" onConfirmar={confirmarEstorno} onCancelar={() => setEstornar(null)}>
          <input autoFocus required placeholder="Motivo do estorno" maxLength={255} value={motivo} onChange={(e) => setMotivo(e.target.value)} className={INPUT_CLASS} />
        </ConfirmDialog>
      )}
      {cancelar && (
        <ConfirmDialog titulo={t?.origem === 'renegociacao' ? 'Desfazer renegociação' : 'Cancelar título'} mensagem={t?.origem === 'renegociacao' ? 'O título da renegociação é cancelado e as parcelas originais voltam a ficar em aberto, com o saldo de antes. Só sem baixa no título novo (estorne antes).' : 'As parcelas em aberto são canceladas. Título com parcela baixada não pode ser cancelado (estorne antes).'} confirmar={t?.origem === 'renegociacao' ? 'Desfazer' : 'Cancelar título'} onConfirmar={confirmarCancelar} onCancelar={() => setCancelar(false)}>
          <input autoFocus required placeholder="Motivo do cancelamento" maxLength={255} value={motivo} onChange={(e) => setMotivo(e.target.value)} className={INPUT_CLASS} />
        </ConfirmDialog>
      )}
    </Janela>
  );
}
