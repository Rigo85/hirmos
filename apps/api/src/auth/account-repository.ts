import type { SessionUser, UserRole } from '@hirmos/contracts';
import type { Database } from '../db/database.js';

export interface QueuedAccountMail {
  ciphertext: Buffer;
  keyVersion: number;
}

export interface AccountRepository {
  createInvitation(input: {
    email: string;
    role: UserRole;
    createdBy: string;
    tokenHash: Buffer;
    expiresAt: Date;
    mail: QueuedAccountMail;
  }): Promise<boolean>;
  acceptInvitation(input: {
    tokenHash: Buffer;
    displayName: string;
    passwordHash: string;
    now: Date;
  }): Promise<SessionUser | null>;
  invitationUsable(tokenHash: Buffer, now: Date): Promise<boolean>;
  createRecovery(input: {
    email: string;
    tokenHash: Buffer;
    expiresAt: Date;
    mail: QueuedAccountMail;
    now: Date;
  }): Promise<void>;
  completeRecovery(input: {
    tokenHash: Buffer;
    passwordHash: string;
    now: Date;
  }): Promise<string | null>;
  recoveryUsable(tokenHash: Buffer, now: Date): Promise<boolean>;
}

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  role: UserRole;
}

export class PostgresAccountRepository implements AccountRepository {
  public constructor(private readonly db: Database) {}

  public async createInvitation(input: {
    email: string;
    role: UserRole;
    createdBy: string;
    tokenHash: Buffer;
    expiresAt: Date;
    mail: QueuedAccountMail;
  }): Promise<boolean> {
    const result = await this.db.query<{ created: boolean }>(
      `WITH eligible AS (
         SELECT 1
          WHERE NOT EXISTS (
            SELECT 1 FROM users WHERE lower(email) = lower($1)
          )
       ), refreshed AS (
         UPDATE account_invitations
            SET role = $2, token_hash = $3, created_by = $4,
                created_at = now(), expires_at = $5,
                accepted_at = NULL, revoked_at = NULL
          WHERE lower(email) = lower($1)
            AND accepted_at IS NULL
            AND revoked_at IS NULL
            AND EXISTS (SELECT 1 FROM eligible)
         RETURNING id
       ), created AS (
         INSERT INTO account_invitations
           (email, role, token_hash, created_by, expires_at)
         SELECT lower($1), $2, $3, $4, $5
           FROM eligible
          WHERE NOT EXISTS (SELECT 1 FROM refreshed)
         RETURNING id
       ), invitation AS (
         SELECT id FROM refreshed
         UNION ALL
         SELECT id FROM created
       ), queued AS (
         INSERT INTO email_outbox
           (message_type, recipient, template_data_ciphertext, encryption_key_version)
         SELECT 'invitation', lower($1), $6, $7
           FROM invitation
       )
       SELECT EXISTS (SELECT 1 FROM invitation) AS created`,
      [
        input.email,
        input.role,
        input.tokenHash,
        input.createdBy,
        input.expiresAt,
        input.mail.ciphertext,
        input.mail.keyVersion,
      ],
    );
    return result.rows[0]?.created ?? false;
  }

  public async acceptInvitation(input: {
    tokenHash: Buffer;
    displayName: string;
    passwordHash: string;
    now: Date;
  }): Promise<SessionUser | null> {
    const result = await this.db.query<UserRow>(
      `WITH consumed AS (
         UPDATE account_invitations i
            SET accepted_at = $4
          WHERE i.token_hash = $1
            AND i.accepted_at IS NULL
            AND i.revoked_at IS NULL
            AND i.expires_at > $4
            AND NOT EXISTS (
              SELECT 1 FROM users u WHERE lower(u.email) = lower(i.email)
            )
         RETURNING i.email, i.role
       ), created AS (
         INSERT INTO users (email, display_name, role)
         SELECT email, $2, role FROM consumed
         RETURNING id, email, display_name, role
       ), credential AS (
         INSERT INTO password_credentials (user_id, password_hash)
         SELECT id, $3 FROM created
       ), audit AS (
         INSERT INTO security_events (user_id, event_type)
         SELECT id, 'invitation.accepted' FROM created
       )
       SELECT id, email, display_name, role FROM created`,
      [input.tokenHash, input.displayName, input.passwordHash, input.now],
    );
    const row = result.rows[0];
    return row
      ? { id: row.id, email: row.email, displayName: row.display_name, role: row.role }
      : null;
  }

