"""Phase 5 tests: targeted remediation rules (dropped option label restored only by lattice proof, column-true option
continuation, instruction-defined summary gap mode, table gaps bound by printed number, split minimum-word digits,
Part 6 label band of a fused row, dashed graphic frames, nested graphic regions) and the Phase 5 classifiers (legacy
mapping, corpus disposition). Synthetic rows / masks only — no exam text.

Run:  python -m unittest discover -s scripts/exam_extractor/tests -t scripts
"""
from __future__ import annotations

import unittest

import numpy as np

from exam_extractor import toeic_scan
from exam_extractor.corpus_matrix import classify, reason_of
from exam_extractor.diagnostics import DiagnosticLog
from exam_extractor.ielts import extract_writing
from exam_extractor.ielts_groups import (_append_continuation, _grid_text_columns, _letter_splits, _table_gaps_by_number,
                                         parse_group, restore_dropped_label)
from exam_extractor.layout import FRAME, Region, dashed_frames
from exam_extractor.legacy_mapping import EXACT, NONE, REVIEW, decide
from exam_extractor.model import GK_GAP, Option, QuestionGroup
from exam_extractor.ocr_quality import label_glyphs
from exam_extractor.pdf_layer import DOTS, Row, Token


def T(text, x0, w=None, bold=False):
    return Token(text, x0, x0 + (w if w is not None else 6 * max(1, len(text))), bold=bold, size=10.0)


def row(y, *toks, page=1):
    toks = list(toks)
    return Row(page, y, y + 10, toks[0].x0, toks[-1].x1, toks)


def grid(missing_cell=True):
    """3x3 option box A-I (letters bold at x 100/200/300, text at 115/215/315); 'I' dropped by the text layer."""
    rows = [row(10, T("A", 100, bold=True), T("one", 115), T("B", 200, bold=True), T("two", 215), T("C", 300, bold=True), T("three", 315)),
            row(30, T("D", 100, bold=True), T("four", 115), T("E", 200, bold=True), T("five", 215), T("F", 300, bold=True), T("six", 315)),
            row(50, T("G", 100, bold=True), T("seven", 115), T("H", 200, bold=True), T("eight", 215), T("nine", 315))]
    if not missing_cell:
        rows[2].tokens.insert(4, T("I", 300, bold=True))
    return rows


class DroppedLabelTest(unittest.TestCase):
    def test_restored_only_in_the_lattice_cell_after_its_predecessor(self):
        rows, log = grid(), DiagnosticLog()
        self.assertEqual(1, restore_dropped_label(rows, list("ABCDEFGHI"), log, "R/P3", "31-36"))
        self.assertEqual(["G", "H", "I"], [l for l, _ in _letter_splits(rows[2], "G", True)])
        self.assertEqual("OPTION_LABEL_RESTORED", log.items[0].code)

    def test_never_restored_when_the_label_is_printed_or_two_letters_are_missing(self):
        self.assertEqual(0, restore_dropped_label(grid(missing_cell=False), list("ABCDEFGHI"), DiagnosticLog(), "s", "q"))
        rows = grid()
        del rows[2].tokens[2:4]                      # H dropped too
        self.assertEqual(0, restore_dropped_label(rows, list("ABCDEFGHI"), DiagnosticLog(), "s", "q"))

    def test_only_the_lone_stroke_glyph_is_ever_restored(self):
        rows = grid()
        rows[2].tokens[-1:] = [T("H2", 315)]
        self.assertEqual(0, restore_dropped_label(rows, list("ABCDEFGH") + ["J"], DiagnosticLog(), "s", "q"))

    def test_orphan_text_must_start_exactly_in_the_text_column(self):
        rows = grid()
        rows[2].tokens[-1] = T("nine", 290)          # not at x 315
        self.assertEqual(0, restore_dropped_label(rows, list("ABCDEFGHI"), DiagnosticLog(), "s", "q"))

    def test_single_column_list_requires_one_line_options_at_the_list_pitch(self):
        rows = [row(10 + 20 * i, T(L, 100, bold=True), T("option", 120)) for i, L in enumerate("ABCDEFGH")]
        rows.append(row(170, T("orphan", 120)))
        self.assertEqual(1, restore_dropped_label(rows, list("ABCDEFGHI"), DiagnosticLog(), "s", "q"))
        rows = [row(10 + 20 * i, T(L, 100, bold=True), T("option", 120)) for i, L in enumerate("ABCDEFGH")]
        rows.append(row(200, T("far", 120)))         # wrong pitch: a heading / other text, not option I
        self.assertEqual(0, restore_dropped_label(rows, list("ABCDEFGHI"), DiagnosticLog(), "s", "q"))


