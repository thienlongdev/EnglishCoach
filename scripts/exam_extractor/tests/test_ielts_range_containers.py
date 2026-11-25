import unittest
from exam_extractor.ielts import split_parts, segment_groups, _merge_overlaps
from exam_extractor.diagnostics import DiagnosticLog
from exam_extractor.tests.test_units import rows


class PrintedRangeContainersTest(unittest.TestCase):
    def test_printed_section_range_is_a_container_after_a_long_preamble(self):
        source = rows('SECTION 2 Questions 11-20', 'Synthetic notes', 'Read these instructions',
                      'A further heading', 'Additional directions', 'Questions 11-14',
                      'Choose the correct letter.', 'Questions 15-16',
                      'Choose TWO letters.', 'Questions 17-20', 'Match the descriptions.')
        parts = split_parts(source)
        self.assertEqual(2, parts[0][0])
        groups = segment_groups(parts[0][1])
        self.assertEqual([(11,14), (15,16), (17,20)], [(a,b) for a,b,_ in groups])
        self.assertEqual(3, len(_merge_overlaps(groups, 'LISTENING/PART_2', DiagnosticLog())))

    def test_a_distant_unmarked_overlap_is_not_silently_discarded(self):
        source = rows('Questions 11-20', 'Synthetic heading', 'First line', 'Second line',
                      'Third line', 'Questions 11-14', 'Choose the correct letter.')
        groups = segment_groups(source)
        log = DiagnosticLog()
        self.assertEqual([], _merge_overlaps(groups, 'LISTENING/PART_2', log))
        self.assertTrue(log.has_blocking())
