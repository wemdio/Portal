#!/usr/bin/env python3
"""Check the repo-local Software Factory files without changing the environment."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil


def check(root):
    errors = []
    manifest_path = root / "docs/software-factory-upstream.json"
    try:
        manifest = json.loads(manifest_path.read_text())
        skills = manifest["skills"]
        unchanged = manifest["unchanged_files"]
        if not isinstance(skills, list) or not skills or any(
            not isinstance(name, str) or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name)
            for name in skills
        ):
            raise ValueError("invalid skill names")
        if len(set(skills)) != len(skills) or not isinstance(unchanged, dict):
            raise ValueError("duplicate skills or invalid unchanged_files")
        if not re.fullmatch(r"[a-f0-9]{40}", manifest["revision"]):
            raise ValueError("invalid upstream revision")
    except (OSError, ValueError, KeyError, TypeError) as exc:
        return {"ok": False, "errors": [f"Cannot read manifest: {exc}"]}

    for name in skills:
        skill = root / ".agents/skills" / name / "SKILL.md"
        try:
            content = skill.read_text()
            frontmatter = re.match(r"\A---\n(.*?)\n---\n", content, re.S)
            if not frontmatter or not re.search(
                rf"^name: {re.escape(name)}$", frontmatter[1], re.M
            ) or not re.search(r"^description: \S", frontmatter[1], re.M):
                errors.append(f"Invalid name/description frontmatter: {skill.relative_to(root)}")
        except OSError as exc:
            errors.append(f"Cannot read {skill.relative_to(root)}: {exc}")

        link = root / ".claude/skills" / name
        try:
            if not link.is_symlink() or link.resolve(strict=True) != skill.parent.resolve(strict=True):
                errors.append(f"Invalid Claude link: {link.relative_to(root)}")
        except (OSError, RuntimeError):
            errors.append(f"Broken Claude link: {link.relative_to(root)}")

    for relative, expected in unchanged.items():
        try:
            path = root / relative
            path.resolve(strict=True).relative_to((root / ".agents/skills").resolve())
            if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
                errors.append(f"Changed upstream asset: {relative}")
        except (OSError, ValueError, TypeError, RuntimeError):
            errors.append(f"Missing or invalid upstream asset: {relative}")

    optional = {name: bool(shutil.which(name)) for name in ("gh", "ffmpeg", "ffprobe")}
    return {
        "ok": not errors,
        "skills": skills,
        "upstream_revision": manifest["revision"],
        "errors": errors,
        "optional_tools_on_path": optional,
        "notes": [
            "Optional tool presence does not verify authentication, Greptile installation or screen permission.",
            "Use evidence.py doctor --json to check recording capabilities; screenshots and logs work without video.",
        ],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="Print machine-readable results")
    args = parser.parse_args()
    result = check(Path(__file__).resolve().parents[1])
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print("Software Factory: " + ("OK" if result["ok"] else "FAILED"))
        if "skills" in result:
            print(f"Skills: {len(result['skills'])}; Claude links and upstream assets checked")
        for error in result["errors"]:
            print(f"ERROR: {error}")
        for name, available in result.get("optional_tools_on_path", {}).items():
            print(f"Optional {name}: {'found' if available else 'not installed'}")
        for note in result.get("notes", []):
            print(note)
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
