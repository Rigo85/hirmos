#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import {
  constants as fsConstants,
  createReadStream,
  promises as fs,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Publication } from './publication.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
const operation = new AsyncLocalStorage();
const signal = () => operation.getStore()?.signal;

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
const LOSSLESS_SOURCE_CODECS = new Map([
  ['.ape', 'ape'],
  ['.flac', 'flac'],
]);

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

  const total = (minutes * 60 + seconds) * 75 + frames;
  if (!Number.isSafeInteger(total)) throw new Error('Índice CUE demasiado grande.');
  return total;
}

function readCueValue(line, keyword) {
  const remainder = line.slice(keyword.length).trim();
  if (remainder.startsWith('"') && remainder.endsWith('"')) {
    return remainder.slice(1, -1).replaceAll('""', '"');
  }
  return remainder;
}

export function parseCue(text) {
  if (text.includes('\uFFFD')) throw new Error('El CUE no es UTF-8 válido; convierte su codificación antes de continuar.');
  const album = {
    title: undefined,
    performer: undefined,
    date: undefined,
    genre: undefined,
  };
  const tracks = [];
  let currentFile;
  let currentTrack;
  let fileCount = 0;

  for (const originalLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = originalLine.trim();
    if (!line) continue;

    const disc = /^REM\s+(DISCNUMBER|DISC|TOTALDISCS|DISCTOTAL)\s+"?(\d+)"?$/i.exec(line);
    if (disc) {
      const value = Number(disc[2]);
      if (value < 1) throw new Error('Número/total de disco inválido.');
      album[/^(DISCNUMBER|DISC)$/i.test(disc[1]) ? 'discNumber' : 'discTotal'] = value;
      continue;
    }
    if (/^ISRC\s+/i.test(line)) {
      if (!currentTrack) throw new Error('ISRC fuera de una pista.');
      const value = readCueValue(line, 'ISRC').toUpperCase();
      if (!/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(value)) throw new Error('ISRC inválido.');
      currentTrack.isrc = value;
      continue;
    }

    if (/^REM\s+DATE\s+/i.test(line)) {
      album.date = readCueValue(line, line.match(/^REM\s+DATE/i)[0]);
      continue;
    }
    if (/^REM\s+GENRE\s+/i.test(line)) {
      album.genre = readCueValue(line, line.match(/^REM\s+GENRE/i)[0]);
      continue;
    }
    if (/^FILE\s+/i.test(line)) {
      if (++fileCount !== 1) throw new Error('Esta versión admite una única declaración FILE por CUE.');
      const match = /^FILE\s+(?:"([^"]+)"|(\S+))\s+\S+$/i.exec(line);
      if (!match) throw new Error(`Declaración FILE no reconocida: ${line}`);
      currentFile = match[1] ?? match[2];
      continue;
    }
    if (/^TRACK\s+/i.test(line)) {
      const match = /^TRACK\s+(\d+)\s+(\S+)$/i.exec(line);
      if (!match) throw new Error(`Declaración TRACK no reconocida: ${line}`);
      if (match[2].toUpperCase() !== 'AUDIO') throw new Error('Solo se admiten CUE exclusivamente AUDIO; no pistas de datos.');
      const number = Number(match[1]);
      if (!Number.isSafeInteger(number) || number < 1 || number > 99 ||
          tracks.some(t => t.number === number) || (currentTrack && number <= currentTrack.number)) {
        throw new Error('Los números TRACK deben ser únicos, ascendentes y estar entre 1 y 99.');
      }
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
      const key = match[1] === '00' ? 'index00Frames' : 'index01Frames';
      if (currentTrack[key] !== undefined) throw new Error('INDEX repetido en la misma pista.');
      currentTrack[key] = frames;
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
    if (track.index00Frames !== undefined && track.index00Frames > track.index01Frames) {
      throw new Error('INDEX 00 no puede estar después de INDEX 01.');
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

export function validateCueMetadata(cue) {
  const performers = new Map();
  for (const track of cue.tracks) {
    if (!track.performer) continue;
    const identity = normalizeIdentity(track.performer);
    if (identity && !performers.has(identity)) performers.set(identity, track.performer);
  }
  if (
    cue.album.title &&
    cue.album.performer &&
    performers.size === 1 &&
    cue.tracks.length > 1 &&
    cue.tracks.every((track) => track.performer)
  ) {
    const [[trackPerformerIdentity, trackPerformer]] = performers;
    const albumTitleIdentity = normalizeIdentity(cue.album.title);
    const albumPerformerIdentity = normalizeIdentity(cue.album.performer);
    if (
      albumTitleIdentity === trackPerformerIdentity &&
      albumPerformerIdentity !== trackPerformerIdentity
    ) {
      throw new Error(
        `El CUE parece tener TITLE y PERFORMER intercambiados: álbum ` +
          `"${cue.album.title}", artista del álbum "${cue.album.performer}" y ` +
          `artista de todas las pistas "${trackPerformer}". Corrige el CUE antes de continuar.`,
      );
    }
  }
}

function escapeIgnoreFileName(fileName) {
  if (path.basename(fileName) !== fileName || fileName.trim() !== fileName || /[\r\n\0]/.test(fileName)) {
    throw new Error('El nombre de la imagen no permite una regla .ndignore inequívoca.');
  }
  // Navidrome's pinned go-gitignore exposes regex punctuation and already
  // escapes '?'. Check this against the real scanner, not a JS glob library.
  return fileName.replace(/[\\*\[\]()+{}^$|]/g, '\\$&')
    .replace(/^([#!])/, '\\$1');
}

export function buildSourceIgnoreUpdate(existingContent, sourceFile) {
  const rule = escapeIgnoreFileName(sourceFile);
  const legacyRule = `/${sourceFile.replaceAll('\\', '\\\\').replace(/([*?\[\]])/g, '\\$1')}`;
  const comment = '# Hirmos CUE splitter: preserve source without indexing it';
  if (existingContent === undefined) {
    return {
      status: 'missing',
      changed: true,
      addition: `${comment}\n${rule}\n`,
      rule,
    };
  }
  if (!existingContent.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    return trimmed && !trimmed.startsWith('#');
  })) {
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
  const lines = existingContent.split(/\r?\n/);
  if (lines.some((line, index) => line === legacyRule && lines[index - 1] === comment)) {
    const separator = existingContent.includes('\r\n') ? '\r\n' : '\n';
    return {
      status: 'legacy',
      changed: true,
      addition: '',
      replacement: lines
        .map((line, index) => (line === legacyRule && lines[index - 1] === comment ? rule : line))
        .join(separator),
      rule,
    };
  }
  const separator = existingContent.endsWith('\n') ? '' : '\n';
  return {
    status: 'missing',
    changed: true,
    addition: `${separator}${comment}\n${rule}\n`,
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

  return cue.tracks.map((track, index) => {
    if (Math.round(track.index01Frames * sampleRate / 75) >= totalSamples) throw new Error(`INDEX 01 fuera de la fuente: pista ${track.number}.`);
    // Preserve HTOA/initial silence rather than silently excluding source samples.
    const startSample = index === 0 ? 0 : Math.round((track.index01Frames * sampleRate) / 75);
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
      outputFile: `${paddedNumber} - ${sanitizeFileName(track.title)}.flac`,
    };
  });
}

export function validateLosslessSource(sourceFile, codec) {
  const extension = path.extname(sourceFile).toLowerCase();
  const expectedCodec = LOSSLESS_SOURCE_CODECS.get(extension);
  if (!expectedCodec) {
    throw new Error(
      'Solo se admiten imágenes FLAC o APE; no se recodifican fuentes con pérdida.',
    );
  }
  if (codec !== expectedCodec) {
    throw new Error(
      `La extensión ${extension} no coincide con el códec ${codec || 'desconocido'}.`,
    );
  }
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
  if (new Set(plan.map(t => t.number)).size !== plan.length) throw new Error('Números de pista duplicados en el plan.');
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
        'format=duration:format_tags:stream=index,codec_name,codec_type,sample_rate,channels,bits_per_raw_sample,duration_ts,time_base:stream_disposition=attached_pic',
        '-of',
        'json',
        file,
      ],
      { maxBuffer: 4 * 1024 * 1024, signal: signal() },
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
    artworkIndex: parsed.streams?.find(stream => stream.codec_type === 'video' && stream.disposition?.attached_pic)?.index,
    hasArtwork: parsed.streams?.some(stream => stream.codec_type === 'video' && stream.disposition?.attached_pic) ?? false,
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
  if (images.length === 1) return path.join(directory, images[0].name);
  return undefined;
}

async function readOptionalText(file) {
  try {
    if (!(await fs.lstat(file)).isFile()) throw new Error('Se esperaba un archivo regular: ' + path.basename(file));
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
    if (update.replacement !== undefined) {
      // Append an effective rule, keeping the legacy one as harmless history.
      // Never replace the user's whole file with a read/rename race.
      update.addition = `\n# Hirmos CUE splitter: corrected source exclusion\n${update.rule}\n`;
    }
    // Open an existing regular file without following a late symlink. Appending
    // preserves concurrent user additions instead of replacing the whole file.
    const handle = await fs.open(ignorePath, fsConstants.O_RDWR | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW);
    try {
      if (!(await handle.stat()).isFile()) throw new Error('.ndignore no es un archivo regular.');
      const latest = await handle.readFile('utf8');
      if (latest !== existingContent) continue;
      await handle.writeFile(update.addition);
      await handle.sync();
    } finally { await handle.close(); }
    return { status: 'updated', changed: true, rule: update.rule, ignorePath };
  }
  throw new Error('No se pudo actualizar .ndignore porque cambió concurrentemente.');
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], signal: signal() });
    let stderr = '';
    let abortError;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-16_384);
    });
    child.on('error', error => { if (error.name === 'AbortError') abortError = error; else reject(error); });
    child.on('close', (code) => {
      if (abortError) reject(abortError);
      else if (code === 0) resolve();
      else reject(new Error(`${command} terminó con código ${code}: ${stderr.trim()}`));
    });
  });
}

