// Disposable schemas and synthetic accounts only. No mail worker or external requests.
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";
import argon2 from "argon2";
import { buildApp } from "../apps/api/dist/app.js";
import { loadConfig } from "../apps/api/dist/config.js";
import { createDatabase } from "../apps/api/dist/db/database.js";
import {
  AuthService,
  hashSessionToken,
} from "../apps/api/dist/auth/auth-service.js";
import { PostgresAuthRepository } from "../apps/api/dist/auth/auth-repository.js";
import { PostgresAccountRepository } from "../apps/api/dist/auth/account-repository.js";
import {
  AccountService,
  hashOneTimeToken,
} from "../apps/api/dist/auth/account-service.js";
import { AccountManagement } from "../apps/api/dist/auth/account-management.js";
import { SessionRevocationNotifier } from "../apps/api/dist/auth/session-revocation.js";
import { AesGcmOutboxCipher } from "../apps/api/dist/mail/outbox-cipher.js";
import { PlaybackRepository } from "../apps/api/dist/playback/playback-repository.js";
import { PlaybackService } from "../apps/api/dist/playback/playback-service.js";

const url = new URL(process.env.HIRMOS_TEST_DATABASE_URL ?? "");
assert.ok(
  ["localhost", "127.0.0.1"].includes(url.hostname) &&
    url.pathname === "/hirmos_core_test",
);
const admin = new pg.Client({ connectionString: url.href });
await admin.connect();
const schema = `hirmos_accounts_${randomUUID().replaceAll("-", "")}`;
await admin.query(`CREATE SCHEMA ${schema}`);
url.searchParams.set(
  "options",
  `-c search_path=${schema} -c statement_timeout=10000`,
);
const db = createDatabase(url.href);
let app,
  checks = 0;
const pass = (label) => {
  checks++;
  console.log(`PASS ${label}`);
};
const password = "Synthetic-only-2026!",
  replacement = "Replacement-only-2026!";
