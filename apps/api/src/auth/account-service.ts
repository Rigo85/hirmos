import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import type { SessionUser, UserRole } from '@hirmos/contracts';
import type { AccountRepository } from './account-repository.js';
import type { OutboxCipher } from '../mail/outbox-cipher.js';
import type { SessionRevocationNotifier } from './session-revocation.js';

const TOKEN_BYTES = 32;
const INVITATION_TTL_MS = 48 * 60 * 60 * 1_000;
const RECOVERY_TTL_MS = 60 * 60 * 1_000;

export class InvalidOrExpiredTokenError extends Error {
  public constructor() {
    super('Invalid or expired token');
    this.name = 'InvalidOrExpiredTokenError';
  }
}

export class AccountService {
  public constructor(
    private readonly repository: AccountRepository,
    private readonly cipher: OutboxCipher,
    private readonly publicOrigin: string,
    private readonly now: () => Date = () => new Date(),
    private readonly revocations?: SessionRevocationNotifier,
  ) {}

  public async invite(email: string, role: UserRole, createdBy: string): Promise<boolean> {
    const normalizedEmail = email.trim().toLowerCase();
    const token = newToken();
    const now = this.now();
    const encrypted = this.cipher.encrypt({
      display: 'Invitación a Hirmos',
      actionUrl: `${this.publicOrigin}/aceptar-invitacion?token=${encodeURIComponent(token)}&ngsw-bypass=true`,
    });
    return this.repository.createInvitation({
      email: normalizedEmail,
      role,
      createdBy,
      tokenHash: hashOneTimeToken(token),
      expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
      mail: encrypted,
    });
  }

  public async acceptInvitation(
    token: string,
    displayName: string,
    password: string,
  ): Promise<SessionUser> {
    const tokenHash = hashOneTimeToken(token);
    const now = this.now();
    if (!await this.repository.invitationUsable(tokenHash, now)) {
      throw new InvalidOrExpiredTokenError();
    }
    const passwordHash = await hashPassword(password);
    const user = await this.repository.acceptInvitation({
      tokenHash,
      displayName: displayName.trim(),
      passwordHash,
      now,
    });
    if (!user) throw new InvalidOrExpiredTokenError();
    return user;
  }

  public async requestRecovery(email: string): Promise<void> {
    const normalizedEmail = email.trim().toLowerCase();
    const token = newToken();
    const now = this.now();
    const encrypted = this.cipher.encrypt({
      display: 'Recuperar acceso a Hirmos',
      actionUrl: `${this.publicOrigin}/recuperar?token=${encodeURIComponent(token)}&ngsw-bypass=true`,
    });
    await this.repository.createRecovery({
      email: normalizedEmail,
      tokenHash: hashOneTimeToken(token),
      expiresAt: new Date(now.getTime() + RECOVERY_TTL_MS),
      mail: encrypted,
      now,
    });
  }

  public async completeRecovery(token: string, password: string): Promise<void> {
    const tokenHash = hashOneTimeToken(token);
    const now = this.now();
    if (!await this.repository.recoveryUsable(tokenHash, now)) {
      throw new InvalidOrExpiredTokenError();
    }
    const userId = await this.repository.completeRecovery({
      tokenHash,
      passwordHash: await hashPassword(password),
      now,
    });
    if (!userId) throw new InvalidOrExpiredTokenError();
    this.revocations?.user(userId);
  }
}

export function hashOneTimeToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });
}
