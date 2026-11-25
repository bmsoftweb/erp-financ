# ERP-Financeiro

@../../_claude/web.md

Módulo Financeiro do ERP BMsoft: contas a receber e a pagar, baixas com encargos proporcionais, rateio obrigatório
(conta analítica × centro analítico), créditos, auditoria e período fechado. Especificação em
`../extras/PROMPT_IMPLEMENTACAO.md` e `../extras/Escopo_Modulo_Financeiro_v0.3.pdf`. Modelo 1 (Vite + React + Express),
copiado do erp-compras. Mesmo banco do ERP (`bmerp_000000`), aberto pelo erp-master.

## Estrutura
- `server.ts` (local) e `api/index.ts` (Vercel) usam `createApp()` de `server/app.ts`. Autenticação e pesquisas em
  `/api`; tudo do financeiro em `/api/financ`.
- Receber e pagar são tabelas separadas (`fin_receber_*`, `fin_pagar_*`) com **um** serviço parametrizado pelo lado:
  `LADOS` em `server/comum.ts` (nomes de tabela, sinal, conta padrão, contas de juros/multa/desconto).
- `server/calculo.ts`: `calcularBaixa` é função pura (Decimal, ROUND_HALF_UP), testada em `server/calculo.test.ts`.
  `server/rateio.ts`: `distribuir` (sobra de centavo na maior linha) e `fecha100`. `npm run teste` roda os dois.
- `server/teste-banco.ts`: ponta a ponta pela API contra o servidor rodando, **grava** na empresa informada
  (`npx tsx server/teste-banco.ts 0 <porta>`; a empresa 0 DEMONSTRACAO é a de testes).
- `server/titulos.ts` (criação idempotente por origem, cancelar, prorrogar, aprovar, situação da pessoa),
  `server/baixas.ts` (baixar, estornar LIFO, lote, simular), `server/cadastros.ts`, `server/painel.ts`,
  `server/acordos.ts` (compensação receber × pagar sem conta financeira; renegociação → título novo com rateio pelos
  valores de origem + juros/multa, originais 'renegociada'; desfazer cancela o título novo e devolve as originais),
  `server/semente.ts` (cadastros padrão e régua de cobrança com modelos; também pelo botão em Parâmetros).
  `server/anexos.ts`: anexos do título no Vercel Blob (`BLOB_READ_WRITE_TOKEN`), envio direto do navegador como no
  erp-crm; pasta `financ/<empresa>/<lado>/<título>/`.
- Fase 2 (caixa e conciliação): `server/caixa.ts` (lançamento direto com conta do plano + centro, transferência =
  saída + entrada com `transferencia_id` sem DRE, estorno de movimento = linha inversa na mesma data; caixa: abertura
  com troco, suprimento/sangria = transferência ligada à sessão, fechamento com contagem → diferença em Quebra de caixa;
  baixa em conta caixa com sessão aberta grava `caixa_sessao_id`). `server/conciliacao.ts` lê `ban_extrato_lancamentos`
  (só leitura) e muda a situação da linha pelo BMBancos (`server/bancos.ts`, token HMAC com `BANCOS_SECRET`, como no
  erp-pdv); `server/sugestoes.ts` (função pura das sugestões e dos pares N:N, teste em `sugestoes.test.ts`).
  `server/relatorios.ts`: fluxo de caixa (realizado + previsto + projetado, vencidas à parte), DRE caixa/competência,
  aging, extrato por pessoa, baixas, encargos, previsto × realizado. `server/datas.ts`: datas puras (recorrência).
  O OFX é importado no BMBancos (Extratos), não aqui.
- Fase 3 (recebimento automático): `server/recebimento.ts` emite boleto (`POST /api/boletos` do BMBancos com
  `referencia = FIN-P<parcela>-<seq>`, vínculo em `fin_receber_parcela_boletos`) e Pix `cob` (`fin_pix_cobrancas`; o
  BMBancos não tem cobv nem Pix Automático); liquidação por `GET /api/ocorrencias?desde=` (cursor numa linha
  `bancos.cursor` de `fin_eventos`), por consulta do txid e pelo webhook `POST /api/financ/webhooks/bancos`
  (`FINANC_WEBHOOK_SECRET`). Todo evento passa por `fin_eventos` (chave_dedup; 4xx não volta, 5xx volta em 2^n min).
  `server/eventos.ts`: fila de saída (instruções) usada dentro das transações de baixas/titulos/acordos.
  `server/cartao.ts`: transação de cartão (baixa do cliente `semConta` + `semLancamento`, título `cartao_adquirente`
  com o rateio do cliente), antecipação (`tarifa` → `conta_antecipacao_id`); em `lancar`, recebível de cartão lança
  +taxa de receita e −taxa em `conta_taxas_cartao_id`. `planoRecebivel` em `rateio.ts` (testado).
