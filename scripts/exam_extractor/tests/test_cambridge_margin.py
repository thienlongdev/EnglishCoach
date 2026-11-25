import unittest

from exam_extractor.adapters.cambridge_ielts import CambridgeIeltsAdapter
from exam_extractor.tests.test_units import row
from exam_extractor.adapters.base import QUESTIONS


class CambridgeMarginTests(unittest.TestCase):
    def test_key_legend_in_proven_question_window_does_not_hide_later_skills(self):
        adapter = CambridgeIeltsAdapter()
        rows = [(1, [row('Test 4'), row('LISTENING'), row('Key'), row('map label'),
                     row('READING'), row('READING PASSAGE 1'), row('passage'),
                     row('WRITING'), row('WRITING TASK 2'), row('essay')])]
        stream = adapter.annotate(rows, 600, 800, question_window=True)
        self.assertTrue(all(a.region == QUESTIONS and a.test == 4 for a in stream))
        self.assertEqual('WRITING', stream[-1].skill)

    def test_normal_book_stream_still_recognises_back_matter(self):
        adapter = CambridgeIeltsAdapter()
        stream = adapter.annotate([(1, [row('Test 1'), row('LISTENING'), row('question'),
                                      row('Listening and Reading answer keys'), row('LISTENING'), row('1 answer')])], 600, 800)
        self.assertEqual('ANSWER_KEY', stream[-1].region)

    def test_decorated_next_skill_never_continues_writing_prompt(self):
        adapter = CambridgeIeltsAdapter()
        stream = adapter.annotate([(1, [row('Test 1'), row('X LISTENING X'), row('question'),
                                       row('X WRITING X'), row('WRITING TASK 2'), row('essay'),
                                       row('X SPEAKING X'), row('speaker prompt')])], 600, 800)
        self.assertEqual([(a.row.text, a.skill) for a in stream if a.region == QUESTIONS],
                         [('question', 'LISTENING'), ('WRITING TASK 2', 'WRITING'),
                          ('essay', 'WRITING'), ('speaker prompt', 'SPEAKING')])
    def test_resource_navigation_in_bottom_margin_is_not_question_continuation(self):
        adapter = CambridgeIeltsAdapter()
        for text in ["58 ➔ 1'1 p. 12111~ p. 1091", "p.121II~ p.110I s9"]:
            self.assertTrue(adapter.is_noise(row(text, y=770), 600, 800))

    def test_page_body_and_last_question_above_margin_remain(self):
        adapter = CambridgeIeltsAdapter()
        self.assertFalse(adapter.is_noise(row("58 ➔ 1'1 p. 12111~ p. 1091", y=400), 600, 800))
        self.assertFalse(adapter.is_noise(row("• Asking the public to 40 ……", y=730), 600, 800))

    def test_right_margin_skill_header_is_not_last_item_text(self):
        adapter = CambridgeIeltsAdapter()
        self.assertTrue(adapter.is_noise(row("Listening", x=505, y=162), 600, 800))
        self.assertFalse(adapter.is_noise(row("Listening", x=60, y=400), 600, 800))

    def test_ocr_resource_icons_and_colons_in_margin_are_furniture(self):
        adapter = CambridgeIeltsAdapter()
        text = "7/0 p: 123 | LE ______ ) p: 107 | 37"
        self.assertTrue(adapter.is_noise(row(text, y=730), 600, 800))
        self.assertFalse(adapter.is_noise(row(text, y=400), 600, 800))

