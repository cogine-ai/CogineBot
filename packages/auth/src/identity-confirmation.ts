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
const CODE_SEND_COOLDOWN_MS = 60_000;
const PASSWORD_FAILURES = 5;
const PASSWORD_LOCKOUT_MS = 15 * 60_000;

const confirmationKey = (sessionId: string) => `identity-confirmed-${sessionId}`;
const codeKey = (sessionId: string) => `identity-code-${sessionId}`;
const deliveryKey = (userId: string) => `identity-email-window-${userId}`;
const attemptKey = (userId: string, slot: number) => `identity-attempt-${userId}-${slot}`;

type Verification = { value: string; expiresAt: Date };

/** Reserve a first-writer-wins verification window across API processes. */
async function reserveIdentityWindow(
  prisma: PrismaClient,
  identifier: string,
  userId: string,
  duration: number,
) {
  const now = Date.now();
  await prisma.verification.deleteMany({
    where: { identifier, expiresAt: { lte: new Date(now) } },
  });
  const result = await prisma.verification.createMany({
    data: { id: identifier, identifier, value: userId, expiresAt: new Date(now + duration) },
    skipDuplicates: true,
  });
  return result.count === 1;
}

async function reservePasswordAttempt(prisma: PrismaClient, userId: string): Promise<boolean> {
  for (let slot = 0; slot < PASSWORD_FAILURES; slot += 1) {
    if (await reserveIdentityWindow(prisma, attemptKey(userId, slot), userId, PASSWORD_LOCKOUT_MS))
      return true;
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

type EmailCode = { hash: string; version: string; expiresAt: number; failures: number };
type EmailCodeState = { userId: string; active?: EmailCode; pending?: EmailCode };

/** Code attempts and delivery receipts only change the exact state they read. */
async function changeEmailCode(
  prisma: PrismaClient,
  id: string,
  userId: string,
  change: (state: EmailCodeState) => EmailCodeState,
) {
  for (let retry = 0; retry < 3; retry++) {
    const stored = await prisma.verification.findUnique({ where: { id } });
    const parsed = stored ? (JSON.parse(stored.value) as EmailCodeState) : undefined;
    const state = parsed?.userId === userId ? parsed : { userId };
    const next = change(state);
    if (next === state) return;
    const expiresAt = Math.max(next.active?.expiresAt ?? 0, next.pending?.expiresAt ?? 0);
    const data = { value: JSON.stringify(next), expiresAt: new Date(expiresAt) };
    if (!stored && !expiresAt) return;
    const result = !stored
      ? await prisma.verification.createMany({
          data: { id, identifier: id, ...data },
          skipDuplicates: true,
        })
      : expiresAt
        ? await prisma.verification.updateMany({ where: { id, value: stored.value }, data })
        : await prisma.verification.deleteMany({ where: { id, value: stored.value } });
    if (result.count === 1) return;
  }
  throw new APIError("CONFLICT", { message: "The confirmation changed. Try again." });
}

async function sendIdentityCode(
  prisma: PrismaClient,
  email: TransactionalEmailProvider,
  sessionId: string,
  user: { id: string; email: string },
) {
  const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
  const pending = {
    hash: hashCode(code),
    version: randomUUID(),
    expiresAt: Date.now() + CODE_EXPIRES_MS,
    failures: 0,
  };
  const id = codeKey(sessionId);
  await changeEmailCode(prisma, id, user.id, (state) => {
    if (state.pending && state.pending.expiresAt > Date.now())
      throw new APIError("TOO_MANY_REQUESTS", {
        message: "A code is already being sent. Try again later.",
      });
    return { ...state, pending };
  });

  try {
    await email.send({
      to: user.email,
      subject: "Confirm your identity",
      text: `Your confirmation code is ${code}. It expires in ten minutes.`,
    });
  } catch {
    await changeEmailCode(prisma, id, user.id, (state) =>
      state.pending?.version === pending.version ? { ...state, pending: undefined } : state,
    ).catch(() => undefined);
    // The provider's failure may quote the email body.
    throw new APIError("SERVICE_UNAVAILABLE", { message: "Could not send a confirmation code" });
  }

  // The staged code is already verifiable if the provider delivered it before acknowledging.
  // A failed promotion cannot strand a delivered code or erase the previously delivered one.
  return changeEmailCode(prisma, id, user.id, (state) =>
    state.pending?.version === pending.version ? { userId: user.id, active: state.pending } : state,
  ).then(
    () => true,
    () => false,
  );
}

async function verifyIdentityCode(
  prisma: PrismaClient,
  sessionId: string,
  userId: string,
  code: string,
) {
  if (!/^[0-9]{6}$/.test(code)) throw expiredCode();
  const candidate = hashCode(code);
  const outcome: { state: "expired" | "verified" | "incorrect" | "exhausted"; expiry?: number } = {
    state: "expired",
  };
  let attempted: { versions: string[]; matchedVersion?: string } | undefined;
  await changeEmailCode(prisma, codeKey(sessionId), userId, (state) => {
    const now = Date.now();
    const codes = [state.pending, state.active].filter((entry): entry is EmailCode =>
      Boolean(entry && entry.expiresAt > now),
    );
    const versions = codes.map((entry) => entry.version);
    const matchedVersion = codes.find((entry) => sameHash(entry.hash, candidate))?.version;
    if (!attempted) attempted = { versions, matchedVersion };
    // Promotion can retire the old code while the exact matched candidate remains valid.
    const expectedVersion = attempted.matchedVersion;
    const matched = codes.find((entry) => entry.version === expectedVersion);
    const stale = expectedVersion
      ? !matched
      : attempted.versions.length !== versions.length ||
        attempted.versions.some((version, index) => version !== versions[index]);
    if (versions.length === 0 || stale) {
      outcome.state = "expired";
      return state;
    }
    if (matched) {
      outcome.state = "verified";
      outcome.expiry = matched.expiresAt;
      const seen = attempted.versions;
      const preserveNew = (entry: EmailCode | undefined) =>
        entry && !seen.includes(entry.version) ? entry : undefined;
      return { userId, active: preserveNew(state.active), pending: preserveNew(state.pending) };
    }
    const recordFailure = (entry: EmailCode | undefined) =>
      entry && entry.expiresAt > now && entry.failures + 1 < CODE_ATTEMPTS
        ? { ...entry, failures: entry.failures + 1 }
        : undefined;
    const active = recordFailure(state.active);
    const pending = recordFailure(state.pending);
    outcome.state = active || pending ? "incorrect" : "exhausted";
    return { userId, active, pending };
  });
  switch (outcome.state) {
    case "verified":
      if ((outcome.expiry ?? 0) <= Date.now()) throw expiredCode();
      return;
    case "expired":
      throw expiredCode();
    case "exhausted":
      throw new APIError("BAD_REQUEST", {
        message: "Request a new code",
        code: "TOO_MANY_ATTEMPTS",
      });
    case "incorrect":
      throw new APIError("BAD_REQUEST", { message: "Invalid code", code: "INVALID_OTP" });
  }
}

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
          if (
            !(await reserveIdentityWindow(
              prisma,
              deliveryKey(user.id),
              user.id,
              CODE_SEND_COOLDOWN_MS,
            ))
          )
            throw new APIError("TOO_MANY_REQUESTS", {
              message: "Wait before requesting another code.",
              code: "TOO_MANY_REQUESTS",
            });
          const promoted = await sendIdentityCode(prisma, email, session.id, user);
          if (!promoted) ctx.context.logger.warn("Identity code activation could not be confirmed");
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
            if (!(await reservePasswordAttempt(prisma, user.id))) {
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
            await verifyIdentityCode(prisma, session.id, user.id, code);
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
