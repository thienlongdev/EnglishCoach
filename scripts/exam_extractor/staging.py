"""Staging writer, incremental run cache and copyright-safe extraction reports.

Layout (never inside imports/source-files/**, never over the legacy imports/exams/real/** corpus):
  imports/exams/staging/extracted/<family>/<collection>/<book>/<book>__test-<n>.json   canonical packages
  imports/exams/staging/reports/extraction/<family>/<book>__test-<n>.json             per-test extraction report
  imports/exams/staging/reports/batch_<X>.json                                       batch summary
  imports/exams/staging/reports/phase2_validation.json                               written by the Java gate
  imports/exams/staging/reports/staging_status.json                                  merged final status
  imports/exams/staging/assets/                                                       rendered images + asset index
  imports/exams/staging/cache/                                                        hashes, OCR, run fingerprints
Reports hold structure, counts, codes, pages and hashes only — no exam text.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path
from typing import Optional

from .diagnostics import BLOCKING, EXTRACTOR_NAME, EXTRACTOR_VERSION, REVIEW, page_range
from .model import ExtractedTest

INVALID_SOURCE = "INVALID_SOURCE"
NEEDS_REVIEW = "NEEDS_REVIEW"
EXTRACTED_CLEAN = "EXTRACTED_CLEAN"


def _write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, indent=1, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def extraction_status(t: ExtractedTest) -> str:
    if any(d.code in ('READING_EXTRACTION_INCOMPLETE', 'FULL_TEST_EXTRACTION_INCOMPLETE')
           for d in t.diagnostics.items):
        return NEEDS_REVIEW
    items = sum(len(s.items) for s in t.sections) + sum(len(s.writing_tasks) for s in t.sections)
    if not t.sections or items == 0:
        if t.family == 'TOEIC' and t.collection in ('ybm','economy'):
            return NEEDS_REVIEW
        return INVALID_SOURCE
    if t.diagnostics.has_blocking():
        return NEEDS_REVIEW
    return EXTRACTED_CLEAN


def summarize(t: ExtractedTest) -> dict:
    secs = []
    for s in t.sections:
        entry = {"skill": s.skill, "pages": page_range(s.pages)}
        if s.parts:
            entry["parts"] = []
            for p in s.parts:
                pe = {"code": p.code, "items": len(p.items),
                      "groups": [{"kind": g.kind, "questions": f"{g.first}-{g.last}", "items": len(g.items),
                                  "interactions": sorted({i.interaction for i in g.items}),
                                  "optionCount": len(g.items[0].options) if g.items and g.items[0].options else 0,
                                  "wordLimit": g.word_limit, "figure": bool(g.figure),
                                  "layoutLinearized": g.layout_linearized,
                                  "keysBound": sum(1 for i in g.items if i.key is not None)} for g in p.groups]}
                if p.audio:
                    pe["audio"] = [{"sha256": b.sha256, "confidence": b.confidence, "durationMs": b.duration_ms,
                                    "technicalQa": b.technical_qa} for b in p.audio]
                if p.passage:
                    pe["passage"] = {"chars": len(p.passage.text()), "paragraphs": len(p.passage.paragraphs),
                                     "titled": bool(p.passage.title), "pages": page_range(p.passage.pages),
                                     "documents": len(p.passage.documents)}
                entry["parts"].append(pe)
            entry["items"] = len(s.items)
        if s.writing_tasks:
            entry["tasks"] = [{"task": w.number, "minimumWords": w.minimum_words, "visual": w.visual_kind,
                               "figureBound": bool(w.figure), "pages": page_range(w.pages)} for w in s.writing_tasks]
        if s.speaking_parts:
            entry["speakingParts"] = [{"part": sp.number, "promptLines": len(sp.prompts)} for sp in s.speaking_parts]
        secs.append(entry)
    keys_bound = sum(1 for s in t.sections for i in s.items if i.key is not None)
    return {"sections": secs, "itemsEmitted": sum(len(s.items) for s in t.sections),
            "answerKeysBound": keys_bound,
            "diagnosticCounts": {sev: sum(1 for d in t.diagnostics.items if d.severity == sev)
                                 for sev in ("BLOCKING", "REVIEW", "INFO")}}


class Staging:
    def __init__(self, root: Path):
        self.root = root
        self.runs_path = root / "cache" / "runs.json"
        self.runs = {}
        if self.runs_path.exists():
            try:
                self.runs = json.loads(self.runs_path.read_text(encoding="utf-8"))
            except Exception:
                self.runs = {}

    def package_path(self, t: ExtractedTest) -> Path:
        return self.root / "extracted" / t.family.lower() / t.collection / t.book / f"{t.book}__test-{t.test_number}.json"

    def report_path(self, family: str, book: str, n: int) -> Path:
        return self.root / "reports" / "extraction" / family.lower() / f"{book}__test-{n}.json"

    def fingerprint(self, inputs: dict) -> str:
        blob = json.dumps({"inputs": inputs, "extractor": EXTRACTOR_VERSION}, sort_keys=True).encode()
        return hashlib.sha256(blob).hexdigest()

    def unchanged(self, test_id: str, fp: str) -> bool:
        rec = self.runs.get(test_id)
        if not rec or rec.get("fingerprint") != fp:
            return False
        try:
            report = self.cached_report(test_id)
            package = report.get("package") or {}
            if package.get("path"):
                prefix = "imports/exams/staging/"
                if not package["path"].startswith(prefix):
                    return False
                relative = Path(package["path"][len(prefix):])
                local = (self.root / relative).resolve()
                if self.root.resolve() not in local.parents or not local.is_file():
                    return False
                pkg = json.loads(local.read_text(encoding="utf-8"))
                if pkg.get("manifest", {}).get("contentHash") != package.get("contentHash"):
                    return False
            return True
        except (OSError, ValueError, KeyError, TypeError):
            return False

    def cached_report(self, test_id: str) -> dict:
        """Resolve identity in this checkout; never dereference a cached machine path."""
        match = re.fullmatch(r"(ielts|toeic)/([a-z0-9-]+)/test-([1-9][0-9]*)", test_id)
        if match is None:
            raise ValueError("invalid cached test identity")
        family, book, number = match.groups()
        report = json.loads(self.report_path(family, book, int(number)).read_text(encoding="utf-8"))
        if report.get("testId") != test_id:
            raise ValueError("cached report identity mismatch")
        return report

    def write(self, t: ExtractedTest, package: Optional[dict], fp: str, batch: str) -> dict:
        status = extraction_status(t)
        pkg_path = None
        if package is not None:
            pkg_path = self.package_path(t)
            _write_json(pkg_path, package)
        report = {"testId": t.test_id, "family": t.family, "variant": t.variant, "collection": t.collection,
                  "book": t.book, "test": t.test_number, "batch": batch, "phase1Readiness": t.readiness_phase1,
                  "extractionStatus": status, "extractor": {"name": EXTRACTOR_NAME, "version": EXTRACTOR_VERSION},
                  "methods": sorted(t.extraction_methods),
                  "documents": [{"path": d.path, "sha256": d.sha256, "role": d.role, "textLayer": d.text_layer,
                                 "pages": d.page_count, **({"scope": d.scope} if d.scope else {})} for d in t.documents],
                  "package": {"path": str(pkg_path.relative_to(self.root.parents[2])).replace("\\", "/") if pkg_path else None,
                              "packageId": package["manifest"]["packageId"] if package else None,
                              "contentHash": package["manifest"]["contentHash"] if package else None},
                  "summary": summarize(t),
                  "transcripts": t.transcript_refs, "answerKeys": t.answer_key_refs,
                  "ocrMetrics": t.ocr_metrics, "ocrPages": {k: sorted(v) for k, v in t.ocr_pages.items()},
                  "reviewItems": t.review_items,
                  "diagnostics": t.diagnostics.to_list()}
        rp = self.report_path(t.family, t.book, t.test_number)
        _write_json(rp, report)
        self.runs[t.test_id] = {"fingerprint": fp,
                               "report": rp.relative_to(self.root).as_posix(),
                               "package": pkg_path.relative_to(self.root).as_posix() if pkg_path else None}
        return report

    def save(self) -> None:
        _write_json(self.runs_path, self.runs)
