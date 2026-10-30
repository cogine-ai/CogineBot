import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];
const runningScripts = new Set<{ pid: number; done: Promise<unknown> }>();
const source = readFileSync(
  path.resolve(import.meta.dirname, "../../../infra/compose/firewall-change.sh"),
  "utf8",
);
const token = "12345678-1234-4234-8234-123456789abc";
const firstConnection = "192.0.2.10 12345 192.0.2.20 22";
const secondConnection = "192.0.2.10 12346 192.0.2.20 22";

function signalGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
async function waitForFile(file: string) {
  const deadline = Date.now() + 5_000;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error("Fixture did not reach its ready gate");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
afterEach(async () => {
  for (const running of runningScripts) signalGroup(running.pid, "SIGKILL");
  for (const running of runningScripts) await running.done;
  runningScripts.clear();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function write(file: string, contents: string, mode = 0o600) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents, { mode });
  chmodSync(file, mode);
}

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "firewall-script-"));
  temporaryDirectories.push(root);
  const base = path.join(root, "state");
  const state = path.join(base, "firewall-change");
  const etc = path.join(root, "etc");
  const bin = path.join(root, "bin");
  const script = path.join(bin, "firewall-change");
  const log = path.join(root, "calls.jsonl");
  const faults = path.join(root, "faults.json");
  const manager = path.join(root, "manager.json");
  for (const directory of [base, etc, path.join(etc, "ufw"), path.join(etc, "default"), bin]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  write(path.join(etc, "ufw", "user.rules"), "original rules\n");
  write(path.join(etc, "default", "ufw"), "ENABLED=yes\n");
  write(faults, "{}");
  write(manager, "{}");
  // Only host paths and the root admission predicate are instrumented. All state,
  // locking, token, command and publication logic executes unchanged against fixtures.
  const replacements = new Map([
    [`[[ "\${EUID}" == 0 ]]`, `[[ "\${EUID}" == "\${UID}" ]]`],
    ["BASE=/var/lib/rakazo", `BASE=${JSON.stringify(base)}`],
    ["ETC=/etc", `ETC=${JSON.stringify(etc)}`],
    ["SELF=/usr/local/sbin/rakazo-firewall-change", `SELF=${JSON.stringify(script)}`],
    ["BIN=/usr/local/sbin", `BIN=${JSON.stringify(bin)}`],
    ["for directory in /var /var/lib;", `for directory in ${JSON.stringify(root)};`],
  ]);
  let instrumented = source;
  for (const [before, after] of replacements) {
    expect(instrumented.split(before)).toHaveLength(2);
    instrumented = instrumented.replace(before, after);
  }
  write(script, instrumented, 0o755);
  const stub = `#!${process.execPath}
const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');
const name=path.basename(process.argv[1]),args=process.argv.slice(2),fault=JSON.parse(fs.readFileSync(process.env.FW_FAULTS,'utf8'));
fs.appendFileSync(process.env.FW_LOG,JSON.stringify([name,...args])+'\\n');
const state=()=>JSON.parse(fs.readFileSync(process.env.FW_MANAGER,'utf8'));
const save=s=>fs.writeFileSync(process.env.FW_MANAGER,JSON.stringify(s));
const bad=(key)=>fault[key]===true;
if(name==='stat'){
 const file=args.at(-1),s=fs.lstatSync(file),mode=(s.mode&0o7777).toString(8),owner=fault.owner===file?99:0,format=args[1];
 process.stdout.write(format==='%a'?mode+'\\n':format==='%u'?owner+'\\n':format==='%u %h'?owner+' '+s.nlink+'\\n':owner+' '+mode+(format.includes('%h')?' '+s.nlink:'')+'\\n');
}else if(name==='find'){
 if(bad('findFail'))process.exit(1);
 const visit=f=>{const s=fs.lstatSync(f);if(s.isSymbolicLink()||(!s.isFile()&&!s.isDirectory())||(s.mode&0o022)||fault.owner===f)return f;
 if(s.isDirectory())for(const n of fs.readdirSync(f)){const found=visit(path.join(f,n));if(found)return found;}};
 for(const f of args.slice(0,2)){const found=visit(f);if(found){console.log(found);break;}}
}else if(name==='cat'){
 if(args[0]==='/proc/sys/kernel/random/uuid')console.log(fault.uuid||'${token}');
 else if(args[0]==='/proc/self/mountinfo'){
  if(bad('mountReadFail'))process.exit(1);
  if(fault.mountInfo!==undefined)process.stdout.write(fault.mountInfo);
  else console.log('1 0 8:1 / '+(fault.mountPath||'/')+' rw - ext4 /dev/fixture rw');
 }else fs.writeFileSync(1,fs.readFileSync(args[0]??0));
}else if(name==='df'){
 if(bad('dfFail'))process.exit(1);
 process.stdout.write('Filesystem 1024-blocks Used Available Capacity Mounted on\\nfixture 999999 0 '+(fault.free??'102400')+' 0% /fixture\\n'+(fault.dfExtra?'extra\\n':''));
}else if(name==='tar'){
 if((args[0]==='-cpf'&&bad('tarFail'))||(args.includes('-xpf')&&bad('restoreFail')))process.exit(2);
 if(args[0]==='-tf'&&fault.members){process.stdout.write(fault.members);process.exit(0);}
 if(args[0]==='-tvf'&&bad('archiveLink')){console.log('lrwxrwxrwx link');process.exit(0);}
 const actual=[...args];if(actual.includes('--recursive-unlink')&&process.platform==='darwin'){
  const target=actual[actual.indexOf('-C')+1];if(target!==process.env.FW_ETC)process.exit(98);
  fs.rmSync(path.join(target,'ufw'),{recursive:true,force:true});actual.splice(actual.indexOf('--recursive-unlink'),1);
 }
 const r=cp.spawnSync('/usr/bin/tar',actual,{stdio:'inherit'});process.exit(r.status??1);
}else if(name==='mv'){
 const from=args.at(-2),to=args.at(-1),match=fault.mvTarget&&to.endsWith('/'+fault.mvTarget);
 if(match&&bad('mvBefore'))process.exit(1);fs.renameSync(from,to);if(match&&bad('mvAfter'))process.exit(1);
}else if(name==='rm'){
 for(const file of args.filter(a=>!a.startsWith('-'))){const match=fault.rmTarget&&file.endsWith('/'+fault.rmTarget);if(match&&bad('rmBefore'))process.exit(1);fs.rmSync(file,{force:true});if(match&&bad('rmAfter'))process.exit(1);}
}else if(name==='ufw'){
 if(args[0]==='status')console.log(fault.ufwStatus||'Status: active');else if(bad('ufwFail'))process.exit(1);
}else if(name==='systemd-run'){
 const unit=args.find(a=>a.startsWith('--unit=')).slice(7);if(bad('scheduleBefore'))process.exit(1);
 const s=state();s[unit+'.timer']=fault.timerState||'active';save(s);if(bad('scheduleAfter'))process.exit(1);
}else if(name==='systemctl'){
 const s=state();if(args[0]==='show')console.log(s[args[1]]||'inactive');
 else if(args[0]==='stop'){if(bad('stopBefore'))process.exit(1);s[args[1]]='inactive';save(s);if(bad('stopAfter'))process.exit(1);}
}else if(name==='install'){
 const mode=parseInt(args[args.indexOf('-m')+1],8);if(args.includes('-d'))fs.mkdirSync(args.at(-1),{recursive:true,mode});else{fs.copyFileSync(args.at(-2),args.at(-1));fs.chmodSync(args.at(-1),mode);}
}else if(['id','apt-get','sshd','sysctl','augenrules'].includes(name)){
}else if(name==='logger'){if(bad('loggerFail'))process.exit(1);}else process.exit(99);
`;
  for (const command of [
    "stat",
    "find",
    "cat",
    "df",
    "tar",
    "mv",
    "rm",
    "ufw",
    "systemd-run",
    "systemctl",
    "logger",
    "install",
    "id",
    "apt-get",
    "sshd",
    "sysctl",
    "augenrules",
  ])
    write(path.join(bin, command), stub, 0o755);
  write(
    path.join(bin, "flock"),
    `#!/usr/bin/env python3
import fcntl,sys,os,time
from pathlib import Path
if os.environ.get('FW_FLOCK_WAITING'): Path(os.environ['FW_FLOCK_WAITING']).write_text('ready')
while os.environ.get('FW_FLOCK_RELEASE') and not Path(os.environ['FW_FLOCK_RELEASE']).exists(): time.sleep(0.01)
try: fcntl.flock(9,fcntl.LOCK_EX|(fcntl.LOCK_NB if '-n' in sys.argv else 0))
except BlockingIOError: raise SystemExit(1)
`,
    0o755,
  );
  write(
    path.join(bin, "timeout"),
    `#!/usr/bin/env python3
import os,sys
assert sys.argv[1:3]==['--kill-after=5s','120s']
os.execvp(sys.argv[3],sys.argv[3:])
`,
    0o755,
  );
  const env = {
    PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    FW_FAULTS: faults,
    FW_LOG: log,
    FW_MANAGER: manager,
    FW_ETC: etc,
    SSH_CONNECTION: firstConnection,
    PYTHONDONTWRITEBYTECODE: "1",
  };
  return {
    root,
    base,
    state,
    etc,
    bin,
    script,
    env,
    faults: (value: Record<string, unknown>) => write(faults, JSON.stringify(value)),
    calls: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as string[])
        : [],
    read: (file: string) => readFileSync(path.join(state, file), "utf8").trim(),
    run: (args: string[], overrides: Record<string, string> = {}) =>
      spawnSync("/bin/bash", [script, ...args], {
        env: { ...env, ...overrides },
        encoding: "utf8",
        timeout: 10_000,
      }),
    start: (args: string[], overrides: Record<string, string> = {}) => {
      const child = spawn("/bin/bash", [script, ...args], {
        env: { ...env, ...overrides },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [],
        stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      const done = new Promise<{
        status: number | null;
        signal: NodeJS.Signals | null;
        stdout: string;
        stderr: string;
      }>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (status, signal) =>
          resolve({
            status,
            signal,
            stdout: Buffer.concat(stdout).toString(),
            stderr: Buffer.concat(stderr).toString(),
          }),
        );
      });
      if (!child.pid) throw new Error("Fixture process did not start");
      const running = { pid: child.pid, done };
      runningScripts.add(running);
      void done.then(
        () => runningScripts.delete(running),
        () => runningScripts.delete(running),
      );
      return { child, done };
    },
    apply() {
      return this.run(["apply", "/bin/true"]);
    },
    pending: () => existsSync(path.join(state, "token")),
    timer: () =>
      JSON.parse(readFileSync(manager, "utf8"))[`rakazo-firewall-rollback-${token}.timer`],
  };
}

