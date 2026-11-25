import unittest
from exam_extractor.pdf_layer import Row,Token
from exam_extractor.toeic_scan import strip_ybm_brand_footer


def row(text,y=670,x0=205,x1=312):
    return Row(1,y,y+13,x0,x1,[Token(text,x0,x1)],'OCR')


class YbmFooterTest(unittest.TestCase):
    def test_centered_footer_removed_without_touching_option(self):
        option=row('(D) demand',y=640,x0=280,x1=350)
        rows=[option,row('Benzen English - TOEIC')]
        self.assertEqual(1,strip_ybm_brand_footer(rows,508,729))
        self.assertEqual([option],rows)

    def test_same_words_in_question_body_are_preserved(self):
        body=row('Benzen English - TOEIC',y=200)
        rows=[body]
        self.assertEqual(0,strip_ybm_brand_footer(rows,508,729))
        self.assertEqual([body],rows)

    def test_footer_pattern_cannot_strip_answer_text_or_side_column(self):
        rows=[row('(D) demand Benzen English - TOEIC'),row('Benzen English - TOEIC',x0=10,x1=117)]
        self.assertEqual(0,strip_ybm_brand_footer(rows,508,729))
