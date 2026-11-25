"""SourceCollectionAdapter contract.

An adapter isolates everything that differs between publishers / collections (which documents hold a test,
running headers and page furniture, region markers, how audio is named, text-layer origin) and feeds ONE common
extraction model. Collection-specific naming never leaks into the canonical package: the package only carries
references (raw path, SHA-256, pages) through sourceProvenance.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional

from ..corpus import RawCorpusManifest, TestRecord
from ..pdf_layer import Row

# Region labels used while streaming a book.
QUESTIONS = "QUESTIONS"
ANSWER_KEY = "ANSWER_KEY"
TRANSCRIPT = "TRANSCRIPT"
OTHER = "OTHER"


@dataclass
class AnnotatedRow:
    row: Row
    region: str
    test: Optional[int]
    skill: Optional[str]


class SourceCollectionAdapter:
    name = "base"
    family = "IELTS"
    collections: tuple = ()
    publisher = "UNKNOWN"
    source_type = "COMMERCIAL_PUBLISHER"

    def supports(self, test: TestRecord) -> bool:
        return test.family == self.family and test.collection in self.collections

    def variant(self, test: TestRecord) -> str:
        return "ACADEMIC"

    def question_documents(self, test: TestRecord, manifest: RawCorpusManifest) -> list:
        """Corpus-relative paths of the PDFs holding questions + keys for this test (in reading order)."""
        docs = [d["path"] for d in test.book_raw.get("source_documents", [])
                if d.get("role") in ("QUESTION_BOOK", "PER_TEST_BOOK") and d.get("readable", True)]
        per_test = [d["path"] for d in test.book_raw.get("source_documents", [])
                    if d.get("role") == "PER_TEST_BOOK" and d.get("test_from_name") == test.test_number]
        return per_test or docs

    def answer_documents(self, test: TestRecord, manifest: RawCorpusManifest) -> list:
        return [d["path"] for d in test.book_raw.get("source_documents", []) if d.get("role") == "ANSWER_KEY"]

    def transcript_documents(self, test: TestRecord, manifest: RawCorpusManifest) -> list:
        return [d["path"] for d in test.book_raw.get("source_documents", []) if d.get("role") == "TRANSCRIPT"]

    def is_noise(self, row: Row, page_w: float, page_h: float) -> bool:
        return False

    def annotate(self, rows_by_page: list, page_w: float, page_h: float) -> list:
        raise NotImplementedError


def norm_space(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()
