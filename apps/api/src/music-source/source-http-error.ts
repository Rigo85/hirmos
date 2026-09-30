import type { MusicLookupFailure } from '@hirmos/contracts';

export class SourceHttpError extends Error {
  public constructor(public readonly status: number, public readonly retryAfterMs: number | null = null) {
    super(`Music source returned HTTP ${status}`);
  }
}

/** OpenSubsonic errors can use HTTP 200; preserve the protocol code. */
export class SourceProtocolError extends Error {
  public constructor(public readonly code: number | undefined) {
    super('Music source rejected the request');
  }
}

export class MusicLookupError extends Error {
  public constructor(public readonly failure: MusicLookupFailure) {
    super('Music metadata lookup failed');
  }
}

export function musicLookupFailure(reference: string, error: unknown): MusicLookupFailure {
  if (error instanceof SourceHttpError) {
    return { reference, code: [404, 410].includes(error.status) ? 'not_found'
      : [401, 403, 408, 425, 429].includes(error.status) || error.status >= 500 ? 'service_unavailable' : 'unknown',
      ...(error.retryAfterMs === null ? {} : { retryAfterMs: error.retryAfterMs }) };
  }
  if (error instanceof SourceProtocolError) {
    return { reference, code: error.code === 70 ? 'not_found' : 'service_unavailable' };
  }
  return { reference, code: error instanceof Error && error.name === 'TimeoutError' ? 'timeout'
    : error instanceof TypeError ? 'service_unavailable' : 'unknown' };
}
