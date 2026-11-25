"""Phase 1 raw-corpus manifest loader + read-only file access with hash verification.

Discovery and provenance come from imports/exams/manifests/raw-source/ (built by
scripts/build_exam_source_manifest.py). The corpus root imports/source-files/** is only ever opened for reading.
"""
from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

REPO_ROOT = Path(__file__).resolve().parents[2]
RAW_ROOT = REPO_ROOT / "imports" / "source-files"
RAW_PREFIX = "imports/source-files/"
MANIFEST_DIR = REPO_ROOT / "imports" / "exams" / "manifests" / "raw-source"
MANIFEST_FILE = MANIFEST_DIR / "raw_source_manifest.json"
FILES_FILE = MANIFEST_DIR / "raw_source_files.json"
MANIFEST_REF = "imports/exams/manifests/raw-source/raw_source_manifest.json"


def raw_rel(corpus_path: str) -> str:
    """Corpus-relative path ('ielts/...') -> repository-relative ('imports/source-files/ielts/...')."""
    p = corpus_path.replace("\\", "/")
    return p if p.startswith(RAW_PREFIX) else RAW_PREFIX + p


def raw_abs(corpus_path: str) -> Path:
    p = corpus_path.replace("\\", "/")
    if p.startswith(RAW_PREFIX):
        p = p[len(RAW_PREFIX):]
    full = (RAW_ROOT / p).resolve()
    if RAW_ROOT.resolve() not in full.parents and full != RAW_ROOT.resolve():
        raise ValueError("path escapes the raw corpus root")
    return full


@dataclass
class TestRecord:
    family: str
    collection: str
    book: str
    book_title: str
    test_id: str
    test_number: int
    raw: dict           # the Phase 1 test record
    book_raw: dict      # the Phase 1 book record

    @property
    def readiness(self) -> str:
        return self.raw.get("extraction_readiness")


class RawCorpusManifest:
    def __init__(self, manifest_path: Path = MANIFEST_FILE, files_path: Path = FILES_FILE):
        with open(manifest_path, encoding="utf-8") as fh:
            self.manifest = json.load(fh)
        with open(files_path, encoding="utf-8") as fh:
            files = json.load(fh)
        self.files = {r["path"]: r for r in files["files"]}
        self.tests: list[TestRecord] = []
        self.books: dict = {}
        for fam in self.manifest["families"]:
            for col in fam["collections"]:
                for book in col["books"]:
                    self.books[book["book"]] = (fam["family"], col["collection"], book)
                    for t in book["tests"]:
                        self.tests.append(TestRecord(fam["family"], col["collection"], book["book"],
                                                     book.get("title") or book["book"], t["test_id"],
                                                     int(t["test_number"]), t, book))

    def test(self, test_id: str) -> Optional[TestRecord]:
        for t in self.tests:
            if t.test_id == test_id:
                return t
        return None

    def select(self, family: Optional[str] = None, readiness: Optional[str] = None,
               book: Optional[str] = None) -> list:
        out = []
        for t in self.tests:
            if family and t.family != family:
                continue
            if readiness and t.readiness != readiness:
                continue
            if book and t.book != book:
                continue
            out.append(t)
        return out

    def file_record(self, corpus_path: str) -> Optional[dict]:
        return self.files.get(corpus_path.replace("\\", "/"))


class HashCache:
    """SHA-256 of raw files, re-verified only when size or mtime changed (never trusts a stale value)."""

    def __init__(self, path: Path):
        self.path = path
        self.data = {}
        if path.exists():
            try:
                self.data = json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                self.data = {}
        self.dirty = False

    def sha256(self, full: Path) -> str:
        st = full.stat()
        key = str(full)
        rec = self.data.get(key)
        if rec and rec.get("size") == st.st_size and rec.get("mtime_ns") == st.st_mtime_ns:
            return rec["sha256"]
        h = hashlib.sha256()
        with open(full, "rb") as fh:  # read-only
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
        digest = h.hexdigest()
        self.data[key] = {"size": st.st_size, "mtime_ns": st.st_mtime_ns, "sha256": digest}
        self.dirty = True
        return digest

    def save(self) -> None:
        if self.dirty:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self.data, indent=0, sort_keys=True), encoding="utf-8")
            os.replace(tmp, self.path)
            self.dirty = False


def companion_matches(test: TestRecord, companion: dict) -> tuple:
    """Phase 3.6D cross-source binding guard: a companion source (recording analysis, script, key book) may be
    bound to a test only when its identity is that test's — same book, same test number, and (when it names a
    file) a file the Phase 1 manifest maps to THIS test. Equal question ranges alone never bind two sources.
    -> (ok, reason)."""
    if companion.get("book") != test.book:
        return False, f"book {companion.get('book')} != {test.book}"
    try:
        n = int(companion.get("testNumber"))
    except (TypeError, ValueError):
        return False, "companion carries no test number"
    if n != test.test_number:
        return False, f"test {n} != {test.test_number}"
    path = companion.get("path")
    if path:
        own = {raw_rel(a["source"]) + (f"::{a['archive_member']}" if a.get("archive_member") else "")
               for a in test.raw.get("audio", [])}
        own |= {raw_rel(d["path"]) for d in test.book_raw.get("source_documents", [])}
        if path not in own:
            return False, "file is not mapped to this test by the Phase 1 manifest"
    return True, ""
