import { Router } from 'express';
import Decimal from 'decimal.js';
import { masterPool as pool, hojeSql } from './db.js';
import { falha, rota } from './http.js';
import type { SessionData } from './session.js';
import { LADOS, ladoDe, empresaDe, filtroContas, contaDoUsuario } from './comum.js';
import { somarDias, ocorrencias } from './datas.js';

/**
 * Fluxo de caixa (realizado + previsto + projetado), DRE caixa/competência e relatórios. Só leitura.
 * Dinheiro somado no MySQL (DECIMAL) ou em Decimal, nunca em float.
 */

const iso = (v: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : null);
const dec = (v: unknown) => new Decimal(String(v ?? 0));
/** Chave e rótulo do período do fluxo */
function periodo(data: string, visao: string): { chave: string; rotulo: string; inicio: string } {
  if (visao === 'mensal') return { chave: data.slice(0, 7), rotulo: `${data.slice(5, 7)}/${data.slice(0, 4)}`, inicio: `${data.slice(0, 7)}-01` };
  if (visao === 'semanal') {
    const dow = new Date(Date.UTC(Number(data.slice(0, 4)), Number(data.slice(5, 7)) - 1, Number(data.slice(8, 10)))).getUTCDay();
    const seg = somarDias(data, -((dow + 6) % 7));
    return { chave: seg, rotulo: `Semana de ${seg.split('-').reverse().join('/')}`, inicio: seg };
  }
  return { chave: data, rotulo: data.split('-').reverse().join('/'), inicio: data };
}

type Camada = 'realizado' | 'previsto' | 'projetado';
interface Item { data: string; valor: Decimal; camada: Camada; grupo: string }

/** Grupo da linha: conta financeira, conta do plano ou centro de custo */
const GRUPO = {
  conta: { sql: "COALESCE(cf.nome, '(sem conta)')" },
  plano: { sql: "CONCAT(pc.codigo, ' ', pc.descricao)" },
  centro: { sql: "CONCAT(cc.codigo, ' ', cc.descricao)" },
} as const;

