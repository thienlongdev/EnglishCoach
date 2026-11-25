"""Structured human-QA queue for uncertain extraction (Exams Recovery Phase 3.5M / 3.6G).

Every entry says WHERE to look (source path + SHA-256, page + bbox, or audio interval), WHAT is uncertain
(diagnostic code, detail, confidence) and for WHICH test / questions — so a reviewer never searches a whole book.
Entries hold locations, codes and counts only: no exam text, no answer-key letters.

Output: imports/exams/staging/reports/qa_queue.json

Phase 3.6G: every entry carries a priority (P0 answer-key uncertainty on an otherwise-complete form, P1 question /
group boundaries, P2 image crops, P3 audio boundaries, P4 reading order / OCR proofreading, P5 cosmetics).
Entries of the previous phase's queue (reports/phase35_baseline/qa_queue.json) that are no longer raised are kept
as an AUDIT list ("resolved": old status, resolution method, resulting confidence) — nothing is dropped silently,
and no entry is auto-approved: an entry leaves the queue only when the extractor no longer raises it.
"""
from __future__ import annotations

import glob
import hashlib
import json
import re
from collections import Counter
from pathlib import Path

from .staging import _write_json

# diagnostic code -> queue type
TYPE_BY_CODE = {
    "ANSWER_KEY_LATTICE_CONFLICT": "ANSWER_KEY", "ANSWER_KEY_NUMBER_UNREAD": "ANSWER_KEY",
    "ANSWER_KEY_LETTER_UNCERTAIN": "ANSWER_KEY", "ANSWER_KEY_SEQUENCE_UNPROVEN": "ANSWER_KEY",
    "ANSWER_KEY_BLOCK_UNASSIGNED": "ANSWER_KEY", "ANSWER_KEY_MISSING_ITEM": "ANSWER_KEY",
    "ANSWER_KEY_OCR_REPAIRED": "ANSWER_KEY", "ANSWER_KEY_SYNTAX_INVALID": "ANSWER_KEY",
    "PART6_BLANK_MAPPING_UNPROVEN": "PART6_BLANK", "GROUP_STRUCTURE_AMBIGUOUS": "PART6_BLANK",
    "PHOTO_MAPPING_UNPROVEN": "IMAGE_CROP", "IMAGE_REGION_HEURISTIC": "IMAGE_CROP", "IMAGE_NOT_BOUND": "IMAGE_CROP",
    "WRITING_VISUAL_NOT_FOUND": "IMAGE_CROP", "GRAPHIC_NOT_BOUND": "IMAGE_CROP",
    "OCR_COLUMN_ORDER_INVERTED": "OCR_READING_ORDER", "LAYOUT_LINEARIZED": "OCR_READING_ORDER",
    "OPTION_LABEL_MISSING": "OCR", "OPTION_PARSE_FAILED": "OCR", "QUESTION_NUMBER_GAP": "OCR",
    "OPTION_CONTINUATION_UNPROVEN": "OCR", "SPEAKING_TURN_STRUCTURE_UNPROVEN": "OTHER",
    "SOURCE_BLANK_GEOMETRY_RESTORED": "OCR",
    "BLANK_NOT_FOUND": "OCR", "OCR_LOW_CONFIDENCE": "OCR", "OPTION_LABEL_RECOGNISED": "OCR",
    "OPTION_LABEL_RESTORED": "OCR",          # Phase 5B: lattice-restored label (human-visible, never auto-closed)
    "TEST_PAGES_UNVERIFIED": "TEST_NUMBER", "TEST_BOUNDARY_NOT_FOUND": "TEST_NUMBER",
    "SOURCE_PAGE_RANGE_UNCERTAIN": "TEST_NUMBER",
    "GROUP_BOUNDARY_UNPROVEN": "OTHER", "QUESTION_RANGE_MISMATCH": "OTHER",
}


def _id(*parts) -> str:
    return hashlib.sha256("|".join(str(p) for p in parts).encode()).hexdigest()[:16]


