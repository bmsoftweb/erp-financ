import React from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import Login from './app/page';
import { LayoutApp } from '@/components/LayoutApp';
import Painel from './app/painel/page';
import Parcelas from './app/parcelas/page';
import Arvore from './app/cadastros/Arvore';
import Contas from './app/cadastros/Contas';
import Formas from './app/cadastros/Formas';
import Parametros from './app/cadastros/Parametros';
import Permissoes from './app/cadastros/Permissoes';
import Movimentos from './app/movimentos/page';
import Caixa from './app/caixa/page';
import Conciliacao from './app/conciliacao/page';
import Regras from './app/conciliacao/Regras';
import Fluxo from './app/fluxo/page';
import Relatorios from './app/relatorios/page';
import Cartao from './app/cartao/page';
import Integracao from './app/integracao/page';
import Taxas from './app/cadastros/Taxas';
import Regua from './app/regua/page';

/** Uma rota por tela; contas a receber e a pagar são a mesma tela, pelo lado */
export const App: React.FC = () => (
  <Routes>
    <Route path="/" element={<Login />} />
    <Route element={<LayoutApp />}>
      <Route path="/painel" element={<Painel />} />
      <Route path="/receber" element={<Parcelas key="receber" lado="receber" />} />
      <Route path="/pagar" element={<Parcelas key="pagar" lado="pagar" />} />
      <Route path="/movimentos" element={<Movimentos />} />
      <Route path="/caixa" element={<Caixa />} />
      <Route path="/conciliacao" element={<Conciliacao />} />
      <Route path="/regras-conciliacao" element={<Regras />} />
      <Route path="/fluxo-caixa" element={<Fluxo />} />
      <Route path="/relatorios" element={<Relatorios />} />
      <Route path="/cartao" element={<Cartao />} />
      <Route path="/integracao" element={<Integracao />} />
      <Route path="/taxas-cartao" element={<Taxas />} />
      <Route path="/regua" element={<Regua />} />
      <Route path="/plano-contas" element={<Arvore key="plano" tipo="plano" />} />
      <Route path="/centros-custo" element={<Arvore key="centros" tipo="centros" />} />
      <Route path="/contas" element={<Contas />} />
      <Route path="/formas" element={<Formas />} />
      <Route path="/parametros" element={<Parametros />} />
      <Route path="/permissoes" element={<Permissoes />} />
    </Route>
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes>
);
