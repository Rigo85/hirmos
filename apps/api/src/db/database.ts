import pg from 'pg';

const { Pool } = pg;

export interface Database {
  query<Row extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<pg.QueryResult<Row>>;
  transaction?<T>(operation: (database: Pick<Database, 'query'>) => Promise<T>): Promise<T>;
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
    transaction: async <T>(operation: (database: Pick<Database, 'query'>) => Promise<T>) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await operation({
          query: (text, values) => client.query(text, values as unknown[] | undefined),
        });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
