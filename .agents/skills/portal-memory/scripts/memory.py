#!/usr/bin/env python3
"""Local Markdown memory, with provenance and optimistic concurrent updates.

Python standard library, macOS/Linux. No network, model calls, or Git mutations.
JSON frontmatter is a valid YAML subset and is parsed without a dependency.
"""

import argparse
from contextlib import contextmanager
from datetime import date, timedelta
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import uuid

DOMAINS = ("portal", "vertical-engine", "instantly-dataset")
KINDS = ("decision", "observation", "hypothesis", "session", "review")
STATUSES = ("candidate", "verified", "disputed", "superseded")
FOLDERS = ("notes", "sessions", "reviews")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def unpack(data):
    text = data.decode("utf-8")
    if not text.startswith("---\n") or "\n---\n" not in text[4:]:
        raise ValueError("Expected JSON frontmatter between --- lines")
    header, body = text[4:].split("\n---\n", 1)
    meta = json.loads(header)
    if not isinstance(meta, dict):
        raise ValueError("Metadata must be an object")
    for field in ("id", "title", "scope", "actor"):
        if not isinstance(meta.get(field), str) or not meta[field].strip():
            raise ValueError(f"Missing {field}")
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,100}", meta["id"]):
        raise ValueError("Invalid id")
    for field, choices in (("domain", DOMAINS), ("kind", KINDS), ("status", STATUSES)):
        if meta.get(field) not in choices:
            raise ValueError(f"Invalid {field}")
    sources = meta.get("sources")
    if not isinstance(sources, list) or not sources or any(
        not isinstance(s, str) or not s.strip() for s in sources
    ):
        raise ValueError("At least one source is required")
    recorded, checked, review = [date.fromisoformat(meta[k]) for k in
                                 ("recorded_at", "checked_at", "review_after")]
    if recorded > checked or checked > date.today() or review < checked:
        raise ValueError("Invalid chronology: recorded <= checked <= today, review >= checked")
    if not body.strip():
        raise ValueError("Body is empty")
    return meta, body


def pack(meta, body):
    return ("---\n" + json.dumps(meta, ensure_ascii=False, indent=2) +
            "\n---\n\n" + body.strip() + "\n").encode("utf-8")


def record_path(meta):
    folder = {"session": "sessions", "review": "reviews"}.get(meta["kind"], "notes")
    return f"{folder}/{meta['domain']}/{meta['id']}.md"


