"""Printed part boundaries must not leak directions into scored options."""
import unittest

from exam_extractor.diagnostics import DiagnosticLog
from exam_extractor.toeic import _parse_items
from exam_extractor.tests.test_units import rows


class PartBoundaryTests(unittest.TestCase):
    def test_long_adjacent_option_is_not_truncated(self):
        long_text = "synthetic " * 15
        source = rows("130. Synthetic question", "(A) first", "(B) second", "(C) third", "(D) " + long_text,
                      "continued source text", "PART 6")
        items = _parse_items(source, [130], DiagnosticLog(), "READING/PART_5")
        self.assertEqual(items[0].options[-1].text, long_text.strip() + " continued source text")

    def test_disconnected_nonfinal_option_fails_closed(self):
        source = rows("130. Synthetic question", "(A) first")
        continuation = rows("possible continuation", page=2)[0]
        log = DiagnosticLog()
        self.assertIsNone(_parse_items(source + [continuation] + rows("(B) second", "(C) third", "(D) final", page=2),
                                       [130], log, "READING/PART_5"))
        self.assertEqual(log.items[-1].code, "OPTION_CONTINUATION_UNPROVEN")

    def test_column_furniture_does_not_continue_final_option(self):
        source = rows("130. Synthetic question", "(A) first", "(B) second", "(C) third", "(D) final")
        debris = rows("Synthetic sidebar texture")[0]
        debris.column = 1
        items = _parse_items(source + [debris], [130], DiagnosticLog(), "READING/PART_5")
        self.assertEqual(items[0].options[-1].text, "final")

    def test_next_page_header_does_not_continue_final_option(self):
        source = rows("130. Synthetic question", "(A) first", "(B) second", "(C) third", "(D) final")
        header = rows("Synthetic decorative header", page=2)[0]
        items = _parse_items(source + [header], [130], DiagnosticLog(), "READING/PART_5")
        self.assertEqual(items[0].options[-1].text, "final")
    def test_next_part_closes_final_option_after_real_continuation(self):
        source = rows("130. Synthetic question", "(A) first", "(B) second",
                      "(C) third", "(D) final", "continued option text",
                      "PART 6", "Directions: Synthetic next-part instructions",
                      "Questions 131-134 refer to the following e-mail.")
        items = _parse_items(source, [130], DiagnosticLog(), "READING/PART_5")
        self.assertEqual(items[0].options[-1].text, "final continued option text")

    def test_boundary_before_required_question_still_fails_closed(self):
        log = DiagnosticLog()
        source = rows("129. Synthetic question", "(A) first", "(B) second",
                      "(C) third", "(D) final", "PART 6", "130. Wrong part")
        self.assertIsNone(_parse_items(source, [129, 130], log, "READING/PART_5"))
        self.assertEqual(log.items[-1].code, "QUESTION_NUMBER_GAP")

    def test_heading_with_inline_directions_closes_block(self):
        source = rows("130. Synthetic question", "(A) first", "(B) second",
                      "(C) third", "(D) final", "PART 6 Directions: next part")
        items = _parse_items(source, [130], DiagnosticLog(), "READING/PART_5")
        self.assertEqual(items[0].options[-1].text, "final")
