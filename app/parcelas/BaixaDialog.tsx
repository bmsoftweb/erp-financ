import React, { useEffect, useRef, useState } from 'react';
import { Janela, Info } from '@/components/Janela';
import { Campo, GradeCampos, INPUT_CLASS } from '@/components/FormCrm';
import { NumberField } from '@/components/NumberField';
import { DateField } from '@/components/DateField';
import { Toggle } from '@/components/Toggle';
import { api, dataBr, hojeIso, moeda } from '@/lib/api';
import { NOME_LADO, type Apoio, type Lado } from '@/lib/financ';

interface Simulacao {
  diasAtraso: number; saldoAntes: string; multaDevida: string; jurosDevidos: string; totalDevido: string; fator: string;
  valorPago: string; valorPrincipal: string; valorMulta: string; valorJuros: string; valorDesconto: string; valorDispensado: string;
  valorExcedente: string; saldoDepois: string; total_dia: string; credito_disponivel: string;
}

/**
 * Baixa de uma parcela: multa, juros, desconto, total do dia e saldo que sobra vêm do servidor (simular-baixa, a
 * mesma função que grava). Digitar o principal faz o cálculo inverso (quanto cobrar para amortizá-lo).
 */
export function BaixaDialog({ lado, parcela, apoio, onFechar, onBaixada }: { lado: Lado; parcela: any; apoio: Apoio; onFechar: () => void; onBaixada: (msg: string) => void }) {
  const n = NOME_LADO[lado];
  const [dataPag, setDataPag] = useState(hojeIso());
  const [dataConta, setDataConta] = useState(hojeIso());
  const [conta, setConta] = useState<number | ''>(parcela.conta_financeira_id ?? apoio.contas[0]?.id ?? '');
  const [forma, setForma] = useState<number | ''>(parcela.forma_pagamento_id ?? '');
  const [pago, setPago] = useState('');
  const [principal, setPrincipal] = useState('');
  const [tarifa, setTarifa] = useState('');
  const [dispensa, setDispensa] = useState('');
  const [motivo, setMotivo] = useState('');
  const [usarCredito, setUsarCredito] = useState(false);
  const [informados, setInformados] = useState(false);
  const [multaInf, setMultaInf] = useState('');
  const [jurosInf, setJurosInf] = useState('');
  const [obs, setObs] = useState('');
  const [sim, setSim] = useState<Simulacao | null>(null);
  const [erroSim, setErroSim] = useState('');
  // Qual dos dois o usuário digitou por último: valor pago ou principal (cálculo inverso)
  const origem = useRef<'pago' | 'principal' | null>(null);

  const corpo = () => ({
    data_pagamento: dataPag,
    valor_pago: origem.current === 'pago' && Number(pago) ? pago : null,
    principal: origem.current === 'principal' && Number(principal) ? principal : null,
    dispensa: Number(dispensa) ? dispensa : null,
    multa_informada: informados ? multaInf || '0' : null,
    juros_informados: informados ? jurosInf || '0' : null,
  });

  useEffect(() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dataPag)) return;
    const t = setTimeout(() => {
      api<Simulacao>(`/api/financ/${lado}/parcelas/${parcela.id}/simular-baixa`, 'POST', corpo())
        .then((r) => {
          setSim(r);
          setErroSim('');
          if (origem.current !== 'pago') setPago(r.valorPago);
          if (origem.current !== 'principal') setPrincipal(r.valorPrincipal);
        })
        .catch((e) => setErroSim(e.message));
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataPag, pago, principal, dispensa, informados, multaInf, jurosInf]);

  // A data da conta acompanha a do pagamento + D+n da forma (boleto D+1, cartão D+30)
  useEffect(() => {
    const f = apoio.formas.find((x) => x.id === forma);
    const [y, m, d] = dataPag.split('-').map(Number);
    if (!y) return;
    const dt = new Date(y, m - 1, d + Number(lado === 'receber' ? f?.dias_credito ?? 0 : 0));
    setDataConta(`${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`);
  }, [dataPag, forma, apoio.formas, lado]);

  const baixar = async () => {
    const r = await api(`/api/financ/${lado}/parcelas/${parcela.id}/baixas`, 'POST', {
      ...corpo(),
      valor_pago: pago,
      principal: null,
      data_conta: usarCredito ? null : dataConta,
      conta_financeira_id: usarCredito ? null : conta || null,
      forma_pagamento_id: forma || null,
      valor_tarifa: Number(tarifa) ? tarifa : null,
      motivo_dispensa: motivo || null,
      usar_credito: usarCredito,
      observacoes: obs || null,
    });
    onBaixada(r.status === 'quitada' ? 'Parcela quitada.' : `Baixa parcial gravada. Saldo: R$ ${moeda(r.resultado.saldoDepois)}.`);
  };

  const credito = Number(sim?.credito_disponivel || 0);
  const atrasada = (sim?.diasAtraso ?? 0) > 0;
  return (
    <Janela
      titulo={`${n.verbo}: ${parcela.pessoa_nome}`}
      subtitulo={`${parcela.numero_documento ?? `Título ${parcela.titulo_id}`} · parcela ${parcela.numero}/${parcela.total_parcelas} · vencimento ${dataBr(parcela.vencimento)} · saldo R$ ${moeda(parcela.saldo)}`}
      largura="max-w-4xl"
      onFechar={onFechar}
      onConfirmar={baixar}
      confirmar={`Confirmar baixa de R$ ${moeda(pago)}`}
      tom="verde"
      desabilitado={!sim || !!erroSim || !Number(pago) || (!usarCredito && !conta)}
    >
      <div className="grid md:grid-cols-[1fr_17rem] gap-5">
        <GradeCampos>
          <Campo rotulo="Data do pagamento"><DateField required value={dataPag} onChange={setDataPag} /></Campo>
          <Campo rotulo={n.dataConta}><DateField required value={dataConta} onChange={setDataConta} /></Campo>
          <Campo rotulo="Forma de pagamento" span={2}>
            <select value={forma} onChange={(e) => setForma(e.target.value ? Number(e.target.value) : '')} className={INPUT_CLASS}>
              <option value="">(da parcela)</option>
              {apoio.formas.map((f) => <option key={f.id} value={f.id}>{f.nome}</option>)}
            </select>
          </Campo>
          {credito > 0 && (
            <Campo rotulo={lado === 'receber' ? `Usar crédito do cliente (R$ ${moeda(credito)})` : `Usar adiantamento (R$ ${moeda(credito)})`} span={2}>
              <Toggle checked={usarCredito} onChange={setUsarCredito} />
            </Campo>
          )}
          {!usarCredito && (
            <Campo rotulo="Conta financeira" span={credito > 0 ? 2 : 4}>
              <select required value={conta} onChange={(e) => setConta(e.target.value ? Number(e.target.value) : '')} className={INPUT_CLASS}>
                <option value="">Escolha a conta…</option>
                {apoio.contas.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
              </select>
            </Campo>
          )}
          <Campo rotulo={n.pago} span={2} dica="Sem mexer, quita pelo total do dia">
            <NumberField required scale={2} value={pago} onChange={(v) => ((origem.current = 'pago'), setPago(v))} className={INPUT_CLASS} />
          </Campo>
          <Campo rotulo="Principal a amortizar" span={2} dica="Cálculo inverso: quanto cobrar para abater este principal">
            <NumberField scale={2} value={principal} onChange={(v) => ((origem.current = 'principal'), setPrincipal(v))} className={INPUT_CLASS} />
          </Campo>
          {!usarCredito && (
            <Campo rotulo={lado === 'receber' ? 'Tarifa (boleto/cartão)' : 'Tarifa bancária'} span={2}>
              <NumberField scale={2} value={tarifa} onChange={setTarifa} className={INPUT_CLASS} />
            </Campo>
          )}
          {atrasada && (
            <Campo rotulo="Dispensar encargos (R$)" span={2} dica="Precisa da permissão Dispensar encargos">
              <NumberField scale={2} value={dispensa} onChange={setDispensa} className={INPUT_CLASS} />
            </Campo>
          )}
          {Number(dispensa) > 0 && (
            <Campo rotulo="Motivo da dispensa" span={4}>
              <input required maxLength={255} value={motivo} onFocus={(e) => e.target.select()} onChange={(e) => setMotivo(e.target.value)} className={INPUT_CLASS} />
            </Campo>
          )}
          {lado === 'pagar' && (
            <Campo rotulo="Encargos do boleto do fornecedor" span={informados ? 2 : 4}>
              <Toggle checked={informados} onChange={setInformados} />
            </Campo>
          )}
          {informados && (
            <>
              <Campo rotulo="Multa do boleto"><NumberField scale={2} value={multaInf} onChange={setMultaInf} className={INPUT_CLASS} /></Campo>
              <Campo rotulo="Juros do boleto"><NumberField scale={2} value={jurosInf} onChange={setJurosInf} className={INPUT_CLASS} /></Campo>
            </>
          )}
          <Campo rotulo="Observações" span={4}>
            <textarea rows={2} maxLength={5000} value={obs} onChange={(e) => setObs(e.target.value)} className={INPUT_CLASS} />
          </Campo>
        </GradeCampos>

        <div className="rounded-xl border border-stone-200 dark:border-stone-800 p-3 bg-stone-50/60 dark:bg-stone-950/40 self-start">
          {erroSim ? <p className="text-xs text-rose-600">{erroSim}</p> : sim ? (
            <>
              <Info rotulo="Dias de atraso">{sim.diasAtraso}</Info>
              <Info rotulo="Saldo de principal">R$ {moeda(sim.saldoAntes)}</Info>
              <Info rotulo="Multa devida">R$ {moeda(sim.multaDevida)}</Info>
              <Info rotulo="Juros devidos">R$ {moeda(sim.jurosDevidos)}</Info>
              <Info rotulo="Total do dia" forte>R$ {moeda(sim.total_dia)}</Info>
              <div className="h-3" />
              <Info rotulo="Multa paga">R$ {moeda(sim.valorMulta)}</Info>
              <Info rotulo="Juros pagos">R$ {moeda(sim.valorJuros)}</Info>
              {Number(sim.valorDesconto) > 0 && <Info rotulo="Desconto de pontualidade" cor="text-emerald-600">R$ {moeda(sim.valorDesconto)}</Info>}
              {Number(sim.valorDispensado) > 0 && <Info rotulo="Encargos dispensados" cor="text-amber-600">R$ {moeda(sim.valorDispensado)}</Info>}
              <Info rotulo="Principal amortizado" forte>R$ {moeda(sim.valorPrincipal)}</Info>
              <Info rotulo="Saldo que sobra" forte cor={Number(sim.saldoDepois) ? 'text-amber-600' : 'text-emerald-600'}>R$ {moeda(sim.saldoDepois)}</Info>
              {Number(sim.valorExcedente) > 0 && <Info rotulo={lado === 'receber' ? 'Excedente → crédito do cliente' : 'Excedente → adiantamento'} cor="text-blue-600">R$ {moeda(sim.valorExcedente)}</Info>}
              <p className="mt-2 text-[10px] text-stone-400">Fator proporcional {Number(sim.fator).toLocaleString('pt-BR', { minimumFractionDigits: 8 })}</p>
            </>
          ) : <p className="text-xs text-stone-400">Calculando…</p>}
        </div>
      </div>
    </Janela>
  );
}
