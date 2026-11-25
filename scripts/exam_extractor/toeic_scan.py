"""Scanned TOEIC books through the layout-aware OCR pipeline (Exams Recovery Phase 3.5F/G/H/I).

    page render -> layout regions -> per-region OCR (lines/words, blanks by geometry) -> reading order
      -> option-label repair (constrained re-read, sequence-checked)
      -> test page identity: runs of printed question numbers (a restart at the first number = next test),
         cross-checked with the running header/footer 'TEST n'
      -> Reading: the common Phase 3 TOEIC parser (Part 5 items, Part 6/7 sets from printed set headers;
         Part 6 blanks tied to questions by geometry; Part 7 documents segmented by layout)
      -> Listening booklet: Part 1 photos mapped to their printed numbers, Part 2 printed prompt, Part 3/4
         questions; Part 3/4 SETS only from printed range headers (booklet or script) — never 39/3 arithmetic
      -> answer keys: key tables read cell by cell (key_tables.py), bound only when CONFIRMED
      -> audio: Phase 1 whole-test recording; per-Part segments only from audio_segment.py CONFIDENT splits

Collection knowledge lives in `ScanProfile` (format version, layout profile, key search window, script pages).
Budgets bound every OCR loop; a stop on budget is a BLOCKING diagnostic, never a partial silent result.
"""
from __future__ import annotations

import re
import json
from copy import deepcopy
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from typing import Optional

from .diagnostics import CONFIDENT, PROBABLE, INFO, REVIEW, DiagnosticLog, page_range
from .key_tables import read_key_page
from . import preprocess
from .layout import FIGURE, FRAME, TEXT, LayoutProfile, analyze_page, dashed_frames, furniture_text, ocr_layout
from .ocr_engine import render_region
from .media import capture_figure
from .model import (AnswerKey, ExtractedTest, Item, Option, Part, QuestionGroup, Section, SINGLE_CHOICE,
                    SourceDocument)
from .ocr_quality import (normalize_number_tokens, question_blocks, repair_option_labels, reread_blank_labels,
                          normalize_split_labels, strip_scan_furniture, structure_metrics)
from .ocr_quality import recover_stem_blanks
from .pdf_layer import Row, Token, clean_text
from .toeic import FORMATS, _norm, _parse_items, extract_reading_test, part_numbers, part_of

PART2_PRINTED = "Mark your answer on your answer sheet."
_QNUM_ROW = re.compile(r"^(\d{1,3})\s*[.,]")
_SCRIPT_SET = re.compile(r"(?:Questions?\s*)?(\d{2,3})\s*[-–—·~]\s*(\d{2,3})\s*,?\s*refers?\s+to\s+the\s+following", re.I)


@dataclass
class ScanProfile:
    book: str
    format_version: str
    layout: LayoutProfile
    key_search_last: dict = field(default_factory=lambda: {"READING": 4, "LISTENING": 4})
    key_pages: dict = field(default_factory=dict)   # explicit {skill: (first, last)} when keys precede back matter
    script_search: Optional[tuple] = None      # (first_page, last_page) of the LC script section, if printed
    page_budget: int = 72                      # pages OCR'd per test and skill (finite by construction)
    strip_furniture: bool = False              # Phase 3.6: box-border strokes / background texture (older scans)
    part6_inline_options: bool = False         # Phase 3.6: pre-2016 Part 6 prints each option block under its blank
    test_furniture: str = r"\bT\s*E\s*S\s*T\s*0?(\d{1,2})\b"
    source_hashes: dict = field(default_factory=dict)
    discovered_key_pages: dict = field(default_factory=dict)
    listening_furniture_identity: bool = False
    reading_furniture_identity: bool = False
    footer_identity_dpi: int = 300
    footer_identity_band: tuple = (0, .86, 1, .97)
    footer_identity_dual_read: bool = False
    explanation_chapter_ranges: bool = False


PROFILES = {
    "ybm-vol-1": ScanProfile("ybm-vol-1", "TOEIC_LR_2016", LayoutProfile(name="ybm-vol-1"),
                             key_search_last={"READING": 12, "LISTENING": 12}, page_budget=310,
                             source_hashes={"READING": "c79f0fdccd3b885f5624aa175225a14d75bc55cd18632d3ac0b3e9ad0b7a079b",
                                            "LISTENING": "5fb748b393ffd590f3afaa6448aee1e5510c106f584a2a8274bd9173ec5d6847"}),
    "ets-2026": ScanProfile("ets-2026", "TOEIC_LR_2016", LayoutProfile(name="ets-2026"),
                            key_search_last={"READING": 3, "LISTENING": 3},
                            page_budget=310),          # bounded complete 304-page Reading source, all ten tests
    "economy-vol-1": ScanProfile("economy-vol-1", "TOEIC_LR_PRE_2016", LayoutProfile(name="economy-vol-1"),
                                 key_search_last={"READING": 3, "LISTENING": 0},
                                 key_pages={"LISTENING": (146, 147), "READING": (271, 272)}, script_search=(148, 201),
                                 strip_furniture=True, part6_inline_options=True, page_budget=273),
    "economy-vol-2": ScanProfile("economy-vol-2", "TOEIC_LR_PRE_2016", LayoutProfile(name="economy-vol-2"),
                                 key_search_last={"READING": 4, "LISTENING": 0},
                                 key_pages={"LISTENING": (147, 148), "READING": (269, 270)}, script_search=(150, 209),
                                 strip_furniture=True, part6_inline_options=True, page_budget=272),
    "ybm-vol-2": ScanProfile("ybm-vol-2", "TOEIC_LR_2016", LayoutProfile(name="ybm-vol-2"),
                             key_search_last={"READING": 0, "LISTENING": 0},
                             key_pages={"READING": (329, 338)}, page_budget=465,
                             source_hashes={"READING": "e1546254a35cf5a15e994cd5c69449cf30f3af86787472cc6c5db59a5801cb6f",
                                            "LISTENING": "16673e093f59d6e9237c2d5745b98351fa9bdcdbe68aa0d3a97fd8ef87b5aad6"}),
    "economy-vol-4": ScanProfile("economy-vol-4", "TOEIC_LR_PRE_2016", LayoutProfile(name="economy-vol-4"),
                                 key_search_last={"READING": 0, "LISTENING": 0},
                                 key_pages={"LISTENING": (164, 165)}, script_search=(168, 241),
                                 strip_furniture=True, page_budget=244,
                                 source_hashes={"LISTENING": "8709ff85307d8a12c0e88bdf3b1ba20f3b7f4dbc979a4e7f5d1bed50bbb14647"}),
    "economy-vol-5": ScanProfile("economy-vol-5", "TOEIC_LR_PRE_2016", LayoutProfile(name="economy-vol-5"),
                                 key_search_last={"READING": 0, "LISTENING": 0},
                                 key_pages={"LISTENING": (158, 160)}, script_search=(162, 229),
                                 strip_furniture=True, page_budget=230,
                                 source_hashes={"LISTENING": "375e89fb81fbc0fbd8f6ec6164eb4342cbf4ea86cea5986c2f7de833394316af"}),
}

PROFILES["economy-vol-5"].listening_furniture_identity = True
PROFILES["economy-vol-4"].listening_furniture_identity = True
PROFILES["economy-vol-1"].reading_furniture_identity = True
PROFILES["economy-vol-1"].listening_furniture_identity = True
PROFILES["economy-vol-2"].listening_furniture_identity = True
PROFILES["ybm-vol-2"].listening_furniture_identity = True
PROFILES["ybm-vol-2"].footer_identity_dpi = 450
PROFILES["ybm-vol-2"].footer_identity_band = (.75, .92, 1, .98)
PROFILES["ybm-vol-2"].footer_identity_dual_read = True
PROFILES["ybm-vol-2"].explanation_chapter_ranges = True


class BudgetExhausted(RuntimeError):
    pass


class ScanContext:
    def __init__(self, extractor, layer, cache, profile: ScanProfile, log: DiagnosticLog, store):
        self.ex, self.layer, self.cache, self.profile, self.log, self.store = extractor, layer, cache, profile, log, store
        self.pages: dict = {}
        self.budget = profile.page_budget
        self.used: list = []

    def page(self, page: int) -> tuple:
        """(layout, rows) of one page; every page processed counts against the budget."""
        if page in self.pages:
            return self.pages[page]
        if len(self.used) >= self.budget:
            raise BudgetExhausted(f"page budget {self.budget} exhausted at page {page}")
        self.used.append(page)
        shared = getattr(self.ex, "_scan_pages", None)
        if shared is None:
            shared = self.ex._scan_pages = {}
        page_key = (self.layer.sha256, self.profile.book, page)
        if page_key in shared:
            self.pages[page] = deepcopy(shared[page_key])
            return self.pages[page]
        lay = analyze_page(self.layer, page, self.profile.layout)
        rows = ocr_layout(self.layer, lay, self.cache, self.profile.layout)
        if self.profile.strip_furniture:
            # This exact RC scan has a decorative right sidebar outside the
            # printed question columns (source pages 28/31/33). Remove detached
            # sidebar tokens by position, never by guessed English text.
            if self.layer.sha256 == "87a169d8855ad44c3d17641f9cfcc9b53e0419af6f5877845b0de3df08d2826b":
                remove_economy_sidebar(rows, lay.width)
            strip_scan_furniture(rows)
            normalize_split_labels(rows)
        recover_detached_question_headers(self.layer, rows, self.cache)
        reread_bare_question_ordinals(self.layer, rows, self.cache)
        normalize_number_tokens(rows)
        if (self.profile.book == 'ybm-vol-2' and self.layer.sha256 == self.profile.source_hashes.get('READING')):
            strip_ybm_brand_footer(rows, lay.width, lay.height)
        # running furniture that survived the band rules ('GO ON TO THE NEXT PAGE', 'TEST 1 25') is never content
        rows = [r for r in rows if not re.fullmatch(r"(GO ON TO THE NEXT PAGE.*|T\s*E\s*S\s*T\s*\d+(\s+\d+)?|"
                                                     r"\d{1,3}\s+T\s*E\s*S\s*T\s*\d+|\d{1,3})", clean_text(r.text), re.I)]
        rows = split_inline_columns(rows)
        if any(r.column == 1 for r in rows):
            # Keep the layout's proven physical columns intact across region
            # boundaries; a late left block must precede the right column.
            rows.sort(key=lambda r: (r.column, r.y0, r.x0))
        normalize_unpunctuated_questions(rows)
        repair_document_header(self, rows, page)
        restored = reread_damaged_reading_ordinals(self.layer, rows, self.cache)
        if restored:
            self.log.add('QUESTION_ORDINAL_OWN_REREAD', 'READING',
                         f'{restored} damaged prefixes restored by independent own-glyph reads',
                         pages=str(page))
        # Parsers repair labels and attach geometry to rows. Share only an untouched
        # baseline, so one test cannot change another test's input.
        shared[page_key] = deepcopy((lay, rows))
        self.pages[page] = (lay, rows)
        return lay, rows


def repair_document_header(ctx, rows, page):
    """Resolve damaged set-header punctuation only from two own-source reads."""
    from .toeic import SET_HEADER, declared_types
    for row in rows:
        original = SET_HEADER.match(_norm(row.text))
        if not original or int(original.group(1)) < 147:
            continue
        box=(max(0,row.x0-2),max(0,row.y0-2),min(ctx.layer.page_size(page)[0],row.x1+2),row.y1+2)
        readings=[]
        for prep in ('P1','P2'):
            result=ctx.cache.recognize(ctx.layer,page,box,dpi=450,pipeline=prep)
            text=clean_text(' '.join(w.text for w in result.words)) if result else ''
            match=SET_HEADER.match(_norm(text))
            if match and (match.group(1),match.group(2))==(original.group(1),original.group(2)):
                readings.append((text,[v.rstrip('.:; ') for v in declared_types(match.group(3))]))
        if (len(readings)==2 and readings[0][1]==readings[1][1]
                and len(readings[0][1]) in (2,3)
                and readings[0][1]!=declared_types(original.group(3))):
            row.tokens=[Token(readings[0][0],row.x0,row.x1)]
            ctx.log.add('SOURCE_DOCUMENT_HEADER_DUAL_READ',f'READING/PART_7/Q{original.group(1)}-{original.group(2)}',
                        'own printed document nouns agree across two independent reads',pages=str(page))


