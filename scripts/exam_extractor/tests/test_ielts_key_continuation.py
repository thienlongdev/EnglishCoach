"""IELTS key chapters retain printed test identity across facing key pages."""
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from exam_extractor.diagnostics import DiagnosticLog
from exam_extractor.pdf_layer import Row, Token
from exam_extractor.pipeline import Extractor, IELTS_SCAN_PROFILES


def row(page, text):
    return Row(page, 100, 110, 20, 200, [Token(text, 20, 200)])


class IeltsKeyContinuationTest(unittest.TestCase):
    def stream(self, key_pages):
        extractor = Extractor.__new__(Extractor)
        extractor.region_cache = lambda: SimpleNamespace(engine=SimpleNamespace(available=lambda: True))
        layer = SimpleNamespace(rel_path='source.pdf', page_size=lambda p: (600, 800))
        profile = {'test_pages': {5: (1, 1)}, 'key_pages': (2, 4), 'budget': 4}
        test = SimpleNamespace(book='fixture', diagnostics=DiagnosticLog(), extraction_methods=set(), ocr_pages={})
        adapter = SimpleNamespace(annotate=lambda *args, **kwargs: [])
        with patch('exam_extractor.layout.analyze_page', side_effect=lambda layer, p, lp: p), \
             patch('exam_extractor.layout.ocr_layout', side_effect=lambda layer, p, *args: key_pages.get(p, [])), \
             patch('exam_extractor.layout.inverse_rows', return_value=[]), \
             patch('exam_extractor.layout.merge_by_y', side_effect=lambda a, b: a), \
             patch('exam_extractor.ocr_quality.reread_gap_numbers', return_value=0):
            return extractor._ocr_stream(adapter, layer, profile, 5, test)

    def test_reading_keys_keep_their_preceding_printed_test(self):
        stream = self.stream({2: [row(2, 'TEST 5'), row(2, 'LISTENING'), row(2, '1 key')],
                              3: [row(3, 'READING'), row(3, '1 other-key')]})
        self.assertEqual([(5, 'LISTENING'), (5, 'READING')], [(r.test, r.skill) for r in stream])

    def test_new_printed_badge_replaces_the_context(self):
        stream = self.stream({2: [row(2, 'TEST 5'), row(2, 'LISTENING'), row(2, '1 key')],
                              3: [row(3, 'TEST 6'), row(3, 'READING'), row(3, '1 other-key')]})
        self.assertEqual([5, 6], [r.test for r in stream])

    def test_requested_test_does_not_supply_an_absent_badge(self):
        self.assertEqual([], self.stream({2: [row(2, 'LISTENING'), row(2, '1 key')],
                                         3: [row(3, 'READING'), row(3, '1 other-key')]}))

    def test_continuation_requires_its_own_skill_heading(self):
        stream = self.stream({2: [row(2, 'TEST 5'), row(2, 'LISTENING'), row(2, '1 key')],
                              3: [row(3, '1 unlabelled-key')]})
        self.assertEqual(1, len(stream))

    def test_new_listening_chapter_cannot_borrow_previous_badge(self):
        stream = self.stream({2: [row(2, 'TEST 5'), row(2, 'LISTENING'), row(2, '1 key')],
                              3: [row(3, 'LISTENING'), row(3, '1 unlabelled-key')],
                              4: [row(4, 'READING'), row(4, '1 other-key')]})
        self.assertEqual(1, len(stream))

    def test_new_badge_cannot_borrow_previous_skill(self):
        stream = self.stream({2: [row(2, 'TEST 5'), row(2, 'LISTENING'), row(2, '1 key'),
                                      row(2, 'TEST 6'), row(2, '1 unlabelled-key')]})
        self.assertEqual(1, len(stream))

    def test_cambridge12_retains_printed_tests_five_through_eight(self):
        profile = IELTS_SCAN_PROFILES['cambridge-ielts-12']
        self.assertEqual({5, 6, 7, 8}, set(profile['test_pages']))
        self.assertEqual({5, 6, 7, 8}, set(profile['key_pages_by_test']))
        self.assertNotIn('key_test_from_source', profile)

    def test_cambridge19_uses_verified_physical_pages_and_bounded_family(self):
        profile=IELTS_SCAN_PROFILES['cambridge-ielts-19']
        self.assertEqual({1,2,3,4},set(profile['test_pages']))
        self.assertEqual((9,31),profile['test_pages'][1])
        self.assertEqual((119,120),profile['key_pages_by_test'][1])
        for n,(a,b) in profile['test_pages'].items():
            ka,kb=profile['key_pages_by_test'][n]
            self.assertLessEqual(b-a+1+kb-ka+1,profile['budget'])
        self.assertNotIn('key_test_from_source',profile)


if __name__ == '__main__':
    unittest.main()
