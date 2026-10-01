import { describe,it,expect } from 'vitest';
import { uniqueTracks } from '../src/music-source/unique-tracks.js';
import { playlistCommandSchema } from '@hirmos/contracts';

describe('unique tracks',()=>{
  it('keeps the first occurrence in stable order without changing input',()=>{
    const input=['a','b','a','c','b'];
    expect(uniqueTracks(input,x=>x)).toEqual(['a','b','c']);
    expect(input).toEqual(['a','b','a','c','b']);
  });
  it('identity, not title, determines uniqueness',()=>{
    const input=[{key:'source1:1',title:'Song'},{key:'source2:1',title:'Song'},{key:'source1:2',title:'Song'}];
    expect(uniqueTracks(input,x=>x.key)).toEqual(input);
  });
  it('rejects the old allow option at the API boundary',()=>{
    const command={action:'add',playlistId:'00000000-0000-4000-8000-000000000001',commandId:'00000000-0000-4000-8000-000000000002',expectedRevision:0,trackRefs:['ref']};
    expect(playlistCommandSchema.parse(command)).toMatchObject({duplicates:'skip'});
    expect(playlistCommandSchema.safeParse({...command,duplicates:'allow'}).success).toBe(false);
  });
});