def strip_ybm_brand_footer(rows: list, width: float, height: float) -> int:
    """The hash-pinned YBM RC scan's centered footer must not extend an option."""
    keep = [r for r in rows if not (
        r.y0 >= .85 * height and r.x0 >= .30 * width and r.x1 <= .70 * width
        and re.fullmatch(r'BENZEN\s+ENGLISH\s*[-–—]?\s*TOEIC',clean_text(r.text),re.I))]
    removed = len(rows)-len(keep)
    rows[:] = keep
    return removed


def remove_economy_sidebar(rows: list, width: float) -> int:
    removed = 0
    for r in rows:
        h = max(r.y1 - r.y0, 1.0)
        keep = []
        for token in r.tokens:
            if keep and token.x0 > 0.93 * width and token.x0 - keep[-1].x1 > 6 * h:
                removed += 1
                continue
            keep.append(token)
        if keep:
            r.tokens = keep
            r.x0, r.x1 = keep[0].x0, keep[-1].x1
    return removed


def repair_economy_source_text(section, source_sha: str, test_number: int, log) -> None:
    """Exact OCR corrections proved on immutable RC PDF28/31 (evidence renders retained)."""
    if source_sha != "87a169d8855ad44c3d17641f9cfcc9b53e0419af6f5877845b0de3df08d2826b" or test_number != 2:
        return
    corrections = {
        (101, (28,), "Mr . Kurt Spienza appears to be the only person in our team who can finish the sunrvey by …… E"):
            "Mr. Kurt Spienza appears to be the only person in our team who can finish the survey by …….",
        (104, (28,), "Many companies interviewed plan to …… more personnel, while 20 percent expect to reduce their payrolls:"):
            "Many companies interviewed plan to …… more personnel, while 20 percent expect to reduce their payrolls.",
        (140, (31,), "AlI the accountants are required to compile a report which …… annual corporate spenaing:"):
            "All the accountants are required to compile a report which …… annual corporate spending.",
    }
    for item in section.items:
        corrected = corrections.get((item.number, tuple(item.pages), item.prompt))
        if corrected is not None:
            item.prompt = corrected
            log.add("SOURCE_PROVEN_TEXT_CORRECTION", "READING/PART_5", "hash-pinned source prompt correction",
                    pages=page_range(item.pages), questions=str(item.number))


def split_inline_columns(rows: list) -> list:
    """Two question columns fused into one visual row (narrow gutter bridged by the line smear): a printed
    question number in the MIDDLE of a row marks the second column's x; that row and the following rows of the
    block are split there and read left column first."""
    out, i = [], 0
    while i < len(rows):
        r = rows[i]
        cut = next((t.x0 - 2 for k, t in enumerate(r.tokens) if k > 0 and re.fullmatch(r"\d{1,3}\.", t.text)
                    and r.tokens[0].text.endswith(".") and re.fullmatch(r"\d{1,3}\.", r.tokens[0].text)), None)
        if cut is None:
            # A right-column heading can share a row with the LEFT question's
            # wrapped stem rather than its heading. Its own printed ordinal
            # must align with another independently detected question heading
            # on this page before it proposes a split.
            cut = next((t.x0-2 for k,t in enumerate(r.tokens) if k>0 and re.fullmatch(r'1\d{2}\.',t.text)
                        and t.x0-r.x0>8*max(r.y1-r.y0,1)
                        and any(o.page==r.page and _row_number(o) is not None and 101<=_row_number(o)<=200
                                and abs(o.x0-t.x0)<8 for o in rows if o is not r)),None)
        if cut is None:
            out.append(r)
            i += 1
            continue
        block = [r]
        j = i + 1
        h = max(r.y1 - r.y0, 1.0)
        initial_numbers = {int(t.text[:-1]) for t in r.tokens if re.fullmatch(r"\d{1,3}\.", t.text)}
        while j < len(rows) and rows[j].page == r.page:
            following = rows[j]
            number = _row_number(following)
            if number is not None and number not in initial_numbers:
                break
            # Region order can return to the top of the right column after all
            # left options. Single-column rows inside this same block still
            # belong to it; requiring every row to bridge the gutter loses them.
            if following.y0 < r.y0 - h or following.y0 > max(b.y1 for b in block) + 2.0 * h:
                break
            block.append(rows[j])
            j += 1
        left, right = [], []
        for b in block:
            lt = [t for t in b.tokens if t.x1 <= cut + 1]
            rt = [t for t in b.tokens if t.x0 >= cut - 1]
            if lt:
                left.append(Row(b.page, b.y0, b.y1, lt[0].x0, lt[-1].x1, lt, b.method, b.confidence, 0))
            if rt:
                right.append(Row(b.page, b.y0, b.y1, rt[0].x0, rt[-1].x1, rt, b.method, b.confidence, 1))
        out.extend(left + right)
        i = j
    return out


def _numbers(rows: list, lo: int, hi: int) -> list:
    """Printed question numbers at line starts ('117.' — the period is required: a passage line starting with
    '150 employees' is not question 150)."""
    out = []
    for r in rows:
        m = re.fullmatch(r"(\d{1,3})[.,]", r.tokens[0].text) if r.tokens else None
        if m and lo <= int(m.group(1)) <= hi:
            out.append(int(m.group(1)))
    return out


def _row_number(r) -> Optional[int]:
    m = re.fullmatch(r"(\d{1,3})[.,]", r.tokens[0].text) if r.tokens else None
    return int(m.group(1)) if m else None


def normalize_unpunctuated_questions(rows: list) -> int:
    """Bare printed ordinals require their own response prompt or following option block.

    Economy LC omits periods after question labels. A leading passage number,
    preface list, or isolated OCR digit is not a question marker.
    """
    changed = 0
    for i, row in enumerate(rows):
        if len(row.tokens) < 2 or not re.fullmatch(r"\d{1,3}", row.tokens[0].text):
            continue
        number = int(row.tokens[0].text)
        if not 1 <= number <= 200:
            continue
        prompt = " ".join(t.text for t in row.tokens[1:])
        following = rows[i + 1:i + 16]
        letters = []
        for next_row in following:
            if next_row.page != row.page or next_row.column != row.column:
                break
            text = clean_text(next_row.text)
            match = re.match(r"^\(([A-D])\)", text)
            if match:
                letters.append(match.group(1))
            elif re.match(r"^\d{1,3}[.]?\s", text) or re.match(r"^Part\s+[1-7]\b", text, re.I):
                break
        if re.match(r"Mark\s+(?:your|vour)\s+answer\b", prompt, re.I) or letters[:3] == ["A", "B", "C"]:
            row.tokens[0].text += "."
            changed += 1
    return changed


def reread_damaged_reading_ordinals(layer, rows: list, cache) -> int:
    """Reread a damaged three-glyph prefix beside its own A-D option block.

    Letter-like glyphs only propose a crop. No character substitution or next
    expected question number supplies the recovered ordinal.
    """
    changed = 0
    for i, row in enumerate(rows):
        if len(row.tokens) < 2:
            continue
        prefix = row.tokens[0]
        if (not re.fullmatch(r'[0-9A-Za-z]{3}[.,]', prefix.text)
                or re.fullmatch(r'\d{3}[.,]', prefix.text)):
            continue
        letters = []
        for following in rows[i + 1:i + 20]:
            if following.page != row.page or following.column != row.column:
                break
            text = clean_text(following.text)
            if re.match(r'^\d{1,3}[.,]\s', text):
                break
            match = re.match(r'^\(([A-D])\)', text)
            if match:
                letters.append(match.group(1))
                if len(letters) == 4:
                    break
        if letters != list('ABCD'):
            continue
        height = max(1, row.y1 - row.y0)
        if prefix.x1 - prefix.x0 > 3.5 * height:
            continue
        bbox = (max(0, prefix.x0 - 3), max(0, row.y0 - 3),
                min(row.tokens[1].x0 - 1, prefix.x1 + 3), row.y1 + 3)
        if bbox[2] <= bbox[0]:
            continue
        reads = []
        for pipeline in ('P5', 'P6'):
            result = cache.recognize(layer, row.page, bbox, dpi=600, pipeline=pipeline,
                                     allowlist='0123456789.,', boxes_pt=[bbox])
            text = ''.join(w.text for w in result.words).strip() if result else ''
            reads.append(text[:-1] if re.fullmatch(r'1\d{2}[.,]', text) else None)
        if reads[0] is None or reads[0] != reads[1]:
            continue
        number = int(reads[0])
        if not 101 <= number <= 200:
            continue
        prefix.text = str(number) + '.'
        changed += 1
    return changed


def read_ordinal_glyphs(layer, row, bbox, cache, digit_only=False):
    """Tighten an ordinal-only band to physical ink, then require three agreeing reads.

    Outlined Economy digits need whitespace around their actual ink rather than
    the detector's stem-height box. No expected ordinal is supplied to OCR.
    """
    import cv2
    import numpy as np
    # The detector row follows the smaller stem font. Economy's outlined
    # ordinal is taller; preserve its ink above/below that stem-height band.
    row_height = max(1, row.y1 - row.y0)
    bbox = (bbox[0], max(0, row.y0-row_height), bbox[2], row.y1+row_height)
    image = render_region(layer, row.page, bbox, 300)
    gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
    _, _, stats, _ = cv2.connectedComponentsWithStats((gray < 180).astype(np.uint8), connectivity=8)
    height = max(1, row.y1 - row.y0) * 300 / 72
    components = [s for s in stats[1:] if .4 * height <= s[3] <= 2.8 * height and s[4] >= 10]
    if not components:
        return None
    tallest = max(s[3] for s in components)
    if digit_only or tallest > 1.3 * height:
        components = [s for s in components if s[3] >= .65 * tallest]
    ink = (bbox[0] + min(s[0] for s in components) * 72 / 300,
           bbox[1] + min(s[1] for s in components) * 72 / 300,
           bbox[0] + max(s[0] + s[2] for s in components) * 72 / 300,
           bbox[1] + max(s[1] + s[3] for s in components) * 72 / 300)
    crop = (max(0, ink[0] - 4), max(0, ink[1] - 4), ink[2] + (.25 if digit_only else 4), ink[3] + 4)
    reads = []
    for dpi, pipeline in ((600, 'P2'), (600, 'P6'), (450, 'P2'), (450, 'P6')):
        result = cache.recognize(layer, row.page, crop, dpi=dpi, pipeline=pipeline,
                                 allowlist='0123456789', boxes_pt=[crop])
        text = ''.join(w.text for w in result.words).strip() if result else ''
        reads.append(text if re.fullmatch(r'\d{1,3}', text) else None)
    proven = {text for text in reads if text is not None and reads.count(text) >= 3
              and 1 <= int(text) <= 100}
    if not proven and not digit_only:
        # Outlined ordinals can merge with punctuation or adjacent stem ink.
        # Retry only the tallest own digit ink with a narrow right margin;
        # keep the same three-of-four independent-read requirement.
        return read_ordinal_glyphs(layer, row, bbox, cache, digit_only=True)
    return next(iter(proven)) if len(proven) == 1 else None


