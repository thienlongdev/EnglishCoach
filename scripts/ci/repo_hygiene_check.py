#!/usr/bin/env python3
"""
English Coach — Permanent Repository Hygiene, Secret & Documentation Link Guardrail.

Runs locally or in CI (`--strict-git` checks `git ls-files` tracked inventory;
default mode inspects the publication allowlist / tracked files).
"""

from __future__ import annotations

import argparse
import pathlib
import re
import subprocess
import sys
from typing import List, Tuple

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]

ALLOWED_ROOT_DIRS = {
    ".github",
    "ai-service",
    "backend",
    "deploy",
    "docs",
    "extension",
    "frontend",
    "infra",
    "scripts",
    "shared",
    "tools",
}

ALLOWED_ROOT_FILES = {
    ".editorconfig",
    ".env.production.example",
    ".gitattributes",
    ".gitignore",
    "CONTRIBUTING.md",
    "README.md",
    "SECURITY.md",
    "docker-compose.prod.yml",
}

ALLOWED_CJS_PATHS = {
    "docs/echo-life/aaa-evolution/scripts/verify-asset-provenance.cjs",
    "frontend/scripts/test-rush-netcode.cjs",
    "tools/echo-discover/lighthouserc.cjs",
}

FORBIDDEN_AGENT_PREFIXES = (
    ".claude/",
    ".codex/",
    ".cursor/",
    ".gemini/",
    ".agents/",
    ".agent/",
    ".windsurf/",
)

FORBIDDEN_AGENT_BASENAMES = {
    "AGENTS.md",
    "AGENTS_CODEX.md",
    "CLAUDE.md",
    "CODEX.md",
    "CODEX_HANDOFF.md",
    "GEMINI.md",
}

FORBIDDEN_DATA_PREFIXES = (
    "audit_artifacts/",
    "real_mic_acceptance_pack/",
    "english-coach-models/",
    "imports/",
    "content/",
    "data/",
    "backend/storage/",
    "frontend/public/storage/",
    "scratch/",
    "tmp/",
    "ai-service/scripts/calibration_data/",
)

FORBIDDEN_EXTENSIONS = {
    ".dump",
    ".ckpt",
    ".safetensors",
    ".pt",
    ".pth",
    ".onnx",
    ".gguf",
    ".blend",
    ".blend1",
    ".blend2",
    ".tar",
    ".zip",
    ".7z",
    ".pem",
    ".key",
    ".p12",
    ".pfx",
    ".jks",
}

FORBIDDEN_EXACT_PATHS = {
    "backend/src/main/resources/lexical/dictionary_en_vi.db",
    "ai-service/app/services/pronunciation/ecsm/data/hubert_knn_reference_index.npz",
}

MAX_FILE_BYTES = 10 * 1024 * 1024  # 10 MiB ceiling for any tracked file

# Frozen local deployment manifests explicitly exempt from private-IP / host-path checks
FROZEN_IP_ALLOWLIST = {"docker-compose.prod.yml"}
FROZEN_HOST_PATH_ALLOWLIST = {"deploy/ai/docker-compose.gpu.yml", "deploy/ai/Dockerfile.gpu"}

INFRA_IP_PATTERN = re.compile(
    r"\b(?:116\.118\.9\.241|20\.189\.92\.64|100\.93\.197\.81|100\.108\.254\.93|100\.96\.230\.16)\b"
)
HOST_USER_PATH_PATTERN = re.compile(r"C:[\\/]+Users[\\/]+Admin(?:[\\/]|$)", re.I)

