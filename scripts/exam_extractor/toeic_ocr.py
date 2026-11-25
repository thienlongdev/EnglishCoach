"""Limited OCR path for scanned TOEIC books (Phase 3D sample, Batch D).

Bounded: OCR only the Reading book's Part 5 pages of test 1 and the answer-key page, within OCR_PAGE_BUDGET pages,
through the persistent OcrCache. OCR output is never authoritative on its own: Part 5 is emitted only when all 30
items parse with four options AND every item has an OCR'd key in sequence; otherwise it is omitted with
diagnostics. Mass OCR is Phase 3.5.
"""
from __future__ import annotations

import re

from .diagnostics import PROBABLE, DiagnosticLog, page_range
from .model import AnswerKey, ExtractedTest, Part, QuestionGroup, Section, SourceDocument
from .pdf_layer import split_columns
from .toeic import _parse_items, page_bands

OCR_PAGE_BUDGET = 12
_KEY_NUM = re.compile(r"^[0-9L]{3}$")
_KEY_LETTER = re.compile(r"^\(?([A-D])[)J\]]?\.?$")


def _ocr_number(tok: str):
    """'11L' -> (114, True): 'L' for '4' is the engine's known digit confusion; nothing else is repaired."""
    if not _KEY_NUM.match(tok):
        return None, False
    return int(tok.replace("L", "4")), "L" in tok


def parse_ocr_key(rows: list, first: int, last: int, log: DiagnosticLog, scope: str) -> dict:
    """'101 (B) 102 (A) ...' read in sequence. An out-of-sequence number (OCR '161' where 141 is printed) or a
    number without a letter leaves that question WITHOUT a key; nothing is inferred."""
    toks = [t.text.strip() for r in rows for t in r.tokens if t.text.strip()]
    page = rows[0].page if rows else None
    keys, expected, i = {}, first, 0
    while i < len(toks) and expected <= last:
        n, repaired = _ocr_number(toks[i])
        if n is None:
            i += 1
            continue
        letter = _KEY_LETTER.match(toks[i + 1]) if i + 1 < len(toks) else None
        if n == expected or (n > expected and n - expected <= 2):
            if letter:
                keys[n] = AnswerKey(n, [letter.group(1)], 1, PROBABLE, None, page)
                if repaired or toks[i + 1] not in ("(A)", "(B)", "(C)", "(D)"):
                    log.add("ANSWER_KEY_OCR_REPAIRED", scope, "OCR digit/bracket confusion", questions=str(n))
            expected = n + 1
        i += 2 if letter else 1
    missing = [n for n in range(first, last + 1) if n not in keys]
    if missing:
        log.add("ANSWER_KEY_MISSING_ITEM", scope, f"missing={len(missing)} (OCR)", questions=",".join(map(str, missing[:15])))
    return keys


