import crypto from 'node:crypto';
import { Router, type Request } from 'express';
import Decimal from 'decimal.js';
import { masterPool as pool, transacao, hojeSql } from './db.js';
import { ErroHttp, falha, iguais, rota, rotaModulo, rotaPublica } from './http.js';
import type { SessionData } from './session.js';
import { auditar, empresaDe, somarDias, usuarioDe } from './comum.js';
import { bancos, bancosBruto } from './bancos.js';
import { baixar, validarBaixa } from './baixas.js';
import { totalDoDia, round2 } from './calculo.js';
import { enfileirar, sha256 } from './eventos.js';

/**
 * Fase 3: recebimento automático. Só o erp-bancos fala com os bancos; aqui o financeiro decide o que cobrar,
 * guarda o vínculo (fin_receber_parcela_boletos, fin_pix_cobrancas) e baixa quando o pagamento chega:
 *  - consulta GET /api/ocorrencias?desde= do BMBancos (é assim que ele devolve as liquidações) e Pix pelo txid;
 *  - webhook POST /api/financ/webhooks/bancos (assinado com FINANC_WEBHOOK_SECRET).
 * Tudo passa por fin_eventos: chave_dedup impede baixa em dobro e erro temporário volta com espera exponencial.
 */

const REF = /^FIN-P(\d+)-(\d+)$/;
const dinheiro = (v: unknown) => new Decimal(v == null || v === '' ? 0 : String(v)).toFixed(2);
/** Instante do PSP (ISO com fuso) → data e hora de Brasília (UTC−3, sem horário de verão) */
function brasilia(iso: string) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const x = new Date(t - 3 * 3600_000).toISOString();
  return { data: x.slice(0, 10), hora: `${x.slice(0, 10)} ${x.slice(11, 19)}` };
}

// ------------------------------------------------------------------ emissão

async function parcelaParaCobrar(empresa: number, id: number) {
  const [[p]]: any = await pool.query(
    `SELECT p.*, t.numero_documento, t.pessoa_id, pe.nome, pe.cpf_cnpj, pe.logradouro, pe.numero AS end_numero, pe.complemento, pe.bairro,
            pe.cidade_nome, pe.cidade_uf, pe.cep, COALESCE(pe.email_cobranca, pe.email_principal) AS email
       FROM fin_receber_parcelas p JOIN fin_receber_titulos t ON t.id = p.titulo_id JOIN cad_pessoas pe ON pe.id = t.pessoa_id
      WHERE p.id = ? AND p.empresa_id = ?`,
    [id, empresa],
  );
  if (!p) falha('Parcela não encontrada.', 404);
  if (p.status !== 'aberta' && p.status !== 'parcial') falha(`Parcela ${p.status}: não há o que cobrar.`);
  return p;
}

async function contaBancos(empresa: number, contaId: number | null | undefined) {
  if (!contaId) falha('Informe a conta financeira (ou deixe uma conta padrão na parcela).');
  const [[c]]: any = await pool.query('SELECT id, nome, ban_conta_id FROM fin_contas_financeiras WHERE id = ? AND empresa_id = ? AND ativo = 1', [contaId, empresa]);
  if (!c) falha('Conta financeira não encontrada.');
  if (!c.ban_conta_id) falha(`A conta "${c.nome}" não está ligada a uma conta do BMBancos (Cadastros › Contas financeiras).`);
  return c;
}

