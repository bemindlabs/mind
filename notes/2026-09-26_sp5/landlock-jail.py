#!/usr/bin/env python3
"""landlock-jail.py — outer Landlock jail for SP-5 CLI runs (no root, no user namespaces).

Usage: landlock-jail.py --rw DIR [--rw DIR ...] [--tcp-port PORT ...] -- CMD [ARGS...]

- Filesystem: reads/exec allowed everywhere; every write-type access (write, truncate,
  create, remove, rename/link) is denied except beneath the --rw directories.
- Network: if any --tcp-port is given, TCP connect() is allowed only to those ports and
  TCP bind() is denied (Landlock ABI >= 4). UDP is not covered by Landlock.
- Signals / abstract unix sockets are scoped to the jail (ABI >= 6).
The restriction is inherited by every child process and cannot be lifted.
"""
from __future__ import annotations

import ctypes
import os
import sys

SYS_CREATE, SYS_ADD_RULE, SYS_RESTRICT = 444, 445, 446
PR_SET_NO_NEW_PRIVS = 38

FS = {
    "WRITE_FILE": 1 << 1, "REMOVE_DIR": 1 << 4, "REMOVE_FILE": 1 << 5, "MAKE_CHAR": 1 << 6,
    "MAKE_DIR": 1 << 7, "MAKE_REG": 1 << 8, "MAKE_SOCK": 1 << 9, "MAKE_FIFO": 1 << 10,
    "MAKE_BLOCK": 1 << 11, "MAKE_SYM": 1 << 12, "REFER": 1 << 13, "TRUNCATE": 1 << 14,
}
NET_BIND_TCP, NET_CONNECT_TCP = 1 << 0, 1 << 1
SCOPE_ABSTRACT_UNIX, SCOPE_SIGNAL = 1 << 0, 1 << 1


class RulesetAttr(ctypes.Structure):
    _fields_ = [("handled_access_fs", ctypes.c_uint64), ("handled_access_net", ctypes.c_uint64),
                ("scoped", ctypes.c_uint64)]


class PathBeneathAttr(ctypes.Structure):
    _pack_ = 1
    _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]


class NetPortAttr(ctypes.Structure):
    _fields_ = [("allowed_access", ctypes.c_uint64), ("port", ctypes.c_uint64)]


def die(message: str) -> None:
    print(f"landlock-jail: {message}", file=sys.stderr)
    sys.exit(126)


def main(argv: list[str]) -> None:
    if "--" not in argv:
        die("usage: landlock-jail.py --rw DIR [...] [--tcp-port N ...] -- CMD [ARGS...]")
    split = argv.index("--")
    options, command = argv[:split], argv[split + 1:]
    rw_dirs: list[str] = []
    tcp_ports: list[int] = []
    it = iter(options)
    for flag in it:
        value = next(it, None)
        if value is None:
            die(f"missing value for {flag}")
        if flag == "--rw":
            rw_dirs.append(value)
        elif flag == "--tcp-port":
            tcp_ports.append(int(value))
        else:
            die(f"unknown option {flag}")
    if not command:
        die("no command")

    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    abi = libc.syscall(SYS_CREATE, None, ctypes.c_size_t(0), ctypes.c_uint32(1))
    if abi < 6:
        die(f"Landlock ABI {abi} < 6 is not supported by this jail")

    fs_mask = 0
    for bit in FS.values():
        fs_mask |= bit
    attr = RulesetAttr(fs_mask, (NET_BIND_TCP | NET_CONNECT_TCP) if tcp_ports else 0,
                       SCOPE_ABSTRACT_UNIX | SCOPE_SIGNAL)
    ruleset_fd = libc.syscall(SYS_CREATE, ctypes.byref(attr), ctypes.c_size_t(ctypes.sizeof(attr)),
                              ctypes.c_uint32(0))
    if ruleset_fd < 0:
        die(f"landlock_create_ruleset failed: {os.strerror(ctypes.get_errno())}")

    for directory in rw_dirs:
        fd = os.open(directory, os.O_PATH | os.O_CLOEXEC)
        rule = PathBeneathAttr(fs_mask, fd)
        if libc.syscall(SYS_ADD_RULE, ruleset_fd, ctypes.c_int(1), ctypes.byref(rule), ctypes.c_uint32(0)) != 0:
            die(f"add path rule {directory}: {os.strerror(ctypes.get_errno())}")
        os.close(fd)
    for port in tcp_ports:
        rule = NetPortAttr(NET_CONNECT_TCP, port)
        if libc.syscall(SYS_ADD_RULE, ruleset_fd, ctypes.c_int(2), ctypes.byref(rule), ctypes.c_uint32(0)) != 0:
            die(f"add port rule {port}: {os.strerror(ctypes.get_errno())}")

    if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
        die("prctl(NO_NEW_PRIVS) failed")
    if libc.syscall(SYS_RESTRICT, ruleset_fd, ctypes.c_uint32(0)) != 0:
        die(f"landlock_restrict_self failed: {os.strerror(ctypes.get_errno())}")
    os.close(ruleset_fd)
    os.execvp(command[0], command)


if __name__ == "__main__":
    main(sys.argv[1:])
