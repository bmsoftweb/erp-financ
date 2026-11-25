# Histórico de versões

Mais recente primeiro. PATCH a cada envio ao GitHub; MAJOR/MINOR só quando pedido.

## 0.1.1 — 2026-11-25

- Integração com erp-vendas e erp-compras: venda com nota autorizada vira conta a receber e nota de entrada lançada vira
  conta a pagar; cancelar a nota da venda ou estornar a entrada é recusado se alguma parcela já foi baixada e, se não,
  cancela o título. O que não chegou com o financeiro fora do ar é acertado na rodada automática.
- Parcelas "Sem pagamento" (NFC-e dos 180 dias) não viram conta a receber.
- Primeiro envio ao GitHub.

## 0.1.0 — 2026-11-24

- Criação do app (fase 1): contas a receber e a pagar com títulos, parcelas e rateio obrigatório (conta × centro, 100%).
- Baixa total, parcial e em lote com multa, juros e desconto proporcionais, cálculo inverso, dispensa de encargos,
  tarifa, crédito do cliente/adiantamento e excedente; estorno da última baixa.
- Prorrogação, cancelamento de título, aprovação de pagamentos, período fechado e auditoria.
- API para erp-vendas/erp-compras (criação idempotente por origem, cancelamento, situação da pessoa).
- Cadastros: plano de contas, centros de custo, contas financeiras, formas de pagamento e parâmetros (com criação dos cadastros padrão).
- Painel com vencidos, a vencer, saldos das contas e pagamentos aguardando aprovação.
- Renegociação das parcelas marcadas (mesma pessoa) em um título novo, com dispensa de encargos; desfazer devolve as parcelas originais.
- Compensação de parcela a receber com parcela a pagar da mesma pessoa; o estorno desfaz os dois lados.
- Tela de permissões por perfil e régua de cobrança padrão com os modelos de mensagem (criada em Parâmetros).
- Anexos no título (nota, boleto, comprovante), guardados no Vercel Blob.
- Agenda do contas a pagar: vencimentos do mês em calendário, com vencidos e pagamentos aguardando aprovação.
- Fase 2: movimento de contas com saldo, lançamento direto (tarifa, rendimento, IOF), transferência e estorno de movimento.
- Caixa: abertura com troco, suprimento, sangria e fechamento com contagem; a diferença vira lançamento em Quebra de caixa.
- Conciliação bancária com o extrato do BMBancos: sugestões automáticas, confirmação em lote, conciliação manual com
  oferta de virar regra, linha sem par como lançamento direto ou baixa, desfazer; tela de regras de conciliação.
- Fluxo de caixa (realizado, previsto e projetado; diário, semanal ou mensal; por conta, plano ou centro) com alerta de saldo negativo.
- Relatórios: DRE caixa e competência, aging, extrato por pessoa, baixas, juros e descontos, previsto × realizado.
- Exportação Excel e PDF em todas as listas.
- Fase 3: cobrança da parcela a receber por boleto/bolecode e Pix pelo BMBancos (reemissão com referência nova e baixa
  do boleto antigo; prorrogar, cancelar, renegociar ou quitar fora do banco manda a instrução ao banco).
- Baixa automática: liquidações lidas do BMBancos (Integração bancária › Buscar) e webhook assinado; boleto e Pix
  avisados duas vezes baixam uma vez só. Fila de eventos com retentativa exponencial e reprocessamento.
- Cartão: a parcela do cliente fica quitada e nasce o recebível contra o adquirente, mês a mês, líquido da taxa;
  no repasse a receita entra bruta e a taxa como despesa; antecipação com custo próprio; cadastro de taxas de cartão.
- Fase 4: régua de cobrança por WhatsApp (API oficial da Meta, com modelos aprovados) e email (SMTP da empresa):
  etapas por perfil de cliente, modelos com prévia, agrupamento das parcelas do mesmo cliente no mesmo vencimento,
  valor atualizado com multa e juros do dia, para sozinha quando a parcela é paga, cancelada ou renegociada, e
  respeita o opt-out por canal (inclusive "Sair" respondido no WhatsApp). Rodada automática a cada 15 min em horário
  comercial (Vercel Cron), botão "Rodar agora", histórico de envios e status entregue/lido/respondido pelo webhook.
- Aba Mensagens na janela Cobrar: envio avulso com prévia, histórico da parcela e opt-out do cliente.
- Situação do cliente para o erp-vendas diz se pode vender a prazo e por quê não (bloqueado, atraso, limite).
