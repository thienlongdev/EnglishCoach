"""Cambridge-style IELTS books (Cambridge IELTS / Cambridge Practice Tests for IELTS) adapter.

Book layout: per test LISTENING (PART/SECTION 1-4) -> READING (READING PASSAGE 1-3) -> WRITING (TASK 1-2) ->
SPEAKING (PART 1-3); then Audioscripts/Tapescripts; then 'Listening and Reading answer keys' per TEST n;
then sample/model writing answers. The same markers appear in the native-typeset books (Cambridge 17) and in
re-typeset OCR layers (Cambridge 21); old 'Practice Tests for IELTS' volumes use SECTION n and 41-42 items.
"""
from __future__ import annotations

import re
from typing import Optional

from ..corpus import TestRecord
from ..pdf_layer import Row
from .base import ANSWER_KEY, OTHER, QUESTIONS, TRANSCRIPT, AnnotatedRow, SourceCollectionAdapter, norm_space

_TEST = re.compile(r"^(?:(?:academic|general\s+training)\s+)?(?:practice\s+)?test\s*(\d{1,2})(?:\s+[-–]?\d{1,3}[-–]?)?$", re.I)
_SKILLS = {"LISTENING": "LISTENING", "READING": "READING", "WRITING": "WRITING", "SPEAKING": "SPEAKING",
           "LISTENING KEYS": "LISTENING"}
_TRANSCRIPT = re.compile(r"^(audioscripts?|tapescripts?|transcripts?)$", re.I)
_KEYS = re.compile(r"^(listening and reading answer keys|answer keys?|key)$", re.I)
_OTHER = re.compile(r"^(sample writing answers|sample answer sheets|writing: model answers|model answers|"
                    r"acknowledgements|general training(:)?( module| reading and)?.*|general training)$", re.I)
_NOISE_ANY = re.compile(r"^(listening test audio|example speaking test video|answer key with extra( explanations)?|"
                        r"explanations|in resource bank|photocopiable|go on to the next page.*|[➔→▶].*|"
                        r"(\d+\s+)?(p\.\s*\d+\s*)+\d*|-\d{1,3}-|[-•]|ill|g)$", re.I)
_RUNNING = re.compile(r"^(listening|reading|writing|speaking|audioscripts|tapescripts|test \d+|practice test \d+|"
                      r"listening and reading answer keys|answer keys|sample writing answers|introdu[c]?tion|"
                      r"r?reading|introdution)$", re.I)


class CambridgeIeltsAdapter(SourceCollectionAdapter):
    name = "cambridge-ielts"
    family = "IELTS"
    collections = ("cambridge",)
    publisher = "Cambridge University Press & Assessment"

    def is_noise(self, row: Row, page_w: float, page_h: float) -> bool:
        t = norm_space(row.text)
        if not t:
            return True
        if _NOISE_ANY.match(t):
            return True
        top = row.y1 < 0.085 * page_h
        bottom = row.y0 > 0.915 * page_h
        # Cambridge21's OCR text layer joins the folio and resource-bank arrows, or misreads the
        # separator after a page reference. These are page-margin navigation, not question text.
        if bottom and re.match(r"^(?:\d{1,3}\s+[➔→▶]|p\.\s*\d)", t, re.I):
            return True
        # OCR can corrupt icons and dots in the two resource-bank references.
        # Two references plus the bottom-margin position prove navigation furniture.
        if row.y0 > 0.90 * page_h and len(re.findall(r"\bp\s*[:.]\s*\d+", t, re.I)) >= 2:
            return True
        if row.x0 > 0.75 * page_w and row.y1 < 0.25 * page_h and t.upper() in _SKILLS:
            return True
        if (top or bottom) and (_RUNNING.match(t) or re.fullmatch(r"[\d\s|.\-]+", t)):
            return True
        return False

    def annotate(self, pages: list, page_w: float, page_h: float, *, question_window: bool = False, proven_test: Optional[int] = None) -> list:
        """pages: [(page_no, rows)] -> AnnotatedRow stream with (region, test, skill) per row."""
        out = []
        region, test, skill = OTHER, proven_test, None
        seen_listening_tests = set()
        for page_no, rows in pages:
            for r in rows:
                t = norm_space(r.text)
                tu = t.upper()
                # Some compiled Cambridge editions frame section headings with X marks.
                # Strip framing only around an exact section name, never body prose.
                decorated = re.fullmatch(r"X\s+(LISTENING|READING|WRITING|SPEAKING)\s+X", tu)
                if decorated:
                    tu = decorated.group(1)
                    t = tu
                m = _TEST.match(t)
                if m and len(t) <= 22:
                    n = int(m.group(1))
                    # "Test 1" running headers repeat the current test; a new number moves the context forward.
                    if region in (ANSWER_KEY, TRANSCRIPT) or test is None or n in (test, test + 1) or n not in seen_listening_tests:
                        test = n
                    if region == OTHER:
                        region = QUESTIONS
                    continue
                # back-matter markers count only after questions were seen (contents pages list them too)
                if not question_window and _TRANSCRIPT.match(t) and seen_listening_tests:
                    region, skill = TRANSCRIPT, "LISTENING"
                    continue
                if not question_window and _KEYS.match(t) and seen_listening_tests:
                    region, skill = ANSWER_KEY, None
                    continue
                if _OTHER.match(t) and (r.size >= 12 or r.all_bold or len(t) < 40):
                    region, skill = OTHER, None
                    continue
                if tu in _SKILLS and t == tu:
                    skill = _SKILLS[tu]
                    if test is None and skill == "LISTENING" and region == OTHER:
                        test = 1  # old volumes open Practice Test 1 with LISTENING before any test header
                    if region == OTHER and test is not None:
                        region = QUESTIONS
                    if region == QUESTIONS and skill == "LISTENING" and test is not None:
                        seen_listening_tests.add(test)
                    continue
                if region == QUESTIONS and re.match(r"^READING PASSAGE 1\b", tu):
                    skill = "READING"
                if region == QUESTIONS and re.match(r"^WRITING TASK 1\b", tu):
                    skill = "WRITING"
                if self.is_noise(r, page_w, page_h):
                    continue
                out.append(AnnotatedRow(r, region, test, skill))
        return out

    def variant(self, test: TestRecord) -> str:
        return "ACADEMIC"


GENERIC_IELTS = CambridgeIeltsAdapter()