try {
  for (const name of (
    await readdir(new URL("../database/migrations/", import.meta.url))
  )
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    await db.query(
      await readFile(
        new URL(`../database/migrations/${name}`, import.meta.url),
        "utf8",
      ),
    );
  }
  const repo = new PostgresAuthRepository(db),
    accountsRepo = new PostgresAccountRepository(db);
  const notifier = new SessionRevocationNotifier(),
    revoked = [],
    revokedUsers = [];
  notifier.onSession((id) => revoked.push(id));
  notifier.onUser((id) => revokedUsers.push(id));
  const auth = new AuthService(repo, undefined, notifier);
  const cipher = new AesGcmOutboxCipher(randomBytes(32).toString("base64url"));
  const accounts = new AccountService(
    accountsRepo,
    cipher,
    "http://localhost:4200",
    undefined,
    notifier,
  );
  const service = new AccountManagement(db, notifier);
  const initialHash = await argon2.hash(password);
  const seed = async (name, role) => {
    const user = await repo.createUser({
      email: `${name}@example.test`,
      displayName: name,
      role,
      passwordHash: initialHash,
    });
    const token = `synthetic-${name}`;
    await repo.createSession({
      userId: user.id,
      tokenHash: hashSessionToken(token),
      expiresAt: new Date(Date.now() + 86400000),
      ipAddress: null,
      userAgent: "Synthetic",
    });
    return { ...user, token, actor: await auth.authenticate(token) };
  };
  const a = await seed("admin-a", "admin"),
    b = await seed("admin-b", "admin");
  const u = await seed("listener", "user"),
    foreign = await seed("foreign", "user");
  const second = await repo.createSession({
    userId: u.id,
    tokenHash: hashSessionToken("synthetic-second"),
    expiresAt: new Date(Date.now() + 86400000),
    ipAddress: null,
    userAgent: "Remote",
  });
  const config = loadConfig({
    NODE_ENV: "test",
    PUBLIC_ORIGIN: "http://localhost:4200",
  });
  app = await buildApp({
    config,
    database: db,
    authService: auth,
    accountService: accounts,
    revocations: notifier,
    logger: false,
  });
  const request = (
    method,
    path,
    payload,
    token = a.token,
    origin = config.PUBLIC_ORIGIN,
  ) =>
    app.inject({
      method,
      url: path,
      headers: { cookie: `hirmos_session=${token}`, origin },
      ...(payload ? { payload } : {}),
    });
  assert.equal((await app.inject("/api/admin/users")).statusCode, 401);
  for (const path of [
    "/api/admin/users",
    "/api/admin/invitations",
    "/api/admin/account-events",
  ])
    assert.equal((await request("GET", path, null, u.token)).statusCode, 403);
  assert.equal(
    (
      await request(
        "POST",
        "/api/account/password",
        { currentPassword: password, newPassword: replacement },
        u.token,
        "https://other.example.test",
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (await request("GET", "/api/admin/users?userId=other")).statusCode,
    400,
  );
  pass("admin-only reads and mutation origin enforcement");

  await accounts.requestRecovery(u.email);
  const playback = new PlaybackService(new PlaybackRepository(db));
  const before = await playback.snapshot(u.id);
  assert.equal(
    (
      await request(
        "POST",
        "/api/account/password",
        { currentPassword: "wrong", newPassword: replacement },
        u.token,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await request(
        "POST",
        "/api/account/password",
        { currentPassword: password, newPassword: "short" },
        u.token,
      )
    ).statusCode,
    400,
  );
  assert.ok(await auth.authenticate("synthetic-second"));
  const changed = await request(
    "POST",
    "/api/account/password",
    { currentPassword: password, newPassword: replacement },
    u.token,
  );
  assert.equal(changed.statusCode, 200, changed.body);
  const cookie = changed.headers["set-cookie"];
  const newToken = /hirmos_session=([^;]+)/.exec(cookie)[1];
  assert.notEqual(newToken, u.token);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/i);
  assert.ok(await auth.authenticate(newToken));
  assert.equal(await auth.authenticate(u.token), null);
  assert.equal(await auth.authenticate("synthetic-second"), null);
  assert.ok(await auth.authenticate(foreign.token));
  assert.ok(revoked.includes(second) && revoked.includes(u.actor.id));
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int n FROM password_recovery_tokens WHERE user_id=$1 AND consumed_at IS NULL",
        [u.id],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(changed.json().expiresAt, u.actor.response.expiresAt);
  const after = await playback.snapshot(u.id);
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.queue, before.queue);
  await assert.rejects(
    auth.login(u.email, password, { ipAddress: null, userAgent: null }),
  );
  await auth.login(u.email, replacement, { ipAddress: null, userAgent: null });
  pass(
    "password rotation closes old sessions/tokens, preserves other users, expiry and durable queue",
  );

  await assert.rejects(
    repo.createSession({
      userId: u.id,
      tokenHash: hashSessionToken("stale-login"),
      expiresAt: new Date(Date.now() + 86400000),
      ipAddress: null,
      userAgent: null,
      expectedPasswordHash: initialHash,
    }),
    { code: "REAUTH_REQUIRED" },
  );
  pass(
    "login validated before password change cannot create a session afterward",
  );

  const users = await request("GET", "/api/admin/users");
  assert.equal(users.statusCode, 200);
  assert.equal(users.headers["cache-control"], "no-store");
  assert.ok(!users.body.includes("password") && !users.body.includes("token"));
  const version = (id) =>
    service
      .users(0, "")
      .then((result) => result.users.find((x) => x.id === id).updatedAt);
  const oldVersion = await version(foreign.id);
  const patch = {
    role: "user",
    disabled: true,
    currentPassword: password,
    expectedUpdatedAt: oldVersion,
  };
  assert.equal(
    (
      await request("PATCH", `/api/admin/users/${foreign.id}`, {
        ...patch,
        currentPassword: "wrong",
      })
    ).statusCode,
    403,
  );
  const disabled = await request(
    "PATCH",
    `/api/admin/users/${foreign.id}`,
    patch,
  );
  assert.equal(disabled.statusCode, 204, disabled.body);
  assert.equal(await auth.authenticate(foreign.token), null);
  assert.ok(revokedUsers.includes(foreign.id));
  await assert.rejects(
    auth.login(foreign.email, password, { ipAddress: null, userAgent: null }),
  );
  assert.equal(
    (
      await request("PATCH", `/api/admin/users/${foreign.id}`, {
        ...patch,
        disabled: false,
      })
    ).statusCode,
    409,
  );
  await service.changeUser(a.actor, foreign.id, {
    ...patch,
    disabled: false,
    expectedUpdatedAt: await version(foreign.id),
  });
  assert.equal(await auth.authenticate(foreign.token), null);
  await auth.login(foreign.email, password, {
    ipAddress: null,
    userAgent: null,
  });
  pass(
    "reauth, disable/re-enable and exact optimistic version; old sessions do not revive",
  );

  const pendingEmail = "invited@example.test";
  assert.equal(
    (
      await request("POST", "/api/admin/invitations", {
        email: pendingEmail,
        role: "user",
      })
    ).statusCode,
    202,
  );
  const invitation = (await request("GET", "/api/admin/invitations")).json()
    .invitations[0];
  const mail = async () =>
    (
      await db.query(
        "SELECT * FROM email_outbox WHERE recipient=$1 AND failed_at IS NULL ORDER BY created_at DESC LIMIT 1",
        [pendingEmail],
      )
    ).rows[0];
  const tokenFrom = (row) =>
    new URL(
      cipher.decrypt(row.template_data_ciphertext, row.encryption_key_version)
        .actionUrl,
    ).searchParams.get("token");
  const token1 = tokenFrom(await mail());
  assert.equal(
    (
      await request(
        "POST",
        `/api/admin/invitations/${invitation.id}/resend`,
        {},
      )
    ).statusCode,
    202,
  );
  const token2 = tokenFrom(await mail());
  assert.notEqual(token1, token2);
  await assert.rejects(accounts.acceptInvitation(token1, "Invited", password));
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int n FROM email_outbox WHERE recipient=$1 AND failed_at IS NULL",
        [pendingEmail],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (await request("DELETE", `/api/admin/invitations/${invitation.id}`))
      .statusCode,
    204,
  );
  await assert.rejects(accounts.acceptInvitation(token2, "Invited", password));
  assert.equal(
    (
      await request(
        "POST",
        `/api/admin/invitations/${invitation.id}/resend`,
        {},
      )
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int n FROM email_outbox WHERE recipient=$1 AND failed_at IS NULL",
        [pendingEmail],
      )
    ).rows[0].n,
    0,
  );
  // Accepted invitations cannot be replayed or resent.
  await accounts.invite(pendingEmail, "user", a.id, {
    actorSessionId: a.actor.id,
  });
  const token3 = tokenFrom(await mail());
  await accounts.acceptInvitation(token3, "Invited", password);
  await assert.rejects(
    accounts.acceptInvitation(token3, "Invited twice", password),
  );
  pass(
    "resend/revoke cancel queued stale mail and old links; accepted token is single-use",
  );

  await db.query(`CREATE FUNCTION reject_account_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$;
    CREATE TRIGGER reject_audit BEFORE INSERT ON security_events FOR EACH ROW EXECUTE FUNCTION reject_account_audit()`);
  await assert.rejects(service.changePassword(a.actor, password, replacement));
  assert.ok(await auth.authenticate(a.token));
  assert.ok(
    await argon2.verify(
      (await repo.findPasswordUserByEmail(a.email)).passwordHash,
      password,
    ),
  );
  await assert.rejects(
    service.changeUser(a.actor, foreign.id, {
      ...patch,
      expectedUpdatedAt: await version(foreign.id),
    }),
  );
  assert.equal(
    (await service.users(0, "")).users.find((x) => x.id === foreign.id)
      .disabled,
    false,
  );
  await db.query(
    "DROP TRIGGER reject_audit ON security_events; DROP FUNCTION reject_account_audit()",
  );
  pass("audit failure rolls back password, sessions and account edits");

  const newActor = await auth.authenticate(newToken);
  const passwordRace = await Promise.allSettled([
    service.changePassword(newActor, replacement, 'Concurrent-first-2026!'),
    service.changePassword(newActor, replacement, 'Concurrent-second-2026!'),
  ]);
  assert.equal(passwordRace.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(passwordRace.find(r => r.status === 'rejected').reason.code, 'REAUTH_REQUIRED');
  const winner = passwordRace.find(r => r.status === 'fulfilled').value;
  assert.ok(await auth.authenticate(winner.token));
  assert.equal(await auth.authenticate(newToken), null);
  await accounts.requestRecovery(u.email);
  const recoveryMail = (await db.query("SELECT * FROM email_outbox WHERE recipient=$1 AND message_type='password-recovery' AND failed_at IS NULL ORDER BY created_at DESC LIMIT 1", [u.email])).rows[0];
  const recoveryToken = tokenFrom(recoveryMail);
  await accounts.completeRecovery(recoveryToken, replacement);
  assert.equal(await auth.authenticate(winner.token), null);
  await assert.rejects(accounts.completeRecovery(recoveryToken, password));
  await auth.login(u.email, replacement, { ipAddress: null, userAgent: null });
  pass('concurrent password edits have one winner; recovery remains single-use and revokes it');

  const concurrent = await Promise.allSettled(
    [a, b].map(async (actor) =>
      service.changeUser(actor.actor, actor.id, {
        role: "user",
        disabled: false,
        currentPassword: password,
        expectedUpdatedAt: await version(actor.id),
      }),
    ),
  );
  assert.equal(concurrent.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    concurrent.find((r) => r.status === "rejected").reason.code,
    "LAST_ADMIN",
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int n FROM users WHERE role='admin' AND disabled_at IS NULL",
      )
    ).rows[0].n,
    1,
  );
  pass("concurrent self-demotions cannot remove the last active administrator");

  const remaining = (await auth.authenticate(a.token)) ? a : b;
  const events = await request(
    "GET",
    "/api/admin/account-events",
    null,
    remaining.token,
  );
  assert.equal(events.statusCode, 200);
  assert.ok(
    events.json().events.some((e) => e.eventType === "password.changed"),
  );
  for (const entry of events.json().events)
    assert.deepEqual(
      Object.keys(entry).sort(),
      ["eventType", "id", "occurredAt", "subjectEmail", "actorEmail"].sort(),
    );
  assert.ok(
    events
      .json()
      .events.some(
        (e) =>
          e.eventType === "account.updated" &&
          e.subjectEmail === foreign.email &&
          e.actorEmail === a.email,
      ),
  );
  assert.equal(
    (
      await request("GET", "/api/admin/users?q=no-match", null, remaining.token)
    ).json().users.length,
    0,
  );
  pass(
    "audit exposes only allowed fields and filtered users do not leak secrets",
  );
  console.log(`${checks} account management groups passed`);
} finally {
  if (app) await app.close();
  await db.close();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
}
