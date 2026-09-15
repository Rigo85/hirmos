import type { MusicSourceAdapter } from './music-source-adapter.js';
import { NavidromeAdapter } from './navidrome-adapter.js';
import type { ThirdPartyTelemetry } from '../integrations/third-party-request.js';
import type { SourceCapability } from '@hirmos/contracts';

export interface MusicSourceConnection {
  adapterType: 'navidrome';
  baseUrl: URL;
  username: string;
  password: string;
  capabilities?: SourceCapability[];
}

export interface MusicSourceAdapterFactory {
  create(connection: MusicSourceConnection): MusicSourceAdapter;
}

export class DefaultMusicSourceAdapterFactory implements MusicSourceAdapterFactory {
  public constructor(private readonly telemetry?: ThirdPartyTelemetry) {}

  public create(connection: MusicSourceConnection): MusicSourceAdapter {
    switch (connection.adapterType) {
      case 'navidrome':
        return new NavidromeAdapter({
          ...connection,
          supportsTopSongsByArtistId: connection.capabilities?.includes('topSongsByArtistId'),
          telemetry: this.telemetry,
        });
    }
  }
}