/** Emite (ou reemite) o boleto da parcela pelo saldo, com multa, juros e desconto da parcela */
async function emitirBoleto(s: SessionData, req: Request, parcelaId: number, contaId?: number | null) {
  const empresa = empresaDe(s);
  const p = await parcelaParaCobrar(empresa, parcelaId);
  const conta = await contaBancos(empresa, contaId ?? p.conta_financeira_id);
  const hoje = await hojeSql(pool);
  const venc = String(p.vencimento).slice(0, 10);
  if (venc < hoje) falha('Parcela vencida: prorrogue o vencimento antes de emitir o boleto.');
  const doc = String(p.cpf_cnpj || '').replace(/\D/g, '');
  if (doc.length !== 11 && doc.length !== 14) falha(`Cliente "${p.nome}" sem CPF/CNPJ: o boleto precisa do documento do pagador.`);

  const [vinculos]: any = await pool.query('SELECT id, boleto_id, referencia, ativo FROM fin_receber_parcela_boletos WHERE parcela_id = ? ORDER BY id', [p.id]);
  const referencia = `FIN-P${p.id}-${vinculos.length + 1}`;
  const inicioEncargos = Number(p.carencia_dias) > 0 ? somarDias(venc, Number(p.carencia_dias) + 1) : undefined;
  const desconto = Number(p.desconto_pct) > 0 && p.desconto_ate && String(p.desconto_ate).slice(0, 10) >= hoje
    ? { valor: Number(round2(new Decimal(p.saldo).times(p.desconto_pct).div(100))), data: String(p.desconto_ate).slice(0, 10) }
    : null;
  // Mesma referência = mesmo boleto no BMBancos: repetir a chamada depois de uma falha não emite dois
  const r = await bancos(s, '/boletos', {
    referencia,
    contaId: conta.ban_conta_id,
    dataVencimento: venc,
    valor: Number(p.saldo),
    pagador: {
      documento: doc, nome: p.nome, logradouro: p.logradouro || '', numero: p.end_numero || undefined, complemento: p.complemento || undefined,
      bairro: p.bairro || '', cidade: p.cidade_nome || '', uf: p.cidade_uf || '', cep: String(p.cep || '').replace(/\D/g, ''), email: p.email || undefined,
    },
    multa: Number(p.multa_pct) > 0 ? { percentual: Number(p.multa_pct), ...(inicioEncargos && { data: inicioEncargos }) } : null,
    juros: Number(p.juros_mes_pct) > 0 ? { percentualMensal: Number(p.juros_mes_pct), ...(inicioEncargos && { data: inicioEncargos }) } : null,
    desconto,
  });

  await transacao(async (c) => {
    const antigos = vinculos.filter((v: any) => Number(v.ativo));
    // Reemissão: referência nova, a antiga fica inativa e é baixada no banco
    for (const v of antigos) {
      await c.query('UPDATE fin_receber_parcela_boletos SET ativo = 0 WHERE id = ?', [v.id]);
      if (v.boleto_id) await enfileirar(c, s, 'boleto.instrucao', { boleto_id: v.boleto_id, referencia: v.referencia, tipo: 'baixar', dados: {} });
    }
    await c.query('INSERT INTO fin_receber_parcela_boletos SET ?', [{ empresa_id: empresa, parcela_id: p.id, boleto_id: r.boleto.id, referencia, usuario_id: usuarioDe(s) }])
      .catch((e: any) => (e?.code === 'ER_DUP_ENTRY' ? falha('Boleto emitido agora por outra chamada: atualize a tela.', 409) : Promise.reject(e)));
    await auditar(c, s, req, 'fin_receber_parcelas', p.id, antigos.length ? 'reemitir_boleto' : 'emitir_boleto', antigos.length ? { referencias: antigos.map((v: any) => v.referencia) } : null, { referencia, boleto_id: r.boleto.id, valor: p.saldo, vencimento: venc });
  });
  await processarFila(s);
  return { referencia, boleto: r.boleto };
}

