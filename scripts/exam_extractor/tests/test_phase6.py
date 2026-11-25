"""Phase 6 tests: the corpus matrix reads the DECLARED runner support of LABEL_ASSIGNMENT from the Java mirror of the
runtime capabilities instead of assuming it unsupported; an unbound map figure is a runtime block only while the
interaction is unsupported. Synthetic files only — no exam text.

Run:  python -m unittest discover -s scripts/exam_extractor/tests -t scripts
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from exam_extractor.corpus_matrix import classify, declared_interaction_support

REPO = Path(__file__).resolve().parents[3]
JAVA_REL = Path("backend/src/main/java/com/englishcoach/exams/release/ExamRunnerCapabilities.java")


class DeclaredSupportTest(unittest.TestCase):

    def test_repository_declares_label_assignment_supported(self):
        self.assertEqual("SUPPORTED", declared_interaction_support(REPO, "LABEL_ASSIGNMENT"))
        self.assertEqual("SUPPORTED", declared_interaction_support(REPO, "SPEAKING_RESPONSE"))

    def test_unknown_or_missing_declaration_fails_closed(self):
        self.assertEqual("UNSUPPORTED", declared_interaction_support(REPO, "NOT_AN_INTERACTION"))
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual("UNSUPPORTED", declared_interaction_support(Path(tmp), "LABEL_ASSIGNMENT"))
            java = Path(tmp) / JAVA_REL
            java.parent.mkdir(parents=True)
            java.write_text('entry("LABEL_ASSIGNMENT", Support.UNSUPPORTED)', encoding="utf-8")
            self.assertEqual("UNSUPPORTED", declared_interaction_support(Path(tmp), "LABEL_ASSIGNMENT"))

    def test_unbound_figure_is_recoverable_once_supported(self):
        g = {"IMPORT_READY": False, "READY_EXCEPT_HUMAN_QA": False}
        # supported runtime ⇒ no runtime_unsupported entry ⇒ the extraction defect classifies as recoverable
        self.assertEqual("TECHNICALLY_RECOVERABLE", classify(g, [{"reason": "RECOVERABLE_SOURCE_DEFECT"}], [], [], [])[0])
        # unsupported runtime ⇒ runtime block (Phase 5 behaviour preserved)
        self.assertEqual("RUNTIME_BLOCKED", classify(g, [{"reason": "UNSUPPORTED_INTERACTION"}], [], [],
                                                     [{"interaction": "LABEL_ASSIGNMENT"}])[0])


if __name__ == "__main__":
    unittest.main()
