#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import {
  constants as fsConstants,
  createReadStream,
  promises as fs,
} from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFile = promisify(execFileCallback);
const AUDIO_EXTENSIONS = new Set([
  '.aac',
  '.aiff',
  '.alac',
  '.ape',
  '.flac',
  '.m4a',
  '.mp3',
  '.ogg',
  '.opus',
  '.wav',
  '.wv',
]);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png']);
const COVER_NAMES = ['cover', 'folder', 'front'];

export function cueTimestampToFrames(value) {
  const match = /^(\d+):(\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(`Índice CUE inválido: ${value}`);
  }

  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  const frames = Number(match[3]);
  if (seconds > 59 || frames > 74) {
    throw new Error(`Índice CUE fuera de rango: ${value}`);
  }

  return (minutes * 60 + seconds) * 75 + frames;
}

function readCueValue(line, keyword) {
  const remainder = line.slice(keyword.length).trim();
  if (remainder.startsWith('"') && remainder.endsWith('"')) {
    return remainder.slice(1, -1).replaceAll('""', '"');
  }
  return remainder;
}

export function parseCue(text) {
  const album = {
    title: undefined,
    performer: undefined,
    date: undefined,
    genre: undefined,
  };
  const tracks = [];
  let currentFile;
  let currentTrack;

  for (const originalLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = originalLine.trim();
    if (!line) continue;

    if (/^REM\s+DATE\s+/i.test(line)) {
      album.date = readCueValue(line, line.match(/^REM\s+DATE/i)[0]);
      continue;
    }
    if (/^REM\s+GENRE\s+/i.test(line)) {
      album.genre = readCueValue(line, line.match(/^REM\s+GENRE/i)[0]);
      continue;
    }
    if (/^FILE\s+/i.test(line)) {
      const match = /^FILE\s+(?:"([^"]+)"|(\S+))\s+\S+$/i.exec(line);
      if (!match) throw new Error(`Declaración FILE no reconocida: ${line}`);
      currentFile = match[1] ?? match[2];
      continue;
    }
    if (/^TRACK\s+/i.test(line)) {
      const match = /^TRACK\s+(\d+)\s+(\S+)$/i.exec(line);
      if (!match) throw new Error(`Declaración TRACK no reconocida: ${line}`);
      if (match[2].toUpperCase() !== 'AUDIO') continue;
      if (!currentFile) throw new Error('TRACK apareció antes de FILE.');
      currentTrack = {
        number: Number(match[1]),
        file: currentFile,
        title: undefined,
        performer: undefined,
        index00Frames: undefined,
        index01Frames: undefined,
      };
      tracks.push(currentTrack);
      continue;
    }
    if (/^TITLE\s+/i.test(line)) {
      const value = readCueValue(line, line.match(/^TITLE/i)[0]);
      if (currentTrack) currentTrack.title = value;
      else album.title = value;
      continue;
    }
    if (/^PERFORMER\s+/i.test(line)) {
      const value = readCueValue(line, line.match(/^PERFORMER/i)[0]);
      if (currentTrack) currentTrack.performer = value;
      else album.performer = value;
      continue;
    }
    if (/^INDEX\s+(00|01)\s+/i.test(line) && currentTrack) {
      const match = /^INDEX\s+(00|01)\s+(\d+:\d{2}:\d{2})$/i.exec(line);
      if (!match) throw new Error(`Declaración INDEX no reconocida: ${line}`);
      const frames = cueTimestampToFrames(match[2]);
      if (match[1] === '00') currentTrack.index00Frames = frames;
      else currentTrack.index01Frames = frames;
    }
  }

  if (!tracks.length) throw new Error('El CUE no contiene pistas AUDIO.');
  const sourceFiles = new Set(tracks.map((track) => track.file));
  if (sourceFiles.size !== 1) {
    throw new Error('Esta versión admite un único archivo de audio por CUE.');
  }
  for (const track of tracks) {
    if (!track.title) throw new Error(`La pista ${track.number} no tiene TITLE.`);
    if (track.index01Frames === undefined) {
      throw new Error(`La pista ${track.number} no tiene INDEX 01.`);
    }
  }
  for (let index = 1; index < tracks.length; index += 1) {
    if (tracks[index].index01Frames <= tracks[index - 1].index01Frames) {
      throw new Error('Los INDEX 01 no están ordenados de forma ascendente.');
    }
  }

  return { album, sourceFile: tracks[0].file, tracks };
}