/** Pix cobrança imediata (cob) pelo total do dia. O BMBancos ainda não tem cobv nem Pix Automático. */
async function gerarPix(s: SessionData, req: Request, parcelaId: number, contaId?: number | null) {
  const empresa = empresaDe(s);
  const p = await parcelaParaCobrar(empresa, parcelaId);
  const conta = await contaBancos(empresa, contaId ?? p.conta_financeira_id);
  const hoje = await hojeSql(pool);
  const base = Number(p.manter_encargos_original) ? p.vencimento_original : p.vencimento;
  const valor = totalDoDia({ saldo: p.saldo, vencimento: String(base).slice(0, 10), dataPagamento: hoje, carenciaDias: p.carencia_dias, multaPct: p.multa_pct, jurosMesPct: p.juros_mes_pct, descontoPct: p.desconto_pct, descontoAte: p.desconto_ate });
  // Cobrança ativa, no prazo e com o mesmo valor: devolve a mesma
  const [[ja]]: any = await pool.query(
    "SELECT * FROM fin_pix_cobrancas WHERE parcela_id = ? AND status = 'ativa' AND expira_em > NOW() AND valor = ? ORDER BY id DESC LIMIT 1",
    [p.id, valor],
  );
  if (ja) return ja;
  const expiracao = 86400;
  const r = await bancos(s, '/pix/cobrancas', {
    valor: Number(valor), contaId: conta.ban_conta_id, expiracao, referencia: `FIN-P${p.id}`,
    descricao: `${p.numero_documento ?? `Título ${p.titulo_id}`} parc. ${p.numero}/${p.total_parcelas}`,
  });
  const cob = r.cobranca;
  return transacao(async (c) => {
    const [ins]: any = await c.query('INSERT INTO fin_pix_cobrancas SET ?, expira_em = DATE_ADD(NOW(), INTERVAL ? SECOND)', [{
      empresa_id: empresa, parcela_id: p.id, conta_financeira_id: conta.id, txid: cob.txid, tipo: 'cob', valor, pix_emv: cob.pixCopiaECola,
      vencimento: String(p.vencimento).slice(0, 10), dados: JSON.stringify(r), usuario_id: usuarioDe(s),
    }, expiracao]);
    await auditar(c, s, req, 'fin_receber_parcelas', p.id, 'gerar_pix', null, { txid: cob.txid, valor });
    const [[x]]: any = await c.query('SELECT * FROM fin_pix_cobrancas WHERE id = ?', [ins.insertId]);
    return x;
  });
}

// ------------------------------------------------------------------ eventos

/** Aplica um evento de entrada (dentro da transação). ErroHttp 422 = não é do financeiro: descartado. */
async function aplicarEntrada(s: SessionData, tipo: string, x: any) {
  const empresa = empresaDe(s);
  return transacao(async (c) => {
    if (tipo === 'boleto.liquidado') {
      const [[v]]: any = await c.query('SELECT parcela_id FROM fin_receber_parcela_boletos WHERE empresa_id = ? AND referencia = ?', [empresa, String(x.referencia ?? '')]);
      if (!v) falha(`Referência ${x.referencia} não é de boleto do financeiro.`, 422);
      const [[cf]]: any = await c.query(
        `SELECT COALESCE((SELECT id FROM fin_contas_financeiras WHERE empresa_id = ? AND ban_conta_id = ?), p.conta_financeira_id) AS id
           FROM fin_receber_parcelas p WHERE p.id = ?`,
        [empresa, Number(x.contaId) || 0, v.parcela_id],
      );
      if (!cf?.id) falha(`Nenhuma conta financeira ligada à conta ${x.contaId} do BMBancos.`);
      const data = String(x.dataOcorrencia).slice(0, 10);
      const b = await baixar(c, s, null, 'receber', v.parcela_id, validarBaixa({
        data_pagamento: data, data_conta: x.dataCredito ? String(x.dataCredito).slice(0, 10) : data, conta_financeira_id: cf.id,
        valor_pago: dinheiro(x.valorPago), valor_tarifa: dinheiro(x.valorTarifa),
        // O banco manda mora (juros + multa) num campo só: entra como juros
        juros_informados: dinheiro(x.valorJuros), multa_informada: '0.00',
        observacoes: `Retorno do banco: boleto ${x.referencia}, ocorrência ${x.id}`,
      }), { origem: 'retorno_banco', banOcorrenciaId: Number(x.id) });
      return { parcela_id: v.parcela_id, baixa_id: b.baixaId, status: b.status };
    }
    if (tipo === 'pix.recebido') {
      const [[cob]]: any = await c.query('SELECT * FROM fin_pix_cobrancas WHERE empresa_id = ? AND txid = ? FOR UPDATE', [empresa, String(x.txid ?? '')]);
      if (!cob) falha(`Txid ${x.txid} não é de cobrança Pix do financeiro.`, 422);
      if (cob.status === 'concluida') return { parcela_id: cob.parcela_id, jaBaixada: true };
      const quando = brasilia(String(x.pagoEm || '')) ?? { data: await hojeSql(c), hora: null };
      const b = await baixar(c, s, null, 'receber', cob.parcela_id, validarBaixa({
        data_pagamento: quando.data, conta_financeira_id: cob.conta_financeira_id, valor_pago: dinheiro(x.valor ?? cob.valor),
        observacoes: `Pix ${cob.txid}${x.endToEndId ? `, E2E ${x.endToEndId}` : ''}`,
      }), { origem: 'pix' });
      await c.query("UPDATE fin_pix_cobrancas SET status = 'concluida', e2e_id = ?, pago_em = COALESCE(?, NOW()) WHERE id = ?", [x.endToEndId || null, quando.hora, cob.id]);
      return { parcela_id: cob.parcela_id, baixa_id: b.baixaId, status: b.status };
    }
    falha(`Tipo de evento desconhecido: ${tipo}.`, 422);
  });
}

