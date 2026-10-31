#!/usr/bin/env python3
"""Reject user-rule files that installed UFW cannot serialize without loss."""

import ast
import gettext
import hashlib
import io
import os
from pathlib import Path
import stat
import sys
import tempfile


PACKAGED_TEMPLATE_DIRECTORY = Path("/usr/share/ufw/iptables")
PACKAGED_USER_TEMPLATES = {
    "user.rules": (307, "320f53e1ee90a7fd92f17b67f50b06b51cb20998cd52f01dbcb52e24160618bf"),
    "user6.rules": (107, "f6696cd7741aada36ab2055dd1a9d098e23e0290ca3a67dafbbad2920e5fdf60"),
}


def matches_packaged_template(name, original):
    expected = PACKAGED_USER_TEMPLATES.get(name)
    if expected is None or (len(original), hashlib.sha256(original).hexdigest()) != expected:
        return False
    template = PACKAGED_TEMPLATE_DIRECTORY / name
    try:
        for directory in reversed(template.parents):
            details = directory.lstat()
            if (not stat.S_ISDIR(details.st_mode) or details.st_uid != 0
                    or details.st_mode & 0o022 or not os.access(directory, os.R_OK | os.X_OK)):
                return False
        details = template.lstat()
        if (not stat.S_ISREG(details.st_mode) or details.st_uid != 0
                or details.st_mode & 0o022 or details.st_size != expected[0]
                or not os.access(template, os.R_OK)):
            return False
        return template.read_bytes() == original
    except OSError:
        return False