def recover_detached_question_headers(layer, rows: list, cache) -> int:
    """Recover a dropped ordinal when OCR turned an indented stem word into a digit.

    A column margin requires two own printed question headers. The proposed
    row is reread in full twice, and its separate margin glyph twice. Both
    printed number and stem must agree; no neighboring ordinal is predicted.
    """
    margins = {}
    for row in rows:
        if len(row.tokens) < 2 or not re.fullmatch(r'\d{1,3}[.]?', row.tokens[0].text):
            continue
        if re.match(r'^(?:What|Why|Who|Where|When|How|Which|Mark|According)\b',
                    ' '.join(t.text for t in row.tokens[1:]), re.I):
            margins.setdefault(row.column, []).append(row.tokens[0].x0)
    changed = 0
    for row in rows:
        anchors = margins.get(row.column, [])
        if len(anchors) < 2 or len(row.tokens) < 2:
            continue
        if not re.fullmatch(r'\d{1,3}[.]?', row.tokens[0].text):
            continue
        if not re.match(r'^(?:What|Why|Who|Where|When|How|Which|Mark|According|will|does|do|did|is|are|has|have)\b',
                        ' '.join(t.text for t in row.tokens[1:]), re.I):
            continue
        margin = min(anchors)
        height = max(1, row.y1 - row.y0)
        if sum(abs(x - margin) <= .5 * height for x in anchors) < 2:
            continue
        if not .8 * height < row.x0 - margin < 3.5 * height:
            continue
        bbox = (max(0, margin - 3), max(0, row.y0 - 3), row.x1 + 2, row.y1 + 3)
        readings = []
        for pipeline in ('P1', 'P2'):
            result = cache.recognize(layer, row.page, bbox, dpi=600, pipeline=pipeline)
            words = sorted(result.words, key=lambda w: w.bbox[0]) if result else []
            if len(words) < 2 or not re.fullmatch(r'\d{1,3}[.]?', words[0].text):
                readings.append(None)
                continue
            number = int(words[0].text.rstrip('.'))
            stem = clean_text(' '.join(w.text for w in words[1:]))
            if not 1 <= number <= 100 or not re.match(
                    r'^(?:What|Why|Who|Where|When|How|Which|Mark|According)\b', stem, re.I):
                readings.append(None)
                continue
            readings.append((number, stem, words))
        if readings[0] is None or readings[1] is None or readings[0][:2] != readings[1][:2]:
            continue
        number, _stem, words = readings[0]
        glyph = (max(bbox[0], words[0].bbox[0] - 1),
                 max(bbox[1], words[0].bbox[1] - 1),
                 min(words[1].bbox[0] - 1, words[0].bbox[2] + 1),
                 min(bbox[3], words[0].bbox[3] + 1))
        votes = []
        for pipeline in ('P5', 'P6'):
            own = cache.recognize(layer, row.page, glyph, dpi=600, pipeline=pipeline,
                                  allowlist='0123456789', boxes_pt=[glyph])
            text = ''.join(w.text for w in own.words) if own else ''
            votes.append(int(text) if re.fullmatch(r'\d{1,3}', text) else None)
        if votes != [number, number]:
            continue
        row.tokens = [Token(str(number) + '.', words[0].bbox[0], words[0].bbox[2])]
        row.tokens.extend(Token(w.text, w.bbox[0], w.bbox[2]) for w in words[1:])
        row.x0, row.x1 = row.tokens[0].x0, row.tokens[-1].x1
        changed += 1
    return changed


def read_split_ordinal_punctuation(layer, row, prefix, cache):
    """A digit-like OCR token can be punctuation only when its own ink proves a dot."""
    if (layer is None or len(prefix) != 2 or not re.fullmatch(r'\d{1,3}',prefix[0].text)
            or len(prefix[1].text) != 1):
        return None
    height = row.y1-row.y0
    mark = prefix[1]
    if height <= 0 or mark.x1-mark.x0 > .4*height:
        return None
    import cv2
    import numpy as np
    box = (max(0,mark.x0-.5),max(0,row.y0-1),mark.x1+.5,row.y1+1)
    image = render_region(layer,row.page,box,600)
    gray = cv2.cvtColor(image,cv2.COLOR_RGB2GRAY)
    _,_,stats,_ = cv2.connectedComponentsWithStats((gray<160).astype(np.uint8),connectivity=8)
    ink = [s for s in stats[1:] if s[4] >= 4]
    if len(ink) != 1:
        return None
    x,y,width,ink_height,area = ink[0]
    scale = 600/72
    if (not .06*height <= ink_height/scale <= .3*height
            or not .6 <= width/ink_height <= 1.6 or area/(width*ink_height) < .65
            or box[1]+y/scale < row.y0+.6*height):
        return None
    first = prefix[0]
    number_box = (max(0,first.x0-.5),max(0,row.y0-1),first.x1+.5,row.y1+1)
    reads = []
    for prep in ('P0','P2','P6'):
        result = cache.recognize(layer,row.page,number_box,dpi=600,pipeline=prep,
                                 allowlist='0123456789',boxes_pt=[number_box])
        if not result or len(result.words) != 1 or result.words[0].conf < .85:
            return None
        text = result.words[0].text.strip()
        if not re.fullmatch(r'\d{1,3}',text) or not 1 <= int(text) <= 100:
            return None
        reads.append(str(int(text)))
    return reads[0] if len(set(reads)) == 1 else None


def reread_bare_question_ordinals(layer, rows: list, cache) -> int:
    """Read a question's own printed prefix twice; never repair from sequence position."""
    changed = 0
    candidates = []
    for row in rows:
        stem_at = next((i for i, token in enumerate(row.tokens[:6]) if
                        re.match(r"^(?:What|Why|Who|Where|When|How|Which|Mark|According)\b", token.text, re.I)), None)
        if stem_at is None:
            continue
        prefix = row.tokens[:stem_at]
        if any(len(token.text) > 3 for token in prefix):
            continue
        height = max(1, row.y1 - row.y0)
        if prefix and prefix[-1].x1 - prefix[0].x0 > 5 * height:
            continue
        candidates.append((row, stem_at, prefix, height))
    margins = {}
    numeric = {}
    for row, _stem_at, _prefix, _height in candidates:
        if _prefix:
            margins[row.column] = min(margins.get(row.column, row.x0), row.x0)
            if len(_prefix) == 1 and re.fullmatch(r'\d{1,3}[.]?', _prefix[0].text):
                key = (row.column, _prefix[0].text.rstrip('.'))
                numeric[key] = numeric.get(key, 0) + 1
    for row, stem_at, prefix, height in candidates:
        if not prefix:
            # A dropped prefix needs a physically established question margin
            # in this column and visible ink in its own narrow band.
            margin = margins.get(row.column)
            if margin is None or not .6 * height <= row.x0 - margin <= 3.5 * height:
                continue
            bbox = (max(0, margin - 3), max(0, row.y0 - 3), row.x0 - 1, row.y1 + 3)
            text = read_ordinal_glyphs(layer, row, bbox, cache)
            if text:
                row.tokens = [Token(str(int(text)) + '.', margin, row.x0 - 1)] + row.tokens
                changed += 1
            continue
        # Spoken answer option labels can resemble digits. Their indented
        # column is not the question-number margin.
        if row.x0 - margins[row.column] > .8 * height:
            continue
        punctuated = read_split_ordinal_punctuation(layer,row,prefix,cache)
        if punctuated is not None:
            row.tokens = [Token(punctuated+'.',prefix[0].x0,prefix[-1].x1)] + row.tokens[stem_at:]
            changed += 1
            continue
        bbox = (max(0, prefix[0].x0 - 2), max(0, row.y0 - 2),
                min(row.tokens[stem_at].x0 - 1, prefix[-1].x1 + 2), row.y1 + 2)
        if layer is not None and not (len(prefix)==1 and re.fullmatch(r'\d{1,3}[.]?',prefix[0].text)):
            glyph = read_ordinal_glyphs(layer, row, bbox, cache)
            if glyph is not None:
                row.tokens = [Token(str(int(glyph))+'.', prefix[0].x0, prefix[-1].x1)] + row.tokens[stem_at:]
                changed += 1
                continue
        duplicate = len(prefix) == 1 and numeric.get((row.column, prefix[0].text.rstrip('.')), 0) > 1
        if duplicate:
            text = read_ordinal_glyphs(layer, row, bbox, cache)
            if text and prefix[0].text.rstrip('.') != str(int(text)):
                row.tokens = [Token(str(int(text)) + '.', prefix[0].x0, prefix[-1].x1)] + row.tokens[stem_at:]
                changed += 1
            continue
        reads = []
        for pipeline in ('P5', 'P6'):
            result = cache.recognize(layer, row.page, bbox, dpi=600, pipeline=pipeline,
                                     allowlist='0123456789', boxes_pt=[bbox])
            text = ''.join(word.text for word in result.words).strip() if result else ''
            reads.append(text if re.fullmatch(r'\d{1,3}', text) else None)
        if reads[0] is None or reads[0] != reads[1] or not 1 <= int(reads[0]) <= 100:
            # A second geometry-based crop still reads only this printed
            # prefix; three new agreeing reads are required.
            text = read_ordinal_glyphs(layer, row, bbox, cache) if layer is not None else None
            if not text:
                continue
            reads = [text, text]
        text = str(int(reads[0]))
        if len(prefix) == 1 and re.fullmatch(r'\d{1,3}[.]?', prefix[0].text) and prefix[0].text.rstrip('.') != text:
            # A conflicting already-numeric read needs a third new own-glyph
            # read, as in key-cell adjudication; no sequence-based repair.
            result = cache.recognize(layer, row.page, bbox, dpi=600, pipeline='P2',
                                     allowlist='0123456789', boxes_pt=[bbox])
            third = ''.join(word.text for word in result.words).strip() if result else ''
            if third != text:
                continue
            # The detector may already have read an outlined digit correctly
            # while all wider stem-height reads confuse it. Require agreement
            # from its physical glyph crop before replacing a numeric prefix.
            if layer is not None and read_ordinal_glyphs(layer, row, bbox, cache) != text:
                continue
        if len(prefix) != 1 or prefix[0].text != text + '.':
            row.tokens = [Token(text + '.', prefix[0].x0, prefix[-1].x1)] + row.tokens[stem_at:]
            changed += 1
    # A prefix omitted/confused by the detector can become numeric during this
    # pass. Revisit duplicate labels after all candidates have been read. A
    # duplicate proposes only its own glyph crop, never the missing number.
    counts = {}
    for row in rows:
        number = _row_number(row)
        if number is not None:
            counts[(row.column, number)] = counts.get((row.column, number), 0) + 1
    for row in rows:
        number = _row_number(row)
        if number is None or counts[(row.column, number)] < 2 or len(row.tokens) < 2:
            continue
        prefix = row.tokens[0]
        bbox = (max(0, prefix.x0 - 3), max(0, row.y0 - 4),
                min(row.tokens[1].x0 - 1, prefix.x1 + 3), row.y1 + 4)
        text = read_ordinal_glyphs(layer, row, bbox, cache) if layer is not None else None
        if text and int(text) != number:
            prefix.text = str(int(text)) + '.'
            changed += 1
    return changed


