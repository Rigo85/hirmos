import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  changePasswordRequestSchema,
  manageUserRequestSchema,
} from "@hirmos/contracts";
import type { Database } from "../db/database.js";
import type { AppConfig } from "../config.js";
import type { AccountService } from "../auth/account-service.js";
import type { RateLimiter } from "../auth/rate-limiter.js";
import type { SessionRevocationNotifier } from "../auth/session-revocation.js";
import { AccountManagement } from "../auth/account-management.js";
import { IdentityChangeError } from "../auth/identity-write.js";
import {
  requireAuthentication,
  requireAdmin,
  enforceRateLimits,
  setSessionCookie,
  sessionCookieName,
} from "./auth-routes.js";

const pageSchema = z
  .object({
    offset: z.coerce.number().int().min(0).max(1000000).default(0),
    q: z.string().max(100).default(""),
  })
  .strict();
const idSchema = z.object({ id: z.uuid() });
export async function registerAccountManagementRoutes(
  app: FastifyInstance,
  config: AppConfig,
  db: Database | undefined,
  accounts: AccountService | undefined,
  limiter: RateLimiter,
  revocations?: SessionRevocationNotifier,
) {
  const service = db ? new AccountManagement(db, revocations) : null;
  await app.register(async (scope) => {
    scope.addHook("preHandler", async (request, reply) => {
      reply.header("cache-control", "no-store");
      const denied = request.url.startsWith("/api/admin/")
        ? requireAdmin(request, reply)
        : requireAuthentication(request, reply);
      if (denied) return denied;
      if (!service)
        return reply
          .code(503)
          .send({
            code: "ACCOUNT_UNAVAILABLE",
            message: "La gestión de cuentas no está disponible.",
          });
    });
    scope.setErrorHandler((error, _request, reply) => {
      if (!(error instanceof IdentityChangeError)) throw error;
      const messages = {
        REAUTH_REQUIRED:
          "Confirma tu contraseña actual; si la sesión cambió, vuelve a entrar.",
        ACCOUNT_CONFLICT:
          "Esta cuenta cambió mientras la editabas. Actualiza antes de continuar.",
        LAST_ADMIN: "Debe quedar al menos un administrador activo.",
        ACCOUNT_NOT_FOUND: "La cuenta o invitación no está disponible.",
        FORBIDDEN: "Ya no tienes permiso para esta acción.",
      };
      return reply
        .code(
          error.code === "ACCOUNT_NOT_FOUND"
            ? 404
            : error.code === "FORBIDDEN"
              ? 403
              : error.code === "REAUTH_REQUIRED"
                ? 403
                : 409,
        )
        .send({ code: error.code, message: messages[error.code] });
    });
    scope.post("/api/account/password", async (request, reply) => {
      const parsed = changePasswordRequestSchema.safeParse(request.body);
      if (!parsed.success)
        return reply
          .code(400)
          .send({
            code: "INVALID_REQUEST",
            message: "Usa al menos 12 caracteres para la nueva contraseña.",
          });
      const actor = request.authSession!;
      const limited = enforceRateLimits(
        limiter,
        request,
        reply,
        `reauth:ip:${request.ip}`,
        `reauth:user:${actor.response.user.id}`,
        20,
        6,
        15 * 60000,
      );
      if (limited) return limited;
      const result = await service!.changePassword(
        actor,
        parsed.data.currentPassword,
        parsed.data.newPassword,
      );
      setSessionCookie(
        reply,
        sessionCookieName(config),
        result.token,
        result.session.expiresAt,
        config,
      );
      return result.session;
    });
    scope.get("/api/admin/users", async (request, reply) => {
      const parsed = pageSchema.safeParse(request.query);
      if (!parsed.success)
        return reply.code(400).send({ code: "INVALID_REQUEST" });
      return service!.users(parsed.data.offset, parsed.data.q);
    });
    scope.patch("/api/admin/users/:id", async (request, reply) => {
      const params = idSchema.safeParse(request.params),
        parsed = manageUserRequestSchema.safeParse(request.body);
      if (!params.success || !parsed.success)
        return reply.code(400).send({ code: "INVALID_REQUEST" });
      const actor = request.authSession!;
      const limited = enforceRateLimits(
        limiter,
        request,
        reply,
        `reauth:ip:${request.ip}`,
        `reauth:user:${actor.response.user.id}`,
        20,
        6,
        15 * 60000,
      );
      if (limited) return limited;
      await service!.changeUser(actor, params.data.id, parsed.data);
      return reply.code(204).send();
    });
    scope.get("/api/admin/invitations", async (request, reply) => {
      const parsed = pageSchema.safeParse(request.query);
      if (!parsed.success)
        return reply.code(400).send({ code: "INVALID_REQUEST" });
      return service!.invitations(parsed.data.offset);
    });
    scope.delete("/api/admin/invitations/:id", async (request, reply) => {
      const parsed = idSchema.safeParse(request.params);
      if (!parsed.success)
        return reply.code(400).send({ code: "INVALID_REQUEST" });
      await service!.revokeInvitation(request.authSession!, parsed.data.id);
      return reply.code(204).send();
    });
    scope.post("/api/admin/invitations/:id/resend", async (request, reply) => {
      const parsed = idSchema.safeParse(request.params);
      if (!parsed.success)
        return reply.code(400).send({ code: "INVALID_REQUEST" });
      if (!accounts)
        return reply
          .code(503)
          .send({
            code: "ACCOUNT_MAIL_NOT_CONFIGURED",
            message: "El correo aún no está configurado.",
          });
      const row = (
        await db!.query(
          "SELECT email,role FROM account_invitations WHERE id=$1 AND accepted_at IS NULL AND revoked_at IS NULL",
          [parsed.data.id],
        )
      ).rows[0];
      if (!row) throw new IdentityChangeError("ACCOUNT_NOT_FOUND");
      const limited = enforceRateLimits(
        limiter,
        request,
        reply,
        `invite:ip:${request.ip}`,
        `invite:recipient:${row.email}`,
        30,
        5,
        60 * 60000,
      );
      if (limited) return limited;
      if (
        !(await accounts.invite(
          row.email,
          row.role,
          request.authSession!.response.user.id,
          {
            actorSessionId: request.authSession!.id,
            expectedInvitationId: parsed.data.id,
          },
        ))
      )
        throw new IdentityChangeError("ACCOUNT_CONFLICT");
      return reply.code(202).send({ status: "queued" });
    });
    scope.get("/api/admin/account-events", async (request, reply) => {
      const parsed = pageSchema.safeParse(request.query);
      if (!parsed.success)
        return reply.code(400).send({ code: "INVALID_REQUEST" });
      return service!.audit(parsed.data.offset);
    });
  });
}
