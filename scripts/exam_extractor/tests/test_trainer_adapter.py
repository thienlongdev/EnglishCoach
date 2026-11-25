import unittest
from types import SimpleNamespace

from build_exam_source_manifest import pdf_role
from exam_extractor.adapters.ielts_trainer import IeltsTrainerPracticeAdapter
from exam_extractor.tests.test_units import row


class TrainerAdapterTests(unittest.TestCase):
    def test_integrated_book_is_not_an_answer_only_file(self):
        self.assertEqual(pdf_role("IELTS", "Six Practice Tests with Answers.pdf")[0], "QUESTION_BOOK")
        self.assertEqual(pdf_role("IELTS", "Trainer Answer Key.pdf")[0], "ANSWER_KEY")

    def test_exact_source_windows_keep_training_and_key_pages_out(self):
        adapter = IeltsTrainerPracticeAdapter()
        pages = [(97, [row("training", page=97)]), (98, [row("question", page=98)]),
                 (115, [row("writing", page=115)]), (174, [row("key", page=174)])]
        stream = adapter.annotate(pages, 600, 800)
        self.assertEqual([(r.row.page, r.test, r.skill) for r in stream],
                         [(98, 3, "LISTENING"), (115, 3, "WRITING")])

    def test_different_edition_does_not_use_pinned_windows(self):
        adapter = IeltsTrainerPracticeAdapter()
        test = SimpleNamespace(book_raw={"source_documents": [{"path": "different.pdf", "sha256": "unknown"}]})
        self.assertEqual(adapter.question_documents(test, None), [])
