import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repo = path.resolve(import.meta.dirname, "../../..");
const helper = path.join(repo, "scripts/install-ci-cjk-fonts.mjs");
const directories: string[] = [];
const mirror = "mirror+file:/etc/apt/apt-mirrors.txt";
const archive = "https://archive.ubuntu.com/ubuntu";
const runnerSources = [
  "# Keep comments and all non-URI fields.",
  "Types: deb",
  "URIs: " + mirror,
  "Suites: noble noble-updates noble-backports",
  "Components: main restricted universe multiverse",
  "Architectures: amd64",
  "Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg",
  "",
  "Types: deb",
  "uRiS: " + mirror,
  "Suites: noble-security",
  "Components: main restricted universe multiverse",
  "Signed-By:",
  " -----BEGIN PGP PUBLIC KEY BLOCK-----",
  " .",
  " URI text inside a key must stay unchanged: " + mirror,
  " -----END PGP PUBLIC KEY BLOCK-----",
  "",
].join("\n");

type Call = {
  name: string;
  args: string[];
  sourceFile?: string | null;
  source?: string | null;
  parts?: string | null;
  partFiles?: string[] | null;
  sourceMode?: number | null;
  directoryMode?: number | null;
  partsMode?: number | null;
};

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function shellQuote(value: string) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function workflowBody() {
  const lines = readFileSync(path.join(repo, ".github/workflows/repository-ci.yml"), "utf8").split(
    "\n",
  );
  const start = lines.findIndex((line) => line.trim() === "- name: Install Chromium and CJK fonts");
  const run = lines.findIndex((line, index) => index > start && line.trim() === "run: |");
  const body: string[] = [];
  for (const line of lines.slice(run + 1)) {
    if (!line.startsWith("          ")) break;
    body.push(line.slice(10));
  }
  expect(start).toBeGreaterThan(0);
  expect(run).toBeGreaterThan(start);
  return body.join("\n");
}

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "ci fonts script "));
  directories.push(root);
  const bin = path.join(root, "bin");
  const temporary = path.join(root, "temporary metadata");
  const source = path.join(root, "runner sources.sources");
  const trace = path.join(root, "calls.jsonl");
  for (const directory of [bin, temporary, path.join(root, "test-report/repository-ci")]) {
    mkdirSync(directory, { recursive: true });
  }
  const stub = [
    "#!" + process.execPath,
    "const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');",
    "const name=path.basename(process.argv[1]),args=process.argv.slice(2);",
    "if(name==='sudo'){if(args[0]!=='apt-get')process.exit(91);const r=cp.spawnSync(args[0],args.slice(1),{stdio:'inherit'});process.exit(r.status??92);}",
    "const call={name,args};",
    "if(name==='apt-get'){",
    " const option=k=>args.find(v=>v.startsWith(k+'='))?.slice(k.length+1)??null;",
    " call.sourceFile=option('Dir::Etc::sourcelist');call.parts=option('Dir::Etc::sourceparts');",
    " call.source=call.sourceFile?fs.readFileSync(call.sourceFile,'utf8'):null;",
    " call.partFiles=call.parts?fs.readdirSync(call.parts):null;",
    " call.sourceMode=call.sourceFile?fs.statSync(call.sourceFile).mode&511:null;",
    " call.directoryMode=call.sourceFile?fs.statSync(path.dirname(call.sourceFile)).mode&511:null;",
    " call.partsMode=call.parts?fs.statSync(call.parts).mode&511:null;",
    "}",
    "fs.appendFileSync(process.env.CI_FONT_TRACE,JSON.stringify(call)+'\\n');",
    "const fault=process.env.CI_FONT_FAULT;",
    "if(name==='apt-get'&&((args.at(-1)==='update'&&fault==='update')||(args.includes('install')&&fault==='install')))process.exit(42);",
    "if(name==='fc-match'){if(fault==='font')process.exit(43);console.log('Synthetic font boundary');}",
    "if(name==='pnpm'){if(JSON.stringify(args)!==JSON.stringify(['--filter','@rakazo/web','exec','playwright','install','chromium']))process.exit(93);if(fault==='browser')process.exit(44);}",
  ].join("\n");
  for (const name of ["sudo", "apt-get", "fc-match", "pnpm"]) {
    const file = path.join(bin, name);
    writeFileSync(file, stub);
    chmodSync(file, 0o755);
  }
  return {
    root,
    source,
    temporary,
    run(contents: string | null = runnerSources, fault = "", mask = "", helperArgs?: string[]) {
      if (contents === null) rmSync(source, { force: true });
      else writeFileSync(source, contents);
      const before = existsSync(source)
        ? { text: readFileSync(source, "utf8"), ino: statSync(source).ino }
        : null;
      const original =
        "node scripts/install-ci-cjk-fonts.mjs /etc/apt/sources.list.d/ubuntu.sources";
      const mapped = workflowBody().replace(
        original,
        [process.execPath, helper, ...(helperArgs ?? [source])].map(shellQuote).join(" "),
      );
      const result = spawnSync("bash", ["-c", (mask ? "umask " + mask + "\n" : "") + mapped], {
        cwd: root,
        env: {
          ...process.env,
          PATH: bin + path.delimiter + process.env.PATH,
          TMPDIR: temporary,
          CI_FONT_TRACE: trace,
          CI_FONT_FAULT: fault,
        },
        encoding: "utf8",
        timeout: 10_000,
      });
      if (result.error) throw result.error;
      const calls: Call[] = existsSync(trace)
        ? readFileSync(trace, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [];
      expect(readdirSync(temporary)).toEqual([]);
      if (before) {
        expect(readFileSync(source, "utf8")).toBe(before.text);
        expect(statSync(source).ino).toBe(before.ino);
      } else expect(existsSync(source)).toBe(false);
      return { ...result, calls };
    },
  };
}

