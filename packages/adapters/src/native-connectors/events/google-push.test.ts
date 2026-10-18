import assert from "node:assert/strict";
import type { JSONWebKeySet, JWTPayload } from "jose";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, it as test } from "vitest";
import { NativeActionError } from "../action.js";
import type { GmailPushVerifier } from "./google-push.js";
import { createGmailPushVerifier } from "./google-push.js";
import { InvalidNativeEventSignal } from "./signals.js";

type Obj = Record<string, unknown>;
const NOW = Date.parse("2026-10-18T00:00:00Z"),
  SECONDS = Math.floor(NOW / 1000);
const CONFIG = {
  callbackAudience: "https://api.example.test/api/connectors/events/gmail",
  pushServiceAccountEmail: "fixture-push@fixture-project.iam.gserviceaccount.com",
  subscriptionName: "projects/fixture-project/subscriptions/gmail-push",
};
let pair: Awaited<ReturnType<typeof generateKeyPair>>,
  rotated: Awaited<ReturnType<typeof generateKeyPair>>,
  jwks: JSONWebKeySet,
  rotatedJwks: JSONWebKeySet;
beforeAll(async () => {
  pair = await generateKeyPair("RS256", { modulusLength: 2048 });
  rotated = await generateKeyPair("RS256", { modulusLength: 2048 });
  jwks = {
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: "fixture-key", use: "sig", alg: "RS256" }],
  };
  rotatedJwks = {
    keys: [
      { ...(await exportJWK(rotated.publicKey)), kid: "rotated-key", use: "sig", alg: "RS256" },
    ],
  };
});
const verifiers: GmailPushVerifier[] = [];
afterEach(async () => {
  await Promise.all(verifiers.splice(0).map((verifier) => verifier.close()));
});
async function jwt(
  patch: Obj = {},
  header: Obj = {},
  key?: Parameters<SignJWT["sign"]>[0],
): Promise<string> {
  const payload = {
    iss: "https://accounts.google.com",
    sub: "fixture-push-subject",
    aud: CONFIG.callbackAudience,
    iat: SECONDS,
    exp: SECONDS + 3600,
    email: CONFIG.pushServiceAccountEmail,
    email_verified: true,
    ...patch,
  };
  return new SignJWT(payload as JWTPayload)
    .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: "fixture-key", ...header })
    .sign(key ?? pair.privateKey);
}
function body(
  data: unknown = { emailAddress: "owner@example.test", historyId: "100" },
  patch: Obj = {},
): string {
  return JSON.stringify({
    message: {
      data: Buffer.from(JSON.stringify(data)).toString("base64"),
      messageId: "fixture-pubsub-message",
      publishTime: "2026-10-17T23:59:00.123456Z",
    },
    subscription: CONFIG.subscriptionName,
    ...patch,
  });
}
function fixture(
  options: { fetch?: typeof globalThis.fetch; headers?: Record<string, string> } = {},
) {
  let now = NOW,
    calls = 0;
  const verifier = createGmailPushVerifier({
    now: () => now,
    network: {
      resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
      fetch: async (input, init) => {
        calls++;
        assert.equal(String(input), "https://www.googleapis.com/oauth2/v3/certs");
        assert.equal(init?.method, "GET");
        assert.equal(init?.redirect, "manual");
        assert.equal(new Headers(init?.headers).get("authorization"), null);
        return options.fetch
          ? options.fetch(input, init)
          : Response.json(jwks, {
              headers: { "cache-control": "public, max-age=3600", ...options.headers },
            });
      },
    },
  });
  verifiers.push(verifier);
  return {
    verifier,
    calls: () => calls,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}
const signal = async (token: string, rawBody = body()) => ({
  authorization: `Bearer ${token}`,
  rawBody,
});
const unavailable = (error: unknown) =>
  error instanceof NativeActionError && error.kind === "temporarily_unavailable";

test("Google-signed-format RSA push verifies exact claims and returns only the four narrow signal fields", async () => {
  const f = fixture(),
    token = await jwt();
  const output = await f.verifier.verify(await signal(token), CONFIG);
  assert.deepEqual(output, {
    messageId: "fixture-pubsub-message",
    publishTime: "2026-10-17T23:59:00.123456Z",
    emailAddress: "owner@example.test",
    historyId: "100",
  });
  assert.equal(f.calls(), 1);
  assert.ok(!JSON.stringify(output).includes(token));
  assert.ok(!JSON.stringify(output).includes(CONFIG.pushServiceAccountEmail));
});
test("Google legacy issuer is allowed but issuer lookalikes are not", async () => {
  const f = fixture();
  await f.verifier.verify(await signal(await jwt({ iss: "accounts.google.com" })), CONFIG);
  for (const iss of [
    "https://accounts.google.com.evil.test",
    "http://accounts.google.com",
    "https://www.googleapis.com",
    "accounts.google.com/",
  ])
    await assert.rejects(
      f.verifier.verify(await signal(await jwt({ iss })), CONFIG),
      InvalidNativeEventSignal,
    );
});
test("JWT audience, service-account identity, booleans and required claims are exact", async () => {
  const patches: Obj[] = [
    { aud: "https://another.example.test/callback" },
    { aud: [CONFIG.callbackAudience, "https://another.example.test"] },
    { email: "another@fixture-project.iam.gserviceaccount.com" },
    { email_verified: false },
    { email_verified: "true" },
    { email_verified: undefined },
    { sub: undefined },
    { iat: undefined },
    { exp: undefined },
    { aud: undefined },
  ];
  const f = fixture();
  for (const patch of patches)
    await assert.rejects(
      f.verifier.verify(await signal(await jwt(patch)), CONFIG),
      InvalidNativeEventSignal,
    );
});
test("JWT rejects expired, future, old, fractional and inverted times", async () => {
  const patches: Obj[] = [
    { exp: SECONDS - 31 },
    { iat: SECONDS + 31 },
    { iat: SECONDS - 3931, exp: SECONDS + 3600 },
    { iat: SECONDS - 1.5 },
    { exp: SECONDS + 1.5 },
    { iat: SECONDS, exp: SECONDS - 1 },
  ];
  const f = fixture();
  for (const patch of patches)
    await assert.rejects(
      f.verifier.verify(await signal(await jwt(patch)), CONFIG),
      InvalidNativeEventSignal,
    );
  await f.verifier.verify(
    await signal(await jwt({ iat: SECONDS - 3600, exp: SECONDS + 60 })),
    CONFIG,
  );
});
test("JWT does not accept a forged RSA signature or an HMAC algorithm", async () => {
  const f = fixture();
  await assert.rejects(
    f.verifier.verify(await signal(await jwt({}, {}, rotated.privateKey)), CONFIG),
    InvalidNativeEventSignal,
  );
  const hmac = await jwt({}, { alg: "HS256" }, new Uint8Array(32).fill(65));
  const fresh = fixture();
  await assert.rejects(fresh.verifier.verify(await signal(hmac), CONFIG), InvalidNativeEventSignal);
  assert.equal(fresh.calls(), 0);
});
test("JWT jku/x5u/jwk headers never choose a network key authority", async () => {
  for (const header of [
    { jku: "https://unexpected.example.test/keys" },
    { x5u: "https://unexpected.example.test/cert" },
    { jwk: jwks.keys[0] },
    { x5c: ["fixture-certificate"] },
  ]) {
    const f = fixture();
    await assert.rejects(
      f.verifier.verify(await signal(await jwt({}, header)), CONFIG),
      InvalidNativeEventSignal,
    );
    assert.equal(f.calls(), 0);
  }
});
test("Malformed authorization and oversized inputs fail before any JWKS fetch", async () => {
  const f = fixture();
  for (const authorization of [
    undefined,
    null,
    "",
    "Bearer x",
    "bearer x.y.z",
    "Bearer x.y.z extra",
    `Bearer ${"a".repeat(17_000)}.a.a`,
  ])
    await assert.rejects(
      f.verifier.verify({ authorization, rawBody: body() }, CONFIG),
      InvalidNativeEventSignal,
    );
  await assert.rejects(
    f.verifier.verify(
      { authorization: `Bearer ${await jwt()}`, rawBody: "x".repeat(65 * 1024) },
      CONFIG,
    ),
    InvalidNativeEventSignal,
  );
  assert.equal(f.calls(), 0);
});
test("Pub/Sub subscription is exact and messageId is independent of Gmail identities", async () => {
  const f = fixture(),
    token = await jwt();
  await assert.rejects(
    f.verifier.verify(
      await signal(
        token,
        body(undefined, { subscription: "projects/another-project/subscriptions/gmail-push" }),
      ),
      CONFIG,
    ),
    InvalidNativeEventSignal,
  );
  const output = await f.verifier.verify(
    await signal(token, body({ emailAddress: "owner@example.test", historyId: "999" })),
    CONFIG,
  );
  assert.equal(output.messageId, "fixture-pubsub-message");
  assert.equal(output.historyId, "999");
});
test("Data permits only emailAddress/historyId and cannot smuggle message content or commands", async () => {
  const f = fixture(),
    token = await jwt();
  for (const data of [
    { emailAddress: "owner@example.test", historyId: "100", body: "private-body" },
    { emailAddress: "owner@example.test", historyId: "100", instructions: "untrusted instruction" },
    { emailAddress: "owner@example.test", historyId: "not-a-cursor" },
    { emailAddress: "not-an-email", historyId: "100" },
    { emailAddress: "owner@example.test" },
    ["owner@example.test", "100"],
  ])
    await assert.rejects(
      f.verifier.verify(await signal(token, body(data)), CONFIG),
      InvalidNativeEventSignal,
    );
});
test("Data decoding is bounded, canonical and UTF-8 checked", async () => {
  const f = fixture(),
    token = await jwt(),
    envelope = JSON.parse(body()) as { message: Obj; subscription: string };
  for (const data of [
    "%%%",
    "A",
    "SGVsbG8",
    Buffer.from([255]).toString("base64"),
    Buffer.from('{"emailAddress":"owner@example.test","historyId":"100"}x').toString("base64"),
  ]) {
    envelope.message.data = data;
    await assert.rejects(
      f.verifier.verify(await signal(token, JSON.stringify(envelope)), CONFIG),
      InvalidNativeEventSignal,
    );
  }
  envelope.message.data = Buffer.from(
    JSON.stringify({ emailAddress: "owner@example.test", historyId: "100" }),
  ).toString("base64url");
  await f.verifier.verify(await signal(token, JSON.stringify(envelope)), CONFIG);
});
test("Envelope requires standard metadata and strips accepted attributes rather than exposing them", async () => {
  const f = fixture(),
    token = await jwt(),
    envelope = JSON.parse(body()) as {
      message: Obj;
      subscription: string;
      deliveryAttempt?: number;
    };
  envelope.message.attributes = { fixture: "not-returned" };
  envelope.message.orderingKey = "fixture-order";
  envelope.deliveryAttempt = 2;
  const result = await f.verifier.verify(await signal(token, JSON.stringify(envelope)), CONFIG);
  assert.ok(!JSON.stringify(result).includes("not-returned"));
  for (const message of [
    { ...envelope.message, publishTime: "bad-time" },
    { ...envelope.message, messageId: undefined },
    { ...envelope.message, content: "private-body" },
  ])
    await assert.rejects(
      f.verifier.verify(await signal(token, JSON.stringify({ ...envelope, message })), CONFIG),
      InvalidNativeEventSignal,
    );
});
test("JWKS caches only within Google's Cache-Control/Age lifetime", async () => {
  const f = fixture({ headers: { "cache-control": "public, max-age=10", age: "5" } }),
    token = await jwt();
  await f.verifier.verify(await signal(token), CONFIG);
  await f.verifier.verify(await signal(token), CONFIG);
  assert.equal(f.calls(), 1);
  f.advance(5001);
  await f.verifier.verify(await signal(token), CONFIG);
  assert.equal(f.calls(), 2);
});
test("JWKS no-store does not become a long-lived trust cache", async () => {
  const f = fixture({ headers: { "cache-control": "no-store" } }),
    token = await jwt();
  await f.verifier.verify(await signal(token), CONFIG);
  await f.verifier.verify(await signal(token), CONFIG);
  assert.equal(f.calls(), 2);
});
test("JWKS key rotation refreshes only the fixed authority and unknown kid is cooled down", async () => {
  let next = jwks;
  const f = fixture({
    fetch: async () => Response.json(next, { headers: { "cache-control": "max-age=3600" } }),
  });
  await f.verifier.verify(await signal(await jwt()), CONFIG);
  next = rotatedJwks;
  f.advance(31_000);
  await f.verifier.verify(
    await signal(await jwt({}, { kid: "rotated-key" }, rotated.privateKey)),
    CONFIG,
  );
  assert.equal(f.calls(), 2);
  await assert.rejects(
    f.verifier.verify(
      await signal(await jwt({}, { kid: "unknown-key" }, rotated.privateKey)),
      CONFIG,
    ),
    InvalidNativeEventSignal,
  );
  assert.equal(f.calls(), 2);
});
test("JWKS concurrent loading is single-flight", async () => {
  let release: ((response: Response) => void) | undefined;
  const f = fixture({
    fetch: async () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  });
  const input = await signal(await jwt()),
    first = f.verifier.verify(input, CONFIG),
    second = f.verifier.verify(input, CONFIG);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls(), 1);
  assert.ok(release);
  release(Response.json(jwks, { headers: { "cache-control": "max-age=3600" } }));
  await Promise.all([first, second]);
});
test("JWKS outage does not reuse expired keys or cause unbounded retry fetches", async () => {
  let healthy = true;
  const f = fixture({
    fetch: async () =>
      healthy
        ? Response.json(jwks, { headers: { "cache-control": "max-age=5" } })
        : new Response("private-provider-body", { status: 503 }),
  });
  const input = await signal(await jwt());
  await f.verifier.verify(input, CONFIG);
  healthy = false;
  f.advance(6000);
  await assert.rejects(f.verifier.verify(input, CONFIG), (error) => {
    assert.ok(unavailable(error));
    assert.ok(!String(error).includes("private-provider-body"));
    return true;
  });
  await assert.rejects(f.verifier.verify(input, CONFIG), unavailable);
  assert.equal(f.calls(), 2);
});
test("JWKS redirects, invalid JSON, duplicate keys, private keys and oversized sets fail closed", async () => {
  const replies = [
    new Response(null, {
      status: 302,
      headers: { location: "https://unexpected.example.test/keys" },
    }),
    new Response("{malformed"),
    Response.json({ keys: [jwks.keys[0], jwks.keys[0]] }),
    Response.json({ keys: [{ ...jwks.keys[0], d: "must-not-accept-private-key" }] }),
    Response.json({ keys: jwks.keys, padding: "x".repeat(256 * 1024) }),
  ];
  for (const reply of replies) {
    const f = fixture({ fetch: async () => reply });
    await assert.rejects(f.verifier.verify(await signal(await jwt()), CONFIG), unavailable);
    assert.equal(f.calls(), 1);
  }
});
test("Invalid deployment verification configuration never invokes the key service", async () => {
  const f = fixture();
  for (const config of [
    { ...CONFIG, callbackAudience: "http://127.0.0.1/callback" },
    { ...CONFIG, pushServiceAccountEmail: "owner@example.test" },
    { ...CONFIG, subscriptionName: "https://unexpected.example.test/subscription" },
  ])
    await assert.rejects(
      f.verifier.verify(await signal(await jwt()), config),
      (error) => error instanceof NativeActionError && error.kind === "invalid_input",
    );
  assert.equal(f.calls(), 0);
});
test("Closing verifier prevents further trust-network operations", async () => {
  const f = fixture();
  await f.verifier.close();
  await assert.rejects(f.verifier.verify(await signal(await jwt()), CONFIG), unavailable);
  assert.equal(f.calls(), 0);
});