def graphic_scope(review: dict, variant: str) -> str:
    """Printed graphic ordinals select their specification part; uncertainty stays skill-wide."""
    from .toeic import part_numbers
    match=re.fullmatch(r'\s*(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?\s*',
                       str(review.get('question') or review.get('questions') or ''))
    if not match or variant not in ('TOEIC_LR_2016','TOEIC_LR_PRE_2016'):
        return 'LISTENING'
    first=int(match[1]);last=int(match[2] or match[1])
    if first>last:
        return 'LISTENING'
    numbers=set(range(first,last+1))
    for part in (3,4):
        if numbers <= set(part_numbers(part,variant)):
            return f'LISTENING/PART_{part}'
    return 'LISTENING'


def numbered_scopes(entry: dict, fmt: str) -> list:
    """Localize explicitly recorded ordinals using the canonical TOEIC specification."""
    from .toeic import part_numbers
    scope=entry.get('scope','')
    match=re.fullmatch(r'(?:ANSWER_KEY/)?(LISTENING|READING)',scope)
    if not match or fmt not in ('TOEIC_LR_2016','TOEIC_LR_PRE_2016'):
        return [entry]
    text=str(entry.get('questions') or '')
    if not text:return [entry]
    numbers=set()
    for token in text.split(','):
        m=re.fullmatch(r'\s*(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?\s*',token)
        if not m:return [entry]
        a=int(m[1]);b=int(m[2] or m[1])
        if a>b or b>200:return [entry]
        numbers.update(range(a,b+1))
    skill=match[1];parts=range(1,5) if skill=='LISTENING' else range(5,8)
    valid=set(n for part in parts for n in part_numbers(part,fmt))
    if not numbers or not numbers<=valid:return [entry]
    return [dict(entry,scope=f'{skill}/PART_{part}',questions=','.join(map(str,sorted(own))))
            for part in parts if (own:=numbers & set(part_numbers(part,fmt)))]


def canonical_format(staging: Path, report: dict):
    from .corpus import REPO_ROOT
    ref=report.get('package') or {}
    if not ref.get('path'):return None
    path=(REPO_ROOT/ref['path']).resolve()
    if not path.is_relative_to(staging.resolve()):return None
    pkg=json.loads(path.read_text(encoding='utf-8'))
    spec_id=(pkg.get('form') or {}).get('specificationId')
    specs=[s for s in pkg.get('specifications',[]) if s.get('id')==spec_id]
    return (specs[0].get('blueprint') or {}).get('formatVersion') if len(specs)==1 else None


def diagnostic_locations(report: dict, diagnostic: dict) -> list[dict]:
    """Recover individual locations from recorded OCR evidence, never a cross product."""
    skill = diagnostic.get('scope', '').split('/')[0]
    if diagnostic.get('code') != 'OPTION_LABEL_RECOGNISED' or skill not in ('LISTENING', 'READING'):
        return [diagnostic]
    locations = ((report.get('ocrMetrics') or {}).get(skill, {}).get('labels') or {}).get('locations') or []
    questions = str(diagnostic.get('questions') or '').split(',')
    pages = str(diagnostic.get('pages') or '').split(',')
    if not locations or {str(x.get('q')) for x in locations} != set(questions) or {
            str(x.get('page')) for x in locations} != set(pages):
        return [diagnostic]
    return [dict(diagnostic, questions=str(x['q']), pages=str(x['page'])) for x in locations]


def diagnostic_source(report: dict, diagnostic: dict, source_records: list[dict]) -> dict:
    """Select one hash-matched, skill-recorded document. Ambiguity has no default source."""
    documents = report.get('documents') or []
    if len(documents) == 1:
        return documents[0]
    scope = diagnostic.get('scope', '')
    skill = scope.removeprefix('ANSWER_KEY/').split('/')[0]
    role = 'ANSWER_KEY' if scope.startswith('ANSWER_KEY/') else 'QUESTION_BOOK'
    candidates = []
    for document in documents:
        if document.get('role') != role:
            continue
        scopes = {document['scope']} if document.get('scope') else {
            r.get('scope') for r in source_records
            if document.get('sha256') and r.get('sha256') == document['sha256'] and r.get('role') == role}
        if scopes == {skill}:
            candidates.append(document)
    return candidates[0] if len(candidates) == 1 else {}


