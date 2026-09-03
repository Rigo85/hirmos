import type { Database } from '../db/database.js';

export interface ClaimedOutboxMessage {
  id: string;
  lockId: string;
  type: string;
  recipient: string;
  ciphertext: Buffer;
  keyVersion: number;
  attempts: number;
}

interface OutboxRow {
  id: string;
  lock_id: string;
  message_type: string;
  recipient: string;
  template_data_ciphertext: Buffer;
  encryption_key_version: number;
  attempts: number;
}

export class OutboxRepository {
  public constructor(private readonly db: Database) {}

  public async claim(): Promise<ClaimedOutboxMessage | null> {
    const result = await this.db.query<OutboxRow>(
      `WITH candidate AS (
         SELECT id
           FROM email_outbox
          WHERE sent_at IS NULL
            AND failed_at IS NULL
            AND available_at <= now()
            AND (locked_at IS NULL OR locked_at < now() - interval '10 minutes')
          ORDER BY available_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       UPDATE email_outbox o
          SET lock_id = gen_random_uuid(), locked_at = now(), attempts = attempts + 1
         FROM candidate
        WHERE o.id = candidate.id
       RETURNING o.id::text, o.lock_id, o.message_type, o.recipient,
                 o.template_data_ciphertext, o.encryption_key_version, o.attempts`,
    );
    const row = result.rows[0];
    return row
      ? {
          id: row.id,
          lockId: row.lock_id,
          type: row.message_type,
          recipient: row.recipient,
          ciphertext: row.template_data_ciphertext,
          keyVersion: row.encryption_key_version,
          attempts: row.attempts,
        }
      : null;
  }

  public async markSent(id: string, lockId: string): Promise<void> {
    await this.db.query(
      `UPDATE email_outbox
          SET sent_at = now(), locked_at = NULL, lock_id = NULL,
              template_data_ciphertext = decode('00', 'hex')
        WHERE id = $1 AND lock_id = $2`,
      [id, lockId],
    );
  }

  public async markFailed(id: string, lockId: string, attempts: number, code: string): Promise<void> {
    const permanentlyFailed = attempts >= 5;
    const retryMinutes = Math.min(60, 2 ** Math.max(0, attempts - 1));
    await this.db.query(
      `UPDATE email_outbox
          SET locked_at = NULL,
              lock_id = NULL,
              failed_at = CASE WHEN $3 THEN now() ELSE NULL END,
              available_at = CASE WHEN $3 THEN available_at
                                  ELSE now() + ($4::int * interval '1 minute') END,
              last_error_code = $5
        WHERE id = $1 AND lock_id = $2`,
      [id, lockId, permanentlyFailed, retryMinutes, code],
    );
  }
}
