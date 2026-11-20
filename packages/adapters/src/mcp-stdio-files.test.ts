import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  mcpCredentialFileSecrets,
  renderMcpStdioFile,
  renderMcpStdioTemplate,
  writeMcpStdioCredentialFiles,
} from "./mcp-stdio-files.js";

describe("managed stdio credential files", () => {
  const token = 'test"token\\with\nnewlines and {{oauth.scope}}';

  it("renders JSON, plain text and environment templates without interpreting injected text", () => {
    const values = { access_token: token, expires_at: "1770000000000" };
    expect(renderMcpStdioTemplate("Bearer {{oauth.access_token}}", values)).toBe(`Bearer ${token}`);
    expect(renderMcpStdioFile("token={{oauth.access_token}}", values)).toBe(`token=${token}`);
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

  it("collects complete files and credential values separately for redaction", () => {
    const json = JSON.stringify({ settings: { tokens: [token] } });
    expect(mcpCredentialFileSecrets(json)).toEqual([json, token]);
    const text = "[credentials]\nsecret = 'fixture-value'";
    expect(mcpCredentialFileSecrets(text)).toContain("fixture-value");
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
});
