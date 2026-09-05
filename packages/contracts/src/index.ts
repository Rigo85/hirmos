import { z } from 'zod';

export const userRoleSchema = z.enum(['user', 'admin']);
export type UserRole = z.infer<typeof userRoleSchema>;

export const sessionUserSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  displayName: z.string().min(1).max(100),
  role: userRoleSchema,
});
export type SessionUser = z.infer<typeof sessionUserSchema>;

export const loginRequestSchema = z.object({
  email: z.email().max(320),
  password: z.string().min(1).max(1024),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const passwordSchema = z
  .string()
  .min(12, 'La contraseña debe tener al menos 12 caracteres.')
  .max(1024);

export const createInvitationRequestSchema = z.object({
  email: z.email().max(320),
  role: userRoleSchema.default('user'),
});
export type CreateInvitationRequest = z.infer<typeof createInvitationRequestSchema>;

export const acceptInvitationRequestSchema = z.object({
  token: z.string().min(32).max(256),
  displayName: z.string().trim().min(1).max(100),
  password: passwordSchema,
});
export type AcceptInvitationRequest = z.infer<typeof acceptInvitationRequestSchema>;

export const recoveryRequestSchema = z.object({
  email: z.email().max(320),
});
export type RecoveryRequest = z.infer<typeof recoveryRequestSchema>;

export const completeRecoveryRequestSchema = z.object({
  token: z.string().min(32).max(256),
  password: passwordSchema,
});
export type CompleteRecoveryRequest = z.infer<typeof completeRecoveryRequestSchema>;

export const sessionResponseSchema = z.object({
  user: sessionUserSchema,
  expiresAt: z.iso.datetime(),
});
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

export const apiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  requestId: z.string().optional(),
  details: z.unknown().optional(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export const sourceCapabilitySchema = z.enum([
  'browse',
  'search',
  'coverArt',
  'lyrics',
  'structuredLyrics',
  'stream',
  'transcode',
  'playlists',
  'scrobble',
]);
export type SourceCapability = z.infer<typeof sourceCapabilitySchema>;

export const musicSourceSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  enabled: z.boolean(),
  healthy: z.boolean(),
  capabilities: z.array(sourceCapabilitySchema),
  lastCheckedAt: z.iso.datetime().nullable(),
  lastSyncedAt: z.iso.datetime().nullable(),
});
export type MusicSourceSummary = z.infer<typeof musicSourceSummarySchema>;

export const configureMusicSourceRequestSchema = z.object({
  name: z.string().trim().min(1).max(100),
  baseUrl: z.url().refine((value) => ['http:', 'https:'].includes(new URL(value).protocol)),
  username: z.string().min(1).max(320),
  password: z.string().min(1).max(1024),
});
export type ConfigureMusicSourceRequest = z.infer<typeof configureMusicSourceRequestSchema>;

export const adminMusicSourceSchema = musicSourceSummarySchema.extend({
  baseUrl: z.url(),
  adapterType: z.literal('navidrome'),
  serverVersion: z.string().nullable(),
});
export type AdminMusicSource = z.infer<typeof adminMusicSourceSchema>;

export const trackSchema = z.object({
  id: z.string(),
  title: z.string(),
  artist: z.string(),
  artistId: z.string().nullable(),
  album: z.string(),
  albumId: z.string().nullable(),
  durationMs: z.number().int().nonnegative(),
  coverUrl: z.string().nullable(),
  year: z.number().int().nullable(),
  favorite: z.boolean(),
});
export type Track = z.infer<typeof trackSchema>;

export const artistSchema = z.object({
  id: z.string(),
  name: z.string(),
  coverUrl: z.string().nullable(),
  albumCount: z.number().int().nonnegative(),
  favorite: z.boolean(),
});
export type Artist = z.infer<typeof artistSchema>;

export const albumSchema = z.object({
  id: z.string(),
  name: z.string(),
  artist: z.string(),
  artistId: z.string().nullable(),
  coverUrl: z.string().nullable(),
  songCount: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  year: z.number().int().nullable(),
  genre: z.string().nullable(),
  favorite: z.boolean(),
  playCount: z.number().int().nonnegative().nullable(),
  lastPlayedAt: z.iso.datetime().nullable(),
});
export type Album = z.infer<typeof albumSchema>;

export const genreSchema = z.object({
  name: z.string(),
  albumCount: z.number().int().nonnegative(),
  songCount: z.number().int().nonnegative(),
});
export type Genre = z.infer<typeof genreSchema>;

export const albumDetailSchema = albumSchema.extend({ tracks: z.array(trackSchema) });
export type AlbumDetail = z.infer<typeof albumDetailSchema>;

export const artistDetailSchema = artistSchema.extend({
  albums: z.array(albumSchema),
  biography: z.string().nullable(),
  externalUrl: z.url().nullable(),
  similarArtists: z.array(artistSchema),
  topTracks: z.array(trackSchema),
});
export type ArtistDetail = z.infer<typeof artistDetailSchema>;

export const searchResponseSchema = z.object({
  artists: z.array(artistSchema).default([]),
  albums: z.array(albumSchema).default([]),
  tracks: z.array(trackSchema),
  nextCursor: z.string().nullable(),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;

export const habitPeriodSchema = z.enum(['7d', '30d', '12m', 'all']);
export type HabitPeriod = z.infer<typeof habitPeriodSchema>;
export const habitKindSchema = z.enum(['artists', 'albums', 'tracks']);
export type HabitKind = z.infer<typeof habitKindSchema>;

const habitMetricsSchema = z.object({
  listenedMs: z.number().int().nonnegative(),
  playStarts: z.number().int().nonnegative(),
  qualifiedPlays: z.number().int().nonnegative(),
  importedPlays: z.number().int().nonnegative(),
  completions: z.number().int().nonnegative(),
  skips: z.number().int().nonnegative(),
  trackCount: z.number().int().nonnegative(),
  lastPlayedAt: z.iso.datetime().nullable(),
  estimated: z.boolean(),
});

export const habitArtistSchema = artistSchema.extend(habitMetricsSchema.shape);
export type HabitArtist = z.infer<typeof habitArtistSchema>;
export const habitAlbumSchema = albumSchema.extend(habitMetricsSchema.shape);
export type HabitAlbum = z.infer<typeof habitAlbumSchema>;
export const habitTrackSchema = trackSchema.extend(habitMetricsSchema.shape);
export type HabitTrack = z.infer<typeof habitTrackSchema>;

export const habitsResponseSchema = z.object({
  kind: habitKindSchema,
  period: habitPeriodSchema,
  dataSince: z.iso.datetime().nullable(),
  artists: z.array(habitArtistSchema),
  albums: z.array(habitAlbumSchema),
  tracks: z.array(habitTrackSchema),
  nextCursor: z.string().nullable(),
});
export type HabitsResponse = z.infer<typeof habitsResponseSchema>;

export const libraryHomeResponseSchema = z.object({
  recentlyPlayed: z.array(trackSchema),
  topArtists: z.array(habitArtistSchema),
  habitsSince: z.iso.datetime().nullable(),
  recentlyAdded: z.array(albumSchema),
  rediscover: z.array(albumSchema),
});
export type LibraryHomeResponse = z.infer<typeof libraryHomeResponseSchema>;

export const albumListResponseSchema = z.object({
  albums: z.array(albumSchema),
  nextCursor: z.string().nullable(),
});
export type AlbumListResponse = z.infer<typeof albumListResponseSchema>;

export const artistListResponseSchema = z.object({
  artists: z.array(artistSchema),
  nextCursor: z.string().nullable(),
});
export type ArtistListResponse = z.infer<typeof artistListResponseSchema>;

export const trackListResponseSchema = z.object({
  tracks: z.array(trackSchema),
  nextCursor: z.string().nullable(),
});
export type TrackListResponse = z.infer<typeof trackListResponseSchema>;

export const genreListResponseSchema = z.object({ genres: z.array(genreSchema) });
export type GenreListResponse = z.infer<typeof genreListResponseSchema>;

export const lyricWordSchema = z.object({
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative().nullable(),
  text: z.string(),
});
export const lyricLineSchema = z.object({
  startMs: z.number().int().nonnegative().nullable(),
  endMs: z.number().int().nonnegative().nullable().optional(),
  text: z.string(),
  words: z.array(lyricWordSchema).optional(),
});
export const lyricsDocumentSchema = z.object({
  displayArtist: z.string().nullable(),
  displayTitle: z.string().nullable(),
  language: z.string().nullable(),
  synced: z.boolean(),
  lines: z.array(lyricLineSchema),
});
export const lyricsResponseSchema = z.object({
  lyrics: z.array(lyricsDocumentSchema),
  adjustmentMs: z.number().int().min(-30_000).max(30_000),
});
export type LyricsResponse = z.infer<typeof lyricsResponseSchema>;
export const lyricsAdjustmentRequestSchema = z.object({
  adjustmentMs: z.number().int().min(-30_000).max(30_000),
});
export type LyricsAdjustmentRequest = z.infer<typeof lyricsAdjustmentRequestSchema>;

export const playbackStatusSchema = z.enum(['paused', 'playing', 'stopped']);
export const playbackQueueItemSchema = z.object({
  id: z.uuid(),
  trackRef: z.string(),
  ordinal: z.number().int(),
  origin: z.string(),
});
export type PlaybackQueueItem = z.infer<typeof playbackQueueItemSchema>;
export const playbackSnapshotSchema = z.object({
  sessionId: z.uuid(),
  revision: z.number().int().nonnegative(),
  status: playbackStatusSchema,
  currentQueueItemId: z.uuid().nullable(),
  currentTrackRef: z.string().nullable(),
  positionMs: z.number().int().nonnegative(),
  positionObservedAt: z.iso.datetime(),
  activeDeviceId: z.uuid().nullable(),
  leaseEpoch: z.number().int().nonnegative(),
  leaseExpiresAt: z.iso.datetime().nullable(),
  queue: z.array(playbackQueueItemSchema),
});
export type PlaybackSnapshot = z.infer<typeof playbackSnapshotSchema>;

export const playbackCommandStatusSchema = z.enum(['accepted', 'duplicate', 'conflict']);
export type PlaybackCommandResult = {
  status: z.infer<typeof playbackCommandStatusSchema>;
  snapshot: PlaybackSnapshot;
};
export type PlaybackCommandAck = (result: PlaybackCommandResult) => void;

export interface ServerToClientEvents {
  'playback:snapshot': (snapshot: PlaybackSnapshot) => void;
  'playback:error': (error: ApiError) => void;
}

export interface ClientToServerEvents {
  'playback:sync': (command: { lastRevision: number | null }) => void;
  'playback:claim': (
    command: { commandId: string; expectedRevision: number },
    ack?: PlaybackCommandAck,
  ) => void;
  'playback:select': (command: {
    commandId: string;
    expectedRevision: number;
    trackRef: string;
  }, ack?: PlaybackCommandAck) => void;
  'playback:select-context': (command: {
    commandId: string;
    expectedRevision: number;
    trackRefs: string[];
    selectedIndex: number;
    contextType: 'album' | 'artist' | 'search' | 'home';
    contextRef: string | null;
  }, ack?: PlaybackCommandAck) => void;
  'playback:update': (command: {
    commandId: string;
    expectedRevision: number;
    leaseEpoch: number;
    status: z.infer<typeof playbackStatusSchema>;
    positionMs: number;
  }, ack?: PlaybackCommandAck) => void;
  'playback:control': (command: {
    commandId: string;
    expectedRevision: number;
    action: 'play' | 'pause' | 'next' | 'previous' | 'seek';
    positionMs?: number;
    reason?: 'user' | 'ended';
  }, ack?: PlaybackCommandAck) => void;
  'playback:queue-remove': (command: {
    commandId: string;
    expectedRevision: number;
    queueItemId: string;
  }, ack?: PlaybackCommandAck) => void;
}
