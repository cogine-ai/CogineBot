import {
  COMPUTER_DISK_USAGE_EXCLUDED_NAMES,
  COMPUTER_DISK_USAGE_EXCLUDED_SUFFIXES,
  COMPUTER_DISK_USAGE_MAX_CANDIDATES,
  COMPUTER_DISK_USAGE_MAX_DEPTH,
  COMPUTER_DISK_USAGE_MAX_PATH_BYTES,
  COMPUTER_DISK_USAGE_MAX_RESPONSE_BYTES,
  COMPUTER_DISK_USAGE_TIMEOUT_MS,
} from "@rakazo/contracts";

const mountIdentity = `
def mount(fd):
    with open("/proc/self/fdinfo/" + str(fd), encoding="ascii") as info:
        for line in info:
            if line.startswith("mnt_id:"):
                return int(line.split()[1])
    raise OSError("mount identity unavailable")
`;

// Linux descriptor-relative reads keep traversal on the managed workspace mount.
// O_PATH opens metadata only, including for sockets, device files, and symlinks.
export const workspaceDiskProbe = String.raw`
import json, os, select, stat, sys, threading, unicodedata

home, bot = sys.argv[1:]
max_entries = 2000
max_depth = ${COMPUTER_DISK_USAGE_MAX_DEPTH}
max_candidates = ${COMPUTER_DISK_USAGE_MAX_CANDIDATES}
max_path_bytes = ${COMPUTER_DISK_USAGE_MAX_PATH_BYTES}
# Leave room for the result envelope and Docker's stream framing.
max_candidate_bytes = ${COMPUTER_DISK_USAGE_MAX_RESPONSE_BYTES} - 1024
directory = os.O_DIRECTORY | os.O_NOFOLLOW | os.O_RDONLY
entry_flags = os.O_PATH | os.O_NOFOLLOW
excluded = frozenset(${JSON.stringify(COMPUTER_DISK_USAGE_EXCLUDED_NAMES)})
excluded_suffix = tuple(${JSON.stringify(COMPUTER_DISK_USAGE_EXCLUDED_SUFFIXES)})

${mountIdentity}

def guard(timeout_ms):
    # The supervisor keeps stdin open after sending the budget. A disconnect
    # closes it even while the scanner is inside a filesystem call.
    readable, _, _ = select.select([0], [], [], timeout_ms / 1000)
    os._exit(125 if readable else 124)

def workspace():
    # The parent is in the managed image and the home itself is a fixed mount.
    current = os.open(home, directory)
    try:
        home_mount = mount(current)
        for name in (("bots", bot) if bot else ()):
            child = os.open(name, directory, dir_fd=current)
            os.close(current)
            current = child
            if mount(current) != home_mount:
                raise OSError("workspace crosses its mount")
        return current
    except BaseException:
        os.close(current)
        raise

def safe(name):
    lowered = name.lower()
    return not (name.startswith(".") or "\\" in name or lowered in excluded or
        lowered.endswith(excluded_suffix) or
        any(unicodedata.category(c) in {"Cc", "Cf", "Cs"} for c in name))

def identity(info):
    return (info.st_dev, info.st_ino, info.st_ctime_ns)

def main():
    root = workspace()
    work_mount = mount(root)
    root_info = os.fstat(root)
    filesystem = os.fstatvfs(root)
    rows = []
    seen = 0
    partial = False

    def visit(fd, prefix, depth):
        nonlocal seen, partial
        try:
            with os.scandir(fd) as listing:
                for entry in listing:
                    if seen >= max_entries:
                        partial = True
                        return
                    seen += 1
                    if not safe(entry.name):
                        continue
                    name = prefix + entry.name
                    if len(name.encode("utf-8")) > max_path_bytes:
                        partial = True
                        continue
                    first_row = len(rows)
                    try:
                        child = os.open(entry.name, entry_flags, dir_fd=fd)
                        try:
                            info = os.fstat(child)
                            if info.st_dev != root_info.st_dev or mount(child) != work_mount:
                                continue
                            if stat.S_ISDIR(info.st_mode):
                                if depth == max_depth:
                                    partial = True
                                    continue
                                nested = os.open(".", directory, dir_fd=child)
                                try:
                                    visit(nested, name + "/", depth + 1)
                                finally:
                                    os.close(nested)
                            elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                                rows.append((info.st_size, name))
                            if identity(os.stat(entry.name, dir_fd=fd, follow_symlinks=False)) != identity(info):
                                del rows[first_row:]
                                partial = True
                        finally:
                            os.close(child)
                    except OSError:
                        del rows[first_row:]
                        partial = True
        except OSError:
            if depth == 1:
                raise
            partial = True

    visit(root, "", 1)
    current = workspace()
    after = os.fstat(current)
    if identity(after) != identity(root_info) or mount(current) != work_mount:
        return {"status": "unavailable"}
    rows.sort(key=lambda file: (-file[0], file[1]))
    candidates = []
    remaining = max_candidate_bytes
    for size, name in rows[:max_candidates]:
        candidate = {"path": name, "logicalBytes": size}
        encoded_bytes = len(json.dumps(candidate, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
        remaining -= encoded_bytes + 1
        if remaining < 0:
            break
        candidates.append(candidate)
    return {"status": "available", "data": {
        "volume": {
            "totalBytes": filesystem.f_blocks * filesystem.f_frsize,
            "availableBytes": filesystem.f_bavail * filesystem.f_frsize,
            "availableInodes": filesystem.f_favail if filesystem.f_files else None,
        },
        "candidates": candidates,
        "partial": partial or len(rows) > len(candidates),
    }}

# Exec creation and hijacking can lag. No filesystem work begins until the
# supervisor passes the post-attach budget over the open stream.
maximum_ms = ${COMPUTER_DISK_USAGE_TIMEOUT_MS}
if not select.select([0], [], [], maximum_ms / 1000)[0]:
    sys.exit(124)
start = os.read(0, 16)
if not start.endswith(b"\n") or not start[:-1].isdigit():
    sys.exit(125)
timeout_ms = int(start)
if not 0 < timeout_ms <= maximum_ms:
    sys.exit(125)
threading.Thread(target=guard, args=(timeout_ms,), daemon=True).start()
try:
    result = main()
except OSError:
    result = {"status": "unavailable"}
print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
`;

