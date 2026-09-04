import { ActivityRepository } from '../apps/api/dist/activity/activity-repository.js';
import { CatalogRepository } from '../apps/api/dist/activity/catalog-repository.js';
import { createDatabase } from '../apps/api/dist/db/database.js';
import { MusicSourceRepository } from '../apps/api/dist/music-source/music-source-repository.js';
import { MusicSourceService } from '../apps/api/dist/music-source/music-source-service.js';
import { SourceCredentialCipher } from '../apps/api/dist/music-source/source-credential-cipher.js';

const databaseUrl = required('DATABASE_URL');
const encryptionKey = required('DATA_ENCRYPTION_KEY');
const email = required('HIRMOS_HISTORY_USER_EMAIL').trim().toLowerCase();
const database = createDatabase(databaseUrl);

try {
  const user = await database.query('SELECT id FROM users WHERE email = $1 AND disabled_at IS NULL', [email]);
  if (!user.rows[0]) throw new Error('Active Hirmos user not found');
  const activity = new ActivityRepository(database);
  const service = new MusicSourceService(
    new MusicSourceRepository(database),
    new SourceCredentialCipher(encryptionKey),
    undefined,
    activity,
    undefined,
    undefined,
    new CatalogRepository(database),
  );
  const habits = await service.habits(user.rows[0].id, 'artists', 'all', 100);
  process.stdout.write(JSON.stringify({ status: 'warmed', artists: habits.artists.length }) + '\n');
} finally {
  await database.close();
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