def test_pages(ctx: ScanContext, test_no: int, lo: int, hi: int, start: int = 1) -> tuple:
    """Pages of the test_no-th run of printed question numbers lo..hi (a restart = next test).

    -> (pages, numbers_seen, furniture_check) ; pages = first..last numbered page of the run (+ passage-only
    pages inside it)."""
    runs, cur, last = [], None, None
    layer = ctx.layer
    skill = 'LISTENING' if lo == 1 else 'READING'
    if (lo == 1 and ctx.profile.listening_furniture_identity) or (lo == 101 and ctx.profile.reading_furniture_identity):
        # The question book prints Actual Test n in running furniture. Read
        # that identity directly; Korean preface OCR contains stray ordinals.
        key_pages = list(ctx.profile.discovered_key_pages.get(skill, []))
        key_pages.extend(ctx.profile.key_pages.get(skill, ())[:1])
        end = min(key_pages or [layer.page_count + 1]) - 1
        end = min(end, layer.page_count)
        matches = []
        nums = []
        foreign_boundary = None
        for page in range(start, end + 1):
            lay, rows = ctx.page(page)
            # Layout analysis can classify the running footer as ordinary TEXT.
            # Read its physical band as well; no page-offset test identity.
            band = ctx.profile.footer_identity_band
            bbox = (lay.width * band[0], lay.height * band[1], lay.width * band[2], lay.height * band[3])
            footer = ctx.cache.recognize(layer, page, bbox, dpi=ctx.profile.footer_identity_dpi)
            text = ""
            if footer:
                text = " ".join(word.text for word in footer.words)
            if skill == 'READING':
                # Use the detected physical furniture region. Economy RC's
                # footer can lie below the generic Listening crop.
                text = ' '.join(furniture_text(layer, lay, ctx.cache, ctx.profile.layout).values())
            identities = {int(m.group(1)) for m in re.finditer(ctx.profile.test_furniture, text, re.I)
                          if 1 <= int(m.group(1)) <= 10}
            if ctx.profile.footer_identity_dual_read:
                corroborated = ctx.cache.recognize(layer, page, bbox, dpi=ctx.profile.footer_identity_dpi, pipeline='P2')
                second_text = ' '.join(word.text for word in corroborated.words) if corroborated else ''
                second = {int(m.group(1)) for m in re.finditer(ctx.profile.test_furniture, second_text, re.I)
                          if 1 <= int(m.group(1)) <= 10}
                if identities != second:
                    identities = set()
            if identities == {test_no}:
                matches.append(page)
            elif matches and identities and test_no not in identities:
                foreign_boundary = page
                break
        if not matches:
            return [], [], None
        pages = list(range(matches[0], matches[-1] + 1))
        if skill == 'LISTENING' and ctx.profile.book == 'ybm-vol-2':
            # A missing footer read can drop the two photo pages before the
            # identified run. Include them only through their own printed
            # photo labels and continuous coverage with the identified pages.
            expected = part_numbers(1, ctx.profile.format_version)
            current, _ = _photo_mapping(ctx, pages[:3], expected)
            leading_pages = list(range(max(start,matches[0]-2),matches[0]))
            leading, _ = _photo_mapping(ctx, leading_pages, expected)
            if (leading and current and not (set(leading) & set(current))
                    and max(leading) < min(current) and set(leading)|set(current)==set(expected)):
                pages = sorted({page for page,_ in leading.values()} | set(pages))
        # Economy RC prints its identity on alternate pages. Its first question
        # page is immediately before the first identified footer. Include that
        # page only when its own printed ordinals start the section and precede
        # all ordinals on the identified page; never infer a chapter offset.
        if skill == 'READING' and matches[0] > start:
            # A late readable footer still identifies its own numbered run.
            # Extend to that run's independently printed first question, rather
            # than assuming the first readable footer is the chapter start.
            starts=[p for p in range(start,matches[0]) if lo in _numbers(ctx.pages[p][1],lo,hi)]
            if starts:
                leading_start=starts[-1]
                first=_numbers(ctx.pages[matches[0]][1],lo,hi)
                leading=_numbers(ctx.pages[leading_start][1],lo,hi)
                if first and leading and max(leading)<min(first):
                    pages=list(range(leading_start,matches[-1]+1))
        for page in pages:
            nums.extend(_numbers(ctx.pages[page][1], lo, hi))
        # Facing pages may omit the running test title (YBM prints it on even
        # pages). Retain a trailing question page only when its own printed
        # ordinals continue beyond this proven test's last numbered page.
        # A restart/foreign footer closes the run; no chapter/page offset is used.
        last_number = max(nums, default=0)
        # A family cache can also contain answer pages read before this test.
        # Only this question window can supply a facing-page continuation.
        tail_end = foreign_boundary - 1 if foreign_boundary is not None else end
        for page in range(matches[-1] + 1, tail_end + 1):
            trailing = _numbers(ctx.pages[page][1], lo, hi)
            if not trailing:
                continue
            if last_number == 0 or min(trailing) <= last_number:
                break
            pages.append(page)
            nums.extend(trailing)
            last_number = max(trailing)
        return pages, nums, [test_no]
    for page in range(start, layer.page_count + 1):
        _lay, rows = ctx.page(page)
        nums = _numbers(rows, lo, hi)
        if not nums:
            if cur is not None:
                cur["tail"].append(page)
            continue
        if last is None or nums[0] < last - 20:
            if cur is not None:
                runs.append(cur)
                if len(runs) == test_no:
                    break
            cur = {"pages": [page], "nums": list(nums), "tail": []}
        else:
            cur["pages"].extend(cur["tail"] + [page])
            cur["tail"] = []
            cur["nums"].extend(nums)
        last = nums[-1]
    else:
        if cur is not None:
            runs.append(cur)
    if len(runs) < test_no:
        return [], [], None
    run = runs[test_no - 1]
    # furniture cross-check: running heads / footers naming another test contradict the run
    seen = set()
    for p in run["pages"]:
        lay, _rows = ctx.pages[p]
        txt = " ".join(furniture_text(layer, lay, ctx.cache, ctx.profile.layout).values())
        for m in re.finditer(ctx.profile.test_furniture, txt, re.I):
            if 1 <= int(m.group(1)) <= 10:     # page numbers fused to 'TEST n' are not test numbers
                seen.add(int(m.group(1)))
    return run["pages"], run["nums"], sorted(seen)


def key_blocks(ctx: ScanContext, skill: str, expected: range, fmt: str, test_no=None) -> dict:
    """Share a book's parsed keys, retaining independent diagnostic objects per test."""
    shared = getattr(ctx.ex, "_scan_key_blocks", None)
    if shared is None:
        shared = ctx.ex._scan_key_blocks = {}
    identity = (ctx.layer.sha256, ctx.profile.book, skill, expected.start, expected.stop, fmt)
    if identity not in shared:
        original_log = ctx.log
        ctx.log = DiagnosticLog()
        try:
            blocks = _read_key_blocks(ctx, skill, expected, fmt)
            shared[identity] = (blocks, ctx.log)
        finally:
            ctx.log = original_log
    blocks, diagnostics = deepcopy(shared[identity])
    selected=blocks.get(test_no)
    for d in diagnostics.items:
        bbox=getattr(d,'key_block_bbox',None)
        own_bound=selected is not None and bool(selected.keys())
        disjoint=own_bound and bbox is not None and (getattr(d,'key_block_page',None)!=selected.page
                 or bbox[2]<=selected.bbox[0] or selected.bbox[2]<=bbox[0]
                 or bbox[3]<=selected.bbox[1] or selected.bbox[3]<=bbox[1])
        if d.code=='ANSWER_KEY_BLOCK_UNASSIGNED' and disjoint:
            ctx.log.add('UNRELATED_KEY_BLOCK_UNASSIGNED',d.scope,
                        f'unassigned source block {bbox}; TEST {test_no} has its own disjoint key block {selected.bbox}; confirmed={len(selected.keys())}',pages=d.pages)
        else:ctx.log.items.append(d)
    return blocks


def _read_key_blocks(ctx: ScanContext, skill: str, expected: range, fmt: str) -> dict:
    """{test_no: KeyBlock} from the book's last pages (search window from the profile)."""
    n = ctx.profile.key_search_last.get(skill, 0)
    out = {}
    pages_read = []
    window = ctx.profile.key_pages.get(skill) or (max(1, ctx.layer.page_count - n + 1), ctx.layer.page_count)
    discovered = ctx.profile.discovered_key_pages.get(skill, [])
    # A partial filesystem survey augments the proven profile window. It must
    # never suppress other known key pages simply because one new page was found.
    planned_pages = sorted(set(discovered) | set(
        range(window[0], window[1] + 1) if (n or skill in ctx.profile.key_pages) else ()))
    for page in planned_pages:
        blocks = read_key_page(ctx.layer, page, ctx.cache, expected, lambda q: part_of(q, fmt))
        if blocks:
            pages_read.append(page)
        for b in blocks:
            if b.test is None:
                diagnostic=ctx.log.add("ANSWER_KEY_BLOCK_UNASSIGNED", f"ANSWER_KEY/{skill}", f"block header unreadable bbox={b.bbox}",
                                       pages=str(page))
                diagnostic.key_block_bbox=b.bbox
                diagnostic.key_block_page=page
                continue
            if b.test in out:
                ctx.log.add("ANSWER_KEY_BLOCK_UNASSIGNED", f"ANSWER_KEY/{skill}", f"TEST {b.test} printed twice",
                            pages=str(page))
                out[b.test] = None
                continue
            out[b.test] = b
    return out


def bind_table_keys(t: ExtractedTest, sec: Section, blk, skill: str, layer, fmt: str, log: DiagnosticLog) -> None:
    """Bind CONFIRMED table keys to items; report every other cell; omit parts with missing keys."""
    scope = f"ANSWER_KEY/{skill}"
    if blk is None:
        log.add("ANSWER_KEY_NOT_FOUND", scope, "no key table block for this test")
        for p in list(sec.parts):
            log.add("PART_OMITTED", f"{skill}/{p.code}", "answer key")
        sec.parts = []
        return
    keys = blk.keys()
    for d in blk.diagnostics:
        log.add(d[0], scope, d[1], pages=str(blk.page))
    statuses = {}
    for c in blk.cells:
        if c.status != "CONFIRMED" and c.predicted is not None:
            statuses.setdefault(c.status, []).append(c.predicted)
            t.review_items.append({"type": "ANSWER_KEY_CELL", "skill": skill, "question": c.predicted,
                                   "status": c.status, "source": layer.rel_path, "sha256": layer.sha256,
                                   "page": blk.page, "bbox": c.number_bbox, "letterBbox": c.letter_bbox,
                                   "reads": {"number": c.number_reads}})   # letter reads never leave the package
    code = {"LATTICE_CONFLICT": "ANSWER_KEY_LATTICE_CONFLICT", "NUMBER_UNREAD": "ANSWER_KEY_NUMBER_UNREAD",
            "LETTER_UNCERTAIN": "ANSWER_KEY_LETTER_UNCERTAIN", "LETTER_MISSING": "ANSWER_KEY_LETTER_UNCERTAIN",
            "SYNTAX_INVALID": "ANSWER_KEY_SYNTAX_INVALID", "DUPLICATE": "DUPLICATE_QUESTION_NUMBER",
            "OUT_OF_RANGE": "ANSWER_KEY_EXTRA_ITEM"}
    for st, qs in statuses.items():
        log.add(code.get(st, "ANSWER_KEY_MISSING_ITEM"), scope, f"{st} cells={len(qs)}",
                questions=",".join(map(str, sorted(qs)[:20])), pages=str(blk.page))
    t.answer_key_refs.append({"skill": skill, "path": layer.rel_path, "sha256": layer.sha256, "pages": str(blk.page),
                              "keysParsed": len(keys), "keysExpected": 100, "method": "OCR_KEY_TABLE_V1",
                              "latticeOrientation": blk.orientation, "latticeSupport": blk.lattice_support,
                              "bbox": [round(v, 1) for v in blk.bbox]})
    log.add("ANSWER_KEY_TABLE_READ", scope, f"confirmed={len(keys)} lattice={blk.orientation}", pages=str(blk.page))
    kept = []
    for p in sec.parts:
        ok = True
        for it in p.items:
            c = keys.get(it.number)
            ids = [o.id for o in it.options]
            if c is None or c.letter not in ids:
                ok = False
                continue
            it.key = AnswerKey(it.number, [c.letter], 1, CONFIDENT, None, blk.page)
            it.key.method = "OCR_KEY_TABLE_V1+REREAD" if getattr(c, "adjudicated", False) else "OCR_KEY_TABLE_V1"
        if ok:
            kept.append(p)
        else:
            missing = [it.number for it in p.items if it.key is None]
            log.add("ANSWER_KEY_MISSING_ITEM", scope, f"{p.code}: {len(missing)} without a confirmed key",
                    questions=",".join(map(str, missing[:20])))
            log.add("PART_OMITTED", f"{skill}/{p.code}", "answer key")
    sec.parts = kept