export function sanitizeFileName(value) {
  const sanitized = value
    .normalize('NFC')
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  return sanitized || 'Sin título';
}

export function normalizeIdentity(value) {
  return value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('es')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim();
}

function escapeIgnoreFileName(fileName) {
  return fileName.replaceAll('\\', '\\\\').replace(/([*?\[\]])/g, '\\$1');
}

export function buildSourceIgnoreUpdate(existingContent, sourceFile) {
  const rule = `/${escapeIgnoreFileName(sourceFile)}`;
  if (existingContent === undefined) {
    return {
      status: 'missing',
      changed: true,
      addition: `# Hirmos CUE splitter: preserve source without indexing it\n${rule}\n`,
      rule,
    };
  }
  if (existingContent.trim() === '') {
    return {
      status: 'directory-ignored',
      changed: false,
      addition: '',
      rule,
    };
  }
  const hasRule = existingContent
    .split(/\r?\n/)
    .some((line) => line === rule);
  if (hasRule) {
    return { status: 'present', changed: false, addition: '', rule };
  }
  const separator = existingContent.endsWith('\n') ? '' : '\n';
  return {
    status: 'missing',
    changed: true,
    addition: `${separator}# Hirmos CUE splitter: preserve source without indexing it\n${rule}\n`,
    rule,
  };
}

export function buildTrackPlan(cue, sourceProbe) {
  const sampleRate = Number(sourceProbe.sampleRate);
  const totalSamples = Number(sourceProbe.totalSamples);
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new Error('No se pudo determinar la frecuencia de muestreo.');
  }
  if (!Number.isInteger(totalSamples) || totalSamples <= 0) {
    throw new Error('No se pudo determinar la cantidad total de muestras.');
  }

  const extension = path.extname(cue.sourceFile).toLowerCase();
  return cue.tracks.map((track, index) => {
    const startSample = Math.round((track.index01Frames * sampleRate) / 75);
    const next = cue.tracks[index + 1];
    const endSample = next
      ? Math.round((next.index01Frames * sampleRate) / 75)
      : totalSamples;
    if (endSample <= startSample || endSample > totalSamples) {
      throw new Error(`Límites inválidos para la pista ${track.number}.`);
    }
    const paddedNumber = String(track.number).padStart(2, '0');
    return {
      ...track,
      artist: track.performer ?? cue.album.performer,
      album: cue.album.title,
      albumArtist: cue.album.performer ?? track.performer,
      startSample,
      endSample,
      durationSeconds: (endSample - startSample) / sampleRate,
      outputFile: `${paddedNumber} - ${sanitizeFileName(track.title)}${extension}`,
    };
  });
}

function normalizeTags(tags = {}) {
  return Object.fromEntries(
    Object.entries(tags).map(([key, value]) => [key.toUpperCase(), String(value)]),
  );
}

function trackNumberFromTags(tags) {
  const value = tags.TRACK ?? tags.TRACKNUMBER;
  if (!value) return undefined;
  const number = Number.parseInt(value, 10);
  return Number.isInteger(number) ? number : undefined;
}