def build_queue(staging: Path) -> dict:
    from .corpus import RawCorpusManifest
    source_books = RawCorpusManifest().books
    entries = []
    formats = {}
    # 1. extraction reports: recorded review items + located diagnostics
    for f in sorted(glob.glob(str(staging / "reports" / "extraction" / "*" / "*.json"))):
        rep = json.loads(Path(f).read_text(encoding="utf-8"))
        tid = rep["testId"]
        formats[tid] = canonical_format(staging,rep)
        book_record = source_books.get(rep.get('book'))
        source_records = book_record[2].get('source_documents', []) if book_record else []
        for it in rep.get("reviewItems", []):
            typ = {"ANSWER_KEY_CELL": "ANSWER_KEY", "PART1_PHOTO": "IMAGE_CROP",
                   "PART1_PHOTO_CROP": "IMAGE_CROP", "PART34_GRAPHIC": "IMAGE_CROP",
                   "PART34_GRAPHIC_CROP": "IMAGE_CROP"}.get(it["type"], "OTHER")
            e = {"type": typ, "subtype": it["type"], "testId": tid, "source": it.get("source"),
                 "sha256": it.get("sha256"), "page": it.get("page") or it.get("pages"), "bbox": it.get("bbox"),
                 "questions": it.get("question") or it.get("questions"), "status": it.get("status") or it.get("reviewState"),
                 "detail": it.get("detail"), "confidence": "UNRESOLVED" if typ == "ANSWER_KEY" else "PROBABLE"}
            if it.get("letterBbox"):
                e["letterBbox"] = it["letterBbox"]
            if it.get("reads"):
                e["numberReads"] = it["reads"].get("number")
            if it.get("skill") in ("LISTENING", "READING", "WRITING", "SPEAKING"):
                e["scope"] = ("ANSWER_KEY/" if typ == "ANSWER_KEY" else "") + it["skill"]
            if it["type"] in ("PART1_PHOTO", "PART1_PHOTO_CROP"):
                e["scope"] = "LISTENING/PART_1"
            elif it["type"] in ("PART34_GRAPHIC", "PART34_GRAPHIC_CROP"):
                e["scope"] = graphic_scope(it, formats[tid])
            entries.append(e)
        for d in rep.get("diagnostics", []):
            typ = TYPE_BY_CODE.get(d["code"])
            if typ is None or d["severity"] == "INFO":
                continue
            if d["code"].startswith("ANSWER_KEY_") and any(x.get("type") == "ANSWER_KEY_CELL" for x in rep.get("reviewItems", [])):
                continue     # already itemised per cell
            source = diagnostic_source(rep, d, source_records)
            for location in diagnostic_locations(rep, d):
                entries.append({"type": typ, "subtype": d["code"], "testId": tid, "scope": d["scope"],
                                "source": source.get("path"), "sha256": source.get("sha256"), "page": location.get("pages"),
                                "questions": location.get("questions"), "detail": d.get("detail"),
                                "confidence": "UNRESOLVED" if d["severity"] == "BLOCKING" else "PROBABLE",
                                "severity": d["severity"]})
    # 2. key-table reports: blocks whose numbering could not be proven (no per-test extraction needed)
    for f in sorted(glob.glob(str(staging / "reports" / "ocr_keys" / "*.json"))):
        rep = json.loads(Path(f).read_text(encoding="utf-8"))
        for t in rep["tests"]:
            if t["orientation"] is None or t["confirmed"] < t["expected"]:
                entries.append({"type": "ANSWER_KEY", "subtype": "KEY_TABLE_BLOCK", "testId": f"toeic/{rep['book']}/test-{t['test']}",
                                "scope": "ANSWER_KEY/" + rep["skill"],
                                "source": rep["source"], "sha256": rep["sha256"], "page": t["page"],
                                "bbox": t.get("blockBbox"), "questions": ",".join(map(str, t["missing"][:40])),
                                "detail": f"{rep['skill']}: confirmed {t['confirmed']}/{t['expected']}; "
                                          f"{'; '.join(d['code'] for d in t.get('diagnostics', [])) or 'cells unconfirmed'}",
                                "confidence": "UNRESOLVED"})
            for a in t.get("adjudicated", []):
                # a re-read adjudication is CONFIDENT but stays visible to a human (cell + reads, no letter)
                entries.append({"type": "ANSWER_KEY", "subtype": "KEY_CELL_REREAD_ADJUDICATED",
                                "scope": "ANSWER_KEY/" + rep["skill"],
                                "testId": f"toeic/{rep['book']}/test-{t['test']}", "source": rep["source"],
                                "sha256": rep["sha256"], "page": t["page"], "questions": a["q"],
                                "numberReads": a["numberReads"], "detail": "3 of 4 number reads agree with the lattice",
                                "confidence": "CONFIDENT", "severity": "REVIEW"})
    # 3. audio: every boundary that is not CONFIDENT, with its time interval
    af = staging / "reports" / "audio_segmentation.json"
    if af.exists():
        rep = json.loads(af.read_text(encoding="utf-8"))
        for r in rep.get("recordings", []):
            for b in r.get("boundaries") or []:
                if b["tier"] == "CONFIDENT":
                    continue
                at = b.get("atS")
                entries.append({"type": "AUDIO_BOUNDARY", "subtype": f"PART_{b['between']}", "testId": r["testId"],
                                "scope": "LISTENING",
                                "sha256": r["parentSha256"],
                                "intervalMs": [int((at - 30) * 1000), int((at + 30) * 1000)] if at else None,
                                "detail": "; ".join(b.get("evidence", [])) or "no defensible candidate",
                                "confidence": b["tier"]})
        for p in sorted(glob.glob(str(staging / "audio_segments" / "*.json"))):
            data = json.loads(Path(p).read_text(encoding="utf-8"))
            if data.get("model") == "IELTS_SPOKEN_PART_ANNOUNCEMENTS":
                continue          # every part boundary proven by a spoken announcement: silences are not candidates
            for c in data.get("candidates", []):
                entries.append({"type": "AUDIO_BOUNDARY", "subtype": "IELTS_SILENCE_CANDIDATE",
                                "scope": "LISTENING",
                                "source": data["parentPath"], "sha256": data["parentSha256"],
                                "intervalMs": [int(c["atS"] * 1000), int((c["atS"] + c["durS"]) * 1000)],
                                "detail": c["evidence"][0], "confidence": c["tier"]})
    # 4. rendered page-region images awaiting crop QA (only crops a CURRENT staged package references)
    referenced = set()
    for f in glob.glob(str(staging / "extracted" / "**" / "*.json"), recursive=True):
        pkg = json.loads(Path(f).read_text(encoding="utf-8"))
        referenced.update(a.get("sha256Hash") for a in pkg.get("assets", []))
    ai = staging / "assets" / "asset_index.json"
    if ai.exists():
        idx = json.loads(ai.read_text(encoding="utf-8"))
        for key, rec in idx.items():
            if rec.get("kind") != "IMAGE" or rec.get("sha256") not in referenced:
                continue
            for src in rec.get("derivedFrom", [])[:1]:
                entries.append({"type": "IMAGE_CROP", "subtype": "PAGE_REGION_RENDERING", "source": src.get("rawSourcePath"),
                                "sha256": src.get("rawSourceSha256"), "page": src.get("page"), "bbox": src.get("bbox"),
                                "cropSha256": rec["sha256"], "detail": src.get("method"), "confidence": "PROBABLE"})
    # 5. Phase 4.1A: completion groups the runner cannot show as an inline template (sentence completion with the number
    #    at the start of the line, '(24) ... ______ ...'): the runner falls back to per-item rendering — display only,
    #    scoring unaffected — and a human must be able to approve that presentation (mirror of
    #    ExamRuntimeCompatibility#templateComplete / FE groupPresentation BLANK_RE)
    for f in sorted(glob.glob(str(staging / "extracted" / "**" / "*.json"), recursive=True)):
        pkg = json.loads(Path(f).read_text(encoding="utf-8"))
        entries.extend(_template_fallbacks(pkg, Path(f)))
    complete = _otherwise_complete(staging)
    entries = [scoped for entry in entries for scoped in numbered_scopes(entry,formats.get(entry.get('testId')))]
    seen, out = set(), []
    for e in entries:
        e["id"] = _id(e.get("type"), e.get("subtype"), e.get("testId"), e.get("source"), e.get("page"), e.get("bbox"),
                      e.get("questions"), e.get("intervalMs"), e.get("scope"))
        if e["id"] in seen:
            continue
        seen.add(e["id"])
        e["priority"] = priority(e, complete)
        out.append({k: v for k, v in e.items() if v not in (None, "", [])})
    out.sort(key=lambda e: (e["priority"], e.get("testId") or "", e["type"]))
    resolved = _resolutions(staging, {e["id"] for e in out})
    summary = {"total": len(out), "byPriority": dict(sorted(Counter(e["priority"] for e in out).items())),
               "byType": dict(Counter(e["type"] for e in out)),
               "bySubtype": dict(Counter(e["subtype"] for e in out).most_common(25)),
               "resolvedSincePreviousPhase": len(resolved),
               "resolvedByMethod": dict(Counter(r["resolutionMethod"] for r in resolved))}
    q = {"summary": summary, "entries": out, "resolved": resolved,
         "note": "locations, codes and counts only; open the source page/bbox or audio interval to review. "
                 "'resolved' = audit of previous-phase entries the extractor no longer raises (nothing auto-approved)"}
    _write_json(staging / "reports" / "qa_queue.json", q)
    return q


