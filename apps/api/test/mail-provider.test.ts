import { describe, expect, it } from 'vitest';
import { smtpMessageId } from '../src/mail/mail-provider.js';

describe('SMTP delivery identity', () => {
  it('keeps a stable Message-ID across durable attempts', () => {
    const deliveryId = '018f47cf-f31a-7cb4-8f30-0f5e0679ad16';

    expect(smtpMessageId(deliveryId, 'example.test'))
      .toBe('<hirmos-018f47cf-f31a-7cb4-8f30-0f5e0679ad16@example.test>');
    expect(smtpMessageId(deliveryId, 'example.test'))
      .toBe('<hirmos-018f47cf-f31a-7cb4-8f30-0f5e0679ad16@example.test>');
  });
});
