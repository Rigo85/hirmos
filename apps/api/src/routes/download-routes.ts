import type { FastifyInstance } from 'fastify';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { type MusicSourceService, MusicSourceUnavailableError } from '../music-source/music-source-service.js';
import { musicLookupFailure } from '../music-source/source-http-error.js';
import { decodeTrackReference } from '../music-source/track-reference.js';
import { requireAuthentication } from './auth-routes.js';

// Originals only. Full-file retries restart at byte zero; no unsafe range concatenation.
export async function registerDownloadRoutes(app: FastifyInstance, service?: MusicSourceService): Promise<void> {
  const active = new Map<string, number>();
  let total = 0;
  app.get('/api/music/tracks/:reference/download', async (request, reply) => {
    reply.header('cache-control', 'private, no-store');
    const denied = requireAuthentication(request, reply);
    if (denied) return denied;
    const { reference } = request.params as { reference: string };
    if (!decodeTrackReference(reference)) return reply.code(400).send({ code: 'INVALID_TRACK_REFERENCE' });
    if (request.headers.range || request.headers['if-range']) {
      return reply.code(400).send({ code: 'DOWNLOAD_FULL_FILE_REQUIRED' });
    }
    if (!service) return reply.code(503).send({ code: 'DOWNLOAD_UNAVAILABLE' });
    const user = request.authSession!.response.user.id;
    reply.header('x-hirmos-account-id', user);
    if ((active.get(user) ?? 0) >= 2 || total >= 8) {
      return reply.code(429).header('retry-after', '5').send({ code: 'DOWNLOAD_BUSY' });
    }
    active.set(user, (active.get(user) ?? 0) + 1); total++;
    const controller = new AbortController();
    const started = Date.now();
    let bytes = 0;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const abort = () => controller.abort(new DOMException('Download cancelled', 'AbortError'));
    const close = () => { if (!reply.raw.writableFinished) abort(); };
    request.raw.once('aborted', abort);
    reply.raw.once('close', close);
    const resetIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => controller.abort(new DOMException('Download stopped progressing', 'TimeoutError')), 60000);
      idle.unref();
    };
    const deadline = setTimeout(() => controller.abort(new DOMException('Download budget expired', 'TimeoutError')), 30 * 60000);
    deadline.unref();
    try {
      const media = await service.download(reference, controller.signal);
      controller.signal.throwIfAborted();
      const length = media.contentLength === null ? null : Number(media.contentLength);
      if (media.status !== 200 || (length !== null && (!Number.isSafeInteger(length) || length <= 0))) {
        await media.body.cancel().catch(() => undefined);
        throw new Error('Invalid download response');
      }
      const source = Readable.fromWeb(media.body as unknown as NodeReadableStream<Uint8Array>, { signal: controller.signal });
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.byteLength; resetIdle();
          callback(length !== null && bytes > length ? new Error('Download length mismatch') : null, chunk);
        },
        flush(callback) { callback(bytes === 0 || (length !== null && bytes !== length) ? new Error('Download length mismatch') : null); },
      });
      reply.header('content-type', media.contentType ?? 'application/octet-stream');
      reply.header('content-disposition', 'attachment');
      // Buffer no complete file on the server; do not forward private upstream headers.
      if (length !== null) reply.header('content-length', String(length));
      reply.hijack();
      for (const [name, value] of Object.entries(reply.getHeaders())) if (value !== undefined) reply.raw.setHeader(name, value);
      resetIdle();
      await pipeline(source, meter, reply.raw, { signal: controller.signal });
      request.log.info({ download: { outcome: 'complete', bytes, elapsedMs: Date.now() - started } }, 'Original download completed');
    } catch (error) {
      const failure = error instanceof MusicSourceUnavailableError
        ? { reference, code: 'service_unavailable' as const, retryAfterMs: undefined }
        : musicLookupFailure(reference, controller.signal.aborted ? controller.signal.reason : error);
      request.log.warn({ download: { outcome: controller.signal.aborted ? 'aborted' : 'failed',
        code: failure.code, bytes, elapsedMs: Date.now() - started } }, 'Original download stopped');
      if (reply.sent || reply.raw.destroyed) {
        reply.raw.destroy();
      } else {
        if (failure.retryAfterMs !== undefined) reply.header('retry-after', String(Math.max(1, Math.ceil(failure.retryAfterMs / 1000))));
        reply.code(failure.code === 'not_found' ? 404 : failure.code === 'service_unavailable' ? 503 : 502)
          .send({ code: 'DOWNLOAD_FAILED', reason: failure.code, message: 'No pudimos completar la descarga.' });
      }
    } finally {
      clearTimeout(deadline); clearTimeout(idle); abort();
      request.raw.off('aborted', abort); reply.raw.off('close', close);
      const remaining = (active.get(user) ?? 1) - 1;
      if (remaining) active.set(user, remaining); else active.delete(user);
      total--;
    }
  });
}
