// Manual integrated browser fixture. Never connects to a production database.
// Build and migrate the disposable hirmos_core_test database first.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import argon2 from 'argon2';
import { createDatabase } from '../apps/api/dist/db/database.js';
import { loadConfig } from '../apps/api/dist/config.js';
import { buildApp } from '../apps/api/dist/app.js';
import { AuthService } from '../apps/api/dist/auth/auth-service.js';
import { AccountService } from '../apps/api/dist/auth/account-service.js';
import { PostgresAccountRepository } from '../apps/api/dist/auth/account-repository.js';
import { AesGcmOutboxCipher } from '../apps/api/dist/mail/outbox-cipher.js';
import { SessionRevocationNotifier } from '../apps/api/dist/auth/session-revocation.js';
import { PostgresAuthRepository } from '../apps/api/dist/auth/auth-repository.js';
import { MusicSourceService } from '../apps/api/dist/music-source/music-source-service.js';
import { MusicSourceRepository } from '../apps/api/dist/music-source/music-source-repository.js';
import { SourceCredentialCipher } from '../apps/api/dist/music-source/source-credential-cipher.js';
import { CatalogRepository } from '../apps/api/dist/activity/catalog-repository.js';
import { ActivityRepository } from '../apps/api/dist/activity/activity-repository.js';
import { FavoriteRepository } from '../apps/api/dist/favorites/favorite-repository.js';
import { PlaybackRepository } from '../apps/api/dist/playback/playback-repository.js';
import { PlaybackService } from '../apps/api/dist/playback/playback-service.js';
import { PlaybackActivityProjector } from '../apps/api/dist/playback/playback-activity-projector.js';
import { createSocketServer } from '../apps/api/dist/socket/socket-server.js';
import { LyricsRepository } from '../apps/api/dist/lyrics/lyrics-repository.js';
import { LrclibLyricsProvider } from '../apps/api/dist/lyrics/lrclib-lyrics-provider.js';
import { ThirdPartyTelemetry } from '../apps/api/dist/integrations/third-party-request.js';

const url = new URL(process.env.HIRMOS_TEST_DATABASE_URL ?? '');
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/hirmos_core_test') {
  throw new Error('Only a disposable local hirmos_core_test database is allowed');
}
process.chdir(fileURLToPath(new URL('../apps/api/', import.meta.url)));
const database = createDatabase(url.href);
const user = (await database.query(`INSERT INTO users(email,display_name,role)
  VALUES ('listener@example.test','Prueba aislada','user') ON CONFLICT (lower(email))
  DO UPDATE SET display_name=EXCLUDED.display_name RETURNING id`)).rows[0];
await database.query(`INSERT INTO password_credentials(user_id,password_hash) VALUES ($1,$2)
  ON CONFLICT(user_id) DO NOTHING`,
  [user.id, await argon2.hash('Fixture-only-2026!')]);
const fixtureAdmin = (await database.query(`INSERT INTO users(email,display_name,role)
  VALUES ('admin@example.test','Administración de prueba','admin') ON CONFLICT (lower(email))
  DO UPDATE SET display_name=EXCLUDED.display_name RETURNING id`)).rows[0];
await database.query(`INSERT INTO password_credentials(user_id,password_hash) VALUES ($1,$2)
  ON CONFLICT(user_id) DO NOTHING`, [fixtureAdmin.id, await argon2.hash('Fixture-admin-2026!')]);

