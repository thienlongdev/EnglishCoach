import unittest
from types import SimpleNamespace as NS
from exam_extractor.pdf_layer import Row, Token
from exam_extractor.ielts_key_ocr import reread_key_ordinals, own_glyph_text, recover_key_skill_heading, normalize_chapter_headings, recover_either_order_rows, remove_score_header_rows
from exam_extractor.diagnostics import DiagnosticLog


def row(text, y=100, x=20, gap=30):
    return Row(1, y, y+20, x, x+100,
               [Token(text, x, x+20), Token('answer', x+20+gap, x+100)], 'OCR')


class KeyGlyphTest(unittest.TestCase):
    layer = NS(page_size=lambda p: (600, 800))

    def test_heading_normalization_changes_spacing_not_printed_identity(self):
        headings=[row('READI NG PASSAGE 1'),row('WRiTI NG TASK 2'),row('READING PASSAGE I'),
                  row('READI NG PASSAGE 3',y=400),row('reading')]
        for r in headings:r.tokens=r.tokens[:1]
        self.assertEqual(2,normalize_chapter_headings(self.layer,headings))
        self.assertEqual(['READING PASSAGE 1','WRITING TASK 2','READING PASSAGE I',
                          'READI NG PASSAGE 3','reading'],[r.text for r in headings])

    def cache(self, texts=('5', '5'), conf=1):
        from itertools import cycle
        values = cycle(texts)
        return NS(recognize=lambda *a, **k: NS(words=[NS(text=next(values), conf=conf)]))

    def rows(self):
        return [row('1', 10), row('2', 40), row('3', 70), row('D')]

    def test_digits_come_from_glyph_not_sequence(self):
        rows = self.rows()
        # Only inspect target; anchors are still available but not OCR rows.
        for r in rows[:3]: r.method = 'NATIVE_TEXT'
        self.assertEqual(1, reread_key_ordinals(self.layer, rows, self.cache(), DiagnosticLog(), 'KEY'))
        self.assertEqual('5', rows[-1].tokens[0].text)  # never guessed 4

    def test_collapsed_repeated_digits_cannot_replace_complete_prefix(self):
        rows=self.rows();rows[-1].tokens[0].text='33'
        for r in rows[:3]:r.method='NATIVE_TEXT'
        cache=NS(recognize=lambda *a,**k:NS(words=[NS(text='33' if k['dpi']==300 else '3',conf=1)]))
        self.assertEqual(0,reread_key_ordinals(self.layer,rows,cache,DiagnosticLog(),'KEY'))
        self.assertEqual('33',rows[-1].tokens[0].text)

    def test_disagreement_preserves_uncertainty(self):
        rows = self.rows()
        for r in rows[:3]: r.method = 'NATIVE_TEXT'
        self.assertEqual(0, reread_key_ordinals(self.layer, rows, self.cache(('5','6')), DiagnosticLog(), 'KEY'))
        self.assertEqual('D', rows[-1].tokens[0].text)

    def test_no_column_proof_no_ocr(self):
        self.assertEqual(0, reread_key_ordinals(self.layer, [row('D')], self.cache(()), DiagnosticLog(), 'KEY'))

    def test_answer_touching_prefix_not_rewritten(self):
        rows = self.rows(); rows[-1] = row('D',gap=1)
        for r in rows[:3]: r.method = 'NATIVE_TEXT'
        self.assertEqual(0, reread_key_ordinals(self.layer, rows, self.cache(()), DiagnosticLog(), 'KEY'))

    def test_low_confidence_is_rejected(self):
        self.assertIsNone(own_glyph_text(self.layer, row('D'), self.cache(conf=.6), 20,40,'0123456789'))

    def test_badge_is_read_from_own_ink(self):
        self.assertEqual('TEST8', own_glyph_text(self.layer,row('TEST88'),self.cache(('TEST8','TEST8')),20,100,'TEST0123456789'))

    def test_either_order_pair_requires_own_consecutive_glyphs(self):
        rows=self.rows()
        for r in rows[:3]: r.method='NATIVE_TEXT'
        rows[-1].tokens[0].text='10871'
        rows[-1].tokens[1].text='IN EITHER ORDER'
        self.assertEqual(1,reread_key_ordinals(self.layer,rows,self.cache(('10&11','10&11')),DiagnosticLog(),'KEY'))
        self.assertEqual('10&11',rows[-1].tokens[0].text)

    def test_either_order_context_cannot_supply_missing_digits(self):
        rows=self.rows()
        for r in rows[:3]: r.method='NATIVE_TEXT'
        rows[-1].tokens[0].text='12818'
        rows[-1].tokens[1].text='IN EITHER ORDER'
        self.assertEqual(0,reread_key_ordinals(self.layer,rows,self.cache(('12&18','12&18')),DiagnosticLog(),'KEY'))
        self.assertEqual('12818',rows[-1].tokens[0].text)

    def heading_rows(self):
        return [Row(1,20,30,200,260,[Token('TEST 4',200,260)],'OCR'),
                Row(1,100,110,20,200,[Token('Part 1 Questions 1-10',20,200)],'OCR')]

    def heading_cache(self,skills=('LISTENING','LISTENING')):
        values=iter(skills)
        return NS(recognize=lambda *a,**k:NS(words=[NS(text=next(values),conf=1,bbox=(20,50,100,60))]))

    def test_missing_skill_heading_requires_two_own_reads(self):
        recovered=recover_key_skill_heading(self.layer,self.heading_rows(),self.heading_cache())
        self.assertEqual('LISTENING',recovered.text)

    def test_continued_reading_heading_requires_own_label(self):
        rows=[Row(2,100,112,20,180,[Token('Reading Passage 1,',20,180)],'OCR')]
        recovered=recover_key_skill_heading(self.layer,rows,self.heading_cache(('READING','READING')))
        self.assertEqual('READING',recovered.text)
        self.assertEqual(2,recovered.page)
        for reads in (('READING','LISTENING'),('LISTENING','LISTENING')):
            self.assertIsNone(recover_key_skill_heading(self.layer,rows,self.heading_cache(reads)))

    def test_continued_heading_without_first_passage_or_top_band_is_refused(self):
        for text,y in (('Part 1 Questions 1-10',100),('Reading Passage 2,',100),('Reading Passage 1,',400)):
            rows=[Row(2,y,y+12,20,180,[Token(text,20,180)],'OCR')]
            self.assertIsNone(recover_key_skill_heading(self.layer,rows,self.heading_cache(())))

    def test_heading_conflict_cannot_create_skill(self):
        self.assertIsNone(recover_key_skill_heading(self.layer,self.heading_rows(),self.heading_cache(('LISTENING','READING'))))

    def test_section_title_alone_cannot_create_skill(self):
        self.assertIsNone(recover_key_skill_heading(self.layer,self.heading_rows()[1:],self.heading_cache(())))

    def pair_rows(self):
        source = [row(str(n),y) for n,y in ((1,10),(2,40),(3,70))]
        pair = row('10871',100)
        pair.tokens[1].text = 'IN EITHER ORDER'
        source.append(pair)
        source.append(Row(1,160,180,70,90,[Token('D',70,90)],'OCR'))
        return source

    def pair_cache(self, digits=('10811','10811'), letters=('D','D','E','E'), conf=1):
        from itertools import cycle
        glyphs=cycle(digits); answers=cycle(letters)
        return NS(recognize=lambda *a,**k:NS(words=[NS(
            text=next(glyphs if k['allowlist']=='0123456789&' else answers),conf=conf)]))

    def test_pair_answers_come_from_two_own_baselines(self):
        source=self.pair_rows()
        self.assertEqual(1,recover_either_order_rows(self.layer,source,self.pair_cache(),DiagnosticLog(),'KEY'))
        self.assertEqual('10&11 IN EITHER ORDER D E',source[-1].text)
        self.assertEqual(4,len(source))

    def test_split_numeric_caption_still_requires_two_own_digit_reads(self):
        source=self.pair_rows();source[3].tokens=[Token('1',20,28),Token('0871',30,40),Token('IN EITHER ORDER',70,120)]
        self.assertEqual(1,recover_either_order_rows(self.layer,source,self.pair_cache(),DiagnosticLog(),'KEY'))
        self.assertEqual('10&11 IN EITHER ORDER D E',source[-1].text)

    def test_pair_digit_or_letter_conflict_preserves_original_rows(self):
        for cache in (self.pair_cache(digits=('10811','12813')),
                      self.pair_cache(letters=('D','C')),self.pair_cache(conf=.6)):
            source=self.pair_rows();before=[r.text for r in source]
            self.assertEqual(0,recover_either_order_rows(self.layer,source,cache,DiagnosticLog(),'KEY'))
            self.assertEqual(before,[r.text for r in source])

    def test_pair_cannot_consume_next_printed_entry(self):
        source=self.pair_rows();source.append(row('12',150))
        self.assertEqual(0,recover_either_order_rows(self.layer,source,self.pair_cache(),DiagnosticLog(),'KEY'))

    def test_pair_requires_measured_column_anchors(self):
        source=self.pair_rows()[2:]
        self.assertEqual(0,recover_either_order_rows(self.layer,source,self.pair_cache(),DiagnosticLog(),'KEY'))

    def test_fused_caption_requires_own_exact_either_order_marker(self):
        for marker,expected in (('INEITHERORDER',1),('INEITHERORDEK',0)):
            source=self.pair_rows();source[3].tokens=[Token('118 ? INEITHER ORDEK',20,250)]
            answers=iter([marker,marker,'D','D','E','E'])
            cache=NS(recognize=lambda *a,**k:NS(words=[NS(text=(
                '11812' if k['allowlist']=='0123456789&' else next(answers)),conf=1)]))
            self.assertEqual(expected,recover_either_order_rows(self.layer,source,cache,DiagnosticLog(),'KEY'))
            if expected:self.assertEqual('11&12 IN EITHER ORDER D E',source[-1].text)

    def test_other_column_letter_is_not_removed_by_pair_recovery(self):
        source=self.pair_rows();other=Row(1,160,180,300,320,[Token('F',300,320)],'OCR');source.append(other)
        recover_either_order_rows(self.layer,source,self.pair_cache(),DiagnosticLog(),'KEY')
        self.assertIn(other,source)

    def test_uncorroborated_letter_row_is_preserved(self):
        source=self.pair_rows();other=Row(1,130,150,70,100,[Token('F',70,100)],'OCR');source.append(other)
        recover_either_order_rows(self.layer,source,self.pair_cache(),DiagnosticLog(),'KEY')
        self.assertIn(other,source)

    def test_numeric_prefix_can_use_high_resolution_own_ink(self):
        cache=NS(recognize=lambda *a,**k:NS(words=[NS(text='10',conf=1 if k['dpi']==300 else .5)]))
        self.assertEqual('10',own_glyph_text(self.layer,row('I0'),cache,20,40,'0123456789'))

    def score_rows(self):
        return [row('1',10),Row(1,100,110,20,100,[Token('It',20,30),
                Token('vou',35,50),Token('score',55,80),Token('I I I',85,100)],'OCR')]

    def test_score_header_requires_own_printed_label(self):
        source=self.score_rows()
        self.assertEqual(1,remove_score_header_rows(self.layer,source,
            self.cache(('If you score','Ifyou score')),DiagnosticLog(),'KEY'))
        self.assertEqual(1,len(source))

    def test_score_header_conflict_or_low_confidence_preserves_rows(self):
        for cache in (self.cache(('If you score','Other words')),self.cache(('If you score',)*2,conf=.6)):
            source=self.score_rows()
            self.assertEqual(0,remove_score_header_rows(self.layer,source,cache,DiagnosticLog(),'KEY'))
            self.assertEqual(2,len(source))
