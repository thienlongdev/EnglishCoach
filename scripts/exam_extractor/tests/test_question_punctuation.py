import unittest
from unittest.mock import patch
from types import SimpleNamespace as NS
import numpy as np
from exam_extractor.pdf_layer import Row,Token
from exam_extractor.toeic_scan import read_split_ordinal_punctuation,reread_bare_question_ordinals


class QuestionPunctuationTest(unittest.TestCase):
    def row(self):
        return Row(1,100,120,20,150,[Token('31',20,35),Token('2',37,40),Token('Mark your answer',50,150)],'OCR')

    def image(self,tall=False,top=False):
        image=np.full((184,34,3),255,dtype=np.uint8)
        y=20 if top else 135
        image[y:y+(70 if tall else 20),7:27]=0
        return image

    def cache(self,values=('31','31','31'),conf=1):
        values=iter(values)
        return NS(recognize=lambda *a,**k:NS(words=[NS(text=next(values),conf=conf)]))

    def read(self,image=None,cache=None):
        row=self.row()
        with patch('exam_extractor.toeic_scan.render_region',return_value=self.image() if image is None else image):
            return read_split_ordinal_punctuation(object(),row,row.tokens[:2],cache or self.cache())

    def test_dot_and_three_own_number_reads_recover_printed_identity(self):
        self.assertEqual('31',self.read())
        # The number is supplied by ink reads, never the initial OCR token or sequence.
        self.assertEqual('29',self.read(cache=self.cache(('29',)*3)))

    def test_real_digit_sized_or_high_mark_is_not_discarded(self):
        self.assertIsNone(self.read(self.image(tall=True)))
        self.assertIsNone(self.read(self.image(top=True)))

    def test_disagreement_or_low_confidence_remains_unresolved(self):
        self.assertIsNone(self.read(cache=self.cache(('31','32','31'))))
        self.assertIsNone(self.read(cache=self.cache(conf=.6)))

    def test_hollow_mark_is_not_a_punctuation_dot(self):
        image=self.image();image[139:151,11:23]=255
        self.assertIsNone(self.read(image))

    def test_response_row_gets_exact_proven_ordinal_and_period(self):
        row=self.row()
        with patch('exam_extractor.toeic_scan.render_region',return_value=self.image()):
            self.assertEqual(1,reread_bare_question_ordinals(object(),[row],self.cache()))
        self.assertEqual('31. Mark your answer',row.text)