class ContinuationTest(unittest.TestCase):
    def test_wrapped_word_joins_the_option_of_its_column(self):
        r = row(10, T("D", 100, bold=True), T("product", 115), T("E", 200, bold=True), T("skills", 215),
                T("F", 300, bold=True), T("global", 315))
        sp = _letter_splits(r, "D", True)
        opts = [Option(l, " ".join(p)) for l, p in sp]
        cols = list(zip(opts, _grid_text_columns(r, sp)))
        _append_continuation(row(22, T("markets", 115)), cols, opts[-1])
        self.assertEqual("product markets", opts[0].text)
        self.assertEqual("global", opts[2].text)


class SummaryGapModeTest(unittest.TestCase):
    def test_bold_title_starting_with_a_is_not_option_a_and_wrapped_number_is_a_gap(self):
        rows = [row(0, T("Questions", 50), T("27-28", 100)),
                row(12, T("Complete", 50), T("the", 100), T("summary", 130), T("using", 190), T("the", 230),
                    T("list", 260), T("of", 290), T("words,", 310), T("A-C,", 350, bold=True), T("below.", 380)),
                row(30, T("A", 150, bold=True), T("title", 165, bold=True), T("words", 200, bold=True)),
                row(50, T("Some", 50), T("text", 90), T("about", 120), T("it", 160)),
                row(62, T("27", 50, bold=True), T(DOTS, 70, 40), T(".", 300)),
                row(62, T("and", 120), T("then", 150), T("28", 190, bold=True), T(DOTS, 210, 40)),
                row(90, T("A", 100, bold=True), T("alpha", 115), T("B", 200, bold=True), T("beta", 215),
                    T("C", 300, bold=True), T("gamma", 315))]
        g = parse_group(rows, 27, 28, "R/P3", DiagnosticLog())
        self.assertIsNotNone(g)
        self.assertEqual(["A", "B", "C"], [o.id for o in g.options])
        self.assertEqual("alpha", g.options[0].text)


class TableGapTest(unittest.TestCase):
    def _g(self):
        return QuestionGroup(first=1, last=3, kind=GK_GAP)

    def test_interleaved_cells_bound_by_their_printed_numbers(self):
        rows = [row(10, T("cell", 50), T("1", 150, bold=True), T(DOTS, 160, 40)),
                row(20, T("x", 50), T("3", 250, bold=True), T(DOTS, 260, 40)),
                row(21, T("2", 150, bold=True), T(DOTS, 160, 40))]
        items, _stem = _table_gaps_by_number(self._g(), rows, False)
        self.assertEqual([1, 2, 3], sorted(items))

    def test_a_number_printed_twice_or_missing_never_binds(self):
        rows = [row(10, T("1", 150, bold=True), T(DOTS, 160, 40)), row(20, T("1", 250, bold=True), T(DOTS, 260, 40)),
                row(30, T("3", 150, bold=True), T(DOTS, 160, 40))]
        self.assertIsNone(_table_gaps_by_number(self._g(), rows, False))
        self.assertIsNone(_table_gaps_by_number(self._g(), rows[:1], False))


class WritingMinimumTest(unittest.TestCase):
    def _task(self, words_row):
        rows = [row(10, T("WRITING", 50, bold=True), T("TASK", 120, bold=True), T("1", 160, bold=True)),
                row(30, *[T(w, 50 + 40 * i) for i, w in enumerate("You should spend about 20 minutes on this task".split())]),
                row(50, *[T(w, 50 + 40 * i) for i, w in enumerate(("Describe the information shown in the graph and "
                                                                    "compare the main features where relevant").split())]),
                row(70, *[T(w, 50 + 40 * i) for i, w in enumerate(words_row.split())])]
        log = DiagnosticLog()
        return extract_writing(rows, "WRITING", log, None, None, academic=False), log

    def test_split_digits_join_only_to_the_task_minimum(self):
        tasks, log = self._task("Write at least 1 50 words.")
        self.assertEqual(150, tasks[0].minimum_words)
        self.assertTrue(any(d.code == "WRITING_MIN_WORDS_SPLIT_DIGITS" for d in log.items))
        tasks, log = self._task("Write at least 1 60 words.")
        self.assertEqual([], tasks, "digits that are not the IELTS minimum stay unread")


