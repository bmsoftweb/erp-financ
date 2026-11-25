import { Router } from 'express';
import { masterPool as pool, hojeSql } from './db.js';
import { rota } from './http.js';
import { empresaDe, somarDias } from './comum.js';
import { contasComSaldo } from './cadastros.js';

/** Painel: a receber e a pagar (vencido, hoje, 7 dias, 30 dias), pendentes de aprovação e saldo das contas */
export function createPainelRouter() {
  const r = Router();
  r.get('/painel', rota(async (_req, _res, s) => {
    const empresa = empresaDe(s);
    const hoje = await hojeSql(pool);
    const resumo = async (tabela: string) => {
      const [[x]]: any = await pool.query(
        `SELECT COALESCE(SUM(CASE WHEN vencimento < ? THEN saldo END), 0) AS vencido, COUNT(CASE WHEN vencimento < ? THEN 1 END) AS qtd_vencido,
                COALESCE(SUM(CASE WHEN vencimento = ? THEN saldo END), 0) AS hoje,
                COALESCE(SUM(CASE WHEN vencimento > ? AND vencimento <= ? THEN saldo END), 0) AS semana,
                COALESCE(SUM(CASE WHEN vencimento > ? AND vencimento <= ? THEN saldo END), 0) AS mes,
                COALESCE(SUM(saldo), 0) AS total
           FROM ${tabela} WHERE empresa_id = ? AND status IN ('aberta','parcial')`,
        [hoje, hoje, hoje, hoje, somarDias(hoje, 7), hoje, somarDias(hoje, 30), empresa],
      );
      return x;
    };
    const [[aprovar]]: any = await pool.query("SELECT COUNT(*) n, COALESCE(SUM(saldo), 0) v FROM fin_pagar_parcelas WHERE empresa_id = ? AND aprovacao_status = 'pendente' AND status IN ('aberta','parcial')", [empresa]);
    return { hoje, receber: await resumo('fin_receber_parcelas'), pagar: await resumo('fin_pagar_parcelas'), aprovar, contas: (await contasComSaldo(s)).filter((c: any) => Number(c.ativo)) };
  }));
  return r;
}
