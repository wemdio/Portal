#!/usr/bin/env python3
"""Storage contract tests; uses temporary directories, no Portal data."""

from datetime import date, timedelta
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from memory import Memory, digest, pack, unpack

SCRIPT = Path(__file__).with_name("memory.py")


class MemoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.store = Memory(self.root)
        today = date.today().isoformat()
        self.meta = dict(id="test-note", title="A lesson", domain="vertical-engine",
                         kind="observation", status="candidate", scope="isolated test",
                         actor="test", sources=["test fixture"], recorded_at=today,
                         checked_at=today, review_after=today)
        self.path = "notes/vertical-engine/test-note.md"
        self.data = pack(self.meta, "Observed result")

    def test_capture_and_read_from_unrelated_cwd(self):
        body = self.root / "body.md"
        body.write_text("Проверенный результат", encoding="utf-8")
        result = subprocess.run([sys.executable, str(SCRIPT), "--root", str(self.root),
                                 "capture", "--domain", "instantly-dataset", "--title", "Метрика",
                                 "--scope", "fixture", "--source", "fixture", "--input", str(body)],
                                cwd="/", capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        created = json.loads(result.stdout)
        meta, text = unpack(self.store.read(created["path"]))
        self.assertEqual(meta["status"], "candidate")
        self.assertIn("Проверенный результат", text)
        self.assertEqual(created["sha256"], digest(self.store.read(created["path"])))

    def test_existing_record_cannot_be_blindly_overwritten(self):
        self.store.write(self.path, self.data)
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.store.write(self.path, pack(self.meta, "lost update"))
        self.assertEqual(self.store.read(self.path), self.data)

    def test_default_store_follows_real_script_location(self):
        source = self.root / "repo/.agents/skills/portal-memory/scripts/memory.py"
        source.parent.mkdir(parents=True)
        shutil.copyfile(SCRIPT, source)
        target_store = self.root / "repo/memory"
        target_store.mkdir()
        other = self.root / "other-checkout"
        other.mkdir()
        link = self.root / "personal-skill.py"
        link.symlink_to(source)
        body = self.root / "body.md"
        body.write_text("shared result", encoding="utf-8")
        result = subprocess.run([sys.executable, str(link), "capture", "--domain", "portal",
                                 "--title", "Shared", "--scope", "test", "--source", "fixture",
                                 "--input", str(body)], cwd=other, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((target_store / json.loads(result.stdout)["path"]).exists())
        self.assertFalse((other / "memory").exists())

    def test_two_processes_same_revision_have_exactly_one_winner(self):
        self.store.write(self.path, self.data)
        processes = []
        for i in range(2):
            edited = self.root / f"edit-{i}.md"
            edited.write_bytes(pack(self.meta, f"writer {i}"))
            processes.append(subprocess.Popen(
                [sys.executable, str(SCRIPT), "--root", str(self.root), "update", self.path,
                 "--expected-sha", digest(self.data), "--input", str(edited)],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True))
        outputs = [p.communicate(timeout=10) for p in processes]
        self.assertEqual(sorted(p.returncode for p in processes), [0, 2], outputs)
        self.assertTrue(any("Conflict" in err for _, err in outputs))
        _, body = unpack(self.store.read(self.path))
        self.assertIn(body.strip(), ("writer 0", "writer 1"))

    def test_traversal_and_symlink_escape_are_rejected(self):
        for path in ("../escape.md", "/tmp/escape.md", "notes/../escape.md"):
            with self.assertRaises(ValueError):
                self.store.path(path)
        outside = self.root / "outside"
        outside.mkdir()
        (self.root / "notes").symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "Symlinks"):
            self.store.write(self.path, self.data)
        self.assertEqual(list(outside.iterdir()), [])

    def test_sessions_and_reviews_are_append_only(self):
        for kind, folder in (("session", "sessions"), ("review", "reviews")):
            meta = dict(self.meta, kind=kind)
            path = f"{folder}/vertical-engine/test-note.md"
            data = pack(meta, "original")
            self.store.write(path, data)
            with self.assertRaisesRegex(ValueError, "append-only"):
                self.store.write(path, pack(meta, "rewritten"), digest(data))

    def test_provenance_and_record_identity_are_required(self):
        for changes in (dict(sources=[]), dict(domain="unknown"), dict(status="approved"),
                        dict(checked_at=(date.today() + timedelta(days=1)).isoformat())):
            with self.assertRaises(ValueError):
                self.store.write(self.path, pack(dict(self.meta, **changes), "bad"))
        self.store.write(self.path, self.data)
        with self.assertRaisesRegex(ValueError, "Cannot change kind"):
            self.store.write(self.path, pack(dict(self.meta, kind="decision"), "changed"), digest(self.data))

    def test_check_detects_bad_metadata_without_mutating(self):
        path = self.root / self.path
        path.parent.mkdir(parents=True)
        path.write_text("not a record", encoding="utf-8")
        result = subprocess.run([sys.executable, str(SCRIPT), "--root", str(self.root), "check"],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(path.read_text(), "not a record")
        self.assertFalse((self.root / ".write.lock").exists())

    def test_list_marks_due_records_and_filters_domain(self):
        self.store.write(self.path, self.data)
        command = [sys.executable, str(SCRIPT), "--root", str(self.root), "list", "--domain"]
        result = subprocess.run(command + ["vertical-engine"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("RECHECK", result.stdout)
        result = subprocess.run(command + ["instantly-dataset"], capture_output=True, text=True)
        self.assertEqual(result.stdout, "")

    def test_list_limits_context_and_supports_review_period(self):
        self.store.write(self.path, self.data)
        second = dict(self.meta, id="test-second")
        self.store.write("notes/vertical-engine/test-second.md", pack(second, "second"))
        command = [sys.executable, str(SCRIPT), "--root", str(self.root), "list"]
        result = subprocess.run(command + ["--limit", "1"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(result.stdout.splitlines()), 1)
        self.assertIn("1/2", result.stderr)
        tomorrow = (date.today() + timedelta(days=1)).isoformat()
        result = subprocess.run(command + ["--since", tomorrow], capture_output=True, text=True)
        self.assertEqual(result.stdout, "")
        result = subprocess.run(command + ["--limit", "0"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)


if __name__ == "__main__":
    unittest.main()