function hardenFixture() {
  const f = fixture();
  const target = path.join(f.bin, "rakazo-firewall-change");
  write(
    path.join(f.bin, "firewall-change.sh"),
    readFileSync(f.script, "utf8").replace(
      `SELF=${JSON.stringify(f.script)}`,
      `SELF=${JSON.stringify(target)}`,
    ),
    0o755,
  );
  for (const directory of ["fail2ban/jail.d", "apt/apt.conf.d", "sysctl.d"]) {
    mkdirSync(path.join(f.etc, directory), { recursive: true });
  }
  const harden = path.join(f.bin, "harden-host.sh");
  const text = readFileSync(
    path.resolve(import.meta.dirname, "../../../infra/compose/harden-host.sh"),
    "utf8",
  )
    .replace(`[[ "\${EUID}" -ne 0 ]]`, `[[ "\${EUID}" -ne "\${UID}" ]]`)
    .replaceAll("/usr/local/sbin", f.bin)
    .replaceAll("/usr/local", f.root)
    .replaceAll("/usr", f.root)
    .replaceAll("/etc", f.etc);
  write(harden, text, 0o755);
  return {
    ...f,
    harden,
    runHarden: (overrides: Record<string, string> = {}) =>
      spawnSync("/bin/bash", [harden], {
        env: { ...f.env, ...overrides },
        encoding: "utf8",
        timeout: 10_000,
      }),
  };
}

