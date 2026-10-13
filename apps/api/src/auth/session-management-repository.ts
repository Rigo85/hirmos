import type { AccountSessionsResponse } from '@hirmos/contracts';
import type { Database } from '../db/database.js';
import { identityWrite } from './identity-write.js';

/** Session IDs identify resources, never authorize access. No tokens/IPs leave this repository. */
export class SessionManagementRepository {
  public constructor(private readonly db: Database) {}

  public async list(userId: string, currentId: string, offset: number): Promise<AccountSessionsResponse> {
    const result = await this.db.query<{
      id: string; user_agent: string | null; created_at: Date; last_seen_at: Date; expires_at: Date;
    }>(`SELECT id, left(user_agent, 512) AS user_agent, created_at, last_seen_at, expires_at
       FROM auth_sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now()
       ORDER BY (id=$2) DESC, created_at DESC, id DESC LIMIT 51 OFFSET $3`, [userId, currentId, offset]);
    return { hasMore: result.rows.length > 50, sessions: result.rows.slice(0, 50).map(row => ({
      id: row.id, current: row.id === currentId, userAgent: row.user_agent,
      createdAt: row.created_at.toISOString(), lastSeenAt: row.last_seen_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
    })) };
  }

  public async revoke(userId: string, actorSessionId: string,
    target: { id: string } | { scope: 'others' | 'all' }): Promise<{ found: boolean; ids: string[] }> {
    // Single SQL statement: owned targets + revocation + audit commit together.
    // Repeating a request does not create new audit entries for already closed sessions.
    const result = await identityWrite(this.db, tx => tx.query<{ found: boolean; ids: string[] }>(`
      WITH actor AS (
        SELECT s.id FROM auth_sessions s JOIN users u ON u.id=s.user_id
        WHERE s.id=$2 AND s.user_id=$1 AND s.revoked_at IS NULL AND s.expires_at>now()
          AND u.disabled_at IS NULL
      ), targets AS (
        SELECT id FROM auth_sessions WHERE user_id=$1 AND EXISTS(SELECT 1 FROM actor)
          AND (($3::uuid IS NOT NULL AND id=$3) OR ($3::uuid IS NULL AND ($4='all' OR id<>$2)))
      ), revoked AS (
        UPDATE auth_sessions SET revoked_at=now()
        WHERE id IN (SELECT id FROM targets) AND revoked_at IS NULL AND expires_at>now()
        RETURNING id
      ), audit AS (
        INSERT INTO security_events(user_id,event_type,metadata)
        SELECT $1,'session.revoked',jsonb_build_object('sessionId',id,'actorSessionId',$2::text,
          'scope',COALESCE($4,'one')) FROM revoked
      )
      SELECT EXISTS(SELECT 1 FROM targets) AS found,
        ARRAY(SELECT id::text FROM revoked) AS ids`,
    [userId, actorSessionId, 'id' in target ? target.id : null, 'scope' in target ? target.scope : null]));
    return result.rows[0] ?? { found: false, ids: [] };
  }
}
