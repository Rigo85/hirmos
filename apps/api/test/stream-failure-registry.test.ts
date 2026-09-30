import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { StreamFailureRegistry } from '../src/playback/stream-failure-registry.js';
import { SourceHttpError } from '../src/music-source/source-http-error.js';

describe('ephemeral stream diagnostics', () => {
  it('returns the remaining cooldown rather than restarting Retry-After on every lookup', () => {
    vi.useFakeTimers();
    try {
      const registry = new StreamFailureRegistry(), id = randomUUID();
      registry.record('alice', id, new SourceHttpError(503, 60_000));
      vi.advanceTimersByTime(1_000);
      expect(registry.get('alice', id)).toEqual({code:'service_unavailable',retryAfterMs:59_000});
      expect(registry.get('bob', id)).toBeNull();
    } finally { vi.useRealTimers(); }
  });
  it('isolates users and never exposes upstream details', () => {
    const registry = new StreamFailureRegistry(), id = randomUUID();
    registry.record('alice',id,new SourceHttpError(404));
    expect(registry.get('bob',id)).toBeNull();
    expect(registry.get('alice',id)).toEqual({code:'not_found'});
    registry.record('alice',id,new SourceHttpError(429));
    expect(registry.get('alice',id)).toEqual({code:'service_unavailable'});
  });
  it('bounds memory and expires stale hints', () => {
    vi.useFakeTimers();
    try {
      const registry = new StreamFailureRegistry(), first = randomUUID();
      registry.record('a',first,new Error('private URL must not leak'));
      for (let i=0;i<1000;i++) registry.record('a',randomUUID(),new SourceHttpError(500));
      expect(registry.get('a',first)).toBeNull();
      const last = randomUUID();
      registry.record('a',last,new SourceHttpError(503));
      vi.advanceTimersByTime(120_001);
      expect(registry.get('a',last)).toBeNull();
      registry.record('a','invalid',new SourceHttpError(404));
      expect(registry.get('a','invalid')).toBeNull();
    } finally { vi.useRealTimers(); }
  });
});