# ── Reading ─────────────────────────────────────────────────────────────────────────────────────

def extract_reading_scanned(ctx: ScanContext, t: ExtractedTest, fmt: str) -> Optional[Section]:
    log = ctx.log
    try:
        pages, nums, furn = test_pages(ctx, t.test_number, 101, 200)
    except BudgetExhausted as e:
        log.add("OCR_BUDGET_EXHAUSTED", "READING", str(e))
        return None
    if not pages:
        log.add("TEST_BOUNDARY_NOT_FOUND", "READING", "question-number run for this test not found")
        return None
    if furn and furn != [t.test_number]:
        log.add("TEST_PAGES_UNVERIFIED", "READING", f"running heads name tests {furn}", pages=page_range(pages))
    rows = [r for p in pages for r in ctx.pages[p][1]]
    a6, b6 = FORMATS[fmt][6]
    relabelled = reread_blank_labels(ctx.layer, rows, ctx.cache, a6, b6)
    blank_proofs = [r.blank_label_proof for r in rows if hasattr(r, 'blank_label_proof')]
    if relabelled:
        complete = {p['number'] for p in blank_proofs} == set(range(a6, b6 + 1)) and not any(
            getattr(r, 'blank_label_conflict', False) for r in rows)
        log.add("SOURCE_BLANK_LABELS_DUAL_READ" if complete else "OPTION_LABEL_RECOGNISED", "READING/PART_6",
                f"{relabelled} own blank labels independently re-read", severity=INFO if complete else REVIEW)
    lab = repair_option_labels(ctx.layer, question_blocks(rows, 101, 200), ctx.cache)
    recovered_blanks = recover_stem_blanks(ctx.layer, rows, *FORMATS[fmt][5])
    if recovered_blanks:
        for proven in (True,False):
            locations=[x for x in recovered_blanks if x.get('dualMask',False)==proven]
            if locations:
                log.add("SOURCE_BLANK_DUAL_MASK_PROVEN" if proven else "SOURCE_BLANK_GEOMETRY_RESTORED",
                        "READING/PART_5", "own stem dash runs recovered from source pixels",
                        severity=INFO if proven else REVIEW,
                        questions=",".join(str(x['q']) for x in locations),
                        pages=",".join(str(x['page']) for x in locations))
    if lab["labelsRecognised"]:
        locs = lab.get("locations") or []
        unresolved = {x['q'] for x in locs if not x.get('dualRead')}
        for proven, locations in [(False,[x for x in locs if x['q'] in unresolved]),
                                  (True,[x for x in locs if x['q'] not in unresolved])]:
            if locations:
                log.add("SOURCE_OPTION_LABELS_DUAL_READ" if proven else "OPTION_LABEL_RECOGNISED", "READING",
                        f"{len(locations)} own option labels re-read" + (" independently" if proven else " once"),
                        severity=INFO if proven else REVIEW,
                        questions=",".join(map(str, sorted({x['q'] for x in locations}))),
                        pages=",".join(map(str, sorted({x['page'] for x in locations}))))
    m = structure_metrics(rows, part_numbers(5, fmt), blank_required=True)
    t.ocr_metrics["READING"] = {"pages": page_range(pages), "part5": m, "labels": lab,
                              'blankLabelProofs': blank_proofs, 'stemBlankProofs': recovered_blanks}
    if m["readingOrderInversions"]:
        log.add("OCR_COLUMN_ORDER_INVERTED", "READING/PART_5", f"inversions={m['readingOrderInversions']}")
    log.add("OCR_LAYOUT_USED", "READING", f"layout-aware OCR pages={len(pages)}", pages=page_range(pages))
    log.add("OCR_TEXT_USED", "READING", "OCR text: character errors possible (human proofreading required)")
    parts = extract_reading_test(rows, log, ctx.layer, fmt)
    # Shaded forms/tables can corrupt word-box OCR and falsely create columns.
    # Reconstruct unresolved multi-document sets from their own source regions;
    # preserve each complete region as media so checkboxes/table alignment survive.
    from .toeic import SET_HEADER, ITEM_START, declared_types
    from .toeic_sets import document_regions, doc_paragraphs
    from .layout import words_to_rows
    for part in parts:
        if part.number != 7:
            continue
        for group in part.groups:
            passage = group.passage
            if not passage or len(passage.documents) < 2 or passage.document_boundaries == 'SEGMENTED':
                continue
            start = next((i for i,r in enumerate(rows) if (m := SET_HEADER.match(_norm(r.text)))
                          and int(m.group(1)) == group.first), None)
            end = next((i for i in range((start or 0)+1,len(rows))
                        if (m := ITEM_START.match(_norm(rows[i].text))) and int(m.group(1)) == group.first), None)
            if start is None or end is None:
                continue
            regions = document_regions(rows[start+1:end], {p:ctx.pages[p][0] for p in pages}, len(passage.documents))
            if regions is None:
                continue
            documents, figures = [], []
            for di,(page,box,members) in enumerate(regions):
                result = ctx.cache.recognize(ctx.layer,page,box,dpi=ctx.profile.layout.ocr_dpi,pipeline='P1')
                detected = words_to_rows(result.words,page) if result else []
                if len(detected) < 3:
                    break
                paragraphs = doc_paragraphs(detected)
                documents.append({'declaredType':declared_types(passage.title)[di],
                                  'paragraphs':paragraphs,'sourcePages':[page]})
                figures.append(capture_figure(ctx.layer,ctx.store,page,box,'PAGE_REGION'))
            if len(documents) != len(regions):
                continue
            passage.documents = documents
            passage.paragraphs = [p for d in documents for p in d['paragraphs']]
            passage.figures = figures
            passage.document_boundaries = 'SEGMENTED'
            scope = f'READING/PART_7/Q{group.first}-{group.last}'
            log.items = [d for d in log.items if not (d.code == 'LAYOUT_LINEARIZED' and d.scope == scope)]
            log.add('MULTI_DOC_SEGMENTED',scope,f'{len(documents)} complete source regions; nested frames excluded; rendered documents retained')
    # every Part 5 stem must carry its blank (geometry); a stem without one is not a reproducible sentence
    for p in parts:
        if p.number == 5:
            nob = [it.number for it in p.items if "……" not in it.prompt]
            if nob:
                log.add("BLANK_NOT_FOUND", "READING/PART_5", f"{len(nob)} stems without a blank",
                        questions=",".join(map(str, nob[:15])))
                parts = [x for x in parts if x is not p]
                log.add("PART_OMITTED", "READING/PART_5", "blank")
    if not parts:
        return None
    return Section("READING", parts=parts, pages=pages)


# ── Listening booklet ───────────────────────────────────────────────────────────────────────────

def _merge_stacked_pieces(figs: list, rows: list, page_area: float) -> list:
    """Phase 3.6: one photograph split by a light band (sky, wall) is detected as two tonal pieces. Pieces are one
    figure only when their left AND right edges coincide (<= 4 pt), the vertical gap is < 90 pt and no printed
    question number lies between them (two Part 1 photographs are always separated by their number label; texture
    inside the light band may OCR as debris, which does not separate anything)."""
    from .layout import Region
    figs = sorted(figs, key=lambda f: f.bbox[1])
    out = []
    for f in figs:
        if out:
            g = out[-1]
            gx0, gy0, gx1, gy1 = g.bbox
            x0, y0, x1, y1 = f.bbox
            # a photo's number label is printed level with its TOP edge (photo mapping: -20..+25 pt), so the
            # separating label of a second photograph lies between the pieces or just below the lower top edge
            between = [r for r in rows if gy1 - 1 <= (r.y0 + r.y1) / 2 <= y0 + 25 and r.tokens
                       and len(r.tokens) <= 2 and r.x1 <= min(gx0, x0) + 5
                       and re.fullmatch(r"\d{1,2}[.,]?", r.tokens[0].text)]   # a label LEFT of the photo column
            if abs(gx0 - x0) <= 4 and abs(gx1 - x1) <= 4 and 0 <= y0 - gy1 < 90 and not between:
                box = (min(gx0, x0), gy0, max(gx1, x1), y1)
                out[-1] = Region(g.kind, box, g.page, g.column, g.band, g.order,
                                 dict(g.meta, areaFrac=round((box[2] - box[0]) * (box[3] - box[1]) / page_area, 4),
                                      mergedPieces=g.meta.get("mergedPieces", 1) + 1))
                continue
        out.append(f)
    return out


