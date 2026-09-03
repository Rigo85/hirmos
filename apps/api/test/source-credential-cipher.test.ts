import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SourceCredentialCipher } from '../src/music-source/source-credential-cipher.js';

describe('SourceCredentialCipher', () => {
  it('encrypts and authenticates source credentials', () => {
    const cipher = new SourceCredentialCipher(randomBytes(32).toString('base64url'));
    const encrypted = cipher.encrypt({ username: 'service', password: 'very-secret' });
    expect(encrypted.ciphertext.toString('utf8')).not.toContain('very-secret');
    expect(cipher.decrypt(encrypted.ciphertext, encrypted.keyVersion)).toEqual({
      username: 'service', password: 'very-secret',
    });
  });
});