_TEMPLATE_BLANK = re.compile(r"\((\d{1,3})\)\s*(?:_{2,}|…+|\.{3,})")


def template_complete(stem: str, numbers: list) -> bool:
    """Mirror of ExamRuntimeCompatibility#templateComplete: every item number appears exactly once as '(n) ____' and
    no other numbered blank exists."""
    seen = Counter(int(m.group(1)) for m in _TEMPLATE_BLANK.finditer(stem or ""))
    if not numbers or len(set(numbers)) != len(numbers):
        return False
    return all(seen.get(n, 0) == 1 for n in numbers) and set(seen) <= set(numbers)


def _template_fallbacks(pkg: dict, path: Path) -> list:
    book, _, test = path.stem.partition("__")
    tid = f"{'toeic' if 'toeic' in path.parts else 'ielts'}/{book}/{test}"
    sections = {s["id"]: s["skill"] for s in pkg.get("sections", [])}
    part_of = {p["id"]: p for p in pkg.get("parts", [])}
    group_part = {fg["groupId"]: part_of.get(fg["partId"]) for fg in pkg.get("formGroups", [])}
    groups = {}
    for it in pkg.get("items", []):
        groups.setdefault(it["groupId"], []).append(it)
    prov = (pkg.get("manifest", {}).get("metadata", {}).get("sourceProvenance") or {}).get("rawSourceFile") or {}
    out = []
    for gid, items in groups.items():
        if not all(i.get("interactionType") in ("TEXT_GAP", "SHORT_ANSWER") for i in items):
            continue
        group = (items[0].get("optionDefinitions") or {}).get("group") or {}
        stem = group.get("stem")
        if not isinstance(stem, str) or not stem.strip():
            continue
        numbers = [(i.get("optionDefinitions") or {}).get("questionNumber") for i in items]
        if any(n is None for n in numbers) or template_complete(stem, [int(n) for n in numbers]):
            continue
        part = group_part.get(gid) or {}
        nums = sorted(int(n) for n in numbers)
        out.append({"type": "RUNTIME_DISPLAY", "subtype": "COMPLETION_TEMPLATE_PER_ITEM", "testId": tid,
                    "scope": f"{sections.get(part.get('sectionId'), 'UNKNOWN')}/{part.get('partCode') or 'PART'}",
                    "source": prov.get("path"), "sha256": prov.get("sha256"), "questions": f"{nums[0]}-{nums[-1]}",
                    "detail": "completion group rendered per item (blanks are not '(n) ____' template markers); "
                              "scoring unaffected", "confidence": "PROBABLE", "severity": "REVIEW"})
    return out


