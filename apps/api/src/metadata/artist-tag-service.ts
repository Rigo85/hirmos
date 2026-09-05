import type { SourceArtistDetail } from '../music-source/music-source-adapter.js';
import type { ArtistTagProvider, ProviderTag, TagCategory, TagEvidence } from './tag-provider.js';
import { TagRepository } from './tag-repository.js';

export class ArtistTagService {
  public constructor(
    private readonly repository: TagRepository,
    private readonly providers: readonly ArtistTagProvider[],
  ) {}

  public async resolve(sourceId: string, artist: SourceArtistDetail): Promise<Array<{
    name: string; browsable: boolean; reference: string | null;
  }>> {
    const aliases = await this.repository.aliases();
    const local = localEvidence(artist, aliases);
    await this.repository.putArtistEvidence(sourceId, artist.id, 'opensubsonic', local, 24 * 30);

    const external = await Promise.all(this.providers.map(async (provider) => {
      const cached = await this.repository.cachedArtistEvidence(sourceId, artist.id, provider.name);
      if (cached !== undefined) return cached;
      try {
        const signal = AbortSignal.timeout(provider.name === 'musicbrainz' ? 7_000 : 4_000);
        const raw = await provider.find({
          artistName: artist.name,
          musicBrainzId: artist.musicBrainzId,
        }, signal);
        const evidence = providerEvidence(provider.name, raw, artist.name, aliases);
        await this.repository.putArtistEvidence(
          sourceId, artist.id, provider.name, evidence, evidence.length ? 24 * 30 : 12,
        );
        return evidence;
      } catch {
        // External metadata is optional. A short negative cache prevents hammering a failed service.
        await this.repository.putArtistEvidence(sourceId, artist.id, provider.name, [], 1)
          .catch(() => undefined);
        return [];
      }
    }));
    const resolved = resolveGenres([...local, ...external.flat()]);
    await this.repository.saveResolvedArtistTags(sourceId, artist.id, resolved);
    return resolved.map((tag) => {
      const local = tag.evidence.find((item) => item.provider === 'opensubsonic');
      return { name: tag.name, browsable: Boolean(local), reference: local?.rawName ?? null };
    });
  }
}

function localEvidence(artist: SourceArtistDetail, aliases: Map<string, string>): TagEvidence[] {
  const counts = new Map<string, { raw: string; count: number }>();
  for (const album of artist.albums) {
    for (const raw of album.genres) {
      const normalized = normalizeTag(raw, aliases);
      const current = counts.get(normalized.toLocaleLowerCase());
      counts.set(normalized.toLocaleLowerCase(), { raw, count: (current?.count ?? 0) + 1 });
    }
  }
  return [...counts.values()].map(({ raw, count }) => ({
    provider: 'opensubsonic', rawName: raw, normalizedName: normalizeTag(raw, aliases),
    category: 'genre', score: 100 + Math.min(70, count * 10),
  }));
}

function providerEvidence(
  provider: 'musicbrainz' | 'lastfm',
  tags: ProviderTag[],
  artistName: string,
  aliases: Map<string, string>,
): TagEvidence[] {
  return tags.flatMap((tag) => {
    const category = provider === 'musicbrainz' ? 'genre' : classifyTag(tag.name, artistName);
    if (provider === 'lastfm' && (category !== 'genre' || tag.score < 5)) return [];
    return [{
      provider,
      rawName: tag.name,
      normalizedName: normalizeTag(tag.name, aliases),
      category,
      score: provider === 'musicbrainz'
        ? Math.min(80, 20 + tag.score * 3)
        : Math.min(50, tag.score * 0.5),
    }];
  });
}

export function resolveGenres(evidence: TagEvidence[]) {
  const groups = new Map<string, { name: string; score: number; evidence: TagEvidence[] }>();
  for (const item of evidence) {
    if (item.category !== 'genre') continue;
    const key = item.normalizedName.toLocaleLowerCase();
    const group = groups.get(key) ?? { name: item.normalizedName, score: 0, evidence: [] };
    group.score += item.score;
    group.evidence.push(item);
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .slice(0, 5)
    .map((tag) => ({ ...tag, slug: tagSlug(tag.name) }));
}

export function normalizeTag(raw: string, aliases = new Map<string, string>()): string {
  const compact = raw.normalize('NFKC').trim().replace(/\s+/g, ' ');
  const key = compact.toLocaleLowerCase();
  const alias = aliases.get(key);
  if (alias) return alias;
  return compact.split(' ').map((word) => word
    ? word[0]!.toLocaleUpperCase() + word.slice(1).toLocaleLowerCase()
    : word).join(' ');
}

export function classifyTag(raw: string, artistName = ''): TagCategory {
  const value = raw.normalize('NFKC').trim().toLocaleLowerCase();
  if (!value || value === artistName.trim().toLocaleLowerCase()) return 'unknown';
  if (/^(?:19|20)\d0s$|^\d{2}s$/.test(value)) return 'era';
  if (/^(american|british|canadian|german|french|spanish|swedish|norwegian|australian|japanese|latin)$/.test(value)) return 'origin';
  if (/^(seen live|favorites?|favourites?|supergroup|male vocalists?|female vocalists?|instrumental)$/.test(value)) return 'descriptor';
  if (/(rock|metal|pop|jazz|blues|punk|folk|country|electronic|ambient|classical|soul|funk|reggae|rap|hip hop|grunge|gothic|industrial|alternative|indie|emo|ska|world|latin|soundtrack|new wave|techno|house|trance|disco|hardcore|metalcore|post-grunge)/.test(value)) return 'genre';
  return 'unknown';
}

function tagSlug(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
