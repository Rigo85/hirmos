import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { configureMusicSourceRequestSchema } from '@hirmos/contracts';
import {
  MusicSourceService,
  MusicSourceUnavailableError,
} from '../music-source/music-source-service.js';
import { requireAdmin, requireAuthentication } from './auth-routes.js';

export async function registerMusicSourceRoutes(
  app: FastifyInstance,
  service: MusicSourceService | undefined,
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
      return reply.send(await service.search(term, query.cursor));
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
      return reply.send(await service.discover(20));
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

  app.get('/api/library/albums', async (request, reply) => {
    const denied = requireAuthentication(request, reply);
    if (denied) return denied;
    if (!service) return notConfigured(request, reply);
    const query = request.query as { sort?: string; limit?: string; cursor?: string };
    const sorts = ['random', 'newest', 'frequent', 'recent', 'alphabeticalByName'] as const;
    const sort = sorts.find((value) => value === query.sort) ?? 'alphabeticalByName';
    return libraryResponse(request, reply, () =>
      service.albums(sort, parseLimit(query.limit), query.cursor));
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
      service.tracks(parseLimit(query.limit), query.cursor));
  });

  app.get('/api/library/genres', async (request, reply) => {
    const denied = requireAuthentication(request, reply);
    if (denied) return denied;
    if (!service) return notConfigured(request, reply);
    return libraryResponse(request, reply, () => service.genres());
  });

  app.get('/api/library/albums/:reference', async (request, reply) => {
    const denied = requireAuthentication(request, reply);
    if (denied) return denied;
    if (!service) return notConfigured(request, reply);
    const { reference } = request.params as { reference: string };
    return libraryResponse(request, reply, () => service.album(reference));
  });

  app.get('/api/library/artists/:reference', async (request, reply) => {
    const denied = requireAuthentication(request, reply);
    if (denied) return denied;
    if (!service) return notConfigured(request, reply);
    const { reference } = request.params as { reference: string };
    return libraryResponse(request, reply, () => service.artist(reference));
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
      const range = normalizeRange(request.headers.range);
      const media = await service.stream(
        reference,
        range,
        controller.signal,
      );
      return sendMedia(reply, media, 'private, no-store', controller.signal);
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
      return reply.send(await service.track(reference, AbortSignal.timeout(15_000)));
    } catch (error) {
      return mediaFailure(request, reply, error);
    }
  });

  app.get('/api/music/covers/:reference', async (request, reply) => {
    const denied = requireAuthentication(request, reply);
    if (denied) return denied;
    if (!service) return notConfigured(request, reply);
    const { reference } = request.params as { reference: string };
    try {
      const media = await service.cover(reference, AbortSignal.timeout(15_000));
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
      return reply.send(await service.lyrics(reference, AbortSignal.timeout(15_000)));
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

function parseLimit(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '50', 10);
  return Number.isSafeInteger(parsed) ? Math.min(100, Math.max(1, parsed)) : 50;
}

function sendMedia(
  reply: FastifyReply,
  media: Awaited<ReturnType<MusicSourceService['stream']>>,
  cacheControl: string,
  signal?: AbortSignal,
): FastifyReply {
  reply.code(media.status);
  reply.header('cache-control', cacheControl);
  if (media.contentType) reply.header('content-type', media.contentType);
  if (media.contentLength) reply.header('content-length', media.contentLength);
  if (media.contentRange) reply.header('content-range', media.contentRange);
  if (media.acceptRanges) reply.header('accept-ranges', media.acceptRanges);
  return reply.send(Readable.fromWeb(
    media.body as unknown as NodeReadableStream<Uint8Array>,
    { signal },
  ));
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
