import type { Database } from "../db/database.js";

export class IdentityChangeError extends Error {
  constructor(
    public readonly code:
      | "REAUTH_REQUIRED"
      | "ACCOUNT_CONFLICT"
      | "LAST_ADMIN"
      | "ACCOUNT_NOT_FOUND"
      | "FORBIDDEN",
  ) {
    super(code);
  }
}

/** Low-volume identity writes only; never hold this lock during hashing or SMTP. */
export function identityWrite<T>(
  db: Database,
  operation: (tx: Pick<Database, "query">) => Promise<T>,
): Promise<T> {
  if (!db.transaction) throw new Error("Identity writes require transactions");
  return db.transaction(async (tx) => {
    await tx.query("SET LOCAL lock_timeout='5s'");
    await tx.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('hirmos:identity-writes',0))",
    );
    return operation(tx);
  });
}
