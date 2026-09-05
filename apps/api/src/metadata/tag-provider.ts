export type TagCategory = 'genre' | 'era' | 'origin' | 'descriptor' | 'unknown';

export interface ProviderTag {
  name: string;
  score: number;
}

export interface ArtistTagLookup {
  artistName: string;
  musicBrainzId: string | null;
}

export interface ArtistTagProvider {
  readonly name: 'musicbrainz' | 'lastfm';
  find(input: ArtistTagLookup, signal?: AbortSignal): Promise<ProviderTag[]>;
}

export interface TagEvidence {
  provider: 'opensubsonic' | 'musicbrainz' | 'lastfm';
  rawName: string;
  normalizedName: string;
  category: TagCategory;
  score: number;
}