class Part6LabelBandTest(unittest.TestCase):
    def test_isolated_neighbour_stroke_does_not_hide_own_label(self):
        dashes=[(35+x*12,17,10,4) for x in range(7)]
        digits=[(45,26,12,28),(64,26,18,28),(84,27,18,28)]
        self.assertEqual(digits,label_glyphs(dashes+[(0,24,13,4)]+digits,line_h=56))

    def test_only_the_blanks_own_dash_run_and_the_label_above_the_next_run(self):
        own_dashes = [(0, 0, 12, 2), (16, 0, 12, 2)]
        own_label = [(4, 6, 6, 12), (12, 6, 6, 12)]
        next_dashes = [(0, 60, 12, 2), (16, 60, 12, 2)]
        next_label = [(4, 66, 6, 12)]
        got = label_glyphs(own_dashes + own_label + next_dashes + next_label, line_h=40)
        self.assertEqual(sorted(own_label), sorted(got))


class DashedFrameTest(unittest.TestCase):
    @staticmethod
    def _mask(sides=True):
        m = np.zeros((300, 400), dtype=np.uint8)
        for x in range(40, 340, 25):
            m[40:42, x:x + 17] = 1                 # top dashed rule
            m[200:202, x:x + 17] = 1               # bottom dashed rule
        if sides:
            for y in range(50, 195, 25):
                m[y:y + 17, 38:40] = 1             # left dashed side
        for x in range(60, 300, 14):
            m[100:110, x:x + 8] = 1                # 'text' glyphs inside
        return m

    def test_dashed_rectangle_is_found(self):
        boxes = dashed_frames(self._mask())
        self.assertEqual(1, len(boxes))
        x0, y0, x1, y1 = boxes[0]
        self.assertTrue(x0 <= 40 and y0 <= 41 and x1 >= 330 and y1 >= 200)

    def test_two_dashed_rules_without_a_dashed_side_are_not_a_frame(self):
        self.assertEqual([], dashed_frames(self._mask(sides=False)))


class NestedGraphicTest(unittest.TestCase):
    def test_a_frame_inside_another_graphic_without_questions_is_part_of_it(self):
        class Lay:
            regions = [Region(FRAME, (300, 50, 520, 220), 1), Region(FRAME, (320, 90, 500, 210), 1)]

        class Ctx:
            pages = {1: (Lay(), [row(240, T("98.", 300), T("Who", 330))])}
            log = DiagnosticLog()

        orig = toeic_scan._dashed_boxes
        toeic_scan._dashed_boxes = lambda ctx, p: []
        try:
            self.assertEqual([(1, (300, 50, 520, 220))], toeic_scan._graphic_regions(Ctx(), [1]))
            Lay.regions[0] = Region(FRAME, (300, 50, 520, 260), 1)      # the outer box now holds question 98
            self.assertEqual(2, len(toeic_scan._graphic_regions(Ctx(), [1])))
        finally:
            toeic_scan._dashed_boxes = orig


class LegacyMappingTest(unittest.TestCase):
    CANON = {"rawDocumentSha256": ["aa", "bb"]}

    def _e(self, **kw):
        e = {"raw_book": "book", "raw_test": 1, "raw_test_id": "fam/book/test-1", "confidence": "CONFIDENT",
             "raw_source_drift": None, "family": "IELTS"}
        e.update(kw)
        return e

    def test_exact_needs_every_proof(self):
        self.assertEqual(EXACT, decide(self._e(), "aa", "IELTS", self.CANON)[0])
        self.assertEqual(REVIEW, decide(self._e(confidence="PROBABLE"), "aa", "IELTS", self.CANON)[0])
        self.assertEqual(REVIEW, decide(self._e(), "cc", "IELTS", self.CANON)[0], "different raw bytes")
        self.assertEqual(REVIEW, decide(self._e(raw_source_drift="SOURCE_CONTENT_CHANGED"), "aa", "IELTS", self.CANON)[0])
        self.assertEqual(NONE, decide(self._e(), "aa", "IELTS", None)[0], "no canonical package")
        self.assertEqual(NONE, decide(self._e(confidence="UNMAPPED", raw_book=None), None, "IELTS", self.CANON)[0])


