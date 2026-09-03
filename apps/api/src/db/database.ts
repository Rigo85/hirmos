import pg from 'pg';

const { Pool } = pg;

export interface Database {
  query<Row extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<pg.QueryResult<Row>>;
  close(): Promise<void>;
}

export function createDatabase(connectionString: string): Database {
  const pool = new Pool({
    connectionString,
    application_name: 'hirmos-api',
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  return {
    query: (text, values) => pool.query(text, values as unknown[] | undefined),
    close: () => pool.end(),
  };
}
