import unittest
from itertools import cycle
from types import SimpleNamespace as NS
from exam_extractor.pdf_layer import Row,Token
from exam_extractor.ielts_key_ocr import reread_typed_key_values
from exam_extractor.diagnostics import DiagnosticLog


class TypedKeyValuesTest(unittest.TestCase):
    def rows(self):
        return [Row(1,100,110,20,140,[Token('34',20,32),Token('NOT',50,70),Token('GIVEN',72,100),Token('F 1',120,140)],'OCR')]+[
            Row(1,y,y+10,20,100,[Token(str(n),20,32),Token(value,50,100)],'OCR')
            for n,y,value in ((35,120,'YES'),(36,140,'NO'),(37,160,'NO'))]

    def cache(self,numbers=('34','34'),values=('NOTGIVEN','NOT GIVEN')):
        numbers=cycle(numbers);values=cycle(values)
        return NS(recognize=lambda *a,**k:NS(words=[NS(text=next(numbers if k['allowlist']=='0123456789' else values),conf=1)]))

    def read(self,rows,cache=None,kinds=None):
        return reread_typed_key_values(NS(page_size=lambda p:(600,800)),rows,cache or self.cache(),DiagnosticLog(),'KEY',question_kinds=kinds)

    def test_own_ordinal_and_answer_reads_remove_only_proven_debris(self):
        rows=self.rows();self.assertEqual(1,self.read(rows,kinds={34:'YNNG'}))
        self.assertEqual('34 NOT GIVEN',rows[0].text)

    def test_disagreement_or_another_ordinal_preserves_debris(self):
        for cache in (self.cache(numbers=('35','35')),self.cache(values=('NOTGIVEN','NO'))):
            rows=self.rows();before=[r.text for r in rows]
            self.assertEqual(0,self.read(rows,cache,kinds={34:'YNNG'}));self.assertEqual(before,[r.text for r in rows])

    def test_text_answers_and_unknown_question_types_cannot_be_shortened(self):
        for kinds in (None,{34:'TEXT_GAP'},{}):
            rows=self.rows();rows[0].tokens=[Token('34',20,32),Token('NO',50,65),Token('charge',70,100)]
            before=[r.text for r in rows]
            self.assertEqual(0,self.read(rows,kinds=kinds));self.assertEqual(before,[r.text for r in rows])

    def test_two_token_damaged_enum_requires_own_agreeing_reads(self):
        for values,expected in ((('FALSE','FALSE'),1),(('FALSE','TRUE'),0),(('YES','YES'),0)):
            rows=self.rows()
            rows[0].tokens=[Token('34',20,32),Token('FALSF',50,100)]
            self.assertEqual(expected,self.read(rows,self.cache(values=values),{34:'TFNG'}))
            self.assertEqual('34 FALSE' if expected else '34 FALSF',rows[0].text)

    def test_damaged_enum_in_text_question_is_never_reinterpreted(self):
        for kinds in (None,{}, {34:'TEXT_GAP'}, {34:'MATCHING'}):
            rows=self.rows();rows[0].tokens=[Token('34',20,32),Token('FALSF',50,100)]
            self.assertEqual(0,self.read(rows,self.cache(values=('FALSE','FALSE')),kinds))
            self.assertEqual('34 FALSF',rows[0].text)
