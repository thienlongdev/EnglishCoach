"""A printed page profile must never be reused for another source edition."""
import unittest
from types import SimpleNamespace
from unittest.mock import Mock
from exam_extractor.diagnostics import DiagnosticLog
from exam_extractor.pipeline import Extractor


class IeltsScanSourceGuardTest(unittest.TestCase):
    def test_per_test_scan_profile_refuses_another_tests_pdf(self):
        from exam_extractor.pipeline import IELTS_SCAN_PROFILES
        hashes = IELTS_SCAN_PROFILES["cambridge-ielts-6"]["source_sha256_by_test"]
        for number in (1, 2, 3, 4):
            with self.subTest(number=number):
                extractor = Extractor.__new__(Extractor)
                extractor.manifest = None
                extractor.layer = Mock(return_value=SimpleNamespace(sha256=hashes[number % 4 + 1]))
                extractor._ocr_stream = Mock(side_effect=AssertionError("wrong test reached OCR"))
                adapter = SimpleNamespace(question_documents=lambda test, manifest: ["per-test.pdf"])
                test = SimpleNamespace(book="cambridge-ielts-6", test_number=number,
                    book_raw={"source_documents": [{"path": "per-test.pdf", "text_layer": "SCANNED"}]})
                extracted = SimpleNamespace(diagnostics=DiagnosticLog(), documents=[])
                extractor._extract_ielts(test, adapter, extracted)
                self.assertEqual(["SOURCE_PAGE_RANGE_UNCERTAIN"], [d.code for d in extracted.diagnostics.items])
                self.assertEqual([], extracted.documents)
                extractor._ocr_stream.assert_not_called()

    def test_wrong_hash_refuses_ocr_before_content_or_key_binding(self):
        from exam_extractor.pipeline import IELTS_SCAN_PROFILES
        for book, profile in IELTS_SCAN_PROFILES.items():
            with self.subTest(book=book):
                extractor = Extractor.__new__(Extractor)
                extractor.manifest = None
                extractor.layer = Mock(return_value=SimpleNamespace(sha256="different-edition"))
                extractor._ocr_stream = Mock(side_effect=AssertionError("wrong edition reached OCR"))
                adapter = SimpleNamespace(question_documents=lambda test, manifest: ["edition.pdf"])
                test = SimpleNamespace(book=book, test_number=min(profile['test_pages']),
                    book_raw={"source_documents": [{"path": "edition.pdf", "text_layer": "SCANNED"}]})
                extracted = SimpleNamespace(diagnostics=DiagnosticLog(), documents=[])
                extractor._extract_ielts(test, adapter, extracted)
                self.assertEqual(["SOURCE_PAGE_RANGE_UNCERTAIN"], [d.code for d in extracted.diagnostics.items])
                self.assertEqual([], extracted.documents)
                extractor._ocr_stream.assert_not_called()
