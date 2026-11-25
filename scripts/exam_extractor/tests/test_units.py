"""Phase 3 extractor unit tests (synthetic inputs only — no corpus needed, no exam text stored).

Run:  python -m unittest discover -s scripts/exam_extractor/tests -t scripts
"""
from __future__ import annotations

import glob
import json
import re
import unittest
from pathlib import Path

from exam_extractor.answer_keys import expand_variants, parse_key_rows, resolve_key
from exam_extractor.canonical_json import package_content_hash
from exam_extractor.corpus import REPO_ROOT
from exam_extractor.diagnostics import DiagnosticLog
from exam_extractor.ielts_groups import classify, parse_group, parse_range, word_limit
from exam_extractor.model import (AnswerKey, AudioBinding, GK_GAP, GK_HEADINGS, GK_MATCHING, GK_MULTI_SELECT,
                                  GK_SHORT_ANSWER, GK_SINGLE_CHOICE, GK_TFNG, GK_YNNG)
from exam_extractor.media import audio_validation_state
from exam_extractor.pdf_layer import DOTS, Row, Token
from exam_extractor.toeic import doc_count
from exam_extractor.toeic_ocr import parse_ocr_key


def row(text: str, page: int = 1, y: float = 100.0, bold_numbers: bool = False, x: float = 60.0) -> Row:
    toks, cx = [], x
    for w in text.split():
        t = Token(DOTS if w == "…" else w, cx, cx + 6 * len(w), bold=bold_numbers and w.isdigit())
        toks.append(t)
        cx += 6 * len(w) + 4
    return Row(page, y, y + 10, x, cx, toks)


def rows(*lines, **kw) -> list:
    return [row(l, y=100 + 14 * i, **kw) for i, l in enumerate(lines)]


class AnswerKeyTests(unittest.TestCase):
    def test_variant_syntax(self):
        self.assertEqual(expand_variants("35 / thirty five"), ["35", "thirty five"])
        self.assertEqual(expand_variants("(the) harbour"), ["the harbour", "harbour"])
        self.assertEqual(expand_variants("metal(s)"), ["metals", "metal"])

    def test_sequence_parser_keeps_numeric_answers_and_either_order(self):
        log = DiagnosticLog()
        keys = parse_key_rows(rows("1 litter", "2 25", "3 A", "4&5 IN EITHER ORDER", "B", "D"), 1, 5, log, "K")
        self.assertEqual(keys[2].values, ["25"])           # numeric answer is not read as entry 25
        self.assertEqual(keys[4].values, ["B", "D"])
        self.assertEqual(keys[4].either_order, [4, 5])
        self.assertEqual(log.to_list(), [])

    def test_missing_key_is_a_diagnostic_never_blank(self):
        log = DiagnosticLog()
        keys = parse_key_rows(rows("1 litter", "3 boots"), 1, 3, log, "K")
        self.assertNotIn(2, keys)
        self.assertEqual(log.items[0].code, "ANSWER_KEY_MISSING_ITEM")

    def test_type_checks(self):
        log = DiagnosticLog()
        self.assertIsNone(resolve_key(GK_TFNG, AnswerKey(7, ["YES"]), [], None, False, log, "K"))
        self.assertEqual(log.items[-1].code, "ANSWER_KEY_TYPE_MISMATCH")
        self.assertEqual(resolve_key(GK_TFNG, AnswerKey(8, ["NOTGIVEN"]), [], None, False, log, "K"), ["NOT GIVEN"])
        self.assertIsNone(resolve_key(GK_SINGLE_CHOICE, AnswerKey(9, ["E"]), list("ABC"), None, False, log, "K"))
        self.assertIsNone(resolve_key(GK_GAP, AnswerKey(10, ["you are unlikely to get an acceptable score"]), [], 2,
                                      False, log, "K"))
        self.assertEqual(log.items[-1].code, "ANSWER_KEY_GARBAGE_REJECTED")
        self.assertEqual(resolve_key(GK_HEADINGS, AnswerKey(11, ["iv"]), ["i", "ii", "iii", "iv"], None, False, log, "K"), ["iv"])

    def test_ocr_separator_repaired_only_where_pronoun_impossible(self):
        log = DiagnosticLog()
        self.assertEqual(resolve_key(GK_GAP, AnswerKey(1, ["48 I forty-eight"]), [], 1, True, log, "K"), ["48", "forty-eight"])
        self.assertEqual(resolve_key(GK_GAP, AnswerKey(2, ["cafe I café"]), [], 1, False, log, "K"), ["cafe", "café"])
        self.assertEqual(resolve_key(GK_SHORT_ANSWER, AnswerKey(3, ["what I need"]), [], 3, False, log, "K"), ["what I need"])

    def test_ocr_key_out_of_sequence_stays_missing(self):
        log = DiagnosticLog()
        keys = parse_ocr_key(rows("101 (B) 102 (A) 103 104 (C) 161 (D) 106 (A)"), 101, 106, log, "K")
        self.assertEqual(keys[101].values, ["B"])
        self.assertNotIn(103, keys)      # number without a letter
        self.assertNotIn(105, keys)      # '161' printed where 105 is expected is NOT reinterpreted
        self.assertIn(106, keys)


