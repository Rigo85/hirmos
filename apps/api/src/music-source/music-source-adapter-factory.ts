import type { MusicSourceAdapter } from './music-source-adapter.js';
import { NavidromeAdapter } from './navidrome-adapter.js';
import type { ThirdPartyTelemetry } from '../integrations/third-party-request.js';

export interface MusicSourceConnection {
  adapterType: 'navidrome';
  baseUrl: URL;
  username: string;
  password: string;
}

export interface MusicSourceAdapterFactory {
  create(connection: MusicSourceConnection): MusicSourceAdapter;
}

export class DefaultMusicSourceAdapterFactory implements MusicSourceAdapterFactory {
  public constructor(private readonly telemetry?: ThirdPartyTelemetry) {}

  public create(connection: MusicSourceConnection): MusicSourceAdapter {
    switch (connection.adapterType) {
      case 'navidrome':
        return new NavidromeAdapter({ ...connection, telemetry: this.telemetry });
    }
  }
}
