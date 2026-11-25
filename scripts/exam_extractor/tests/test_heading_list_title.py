import unittest
from exam_extractor.ielts_groups import parse_group
from exam_extractor.diagnostics import DiagnosticLog
from exam_extractor.model import GK_HEADINGS, GK_MATCHING
from exam_extractor.tests.test_units import rows


class HeadingListTitleTest(unittest.TestCase):
    def test_own_printed_list_title_disambiguates_damaged_instruction(self):
        source = rows('Choose the correct headina from the list below.',
                      'List Of Headings', 'i Synthetic heading alpha',
                      'ii Synthetic heading beta', 'iii Synthetic heading gamma',
                      '27 Section A', '28 Section B')
        group = parse_group(source, 27, 28, 'READING', DiagnosticLog(), True)
        self.assertIsNotNone(group)
        self.assertEqual(GK_HEADINGS, group.kind)
        self.assertEqual(['i', 'ii', 'iii'], [o.id for o in group.options])

    def test_another_list_title_retains_matching_type(self):
        source = rows('Choose from the list below.', 'List of people',
                      'A Synthetic person alpha', 'B Synthetic person beta',
                      'C Synthetic person gamma', '27 Description alpha',
                      '28 Description beta')
        for row in source[2:5]:
            row.tokens[0].bold = True
        group = parse_group(source, 27, 28, 'READING', DiagnosticLog(), True)
        self.assertIsNotNone(group)
        self.assertEqual(GK_MATCHING, group.kind)
