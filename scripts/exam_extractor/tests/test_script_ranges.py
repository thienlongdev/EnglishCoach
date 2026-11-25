"""Chapter attribution and independent printed range proof; no raw corpus fixture."""
import unittest
from types import SimpleNamespace as NS
from unittest.mock import patch

from exam_extractor.script_ranges import (chapter_interval, dialogue_header, parse_range,
                                         explanation_ranges, range_glyph_bbox)


class ScriptRangesTest(unittest.TestCase):
    def test_identity_does_not_follow_chapter_position(self):
        blocks = {7: NS(test=7, page=20, orientation='ROW_MAJOR'),
                  2: NS(test=2, page=50, orientation='ROW_MAJOR')}
        self.assertEqual(chapter_interval(blocks, 7, 100), (20, 49))
        self.assertEqual(chapter_interval(blocks, 2, 100), (50, 100))
        self.assertIsNone(chapter_interval(blocks, 1, 100))

    def test_compact_answer_pages_are_not_chapters(self):
        blocks = {1: NS(test=1, page=20, orientation='ROW_MAJOR'),
                  2: NS(test=2, page=20, orientation='ROW_MAJOR')}
        self.assertIsNone(chapter_interval(blocks, 1, 100))

    def test_range_is_never_repaired_from_expected_sequence(self):
        self.assertEqual(parse_range('41–43'), (41, 43))
        for text in ('4I-43', '41 43', '43-41', 'Questions 41-43', '41-143'):
            self.assertIsNone(parse_range(text))

    def test_embedded_range_is_not_dialogue_heading(self):
        word = NS(text='41-43', bbox=(50, 100, 80, 110))
        speaker = NS(text='W-Am', bbox=(56, 130, 80, 140))
        self.assertTrue(dialogue_header([word, speaker], word))
        prose = NS(text='explained', bbox=(85, 100, 120, 110))
        self.assertFalse(dialogue_header([word, prose, speaker], word))
        distant = NS(text='W-Am', bbox=(150, 130, 180, 140))
        self.assertFalse(dialogue_header([word, distant], word))

    def context(self, footer=('TEST 7', 'TEST 7'), own=('41-43', '41-43'),
                fresh=('', '', '', '')):
        header = NS(text='41-43', bbox=(50, 100, 80, 110))
        speaker = NS(text='W-Am', bbox=(56, 130, 80, 140))
        def recognize(layer, page, bbox, dpi, pipeline, **kwargs):
            if dpi == 150:
                return NS(words=[header, speaker])
            if bbox[1] > 600:
                text = footer[pipeline == 'P2'] if dpi == 450 else ''
            elif (dpi, pipeline) in ((600, 'P5'), (600, 'P6'), (900, 'P1'), (900, 'P2')):
                text = fresh[((600, 'P5'), (600, 'P6'), (900, 'P1'), (900, 'P2')).index((dpi, pipeline))]
            else:
                text = own[pipeline == 'P2']
            return NS(words=[NS(text=text)])
        return NS(layer=NS(page_count=20, sha256='fixture', page_size=lambda page: (500, 700)),
                  profile=NS(footer_identity_band=(0, .9, 1, 1), footer_identity_dpi=450,
                             test_furniture=r'\bTEST\s+(\d+)\b'),
                  cache=NS(recognize=recognize), used=[], budget=1, ex=NS())

    def test_own_range_and_footer_reads_are_required(self):
        crop = patch('exam_extractor.script_ranges.range_glyph_bbox', return_value=(48, 98, 82, 112))
        crop.start()
        self.addCleanup(crop.stop)
        blocks = {7: NS(test=7, page=20, orientation='ROW_MAJOR')}
        ctx = self.context()
        self.assertEqual(explanation_ranges(ctx, 7, 'TOEIC_LR_2016', blocks), {3: [(41, 43)]})
        self.assertIsNone(explanation_ranges(self.context(own=('41-43', '41-44')),
                                             7, 'TOEIC_LR_2016', blocks))
        self.assertIsNone(explanation_ranges(self.context(footer=('TEST 6', 'TEST 6')),
                                             7, 'TOEIC_LR_2016', blocks))
        self.assertIsNone(explanation_ranges(self.context(footer=('TEST 7', 'TEST 6')),
                                             7, 'TOEIC_LR_2016', blocks))

    @patch('exam_extractor.script_ranges.range_glyph_bbox', return_value=(48, 98, 82, 112))
    def test_absent_footer_alone_cannot_establish_chapter_identity(self, _crop):
        blocks = {7: NS(test=7, page=20, orientation='ROW_MAJOR')}
        self.assertIsNone(explanation_ranges(self.context(footer=('', '')),
                                             7, 'TOEIC_LR_2016', blocks))

    def test_same_line_title_crop_uses_ink_gap(self):
        import numpy as np
        image = np.full((80, 420, 3), 255, dtype=np.uint8)
        # Seven compact numeral/hyphen glyphs, then a separated title.
        for x in range(10, 220, 30):
            image[10:65, x:x + 20] = 0
        image[10:65, 290:400] = 0
        word = NS(text='98-100 merged title', bbox=(50, 100, 98, 108))
        with patch('exam_extractor.ocr_engine.render_region', return_value=image):
            bbox = range_glyph_bbox(NS(), 1, word, 500, 700)
        self.assertLess(bbox[2], 80)
        self.assertGreater(bbox[2], 70)

    @patch('exam_extractor.script_ranges.range_glyph_bbox', return_value=(48, 98, 82, 112))
    def test_fresh_range_retries_require_three_independent_votes(self, _crop):
        blocks = {7: NS(test=7, page=20, orientation='ROW_MAJOR')}
        for fresh, expected in ((('41-43', '41-43', '41-43', '41-44'), {3: [(41, 43)]}),
                                (('41-43', '41-43', '', ''), None)):
            ctx = self.context(own=('41-43', ''), fresh=fresh)
            self.assertEqual(explanation_ranges(ctx, 7, 'TOEIC_LR_2016', blocks), expected)


if __name__ == '__main__':
    unittest.main()
