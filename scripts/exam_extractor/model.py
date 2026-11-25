"""Intermediate extraction model (source-faithful, storage independent).

The package builder maps it 1:1 onto the canonical Java ExamContentPackage hierarchy:
FORM -> SECTION -> PART -> GROUP -> (STIMULUS -> ASSET) + (ITEM -> ANSWER SPEC).
Every structural unit keeps its source pages (provenance); nothing here is invented.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from .diagnostics import DiagnosticLog

# Canonical interaction types (subset of ExamContentPackageValidator.INTERACTION_TYPES, upper case).
SINGLE_CHOICE = "SINGLE_CHOICE"
TEXT_GAP = "TEXT_GAP"
SHORT_ANSWER = "SHORT_ANSWER"
TRUTH_CLASSIFICATION = "TRUTH_CLASSIFICATION"
MATCHING = "MATCHING"
HEADING_MATCHING = "HEADING_MATCHING"
LABEL_ASSIGNMENT = "LABEL_ASSIGNMENT"
WRITING_RESPONSE = "WRITING_RESPONSE"
SPEAKING_RESPONSE = "SPEAKING_RESPONSE"

# Question-group kinds recognised from the printed instructions.
GK_SINGLE_CHOICE = "SINGLE_CHOICE"          # Choose the correct letter, A, B or C
GK_MULTI_SELECT = "MULTI_SELECT"            # Choose TWO/THREE letters, A-E (one mark per question number)
GK_GAP = "GAP_COMPLETION"                   # notes / form / table / sentence / summary / flow-chart completion
GK_SHORT_ANSWER = "SHORT_ANSWER"            # Answer the questions below
GK_MATCHING = "MATCHING"                    # list of options A-H (box, people, endings, features, sections)
GK_HEADINGS = "HEADING_MATCHING"            # list of headings i-x
GK_TFNG = "TFNG"                            # TRUE / FALSE / NOT GIVEN
GK_YNNG = "YNNG"                            # YES / NO / NOT GIVEN
GK_LABEL = "LABEL_ASSIGNMENT"               # Label the map / plan / diagram (letters)


@dataclass
class Option:
    id: str
    text: str

    def to_dict(self) -> dict:
        return {"id": self.id, "text": self.text}


@dataclass
class AnswerKey:
    number: int
    values: list            # accepted variants, already expanded (optional words, alternatives)
    raw_tokens: int = 0     # number of raw tokens (for diagnostics, no text kept)
    confidence: str = "CONFIDENT"
    either_order: Optional[list] = None   # question numbers sharing one unordered answer set
    page: Optional[int] = None
    rejected: Optional[list] = None       # Phase 4.1C: answers a printed '(do not accept ...)' note rejects
    flags: Optional[list] = None          # Phase 4.1C: printed key notes, e.g. CAPITALS_REQUIRED


@dataclass
class Figure:
    """A visual rendered from a source page region (map, plan, diagram, chart, photograph)."""
    source_path: str
    source_sha256: str
    page: int
    bbox: tuple                 # PDF points (x0, y0, x1, y1)
    method: str                 # EMBEDDED_IMAGE | VECTOR_REGION | PAGE_REGION
    confidence: str
    staged_path: Optional[str] = None   # imports/exams/staging/assets/images/<sha>.png
    sha256: Optional[str] = None
    byte_size: int = 0
    dimensions: Optional[str] = None


@dataclass
class Item:
    number: int
    prompt: str
    interaction: str
    options: list = field(default_factory=list)
    key: Optional[AnswerKey] = None
    word_limit: Optional[int] = None
    selection: Optional[dict] = None     # MULTI_SELECT pair metadata {"count": 2, "questions": [15, 16]}
    pages: list = field(default_factory=list)


@dataclass
class QuestionGroup:
    first: int
    last: int
    kind: str
    instructions: list = field(default_factory=list)   # printed instruction lines (short)
    stem: Optional[str] = None                          # completion template / shared question / title
    options: list = field(default_factory=list)        # shared option list (matching, multi-select, label)
    items: list = field(default_factory=list)
    word_limit: Optional[int] = None
    word_limit_text: Optional[str] = None
    allow_number: bool = False
    figure: Optional[Figure] = None
    layout_linearized: bool = False
    pages: list = field(default_factory=list)

    @property
    def numbers(self) -> list:
        return list(range(self.first, self.last + 1))


@dataclass
class AudioBinding:
    path: str                   # imports/source-files/... (raw, never copied)
    sha256: str
    duration_ms: int
    byte_size: int
    mime: str
    scope: str                  # SECTION / PART / WHOLE_TEST
    section: Optional[int]
    part: Optional[int]
    confidence: str
    rule: Optional[str] = None
    technical_qa: dict = field(default_factory=dict)
    derived: Optional[dict] = None   # Phase 3.5 segment of a raw whole-test recording (parent, offsets, method)


@dataclass
class Passage:
    number: int
    title: Optional[str]
    paragraphs: list            # [{"id": "A"|None, "text": str}]
    notes: list = field(default_factory=list)   # footnotes / glossary lines
    pages: list = field(default_factory=list)
    documents: list = field(default_factory=list)  # TOEIC multi-document sets: [{"title", "paragraphs"}]
    document_boundaries: str = "NOT_SEGMENTED"     # SEGMENTED when the layout proved the document breaks
    figures: list = field(default_factory=list)  # exact source document regions, in declared order

    def text(self) -> str:
        blocks = []
        for p in self.paragraphs:
            blocks.append(f"{p['id']}  {p['text']}" if p.get("id") else p["text"])
        if self.notes:
            blocks.append("\n".join(self.notes))
        return "\n\n".join(blocks)


@dataclass
class Part:
    code: str                   # LISTENING_PART_1 / READING_PASSAGE_2 / TOEIC part codes
    number: int
    groups: list = field(default_factory=list)
    audio: list = field(default_factory=list)     # AudioBinding (IELTS: one per part)
    passage: Optional[Passage] = None
    instructions: Optional[str] = None
    pages: list = field(default_factory=list)

    @property
    def items(self) -> list:
        return [i for g in self.groups for i in g.items]


@dataclass
class WritingTask:
    number: int
    prompt: str
    minimum_words: Optional[int]
    recommended_minutes: Optional[int]
    figure: Optional[Figure] = None
    visual_kind: Optional[str] = None   # CHART / MAP / IMAGE (Academic Task 1)
    pages: list = field(default_factory=list)


@dataclass
class SpeakingPart:
    number: int
    title: Optional[str]
    prompts: list               # questions / cue-card lines (short)
    pages: list = field(default_factory=list)
    turn_prompts: list = field(default_factory=list)


@dataclass
class Section:
    skill: str                  # LISTENING / READING / WRITING / SPEAKING
    parts: list = field(default_factory=list)
    writing_tasks: list = field(default_factory=list)
    speaking_parts: list = field(default_factory=list)
    duration_seconds: int = 0
    pages: list = field(default_factory=list)

    @property
    def items(self) -> list:
        return [i for p in self.parts for i in p.items]


@dataclass
class SourceDocument:
    path: str                   # repository-relative (imports/source-files/...)
    sha256: str
    role: str
    text_layer: str
    page_count: int
    scope: Optional[str] = None


@dataclass
class ExtractedTest:
    test_id: str                # Phase 1 id, e.g. ielts/cambridge-ielts-17/test-1
    family: str                 # IELTS / TOEIC
    variant: str                # ACADEMIC / GENERAL_TRAINING / STANDARD_FIXED_FORM
    collection: str
    book: str
    book_title: str
    test_number: int
    publisher: str
    documents: list = field(default_factory=list)
    sections: list = field(default_factory=list)
    audio: list = field(default_factory=list)
    transcript_refs: list = field(default_factory=list)  # [{"path","sha256","pages"}] references only
    answer_key_refs: list = field(default_factory=list)
    diagnostics: DiagnosticLog = field(default_factory=DiagnosticLog)
    format_version: Optional[str] = None      # TOEIC_LR_2016 / TOEIC_LR_PRE_2016 / IELTS_LEGACY
    raw_manifest_ref: Optional[str] = None
    readiness_phase1: Optional[str] = None
    extraction_methods: set = field(default_factory=set)   # NATIVE_TEXT / OCR
    review_items: list = field(default_factory=list)       # Phase 3.5 human-QA entries (locations, no text)
    ocr_metrics: dict = field(default_factory=dict)        # structural OCR quality per skill
    ocr_pages: dict = field(default_factory=dict)          # {source path: set(pages processed)}

    def section(self, skill: str) -> Optional[Section]:
        for s in self.sections:
            if s.skill == skill:
                return s
        return None
