import argon2 from 'argon2';
import { describe, expect, it } from 'vitest';
import type {
  AuthRepository,
  AuthSessionRecord,
  NewUser,
  PasswordUser,
} from '../src/auth/auth-repository.js';
import { AuthService, InvalidCredentialsError } from '../src/auth/auth-service.js';

class FakeAuthRepository implements AuthRepository {
  user: PasswordUser | null = null;
  createdTokenHash: Buffer | null = null;

  async findPasswordUserByEmail(): Promise<PasswordUser | null> {
    return this.user;
  }
  async createUser(_input: NewUser) {
    throw new Error('not used');
  }
  async createSession(input: { tokenHash: Buffer }): Promise<string> {
    this.createdTokenHash = input.tokenHash;
    return '90ab947a-9c15-4289-8476-74fca1a4910c';
  }
  async findSession(_tokenHash: Buffer): Promise<AuthSessionRecord | null> {
    return null;
  }
  async touchSession(): Promise<void> {}
  async revokeSession(): Promise<void> {}
}

describe('AuthService', () => {
  it('creates an opaque session after valid credentials', async () => {
    const repository = new FakeAuthRepository();
    repository.user = {
      id: 'ae15ac30-bd01-490d-813c-e4fc6cdf4308',
      email: 'oyente@example.com',
      displayName: 'Oyente',
      role: 'user',
      disabledAt: null,
      passwordHash: await argon2.hash('una contraseña suficientemente larga'),
    };
    const service = new AuthService(repository, () => new Date('2026-09-01T12:00:00Z'));

    const result = await service.login(
      'oyente@example.com',
      'una contraseña suficientemente larga',
      { ipAddress: '127.0.0.1', userAgent: 'vitest' },
    );

    expect(result.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(result.session.user.email).toBe('oyente@example.com');
    expect(repository.createdTokenHash).toHaveLength(32);
    expect(repository.createdTokenHash?.toString('hex')).not.toContain(result.token);
  });

  it('uses a generic invalid-credentials failure', async () => {
    const repository = new FakeAuthRepository();
    const service = new AuthService(repository);

    await expect(
      service.login('missing@example.com', 'incorrecta', {
        ipAddress: null,
        userAgent: null,
      }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
  });
});