async function aplicarSaida(s: SessionData, tipo: string, x: any) {
  if (tipo !== 'boleto.instrucao') falha(`Tipo de evento desconhecido: ${tipo}.`, 422);
  const r = await bancos({ ...s, userId: x.usuario_id ?? s.userId }, `/boletos/${Number(x.boleto_id)}/instrucoes`, { tipo: x.tipo, dados: x.dados ?? {} });
  return { local: r.local, situacao: r.boleto?.situacao };
}

const LIVRE = "(status IN ('pendente','erro') OR (status = 'processando' AND atualizado_em < NOW() - INTERVAL 10 MINUTE))";

/**
 * Processa um evento, se ninguém estiver com ele. Erro de regra (4xx) não volta sozinho; erro de rede/BMBancos
 * volta em 2, 4, 8… minutos (até 10 tentativas). Baixa repetida (ban_ocorrencia_id único) = já processado.
 */
export async function processarEvento(s: SessionData, id: number) {
  const [tomou]: any = await pool.query(`UPDATE fin_eventos SET status = 'processando', tentativas = tentativas + 1 WHERE id = ? AND empresa_id = ? AND ${LIVRE}`, [id, empresaDe(s)]);
  const [[ev]]: any = await pool.query('SELECT * FROM fin_eventos WHERE id = ? AND empresa_id = ?', [id, empresaDe(s)]);
  if (!ev) falha('Evento não encontrado.', 404);
  if (!tomou.affectedRows) return { id, status: ev.status, resultado: null };
  const payload = typeof ev.payload === 'string' ? JSON.parse(ev.payload) : ev.payload;
  try {
    const resultado = ev.direcao === 'entrada' ? await aplicarEntrada(s, ev.tipo, payload) : await aplicarSaida(s, ev.tipo, payload);
    await pool.query("UPDATE fin_eventos SET status = 'processado', processado_em = NOW(), proxima_tentativa = NULL, ultimo_erro = NULL WHERE id = ?", [id]);
    return { id, status: 'processado', resultado };
  } catch (e: any) {
    if (e instanceof ErroHttp && e.codigo === 'repetida') {
      await pool.query("UPDATE fin_eventos SET status = 'processado', processado_em = NOW(), proxima_tentativa = NULL, ultimo_erro = ? WHERE id = ?", [e.message, id]);
      return { id, status: 'processado', resultado: { repetida: true } };
    }
    const status = e instanceof ErroHttp && e.status === 422 ? 'descartado' : 'erro';
    const voltar = status === 'erro' && !(e instanceof ErroHttp && e.status < 500) && Number(ev.tentativas) + 1 < 10;
    await pool.query(
      `UPDATE fin_eventos SET status = ?, ultimo_erro = ?, proxima_tentativa = ${voltar ? 'NOW() + INTERVAL POW(2, tentativas) MINUTE' : 'NULL'} WHERE id = ?`,
      [status, String(e?.message ?? e).slice(0, 2000), id],
    );
    return { id, status, erro: String(e?.message ?? e) };
  }
}

