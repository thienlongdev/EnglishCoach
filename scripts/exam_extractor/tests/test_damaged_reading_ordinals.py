"""A letter-like prefix never supplies a number without its own agreeing glyph reads."""
import unittest
from types import SimpleNamespace
from exam_extractor.pdf_layer import Row,Token
from exam_extractor.toeic_scan import reread_damaged_reading_ordinals

class DamagedReadingOrdinalTest(unittest.TestCase):
    def rows(self,prefix='I11.',letters='ABCD'):
        rows=[Row(81,100,110,45,220,[Token(prefix,45,62),Token('Printed stem',70,220)],column=0)]
        rows.extend(Row(81,120+15*i,130+15*i,70,180,[Token(f'({letter})',70,85),Token('Option',90,180)],column=0) for i,letter in enumerate(letters))
        return rows
    def cache(self,reads):
        def recognize(layer,page,bbox,**kwargs):
            self.assertEqual('0123456789.,',kwargs['allowlist'])
            self.assertLess(bbox[2],70)
            return SimpleNamespace(words=[SimpleNamespace(text=reads[kwargs['pipeline']])])
        return SimpleNamespace(recognize=recognize)
    def test_agreeing_own_reads_restore_marker(self):
        rows=self.rows();self.assertEqual(1,reread_damaged_reading_ordinals(None,rows,self.cache({'P5':'111.','P6':'111.'})))
        self.assertEqual('111.',rows[0].tokens[0].text)
    def test_read_disagreement_leaves_prefix_unbound(self):
        rows=self.rows();self.assertEqual(0,reread_damaged_reading_ordinals(None,rows,self.cache({'P5':'111.','P6':'117.'})))
        self.assertEqual('I11.',rows[0].tokens[0].text)
    def test_accepted_marker_punctuation_does_not_change_ordinal_agreement(self):
        rows=self.rows();self.assertEqual(1,reread_damaged_reading_ordinals(None,rows,self.cache({'P5':'111.','P6':'111,'})))
        self.assertEqual('111.',rows[0].tokens[0].text)
    def test_missing_punctuation_is_not_invented(self):
        self.assertEqual(0,reread_damaged_reading_ordinals(None,self.rows(),self.cache({'P5':'111','P6':'111'})))
    def test_passage_prefix_without_own_options_is_not_reread(self):
        self.assertEqual(0,reread_damaged_reading_ordinals(None,self.rows(letters='ACD'),None))
    def test_numeric_prefix_and_foreign_column_are_preserved(self):
        self.assertEqual(0,reread_damaged_reading_ordinals(None,self.rows(prefix='111.'),None))
        rows=self.rows();rows[2].column=1
        self.assertEqual(0,reread_damaged_reading_ordinals(None,rows,None))