def check(ufw_command, config, ssh_port):
    # This adapter is deliberately bounded to the installed formatter API reviewed here.
    tree = ast.parse(Path(ufw_command).read_text(encoding="utf-8"))
    versions = [
        node.value.value
        for node in tree.body
        if isinstance(node, ast.Assign)
        and any(isinstance(target, ast.Name) and target.id == "version" for target in node.targets)
        and isinstance(node.value, ast.Constant)
    ]
    if versions != ["0.36.2"]:
        raise ValueError("unsupported UFW formatter version")

    import ufw.backend_iptables
    import ufw.common
    import ufw.util

    if ufw.common.config_dir != "/etc" or ufw.common.state_dir != "/lib/ufw":
        raise ValueError("unsupported UFW configuration layout")
    gettext.install("ufw")
    saved = {name: (config / "ufw" / name).read_bytes()
             if (config / "ufw" / name).exists() else b""
             for name in ("user.rules", "user6.rules")}

    with tempfile.TemporaryDirectory(prefix="ufw-preserve-") as temporary:
        stage = Path(temporary)
        for relative in ("etc/ufw/applications.d", "etc/default", "lib/ufw"):
            (stage / relative).mkdir(parents=True, exist_ok=True)
        for relative in ("default/ufw", "ufw/ufw.conf"):
            (stage / "etc" / relative).write_bytes((config / relative).read_bytes())
        for name, content in saved.items():
            (stage / "etc/ufw" / name).write_bytes(content)
        for name in ("before.rules", "before6.rules", "after.rules", "after6.rules"):
            (stage / "etc/ufw" / name).touch()
        (stage / "lib/ufw/ufw-init").touch()
        tempfile.tempdir = temporary

        def staged(target, directory_fd=-1):
            target = Path(target)
            if not target.is_absolute() and directory_fd not in (-1, None):
                target = Path(f"/proc/self/fd/{directory_fd}").resolve() / target
            return target.resolve().is_relative_to(stage)

        def restrict(event, arguments):
            if event.startswith(("subprocess.", "socket.", "os.exec", "os.spawn")) or event in (
                "os.system", "os.fork", "os.forkpty", "os.posix_spawn",
            ):
                raise RuntimeError("formatter attempted an external operation")
            if event == "open":
                target, _, flags = arguments
                writing = flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND)
                if writing and not isinstance(target, int) and not staged(target):
                    raise RuntimeError("formatter attempted a write outside staging")
            mutations = {
                "os.remove": ((0, 1),), "os.rmdir": ((0, 1),),
                "os.mkdir": ((0, 2),), "os.chmod": ((0, 2),),
                "os.chown": ((0, 3),), "os.utime": ((0, 3),),
                "os.rename": ((0, 2), (1, 3)), "os.link": ((0, 2), (1, 3)),
                "os.symlink": ((1, 2),),
            }
            for target, directory_fd in mutations.get(event, ()):
                if not staged(arguments[target], arguments[directory_fd]):
                    raise RuntimeError("formatter attempted a mutation outside staging")

        sys.addaudithook(restrict)
        # The constructor's version probe is not used by its reader or writer.
        # Suppress that subprocess; no host iptables command is needed for formatting.
        ufw.util.get_iptables_version = lambda *_: "unused-by-roundtrip"

        class SavedRules(ufw.backend_iptables.UFWBackendIptables):
            def use_ipv6(self):
                # Also inspect saved IPv6 when it is disabled on the running host.
                return True

        backend = SavedRules(True, rootdir=temporary, datadir=temporary)
        for name, original in saved.items():
            if not original:
                continue
            matched = False
            for limit in (False, True):
                backend.caps = {"limit": {"4": limit, "6": limit}}
                output = io.StringIO()
                ufw.util.msg_output = output
                backend._write_rules(v6=name == "user6.rules")
                if output.getvalue().encode("ascii") == original:
                    matched = True
                    break
            # Pristine package files contain no registered user policy, but the
            # formatter adds section markers on their first CLI write.
            if not matched and not matches_packaged_template(name, original):
                raise ValueError(f"{name} contains content UFW would rewrite or discard")

        # CLI additions may replace a rule with matching selectors and another action.
        # Ask the same backend to model the exact additions, and require all old rules
        # to remain in their original order before any newly appended rules.
        backend.caps = {"limit": {"4": True, "6": True}}
        def identity(rule):
            fields = ("action", "protocol", "dport", "dst", "sport", "src", "direction",
                      "forward", "interface_in", "interface_out", "dapp", "sapp", "logtype",
                      "comment", "v6", "multi")
            values = tuple(getattr(rule, field) for field in fields)
            if not all(isinstance(value, (str, bool, int)) for value in values):
                raise ValueError("unsupported UFW rule model")
            return (rule.format_rule(), *values)

        families = [(False, backend.rules), (True, backend.rules6)]
        for v6, rules in families:
            for rule in rules:
                rule.normalize()
            original = tuple(identity(rule) for rule in rules)
            for action, protocol, port, comment in (
                ("limit", "tcp", ssh_port, "Rate-limited SSH"),
                ("allow", "tcp", "80", "HTTP for ACME redirect"),
                ("allow", "tcp", "443", "HTTPS"),
                ("allow", "udp", "443", "HTTP/3"),
            ):
                network = "::/0" if v6 else "0.0.0.0/0"
                rule = ufw.common.UFWRule(action, protocol, port, network, "any", network,
                                          comment=ufw.util.hex_encode(comment))
                rule.set_v6(v6)
                ufw.util.msg_output = io.StringIO()
                backend.set_rule(rule, allow_reload=False)
                current = backend.rules6 if v6 else backend.rules
                if tuple(identity(rule) for rule in current[:len(original)]) != original:
                    raise ValueError("baseline UFW additions would replace or reorder an existing rule")


if __name__ == "__main__":
    try:
        if len(sys.argv) != 4 or not sys.argv[3].isdigit() or not 1 <= int(sys.argv[3]) <= 65535:
            raise ValueError("expected UFW executable, configuration directory and SSH port")
        check(sys.argv[1], Path(sys.argv[2]), str(int(sys.argv[3])))
    except Exception as error:
        print(f"Cannot preserve saved UFW user rules: {error}", file=sys.stderr)
        sys.exit(1)
