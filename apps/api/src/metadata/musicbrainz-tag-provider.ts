import type { ArtistTagLookup, ArtistTagProvider, ProviderTag } from './tag-provider.js';

interface MusicBrainzArtist {
  id?: string;
  name?: string;
  score?: number;
  genres?: Array<{ name?: string; count?: number }>;
}

export class MusicBrainzTagProvider implements ArtistTagProvider {
  public readonly name = 'musicbrainz' as const;
  private nextRequestAt = 0;
  private requestQueue: Promise<unknown> = Promise.resolve();

  public constructor(private readonly fetchImplementation: typeof fetch = fetch) {}

  public async find(input: ArtistTagLookup, signal?: AbortSignal): Promise<ProviderTag[]> {
    let artistId = input.musicBrainzId;
    if (!artistId) {
      const search = await this.request<{ artists?: MusicBrainzArtist[] }>(
        `/ws/2/artist/?query=${encodeURIComponent(`artist:"${input.artistName}"`)}&limit=5&fmt=json`,
        signal,
      );
      artistId = exactArtistId(search.artists ?? [], input.artistName);
    }
    if (!artistId) return [];
    const artist = await this.request<MusicBrainzArtist>(
      `/ws/2/artist/${encodeURIComponent(artistId)}?inc=genres&fmt=json`, signal,
    );
    return (artist.genres ?? []).flatMap((genre) => genre.name?.trim()
      ? [{ name: genre.name.trim(), score: Math.max(1, genre.count ?? 1) }]
      : []);
  }

  private async request<T>(path: string, signal?: AbortSignal): Promise<T> {
    const queued = this.requestQueue.then(async () => {
      const waitMs = Math.max(0, this.nextRequestAt - Date.now());
      if (waitMs) await abortableDelay(waitMs, signal);
      if (signal?.aborted) throw signal.reason;
      this.nextRequestAt = Date.now() + 1_100;
      const response = await this.fetchImplementation(new URL(path, 'https://musicbrainz.org'), {
        signal,
        headers: {
          accept: 'application/json',
          'user-agent': 'Hirmos/0.1 (https://github.com/Rigo85/hirmos)',
        },
      });
      if (!response.ok) throw new Error(`MusicBrainz returned HTTP ${response.status}`);
      return await response.json() as T;
    });
    this.requestQueue = queued.catch(() => undefined);
    return queued;
  }
}

function exactArtistId(artists: MusicBrainzArtist[], expected: string): string | null {
  const normalized = expected.trim().toLocaleLowerCase();
  const exact = artists.find((artist) => artist.id
    && artist.name?.trim().toLocaleLowerCase() === normalized
    && (artist.score ?? 100) >= 90);
  return exact?.id ?? null;
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener('abort', () => {
      clearTimeout(timeout);
      reject(signal.reason);
    }, { once: true });
  });
}
