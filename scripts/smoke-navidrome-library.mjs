import { readFile } from 'node:fs/promises';
import { NavidromeAdapter } from '../apps/api/dist/music-source/navidrome-adapter.js';

const file = process.env.HIRMOS_SOURCE_CREDENTIALS_FILE;
if (!file) throw new Error('HIRMOS_SOURCE_CREDENTIALS_FILE is required');
const values = Object.fromEntries((await readFile(file, 'utf8')).split(/\r?\n/)
  .filter(Boolean).map((line) => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
  }));
const adapter = new NavidromeAdapter({
  baseUrl: new URL(values.URL), username: values.USER, password: values.PASS,
});
const [albums, artists, tracks, genres] = await Promise.all([
  adapter.listAlbums('newest', 10), adapter.listArtists(), adapter.listTracks(10),
  adapter.listGenres(),
]);
if (!albums.length || !artists.length || !tracks.length) {
  throw new Error('Navidrome returned an incomplete library');
}
const album = await adapter.getAlbum(albums[0].id);
const artist = await adapter.getArtist(artists[0].id);
const search = await adapter.search(artists[0].name);
if (!album.tracks.length) throw new Error('First album has no tracks');
process.stdout.write(JSON.stringify({
  status: 'ok', albums: albums.length, artists: artists.length, tracks: tracks.length,
  genres: genres.length, searchArtists: search.artists.length,
  searchAlbums: search.albums.length, searchTracks: search.tracks.length,
  albumTracks: album.tracks.length, artistAlbums: artist.albums.length,
}) + '\n');