  public async invitationUsable(tokenHash: Buffer, now: Date): Promise<boolean> {
    const result = await this.db.query<{ usable: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM account_invitations i
          WHERE i.token_hash = $1
            AND i.accepted_at IS NULL
            AND i.revoked_at IS NULL
            AND i.expires_at > $2
            AND NOT EXISTS (
              SELECT 1 FROM users u WHERE lower(u.email) = lower(i.email)
            )
       ) AS usable`,
      [tokenHash, now],
    );
    return result.rows[0]?.usable ?? false;
  }

  public async createRecovery(input: {
    email: string;
    tokenHash: Buffer;
    expiresAt: Date;
    mail: QueuedAccountMail;
    now: Date;
  }): Promise<void> {
    await this.db.query(
      `WITH target AS (
         SELECT id, email
           FROM users
          WHERE lower(email) = lower($1)
            AND disabled_at IS NULL
          LIMIT 1
       ), invalidated AS (
         UPDATE password_recovery_tokens
            SET consumed_at = $7
          WHERE user_id IN (SELECT id FROM target)
            AND consumed_at IS NULL
       ), recovery AS (
         INSERT INTO password_recovery_tokens (user_id, token_hash, expires_at)
         SELECT id, $2, $3 FROM target
         RETURNING id
       ), queued AS (
         INSERT INTO email_outbox
           (message_type, recipient, template_data_ciphertext, encryption_key_version)
         SELECT 'password-recovery', target.email, $4, $5
           FROM target, recovery
       ), audit AS (
         INSERT INTO security_events (user_id, event_type, metadata)
         SELECT id, 'password.recovery_requested', jsonb_build_object('request', $6::text)
           FROM target
       )
       SELECT 1`,
      [
        input.email,
        input.tokenHash,
        input.expiresAt,
        input.mail.ciphertext,
        input.mail.keyVersion,
        'accepted',
        input.now,
      ],
    );
  }

  public async completeRecovery(input: {
    tokenHash: Buffer;
    passwordHash: string;
    now: Date;
  }): Promise<string | null> {
    const result = await this.db.query<{ user_id: string }>(
      `WITH consumed AS (
         UPDATE password_recovery_tokens
            SET consumed_at = $3
          WHERE token_hash = $1
            AND consumed_at IS NULL
            AND expires_at > $3
         RETURNING user_id
       ), credential AS (
         UPDATE password_credentials
            SET password_hash = $2, updated_at = $3
          WHERE user_id IN (SELECT user_id FROM consumed)
       ), sessions AS (
         UPDATE auth_sessions
            SET revoked_at = COALESCE(revoked_at, $3)
          WHERE user_id IN (SELECT user_id FROM consumed)
       ), audit AS (
         INSERT INTO security_events (user_id, event_type)
         SELECT user_id, 'password.recovered' FROM consumed
       )
       SELECT user_id FROM consumed`,
      [input.tokenHash, input.passwordHash, input.now],
    );
    return result.rows[0]?.user_id ?? null;
  }

  public async recoveryUsable(tokenHash: Buffer, now: Date): Promise<boolean> {
    const result = await this.db.query<{ usable: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM password_recovery_tokens
          WHERE token_hash = $1
            AND consumed_at IS NULL
            AND expires_at > $2
       ) AS usable`,
      [tokenHash, now],
    );
    return result.rows[0]?.usable ?? false;
  }
}
