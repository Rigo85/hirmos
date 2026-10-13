import { afterEach, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import {
  AuthService,
  InvalidCredentialsError,
} from "../src/auth/auth-service.js";

let app: FastifyInstance;
afterEach(async () => {
  await app?.close();
});
const owner = "11111111-1111-4111-8111-111111111111",
  other = "22222222-2222-4222-8222-222222222222";
const session = {
  user: {
    id: owner,
    email: "listener@example.test",
    displayName: "Listener",
    role: "user",
  },
  expiresAt: new Date(Date.now() + 86400000).toISOString(),
};
const headers = { origin: "http://localhost:4200" };
const payload = {
  email: session.user.email,
  password: "synthetic-password",
  expectedUserId: owner,
};
async function setup() {
  const login = vi.fn(async () => ({ token: "synthetic", session })),
    revoke = vi.fn();
  app = await buildApp({
    config: loadConfig({ NODE_ENV: "test", PUBLIC_ORIGIN: headers.origin }),
    authService: {
      login,
      revoke,
      authenticate: async (token: string) =>
        token
          ? {
              id: "synthetic-session",
              response: {
                ...session,
                user: {
                  ...session.user,
                  id: token === "other" ? other : owner,
                },
              },
            }
          : null,
    } as unknown as AuthService,
  });
  return { login, revoke };
}
it("renews an expired session using credentials and expected stable owner", async () => {
  const { login } = await setup();
  const result = await app.inject({
    method: "POST",
    url: "/api/auth/renew",
    headers,
    payload,
  });
  expect(result.statusCode).toBe(200);
  expect(result.headers["set-cookie"]).toBeTruthy();
  expect(login).toHaveBeenCalledWith(
    payload.email,
    payload.password,
    expect.any(Object),
    owner,
  );
  expect(result.headers["cache-control"]).toBe("no-store");
});
it("rejects another authenticated account without replacing cookie or checking a password", async () => {
  const { login } = await setup();
  const result = await app.inject({
    method: "POST",
    url: "/api/auth/renew",
    headers: { ...headers, cookie: "hirmos_session=other" },
    payload,
  });
  expect(result.statusCode).toBe(409);
  expect(result.headers["set-cookie"]).toBeUndefined();
  expect(login).not.toHaveBeenCalled();
});
it("requires expected owner and valid origin; failed credentials issue no cookie", async () => {
  const { login } = await setup();
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/auth/renew",
        headers,
        payload: { email: payload.email, password: payload.password },
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/auth/renew",
        headers: { origin: "https://other.example.test" },
        payload,
      })
    ).statusCode,
  ).toBe(403);
  login.mockRejectedValueOnce(new InvalidCredentialsError());
  const failure = await app.inject({
    method: "POST",
    url: "/api/auth/renew",
    headers,
    payload,
  });
  expect(failure.statusCode).toBe(401);
  expect(failure.headers["set-cookie"]).toBeUndefined();
});
it("logout verifies expected owner on the mutation itself, not a prior check", async () => {
  const { revoke } = await setup();
  const result = await app.inject({
    method: "POST",
    url: "/api/auth/logout",
    headers: { ...headers, cookie: "hirmos_session=other" },
    payload: { expectedUserId: owner },
  });
  expect(result.statusCode).toBe(409);
  expect(revoke).not.toHaveBeenCalled();
  expect(result.headers["set-cookie"]).toBeUndefined();
  const own = await app.inject({
    method: "POST",
    url: "/api/auth/logout",
    headers: { ...headers, cookie: "hirmos_session=own" },
    payload: { expectedUserId: owner },
  });
  expect(own.statusCode).toBe(204);
  expect(revoke).toHaveBeenCalledOnce();
});
