import unittest
from types import SimpleNamespace
from unittest.mock import patch
from exam_extractor.key_tables import read_compact_key_title, _dedupe_heads, reread_plain_key_title, find_blocks
from exam_extractor.source_index import key_page_candidate, compact_key_grid_candidate


class CompactKeyTitleTest(unittest.TestCase):
    def test_correct_high_resolution_title_is_not_discarded(self):
        word = SimpleNamespace(text='Actual Test 8', bbox=(50, 300, 110, 310))
        layer = SimpleNamespace(page_size=lambda page: (600, 750))
        cache = SimpleNamespace(recognize=lambda *args, **kwargs: SimpleNamespace(
            words=[word] if kwargs.get('dpi') == 300 else []))
        with patch('exam_extractor.key_tables.reread_plain_key_title', return_value=(8, [8] * 4)):
            blocks = find_blocks(layer, 1, cache)
        self.assertEqual(8, blocks[0][0])

    def test_fused_damaged_caption_retains_its_own_unassigned_boundary(self):
        word = SimpleNamespace(text='Actuavest6', bbox=(50, 100, 110, 110))
        layer = SimpleNamespace(page_size=lambda page: (600, 750))
        cache = SimpleNamespace(recognize=lambda *args, **kwargs: SimpleNamespace(words=[word]))
        with patch('exam_extractor.key_tables.reread_plain_key_title', return_value=(None, [None] * 4)):
            blocks = find_blocks(layer, 1, cache)
        self.assertEqual(1, len(blocks))
        self.assertIsNone(blocks[0][0])
        self.assertEqual(111, blocks[0][1][1])

    def test_letter_o_caption_retains_unassigned_table_boundary(self):
        word = SimpleNamespace(text='Ackual Tesk O8', bbox=(50, 300, 110, 310))
        layer = SimpleNamespace(page_size=lambda page: (600, 750))
        cache = SimpleNamespace(recognize=lambda *args, **kwargs: SimpleNamespace(words=[word]))
        with patch('exam_extractor.key_tables.reread_plain_key_title', return_value=(None, [None] * 4)):
            blocks = find_blocks(layer, 1, cache)
        self.assertEqual(1, len(blocks))
        self.assertIsNone(blocks[0][0])
        self.assertEqual(311, blocks[0][1][1])

    def test_tighter_caption_requires_its_own_consensus(self):
        word = SimpleNamespace(text='Ackual tesk 04', bbox=(50, 300, 110, 310))
        layer = SimpleNamespace(page_size=lambda page: (600, 750))
        cache = SimpleNamespace(recognize=lambda *args, **kwargs: SimpleNamespace(words=[word]))
        with patch('exam_extractor.key_tables.reread_plain_key_title',
                   side_effect=[(None, [4, None, 4, None]), (4, [4] * 4)]) as retry:
            blocks = find_blocks(layer, 1, cache)
        self.assertEqual(4, blocks[0][0])
        self.assertEqual(2, retry.call_args.kwargs['padding'])

    def test_plain_caption_requires_three_fresh_explicit_test_readings(self):
        class Cache:
            def __init__(self, values): self.values = iter(values)
            def recognize(self, *args, **kwargs):
                return SimpleNamespace(words=[SimpleNamespace(text=next(self.values))])
        number, _ = reread_plain_key_title(None, 1, Cache(['Actual Test 02', 'Test 2', 'Test 2', 'Test 7']), (50, 50, 100, 60))
        self.assertEqual(2, number)
        for values in [['Test 2', 'Test 2', 'Test 7', 'Test 7'], ['2'] * 4, ['Test 64'] * 4]:
            self.assertIsNone(reread_plain_key_title(None, 1, Cache(values), (50, 50, 100, 60))[0])

    def test_overlapping_whole_and_suffix_title_are_one_physical_header(self):
        heads = [(10, (59, 605, 145, 619), 'Actual Test 10'),
                 (10, (83, 607, 145, 620), 'Test 10')]
        result = _dedupe_heads(heads)
        self.assertEqual(1, len(result))
        self.assertEqual(10, result[0][0])
        self.assertEqual((59, 605, 145, 620), result[0][1])

    def test_overlapping_conflicting_title_stays_unassigned(self):
        self.assertIsNone(_dedupe_heads([(10, (59, 605, 145, 619), 'Test 10'),
                                        (1, (83, 607, 145, 620), 'Test 1')])[0][0])

    def test_distinct_same_row_titles_are_separate_tables(self):
        self.assertEqual(2, len(_dedupe_heads([(1, (50, 50, 130, 65), 'Test 1'),
                                             (2, (300, 50, 380, 65), 'Test 2')])))
    def test_compact_grid_requires_its_own_physical_title_above(self):
        from exam_extractor.layout import TEXT, INVERSE
        grid = SimpleNamespace(kind=TEXT, bbox=(50, 65, 260, 210), meta={'lines': 100})
        bar = SimpleNamespace(kind=INVERSE, bbox=(50, 30, 265, 50), meta={'horizontal': True})
        with patch('exam_extractor.layout.analyze_page', return_value=SimpleNamespace(regions=[grid, bar])):
            self.assertTrue(compact_key_grid_candidate(None, 232))
            bar.bbox = (50, 250, 265, 270)
            self.assertFalse(compact_key_grid_candidate(None, 232))
    def test_answer_heading_with_ordinal_density_proposes_faint_key_cells(self):
        self.assertTrue(key_page_candidate(503, 4, 1, ['ANSWER_KEY']))
        self.assertFalse(key_page_candidate(503, 4, 1, ['TEST_HEADER']))

    def test_score_conversion_never_proposes_question_keys(self):
        self.assertFalse(key_page_candidate(100, 100, 0, ['ANSWER_KEY', 'SCORE_CONVERSION']))

    def read(self, normal='TEST 3', inverse='TEST 3', confidence=0.9):
        class Cache:
            def recognize(self, *args, **kwargs):
                text = normal if kwargs['pipeline'] == 'P1' else inverse
                return SimpleNamespace(words=[SimpleNamespace(text=text, conf=confidence,
                    bbox=(60, 39, 121, 57))])
        return read_compact_key_title(None, 232, Cache(), (53, 33, 262, 60))

    def test_own_normal_inverse_reads_agree(self):
        self.assertEqual(3, self.read()[0])

    def test_conflicting_title_identity_stays_unassigned(self):
        self.assertIsNone(self.read(inverse='TEST 8'))

    def test_unreadable_or_low_confidence_title_stays_unassigned(self):
        self.assertIsNone(self.read(normal='TEST'))
        self.assertIsNone(self.read(confidence=0.4))


if __name__ == '__main__':
    unittest.main()