async function fluxoDeCaixa(s: SessionData, q: any) {
  const empresa = empresaDe(s);
  const hoje = await hojeSql(pool);
  const de = iso(q.de) ?? hoje;
  const ate = iso(q.ate) ?? somarDias(hoje, 30);
  if (ate < de) falha('Período inválido.');
  if (de < somarDias(ate, -800)) falha('Use um período de até dois anos.');
  const visao = ['diaria', 'semanal', 'mensal'].includes(q.visao) ? q.visao : 'diaria';
  const agrupar = (['conta', 'plano', 'centro'] as const).find((g) => g === q.agrupar) ?? null;
  const conta = Number(q.conta) || null;
  if (conta) await contaDoUsuario(pool, s, conta);
  const f = await filtroContas(s);
  const contaSql = conta ? 'AND cf.id = ?' : '';
  const contaPar = conta ? [conta] : [];
  const g = agrupar ? GRUPO[agrupar].sql : "''";
  const itens: Item[] = [];
  const add = (linhas: any[], camada: Camada) => linhas.forEach((l) => itens.push({ data: String(l.data).slice(0, 10), valor: dec(l.valor), camada, grupo: String(l.grupo ?? '') }));

  // saldo no início
  const [[si]]: any = await pool.query(
    `SELECT COALESCE(SUM(cf.saldo_inicial + COALESCE((SELECT SUM(IF(m.tipo = 'entrada', m.valor, -m.valor)) FROM fin_movimentos m WHERE m.conta_financeira_id = cf.id AND m.data < ?), 0)), 0) AS saldo
       FROM fin_contas_financeiras cf WHERE cf.empresa_id = ? AND cf.ativo = 1 AND ${f.sql} ${contaSql}`,
    [de, empresa, ...f.params, ...contaPar],
  );

  // realizado: movimentos (por plano/centro, os lançamentos dos movimentos; transferência não tem e fica de fora)
  const fimReal = ate < hoje ? ate : hoje;
  if (de <= fimReal) {
    const [l]: any = agrupar === 'plano' || agrupar === 'centro'
      ? await pool.query(
        `SELECT DATE_FORMAT(m.data, '%Y-%m-%d') AS data, SUM(l.sinal * l.valor) AS valor, ${g} AS grupo
           FROM fin_lancamentos l JOIN fin_movimentos m ON m.id = l.movimento_id JOIN fin_contas_financeiras cf ON cf.id = m.conta_financeira_id
           JOIN fin_plano_contas pc ON pc.id = l.plano_conta_id JOIN fin_centros_custo cc ON cc.id = l.centro_custo_id
          WHERE m.empresa_id = ? AND m.data BETWEEN ? AND ? AND ${f.sql} ${contaSql} GROUP BY 1, 3`,
        [empresa, de, fimReal, ...f.params, ...contaPar])
      : await pool.query(
        `SELECT DATE_FORMAT(m.data, '%Y-%m-%d') AS data, SUM(IF(m.tipo = 'entrada', m.valor, -m.valor)) AS valor, ${g} AS grupo
           FROM fin_movimentos m JOIN fin_contas_financeiras cf ON cf.id = m.conta_financeira_id
          WHERE m.empresa_id = ? AND m.data BETWEEN ? AND ? AND ${f.sql} ${contaSql} GROUP BY 1, 3`,
        [empresa, de, fimReal, ...f.params, ...contaPar]);
    add(l, 'realizado');
  }

  // previsto (títulos confirmados) e projetado (provisórios), pelo saldo da parcela; vencidas numa linha própria
  const vencidas = { receber: new Decimal(0), pagar: new Decimal(0) };
  for (const lado of ['receber', 'pagar'] as const) {
    const L = LADOS[lado];
    const porRateio = agrupar === 'plano' || agrupar === 'centro';
    const [l]: any = await pool.query(
      `SELECT DATE_FORMAT(COALESCE(p.${L.dataPrevista}, p.vencimento), '%Y-%m-%d') AS data, t.provisorio,
              ${porRateio ? 'SUM(ROUND(p.saldo * r.percentual / 100, 2))' : 'SUM(p.saldo)'} * ${L.sinal} AS valor, ${g} AS grupo
         FROM ${L.parcelas} p JOIN ${L.titulos} t ON t.id = p.titulo_id
         LEFT JOIN fin_formas_pagamento fp ON fp.id = p.forma_pagamento_id
         LEFT JOIN fin_contas_financeiras cf ON cf.id = COALESCE(p.conta_financeira_id, fp.conta_financeira_id)
         ${porRateio ? `JOIN ${L.rateios} r ON r.titulo_id = t.id JOIN fin_plano_contas pc ON pc.id = r.plano_conta_id JOIN fin_centros_custo cc ON cc.id = r.centro_custo_id` : ''}
        WHERE p.empresa_id = ? AND p.status IN ('aberta','parcial') ${lado === 'pagar' ? "AND p.aprovacao_status <> 'reprovada'" : ''}
          AND COALESCE(p.${L.dataPrevista}, p.vencimento) <= ? ${conta ? 'AND cf.id = ?' : ''}
        GROUP BY 1, 2, 4`,
      [empresa, ate, ...contaPar],
    );
    for (const x of l) {
      if (x.data < hoje) {
        if (!Number(x.provisorio)) vencidas[lado] = vencidas[lado].plus(dec(x.valor).abs());
      } else if (x.data >= de) add([x], Number(x.provisorio) ? 'projetado' : 'previsto');
    }
  }

  // projetado: recorrências ainda não geradas
  const [recs]: any = await pool.query(
    `SELECT r.*, DATE_FORMAT(r.inicio, '%Y-%m-%d') AS inicio, DATE_FORMAT(r.fim, '%Y-%m-%d') AS fim, DATE_FORMAT(r.gerado_ate, '%Y-%m-%d') AS gerado_ate, cf.nome AS conta_nome
       FROM fin_recorrencias r LEFT JOIN fin_contas_financeiras cf ON cf.id = r.conta_financeira_id
      WHERE r.empresa_id = ? AND r.ativo = 1 AND (r.fim IS NULL OR r.fim >= ?) ${conta ? 'AND cf.id = ?' : ''}`,
    [empresa, hoje, ...contaPar],
  );
  for (const r of recs) {
    const desde = [de, hoje, r.gerado_ate ? somarDias(r.gerado_ate, 1) : de].sort().pop()!;
    const datas = ocorrencias(r, desde, ate);
    if (!datas.length) continue;
    const sinal = r.tipo === 'receber' ? 1 : -1;
    let partes: { grupo: string; valor: Decimal }[] = [{ grupo: agrupar === 'conta' ? r.conta_nome ?? '(sem conta)' : '', valor: dec(r.valor) }];
    if (agrupar === 'plano' || agrupar === 'centro') {
      const [rt]: any = await pool.query(
        `SELECT ROUND(? * x.percentual / 100, 2) AS valor, ${g} AS grupo FROM fin_recorrencia_rateios x
           JOIN fin_plano_contas pc ON pc.id = x.plano_conta_id JOIN fin_centros_custo cc ON cc.id = x.centro_custo_id WHERE x.recorrencia_id = ?`,
        [r.valor, r.id],
      );
      partes = rt.map((x: any) => ({ grupo: x.grupo, valor: dec(x.valor) }));
    }
    for (const d of datas) for (const p of partes) itens.push({ data: d, valor: p.valor.times(sinal), camada: 'projetado', grupo: p.grupo });
  }

  // períodos (todos, mesmo vazios) e saldo acumulado
  const chaves = new Map<string, any>();
  for (let d = de; d <= ate; d = somarDias(d, 1)) {
    const p = periodo(d, visao);
    if (!chaves.has(p.chave)) {
      chaves.set(p.chave, { ...p, realizado_entradas: new Decimal(0), realizado_saidas: new Decimal(0), previsto_entradas: new Decimal(0), previsto_saidas: new Decimal(0), projetado_entradas: new Decimal(0), projetado_saidas: new Decimal(0) });
    }
  }
  const grupos = new Map<string, Map<string, Decimal>>();
  for (const i of itens) {
    const p = chaves.get(periodo(i.data, visao).chave);
    if (!p) continue;
    const campo = `${i.camada}_${i.valor.gte(0) ? 'entradas' : 'saidas'}`;
    p[campo] = p[campo].plus(i.valor.abs());
    if (agrupar) {
      const gm = grupos.get(i.grupo) ?? new Map<string, Decimal>();
      gm.set(p.chave, (gm.get(p.chave) ?? new Decimal(0)).plus(i.valor));
      grupos.set(i.grupo, gm);
    }
  }
  let saldo = dec(si.saldo);
  const periodos = [...chaves.values()].map((p) => {
    const liquido = p.realizado_entradas.minus(p.realizado_saidas).plus(p.previsto_entradas).minus(p.previsto_saidas).plus(p.projetado_entradas).minus(p.projetado_saidas);
    saldo = saldo.plus(liquido);
    const out: any = { chave: p.chave, rotulo: p.rotulo, inicio: p.inicio };
    for (const k of ['realizado_entradas', 'realizado_saidas', 'previsto_entradas', 'previsto_saidas', 'projetado_entradas', 'projetado_saidas']) out[k] = p[k].toFixed(2);
    return { ...out, liquido: liquido.toFixed(2), saldo: saldo.toFixed(2), negativo: saldo.lt(0) };
  });
  return {
    de, ate, hoje, visao, agrupar,
    saldo_inicial: dec(si.saldo).toFixed(2),
    vencidas: { receber: vencidas.receber.toFixed(2), pagar: vencidas.pagar.toFixed(2) },
    periodos,
    negativos: periodos.filter((p) => p.negativo).length,
    grupos: agrupar
      ? [...grupos.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([grupo, m]) => ({
        grupo, total: [...m.values()].reduce((a, v) => a.plus(v), new Decimal(0)).toFixed(2), valores: Object.fromEntries([...m.entries()].map(([k, v]) => [k, v.toFixed(2)])),
      }))
      : [],
  };
}

