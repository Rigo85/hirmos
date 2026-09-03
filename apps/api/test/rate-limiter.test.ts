import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/auth/rate-limiter.js';

describe('RateLimiter', () => {
  it('limits a hashed bucket and permits it after the window resets', () => {
    let now = 1_000;
    const limiter = new RateLimiter(() => now);
    expect(limiter.take('login', 'listener@example.com', 2, 60_000).allowed).toBe(true);
    expect(limiter.take('login', 'listener@example.com', 2, 60_000).allowed).toBe(true);
    const blocked = limiter.take('login', 'listener@example.com', 2, 60_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(60);
    now += 60_000;
    expect(limiter.take('login', 'listener@example.com', 2, 60_000).allowed).toBe(true);
  });
});
