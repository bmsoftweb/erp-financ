import express from 'express';
import { createAuthRouter } from './auth.js';
import { createPesquisasRouter } from './pesquisas.js';
import { createCadastrosRouter } from './cadastros.js';
import { createTitulosRouter } from './titulos.js';
import { createBaixasRouter } from './baixas.js';
import { createPainelRouter } from './painel.js';
import { createAcordosRouter } from './acordos.js';
import { createAnexosRouter } from './anexos.js';
import { createCaixaRouter } from './caixa.js';
import { createConciliacaoRouter } from './conciliacao.js';
import { createRelatoriosRouter } from './relatorios.js';
import { createRecebimentoRouter } from './recebimento.js';
import { createCartaoRouter } from './cartao.js';
import { createCobrancaRouter } from './cobranca.js';

/**
 * App Express só com a API. Sessão e pesquisas em /api (como nos outros módulos); o financeiro em /api/financ.
 * Usado pelo servidor local (server.ts) e pela função da Vercel (api/index.ts).
 */
export function createApp() {
  const app = express();
  // Corpo bruto guardado para conferir a assinatura do webhook do BMBancos
  app.use(express.json({ limit: '2mb', verify: (req, _res, buf) => void ((req as any).rawBody = buf) }));

  app.use('/api', createAuthRouter());
  app.use('/api', createPesquisasRouter());
  app.use('/api/financ', createPainelRouter());
  app.use('/api/financ', createCadastrosRouter());
  app.use('/api/financ', createTitulosRouter());
  app.use('/api/financ', createBaixasRouter());
  app.use('/api/financ', createAcordosRouter());
  app.use('/api/financ', createAnexosRouter());
  app.use('/api/financ', createCaixaRouter());
  app.use('/api/financ', createConciliacaoRouter());
  app.use('/api/financ', createRelatoriosRouter());
  app.use('/api/financ', createRecebimentoRouter());
  app.use('/api/financ', createCartaoRouter());
  app.use('/api/financ', createCobrancaRouter());

  // API desconhecida: 404 em JSON em vez de cair no index.html
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Rota não encontrada' }));
  return app;
}
