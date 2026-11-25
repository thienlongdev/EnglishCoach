import unittest

from exam_extractor.diagnostics import DiagnosticLog
from exam_extractor.ielts_groups import parse_group
from exam_extractor.tests.test_units import rows


class CompletionContextTests(unittest.TestCase):
    def test_title_and_wrapped_prefix_survive_first_gap(self):
        source = rows("Complete the notes below.", "Write ONE WORD ONLY for each answer.",
                      "Synthetic report title", "Recent observations:",
                      "A synthetic study found an increase in", "31 … .", "32 … helps participants.")
        group = parse_group(source, 31, 32, "LISTENING/PART_4", DiagnosticLog(), ocr=True)
        self.assertIsNotNone(group)
        self.assertIn("Synthetic report title", group.stem)
        self.assertIn("A synthetic study found an increase in", group.stem)
        self.assertIn("A synthetic study found an increase in", group.items[0].prompt)
        self.assertNotIn("Write ONE WORD", group.stem)
        self.assertEqual([31, 32], [i.number for i in group.items])