export function classifyExistingTracks(plan, candidates) {
  const matches = new Map();
  const conflicts = [];

  for (const candidate of candidates) {
    const tags = normalizeTags(candidate.tags);
    const candidateTrackNumber = trackNumberFromTags(tags);
    const candidateTitle = normalizeIdentity(tags.TITLE ?? '');
    const candidateStem = normalizeIdentity(path.parse(candidate.file).name);

    const possible = plan.filter((track) => {
      const title = normalizeIdentity(track.title);
      const outputStem = normalizeIdentity(path.parse(track.outputFile).name);
      return (
        (candidateTrackNumber === track.number && candidateTitle === title) ||
        candidateStem === outputStem ||
        candidateStem === title
      );
    });

    for (const track of possible) {
      const problems = [];
      if (
        !Number.isFinite(candidate.durationSeconds) ||
        Math.abs(candidate.durationSeconds - track.durationSeconds) > 0.25
      ) {
        problems.push('la duración no coincide');
      }
      if (candidateTrackNumber !== track.number) problems.push('TRACK no coincide');
      if (candidateTitle !== normalizeIdentity(track.title)) {
        problems.push('TITLE no coincide');
      }
      if (
        track.artist &&
        normalizeIdentity(tags.ARTIST ?? '') !== normalizeIdentity(track.artist)
      ) {
        problems.push('ARTIST no coincide');
      }
      if (
        track.album &&
        normalizeIdentity(tags.ALBUM ?? '') !== normalizeIdentity(track.album)
      ) {
        problems.push('ALBUM no coincide');
      }
      const albumArtist = tags.ALBUMARTIST ?? tags.ALBUM_ARTIST;
      if (
        track.albumArtist &&
        normalizeIdentity(albumArtist ?? '') !== normalizeIdentity(track.albumArtist)
      ) {
        problems.push('ALBUMARTIST no coincide');
      }
      if (problems.length) {
        conflicts.push({
          file: candidate.file,
          track: track.number,
          reason: problems.join(', '),
        });
        continue;
      }
      if (matches.has(track.number)) {
        conflicts.push({
          file: candidate.file,
          track: track.number,
          reason: `también coincide con ${matches.get(track.number).file}`,
        });
        continue;
      }
      matches.set(track.number, candidate);
    }
  }

  const missing = plan.filter((track) => !matches.has(track.number));
  return {
    status:
      conflicts.length > 0
        ? 'conflict'
        : matches.size === 0
          ? 'empty'
          : missing.length === 0
            ? 'complete'
            : 'partial',
    matches,
    missing,
    conflicts,
  };
}

async function probeAudio(file) {
  let stdout;
  try {
    ({ stdout } = await execFile(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration:format_tags:stream=index,codec_name,codec_type,sample_rate,channels,bits_per_raw_sample,duration_ts,time_base',
        '-of',
        'json',
        file,
      ],
      { maxBuffer: 4 * 1024 * 1024 },
    ));
  } catch (error) {
    throw new Error(`ffprobe no pudo leer ${path.basename(file)}: ${error.message}`);
  }
  const parsed = JSON.parse(stdout);
  const audio = parsed.streams?.find((stream) => stream.codec_type === 'audio');
  if (!audio) throw new Error(`${path.basename(file)} no contiene audio.`);
  const sampleRate = Number(audio.sample_rate);
  let totalSamples = Number(audio.duration_ts);
  if (!Number.isInteger(totalSamples) || totalSamples <= 0) {
    totalSamples = Math.round(Number(parsed.format?.duration) * sampleRate);
  }
  return {
    codec: audio.codec_name,
    sampleRate,
    channels: Number(audio.channels),
    bitsPerRawSample: Number(audio.bits_per_raw_sample) || undefined,
    totalSamples,
    durationSeconds: Number(parsed.format?.duration),
    tags: parsed.format?.tags ?? {},
    hasArtwork: parsed.streams?.some((stream) => stream.codec_type === 'video') ?? false,
  };
}

async function findCover(entries, directory) {
  const images = entries.filter((entry) => {
    return entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase());
  });
  for (const preferred of COVER_NAMES) {
    const match = images.find(
      (entry) => path.parse(entry.name).name.toLowerCase() === preferred,
    );
    if (match) return path.join(directory, match.name);
  }
  return undefined;
}