/** Grava o evento de entrada (idempotente) e já processa. Repetido e já processado: só devolve. */
export async function receberEvento(s: SessionData, tipo: string, chave: string, payload: unknown) {
  const empresa = empresaDe(s);
  const dedup = sha256(chave);
  let id: number;
  try {
    const [ins]: any = await pool.query('INSERT INTO fin_eventos SET ?', [{ empresa_id: empresa, direcao: 'entrada', tipo, chave_dedup: dedup, payload: JSON.stringify(payload), status: 'pendente' }]);
    id = Number(ins.insertId);
  } catch (e: any) {
    if (e?.code !== 'ER_DUP_ENTRY') throw e;
    const [[ev]]: any = await pool.query("SELECT id, status FROM fin_eventos WHERE empresa_id = ? AND direcao = 'entrada' AND tipo = ? AND chave_dedup = ?", [empresa, tipo, dedup]);
    if (ev.status === 'processado' || ev.status === 'descartado') return { id: Number(ev.id), status: ev.status, repetido: true };
    id = Number(ev.id);
  }
  return { ...(await processarEvento(s, id)), repetido: false };
}

/** Fila: pendentes, erros com a hora de voltar e os presos em "processando" há mais de 10 min */
export async function processarFila(s: SessionData, limite = 50) {
  const [ids]: any = await pool.query(
    `SELECT id FROM fin_eventos WHERE empresa_id = ? AND (status = 'pendente' OR (status = 'erro' AND proxima_tentativa <= NOW())
        OR (status = 'processando' AND atualizado_em < NOW() - INTERVAL 10 MINUTE)) ORDER BY id LIMIT ?`,
    [empresaDe(s), limite],
  );
  const r = { processados: 0, erros: 0 };
  for (const { id } of ids) {
    const x = await processarEvento(s, id).catch((e) => ({ status: 'erro', erro: e?.message }));
    x.status === 'processado' ? r.processados++ : r.erros++;
  }
  return r;
}

// ------------------------------------------------------------------ consulta ao BMBancos

const CURSOR = sha256('cursor-ocorrencias');

/** Pix ativo: pergunta ao BMBancos pelo txid; pago vira evento (chave = E2E), removido/vencido muda a situação */
async function consultarPix(s: SessionData, cob: any) {
  const [[cf]]: any = await pool.query('SELECT ban_conta_id FROM fin_contas_financeiras WHERE id = ?', [cob.conta_financeira_id]);
  const r = await bancos(s, `/pix/cobrancas/${cf.ban_conta_id}/${cob.txid}`);
  const x = r.cobranca;
  if (x.status === 'CONCLUIDA') return receberEvento(s, 'pix.recebido', `pix:${x.endToEndId || x.txid}`, x);
  if (x.status.startsWith('REMOVIDA')) {
    await pool.query('UPDATE fin_pix_cobrancas SET status = ? WHERE id = ?', [x.status === 'REMOVIDA_PELO_PSP' ? 'expirada' : 'removida', cob.id]);
  }
  return { status: x.status };
}

