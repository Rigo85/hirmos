import { describe, expect, it } from 'vitest';
import { classifyTag, normalizeTag, resolveGenres } from '../src/metadata/artist-tag-service.js';

describe('artist tag resolution', () => {
  it('classifies Last.fm social noise separately from genres', () => {
    expect(classifyTag('80s', 'Bon Jovi')).toBe('era');
    expect(classifyTag('American', 'Bon Jovi')).toBe('origin');
    expect(classifyTag('seen live', 'Bon Jovi')).toBe('descriptor');
    expect(classifyTag('Bon Jovi', 'Bon Jovi')).toBe('unknown');
    expect(classifyTag('progressive metal', 'Queensrÿche')).toBe('genre');
  });

  it('normalizes aliases and ranks local evidence before complementary providers', () => {
    const aliases = new Map([['alt. rock', 'Alternative Rock']]);
    expect(normalizeTag(' alt. rock ', aliases)).toBe('Alternative Rock');
    const result = resolveGenres([
      evidence('opensubsonic', 'Rock', 120),
      evidence('musicbrainz', 'Rock', 50),
      evidence('lastfm', 'Rock', 40),
      evidence('musicbrainz', 'Progressive Metal', 62),
      evidence('lastfm', 'American', 50, 'origin'),
    ]);
    expect(result.map((tag) => tag.name)).toEqual(['Rock', 'Progressive Metal']);
    expect(result[0]!.evidence).toHaveLength(3);
  });
});

function evidence(
  provider: 'opensubsonic' | 'musicbrainz' | 'lastfm',
  name: string,
  score: number,
  category: 'genre' | 'origin' = 'genre',
) {
  return { provider, rawName: name, normalizedName: name, category, score };
}