class Memory:
    def __init__(self, root):
        self.root = Path(root).resolve(strict=True)
        if not self.root.is_dir():
            raise ValueError("Memory root must be a directory")

    def path(self, relative):
        parts = Path(relative).parts
        if (len(parts) != 3 or parts[0] not in FOLDERS or parts[1] not in DOMAINS
                or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,100}\.md", parts[2])):
            raise ValueError("Expected <notes|sessions|reviews>/<domain>/<id>.md")
        path = self.root
        for part in parts:
            path = path / part
            if path.is_symlink():
                raise ValueError("Symlinks inside the store are not allowed")
        return path

    @contextmanager
    def lock(self):
        # Lock covers read, hash comparison and replace, not just the write.
        flags = os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW
        fd = os.open(self.root / ".write.lock", flags, 0o600)
        with os.fdopen(fd, "a") as stream:
            fcntl.flock(stream, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(stream, fcntl.LOCK_UN)

    def read(self, relative):
        data = self.path(relative).read_bytes()
        meta, _ = unpack(data)
        if record_path(meta) != relative:
            raise ValueError("Path does not match metadata")
        return data

    def write(self, relative, data, expected=None):
        meta, _ = unpack(data)
        if record_path(meta) != relative:
            raise ValueError("Path does not match metadata")
        with self.lock():
            path = self.path(relative)
            current = path.read_bytes() if path.exists() else None
            if expected is None:
                if current is not None:
                    raise ValueError("Record already exists; read it before updating")
            else:
                if current is None or digest(current) != expected:
                    raise ValueError("Conflict: reread the record and merge your changes")
                old, _ = unpack(current)
                if old["kind"] in ("session", "review"):
                    raise ValueError("Sessions and reviews are append-only; create a correction")
                for key in ("id", "domain", "kind", "recorded_at"):
                    if meta[key] != old[key]:
                        raise ValueError(f"Cannot change {key}; create a new record")
            path.parent.mkdir(parents=True, exist_ok=True)
            fd, temporary = tempfile.mkstemp(prefix=".memory-", suffix=".tmp", dir=path.parent)
            try:
                with os.fdopen(fd, "wb") as stream:
                    stream.write(data)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary, path)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
        return {"path": relative, "sha256": digest(data)}

    def records(self):
        for folder in FOLDERS:
            for path in sorted((self.root / folder).glob("*/*.md")):
                relative = path.relative_to(self.root).as_posix()
                meta, _ = unpack(self.read(relative))
                yield relative, meta


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path,
                        default=Path(__file__).resolve().parents[4] / "memory")
    commands = parser.add_subparsers(dest="command", required=True)
    listing = commands.add_parser("list")
    listing.add_argument("--domain", choices=DOMAINS)
    listing.add_argument("--kind", choices=KINDS)
    listing.add_argument("--status", choices=STATUSES)
    listing.add_argument("--since", type=date.fromisoformat, help="Recorded on/after YYYY-MM-DD")
    listing.add_argument("--limit", type=int, default=30, help="Maximum rows (default: 30)")
    commands.add_parser("check")
    reading = commands.add_parser("read")
    reading.add_argument("path")
    capture = commands.add_parser("capture")
    capture.add_argument("--domain", choices=DOMAINS, required=True)
    capture.add_argument("--kind", choices=KINDS, default="observation")
    capture.add_argument("--status", choices=STATUSES, default="candidate")
    capture.add_argument("--title", required=True)
    capture.add_argument("--scope", required=True)
    capture.add_argument("--source", action="append", required=True)
    capture.add_argument("--actor", default="codex")
    capture.add_argument("--id", default=None)
    capture.add_argument("--review-after", default=(date.today() + timedelta(days=30)).isoformat())
    capture.add_argument("--input", type=Path, required=True, help="Markdown body")
    update = commands.add_parser("update")
    update.add_argument("path")
    update.add_argument("--expected-sha", required=True)
    update.add_argument("--input", type=Path, required=True, help="Full document including metadata")
    args = parser.parse_args(argv)
    try:
        memory = Memory(args.root)
        if args.command in ("list", "check"):
            rows = list(memory.records())
            if args.command == "check":
                print(f"OK: {len(rows)} records; structure and metadata valid (evidence not evaluated)")
            else:
                if args.limit < 1:
                    raise ValueError("Limit must be positive")
                matching = []
                for relative, meta in sorted(rows, key=lambda row: (row[1]["recorded_at"], row[0]), reverse=True):
                    if any(getattr(args, key) and getattr(args, key) != meta[key]
                           for key in ("domain", "kind", "status")):
                        continue
                    if args.since and date.fromisoformat(meta["recorded_at"]) < args.since:
                        continue
                    matching.append((relative, meta))
                for relative, meta in matching[:args.limit]:
                    stale = "RECHECK" if date.fromisoformat(meta["review_after"]) <= date.today() else "current"
                    print(f"{meta['status']}\t{stale}\t{meta['kind']}\t{relative}\t{meta['title']}")
                if len(matching) > args.limit:
                    print(f"Showing {args.limit}/{len(matching)}; narrow filters or raise --limit", file=sys.stderr)
        elif args.command == "read":
            data = memory.read(args.path)
            print(f"SHA256 {digest(data)}\n{data.decode('utf-8')}", end="")
        elif args.command == "capture":
            today = date.today().isoformat()
            meta = dict(id=args.id or f"{today}-{uuid.uuid4().hex[:12]}",
                        title=args.title, domain=args.domain, kind=args.kind, status=args.status,
                        scope=args.scope, actor=args.actor, sources=args.source,
                        recorded_at=today, checked_at=today, review_after=args.review_after)
            result = memory.write(record_path(meta), pack(meta, args.input.read_text(encoding="utf-8")))
            print(json.dumps(result, ensure_ascii=False))
        elif args.command == "update":
            result = memory.write(args.path, args.input.read_bytes(), args.expected_sha)
            print(json.dumps(result, ensure_ascii=False))
        return 0
    except (ValueError, OSError, KeyError, TypeError) as error:
        print(f"Memory error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