/** DRE gerencial pelos lançamentos (data_caixa ou data_competencia), por mês, somando até as contas sintéticas */
async function dre(s: SessionData, q: any) {
  const empresa = empresaDe(s);
  const hoje = await hojeSql(pool);
  const de = iso(q.de) ?? `${hoje.slice(0, 7)}-01`;
  const ate = iso(q.ate) ?? hoje;
  const regime = q.regime === 'competencia' ? 'competencia' : 'caixa';
  const centro = Number(q.centro) || null;
  const [l]: any = await pool.query(
    `SELECT plano_conta_id, DATE_FORMAT(data_${regime}, '%Y-%m') AS mes, SUM(sinal * valor) AS valor
       FROM fin_lancamentos WHERE empresa_id = ? AND data_${regime} BETWEEN ? AND ? ${centro ? 'AND centro_custo_id = ?' : ''}
      GROUP BY 1, 2`,
    [empresa, de, ate, ...(centro ? [centro] : [])],
  );
  const [plano]: any = await pool.query('SELECT id, pai_id, codigo, descricao, tipo, analitica FROM fin_plano_contas WHERE empresa_id = ? ORDER BY codigo', [empresa]);
  const porId = new Map<number, any>(plano.map((p: any) => [Number(p.id), { ...p, valores: new Map<string, Decimal>() }]));
  const meses = [...new Set<string>(l.map((x: any) => x.mes))].sort();
  for (const x of l) {
    for (let p = porId.get(Number(x.plano_conta_id)); p; p = p.pai_id ? porId.get(Number(p.pai_id)) : undefined) {
      p.valores.set(x.mes, (p.valores.get(x.mes) ?? new Decimal(0)).plus(dec(x.valor)));
    }
  }
  const linhas = plano
    .map((p: any) => porId.get(Number(p.id)))
    .filter((p: any) => p.valores.size)
    .map((p: any) => ({
      id: p.id, codigo: p.codigo, descricao: p.descricao, tipo: p.tipo, analitica: Number(p.analitica), nivel: String(p.codigo).split('.').length - 1,
      valores: Object.fromEntries(meses.map((m) => [m, (p.valores.get(m) ?? new Decimal(0)).toFixed(2)])),
      total: [...p.valores.values()].reduce((a: Decimal, v: Decimal) => a.plus(v), new Decimal(0)).toFixed(2),
    }));
  const resultado = Object.fromEntries(meses.map((m) => [m, l.filter((x: any) => x.mes === m).reduce((a: Decimal, x: any) => a.plus(dec(x.valor)), new Decimal(0)).toFixed(2)]));
  const total = l.reduce((a: Decimal, x: any) => a.plus(dec(x.valor)), new Decimal(0)).toFixed(2);
  return { de, ate, regime, meses, linhas, resultado, total };
}

