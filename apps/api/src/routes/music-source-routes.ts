import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Readable, Transform } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import {
  configureMusicSourceRequestSchema,
  favoriteTrackRequestSchema,
  lyricsAdjustmentRequestSchema,
  resolveTracksRequestSchema,
} from '@hirmos/contracts';
import {
  MusicSourceService,
  MusicSourceUnavailableError,
} from '../music-source/music-source-service.js';
import { ImageCachePendingError } from '../cache/image-cache-service.js';
import type { CatalogSyncControl } from '../cache/catalog-sync-coordinator.js';
import type { TopSongsRefreshControl } from '../cache/top-songs-repository.js';
import { requireAdmin, requireAuthentication } from './auth-routes.js';

export async function registerMusicSourceRoutes(
  app: FastifyInstance,
  service: MusicSourceService | undefined,
  catalogSync?: CatalogSyncControl,
  topSongsRefresh?: TopSongsRefreshControl,
): Promise<void> {
  app.get('/api/admin/music-source', async (request, reply) => {
    const denied = requireAdmin(request, reply);
    if (denied) return denied;
    if (!service) return notConfigured(request, reply);
    return reply.send({ source: await service.currentForAdmin() });
  });

  app.put('/api/admin/music-source', async (request, reply) => {
    const denied = requireAdmin(request, reply);
    if (denied) return denied;
    if (!service) return notConfigured(request, reply);
    const parsed = configureMusicSourceRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        code: 'INVALID_REQUEST',
        message: 'Revisa los datos de la fuente.',
        requestId: request.id,
      });
    }
    try {
      return reply.send({ source: await service.configure(parsed.data) });
    } catch {
      return reply.code(502).send({
        code: 'MUSIC_SOURCE_UNREACHABLE',
        message: 'No pudimos validar la fuente con esos datos.',
        requestId: request.id,
      });
    }
  });

  app.post('/api/admin/music-source/probe', async (request, reply) => {
    const denied = requireAdmin(request, reply);
    if (denied) return denied;
    if (!service) return notConfigured(request, reply);
    const parsed = configureMusicSourceRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        code: 'INVALID_REQUEST',
        message: 'Revisa los datos de la fuente.',
        requestId: request.id,
      });
    }
    try {
      const probe = await service.probe(parsed.data);
      return reply.send({
        status: 'ok',
        serverType: probe.serverType,
        serverVersion: probe.serverVersion,
        capabilities: probe.capabilities,
      });
    } catch {
      return reply.code(502).send({
        code: 'MUSIC_SOURCE_UNREACHABLE',
        message: 'No pudimos validar la fuente con esos datos.',
        requestId: request.id,
      });
    }
  });

  app.get('/api/admin/music-source/sync', async (request, reply) => {
    const denied = requireAdmin(request, reply);
    if (denied) return denied;
    if (!service || !catalogSync) return notConfigured(request, reply);
    return reply.send(catalogSync.status());
  });

  app.post('/api/admin/music-source/sync', async (request, reply) => {
    const denied = requireAdmin(request, reply);
    if (denied) return denied;
    if (!service || !catalogSync) return notConfigured(request, reply);
    if (!await service.currentForAdmin()) {
      return reply.code(409).send({
        code: 'MUSIC_SOURCE_NOT_CONFIGURED',
        message: 'Configura una fuente musical antes de sincronizar.',
        requestId: request.id,
      });
    }

    const trigger = catalogSync.trigger();
    if (trigger.started) {
      request.log.info({ catalogSync: { trigger: 'manual' } }, 'Catalog sync requested');
      void trigger.completion.then(({ counts, followUpError }) => {
        request.log.info(
          { catalogSync: { trigger: 'manual', outcome: 'success', ...counts } },
          'Manual catalog sync completed',
        );
        if (followUpError) {
          request.log.warn({ err: followUpError }, 'Catalog follow-up scheduling failed');
        }
      }).catch((error: unknown) => {
        request.log.warn({
          err: error,
          catalogSync: { trigger: 'manual', outcome: 'failure' },
        }, 'Manual catalog sync failed');
      });
    }
    return reply.code(202).send({ started: trigger.started, ...catalogSync.status() });
  });

  app.get('/api/admin/music-source/top-songs', async (request, reply) => {
    const denied = requireAdmin(request, reply);
    if (denied) return denied;
    if (!service || !topSongsRefresh) return notConfigured(request, reply);
    const source = await service.currentForAdmin();
    return reply.send(await topSongsRefresh.stats(source?.id));
  });

  app.post('/api/admin/music-source/top-songs/revalidate', async (request, reply) => {
    const denied = requireAdmin(request, reply);
    if (denied) return denied;
    if (!service || !topSongsRefresh) return notConfigured(request, reply);
    const source = await service.currentForAdmin();
    if (!source) {
      return reply.code(409).send({
        code: 'MUSIC_SOURCE_NOT_CONFIGURED',
        message: 'Configura una fuente musical antes de revalidar metadatos.',
        requestId: request.id,
      });
    }
    const queued = await topSongsRefresh.enqueueAll(source.id);
    request.log.info({ topSongs: { trigger: 'manual', queued } },
      'Global top songs revalidation requested');
    return reply.code(202).send({ queued, ...await topSongsRefresh.stats(source.id) });
  });

  app.get('/api/music/search', async (request, reply) => {
    const denied = requireAuthentication(request, reply);
    if (denied) return denied;
    if (!service) return notConfigured(request, reply);
    const query = request.query as { q?: string; cursor?: string };
    const term = query.q?.trim() ?? '';
    if (term.length < 1 || term.length > 200) {
      return reply.code(400).send({
        code: 'INVALID_SEARCH',
        message: 'Escribe algo para buscar.',
        requestId: request.id,
      });
    }
    try {
      return reply.send(await service.search(
        request.authSession!.response.user.id, term, query.cursor,
      ));
    } catch (error) {
      if (error instanceof MusicSourceUnavailableError) {
        return reply.code(503).send({
          code: 'MUSIC_SOURCE_NOT_CONFIGURED',
          message: 'La biblioteca aún no está disponible.',
          requestId: request.id,
        });
      }
      request.log.warn({ err: error }, 'Music source search failed');
      return reply.code(502).send({
        code: 'MUSIC_SOURCE_FAILED',
        message: 'No pudimos consultar la biblioteca.',
        requestId: request.id,
      });
    }
  });

  app.get('/api/music/discover', async (request, reply) => {
    const denied = requireAuthentication(request, reply);
    if (denied) return denied;
    if (!service) return notConfigured(request, reply);
    try {
      return reply.send(await service.discover(request.authSession!.response.user.id, 20));
    } catch (error) {
      if (error instanceof MusicSourceUnavailableError) {
        return reply.code(503).send({
          code: 'MUSIC_SOURCE_NOT_CONFIGURED',
          message: 'La biblioteca aún no está disponible.',
          requestId: request.id,
        });
      }
      request.log.warn({ err: error }, 'Music source discovery failed');
      return reply.code(502).send({
        code: 'MUSIC_SOURCE_FAILED',
        message: 'No pudimos explorar la biblioteca.',
        requestId: request.id,
      });
    }
  });

  app.get('/api/library/home', async (request, reply) => {
    const denied = requireAuthentication(request, reply);
    if (denied) return denied;
    if (!service) return notConfigured(request, reply);
    return libraryResponse(request, reply, () =>
      service.home(request.authSession!.response.user.id));
  });

  app.get('/api/library/activity/:kind', async (request, reply) => {
    const denied = requireAuthentication(request, reply);
    if (denied) return denied;
    if (!service) return notConfigured(request, reply);
    const { kind } = request.params as { kind: string };
    if (kind !== 'recent' && kind !== 'most-played') {
      return reply.code(404).send({
        code: 'ACTIVITY_VIEW_NOT_FOUND',
        message: 'No encontramos esa vista de actividad.',
        requestId: request.id,
      });
    }
    const query = request.query as { limit?: string; cursor?: string };
    return libraryResponse(request, reply, () => service.activityTracks(
      request.authSession!.response.user.id,
      kind,
      parseLimit(query.limit),
      query.cursor,
    ));
  });

  app.get('/api/library/habits', async (request, reply) => {
    const denied = requireAuthentication(request, reply);
    if (denied) return denied;
    if (!service) return notConfigured(request, reply);
    const query = request.query as {
      kind?: string;
      period?: string;
      limit?: string;
      cursor?: string;
    };
    const kinds = ['artists', 'albums', 'tracks'] as const;
    const periods = ['7d', '30d', '12m', 'all'] as const;
    const kind = kinds.find((value) => value === query.kind) ?? 'artists';
    const period = periods.find((value) => value === query.period) ?? '30d';
    return libraryResponse(request, reply, () => service.habits(
      request.authSession!.response.user.id,
      kind,
      period,
      parseLimit(query.limit),
      query.cursor,
    ));
  });

  app.get('/api/library/albums', async (request, reply) => {
    const denied = requireAuthentication(request, reply);
    if (denied) return denied;
    if (!service) return notConfigured(request, reply);
    const query = request.query as { sort?: string; limit?: string; cursor?: string; year?: string };
    const sorts = ['random', 'newest', 'frequent', 'recent', 'alphabeticalByName'] as const;
    const sort = sorts.find((value) => value === query.sort) ?? 'alphabeticalByName';
    const year = query.year ? Number.parseInt(query.year, 10) : undefined;
    if (year !== undefined && (!Number.isInteger(year) || year < 1 || year > 9999)) {
      return reply.code(400).send({
        code: 'INVALID_YEAR', message: 'El año indicado no es válido.', requestId: request.id,
      });
    }
    return libraryResponse(request, reply, () =>
      service.albums(sort, parseLimit(query.limit), query.cursor, year));
  });

  app.get('/api/library/stats', async (request, reply) => {
    const denied = requireAuthentication(request, reply);
    if (denied) return denied;
    if (!service) return notConfigured(request, reply);
    return libraryResponse(request, reply, () => service.libraryStats());
  });

  app.get('/api/library/artists', async (request, reply) => {
    const denied = requireAuthentication(request, reply);
    if (denied) return denied;
    if (!service) return notConfigured(request, reply);
    const query = request.query as { limit?: string; cursor?: string };
    return libraryResponse(request, reply, () =>
      service.artists(parseLimit(query.limit), query.cursor));
  });

  app.get('/api/library/tracks', async (request, reply) => {
    const denied = requireAuthentication(request, reply);
    if (denied) return denied;
    if (!service) return notConfigured(request, reply);
    const query = request.query as { limit?: string; cursor?: string };
    return libraryResponse(request, reply, () =>
      service.tracks(
        request.authSession!.response.user.id, parseLimit(query.limit), query.cursor,
      ));
  });

  app.get('/api/library/favorites', async (request, reply) => {
    const denied = requireAuthentication(request, reply);
    if (denied) return denied;
    if (!service) return notConfigured(request, reply);
    const query = request.query as { limit?: string; cursor?: string };
    return libraryResponse(request, reply, () => service.favoriteTracks(
      request.authSession!.response.user.id, parseLimit(query.limit, 500), query.cursor,
    ));
  });

  app.put('/api/library/tracks/:reference/favorite', async (request, reply) => {
    const denied = requireAuthentication(request, reply);
    if (denied) return denied;
    if (!service) return notConfigured(request, reply);
    const parsed = favoriteTrackRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        code: 'INVALID_FAVORITE', message: 'El estado de favorito no es válido.',
        requestId: request.id,
      });
    }
    const { reference } = request.params as { reference: string };
    return libraryResponse(request, reply, () => service.setTrackFavorite(
      request.authSession!.response.user.id, reference, parsed.data.favorite,
    ));
  });

  app.get('/api/library/genres', async (request, reply) => {
    const denied = requireAuthentication(request, reply);
    if (denied) return denied;
    if (!service) return notConfigured(request, reply);
    return libraryResponse(request, reply, () => service.genres());
  });

  app.get('/api/library/genres/:name', async (request, reply) => {
    const denied = requireAuthentication(request, reply);
    if (denied) return denied;
    if (!service) return notConfigured(request, reply);
    const { name } = request.params as { name: string };
    const query = request.query as { limit?: string };
    const genre = name.trim();
    if (!genre || genre.length > 150) {
      return reply.code(400).send({
        code: 'INVALID_GENRE', message: 'El género indicado no es válido.', requestId: request.id,
      });
    }
    return libraryResponse(request, reply, () => service.genre(
      request.authSession!.response.user.id, genre, parseLimit(query.limit),
    ));
  });

  app.get('/api/library/albums/:reference', async (request, reply) => {
    const denied = requireAuthentication(request, reply);
    if (denied) return denied;
    if (!service) return notConfigured(request, reply);
    const { reference } = request.params as { reference: string };
    return libraryResponse(request, reply, () => service.album(
      request.authSession!.response.user.id, reference,
    ));
  });

  app.get('/api/library/artists/:reference', async (request, reply) => {
    const denied = requireAuthentication(request, reply);
    if (denied) return denied;
    if (!service) return notConfigured(request, reply);
    const { reference } = request.params as { reference: string };
    return libraryResponse(request, reply, () => service.artist(
      request.authSession!.response.user.id, reference,
    ));
  });

  app.get('/api/library/artists/:reference/genres', async (request, reply) => {
    const denied = requireAuthentication(request, reply);
    if (denied) return denied;
    if (!service) return notConfigured(request, reply);
    const { reference } = request.params as { reference: string };
    return libraryResponse(request, reply, () => service.artistGenreTags(reference));
  });

  app.get('/api/music/tracks/:reference/stream', async (request, reply) => {
    const denied = requireAuthentication(request, reply);
    if (denied) return denied;
    if (!service) return notConfigured(request, reply);
    const { reference } = request.params as { reference: string };
    const controller = new AbortController();
    request.raw.once('aborted', () => controller.abort());
    reply.raw.once('close', () => {
      if (!reply.raw.writableFinished) controller.abort();
    });
    try {
      const startedAt = Date.now();
      const range = normalizeRange(request.headers.range);
      const media = await service.stream(
        reference,
        range,
        controller.signal,
      );
      request.log.info({ audioStream: {
        phase: 'headers',
        upstreamLatencyMs: Date.now() - startedAt,
        status: media.status,
        rangeRequested: Boolean(range),
        contentLength: media.contentLength,
      } }, 'Audio stream headers received');
      return sendMedia(reply, media, 'private, no-store', controller.signal, {
        request,
        startedAt,
        rangeRequested: Boolean(range),
      });
    } catch (error) {
      return mediaFailure(request, reply, error);
    }
  });

  app.get('/api/music/tracks/:reference', async (request, reply) => {
    const denied = requireAuthentication(request, reply);
    if (denied) return denied;
    if (!service) return notConfigured(request, reply);
    const { reference } = request.params as { reference: string };
    try {
      return reply.send(await service.track(
        request.authSession!.response.user.id, reference, AbortSignal.timeout(15_000),
      ));
    } catch (error) {
      return mediaFailure(request, reply, error);
    }
  });

  app.post('/api/music/tracks/resolve', async (request, reply) => {
    const denied = requireAuthentication(request, reply);
    if (denied) return denied;
    if (!service) return notConfigured(request, reply);
    const parsed = resolveTracksRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        code: 'INVALID_TRACK_REFERENCES',
        message: 'La lista de canciones no es válida.',
        requestId: request.id,
      });
    }
    return libraryResponse(request, reply, () => service.tracksByReferences(
      request.authSession!.response.user.id, parsed.data.references,
    ));
  });

  app.get('/api/music/covers/:reference', async (request, reply) => {
    const denied = requireAuthentication(request, reply);
    if (denied) return denied;
    if (!service) return notConfigured(request, reply);
    const { reference } = request.params as { reference: string };
    const { size: requestedSize } = request.query as { size?: string };
    const size = parseCoverSize(requestedSize);
    try {
      const media = await service.cover(reference, size, AbortSignal.timeout(15_000));
      if (media.etag && request.headers['if-none-match'] === media.etag) {
        return reply.code(304).header('etag', media.etag).send();
      }
      return sendMedia(reply, media, 'private, max-age=86400');
    } catch (error) {
      return mediaFailure(request, reply, error);
    }
  });

  app.get('/api/music/tracks/:reference/lyrics', async (request, reply) => {
    const denied = requireAuthentication(request, reply);
    if (denied) return denied;
    if (!service) return notConfigured(request, reply);
    const { reference } = request.params as { reference: string };
    try {
      return reply.send(await service.lyrics(
        reference,
        request.authSession!.response.user.id,
        AbortSignal.timeout(15_000),
      ));
    } catch (error) {
      return mediaFailure(request, reply, error);
    }
  });

  app.put('/api/music/tracks/:reference/lyrics-adjustment', async (request, reply) => {
    const denied = requireAuthentication(request, reply);
    if (denied) return denied;
    if (!service) return notConfigured(request, reply);
    const parsed = lyricsAdjustmentRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        code: 'INVALID_LYRICS_ADJUSTMENT',
        message: 'El ajuste de letra debe estar entre -30 y 30 segundos.',
        requestId: request.id,
      });
    }
    const { reference } = request.params as { reference: string };
    try {
      return reply.send(await service.setLyricsAdjustment(
        reference,
        request.authSession!.response.user.id,
        parsed.data.adjustmentMs,
      ));
    } catch (error) {
      return mediaFailure(request, reply, error);
    }
  });
}