- Fase 4 (cobrança): `server/cobranca.ts` (régua: cada etapa ativa tem uma janela em dias — vencimento, emissão ou
  pagamento — e as parcelas nela viram `fin_cobranca_envios` com INSERT IGNORE no único (parcela, etapa, canal); envio
  agrupa cliente + etapa + canal + destino + vencimento; pendente de parcela que deixou de estar em aberto é cancelado),
  `server/enviador.ts` (`EnviadorMensagem`: WhatsApp Cloud API e SMTP de `sys_empresas_smtp`; `COBRANCA_SIMULAR=1` não
  envia; `ErroProvedor` deixa pendente para 30 min), `server/mensagens.ts` (funções puras, `mensagens.test.ts`).
  Agendador: `GET /api/financ/cron/cobranca` (Vercel Cron em `vercel.json`, `Authorization: Bearer CRON_SECRET`):
  régua só em horário comercial, fila de `fin_eventos` sempre; local só com `COBRANCA_AUTOMATICA=1`. Webhook da Meta em
  `/api/financ/webhooks/mensagens` (GET verificação, POST assinado com `WHATSAPP_CLOUD_APP_SECRET`). `{{link}}` = PDF do
  boleto em `/api/financ/publico/boleto/<parcela>.<hmac>` (precisa de `FINANC_URL_PUBLICA`). Tela `app/regua` e aba
  Mensagens (`app/parcelas/Mensagens.tsx`) na janela Cobrar. Opt-out/perfil em `fin_pessoas_financeiro`.
- Toda lista (`ListaCrm`) exporta Excel (CSV `;` com BOM) e PDF (impressão) pelo menu da lista (`lib/exportar.ts`).
- Telas em `app/`: `painel`, `parcelas` (mesma tela para receber/pagar, prop `lado`; no pagar, `Agenda.tsx` mostra o
  mês em calendário), `movimentos`, `caixa`, `conciliacao` (+ `Regras.tsx`), `fluxo`, `relatorios`, `cadastros`. Apoio comum em
  `lib/financ.tsx`; janela modal em `components/Janela.tsx`.

## Regras de negócio que não podem quebrar
- Dinheiro sempre `Decimal`/string, nunca float. Baixa e movimento nunca são apagados: estorno cria a linha inversa
  (`estorno_de_id`) e só a baixa mais recente da parcela pode ser estornada.
- Soma dos lançamentos de uma baixa = movimento líquido − excedente (líquido = pago − tarifa no receber, + tarifa no pagar).
- Nada grava em `ven_`/`com_`/`ban_`/`cad_`; `fin_legado_*` não é usado.

## Acesso
- Entrada pelo Master em `/api/entrar` (sem tela de login). Cookie `bm_financ_sessao`; `session.role` = `sys_usuarios.nivel`.
- `admin`/`super` podem tudo. Demais: `sys_perfil_permissao` × `sys_permissoes` (módulo `FIN`), ver `PERMISSOES` em `server/comum.ts`.
  Tela Cadastros › Permissões marca por perfil (os perfis são criados no Master).
- erp-vendas/erp-compras chamam a API com `Authorization: Bearer FINANC_CHAVE_API` + `X-Empresa-Id`
  (`rotaModulo` em `server/http.ts`). Corpo `{venda_id}`/`{entrada_id}` faz o financeiro ler a origem sozinho.
  Do lado deles, `server/financ.ts` (`FINANC_URL` + `FINANC_CHAVE_API`; vazio = não integra): o erp-vendas confere o
  crédito antes de gravar parcelas a prazo, gera o título quando a nota é autorizada e, ao cancelar a nota, pergunta antes
  (`{simular: true}` no cancelar por origem: 409 com parcela baixada) e cancela depois; o erp-compras faz o mesmo no
  lançar/estornar da entrada. O que não chegou (financeiro fora) a rodada agendada acerta em `sincronizarOrigens`
  (`titulos.ts`; também `POST /api/financ/origens/sincronizar`), só a partir da primeira venda/nota que virou título.
- Ícone `BarChart3` em âmbar. Porta padrão 3006 (`.claude/launch.json`).

## Banco
- O app nunca cria nem altera tabela. Migrations em `../extras/` (`20261125_000_*`, `20261125_001_*`), já aplicadas.

## Pendências (fases do prompt)
- Fases 2, 3 e 4 feitas; conciliação, boleto e Pix ponta a ponta só com BMBancos configurado (`BANCOS_URL`/`BANCOS_SECRET`)
  e uma conta do BMBancos na empresa. Sem agendador: a busca no BMBancos é pelo botão ou por um cron chamando
  `POST /api/financ/bancos/sincronizar` com a chave de API + `X-Empresa-Id` + `X-Usuario-Id`.
- Fase 4 feita; o teste da régua no teste-banco só roda com `COBRANCA_SIMULAR=1` no servidor e no teste. O cron de 15 min
  exige plano Pro na Vercel (no Hobby o cron é diário).
