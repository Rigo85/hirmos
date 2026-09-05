import { SaxesParser, type SaxesTagNS } from 'saxes';
import type { SourceLyrics, SourceTrack } from '../music-source/music-source-adapter.js';
import type { LyricsProvider, PublicLyricsResult } from './lyrics-provider.js';

const AMLL_ORIGIN = 'https://api.amll.dev';
const MAX_TTML_LENGTH = 2_000_000;
const MAX_CANDIDATES = 5;

interface AmllSong {
  id: number;
  musicNames: string[];
  artistNames: string[];
  albumNames: string[];
  lyrics?: string;
}

interface AmllResponse<T> {
  status: number;
  data?: T;
}

interface ParsedTtml {
  language: string | null;
  durationMs: number | null;
  lines: SourceLyrics['lines'];
}

interface PendingLine {
  depth: number;
  startMs: number;
  endMs: number | null;
  looseText: string;
  words: NonNullable<SourceLyrics['lines'][number]['words']>;
}

interface PendingWord {
  depth: number;
  startMs: number;
  endMs: number | null;
  text: string;
}

export class AmllLyricsProvider implements LyricsProvider {
  public readonly name = 'amll-ttml';
  public readonly timeoutMs = 3_000;

  public constructor(private readonly fetchImplementation: typeof fetch = fetch) {}

  public async find(track: SourceTrack, signal?: AbortSignal): Promise<PublicLyricsResult | null> {
    const searchUrl = new URL('/v1/lyrics/search', AMLL_ORIGIN);
    searchUrl.search = new URLSearchParams({
      musicName: track.title,
      artistName: track.artist,
      pageSize: String(MAX_CANDIDATES),
    }).toString();
    const search = await this.getJson<{
      items: AmllSong[];
    }>(searchUrl, signal);
    const candidates = (search?.items ?? [])
      .map((song) => ({ song, score: candidateScore(track, song) }))
      .filter((candidate) => candidate.score >= 6)
      .sort((left, right) => right.score - left.score)
      .slice(0, MAX_CANDIDATES);

    for (const { song } of candidates) {
      const getUrl = new URL('/v1/lyrics/get', AMLL_ORIGIN);
      getUrl.searchParams.set('id', String(song.id));
      const full = await this.getJson<AmllSong>(getUrl, signal);
      if (!full?.lyrics || full.lyrics.length > MAX_TTML_LENGTH) continue;
      const parsed = parseAmllTtml(full.lyrics);
      if (!durationMatches(track.durationMs, parsed.durationMs)) continue;
      if (!parsed.lines.some((line) => line.words?.length)) continue;
      return {
        providerItemId: String(full.id),
        instrumental: false,
        document: {
          displayArtist: track.artist,
          displayTitle: track.title,
          language: parsed.language,
          synced: true,
          lines: parsed.lines,
        },
      };
    }
    return null;
  }

