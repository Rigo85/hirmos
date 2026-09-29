#!/usr/bin/env node
// Optional regression against the actual scanner; requires Docker, ffmpeg, sqlite3.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildSourceIgnoreUpdate } from './index.mjs';

const image = process.env.NAVIDROME_TEST_IMAGE ?? 'deluan/navidrome:0.63.2';
const root = await fs.mkdtemp(path.join(tmpdir(), 'hirmos-ndignore-test-'));
const music = path.join(root, 'music');
const data = path.join(root, 'data');
const expected = [];
const container = `hirmos-ndignore-test-${process.pid}`;
let started = false;
try {
  await fs.mkdir(music);
  await fs.mkdir(data);
  const sample = path.join(root, 'sample.flac');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
    '-t', '0.1', '-c:a', 'flac', sample]);
  // A legacy negative control proves that the test can reproduce the original bug.
  const cases = [
    { folder: 'Box/Disc legacy', source: 'Example - Album.flac', legacy: true },
    { folder: 'Box/Disc fixed', source: 'Example - Album.flac' },
    { folder: 'Box/Disc migrated', source: 'Example - Album.flac', migrate: true },
    { folder: 'Box/Disc appended', source: 'Example - Album.flac', append: true },
    { folder: 'Box/Disc symbols', source: 'Example [Disc 1]?.flac' },
    { folder: 'Box/Disc hash', source: '#Example.flac' },
    { folder: 'Box/Disc bang', source: '!Example.flac' },
    { folder: 'Box/Disc punctuation', source: 'Example (Japan) + {Live} $1^|.flac' },
    { folder: 'Box/Disc star', source: 'Example*.flac' },
    { folder: 'Box/Disc regex', source: 'Example (Japan).flac', nearMiss: 'Example Japan.flac' },
  ];
  for (const item of cases) {
    const directory = path.join(music, item.folder);
    await fs.mkdir(directory, { recursive: true });
    const old = `# Hirmos CUE splitter: preserve source without indexing it\n/${item.source}\n`;
    const update = buildSourceIgnoreUpdate(item.migrate ? old : undefined, item.source);
    await fs.writeFile(path.join(directory, '.ndignore'),
      item.legacy ? old : item.append ? old + update.addition : (update.replacement ?? update.addition));
    for (const name of [item.source, '01 - Keep.flac', ...(item.nearMiss ? [item.nearMiss] : [])]) {
      await fs.copyFile(sample, path.join(directory, name));
    }
    expected.push(`${item.folder}/01 - Keep.flac`);
    if (item.legacy) expected.push(`${item.folder}/${item.source}`);
    if (item.nearMiss) expected.push(`${item.folder}/${item.nearMiss}`);
  }
  execFileSync('docker', ['run', '-d', '--rm', '--network', 'none',
    '--name', container, '--user', `${process.getuid()}:${process.getgid()}`,
    '-v', `${music}:/music:ro`, '-v', `${data}:/data`, image,
    '--datafolder', '/data', '--musicfolder', '/music', '--loglevel', 'info'],
  { stdio: 'pipe', timeout: 120_000 });
  started = true;
  let scanned = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const result = spawnSync('docker', ['logs', container], { encoding: 'utf8' });
    const logs = result.stdout + result.stderr;
    if (logs.includes('Finished scanning all libraries')) { scanned = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.ok(scanned, 'isolated Navidrome did not complete its scan');
  const actual = JSON.parse(execFileSync('sqlite3', ['-json', path.join(data, 'navidrome.db'),
    'SELECT path FROM media_file WHERE missing = 0 ORDER BY path'], { encoding: 'utf8' }));
  assert.deepEqual(actual.map((row) => row.path).sort(), expected.sort());
  console.log(`PASS: actual Navidrome scanner ${image}, ${cases.length} cases; only legacy source remains.`);
} finally {
  if (started) execFileSync('docker', ['stop', '-t', '5', container], { stdio: 'pipe' });
  await fs.rm(root, { recursive: true, force: true });
}
