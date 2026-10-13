import { randomBytes } from "node:crypto";
import argon2 from "argon2";
import type {
  ManagedUser,
  ManagedInvitation,
  AccountAuditEntry,
  ManageUserRequest,
  SessionResponse,
} from "@hirmos/contracts";
import type { Database } from "../db/database.js";
import type { SessionRevocationNotifier } from "./session-revocation.js";
import { hashSessionToken } from "./auth-service.js";
import { identityWrite, IdentityChangeError } from "./identity-write.js";

type Actor = { id: string; response: SessionResponse };
export class AccountManagement {
  constructor(
    private readonly db: Database,
    private readonly revocations?: SessionRevocationNotifier,
  ) {}

  private async verify(actor: Actor, password: string): Promise<string> {
    const result = await this.db.query<{ password_hash: string }>(
      `SELECT p.password_hash
      FROM password_credentials p JOIN users u ON u.id=p.user_id JOIN auth_sessions s ON s.user_id=u.id
      WHERE u.id=$1 AND s.id=$2 AND u.disabled_at IS NULL AND s.revoked_at IS NULL AND s.expires_at>now()`,
      [actor.response.user.id, actor.id],
    );
    const hash = result.rows[0]?.password_hash;
    if (!hash || !(await argon2.verify(hash, password).catch(() => false)))
      throw new IdentityChangeError("REAUTH_REQUIRED");
    return hash;
  }

  private async check(
    tx: Pick<Database, "query">,
    actor: Actor,
    hash: string,
    admin: boolean,
  ) {
    const result = await tx.query<{ id: string }>(
      `SELECT u.id FROM users u
      JOIN password_credentials p ON p.user_id=u.id JOIN auth_sessions s ON s.user_id=u.id
      WHERE u.id=$1 AND s.id=$2 AND p.password_hash=$3 AND u.disabled_at IS NULL
        AND s.revoked_at IS NULL AND s.expires_at>now() AND (NOT $4::boolean OR u.role='admin')`,
      [actor.response.user.id, actor.id, hash, admin],
    );
    if (!result.rows.length) throw new IdentityChangeError("REAUTH_REQUIRED");
  }

  async changePassword(actor: Actor, current: string, replacement: string) {
    const expected = await this.verify(actor, current);
    const passwordHash = await argon2.hash(replacement, {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });
    const token = randomBytes(32).toString("base64url");
    const ids = await identityWrite(this.db, async (tx) => {
      await this.check(tx, actor, expected, false);
      // Fence concurrent close-current/close-all through the row lock too.
      const live = await tx.query<{ id: string }>(
        `SELECT id FROM auth_sessions WHERE id=$1 AND revoked_at IS NULL FOR UPDATE`,
        [actor.id],
      );
      if (!live.rows.length) throw new IdentityChangeError("REAUTH_REQUIRED");
      await tx.query(
        "UPDATE password_credentials SET password_hash=$2,updated_at=now() WHERE user_id=$1",
        [actor.response.user.id, passwordHash],
      );
      await tx.query(
        "UPDATE password_recovery_tokens SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL",
        [actor.response.user.id],
      );
      const revoked = await tx.query<{ id: string }>(
        "UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL RETURNING id",
        [actor.response.user.id],
      );
      await tx.query(
        `INSERT INTO auth_sessions(user_id,token_hash,expires_at,ip_address,user_agent)
        SELECT user_id,$2,expires_at,ip_address,user_agent FROM auth_sessions WHERE id=$1`,
        [actor.id, hashSessionToken(token)],
      );
      await tx.query(
        "INSERT INTO security_events(user_id,event_type) VALUES($1,'password.changed')",
        [actor.response.user.id],
      );
      return revoked.rows.map((r) => r.id);
    });
    for (const id of ids) this.revocations?.session(id);
    return { token, session: actor.response };
  }

  async users(
    offset: number,
    search: string,
  ): Promise<{ users: ManagedUser[]; hasMore: boolean }> {
    const result = await this.db.query(
      `SELECT id,email,display_name,role,disabled_at,
      to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_version,created_at FROM users
      WHERE email ILIKE '%'||$2||'%' OR display_name ILIKE '%'||$2||'%'
      ORDER BY created_at,id LIMIT 51 OFFSET $1`,
      [offset, search],
    );
    return {
      hasMore: result.rows.length > 50,
      users: result.rows
        .slice(0, 50)
        .map((r) => ({
          id: r.id,
          email: r.email,
          displayName: r.display_name,
          role: r.role,
          disabled: r.disabled_at !== null,
          updatedAt: r.updated_version,
          createdAt: r.created_at.toISOString(),
        })),
    };
  }

