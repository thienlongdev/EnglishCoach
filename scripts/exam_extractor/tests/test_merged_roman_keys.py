import unittest
from unittest.mock import patch
from types import SimpleNamespace as NS
import numpy as np
from exam_extractor.pdf_layer import Row,Token
from exam_extractor.ielts_key_ocr import recover_merged_roman_key_rows,recover_merged_enum_key_rows
from exam_extractor.diagnostics import DiagnosticLog


class MergedRomanKeysTest(unittest.TestCase):
    def rows(self):
        return [Row(1,100,130,20,180,[Token('15',20,34),Token('ix',50,65),Token('scribble',150,180)],'OCR')]+[
            Row(1,y,y+10,20,65,[Token(str(n),20,34),Token(answer,50,65)],'OCR')
            for n,y,answer in ((16,140,'viii'),(17,160,'i'),(18,180,'iv'))]

    def image(self):
        image=np.full((128,80,3),255,dtype=np.uint8)
        image[20:52,10:60]=0;image[70:102,10:60]=0
        return image

    def cache(self,nums=('14','14','15','15')):
        from itertools import cycle
        numbers=cycle(nums);letters=cycle(('ii','ii','ix','ix'))
        return NS(recognize=lambda *a,**k:NS(words=[NS(text=next(numbers if k['allowlist']=='0123456789' else letters),conf=1)]))

    def read(self,rows,image=None,cache=None):
        with patch('exam_extractor.ocr_engine.render_region',return_value=self.image() if image is None else image):
            return recover_merged_roman_key_rows(NS(page_size=lambda p:(600,800)),rows,cache or self.cache(),DiagnosticLog(),'KEY')

    def test_each_ordinal_and_answer_comes_from_its_own_baseline(self):
        rows=self.rows();self.assertEqual(1,self.read(rows))
        self.assertEqual(['14 ii','15 ix','16 viii','17 i','18 iv'],[r.text for r in rows])

    def test_disagreement_preserves_the_original_row(self):
        rows=self.rows();before=[r.text for r in rows]
        self.assertEqual(0,self.read(rows,cache=self.cache(('14','13'))))
        self.assertEqual(before,[r.text for r in rows])

    def test_question_type_guard_does_not_truncate_text_answers(self):
        rows=self.rows();before=[r.text for r in rows]
        with patch('exam_extractor.ocr_engine.render_region',return_value=self.image()):
            self.assertEqual(0,recover_merged_roman_key_rows(NS(page_size=lambda p:(600,800)),rows,self.cache(),DiagnosticLog(),'KEY',question_kinds={14:'TEXT_GAP',15:'TEXT_GAP'}))
        self.assertEqual(before,[r.text for r in rows])

    def test_unproven_third_baseline_and_missing_anchors_remain_unresolved(self):
        image=self.image();image[115:124,10:60]=0
        self.assertEqual(0,self.read(self.rows(),image))
        self.assertEqual(0,self.read(self.rows()[:-1]))

    def test_enum_answers_use_their_own_baselines_and_values(self):
        from itertools import cycle
        rows=self.rows()
        for r,n,word in zip(rows[1:],(37,38,39),('NO','YES','NOT GIVEN')):
            r.tokens[0].text=str(n);r.tokens[1].text=word
        numbers=cycle(('35','35','36','36'));letters=cycle(('YES','YES','NO','NO'))
        cache=NS(recognize=lambda *a,**k:NS(words=[NS(text=next(numbers if k['allowlist']=='0123456789' else letters),conf=1)]))
        with patch('exam_extractor.ocr_engine.render_region',return_value=self.image()):
            self.assertEqual(1,recover_merged_enum_key_rows(NS(page_size=lambda p:(600,800)),rows,cache,DiagnosticLog(),'KEY'))
        self.assertEqual(['35 YES','36 NO'],[r.text for r in rows[:2]])