def _photo_mapping(ctx: ScanContext, pages: list, numbers: list) -> tuple:
    """{q: (page, bbox)} for Part 1 photos: each printed number label owns the nearest figure below/right of it;
    the mapping must be one-to-one and cover every Part 1 question."""
    labels = []
    figures = []
    for p in pages:
        lay, rows = ctx.pages[p]
        figs = _merge_stacked_pieces(lay.figures(), rows, lay.width * lay.height)
        if (ctx.profile.book == 'ybm-vol-2' or ctx.profile.book.startswith('economy-vol-')) and (figs or any(r.kind == FRAME for r in lay.regions)):
            from .ocr_quality import tonal_photo_boxes
            from .layout import Region
            image = render_region(ctx.layer, p, (0, 0, lay.width, lay.height), 100)
            for box in tonal_photo_boxes(image, lay.width, lay.height):
                overlaps = [f for f in figs if min(f.bbox[2], box[2]) > max(f.bbox[0], box[0])
                            and min(f.bbox[3], box[3]) > max(f.bbox[1], box[1])]
                if overlaps:
                    figs = [f for f in figs if f not in overlaps]
                figs.append(Region(FIGURE, box, p, meta={'areaFrac':
                    (box[2]-box[0])*(box[3]-box[1])/(lay.width*lay.height), 'tonalRecovery': True}))
        figs = [f for f in figs if f.meta.get("areaFrac", 0) >= 0.05]
        if not figs:
            continue                 # numbers on pages without photographs are not Part 1 labels
        figures.extend((p, f) for f in figs)
        if ctx.profile.listening_furniture_identity or ctx.profile.book.startswith('economy-vol-'):
            for figure in figs:
                x0, y0, _x1, _y1 = figure.bbox
                bbox = (max(0, x0 - 110), max(0, y0 - 15), max(1, x0 - 3), min(lay.height, y0 + 40))
                reads = []
                for pipeline in ('P5', 'P6'):
                    result = ctx.cache.recognize(ctx.layer, p, bbox, dpi=600, pipeline=pipeline,
                                                 allowlist='0123456789')
                    words = result.words if result else []
                    reads.append(words[0] if len(words) == 1 and re.fullmatch(r'\d{1,2}', words[0].text) else None)
                if reads[0] is None or reads[1] is None or reads[0].text != reads[1].text:
                    continue
                number = int(reads[0].text)
                if number not in numbers:
                    continue
                bx0, by0, bx1, by1 = reads[0].bbox
                label = Row(p, by0, by1, bx0, bx1, [Token(str(number), bx0, bx1)], method='OCR')
                labels.append((number, p, label))
        for r in rows:
            if r.tokens and re.fullmatch(r"\d{1,2}[.,]?", r.tokens[0].text):
                q = int(re.match(r"\d+", r.tokens[0].text).group(0))
                if q in numbers and not any(n == q and page == p for n, page, _ in labels):
                    token = r.tokens[0]
                    # Page OCR can fuse the margin caption with artwork text.
                    # Read only its own digit ink, left of a unique photo, and
                    # require the existing three-of-four source-glyph proof.
                    adjacent = [f for f in figs if 3 <= f.bbox[0]-token.x1 <= 110
                                and -20 <= r.y0-f.bbox[1] <= 40]
                    if len(r.tokens)>2 or not re.fullmatch(r'\d{1,2}[.,]',token.text):
                        if len(adjacent)!=1:
                            continue
                        own=read_ordinal_glyphs(ctx.layer,r,
                            (max(0,token.x0-3),r.y0-2,min(adjacent[0].bbox[0]-3,token.x1+3),r.y1+2),
                            ctx.cache,digit_only=True)
                        if own is None or int(own) not in numbers:
                            continue
                        q=int(own)
                        token=Token(str(q),token.x0,token.x1)
                    label = Row(p,r.y0,r.y1,token.x0,token.x1,[token],r.method,r.confidence)
                    labels.append((q, p, label))
    out, used, problems = {}, set(), []
    for q, p, r in labels:
        cands = []
        for i, (fp, f) in enumerate(figures):
            if fp != p:
                continue
            x0, y0, x1, y1 = f.bbox
            # the printed number sits just left of the photo, level with its top edge
            gap = x0 - r.x1
            dy = r.y0 - y0
            if -10 <= gap <= 110 and -20 <= dy <= 40:
                cands.append((abs(dy) + 0.2 * abs(gap), i))
        if not cands:
            # A bare number in artwork or page furniture is not a photo label
            # unless it is beside a figure. Required questions without a real
            # association still fail the final coverage check below.
            continue
        cands.sort()
        if len(cands) > 1 and cands[1][0] - cands[0][0] < 5:
            problems.append(f"Q{q}: two photos equally close")
            continue
        i = cands[0][1]
        if i in used or q in out:
            problems.append(f"Q{q}: photo already mapped")
            continue
        used.add(i)
        out[q] = figures[i]
    missing = [q for q in numbers if q not in out]
    if missing:
        problems.append(f"unmapped {missing}")
    return out, problems


_GRAPHIC_REF = re.compile(r"\bgraph\s*ic\b", re.I)


def _graphic_regions(ctx: ScanContext, pages: list) -> list:
    """[(page, bbox)] of printed graphics on Listening pages: FIGURE regions and FRAME regions that are not the
    directions box (a frame whose own rows read 'Directions' / 'PART n'), plus (Phase 5B) graphics with a
    DASHED border (coupons), which the frame test cannot see; a figure inside a dashed box is part of it."""
    out = []
    for p in pages:
        lay, rows = ctx.pages[p]

        def directions(bbox):
            x0, y0, x1, y1 = bbox
            inside = [r for r in rows if x0 - 2 <= (r.x0 + r.x1) / 2 <= x1 + 2 and y0 - 2 <= (r.y0 + r.y1) / 2 <= y1 + 2]
            return re.search(r"Directions|\bPART\s*\d", " ".join(clean_text(r.text) for r in inside), re.I)

        def has_question(bbox):
            x0, y0, x1, y1 = bbox
            return any(_row_number(r) is not None and x0 - 2 <= (r.x0 + r.x1) / 2 <= x1 + 2
                       and y0 - 2 <= (r.y0 + r.y1) / 2 <= y1 + 2 for r in rows)

        dashed = [b for b in _dashed_boxes(ctx, p) if not directions(b)]
        cands = [reg.bbox for reg in lay.regions if reg.kind in (FIGURE, FRAME) and not directions(reg.bbox)] + dashed
        for b in cands:
            x0, y0, x1, y1 = b
            # Phase 5B: a drawing / frame nested inside another graphic (its printed border, a dashed coupon) is
            # part of that graphic, provided the container holds no printed question
            if any(c is not b and c[0] - 2 <= x0 and x1 <= c[2] + 2 and c[1] - 2 <= y0 and y1 <= c[3] + 2
                   and (c[2] - c[0]) * (c[3] - c[1]) > (x1 - x0) * (y1 - y0) and not has_question(c) for c in cands):
                continue
            if b in dashed:
                ctx.log.add("GRAPHIC_DASHED_FRAME", "LISTENING", "graphic delimited by a dashed border", pages=str(p))
            out.append((p, b))
    merged = []
    for page, box in out:
        x0,y0,x1,y1 = box
        for i,(other_page,other) in enumerate(merged):
            if page != other_page:
                continue
            a0,b0,a1,b1 = other
            overlap = max(0,min(x1,a1)-max(x0,a0))*max(0,min(y1,b1)-max(y0,b0))
            smaller = min((x1-x0)*(y1-y0),(a1-a0)*(b1-b0))
            if smaller > 0 and overlap/smaller >= .85:
                merged[i] = (page,(min(x0,a0),min(y0,b0),max(x1,a1),max(y1,b1)))
                break
        else:
            merged.append((page,box))
    return merged


def _dashed_boxes(ctx: ScanContext, page: int) -> list:
    """Dashed-border rectangles of one page in points (rendered at the layout analysis resolution; cached)."""
    cache = ctx.__dict__.setdefault("_dashed", {})
    if page not in cache:
        w, h = ctx.layer.page_size(page)
        dpi = ctx.profile.layout.analysis_dpi
        mask = preprocess.ink_mask(preprocess.to_gray(render_region(ctx.layer, page, (0, 0, w, h), dpi=dpi)))
        k = 72.0 / dpi
        cache[page] = [(x0 * k, y0 * k, x1 * k, y1 * k) for x0, y0, x1, y1 in dashed_frames(mask)]
        # Fine dotted / rounded map borders fragment into glyph-sized ink.
        # Require the border lattice to enclose almost the entire source TEXT
        # region; the region supplies the complete artwork bounds, including
        # rounded corners and captions. A few dots in prose cannot suffice.
        dotted = [tuple(v * k for v in b) for b in dashed_frames(mask, dotted=True)]
        lay, rows = ctx.pages[page]
        for reg in lay.regions:
            if reg.kind != TEXT:
                continue
            x0, y0, x1, y1 = reg.bbox
            area = (x1-x0)*(y1-y0)
            if x1-x0 < 100 or y1-y0 < 60:
                continue
            if any(_row_number(r) is not None and x0 <= (r.x0+r.x1)/2 <= x1
                   and y0 <= (r.y0+r.y1)/2 <= y1 for r in rows):
                continue
            matches = [b for b in dotted if
                       max(0,min(x1,b[2])-max(x0,b[0])) * max(0,min(y1,b[3])-max(y0,b[1])) >= .85*area]
            if matches:
                box = (max(0,min([x0]+[b[0] for b in matches])-2),
                       max(0,min([y0]+[b[1] for b in matches])-2),
                       min(w,max([x1]+[b[2] for b in matches])+2),
                       min(h,max([y1]+[b[3] for b in matches])+2))
                cache[page].append(box)
    return cache[page]


