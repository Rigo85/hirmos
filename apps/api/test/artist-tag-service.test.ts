import { describe, expect, it, vi } from 'vitest';
import { ArtistTagService, classifyTag, normalizeTag, resolveGenres } from '../src/metadata/artist-tag-service.js';
import type { TagRepository } from '../src/metadata/tag-repository.js';
import type { ArtistTagProvider } from '../src/metadata/tag-provider.js';
import type { SourceArtistDetail } from '../src/music-source/music-source-adapter.js';

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

  it('uses stale evidence and does not cache a provider exception as empty evidence', async () => {
    const putArtistEvidence = vi.fn(async () => undefined);
    const repository = {
      aliases: vi.fn(async () => new Map()),
      cachedArtistEvidence: vi.fn(async () => undefined),
      staleArtistEvidence: vi.fn(async () => [evidence('lastfm', 'Hard Rock', 35)]),
      putArtistEvidence,
      saveResolvedArtistTags: vi.fn(async () => undefined),
    } as unknown as TagRepository;
    const provider = {
      name: 'lastfm',
      find: vi.fn(async () => { throw new TypeError('temporary network failure'); }),
    } as ArtistTagProvider;
    const artist: SourceArtistDetail = {
      id: 'artist-a', name: 'Artist', coverArtId: null, albumCount: 0,
      favorite: false, musicBrainzId: null, albums: [], biography: null,
      externalUrl: null, similarArtists: [], topTracks: [],
    };

    const result = await new ArtistTagService(repository, [provider]).resolve('source-a', artist);

    expect(result).toEqual([{ name: 'Hard Rock', browsable: false, reference: null }]);
    expect(repository.staleArtistEvidence).toHaveBeenCalledWith('source-a', 'artist-a', 'lastfm');
    expect(putArtistEvidence).toHaveBeenCalledTimes(1);
    expect(putArtistEvidence).toHaveBeenCalledWith('source-a', 'artist-a', 'opensubsonic', [], 720);
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