async function updateDecodedPcmHash(hash, file, filter) {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', file];
    if (filter) args.push('-af', filter);
    args.push('-map', '0:a:0', '-f', 's32le', '-c:a', 'pcm_s32le', 'pipe:1');
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'], signal: signal() });
    let stderr = '';
    let abortError;
    child.stdout.on('data', (chunk) => hash.update(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-16_384);
    });
    child.on('error', error => { if (error.name === 'AbortError') abortError = error; else reject(error); });
    child.on('close', (code) => {
      if (abortError) reject(abortError);
      else if (code === 0) resolve();
      else {
        reject(
          new Error(
            `ffmpeg no pudo verificar el PCM de ${path.basename(file)}: ${stderr.trim()}`,
          ),
        );
      }
    });
  });
}

async function decodedPcmSha256(files, filter) {
  const hash = createHash('sha256');
  for (const [index, file] of files.entries()) {
    await updateDecodedPcmHash(hash, file, index === 0 ? filter : undefined);
  }
  return hash.digest('hex');
}

function sourceTag(tags, ...names) {
  const normalized = normalizeTags(tags);
  for (const name of names) {
    if (normalized[name]) return normalized[name];
  }
  return undefined;
}

function metadataArguments(track, cue, sourceTags, totalTracks) {
  const sourceDisc = sourceTag(sourceTags, 'DISC', 'DISCNUMBER')?.split('/');
  const disc = cue.album.discNumber ?? sourceDisc?.[0];
  const discTotal = cue.album.discTotal ?? sourceTag(sourceTags, 'DISCTOTAL', 'TOTALDISCS') ?? sourceDisc?.[1];
  const metadata = {
    title: track.title,
    artist: track.artist ?? sourceTag(sourceTags, 'ARTIST'),
    album: track.album ?? sourceTag(sourceTags, 'ALBUM'),
    album_artist:
      track.albumArtist ?? sourceTag(sourceTags, 'ALBUMARTIST', 'ALBUM_ARTIST'),
    track: `${track.number}/${totalTracks}`,
    date: cue.album.date ?? sourceTag(sourceTags, 'DATE', 'YEAR'),
    genre: cue.album.genre ?? sourceTag(sourceTags, 'GENRE'),
    isrc: track.isrc,
    disc: disc ? `${disc}${discTotal ? `/${discTotal}` : ''}` : undefined,
    disctotal: discTotal,
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
    ...(coverPath ? ['-map', '1:v:0'] : sourceProbe.hasArtwork ? ['-map', `0:${sourceProbe.artworkIndex}`] : []),
    '-map_metadata',
    '-1',
    '-af',
    filter,
    '-c:a',
    'flac',
    '-compression_level',
    '8',
    ...(coverPath || sourceProbe.hasArtwork ? ['-c:v', 'png', '-disposition:v:0', 'attached_pic'] : []),
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
  if (track.isrc && tags.ISRC !== track.isrc) failures.push('ISRC incorrecto');
  if (failures.length) {
    throw new Error(`${track.outputFile} no superó la validación: ${failures.join(', ')}`);
  }
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function copyFileSequentiallyVerified(source, destination) {
  let destinationHandle;
  let destinationCreated = false;
  try {
    destinationHandle = await fs.open(destination, 'wx');
    destinationCreated = true;
    for await (const chunk of createReadStream(source)) {
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await destinationHandle.write(
          chunk,
          offset,
          chunk.length - offset,
          null,
        );
        if (bytesWritten === 0) {
          throw new Error(`No se pudo continuar copiando ${path.basename(source)}.`);
        }
        offset += bytesWritten;
      }
    }
    await destinationHandle.close();
    destinationHandle = undefined;
    const [sourceHash, destinationHash] = await Promise.all([
      sha256(source),
      sha256(destination),
    ]);
    if (sourceHash !== destinationHash) {
      throw new Error(
        `La copia de ${path.basename(source)} no coincide con el archivo local validado.`,
      );
    }
    return sourceHash;
  } catch (error) {
    await destinationHandle?.close().catch(() => undefined);
    if (destinationCreated) {
      await fs.rm(destination, { force: true }).catch(() => undefined);
    }
    throw error;
  }
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
  validateCueMetadata(cue);
  const sourcePath = path.resolve(directory, cue.sourceFile);
  if (path.dirname(sourcePath) !== directory) {
    throw new Error('FILE debe apuntar a un archivo dentro del directorio del álbum.');
  }
  await fs.access(sourcePath, fsConstants.R_OK);
  if (!(await fs.lstat(sourcePath)).isFile()) throw new Error('La fuente debe ser un archivo regular, no un enlace.');
  const sourceProbe = await probeAudio(sourcePath);
  validateLosslessSource(sourcePath, sourceProbe.codec);
  cue.album.title ??= sourceTag(sourceProbe.tags, 'ALBUM');
  cue.album.performer ??= sourceTag(sourceProbe.tags, 'ALBUMARTIST', 'ALBUM_ARTIST', 'ARTIST');
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
  if (!coverPath && !sourceProbe.hasArtwork && entries.filter(e => e.isFile() && IMAGE_EXTENSIONS.has(path.extname(e.name).toLowerCase())).length > 1) {
    throw new Error('Hay varias portadas posibles: identifica la elegida como cover.jpg, folder.jpg o front.png.');
  }
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
    `Audio: ${sourceProbe.codec.toUpperCase()} → FLAC, ${sourceProbe.sampleRate} Hz, ${sourceProbe.bitsPerRawSample ?? '?'} bits, ${sourceProbe.channels} canales`,
  );
  console.log(`Portada: ${coverPath ? path.basename(coverPath) : sourceProbe.hasArtwork ? 'incrustada en la fuente' : 'no encontrada'}`);
  if (cue.tracks[0].index01Frames > 0) console.log('Audio previo a INDEX 01: se conserva al principio de la primera pista.');
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

async function applyPlan(inspection, publication) {
  const { existing, plan, directory, sourcePath, sourceProbe, cue, cuePath, coverPath } =
    inspection;
  if (inspection.ignoreUpdate.status === 'directory-ignored') {
    throw new Error(
      '.ndignore está vacío e impediría que Navidrome indexe las pistas nuevas.',
    );
  }
  if (existing.status === 'complete') {
    for (const candidate of existing.matches.values()) await publication.witness(candidate.file);
    await publication.finalize(path.basename(sourcePath));
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

  const stagingDirectory = await fs.mkdtemp(
    path.join(tmpdir(), 'hirmos-cue-split-'),
  );
  const generated = [];
  try {
    await publication.trackStaging(stagingDirectory);
    const initialSourceHash = await sha256(sourcePath);
    const initialCueHash = await sha256(cuePath);
    console.log('Preparando y validando las pistas en almacenamiento local temporal…');
    for (const track of plan) {
      const finalPath = path.join(directory, track.outputFile);
      try {
        await fs.access(finalPath);
        throw new Error(`${track.outputFile} apareció durante el procesamiento.`);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const localPath = path.join(stagingDirectory, track.outputFile);
      const generatedItem = {
        localPath,
        finalPath,
        track,
      };
      generated.push(generatedItem);
      console.log(`Generando ${track.outputFile}…`);
      await createTemporaryTrack({
        sourcePath,
        coverPath,
        temporaryPath: localPath,
        track,
        cue,
        sourceProbe,
      });
      await validateGeneratedTrack(localPath, track, sourceProbe, Boolean(coverPath) || sourceProbe.hasArtwork);
    }

    console.log('Verificando identidad PCM de la imagen y las pistas…');
    const sourcePcmHash = await decodedPcmSha256([sourcePath]);
    const tracksPcmHash = await decodedPcmSha256(
      generated.map((item) => item.localPath),
    );
    if (sourcePcmHash !== tracksPcmHash) {
      throw new Error(
        'Las pistas generadas no contienen el mismo PCM que la imagen original.',
      );
    }
    if (await sha256(sourcePath) !== initialSourceHash || await sha256(cuePath) !== initialCueHash) {
      throw new Error('La fuente o el CUE cambió durante el procesamiento; no se publica.');
    }

    const sourceStat = await fs.stat(sourcePath);
    const manifest = {
      schemaVersion: 2,
      createdAt: new Date().toISOString(),
      source: {
        file: path.basename(sourcePath),
        size: sourceStat.size,
        sha256: initialSourceHash,
      },
      cue: {
        file: path.basename(cuePath),
        sha256: initialCueHash,
      },
      audio: {
        sourceCodec: sourceProbe.codec,
        outputCodec: 'flac',
        sampleRate: sourceProbe.sampleRate,
        bitsPerRawSample: sourceProbe.bitsPerRawSample,
        channels: sourceProbe.channels,
        pcmSha256: sourcePcmHash,
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
    try {
      await fs.access(manifestPath);
      throw new Error('.hirmos-cue-split.json apareció durante el procesamiento.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const localManifest = path.join(stagingDirectory, 'manifest.json');
    await fs.writeFile(localManifest, `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: 'wx',
    });

    console.log('Publicando las pistas verificadas en el directorio del álbum…');
    for (const item of generated) {
      await publication.publish(item.localPath, item.track.outputFile);
    }
    await publication.publish(localManifest, path.basename(manifestPath));
    await publication.finalize(path.basename(sourcePath));
    const ignore = await ensureSourceIgnored(directory, path.basename(sourcePath));
    console.log('');
    console.log(`División terminada y validada: ${generated.length} pistas.`);
    console.log(
      ignore.changed
        ? `.ndignore quedó actualizado con ${ignore.rule}.`
        : `.ndignore ya contenía ${ignore.rule}.`,
    );
  } finally {
    await fs.rm(stagingDirectory, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

function parseArguments(argv) {
  const apply = argv.includes('--apply');
  const recover = argv.includes('--recover');
  const positional = argv.filter((argument) => !argument.startsWith('--'));
  if (argv.some((argument) => argument.startsWith('--') && !['--apply', '--recover'].includes(argument)) || (apply && recover)) {
    throw new Error('Usa --apply o --recover, no ambos.');
  }
  if (positional.length !== 1) {
    throw new Error('Uso: npm run cue:split -- [--apply | --recover] <directorio-del-álbum>');
  }
  return { apply, recover, directory: path.resolve(positional[0]) };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const directory = await fs.realpath(args.directory);
  if (args.recover) {
    console.log('Recuperación:', await Publication.recover(directory, source => ensureSourceIgnored(directory, source)));
    return;
  }
  if (!args.apply) {
    const inspection = await inspectDirectory(directory);
    printInspection(inspection);
    console.log('');
    console.log('Análisis solamente. Usa --apply para crear las pistas.');
    return;
  }
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('Operación interrumpida; recuperando archivos propios.'));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let publication;
  try {
    publication = await Publication.begin(directory, controller.signal);
    await operation.run(controller, async () => {
      const inspection = await inspectDirectory(directory);
      printInspection(inspection);
      await applyPlan(inspection, publication);
    });
    await publication.finish();
  } catch (error) {
    if (publication) {
      try { await publication.rollback(); }
      catch (recoveryError) { console.error(`${recoveryError.message} Ejecuta --recover tras revisar la carpeta.`); }
    }
    throw error;
  } finally {
    await publication?.close();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

const isEntryPoint = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntryPoint) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}