  private async getJson<T>(url: URL, signal?: AbortSignal): Promise<T | null> {
    const response = await this.fetchImplementation(url, {
      signal,
      headers: {
        accept: 'application/json',
        'user-agent': 'Hirmos/0.1 (OpenSubsonic web player)',
      },
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`AMLL returned HTTP ${response.status}`);
    const payload = await response.json() as AmllResponse<T>;
    if (payload.status === 404) return null;
    if (payload.status !== 200 || !payload.data) {
      throw new Error(`AMLL returned status ${payload.status}`);
    }
    return payload.data;
  }
}

export function parseAmllTtml(value: string): ParsedTtml {
  if (value.length > MAX_TTML_LENGTH) throw new Error('AMLL TTML is too large');
  const lines: SourceLyrics['lines'] = [];
  const parser = new SaxesParser({ xmlns: true });
  let depth = 0;
  let language: string | null = null;
  let durationMs: number | null = null;
  let line: PendingLine | null = null;
  let word: PendingWord | null = null;
  let ignoredDepth: number | null = null;

  parser.on('doctype', () => {
    throw new Error('DOCTYPE is not allowed in AMLL TTML');
  });
  parser.on('opentag', (tag) => {
    depth += 1;
    if (tag.local === 'tt') language = attribute(tag, 'lang') || null;
    if (tag.local === 'body') durationMs = parseTtmlTime(attribute(tag, 'dur'));
    if (tag.local === 'p' && !line) {
      const startMs = parseTtmlTime(attribute(tag, 'begin'));
      if (startMs !== null) {
        line = {
          depth,
          startMs,
          endMs: parseTtmlTime(attribute(tag, 'end')),
          looseText: '',
          words: [],
        };
      }
      return;
    }
    if (!line || tag.local !== 'span' || depth !== line.depth + 1) return;
    const role = attribute(tag, 'role');
    if (role) {
      ignoredDepth = depth;
      return;
    }
    const startMs = parseTtmlTime(attribute(tag, 'begin'));
    if (startMs === null) return;
    word = {
      depth,
      startMs,
      endMs: parseTtmlTime(attribute(tag, 'end')),
      text: '',
    };
  });
  parser.on('text', (text) => {
    if (!line || ignoredDepth !== null) return;
    if (word) {
      word.text += text;
    } else if (line.words.length) {
      const previousWord = line.words.at(-1);
      if (previousWord) previousWord.text += text;
    } else {
      line.looseText += text;
    }
  });
  parser.on('cdata', (text) => {
    if (line && ignoredDepth === null) {
      if (word) word.text += text;
      else line.looseText += text;
    }
  });
  parser.on('closetag', (tag) => {
    if (word && depth === word.depth) {
      if (word.text) line?.words.push({
        startMs: word.startMs,
        endMs: word.endMs,
        text: word.text,
      });
      word = null;
    }
    if (ignoredDepth !== null && depth === ignoredDepth) ignoredDepth = null;
    if (line && tag.local === 'p' && depth === line.depth) {
      const text = `${line.looseText}${line.words.map((item) => item.text).join('')}`.trim();
      if (text) {
        lines.push({
          startMs: line.startMs,
          endMs: line.endMs,
          text,
          words: line.words.length ? line.words : undefined,
        });
      }
      line = null;
      word = null;
      ignoredDepth = null;
    }
    depth -= 1;
  });
  parser.write(value).close();
  if (lines.length > 2_000) throw new Error('AMLL TTML contains too many lines');
  return { language, durationMs, lines };
}

export function parseTtmlTime(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?ms$/i.test(trimmed)) return Math.round(Number.parseFloat(trimmed) || 0);
  if (/^\d+(?:\.\d+)?s$/i.test(trimmed)) return Math.round((Number.parseFloat(trimmed) || 0) * 1_000);
  const parts = trimmed.split(':');
  if (!parts.length || parts.some((part) => !/^\d+(?:\.\d+)?$/.test(part))) return null;
  return Math.round(parts.reduce((total, part) => total * 60 + Number(part), 0) * 1_000);
}

function attribute(tag: SaxesTagNS, local: string): string | null {
  return Object.values(tag.attributes).find((item) => item.local === local)?.value ?? null;
}

function candidateScore(track: SourceTrack, song: AmllSong): number {
  const requestedTitle = normalize(track.title);
  const requestedBaseTitle = normalize(stripEdition(track.title));
  const titleScore = song.musicNames.reduce((score, title) => {
    const normalized = normalize(title);
    if (normalized === requestedTitle) return Math.max(score, 5);
    if (normalize(stripEdition(title)) === requestedBaseTitle) return Math.max(score, 4);
    return score;
  }, 0);
  const requestedArtist = normalize(track.artist);
  const artistScore = song.artistNames.reduce((score, artist) => {
    const normalized = normalize(artist);
    if (normalized === requestedArtist) return Math.max(score, 3);
    if (requestedArtist.length >= 4
      && (normalized.includes(requestedArtist) || requestedArtist.includes(normalized))) {
      return Math.max(score, 2);
    }
    return score;
  }, 0);
  const albumScore = song.albumNames.some((album) => normalize(album) === normalize(track.album)) ? 1 : 0;
  return titleScore + artistScore + albumScore;
}

function stripEdition(value: string): string {
  return value.replace(/\s*[\[(][^)\]]*(?:remaster(?:ed)?|live|version|edit|mix)[^)\]]*[)\]]/gi, '');
}

function normalize(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('en')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function durationMatches(trackDurationMs: number, lyricsDurationMs: number | null): boolean {
  if (!lyricsDurationMs || !trackDurationMs) return true;
  const tolerance = Math.max(5_000, Math.round(trackDurationMs * 0.03));
  return Math.abs(trackDurationMs - lyricsDurationMs) <= tolerance;
}
