"""Structured extraction diagnostics and confidence labels (Exams Recovery Phase 3).

Diagnostics carry codes, locations and counts only, never source text (copyright-safe reports).

Severity:
  BLOCKING  the unit (part / passage / section / test) is NOT emitted, or a claim is not made authoritative
  REVIEW    the unit is emitted but a human must review it before publication
  INFO      reported only
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

EXTRACTOR_NAME = "exam-raw-extractor"
EXTRACTOR_VERSION = "3.9.91"

# Confidence model (shared with the Phase 1 manifest labels for audio).
CONFIDENT = "CONFIDENT"
PROBABLE = "PROBABLE"
AMBIGUOUS = "AMBIGUOUS"
UNRESOLVED = "UNRESOLVED"
CONFIDENCE_ORDER = {CONFIDENT: 3, PROBABLE: 2, AMBIGUOUS: 1, UNRESOLVED: 0}

BLOCKING = "BLOCKING"
REVIEW = "REVIEW"
INFO = "INFO"

CODES = {
    "UNRELATED_KEY_BLOCK_UNASSIGNED": INFO,
    # source / corpus
    "SOURCE_PDF_MISSING": BLOCKING,
    "QUESTION_SOURCE_SELECTION_UNRESOLVED": BLOCKING,
    "SOURCE_ADAPTER_UNSUPPORTED": BLOCKING,
    "SOURCE_PDF_UNREADABLE": BLOCKING,
    "SOURCE_HASH_MISMATCH": BLOCKING,
    "SOURCE_AUDIO_UNMAPPED": BLOCKING,
    "SOURCE_AUDIO_PART_BOUND": INFO,
    "SOURCE_AUDIO_AMBIGUOUS": BLOCKING,
    "SOURCE_AUDIO_DURATION_IMPLAUSIBLE": BLOCKING,
    "SOURCE_AUDIO_WHOLE_TEST_ONLY": REVIEW,
    "PDF_NO_TEXT_LAYER": BLOCKING,
    "TEXT_LAYER_UNRELIABLE": BLOCKING,
    "OCR_REQUIRED": BLOCKING,
    "OCR_UNAVAILABLE": BLOCKING,
    "OCR_LOW_CONFIDENCE": REVIEW,
    "OCR_TEXT_USED": REVIEW,
    "SOURCE_PROVEN_TEXT_CORRECTION": INFO,
    "SOURCE_BLANK_GEOMETRY_RESTORED": REVIEW,
    "SOURCE_BLANK_DUAL_MASK_PROVEN": INFO,
    "SOURCE_BLANK_LABELS_DUAL_READ": INFO,
    "SOURCE_OPTION_LABELS_DUAL_READ": INFO,
    "SOURCE_PAGE_RANGE_UNCERTAIN": BLOCKING,
    "TEST_BOUNDARY_NOT_FOUND": BLOCKING,
    "SECTION_NOT_FOUND": BLOCKING,
    "SECTION_OMITTED": BLOCKING,
    "PART_OMITTED": BLOCKING,
    "READING_EXTRACTION_INCOMPLETE": BLOCKING,
    "FULL_TEST_EXTRACTION_INCOMPLETE": BLOCKING,
    "SOURCE_PART_EXTRACTION_INVALID": BLOCKING,
    # structure
    "QUESTION_BLOCK_NOT_FOUND": BLOCKING,
    "QUESTION_NUMBER_GAP": BLOCKING,
    "QUESTION_ORDINAL_OWN_REREAD": INFO,
    "DUPLICATE_QUESTION_NUMBER": BLOCKING,
    "QUESTION_RANGE_MISMATCH": BLOCKING,
    "GROUP_STRUCTURE_AMBIGUOUS": BLOCKING,
    "GROUP_TYPE_UNKNOWN": BLOCKING,
    "PASSAGE_NOT_FOUND": BLOCKING,
    "PASSAGE_BOUNDARY_AMBIGUOUS": BLOCKING,
    "OPTION_PARSE_FAILED": BLOCKING,
    "OPTION_CONTINUATION_UNPROVEN": BLOCKING,
    "INTERACTION_NOT_REPRESENTABLE": BLOCKING,
    "ITEM_COUNT_NONSTANDARD": REVIEW,
    "LAYOUT_LINEARIZED": REVIEW,
    "MULTI_SELECT_PAIR": INFO,
    "EXAMPLE_ITEM_SKIPPED": INFO,
    # answer keys
    "ANSWER_KEY_NOT_FOUND": BLOCKING,
    "ANSWER_KEY_COUNT_MISMATCH": BLOCKING,
    "ANSWER_KEY_MISSING_ITEM": BLOCKING,
    "ANSWER_KEY_EXTRA_ITEM": BLOCKING,
    "ANSWER_KEY_SYNTAX_INVALID": BLOCKING,
    "ANSWER_KEY_TYPE_MISMATCH": BLOCKING,
    "ANSWER_KEY_GARBAGE_REJECTED": BLOCKING,
    "ANSWER_KEY_WORD_LIMIT_CONFLICT": REVIEW,
    "ANSWER_KEY_OCR_REPAIRED": REVIEW,
    "ANSWER_KEY_ANNOTATION": INFO,                    # Phase 4.1C: printed examiner note separated from the answer
    "ANSWER_KEY_OPTIONAL_EXPANSION_LIMITED": INFO,    # Phase 4.1C: optional-word combination over the printed limit
    "ANSWER_KEY_PAGE_FOLIO_REMOVED": INFO,            # Phase 4.1C: printed page number inside the key block
    # media / transcripts
    "IMAGE_NOT_BOUND": BLOCKING,
    "IMAGE_REGION_HEURISTIC": REVIEW,
    "TRANSCRIPT_NOT_FOUND": INFO,
    "TRANSCRIPT_REFERENCED": INFO,
    # productive skills
    "WRITING_TASK_NOT_FOUND": BLOCKING,
    "WRITING_VISUAL_NOT_FOUND": REVIEW,
    "SPEAKING_PROMPTS_NOT_FOUND": INFO,
    "SPEAKING_TURN_STRUCTURE_UNPROVEN": BLOCKING,
    "SPEAKING_PROMPTS_RUNTIME_GENERATED": INFO,
    # rights: the publisher licence is never "fixed" by the extractor; the owner authorization is separate
    "PUBLISHER_LICENCE_NOT_ESTABLISHED": INFO,
    # Phase 3.5 â€” layout-aware OCR
    "OCR_LAYOUT_USED": INFO,
    "OCR_COLUMN_ORDER_INVERTED": BLOCKING,
    "OPTION_LABEL_MISSING": BLOCKING,
    "OPTION_LABEL_RECOGNISED": REVIEW,
    "BLANK_NOT_FOUND": BLOCKING,
    "OCR_BUDGET_EXHAUSTED": BLOCKING,
    "TEST_PAGES_UNVERIFIED": REVIEW,
    # Phase 3.5 â€” answer-key tables
    "ANSWER_KEY_SEQUENCE_UNPROVEN": BLOCKING,
    "ANSWER_KEY_LATTICE_CONFLICT": BLOCKING,
    "ANSWER_KEY_NUMBER_UNREAD": BLOCKING,
    "ANSWER_KEY_LETTER_UNCERTAIN": BLOCKING,
    "ANSWER_KEY_BLOCK_UNASSIGNED": BLOCKING,
    "ANSWER_KEY_TABLE_READ": INFO,
    "ANSWER_KEY_PHYSICAL_CELL_READ": INFO,
    # Phase 3.5 â€” TOEIC sets / listening booklet
    "PART6_BLANK_MAPPING_UNPROVEN": BLOCKING,
    "PART6_BLANK_GEOMETRY": INFO,
    "MULTI_DOC_SEGMENTED": INFO,
    "SOURCE_DOCUMENT_HEADER_DUAL_READ": INFO,
    "GROUP_BOUNDARY_UNPROVEN": BLOCKING,
    "GROUP_BOUNDARY_FROM_SCRIPT": INFO,
    "PHOTO_MAPPING_UNPROVEN": BLOCKING,
    "PHOTO_MAPPED": REVIEW,
    "PROMPT_FORMAT_STANDARD": INFO,
    "SOURCE_DOCUMENT_NOT_A_BOOKLET": INFO,
    # Phase 3.5 â€” whole-test audio segmentation
    "AUDIO_SEGMENT_CONFIDENT": INFO,
    "AUDIO_SEGMENT_REVIEW_REQUIRED": REVIEW,
    "AUDIO_SEGMENT_UNRESOLVED": REVIEW,
    # Phase 3.6 â€” spoken structure cues, Part 3/4 graphics, rights
    "GROUP_BOUNDARY_FROM_AUDIO": INFO,
    "AUDIO_CUES_NOT_ANALYZED": REVIEW,
    "GRAPHIC_BOUND": REVIEW,
    "GRAPHIC_NOT_BOUND": BLOCKING,
    "ANSWER_KEY_CELL_REREAD": REVIEW,
    "CROSS_SOURCE_BINDING_REJECTED": BLOCKING,
    "GAP_NUMBER_GEOMETRY": INFO,
    "PROJECT_USAGE_OWNER_AUTHORIZED": INFO,
    # Phase 5B â€” targeted existing-corpus remediation
    "OPTION_LABEL_RESTORED": REVIEW,          # a label glyph absent from the text layer, restored by lattice + range
    "GRAPHIC_DASHED_FRAME": INFO,             # a Part 3/4 graphic delimited by a dashed border (coupon)
    "GAP_TABLE_BOUND_BY_NUMBER": INFO,        # table gaps bound by their printed numbers (cells interleave)
    "WRITING_MIN_WORDS_SPLIT_DIGITS": INFO,   # 'Write at least 1 50 words': digits joined = the task's IELTS minimum
}


@dataclass
class Diagnostic:
    code: str
    severity: str
    scope: str  # e.g. "TEST", "LISTENING", "LISTENING/PART_2", "READING/PASSAGE_1", "ANSWER_KEY/LISTENING"
    detail: Optional[str] = None  # short structural detail, never source text
    pages: Optional[str] = None
    questions: Optional[str] = None
    occurrences: int = 1

    def to_dict(self) -> dict:
        out = {"code": self.code, "severity": self.severity, "scope": self.scope}
        if self.detail:
            out["detail"] = self.detail[:200]
        if self.pages:
            out["pages"] = self.pages
        if self.questions:
            out["questions"] = self.questions
        if self.occurrences != 1:
            out["occurrences"] = self.occurrences
        return out


@dataclass
class DiagnosticLog:
    items: list = field(default_factory=list)

    def add(self, code: str, scope: str, detail: Optional[str] = None, pages: Optional[str] = None,
            questions: Optional[str] = None, severity: Optional[str] = None) -> Diagnostic:
        if code not in CODES:
            raise ValueError(f"unknown diagnostic code {code}")
        sev = severity or CODES[code]
        for d in self.items:
            if d.code == code and d.scope == scope and d.detail == detail and d.severity == sev:
                d.occurrences += 1
                if questions and d.questions and questions not in d.questions:
                    d.questions = (d.questions + "," + questions)[:120]
                return d
        d = Diagnostic(code, sev, scope, detail, pages, questions)
        self.items.append(d)
        return d

    def extend(self, other: "DiagnosticLog") -> None:
        for d in other.items:
            self.items.append(d)

    def blocking(self, scope_prefix: str = "") -> list:
        return [d for d in self.items if d.severity == BLOCKING and d.scope.startswith(scope_prefix)]

    def has_blocking(self, scope_prefix: str = "") -> bool:
        return bool(self.blocking(scope_prefix))

    def to_list(self) -> list:
        return [d.to_dict() for d in self.items]


def page_range(pages) -> Optional[str]:
    """Compact '3-5,9' page notation from an iterable of 1-based page numbers."""
    ps = sorted({int(p) for p in pages if p is not None})
    if not ps:
        return None
    out, start, prev = [], ps[0], ps[0]
    for p in ps[1:]:
        if p == prev + 1:
            prev = p
            continue
        out.append(f"{start}-{prev}" if prev != start else str(start))
        start = prev = p
    out.append(f"{start}-{prev}" if prev != start else str(start))
    return ",".join(out)


def page_span(pages) -> Optional[str]:
    """'N' or 'N-M' (min..max), the form accepted by ExamPackageSourceProvenance.pageRange."""
    ps = sorted({int(p) for p in pages if p is not None})
    if not ps:
        return None
    return str(ps[0]) if ps[0] == ps[-1] else f"{ps[0]}-{ps[-1]}"
