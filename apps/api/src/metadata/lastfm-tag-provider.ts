import type { ArtistTagLookup, ArtistTagProvider, ProviderTag } from './tag-provider.js';
import { fetchWithRetry, type ThirdPartyTelemetry } from '../integrations/third-party-request.js';

export class LastFmTagProvider implements ArtistTagProvider {
  public readonly name = 'lastfm' as const;

  public constructor(
    private readonly apiKey: string,
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly telemetry?: ThirdPartyTelemetry,
  ) {}

  public async find(input: ArtistTagLookup, signal?: AbortSignal): Promise<ProviderTag[]> {
    const url = new URL('/2.0/', 'https://ws.audioscrobbler.com');
    url.search = new URLSearchParams({
      method: 'artist.getTopTags', artist: input.artistName, api_key: this.apiKey,
      format: 'json', autocorrect: '1',
    }).toString();
    const response = await fetchWithRetry(this.fetchImplementation, url, {
      headers: { accept: 'application/json' },
    }, {
      provider: this.name,
      operation: 'artist-top-tags',
      signal,
      attemptTimeoutMs: 1_500,
      totalTimeoutMs: 3_500,
      maxAttempts: 2,
      telemetry: this.telemetry,
    });
    if (!response.ok) throw new Error(`Last.fm returned HTTP ${response.status}`);
    const document = await response.json() as {
      toptags?: { tag?: Array<{ name?: string; count?: number | string }> };
    };
    return (document.toptags?.tag ?? []).flatMap((tag) => {
      const name = tag.name?.trim();
      const score = Number(tag.count ?? 0);
      return name && Number.isFinite(score) && score > 0 ? [{ name, score }] : [];
    });
  }
}
