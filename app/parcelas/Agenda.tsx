import React, { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, List } from 'lucide-react';
import { AvisoErro } from '@/components/AvisoErro';
import { api, hojeIso, moeda } from '@/lib/api';
import { somar, type Lado } from '@/lib/financ';

const DIAS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const iso = (y: number, m: number, d: number) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const BOTAO = 'h-[34px] flex items-center gap-1.5 px-3 rounded-lg text-xs font-semibold border border-stone-300 dark:border-stone-700 text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800 cursor-pointer';

/**
 * Agenda do contas a pagar: o mês em calendário, com o total em aberto de cada dia (saldo), vencidos em vermelho e
 * pagamentos aguardando aprovação em âmbar. Clicar no dia abre a lista daquele vencimento.
 */
export function Agenda({ lado, onDia, onLista }: { lado: Lado; onDia: (iso: string) => void; onLista: () => void }) {
  const hoje = hojeIso();
  const [mes, setMes] = useState(() => ({ y: Number(hoje.slice(0, 4)), m: Number(hoje.slice(5, 7)) - 1 }));
  const [linhas, setLinhas] = useState<any[]>([]);
  const [vencidas, setVencidas] = useState<any[]>([]);
  const [erro, setErro] = useState('');

  const ultimo = new Date(mes.y, mes.m + 1, 0).getDate();
  useEffect(() => {
    const q = new URLSearchParams({ situacao: 'abertas', de: iso(mes.y, mes.m, 1), ate: iso(mes.y, mes.m, ultimo) });
    api<any[]>(`/api/financ/${lado}/parcelas?${q}`).then(setLinhas).catch((e) => setErro(e.message));
  }, [lado, mes, ultimo]);
  useEffect(() => void api<any[]>(`/api/financ/${lado}/parcelas?situacao=vencidas`).then(setVencidas).catch((e) => setErro(e.message)), [lado]);

  const porDia = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const l of linhas) m.set(l.vencimento.slice(0, 10), [...(m.get(l.vencimento.slice(0, 10)) ?? []), l]);
    return m;
  }, [linhas]);
  const inicio = new Date(mes.y, mes.m, 1).getDay();
  const celulas = [...Array(inicio).fill(null), ...Array.from({ length: ultimo }, (_, i) => i + 1)];
  const andar = (n: number) => setMes(({ y, m }) => ({ y: m + n < 0 ? y - 1 : m + n > 11 ? y + 1 : y, m: (m + n + 12) % 12 }));

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0 p-3 gap-3 overflow-auto">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => andar(-1)} title="Mês anterior" className={BOTAO}><ChevronLeft className="w-4 h-4" /></button>
        <span className="text-sm font-bold w-40 text-center capitalize">{MESES[mes.m]} de {mes.y}</span>
        <button type="button" onClick={() => andar(1)} title="Próximo mês" className={BOTAO}><ChevronRight className="w-4 h-4" /></button>
        <button type="button" onClick={() => setMes({ y: Number(hoje.slice(0, 4)), m: Number(hoje.slice(5, 7)) - 1 })} className={BOTAO}>Hoje</button>
        <span className="text-xs text-stone-500 ml-2">No mês: <b className="tabular-nums">R$ {moeda(somar(linhas.map((l) => l.saldo)))}</b> em {linhas.length} parcela(s)</span>
        {vencidas.length > 0 && (
          <span className="text-xs text-rose-600 font-semibold">Vencidas (todas): R$ {moeda(somar(vencidas.map((l) => l.saldo)))} em {vencidas.length}</span>
        )}
        <span className="flex-1" />
        <button type="button" onClick={onLista} className={BOTAO}><List className="w-4 h-4" /> Ver lista</button>
      </div>

      <div className="grid grid-cols-7 gap-1 min-w-[640px]">
        {DIAS.map((d) => <div key={d} className="text-[11px] font-semibold text-stone-500 text-center py-1">{d}</div>)}
        {celulas.map((dia, i) => {
          if (!dia) return <div key={`v${i}`} />;
          const data = iso(mes.y, mes.m, dia);
          const itens = porDia.get(data) ?? [];
          const vencido = itens.length > 0 && data < hoje;
          const pendentes = itens.filter((l) => l.aprovacao_status === 'pendente').length;
          return (
            <button
              key={data}
              type="button"
              disabled={!itens.length}
              onClick={() => onDia(data)}
              title={itens.length ? `${itens.length} parcela(s)` : undefined}
              data-dica-desc={itens.length ? itens.slice(0, 6).map((l) => `${l.pessoa_nome}: R$ ${moeda(l.saldo)}`).join(' · ') + (itens.length > 6 ? ' …' : '') : undefined}
              className={`h-20 rounded-lg border p-1.5 text-left flex flex-col transition-colors ${data === hoje ? 'border-blue-400 dark:border-blue-600' : 'border-stone-200 dark:border-stone-800'} ${itens.length ? 'cursor-pointer hover:bg-stone-50 dark:hover:bg-stone-800/60' : 'cursor-default'} ${vencido ? 'bg-rose-50/70 dark:bg-rose-950/30' : ''}`}
            >
              <span className={`text-[11px] ${data === hoje ? 'font-bold text-blue-600' : 'text-stone-400'}`}>{dia}</span>
              {itens.length > 0 && (
                <>
                  <span className={`mt-auto text-right text-xs font-semibold tabular-nums ${vencido ? 'text-rose-600' : ''}`}>R$ {moeda(somar(itens.map((l) => l.saldo)))}</span>
                  <span className="text-right text-[10px] text-stone-500">
                    {itens.length} parc.{pendentes > 0 && <span className="ml-1 text-amber-600 font-semibold">· {pendentes} p/ aprovar</span>}
                  </span>
                </>
              )}
            </button>
          );
        })}
      </div>
      {erro && <AvisoErro mensagem={erro} onFechar={() => setErro('')} />}
    </div>
  );
}
