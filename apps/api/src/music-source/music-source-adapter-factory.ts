import type { MusicSourceAdapter } from './music-source-adapter.js';
import { NavidromeAdapter } from './navidrome-adapter.js';

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
  public create(connection: MusicSourceConnection): MusicSourceAdapter {
    switch (connection.adapterType) {
      case 'navidrome':
        return new NavidromeAdapter(connection);
    }
  }
}