def extract_toeic_ocr(extractor, test, t: ExtractedTest, cache) -> None:
    log = t.diagnostics
    t.variant = "STANDARD_FIXED_FORM"
    t.format_version = "TOEIC_LR_2016"
    if not cache.adapter.available():
        log.add("OCR_UNAVAILABLE", "TEST", "no OCR engine installed")
        return
    docs = [d for d in test.book_raw.get("source_documents", []) if d.get("role") == "QUESTION_BOOK"]
    rc = [d for d in docs if d.get("scope") == "READING"]
    if not rc:
        log.add("SOURCE_PDF_MISSING", "READING")
        return
    layer = extractor.layer(rc[0]["path"], log)
    if layer is None:
        return
    t.documents.append(SourceDocument(layer.rel_path, layer.sha256, rc[0]["role"], rc[0]["text_layer"], layer.page_count))
    t.extraction_methods.add("OCR")
    log.add("SECTION_OMITTED", "LISTENING", "Listening not OCR'd in the Phase 3 sample (Phase 3.5)")
    if test.test_number != 1:
        log.add("OCR_REQUIRED", "TEST", "outside the Phase 3 OCR sample")
        return
    budget, pages_used = OCR_PAGE_BUDGET, []
    p5_rows, page = [], 1
    while page <= layer.page_count and budget > 0:
        rows = cache.page_rows(layer, page, dpi=150)
        budget -= 1
        pages_used.append(page)
        if re.search(r"\bPART\s*6\b", " ".join(r.text for r in rows)):
            break
        p5_rows.extend(page_bands(layer, page, rows))
        page += 1
    key_rows, kp = [], layer.page_count
    while kp > page and budget > 0:
        rows = cache.page_rows(layer, kp, dpi=150)
        budget -= 1
        pages_used.append(kp)
        if sum(1 for r in rows for tok in r.tokens if _KEY_LETTER.match(tok.text.strip())) >= 120:
            w = layer.page_size(kp)[0]
            # the block must be explicitly headed 'TEST <n>' (a key page holds four tests); never assume position
            for col in (0, 1):
                colrows = [r for r in split_columns(rows, w) if r.column == col]
                start = next((i for i, r in enumerate(colrows)
                              if re.search(rf"\bTEST\s*{test.test_number}\b(?!\d)", r.text)), None)
                if start is None:
                    continue
                stop = next((i for i in range(start + 1, len(colrows)) if re.search(r"\bTEST\s*\d", colrows[i].text)),
                            len(colrows))
                key_rows = colrows[start + 1:stop]
                break
            if key_rows:
                break
        kp -= 1
    log.add("OCR_TEXT_USED", "READING", f"OCR pages={len(pages_used)} (budget {OCR_PAGE_BUDGET}, cached)",
            pages=page_range(pages_used))
    low = [r for r in p5_rows if r.confidence < 0.5]
    if low:
        log.add("OCR_LOW_CONFIDENCE", "READING/PART_5", f"rows below 0.5 confidence={len(low)}")
    # the key page is parsed even when the questions fail, so OCR key reliability is measured and reported
    if not key_rows:
        log.add("ANSWER_KEY_NOT_FOUND", "ANSWER_KEY/READING", "key page not located within the OCR budget")
    keys = parse_ocr_key(key_rows, 101, 200, log, "ANSWER_KEY/READING") if key_rows else {}
    t.answer_key_refs.append({"skill": "READING", "path": layer.rel_path, "sha256": layer.sha256,
                              "pages": str(kp) if key_rows else None, "keysParsed": len(keys), "keysExpected": 100,
                              "method": "OCR"})
    items = _parse_items(p5_rows, list(range(101, 131)), log, "READING/PART_5")
    if not items:
        log.add("PART_OMITTED", "READING/PART_5", "OCR structure (option letters / blanks / column merges lost)")
        return
    incomplete = False
    for it in items:
        k = keys.get(it.number)
        if k is None or k.values[0] not in [o.id for o in it.options]:
            incomplete = True
            continue
        it.key = k
    for n in (6, 7):
        log.add("PART_OMITTED", f"READING/PART_{n}", "not OCR'd in the Phase 3 sample (Phase 3.5)")
    if incomplete:
        log.add("PART_OMITTED", "READING/PART_5", "answer key (OCR) incomplete")
        return
    p = Part(code="READING_PART_5", number=5, pages=sorted({r.page for r in p5_rows}))
    p.groups.append(QuestionGroup(first=101, last=130, kind="TOEIC_PART_5", items=items,
                                  instructions=["Select the best answer to complete the sentence."]))
    t.sections.append(Section("READING", parts=[p], pages=p.pages))
    log.add("PUBLISHER_LICENCE_NOT_ESTABLISHED", "TEST", "third-party publication; publisher licence UNKNOWN / PENDING (unchanged)")
    log.add("PROJECT_USAGE_OWNER_AUTHORIZED", "TEST", "project-owner authorization 2026-10-03 (not a publisher licence)")