_STRUCTURE = {"QUESTION_NUMBER_GAP", "OPTION_PARSE_FAILED", "GROUP_BOUNDARY_UNPROVEN", "QUESTION_RANGE_MISMATCH",
              "PART6_BLANK_MAPPING_UNPROVEN", "GROUP_STRUCTURE_AMBIGUOUS", "BLANK_NOT_FOUND", "OPTION_LABEL_MISSING",
              "TEST_BOUNDARY_NOT_FOUND", "TEST_PAGES_UNVERIFIED", "SOURCE_PAGE_RANGE_UNCERTAIN"}


def priority(e: dict, complete: set) -> str:
    """P0 key on an otherwise-complete form, P1 boundaries / other keys, P2 crops, P3 audio, P4 OCR, P5 rest."""
    t, st = e.get("type"), e.get("subtype")
    if t == "ANSWER_KEY":
        return "P0" if e.get("testId") in complete else "P1"
    if st in _STRUCTURE or t in ("TEST_NUMBER", "PART6_BLANK"):
        return "P1"
    if t == "IMAGE_CROP":
        return "P2"
    if t == "AUDIO_BOUNDARY":
        return "P3"
    if t in ("OCR_READING_ORDER", "OCR", "RUNTIME_DISPLAY"):
        return "P4"
    return "P5"


