import {
  COMPUTER_DISK_USAGE_EXCLUDED_NAMES,
  COMPUTER_DISK_USAGE_EXCLUDED_SUFFIXES,
  COMPUTER_DISK_USAGE_MAX_CANDIDATES,
  COMPUTER_DISK_USAGE_MAX_DEPTH,
  COMPUTER_DISK_USAGE_MAX_PATH_BYTES,
} from "@rakazo/contracts";

// Linux descriptor-relative reads keep traversal on the managed workspace mount.
// O_PATH opens metadata only, including for sockets, device files, and symlinks.
export const workspaceDiskProbe = String.raw`
import json, os, select, stat, sys, threading, unicodedata

home, bot, timeout_ms = sys.argv[1:]
max_entries = 2000
max_depth = ${COMPUTER_DISK_USAGE_MAX_DEPTH}
max_candidates = ${COMPUTER_DISK_USAGE_MAX_CANDIDATES}
max_path_bytes = ${COMPUTER_DISK_USAGE_MAX_PATH_BYTES}
directory = os.O_DIRECTORY | os.O_NOFOLLOW | os.O_RDONLY
entry_flags = os.O_PATH | os.O_NOFOLLOW
excluded = frozenset(${JSON.stringify(COMPUTER_DISK_USAGE_EXCLUDED_NAMES)})
excluded_suffix = tuple(${JSON.stringify(COMPUTER_DISK_USAGE_EXCLUDED_SUFFIXES)})

def guard():
    # Docker leaves stdin open for this operation. A disconnect closes it even
    # if the scanner is still inside a filesystem call.
    readable, _, _ = select.select([0], [], [], int(timeout_ms) / 1000)
    os._exit(125 if readable else 124)

def mount(fd):
    with open("/proc/self/fdinfo/" + str(fd), encoding="ascii") as info:
        for line in info:
            if line.startswith("mnt_id:"):
                return int(line.split()[1])
    raise OSError("mount identity unavailable")

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
    return {"status": "available", "data": {
        "volume": {
            "totalBytes": filesystem.f_blocks * filesystem.f_frsize,
            "availableBytes": filesystem.f_bavail * filesystem.f_frsize,
            "availableInodes": filesystem.f_favail if filesystem.f_files else None,
        },
        "candidates": [{"path": name, "logicalBytes": size} for size, name in rows[:max_candidates]],
        "partial": partial or len(rows) > max_candidates,
    }}

threading.Thread(target=guard, daemon=True).start()
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
target = sys.argv[1]
try:
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "wb") as file:
        file.write(sys.stdin.buffer.read())
    os.chmod(target, 0o700 if sys.argv[2] == "1" else 0o600)
except OSError as error:
    if error.errno != errno.ENOSPC:
        raise
    print("workspace-write:ENOSPC:v1", flush=True)
    sys.exit(77)
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
