import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { loadConfig } from '../config.js';

const { Client } = pg;
const config = loadConfig();
const migrationDatabaseUrl = process.env['MIGRATION_DATABASE_URL'] ?? config.DATABASE_URL;
if (!migrationDatabaseUrl) {
  throw new Error('MIGRATION_DATABASE_URL or DATABASE_URL is required to run migrations');
}

const migrationsDirectory = resolve(process.cwd(), '../../database/migrations');
const filenames = (await readdir(migrationsDirectory))
  .filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name))
  .sort();

const client = new Client({
  connectionString: migrationDatabaseUrl,
  application_name: 'hirmos-migrate',
});
await client.connect();

try {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  for (const filename of filenames) {
    const sql = await readFile(resolve(migrationsDirectory, filename), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const existing = await client.query<{ checksum: string }>(
      'SELECT checksum FROM schema_migrations WHERE filename = $1',
      [filename],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].checksum !== checksum) {
        throw new Error(`Applied migration changed: ${filename}`);
      }
      continue;
    }

    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)',
        [filename, checksum],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    process.stdout.write(`Applied ${filename}\n`);
  }
} finally {
  await client.end();
}
