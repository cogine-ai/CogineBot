import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const temporaryDirectories: string[] = [];

type ScriptResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};
const runningScripts = new Set<{ pid: number; result: Promise<ScriptResult> }>();
function signalGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
async function waitForFile(file: string) {
  const deadline = Date.now() + 10_000;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error("Fixture command did not reach its ready gate");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
afterEach(async () => {
  for (const running of runningScripts) signalGroup(running.pid, "SIGKILL");
  for (const running of runningScripts) await running.result;
  runningScripts.clear();
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function write(file: string, content: string, mode?: number) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  if (mode) chmodSync(file, mode);
}
function git(cwd: string, ...args: string[]) {
  return execFileSync("/usr/bin/git", args, { cwd, encoding: "utf8" }).trim();
}
function commit(cwd: string, message: string) {
  write(path.join(cwd, "revision.txt"), `${message}\n`);
  git(cwd, "add", "revision.txt");
  git(
    cwd,
    "-c",
    "user.name=Example",
    "-c",
    "user.email=example@example.test",
    "commit",
    "-qm",
    message,
  );
  return git(cwd, "rev-parse", "HEAD");
}

type ImageRecord = {
  Id: string;
  RepoTags: string[];
  RepoDigests: string[];
  Config: { Labels: Record<string, string> };
};
type ContainerRecord = {
  Id: string;
  Name: string;
  Image: string;
  Config: { Image: string; Labels: Record<string, string> };
  State: { Status: string };
  Mounts: { Type: string; Name: string; Destination: string; Source: string; RW: boolean }[];
};
type DockerState = {
  daemonId: string;
  dockerRoot: string;
  context: string;
  endpoint: string;
  initialRevision: string;
  config: {
    name: string;
    services: Record<string, { image: string; build?: { context: string }; profiles?: string[] }>;
  };
  images: Record<string, ImageRecord>;
  containers: Record<string, ContainerRecord>;
  builders: Record<
    string,
    { name: string; node: string; image: string; cid: string; volume: string }
  >;
  volumes: Record<string, { Name: string; Driver: string; Labels: null; Mountpoint: string }>;
  readyAttempts: number;
  builds: number;
  pulls: number;
  lastBuiltId: string | null;
  ups: number;
  prunes: number;
  bootstraps: number;
  removed: string[];
  activeProfiles: string[];
  failedBuild?: boolean;
};
type ServiceImage = { service: string; id: string; ref: string };
type DeploymentRecord = {
  version: number;
  owner: { id: string; appDir: string; project: string; daemonId: string; endpoint: string };
  builder: { name: string; node: string; containerId: string; volume: string; imageId: string };
  images: { ref: string; id: string }[];
  healthy: null | { revision: string; services: ServiceImage[]; previous: ServiceImage[] };
};

const dockerStub = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const input = process.argv.slice(2);
const file = process.env.DOCKER_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
fs.appendFileSync(process.env.COMMAND_LOG, 'docker ' + input.join(' ') + ' @ ' + cp.execFileSync('git', ['rev-parse', '--short', 'HEAD'], {encoding:'utf8'}).trim() + '\n');
fs.appendFileSync(process.env.DOCKER_ARGUMENTS_LOG, Buffer.from(input.length+'\0'+input.join('\0')+'\0'));
fs.appendFileSync(process.env.COMPOSE_SELECTORS_LOG, JSON.stringify({project:process.env.COMPOSE_PROJECT_NAME ?? null, profiles:process.env.COMPOSE_PROFILES ?? null})+'\n');
function save() { fs.writeFileSync(file, JSON.stringify(state)); }
function out(x) { save(); process.stdout.write((typeof x === 'string' ? x : JSON.stringify(x)) + '\n'); process.exit(0); }
function fail(message, code = 1) { save(); if (message) process.stderr.write(message + '\n'); process.exit(code); }
let args = [...input];
while (args[0] === '--host' || args[0] === '-H' || args[0] === '--context') {
 const option = args.shift(), value = args.shift();
 if (option !== '--context' && value !== state.endpoint) fail('wrong endpoint');
 if (option === '--context' && value !== state.context) fail('wrong context');
}
const key = args.join(' ');
if (process.env.HOLD_COMMAND_MATCH && key.includes(process.env.HOLD_COMMAND_MATCH)) { fs.writeFileSync(process.env.HOLD_READY, 'ready'); while (!fs.existsSync(process.env.HOLD_RELEASE)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); }
if (process.env.FAIL_DOCKER_MATCH && key.includes(process.env.FAIL_DOCKER_MATCH)) fail('injected Docker failure');
if (key === 'context show') out(process.env.CONTEXT_SHOW || state.context);
if (args[0] === 'context' && args[1] === 'inspect' && args.length === 3) {
 if (process.env.BAD_CONTEXT_JSON) out(process.env.BAD_CONTEXT_JSON);
 out([{Name:state.context, Endpoints:{docker:{Host:process.env.CONTEXT_ENDPOINT ?? state.endpoint}}}]);
}
if (key === "info --format {{json .}}") {
 if (process.env.BAD_INFO_JSON) out(process.env.BAD_INFO_JSON);
 out({ID:(process.env.DAEMON_ID_AFTER_BUILD && state.builds > 0) ? process.env.DAEMON_ID_AFTER_BUILD : process.env.DAEMON_ID || state.daemonId, DockerRootDir:process.env.DOCKER_ROOT ?? state.dockerRoot, ServerVersion:'27.5.1'});
}
if (key === 'buildx version') out(process.env.BUILDX_VERSION || 'github.com/docker/buildx v0.20.1 example');
if (key === "buildx ls --format {{json .Builder}}") {
 if (process.env.BAD_BUILDERS_JSON) out(process.env.BAD_BUILDERS_JSON);
 const list = Object.values(state.builders).map(b => ({Name:b.name, Driver:process.env.BUILDER_DRIVER || 'docker-container', Nodes:[{Name:b.node, Endpoint:process.env.BUILDER_ENDPOINT || state.endpoint, DriverOpts:{'default-load':'true', image:b.image}}]}));
 out(list.map(x=>JSON.stringify(x)).join('\n'));
}
if (args[0] === 'buildx' && args[1] === 'create') {
 const nameIndex=args.indexOf('--name'), nodeIndex=args.indexOf('--node'), driverIndex=args.indexOf('--driver');
 if (nameIndex < 0 || nodeIndex < 0 || driverIndex < 0 || args[driverIndex+1] !== 'docker-container' || args.includes('--use')) fail('unsupported builder create shape', 2);
 const name=args[nameIndex+1], node=args[nodeIndex+1];
 const opts=args.filter((v,i)=>args[i-1] === '--driver-opt');
 const imageOpt=opts.find(x=>x.startsWith('image='));
 if (!opts.includes('default-load=true') || !imageOpt || !/moby\/buildkit.*@sha256:[0-9a-f]{64}$/.test(imageOpt.slice(6))) fail('unpinned builder image',2);
 if (args.at(-1) !== state.endpoint || state.builders[name]) fail('builder collision');
 const cid='e'.repeat(64), volume='buildx_buildkit_'+node+'_state';
 state.builders[name]={name,node,image:imageOpt.slice(6),cid,volume};
 state.images['sha256:'+'f'.repeat(64)]={Id:'sha256:'+'f'.repeat(64),RepoTags:[],RepoDigests:[imageOpt.slice(6)],Config:{Labels:{}}};
 state.containers[cid]={Id:cid,Name:'/buildx_buildkit_'+node,Image:'sha256:'+'f'.repeat(64),Config:{Image:imageOpt.slice(6),Labels:{}},State:{Status:'running'},Mounts:[{Type:'volume',Name:volume,Destination:'/var/lib/buildkit',Source:'/var/lib/docker/volumes/'+volume+'/_data',RW:true}]};
 state.volumes[volume]={Name:volume,Driver:'local',Labels:null,Mountpoint:'/var/lib/docker/volumes/'+volume+'/_data'};
 out(name);
}
if (args[0] === 'buildx' && args[1] === 'inspect' && args.includes('--bootstrap')) {
 const name=args.find((v,i)=>i>1&&!v.startsWith('-'));
 if (!name || !state.builders[name]) fail('unknown builder');
 if (process.env.FAIL_BOOTSTRAP) fail('bootstrap failed');
 state.bootstraps++;
 out('Name: '+name+'\nDriver: docker-container\n');
}
if (args[0] === 'buildx' && args[1] === 'prune') {
 const index=args.indexOf('--builder'), name=args[index+1];
 if (index<0 || !state.builders[name] || !args.includes('--all') || !args.includes('--force') || !args.includes('until=24h') || args.length !== 8) fail('unsupported builder prune shape',2);
 state.prunes++;
 out('Total: 0B');
}
if (key === "image ls --no-trunc --format {{json .}}") {
 if (process.env.BAD_IMAGES_JSON) out(process.env.BAD_IMAGES_JSON);
 const rows=[]; for(const image of Object.values(state.images)) { for (const ref of image.RepoTags) { const split=ref.lastIndexOf(':');rows.push({Repository:ref.slice(0,split),Tag:ref.slice(split+1),ID:image.Id}); } if(!image.RepoTags.length) rows.push({Repository:'<none>',Tag:'<none>',ID:image.Id}); } out(rows.map(x=>JSON.stringify(x)).join('\n'));
}
if (key === "container ls --all --no-trunc --format {{json .}}") {
 if (process.env.BAD_CONTAINERS_JSON) out(process.env.BAD_CONTAINERS_JSON);
 out(Object.values(state.containers).map(c=>JSON.stringify({ID:c.Id,Names:c.Name.replace(/^\//,''),Image:c.Config.Image,State:c.State.Status,Labels:Object.entries(c.Config.Labels || {}).map(([k,v])=>k+'='+v).join(',')})).join('\n'));
}
if (args[0] === 'container' && args[1] === 'inspect' && args.length>=3) {
 if (process.env.BAD_CONTAINER_INSPECT_JSON) out(process.env.BAD_CONTAINER_INSPECT_JSON);
 const found=args.slice(2).map(id=>Object.values(state.containers).find(c=>c.Id===id || c.Name.replace(/^\//,'')===id));
 if (found.some(x=>!x)) fail('container not found');
 out(found);
}
if (key === "volume ls --format {{json .}}") {
 if (process.env.BAD_VOLUMES_JSON) out(process.env.BAD_VOLUMES_JSON);
 out(Object.values(state.volumes).map(v=>JSON.stringify({Name:v.Name,Driver:v.Driver,Labels:''})).join('\n'));
}
if (args[0] === 'volume' && args[1] === 'inspect' && args.length>=3) {
 if (process.env.BAD_VOLUME_INSPECT_JSON) out(process.env.BAD_VOLUME_INSPECT_JSON);
 const found=args.slice(2).map(name=>state.volumes[name]);
 if (found.some(x=>!x)) fail('volume not found');
 out(found);
}
if (args[0] === 'image' && args[1] === 'inspect' && args.length>=3) {
 if (process.env.BAD_IMAGE_INSPECT_JSON) out(process.env.BAD_IMAGE_INSPECT_JSON);
 const found=args.slice(2).map(ref=>Object.values(state.images).find(im=>im.Id===ref || im.RepoTags.includes(ref)));
 if (found.some(x=>!x)) fail('image not found');
 out(found);
}
if (args[0] === 'image' && args[1] === 'tag' && args.length===4) {
 const image=state.images[args[2]];
 if (!image) fail('image not found');
 for (const old of Object.values(state.images)) old.RepoTags=old.RepoTags.filter(ref=>ref!==args[3]);
 image.RepoTags.push(args[3]);
 out('');
}
if (args[0] === 'image' && args[1] === 'rm' && args.length===3) {
 const ref=args[2], image=Object.values(state.images).find(im=>im.RepoTags.includes(ref));
 if (!image) fail('image reference not found');
 image.RepoTags=image.RepoTags.filter(x=>x!==ref);state.removed.push(ref);
 out(ref);
}
if (args[0] === 'compose') {
 let i=1, project=null, files=[], profiles=null;
 while (i<args.length) {
  if (args[i]==='--env-file' || args[i]==='-f' || args[i]==='--file' || args[i]==='-p' || args[i]==='--project-name' || args[i]==='--profile') {
   const flag=args[i++],value=args[i++];
   if (value === undefined) fail('missing Compose option value',2);
   if (flag==='-f'||flag==='--file') files.push(value);
   if (flag==='-p'||flag==='--project-name') project=value;
   if (flag==='--profile') { profiles ??= []; profiles.push(value); }
  } else break;
 }
 const op=args[i++], tail=args.slice(i);
 if (op==='build' && tail.length===1 && tail[0]==='--help' && files.length===0) out(process.env.COMPOSE_BUILD_HELP || 'Usage: docker compose build\n --builder string Set builder');
 if (op==='pull' && tail.length===1 && tail[0]==='--help' && files.length===0) out(process.env.COMPOSE_PULL_HELP || 'Usage: docker compose pull\n --ignore-buildable Skip buildable images\n --policy string Pull policy');
 if (files[0] !== 'infra/compose/docker-compose.prod.yml') fail('unexpected Compose file',2);
 const revision=cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
 const envFile=Object.fromEntries(fs.readFileSync('.env','utf8').split('\n').flatMap(line=>{const match=/^(COMPOSE_PROJECT_NAME|COMPOSE_PROFILES)=(.*)$/.exec(line);return match?[[match[1],match[2]]]:[]}));
 const activeProfiles=profiles !== null ? profiles.filter(Boolean) : (process.env.COMPOSE_PROFILES ?? envFile.COMPOSE_PROFILES)?.split(',').map(s=>s.trim()).filter(Boolean) ?? state.activeProfiles;
 const config=JSON.parse(JSON.stringify(state.config));
 for (const [service,value] of Object.entries(config.services)) if (value.profiles && !activeProfiles.some(p=>p==='*' || value.profiles.includes(p))) delete config.services[service];
 if (process.env.TARGET_PROJECT && revision !== state.initialRevision) config.name=process.env.TARGET_PROJECT;
 if (process.env.TARGET_IMAGE_REF && revision !== state.initialRevision) config.services.api.image=process.env.TARGET_IMAGE_REF;
 if (state.failedBuild && revision === state.initialRevision) {
  if (process.env.ROLLBACK_PROJECT) config.name=process.env.ROLLBACK_PROJECT;
  if (process.env.ROLLBACK_ADD_SERVICE) config.services.extra={image:'postgres:16'};
  if (process.env.ROLLBACK_REMOVE_SERVICE) delete config.services.web;
  if (process.env.ROLLBACK_RENAME_SERVICE) { config.services.worker=config.services.web; delete config.services.web; }
 }
 if (envFile.COMPOSE_PROJECT_NAME) config.name=envFile.COMPOSE_PROJECT_NAME;
 if (process.env.COMPOSE_PROJECT_NAME) config.name=process.env.COMPOSE_PROJECT_NAME;
 if (project) config.name=project;
 if (op==='build' && tail.length===1 && tail[0]==='--help') out(process.env.COMPOSE_BUILD_HELP || 'Usage: docker compose build\n --builder string Set builder');
 if (op==='config' && tail.length===2 && tail[0]==='--format' && tail[1]==='json') {
  if(process.env.BAD_CONFIG_JSON) out(process.env.BAD_CONFIG_JSON);
  out(config);
 }
 if (op==='config' && tail.length===1 && tail[0]==='--quiet') out('');
 if (op==='exec' && tail[0]==='-T' && tail[1]==='api' && tail[2]==='node' && tail[3]==='-e' && tail.length===5) {
  state.readyAttempts++;
  if (process.env.FAIL_READY || state.readyAttempts<=Number(process.env.READY_RECOVER_AFTER || 0)) fail('readiness unavailable');
  out('');
 }
 if (op==='pull' && tail.join(' ')==='--ignore-buildable --policy missing') {
  if (process.env.FAIL_PULL) fail('dependency pull failed');
  for (const [service,value] of Object.entries(config.services)) {
   if(value.build) continue;
   if(!Object.values(state.images).some(image=>image.RepoTags.includes(value.image))) {
    const id=service==='postgres' ? 'sha256:'+'c'.repeat(64) : 'sha256:'+crypto.createHash('sha256').update(value.image).digest('hex');
    state.images[id]={Id:id,RepoTags:[value.image],RepoDigests:[],Config:{Labels:{}}};
   }
  }
  state.pulls++;out('');
 }
 if (op==='build') {
  if (!(tail.length===0 || (tail.length===2 && tail[0]==='--builder' && state.builders[tail[1]]))) fail('unsupported build shape',2);
  if (process.env.FAIL_BUILD) { state.failedBuild=true; fail('build failed'); }
  const imageId='sha256:'+crypto.createHash('sha256').update(revision).digest('hex');
  const refs=[...new Set(Object.values(config.services).filter(x=>x.build).map(x=>x.image))];
  for (const old of Object.values(state.images)) old.RepoTags=old.RepoTags.filter(ref=>!refs.includes(ref));
  const existing=state.images[imageId];
  state.images[imageId]={Id:imageId,RepoTags:[...new Set([...(existing?.RepoTags || []),...refs])],RepoDigests:existing?.RepoDigests || [],Config:{Labels:{}}};
  state.builds++;state.lastBuiltId=imageId;out('');
 }
 if (op==='up') {
  const rollback=files.at(-1)?.endsWith('/rollback.json') || tail.includes('--build');
  if (process.env.FAIL_UP && !rollback) fail('up failed');
  if (process.env.FAIL_ROLLBACK_UP && rollback) fail('rollback up failed');
  if (process.env.RETAG_BEFORE_UP && !rollback) {
   for(const value of Object.values(config.services)) {
    for (const old of Object.values(state.images)) old.RepoTags=old.RepoTags.filter(ref=>ref!==value.image);
    state.images['sha256:'+'a'.repeat(64)].RepoTags.push(value.image);
   }
  }
  let services=config.services;
  if (files.length>1) {
   const override=JSON.parse(fs.readFileSync(files.at(-1),'utf8'));
   services=Object.fromEntries(Object.entries(config.services).map(([name,value])=>[name,{...value,...override.services[name]}]));
  }
  for (const [name,value] of Object.entries(services)) {
   if (value.profiles && !activeProfiles.some(p=>p==='*' || value.profiles.includes(p))) continue;
   const image=Object.values(state.images).find(im=>im.Id===value.image || im.RepoTags.includes(value.image));
   if (!image) fail('up image missing for '+name);
   let container=Object.values(state.containers).find(c=>c.Config.Labels['com.docker.compose.project']===config.name && c.Config.Labels['com.docker.compose.service']===name);
   if (!container) {
    const cid=crypto.createHash('sha256').update(config.name+'/'+name).digest('hex');
    container={Id:cid,Name:'/'+config.name+'-'+name+'-1',Config:{Labels:{'com.docker.compose.project':config.name,'com.docker.compose.service':name}},State:{Status:'running'},Mounts:[]};
    state.containers[cid]=container;
   }
   container.Image=(process.env.UP_IMAGE_MISMATCH && !rollback && name==='api') ? 'sha256:'+'a'.repeat(64) : (process.env.ROLLBACK_IMAGE_MISMATCH && rollback && name==='api') ? 'sha256:'+'c'.repeat(64) : image.Id;container.Config.Image=value.image;
  }
  state.ups++;out('');
 }
 fail('unsupported Compose shape: '+key,2);
}
fail('unsupported Docker shape: '+key,2);
`;

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "rakazo-deploy-")));
  temporaryDirectories.push(root);
  const upstream = path.join(root, "upstream");
  const checkout = path.join(root, "checkout with spaces");
  const bin = path.join(root, "bin");
  mkdirSync(upstream);
  git(upstream, "init", "-q", "-b", "main");
  const first = commit(upstream, "first");
  git(root, "clone", "-q", upstream, checkout);
  write(path.join(checkout, ".env"), "RAKAZO_HOST=app.example.test\n");
  const dockerRoot = path.join(root, "Docker storage with spaces");
  mkdirSync(dockerRoot);
  const stateFile = path.join(root, "docker-state.json");
  const log = path.join(root, "commands.log");
  const argvLog = path.join(root, "docker-arguments.log");
  const eventsLog = path.join(root, "events.log");
  const composeSelectorsLog = path.join(root, "compose-selectors.log");
  const firstImage = `sha256:${"a".repeat(64)}`;
  const databaseImage = `sha256:${"c".repeat(64)}`;
  const project = "example-prod";
  const serviceImages: Record<string, string> = {
    api: firstImage,
    web: firstImage,
    postgres: databaseImage,
  };
  const images: Record<string, ImageRecord> = {
    [firstImage]: {
      Id: firstImage,
      RepoTags: ["example/app:local"],
      RepoDigests: [],
      Config: { Labels: {} },
    },
    [databaseImage]: {
      Id: databaseImage,
      RepoTags: ["postgres:16"],
      RepoDigests: [],
      Config: { Labels: {} },
    },
  };
  const containers = Object.fromEntries(
    Object.entries(serviceImages).map(([service, image], index) => {
      const id = String(index + 1).repeat(64);
      return [
        id,
        {
          Id: id,
          Name: `/${project}-${service}-1`,
          Image: image,
          Config: {
            Image: service === "postgres" ? "postgres:16" : "example/app:local",
            Labels: {
              "com.docker.compose.project": project,
              "com.docker.compose.service": service,
            },
          },
          State: { Status: "running" },
          Mounts: [],
        },
      ];
    }),
  );
  const initial: DockerState = {
    daemonId: "d".repeat(64),
    dockerRoot,
    context: "default",
    endpoint: "unix:///var/run/docker.sock",
    initialRevision: first,
    config: {
      name: project,
      services: {
        api: { image: "example/app:local", build: { context: "../.." } },
        web: { image: "example/app:local", build: { context: "../.." } },
        postgres: { image: "postgres:16" },
      },
    },
    images,
    containers,
    builders: {},
    volumes: {},
    readyAttempts: 0,
    builds: 0,
    pulls: 0,
    lastBuiltId: null,
    ups: 0,
    prunes: 0,
    bootstraps: 0,
    removed: [],
    activeProfiles: [],
  };
  write(stateFile, JSON.stringify(initial));
  // Model only the two Compose selectors commonly removed by sudo env_reset.
  write(
    path.join(bin, "sudo"),
    '#!/bin/bash\nunset COMPOSE_PROJECT_NAME COMPOSE_PROFILES\nexec "$@"\n',
    0o755,
  );
  write(
    path.join(bin, "timeout"),
    '#!/bin/bash\nprintf "%s\\0" "$@" >> "$TIMEOUT_LOG"\nprintf "\\0" >> "$TIMEOUT_LOG"\nwhile [[ "$1" == --* ]]; do shift; done\nshift\nexec "$@"\n',
    0o755,
  );
  write(path.join(bin, "docker"), dockerStub, 0o755);
  write(
    path.join(bin, "git"),
    '#!/bin/bash\nif [[ "$1" == fetch || "$1" == reset ]]; then printf "git %s\\n" "$*" >> "$EVENTS_LOG"; fi\nexec /usr/bin/git "$@"\n',
    0o755,
  );
  write(
    path.join(bin, "curl"),
    `#!/bin/bash\necho "curl \${*: -1}" >> "$COMMAND_LOG"\n[[ -z "\${FAIL_HEALTH:-}" ]]\n`,
    0o755,
  );
  write(path.join(bin, "flock"), `#!/bin/bash\n[[ -z "\${LOCK_HELD:-}" ]]\n`, 0o755);
  write(
    path.join(bin, "df"),
    `#!/usr/bin/env node
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.env.DOCKER_STATE, 'utf8'));
const args = process.argv.slice(2), p = args.at(-1);
fs.appendFileSync(process.env.EVENTS_LOG, 'df ' + JSON.stringify(args) + '\\n');
if (process.env.FAIL_DF || (process.env.FAIL_DF_PATH && p.includes(process.env.FAIL_DF_PATH))) process.exit(1);
if (process.env.DF_RAW !== undefined) { process.stdout.write(process.env.DF_RAW); process.exit(0); }
const isDocker = p === state.dockerRoot;
const value = isDocker ? process.env.DOCKER_FREE_KB : process.env.APP_FREE_KB;
const reads = process.env.FREE_KB ?? '52428800';
const free = value === undefined ? reads : value;
const after = isDocker ? process.env.DOCKER_FREE_AFTER_PRUNE : process.env.APP_FREE_AFTER_PRUNE;
const afterBootstrap = isDocker ? process.env.DOCKER_FREE_AFTER_BOOTSTRAP : process.env.APP_FREE_AFTER_BOOTSTRAP;
const afterPull = isDocker ? process.env.DOCKER_FREE_AFTER_PULL : process.env.APP_FREE_AFTER_PULL;
const available = state.pulls && afterPull !== undefined ? afterPull : state.prunes && after !== undefined ? after : state.bootstraps && afterBootstrap !== undefined ? afterBootstrap : free;
console.log('Filesystem 1024-blocks Used Available Capacity Mounted on');
console.log('/dev/fake 104857600 0 ' + available + ' 0% /');
`,
    0o755,
  );
  write(
    path.join(bin, "mv"),
    `#!/usr/bin/env node
const fs=require('node:fs'), cp=require('node:child_process'), path=require('node:path');
const args=process.argv.slice(2), target=args.at(-1), source=args.at(-2);
if (process.env.FAIL_LEGACY_PUBLISH && path.basename(target)==='.last-deployed-revision') process.exit(1);
if (path.basename(target)==='state.json') {
 const candidate=JSON.parse(fs.readFileSync(source,'utf8'));
 const old=fs.existsSync(target) ? JSON.parse(fs.readFileSync(target,'utf8')) : null;
 if (process.env.FAIL_FIRST_STATE_PUBLISH && !old) process.exit(1);
 if (process.env.FAIL_LEDGER_PUBLISH && old && candidate.images.length > old.images.length) process.exit(1);
 if (process.env.FAIL_HEALTHY_PUBLISH && candidate.healthy && (!old || candidate.healthy.revision !== old.healthy?.revision)) process.exit(1);
}
const priorRevision=path.basename(target)==='state.json' && fs.existsSync(target) ? JSON.parse(fs.readFileSync(target,'utf8')).healthy?.revision : null;
const result=cp.spawnSync('/bin/mv',args,{stdio:'inherit'});
if (process.env.FAIL_AFTER_HEALTHY_PUBLISH && path.basename(target)==='state.json' && result.status===0) { const committed=JSON.parse(fs.readFileSync(target,'utf8')); if(committed.healthy && committed.healthy.revision!==priorRevision) process.exit(1); }
process.exit(result.status ?? 1);
`,
    0o755,
  );
  const holdReady = path.join(root, "command-ready"),
    holdRelease = path.join(root, "command-release");
  const env = {
    PATH: [bin, path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
    HOME: root,
    COMMAND_LOG: log,
    DOCKER_ARGUMENTS_LOG: argvLog,
    COMPOSE_SELECTORS_LOG: composeSelectorsLog,
    EVENTS_LOG: eventsLog,
    DOCKER_STATE: stateFile,
    HOLD_READY: holdReady,
    HOLD_RELEASE: holdRelease,
    TIMEOUT_LOG: path.join(root, "timeouts.log"),
    RAKAZO_DEPLOY_DIR: checkout,
    RAKAZO_DEPLOY_HEALTH_INTERVAL: "0",
  };
  const state = (): DockerState => JSON.parse(readFileSync(stateFile, "utf8"));
  const update = (change: (value: DockerState) => void) => {
    const value = state();
    change(value);
    write(stateFile, JSON.stringify(value));
  };
  const dockerArguments = (): string[][] => {
    if (!existsSync(argvLog)) return [];
    const raw = readFileSync(argvLog, "utf8");
    if (raw.length === 0) return [];
    const words = raw.split("\0");
    let offset = 0;
    const commands: string[][] = [];
    while (offset < words.length - 1) {
      const countText = words[offset++]!;
      expect(countText).toMatch(/^[1-9][0-9]*$/);
      const count = Number(countText);
      expect(Number.isSafeInteger(count) && count <= words.length - offset - 1).toBe(true);
      const command = words.slice(offset, offset + count);
      offset += count;
      commands.push(command);
    }
    expect(offset).toBe(words.length - 1);
    expect(words[offset]).toBe("");
    return commands;
  };
  const stateDirectory = path.join(checkout, ".git", "coginebot-deploy");
  const recordPath = path.join(stateDirectory, "state.json");
  return {
    root,
    upstream,
    checkout,
    bin,
    first,
    firstImage,
    databaseImage,
    dockerRoot,
    project,
    stateDirectory,
    recordPath,
    state,
    update,
    env,
    holdReady,
    holdRelease,
    next: (message = "next") => commit(upstream, message),
    run(overrides: Record<string, string> = {}) {
      const result = spawnSync("/bin/bash", [path.join(repoRoot, "infra/compose/deploy-main.sh")], {
        cwd: root,
        env: { ...env, ...overrides },
        encoding: "utf8",
        timeout: 20_000,
      });
      expect(result.error).toBeUndefined();
      return result;
    },
    start(overrides: Record<string, string> = {}) {
      const child = spawn("/bin/bash", [path.join(repoRoot, "infra/compose/deploy-main.sh")], {
        cwd: root,
        env: { ...env, ...overrides },
        detached: true,
      });
      if (!child.pid) throw new Error("Fixture child did not start");
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const result = new Promise<ScriptResult>((resolve, reject) => {
        const deadline = setTimeout(() => signalGroup(child.pid!, "SIGKILL"), 20_000);
        child.on("error", reject);
        child.on("close", (status, signal) => {
          clearTimeout(deadline);
          resolve({ status, signal, stdout, stderr });
        });
      });
      const running = { pid: child.pid, result };
      runningScripts.add(running);
      return running;
    },
    commands: (): string[] =>
      existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [],
    events: (): string[] =>
      existsSync(eventsLog)
        ? readFileSync(eventsLog, "utf8").trim().split("\n").filter(Boolean)
        : [],
    dockerArguments,
    cliSelectors: (): { project: string | null; profiles: string | null }[] =>
      existsSync(composeSelectorsLog)
        ? readFileSync(composeSelectorsLog, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [],
    composeArguments: (op: string) =>
      dockerArguments().filter((args) => composeOperation(args)[0] === op),
    record: (): DeploymentRecord => JSON.parse(readFileSync(recordPath, "utf8")),
    readyAttempts: () => state().readyAttempts,
    clearLogs() {
      for (const file of [log, argvLog, eventsLog, env.TIMEOUT_LOG, composeSelectorsLog])
        write(file, "");
      update((s) => {
        s.readyAttempts = 0;
      });
    },
    timeouts: () =>
      existsSync(env.TIMEOUT_LOG)
        ? readFileSync(env.TIMEOUT_LOG, "utf8").replaceAll("\0", " ")
        : "",
    head: () => git(checkout, "rev-parse", "HEAD"),
    deployed: () =>
      existsSync(path.join(checkout, ".last-deployed-revision"))
        ? readFileSync(path.join(checkout, ".last-deployed-revision"), "utf8").trim()
        : undefined,
  };
}

function assertNoUnsafeCleanup(deploy: ReturnType<typeof fixture>) {
  for (const raw of deploy.dockerArguments()) {
    const args = dockerOperation(raw);
    expect(args).not.toContain("--use");
    expect(args).not.toContain("system");
    expect(args).not.toContain("--force-rm");
    expect(args).not.toContain("-v");
    expect(args.slice(0, 2)).not.toEqual(["builder", "prune"]);
    expect(args.slice(0, 2)).not.toEqual(["image", "prune"]);
    expect(args.slice(0, 2)).not.toEqual(["volume", "rm"]);
    const compose = composeOperation(raw);
    if (compose[0] === "build" && !compose.includes("--help")) {
      expect(compose[1]).toBe("--builder");
      expect(compose[2]).toMatch(/^coginebot-deploy-[a-f0-9]{32}$/);
    }
    if (compose[0] === "up") {
      expect(compose).toContain("--no-build");
      expect(compose.slice(-2)).toEqual(["--pull", "never"]);
      expect(
        raw.some((arg) => arg.endsWith("/forward.json") || arg.endsWith("/rollback.json")),
      ).toBe(true);
    }
    if (args[0] === "image" && args[1] === "rm") {
      expect(args).toHaveLength(3);
      expect(args[2]).toMatch(/^coginebot-deploy-[a-f0-9]{32}:[a-f0-9]{64}$/);
    }
  }
}

function dockerOperation(args: string[]) {
  return args[0] === "--host" || args[0] === "--context" ? args.slice(2) : args;
}
function composeOperation(args: string[]) {
  const command = dockerOperation(args);
  let index = 1;
  while (
    ["--env-file", "-f", "--file", "-p", "--project-name", "--profile"].includes(
      command[index] || "",
    )
  )
    index += 2;
  return command[0] === "compose" ? command.slice(index) : [];
}
function prime(deploy: ReturnType<typeof fixture>) {
  const result = deploy.run();
  expect(result.status, result.stderr).toBe(0);
  deploy.clearLogs();
  return deploy.record();
}
function expectAdmissionFailure(
  deploy: ReturnType<typeof fixture>,
  result: ReturnType<ReturnType<typeof fixture>["run"]>,
) {
  expect(result.status, result.stderr).not.toBe(0);
  expect(
    deploy.events().some((line) => line.startsWith("git fetch") || line.startsWith("git reset")),
  ).toBe(false);
  expect(
    deploy
      .dockerArguments()
      .some((args) => composeOperation(args)[0] === "build" && !args.includes("--help")),
  ).toBe(false);
  expect(deploy.head()).toBe(deploy.first);
  expect(deploy.deployed()).toBeUndefined();
  assertNoUnsafeCleanup(deploy);
}
function imageMutations(deploy: ReturnType<typeof fixture>) {
  return deploy
    .dockerArguments()
    .map(dockerOperation)
    .filter((args) => args[0] === "image" && ["tag", "rm"].includes(args[1] || ""));
}

describe("production deploy script", () => {
  it("fails instead of reporting success while another deploy holds the lock", () => {
    const deploy = fixture();
    deploy.next();
    const result = deploy.run({ LOCK_HELD: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("holds the lock");
    expect(deploy.head()).toBe(deploy.first);
    expect(deploy.commands()).toEqual([]);
    expect(deploy.events()).toEqual([]);
  });
  it("checks public health and container readiness when production is already current", () => {
    const deploy = fixture();
    prime(deploy);
    const before = deploy.state();
    const result = deploy.run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("already at");
    expect(deploy.commands()).toContain("curl https://app.example.test/health");
    expect(deploy.readyAttempts()).toBe(1);
    expect(deploy.state().builds).toBe(before.builds);
    expect(deploy.state().ups).toBe(before.ups);
  });
  it("deploys when the checkout matches but that revision was never recorded", () => {
    const deploy = fixture();
    const result = deploy.run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("already at");
    expect(deploy.head()).toBe(deploy.first);
    expect(deploy.deployed()).toBe(deploy.first);
    expect(deploy.record().healthy?.revision).toBe(deploy.first);
    expect(deploy.state().builds).toBe(1);
    expect(deploy.state().ups).toBe(1);
  });
  it("deploys when the recorded revision is not the checkout", () => {
    const deploy = fixture();
    write(path.join(deploy.checkout, ".last-deployed-revision"), "outdated\n");
    const result = deploy.run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("already at");
    expect(deploy.deployed()).toBe(deploy.first);
    expect(deploy.state().ups).toBe(1);
  });
  it("builds, starts, and records the new revision under time limits", () => {
    const deploy = fixture();
    const next = deploy.next();
    const result = deploy.run();
    expect(result.status, result.stderr).toBe(0);
    expect(deploy.head()).toBe(next);
    expect(deploy.deployed()).toBe(next);
    expect(deploy.record().healthy?.revision).toBe(next);
    const operations = deploy
      .dockerArguments()
      .map(composeOperation)
      .filter(
        (args) =>
          ["config", "build", "up"].includes(args[0] || "") &&
          !args.includes("--help") &&
          !args.includes("json"),
      );
    expect(
      operations.some(
        (args) =>
          args[0] === "build" &&
          args[1] === "--builder" &&
          args[2] === deploy.record().builder.name,
      ),
    ).toBe(true);
    expect(operations.some((args) => args[0] === "up" && args.includes("--remove-orphans"))).toBe(
      true,
    );
    expect(deploy.timeouts()).toContain("--kill-after=30s 15m");
    expect(deploy.timeouts()).toContain("--kill-after=30s 5m");
  });
  it("rolls back to the previous revision when the build fails", () => {
    const deploy = fixture();
    deploy.next("broken");
    const result = deploy.run({ FAIL_BUILD: "1" });
    expect(result.status, result.stderr).toBe(1);
    expect(deploy.head()).toBe(deploy.first);
    const rollback = deploy
      .dockerArguments()
      .map(composeOperation)
      .filter((args) => args[0] === "up");
    expect(rollback).toHaveLength(1);
    expect(rollback[0]).toEqual(["up", "-d", "--remove-orphans", "--no-build", "--pull", "never"]);
    expect(deploy.state().containers["1".repeat(64)]?.Image).toBe(deploy.firstImage);
    expect(deploy.deployed()).toBeUndefined();
  });
  it("rolls back when production never becomes healthy", () => {
    const deploy = fixture();
    deploy.next("unhealthy");
    const result = deploy.run({ FAIL_HEALTH: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("did not recover");
    expect(deploy.head()).toBe(deploy.first);
    expect(deploy.deployed()).toBeUndefined();
    expect(deploy.state().containers["1".repeat(64)]?.Image).toBe(deploy.firstImage);
  });
  it("rolls back without recording a revision when readiness fails despite public liveness", () => {
    const deploy = fixture();
    deploy.next("database unavailable");
    const result = deploy.run({ FAIL_READY: "1" });
    expect(result.status).toBe(1);
    expect(deploy.readyAttempts()).toBe(60);
    const commands = deploy.dockerArguments();
    const rollback = commands.findIndex(
      (args) =>
        args.some((arg) => arg.endsWith("/rollback.json")) && composeOperation(args)[0] === "up",
    );
    expect(rollback).toBeGreaterThan(0);
    expect(
      commands.slice(0, rollback).filter((args) => composeOperation(args)[0] === "exec"),
    ).toHaveLength(30);
    expect(
      commands.slice(rollback + 1).filter((args) => composeOperation(args)[0] === "exec"),
    ).toHaveLength(30);
    expect(deploy.head()).toBe(deploy.first);
    expect(deploy.deployed()).toBeUndefined();
    expect(
      deploy
        .dockerArguments()
        .map(composeOperation)
        .some((args) => args[0] === "up" && args.includes("--no-build") && args.includes("never")),
    ).toBe(true);
  });
  it("preserves the last healthy revision when public health fails and readiness would succeed", () => {
    const deploy = fixture();
    const record = prime(deploy);
    deploy.next("public edge unavailable");
    const result = deploy.run({ FAIL_HEALTH: "1" });
    expect(result.status).toBe(1);
    expect(deploy.head()).toBe(deploy.first);
    expect(deploy.deployed()).toBe(deploy.first);
    expect(deploy.record().healthy).toEqual(record.healthy);
  });
  it("retries until readiness recovers before recording the deployment", () => {
    const deploy = fixture();
    const next = deploy.next("database recovering");
    const result = deploy.run({ READY_RECOVER_AFTER: "2" });
    expect(result.status, result.stderr).toBe(0);
    expect(deploy.readyAttempts()).toBe(3);
    expect(deploy.head()).toBe(next);
    expect(deploy.deployed()).toBe(next);
    expect(
      deploy
        .dockerArguments()
        .some(
          (args) =>
            composeOperation(args)[0] === "up" &&
            args.some((arg) => arg.endsWith("/rollback.json")),
        ),
    ).toBe(false);
    expect(
      deploy.dockerArguments().some((args) => args.some((arg) => arg.endsWith("/forward.json"))),
    ).toBe(true);
  });
  it("does not take the current-revision shortcut while readiness is down", () => {
    const deploy = fixture();
    prime(deploy);
    const result = deploy.run({ READY_RECOVER_AFTER: "1" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("already at");
    expect(deploy.readyAttempts()).toBe(2);
    expect(
      deploy
        .dockerArguments()
        .map(composeOperation)
        .some((args) => args[0] === "up" && args.includes("--no-build")),
    ).toBe(true);
  });
  it("passes the bounded readiness fetch as one argument in a checkout containing spaces", () => {
    const deploy = fixture();
    const result = deploy.run();
    expect(result.status, result.stderr).toBe(0);
    const ready = deploy
      .dockerArguments()
      .map(composeOperation)
      .filter((args) => args[0] === "exec");
    expect(ready).toHaveLength(1);
    expect(ready[0]?.slice(0, 6)).toEqual(["exec", "-T", "api", "node", "-e", ready[0]?.[5]]);
    expect(ready[0]).toHaveLength(6);
    expect(ready[0]?.[5]).toContain("http://127.0.0.1:3100/ready");
    expect(ready[0]?.[5]).toContain("AbortSignal.timeout(2000)");
    expect(deploy.timeouts()).toContain("--kill-after=30s 5s");
  });
  it("keeps an explicit public health URL as a single argument and still checks readiness", () => {
    const deploy = fixture();
    const url = "https://edge.example.test/status?value=one two&ready=public";
    const result = deploy.run({ RAKAZO_HEALTH_URL: url });
    expect(result.status, result.stderr).toBe(0);
    expect(deploy.commands()).toContain(`curl ${url}`);
    expect(deploy.readyAttempts()).toBe(1);
  });
});

describe("production deploy admission and capabilities", () => {
  it.each([
    "",
    "08",
    "-1",
    "1.5",
    "8GB",
    " 5",
    "5\n6",
    "$(touch not-run)",
    "9223372036854775807",
    "99999999999999999999",
  ])("rejects an unsafe reserve %j before mutations", (value) => {
    const deploy = fixture();
    deploy.next();
    const result = deploy.run({ RAKAZO_DEPLOY_MIN_FREE_GB: value });
    expectAdmissionFailure(deploy, result);
    expect(Object.keys(deploy.state().builders)).toHaveLength(0);
    expect(imageMutations(deploy)).toHaveLength(0);
  });
  it.each([
    { APP_FREE_KB: "5242879", DOCKER_FREE_KB: "5242880" },
    { APP_FREE_KB: "5242880", DOCKER_FREE_KB: "5242879" },
  ])("refuses first adoption below reserve on either filesystem: %j", (values) => {
    const deploy = fixture();
    deploy.next();
    const result = deploy.run(values);
    expectAdmissionFailure(deploy, result);
    expect(Object.keys(deploy.state().builders)).toHaveLength(0);
    expect(imageMutations(deploy)).toHaveLength(0);
  });
  it("accepts exact KiB equality on both paths and keeps them as single arguments", () => {
    const deploy = fixture();
    const result = deploy.run({ APP_FREE_KB: "5242880", DOCKER_FREE_KB: "5242880" });
    expect(result.status, result.stderr).toBe(0);
    expect(
      deploy
        .events()
        .filter((line) => line.startsWith("df "))
        .some((line) => line.includes(deploy.dockerRoot)),
    ).toBe(true);
    expect(deploy.record().owner.appDir).toBe(deploy.checkout);
  });
  it("allows zero only to disable the threshold, while still validating readings", () => {
    const deploy = fixture();
    expect(deploy.run({ RAKAZO_DEPLOY_MIN_FREE_GB: "0", FREE_KB: "0" }).status).toBe(0);
    const invalid = fixture();
    expectAdmissionFailure(
      invalid,
      invalid.run({ RAKAZO_DEPLOY_MIN_FREE_GB: "0", FREE_KB: "invalid" }),
    );
  });
  it.each([
    "",
    "Filesystem blocks used available capacity path\n",
    "Filesystem blocks used available capacity path\n/dev/x 1 0 invalid 0% /\n",
    "Filesystem blocks used available capacity path\n/dev/x 1 0 -1 0% /\n",
    "Filesystem blocks used available capacity path\n/dev/x 1 0 5.5 0% /\n",
    "Filesystem blocks used available capacity path\n/dev/x 1 0 9223372036854775808 0% /\n",
    "Filesystem blocks used available capacity path\n/dev/x 1 0 52428800 0% /\n/dev/y 1 0 52428800 0% /\n",
  ])("does not authorize cleanup from malformed df %j", (raw) => {
    const deploy = fixture();
    const result = deploy.run({ DF_RAW: raw || "\n" });
    expectAdmissionFailure(deploy, result);
    expect(imageMutations(deploy)).toHaveLength(0);
    expect(deploy.state().prunes).toBe(0);
  });
  it("rejects a failed df without deleting images or cache", () => {
    const deploy = fixture();
    expectAdmissionFailure(deploy, deploy.run({ FAIL_DF: "1" }));
    expect(imageMutations(deploy)).toHaveLength(0);
  });
  it.each(["", "relative", "/missing-docker-storage", "/tmp\n/other"])(
    "rejects invalid DockerRootDir %j",
    (value) => {
      const deploy = fixture();
      expectAdmissionFailure(deploy, deploy.run({ DOCKER_ROOT: value }));
      expect(imageMutations(deploy)).toHaveLength(0);
    },
  );
  it.each([
    "tcp://remote.example.test:2375",
    "ssh://example.test",
    "unix://relative",
    "unix:///tmp/one\nunix:///tmp/two",
  ])("rejects nonlocal or ambiguous endpoint %j", (endpoint) => {
    const deploy = fixture();
    expectAdmissionFailure(deploy, deploy.run({ CONTEXT_ENDPOINT: endpoint }));
    expect(Object.keys(deploy.state().builders)).toHaveLength(0);
  });
  it.each([
    { BUILDX_VERSION: "github.com/docker/buildx v0.13.1 old" },
    { BUILDX_VERSION: "not-a-version" },
    { COMPOSE_BUILD_HELP: "Usage: docker compose build" },
    { BAD_CONFIG_JSON: "not-json" },
    { BAD_CONTEXT_JSON: "[]" },
    { BAD_INFO_JSON: "{}" },
  ])("rejects unsupported prerequisites or metadata %j", (values) => {
    const deploy = fixture();
    expectAdmissionFailure(deploy, deploy.run(values));
    expect(Object.keys(deploy.state().builders)).toHaveLength(0);
    expect(imageMutations(deploy)).toHaveLength(0);
  });
  it("rechecks capacity after bootstrap before fetch", () => {
    const deploy = fixture();
    const result = deploy.run({ APP_FREE_AFTER_BOOTSTRAP: "1" });
    expectAdmissionFailure(deploy, result);
    expect(Object.keys(deploy.state().builders)).toHaveLength(1);
    expect(deploy.state().bootstraps).toBeGreaterThan(0);
    expect(deploy.state().builds).toBe(0);
  });
  it("leaves a safe explicit adoption boundary when initial receipt publication fails", () => {
    const deploy = fixture();
    const result = deploy.run({ FAIL_FIRST_STATE_PUBLISH: "1" });
    expectAdmissionFailure(deploy, result);
    expect(existsSync(deploy.recordPath)).toBe(false);
    expect(Object.keys(deploy.state().builders)).toHaveLength(1);
    deploy.clearLogs();
    const retry = deploy.run();
    expect(retry.status).not.toBe(0);
    expect(deploy.state().builds).toBe(0);
    expect(deploy.state().prunes).toBe(0);
  });
});

describe("production deploy owned resources and generation state", () => {
  it("records actual identities and uses one explicitly selected owned builder", () => {
    const deploy = fixture();
    const result = deploy.run();
    expect(result.status, result.stderr).toBe(0);
    const record = deploy.record(),
      state = deploy.state();
    expect(record.version).toBe(1);
    expect(record.owner.project).toBe(deploy.project);
    expect(record.owner.appDir).toBe(deploy.checkout);
    expect(record.owner.daemonId).toBe(state.daemonId);
    expect(record.owner.endpoint).toBe(state.endpoint);
    const builder = state.builders[record.builder.name];
    expect(builder?.cid).toBe(record.builder.containerId);
    expect(builder?.volume).toBe(record.builder.volume);
    expect(record.builder.name).toMatch(/^coginebot-deploy-[a-f0-9]{32}$/);
    expect(statSync(deploy.stateDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(deploy.recordPath).mode & 0o777).toBe(0o600);
    expect(record.healthy?.services.map((x) => x.service).sort()).toEqual([
      "api",
      "postgres",
      "web",
    ]);
    for (const args of deploy.dockerArguments()) {
      if (dockerOperation(args)[0] !== "context")
        expect(args.slice(0, 2)).toEqual(["--host", state.endpoint]);
      const op = dockerOperation(args);
      if (op[0] === "buildx" && op[1] === "prune")
        expect(op).toEqual([
          "buildx",
          "prune",
          "--builder",
          record.builder.name,
          "--all",
          "--force",
          "--filter",
          "until=24h",
        ]);
    }
    assertNoUnsafeCleanup(deploy);
  });
  it("reuses the same builder without changing the default or adopting shared cache", () => {
    const deploy = fixture();
    const first = prime(deploy);
    const result = deploy.run();
    expect(result.status, result.stderr).toBe(0);
    expect(deploy.record().builder).toEqual(first.builder);
    expect(Object.keys(deploy.state().builders)).toHaveLength(1);
    expect(
      deploy
        .dockerArguments()
        .map(dockerOperation)
        .some((args) => args[0] === "buildx" && args[1] === "create"),
    ).toBe(false);
    assertNoUnsafeCleanup(deploy);
  });
  it("recovers capacity through only the owned cache and rechecks both paths", () => {
    const deploy = fixture();
    prime(deploy);
    deploy.next();
    const result = deploy.run({
      APP_FREE_KB: "1",
      DOCKER_FREE_KB: "1",
      APP_FREE_AFTER_PRUNE: "5242880",
      DOCKER_FREE_AFTER_PRUNE: "5242880",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(deploy.state().prunes).toBeGreaterThan(0);
    assertNoUnsafeCleanup(deploy);
  });
  it.each([
    { APP_FREE_AFTER_PRUNE: "1", DOCKER_FREE_AFTER_PRUNE: "5242880" },
    { APP_FREE_AFTER_PRUNE: "5242880", DOCKER_FREE_AFTER_PRUNE: "1" },
  ])("refuses when cleanup leaves either path low: %j", (values) => {
    const deploy = fixture();
    const before = prime(deploy);
    deploy.next();
    const result = deploy.run({ FREE_KB: "1", ...values });
    expect(result.status).not.toBe(0);
    expect(deploy.events().some((x) => x.startsWith("git fetch"))).toBe(false);
    expect(deploy.record().healthy).toEqual(before.healthy);
    assertNoUnsafeCleanup(deploy);
  });
  it.each(["buildx prune", "container inspect", "image inspect", "image ls", "volume inspect"])(
    "refuses unknown or failed resource inspection/cleanup: %s",
    (operation) => {
      const deploy = fixture();
      const before = prime(deploy);
      deploy.next();
      const result = deploy.run({ FAIL_DOCKER_MATCH: operation });
      expect(result.status).not.toBe(0);
      expect(deploy.events().some((x) => x.startsWith("git fetch"))).toBe(false);
      expect(deploy.record().healthy).toEqual(before.healthy);
      assertNoUnsafeCleanup(deploy);
    },
  );
  it.each([
    { BAD_BUILDERS_JSON: "bad" },
    { BAD_CONTAINER_INSPECT_JSON: "{}" },
    { BAD_IMAGE_INSPECT_JSON: "[]" },
    { BAD_VOLUMES_JSON: "bad" },
    { BAD_VOLUME_INSPECT_JSON: "[]" },
  ])("does not clean after malformed owned-resource evidence %j", (values) => {
    const deploy = fixture();
    prime(deploy);
    const before = deploy.state().removed.length;
    const result = deploy.run(values);
    expect(result.status).not.toBe(0);
    expect(deploy.state().removed).toHaveLength(before);
    expect(deploy.events().some((x) => x.startsWith("git fetch"))).toBe(false);
  });
  it.each([
    "builder driver",
    "builder endpoint",
    "builder image",
    "container identity",
    "volume mount",
    "volume driver",
  ])("rejects a replaced %s before prune", (part) => {
    const deploy = fixture();
    const record = prime(deploy);
    const overrides: Record<string, string> = {};
    if (part === "builder driver") overrides.BUILDER_DRIVER = "docker";
    if (part === "builder endpoint") overrides.BUILDER_ENDPOINT = "unix:///another.sock";
    if (part === "builder image")
      deploy.update((s) => {
        s.builders[record.builder.name]!.image = `moby/buildkit:other@sha256:${"0".repeat(64)}`;
      });
    if (part === "container identity")
      deploy.update((s) => {
        const c = s.containers[record.builder.containerId]!;
        delete s.containers[c.Id];
        c.Id = "9".repeat(64);
        s.containers[c.Id] = c;
      });
    if (part === "volume mount")
      deploy.update((s) => {
        s.containers[record.builder.containerId]!.Mounts[0]!.Destination = "/different";
      });
    if (part === "volume driver")
      deploy.update((s) => {
        s.volumes[record.builder.volume]!.Driver = "other";
      });
    const prunes = deploy.state().prunes;
    const result = deploy.run(overrides);
    expect(result.status).not.toBe(0);
    expect(deploy.state().prunes).toBe(prunes);
    expect(deploy.events().some((x) => x.startsWith("git fetch"))).toBe(false);
  });
  it("rejects a same-name builder when its ownership receipt is missing", () => {
    const deploy = fixture();
    prime(deploy);
    rmSync(deploy.recordPath);
    const prunes = deploy.state().prunes;
    const result = deploy.run();
    expect(result.status).not.toBe(0);
    expect(deploy.state().prunes).toBe(prunes);
    expect(deploy.events().some((x) => x.startsWith("git fetch"))).toBe(false);
  });
  it.each([
    "directory symlink",
    "file symlink",
    "file directory",
    "invalid JSON",
    "unsupported version",
    "oversized JSON",
    "wrong mode",
  ])("rejects unsafe deployment state: %s", (kind) => {
    const deploy = fixture();
    prime(deploy);
    if (kind === "directory symlink") {
      const other = path.join(deploy.root, "other state");
      mkdirSync(other);
      rmSync(deploy.stateDirectory, { recursive: true });
      symlinkSync(other, deploy.stateDirectory);
    }
    if (kind === "file symlink") {
      const other = path.join(deploy.root, "other receipt");
      write(other, "do not change\n");
      rmSync(deploy.recordPath);
      symlinkSync(other, deploy.recordPath);
    }
    if (kind === "file directory") {
      rmSync(deploy.recordPath);
      mkdirSync(deploy.recordPath);
    }
    if (kind === "invalid JSON") write(deploy.recordPath, "{bad");
    if (kind === "unsupported version") {
      const record = deploy.record();
      record.version = 2;
      write(deploy.recordPath, JSON.stringify(record));
    }
    if (kind === "oversized JSON") write(deploy.recordPath, " ".repeat(1024 * 1024 + 1));
    if (kind === "wrong mode") chmodSync(deploy.recordPath, 0o666);
    const before = deploy.state().prunes;
    const result = deploy.run();
    expect(result.status).not.toBe(0);
    expect(deploy.state().prunes).toBe(before);
    expect(deploy.events().some((x) => x.startsWith("git fetch"))).toBe(false);
  });
  it("rejects a lock symlink without truncating its target", () => {
    const deploy = fixture();
    const target = path.join(deploy.root, "operator file");
    write(target, "keep operator data\n");
    symlinkSync(target, path.join(deploy.checkout, ".deploy.lock"));
    expectAdmissionFailure(deploy, deploy.run());
    expect(readFileSync(target, "utf8")).toBe("keep operator data\n");
    expect(deploy.commands()).toEqual([]);
  });
  it("opens an existing regular lock without truncating it", () => {
    const deploy = fixture();
    const lock = path.join(deploy.checkout, ".deploy.lock");
    write(lock, "lock sentinel\n");
    const result = deploy.run();
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(lock, "utf8")).toBe("lock sentinel\n");
  });
  it("never treats a legacy revision marker as sufficient authoritative image evidence", () => {
    const deploy = fixture();
    write(path.join(deploy.checkout, ".last-deployed-revision"), `${deploy.first}\n`);
    const result = deploy.run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("already at");
    expect(deploy.state().builds).toBe(1);
    expect(deploy.record().healthy?.revision).toBe(deploy.first);
  });
  it("rejects target Compose project drift before build or startup", () => {
    const deploy = fixture();
    deploy.next();
    const result = deploy.run({ TARGET_PROJECT: "other-stack" });
    expect(result.status).not.toBe(0);
    expect(deploy.state().builds).toBe(0);
    const starts = deploy.dockerArguments().filter((args) => composeOperation(args)[0] === "up");
    expect(starts.every((args) => composeOperation(args).includes("--no-build"))).toBe(true);
    expect(starts.every((args) => args.includes(deploy.project))).toBe(true);
    expect(starts.some((args) => args.includes("other-stack"))).toBe(false);
    expect(deploy.head()).toBe(deploy.first);
  });
  it("uses an actual custom Compose project instead of a hardcoded namespace", () => {
    const deploy = fixture();
    deploy.update((s) => {
      s.config.name = "custom-stack";
      for (const c of Object.values(s.containers))
        c.Config.Labels["com.docker.compose.project"] = "custom-stack";
    });
    const result = deploy.run({ COMPOSE_PROJECT_NAME: "custom-stack" });
    expect(result.status, result.stderr).toBe(0);
    expect(deploy.record().owner.project).toBe("custom-stack");
    assertNoUnsafeCleanup(deploy);
  });
});

describe("production deploy exact rollback and owned image history", () => {
  it("protects actual pre-deploy images even when HEAD and configured tag describe different content", () => {
    const deploy = fixture();
    deploy.next();
    const result = deploy.run({ FAIL_BUILD: "1" });
    expect(result.status).toBe(1);
    const state = deploy.state();
    expect(state.containers["1".repeat(64)]?.Image).toBe(deploy.firstImage);
    expect(state.containers["2".repeat(64)]?.Image).toBe(deploy.firstImage);
    expect(state.containers["3".repeat(64)]?.Image).toBe(deploy.databaseImage);
    const rollback = deploy.dockerArguments().filter((args) => composeOperation(args)[0] === "up");
    expect(rollback).toHaveLength(1);
    const op = composeOperation(rollback[0]!);
    expect(op).toContain("--no-build");
    expect(op.slice(-2)).toEqual(["--pull", "never"]);
    expect(deploy.record().images.some((x) => x.id === deploy.firstImage)).toBe(true);
    assertNoUnsafeCleanup(deploy);
  });
  it("returns an accurate first-install failure without rebuilding an unavailable previous deployment", () => {
    const deploy = fixture();
    deploy.update((s) => {
      s.containers = {};
    });
    deploy.next();
    const result = deploy.run({ FAIL_BUILD: "1" });
    expect(result.status).not.toBe(0);
    expect(result.stderr.toLowerCase()).toMatch(
      /rollback.*(unavailable|incomplete|no previous)|no.*previous.*deployment/,
    );
    expect(deploy.state().ups).toBe(0);
    expect(deploy.record().healthy).toBeNull();
    expect(deploy.deployed()).toBeUndefined();
  });
  it("reports a failed exact rollback without claiming restoration", () => {
    const deploy = fixture();
    deploy.next();
    const result = deploy.run({ FAIL_BUILD: "1", FAIL_ROLLBACK_UP: "1" });
    expect(result.status).not.toBe(0);
    expect(result.stderr.toLowerCase()).toMatch(/rollback.*fail|restor.*fail/);
    expect(deploy.deployed()).toBeUndefined();
  });
  it.each(["FAIL_LEGACY_PUBLISH", "FAIL_HEALTHY_PUBLISH"])(
    "keeps the previous authoritative generation after %s",
    (failure) => {
      const deploy = fixture();
      const before = prime(deploy);
      deploy.next();
      const result = deploy.run({ [failure]: "1" });
      expect(result.status).not.toBe(0);
      expect(deploy.record().healthy).toEqual(before.healthy);
      expect(deploy.deployed()).toBe(deploy.first);
      for (const prior of before.healthy!.services) {
        const current = Object.values(deploy.state().containers).find(
          (c) => c.Config.Labels["com.docker.compose.service"] === prior.service,
        );
        expect(current?.Image).toBe(prior.id);
      }
      expect(deploy.head()).toBe(deploy.first);
      expect(
        deploy
          .dockerArguments()
          .map(composeOperation)
          .filter((args) => args[0] === "up")
          .at(-1),
      ).toContain("--no-build");
    },
  );
  it("publishes current and previous image generations only after health and readiness", () => {
    const deploy = fixture();
    const previous = prime(deploy);
    const next = deploy.next();
    const result = deploy.run();
    expect(result.status, result.stderr).toBe(0);
    const record = deploy.record();
    expect(record.healthy?.revision).toBe(next);
    expect(record.healthy?.previous).toEqual(previous.healthy?.services);
    expect(deploy.deployed()).toBe(next);
    expect(record.healthy?.services.find((x) => x.service === "api")?.id).not.toBe(
      previous.healthy?.services.find((x) => x.service === "api")?.id,
    );
  });
  it("collects only an obsolete owned reference over three healthy generations", () => {
    const deploy = fixture();
    prime(deploy);
    deploy.next("second");
    expect(deploy.run().status).toBe(0);
    deploy.clearLogs();
    deploy.next("third");
    const result = deploy.run();
    expect(result.status, result.stderr).toBe(0);
    const removed = deploy.state().removed;
    expect(removed.some((ref) => ref.endsWith(deploy.firstImage.slice(7)))).toBe(true);
    const record = deploy.record();
    const protectedIds = new Set(
      [...(record.healthy?.services || []), ...(record.healthy?.previous || [])].map((x) => x.id),
    );
    for (const ref of removed)
      expect(protectedIds.has(`sha256:${ref.split(":").at(-1)}`)).toBe(false);
    assertNoUnsafeCleanup(deploy);
  });
  it.each(["foreign tag", "running foreign container", "stopped foreign container"])(
    "preserves obsolete owned images with a %s",
    (kind) => {
      const deploy = fixture();
      prime(deploy);
      deploy.next("second");
      expect(deploy.run().status).toBe(0);
      deploy.update((s) => {
        if (kind === "foreign tag")
          s.images[deploy.firstImage]!.RepoTags.push("someone-else/shared:keep");
        else {
          const id = "8".repeat(64);
          s.containers[id] = {
            Id: id,
            Name: "/foreign-api-1",
            Image: deploy.firstImage,
            Config: {
              Image: "foreign/shared:keep",
              Labels: {
                "com.docker.compose.project": "foreign",
                "com.docker.compose.service": "api",
              },
            },
            State: { Status: kind.startsWith("stopped") ? "exited" : "running" },
            Mounts: [],
          };
        }
      });
      deploy.clearLogs();
      deploy.next("third");
      const result = deploy.run();
      expect(result.status, result.stderr).toBe(0);
      expect(deploy.state().removed.some((ref) => ref.endsWith(deploy.firstImage.slice(7)))).toBe(
        false,
      );
      expect(
        deploy
          .state()
          .images[deploy.firstImage]?.RepoTags.some((ref) =>
            ref.endsWith(deploy.firstImage.slice(7)),
          ),
      ).toBe(true);
      assertNoUnsafeCleanup(deploy);
    },
  );
  it("rejects changed protected image identities before any prune", () => {
    const deploy = fixture();
    const record = prime(deploy);
    const id = record.healthy!.services.find((x) => x.service === "api")!.id;
    deploy.update((s) => {
      delete s.images[id];
    });
    const before = deploy.state().prunes;
    const result = deploy.run();
    expect(result.status).not.toBe(0);
    expect(deploy.state().prunes).toBe(before);
    expect(deploy.state().removed).toEqual([]);
  });
  it("rejects a ledger reference that now resolves to different content", () => {
    const deploy = fixture();
    const record = prime(deploy);
    const own = record.images.find((x) => x.id === deploy.firstImage)!;
    deploy.update((s) => {
      const original = s.images[own.id]!;
      original.RepoTags = original.RepoTags.filter((x) => x !== own.ref);
      s.images[deploy.databaseImage]!.RepoTags.push(own.ref);
    });
    const result = deploy.run();
    expect(result.status).not.toBe(0);
    expect(deploy.state().removed).toEqual([]);
    expect(deploy.events().some((x) => x.startsWith("git fetch"))).toBe(false);
  });
});

describe("production deploy authority fault boundaries", () => {
  it("accepts a safe maximum reserve without arithmetic wrap", () => {
    const deploy = fixture();
    const result = deploy.run({
      RAKAZO_DEPLOY_MIN_FREE_GB: "8796093022207",
      FREE_KB: "9223372036854775807",
    });
    expect(result.status, result.stderr).toBe(0);
  });
  it("rejects the first overflowing GiB-to-KiB reserve", () => {
    const deploy = fixture();
    expectAdmissionFailure(deploy, deploy.run({ RAKAZO_DEPLOY_MIN_FREE_GB: "8796093022208" }));
  });
  it("rejects an unavailable jq before resource mutations", () => {
    const deploy = fixture();
    write(path.join(deploy.bin, "jq"), "#!/bin/bash\nexit 127\n", 0o755);
    expectAdmissionFailure(deploy, deploy.run());
    expect(imageMutations(deploy)).toHaveLength(0);
    expect(Object.keys(deploy.state().builders)).toHaveLength(0);
  });
  it("honors Docker context precedence over a conflicting host variable", () => {
    const deploy = fixture();
    const result = deploy.run({
      DOCKER_CONTEXT: "default",
      DOCKER_HOST: "tcp://unused.example.test:2375",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(deploy.record().owner.endpoint).toBe("unix:///var/run/docker.sock");
    assertNoUnsafeCleanup(deploy);
  });
  it("uses an explicit local host without falling back to the context endpoint", () => {
    const deploy = fixture();
    const endpoint = "unix:///tmp/selected-deployment.sock";
    deploy.update((s) => {
      s.endpoint = endpoint;
    });
    const result = deploy.run({
      DOCKER_HOST: endpoint,
      CONTEXT_ENDPOINT: "unix:///tmp/not-selected.sock",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(deploy.record().owner.endpoint).toBe(endpoint);
  });
  it.each([
    "daemon",
    "checkout",
    "project",
    "endpoint",
    "unsafe ref",
    "invalid image ID",
    "duplicate service",
    "invalid healthy revision",
  ])("rejects altered state authority: %s", (part) => {
    const deploy = fixture();
    const record = prime(deploy);
    if (part === "daemon") record.owner.daemonId = "another-daemon";
    if (part === "checkout") record.owner.appDir = path.join(deploy.root, "other checkout");
    if (part === "project") record.owner.project = "another-stack";
    if (part === "endpoint") record.owner.endpoint = "unix:///another.sock";
    if (part === "unsafe ref") record.images[0]!.ref = "--force";
    if (part === "invalid image ID") record.images[0]!.id = "not-an-image-id";
    if (part === "duplicate service") record.healthy!.services.push(record.healthy!.services[0]!);
    if (part === "invalid healthy revision") record.healthy!.revision = "not-a-commit";
    write(deploy.recordPath, JSON.stringify(record));
    const before = deploy.state().prunes;
    const result = deploy.run();
    expect(result.status).not.toBe(0);
    expect(deploy.state().prunes).toBe(before);
    expect(deploy.events().some((x) => x.startsWith("git fetch"))).toBe(false);
  });
  it("does not accept state from a changed daemon identity", () => {
    const deploy = fixture();
    prime(deploy);
    const before = deploy.state().prunes;
    const result = deploy.run({ DAEMON_ID: "changed-daemon" });
    expect(result.status).not.toBe(0);
    expect(deploy.state().prunes).toBe(before);
    expect(imageMutations(deploy)).toHaveLength(0);
  });
  it("does not take ownership of an existing matching volume without a receipt", () => {
    const deploy = fixture();
    const record = prime(deploy);
    rmSync(deploy.recordPath);
    deploy.update((s) => {
      delete s.builders[record.builder.name];
      delete s.containers[record.builder.containerId];
    });
    const result = deploy.run();
    expect(result.status).not.toBe(0);
    expect(deploy.state().volumes[record.builder.volume]).toBeDefined();
    expect(deploy.events().some((x) => x.startsWith("git fetch"))).toBe(false);
    assertNoUnsafeCleanup(deploy);
  });
  it("does not infer absence from a failed builder or volume inventory", () => {
    for (const operation of ["buildx ls", "volume ls", "image ls", "container ls"]) {
      const deploy = fixture();
      expectAdmissionFailure(deploy, deploy.run({ FAIL_DOCKER_MATCH: operation }));
      expect(Object.keys(deploy.state().builders)).toHaveLength(0);
      expect(imageMutations(deploy)).toHaveLength(0);
    }
  });
  it("retains a successful new generation after an ambiguous post-publication failure", () => {
    const deploy = fixture();
    const before = prime(deploy);
    const next = deploy.next();
    const result = deploy.run({ FAIL_AFTER_HEALTHY_PUBLISH: "1" });
    expect(result.status).not.toBe(0);
    const record = deploy.record();
    if (record.healthy?.revision === next) {
      for (const image of record.healthy.services)
        expect(
          Object.values(deploy.state().containers).find(
            (c) => c.Config.Labels["com.docker.compose.service"] === image.service,
          )?.Image,
        ).toBe(image.id);
      expect(deploy.head()).toBe(next);
      expect(deploy.deployed()).toBe(next);
    } else {
      expect(record.healthy).toEqual(before.healthy);
      for (const image of before.healthy!.services)
        expect(
          Object.values(deploy.state().containers).find(
            (c) => c.Config.Labels["com.docker.compose.service"] === image.service,
          )?.Image,
        ).toBe(image.id);
    }
  });
  it("recovers a legacy-before-authority publication failure without a false no-op", () => {
    const deploy = fixture();
    const before = prime(deploy);
    const next = deploy.next();
    expect(deploy.run({ FAIL_HEALTHY_PUBLISH: "1" }).status).not.toBe(0);
    expect(deploy.record().healthy).toEqual(before.healthy);
    deploy.clearLogs();
    const result = deploy.run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("already at");
    expect(deploy.record().healthy?.revision).toBe(next);
    expect(deploy.deployed()).toBe(next);
  });
  it("does not require inactive profile services as rollback images", () => {
    const deploy = fixture();
    deploy.update((s) => {
      s.config.services.optional = {
        image: "example/optional:not-installed",
        build: { context: "../.." },
        profiles: ["optional"],
      };
    });
    const result = deploy.run();
    expect(result.status, result.stderr).toBe(0);
    expect(deploy.record().healthy?.services.some((s) => s.service === "optional")).toBe(false);
  });
});

describe.skipIf(process.platform !== "linux")("production deploy real filesystem locks", () => {
  it("rejects a FIFO lock before opening it", () => {
    const deploy = fixture();
    execFileSync("mkfifo", [path.join(deploy.checkout, ".deploy.lock")]);
    const result = deploy.run();
    expect(result.status).not.toBe(0);
    expect(deploy.commands()).toEqual([]);
  });
  it("rejects a FIFO receipt before parsing it", () => {
    const deploy = fixture();
    prime(deploy);
    rmSync(deploy.recordPath);
    execFileSync("mkfifo", [deploy.recordPath]);
    const before = deploy.state().prunes;
    expect(deploy.run().status).not.toBe(0);
    expect(deploy.state().prunes).toBe(before);
  });
  it("refuses an independently held GNU flock without truncating the lock", () => {
    const deploy = fixture();
    rmSync(path.join(deploy.bin, "flock"));
    const lock = path.join(deploy.checkout, ".deploy.lock");
    write(lock, "sentinel\n");
    const result = spawnSync(
      "/usr/bin/flock",
      [lock, "/bin/bash", path.join(repoRoot, "infra/compose/deploy-main.sh")],
      { cwd: deploy.root, env: deploy.env, encoding: "utf8", timeout: 10_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("holds the lock");
    expect(readFileSync(lock, "utf8")).toBe("sentinel\n");
    expect(deploy.commands()).toEqual([]);
  });
  it("excludes a concurrent deploy while the owned fake build holds its descriptor", async () => {
    const deploy = fixture();
    rmSync(path.join(deploy.bin, "flock"));
    const first = deploy.start({ HOLD_COMMAND_MATCH: "build --builder" });
    await waitForFile(deploy.holdReady);
    const second = deploy.start();
    const refused = await second.result;
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("holds the lock");
    write(deploy.holdRelease, "release");
    const result = await first.result;
    expect(result.status, result.stderr).toBe(0);
  });
  it("retains the lock in an orphaned fake CLI after its parent is killed", async () => {
    const deploy = fixture();
    rmSync(path.join(deploy.bin, "flock"));
    const first = deploy.start({ HOLD_COMMAND_MATCH: "build --builder" });
    await waitForFile(deploy.holdReady);
    process.kill(first.pid, "SIGKILL");
    const second = deploy.start();
    const refused = await second.result;
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("holds the lock");
    write(deploy.holdRelease, "release");
    await first.result;
    const next = deploy.run({ FREE_KB: "1" });
    expect(next.status).not.toBe(0);
    expect(next.stderr).not.toContain("holds the lock");
  });
});

it.skipIf(
  process.platform !== "linux" || process.getuid?.() !== 0 || process.env.C32_TEST_CHOWN !== "1",
)("rejects real foreign-UID lock and state authority in an isolated ownership probe", () => {
  for (const area of ["lock", "state directory", "state file"]) {
    const deploy = fixture();
    if (area !== "lock") prime(deploy);
    const target =
      area === "lock"
        ? path.join(deploy.checkout, ".deploy.lock")
        : area === "state directory"
          ? deploy.stateDirectory
          : deploy.recordPath;
    if (area === "lock") write(target, "foreign owner sentinel\n");
    const uid = process.getuid!(),
      gid = process.getgid!();
    chownSync(target, 12345, gid);
    try {
      const before = deploy.state().prunes;
      const result = deploy.run();
      expect(result.status).not.toBe(0);
      expect(deploy.state().prunes).toBe(before);
      expect(deploy.events().some((x) => x.startsWith("git fetch"))).toBe(false);
    } finally {
      chownSync(target, uid, gid);
    }
  }
});

it("revalidates the engine after building and refuses startup on identity drift", () => {
  const deploy = fixture();
  deploy.next();
  const result = deploy.run({ DAEMON_ID_AFTER_BUILD: "changed-after-build" });
  expect(result.status).not.toBe(0);
  expect(deploy.state().builds).toBe(1);
  expect(deploy.state().ups).toBe(0);
  expect(deploy.record().healthy).toBeNull();
  expect(deploy.deployed()).toBeUndefined();
});

it.each(["FAIL_LEGACY_PUBLISH", "FAIL_HEALTHY_PUBLISH"])(
  "keeps the initial healthy receipt absent when first publication fails: %s",
  (failure) => {
    const deploy = fixture();
    deploy.next();
    const result = deploy.run({ [failure]: "1" });
    expect(result.status).not.toBe(0);
    expect(deploy.record().healthy).toBeNull();
    expect(deploy.deployed()).toBeUndefined();
    expect(deploy.head()).toBe(deploy.first);
    expect(deploy.state().containers["1".repeat(64)]?.Image).toBe(deploy.firstImage);
  },
);

describe("production deploy adoption recovery and Git metadata", () => {
  it("leaves a failed bootstrap unadopted and refuses a same-name retry", () => {
    const deploy = fixture();
    const first = deploy.run({ FAIL_BOOTSTRAP: "1" });
    expectAdmissionFailure(deploy, first);
    expect(existsSync(deploy.recordPath)).toBe(false);
    const state = deploy.state();
    expect(Object.keys(state.builders)).toHaveLength(1);
    expect(Object.keys(state.volumes)).toHaveLength(1);
    deploy.clearLogs();
    const second = deploy.run();
    expect(second.status).not.toBe(0);
    expect(deploy.state().prunes).toBe(0);
    expect(deploy.state().builds).toBe(0);
    expect(
      deploy
        .dockerArguments()
        .map(dockerOperation)
        .some((args) => args[0] === "buildx" && args[1] === "create"),
    ).toBe(false);
    assertNoUnsafeCleanup(deploy);
  });

  it("does not adopt a protection tag whose ledger publication failed", () => {
    const deploy = fixture();
    const first = deploy.run({ FAIL_LEDGER_PUBLISH: "1" });
    expectAdmissionFailure(deploy, first);
    expect(deploy.record().images).toEqual([]);
    expect(
      deploy
        .state()
        .images[deploy.firstImage]!.RepoTags.some((ref) => ref.startsWith("coginebot-deploy-")),
    ).toBe(true);
    expect(deploy.record().healthy).toBeNull();
    deploy.clearLogs();
    const second = deploy.run();
    expect(second.status).not.toBe(0);
    expect(deploy.state().builds).toBe(0);
    expect(deploy.state().prunes).toBe(0);
    expect(deploy.events().some((event) => event.startsWith("git fetch"))).toBe(false);
  });

  it("keeps state inside a linked worktree's Git metadata rather than its checkout", () => {
    const deploy = fixture(),
      linked = path.join(deploy.root, "linked checkout with spaces");
    git(deploy.checkout, "worktree", "add", "--quiet", "--detach", linked, deploy.first);
    write(path.join(linked, ".env"), "RAKAZO_HOST=app.example.test\n");
    const result = deploy.run({ RAKAZO_DEPLOY_DIR: linked });
    expect(result.status, result.stderr).toBe(0);
    const metadata = path.resolve(
      linked,
      git(linked, "rev-parse", "--git-path", "coginebot-deploy"),
    );
    expect(existsSync(path.join(metadata, "state.json"))).toBe(true);
    const record = JSON.parse(
      readFileSync(path.join(metadata, "state.json"), "utf8"),
    ) as DeploymentRecord;
    expect(record.owner.appDir).toBe(realpathSync(linked));
    expect(record.healthy?.revision).toBe(deploy.first);
    expect(existsSync(path.join(linked, "coginebot-deploy"))).toBe(false);
    expect(existsSync(deploy.stateDirectory)).toBe(false);
  });
});

describe("production deploy pinned forward images", () => {
  it("pulls missing dependency images before the named build and never implicitly builds or pulls during up", () => {
    const deploy = fixture();
    deploy.update((s) => {
      s.containers = {};
      delete s.images[deploy.databaseImage];
    });
    const result = deploy.run();
    expect(result.status, result.stderr).toBe(0);
    const commands = deploy.dockerArguments();
    const pull = commands.findIndex(
      (args) => composeOperation(args)[0] === "pull" && !args.includes("--help"),
    );
    const build = commands.findIndex(
      (args) => composeOperation(args)[0] === "build" && !args.includes("--help"),
    );
    const up = commands.findIndex((args) => composeOperation(args)[0] === "up");
    expect(pull).toBeGreaterThanOrEqual(0);
    expect(composeOperation(commands[pull]!)).toEqual([
      "pull",
      "--ignore-buildable",
      "--policy",
      "missing",
    ]);
    expect(build).toBeGreaterThan(pull);
    expect(up).toBeGreaterThan(build);
    expect(deploy.record().healthy?.services.find((s) => s.service === "postgres")?.id).toBe(
      deploy.databaseImage,
    );
    expect(commands[up]!.some((arg) => arg.endsWith("/forward.json"))).toBe(true);
    assertNoUnsafeCleanup(deploy);
  });

  it("rechecks reserve after pulling dependencies and refuses a forward build if it was consumed", () => {
    const deploy = fixture();
    deploy.next();
    const result = deploy.run({ DOCKER_FREE_AFTER_PULL: "1" });
    expect(result.status).not.toBe(0);
    expect(deploy.state().pulls).toBe(1);
    expect(deploy.state().builds).toBe(0);
    expect(
      deploy
        .dockerArguments()
        .filter((args) => composeOperation(args)[0] === "up")
        .every((args) => args.some((arg) => arg.endsWith("/rollback.json"))),
    ).toBe(true);
    expect(deploy.deployed()).toBeUndefined();
  });

  it.each([{ COMPOSE_PULL_HELP: "Usage: docker compose pull" }, { FAIL_PULL: "1" }])(
    "fails accurately when dependency pull prerequisites or execution fail: %j",
    (overrides) => {
      const deploy = fixture();
      deploy.next();
      const result = deploy.run(overrides);
      expect(result.status).not.toBe(0);
      expect(deploy.state().builds).toBe(0);
      expect(deploy.deployed()).toBeUndefined();
      expect(
        deploy
          .dockerArguments()
          .filter((args) => composeOperation(args)[0] === "up")
          .every((args) => args.some((arg) => arg.endsWith("/rollback.json"))),
      ).toBe(true);
    },
  );

  it("uses captured image identities after configured aliases change immediately before startup", () => {
    const deploy = fixture();
    deploy.update((s) => {
      s.config.services.api!.pull_policy = "always";
      s.config.services.web!.pull_policy = "build";
    });
    deploy.next();
    const result = deploy.run({ RETAG_BEFORE_UP: "1" });
    expect(result.status, result.stderr).toBe(0);
    const state = deploy.state();
    expect(state.lastBuiltId).not.toBeNull();
    expect(state.lastBuiltId).not.toBe(deploy.firstImage);
    expect(state.containers["1".repeat(64)]!.Image).toBe(state.lastBuiltId);
    expect(state.containers["2".repeat(64)]!.Image).toBe(state.lastBuiltId);
    expect(state.containers["3".repeat(64)]!.Image).toBe(deploy.databaseImage);
    expect(deploy.record().healthy?.services.find((s) => s.service === "api")?.id).toBe(
      state.lastBuiltId,
    );
    assertNoUnsafeCleanup(deploy);
  });

  it("refuses to publish a healthy generation when the running image map differs from its captured forward map", () => {
    const deploy = fixture();
    const before = prime(deploy);
    deploy.next();
    const result = deploy.run({ UP_IMAGE_MISMATCH: "1" });
    expect(result.status).not.toBe(0);
    expect(deploy.record().healthy).toEqual(before.healthy);
    expect(deploy.deployed()).toBe(deploy.first);
    for (const prior of before.healthy!.services)
      expect(
        Object.values(deploy.state().containers).find(
          (c) => c.Config.Labels["com.docker.compose.service"] === prior.service,
        )?.Image,
      ).toBe(prior.id);
    expect(
      deploy.dockerArguments().some((args) => args.some((arg) => arg.endsWith("/rollback.json"))),
    ).toBe(true);
  });
});

describe("production deploy reserved image references and verified rollback", () => {
  const internalAliases = [
    ["private history reference", (ref: string) => ref],
    ["Docker Hub qualified history reference", (ref: string) => `docker.io/library/${ref}`],
    [
      "foreign internal namespace alias",
      () => `registry.example.test/team/coginebot-deploy-${"f".repeat(32)}:${"a".repeat(64)}`,
    ],
  ] as const;

  it.each(internalAliases)("rejects an initial build tag using a %s", (_label, alias) => {
    const deploy = fixture();
    const before = prime(deploy);
    deploy.update((state) => {
      state.config.services.api!.image = alias(before.healthy!.services[0]!.ref);
    });
    const result = deploy.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("reserved deployment image namespace");
    expect(deploy.state().builds).toBe(1);
    expect(deploy.state().prunes).toBe(0);
    expect(deploy.events().some((event) => event.startsWith("git fetch"))).toBe(false);
    expect(imageMutations(deploy)).toHaveLength(0);
    expect(deploy.record().healthy).toEqual(before.healthy);
  });

  it.each(internalAliases)("rejects a target build tag using a %s", (_label, alias) => {
    const deploy = fixture();
    const before = prime(deploy);
    deploy.next();
    const result = deploy.run({ TARGET_IMAGE_REF: alias(before.healthy!.services[0]!.ref) });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("reserved deployment image namespace");
    expect(deploy.state().builds).toBe(1);
    expect(deploy.record().healthy).toEqual(before.healthy);
    expect(deploy.head()).toBe(deploy.first);
    expect(
      deploy
        .composeArguments("up")
        .some((args) => args.some((arg) => arg.endsWith("/forward.json"))),
    ).toBe(false);
    for (const image of before.healthy!.services)
      expect(
        Object.values(deploy.state().containers).find(
          (container) => container.Config.Labels["com.docker.compose.service"] === image.service,
        )?.Image,
      ).toBe(image.id);
  });

  it.each([
    { ROLLBACK_PROJECT: "another-stack" },
    { ROLLBACK_ADD_SERVICE: "1" },
    { ROLLBACK_REMOVE_SERVICE: "1" },
    { ROLLBACK_RENAME_SERVICE: "1" },
  ])(
    "does not start rollback after the restored config changes project or active services: %j",
    (fault) => {
      const deploy = fixture();
      const before = prime(deploy);
      deploy.next();
      const result = deploy.run({ FAIL_BUILD: "1", ...fault });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("previous Compose project or active services changed");
      expect(result.stderr).not.toContain("passed health and readiness");
      expect(deploy.composeArguments("up")).toHaveLength(0);
      expect(deploy.record().healthy).toEqual(before.healthy);
      expect(deploy.deployed()).toBe(deploy.first);
      expect(deploy.head()).toBe(deploy.first);
    },
  );

  it("does not claim exact-image rollback when health succeeds with different actual image IDs", () => {
    const deploy = fixture();
    const before = prime(deploy);
    deploy.next();
    const result = deploy.run({ FAIL_BUILD: "1", ROLLBACK_IMAGE_MISMATCH: "1" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Exact-image rollback service images differ");
    expect(result.stderr).not.toContain("passed health and readiness");
    expect(deploy.readyAttempts()).toBe(1);
    expect(deploy.state().containers["1".repeat(64)]!.Image).toBe(deploy.databaseImage);
    expect(deploy.record().healthy).toEqual(before.healthy);
    expect(deploy.deployed()).toBe(deploy.first);
  });
});

describe("production deploy Compose selectors through sudo", () => {
  function withProfiles(deploy: ReturnType<typeof fixture>) {
    deploy.update((state) => {
      state.config.services.optional = {
        image: "example/app:local",
        build: { context: "../.." },
        profiles: ["optional"],
      };
      state.config.services.audit = {
        image: "postgres:16",
        profiles: ["audit"],
      };
    });
  }
  function profileArguments(args: string[]) {
    return args.flatMap((arg, index) => (arg === "--profile" ? [args[index + 1]!] : []));
  }
  function executionArguments(deploy: ReturnType<typeof fixture>) {
    return deploy.dockerArguments().filter((args) => {
      const op = composeOperation(args)[0];
      return op && !args.includes("--help");
    });
  }

  it.each([
    { callerProfiles: " optional , audit ", expectedProfiles: ["optional", "audit"] },
    {
      callerProfiles: "\u00a0optional\u3000, audit , ",
      expectedProfiles: ["optional", "audit", ""],
    },
  ])(
    "preserves caller project and multiple profiles in explicit arguments after sudo removes their environment: %j",
    ({ callerProfiles, expectedProfiles }) => {
      const deploy = fixture();
      withProfiles(deploy);
      write(
        path.join(deploy.checkout, ".env"),
        "RAKAZO_HOST=app.example.test\nCOMPOSE_PROJECT_NAME=dotenv-stack\nCOMPOSE_PROFILES=unused\n",
      );
      deploy.update((state) => {
        for (const container of Object.values(state.containers))
          container.Config.Labels["com.docker.compose.project"] = "caller-stack";
      });
      const result = deploy.run({
        COMPOSE_PROJECT_NAME: "caller-stack",
        COMPOSE_PROFILES: callerProfiles,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(deploy.record().owner.project).toBe("caller-stack");
      expect(deploy.record().healthy!.services.map((service) => service.service)).toEqual([
        "api",
        "audit",
        "optional",
        "postgres",
        "web",
      ]);
      const args = executionArguments(deploy);
      expect(args.length).toBeGreaterThan(4);
      for (const command of args) {
        expect(command[command.indexOf("--project-name") + 1]).toBe("caller-stack");
        expect(profileArguments(command)).toEqual(expectedProfiles);
      }
      expect(
        deploy
          .cliSelectors()
          .every((selectors) => selectors.project === null && selectors.profiles === null),
      ).toBe(true);
      assertNoUnsafeCleanup(deploy);
    },
  );

  it("preserves an explicitly empty caller profile selection over dotenv profiles", () => {
    const deploy = fixture();
    withProfiles(deploy);
    write(
      path.join(deploy.checkout, ".env"),
      "RAKAZO_HOST=app.example.test\nCOMPOSE_PROFILES=optional,audit\n",
    );
    const result = deploy.run({ COMPOSE_PROFILES: "" });
    expect(result.status, result.stderr).toBe(0);
    expect(deploy.record().healthy!.services.map((service) => service.service)).toEqual([
      "api",
      "postgres",
      "web",
    ]);
    for (const command of executionArguments(deploy))
      expect(profileArguments(command)).toEqual([""]);
    expect(deploy.cliSelectors().every((selectors) => selectors.profiles === null)).toBe(true);
  });

  it("uses dotenv project and profiles when caller selectors are unset", () => {
    const deploy = fixture();
    withProfiles(deploy);
    write(
      path.join(deploy.checkout, ".env"),
      "RAKAZO_HOST=app.example.test\nCOMPOSE_PROJECT_NAME=dotenv-stack\nCOMPOSE_PROFILES=optional\n",
    );
    deploy.update((state) => {
      for (const container of Object.values(state.containers))
        container.Config.Labels["com.docker.compose.project"] = "dotenv-stack";
    });
    const result = deploy.run();
    expect(result.status, result.stderr).toBe(0);
    expect(deploy.record().owner.project).toBe("dotenv-stack");
    expect(deploy.record().healthy!.services.map((service) => service.service)).toEqual([
      "api",
      "optional",
      "postgres",
      "web",
    ]);
    for (const command of executionArguments(deploy)) expect(profileArguments(command)).toEqual([]);
    const readConfig = executionArguments(deploy).find((command) =>
      composeOperation(command).includes("--format"),
    );
    expect(readConfig).not.toContain("--project-name");
  });

  it("keeps the original caller selectors for rollback startup and readiness", () => {
    const deploy = fixture();
    withProfiles(deploy);
    const selectors = { COMPOSE_PROJECT_NAME: "caller-stack", COMPOSE_PROFILES: "optional,audit" };
    deploy.update((state) => {
      for (const container of Object.values(state.containers))
        container.Config.Labels["com.docker.compose.project"] = selectors.COMPOSE_PROJECT_NAME;
    });
    expect(deploy.run(selectors).status).toBe(0);
    const before = deploy.record();
    deploy.clearLogs();
    deploy.next();
    const result = deploy.run({ ...selectors, FAIL_BUILD: "1" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("passed health and readiness");
    expect(deploy.record().healthy).toEqual(before.healthy);
    const rollback = deploy.composeArguments("up");
    expect(rollback).toHaveLength(1);
    for (const command of [...rollback, ...deploy.composeArguments("exec")]) {
      expect(command[command.indexOf("--project-name") + 1]).toBe("caller-stack");
      expect(profileArguments(command)).toEqual(["optional", "audit"]);
    }
  });

  it("rejects an explicitly empty project selector before Docker, cleanup or checkout mutation", () => {
    const deploy = fixture();
    write(
      path.join(deploy.checkout, ".env"),
      "RAKAZO_HOST=app.example.test\nCOMPOSE_PROJECT_NAME=dotenv-stack\n",
    );
    const result = deploy.run({ COMPOSE_PROJECT_NAME: "" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "COMPOSE_PROJECT_NAME must be a nonempty valid Compose project name when set",
    );
    expect(deploy.dockerArguments()).toEqual([]);
    expect(deploy.events()).toEqual([]);
    expect(existsSync(deploy.stateDirectory)).toBe(false);
    expect(deploy.head()).toBe(deploy.first);
  });
});

describe.skipIf(process.platform !== "linux")(
  "production deploy SGID state directory boundary",
  () => {
    it("normalizes only a newly created state directory beneath an owned SGID Git directory", () => {
      const deploy = fixture();
      const gitDirectory = path.dirname(deploy.stateDirectory);
      const originalMode = statSync(gitDirectory).mode & 0o7777;
      chmodSync(gitDirectory, 0o2700);
      try {
        const result = deploy.run();
        expect(result.status, result.stderr).toBe(0);
        expect(statSync(deploy.stateDirectory).mode & 0o7777).toBe(0o700);
        expect(statSync(deploy.recordPath).mode & 0o7777).toBe(0o600);
      } finally {
        chmodSync(gitDirectory, originalMode);
      }
    });

    it("refuses an existing SGID state directory instead of repairing it implicitly", () => {
      const deploy = fixture();
      const before = prime(deploy);
      chmodSync(deploy.stateDirectory, 0o2700);
      const result = deploy.run();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("mode-0700");
      expect(statSync(deploy.stateDirectory).mode & 0o7777).toBe(0o2700);
      expect(deploy.record().healthy).toEqual(before.healthy);
      expect(deploy.state().prunes).toBe(0);
      expect(deploy.events().some((event) => event.startsWith("git fetch"))).toBe(false);
    });
  },
);