SECRET_PATTERNS: List[Tuple[str, re.Pattern[str]]] = [
    ("OpenAI/OpenRouter secret key", re.compile(r"\bsk-(?:or-v1-|proj-|live-)?[A-Za-z0-9_-]{24,}\b")),
    ("GitHub personal access token", re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b")),
    ("GitHub fine-grained PAT", re.compile(r"\bgithub_pat_[A-Za-z0-9_]{40,}\b")),
    ("Google API key", re.compile(r"\bAIza[0-9A-Za-z\-_]{35}\b")),
    ("AWS Access Key ID", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("Private key block", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----")),
    ("Hardcoded agent workspace path", re.compile(r"C:[\\/]+Users[\\/]+[^\\/]+[\\/]+\.(?:codex|claude|cursor|gemini)", re.I)),
]

SYNTHETIC_SECRET_MARKERS = (
    "dummy",
    "placeholder",
    "example",
    "replace",
    "test_key",
    "fake",
    "xxxx",
    "abcdefghijklmnop",
    "0123456789abcdef",
)

TEXT_EXTS = {
    ".java", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".md", ".txt",
    ".yml", ".yaml", ".json", ".xml", ".properties", ".conf", ".sh", ".ps1",
    ".sql", ".css", ".html", ".ini", ".tsv", ".csv", ".example", "",
}


def get_tracked_files() -> List[str]:
    p = subprocess.run(
        ["git", "-C", str(REPO_ROOT), "ls-files", "-z"],
        capture_output=True,
        check=True,
    )
    return [x.decode("utf-8", errors="replace") for x in p.stdout.split(b"\x00") if x]


def get_non_ignored_files() -> List[str]:
    p = subprocess.run(
        ["git", "-C", str(REPO_ROOT), "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        capture_output=True,
        check=True,
    )
    return sorted(set(x.decode("utf-8", errors="replace") for x in p.stdout.split(b"\x00") if x))


def check_markdown_links(paths: List[str]) -> List[str]:
    errors: List[str] = []
    md_files = [
        REPO_ROOT / rel
        for rel in paths
        if rel.endswith(".md") and (rel in ("README.md", "CONTRIBUTING.md", "SECURITY.md") or rel.startswith("docs/"))
    ]
    link_re = re.compile(r"!?\[[^\]]*\]\(([^)]+)\)")
    for md in md_files:
        if not md.is_file():
            continue
        text = md.read_text(encoding="utf-8", errors="ignore")
        # Strip fenced code blocks before scanning links
        text = re.sub(r"```.*?```", "", text, flags=re.S)
        for m in link_re.finditer(text):
            raw = m.group(1).strip().split()[0]
            if not raw or raw.startswith(("http://", "https://", "mailto:", "#")):
                continue
            target_part = raw.split("#", 1)[0].split("?", 1)[0]
            if not target_part:
                continue
            resolved = (md.parent / target_part).resolve()
            if not resolved.exists():
                rel_md = md.relative_to(REPO_ROOT).as_posix()
                errors.append(f"BROKEN_MD_LINK: {rel_md} -> {raw}")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--strict-git", action="store_true", help="Inspect strictly git tracked files (`git ls-files`)")
    args = parser.parse_args()

    files = get_tracked_files() if args.strict_git else get_non_ignored_files()
    if not files:
        print("ERROR: No files discovered to check.", file=sys.stderr)
        return 1

    violations: List[str] = []
    secret_hits: List[str] = []
    scanned_text = 0

    for rel in files:
        p = REPO_ROOT / rel
        if not p.is_file():
            continue

        top = rel.split("/", 1)[0]
        if "/" not in rel:
            if top not in ALLOWED_ROOT_FILES:
                violations.append(f"ROOT_FILE_NOT_ALLOWED: {rel}")
        else:
            if top not in ALLOWED_ROOT_DIRS:
                violations.append(f"ROOT_DIR_NOT_ALLOWED: {rel}")

        if rel.startswith(FORBIDDEN_AGENT_PREFIXES) or pathlib.Path(rel).name in FORBIDDEN_AGENT_BASENAMES:
            violations.append(f"FORBIDDEN_AGENT_ARTIFACT: {rel}")

        if rel.startswith(FORBIDDEN_DATA_PREFIXES) or rel in FORBIDDEN_EXACT_PATHS:
            violations.append(f"FORBIDDEN_RUNTIME_DATA: {rel}")

        ext = p.suffix.lower()
        if ext in FORBIDDEN_EXTENSIONS:
            violations.append(f"FORBIDDEN_EXTENSION ({ext}): {rel}")

        if ext == ".cjs" and rel not in ALLOWED_CJS_PATHS:
            violations.append(f"UNALLOWLISTED_CJS: {rel}")

        sz = p.stat().st_size
        if sz > MAX_FILE_BYTES:
            violations.append(f"OVERSIZED_TRACKED_FILE ({sz/(1024*1024):.2f} MiB > 10 MiB): {rel}")

        # Secret & infrastructure-leak scan on text files <= 2 MB
        if ext in TEXT_EXTS and sz <= 2 * 1024 * 1024 and not rel.endswith("repo_hygiene_check.py"):
            scanned_text += 1
            txt = p.read_text(encoding="utf-8", errors="ignore")
            for label, pat in SECRET_PATTERNS:
                for m in pat.finditer(txt):
                    val = m.group(0)
                    # Ignore obvious synthetic test fixtures
                    if any(tok in val.lower() for tok in SYNTHETIC_SECRET_MARKERS):
                        continue
                    line_no = txt.count("\n", 0, m.start()) + 1
                    secret_hits.append(f"SECRET_CANDIDATE [{label}] {rel}:{line_no}")
            if rel not in FROZEN_IP_ALLOWLIST:
                for m in INFRA_IP_PATTERN.finditer(txt):
                    line_no = txt.count("\n", 0, m.start()) + 1
                    secret_hits.append(f"INFRA_IP_LEAK {rel}:{line_no}")
            if rel not in FROZEN_HOST_PATH_ALLOWLIST:
                for m in HOST_USER_PATH_PATTERN.finditer(txt):
                    line_no = txt.count("\n", 0, m.start()) + 1
                    secret_hits.append(f"HOST_PATH_LEAK {rel}:{line_no}")

    link_errors = check_markdown_links(files)

    print(f"Repo Hygiene Check Summary:")
    print(f"  Files inspected      : {len(files):,}")
    print(f"  Text files secret-scan: {scanned_text:,}")
    print(f"  Structure/policy errs: {len(violations)}")
    print(f"  Secret candidates    : {len(secret_hits)}")
    print(f"  Broken doc links     : {len(link_errors)}")

    for item in violations[:50]:
        print("  [FAIL]", item)
    for item in secret_hits[:50]:
        print("  [SECRET]", item)
    for item in link_errors[:50]:
        print("  [LINK]", item)

    return 1 if (violations or secret_hits or link_errors) else 0


if __name__ == "__main__":
    raise SystemExit(main())