const songs = ['Primera señal', 'Segunda señal', 'Tercera señal', 'Cuarta señal'].map((title, i) => ({
  id: String(i + 1), title, artist: 'Artista de prueba', artistId: 'artist', album: 'Prueba de continuidad',
  albumId: 'album', coverArt:'fixture-cover', duration: 180, track: i + 1, isDir: false, contentType: 'audio/wav', suffix: 'wav',
}));
// Opt-in lyrics lab: real resolver + synthetic responses, no external traffic.
const lyricsLab = process.env.HIRMOS_FIXTURE_LYRICS_LOOKUP === '1';
if (lyricsLab) for (const song of songs) song.album += ' (Example Records - ABC 1234, EU, 2026)';
const lyricsTelemetry = new ThirdPartyTelemetry();
const lyricsRequests = [];
const lyricsProvider = new LrclibLyricsProvider(async input => {
  const target = new URL(String(input));
  const title = target.searchParams.get('track_name');
  const search = target.pathname === '/api/search';
  lyricsRequests.push({ operation: search ? 'search' : 'get', title,
    album: target.searchParams.get('album_name') });
  if (lyricsRequests.length > 100) lyricsRequests.shift();
  const song = songs.find(song => song.title === title);
  if (!song) throw new Error('Only synthetic fixture tracks are allowed');
  if (song.id === '4') return new Response(null, { status: 503, headers: { 'Retry-After': '0' } });
  const row = { id: Number(song.id), trackName: title, artistName: song.artist,
    albumName: 'Prueba de continuidad', duration: 180,
    syncedLyrics: '[00:00]Letra sintética LRCLIB: búsqueda validada.\n[00:10]Segunda línea de prueba.' };
  if (!search) {
    if (song.id !== '1' || target.searchParams.get('album_name') !== row.albumName) {
      return new Response(null, { status: 404 });
    }
    return Response.json(row);
  }
  return Response.json(song.id === '3'
    ? [row, { ...row, id: 33, syncedLyrics: '[00:00]Documento contradictorio: no elegir.' }] : [row]);
}, lyricsTelemetry);
const album = { id: 'album', name: 'Prueba de continuidad', artist: 'Artista de prueba',
  artistId: 'artist', coverArt:'fixture-cover', songCount: songs.length, duration: 720, year: 2026 };
const artist = { id: 'artist', name: 'Artista de prueba', albumCount: 1 };
const wav = Buffer.alloc(44 + 180 * 16000 * 2);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
wav.writeUInt32LE(wav.length - 44, 40);
for (let i = 44; i < wav.length; i += 2) wav.writeInt16LE(Math.round(180 * Math.sin((i - 44) / 2 * Math.PI * 440 / 16000)), i);
let fault = { mode: 'healthy', track: '1' };
const requests = [];
const provider = createServer(async (req, res) => {
  const target = new URL(req.url, 'http://127.0.0.1:3314');
  const json = data => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data)); };
  if (target.pathname === '/__fixture/state') {
    if (req.method === 'POST') {
      // Loopback-only control; refuse browser cross-origin requests.
      if (req.headers.origin) { res.writeHead(403); return res.end(); }
      let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 512) break; }
      const value = JSON.parse(body);
      if (!['healthy','missing','unavailable','stall','corrupt'].includes(value.mode)) { res.writeHead(400); return res.end(); }
      fault = { mode: value.mode, track: String(value.track ?? '1') };
    }
    return json({ fault, requests: requests.slice(-30) });
  }
  const operation = target.pathname.split('/').pop().replace('.view', '');
  const id = target.searchParams.get('id');
  requests.push({ operation, id, at: Date.now(), mode: fault.mode });
  if (requests.length > 100) requests.shift();
  if(operation==='getCoverArt'){
    // One-pixel raster, entirely synthetic; no artwork or external provider.
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
    res.writeHead(200,{'content-type':'image/png','content-length':png.length});return res.end(png);
  }
  if (operation === 'stream' || operation === 'download') {
    if (fault.mode === 'unavailable') { res.writeHead(503, { 'retry-after': '10' }); return res.end(); }
    if (id === fault.track && fault.mode === 'missing') { res.writeHead(404); return res.end(); }
    if (id === fault.track && fault.mode === 'corrupt') {
      res.writeHead(200, { 'content-type': 'audio/wav' }); return res.end('not an audio file');
    }
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1;
    res.writeHead(range ? 206 : 200, { 'content-type': 'audio/wav', 'accept-ranges': 'bytes',
      'content-length': end - start + 1, ...(range ? { 'content-range': `bytes ${start}-${end}/${wav.length}` } : {}) });
    if (id === fault.track && fault.mode === 'stall') {
      res.write(wav.subarray(start, Math.min(end + 1, start + 64044))); return;
    }
    return res.end(wav.subarray(start, end + 1));
  }
  const data = {
    ping: {}, getOpenSubsonicExtensions: { openSubsonicExtensions: [] },
    getArtists: { artists: { index: [{ artist: [artist] }] } },
    getAlbumList2: { albumList2: { album: Number(target.searchParams.get('offset')) ? [] : [album] } },
    getAlbum: { album: { ...album, song: songs } }, getArtist: { artist: { ...artist, album: [album] } },
    getArtistInfo2: { artistInfo2: {} }, getTopSongs: { topSongs: { song: songs } },
    getGenres: { genres: { genre: [] } }, getRandomSongs: { randomSongs: { song: songs } },
    search3: { searchResult3: { song: Number(target.searchParams.get('songOffset')) ? [] : songs, artist: [artist], album: [album] } },
    getSong: { song: songs.find(song => song.id === id) }, getLyrics: { lyrics: {} },
    getLyricsBySongId: { lyricsList: { structuredLyrics: [{displayArtist:artist.name,
      displayTitle:songs.find(song=>song.id===id)?.title,lang:'es',synced:true,
      line:[{start:0,value:'Letra sintética guardada para la prueba offline.'},
        {start:10000,value:'Segunda línea: puedes saltar aquí sin consultar la red.'},
        {start:30000,value:'Tercera línea: la música y la cola permanecen locales.'}]}] } },
  }[operation];
  json({ 'subsonic-response': { status: 'ok', version: '1.16.1', type: 'fixture', ...data } });
});
await new Promise(resolve => provider.listen(3314, '127.0.0.1', resolve));
const config = loadConfig({ NODE_ENV: 'development', HOST: '127.0.0.1', PORT: '3313',
  PUBLIC_ORIGIN: 'http://127.0.0.1:3313', LOG_LEVEL: 'warn' });
