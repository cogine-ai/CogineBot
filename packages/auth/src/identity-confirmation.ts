import { createHash, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type { TransactionalEmailProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { oidcProofKey } from "./account-security.js";

/** How long one confirmation lets a session reach sensitive data. */
export const IDENTITY_CONFIRMATION_MS = 5 * 60_000;
const CODE_EXPIRES_MS = 10 * 60_000;
const CODE_ATTEMPTS = 3;
const PASSWORD_FAILURES = 5;
const PASSWORD_LOCKOUT_MS = 15 * 60_000;

const confirmationKey = (sessionId: string) => `identity-confirmed-${sessionId}`;
const codeKey = (sessionId: string) => `identity-code-${sessionId}`;
const attemptKey = (userId: string, slot: number) => `identity-attempt-${userId}-${slot}`;

type Verification = { value: string; expiresAt: Date };

/**
 * Claims one of the account's password attempts before the password is checked. Each attempt is
 * its own row created first-writer-wins, so parallel guesses across API processes cannot share one.
 */
async function reservePasswordAttempt(
  adapter: {
    reserveVerificationValue(data: Verification & { identifier: string }): Promise<boolean>;
  },
  prisma: PrismaClient,
  userId: string,
): Promise<boolean> {
  for (let slot = 0; slot < PASSWORD_FAILURES; slot += 1) {
    const identifier = attemptKey(userId, slot);
    await prisma.verification.deleteMany({
      where: { identifier, expiresAt: { lte: new Date() } },
    });
    const reserved = await adapter.reserveVerificationValue({
      identifier,
      value: userId,
      expiresAt: new Date(Date.now() + PASSWORD_LOCKOUT_MS),
    });
    if (reserved) return true;
  }
  return false;
}

/**
 * The deadline for this session's confirmation by password, emailed code or fresh SSO.
 * Returning the deadline lets the caller recheck it after a protected read without another lookup.
 */
export async function identityConfirmationExpiry(
  adapter: { findVerificationValue(identifier: string): Promise<Verification | null> },
  session: { sessionId: string; userId: string },
): Promise<number | null> {
  const proofs = await Promise.all(
    [confirmationKey(session.sessionId), oidcProofKey(session.sessionId)].map((identifier) =>
      adapter.findVerificationValue(identifier),
    ),
  );
  const expiry = Math.max(
    ...proofs.map((proof) => (proof?.value === session.userId ? proof.expiresAt.getTime() : 0)),
  );
  return expiry > Date.now() ? expiry : null;
}

const hashCode = (code: string) => createHash("sha256").update(code).digest("hex");

function sameHash(stored: string, candidate: string): boolean {
  const left = Buffer.from(stored, "hex");
  const right = Buffer.from(candidate, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

const invalidPassword = () =>
  new APIError("BAD_REQUEST", { message: "Invalid password", code: "INVALID_PASSWORD" });
const expiredCode = () =>
  new APIError("BAD_REQUEST", { message: "Request a new code", code: "OTP_EXPIRED" });

/**
 * Step-up confirmation for the signed-in session. Password accounts confirm with their
 * password; accounts without one use an emailed code or a fresh SSO sign-in, like deletion.
 */
export function identityConfirmation(
  prisma: PrismaClient,
  email: TransactionalEmailProvider | undefined,
  passwordAuth: boolean,
) {
  return {
    id: "identity-confirmation",
    endpoints: {
      requestIdentityCode: createAuthEndpoint(
        "/request-identity-code",
        { method: "POST", use: [sessionMiddleware] },
        async (ctx) => {
          const { session, user } = ctx.context.session;
          const adapter = ctx.context.internalAdapter;
          if (!passwordAuth || !email || (await adapter.findCredentialAccount(user.id))?.password) {
            throw new APIError("BAD_REQUEST", {
              message: "Email codes are not available",
              code: "EMAIL_CODE_UNAVAILABLE",
            });
          }
          const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
          await email.send({
            to: user.email,
            subject: "Confirm your identity",
            text: `Your confirmation code is ${code}. It expires in ten minutes.`,
          });
          const identifier = codeKey(session.id);
          const challenge = {
            value: `${user.id}:${hashCode(code)}:0:${randomUUID()}`,
            expiresAt: new Date(Date.now() + CODE_EXPIRES_MS),
          };
          await prisma.verification.upsert({
            where: { id: identifier },
            create: { id: identifier, identifier, ...challenge },
            update: challenge,
          });
          return ctx.json({ success: true });
        },
      ),
      confirmIdentity: createAuthEndpoint(
        "/confirm-identity",
        { method: "POST", use: [sessionMiddleware] },
        async (ctx) => {
          const { session, user } = ctx.context.session;
          if (!passwordAuth) throw new APIError("FORBIDDEN");
          const adapter = ctx.context.internalAdapter;
          const body = (ctx.body ?? {}) as { password?: unknown; code?: unknown };
          const hash = (await adapter.findCredentialAccount(user.id))?.password;
          if (hash) {
            if (typeof body.password !== "string" || !body.password || body.password.length > 128)
              throw invalidPassword();
            if (!(await reservePasswordAttempt(adapter, prisma, user.id))) {
              throw new APIError("TOO_MANY_REQUESTS", {
                message: "Too many attempts. Try again later.",
                code: "TOO_MANY_REQUESTS",
              });
            }
            // A wrong password keeps its reserved attempt until the lockout window passes.
            if (!(await ctx.context.password.verify({ hash, password: body.password })))
              throw invalidPassword();
            for (let slot = 0; slot < PASSWORD_FAILURES; slot += 1)
              await adapter.deleteVerificationByIdentifier(attemptKey(user.id, slot));
          } else {
            const code = typeof body.code === "string" ? body.code.trim() : "";
            if (!/^[0-9]{6}$/.test(code)) throw expiredCode();
            const id = codeKey(session.id);
            const stored = await prisma.verification.findUnique({ where: { id } });
            const [userId, codeHash, attempts, version] = stored?.value.split(":") ?? [];
            if (!stored || stored.expiresAt.getTime() <= Date.now() || userId !== user.id)
              throw expiredCode();
            const where = { id, value: stored.value, expiresAt: { gt: new Date() } };
            const valid = sameHash(codeHash ?? "", hashCode(code));
            const next = Number(attempts) + 1;
            // Resending replaces the challenge. Every attempt is bound to its exact version.
            const changed =
              valid || next >= CODE_ATTEMPTS
                ? await prisma.verification.deleteMany({ where })
                : await prisma.verification.updateMany({
                    where,
                    data: { value: `${userId}:${codeHash}:${next}:${version}` },
                  });
            if (changed.count !== 1) throw expiredCode();
            if (!valid)
              throw new APIError("BAD_REQUEST", {
                message: next >= CODE_ATTEMPTS ? "Request a new code" : "Invalid code",
                code: next >= CODE_ATTEMPTS ? "TOO_MANY_ATTEMPTS" : "INVALID_OTP",
              });
          }
          await adapter.deleteVerificationByIdentifier(confirmationKey(session.id));
          await adapter.createVerificationValue({
            identifier: confirmationKey(session.id),
            value: user.id,
            expiresAt: new Date(Date.now() + IDENTITY_CONFIRMATION_MS),
          });
          return ctx.json({ success: true });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
