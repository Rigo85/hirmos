import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AesGcmOutboxCipher } from '../src/mail/outbox-cipher.js';

describe('AesGcmOutboxCipher', () => {
  it('round-trips authenticated template data', () => {
    const cipher = new AesGcmOutboxCipher(randomBytes(32).toString('base64url'));
    const encrypted = cipher.encrypt({
      display: 'Invitación',
      actionUrl: 'https://hirmos.example/aceptar?token=secret',
    });
    expect(encrypted.ciphertext.toString('utf8')).not.toContain('secret');
    expect(cipher.decrypt(encrypted.ciphertext, encrypted.keyVersion)).toEqual({
      display: 'Invitación',
      actionUrl: 'https://hirmos.example/aceptar?token=secret',
    });
  });

  it('rejects modified ciphertext', () => {
    const cipher = new AesGcmOutboxCipher(randomBytes(32).toString('base64url'));
    const encrypted = cipher.encrypt({ display: 'x', actionUrl: 'https://example.test' });
    encrypted.ciphertext[encrypted.ciphertext.length - 1]! ^= 1;
    expect(() => cipher.decrypt(encrypted.ciphertext, encrypted.keyVersion)).toThrow();
  });
});
