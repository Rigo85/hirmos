import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_VERSION = 1;

export interface OutboxTemplateData {
  display: string;
  actionUrl: string;
}

export interface EncryptedOutboxData {
  ciphertext: Buffer;
  keyVersion: number;
}

export interface OutboxCipher {
  encrypt(data: OutboxTemplateData): EncryptedOutboxData;
  decrypt(ciphertext: Buffer, keyVersion: number): OutboxTemplateData;
}

export class AesGcmOutboxCipher implements OutboxCipher {
  private readonly key: Buffer;

  public constructor(encodedKey: string) {
    this.key = decodeKey(encodedKey);
  }

  public encrypt(data: OutboxTemplateData): EncryptedOutboxData {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    const plaintext = Buffer.from(JSON.stringify(data), 'utf8');
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
      ciphertext: Buffer.concat([nonce, cipher.getAuthTag(), encrypted]),
      keyVersion: KEY_VERSION,
    };
  }

  public decrypt(ciphertext: Buffer, keyVersion: number): OutboxTemplateData {
    if (keyVersion !== KEY_VERSION || ciphertext.length <= NONCE_BYTES + TAG_BYTES) {
      throw new Error('Unsupported or malformed outbox ciphertext');
    }
    const nonce = ciphertext.subarray(0, NONCE_BYTES);
    const tag = ciphertext.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
    const encrypted = ciphertext.subarray(NONCE_BYTES + TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', this.key, nonce);
    decipher.setAuthTag(tag);
    const decoded: unknown = JSON.parse(
      Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8'),
    );
    if (!isTemplateData(decoded)) throw new Error('Invalid outbox template data');
    return decoded;
  }
}

function decodeKey(encoded: string): Buffer {
  const key = Buffer.from(encoded, 'base64url');
  if (key.length !== KEY_BYTES) {
    throw new Error('DATA_ENCRYPTION_KEY must be a base64url-encoded 32-byte key');
  }
  return key;
}

function isTemplateData(value: unknown): value is OutboxTemplateData {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate['display'] === 'string' && typeof candidate['actionUrl'] === 'string';
}
