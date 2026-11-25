import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from '@/components/Sidebar';
import { TelaHeader } from '@/components/TelaHeader';
import { RodapeSistema } from '@/components/RodapeSistema';

/**
 * Casca das telas logadas, como no Romaneio e no crmWeb: menu, cabeçalho e barra de status ficam aqui, uma vez só,
 * e não são refeitos ao trocar de opção. Cada tela desenha apenas o conteúdo; o título vem da rota.
 */

const TELAS: Record<string, { titulo: string; subtitulo: string; semCabecalho?: boolean }> = {
  '/painel': { titulo: 'Painel financeiro', subtitulo: 'A receber, a pagar e saldo das contas' },
  '/receber': { titulo: 'Contas a receber', subtitulo: 'Parcelas de clientes: baixa com juros e multa proporcionais, prorrogação e estorno' },
  '/pagar': { titulo: 'Contas a pagar', subtitulo: 'Parcelas de fornecedores: agenda, aprovação e pagamento' },
  '/cartao': { titulo: 'Cartão e recebíveis', subtitulo: 'Vendas no cartão, recebíveis contra os adquirentes e antecipação' },
  '/integracao': { titulo: 'Integração bancária', subtitulo: 'Boletos pagos, Pix recebidos e instruções ao BMBancos, com retentativa' },
  '/regua': { titulo: 'Régua de cobrança', subtitulo: 'Etapas, modelos de WhatsApp e email com prévia, e o histórico de envios' },
  '/taxas-cartao': { titulo: 'Taxas de cartão', subtitulo: 'Por adquirente, bandeira, modalidade e parcelas; viram despesa no repasse' },
  '/movimentos': { titulo: 'Movimento de contas', subtitulo: 'Entradas e saídas com saldo; lançamento direto, transferência e estorno' },
  '/caixa': { titulo: 'Caixa', subtitulo: 'Abertura com troco, suprimento, sangria e fechamento com contagem' },
  '/conciliacao': { titulo: 'Conciliação bancária', subtitulo: 'Extrato do BMBancos × movimentos, com sugestões automáticas' },
  '/regras-conciliacao': { titulo: 'Regras de conciliação', subtitulo: 'Casam linhas do extrato por histórico, documento ou valor' },
  '/fluxo-caixa': { titulo: 'Fluxo de caixa', subtitulo: 'Realizado, previsto e projetado, com alerta de saldo negativo' },
  '/relatorios': { titulo: 'Relatórios', subtitulo: 'DRE, aging, extrato por pessoa, baixas, encargos e previsto × realizado' },
  '/plano-contas': { titulo: 'Plano de contas', subtitulo: 'Contas gerenciais; só as analíticas recebem lançamento' },
  '/centros-custo': { titulo: 'Centros de custo', subtitulo: 'Onde cada valor é classificado, junto com a conta do plano' },
  '/contas': { titulo: 'Contas financeiras', subtitulo: 'Caixas, bancos e carteiras; saldo = saldo inicial + movimentos' },
  '/formas': { titulo: 'Formas de pagamento', subtitulo: 'Mesmos nomes das parcelas de venda e compra; conta padrão e D+n' },
  '/parametros': { titulo: 'Parâmetros', subtitulo: 'Encargos, contas padrão, aprovação de pagamentos e período fechado' },
  '/permissoes': { titulo: 'Permissões', subtitulo: 'O que cada perfil do Master pode fazer no financeiro' },
};

/** O botão de recarregar do cabeçalho chama o que a tela ativa registrou */
const RefreshCtx = createContext<{ registrar: (fn: (() => void) | null) => void }>({ registrar: () => {} });

/** A tela registra como se recarrega (o botão só aparece nas que registram) */
export function useRefreshDaTela(fn: () => void) {
  const { registrar } = useContext(RefreshCtx);
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    registrar(() => ref.current());
    return () => registrar(null);
  }, [registrar]);
}

export const LayoutApp: React.FC = () => {
  const { pathname } = useLocation();
  const [empresa, setEmpresa] = useState<string | undefined>();
  const [nome, setNome] = useState('');
  const [refresh, setRefresh] = useState<(() => void) | null>(null);
  const registrar = useCallback((fn: (() => void) | null) => setRefresh(() => fn), []);

  useEffect(() => {
    fetch('/api/user')
      .then((r) => (r.ok ? r.json() : null))
      .then((u) => {
        if (!u) return;
        setNome(u.userName || '');
        setEmpresa(u.empresaNome);
      })
      .catch(() => {});
  }, []);

  const tela = TELAS[pathname] ?? { titulo: '', subtitulo: '' };
  return (
    <RefreshCtx.Provider value={{ registrar }}>
      <div className="min-h-screen bg-elegant-bg font-sans text-elegant-text">
        <Sidebar userName={nome || 'Admin'} />
        <div className="lg:ml-[var(--larg-menu)] h-screen flex flex-col min-w-0 overflow-hidden">
          {!tela.semCabecalho && <TelaHeader titulo={tela.titulo} subtitulo={tela.subtitulo} empresaNome={empresa} onRefresh={refresh ?? undefined} />}
          <div className="flex-1 min-h-0 flex flex-col">
            <Outlet />
          </div>
          <RodapeSistema />
        </div>
      </div>
    </RefreshCtx.Provider>
  );
};