/** Lê as ocorrências novas do BMBancos (liquidações dos boletos FIN-P…), confere os Pix ativos e roda a fila */
async function sincronizar(s: SessionData) {
  const empresa = empresaDe(s);
  const [[cur]]: any = await pool.query("SELECT payload FROM fin_eventos WHERE empresa_id = ? AND direcao = 'entrada' AND tipo = 'bancos.cursor' AND chave_dedup = ?", [empresa, CURSOR]);
  let desde = Number((typeof cur?.payload === 'string' ? JSON.parse(cur.payload) : cur?.payload)?.ultimoId) || 0;
  const r = { lidas: 0, liquidacoes: 0, baixadas: 0, pix: 0, erros: [] as string[] };
  for (let pagina = 0; pagina < 20; pagina++) {
    const d = await bancos(s, `/ocorrencias?desde=${desde}&limite=500`);
    for (const oc of d.ocorrencias ?? []) {
      r.lidas++;
      if (oc.tipo !== 'liquidacao' || !REF.test(String(oc.referencia ?? ''))) continue;
      r.liquidacoes++;
      const x = await receberEvento(s, 'boleto.liquidado', `ocorrencia:${oc.id}`, oc);
      if (x.status === 'processado' && !x.repetido) r.baixadas++;
      if ('erro' in x && x.erro) r.erros.push(`${oc.referencia}: ${x.erro}`);
    }
    // O cursor só anda depois de cada liquidação estar gravada na fila
    desde = Number(d.ultimoId) || desde;
    await pool.query(
      "INSERT INTO fin_eventos SET ? ON DUPLICATE KEY UPDATE payload = VALUES(payload), processado_em = NOW()",
      [{ empresa_id: empresa, direcao: 'entrada', tipo: 'bancos.cursor', chave_dedup: CURSOR, payload: JSON.stringify({ ultimoId: desde }), status: 'processado' }],
    );
    if ((d.ocorrencias ?? []).length < 500) break;
  }
  const [ativos]: any = await pool.query("SELECT * FROM fin_pix_cobrancas WHERE empresa_id = ? AND status = 'ativa' ORDER BY id LIMIT 100", [empresa]);
  for (const cob of ativos) {
    const x: any = await consultarPix(s, cob).catch((e) => ({ erro: e?.message }));
    if (x.status === 'processado' && !x.repetido) r.pix++;
    if (x.erro) r.erros.push(`Pix ${cob.txid}: ${x.erro}`);
  }
  return { ...r, cursor: desde, fila: await processarFila(s) };
}

// ------------------------------------------------------------------ rotas

/** Assinatura do webhook: X-Assinatura: sha256=<hex do HMAC-SHA256 do corpo bruto com FINANC_WEBHOOK_SECRET> */
function conferirAssinatura(req: Request) {
  const segredo = process.env.FINANC_WEBHOOK_SECRET || '';
  if (segredo.length < 32) falha('Webhook não configurado (FINANC_WEBHOOK_SECRET).', 503);
  const bruto: Buffer | undefined = (req as any).rawBody;
  const esperado = `sha256=${crypto.createHmac('sha256', segredo).update(bruto ?? '').digest('hex')}`;
  if (!bruto || !iguais(String(req.headers['x-assinatura'] || ''), esperado)) falha('Assinatura inválida.', 401);
}

