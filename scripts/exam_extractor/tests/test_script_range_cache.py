import copy
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from exam_extractor.script_ranges import explanation_ranges
from exam_extractor.toeic_scan import BudgetExhausted


class ScriptRangeCacheTests(unittest.TestCase):
    def test_complete_proof_reuses_ranges_and_invalid_proofs_fall_back(self):
        ranges = [(q, q + 2) for q in range(32, 71, 3)] + [(q, q + 2) for q in range(71, 101, 3)]
        proof = dict(sha256='source-hash', test=1, chapterPages=[10, 19],
                     identityBasis='PRINTED_KEY_CHAPTER_AND_DUAL_FOOTER', rejected=[],
                     ranges=[dict(range=list(pair), page=11, bbox=[10, 10, 40, 20], footerIdentity=[1])
                             for pair in ranges])
        with tempfile.TemporaryDirectory() as folder:
            staging = Path(folder)
            target = staging / 'reports/ocr_script_ranges/book__test-1.json'
            target.parent.mkdir(parents=True)
            ctx = SimpleNamespace(ex=SimpleNamespace(staging=staging),
                                  layer=SimpleNamespace(sha256='source-hash', page_count=30,
                                                        page_size=lambda page: (600, 800)),
                                  profile=SimpleNamespace(book='book'), used=[], budget=0)
            blocks = {1: SimpleNamespace(test=1, page=10, orientation='rows'),
                      2: SimpleNamespace(test=2, page=20, orientation='rows')}
            target.write_text(json.dumps(proof), encoding='utf-8')
            result = explanation_ranges(ctx, 1, 'TOEIC_LR_2016', blocks)
            self.assertEqual(ranges[:13], result[3])
            self.assertEqual(ranges[13:], result[4])
            self.assertEqual([], ctx.used)
            mutations = [lambda p: p.update(sha256='stale'),
                         lambda p: p.update(chapterPages=[10, 20]),
                         lambda p: p.update(test=2),
                         lambda p: p.update(rejected=[{'reason': 'conflict'}]),
                         lambda p: p['ranges'].pop(),
                         lambda p: p['ranges'][0].update(footerIdentity=[2]),
                         lambda p: p['ranges'][0].update(bbox=[40, 10, 10, 20]),
                         lambda p: p['ranges'][0].update(page=20)]
            for mutate in mutations:
                candidate = copy.deepcopy(proof)
                mutate(candidate)
                target.write_text(json.dumps(candidate), encoding='utf-8')
                with self.subTest(proof=candidate), self.assertRaises(BudgetExhausted):
                    explanation_ranges(ctx, 1, 'TOEIC_LR_2016', blocks)