class DispositionTest(unittest.TestCase):
    def test_owner_confirmed_family_mapping_failure_is_not_hard_source_absence(self):
        gate = {'IMPORT_READY': False, 'READY_EXCEPT_HUMAN_QA': False}
        for book in ('ybm-vol-1', 'ybm-vol-2', 'economy-vol-4'):
            for code in ('SOURCE_PDF_MISSING', 'SOURCE_AUDIO_UNMAPPED', 'ANSWER_KEY_NOT_FOUND',
                         'ANSWER_KEY_BLOCK_UNASSIGNED', 'ANSWER_KEY_NUMBER_UNREAD'):
                reason = reason_of({'code': code, 'scope': 'LISTENING',
                                    'detail': 'no Reading answer key exists in this collection'},
                                   {'test_id': f'toeic/{book}/test-1', 'audio_mapping_confidence': 'UNMAPPED'})
                self.assertEqual('RECOVERABLE_SOURCE_DEFECT', reason[0])
                self.assertEqual('TECHNICALLY_RECOVERABLE', classify(gate, [{'reason': reason[0]}], [], [], [])[0])
        self.assertEqual('SOURCE_KEY_UNPROVABLE', reason_of({'code': 'ANSWER_KEY_NUMBER_UNREAD'},
                         {'test_id': 'toeic/ets-2026/test-1'})[0])

    def test_reason_codes(self):
        self.assertEqual("SOURCE_KEY_UNAVAILABLE", reason_of({"code": "ANSWER_KEY_NOT_FOUND", "scope": "ANSWER_KEY/READING",
                         "detail": "no Reading answer key exists in this collection"}, {})[0])
        self.assertEqual("RECOVERABLE_SOURCE_DEFECT", reason_of({"code": "ANSWER_KEY_NOT_FOUND", "scope": "x",
                         "detail": "no answer-key rows for this test/skill"}, {})[0])
        self.assertEqual("SOURCE_PAGE_MISSING", reason_of({"code": "SOURCE_PDF_MISSING", "scope": "LISTENING"}, {})[0])
        self.assertEqual("SOURCE_MEDIA_UNAVAILABLE", reason_of({"code": "SOURCE_AUDIO_UNMAPPED", "scope": "L"},
                                                               {"audio_mapping_confidence": "UNMAPPED"})[0])
        self.assertIsNone(reason_of({"code": "PART_OMITTED", "scope": "L"}, {}))

    def test_disposition_precedence(self):
        g = {"IMPORT_READY": False, "READY_EXCEPT_HUMAN_QA": False}
        src = [{"reason": "SOURCE_KEY_UNAVAILABLE"}, {"reason": "RECOVERABLE_SOURCE_DEFECT"}]
        self.assertEqual("SOURCE_BLOCKED", classify(g, src, [], [], [])[0])
        self.assertEqual("RUNTIME_BLOCKED", classify(g, [{"reason": "UNSUPPORTED_INTERACTION"}], [], [], [{"x": 1}])[0])
        self.assertEqual("TECHNICALLY_RECOVERABLE", classify(g, [{"reason": "RECOVERABLE_SOURCE_DEFECT"}], [], [], [])[0])
        self.assertEqual("READY_EXCEPT_HUMAN_QA", classify({"READY_EXCEPT_HUMAN_QA": True}, src, [], [], [])[0])
        self.assertEqual("RELEASE_CANDIDATE", classify({"IMPORT_READY": True}, [], [], [], [])[0])
        self.assertEqual("NOT_RELEASEABLE", classify(g, [], [], ["X"], [])[0], "never a silent recoverable label")


if __name__ == "__main__":
    unittest.main()