def _otherwise_complete(staging: Path) -> set:
    """Tests whose ONLY blocking extraction diagnostics are answer-key ones (the form is complete otherwise)."""
    out = set()
    for f in glob.glob(str(staging / "reports" / "extraction" / "*" / "*.json")):
        rep = json.loads(Path(f).read_text(encoding="utf-8"))
        blk = [d for d in rep.get("diagnostics", []) if d["severity"] == "BLOCKING"]
        if blk and all(d["code"].startswith("ANSWER_KEY_") or (d["code"] == "PART_OMITTED" and d.get("detail") == "answer key")
                       for d in blk):
            out.add(rep["testId"])
    return out


_METHOD = {
    "GROUP_BOUNDARY_UNPROVEN": ("SPOKEN_SET_ANNOUNCEMENTS_CORROBORATED_BY_ANSWER_PAUSES", "CONFIDENT"),
    "PART_1|2": ("SPOKEN_PART_ANNOUNCEMENT_S6_S7", "CONFIDENT"),
    "PART_2|3": ("SPOKEN_PART_ANNOUNCEMENT_S6_S7", "CONFIDENT"),
    "PART_3|4": ("SPOKEN_PART_ANNOUNCEMENT_S6_S7", "CONFIDENT"),
    "IELTS_SILENCE_CANDIDATE": ("SPOKEN_PART_ANNOUNCEMENTS_AFTER_LONG_SILENCES", "CONFIDENT"),
    "LAYOUT_LINEARIZED": ("MULTI_DOC_SEGMENTATION_OR_HEADER_DOC_COUNT", "CONFIDENT"),
    "ANSWER_KEY_CELL": ("KEY_CELL_REREAD_3_OF_4", "CONFIDENT"),
    "KEY_TABLE_BLOCK": ("KEY_TABLE_COMPLETED_BY_REREAD", "CONFIDENT"),
    "WRITING_VISUAL_NOT_FOUND": ("RASTER_FIGURE_REGION_FULL_INK_BAND", "PROBABLE"),
    "PART6_BLANK_MAPPING_UNPROVEN": ("PART6_GEOMETRY_LABEL_DEDUP_OR_INLINE_PROFILE", "CONFIDENT"),
}


def _resolutions(staging: Path, current_ids: set) -> list:
    """Audit of previous-phase entries no longer raised (old status -> method -> resulting confidence)."""
    base = staging / "reports" / "phase35_baseline" / "qa_queue.json"
    if not base.exists():
        return []
    prev = json.loads(base.read_text(encoding="utf-8")).get("entries", [])
    out = []
    for e in prev:
        if e["id"] in current_ids:
            continue
        st = e.get("subtype")
        method, conf = _METHOD.get(st, (None, None))
        if method is None:
            if e.get("type") == "IMAGE_CROP" and st == "PAGE_REGION_RENDERING":
                method, conf = "SUPERSEDED_RENDER_NOT_REFERENCED_BY_ANY_PACKAGE", "N/A"
            elif e.get("type") in ("OCR", "OTHER", "PART6_BLANK", "TEST_NUMBER"):
                method, conf = "LAYOUT_OCR_REMEDIATION_UNIT_NOW_EXTRACTED_OR_RECLASSIFIED", "STRUCTURE_PROVEN"
            else:
                method, conf = "NO_LONGER_RAISED_AFTER_REMEDIATION", "SEE_CURRENT_REPORT"
        out.append({"id": e["id"], "type": e.get("type"), "subtype": st, "testId": e.get("testId"),
                    "questions": e.get("questions"), "oldStatus": e.get("confidence"),
                    "resolutionMethod": method, "resultingConfidence": conf})
    return out
