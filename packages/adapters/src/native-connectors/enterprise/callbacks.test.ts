import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import { describe, it } from "vitest";
import type { EnterpriseCallbackConfig, EnterpriseCallbackInput } from "./callbacks.js";
import { verifyEnterpriseCallback } from "./callbacks.js";

const now = 1_800_000_000_000,
  timestamp = String(now / 1000),
  nonce = "fixture-nonce",
  key = Buffer.alloc(32, 42),
  wecom: EnterpriseCallbackConfig = {
    appId: "wecom",
    clientId: "suite-fixture",
    verificationToken: "fixture-verify",
    encryptionKey: key.toString("base64").slice(0, -1),
  },
  feishu: EnterpriseCallbackConfig = {
    appId: "feishu-lark",
    clientId: "app-fixture",
    region: "feishu",
    verificationToken: "fixture-verify",
    encryptionKey: "fixture-encryption",
  };
function wx(body: string, receiveId = "suite-fixture", challenge = false): EnterpriseCallbackInput {
  const payload = Buffer.from(body),
    size = Buffer.alloc(4);
  size.writeUInt32BE(payload.length);
  let plain = Buffer.concat([Buffer.alloc(16, 7), size, payload, Buffer.from(receiveId)]);
  const pad = 32 - (plain.length % 32);
  plain = Buffer.concat([plain, Buffer.alloc(pad, pad)]);
  const c = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  c.setAutoPadding(false);
  const cipher = Buffer.concat([c.update(plain), c.final()]).toString("base64"),
    signature = createHash("sha1")
      .update([wecom.verificationToken, timestamp, nonce, cipher].sort().join(""))
      .digest("hex");
  return {
    query: {
      timestamp,
      nonce,
      msg_signature: signature,
      ...(challenge ? { echostr: cipher } : {}),
    },
    ...(!challenge ? { rawBody: `<xml><Encrypt><![CDATA[${cipher}]]></Encrypt></xml>` } : {}),
  };
}
function lark(body: Record<string, unknown>, signed = true): EnterpriseCallbackInput {
  const iv = Buffer.alloc(16, 8),
    c = createCipheriv(
      "aes-256-cbc",
      createHash("sha256").update(feishu.encryptionKey).digest(),
      iv,
    ),
    encrypt = Buffer.concat([iv, c.update(JSON.stringify(body)), c.final()]).toString("base64"),
    rawBody = JSON.stringify({ encrypt });
  return {
    rawBody,
    ...(signed
      ? {
          headers: {
            "x-lark-request-timestamp": timestamp,
            "x-lark-request-nonce": nonce,
            "x-lark-signature": createHash("sha256")
              .update(timestamp + nonce + feishu.encryptionKey + rawBody)
              .digest("hex"),
          },
        }
      : {}),
  };
}
const ticketXML = `<xml><SuiteId>suite-fixture</SuiteId><InfoType>suite_ticket</InfoType><TimeStamp>${timestamp}</TimeStamp><SuiteTicket><![CDATA[fixture-ticket]]></SuiteTicket></xml>`;
const ticketJSON = {
  schema: "2.0",
  header: {
    app_id: "app-fixture",
    event_type: "application.app_ticket",
    create_time: timestamp,
    token: "fixture-verify",
    event_id: "fixture-event",
  },
  event: { app_ticket: "fixture-ticket" },
};
describe("Enterprise callback verified protocol facts", () => {
  it("decrypts and verifies real WeCom AES CBC SHA1 ticket envelope", () => {
    const result = verifyEnterpriseCallback(wecom, wx(ticketXML), now);
    assert.equal(result.type, "ticket");
    if (result.type !== "ticket") throw Error();
    assert.equal(result.ticket, "fixture-ticket");
    assert.equal(result.appId, "suite-fixture");
    assert.equal(result.issuedAt, now / 1000);
  });
  it("returns WeCom encrypted echo without inventing an installation", () => {
    assert.deepEqual(
      verifyEnterpriseCallback(wecom, wx("fixture-echo", "suite-fixture", true), now),
      { type: "challenge", challenge: "fixture-echo" },
    );
  });
  it("rejects valid cipher intended for a different receiver", () => {
    assert.throws(() => verifyEnterpriseCallback(wecom, wx(ticketXML, "other-suite"), now));
  });
  it("rejects application mismatch inside a signed WeCom payload", () => {
    assert.throws(() =>
      verifyEnterpriseCallback(
        wecom,
        wx(ticketXML.replace("<SuiteId>suite-fixture", "<SuiteId>other-suite")),
        now,
      ),
    );
  });
  it("rejects stale signed callbacks before decrypting", () => {
    assert.throws(() => verifyEnterpriseCallback(wecom, wx(ticketXML), now + 301000));
  });
  it("rejects forged signature and mutated ciphertext", () => {
    const input = wx(ticketXML);
    input.query!.msg_signature = "0".repeat(40);
    assert.throws(() => verifyEnterpriseCallback(wecom, input, now));
  });
  it("rejects DTD and duplicate XML identity fields even with valid provider crypto", () => {
    for (const body of [
      ticketXML.replace("<xml>", "<!DOCTYPE xml [<!ENTITY x SYSTEM 'file:///synthetic'>]><xml>"),
      ticketXML.replace("</xml>", "<SuiteId>suite-fixture</SuiteId></xml>"),
    ])
      assert.throws(() => verifyEnterpriseCallback(wecom, wx(body), now));
  });
  it("reports signed create_auth as facts without requiring a fabricated corp id", () => {
    const xml = `<xml><SuiteId>suite-fixture</SuiteId><InfoType>create_auth</InfoType><TimeStamp>${timestamp}</TimeStamp><AuthCode>fixture-auth-code</AuthCode></xml>`,
      result = verifyEnterpriseCallback(wecom, wx(xml), now);
    assert.equal(result.type, "installation");
    if (result.type !== "installation") throw Error();
    assert.equal(result.action, "create");
    assert.equal(result.tenantId, undefined);
    assert.equal(result.authorizationCode, "fixture-auth-code");
  });
  for (const kind of ["change_auth", "cancel_auth"])
    it(`returns exact corp for ${kind}`, () => {
      const xml = `<xml><SuiteId>suite-fixture</SuiteId><InfoType>${kind}</InfoType><TimeStamp>${timestamp}</TimeStamp><AuthCorpId>corp-fixture</AuthCorpId></xml>`,
        result = verifyEnterpriseCallback(wecom, wx(xml), now);
      assert.equal(result.type, "installation");
      if (result.type !== "installation") throw Error();
      assert.equal(result.tenantId, "corp-fixture");
      assert.equal(result.action, kind === "cancel_auth" ? "cancel" : "change");
    });
  it("decrypts and verifies Feishu v2 app ticket with SHA256 signature", () => {
    const result = verifyEnterpriseCallback(feishu, lark(ticketJSON), now);
    assert.equal(result.type, "ticket");
    if (result.type !== "ticket") throw Error();
    assert.equal(result.ticket, "fixture-ticket");
    assert.equal(result.eventId, "fixture-event");
  });
  it("supports explicit Lark regional configuration with same authenticated protocol", () => {
    assert.equal(
      verifyEnterpriseCallback({ ...feishu, region: "lark" }, lark(ticketJSON), now).type,
      "ticket",
    );
  });
  it("answers encrypted Feishu URL challenge only after token decryption", () => {
    assert.deepEqual(
      verifyEnterpriseCallback(
        feishu,
        lark(
          { type: "url_verification", token: "fixture-verify", challenge: "fixture-challenge" },
          false,
        ),
        now,
      ),
      { type: "challenge", challenge: "fixture-challenge" },
    );
  });
  it("rejects plaintext challenge and wrong decrypted verification token", () => {
    assert.throws(() =>
      verifyEnterpriseCallback(
        feishu,
        {
          rawBody: JSON.stringify({
            type: "url_verification",
            token: "fixture-verify",
            challenge: "x",
          }),
        },
        now,
      ),
    );
    assert.throws(() =>
      verifyEnterpriseCallback(
        feishu,
        lark({ type: "url_verification", token: "wrong", challenge: "x" }),
        now,
      ),
    );
  });
  it("rejects missing Feishu ticket signature and a signed different app", () => {
    assert.throws(() => verifyEnterpriseCallback(feishu, lark(ticketJSON, false), now));
    assert.throws(() =>
      verifyEnterpriseCallback(
        feishu,
        lark({ ...ticketJSON, header: { ...ticketJSON.header, app_id: "other-app" } }),
        now,
      ),
    );
  });
  it("does not consume existing Feishu message event stream", () => {
    assert.throws(() =>
      verifyEnterpriseCallback(
        feishu,
        lark({
          ...ticketJSON,
          header: { ...ticketJSON.header, event_type: "im.message.receive_v1" },
        }),
        now,
      ),
    );
  });
  it("rejects Feishu stale signature and overbound callback bodies", () => {
    assert.throws(() => verifyEnterpriseCallback(feishu, lark(ticketJSON), now + 301000));
    assert.throws(() => verifyEnterpriseCallback(feishu, { rawBody: "x".repeat(262145) }, now));
  });
});