describe("firewall change rollback", () => {
  it("arms a generation-specific timer before executing the bounded command", () => {
    const f = fixture();
    const result = f.apply();
    expect(result.status, result.stderr).toBe(0);
    expect(f.read("token")).toBe(token);
    expect(f.read("connection")).toBe(firstConnection);
    expect(f.timer()).toBe("active");
    const schedule = f.calls().find((call) => call[0] === "systemd-run");
    expect(schedule).toContain("--on-active=180s");
    expect(schedule).toContain(f.script);
    expect(schedule?.slice(-2)).toEqual(["rollback", token]);
  });

  it.each([
    "",
    "192.0.2.1 0 192.0.2.2 22",
    "192.0.2.1 123 192.0.2.2 65536",
    "a 1 b 2 extra",
    "a 1 b 2\ninjected",
  ])("rejects invalid SSH connection %j before mutation", (connection) => {
    const f = fixture();
    expect(f.run(["apply", "/bin/true"], { SSH_CONNECTION: connection }).status).not.toBe(0);
    expect(f.calls()).toEqual([]);
  });

  it.each(["102399", "invalid", "-1", "9999999999999999"])(
    "refuses invalid or insufficient free KiB %s",
    (free) => {
      const f = fixture();
      f.faults({ free });
      expect(f.apply().status).not.toBe(0);
      expect(f.calls().some((call) => call[0] === "systemd-run")).toBe(false);
      expect(f.pending()).toBe(false);
    },
  );

  it.each([
    { findFail: true },
    { dfFail: true },
    { dfExtra: true },
    { tarFail: true },
    { ufwStatus: "unknown" },
    { uuid: "invalid" },
  ])("retains the firewall before failed preparation %j", (fault) => {
    const f = fixture();
    f.faults(fault);
    expect(f.apply().status).not.toBe(0);
    expect(f.calls().some((call) => call[0] === "systemd-run")).toBe(false);
    expect(f.pending()).toBe(false);
  });

  it.each([{ scheduleBefore: true }, { scheduleAfter: true }, { timerState: "inactive" }])(
    "does not execute when scheduling is unconfirmed %j",
    (fault) => {
      const f = fixture();
      f.faults(fault);
      const marker = path.join(f.root, "changed");
      expect(f.run(["apply", "/usr/bin/touch", marker]).status).not.toBe(0);
      expect(existsSync(marker)).toBe(false);
      expect(f.pending()).toBe(true);
      expect(f.apply().status).not.toBe(0);
    },
  );

  it("keeps the rollback armed after a change command fails", () => {
    const f = fixture();
    expect(f.run(["apply", "/bin/sh", "-c", "exit 7"]).status).toBe(7);
    expect(f.pending()).toBe(true);
    expect(f.timer()).toBe("active");
  });

  it("closes the operation lock in the change command", () => {
    const f = fixture();
    const code =
      "import os;\ntry: os.fstat(9)\nexcept OSError: raise SystemExit(0)\nraise SystemExit(1)";
    expect(f.run(["apply", "python3", "-c", code]).status).toBe(0);
  });

  it("requires the matching token and another SSH connection to confirm", () => {
    const f = fixture();
    expect(f.apply().status).toBe(0);
    expect(
      f.run(["confirm", "00000000-0000-4000-8000-000000000000"], {
        SSH_CONNECTION: secondConnection,
      }).status,
    ).not.toBe(0);
    expect(f.run(["confirm", token]).status).not.toBe(0);
    expect(f.timer()).toBe("active");
    expect(f.pending()).toBe(true);
    expect(f.run(["confirm", token], { SSH_CONNECTION: secondConnection }).status).toBe(0);
    expect(f.pending()).toBe(false);
    expect(f.timer()).toBe("inactive");
  });

  it("leaves the armed change unconfirmed if confirmation publication fails", () => {
    const f = fixture();
    expect(f.apply().status).toBe(0);
    f.faults({ mvTarget: "confirmed", mvBefore: true });
    expect(f.run(["confirm", token], { SSH_CONNECTION: secondConnection }).status).not.toBe(0);
    expect(f.timer()).toBe("active");
    expect(f.pending()).toBe(true);
    expect(existsSync(path.join(f.state, "confirmed"))).toBe(false);
  });

  it.each([
    { mvTarget: "confirmed", mvAfter: true },
    { stopBefore: true },
    { stopAfter: true },
    { rmTarget: "token", rmBefore: true },
  ])("retains a committed confirmation through ambiguous cleanup %j", (fault) => {
    const f = fixture();
    expect(f.apply().status).toBe(0);
    f.faults(fault);
    expect(f.run(["confirm", token], { SSH_CONNECTION: secondConnection }).status).toBe(0);
    expect(f.read("confirmed")).toBe(token);
    write(path.join(f.etc, "ufw", "user.rules"), "accepted rules\n");
    if (f.pending()) {
      expect(f.run(["rollback", token]).status).toBe(0);
      expect(readFileSync(path.join(f.etc, "ufw", "user.rules"), "utf8")).toBe("accepted rules\n");
      f.faults({});
      expect(f.run(["confirm", token], { SSH_CONNECTION: secondConnection }).status).toBe(0);
    }
    expect(f.pending()).toBe(false);
  });

  it.each(["Status: active", "Status: inactive"])(
    "restores the snapshot and prior enabled state %s",
    (ufwStatus) => {
      const f = fixture();
      f.faults({ ufwStatus });
      expect(f.apply().status).toBe(0);
      write(path.join(f.etc, "ufw", "user.rules"), "changed rules\n");
      expect(f.run(["rollback", token], { SSH_CONNECTION: "" }).status).toBe(0);
      expect(readFileSync(path.join(f.etc, "ufw", "user.rules"), "utf8")).toBe("original rules\n");
      expect(f.calls()).toContainEqual([
        "ufw",
        "--force",
        ufwStatus.endsWith("inactive") ? "disable" : "enable",
      ]);
      expect(f.pending()).toBe(false);
    },
  );

  it.each([{ restoreFail: true }, { ufwFail: true }, { stopBefore: true }])(
    "retains pending recovery after rollback failure %j",
    (fault) => {
      const f = fixture();
      expect(f.apply().status).toBe(0);
      f.faults(fault);
      expect(f.run(["rollback", token]).status).not.toBe(0);
      expect(f.pending()).toBe(true);
    },
  );

  it("retains recovery state after logging fails and completes a later retry", () => {
    const f = fixture();
    expect(f.apply().status).toBe(0);
    write(path.join(f.etc, "ufw", "user.rules"), "unconfirmed\n");
    f.faults({ loggerFail: true });
    expect(f.run(["rollback", token]).status).toBe(1);
    expect(readFileSync(path.join(f.etc, "ufw", "user.rules"), "utf8")).toBe("original rules\n");
    expect(f.pending()).toBe(true);
    expect(f.timer()).toBe("inactive");
    f.faults({});
    expect(f.run(["rollback", token]).status).toBe(0);
    expect(f.pending()).toBe(false);
  });

  it.each([
    "../outside\n",
    "ufw/\nufw/../../ssh/config\ndefault/ufw\n",
    "ufw/\n",
    "/etc/ufw\ndefault/ufw\n",
  ])("rejects unsafe snapshot members %j", (members) => {
    const f = fixture();
    expect(f.apply().status).toBe(0);
    f.faults({ members });
    expect(f.run(["rollback", token]).status).not.toBe(0);
    expect(f.calls().some((call) => call[0] === "tar" && call.includes("-xpf"))).toBe(false);
    expect(f.pending()).toBe(true);
  });

  it("rejects snapshot links", () => {
    const f = fixture();
    expect(f.apply().status).toBe(0);
    f.faults({ archiveLink: true });
    expect(f.run(["rollback", token]).status).not.toBe(0);
    expect(f.pending()).toBe(true);
  });

  it.each(["symlink", "hardlink", "writable", "owner"])(
    "rejects unsafe pending metadata %s",
    (kind) => {
      const f = fixture();
      expect(f.apply().status).toBe(0);
      const target = path.join(f.state, "connection");
      if (kind === "symlink") {
        rmSync(target);
        symlinkSync(path.join(f.etc, "default", "ufw"), target);
      }
      if (kind === "hardlink") {
        rmSync(target);
        linkSync(path.join(f.etc, "default", "ufw"), target);
      }
      if (kind === "writable") chmodSync(target, 0o666);
      if (kind === "owner") f.faults({ owner: target });
      expect(f.run(["confirm", token], { SSH_CONNECTION: secondConnection }).status).not.toBe(0);
      expect(f.pending()).toBe(true);
      expect(f.timer()).toBe("active");
    },
  );

  it("rejects a state directory symlink without touching its target", () => {
    const f = fixture();
    const outside = path.join(f.root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, f.state);
    expect(f.apply().status).not.toBe(0);
    expect(existsSync(path.join(outside, "lock"))).toBe(false);
  });

  it("rejects stale confirmation metadata instead of applying it to another generation", () => {
    const f = fixture();
    expect(f.apply().status).toBe(0);
    write(path.join(f.state, "confirmed"), "00000000-0000-4000-8000-000000000000\n");
    expect(f.run(["rollback", token]).status).not.toBe(0);
    expect(f.pending()).toBe(true);
  });

  it("prevents an older callback from restoring a newer generation", () => {
    const f = fixture();
    expect(f.apply().status).toBe(0);
    expect(f.run(["confirm", token], { SSH_CONNECTION: secondConnection }).status).toBe(0);
    const next = "12345678-1234-4234-8234-123456789abd";
    f.faults({ uuid: next });
    expect(f.apply().status).toBe(0);
    expect(f.run(["rollback", token]).status).not.toBe(0);
    expect(f.read("token")).toBe(next);
    expect(f.calls().some((call) => call[0] === "tar" && call.includes("-xpf"))).toBe(false);
  });

  it.each(["0", "65536", "22;id", "-1"])(
    "rejects an invalid hardening SSH port %s before host commands",
    (SSH_PORT) => {
      const f = hardenFixture();
      expect(f.runHarden({ SSH_PORT }).status).not.toBe(0);
      expect(f.calls()).toEqual([]);
    },
  );

  it("requires SSH before hardening installs packages or writes host configuration", () => {
    const f = hardenFixture();
    expect(f.runHarden({ SSH_CONNECTION: "" }).status).not.toBe(0);
    expect(f.calls()).toEqual([]);
    expect(existsSync(path.join(f.etc, "ssh"))).toBe(false);
  });

  it.each(["not-a-tuple", "192.0.2.10 65536 192.0.2.20 22"])(
    "rejects malformed hardening SSH identity %j before host commands",
    (SSH_CONNECTION) => {
      const f = hardenFixture();
      expect(f.runHarden({ SSH_CONNECTION }).status).not.toBe(0);
      expect(f.calls()).toEqual([]);
      expect(existsSync(path.join(f.etc, "ssh"))).toBe(false);
    },
  );

  it("routes hardening firewall edits through the armed guard without resetting private rules", () => {
    const f = hardenFixture();
    const result = f.runHarden({ SSH_PORT: "2222" });
    expect(result.status, result.stderr).toBe(0);
    const calls = f.calls();
    const scheduled = calls.findIndex((call) => call[0] === "systemd-run");
    const firstEdit = calls.findIndex((call) => call[0] === "ufw" && call[1] === "default");
    expect(scheduled).toBeGreaterThanOrEqual(0);
    expect(firstEdit).toBeGreaterThan(scheduled);
    expect(calls).toContainEqual(["ufw", "limit", "2222/tcp", "comment", "Rate-limited SSH"]);
    expect(calls.some((call) => call[0] === "ufw" && call.includes("reset"))).toBe(false);
    expect(f.pending()).toBe(true);
    expect(f.timer()).toBe("active");
  });

  it("refuses a different installed callback before changing a host with a pending operation", () => {
    const f = hardenFixture();
    const target = path.join(f.bin, "rakazo-firewall-change");
    write(target, "#!/bin/sh\necho previous-version\n", 0o755);
    mkdirSync(f.state, { mode: 0o700 });
    write(path.join(f.state, "token"), `${token}\n`);
    const result = f.runHarden();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Existing firewall helper differs");
    expect(readFileSync(target, "utf8")).toBe("#!/bin/sh\necho previous-version\n");
    expect(
      f
        .calls()
        .some((call) => ["apt-get", "install", "systemd-run", "ufw"].includes(call[0] as string)),
    ).toBe(false);
    expect(existsSync(path.join(f.etc, "ssh"))).toBe(false);
    expect(f.read("token")).toBe(token);
  });

  it("reuses an identical installed callback during repeated hardening", () => {
    const f = hardenFixture();
    const target = path.join(f.bin, "rakazo-firewall-change");
    expect(f.runHarden().status).toBe(0);
    expect(f.run(["confirm", token], { SSH_CONNECTION: secondConnection }).status).toBe(0);
    f.faults({ uuid: "12345678-1234-4234-8234-123456789abd" });
    const result = f.runHarden();
    expect(result.status, result.stderr).toBe(0);
    expect(
      f.calls().filter((call) => call[0] === "install" && call.at(-1) === target),
    ).toHaveLength(1);
    expect(f.read("token")).toBe("12345678-1234-4234-8234-123456789abd");
  });

  it("rejects an identical non-executable callback before changing host configuration", () => {
    const f = hardenFixture();
    const target = path.join(f.bin, "rakazo-firewall-change");
    const identical = readFileSync(path.join(f.bin, "firewall-change.sh"), "utf8");
    write(target, identical, 0o600);
    const result = f.runHarden();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unsafe existing firewall helper");
    expect(readFileSync(target, "utf8")).toBe(identical);
    expect(
      f
        .calls()
        .some((call) =>
          ["apt-get", "install", "systemd-run", "ufw", "sshd", "sysctl"].includes(
            call[0] as string,
          ),
        ),
    ).toBe(false);
    expect(existsSync(path.join(f.etc, "ssh"))).toBe(false);
    expect(f.pending()).toBe(false);
  });

  it("removes new unconfirmed UFW files while preserving unrelated defaults", () => {
    const f = fixture();
    expect(f.apply().status).toBe(0);
    write(path.join(f.etc, "ufw", "added.rules"), "unconfirmed\n");
    write(path.join(f.etc, "default", "unrelated"), "keep\n");
    expect(f.run(["rollback", token]).status).toBe(0);
    expect(existsSync(path.join(f.etc, "ufw", "added.rules"))).toBe(false);
    expect(readFileSync(path.join(f.etc, "default", "unrelated"), "utf8")).toBe("keep\n");
    expect(f.calls().some((call) => call[0] === "tar" && call.includes("--recursive-unlink"))).toBe(
      true,
    );
  });

  it("rejects an actual archive that contains the defaults directory and its sibling", () => {
    const f = fixture();
    expect(f.apply().status).toBe(0);
    write(path.join(f.etc, "default", "unrelated"), "keep\n");
    execFileSync("/usr/bin/tar", [
      "-cpf",
      path.join(f.state, "before.tar"),
      "-C",
      f.etc,
      "ufw",
      "default",
    ]);
    const result = f.run(["rollback", token]);
    expect(result.status).not.toBe(0);
    expect(result.error).toBeUndefined();
    expect(f.calls().some((call) => call[0] === "tar" && call.includes("-xpf"))).toBe(false);
    expect(f.pending()).toBe(true);
  });

  it("restores a removed UFW directory from the validated snapshot", () => {
    const f = fixture();
    expect(f.apply().status).toBe(0);
    rmSync(path.join(f.etc, "ufw"), { recursive: true });
    expect(f.run(["rollback", token]).status).toBe(0);
    expect(readFileSync(path.join(f.etc, "ufw", "user.rules"), "utf8")).toBe("original rules\n");
  });

  it("rejects a FIFO lock without opening or blocking on it", () => {
    const f = fixture();
    mkdirSync(f.state, { mode: 0o700 });
    execFileSync("mkfifo", [path.join(f.state, "lock")]);
    const result = f.apply();
    expect(result.status).toBe(1);
    expect(result.error).toBeUndefined();
    expect(f.calls().some((call) => call[0] === "systemd-run")).toBe(false);
  });

  it("rejects an SGID state directory without correcting its permissions", () => {
    const f = fixture();
    mkdirSync(f.state, { mode: 0o700 });
    chmodSync(f.state, 0o2700);
    expect(f.apply().status).toBe(1);
    expect(f.calls().some((call) => call[0] === "systemd-run")).toBe(false);
  });

  it("serializes recovery after a running apply and refuses a concurrent confirmation", async () => {
    const f = fixture();
    const ready = path.join(f.root, "ready"),
      release = path.join(f.root, "release");
    const started = f.start([
      "apply",
      "/bin/sh",
      "-c",
      'printf "changed\\n" >"$1"; touch "$2"; while [ ! -f "$3" ]; do sleep 0.01; done',
      "--",
      path.join(f.etc, "ufw", "user.rules"),
      ready,
      release,
    ]);
    await waitForFile(ready);
    expect(f.run(["confirm", token], { SSH_CONNECTION: secondConnection }).status).toBe(1);
    const waiting = path.join(f.root, "waiting");
    const recovery = f.start(["rollback", token], { FW_FLOCK_WAITING: waiting });
    await waitForFile(waiting);
    expect(recovery.child.exitCode).toBeNull();
    write(release, "release");
    expect((await started.done).status).toBe(0);
    const result = await recovery.done;
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(path.join(f.etc, "ufw", "user.rules"), "utf8")).toBe("original rules\n");
    expect(f.pending()).toBe(false);
  });

  it("rechecks committed confirmation when a previously queued callback acquires the lock", async () => {
    const f = fixture();
    expect(f.apply().status).toBe(0);
    write(path.join(f.etc, "ufw", "user.rules"), "accepted\n");
    const waiting = path.join(f.root, "waiting"),
      release = path.join(f.root, "release");
    const callback = f.start(["rollback", token], {
      FW_FLOCK_WAITING: waiting,
      FW_FLOCK_RELEASE: release,
    });
    await waitForFile(waiting);
    f.faults({ stopBefore: true });
    expect(f.run(["confirm", token], { SSH_CONNECTION: secondConnection }).status).toBe(0);
    write(release, "release");
    const result = await callback.done;
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(path.join(f.etc, "ufw", "user.rules"), "utf8")).toBe("accepted\n");
    expect(f.read("confirmed")).toBe(token);
    expect(f.pending()).toBe(true);
  });

  it("preserves the pending timer when the apply process group is interrupted", async () => {
    const f = fixture();
    const ready = path.join(f.root, "ready");
    const running = f.start([
      "apply",
      "/bin/sh",
      "-c",
      'touch "$1"; while :; do sleep 1; done',
      "--",
      ready,
    ]);
    await waitForFile(ready);
    signalGroup(running.child.pid as number, "SIGTERM");
    const result = await running.done;
    expect(result.signal).toBe("SIGTERM");
    expect(f.pending()).toBe(true);
    expect(f.timer()).toBe("active");
    expect(f.run(["rollback", token]).status).toBe(0);
  });

  it("retries confirmation after token retirement succeeded but its acknowledgment was lost", () => {
    const f = fixture();
    expect(f.apply().status).toBe(0);
    f.faults({ rmTarget: "token", rmAfter: true });
    expect(f.run(["confirm", token], { SSH_CONNECTION: secondConnection }).status).toBe(0);
    expect(f.pending()).toBe(false);
    expect(f.read("confirmed")).toBe(token);
    f.faults({});
    expect(f.run(["confirm", token], { SSH_CONNECTION: secondConnection }).status).toBe(0);
    expect(f.run(["confirm", token]).status).not.toBe(0);
    expect(f.run(["rollback", token]).status).not.toBe(0);
    const next = "12345678-1234-4234-8234-123456789abd";
    f.faults({ uuid: next });
    expect(f.apply().status).toBe(0);
    expect(existsSync(path.join(f.state, "confirmed"))).toBe(false);
    expect(f.read("token")).toBe(next);
    expect(f.run(["confirm", token], { SSH_CONNECTION: secondConnection }).status).not.toBe(0);
  });

  it.each(["ufw", "ufw/nested", "default/ufw"])(
    "rejects a mounted rollback target %s before scheduling or changing rules",
    (target) => {
      const f = fixture();
      f.faults({ mountPath: path.join(f.etc, target) });
      const marker = path.join(f.root, "changed");
      const result = f.run(["apply", "/usr/bin/touch", marker]);
      expect(result.status).toBe(1);
      expect(result.error).toBeUndefined();
      expect(existsSync(marker)).toBe(false);
      expect(f.pending()).toBe(false);
      expect(f.calls().some((call) => call[0] === "systemd-run")).toBe(false);
    },
  );

  it("supports the ordinary parent filesystem and unrelated mount siblings", () => {
    const f = fixture();
    f.faults({
      mountInfo: `1 0 8:1 / ${f.etc} rw - ext4 /dev/fixture rw\n2 1 0:2 / ${f.etc}/ufw-other rw - tmpfs tmpfs rw\n`,
    });
    expect(f.apply().status).toBe(0);
  });

  it.each([{ mountReadFail: true }, { mountInfo: "" }, { mountInfo: "malformed\n" }])(
    "rejects missing or malformed mount information before mutation %j",
    (fault) => {
      const f = fixture();
      f.faults(fault);
      expect(f.apply().status).toBe(1);
      expect(f.pending()).toBe(false);
      expect(f.calls().some((call) => call[0] === "systemd-run")).toBe(false);
    },
  );

  it("retains recovery state if a mount appeared after the change was armed", () => {
    const f = fixture();
    expect(f.apply().status).toBe(0);
    f.faults({ mountPath: path.join(f.etc, "ufw") });
    expect(f.run(["rollback", token]).status).toBe(1);
    expect(f.pending()).toBe(true);
    expect(f.timer()).toBe("active");
    expect(f.calls().some((call) => call[0] === "tar" && call.includes("-xpf"))).toBe(false);
  });
});
