import { expect, it, vi } from 'vitest';
import { MusicSourceService } from '../src/music-source/music-source-service.js';
import type { MusicSourceRepository } from '../src/music-source/music-source-repository.js';
import type { MusicSourceAdapterFactory } from '../src/music-source/music-source-adapter-factory.js';
import type { SourceCredentialCipher } from '../src/music-source/source-credential-cipher.js';
import { encodeTrackReference } from '../src/music-source/track-reference.js';

it('resolves downloads only against the active source without a playback or catalog mutation', async () => {
  const sourceId = '11111111-1111-4111-8111-111111111111';
  const getDownload = vi.fn().mockResolvedValue('synthetic-media');
  const create = vi.fn(() => ({getDownload}));
  const service = new MusicSourceService(
    {current:async () => ({id:sourceId,baseUrl:'https://music.example',adapterType:'navidrome',enabled:true,
      capabilities:[],credentialCiphertext:Buffer.from('synthetic'),encryptionKeyVersion:1})} as unknown as MusicSourceRepository,
    {decrypt:()=>({username:'synthetic',password:'synthetic'})} as unknown as SourceCredentialCipher,
    {create} as unknown as MusicSourceAdapterFactory,
  );
  await expect(service.download(encodeTrackReference('other-source','song'))).rejects.toThrow('Unknown track reference');
  expect(create).not.toHaveBeenCalled();
  const signal = new AbortController().signal;
  await expect(service.download(encodeTrackReference(sourceId,'song'),signal)).resolves.toBe('synthetic-media');
  expect(getDownload).toHaveBeenCalledWith('song',signal);
});
