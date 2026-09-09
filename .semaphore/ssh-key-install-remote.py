"""One reviewed host/key/file only. Streamed over SSH; no on-disk program or deps."""

import base64
from contextlib import ExitStack
import fcntl
import hashlib
import ipaddress
import os
import pwd
import re
import socket
import stat
import subprocess
import sys


TARGET = "139.60.162.24"
PUBLIC_KEY = b"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILoPl4BtuR0TxIrnF+BXET77gmemxO1VzX0AwEongYGz Portal Mac Hostkey 2026-09-09"
FINGERPRINT = "SHA256:h3sRVPnsNrd+/HAQcvY8CwP6wVkn2PCGcDN2HMk+23s"
MAX_BYTES = 1024 * 1024


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def run_readonly(argv):
    result = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=10, check=False)
    # Do not include arbitrary command output or key contents in exceptions/logs.
    require(result.returncode == 0, "SSH configuration inspection failed")
    return result.stdout.decode("utf-8", errors="strict")


def verify_server(mac_ip):
    require(os.getuid() == 0 and os.geteuid() == 0, "Expected real and effective root")
    require(socket.gethostname() == "33074.example.us", "Unexpected hostname")
    require(pwd.getpwnam("root").pw_dir == "/root", "Unexpected root home")
    connection = os.environ.get("SSH_CONNECTION", "").split()
    require(len(connection) == 4 and connection[2:] == [TARGET, "22"],
            "Unexpected SSH endpoint")
    client = ipaddress.IPv4Address(mac_ip)
    require(client.is_global, "Mac source must be a current public IPv4 address")
    ipaddress.ip_address(connection[0])
    listeners = [line.strip() for line in run_readonly(
        ["/bin/ps", "-C", "sshd", "-o", "args="]).splitlines() if "[listener]" in line]
    require(len(listeners) == 1 and re.fullmatch(
        r"sshd: /usr/sbin/sshd -D \[listener\] \d+ of \d+-\d+ startups", listeners[0]) is not None,
        "Unexpected sshd listener or command-line overrides")
    for source in {connection[0], str(client)}:
        output = run_readonly(["/usr/sbin/sshd", "-T", "-C",
                              f"user=root,addr={source},host={source},laddr={TARGET},lport=22"])
        config = dict(line.split(None, 1) for line in output.splitlines() if " " in line)
        require(config.get("permitrootlogin") in {"yes", "prohibit-password", "without-password"},
                "Root public-key login is not permitted")
        for setting, expected in {
            "pubkeyauthentication": "yes", "strictmodes": "yes", "usedns": "no",
            "forcecommand": "none", "authorizedkeyscommand": "none", "revokedkeys": "none",
            "authorizedkeysfile": ".ssh/authorized_keys .ssh/authorized_keys2",
        }.items():
            require(config.get(setting) == expected, "Unexpected SSH setting: " + setting)
        require(config.get("authenticationmethods") in {"any", "publickey"},
                "Additional authentication would be required")
        require("ssh-ed25519" in config.get("pubkeyacceptedalgorithms", "").split(","),
                "ED25519 authentication is not accepted")
        require(not any(name in config for name in
                        ("allowusers", "denyusers", "allowgroups", "denygroups")),
                "Unexpected user/group access rules; inspect before installing")


def check_metadata(info, directory=False, mode=0o600):
    require(info.st_uid == 0 and info.st_gid == 0, "Unexpected path ownership")
    require(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode),
            "Unexpected path type")
    require(stat.S_IMODE(info.st_mode) == mode, "Unexpected path permissions")
    if not directory:
        require(info.st_nlink == 1, "Refusing hard-linked key file")


def same_inode(left, right):
    return (left.st_dev, left.st_ino) == (right.st_dev, right.st_ino)


def read_keys(fd):
    content = os.pread(fd, MAX_BYTES + 1, 0)
    require(len(content) <= MAX_BYTES, "Key file exceeds safety size limit")
    require(b"\0" not in content, "Key file contains NUL bytes")
    return content


def contains_key(content):
    blob = PUBLIC_KEY.split()[1]
    # Conservative: an options-restricted occurrence also prevents a new grant.
    # False positives in comments on an active line stop safely, never widen access.
    pattern = rb"(?:^|[ \t])ssh-ed25519[ \t]+" + re.escape(blob) + rb"(?=[ \t\r]|$)"
    return any(re.search(pattern, line) for line in content.splitlines()
               if not line.lstrip().startswith(b"#"))


