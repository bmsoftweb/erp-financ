import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowDownCircle, ArrowUpCircle, Landmark, ShieldCheck } from 'lucide-react';
import { useRefreshDaTela } from '@/components/LayoutApp';
import { AvisoErro } from '@/components/AvisoErro';
import { api, moeda } from '@/lib/api';

interface Resumo { vencido: string; qtd_vencido: number; hoje: string; semana: string; mes: string; total: string }
interface Painel { hoje: string; receber: Resumo; pagar: Resumo; aprovar: { n: number; v: string }; contas: { id: number; nome: string; tipo: string; saldo: string }[] }

const Linha = ({ rotulo, valor, destaque }: { rotulo: string; valor: string; destaque?: boolean }) => (
  <div className="flex items-center justify-between py-1.5 border-b border-stone-100 dark:border-stone-800 last:border-0">
    <span className="text-xs text-stone-500 dark:text-stone-400">{rotulo}</span>
    <span className={`text-sm font-semibold tabular-nums ${destaque && Number(valor) ? 'text-rose-600 dark:text-rose-400' : ''}`}>R$ {moeda(valor)}</span>
  </div>
);

const Cartao = ({ titulo, icone: Icone, cor, para, r }: { titulo: string; icone: typeof ArrowDownCircle; cor: string; para: string; r: Resumo }) => (
  <Link to={para} className="block p-4 rounded-2xl border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 hover:shadow-md transition-shadow">
    <div className="flex items-center gap-2 mb-2">
      <Icone className={`w-5 h-5 ${cor}`} />
      <h2 className="text-sm font-bold">{titulo}</h2>
      <span className="ml-auto text-lg font-black tabular-nums">R$ {moeda(r.total)}</span>
    </div>
    <Linha rotulo={`Vencido (${r.qtd_vencido})`} valor={r.vencido} destaque />
    <Linha rotulo="Vence hoje" valor={r.hoje} />
    <Linha rotulo="Próximos 7 dias" valor={r.semana} />
    <Linha rotulo="Próximos 30 dias" valor={r.mes} />
  </Link>
);

export default function PainelPage() {
  const [p, setP] = useState<Painel | null>(null);
  const [erro, setErro] = useState('');
  const carregar = useCallback(() => api<Painel>('/api/financ/painel').then(setP).catch((e) => setErro(e.message)), []);
  useEffect(() => void carregar(), [carregar]);
  useRefreshDaTela(carregar);

  const totalContas = p ? p.contas.reduce((a, c) => a + Math.round(Number(c.saldo) * 100), 0) / 100 : 0;
  return (
    <div className="flex-1 overflow-auto p-4 lg:p-6">
      {p && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 max-w-6xl">
          <Cartao titulo="A receber" icone={ArrowDownCircle} cor="text-emerald-600" para="/receber" r={p.receber} />
          <Cartao titulo="A pagar" icone={ArrowUpCircle} cor="text-rose-600" para="/pagar" r={p.pagar} />
          <div className="p-4 rounded-2xl border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900">
            <div className="flex items-center gap-2 mb-2">
              <Landmark className="w-5 h-5 text-amber-600" />
              <h2 className="text-sm font-bold">Saldo das contas</h2>
              <span className={`ml-auto text-lg font-black tabular-nums ${totalContas < 0 ? 'text-rose-600' : ''}`}>R$ {moeda(totalContas)}</span>
            </div>
            {p.contas.length ? p.contas.map((c) => <Linha key={c.id} rotulo={c.nome} valor={c.saldo} destaque={Number(c.saldo) < 0} />) : (
              <p className="text-xs text-stone-500">Nenhuma conta financeira. <Link to="/contas" className="text-blue-600 underline">Cadastrar</Link></p>
            )}
            {p.contas.some((c) => Number(c.saldo) < 0) && (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-rose-600"><AlertTriangle className="w-4 h-4" /> Conta com saldo negativo.</p>
            )}
          </div>
          {Number(p.aprovar.n) > 0 && (
            <Link to="/pagar?situacao=aprovar" className="flex items-center gap-3 p-4 rounded-2xl border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40">
              <ShieldCheck className="w-5 h-5 text-amber-600" />
              <span className="text-sm"><b>{p.aprovar.n}</b> pagamento(s) aguardando aprovação: R$ {moeda(p.aprovar.v)}</span>
            </Link>
          )}
        </div>
      )}
      {erro && <AvisoErro mensagem={erro} onFechar={() => setErro('')} />}
    </div>
  );
}
