import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseAllDocuments } from "yaml";
import { redactConnectorPayload } from "./connector-safety.js";
import {
  mcpCredentialFileSecrets,
  renderMcpStdioFile,
  renderMcpStdioTemplate,
  writeMcpStdioCredentialFiles,
} from "./mcp-stdio-files.js";

vi.mock("node:fs/promises", { spy: true });

describe("managed stdio credential files", () => {
  const token = 'test"token\\with\nnewlines and {{oauth.scope}}';

  it("renders JSON, plain text and environment templates without interpreting injected text", () => {
    const values = { access_token: token, expires_at: "1770000000000" };
    expect(renderMcpStdioTemplate("Bearer {{oauth.access_token}}", values)).toBe(`Bearer ${token}`);
    expect(renderMcpStdioFile("token={{oauth.access_token}}", values)).toBe(`token=${token}`);
    expect(JSON.parse(renderMcpStdioFile('"{{oauth.access_token}}"', values))).toBe(token);
    expect(
      JSON.parse(
        renderMcpStdioFile(
          '{"access":"{{oauth.access_token}}","expires":{{oauth.expires_at}}}',
          values,
        ),
      ),
    ).toEqual({ access: token, expires: 1770000000000 });
  });

  it("rejects missing fields, bare JSON strings, and partial numeric substitution", () => {
    expect(() => renderMcpStdioTemplate("{{oauth.refresh_token}}", {})).toThrow(/unavailable/);
    expect(() =>
      renderMcpStdioFile('{"token":{{oauth.access_token}}}', { access_token: token }),
    ).toThrow(/inside strings/);
    expect(() =>
      renderMcpStdioFile('{"expires":1{{oauth.expires_at}}}', { expires_at: "1770000000000" }),
    ).toThrow(/inside strings/);
  });

  it("renders YAML credential scalars without letting injected text change the document", () => {
    const template = [
      "# keep this configuration",
      "single: &secret '{{oauth.client_secret}}' # keep anchor",
      'double: "prefix {{oauth.client_secret}} suffix"',
      "plain: {{oauth.access_token}}",
      "folded: >- # keep block note",
      "  before {{oauth.client_secret}}",
      "  after",
      "alias: *secret",
      "expiration: {{oauth.expires_at}}",
      'quotedExpiry: "{{oauth.expires_at}}"',
      "---",
      "mode: true",
      "",
    ].join("\n");
    const secret = "quote:'\"\\value\n---\nentry: false\nmcp_oauth_field_0_";
    const rendered = renderMcpStdioFile(template, {
      client_secret: secret,
      access_token: "false",
      expires_at: "1770000000000",
    });
    expect(parseAllDocuments(rendered).map((document) => document.toJS())).toEqual([
      {
        single: secret,
        double: `prefix ${secret} suffix`,
        plain: "false",
        folded: `before ${secret} after`,
        alias: secret,
        expiration: 1770000000000,
        quotedExpiry: "1770000000000",
      },
      { mode: true },
    ]);
    expect(rendered).toContain("# keep this configuration");
    expect(rendered).toContain("# keep anchor");
    expect(rendered).toContain("# keep block note");
    expect(mcpCredentialFileSecrets(rendered)).toContain(secret);
  });

  it("rejects YAML references outside materialized scalars", () => {
    expect(() =>
      renderMcpStdioFile("token: fixture # {{oauth.client_secret}}\n", { client_secret: token }),
    ).toThrow("MCP YAML credentials require OAuth values inside scalars");
    expect(() =>
      renderMcpStdioFile("token: {{oauth.access_token}}\n---\n{{oauth.refresh_token}}\n", {
        access_token: "fixture\nextra: confirmed",
        refresh_token: "next: fixture",
      }),
    ).toThrow("MCP YAML credentials require OAuth values inside scalars");
    expect(
      renderMcpStdioFile("[credentials]\nsecret='{{oauth.client_secret}}'\n", {
        client_secret: "fixture-value",
      }),
    ).toBe("[credentials]\nsecret='fixture-value'\n");
  });

  it("collects complete files and credential values separately for redaction", () => {
    const json = JSON.stringify({ settings: { tokens: [token] } });
    expect(mcpCredentialFileSecrets(json)).toEqual([json, token]);
    const text = "[credentials]\nsecret = 'fixture-value'";
    expect(mcpCredentialFileSecrets(text)).toContain("fixture-value");
    const mixed = JSON.stringify({
      credentials: { key: "fixture-private", enabled: true },
      kind: "object",
      port: 443,
    });
    expect(mcpCredentialFileSecrets(mixed).sort()).toEqual(
      [mixed, "fixture-private", "true", "object", "443"].sort(),
    );
    const yaml =
      'username: fixture-user\npassword: "line\\nbreak"\ncredential: |-\n  line one\n  line two';
    expect(mcpCredentialFileSecrets(yaml)).toEqual(
      expect.arrayContaining([yaml, "fixture-user", "line\nbreak", "line one\nline two"]),
    );
    expect(mcpCredentialFileSecrets('export VALUE="fixture with spaces" # comment')).toContain(
      "fixture with spaces",
    );
    expect(mcpCredentialFileSecrets('VALUE="fixture\\nline"')).toContain("fixture\nline");
    expect(mcpCredentialFileSecrets('{"instruction":"Basic user"}')).not.toContain("user");
    expect(mcpCredentialFileSecrets("KEY=fixture-value")).toContain("fixture-value");
    expect(mcpCredentialFileSecrets('KEY="fixture-value"#comment')).toContain("fixture-value");
    expect(mcpCredentialFileSecrets("KEY=fixture-value#comment")).toContain("fixture-value");
  });

  it.each([
    ["fixture-key", "fixture-secret"],
    ["fixture-key", ""],
    ["", "fixture-secret"],
  ])("retains nonempty Basic credential parts for redaction", (username, password) => {
    const encoded = Buffer.from(`${username}:${password}`).toString("base64");
    const authorization = `Basic ${encoded}`;
    const file = JSON.stringify({ authorization });
    expect(mcpCredentialFileSecrets(file)).toEqual([
      file,
      authorization,
      encoded,
      ...[username, password].filter(Boolean),
    ]);
  });

  it("retains lossless numeric credential text in JSON and YAML", () => {
    expect(mcpCredentialFileSecrets('{"code":9007199254740993,"label":1e+7}')).toEqual(
      expect.arrayContaining(["9007199254740993", "9007199254740992", "1e+7", "10000000"]),
    );
    expect(mcpCredentialFileSecrets("code: 9007199254740993\nlabel: 1e+7")).toEqual(
      expect.arrayContaining(["9007199254740993", "9007199254740992", "1e+7", "10000000"]),
    );
  });

  it("keeps multiline quoted assignments and parses the following assignment", () => {
    const value = "first fixture line\n  next line\n# retained inside the value";
    for (const quote of ['"', "'", "`"]) {
      const content = `FILE_VALUE=${quote}${value}${quote} # comment\nANOTHER=fixture-two`;
      expect(mcpCredentialFileSecrets(content)).toEqual(
        expect.arrayContaining([value, "fixture-two"]),
      );
    }
    expect(() => mcpCredentialFileSecrets('VALUE="open\nOTHER=fixture-two')).toThrow(
      /Unsupported MCP credential file format/,
    );
  });

  it("masks separate cookie values echoed from named credential fields", () => {
    const file = JSON.stringify({
      headers: {
        Cookie: ['session="fixture%2Fprivate"; auxiliary=fixture-second; session=fixture-third'],
        "Set-Cookie": ["login=fixture-login; Path=/public; HttpOnly"],
      },
      session: "sid=fixture-session",
      documentation: "key=fixture-example",
    });
    const secrets = mcpCredentialFileSecrets(file);
    expect(secrets).toEqual(
      expect.arrayContaining([
        "fixture%2Fprivate",
        "fixture/private",
        "fixture-second",
        "fixture-third",
        "fixture-login",
        "fixture-session",
      ]),
    );
    expect(secrets).not.toContain("/public");
    expect(secrets).not.toContain("fixture-example");
    const result = {
      content: [
        { type: "text", text: "fixture/private fixture-second fixture-session fixture-example" },
      ],
    };
    expect(redactConnectorPayload(result, secrets, "mcp-result")).toEqual({
      content: [{ type: "text", text: "[redacted] [redacted] [redacted] fixture-example" }],
    });
    expect(mcpCredentialFileSecrets("headers:\n  Cookie: |\n    session=fixture-yaml\n")).toContain(
      "fixture-yaml",
    );
    const longValue = "z".repeat(4_200);
    expect(mcpCredentialFileSecrets(JSON.stringify({ Cookie: `session=${longValue}` }))).toContain(
      longValue,
    );
    expect(mcpCredentialFileSecrets('[credentials]\nAPP_COOKIE="sid=fixture-env"')).toContain(
      "fixture-env",
    );
    expect(mcpCredentialFileSecrets('Session: "sid=fixture-yaml-session"')).toContain(
      "fixture-yaml-session",
    );
    expect(mcpCredentialFileSecrets('{"sessionTimeout":"mode=fixture-config"}')).not.toContain(
      "fixture-config",
    );
  });

  it("writes same-name files into distinct private directories and cleans up only its launch", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-files-fixture-"));
    const signal = new AbortController().signal;
    try {
      const [first, second] = await Promise.all([
        writeMcpStdioCredentialFiles({ CONFIG_FILE: "first" }, signal, root),
        writeMcpStdioCredentialFiles({ CONFIG_FILE: "second" }, signal, root),
      ]);
      const firstPath = first.env.CONFIG_FILE!;
      const secondPath = second.env.CONFIG_FILE!;
      expect(dirname(firstPath)).not.toBe(dirname(secondPath));
      expect((await stat(dirname(firstPath))).mode & 0o777).toBe(0o700);
      expect((await stat(firstPath)).mode & 0o777).toBe(0o600);
      expect(await readFile(firstPath, "utf8")).toBe("first");
      expect(await readFile(secondPath, "utf8")).toBe("second");
      await Promise.all([first.remove(), first.remove()]);
      await expect(stat(firstPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(secondPath, "utf8")).toBe("second");
      await second.remove();
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves no directory on invalid names or cancellation before writing", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-files-fixture-"));
    try {
      await expect(
        writeMcpStdioCredentialFiles({ "../FILE": token }, new AbortController().signal, root),
      ).rejects.toThrow(/Invalid MCP credential files/);
      await expect(
        writeMcpStdioCredentialFiles({ CONFIG_FILE: token }, AbortSignal.abort(), root),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retries cleanup of an already written file when a later write fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-partial-fixture-"));
    const actualWrite = vi.mocked(writeFile).getMockImplementation()!;
    vi.mocked(writeFile)
      .mockImplementationOnce(actualWrite)
      .mockRejectedValueOnce(new Error("fixture disk write failure"));
    vi.mocked(rm).mockRejectedValueOnce(new Error("fixture first removal failure"));
    try {
      await expect(
        writeMcpStdioCredentialFiles(
          { FIRST: "fixture", SECOND: "fixture" },
          new AbortController().signal,
          root,
        ),
      ).rejects.toThrow("Could not write MCP credential files");
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an unsupported credential grammar before creating a directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-unsupported-fixture-"));
    try {
      for (const content of [
        "machine host.example.test login synthetic password fixture-value",
        "host.example.test:5432:fixture:synthetic:fixture-value",
        "<credential>fixture-value</credential>",
        "Bearer fixture:fixture-value",
      ]) {
        await expect(
          writeMcpStdioCredentialFiles(
            { CONFIG_FILE: content },
            new AbortController().signal,
            root,
          ),
        ).rejects.toThrow("Unsupported MCP credential file format");
      }
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
