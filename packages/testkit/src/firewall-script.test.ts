import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
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
const firstBoot = "00000000-0000-4000-8000-000000000001";
const nextBoot = "00000000-0000-4000-8000-000000000002";
const bootUnit = "rakazo-firewall-recovery.service";
const firstConnection = "192.0.2.10 12345 192.0.2.20 22";
const secondConnection = "192.0.2.10 12346 192.0.2.20 22";
const emptyUfwAdded = "Added user rules (see 'ufw status' for running firewall):\n(None)";

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
  for (const directory of [
    base,
    etc,
    path.join(etc, "ufw"),
    path.join(etc, "default"),
    path.join(etc, "systemd", "system"),
    bin,
  ]) {
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
 for(const f of args.slice(0,args.indexOf('('))){const found=visit(f);if(found){console.log(found);break;}}
}else if(name==='cat'){
 if(args[0]==='/proc/sys/kernel/random/uuid')console.log(fault.uuid||'${token}');
 else if(args[0]==='/proc/sys/kernel/random/boot_id'){
  if(bad('bootReadFail'))process.exit(1);console.log(fault.bootId??'${firstBoot}');
 }
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
 if(args[0]==='show'&&args[1]==='added'){
  if(bad('showAddedFail')||process.env.LC_ALL!=='C')process.exit(1);
  console.log(fault.ufwAdded??${JSON.stringify(emptyUfwAdded)});
 }else if(args[0]==='status')console.log(fault.ufwStatus||'Status: active');else if(bad('ufwFail'))process.exit(1);
}else if(name==='grep'){
 if(bad('ruleReadFail'))process.exit(2);
 const r=cp.spawnSync('/usr/bin/grep',args,{stdio:'inherit'});process.exit(r.status??2);
}else if(name==='ufw-preserve-python3'){
 const checks=fs.readFileSync(process.env.FW_LOG,'utf8').trim().split('\\n').map(l=>JSON.parse(l)).filter(c=>c[0]==='ufw-preserve-python3').length;
 if(bad('preserveCheckFail')||(bad('preserveCheckAfterFail')&&checks>1)){console.error('Cannot preserve saved UFW user rules: formatter rejected input');process.exit(1);}
}else if(name==='systemd-run'){
 const unit=args.find(a=>a.startsWith('--unit=')).slice(7);if(bad('scheduleBefore'))process.exit(1);
 const s=state();s[unit+'.timer']=fault.timerState||'active';save(s);if(bad('scheduleAfter'))process.exit(1);
}else if(name==='systemctl'){
 const s=state(),unit=path.join(process.env.FW_ETC,'systemd/system','${bootUnit}'),wants=path.join(path.dirname(unit),'multi-user.target.wants','${bootUnit}');
 if(args[0]==='daemon-reload'){if(bad('reloadFail'))process.exit(1);}
 else if(args[0]==='enable'&&args[1]==='${bootUnit}'){
  if(bad('enableBefore'))process.exit(1);fs.mkdirSync(path.dirname(wants),{recursive:true,mode:0o755});
  if(!fs.existsSync(wants))fs.symlinkSync(unit,wants);if(bad('enableAfter'))process.exit(1);
 }else if(args[0]==='show'){
  if(bad('showFail'))process.exit(1);
  const prop=args.find(a=>a.startsWith('--property=')).slice(11);
  if(args[1]==='${bootUnit}')console.log(({LoadState:fault.bootLoadState??(fs.existsSync(unit)?'loaded':'not-found'),FragmentPath:fault.bootFragment??(fs.existsSync(unit)?unit:''),DropInPaths:fault.bootDropIns??'',UnitFileState:fault.bootUnitState??(fs.existsSync(wants)?'enabled':'disabled')})[prop]??'');
  else console.log(prop==='LoadState'?(Object.hasOwn(s,args[1])?'loaded':'not-found'):(s[args[1]]||'inactive'));
 }else if(args[0]==='stop'){if(bad('stopBefore')||!Object.hasOwn(s,args[1]))process.exit(1);s[args[1]]='inactive';save(s);if(bad('stopAfter'))process.exit(1);}
}else if(name==='sync'){
 if(bad('syncFail')||(fault.syncTarget&&args.includes(fault.syncTarget)))process.exit(1);
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
    "grep",
    "ufw-preserve-python3",
    "systemd-run",
    "systemctl",
    "sync",
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
    reboot: (value: Record<string, unknown> = {}) => {
      write(manager, "{}");
      write(faults, JSON.stringify({ bootId: nextBoot, ...value }));
    },
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
  write(path.join(f.etc, "ufw", "user.rules"), "");
  write(path.join(f.etc, "ufw", "user6.rules"), "");
  write(
    path.join(f.bin, "ufw-preserve-check.py"),
    "# Formatter command is stubbed by this shell fixture.\n",
  );
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
    .replaceAll("/usr/bin/python3", path.join(f.bin, "ufw-preserve-python3"))
    .replaceAll("/usr/local/sbin", f.bin)
    .replaceAll("/usr/local", f.root)
    .replaceAll("/usr", f.root)
    .replaceAll("/etc", f.etc)
    .replaceAll("/var/lib/ufw", path.join(f.root, "retained-ufw"))
    .replaceAll("/lib/ufw", path.join(f.root, "legacy-ufw"));
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

function expectNoHardeningWrites(f: ReturnType<typeof hardenFixture>) {
  expect(
    f
      .calls()
      .filter(
        (call) =>
          [
            "apt-get",
            "install",
            "sshd",
            "sysctl",
            "augenrules",
            "systemd-run",
            "systemctl",
          ].includes(call[0] as string) ||
          (call[0] === "ufw" && !(call[1] === "show" && call[2] === "added")),
      ),
  ).toEqual([]);
  expect(existsSync(path.join(f.etc, "ssh"))).toBe(false);
  expect(existsSync(path.join(f.etc, "sysctl.d", "99-rakazo-hardening.conf"))).toBe(false);
  expect(existsSync(path.join(f.etc, "apt", "apt.conf.d", "20auto-upgrades"))).toBe(false);
  expect(f.pending()).toBe(false);
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

  it("persistently enables and flushes protected boot recovery before firewall edits", () => {
    const f = fixture();
    const result = f.run(["apply", "ufw", "default", "deny", "incoming"]);
    expect(result.status, result.stderr).toBe(0);
    const unit = path.join(f.etc, "systemd", "system", bootUnit);
    expect(readFileSync(unit, "utf8")).toContain(`ExecStart=${f.script} recover\n`);
    expect(readFileSync(unit, "utf8")).toContain("After=ufw.service\n");
    expect(readFileSync(unit, "utf8")).toContain("WantedBy=multi-user.target\n");
    expect(f.read("boot")).toBe(firstBoot);
    const calls = f.calls();
    const enable = calls.findIndex((call) => call[0] === "systemctl" && call[1] === "enable");
    const flush = calls.findIndex((call) => call[0] === "sync");
    const edit = calls.findIndex((call) => call[0] === "ufw" && call[1] === "default");
    expect(enable).toBeGreaterThan(-1);
    expect(flush).toBeGreaterThan(enable);
    expect(edit).toBeGreaterThan(flush);
    expect(calls[enable]).not.toContain("--runtime");
    expect(calls[enable]).not.toContain("--now");
  });

  it.each([
    { bootLoadState: "loaded", bootFragment: "/usr/lib/systemd/system/vendor.service" },
    { bootLoadState: "loaded", bootFragment: "/run/systemd/system/runtime.service" },
    { bootLoadState: "masked" },
    { bootLoadState: "error" },
    { bootDropIns: "/run/systemd/system/service.d/override.conf" },
    { showFail: true },
  ])("refuses to shadow an existing manager unit before writing its own file %j", (fault) => {
    const f = fixture();
    f.faults(fault);
    const unit = path.join(f.etc, "systemd", "system", bootUnit);
    expect(f.apply().status).toBe(1);
    expect(existsSync(unit)).toBe(false);
    expect(f.pending()).toBe(false);
    expect(
      f
        .calls()
        .some(
          (call) =>
            call[0] === "systemctl" && ["daemon-reload", "enable"].includes(call[1] as string),
        ),
    ).toBe(false);
    expect(f.calls().some((call) => call[0] === "ufw" || call[0] === "systemd-run")).toBe(false);
  });

  it.each([
    { reloadFail: true },
    { enableBefore: true },
    { enableAfter: true },
    { showFail: true },
    { bootLoadState: "masked" },
    { bootFragment: "/run/systemd/transient/other.service" },
    { bootDropIns: "/run/systemd/system/service.d/override.conf" },
    { bootUnitState: "enabled-runtime" },
    { syncFail: true },
    { bootReadFail: true },
    { bootId: "invalid" },
  ])("refuses mutation when durable boot recovery is unverified %j", (fault) => {
    const f = fixture();
    f.faults(fault);
    const marker = path.join(f.root, "changed");
    expect(f.run(["apply", "/usr/bin/touch", marker]).status).not.toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  it.each(["different", "symlink", "hardlink", "writable", "owner", "directory"])(
    "rejects an unsafe or different installed boot unit %s without replacing it",
    (kind) => {
      const f = fixture();
      const unit = path.join(f.etc, "systemd", "system", bootUnit);
      if (kind === "directory") mkdirSync(unit);
      else if (kind === "symlink") symlinkSync(path.join(f.etc, "default", "ufw"), unit);
      else if (kind === "hardlink") linkSync(path.join(f.etc, "default", "ufw"), unit);
      else write(unit, "existing unit\n", kind === "writable" ? 0o666 : 0o600);
      if (kind === "owner") f.faults({ owner: unit });
      expect(f.run(["apply", "ufw", "default", "deny", "incoming"]).status).not.toBe(0);
      expect(f.pending()).toBe(false);
      expect(f.calls().some((call) => call[0] === "systemctl")).toBe(false);
      expect(f.calls().some((call) => call[0] === "ufw")).toBe(false);
      if (kind === "different") expect(readFileSync(unit, "utf8")).toBe("existing unit\n");
    },
  );

  it.each(["directory-link", "writable-directory", "wrong-link", "regular-link", "owner"])(
    "rejects unsafe boot enablement %s before manager or firewall commands",
    (kind) => {
      const f = fixture();
      const wants = path.join(f.etc, "systemd", "system", "multi-user.target.wants");
      const link = path.join(wants, bootUnit);
      if (kind === "directory-link") symlinkSync(f.bin, wants);
      else {
        mkdirSync(wants, { mode: kind === "writable-directory" ? 0o777 : 0o755 });
        if (kind === "writable-directory") chmodSync(wants, 0o777);
        if (kind === "wrong-link") symlinkSync(path.join(f.etc, "default", "ufw"), link);
        if (kind === "regular-link") write(link, "unexpected\n");
        if (kind === "owner") {
          symlinkSync(path.join(f.etc, "systemd", "system", bootUnit), link);
          f.faults({ owner: link });
        }
      }
      expect(f.apply().status).not.toBe(0);
      expect(f.pending()).toBe(false);
      expect(f.calls().some((call) => call[0] === "systemctl")).toBe(false);
    },
  );

  it.each(["Status: active", "Status: inactive"])(
    "restores persisted unconfirmed state after manager reset with prior %s",
    (ufwStatus) => {
      const f = fixture();
      f.faults({ ufwStatus });
      expect(f.apply().status).toBe(0);
      write(path.join(f.etc, "ufw", "user.rules"), "changed rules\n");
      write(path.join(f.etc, "ufw", "added.rules"), "unconfirmed\n");
      write(path.join(f.etc, "default", "ufw"), "changed defaults\n");
      f.reboot();
      expect(f.timer()).toBeUndefined();
      const result = f.run(["recover"], { SSH_CONNECTION: "" });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(path.join(f.etc, "ufw", "user.rules"), "utf8")).toBe("original rules\n");
      expect(readFileSync(path.join(f.etc, "default", "ufw"), "utf8")).toBe("ENABLED=yes\n");
      expect(existsSync(path.join(f.etc, "ufw", "added.rules"))).toBe(false);
      expect(f.calls()).toContainEqual([
        "ufw",
        "--force",
        ufwStatus.endsWith("inactive") ? "disable" : "enable",
      ]);
      expect(f.pending()).toBe(false);
    },
  );

  it("does nothing at boot without a pending token", () => {
    const f = fixture();
    const result = f.run(["recover"], { SSH_CONNECTION: "" });
    expect(result.status, result.stderr).toBe(0);
    expect(f.calls().some((call) => ["ufw", "systemctl", "tar"].includes(call[0] as string))).toBe(
      false,
    );
  });

  it("leaves a current-boot change to its generation timer", () => {
    const f = fixture();
    expect(f.apply().status).toBe(0);
    write(path.join(f.etc, "ufw", "user.rules"), "current boot\n");
    expect(f.run(["recover"], { SSH_CONNECTION: "" }).status).toBe(0);
    expect(readFileSync(path.join(f.etc, "ufw", "user.rules"), "utf8")).toBe("current boot\n");
    expect(f.pending()).toBe(true);
    expect(f.timer()).toBe("active");
  });

  it.each([
    "missing-boot",
    "invalid-boot",
    "invalid-token",
    "linked-token",
    "foreign-boot",
    "invalid-current-boot",
  ])("rejects untrusted persisted recovery metadata %s after manager reset", (kind) => {
    const f = fixture();
    expect(f.apply().status).toBe(0);
    f.reboot(kind === "invalid-current-boot" ? { bootId: "invalid" } : {});
    if (kind === "missing-boot") rmSync(path.join(f.state, "boot"));
    if (kind === "invalid-boot") write(path.join(f.state, "boot"), "invalid\n");
    if (kind === "invalid-token") write(path.join(f.state, "token"), "invalid\n");
    if (kind === "linked-token") {
      rmSync(path.join(f.state, "token"));
      symlinkSync(path.join(f.etc, "default", "ufw"), path.join(f.state, "token"));
    }
    if (kind === "foreign-boot") f.reboot({ owner: path.join(f.state, "boot") });
    const result = f.run(["recover"], { SSH_CONNECTION: "" });
    expect(result.status).not.toBe(0);
    expect(f.pending()).toBe(true);
    expect(f.calls().some((call) => call[0] === "tar" && call.includes("-xpf"))).toBe(false);
  });

  it("keeps a committed change after reboot when timer cleanup was incomplete", () => {
    const f = fixture();
    expect(f.apply().status).toBe(0);
    write(path.join(f.etc, "ufw", "user.rules"), "accepted\n");
    f.faults({ stopBefore: true });
    expect(f.run(["confirm", token], { SSH_CONNECTION: secondConnection }).status).toBe(0);
    f.reboot();
    expect(f.run(["recover"], { SSH_CONNECTION: "" }).status).toBe(0);
    expect(readFileSync(path.join(f.etc, "ufw", "user.rules"), "utf8")).toBe("accepted\n");
    expect(f.pending()).toBe(true);
  });

  it("retires a committed token after reboot removed its timer and admits the next apply", () => {
    const f = fixture();
    expect(f.apply().status).toBe(0);
    f.faults({ stopBefore: true });
    expect(f.run(["confirm", token], { SSH_CONNECTION: secondConnection }).status).toBe(0);
    expect(f.pending()).toBe(true);
    f.reboot();
    expect(f.run(["confirm", token], { SSH_CONNECTION: secondConnection }).status).toBe(0);
    expect(f.pending()).toBe(false);
    f.faults({ bootId: nextBoot, uuid: "12345678-1234-4234-8234-123456789abd" });
    expect(f.apply().status).toBe(0);
    expect(f.read("token")).toBe("12345678-1234-4234-8234-123456789abd");
  });

  it.each(["loaded-timer", "failed-readback"])(
    "keeps confirmed cleanup pending when timer absence is unverified: %s",
    (kind) => {
      const f = fixture();
      expect(f.apply().status).toBe(0);
      if (kind === "loaded-timer") f.faults({ stopBefore: true });
      else f.reboot({ showFail: true });
      const result = f.run(["confirm", token], { SSH_CONNECTION: secondConnection });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("timer cleanup is incomplete");
      expect(f.pending()).toBe(true);
      expect(f.apply().status).not.toBe(0);
    },
  );

  it("reports committed confirmation and keeps cleanup pending when its flush fails", () => {
    const f = fixture();
    expect(f.apply().status).toBe(0);
    f.faults({ syncFail: true });
    const result = f.run(["confirm", token], { SSH_CONNECTION: secondConnection });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("confirmation committed but durability is unverified");
    expect(f.read("confirmed")).toBe(token);
    expect(f.pending()).toBe(true);
    expect(f.timer()).toBe("active");
    f.faults({});
    expect(f.run(["confirm", token], { SSH_CONNECTION: secondConnection }).status).toBe(0);
    expect(f.pending()).toBe(false);
  });

  it("retains pending state when restored configuration cannot be flushed", () => {
    const f = fixture();
    expect(f.apply().status).toBe(0);
    write(path.join(f.etc, "ufw", "user.rules"), "unconfirmed\n");
    f.reboot({ syncTarget: path.join(f.etc, "ufw") });
    const result = f.run(["recover"], { SSH_CONNECTION: "" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Firewall restored but durability is unverified; pending state retained",
    );
    expect(f.pending()).toBe(true);
    f.reboot();
    expect(f.run(["recover"], { SSH_CONNECTION: "" }).status).toBe(0);
    expect(f.pending()).toBe(false);
  });

  it("reports token retirement accurately when its final flush fails and retries at boot", () => {
    const f = fixture();
    expect(f.apply().status).toBe(0);
    f.reboot({ syncTarget: f.state });
    const result = f.run(["recover"], { SSH_CONNECTION: "" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Firewall restored and pending token retired; state durability is unverified",
    );
    expect(f.pending()).toBe(false);
    f.reboot();
    expect(f.run(["recover"], { SSH_CONNECTION: "" }).status).toBe(0);
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

  it.each([
    { scheduleBefore: true },
    { scheduleAfter: true },
    { timerState: "inactive" },
    { syncFail: true },
  ])("reports recovery and does not execute when arming is unconfirmed %j", (fault) => {
    const f = fixture();
    f.faults(fault);
    const marker = path.join(f.root, "changed");
    const result = f.run(["apply", "/usr/bin/touch", marker]);
    expect(result.status).not.toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(f.pending()).toBe(true);
    const recovery = /^Recovery command if setup fails: sudo (.+) rollback ([0-9a-f-]+)$/m.exec(
      result.stdout,
    );
    expect(recovery).not.toBeNull();
    expect(recovery![1]).toBe(f.script);
    expect(recovery![2]).toBe(token);
    expect(result.stdout).not.toContain("Rollback armed");
    expect(f.apply().status).not.toBe(0);
    f.faults({});
    const sameBoot = f.run(["recover"], { SSH_CONNECTION: "" });
    expect(sameBoot.status).toBe(0);
    expect(sameBoot.stdout).toContain("remains pending");
    expect(sameBoot.stdout).not.toContain("protected by its rollback timer");
    expect(f.pending()).toBe(true);
    const restored = f.run(["rollback", recovery![2]!], { SSH_CONNECTION: "" });
    expect(restored.status, restored.stderr).toBe(0);
    expect(f.pending()).toBe(false);
    expect(readFileSync(path.join(f.etc, "ufw", "user.rules"), "utf8")).toBe("original rules\n");
    f.faults({ uuid: "12345678-1234-4234-8234-123456789abd" });
    expect(f.apply().status).toBe(0);
  });

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

  it.each(["", "2", "true", " 1", "01"])(
    "rejects an invalid existing-rule acknowledgment %j before host commands",
    (PRESERVE_EXISTING_UFW_RULES) => {
      const f = hardenFixture();
      expect(f.runHarden({ PRESERVE_EXISTING_UFW_RULES }).status).not.toBe(0);
      expect(f.calls()).toEqual([]);
    },
  );

  it("admits UFW's exact no-rules report before installing packages or changing host settings", () => {
    const f = hardenFixture();
    const result = f.runHarden();
    expect(result.status, result.stderr).toBe(0);
    const calls = f.calls();
    const audit = calls.findIndex((call) => call[0] === "ufw" && call[1] === "show");
    const packages = calls.findIndex((call) => call[0] === "apt-get");
    expect(audit).toBeGreaterThan(-1);
    expect(packages).toBeGreaterThan(audit);
    expect(f.pending()).toBe(true);
  });

  const rawPolicyPaths = [
    "etc/ufw/user.rules",
    "etc/ufw/user6.rules",
    "etc/ufw/before.rules",
    "etc/ufw/before6.rules",
    "etc/ufw/after.rules",
    "etc/ufw/after6.rules",
    "etc/ufw/before.init",
    "etc/ufw/after.init",
    "legacy-ufw/user.rules",
    "legacy-ufw/user6.rules",
  ];
  it.each(
    rawPolicyPaths.flatMap((file) =>
      ["Status: active", "Status: inactive"].map((ufwStatus) => ({ file, ufwStatus })),
    ),
  )(
    "requires acknowledgment for raw UFW policy omitted by the report: $file/$ufwStatus",
    ({ file, ufwStatus }) => {
      const f = hardenFixture();
      const target = path.join(f.root, file);
      const saved = file.endsWith(".init")
        ? "#!/bin/sh\niptables -A INPUT -p tcp --dport 5432 -j ACCEPT\n"
        : "*filter\n-A INPUT -p tcp --dport 5432 -j ACCEPT\nCOMMIT\n";
      write(target, saved, file.endsWith(".init") ? 0o700 : 0o600);
      const unsupportedUser = ["etc/ufw/user.rules", "etc/ufw/user6.rules"].includes(file);
      f.faults({ ufwStatus, ufwAdded: emptyUfwAdded, preserveCheckFail: unsupportedUser });
      const rejected = f.runHarden();
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain("nonempty UFW policy or initialization hook");
      expectNoHardeningWrites(f);
      expect(readFileSync(target, "utf8")).toBe(saved);
      const accepted = f.runHarden({ PRESERVE_EXISTING_UFW_RULES: "1" });
      if (unsupportedUser || file.startsWith("legacy-ufw/")) {
        expect(accepted.status).not.toBe(0);
        expectNoHardeningWrites(f);
        expect(readFileSync(target, "utf8")).toBe(saved);
        return;
      }
      expect(accepted.status, accepted.stderr).toBe(0);
      expect(accepted.stderr).toContain("including public allows");
      expect(readFileSync(target, "utf8")).toBe(saved);
      expect(f.pending()).toBe(true);
      expect(
        f
          .calls()
          .some(
            (call) =>
              call[0] === "ufw" &&
              call.some((arg) => ["reset", "delete", "insert", "prepend"].includes(arg)),
          ),
      ).toBe(false);
    },
  );

  it("admits byte-empty raw policy only after the exact no-rules audit", () => {
    const f = hardenFixture();
    for (const file of rawPolicyPaths) write(path.join(f.root, file), "");
    const result = f.runHarden();
    expect(result.status, result.stderr).toBe(0);
    expect(f.calls()).toContainEqual(["ufw", "show", "added"]);
    expect(f.pending()).toBe(true);
  });

  it.each(["user.rules", "user6.rules"])(
    "refuses mixed registered and raw %s when the installed formatter rejects it",
    (file) => {
      const f = hardenFixture();
      const target = path.join(f.etc, "ufw", file);
      const saved =
        "### tuple ### allow tcp 22 0.0.0.0/0 any 0.0.0.0/0 in\n-A ufw-user-input -p tcp --dport 5432 -j ACCEPT\n";
      write(target, saved);
      f.faults({ preserveCheckFail: true });
      const result = f.runHarden({ PRESERVE_EXISTING_UFW_RULES: "1" });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("cannot be preserved safely");
      expect(readFileSync(target, "utf8")).toBe(saved);
      expectNoHardeningWrites(f);
    },
  );

  it("requires the installed formatter to accept nonempty user files before host writes", () => {
    const f = hardenFixture();
    write(path.join(f.etc, "ufw", "user.rules"), "formatter-approved fixture\n");
    const result = f.runHarden({ PRESERVE_EXISTING_UFW_RULES: "1" });
    expect(result.status, result.stderr).toBe(0);
    const calls = f.calls();
    const check = calls.findIndex((call) => call[0] === "ufw-preserve-python3");
    expect(check).toBeGreaterThan(-1);
    expect(calls[check]?.slice(1, 3)).toEqual(["-I", "-B"]);
    expect(calls.findIndex((call) => call[0] === "apt-get")).toBeGreaterThan(check);
    expect(calls.filter((call) => call[0] === "ufw-preserve-python3")).toHaveLength(2);
    expect(calls.find((call) => call[0] === "apt-get" && call[1] === "install")).toContain(
      "--no-upgrade",
    );
  });

  it("rechecks acknowledged user rules inside the armed guard before firewall mutations", () => {
    const f = hardenFixture();
    write(path.join(f.etc, "ufw", "user.rules"), "formatter-approved fixture\n");
    f.faults({ preserveCheckAfterFail: true });
    expect(f.runHarden({ PRESERVE_EXISTING_UFW_RULES: "1" }).status).not.toBe(0);
    expect(f.pending()).toBe(true);
    expect(f.calls().filter((call) => call[0] === "ufw-preserve-python3")).toHaveLength(2);
    expect(
      f
        .calls()
        .some((call) => call[0] === "ufw" && !["show", "status"].includes(call[1] as string)),
    ).toBe(false);
  });

  const savedRuleCases = ["Status: active", "Status: inactive"].flatMap((ufwStatus) =>
    [
      "allow 22/tcp",
      "allow 5432/tcp",
      "allow from 10.0.0.0/8 to any port 5432 proto tcp",
      "limit 22/tcp comment 'Rate-limited SSH'",
    ].map((rule) => ({ ufwStatus, rule })),
  );
  it.each(savedRuleCases)(
    "rejects all existing rules before host writes without acknowledgment %j",
    ({ ufwStatus, rule }) => {
      const f = hardenFixture();
      const rules = path.join(f.etc, "ufw", "user.rules");
      const saved = readFileSync(rules, "utf8");
      f.faults({ ufwStatus, ufwAdded: `${emptyUfwAdded.split("\n")[0]}\nufw ${rule}` });
      const result = f.runHarden();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("PRESERVE_EXISTING_UFW_RULES=1");
      expect(readFileSync(rules, "utf8")).toBe(saved);
      expectNoHardeningWrites(f);
    },
  );

  it.each(savedRuleCases)(
    "preserves explicitly acknowledged existing rules and uses the armed guard %j",
    ({ ufwStatus, rule }) => {
      const f = hardenFixture();
      const rules = path.join(f.etc, "ufw", "user.rules");
      const saved = readFileSync(rules, "utf8");
      f.faults({ ufwStatus, ufwAdded: `${emptyUfwAdded.split("\n")[0]}\nufw ${rule}` });
      const result = f.runHarden({ PRESERVE_EXISTING_UFW_RULES: "1" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain("including public allows");
      expect(result.stderr).toContain("do not override earlier allows");
      expect(readFileSync(rules, "utf8")).toBe(saved);
      const calls = f.calls();
      const scheduled = calls.findIndex((call) => call[0] === "systemd-run");
      const edit = calls.findIndex((call) => call[0] === "ufw" && call[1] === "default");
      expect(scheduled).toBeGreaterThan(-1);
      expect(edit).toBeGreaterThan(scheduled);
      expect(
        calls.some(
          (call) =>
            call[0] === "ufw" &&
            call.some((arg) => ["reset", "delete", "insert", "prepend"].includes(arg)),
        ),
      ).toBe(false);
      expect(f.pending()).toBe(true);
    },
  );

  it.each([
    "",
    emptyUfwAdded.split("\n")[0],
    "(None)",
    "Status: inactive",
    `${emptyUfwAdded}\nufw allow 22/tcp`,
  ])("rejects empty or unrecognized saved-rule audit output %j before host writes", (ufwAdded) => {
    const f = hardenFixture();
    f.faults({ ufwAdded });
    expect(f.runHarden().status).not.toBe(0);
    expectNoHardeningWrites(f);
  });

  it.each([{ showAddedFail: true }, { ruleReadFail: true }])(
    "rejects a failed saved-rule audit before host writes %j",
    (fault) => {
      const f = hardenFixture();
      f.faults(fault);
      expect(f.runHarden().status).not.toBe(0);
      expectNoHardeningWrites(f);
    },
  );

  it.each(["user.rules", "user6.rules"])(
    "rejects saved tuples omitted by the report, including disabled IPv6 rules in %s",
    (file) => {
      const f = hardenFixture();
      const rules = path.join(f.etc, "ufw", file);
      const network = file === "user.rules" ? "0.0.0.0/0" : "::/0";
      const saved = `### tuple ### allow tcp 5432 ${network} any ${network} in\n`;
      write(rules, saved);
      f.faults({ ufwStatus: "Status: inactive", ufwAdded: emptyUfwAdded });
      expect(f.runHarden().status).not.toBe(0);
      expectNoHardeningWrites(f);
      expect(readFileSync(rules, "utf8")).toBe(saved);
      const result = f.runHarden({ PRESERVE_EXISTING_UFW_RULES: "1" });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(rules, "utf8")).toBe(saved);
      expect(f.pending()).toBe(true);
    },
  );

  it.each(["missing", "symlink", "directory", "fifo"])(
    "rejects a %s saved IPv6 rule file before trying to read it",
    (kind) => {
      const f = hardenFixture();
      const file = path.join(f.etc, "ufw", "user6.rules");
      rmSync(file);
      if (kind === "symlink") symlinkSync(path.join(f.etc, "default", "ufw"), file);
      else if (kind === "directory") mkdirSync(file);
      else if (kind === "fifo") execFileSync("mkfifo", [file]);
      expect(f.runHarden().status).not.toBe(0);
      expectNoHardeningWrites(f);
      expect(f.calls().some((call) => call[0] === "grep" && call.includes(file))).toBe(false);
      expect(f.calls().some((call) => call[0] === "ufw" && call[1] === "show")).toBe(false);
    },
  );

  it.each(["directory-symlink", "rules-directory", "rules6-fifo", "defaults-symlink"])(
    "rejects known unsafe UFW paths despite explicit rule-preservation acknowledgment: %s",
    (kind) => {
      const f = hardenFixture();
      if (kind === "directory-symlink") {
        const directory = path.join(f.etc, "ufw");
        const target = path.join(f.root, "saved-ufw");
        rmSync(directory, { recursive: true });
        mkdirSync(target);
        symlinkSync(target, directory);
      } else if (kind === "rules-directory") {
        const file = path.join(f.etc, "ufw", "user.rules");
        rmSync(file);
        mkdirSync(file);
      } else if (kind === "rules6-fifo") {
        const file = path.join(f.etc, "ufw", "user6.rules");
        rmSync(file);
        execFileSync("mkfifo", [file]);
      } else {
        const file = path.join(f.etc, "default", "ufw");
        rmSync(file);
        symlinkSync(path.join(f.etc, "ufw", "user.rules"), file);
      }
      const result = f.runHarden({ PRESERVE_EXISTING_UFW_RULES: "1" });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Unsafe or unreadable");
      expectNoHardeningWrites(f);
      expect(f.calls().some((call) => ["ufw", "grep"].includes(call[0] as string))).toBe(false);
    },
  );

  it.each(["default", "legacy-ufw", "retained-ufw"])(
    "rejects a saved configuration parent symlink despite explicit rule preservation: %s",
    (kind) => {
      const f = hardenFixture();
      const directory = kind === "default" ? path.join(f.etc, kind) : path.join(f.root, kind);
      const target = path.join(f.root, `saved-${kind}`);
      if (kind === "default") renameSync(directory, target);
      else mkdirSync(target);
      symlinkSync(target, directory);
      const result = f.runHarden({ PRESERVE_EXISTING_UFW_RULES: "1" });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Unsafe or unreadable");
      expectNoHardeningWrites(f);
      expect(f.calls().some((call) => ["ufw", "grep"].includes(call[0] as string))).toBe(false);
    },
  );

  it.each(
    [
      "etc",
      "etc/ufw",
      "etc/default",
      "legacy-ufw",
      "retained-ufw",
      "etc/ufw/user.rules",
      "etc/ufw/user6.rules",
      "etc/default/ufw",
      "legacy-ufw/user.rules",
      "legacy-ufw/user6.rules",
    ].flatMap((file) =>
      ["owner", "group-writable", "world-writable"].flatMap((hazard) =>
        ["0", "1"].map((ack) => ({ file, hazard, ack })),
      ),
    ),
  )(
    "rejects unprotected UFW permissions before host changes: $file/$hazard/$ack",
    ({ file, hazard, ack }) => {
      const f = hardenFixture();
      const target = path.join(f.root, file);
      const directory = ["etc", "etc/ufw", "etc/default", "legacy-ufw", "retained-ufw"].includes(
        file,
      );
      if (!existsSync(target)) {
        if (directory) mkdirSync(target, { recursive: true, mode: 0o755 });
        else write(target, "saved rules\n", 0o644);
      }
      if (hazard === "owner") f.faults({ owner: target });
      else
        chmodSync(
          target,
          directory
            ? hazard === "group-writable"
              ? 0o775
              : 0o777
            : hazard === "group-writable"
              ? 0o664
              : 0o666,
        );
      const result = f.runHarden({ PRESERVE_EXISTING_UFW_RULES: ack });
      expect(result.status).not.toBe(0);
      expectNoHardeningWrites(f);
      expect(f.calls().some((call) => ["ufw", "grep"].includes(call[0] as string))).toBe(false);
      expect(result.stderr).toContain("Unsafe or unreadable");
    },
  );

  it.each(["owner", "writable", "symlink", "find-failure"])(
    "rejects unsafe nested UFW configuration before host changes: %s",
    (hazard) => {
      const f = hardenFixture();
      const target = path.join(f.etc, "ufw", "ufw.conf");
      write(target, "ENABLED=yes\n", 0o644);
      if (hazard === "owner") f.faults({ owner: target });
      else if (hazard === "writable") chmodSync(target, 0o666);
      else if (hazard === "symlink") {
        rmSync(target);
        symlinkSync(path.join(f.etc, "default", "ufw"), target);
      } else f.faults({ findFail: true });
      const result = f.runHarden({ PRESERVE_EXISTING_UFW_RULES: "1" });
      expect(result.status).not.toBe(0);
      expectNoHardeningWrites(f);
      expect(f.calls().some((call) => ["ufw", "grep"].includes(call[0] as string))).toBe(false);
    },
  );

  it("rejects retained UFW configuration when its CLI is missing before installing packages", () => {
    const f = hardenFixture();
    rmSync(path.join(f.bin, "ufw"));
    const result = f.runHarden();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Cannot audit retained UFW configuration without ufw");
    expectNoHardeningWrites(f);
  });

  it("reports an unknown audit when the operator explicitly acknowledges preserving every rule", () => {
    const f = hardenFixture();
    f.faults({ showAddedFail: true });
    const result = f.runHarden({ PRESERVE_EXISTING_UFW_RULES: "1" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("Unable to audit existing UFW rules");
    expect(result.stderr).toContain("including public allows");
    expect(f.pending()).toBe(true);
  });

  it("routes hardening firewall edits through the armed guard without resetting private rules", () => {
    const f = hardenFixture();
    f.faults({ ufwAdded: `${emptyUfwAdded.split("\n")[0]}\nufw allow from 10.0.0.0/8` });
    const result = f.runHarden({ SSH_PORT: "2222", PRESERVE_EXISTING_UFW_RULES: "1" });
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
    f.faults({
      uuid: "12345678-1234-4234-8234-123456789abd",
      ufwAdded: `${emptyUfwAdded.split("\n")[0]}\nufw limit 22/tcp comment 'Rate-limited SSH'`,
    });
    const packagesBefore = f.calls().filter((call) => call[0] === "apt-get").length;
    expect(f.runHarden().status).not.toBe(0);
    expect(f.calls().filter((call) => call[0] === "apt-get")).toHaveLength(packagesBefore);
    const result = f.runHarden({ PRESERVE_EXISTING_UFW_RULES: "1" });
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

  it("rechecks confirmation under the shared lock when boot recovery was already queued", async () => {
    const f = fixture();
    expect(f.apply().status).toBe(0);
    write(path.join(f.etc, "ufw", "user.rules"), "accepted\n");
    f.reboot();
    const waiting = path.join(f.root, "boot-waiting"),
      release = path.join(f.root, "boot-release");
    const callback = f.start(["recover"], {
      SSH_CONNECTION: "",
      FW_FLOCK_WAITING: waiting,
      FW_FLOCK_RELEASE: release,
    });
    await waitForFile(waiting);
    expect(f.run(["confirm", token], { SSH_CONNECTION: secondConnection }).status).toBe(0);
    expect(f.read("confirmed")).toBe(token);
    write(release, "release");
    const result = await callback.done;
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(path.join(f.etc, "ufw", "user.rules"), "utf8")).toBe("accepted\n");
    expect(f.calls().some((call) => call[0] === "tar" && call.includes("-xpf"))).toBe(false);
  });

  it("does not let queued boot recovery restore a newer current-boot generation", async () => {
    const f = fixture();
    expect(f.apply().status).toBe(0);
    const waiting = path.join(f.root, "boot-waiting"),
      release = path.join(f.root, "boot-release");
    const callback = f.start(["recover"], {
      FW_FLOCK_WAITING: waiting,
      FW_FLOCK_RELEASE: release,
    });
    await waitForFile(waiting);
    expect(f.run(["confirm", token], { SSH_CONNECTION: secondConnection }).status).toBe(0);
    const next = "12345678-1234-4234-8234-123456789abd";
    f.faults({ uuid: next });
    expect(f.apply().status).toBe(0);
    write(path.join(f.etc, "ufw", "user.rules"), "new generation\n");
    write(release, "release");
    const result = await callback.done;
    expect(result.status, result.stderr).toBe(0);
    expect(f.read("token")).toBe(next);
    expect(readFileSync(path.join(f.etc, "ufw", "user.rules"), "utf8")).toBe("new generation\n");
    expect(f.calls().some((call) => call[0] === "tar" && call.includes("-xpf"))).toBe(false);
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