def append_key():
    blob = base64.b64decode(PUBLIC_KEY.split()[1], validate=True)
    fingerprint = "SHA256:" + base64.b64encode(hashlib.sha256(blob).digest()).decode().rstrip("=")
    require(fingerprint == FINGERPRINT, "Approved public-key fingerprint mismatch")
    with ExitStack() as stack:
        def opened(name, flags, parent=None):
            fd = os.open(name, flags | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
            stack.callback(os.close, fd)
            return fd

        fs_fd = opened("/", os.O_RDONLY | os.O_DIRECTORY)
        root_fd = opened("root", os.O_RDONLY | os.O_DIRECTORY, fs_fd)
        ssh_fd = opened(".ssh", os.O_RDONLY | os.O_DIRECTORY, root_fd)
        check_metadata(os.stat("authorized_keys", dir_fd=ssh_fd, follow_symlinks=False))
        # No O_CREAT, O_TRUNC, chmod or chown. Unexpected/missing paths must stop.
        key_fd = opened("authorized_keys", os.O_RDWR | os.O_APPEND | os.O_NONBLOCK, ssh_fd)
        check_metadata(os.fstat(root_fd), directory=True, mode=0o700)
        check_metadata(os.fstat(ssh_fd), directory=True, mode=0o700)
        check_metadata(os.fstat(key_fd))
        fcntl.flock(key_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        before = read_keys(key_fd)
        duplicate = contains_key(before)
        alternate_fd = None
        alternate_before = None
        try:
            check_metadata(os.stat("authorized_keys2", dir_fd=ssh_fd, follow_symlinks=False))
            alternate_fd = opened("authorized_keys2", os.O_RDONLY | os.O_NONBLOCK, ssh_fd)
        except FileNotFoundError:
            pass
        if alternate_fd is not None:
            check_metadata(os.fstat(alternate_fd))
            fcntl.flock(alternate_fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
            alternate_before = read_keys(alternate_fd)
            duplicate = duplicate or contains_key(alternate_before)
        if duplicate:
            print("KEY_ALREADY_PRESENT: unchanged; any existing restrictions preserved. " + FINGERPRINT)
            return

        def revalidate_paths():
            for fd, parent, name, directory in (
                (root_fd, fs_fd, "root", True), (ssh_fd, root_fd, ".ssh", True),
                (key_fd, ssh_fd, "authorized_keys", False),
            ):
                current = os.stat(name, dir_fd=parent, follow_symlinks=False)
                require(same_inode(current, os.fstat(fd)), "Path changed during inspection")
                check_metadata(current, directory=directory, mode=0o700 if directory else 0o600)
            try:
                alternate_current = os.stat("authorized_keys2", dir_fd=ssh_fd, follow_symlinks=False)
            except FileNotFoundError:
                require(alternate_fd is None, "Alternate key file disappeared")
            else:
                require(alternate_fd is not None and same_inode(alternate_current, os.fstat(alternate_fd)),
                        "Alternate key file changed during inspection")
                check_metadata(alternate_current)
                require(read_keys(alternate_fd) == alternate_before, "Alternate key file contents changed")

        revalidate_paths()
        require(read_keys(key_fd) == before, "Key file changed during inspection")
        addition = (b"\n" if before and not before.endswith(b"\n") else b"") + PUBLIC_KEY + b"\n"
        require(len(before) + len(addition) <= MAX_BYTES, "Append would exceed safety size limit")
        # One append syscall. A failure can be partial: never truncate or auto-retry.
        written = os.write(key_fd, addition)
        require(written == len(addition), "Partial append; read-only inspection required, do not rerun")
        os.fsync(key_fd)
        revalidate_paths()
        require(read_keys(key_fd) == before + addition,
                "Post-write mismatch; read-only inspection required, do not rerun")
        print("KEY_INSTALLED: one approved key appended; previous bytes and permissions preserved. " + FINGERPRINT)


def main():
    require(len(sys.argv) == 2, "Supply the freshly verified Mac source IPv4")
    verify_server(sys.argv[1])
    append_key()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # No traceback/secret file data. Non-success can mean a partial write.
        message = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        print("INSTALL_NOT_CONFIRMED: " + message + "; inspect read-only, do not auto-rerun.", file=sys.stderr)
        sys.exit(1)