// The fixed non-shell writer alone can attest to ENOSPC. Raw stderr remains a
// generic failure and is never interpreted as proof of exhausted storage.
export const workspaceWrite = `
import errno, os, sys
home, relative, executable = sys.argv[1:]
${mountIdentity}

def known_mount(fd):
    try:
        return mount(fd)
    except OSError:
        return None

def fail(error, workspace_volume):
    if error.errno != errno.ENOSPC or not workspace_volume:
        raise error
    print("workspace-write:ENOSPC:v1", flush=True)
    sys.exit(77)

# Open directory descriptors rather than changing existing symlink behavior.
# Only errors on the identified workspace mount can point to its diagnosis.
directory = os.O_PATH | os.O_DIRECTORY
parent = os.open(home, directory)
workspace_mount = known_mount(parent)
parts = relative.split("/")
try:
    for name in parts[:-1]:
        try:
            child = os.open(name, directory, dir_fd=parent)
        except FileNotFoundError:
            try:
                os.mkdir(name, dir_fd=parent)
            except FileExistsError:
                pass
            except OSError as error:
                fail(error, workspace_mount is not None and known_mount(parent) == workspace_mount)
            child = os.open(name, directory, dir_fd=parent)
        os.close(parent)
        parent = child
    name = parts[-1] or "."
    flags = os.O_WRONLY | os.O_CREAT
    try:
        fd = os.open(name, flags | os.O_EXCL, 0o666, dir_fd=parent)
    except FileExistsError:
        # The resolved file may be on another mount. Its descriptor is the
        # evidence for write, flush, chmod, and close failures.
        fd = os.open(name, flags | os.O_TRUNC, 0o666, dir_fd=parent)
    except OSError as error:
        fail(error, workspace_mount is not None and known_mount(parent) == workspace_mount)
    workspace_volume = workspace_mount is not None and known_mount(fd) == workspace_mount
    try:
        with os.fdopen(fd, "wb") as file:
            file.write(sys.stdin.buffer.read())
            file.flush()
            os.fchmod(file.fileno(), 0o700 if executable == "1" else 0o600)
    except OSError as error:
        fail(error, workspace_volume)
finally:
    os.close(parent)
`;

export function capturedWorkspaceDiskFull(output: {
  code: number;
  stdout: string;
  stderr: string;
}) {
  return (
    output.code === 77 && output.stdout === "workspace-write:ENOSPC:v1\n" && output.stderr === ""
  );
}
