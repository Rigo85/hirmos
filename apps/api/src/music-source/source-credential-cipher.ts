import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_VERSION = 1;

export interface SourceCredentials {
  username: string;
  password: string;
}

export class SourceCredentialCipher {
  private readonly key: Buffer;

  public constructor(encodedKey: string) {
    this.key = Buffer.from(encodedKey, 'base64url');
    if (this.key.length !== 32) {
      throw new Error('DATA_ENCRYPTION_KEY must be a base64url-encoded 32-byte key');
    }
  }

  public encrypt(credentials: SourceCredentials): { ciphertext: Buffer; keyVersion: number } {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(credentials), 'utf8'),
      cipher.final(),
    ]);
    return {
      ciphertext: Buffer.concat([nonce, cipher.getAuthTag(), encrypted]),
      keyVersion: KEY_VERSION,
    };
  }

  public decrypt(ciphertext: Buffer, keyVersion: number): SourceCredentials {
    if (keyVersion !== KEY_VERSION || ciphertext.length <= NONCE_BYTES + TAG_BYTES) {
      throw new Error('Unsupported or malformed source credentials');
    }
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key,
      ciphertext.subarray(0, NONCE_BYTES),
    );
    decipher.setAuthTag(ciphertext.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES));
    const value: unknown = JSON.parse(Buffer.concat([
      decipher.update(ciphertext.subarray(NONCE_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8'));
    if (!value || typeof value !== 'object') throw new Error('Invalid source credentials');
    const candidate = value as Record<string, unknown>;
    if (typeof candidate['username'] !== 'string' || typeof candidate['password'] !== 'string') {
      throw new Error('Invalid source credentials');
    }
    return { username: candidate['username'], password: candidate['password'] };
  }
}
