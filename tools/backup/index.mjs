import { readFile } from 'node:fs/promises';
import { createBackup } from './backup.mjs';

try {
  if (!process.env.HIRMOS_BACKUP_CONFIG || !process.env.HIRMOS_BACKUP_DATABASE_URL) {
    throw new Error('BACKUP_CONFIGURATION_REQUIRED');
  }
  const config = JSON.parse(await readFile(process.env.HIRMOS_BACKUP_CONFIG, 'utf8'));
  console.log(JSON.stringify({ backup: 'complete', ...await createBackup(config, process.env.HIRMOS_BACKUP_DATABASE_URL) }));
} catch (error) {
  // Provider/pg errors can contain paths, hosts or authentication details.
  console.error(JSON.stringify({ backup: 'failed', code: /^BACKUP_[A-Z_]+$/.test(error?.message)
    ? error.message : 'BACKUP_EXECUTION_FAILED' }));
  process.exitCode = 1;
}