def _inside_graphic(r, graphics: list) -> bool:
    """A row printed inside a graphic (coupon / table / map) is part of the visual, never question text."""
    cx, cy = (r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2
    return any(p == r.page and x0 - 2 <= cx <= x1 + 2 and y0 - 2 <= cy <= y1 + 2 for p, (x0, y0, x1, y1) in graphics)


def _graphic_for_set(first_row, graphics: list, rows_part: list) -> tuple:
    """The printed graphic DIRECTLY above a set's first printed question (same page, same column, no other
    question of the part in between). -> ((page, bbox) or None, problem)."""
    cands = []
    for p, (x0, y0, x1, y1) in graphics:
        if p != first_row.page or y1 > first_row.y0 + 2 or first_row.y0 - y1 > 60:
            continue
        if not (x0 < first_row.x0 + 230 and x1 > first_row.x0 - 10):
            continue
        between = [r for r in rows_part if r.page == p and _row_number(r) is not None and y1 < r.y0 < first_row.y0
                   and x0 - 20 < r.x0 < x1]
        if not between:
            cands.append((first_row.y0 - y1, (p, (x0, y0, x1, y1))))
    if len(cands) != 1:
        if not cands:
            # A lightly printed coupon may have no detected rectangle. Its
            # complete table can still occupy the top of the question column.
            # Require a unique column body, two printed numeric data rows and
            # no preceding question; never crop through another question.
            above = [r for r in rows_part if r.page == first_row.page
                     and r.column == first_row.column and r.y1 < first_row.y0
                     and first_row.x0-20 <= (r.x0+r.x1)/2 <= first_row.x0+230]
            if (len(above)>=4 and not any(_row_number(r) is not None for r in above)
                    and sum(bool(re.search(r'(?:\$\s*\d|\d\s*%|\d{1,2}:\d{2})',r.text)) for r in above)>=2
                    and not any(re.search(r'Directions|\bPART\s*\d',r.text,re.I) for r in above)):
                box=(max(0,min(r.x0 for r in above)-2),max(0,min(r.y0 for r in above)-2),
                     max(r.x1 for r in above)+2,max(r.y1 for r in above)+2)
                return (first_row.page,box),None
        return None, f"{len(cands)} graphics directly above the set"
    return cands[0][1], None


def extract_listening_scanned(ctx: ScanContext, t: ExtractedTest, fmt: str, script_groups: Optional[dict],
                              audio_groups: Optional[dict] = None) -> Optional[Section]:
    log = ctx.log
    try:
        pages, nums, furn = test_pages(ctx, t.test_number, 1, 100)
    except BudgetExhausted as e:
        log.add("OCR_BUDGET_EXHAUSTED", "LISTENING", str(e))
        return None
    if not pages:
        log.add("TEST_BOUNDARY_NOT_FOUND", "LISTENING", "question-number run for this test not found")
        return None
    if furn and furn != [t.test_number]:
        log.add("TEST_PAGES_UNVERIFIED", "LISTENING", f"running heads name tests {furn}", pages=page_range(pages))
    log.add("OCR_LAYOUT_USED", "LISTENING", f"layout-aware OCR pages={len(pages)}", pages=page_range(pages))
    rows = [r for p in pages for r in ctx.pages[p][1]]
    parts = []
    # Part 1 — photographs ------------------------------------------------------------------------
    p1 = part_numbers(1, fmt)
    mapping, problems = _photo_mapping(ctx, pages, p1)
    if problems:
        log.add("PHOTO_MAPPING_UNPROVEN", "LISTENING/PART_1", "; ".join(problems)[:190])
        for pr in problems:
            t.review_items.append({"type": "PART1_PHOTO", "detail": pr, "source": ctx.layer.rel_path,
                                   "sha256": ctx.layer.sha256, "pages": page_range(pages)})
        log.add("PART_OMITTED", "LISTENING/PART_1", "photo mapping")
    else:
        part = Part(code="LISTENING_PART_1", number=1, pages=sorted({pg for pg, _f in mapping.values()}))
        for q in p1:
            pg, f = mapping[q]
            fig = capture_figure(ctx.layer, ctx.store, pg, f.bbox, "PAGE_REGION")
            it = Item(number=q, prompt=f"Look at the picture marked number {q} in your test book.",
                      interaction=SINGLE_CHOICE, options=[Option(x, x) for x in "ABCD"], pages=[pg])
            g = QuestionGroup(first=q, last=q, kind="TOEIC_PART_1", items=[it], pages=[pg],
                              instructions=["Part 1 photograph"])
            g.figure = fig
            part.groups.append(g)
            t.review_items.append({"type": "PART1_PHOTO_CROP", "question": q, "source": ctx.layer.rel_path,
                                   "sha256": ctx.layer.sha256, "page": pg, "bbox": [round(v, 1) for v in f.bbox],
                                   "cropSha256": fig.sha256, "reviewState": "PENDING"})
        log.add("PHOTO_MAPPED", "LISTENING/PART_1", f"{len(mapping)} photos mapped to printed numbers (crops need QA)")
        log.add("PROMPT_FORMAT_STANDARD", "LISTENING/PART_1",
                "Part 1 prompt = the format's spoken instruction (no printed stem exists); options are spoken")
        parts.append(part)
    # Part 2 — printed 'Mark your answer…' -------------------------------------------------------------
    p2 = part_numbers(2, fmt)
    found = {}
    printed_p2_counts = {}
    for r in rows:
        match = re.match(r"^(\d{1,2})[.,]\s*(.*)$", clean_text(r.text))
        if match and SequenceMatcher(None, match.group(2).lower(), PART2_PRINTED.lower()).ratio() >= .8:
            n = int(match.group(1))
            printed_p2_counts[n] = printed_p2_counts.get(n, 0) + 1
    for r in rows:
        mm = re.match(r"^(\d{1,2})[.,]\s*(.*)$", clean_text(r.text))
        if (mm and (int(mm.group(1)) not in p2 or printed_p2_counts.get(int(mm.group(1)), 0) > 1) and len(r.tokens)>1
                and SequenceMatcher(None, mm.group(2).lower(), PART2_PRINTED.lower()).ratio() >= .8):
            prefix=r.tokens[0]
            # Include the entire own numeral band. A duplicate is only a reason
            # to reread; three independent glyph reads still supply the number.
            bbox=(max(0,prefix.x0-3),r.y0-3,r.tokens[1].x0-1,r.y1+3)
            own=read_ordinal_glyphs(ctx.layer,r,bbox,ctx.cache,digit_only=True)
            if own is None:
                own=read_ordinal_glyphs(ctx.layer,r,bbox,ctx.cache)
            if own and int(own) in p2:
                prefix.text=own+'.'
                mm=re.match(r"^(\d{1,2})[.,]\s*(.*)$",clean_text(r.text))
                log.add('QUESTION_ORDINAL_OWN_REREAD','LISTENING/PART_2',
                        'printed ordinal recovered from digit-only ink crop',questions=own,pages=str(r.page))
        if mm and int(mm.group(1)) in p2:
            found.setdefault(int(mm.group(1)), mm.group(2))
    if sorted(found) == p2:
        part = Part(code="LISTENING_PART_2", number=2, pages=[])
        g = QuestionGroup(first=p2[0], last=p2[-1], kind="TOEIC_PART_2", instructions=["Part 2"])
        unprinted = 0
        for q in p2:
            printed = found[q]
            same = SequenceMatcher(None, printed.lower(), PART2_PRINTED.lower()).ratio() >= 0.8
            if printed and not same:
                prompt = printed               # some other printed text: kept as printed
            else:
                prompt = PART2_PRINTED         # the printed sentence (OCR noise removed) or the format's own text
                unprinted += 0 if same else 1
            g.items.append(Item(number=q, prompt=prompt, interaction=SINGLE_CHOICE,
                                options=[Option(x, x) for x in "ABC"]))
        if unprinted:
            log.add("PROMPT_FORMAT_STANDARD", "LISTENING/PART_2",
                    f"{unprinted} items print only their number: prompt = the format's standard Part 2 sentence")
        part.groups.append(g)
        parts.append(part)
    else:
        log.add("QUESTION_NUMBER_GAP", "LISTENING/PART_2", f"found {len(found)}/{len(p2)}",
                questions=",".join(str(q) for q in p2 if q not in found)[:100])
        log.add("PART_OMITTED", "LISTENING/PART_2", "structure")
    # Parts 3 / 4 — printed questions; sets only from printed script range headers or SPOKEN announcements
    # corroborated by the answer-pause rhythm (never from 39/3 arithmetic) ------------------------------
    graphics = _graphic_regions(ctx, pages)
    # rows printed inside a DASHED graphic (Phase 5B) are the graphic's own text, never question text; solid
    # frames are already excluded by their 'frame' mark
    dashed_graphics = [g for g in graphics if g[1] in _dashed_boxes(ctx, g[0])]
    for pn in (3, 4):
        nums_p = part_numbers(pn, fmt)
        scope = f"LISTENING/PART_{pn}"
        # rows of this part only: from its first printed number to the next part's first printed number; rows of
        # printed graphics (tables / maps in frames) are visuals, never question text
        start = next((i for i, r in enumerate(rows) if _row_number(r) == nums_p[0]), None)
        nxt = nums_p[-1] + 1
        end = next((i for i, r in enumerate(rows) if start is not None and i > start and _row_number(r) == nxt), len(rows))
        block_rows = [r for r in (rows[start:end] if start is not None else []) if getattr(r, "frame", None) is None
                      and not _inside_graphic(r, dashed_graphics)]
        items = _parse_items(block_rows, nums_p, log, scope, empty_stem_ok=False)
        if items is None:
            log.add("PART_OMITTED", scope, "structure")
            continue
        sets, source = choose_proven_set_ranges((script_groups or {}).get(pn),
                                                (audio_groups or {}).get(pn), nums_p)
        if not sets:
            reason = ("printed and spoken set ranges conflict" if source == "CONFLICT" else
                      (audio_groups or {}).get(f"{pn}_detail") or "no printed set ranges in the booklet or script")
            log.add("GROUP_BOUNDARY_UNPROVEN", scope, f"{len(items)} questions recovered; {reason}"[:190])
            t.ocr_metrics.setdefault("LISTENING", {})[f"part{pn}QuestionsRecovered"] = len(items)
            log.add("PART_OMITTED", scope, "set boundaries")
            continue
        covered = [q for a, b in sets for q in range(a, b + 1)]
        if covered != nums_p:
            log.add("QUESTION_RANGE_MISMATCH", scope, f"{source.lower()} ranges cover {len(covered)} of {len(nums_p)}")
            log.add("PART_OMITTED", scope, "set boundaries")
            continue
        part = Part(code=f"LISTENING_PART_{pn}", number=pn, pages=sorted({pg for it in items for pg in it.pages}))
        by_n = {it.number: it for it in items}
        first_rows = {}
        for r in block_rows:
            q = _row_number(r)
            if q in by_n and q not in first_rows:
                first_rows[q] = r
        ok = True
        for a, b in sets:
            g = QuestionGroup(first=a, last=b, kind=f"TOEIC_PART_{pn}", items=[by_n[q] for q in range(a, b + 1)],
                              instructions=[f"Questions {a}-{b}"])
            if any(_GRAPHIC_REF.search(by_n[q].prompt) for q in range(a, b + 1)):
                # 'Look at the graphic': the set needs its printed graphic, bound by geometry only
                if a in first_rows:
                    hit, problem = _graphic_for_set(first_rows[a], graphics, block_rows)
                else:
                    hit, problem = None, "first question row not found"
                if hit is None:
                    log.add("GRAPHIC_NOT_BOUND", f"{scope}/Q{a}-{b}", problem)
                    t.review_items.append({"type": "PART34_GRAPHIC", "questions": f"{a}-{b}", "detail": problem,
                                           "source": ctx.layer.rel_path, "sha256": ctx.layer.sha256,
                                           "pages": page_range(pages)})
                    ok = False
                    break
                pg, bbox = hit
                g.figure = capture_figure(ctx.layer, ctx.store, pg, bbox, "PAGE_REGION")
                g.pages = [pg]
                t.review_items.append({"type": "PART34_GRAPHIC_CROP", "questions": f"{a}-{b}",
                                       "source": ctx.layer.rel_path, "sha256": ctx.layer.sha256, "page": pg,
                                       "bbox": [round(v, 1) for v in bbox], "cropSha256": g.figure.sha256,
                                       "reviewState": "PENDING"})
            part.groups.append(g)
        if not ok:
            log.add("PART_OMITTED", scope, "graphic")
            continue
        if source == "SCRIPT":
            log.add("GROUP_BOUNDARY_FROM_SCRIPT", scope, f"{len(sets)} sets from printed script range headers")
        else:
            log.add("GROUP_BOUNDARY_FROM_AUDIO", scope, (audio_groups or {}).get(f"{pn}_detail") or f"{len(sets)} sets")
        nfig = sum(1 for g in part.groups if g.figure is not None)
        if nfig:
            log.add("GRAPHIC_BOUND", scope, f"{nfig} printed graphics bound to their sets by geometry (crops need QA)")
        parts.append(part)
    if not parts:
        return None
    return Section("LISTENING", parts=parts, pages=pages)


def choose_proven_set_ranges(script, audio, numbers):
    """A complete spoken proof may supplement incomplete agreeing printed headers.

    `audio` already requires all spoken ranges and their own answer pauses.
    A contradictory printed header is never overridden.
    """
    if script and audio and any(tuple(pair) not in [tuple(p) for p in audio] for pair in script):
        return None, 'CONFLICT'
    def complete(ranges):
        return ranges and [q for a, b in ranges for q in range(a, b + 1)] == numbers
    if complete(script):
        return script, 'SCRIPT'
    if complete(audio):
        return audio, 'AUDIO'
    return (script, 'SCRIPT') if script else (None, 'AUDIO')


def script_set_ranges(ctx: ScanContext, test_no: int, fmt: str) -> Optional[dict]:
    """Printed 'NN-NN refer to the following conversation/talk' headers of this test's script pages."""
    if ctx.profile.explanation_chapter_ranges:
        from .script_ranges import explanation_ranges
        blocks = key_blocks(ctx, 'LISTENING', range(1, 101), fmt)
        return explanation_ranges(ctx, test_no, fmt, blocks)
    if not ctx.profile.script_search:
        return None
    a, b = ctx.profile.script_search
    # this test's script = the test_no-th run of increasing set headers; scanning stops once it is complete
    runs, cur = [], []
    for page in range(a, b + 1):
        _lay, rows = ctx.page(page)
        for r in rows:
            m = _SCRIPT_SET.search(clean_text(r.text))
            if not m:
                continue
            x, y = int(m.group(1)), int(m.group(2))
            if cur and x < cur[-1][1]:
                runs.append(cur)
                cur = []
            cur.append((page, x, y))
        if len(runs) >= test_no:
            break
    if cur and len(runs) < test_no:
        runs.append(cur)
    if len(runs) < test_no:
        return None
    out = {}
    for _p, x, y in runs[test_no - 1]:
        out.setdefault(part_of(x, fmt), []).append((x, y))
    return out


# ── entry point ────────────────────────────────────────────────────────────────────────────────

def extract_toeic_scanned(extractor, test, t: ExtractedTest, cache) -> None:
    log = t.diagnostics
    prof = PROFILES.get(test.book)
    t.variant = "STANDARD_FIXED_FORM"
    if prof is None:
        log.add("OCR_REQUIRED", "TEST", "no Phase 3.5 scan profile for this book (outside the target batch)")
        return
    fmt = prof.format_version
    t.format_version = fmt
    if not cache.engine.available():
        log.add("OCR_UNAVAILABLE", "TEST", "no OCR engine installed")
        return
    docs = [d for d in test.book_raw.get("source_documents", []) if d.get("role") == "QUESTION_BOOK"]
    discovered = getattr(extractor, "family_filesystem_sources", {}).get(test.book, [])
    for candidate in discovered:
        if (candidate['roleCandidate'] != 'PDF_CANDIDATE' or 'path' not in candidate
                or candidate['testCandidate'] not in (None, test.test_number)
                or candidate['scopeCandidate'] not in ('LISTENING', 'READING')):
            continue
        if any(d.get('sha256') == candidate['sha256'] or d['path'] == candidate['path'] for d in docs):
            continue
        docs.append({'path': candidate['path'], 'sha256': candidate['sha256'], 'role': 'QUESTION_BOOK',
                     'scope': candidate['scopeCandidate'], 'text_layer': 'SCANNED'})
    by_scope = {}
    for skill in ('LISTENING', 'READING'):
        choices = [d for d in docs if d.get('scope') == skill]
        if len(choices) == 1:
            by_scope[skill] = choices[0]
        elif choices:
            log.add('SOURCE_PAGE_RANGE_UNCERTAIN', skill, 'multiple filesystem question candidates; identity must be proven')
    t.extraction_methods.add("OCR")
    for skill in getattr(extractor, "toeic_skills", ("LISTENING", "READING")):
        d = by_scope.get(skill)
        if d is None:
            log.add("SOURCE_PDF_MISSING", skill, f"no {skill.lower()} question book in this collection")
            continue
        layer = extractor.layer(d["path"], log, skill)
        if layer is None:
            continue
        if prof.source_hashes.get(skill) and prof.source_hashes[skill] != layer.sha256:
            log.add("SOURCE_PAGE_RANGE_UNCERTAIN", skill, "scan profile does not cover this source hash")
            continue
        # Actual-file back-matter discovery augments static profiles by source
        # hash. It never accepts a marker/filename as an answer proof: every
        # proposed page is parsed again through the cell proof gate below.
        for name in (f'{test.collection}-back-matter.json', f'{test.collection}-key-candidates.json'):
            survey = extractor.staging / 'phase-b' / name
            if not survey.exists():
                continue
            for source in json.loads(survey.read_text(encoding='utf-8')).get('sources', []):
                if source.get('sha256') == layer.sha256:
                    from .source_index import compact_key_grid_candidate
                    survey_cache = extractor.__dict__.setdefault('_scan_survey_pages', {})
                    survey_key = (str(survey), layer.sha256, skill)
                    if survey_key not in survey_cache:
                        tables = [k for k in source.get('keyTables', []) if k['scope'] == skill]
                        # A complete ten-test table survey already supplies every
                        # source key window. Re-reading navigation markers cannot
                        # add another identity; table cells are still proven below.
                        complete = {k.get('test') for k in tables} == set(range(1, 11))
                        proposed = set() if complete else {m['page'] for m in source.get('markers', [])
                                    if 'TEST_HEADER' in m['markers'] and 'SCORE_CONVERSION' not in m['markers']
                                    and compact_key_grid_candidate(layer, m['page'])}
                        survey_cache[survey_key] = sorted(proposed | {k['page'] for k in tables})
                    pages = survey_cache[survey_key]
                    if pages:
                        prof = deepcopy(prof)
                        prof.discovered_key_pages[skill] = sorted(set(pages) | set(prof.discovered_key_pages.get(skill, [])))
        t.documents.append(SourceDocument(layer.rel_path, layer.sha256, d["role"], d.get("text_layer", "?"),
                                          layer.page_count, skill))
        ctx = ScanContext(extractor, layer, cache, prof, log, extractor.store)
        lo, hi = (1, 100) if skill == "LISTENING" else (101, 200)
        if skill == "READING":
            sec = extract_reading_scanned(ctx, t, fmt)
        else:
            groups = None
            if prof.script_search or prof.explanation_chapter_ranges:
                try:
                    groups = script_set_ranges(ctx, t.test_number, fmt)
                except BudgetExhausted as e:
                    log.add("OCR_BUDGET_EXHAUSTED", "LISTENING", f"script pages: {e}")
            audio_groups = announced_part_sets(extractor, test, fmt, log)
            sec = extract_listening_scanned(ctx, t, fmt, groups, audio_groups)
        blocks = key_blocks(ctx, skill, range(lo, hi + 1), fmt, t.test_number)
        if sec is not None:
            if skill == "READING":
                repair_economy_source_text(sec, layer.sha256, t.test_number, log)
            bind_table_keys(t, sec, blocks.get(t.test_number), skill, layer, fmt, log)
            if (skill == 'READING' and test.book == 'ybm-vol-2'
                    and blocks.get(t.test_number) is not None
                    and set(blocks[t.test_number].keys()) == set(range(101, 201))
                    and not complete_reading_section(sec, fmt)):
                counts = {p.number: len(p.items) for p in sec.parts}
                log.add('READING_EXTRACTION_INCOMPLETE', skill,
                        f'proven keys101-200 require all Reading parts; counts={counts}')
            if sec.parts:
                t.sections.append(sec)
            else:
                log.add("SECTION_OMITTED", skill, "no complete part")
        else:
            log.add("SECTION_OMITTED", skill, "structure")
            blk = blocks.get(t.test_number)
            if blk is not None:   # keys recovered even when the questions are not (measured + reported)
                t.answer_key_refs.append({"skill": skill, "path": layer.rel_path, "sha256": layer.sha256,
                                          "pages": str(blk.page), "keysParsed": len(blk.keys()),
                                          "keysExpected": 100, "method": "OCR_KEY_TABLE_V1",
                                          "latticeOrientation": blk.orientation,
                                          "latticeSupport": blk.lattice_support})
        t.ocr_pages.setdefault(layer.rel_path, set()).update(ctx.used)
    if t.sections:
        _bind_whole_test_audio(extractor, test, t)
    log.add("PUBLISHER_LICENCE_NOT_ESTABLISHED", "TEST", "third-party publication; publisher licence UNKNOWN / PENDING (unchanged)")
    log.add("PROJECT_USAGE_OWNER_AUTHORIZED", "TEST", "project-owner authorization 2026-10-03 (not a publisher licence)")


def complete_reading_section(section, fmt: str) -> bool:
    """Full source keys require every printed question, key and passage attachment."""
    if sorted(p.number for p in section.parts) != [5, 6, 7]:
        return False
    for part in section.parts:
        if [i.number for i in part.items] != part_numbers(part.number, fmt):
            return False
        if any(i.key is None for i in part.items):
            return False
        if part.number in (6, 7) and any(not getattr(g, 'passage', None)
                                       or not g.passage.text().strip() for g in part.groups):
            return False
    return True


def announced_part_sets(extractor, test, fmt: str, log: DiagnosticLog) -> dict:
    """{3: [(a, b)...], 4: [...], '3_detail': str, ...} from the recording's spoken set announcements (asr_cues.py),
    corroborated by its answer-pause rhythm (audio_segment.py analysis). Reads caches only (the analysis is run
    by `audio-analyze`); never creates a set that was not announced."""
    import json
    from .asr_cues import announced_sets
    from .audio_segment import TOEIC_ITEMS
    from .corpus import companion_matches, raw_abs
    whole = [a for a in test.raw.get("audio", []) if (a.get("scope") or "").startswith("WHOLE")]
    if len(whole) != 1 or whole[0].get("archive_member"):
        return {}
    sha = extractor.hashes.sha256(raw_abs(whole[0]["source"]))
    ana_p = extractor.staging / "audio_segments" / f"{sha}.json"
    cue_p = extractor.staging / "cache" / "asr_cues" / f"{sha}.json"
    if not ana_p.exists() or not cue_p.exists():
        log.add("AUDIO_CUES_NOT_ANALYZED", "LISTENING", "run audio-analyze for this recording (spoken structure cues)")
        return {}
    ana = json.loads(ana_p.read_text(encoding="utf-8"))
    cues = json.loads(cue_p.read_text(encoding="utf-8")).get("cues", [])
    if ana.get("parentSha256") != sha or ana.get("format") != fmt or fmt not in TOEIC_ITEMS:
        return {}
    ok, why = companion_matches(test, {"book": test.book, "testNumber": test.test_number, "path": ana.get("parentPath")})
    if not ok:
        log.add("CROSS_SOURCE_BINDING_REJECTED", "LISTENING", f"recording analysis: {why}")
        return {}
    longp = [(a, d) for a, d, c in ana.get("answerPauses", []) if c == "LONG"]
    b34 = next((b.get("atS") for b in ana.get("boundaries", []) if b.get("between") == "3|4"
                and b.get("tier") == "CONFIDENT"), None)
    out = {}
    for pn in (3, 4):
        lo, hi = FORMATS[fmt][pn]
        end = b34 if pn == 3 else ana.get("durationS")
        if end is None:
            out[f"{pn}_detail"] = "Part 3|4 boundary not CONFIDENT (end of Part 3 unknown)"
            continue
        sets, detail = announced_sets(cues, lo, hi, longp, end)
        out[f"{pn}_detail"] = detail
        if sets:
            out[pn] = [(a, b) for a, b, _t in sets]
    return out


def _bind_whole_test_audio(extractor, test, t: ExtractedTest) -> None:
    """Phase 1 whole-test recording: bound once (to the first Listening part) unless CONFIDENT per-Part segments
    exist; segments come only from audio_segment.py and are never guessed here."""
    from .audio_segment import confident_part_segments
    from .media import bind_audio
    sec = t.section("LISTENING")
    if sec is None or not sec.parts:
        return
    log = t.diagnostics
    bindings = bind_audio(test.raw, "TOEIC", extractor.hashes, log)
    for p in sec.parts:
        candidates = [b for b in bindings if b.scope == 'PART' and b.part == p.number
                      and b.confidence == CONFIDENT and b.technical_qa.get('hashVerified')
                      and b.technical_qa.get('decodable') and b.technical_qa.get('durationAgrees')]
        if len(candidates) == 1:
            p.audio = candidates
            t.audio.extend(candidates)
            log.add('SOURCE_AUDIO_PART_BOUND', f'LISTENING/{p.code}', 'verified raw per-Part recording')
        elif len(candidates) > 1:
            log.add('SOURCE_AUDIO_AMBIGUOUS', f'LISTENING/{p.code}', 'multiple raw per-Part recordings')
    if all(p.audio for p in sec.parts):
        return
    whole = [b for b in bindings if (b.scope or "").startswith("WHOLE")]
    if len(whole) != 1:
        log.add("SOURCE_AUDIO_AMBIGUOUS" if whole else "SOURCE_AUDIO_UNMAPPED", "LISTENING",
                f"{len(whole)} whole-test recordings")
        return
    b = whole[0]
    segs = confident_part_segments(extractor.staging, b.sha256, t.format_version)
    unsegmented = []
    for p in sec.parts:
        if p.audio:
            continue
        seg = segs.get(p.number)
        if seg is not None:
            p.audio = [seg]
            t.audio.append(seg)
            log.add("AUDIO_SEGMENT_CONFIDENT", f"LISTENING/{p.code}", "derived Part segment (CONFIDENT boundaries)")
        else:
            unsegmented.append(p)
            if segs:
                log.add("AUDIO_SEGMENT_UNRESOLVED", f"LISTENING/{p.code}", "no CONFIDENT segment for this part")
    if not unsegmented:
        return
    log.add("SOURCE_AUDIO_WHOLE_TEST_ONLY", "LISTENING", "one continuous recording; per-Part offsets not proven")
    first = min(unsegmented, key=lambda p: p.number)
    if first.number != 1:
        # the recording starts with Part 1: it is never presented as another part's recording
        log.add("SOURCE_AUDIO_UNMAPPED", "LISTENING", "whole-test recording not bound: Part 1 not emitted")
        return
    first.audio = [b]
    t.audio.append(b)