async function readOptionalText(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function ensureSourceIgnored(directory, sourceFile) {
  const ignorePath = path.join(directory, '.ndignore');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existingContent = await readOptionalText(ignorePath);
    const update = buildSourceIgnoreUpdate(existingContent, sourceFile);
    if (update.status === 'directory-ignored') {
      throw new Error(
        '.ndignore está vacío y actualmente excluye todo el álbum; no se modificó.',
      );
    }
    if (!update.changed) return { ...update, ignorePath };
    if (existingContent === undefined) {
      try {
        await fs.writeFile(ignorePath, update.addition, { flag: 'wx' });
        return { status: 'created', changed: true, rule: update.rule, ignorePath };
      } catch (error) {
        if (error.code === 'EEXIST') continue;
        throw error;
      }
    }
    await fs.appendFile(ignorePath, update.addition);
    return { status: 'updated', changed: true, rule: update.rule, ignorePath };
  }
  throw new Error('No se pudo actualizar .ndignore porque cambió concurrentemente.');
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-16_384);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} terminó con código ${code}: ${stderr.trim()}`));
    });
  });
}

function sourceTag(tags, ...names) {
  const normalized = normalizeTags(tags);
  for (const name of names) {
    if (normalized[name]) return normalized[name];
  }
  return undefined;
}

function metadataArguments(track, cue, sourceTags, totalTracks) {
  const metadata = {
    title: track.title,
    artist: track.artist,
    album: track.album ?? sourceTag(sourceTags, 'ALBUM'),
    album_artist:
      track.albumArtist ?? sourceTag(sourceTags, 'ALBUMARTIST', 'ALBUM_ARTIST'),
    track: `${track.number}/${totalTracks}`,
    date: cue.album.date ?? sourceTag(sourceTags, 'DATE', 'YEAR'),
    genre: cue.album.genre ?? sourceTag(sourceTags, 'GENRE'),
  };
  return Object.entries(metadata).flatMap(([key, value]) =>
    value ? ['-metadata', `${key}=${value}`] : [],
  );
}

async function createTemporaryTrack({
  sourcePath,
  coverPath,
  temporaryPath,
  track,
  cue,
  sourceProbe,
}) {
  const filter = `atrim=start_sample=${track.startSample}:end_sample=${track.endSample},asetpts=N/SR/TB`;
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', sourcePath];
  if (coverPath) args.push('-i', coverPath);
  args.push(
    '-map',
    '0:a:0',
    ...(coverPath ? ['-map', '1:v:0'] : []),
    '-map_metadata',
    '-1',
    '-af',
    filter,
    '-c:a',
    'flac',
    '-compression_level',
    '8',
    ...(coverPath ? ['-c:v', 'copy', '-disposition:v:0', 'attached_pic'] : []),
    ...metadataArguments(track, cue, sourceProbe.tags, cue.tracks.length),
    temporaryPath,
  );
  await runProcess('ffmpeg', args);
}

async function validateGeneratedTrack(file, track, sourceProbe, coverExpected) {
  const probe = await probeAudio(file);
  const tags = normalizeTags(probe.tags);
  const failures = [];
  if (probe.codec !== 'flac') failures.push(`códec ${probe.codec}`);
  if (probe.sampleRate !== sourceProbe.sampleRate) failures.push('sample rate diferente');
  if (probe.channels !== sourceProbe.channels) failures.push('canales diferentes');
  if (
    sourceProbe.bitsPerRawSample &&
    probe.bitsPerRawSample !== sourceProbe.bitsPerRawSample
  ) {
    failures.push('profundidad de bits diferente');
  }
  if (Math.abs(probe.durationSeconds - track.durationSeconds) > 0.02) {
    failures.push('duración diferente');
  }
  if (normalizeIdentity(tags.TITLE ?? '') !== normalizeIdentity(track.title)) {
    failures.push('TITLE incorrecto');
  }
  if (trackNumberFromTags(tags) !== track.number) failures.push('TRACK incorrecto');
  if (track.artist && normalizeIdentity(tags.ARTIST ?? '') !== normalizeIdentity(track.artist)) {
    failures.push('ARTIST incorrecto');
  }
  if (track.album && normalizeIdentity(tags.ALBUM ?? '') !== normalizeIdentity(track.album)) {
    failures.push('ALBUM incorrecto');
  }
  const albumArtist = tags.ALBUMARTIST ?? tags.ALBUM_ARTIST;
  if (
    track.albumArtist &&
    normalizeIdentity(albumArtist ?? '') !== normalizeIdentity(track.albumArtist)
  ) {
    failures.push('ALBUMARTIST incorrecto');
  }
  if (coverExpected && !probe.hasArtwork) failures.push('portada ausente');
  if (failures.length) {
    throw new Error(`${track.outputFile} no superó la validación: ${failures.join(', ')}`);
  }
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function inspectDirectory(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const cueEntries = entries.filter(
    (entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.cue',
  );
  if (cueEntries.length !== 1) {
    throw new Error(
      `Se esperaba exactamente un .cue y se encontraron ${cueEntries.length}.`,
    );
  }
  const cuePath = path.join(directory, cueEntries[0].name);
  const cue = parseCue(await fs.readFile(cuePath, 'utf8'));
  const sourcePath = path.resolve(directory, cue.sourceFile);
  if (path.dirname(sourcePath) !== directory) {
    throw new Error('FILE debe apuntar a un archivo dentro del directorio del álbum.');
  }
  await fs.access(sourcePath, fsConstants.R_OK);
  if (path.extname(sourcePath).toLowerCase() !== '.flac') {
    throw new Error(
      'La primera versión solo divide fuentes FLAC para garantizar salida sin pérdida.',
    );
  }
  const sourceProbe = await probeAudio(sourcePath);
  if (sourceProbe.codec !== 'flac') throw new Error('La fuente declarada no es FLAC.');
  const plan = buildTrackPlan(cue, sourceProbe);
  const sourceName = path.basename(sourcePath);
  const candidateEntries = entries.filter((entry) => {
    return (
      entry.isFile() &&
      entry.name !== sourceName &&
      !entry.name.startsWith('.') &&
      AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
    );
  });
  const candidates = [];
  for (const entry of candidateEntries) {
    const probe = await probeAudio(path.join(directory, entry.name));
    candidates.push({ file: entry.name, ...probe });
  }
  const existing = classifyExistingTracks(plan, candidates);
  const coverPath = await findCover(entries, directory);
  const ignorePath = path.join(directory, '.ndignore');
  const ignoreUpdate = buildSourceIgnoreUpdate(
    await readOptionalText(ignorePath),
    path.basename(sourcePath),
  );
  return {
    directory,
    cue,
    cuePath,
    sourcePath,
    sourceProbe,
    plan,
    existing,
    coverPath,
    ignoreUpdate,
  };
}

function printInspection(inspection) {
  const { cue, sourcePath, sourceProbe, plan, existing, coverPath, ignoreUpdate } =
    inspection;
  console.log(`Álbum: ${cue.album.performer ?? '—'} — ${cue.album.title ?? '—'}`);
  console.log(`Fuente: ${path.basename(sourcePath)}`);
  console.log(
    `Audio: ${sourceProbe.codec.toUpperCase()}, ${sourceProbe.sampleRate} Hz, ${sourceProbe.bitsPerRawSample ?? '?'} bits, ${sourceProbe.channels} canales`,
  );
  console.log(`Portada: ${coverPath ? path.basename(coverPath) : 'no encontrada'}`);
  console.log(`Estado previo: ${existing.status}`);
  console.log(
    `Exclusión de fuente: ${
      ignoreUpdate.status === 'present'
        ? 'lista'
        : ignoreUpdate.status === 'directory-ignored'
          ? 'la carpeta completa ya está ignorada'
          : 'pendiente'
    }`,
  );
  console.log('');
  for (const track of plan) {
    const state = existing.matches.has(track.number) ? 'ya existe' : 'por crear';
    console.log(
      `${String(track.number).padStart(2, '0')}  ${track.title}  ${formatDuration(track.durationSeconds)}  [${state}]`,
    );
  }
  if (existing.conflicts.length) {
    console.log('');
    for (const conflict of existing.conflicts) {
      console.log(`Conflicto: ${conflict.file}: ${conflict.reason}.`);
    }
  }
}

function formatDuration(seconds) {
  const rounded = Math.round(seconds);
  const minutes = Math.floor(rounded / 60);
  return `${minutes}:${String(rounded % 60).padStart(2, '0')}`;
}

async function applyPlan(inspection) {
  const { existing, plan, directory, sourcePath, sourceProbe, cue, cuePath, coverPath } =
    inspection;
  if (inspection.ignoreUpdate.status === 'directory-ignored') {
    throw new Error(
      '.ndignore está vacío e impediría que Navidrome indexe las pistas nuevas.',
    );
  }
  if (existing.status === 'complete') {
    const ignore = await ensureSourceIgnored(directory, path.basename(sourcePath));
    console.log('Las pistas ya existen y coinciden; no se regeneró audio.');
    console.log(
      ignore.changed
        ? `.ndignore quedó actualizado con ${ignore.rule}.`
        : `.ndignore ya contenía ${ignore.rule}.`,
    );
    return;
  }
  if (existing.status === 'partial' || existing.status === 'conflict') {
    throw new Error(
      'La carpeta contiene pistas parciales o ambiguas. No se escribió ningún archivo.',
    );
  }

  const generated = [];
  try {
    for (const track of plan) {
      const finalPath = path.join(directory, track.outputFile);
      try {
        await fs.access(finalPath);
        throw new Error(`${track.outputFile} apareció durante el procesamiento.`);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const extension = path.extname(track.outputFile);
      const stem = path.basename(track.outputFile, extension);
      const temporaryPath = path.join(
        directory,
        `.${stem}.hirmos-part-${process.pid}${extension}`,
      );
      const generatedItem = { temporaryPath, finalPath, track };
      generated.push(generatedItem);
      console.log(`Generando ${track.outputFile}…`);
      await createTemporaryTrack({
        sourcePath,
        coverPath,
        temporaryPath,
        track,
        cue,
        sourceProbe,
      });
      await validateGeneratedTrack(temporaryPath, track, sourceProbe, Boolean(coverPath));
    }

    for (const item of generated) {
      await fs.rename(item.temporaryPath, item.finalPath);
    }

    const sourceStat = await fs.stat(sourcePath);
    const manifest = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      source: {
        file: path.basename(sourcePath),
        size: sourceStat.size,
        sha256: await sha256(sourcePath),
      },
      cue: {
        file: path.basename(cuePath),
        sha256: await sha256(cuePath),
      },
      audio: {
        codec: sourceProbe.codec,
        sampleRate: sourceProbe.sampleRate,
        bitsPerRawSample: sourceProbe.bitsPerRawSample,
        channels: sourceProbe.channels,
      },
      tracks: plan.map((track) => ({
        number: track.number,
        title: track.title,
        file: track.outputFile,
        startSample: track.startSample,
        endSample: track.endSample,
      })),
    };
    const manifestPath = path.join(directory, '.hirmos-cue-split.json');
    const temporaryManifest = `${manifestPath}.tmp-${process.pid}`;
    await fs.writeFile(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: 'wx',
    });
    await fs.rename(temporaryManifest, manifestPath);
    const ignore = await ensureSourceIgnored(directory, path.basename(sourcePath));
    console.log('');
    console.log(`División terminada y validada: ${generated.length} pistas.`);
    console.log(
      ignore.changed
        ? `.ndignore quedó actualizado con ${ignore.rule}.`
        : `.ndignore ya contenía ${ignore.rule}.`,
    );
  } catch (error) {
    for (const item of generated) {
      await fs.rm(item.temporaryPath, { force: true }).catch(() => undefined);
    }
    throw error;
  }
}

function parseArguments(argv) {
  const apply = argv.includes('--apply');
  const positional = argv.filter((argument) => !argument.startsWith('--'));
  if (argv.some((argument) => argument.startsWith('--') && argument !== '--apply')) {
    throw new Error('Opción desconocida. Solo se admite --apply.');
  }
  if (positional.length !== 1) {
    throw new Error('Uso: npm run cue:split -- [--apply] <directorio-del-álbum>');
  }
  return { apply, directory: path.resolve(positional[0]) };
}

export async function main(argv = process.argv.slice(2)) {
  const { apply, directory } = parseArguments(argv);
  const inspection = await inspectDirectory(directory);
  printInspection(inspection);
  if (!apply) {
    console.log('');
    console.log('Análisis solamente. Usa --apply para crear las pistas.');
    return;
  }
  console.log('');
  await applyPlan(inspection);
}

const isEntryPoint = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntryPoint) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}
