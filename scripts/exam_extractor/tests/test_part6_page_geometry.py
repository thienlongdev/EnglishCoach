import unittest
from unittest.mock import patch
from types import SimpleNamespace

from exam_extractor.pdf_layer import DOTS, Row, Token
from exam_extractor.toeic_sets import map_part6_blanks
from exam_extractor.ocr_quality import insert_blanks, reread_blank_labels
from exam_extractor.diagnostics import DiagnosticLog, INFO


def row(page, y, text, x=130):
    return Row(page, y, y + 10, x, x + 45, [Token(text, x, x + 45)])


class Part6PageGeometryTests(unittest.TestCase):
    def test_complete_blank_proof_has_a_registered_audit_code(self):
        log = DiagnosticLog()
        log.add('SOURCE_BLANK_LABELS_DUAL_READ', 'READING/PART_6')
        self.assertEqual(INFO, log.items[0].severity)

    def test_blank_label_requires_two_independent_matching_reads(self):
        for values, expected in [(['131.', '131.'], 1), (['131.', '132.'], 0)]:
            reads = iter(values)
            cache = SimpleNamespace(recognize=lambda *a, **kw: SimpleNamespace(
                words=[SimpleNamespace(text=next(reads), conf=.9)]))
            rows = [row(1, 100, DOTS)]
            with patch('exam_extractor.ocr_quality._label_band', return_value=(130, 110, 150, 120)):
                self.assertEqual(expected, reread_blank_labels(SimpleNamespace(sha256='source'), rows, cache, 131, 146))
            if expected:
                self.assertEqual([131, 131], rows[1].blank_label_proof['reads'])
            else:
                self.assertTrue(rows[0].blank_label_conflict)

    def test_two_reads_of_the_same_dash_run_create_one_blank(self):
        source = [row(1, 100, DOTS)]
        insert_blanks(source, [(105, 131, 158, 'DASH_RUN')])
        self.assertEqual(1, sum(t.text == DOTS for t in source[0].tokens))
        self.assertEqual((130, 175), (source[0].tokens[0].x0, source[0].tokens[0].x1))

    def test_separate_dash_runs_remain_separate(self):
        source = [Row(1, 100, 110, 100, 250, [Token(DOTS,100,130),Token('text',140,180),Token(DOTS,200,230)])]
        insert_blanks(source, [(105, 201, 226, 'DASH_RUN')])
        self.assertEqual(2, sum(t.text == DOTS for t in source[0].tokens))

    def test_same_coordinates_on_two_pages_are_distinct_blanks(self):
        source = [row(1, 100, DOTS), row(1, 111, '131.'),
                  row(2, 100, DOTS), row(2, 111, '132.')]
        mapping, method, detail = map_part6_blanks(source, [131, 132])
        self.assertEqual({131: (0, 0), 132: (2, 0)}, mapping)
        self.assertEqual('GEOMETRY_LABEL', method)

    def test_label_cannot_claim_a_blank_on_another_page(self):
        mapping, _, detail = map_part6_blanks([row(1, 100, DOTS), row(2, 111, '131.')], [131])
        self.assertIsNone(mapping)
        self.assertIn('no blank', detail)

    def test_reading_order_uses_page_before_vertical_coordinate(self):
        source = [row(1, 600, DOTS), row(1, 611, '131.'),
                  row(2, 100, DOTS), row(2, 111, '132.')]
        self.assertIsNotNone(map_part6_blanks(source, [131, 132])[0])