describe("browser CI font source selection", () => {
  it("uses one private HTTPS source selection while preserving every other source byte", () => {
    const f = fixture();
    const result = f.run();
    expect(result.status).toBe(0);
    expect(result.calls.map((call) => call.name)).toEqual([
      "apt-get",
      "apt-get",
      "fc-match",
      "pnpm",
    ]);
    const [update, install] = result.calls;
    const expected = runnerSources.replace(
      /^([Uu][Rr][Ii][Ss]: )mirror\+file:\/etc\/apt\/apt-mirrors\.txt/gm,
      "$1" + archive,
    );
    for (const call of [update!, install!]) {
      expect(call.sourceFile).not.toBeNull();
      expect(call.sourceFile).toMatch(/\.sources$/);
      expect(call.source).toBe(expected);
      expect(call.parts).not.toBeNull();
      expect(call.partFiles).toEqual([]);
      expect(call.sourceMode).toBe(0o644);
      expect(call.directoryMode).toBe(0o755);
      expect(call.partsMode).toBe(0o755);
      expect(call.args).toEqual(
        expect.arrayContaining([
          "Acquire::Retries=2",
          "Acquire::http::Timeout=20",
          "Acquire::https::Timeout=20",
          "APT::Get::List-Cleanup=0",
        ]),
      );
      expect(call.args.join(" ")).not.toMatch(
        /allow-unauthenticated|AllowInsecure|Verify-Peer=false/,
      );
      expect(existsSync(call.sourceFile!)).toBe(false);
      expect(existsSync(call.parts!)).toBe(false);
    }
    expect(update!.sourceFile).toBe(install!.sourceFile);
    expect(update!.parts).toBe(install!.parts);
    expect(update!.args.at(-1)).toBe("update");
    expect(install!.args.slice(-4)).toEqual([
      "install",
      "--yes",
      "--no-install-recommends",
      "fonts-noto-cjk",
    ]);
  });

  it("preserves CRLF and an absent final newline outside URI values", () => {
    const contents = runnerSources.replaceAll("\n", "\r\n").replace(/\r\n$/, "");
    const result = fixture().run(contents);
    expect(result.status).toBe(0);
    expect(result.calls[0]!.source).toBe(
      contents.replace(
        /^([Uu][Rr][Ii][Ss]: )mirror\+file:\/etc\/apt\/apt-mirrors\.txt/gm,
        "$1" + archive,
      ),
    );
  });

  it("makes temporary configuration readable without permitting other writers under a restrictive umask", () => {
    const result = fixture().run(runnerSources, "", "077");
    expect(result.status).toBe(0);
    for (const call of result.calls.filter((entry) => entry.name === "apt-get")) {
      expect(call.sourceMode).toBe(0o644);
      expect(call.directoryMode).toBe(0o755);
      expect(call.partsMode).toBe(0o755);
    }
  });

  it.each(["missing", "extra"])("rejects %s input arguments before package actions", (kind) => {
    const f = fixture();
    const result = f.run(runnerSources, "", "", kind === "missing" ? [] : [f.source, "extra"]);
    expect(result.status).not.toBe(0);
    expect(result.calls).toEqual([]);
  });

  it.each([
    ["unknown URI", runnerSources.replace(mirror, "https://example.invalid/ubuntu")],
    [
      "multiple URI values",
      runnerSources.replace(mirror, mirror + " https://archive.ubuntu.com/ubuntu"),
    ],
    [
      "folded URI",
      runnerSources.replace("Suites: noble ", " https://archive.ubuntu.com/ubuntu\nSuites: noble "),
    ],
    [
      "duplicate URI in one stanza",
      runnerSources.replace("Suites: noble ", "URIs: " + mirror + "\nSuites: noble "),
    ],
    [
      "a later unsupported stanza",
      runnerSources.replace("uRiS: " + mirror, "uRiS: https://example.invalid/ubuntu"),
    ],
    ["no URI fields", "# no active fields\n"],
  ])("rejects %s before any package or browser action", (_label, contents) => {
    const result = fixture().run(contents);
    expect(result.status).not.toBe(0);
    expect(result.calls).toEqual([]);
  });

  it("rejects a missing runner source before package actions", () => {
    const result = fixture().run(null);
    expect(result.status).not.toBe(0);
    expect(result.calls).toEqual([]);
  });

  it.each([
    ["update", 42, ["apt-get"]],
    ["install", 42, ["apt-get", "apt-get"]],
    ["font", 43, ["apt-get", "apt-get", "fc-match"]],
    ["browser", 44, ["apt-get", "apt-get", "fc-match", "pnpm"]],
  ] as const)(
    "propagates a nonzero %s failure and removes only its temporary configuration",
    (fault, status, names) => {
      const result = fixture().run(runnerSources, fault);
      expect(result.status).toBe(status);
      expect(result.calls.map((call) => call.name)).toEqual(names);
    },
  );
});
