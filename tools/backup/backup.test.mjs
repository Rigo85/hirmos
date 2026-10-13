import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { postgresEnvironment, retainedBackups, rotateBackups, validateDestination, verifyBackup } from './backup.mjs';

test('pg_dump connection preserves explicit TLS options and refuses hidden target overrides', () => {
  const env = postgresEnvironment('postgres://fixture:synthetic%3Apassword@127.0.0.1:55439/hirmos_test?sslmode=verify-full&sslrootcert=%2Ftmp%2Fexample.crt');
  assert.equal(env.PGHOST, '127.0.0.1');
  assert.equal(env.PGPORT, '55439');
  assert.equal(env.PGPASSWORD, 'synthetic:password');
  assert.equal(env.PGSSLMODE, 'verify-full');
  assert.equal(env.PGSSLROOTCERT, '/tmp/example.crt');
  assert.throws(() => postgresEnvironment('postgres://fixture:synthetic@localhost/hirmos_test?host=elsewhere'), /UNSUPPORTED_CONNECTION_OPTION/);
});

test('retention keeps daily/weekly/monthly representatives without duplicating artifacts', () => {
  const backups = Array.from({ length: 400 }, (_, i) => ({ name: String(i),
    createdAt: new Date(Date.UTC(2026, 9, 1) - i * 86400000).toISOString() }));
  const keep = retainedBackups(backups);
  for (let i = 0; i < 14; i++) assert.ok(keep.has(String(i)));
  assert.ok(keep.size >= 14 && keep.size <= 28);
  assert.ok(!keep.has('399'));
  assert.deepEqual(retainedBackups(backups.slice(0, 2)), new Set(['0', '1']));
});

test('backup destination refuses system root and unrelated directory names', async () => {
  await assert.rejects(validateDestination({ directory: '/hirmos-backups', mount: '/' }), /UNSAFE_DESTINATION/);
  await assert.rejects(validateDestination({ directory: '/tmp/unrelated', mount: '/tmp' }), /UNSAFE_DESTINATION/);
});

test('manifest detects corruption, traversal, wrong DB and symbolic links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hirmos-backup-verify-'));
  try {
    const bytes = Buffer.from('synthetic dump');
    await writeFile(join(root, 'database.dump'), bytes);
    const manifest = { kind: 'hirmos-backup', version: 1, database: 'hirmos_test',
      createdAt: new Date().toISOString(), artifacts: [{ path: 'database.dump', bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex') }] };
    const save = () => writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
    await save();
    assert.equal((await verifyBackup(root, 'hirmos_test')).database, 'hirmos_test');
    await assert.rejects(verifyBackup(root, 'other'), /INVALID_MANIFEST/);
    await writeFile(join(root, 'database.dump'), 'corrupt');
    await assert.rejects(verifyBackup(root, 'hirmos_test'), /CHECKSUM_MISMATCH/);
    await writeFile(join(root, 'database.dump'), bytes);
    manifest.artifacts.push({ ...manifest.artifacts[0], path: '../database.dump' });
    await save(); await assert.rejects(verifyBackup(root, 'hirmos_test'), /INVALID_ARTIFACT/);
    manifest.artifacts.pop(); await save();
    await mkdir(join(root, 'nested'));
    await symlink(join(root, 'database.dump'), join(root, 'nested', 'database.dump'));
    await writeFile(join(root, 'nested', 'manifest.json'), await readFile(join(root, 'manifest.json')));
    await assert.rejects(verifyBackup(join(root, 'nested'), 'hirmos_test'), /NOT_REGULAR_FILE/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rotation refuses unknown files before erasing an old backup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hirmos-backup-rotation-'));
  const names = ['hirmos-backup-20261001T010000000Z-00000000-0000-0000-0000-000000000001',
    'hirmos-backup-20261001T020000000Z-00000000-0000-0000-0000-000000000002'];
  try {
    for (const [index, name] of names.entries()) {
      const directory = join(root, name);
      await mkdir(directory);
      await mkdir(join(directory, 'lyrics'));
      await mkdir(join(directory, 'config'));
      await writeFile(join(directory, 'database.dump'), 'dump');
      await writeFile(join(directory, 'manifest.json'), JSON.stringify({
        kind: 'hirmos-backup', version: 1, database: 'hirmos_test',
        createdAt: `2026-10-01T0${index + 1}:00:00.000Z`,
        artifacts: [{ path: 'database.dump', bytes: 4,
          sha256: createHash('sha256').update('dump').digest('hex') }],
      }));
    }
    const extra = join(root, names[0], 'unrelated.txt');
    await writeFile(extra, 'keep me');
    await assert.rejects(rotateBackups(root, 'hirmos_test'), /UNEXPECTED_FILE/);
    await verifyBackup(join(root, names[0]), 'hirmos_test');
    await rm(extra);
    assert.deepEqual(await rotateBackups(root, 'hirmos_test'), [names[0]]);
    await verifyBackup(join(root, names[1]), 'hirmos_test');
  } finally { await rm(root, { recursive: true, force: true }); }
});
