import { readFile } from 'node:fs/promises';
import { createDatabase } from '../apps/api/dist/db/database.js';
import { MusicSourceRepository } from '../apps/api/dist/music-source/music-source-repository.js';
import { MusicSourceService } from '../apps/api/dist/music-source/music-source-service.js';
import { SourceCredentialCipher } from '../apps/api/dist/music-source/source-credential-cipher.js';

const databaseUrl = required('DATABASE_URL');
const encryptionKey = required('DATA_ENCRYPTION_KEY');
const credentialsFile = required('HIRMOS_SOURCE_CREDENTIALS_FILE');
const credentials = parseCredentials(await readFile(credentialsFile, 'utf8'));
const database = createDatabase(databaseUrl);

try {
  const service = new MusicSourceService(
    new MusicSourceRepository(database),
    new SourceCredentialCipher(encryptionKey),
  );
  const source = await service.configure({
    name: process.env.HIRMOS_SOURCE_NAME?.trim() || 'Biblioteca principal',
    baseUrl: credentials.URL,
    username: credentials.USER,
    password: credentials.PASS,
  });
  process.stdout.write(JSON.stringify({
    status: 'configured',
    id: source.id,
    adapterType: source.adapterType,
    healthy: source.healthy,
    serverVersion: source.serverVersion,
    capabilities: source.capabilities,
  }) + '\n');
} finally {
  await database.close();
}

function parseCredentials(content) {
  const values = {};
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error('Invalid source credential file');
    values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  for (const key of ['URL', 'USER', 'PASS']) {
    if (!values[key]) throw new Error(`Missing ${key} in source credential file`);
  }
  return values;
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
