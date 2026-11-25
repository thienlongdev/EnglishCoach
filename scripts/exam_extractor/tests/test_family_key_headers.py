"""Family keys must retain every printed block and refuse conflicting identities."""
import unittest
from types import SimpleNamespace
from unittest.mock import patch
import numpy as np

from exam_extractor.key_tables import find_blocks, _dedupe_heads
from exam_extractor.ocr_engine import OcrWord


class Cache:
    def __init__(self, words):
        self.words = words

    def recognize(self, layer, page, bbox, **kwargs):
        pipeline = kwargs['pipeline']
        if pipeline in self.words:
            return SimpleNamespace(words=self.words[pipeline])
        # Caption rereads see only the ink inside their own crop. These tests
        # exercise block geometry; caption consensus has separate conflict tests.
        x0, y0, x1, y1 = bbox
        own = {(word.text, tuple(word.bbox)): word
               for words in self.words.values() for word in words
               if word.bbox[0] >= x0 and word.bbox[1] >= y0
               and word.bbox[2] <= x1 and word.bbox[3] <= y1}
        return SimpleNamespace(words=list(own.values()))


class KeyHeaderTests(unittest.TestCase):
    def test_mixed_inverse_and_normal_headers_are_all_retained(self):
        layer = SimpleNamespace(page_size=lambda page: (600, 800))
        cache = Cache({'P1': [OcrWord('Test 1', (60, 50, 100, 65), 1),
                              OcrWord('Test 3', (60, 400, 100, 415), 1)],
                       'P4': [OcrWord('Test 2', (60, 225, 100, 240), 1),
                              OcrWord('Test 3', (60, 400, 100, 415), 1)]})
        blocks = find_blocks(layer, 1, cache)
        self.assertEqual([1, 2, 3], [b[0] for b in blocks])
        self.assertLess(blocks[0][1][3], 225)
        self.assertLess(blocks[1][1][3], 400)

    def test_centred_title_does_not_cut_off_left_key_columns(self):
        layer = SimpleNamespace(page_size=lambda page: (600, 800))
        words = [OcrWord('TEST 1', (250, 50, 330, 70), 1)]
        blocks = find_blocks(layer, 1, Cache({'P1': words, 'P4': words}))
        self.assertEqual(8, blocks[0][1][0])
        self.assertEqual(592, blocks[0][1][2])
        self.assertEqual(800, blocks[0][1][3])

    def test_conflicting_reads_never_choose_a_test(self):
        heads = _dedupe_heads([(1, (50, 50, 100, 70), 'Test 1'),
                               (7, (50, 50, 100, 70), 'Test 7')])
        self.assertEqual(1, len(heads))
        self.assertIsNone(heads[0][0])

    def test_compact_table_isolated_from_adjacent_explanations(self):
        layer = SimpleNamespace(page_size=lambda page: (600, 800), doc=object())
        words = [OcrWord('TEST 1', (30, 40, 95, 60), 1)]
        regions = [SimpleNamespace(kind='TEXT', bbox=(30, 75, 215, 295), meta={'lines': 100}),
                   SimpleNamespace(kind='TEXT', bbox=(250, 75, 570, 700), meta={'lines': 60})]
        with patch('exam_extractor.key_tables.render_region', return_value=np.full((1667, 1250), 255, dtype=np.uint8)), \
                patch('exam_extractor.key_tables._dark_bars', return_value=[(42, 79, 484, 134)]), \
                patch('exam_extractor.layout.analyze_page', return_value=SimpleNamespace(regions=regions)):
            blocks = find_blocks(layer, 1, Cache({'P1': words, 'P4': words}))
        self.assertEqual(1, blocks[0][0])
        self.assertEqual((25, 61, 220, 300), blocks[0][1])


if __name__ == '__main__':
    unittest.main()
