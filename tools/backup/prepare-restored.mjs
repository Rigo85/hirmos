import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { postgresEnvironment } from './backup.mjs';

export async function prepareRestoredDatabase(connectionString, confirmedDatabase) {
  const env = postgresEnvironment(connectionString);
  // Never accept the production name or an unrelated database. Restore into a fresh
  // copy first; promotion is a separate, explicitly authorized operation.
  if (!/^hirmos_restore_[a-z0-9_]+$/.test(confirmedDatabase ?? '')
    || env.PGDATABASE !== confirmedDatabase) throw new Error('RESTORE_TARGET_NOT_CONFIRMED');
  const client = new pg.Client({ connectionString, application_name: 'hirmos-restore-preparation',
    connectionTimeoutMillis: 10000, query_timeout: 35000 });
  try {
    await client.connect();
    await client.query('BEGIN');
    const identity = (await client.query('SELECT current_database() AS name')).rows[0].name;
    if (identity !== confirmedDatabase) throw new Error('RESTORE_WRONG_DATABASE');
    const others = (await client.query(`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'`)).rows[0].n;
    if (others) throw new Error('RESTORE_DATABASE_IN_USE');
    await client.query(await readFile(new URL('./prepare-restored.sql', import.meta.url), 'utf8'));
    await client.query('COMMIT');
    return { prepared: true, database: identity };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { await client.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--confirm-database') throw new Error('RESTORE_USAGE');
    console.log(JSON.stringify(await prepareRestoredDatabase(process.env.HIRMOS_RESTORE_DATABASE_URL, process.argv[3])));
  } catch (error) {
    // Connection strings, SQL and server errors may contain private details.
    console.error(JSON.stringify({ prepared: false,
      code: /^RESTORE_[A-Z_]+$/.test(error?.message) ? error.message : 'RESTORE_FAILED' }));
    process.exitCode = 1;
  }
}