export function createRecebimentoRouter() {
  const r = Router();

  /** Boletos (com a situação lida de ban_boletos) e Pix da parcela */
  r.get('/receber/parcelas/:id/cobrancas', rota(async (req, _res, s) => {
    const empresa = empresaDe(s);
    const [boletos] = await pool.query(
      `SELECT v.id, v.referencia, v.ativo, v.boleto_id, v.criado_em, b.situacao, b.valor, b.data_vencimento, b.linha_digitavel, b.pix_emv, b.nosso_numero,
              b.data_pagamento, b.valor_pago
         FROM fin_receber_parcela_boletos v LEFT JOIN ban_boletos b ON b.id = v.boleto_id
        WHERE v.parcela_id = ? AND v.empresa_id = ? ORDER BY v.id DESC`,
      [req.params.id, empresa],
    );
    const [pix] = await pool.query(
      `SELECT x.id, x.txid, x.tipo, x.valor, x.pix_emv, x.status, x.expira_em, x.pago_em, x.e2e_id, x.criado_em, cf.nome AS conta_nome
         FROM fin_pix_cobrancas x JOIN fin_contas_financeiras cf ON cf.id = x.conta_financeira_id
        WHERE x.parcela_id = ? AND x.empresa_id = ? ORDER BY x.id DESC`,
      [req.params.id, empresa],
    );
    return { boletos, pix };
  }));

  r.post('/receber/parcelas/:id/boleto', rota(async (req, _res, s) => emitirBoleto(s, req, Number(req.params.id), Number(req.body?.conta_financeira_id) || null)));
  r.post('/receber/parcelas/:id/pix', rota(async (req, _res, s) => gerarPix(s, req, Number(req.params.id), Number(req.body?.conta_financeira_id) || null)));

  /** PDF do boleto, pelo BMBancos (só boleto ligado a parcela desta empresa) */
  r.get('/boletos/:id/pdf', rota(async (req, res, s) => {
    const [[v]]: any = await pool.query('SELECT boleto_id FROM fin_receber_parcela_boletos WHERE boleto_id = ? AND empresa_id = ?', [req.params.id, empresaDe(s)]);
    if (!v) falha('Boleto não encontrado.', 404);
    const pdf = await bancosBruto(s, `/boletos/${v.boleto_id}/pdf`);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="boleto_${v.boleto_id}.pdf"`);
    res.end(pdf);
  }));

  r.post('/pix/:id/consultar', rota(async (req, _res, s) => {
    const [[cob]]: any = await pool.query('SELECT * FROM fin_pix_cobrancas WHERE id = ? AND empresa_id = ?', [req.params.id, empresaDe(s)]);
    if (!cob) falha('Cobrança Pix não encontrada.', 404);
    if (cob.status !== 'ativa') return { status: cob.status };
    return consultarPix(s, cob);
  }));

  /** Tela (botão) ou agendador (Bearer FINANC_CHAVE_API + X-Empresa-Id + X-Usuario-Id, pois o BMBancos exige usuário) */
  r.post('/bancos/sincronizar', rotaModulo(async (_req, _res, s) => sincronizar(s)));

  r.get('/eventos', rota(async (req, _res, s) => {
    const where = ['empresa_id = ?', "tipo <> 'bancos.cursor'"];
    const p: unknown[] = [empresaDe(s)];
    if (req.query.status) where.push('status = ?'), p.push(String(req.query.status));
    if (req.query.direcao) where.push('direcao = ?'), p.push(String(req.query.direcao));
    const [l] = await pool.query(
      `SELECT id, direcao, tipo, status, tentativas, proxima_tentativa, ultimo_erro, processado_em, criado_em, payload FROM fin_eventos WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 1000`,
      p,
    );
    return l;
  }));

  r.post('/eventos/:id/reprocessar', rota(async (req, _res, s) => processarEvento(s, Number(req.params.id))));

  /**
   * Webhook do BMBancos (ou de quem tiver o segredo). Corpo:
   *   { empresa_id, evento: 'ocorrencia', dados: <linha de GET /api/ocorrencias> }
   *   { empresa_id, evento: 'pix', dados: { txid, endToEndId, valor, pagoEm } }
   * Responde 200 só depois de gravar em fin_eventos; repetir o mesmo aviso não baixa de novo.
   */
  r.post('/webhooks/bancos', rotaPublica(async (req) => {
    conferirAssinatura(req);
    const { empresa_id, evento, dados } = req.body ?? {};
    if (!Number.isInteger(empresa_id) || empresa_id < 0 || !dados) falha('Informe empresa_id, evento e dados.');
    const s: SessionData = { isLoggedIn: true, empresaId: empresa_id, userName: 'webhook', role: 'sistema' };
    if (evento === 'ocorrencia') {
      if (dados.tipo !== 'liquidacao' || !REF.test(String(dados.referencia ?? ''))) return { ignorado: true };
      return receberEvento(s, 'boleto.liquidado', `ocorrencia:${dados.id}`, dados);
    }
    if (evento === 'pix') {
      if (!dados.txid) falha('Pix sem txid.');
      return receberEvento(s, 'pix.recebido', `pix:${dados.endToEndId || dados.txid}`, dados);
    }
    falha('Evento desconhecido.');
  }));

  return r;
}
