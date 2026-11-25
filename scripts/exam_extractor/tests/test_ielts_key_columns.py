import unittest
from types import SimpleNamespace as NS
from exam_extractor.adapters.base import AnnotatedRow,ANSWER_KEY
from exam_extractor.pdf_layer import Row,Token
from exam_extractor.ielts import skill_key_rows


class IeltsKeyColumnsTest(unittest.TestCase):
    def test_merged_rows_use_own_key_gutter_and_physical_column_order(self):
        rows=[]
        # Region traversal places the upper right remainder after lower rows.
        for y,left,right in [(100+20*k,k+1,k+8) for k in range(6)]:
            rows.append(Row(1,y,y+10,20,350,[Token(str(left),20,30),Token('long answer',60,180),
                Token(str(right),300,310),Token('B',340,350)],'OCR'))
        rows.append(Row(1,90,100,300,350,[Token('7',300,310),Token('A',340,350)],'OCR'))
        rows.append(Row(1,230,240,20,550,[Token('you are unlikely to get an acceptable score',20,550)],'OCR'))
        stream=[AnnotatedRow(r,ANSWER_KEY,1,'READING') for r in rows]
        found=skill_key_rows(stream,1,'READING',NS(page_size=lambda p:(600,800)))
        self.assertEqual([f'{n} long answer' for n in range(1,7)]+['7 A']+[f'{n} B' for n in range(8,14)],
            [r.text for r in found if r.tokens[0].text.isdigit()])

    def test_score_rows_cannot_supply_key_ordinals(self):
        rows=[Row(1,100,110,20,100,[Token('0-14',20,40),Token('score',60,100)],'OCR')]
        stream=[AnnotatedRow(r,ANSWER_KEY,1,'LISTENING') for r in rows]
        self.assertFalse(any(r.tokens[0].text.isdigit() for r in skill_key_rows(stream,1,'LISTENING',NS(page_size=lambda p:(600,800)))))
