import type { SourceTrack } from '../music-source/music-source-adapter.js';

export interface LrclibResponse {
  id: number;
  trackName: string;
  artistName: string;
  albumName: string;
  duration: number;
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

function key(value: string): string {
  // Do not strip accents, punctuation or version qualifiers: those can identify
  // another artist or recording. Only typographic variants are equivalent.
  return value.normalize('NFC').toLowerCase().replace(/[’‘]/g, "'")
    .replace(/[‐‑–—]/g, '-').replace(/\s+/g, ' ').trim();
}

export function editorialAlbum(value: string): string {
  // A whole trailing label/catalog/country/year group, not arbitrary brackets.
  // Unknown annotations and musical editions (live, remaster, remix...) remain.
  return value.replace(/\s*[([]([^()[\]]+)[)\]]\s*$/, (whole, group: string) => {
    const parts = group.split(',').map((part) => part.trim());
    const catalog = /^[\p{L} .&]+\s+-\s+[A-Z][A-Z0-9 .\/-]*\d[A-Z0-9 .\/-]*$/u;
    const territoryOrYear = /^(?:UK|US|USA|EU|Europe|Japan|Germany|France|Canada|19\d{2}|20\d{2})$/i;
    return parts.length >= 2 && catalog.test(parts[0]!)
      && parts.slice(1).every((part) => territoryOrYear.test(part)) ? '' : whole;
  }).trim();
}

const musicalEdition = /\b(live|acoustic|unplugged|instrumental|remix|radio edit|re-?record(?:ed|ing)?|remaster(?:ed)?|mono|stereo)\b/i;

export function isLrclibResponse(value: unknown): value is LrclibResponse {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<LrclibResponse>;
  return Number.isSafeInteger(row.id) && Number(row.id) > 0
    && typeof row.trackName === 'string' && typeof row.artistName === 'string'
    && typeof row.albumName === 'string' && typeof row.duration === 'number'
    && Number.isFinite(row.duration) && row.duration > 0
    && (row.instrumental === undefined || typeof row.instrumental === 'boolean')
    && (row.plainLyrics == null || typeof row.plainLyrics === 'string')
    && (row.syncedLyrics == null || typeof row.syncedLyrics === 'string');
}

export function mismatch(track: SourceTrack, candidate: LrclibResponse): string | null {
  if (key(track.artist) !== key(candidate.artistName)) return 'artist';
  if (key(track.title) !== key(candidate.trackName)) return 'title_or_version';
  if (!Number.isFinite(track.durationMs) || track.durationMs <= 0
    || Math.abs(track.durationMs / 1_000 - candidate.duration) > 2) return 'duration';
  const album = key(editorialAlbum(track.album));
  const otherAlbum = key(editorialAlbum(candidate.albumName));
  if (album !== otherAlbum && (musicalEdition.test(album) || musicalEdition.test(otherAlbum))) {
    return 'album_version';
  }
  return null;
}

export function sameAlbum(track: SourceTrack, candidate: LrclibResponse): boolean {
  return key(editorialAlbum(track.album)) === key(editorialAlbum(candidate.albumName));
}
