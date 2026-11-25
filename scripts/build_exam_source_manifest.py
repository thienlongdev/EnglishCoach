#!/usr/bin/env python3
"""
Exams Recovery Phase 1 - Raw Source Corpus Manifest builder (READ-ONLY).

Inventories the immutable raw exam corpus under imports/source-files/** and writes METADATA ONLY to
imports/exams/manifests/raw-source/:

  raw_source_files.json            one record per raw file (hash, kind, PDF/audio/zip metadata, path mapping)
  raw_source_manifest.json         Corpus > ExamFamily > Collection > Book > Test hierarchy with candidates,
                                   mapping confidence and extraction-readiness labels
  raw_source_duplicates.json       identity groups (exact, renamed, archive copies, name collisions)
  raw_vs_generated_loss_matrix.json  what the generated packages in imports/exams/real/** kept or lost
  raw_source_summary.json          the counts used by the Phase 1 report

Rules (owner, Exams Recovery Phase 1):
  * never writes, renames or extracts anything under imports/source-files (opened read-only);
  * stores no page text: only page numbers, counts, short outline headings (<= 80 chars) and hashes;
  * page ranges are "candidates" derived from markers actually found in the PDF text layer - a scanned PDF
    gets none (OCR is out of scope);
  * confidence: CONFIDENT (explicit test+section in the name) / PROBABLE (naming convention) /
    AMBIGUOUS (numbers whose meaning is unclear, or test known but section unknown) / UNMAPPED.

Re-run:  python scripts/build_exam_source_manifest.py
SHA-256 is reused from the previous raw_source_files.json when size and mtime are unchanged (--rehash forces).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import zipfile
import zlib
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

try:
    import pymupdf  # PyMuPDF >= 1.24
except ImportError:  # pragma: no cover
    import fitz as pymupdf  # type: ignore
try:
    import mutagen
except ImportError:  # pragma: no cover
    mutagen = None

SCHEMA_VERSION = "1.0"
GENERATOR = "scripts/build_exam_source_manifest.py (Exams Recovery Phase 1)"

REPO = Path(__file__).resolve().parent.parent
RAW = REPO / "imports" / "source-files"
OUT = REPO / "imports" / "exams" / "manifests" / "raw-source"
GENERATED = REPO / "imports" / "exams" / "real"
PRIOR_MANIFEST = REPO / "imports" / "exams" / "manifests" / "real_corpus_manifest.json"
EXTRACTED_IMAGE_DIRS = [REPO / "frontend" / "public" / "storage" / "exams" / "images",
                        REPO / "backend" / "storage" / "exams" / "images"]
IMAGE_PROVENANCE = [REPO / "imports" / "exams" / "provenance" / "toeic_part1_photos_provenance.json",
                    REPO / "imports" / "exams" / "manifests" / "extracted_visual_stimuli.json"]

AUDIO_EXT = {".mp3", ".m4a", ".wav", ".aac", ".ogg", ".flac", ".wma"}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff"}
SYSTEM_JUNK = {".gitkeep", ".ds_store", "desktop.ini", "thumbs.db"}

TEXT_PAGE_MIN_CHARS = 80
LABEL_PRIORITY = ["UNREADABLE_SOURCE", "NEEDS_REVIEW", "MISSING_COMPANION_MEDIA", "AMBIGUOUS_MAPPING",
                  "PARTIAL_SOURCE", "READY_FOR_EXTRACTION"]


# ─── helpers ───────────────────────────────────────────────────────────────────────────────

def ranges(pages):
    """[1,2,3,7,9,10] -> '1-3,7,9-10' (1-based page numbers)."""
    pages = sorted(set(pages))
    if not pages:
        return None
    out, start, prev = [], pages[0], pages[0]
    for p in pages[1:]:
        if p == prev + 1:
            prev = p
            continue
        out.append(f"{start}-{prev}" if start != prev else str(start))
        start = prev = p
    out.append(f"{start}-{prev}" if start != prev else str(start))
    return ",".join(out)


def file_kind(rel: str, name: str, ext: str) -> str:
    low = name.lower()
    if low in SYSTEM_JUNK or ext == ".ini":
        return "SYSTEM_JUNK"
    if "__MACOSX" in rel.split("/") or name.startswith("._"):
        return "APPLEDOUBLE_JUNK"
    if ext == ".pdf":
        return "PDF"
    if ext in AUDIO_EXT:
        return "AUDIO"
    if ext == ".zip":
        return "ARCHIVE"
    if ext in IMAGE_EXT:
        return "IMAGE"
    if ext in {".md", ".url", ".txt"}:
        return "NOTE"
    return "OTHER"


def hash_file(path: Path):
    sha = hashlib.sha256()
    crc = 0
    with open(path, "rb") as fh:
        while True:
            chunk = fh.read(4 * 1024 * 1024)
            if not chunk:
                break
            sha.update(chunk)
            crc = zlib.crc32(chunk, crc)
    return sha.hexdigest(), f"{crc & 0xFFFFFFFF:08x}"


def zip_member_name(info: zipfile.ZipInfo) -> str:
    if info.flag_bits & 0x800:
        return info.filename
    try:
        return info.filename.encode("cp437").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return info.filename


# ─── path → family / collection / book ────────────────────────────────────────────────────

def classify_path(rel: str):
    parts = rel.split("/")
    family = parts[0].upper() if parts and parts[0] in ("ielts", "toeic") else "UNKNOWN"
    collection = parts[1] if len(parts) > 2 else "(root)"
    low = rel.lower()
    book_key, book_title = None, None
    if collection == "cambridge":
        m = re.match(r"cambridge-ielts-(\d+)", parts[2].lower()) if len(parts) > 2 else None
        if m:
            n = int(m.group(1))
            book_key = f"cambridge-ielts-{n}"
            book_title = f"Cambridge IELTS {n}" + (" (reference copy)" if "tham-khao" in parts[2] else "")
    elif collection == "practice-tests-plus":
        m = re.search(r"plus\s*(\d)", low)
        if m:
            book_key, book_title = f"practice-tests-plus-{m.group(1)}", f"IELTS Practice Tests Plus {m.group(1)}"
    elif collection == "ielts-trainer":
        if "trainer 1" in low or "quyển 1" in low:
            book_key, book_title = "ielts-trainer-1", "IELTS Trainer 1"
        elif "quyển 2 academic" in low:
            book_key, book_title = "ielts-trainer-2-academic", "IELTS Trainer 2 Academic"
        elif "quyển 2 general" in low:
            book_key, book_title = "ielts-trainer-2-general", "IELTS Trainer 2 General Training"
    elif collection == "collins":
        book_key, book_title = "collins-practice-tests-1", "Collins Practice Tests for IELTS 1"
    elif collection == "barrons":
        book_key, book_title = "barrons-ielts-practice-exams", "Barron's IELTS Practice Exams"
    elif collection == "economy":
        m = re.search(r"vol(?:ume)?\s*\.?\s*(\d)", low)
        if m:
            book_key, book_title = f"economy-vol-{m.group(1)}", f"Economy TOEIC 1000 Vol {m.group(1)}"
    elif collection == "ets":
        m = re.search(r"ets (\d{4})", low)
        if m:
            book_key, book_title = f"ets-{m.group(1)}", f"ETS TOEIC {m.group(1)}"
    elif collection == "ybm":
        m = re.search(r"ybm vol (\d)", low)
        if m:
            book_key, book_title = f"ybm-vol-{m.group(1)}", f"YBM TOEIC LC/RC 1000 Vol {m.group(1)}"
    if book_key is None:
        book_key, book_title = f"{collection}-unassigned", f"{collection} (unassigned files)"
    return family, collection, book_key, book_title


def pdf_role(family: str, rel: str):
    name = rel.rsplit("/", 1)[-1].lower()
    role, scope, test = "QUESTION_BOOK", "MIXED", None
    if "transcript" in name:
        role = "TRANSCRIPT"
    elif re.search(r"practice\s+tests?\s+with\s+answers\b", name):
        # An integrated practice book includes questions as well as back matter.
        role = "QUESTION_BOOK"
    elif "answer" in name or re.search(r"\bkey\b", name):
        role = "ANSWER_KEY"
    m = re.search(r"\btest\s*0?(\d{1,2})\b", name) or re.search(r"test\s*0?(\d{1,2})\.pdf$", name)
    if m:
        test = int(m.group(1))
        if role == "QUESTION_BOOK":
            role = "PER_TEST_BOOK"
    if family == "TOEIC":
        if re.search(r"\blc\b|listening|lc\s*1000|lc1000", name):
            scope = "LISTENING"
        elif re.search(r"\brc\b|reading|rc\s*1000", name):
            scope = "READING"
        if "lc1000 volume 3" in rel.lower() and test:
            scope = "LISTENING"
    else:
        if "reading" in name and "ielts" in name and "cambridge 15" in name:
            scope = "READING"
    return role, scope, test


# ─── audio name parsing ───────────────────────────────────────────────────────────────────

IELTS_RULES = [
    (re.compile(r"test\s*0?(\d+)\D{0,3}(?:section|part|s)\s*0?([1-4])(?!\d)", re.I), "CONFIDENT", "TEST_SECTION"),
    (re.compile(r"^c\d+t(\d)s([1-4])$", re.I), "CONFIDENT", "CxxTnSn"),
    (re.compile(r"^t(\d)s([1-4])$", re.I), "CONFIDENT", "TnSn"),
    (re.compile(r"test(\d+)_audio([1-4])$", re.I), "PROBABLE", "TEST_AUDIO_N"),
    (re.compile(r"_t(\d)_audio([1-4])$", re.I), "PROBABLE", "T_AUDIO_N"),
    (re.compile(r"^(\d)\.([1-4])$"), "PROBABLE", "N.N"),
]


def parse_ielts_audio(stem: str, parent: str):
    for rx, conf, rule in IELTS_RULES:
        for candidate in (stem, f"{parent} {stem}"):
            m = rx.search(candidate)
            if m:
                return {"test": int(m.group(1)), "section": int(m.group(2)), "scope": "SECTION",
                        "confidence": conf, "rule": rule}
    m = re.search(r"section\s*(\d)\s*part\s*(\d)", stem, re.I)
    if m:
        return {"test": None, "section": None, "scope": "UNKNOWN", "confidence": "AMBIGUOUS",
                "rule": f"SECTION{m.group(1)}_PART{m.group(2)}_MEANING_UNCLEAR"}
    m = re.search(r"\btest\s*0?(\d+)\b", stem, re.I)
    if m:
        return {"test": int(m.group(1)), "section": None, "scope": "WHOLE_TEST_LISTENING",
                "confidence": "PROBABLE", "rule": "TEST_ONLY_IN_NAME"}
    m = re.search(r"\btest\s*0?(\d+)\b", parent, re.I)
    if m:
        return {"test": int(m.group(1)), "section": None, "scope": "UNKNOWN", "confidence": "AMBIGUOUS",
                "rule": "TEST_FROM_FOLDER_TRACK_ONLY"}
    return {"test": None, "section": None, "scope": "UNKNOWN", "confidence": "UNMAPPED", "rule": "TRACK_ONLY"}


def parse_toeic_audio(stem: str, parent: str):
    for candidate in (stem, f"{parent} {stem}"):
        m = re.search(r"(?:^|[_\s-])(?:actual\s+)?(?:at|test)\s*0?(\d+)\D*part\s*([1-7])\b", candidate, re.I)
        if m:
            return {"test": int(m.group(1)), "part": int(m.group(2)), "scope": "PART",
                    "confidence": "CONFIDENT", "rule": "TEST_PART"}
    m = re.search(r"(?:actual\s+)?test\s*0?(\d+)", stem, re.I)
    if m:
        return {"test": int(m.group(1)), "part": None, "scope": "WHOLE_LISTENING", "confidence": "PROBABLE",
                "rule": "TEST_ONLY_IN_NAME"}
    m = re.fullmatch(r"0?(\d{1,2})", stem.strip())
    if m:
        return {"test": int(m.group(1)), "part": None, "scope": "WHOLE_LISTENING", "confidence": "PROBABLE",
                "rule": "NUMERIC_NAME"}
    return {"test": None, "part": None, "scope": "UNKNOWN", "confidence": "UNMAPPED", "rule": "UNRECOGNISED"}


def parse_audio(family: str, name: str, parent: str, duration_s):
    stem = os.path.splitext(name)[0]
    p = parse_toeic_audio(stem, parent) if family == "TOEIC" else parse_ielts_audio(stem, parent)
    # Duration sanity check: a "whole listening" file must be long, a section/part file short.
    if duration_s is not None:
        mins = duration_s / 60.0
        p["duration_check"] = "OK"
        if p["scope"] in ("WHOLE_LISTENING", "WHOLE_TEST_LISTENING") and mins < 15:
            p["duration_check"] = "TOO_SHORT_FOR_WHOLE_TEST"
            p["confidence"] = "AMBIGUOUS"
        if p["scope"] in ("SECTION", "PART") and mins > 25:
            p["duration_check"] = "TOO_LONG_FOR_SECTION"
            p["confidence"] = "AMBIGUOUS"
    return p


def audio_metadata(path: Path):
    if mutagen is None:
        return {"error": "mutagen not installed"}
    try:
        f = mutagen.File(str(path))
        if f is None or f.info is None:
            return {"error": "unrecognised audio container"}
        info = f.info
        codec = getattr(info, "codec", None) or getattr(info, "codec_description", None)
        if codec is None and type(f).__name__.startswith("MP3"):
            codec = f"mpeg-layer{getattr(info, 'layer', 3)}"
        if codec is None and type(f).__name__.startswith("WAVE"):
            codec = "pcm"
        return {
            "container": type(f).__name__,
            "codec": codec,
            "duration_s": round(float(info.length), 1) if getattr(info, "length", None) else None,
            "bitrate": getattr(info, "bitrate", None),
            "sample_rate": getattr(info, "sample_rate", None),
            "channels": getattr(info, "channels", None),
        }
    except Exception as exc:  # metadata only; never fatal
        return {"error": f"{type(exc).__name__}: {exc}"[:200]}


# ─── PDF inspection (text layer + markers, no text stored) ─────────────────────────────────

MARKERS_COMMON = {
    "answer_key": re.compile(r"ANSWER\s*KEYS?|LISTENING AND READING ANSWER|정답"),
    "transcript": re.compile(r"AUDIO\s*SCRIPTS?|TAPE\s*SCRIPTS?|TRANSCRIPTS?|스크립트"),
    "questions": re.compile(r"QUESTIONS?\s+\d{1,3}"),
}
MARKERS_IELTS = {
    "listening": re.compile(r"\bLISTENING\b"),
    "reading_passage": re.compile(r"READING\s+PASSAGE\s+([1-3])"),
    "writing_task": re.compile(r"WRITING\s+TASK\s+([12])"),
    "speaking": re.compile(r"\bSPEAKING\b"),
    "listening_section": re.compile(r"\bSECTION\s+([1-4])\b"),
}
MARKERS_TOEIC = {
    "toeic_part": re.compile(r"\bPART\s+([1-7])\b"),
    "listening_test": re.compile(r"LISTENING\s+(?:TEST|COMPREHENSION)"),
    "reading_test": re.compile(r"READING\s+(?:TEST|COMPREHENSION)"),
    "directions": re.compile(r"\bDIRECTIONS\b"),
}
TEST_HEADER = re.compile(r"\b(?:ACTUAL\s+)?TEST\s*0?(\d{1,2})\b")


def inspect_pdf(path: Path, family: str):
    rec = {"ok": False}
    try:
        doc = pymupdf.open(str(path))
    except Exception as exc:
        rec["error"] = f"{type(exc).__name__}: {exc}"[:200]
        return rec
    try:
        rec["encrypted"] = bool(doc.needs_pass)
        if doc.needs_pass:
            rec["error"] = "ENCRYPTED"
            return rec
        n = doc.page_count
        rec["page_count"] = n
        text_pages, image_pages, scanned_pages, blank_pages = 0, 0, 0, 0
        markers = defaultdict(list)
        numbered = defaultdict(lambda: defaultdict(list))
        header_tests = defaultdict(list)
        markers_spec = dict(MARKERS_COMMON)
        markers_spec.update(MARKERS_TOEIC if family == "TOEIC" else MARKERS_IELTS)
        for idx in range(n):
            page = doc.load_page(idx)
            try:
                text = page.get_text("text") or ""
            except Exception:
                text = ""
            try:
                imgs = len(page.get_images(full=False))
            except Exception:
                imgs = 0
            dense = len(re.sub(r"\s", "", text))
            has_text = dense >= TEXT_PAGE_MIN_CHARS
            text_pages += has_text
            image_pages += imgs > 0
            scanned_pages += (not has_text) and imgs > 0
            blank_pages += (not has_text) and imgs == 0
            if not has_text:
                continue
            upper = text.upper()
            pno = idx + 1
            for key, rx in markers_spec.items():
                found = rx.findall(upper)
                if not found:
                    continue
                if rx.groups:
                    for g in set(found):
                        numbered[key][str(g)].append(pno)
                else:
                    markers[key].append(pno)
            zone = upper[:300] + " " + upper[-200:]
            for t in set(TEST_HEADER.findall(zone)):
                t = int(t)
                if 1 <= t <= 10:
                    header_tests[t].append(pno)
        ratio = text_pages / n if n else 0
        rec.update({
            "ok": True,
            "text_pages": text_pages,
            "image_pages": image_pages,
            "scanned_pages": scanned_pages,
            "blank_pages": blank_pages,
            "text_layer": "TEXT" if ratio >= 0.6 else ("SCANNED" if ratio <= 0.1 else "MIXED"),
            "ocr_required": ratio < 0.6,
            "markers": {k: ranges(v) for k, v in sorted(markers.items())},
            "numbered_markers": {k: {num: ranges(v) for num, v in sorted(d.items(), key=lambda x: int(x[0]))}
                                 for k, d in sorted(numbered.items())},
            "test_header_pages": {str(t): ranges(v) for t, v in sorted(header_tests.items()) if len(v) >= 2},
            "has_questions": bool(markers.get("questions")) if text_pages else None,
            "has_answer_key_marker": bool(markers.get("answer_key")) if text_pages else None,
            "has_transcript_marker": bool(markers.get("transcript")) if text_pages else None,
            "multiple_tests": len([t for t, v in header_tests.items() if len(v) >= 2]) >= 2,
        })
        try:
            toc = doc.get_toc(simple=True)
            rec["outline"] = [[lvl, (title or "")[:80], page] for lvl, title, page in toc[:150]]
        except Exception:
            rec["outline"] = []
        return rec
    finally:
        doc.close()


# ─── build ─────────────────────────────────────────────────────────────────────────────────

def load_json(path: Path, default):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return default


def inventory(rehash: bool):
    previous = {}
    if not rehash:
        for r in load_json(OUT / "raw_source_files.json", {}).get("files", []):
            previous[r["path"]] = r
    files = []
    for dirpath, _dirs, names in os.walk(RAW):
        for name in sorted(names):
            full = Path(dirpath) / name
            rel = full.relative_to(RAW).as_posix()
            ext = os.path.splitext(name)[1].lower()
            st = full.stat()
            kind = file_kind(rel, name, ext)
            family, collection, book_key, book_title = classify_path(rel)
            rec = {"path": rel, "name": name, "ext": ext, "kind": kind, "size": st.st_size,
                   "mtime_ns": st.st_mtime_ns, "family": family, "collection": collection,
                   "book": book_key, "book_title": book_title}
            prev = previous.get(rel)
            if prev and prev.get("size") == st.st_size and prev.get("mtime_ns") == st.st_mtime_ns and prev.get("sha256"):
                rec["sha256"], rec["crc32"] = prev["sha256"], prev.get("crc32")
                rec["hash_source"] = "CACHE(size+mtime)"
            else:
                rec["sha256"], rec["crc32"] = hash_file(full)
                rec["hash_source"] = "COMPUTED"
            if kind == "AUDIO":
                meta = audio_metadata(full)
                rec["audio"] = meta
                rec["mapping"] = parse_audio(family, name, Path(rel).parent.name, meta.get("duration_s"))
            elif kind == "PDF":
                role, scope, test = pdf_role(family, rel)
                rec["pdf"] = {"role": role, "scope": scope, "test_from_name": test}
                if prev and prev.get("sha256") == rec["sha256"] and prev.get("pdf", {}).get("inspection", {}).get("ok"):
                    rec["pdf"]["inspection"] = prev["pdf"]["inspection"]
                else:
                    rec["pdf"]["inspection"] = inspect_pdf(full, family)
            elif kind == "ARCHIVE":
                rec["archive"] = inspect_zip(full, family)
            files.append(rec)
            print(f"  {kind:16s} {rel[:110]}", file=sys.stderr)
    return files


def inspect_zip(path: Path, family: str):
    try:
        with zipfile.ZipFile(str(path)) as zf:
            members = []
            for info in zf.infolist():
                if info.is_dir():
                    continue
                name = zip_member_name(info)
                base = name.rsplit("/", 1)[-1]
                ext = os.path.splitext(base)[1].lower()
                kind = file_kind(name, base, ext)
                m = {"name": name, "kind": kind, "size": info.file_size, "crc32": f"{info.CRC & 0xFFFFFFFF:08x}"}
                if kind == "AUDIO":
                    parent = name.rsplit("/", 2)[-2] if "/" in name else ""
                    m["mapping"] = parse_audio(family, base, parent, None)
                members.append(m)
            return {"ok": True, "member_count": len(members), "members": members,
                    "integrity_checked": False}
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"[:200]}


def audio_entries(files):
    """Loose audio + audio inside archives, one entry per playable track."""
    out = []
    for f in files:
        if f["kind"] == "AUDIO":
            out.append({"source": f["path"], "archive_member": None, "book": f["book"], "family": f["family"],
                        "sha256": f["sha256"], "size": f["size"], "duration_s": f["audio"].get("duration_s"),
                        **{k: v for k, v in f["mapping"].items()}})
        elif f["kind"] == "ARCHIVE" and f["archive"].get("ok"):
            for m in f["archive"]["members"]:
                if m["kind"] == "AUDIO":
                    out.append({"source": f["path"], "archive_member": m["name"], "book": f["book"],
                                "family": f["family"], "sha256": None, "size": m["size"], "duration_s": None,
                                **{k: v for k, v in m["mapping"].items()}})
    return out


def build_hierarchy(files):
    tracks = audio_entries(files)
    books = defaultdict(lambda: {"pdfs": [], "tracks": [], "archives": [], "other": []})
    meta = {}
    for f in files:
        if f["kind"] in ("SYSTEM_JUNK", "APPLEDOUBLE_JUNK") or f["family"] == "UNKNOWN":
            continue
        key = (f["family"], f["collection"], f["book"])
        meta[key] = f["book_title"]
        if f["kind"] == "PDF":
            books[key]["pdfs"].append(f)
        elif f["kind"] == "ARCHIVE":
            books[key]["archives"].append(f)
        elif f["kind"] != "AUDIO":
            books[key]["other"].append(f["path"])
    for t in tracks:
        f = next(x for x in files if x["path"] == t["source"])
        books[(f["family"], f["collection"], f["book"])]["tracks"].append(t)
        meta.setdefault((f["family"], f["collection"], f["book"]), f["book_title"])

    corpus = {}
    for (family, collection, book_key), data in sorted(books.items()):
        fam = corpus.setdefault(family, {"family": family, "collections": {}})
        col = fam["collections"].setdefault(collection, {"collection": collection, "books": []})
        col["books"].append(build_book(family, collection, book_key, meta[(family, collection, book_key)], data))
    # collections that exist on disk but hold no usable file (e.g. official/, hackers/)
    for fam_dir in sorted(p for p in RAW.iterdir() if p.is_dir()):
        family = fam_dir.name.upper()
        for col_dir in sorted(p for p in fam_dir.iterdir() if p.is_dir()):
            fam = corpus.setdefault(family, {"family": family, "collections": {}})
            col = fam["collections"].setdefault(col_dir.name, {"collection": col_dir.name, "books": [],
                                                               "note": "EMPTY: no exam file (placeholder files only)"})
            for book_dir in sorted(p for p in col_dir.iterdir() if p.is_dir()):
                if not any(x.is_file() and x.name.lower() not in SYSTEM_JUNK for x in book_dir.rglob("*")):
                    col.setdefault("empty_book_folders", []).append(book_dir.name)
    return {"corpus": "imports/source-files",
            "families": [{"family": f["family"], "collections": list(f["collections"].values())}
                         for f in corpus.values()]}


def build_book(family, collection, book_key, title, data):
    pdfs = data["pdfs"]
    tracks = data["tracks"]
    readable = [p for p in pdfs if p["pdf"]["inspection"].get("ok")]
    text_pdfs = [p for p in readable if p["pdf"]["inspection"].get("text_layer") == "TEXT"]
    # tests observed
    tests = set()
    evidence = defaultdict(set)
    for t in tracks:
        if t.get("test"):
            tests.add(t["test"])
            evidence[t["test"]].add("AUDIO_NAME")
    for p in pdfs:
        if p["pdf"].get("test_from_name"):
            tests.add(p["pdf"]["test_from_name"])
            evidence[p["pdf"]["test_from_name"]].add("PDF_NAME")
        ins = p["pdf"]["inspection"]
        if ins.get("ok"):
            for t in (ins.get("test_header_pages") or {}):
                tests.add(int(t))
                evidence[int(t)].add("PDF_PAGE_HEADER")
    # book-level availability
    answer_files = [p["path"] for p in pdfs if p["pdf"]["role"] == "ANSWER_KEY"]
    transcript_files = [p["path"] for p in pdfs if p["pdf"]["role"] == "TRANSCRIPT"]
    ak_pages = {p["path"]: p["pdf"]["inspection"]["markers"].get("answer_key") for p in readable
                if (p["pdf"]["inspection"].get("markers") or {}).get("answer_key")}
    tr_pages = {p["path"]: p["pdf"]["inspection"]["markers"].get("transcript") for p in readable
                if (p["pdf"]["inspection"].get("markers") or {}).get("transcript")}

    def availability(files_, pages_):
        if files_:
            return "AVAILABLE_FILE"
        if pages_:
            return "CANDIDATE_PAGES"
        if pdfs and not text_pdfs:
            return "UNKNOWN_NEEDS_OCR"
        return "NOT_FOUND"

    answer_key = {"status": availability(answer_files, ak_pages), "files": answer_files, "page_candidates": ak_pages}
    transcript = {"status": availability(transcript_files, tr_pages), "files": transcript_files,
                  "page_candidates": tr_pages}
    scopes = {p["pdf"]["scope"] for p in pdfs}
    book = {
        "book": book_key, "title": title,
        "source_documents": [{
            "path": p["path"], "sha256": p["sha256"], "size": p["size"], "role": p["pdf"]["role"],
            "scope": p["pdf"]["scope"], "test_from_name": p["pdf"]["test_from_name"],
            "page_count": p["pdf"]["inspection"].get("page_count"),
            "text_layer": p["pdf"]["inspection"].get("text_layer"),
            "ocr_required": p["pdf"]["inspection"].get("ocr_required"),
            "embedded_image_pages": p["pdf"]["inspection"].get("image_pages"),
            "multiple_tests": p["pdf"]["inspection"].get("multiple_tests"),
            "readable": p["pdf"]["inspection"].get("ok"),
            "error": p["pdf"]["inspection"].get("error"),
        } for p in pdfs],
        "archives": [{"path": a["path"], "sha256": a["sha256"], "size": a["size"],
                      "ok": a["archive"].get("ok"), "members": a["archive"].get("member_count"),
                      "audio_members": sum(1 for m in a["archive"].get("members", []) if m["kind"] == "AUDIO")}
                     for a in data["archives"]],
        "audio_track_count": len(tracks),
        "answer_key": answer_key,
        "transcript": transcript,
        "pdf_scopes": sorted(scopes),
        "unassigned_audio": [{"source": t["source"], "archive_member": t["archive_member"], "confidence": t["confidence"],
                              "rule": t["rule"]} for t in tracks if not t.get("test")],
        "tests": [],
    }
    for n in sorted(tests):
        book["tests"].append(build_test(family, book_key, n, evidence[n], pdfs, tracks, answer_key, transcript, scopes))
    if not tests:
        book["note"] = "NO_TEST_IDENTIFIED: no test number in audio names, PDF names or PDF page headers"
        if pdfs and not text_pdfs:
            book["book_readiness"] = "NEEDS_REVIEW"
            book["book_readiness_reason"] = "question source is scanned (OCR required) and no audio names a test"
        elif tracks:
            book["book_readiness"] = "AMBIGUOUS_MAPPING"
            book["book_readiness_reason"] = "audio is track-numbered only; tests cannot be assigned without listening"
        else:
            book["book_readiness"] = "NEEDS_REVIEW"
            book["book_readiness_reason"] = "text layer present but no test headings detected"
    else:
        book["book_readiness"] = next((l for l in LABEL_PRIORITY
                                       if any(t["extraction_readiness"] == l for t in book["tests"])), None)
    return book


def build_test(family, book_key, n, evidence, pdfs, tracks, answer_key, transcript, scopes):
    docs = []
    for p in pdfs:
        ins = p["pdf"]["inspection"]
        page_cand = (ins.get("test_header_pages") or {}).get(str(n)) if ins.get("ok") else None
        if p["pdf"].get("test_from_name") == n or page_cand:
            docs.append({"path": p["path"], "role": p["pdf"]["role"], "scope": p["pdf"]["scope"],
                         "page_candidates": None if p["pdf"].get("test_from_name") == n else page_cand,
                         "page_source": "WHOLE_FILE(name)" if p["pdf"].get("test_from_name") == n else "PAGE_HEADER_MARKER",
                         "text_layer": ins.get("text_layer")})
    audio = [{"source": t["source"], "archive_member": t["archive_member"], "section": t.get("section"),
              "part": t.get("part"), "scope": t["scope"], "confidence": t["confidence"], "rule": t["rule"],
              "duration_s": t.get("duration_s"), "sha256": t.get("sha256")}
             for t in tracks if t.get("test") == n]
    flags = []
    reasons = []
    readable_docs = [p for p in pdfs if p["pdf"]["inspection"].get("ok")]
    if pdfs and not readable_docs:
        flags.append("UNREADABLE_SOURCE")
        reasons.append("no PDF of this book could be opened")
    question_docs = [d for d in docs if d["role"] in ("QUESTION_BOOK", "PER_TEST_BOOK")]
    if not docs and pdfs:
        reasons.append("no page in any book PDF carries this test number in its header (scanned or unnumbered)")
    if any(d["text_layer"] != "TEXT" for d in question_docs) or (pdfs and not any(
            p["pdf"]["inspection"].get("text_layer") == "TEXT" for p in readable_docs)):
        flags.append("NEEDS_REVIEW")
        reasons.append("question source has no reliable text layer (OCR required later)")
    if not pdfs:
        flags.append("PARTIAL_SOURCE")
        reasons.append("no question book PDF for this test (audio only)")
    # audio coverage
    if family == "IELTS":
        sections = sorted({a["section"] for a in audio if a["section"]})
        whole = [a for a in audio if a["scope"] == "WHOLE_TEST_LISTENING"]
        coverage = {"sections_found": sections, "whole_test_files": len(whole),
                    "complete": sections == [1, 2, 3, 4] or bool(whole)}
    else:
        parts = sorted({a["part"] for a in audio if a.get("part")})
        whole = [a for a in audio if a["scope"] == "WHOLE_LISTENING"]
        lc_expected = "LISTENING" in scopes or "MIXED" in scopes or bool(audio)
        coverage = {"parts_found": parts, "whole_listening_files": len(whole),
                    "complete": parts == [1, 2, 3, 4] or bool(whole), "listening_expected": lc_expected}
    if not audio:
        if family == "IELTS" or coverage.get("listening_expected"):
            flags.append("MISSING_COMPANION_MEDIA")
            reasons.append("no audio track mapped to this test")
    elif not coverage["complete"]:
        flags.append("MISSING_COMPANION_MEDIA")
        reasons.append("audio coverage incomplete")
    if any(a["confidence"] in ("AMBIGUOUS", "UNMAPPED") for a in audio):
        flags.append("AMBIGUOUS_MAPPING")
        reasons.append("some audio mapped with AMBIGUOUS confidence")
    if evidence == {"PDF_PAGE_HEADER"} and not audio and family == "IELTS":
        reasons.append("test identified from page headers only")
    if answer_key["status"] in ("NOT_FOUND", "UNKNOWN_NEEDS_OCR"):
        flags.append("PARTIAL_SOURCE")
        reasons.append(f"answer key {answer_key['status']}")
    if family == "TOEIC" and scopes and scopes <= {"LISTENING"}:
        flags.append("PARTIAL_SOURCE")
        reasons.append("book is LC-only: no Reading source")
    if family == "TOEIC" and scopes and scopes <= {"READING"} and not audio:
        flags.append("PARTIAL_SOURCE")
        reasons.append("book is RC-only")
    label = next((l for l in LABEL_PRIORITY if l in flags), "READY_FOR_EXTRACTION")
    confs = [a["confidence"] for a in audio]
    mapping_conf = ("UNMAPPED" if not audio else
                    "AMBIGUOUS" if any(c in ("AMBIGUOUS", "UNMAPPED") for c in confs) else
                    "PROBABLE" if any(c == "PROBABLE" for c in confs) else "CONFIDENT")
    return {
        "test_id": f"{family.lower()}/{book_key}/test-{n}",
        "test_number": n,
        "identified_by": sorted(evidence),
        "source_documents": docs,
        "audio": audio,
        "audio_coverage": coverage,
        "audio_mapping_confidence": mapping_conf,
        "answer_key_status": answer_key["status"],
        "transcript_status": transcript["status"],
        "extraction_readiness": label,
        "flags": sorted(set(flags)),
        "reasons": reasons,
    }


def find_duplicates(files):
    groups = defaultdict(list)
    for f in files:
        if f["kind"] in ("SYSTEM_JUNK", "APPLEDOUBLE_JUNK") or f["size"] == 0:
            continue
        groups[f["sha256"]].append(f)
    exact = []
    for sha, fs in groups.items():
        if len(fs) < 2:
            continue
        names = {x["name"].lower() for x in fs}
        exact.append({"sha256": sha, "kind": fs[0]["kind"], "size": fs[0]["size"],
                      "type": "IDENTICAL_COPY" if len(names) == 1 else "RENAMED_DUPLICATE",
                      "paths": [x["path"] for x in fs]})
    # archive members identical to loose files (size + CRC32, no extraction)
    loose = defaultdict(list)
    for f in files:
        if f["kind"] == "AUDIO":
            loose[(f["size"], f["crc32"])].append(f["path"])
    in_archive = []
    for f in files:
        if f["kind"] == "ARCHIVE" and f["archive"].get("ok"):
            for m in f["archive"]["members"]:
                hit = loose.get((m["size"], m["crc32"]))
                if hit:
                    in_archive.append({"archive": f["path"], "member": m["name"], "loose_copies": hit})
    # same basename, different content (unknown duplicates / different editions)
    by_name = defaultdict(list)
    for f in files:
        if f["kind"] in ("PDF", "AUDIO", "ARCHIVE"):
            by_name[f["name"].lower()].append(f)
    collisions = []
    for name, fs in by_name.items():
        shas = {x["sha256"] for x in fs}
        if len(fs) > 1 and len(shas) > 1:
            collisions.append({"name": name, "variants": [{"path": x["path"], "size": x["size"],
                                                           "sha256": x["sha256"]} for x in fs]})
    junk = [f["path"] for f in files if f["kind"] == "APPLEDOUBLE_JUNK"]
    return {"exact_duplicate_groups": exact, "archive_members_duplicating_loose_files": in_archive,
            "same_name_different_content": collisions, "appledouble_junk_files": junk}


# ─── raw vs generated ──────────────────────────────────────────────────────────────────────

PLACEHOLDER = [
    re.compile(r"mark your answer on your answer sheet \(a, b, c,? or d\)", re.I),
    re.compile(r"choose the one word or phrase that best completes the sentence or passage", re.I),
    re.compile(r"according to the speaker, what is key regarding", re.I),
    re.compile(r"^question \d+: do the statements agree with the information given in passage \d+\??$", re.I),
]
LETTER = re.compile(r"^\(?[A-Da-d]\)?\.?$")


def part_no(code):
    m = re.search(r"(\d+)\D*$", code or "")
    return int(m.group(1)) if m else -1


def generated_stats(pkg):
    items = pkg.get("items", [])
    specs = {s["itemId"]: s for s in pkg.get("answerSpecs", [])}
    groups_by_part = defaultdict(list)
    part_of_group = {}
    parts = {p["id"]: p for p in pkg.get("parts", [])}
    for fg in pkg.get("formGroups", []):
        part_of_group[fg["groupId"]] = part_no(parts.get(fg["partId"], {}).get("partCode"))
    size = Counter(i["groupId"] for i in items)
    stim = {s["id"]: s for s in pkg.get("stimuli", [])}
    text_stim_groups = set()
    audio_stimuli = 0
    image_refs = 0
    transcript_flags = 0
    for gs in pkg.get("groupStimuli", []):
        s = stim.get(gs["stimulusId"], {})
        st = (s.get("stimulusType") or s.get("kind") or "").upper()
        if "AUDIO" in st:
            audio_stimuli += 1
        if (s.get("attributes") or {}).get("transcriptAvailable"):
            transcript_flags += 1
        if "TEXT" in st or "PASSAGE" in st or len(s.get("bodyText") or "") > 300:
            if len(s.get("bodyText") or "") > 300:
                text_stim_groups.add(gs["groupId"])
        attrs = json.dumps(s.get("attributes") or {}) + json.dumps(s.get("bodyPayload") or {})
        if "imageUrl" in attrs or "svgAsset" in attrs or "IMAGE" in st:
            image_refs += 1
    placeholder = letter_only = empty_key = debris_key = 0
    toeic = (pkg.get("form") or {}).get("family") == "TOEIC"
    for it in items:
        prompt = it.get("promptText") or it.get("prompt") or ""
        if any(rx.search(prompt) for rx in PLACEHOLDER):
            placeholder += 1
        opts = (it.get("interactionConfig") or {}).get("options") or (it.get("optionDefinitions") or {}).get("options")
        if opts:
            texts = [o if isinstance(o, str) else (o.get("text") or o.get("label") or "") for o in opts]
            if all(LETTER.match(t.strip() or "A") for t in texts):
                letter_only += 1
        s = specs.get(it["id"], {})
        vals = [v for v in (s.get("acceptedVariants") or []) if str(v).strip()]
        acc = s.get("acceptedAnswers") or {}
        if isinstance(acc, dict):
            for k in ("values", "accepted", "exact", "items"):
                vals += [v for v in (acc.get(k) or []) if str(v).strip()]
        if not vals:
            empty_key += 1
        elif toeic and not all(re.fullmatch(r"[A-D]", str(v).strip().upper()) for v in vals):
            debris_key += 1
    flattened = 0
    missing_passage_groups = 0
    for g, cnt in size.items():
        pn = part_of_group.get(g, -1)
        limit = {3: 3, 4: 3, 6: 4, 7: 5}.get(pn) if toeic else None
        if limit and cnt > limit:
            flattened += 1
        if toeic and pn in (6, 7) and g not in text_stim_groups:
            missing_passage_groups += 1
    asset_shas = {a.get("sha256Hash") for a in pkg.get("assets", []) if (a.get("mimeType") or "").startswith("audio")}
    image_assets = [a for a in pkg.get("assets", []) if (a.get("mimeType") or "").startswith("image")]
    return {
        "items": len(items), "groups": len(size), "placeholder_prompts": placeholder,
        "letter_only_options": letter_only, "empty_keys": empty_key, "debris_keys": debris_key,
        "flattened_groups": flattened, "toeic_p6_p7_groups_without_passage": missing_passage_groups,
        "passage_stimuli": len(text_stim_groups), "audio_assets": len(asset_shas - {None}),
        "audio_asset_sha256": sorted(asset_shas - {None}), "image_assets": len(image_assets),
        "image_refs": image_refs, "transcript_flags": transcript_flags,
    }


def loss_matrix(files, hierarchy):
    prior = {t["test_id"]: t for t in load_json(PRIOR_MANIFEST, {}).get("tests", [])}
    by_path = {f["path"]: f for f in files}
    tests_by_book = {}
    for fam in hierarchy["families"]:
        for col in fam["collections"]:
            for b in col["books"]:
                tests_by_book[b["book"]] = ({t["test_number"]: t for t in b["tests"]}, b)
    extracted = set()
    for d in EXTRACTED_IMAGE_DIRS:
        if d.exists():
            extracted |= {p.name for p in d.iterdir() if p.is_file()}
    rows = []
    for pkg_path in sorted(GENERATED.rglob("*.json")):
        pkg = load_json(pkg_path, None)
        if not isinstance(pkg, dict) or "items" not in pkg:
            continue
        pid = (pkg.get("manifest") or {}).get("packageId") or pkg_path.stem
        gen = generated_stats(pkg)
        pm = prior.get(pid, {})
        qsrc = (pm.get("question_source") or {})
        rel = qsrc.get("rel_path")
        raw_file = by_path.get(rel) if rel else None
        drift = None
        if rel and raw_file is None:
            drift = "SOURCE_FILE_MISSING_NOW"
        elif raw_file is not None and qsrc.get("sha256") and qsrc["sha256"] != raw_file["sha256"]:
            drift = "SOURCE_CONTENT_CHANGED_SINCE_GENERATION"
        book_key = raw_file["book"] if raw_file else None
        test_no = pm.get("test_number")
        raw_test = None
        raw_book = None
        if book_key in tests_by_book:
            raw_tests, raw_book = tests_by_book[book_key]
            raw_test = raw_tests.get(test_no)
        raw_audio_sha = {a["sha256"] for a in (raw_test or {}).get("audio", []) if a.get("sha256")}
        raw_text = raw_file and raw_file.get("pdf", {}).get("inspection", {}).get("text_layer")
        prefix = pid + "_"
        extracted_for_test = sorted(n for n in extracted if n.startswith(prefix))
        losses = []
        if gen["placeholder_prompts"]:
            losses.append("QUESTION_TEXT_REPLACED_BY_PLACEHOLDER" + ("" if raw_text == "TEXT" else "(raw needs OCR)"))
        if gen["letter_only_options"]:
            losses.append("OPTIONS_REDUCED_TO_LETTERS")
        if gen["empty_keys"] or gen["debris_keys"]:
            ak = (raw_book or {}).get("answer_key", {}).get("status")
            losses.append(f"ANSWER_KEYS_EMPTY_OR_DEBRIS(raw answer key: {ak})")
        if gen["flattened_groups"]:
            losses.append("GROUPS_FLATTENED")
        if gen["toeic_p6_p7_groups_without_passage"]:
            losses.append("PASSAGES_MISSING")
        unbound = raw_audio_sha - set(gen["audio_asset_sha256"])
        if unbound:
            losses.append(f"RAW_AUDIO_NOT_BOUND({len(unbound)})")
        if raw_test and not raw_audio_sha and any(a.get("archive_member") for a in raw_test.get("audio", [])):
            losses.append("RAW_AUDIO_ONLY_IN_ARCHIVE")
        if extracted_for_test and gen["image_assets"] + gen["image_refs"] < len(extracted_for_test):
            losses.append(f"EXTRACTED_IMAGES_NOT_BOUND({len(extracted_for_test) - gen['image_assets'] - gen['image_refs']})")
        if (raw_book or {}).get("transcript", {}).get("status") in ("AVAILABLE_FILE", "CANDIDATE_PAGES") and not gen["transcript_flags"]:
            losses.append("TRANSCRIPT_AVAILABLE_NOT_LINKED")
        rows.append({
            "package": pid, "generated_path": pkg_path.relative_to(REPO).as_posix(),
            "family": (pkg.get("form") or {}).get("family"), "raw_book": book_key, "raw_test": test_no,
            "raw_test_id": (raw_test or {}).get("test_id"), "raw_source_drift": drift,
            "raw": {"question_source": rel, "text_layer": raw_text,
                    "audio_tracks": len((raw_test or {}).get("audio", [])),
                    "audio_mapping_confidence": (raw_test or {}).get("audio_mapping_confidence"),
                    "answer_key": (raw_book or {}).get("answer_key", {}).get("status"),
                    "transcript": (raw_book or {}).get("transcript", {}).get("status"),
                    "extracted_images_on_disk": len(extracted_for_test)},
            "generated": {k: v for k, v in gen.items() if k != "audio_asset_sha256"},
            "raw_audio_bound": len(raw_audio_sha & set(gen["audio_asset_sha256"])),
            "generated_audio_not_matching_raw": len(set(gen["audio_asset_sha256"]) - raw_audio_sha) if raw_audio_sha else None,
            "losses": losses,
            "confidence": "CONFIDENT" if raw_test and not drift else ("PROBABLE" if raw_file else "UNMAPPED"),
        })
    by_collection = defaultdict(lambda: Counter())
    for r in rows:
        col = r["package"].split("_TEST_")[0] if "_TEST_" in r["package"] else r["package"]
        c = by_collection[col]
        c["packages"] += 1
        g = r["generated"]
        for k in ("items", "placeholder_prompts", "letter_only_options", "empty_keys", "debris_keys",
                  "flattened_groups", "toeic_p6_p7_groups_without_passage", "passage_stimuli", "audio_assets",
                  "image_assets", "image_refs"):
            c[k] += g[k]
        c["raw_audio_tracks"] += r["raw"]["audio_tracks"]
        c["raw_audio_bound"] += r["raw_audio_bound"]
        c["extracted_images_on_disk"] += r["raw"]["extracted_images_on_disk"]
        c["source_drift"] += 1 if r["raw_source_drift"] else 0
        c["unmapped_to_raw"] += 1 if r["confidence"] == "UNMAPPED" else 0
    return {"packages": rows, "by_collection": {k: dict(v) for k, v in sorted(by_collection.items())}}


def image_inventory(files):
    prov = {}
    for p in IMAGE_PROVENANCE:
        data = load_json(p, [])
        for e in data if isinstance(data, list) else []:
            fname = e.get("filename") or e.get("file")
            if fname:
                prov[fname] = {"source_file": e.get("sourceFile") or e.get("source_file"),
                               "page": e.get("page") or e.get("source_page"),
                               "method": e.get("provenance") or "PDF_CROP", "record": p.relative_to(REPO).as_posix()}
    out = {"raw_source_images": [f["path"] for f in files if f["kind"] == "IMAGE"],
           "pdf_embedded_image_pages": sum((f.get("pdf", {}).get("inspection", {}).get("image_pages") or 0)
                                           for f in files if f["kind"] == "PDF"),
           "generated_or_extracted": {}}
    for d in EXTRACTED_IMAGE_DIRS:
        if not d.exists():
            continue
        names = sorted(p.name for p in d.iterdir() if p.is_file())
        with_prov = [n for n in names if n in prov]
        part1 = [n for n in names if re.search(r"_L_P1_Q\d+", n)]
        task1 = [n for n in names if "W_TASK1" in n]
        out["generated_or_extracted"][d.relative_to(REPO).as_posix()] = {
            "classification": "GENERATED/EXTRACTED_IMAGE",
            "files": len(names), "with_recorded_provenance": len(with_prov),
            "provenance_unknown": len(names) - len(with_prov),
            "toeic_part1_photo_candidates": len(part1), "ielts_writing_task1_candidates": len(task1),
        }
    out["provenance_records"] = len(prov)
    return out


def summarize(files, hierarchy, dups, loss):
    summary = {}
    for family in ("IELTS", "TOEIC"):
        fs = [f for f in files if f["family"] == family]
        fam = next((x for x in hierarchy["families"] if x["family"] == family), {"collections": []})
        books = [b for c in fam["collections"] for b in c["books"]]
        tests = [t for b in books for t in b["tests"]]
        labels = Counter(t["extraction_readiness"] for t in tests)
        audio_tracks = sum(b["audio_track_count"] for b in books)
        summary[family] = {
            "collections": len([c for c in fam["collections"] if c["books"]]),
            "empty_collections": [c["collection"] for c in fam["collections"] if not c["books"]],
            "books": len(books),
            "pdfs": sum(1 for f in fs if f["kind"] == "PDF"),
            "pdf_pages": sum((f.get("pdf", {}).get("inspection", {}).get("page_count") or 0) for f in fs if f["kind"] == "PDF"),
            "pdfs_text_layer": Counter(f["pdf"]["inspection"].get("text_layer", "UNREADABLE") for f in fs if f["kind"] == "PDF"),
            "audio_files_loose": sum(1 for f in fs if f["kind"] == "AUDIO"),
            "audio_tracks_incl_archives": audio_tracks,
            "archives": sum(1 for f in fs if f["kind"] == "ARCHIVE"),
            "images_standalone": sum(1 for f in fs if f["kind"] == "IMAGE"),
            "junk_files": sum(1 for f in fs if f["kind"] in ("SYSTEM_JUNK", "APPLEDOUBLE_JUNK")),
            "storage_bytes": sum(f["size"] for f in fs),
            "identifiable_tests": len(tests),
            "tests_with_audio": sum(1 for t in tests if t["audio"]),
            "tests_with_complete_audio": sum(1 for t in tests if t["audio"] and t["audio_coverage"]["complete"]),
            "tests_without_audio": sum(1 for t in tests if not t["audio"]),
            "tests_answer_key": Counter(t["answer_key_status"] for t in tests),
            "tests_transcript": Counter(t["transcript_status"] for t in tests),
            "tests_ambiguous_mapping": sum(1 for t in tests if t["audio_mapping_confidence"] in ("AMBIGUOUS", "UNMAPPED")),
            "unassigned_audio_tracks": sum(len(b["unassigned_audio"]) for b in books),
            "readiness": labels,
            "books_without_identified_tests": {b["book"]: b.get("book_readiness") for b in books if not b["tests"]},
            "empty_book_folders": [f"{c['collection']}/{n}" for c in fam["collections"] for n in c.get("empty_book_folders", [])],
        }
    summary["duplicates"] = {
        "exact_groups": len(dups["exact_duplicate_groups"]),
        "exact_by_kind": Counter(g["kind"] for g in dups["exact_duplicate_groups"]),
        "renamed_groups": sum(1 for g in dups["exact_duplicate_groups"] if g["type"] == "RENAMED_DUPLICATE"),
        "archive_member_copies": len(dups["archive_members_duplicating_loose_files"]),
        "same_name_different_content": len(dups["same_name_different_content"]),
        "appledouble_junk": len(dups["appledouble_junk_files"]),
    }
    summary["generated_packages"] = len(loss["packages"])
    summary["generated_losses"] = Counter(l.split("(")[0] for r in loss["packages"] for l in r["losses"])
    summary["generated_source_drift"] = Counter(r["raw_source_drift"] for r in loss["packages"] if r["raw_source_drift"])
    summary["total_files"] = len(files)
    summary["total_bytes"] = sum(f["size"] for f in files)
    return json.loads(json.dumps(summary, default=dict))


def write(name, payload):
    OUT.mkdir(parents=True, exist_ok=True)
    payload = {"schema_version": SCHEMA_VERSION, "generator": GENERATOR,
               "generated_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(), **payload}
    with open(OUT / name, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=1, sort_keys=False, default=dict)
        fh.write("\n")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--rehash", action="store_true", help="ignore the size+mtime hash cache")
    args = ap.parse_args()
    if not RAW.is_dir():
        sys.exit(f"raw corpus not found: {RAW}")
    print(f"[manifest] inventory of {RAW}", file=sys.stderr)
    files = inventory(args.rehash)
    hierarchy = build_hierarchy(files)
    dups = find_duplicates(files)
    loss = loss_matrix(files, hierarchy)
    images = image_inventory(files)
    summary = summarize(files, hierarchy, dups, loss)
    summary["images"] = images
    write("raw_source_files.json", {"root": "imports/source-files", "files": files})
    write("raw_source_manifest.json", hierarchy)
    write("raw_source_duplicates.json", dups)
    write("raw_vs_generated_loss_matrix.json", loss)
    write("raw_source_summary.json", summary)
    print(json.dumps(summary, ensure_ascii=False, indent=1, default=dict))


if __name__ == "__main__":
    main()
