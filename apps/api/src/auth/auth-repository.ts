import type { SessionUser, UserRole } from '@hirmos/contracts';
import type { Database } from '../db/database.js';

export interface PasswordUser extends SessionUser {
  passwordHash: string;
  disabledAt: Date | null;
}

export interface AuthSessionRecord {
  id: string;
  user: SessionUser;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface NewUser {
  email: string;
  displayName: string;
  role: UserRole;
  passwordHash: string;
}

export interface AuthRepository {
  findPasswordUserByEmail(email: string): Promise<PasswordUser | null>;
  createUser(input: NewUser): Promise<SessionUser>;
  createSession(input: {
    userId: string;
    tokenHash: Buffer;
    expiresAt: Date;
    ipAddress: string | null;
    userAgent: string | null;
  }): Promise<string>;
  findSession(tokenHash: Buffer): Promise<AuthSessionRecord | null>;
  touchSession(id: string, at: Date): Promise<void>;
  revokeSession(id: string, at: Date): Promise<void>;
}

interface PasswordUserRow {
  id: string;
  email: string;
  display_name: string;
  role: UserRole;
  password_hash: string;
  disabled_at: Date | null;
}

interface SessionRow {
  session_id: string;
  expires_at: Date;
  revoked_at: Date | null;
  user_id: string;
  email: string;
  display_name: string;
  role: UserRole;
}

export class PostgresAuthRepository implements AuthRepository {
  public constructor(private readonly db: Database) {}

  public async findPasswordUserByEmail(email: string): Promise<PasswordUser | null> {
    const result = await this.db.query<PasswordUserRow>(
      `SELECT u.id, u.email, u.display_name, u.role, p.password_hash, u.disabled_at
         FROM users u
         JOIN password_credentials p ON p.user_id = u.id
        WHERE lower(u.email) = lower($1)
        LIMIT 1`,
      [email],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      passwordHash: row.password_hash,
      disabledAt: row.disabled_at,
    };
  }

  public async createUser(input: NewUser): Promise<SessionUser> {
    const result = await this.db.query<PasswordUserRow>(
      `WITH created AS (
         INSERT INTO users (email, display_name, role)
         VALUES (lower($1), $2, $3)
         RETURNING id, email, display_name, role
       ), credential AS (
         INSERT INTO password_credentials (user_id, password_hash)
         SELECT id, $4 FROM created
       )
       SELECT id, email, display_name, role, '' AS password_hash, NULL::timestamptz AS disabled_at
         FROM created`,
      [input.email, input.displayName, input.role, input.passwordHash],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Failed to create user');
    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
    };
  }

  public async createSession(input: {
    userId: string;
    tokenHash: Buffer;
    expiresAt: Date;
    ipAddress: string | null;
    userAgent: string | null;
  }): Promise<string> {
    const result = await this.db.query<{ id: string }>(
      `INSERT INTO auth_sessions
         (user_id, token_hash, expires_at, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [input.userId, input.tokenHash, input.expiresAt, input.ipAddress, input.userAgent],
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error('Failed to create session');
    return id;
  }

  public async findSession(tokenHash: Buffer): Promise<AuthSessionRecord | null> {
    const result = await this.db.query<SessionRow>(
      `SELECT s.id AS session_id, s.expires_at, s.revoked_at,
              u.id AS user_id, u.email, u.display_name, u.role
         FROM auth_sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1
          AND s.revoked_at IS NULL
          AND s.expires_at > now()
          AND u.disabled_at IS NULL
        LIMIT 1`,
      [tokenHash],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.session_id,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      user: {
        id: row.user_id,
        email: row.email,
        displayName: row.display_name,
        role: row.role,
      },
    };
  }

  public async touchSession(id: string, at: Date): Promise<void> {
    await this.db.query(
      `UPDATE auth_sessions
          SET last_seen_at = $2::timestamptz
        WHERE id = $1
          AND last_seen_at < ($2::timestamptz - interval '5 minutes')`,
      [id, at],
    );
  }

  public async revokeSession(id: string, at: Date): Promise<void> {
    await this.db.query(
      `UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, $2) WHERE id = $1`,
      [id, at],
    );
  }
}