async function libraryResponse(
  request: FastifyRequest,
  reply: FastifyReply,
  operation: () => Promise<unknown>,
): Promise<FastifyReply> {
  try {
    return reply.send(await operation());
  } catch (error) {
    if (error instanceof MusicSourceUnavailableError) {
      return reply.code(503).send({
        code: 'MUSIC_SOURCE_NOT_CONFIGURED',
        message: 'La biblioteca aún no está disponible.',
        requestId: request.id,
      });
    }
    request.log.warn({ err: error }, 'Music library request failed');
    return reply.code(502).send({
      code: 'MUSIC_SOURCE_FAILED',
      message: 'No pudimos consultar la biblioteca.',
      requestId: request.id,
    });
  }
}

function parseLimit(value: string | undefined, maximum = 100): number {
  const parsed = Number.parseInt(value ?? '50', 10);
  return Number.isSafeInteger(parsed) ? Math.min(maximum, Math.max(1, parsed)) : 50;
}

function parseCoverSize(value: string | undefined): number {
  const requested = Number.parseInt(value ?? '320', 10);
  const sizes = [64, 128, 320, 640];
  return sizes.includes(requested) ? requested : 320;
}

function sendMedia(
  reply: FastifyReply,
  media: Awaited<ReturnType<MusicSourceService['stream']>>,
  cacheControl: string,
  signal?: AbortSignal,
  observation?: {
    request: FastifyRequest;
    startedAt: number;
    rangeRequested: boolean;
  },
): FastifyReply {
  reply.code(media.status);
  reply.header('cache-control', cacheControl);
  if (media.contentType) reply.header('content-type', media.contentType);
  if (media.contentLength) reply.header('content-length', media.contentLength);
  if (media.contentRange) reply.header('content-range', media.contentRange);
  if (media.acceptRanges) reply.header('accept-ranges', media.acceptRanges);
  if (media.etag) reply.header('etag', media.etag);
  const source = Readable.fromWeb(
    media.body as unknown as NodeReadableStream<Uint8Array>,
    { signal },
  );
  if (!observation) return reply.send(source);

  let bytesSent = 0;
  let recorded = false;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytesSent += chunk.byteLength;
      callback(null, chunk);
    },
  });
  const record = (outcome: 'complete' | 'client_abort' | 'upstream_error', error?: unknown) => {
    if (recorded) return;
    recorded = true;
    const fields = { audioStream: {
      phase: 'body',
      outcome,
      elapsedMs: Date.now() - observation.startedAt,
      bytesSent,
      status: media.status,
      rangeRequested: observation.rangeRequested,
    } };
    if (outcome === 'upstream_error') {
      observation.request.log.warn({ ...fields, err: error }, 'Audio stream failed after headers');
    } else {
      observation.request.log.info(fields, 'Audio stream closed');
    }
  };
  source.once('error', (error) => {
    record(signal?.aborted ? 'client_abort' : 'upstream_error', error);
    meter.destroy(error);
  });
  reply.raw.once('finish', () => record('complete'));
  reply.raw.once('close', () => {
    if (!reply.raw.writableFinished) record('client_abort');
  });
  return reply.send(source.pipe(meter));
}