export function createRelatoriosRouter() {
  const r = Router();

  r.get('/fluxo-caixa', rota(async (req, _res, s) => fluxoDeCaixa(s, req.query)));
  r.get('/relatorios/dre', rota(async (req, _res, s) => dre(s, req.query)));

  /** Aging: saldo em aberto por pessoa e faixa de atraso na data */
  r.get('/relatorios/aging', rota(async (req, _res, s) => {
    const lado = ladoDe(req.query.lado ?? 'receber');
    const L = LADOS[lado];
    const data = iso(req.query.data) ?? (await hojeSql(pool));
    const [l]: any = await pool.query(
      `SELECT t.pessoa_id, pe.nome AS pessoa_nome, pe.cpf_cnpj,
              SUM(IF(DATEDIFF(?, p.vencimento) <= 0, p.saldo, 0)) AS a_vencer,
              SUM(IF(DATEDIFF(?, p.vencimento) BETWEEN 1 AND 30, p.saldo, 0)) AS d1_30,
              SUM(IF(DATEDIFF(?, p.vencimento) BETWEEN 31 AND 60, p.saldo, 0)) AS d31_60,
              SUM(IF(DATEDIFF(?, p.vencimento) BETWEEN 61 AND 90, p.saldo, 0)) AS d61_90,
              SUM(IF(DATEDIFF(?, p.vencimento) > 90, p.saldo, 0)) AS d90_mais,
              SUM(p.saldo) AS total, MAX(GREATEST(DATEDIFF(?, p.vencimento), 0)) AS maior_atraso, COUNT(*) AS parcelas
         FROM ${L.parcelas} p JOIN ${L.titulos} t ON t.id = p.titulo_id JOIN cad_pessoas pe ON pe.id = t.pessoa_id
        WHERE p.empresa_id = ? AND p.status IN ('aberta','parcial') AND t.provisorio = 0
        GROUP BY t.pessoa_id, pe.nome, pe.cpf_cnpj ORDER BY total DESC`,
      [data, data, data, data, data, data, empresaDe(s)],
    );
    return { data, linhas: l };
  }));

  /** Extrato por pessoa: parcelas emitidas e baixas (estorno com sinal invertido) no período */
  r.get('/relatorios/extrato-pessoa', rota(async (req, _res, s) => {
    const lado = ladoDe(req.query.lado ?? 'receber');
    const L = LADOS[lado];
    const pessoa = Number(req.query.pessoa) || falha('Escolha a pessoa.');
    const hoje = await hojeSql(pool);
    const de = iso(req.query.de) ?? somarDias(hoje, -365);
    const ate = iso(req.query.ate) ?? hoje;
    const empresa = empresaDe(s);
    const [l]: any = await pool.query(
      `SELECT * FROM (
         SELECT DATE_FORMAT(t.data_emissao, '%Y-%m-%d') AS data, 'parcela' AS tipo, p.id AS ref, COALESCE(p.documento, t.numero_documento) AS documento,
                CONCAT(p.numero, '/', p.total_parcelas) AS parcela, DATE_FORMAT(p.vencimento, '%Y-%m-%d') AS vencimento, p.valor_original AS valor,
                NULL AS pago, NULL AS principal, NULL AS encargos, NULL AS desconto, p.status AS situacao
           FROM ${L.parcelas} p JOIN ${L.titulos} t ON t.id = p.titulo_id
          WHERE p.empresa_id = ? AND t.pessoa_id = ? AND t.data_emissao BETWEEN ? AND ?
         UNION ALL
         SELECT DATE_FORMAT(b.data_pagamento, '%Y-%m-%d'), IF(b.estorno_de_id IS NULL, 'baixa', 'estorno'), b.id, COALESCE(p.documento, t.numero_documento),
                CONCAT(p.numero, '/', p.total_parcelas), DATE_FORMAT(p.vencimento, '%Y-%m-%d'), NULL,
                IF(b.estorno_de_id IS NULL, 1, -1) * b.valor_pago, IF(b.estorno_de_id IS NULL, 1, -1) * b.valor_principal,
                IF(b.estorno_de_id IS NULL, 1, -1) * (b.valor_juros + b.valor_multa), IF(b.estorno_de_id IS NULL, 1, -1) * b.valor_desconto, b.origem
           FROM ${L.baixas} b JOIN ${L.parcelas} p ON p.id = b.parcela_id JOIN ${L.titulos} t ON t.id = p.titulo_id
          WHERE b.empresa_id = ? AND t.pessoa_id = ? AND b.data_pagamento BETWEEN ? AND ?
       ) x ORDER BY data, tipo = 'parcela' DESC, ref`,
      [empresa, pessoa, de, ate, empresa, pessoa, de, ate],
    );
    const [[ab]]: any = await pool.query(
      `SELECT COALESCE(SUM(p.saldo), 0) AS saldo FROM ${L.parcelas} p JOIN ${L.titulos} t ON t.id = p.titulo_id WHERE p.empresa_id = ? AND t.pessoa_id = ? AND p.status IN ('aberta','parcial')`,
      [empresa, pessoa],
    );
    return { de, ate, linhas: l, saldo_aberto: dec(ab.saldo).toFixed(2) };
  }));

  /** Baixas por período (estorno com sinal invertido); encargos=1 só as que tiveram juros, multa, desconto ou dispensa */
  r.get('/relatorios/baixas', rota(async (req, _res, s) => {
    const lado = ladoDe(req.query.lado ?? 'receber');
    const L = LADOS[lado];
    const hoje = await hojeSql(pool);
    const de = iso(req.query.de) ?? `${hoje.slice(0, 7)}-01`;
    const ate = iso(req.query.ate) ?? hoje;
    const k = 'IF(b.estorno_de_id IS NULL, 1, -1)';
    const [l]: any = await pool.query(
      `SELECT b.id, DATE_FORMAT(b.data_pagamento, '%Y-%m-%d') AS data_pagamento, DATE_FORMAT(b.${L.dataConta}, '%Y-%m-%d') AS data_conta, b.origem,
              b.estorno_de_id, b.estornada_em IS NOT NULL AS estornada, pe.nome AS pessoa_nome, COALESCE(p.documento, t.numero_documento) AS documento,
              CONCAT(p.numero, '/', p.total_parcelas) AS parcela, cf.nome AS conta_nome, fp.nome AS forma_nome, b.dias_atraso,
              ${k} * b.valor_pago AS valor_pago, ${k} * b.valor_principal AS valor_principal, ${k} * b.valor_multa AS valor_multa,
              ${k} * b.valor_juros AS valor_juros, ${k} * b.valor_desconto AS valor_desconto, ${k} * b.valor_dispensado AS valor_dispensado,
              ${k} * b.valor_tarifa AS valor_tarifa, b.motivo_dispensa
         FROM ${L.baixas} b JOIN ${L.parcelas} p ON p.id = b.parcela_id JOIN ${L.titulos} t ON t.id = p.titulo_id JOIN cad_pessoas pe ON pe.id = t.pessoa_id
         LEFT JOIN fin_contas_financeiras cf ON cf.id = b.conta_financeira_id LEFT JOIN fin_formas_pagamento fp ON fp.id = b.forma_pagamento_id
        WHERE b.empresa_id = ? AND b.data_pagamento BETWEEN ? AND ?
          ${req.query.encargos === '1' ? 'AND (b.valor_multa + b.valor_juros + b.valor_desconto + b.valor_dispensado) > 0' : ''}
        ORDER BY b.data_pagamento, b.id LIMIT 10000`,
      [empresaDe(s), de, ate],
    );
    return { de, ate, linhas: l };
  }));

  /** Previsto × realizado por mês: vencimentos (valor das parcelas) × pagos no mês (líquido de estornos) */
  r.get('/relatorios/previsto-realizado', rota(async (req, _res, s) => {
    const lado = ladoDe(req.query.lado ?? 'receber');
    const L = LADOS[lado];
    const hoje = await hojeSql(pool);
    const de = iso(req.query.de) ?? `${hoje.slice(0, 4)}-01-01`;
    const ate = iso(req.query.ate) ?? hoje;
    const empresa = empresaDe(s);
    const [prev]: any = await pool.query(
      `SELECT DATE_FORMAT(p.vencimento, '%Y-%m') AS mes, SUM(p.valor_original) AS valor FROM ${L.parcelas} p JOIN ${L.titulos} t ON t.id = p.titulo_id
        WHERE p.empresa_id = ? AND p.vencimento BETWEEN ? AND ? AND p.status NOT IN ('cancelada','renegociada') AND t.provisorio = 0 GROUP BY 1`,
      [empresa, de, ate],
    );
    const [real]: any = await pool.query(
      `SELECT DATE_FORMAT(b.data_pagamento, '%Y-%m') AS mes, SUM(IF(b.estorno_de_id IS NULL, 1, -1) * b.valor_pago) AS valor FROM ${L.baixas} b
        WHERE b.empresa_id = ? AND b.data_pagamento BETWEEN ? AND ? AND b.origem NOT IN ('renegociacao') GROUP BY 1`,
      [empresa, de, ate],
    );
    const meses = [...new Set<string>([...prev, ...real].map((x: any) => x.mes))].sort();
    return {
      de, ate,
      linhas: meses.map((m) => {
        const p = dec(prev.find((x: any) => x.mes === m)?.valor);
        const r2 = dec(real.find((x: any) => x.mes === m)?.valor);
        return { mes: m, previsto: p.toFixed(2), realizado: r2.toFixed(2), diferenca: r2.minus(p).toFixed(2), pct: p.isZero() ? null : r2.div(p).times(100).toFixed(1) };
      }),
    };
  }));

  return r;
}