class GroupTests(unittest.TestCase):
    def test_classification(self):
        self.assertEqual(classify("Choose the correct letter, A, B or C.")[0], GK_SINGLE_CHOICE)
        self.assertEqual(classify("Choose TWO letters, A-E.")[0], GK_MULTI_SELECT)
        self.assertEqual(classify("Do the following statements agree with the information given in Reading Passage 1? TRUE FALSE NOT GIVEN")[0], GK_TFNG)
        self.assertEqual(classify("Do the following statements agree with the claims of the writer?")[0], GK_YNNG)
        self.assertEqual(classify("Choose the correct heading for each section from the list of headings below.")[0], GK_HEADINGS)
        self.assertEqual(classify("Complete the notes below. Write ONE WORD ONLY for each answer.")[0], GK_GAP)
        self.assertEqual(classify("Which section contains the following information?")[0], GK_MATCHING)
        self.assertIsNone(classify("Read this carefully."))
        self.assertEqual(word_limit("Write NO MORE THAN TWO WORDS AND/OR A NUMBER for each answer.")[:2], (2, True))

    def test_range_markers(self):
        self.assertEqual(parse_range("Questions 11–14")[:2], (11, 14))
        self.assertEqual(parse_range("Questions 15 and 16")[:2], (15, 16))
        self.assertIsNone(parse_range("questions 27–30."))    # sentence tail, not a marker

    def test_gap_group_requires_every_number(self):
        log = DiagnosticLog()
        g = parse_group(rows("Complete the notes below.", "Write ONE WORD ONLY for each answer.",
                             "• the path is made of 1 …", "• visitors need 2 …"), 1, 2, "T", log)
        self.assertIsNotNone(g)
        self.assertEqual([i.number for i in g.items], [1, 2])
        self.assertIn("______", g.items[0].prompt)
        log = DiagnosticLog()
        self.assertIsNone(parse_group(rows("Complete the notes below.", "Write ONE WORD ONLY for each answer.",
                                           "• the path is made of 1 …"), 1, 2, "T", log))
        self.assertIn("QUESTION_NUMBER_GAP", [d.code for d in log.items])

    def test_mcq_options_keep_text(self):
        log = DiagnosticLog()
        g = parse_group(rows("Choose the correct letter, A, B or C.", "11 Where is the office?",
                             "A near the station", "B by the river", "C in the park"), 11, 11, "T", log)
        self.assertEqual([(o.id, o.text) for o in g.items[0].options],
                         [("A", "near the station"), ("B", "by the river"), ("C", "in the park")])


class ToeicTests(unittest.TestCase):
    def test_document_count_from_set_header(self):
        self.assertEqual(doc_count("text-message chain"), 1)
        self.assertEqual(doc_count("Web page and e-mail"), 2)
        self.assertEqual(doc_count("e-mail, list, and article"), 3)
        self.assertEqual(doc_count("e-mails"), 2)


class MediaTests(unittest.TestCase):
    def test_probable_audio_needs_corroboration(self):
        qa = {"hashVerified": True, "decodable": True, "durationAgrees": True}
        b = AudioBinding("imports/source-files/x.mp3", "0" * 64, 300000, 1, "audio/mpeg", "SECTION", 1, None, "PROBABLE",
                         technical_qa=qa)
        self.assertEqual(audio_validation_state(b, corroborated=False), "PENDING")
        self.assertEqual(audio_validation_state(b, corroborated=True), "VALIDATED")
        b.confidence = "AMBIGUOUS"
        self.assertEqual(audio_validation_state(b, corroborated=True), "PENDING")
        b.confidence = "CONFIDENT"
        b.technical_qa = dict(qa, decodable=False)
        self.assertEqual(audio_validation_state(b, corroborated=True), "PENDING")


class CanonicalHashTests(unittest.TestCase):
    def test_hash_parity_with_java_on_sealed_runtime_packages(self):
        # The historical pilot directory includes deliberately altered/unsealed
        # fixtures; a minimum number of matching hashes never proves parity.
        # Check EVERY package in the current canonical runtime bank instead.
        registry = (REPO_ROOT / "backend/src/main/java/com/englishcoach/exams/content/"
                    "ExamOriginalPracticeBootstrapService.java").read_text(encoding="utf-8")
        declaration = re.search(r"PACKAGES\s*=\s*List\.of\((.*?)\);", registry, re.S)
        self.assertIsNotNone(declaration)
        package_ids = re.findall(r'"(EC_ORIGINAL_[A-Z0-9_]+)"', declaration.group(1))
        self.assertEqual(6, len(package_ids))
        for package_id in package_ids:
            path = REPO_ROOT / "backend/src/main/resources/exams/original-practice" / (package_id + ".json")
            pkg = json.loads(path.read_text(encoding="utf-8"))
            with self.subTest(package_id=package_id):
                self.assertEqual(pkg["manifest"]["contentHash"], package_content_hash(pkg))


if __name__ == "__main__":
    unittest.main()