function normalizeRange(value: string | undefined): string | undefined {
  if (!value || !/^bytes=\d*-\d*(,\d*-\d*)*$/.test(value) || value.length > 200) return undefined;
  return value;
}

function mediaFailure(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  if (error instanceof ImageCachePendingError) {
    return reply
      .code(503)
      .header('cache-control', 'private, no-store')
      .header('retry-after', String(Math.max(1, Math.ceil(error.retryAfterMs / 1_000))))
      .send({
        code: 'MEDIA_PENDING',
        message: 'La imagen se está preparando. Reintentaremos en breve.',
        requestId: request.id,
      });
  }
  if (error instanceof MusicSourceUnavailableError) {
    return reply.code(404).send({
      code: 'MEDIA_NOT_FOUND',
      message: 'No encontramos ese contenido.',
      requestId: request.id,
    });
  }
  request.log.warn({ err: error }, 'Music source media request failed');
  return reply.code(502).send({
    code: 'MUSIC_SOURCE_FAILED',
    message: 'No pudimos obtener el contenido de la biblioteca.',
    requestId: request.id,
  });
}

function notConfigured(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply.code(503).send({
    code: 'MUSIC_SOURCE_CONFIGURATION_UNAVAILABLE',
    message: 'El cifrado de fuentes aún no está configurado.',
    requestId: request.id,
  });
}