  async changeUser(
    actor: Actor,
    id: string,
    input: ManageUserRequest,
  ): Promise<void> {
    const hash = await this.verify(actor, input.currentPassword);
    const changed = await identityWrite(this.db, async (tx) => {
      await this.check(tx, actor, hash, true);
      const user = (
        await tx.query(
          `SELECT role,disabled_at,
        to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_version
        FROM users WHERE id=$1 FOR UPDATE`,
          [id],
        )
      ).rows[0];
      if (!user) throw new IdentityChangeError("ACCOUNT_NOT_FOUND");
      if (user.updated_version !== input.expectedUpdatedAt)
        throw new IdentityChangeError("ACCOUNT_CONFLICT");
      if (
        user.role === input.role &&
        Boolean(user.disabled_at) === input.disabled
      )
        return false;
      if (
        user.role === "admin" &&
        !user.disabled_at &&
        (input.role !== "admin" || input.disabled)
      ) {
        const count =
          (
            await tx.query(
              "SELECT count(*)::int AS n FROM users WHERE role='admin' AND disabled_at IS NULL",
            )
          ).rows[0]?.n ?? 0;
        if (count <= 1) throw new IdentityChangeError("LAST_ADMIN");
      }
      await tx.query(
        "UPDATE users SET role=$2,disabled_at=CASE WHEN $3 THEN COALESCE(disabled_at,now()) ELSE NULL END,updated_at=clock_timestamp() WHERE id=$1",
        [id, input.role, input.disabled],
      );
      await tx.query(
        "UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL",
        [id],
      );
      if (input.disabled)
        await tx.query(
          "UPDATE password_recovery_tokens SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL",
          [id],
        );
      await tx.query(
        `INSERT INTO security_events(user_id,event_type,metadata) VALUES($1,'account.updated',
        jsonb_build_object('actorUserId',$2::text,'role',$3::text,'disabled',$4::boolean))`,
        [id, actor.response.user.id, input.role, input.disabled],
      );
      return true;
    });
    if (changed) this.revocations?.user(id);
  }

  async invitations(
    offset: number,
  ): Promise<{ invitations: ManagedInvitation[]; hasMore: boolean }> {
    const result = await this.db.query(
      `SELECT id,email,role,created_at,expires_at,(expires_at<=now()) AS expired
      FROM account_invitations WHERE accepted_at IS NULL AND revoked_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 51 OFFSET $1`,
      [offset],
    );
    return {
      hasMore: result.rows.length > 50,
      invitations: result.rows
        .slice(0, 50)
        .map((r) => ({
          id: r.id,
          email: r.email,
          role: r.role,
          createdAt: r.created_at.toISOString(),
          expiresAt: r.expires_at.toISOString(),
          expired: r.expired,
        })),
    };
  }

  async revokeInvitation(actor: Actor, id: string): Promise<void> {
    await identityWrite(this.db, async (tx) => {
      const admin = await tx.query(
        `SELECT u.id FROM users u JOIN auth_sessions s ON s.user_id=u.id WHERE u.id=$1 AND s.id=$2
        AND u.role='admin' AND u.disabled_at IS NULL AND s.revoked_at IS NULL AND s.expires_at>now()`,
        [actor.response.user.id, actor.id],
      );
      if (!admin.rows.length) throw new IdentityChangeError("FORBIDDEN");
      const row = (
        await tx.query(
          "UPDATE account_invitations SET revoked_at=now() WHERE id=$1 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING email",
          [id],
        )
      ).rows[0];
      if (!row) throw new IdentityChangeError("ACCOUNT_NOT_FOUND");
      await tx.query(
        `UPDATE email_outbox SET failed_at=now(),last_error_code='INVITATION_REVOKED',lock_id=NULL,locked_at=NULL,
        template_data_ciphertext=decode('00','hex') WHERE message_type='invitation' AND recipient=$1 AND sent_at IS NULL AND failed_at IS NULL`,
        [row.email],
      );
      await tx.query(
        "INSERT INTO security_events(user_id,event_type,metadata) VALUES($1,'invitation.revoked',jsonb_build_object('invitationId',$2::text))",
        [actor.response.user.id, id],
      );
    });
  }

  async audit(
    offset: number,
  ): Promise<{ events: AccountAuditEntry[]; hasMore: boolean }> {
    const result = await this.db.query(
      `SELECT e.id::text,e.event_type,e.occurred_at,u.email,actor.email AS actor_email FROM security_events e
      LEFT JOIN users u ON u.id=e.user_id LEFT JOIN users actor ON actor.id::text=e.metadata->>'actorUserId'
      ORDER BY e.id DESC LIMIT 51 OFFSET $1`,
      [offset],
    );
    return {
      hasMore: result.rows.length > 50,
      events: result.rows
        .slice(0, 50)
        .map((r) => ({
          id: r.id,
          eventType: r.event_type,
          occurredAt: r.occurred_at.toISOString(),
          subjectEmail: r.email,
          actorEmail: r.actor_email ?? r.email,
        })),
    };
  }
}
