import { describe, expect, it } from 'vitest';
import { isRetryableMailError, mailRetryDelaySeconds } from '../src/mail/outbox-worker.js';

describe('mail retry policy', () => {
  it('retries temporary SMTP and network failures only', () => {
    expect(isRetryableMailError({ responseCode: 421 })).toBe(true);
    expect(isRetryableMailError({ responseCode: 550 })).toBe(false);
    expect(isRetryableMailError({ code: 'ETIMEDOUT' })).toBe(true);
    expect(isRetryableMailError({ code: 'EAUTH' })).toBe(false);
    expect(isRetryableMailError(new Error('unknown'))).toBe(false);
  });

  it('uses bounded exponential backoff with jitter', () => {
    expect(mailRetryDelaySeconds(1, () => 0)).toBe(60);
    expect(mailRetryDelaySeconds(2, () => 1)).toBe(150);
    expect(mailRetryDelaySeconds(20, () => 1)).toBe(3_600);
  });
});
