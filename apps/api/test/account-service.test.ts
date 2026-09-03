import { describe, expect, it } from 'vitest';
import type { SessionUser } from '@hirmos/contracts';
import type { AccountRepository } from '../src/auth/account-repository.js';
import { AccountService, InvalidOrExpiredTokenError } from '../src/auth/account-service.js';
import type {
  EncryptedOutboxData,
  OutboxCipher,
  OutboxTemplateData,
} from '../src/mail/outbox-cipher.js';

class FakeCipher implements OutboxCipher {
  data: OutboxTemplateData | null = null;
  encrypt(data: OutboxTemplateData): EncryptedOutboxData {
    this.data = data;
    return { ciphertext: Buffer.from('encrypted'), keyVersion: 1 };
  }
  decrypt(): OutboxTemplateData {
    throw new Error('not used');
  }
}

class FakeAccountRepository implements AccountRepository {
  invitationInput: Parameters<AccountRepository['createInvitation']>[0] | null = null;
  recoveryInput: Parameters<AccountRepository['createRecovery']>[0] | null = null;
  acceptedUser: SessionUser | null = null;
  invitationTokenUsable = false;
  recoveryTokenUsable = false;
  recoveryCompletedUserId: string | null = null;

  async createInvitation(input: Parameters<AccountRepository['createInvitation']>[0]) {
    this.invitationInput = input;
    return true;
  }
  async acceptInvitation(): Promise<SessionUser | null> {
    return this.acceptedUser;
  }
  async invitationUsable(): Promise<boolean> {
    return this.invitationTokenUsable;
  }
  async createRecovery(input: Parameters<AccountRepository['createRecovery']>[0]): Promise<void> {
    this.recoveryInput = input;
  }
  async completeRecovery(): Promise<string | null> {
    return this.recoveryCompletedUserId;
  }
  async recoveryUsable(): Promise<boolean> {
    return this.recoveryTokenUsable;
  }
}

describe('AccountService', () => {
  it('queues an invitation without storing its usable token in the repository', async () => {
    const repository = new FakeAccountRepository();
    const cipher = new FakeCipher();
    const service = new AccountService(
      repository,
      cipher,
      'https://hirmos.example',
      () => new Date('2026-09-02T10:00:00Z'),
    );

    await service.invite('USER@Example.com', 'user', '4fd14c9e-c8a1-4fb9-9470-13d9965f001d');

    expect(repository.invitationInput?.email).toBe('user@example.com');
    expect(repository.invitationInput?.tokenHash).toHaveLength(32);
    expect(repository.invitationInput?.expiresAt.toISOString()).toBe('2026-09-04T10:00:00.000Z');
    expect(cipher.data?.actionUrl).toMatch(/^https:\/\/hirmos\.example\/aceptar-invitacion\?token=/);
    const tokenInUrl = new URL(cipher.data!.actionUrl).searchParams.get('token');
    expect(tokenInUrl).toBeTruthy();
    expect(new URL(cipher.data!.actionUrl).searchParams.get('ngsw-bypass')).toBe('true');
    expect(repository.invitationInput?.tokenHash.toString('hex')).not.toContain(tokenInUrl!);
  });

  it('uses a generic error for an invalid invitation token', async () => {
    const service = new AccountService(
      new FakeAccountRepository(),
      new FakeCipher(),
      'https://hirmos.example',
    );
    await expect(
      service.acceptInvitation('x'.repeat(43), 'Oyente', 'una contraseña bastante larga'),
    ).rejects.toBeInstanceOf(InvalidOrExpiredTokenError);
  });

  it('queues recovery with a one-hour expiry and completes only a valid token', async () => {
    const repository = new FakeAccountRepository();
    const cipher = new FakeCipher();
    const service = new AccountService(
      repository,
      cipher,
      'https://hirmos.example',
      () => new Date('2026-09-02T10:00:00Z'),
    );
    await service.requestRecovery('USER@Example.com');
    expect(repository.recoveryInput?.expiresAt.toISOString()).toBe('2026-09-02T11:00:00.000Z');
    expect(new URL(cipher.data!.actionUrl).searchParams.get('ngsw-bypass')).toBe('true');
    await expect(
      service.completeRecovery('y'.repeat(43), 'una contraseña bastante larga'),
    ).rejects.toBeInstanceOf(InvalidOrExpiredTokenError);
    repository.recoveryTokenUsable = true;
    repository.recoveryCompletedUserId = '4fd14c9e-c8a1-4fb9-9470-13d9965f001d';
    await expect(
      service.completeRecovery('y'.repeat(43), 'una contraseña bastante larga'),
    ).resolves.toBeUndefined();
  });
});
