"""TOEIC adapters. Collection specifics only (which book holds which skill, text-layer origin); the parsing is
the common TOEIC extractor in exam_extractor/toeic.py."""
from __future__ import annotations

from .base import SourceCollectionAdapter


class EtsToeicReadingAdapter(SourceCollectionAdapter):
    """ETS TOEIC books whose Reading volume has an embedded (OCR) text layer: ETS 2019 'ETS 1000 RC'."""
    name = "ets-toeic-rc-text"
    family = "TOEIC"
    collections = ("ets",)
    publisher = "Educational Testing Service (ETS) / licensed local edition"
    text_layer_books = ("ets-2019",)

    def supports(self, test) -> bool:
        return test.family == "TOEIC" and test.collection in self.collections and test.book in self.text_layer_books

    def variant(self, test) -> str:
        return "STANDARD_FIXED_FORM"


class EtsToeicOcrAdapter(SourceCollectionAdapter):
    """Scanned ETS / YBM / Economy books: page OCR only through the cached OCR adapter (Batch D sample)."""
    name = "toeic-scanned-ocr"
    family = "TOEIC"
    collections = ("ets", "ybm", "economy")
    publisher = "TOEIC preparation publisher (scanned edition)"

    def variant(self, test) -> str:
        return "STANDARD_FIXED_FORM"