const music = new MusicSourceService(new MusicSourceRepository(database),
  new SourceCredentialCipher(randomBytes(32).toString('base64url')), undefined,
  new ActivityRepository(database), lyricsLab ? new LyricsRepository(database) : undefined,
  lyricsLab ? [lyricsProvider] : [], new CatalogRepository(database), undefined,
  new FavoriteRepository(database));
await music.configure({ name: 'Fuente sintética', baseUrl: 'http://127.0.0.1:3314', username: 'fixture', password: 'fixture' });
await music.syncCatalog();
const revocations = new SessionRevocationNotifier();
const auth = new AuthService(new PostgresAuthRepository(database), undefined, revocations);
// No SMTP worker: synthetic invitation messages stay in this disposable database.
const accounts = new AccountService(new PostgresAccountRepository(database),
  new AesGcmOutboxCipher(randomBytes(32).toString('base64url')), config.PUBLIC_ORIGIN, undefined, revocations);
const app = await buildApp({ config, authService: auth, accountService: accounts, musicSourceService: music, database, revocations });
if (lyricsLab) {
  lyricsTelemetry.attachLogger(app.log);
  app.get('/__fixture/lyrics-requests', async () => ({ requests: lyricsRequests }));
}
// Opt-in, local-only instrumentation. No production bundle or audio behavior changes.
if (process.env.HIRMOS_FIXTURE_AUDIO_PROBE === '1') {
  app.get('/__fixture/audio-probe.js', async (_request, reply) => reply.type('application/javascript')
    .send(await readFile(new URL('./fixtures/audio-reload-probe.js', import.meta.url), 'utf8')));
  app.get('/__fixture/tone.wav', async (_request, reply) => reply.type('audio/wav').send(wav));
  app.get('/__fixture/audio-control', async (_request, reply) => reply.type('text/html').send(`<!doctype html>
    <html lang="es"><head><meta charset="utf-8"><title>Control mínimo de autoplay</title></head><body>
    <h1>Control mínimo de autoplay</h1><p>Sin Angular, Socket.IO ni lease. Audio sintético local.</p>
    <audio id="control-audio" src="/__fixture/tone.wav" controls></audio>
    <button id="control-play">Reproducir control</button><button id="control-pause">Pausar control</button>
    <script src="/__fixture/audio-probe.js"></script></body></html>`));
  const observedPage = async (_request, reply) => reply.type('text/html').send(
    (await readFile(new URL('../apps/web/dist/web/browser/index.html', import.meta.url), 'utf8'))
      .replace('<head>', '<head><script src="/__fixture/audio-probe.js"></script>'));
  app.get('/', observedPage);
  app.get('/albums/:id', observedPage);
}
const playback = new PlaybackService(new PlaybackRepository(database));
const io = createSocketServer(app.server, config, auth, playback, revocations, app.log);
const projector = new PlaybackActivityProjector(database, app.log);
await app.listen({ host: config.HOST, port: config.PORT });
projector.start();
// Test-only transport cut: no production endpoint or browser injection.
process.on('SIGUSR2', () => { for (const socket of io.sockets.sockets.values()) socket.conn.close(); });
async function close() {
  io.close(); provider.closeAllConnections(); provider.close();
  await projector.stop(); await app.close(); await database.close();
}
process.once('SIGINT', () => void close()); process.once('SIGTERM', () => void close());
console.log('Fixture ready: http://127.0.0.1:3313 — listener@example.test / Fixture-only-2026!');
