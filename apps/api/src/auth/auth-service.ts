import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import type { SessionResponse } from '@hirmos/contracts';
import type { AuthRepository, PasswordUser } from './auth-repository.js';
import type { SessionRevocationNotifier } from './session-revocation.js';

const SESSION_BYTES = 32;
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;
const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$T0h3eHZHZzRXeWVRSVh0Zw$dwwMTEgWoYFlrXD1sW3Zz8+BYCn82MF9y2mx99xBpD4';

export interface LoginResult {
  token: string;
  session: SessionResponse;
}

export class InvalidCredentialsError extends Error {
  public constructor() {
    super('Invalid credentials');
    this.name = 'InvalidCredentialsError';
  }
}

export class AuthService {
  public constructor(
    private readonly repository: AuthRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly revocations?: SessionRevocationNotifier,
  ) {}

  public async login(
    email: string,
    password: string,
    context: { ipAddress: string | null; userAgent: string | null },
  ): Promise<LoginResult> {
    const user = await this.repository.findPasswordUserByEmail(email.trim());
    const hash = user?.passwordHash ?? DUMMY_PASSWORD_HASH;
    const valid = await this.verifyPassword(hash, password);

    if (!user || user.disabledAt || !valid) {
      throw new InvalidCredentialsError();
    }

    const now = this.now();
    const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS);
    const token = randomBytes(SESSION_BYTES).toString('base64url');
    await this.repository.createSession({
      userId: user.id,
      tokenHash: hashSessionToken(token),
      expiresAt,
      ...context,
    });

    return {
      token,
      session: {
        user: toSessionUser(user),
        expiresAt: expiresAt.toISOString(),
      },
    };
  }

  public async authenticate(token: string | undefined): Promise<{
    id: string;
    response: SessionResponse;
  } | null> {
    if (!token || token.length > 256) return null;
    const record = await this.repository.findSession(hashSessionToken(token));
    if (!record) return null;
    await this.repository.touchSession(record.id, this.now());
    return {
      id: record.id,
      response: {
        user: record.user,
        expiresAt: record.expiresAt.toISOString(),
      },
    };
  }

  public async revoke(sessionId: string): Promise<void> {
    await this.repository.revokeSession(sessionId, this.now());
    this.revocations?.session(sessionId);
  }

  private async verifyPassword(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }
}

export function hashSessionToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

function toSessionUser(user: PasswordUser): SessionResponse['user'] {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
  };
}
