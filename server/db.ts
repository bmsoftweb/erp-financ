import mysql from 'mysql2/promise';

// Mesmo banco do ERP BMsoft usado pelo Romaneio (bmerp_000000). Credenciais só pelo .env.
for (const nome of ['MYSQL_HOST', 'MYSQL_USER', 'MYSQL_PASSWORD']) {
  if (!process.env[nome]) throw new Error(`${nome} não definido no .env.`);
}

export const dbConfig = {
  host: process.env.MYSQL_HOST as string,
  port: parseInt(process.env.MYSQL_PORT || '3306'),
  user: process.env.MYSQL_USER as string,
  database: process.env.MYSQL_DATABASE || 'bmerp_000000',
};

export const masterPool = mysql.createPool({
  ...dbConfig,
  password: process.env.MYSQL_PASSWORD,
  // DATE volta como 'aaaa-mm-dd' (sem passar por Date/UTC); DATETIME continua Date
  dateStrings: ['DATE'],
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  connectTimeout: 20000,
  enableKeepAlive: true,
  // O MySQL derruba conexão parada (ECONNRESET): fecha as ociosas antes de serem reaproveitadas
  maxIdle: 0,
  idleTimeout: 20000,
});

// O sistema opera no horário de Brasília (UTC-3), qualquer que seja o fuso do servidor MySQL
masterPool.pool.on('connection', (conn: any) => {
  conn.query("SET time_zone = '-03:00'");
});

// Um só banco para tudo: mantido como função porque as rotas já chamam getDb()
export async function getDb(): Promise<any> {
  return masterPool;
}

export default masterPool;

// Colunas de uma tabela (INFORMATION_SCHEMA é lento): em memória por 60 s, porque quase nunca mudam
const cacheColunas = new Map<string, { em: number; linhas: any[] }>();
export async function colunasInfo(db: any, dbName: string | undefined, tabela: string): Promise<any[]> {
  const chave = `${dbName}.${tabela}`;
  const c = cacheColunas.get(chave);
  if (c && Date.now() - c.em < 60_000) return c.linhas;
  const [linhas]: any = await db.execute(
    'SELECT COLUMN_NAME, DATA_TYPE, COLUMN_COMMENT FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
    [dbName, tabela],
  );
  cacheColunas.set(chave, { em: Date.now(), linhas });
  return linhas;
}

/** Abre, confirma ou desfaz uma transação numa conexão do pool (cópia do davs.ts do erp-vendas) */
export async function transacao<T>(fn: (c: mysql.PoolConnection) => Promise<T>): Promise<T> {
  const c = await masterPool.getConnection();
  try {
    await c.beginTransaction();
    const r = await fn(c);
    await c.commit();
    return r;
  } catch (e) {
    await c.rollback().catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** Hoje pelo relógio do MySQL (sessão em -03:00), em 'aaaa-mm-dd' */
export async function hojeSql(c: Pick<mysql.PoolConnection, 'query'>): Promise<string> {
  const [[{ hoje }]]: any = await c.query("SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS hoje");
  return hoje;
}

/** Insere com o próximo número da filial (MAX+1 na transação); colisão de número (dois ao mesmo tempo) tenta de novo */
export async function inserirNumerado(c: mysql.PoolConnection, tabela: 'com_pedidos' | 'com_entradas' | 'com_cotacoes', dados: Record<string, unknown>, empresa: number): Promise<{ id: number; numero: number }> {
  // ponytail: MAX+1 com nova tentativa, como a venda do erp-vendas; contador próprio se a concorrência crescer
  for (let tentativa = 0; ; tentativa++) {
    const [[m]]: any = await c.query(`SELECT COALESCE(MAX(numero), 0) + 1 AS n FROM ${tabela} WHERE empresa_id = ?`, [empresa]);
    try {
      await c.query('SAVEPOINT num');
      const [r]: any = await c.query(`INSERT INTO ${tabela} SET ?`, [{ ...dados, empresa_id: empresa, numero: m.n }]);
      return { id: r.insertId, numero: m.n };
    } catch (e: any) {
      // Só o número repetido tenta de novo (a chave da nota repetida também é ER_DUP_ENTRY)
      if (e?.code !== 'ER_DUP_ENTRY' || !String(e.message).includes('_numero') || tentativa >= 4) throw e;
      await c.query('ROLLBACK TO SAVEPOINT num');
    }
  }
}
