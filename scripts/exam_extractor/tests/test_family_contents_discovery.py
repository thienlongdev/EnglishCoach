import unittest
from types import SimpleNamespace as NS
from exam_extractor.family_discovery import contents_entries,own_badge,own_listening_heading,proposed_folio

class FamilyContentsDiscoveryTest(unittest.TestCase):
    def word(self,text,box):return NS(text=text,bbox=box,conf=1)
    def test_contents_number_must_align_with_its_own_label(self):
        words=[self.word('Test 1',(10,10,70,25)),self.word('10',(200,10,220,25)),self.word('Test 2',(10,40,70,55)),self.word('32',(200,40,220,55))]
        self.assertEqual([{'kind':'TEST','test':1,'printedPage':10},{'kind':'TEST','test':2,'printedPage':32}],contents_entries(words))
        words[1].bbox=(200,90,220,105)
        self.assertEqual([{'kind':'TEST','test':2,'printedPage':32}],contents_entries(words))
    def test_ambiguous_contents_numbers_are_not_selected_by_position(self):
        words=[self.word('Test 1',(10,10,70,25)),self.word('10',(200,10,220,25)),self.word('11',(230,10,250,25))]
        self.assertEqual([],contents_entries(words))
    def test_other_column_text_blocks_a_remote_contents_numeral(self):
        words=[self.word('Test 1 (Academic Module)',(10,10,180,25)),self.word('30',(200,10,220,25)),self.word('Reading Module',(300,10,400,25)),self.word('118',(520,10,550,25))]
        self.assertEqual([{'kind':'TEST','test':1,'printedPage':30}],contents_entries(words))
    def test_general_training_uses_its_own_next_reading_folio(self):
        words=[self.word('General Training Module',(300,10,470,30)),self.word('Reading',(300,30,370,48)),self.word('130',(520,31,550,46))]
        self.assertEqual(130,contents_entries(words)[0]['printedPage'])
    def test_expected_identity_does_not_replace_a_conflicting_badge_read(self):
        layer=NS(page_size=lambda p:(600,800));words=[self.word('Test 2',(10,10,70,25))]
        for values in [('TEST2','TEST3'),('TEST3','TEST3'),('TEST','TEST')]:
            reads=iter(values*2);cache=NS(recognize=lambda *a,**k:NS(words=[NS(text=next(reads),conf=1)]))
            self.assertIsNone(own_badge(layer,11,words,cache,2))
    def test_split_general_training_boundary_is_preserved(self):
        words=[self.word('General',(10,10,60,25)),self.word('Training: Reading Test A',(59,9,180,26)),self.word('104',(210,10,230,25))]
        self.assertEqual([{'kind':'GENERAL','test':None,'printedPage':104}],contents_entries(words))
    def test_separate_caption_uses_inverse_read_and_digit_requires_agreement(self):
        layer=NS(page_size=lambda p:(600,800))
        words=[self.word('TEST',(30,40,136,83)),self.word('1',(149,46,174,77))]
        def recognize(*args,**kwargs):
            alphabet=kwargs['allowlist'];prep=kwargs['pipeline']
            text=('TEST' if prep in ('P0','P4') else 'TST') if alphabet=='TESTtest' else '1' if alphabet=='0123456789' else 'TEST'
            return NS(words=[NS(text=text,conf=1)])
        self.assertTrue(own_badge(layer,32,words,NS(recognize=recognize),1)['componentGlyphReads'])
        def conflicting(*args,**kwargs):
            result=recognize(*args,**kwargs)
            if kwargs['allowlist']=='0123456789' and kwargs['pipeline']=='P2':result.words[0].text='2'
            return result
        self.assertIsNone(own_badge(layer,32,words,NS(recognize=conflicting),1))
    def test_numeric_proposal_does_not_accept_additional_digits_or_letters(self):
        self.assertEqual(10,proposed_folio('10 _'))
        self.assertEqual(106,proposed_folio('106'))
        self.assertIsNone(proposed_folio('10a'))
    def test_corrupted_heading_needs_two_own_literal_reads(self):
        layer=NS(page_size=lambda p:(600,800));words=[self.word('LISTENNG',(210,100,290,115))]
        for values,expected in [(('LISTENING','LISTENING'),True),(('LISTENING','READING'),False),(('READING','READING'),False)]:
            reads=iter(values*2);cache=NS(recognize=lambda *a,**k:NS(words=[NS(text=next(reads),conf=1)]))
            self.assertEqual(expected,own_listening_heading(layer,82,words,cache))
