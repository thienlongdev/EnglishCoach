"""An OCR digit at the stem margin cannot swallow subsequent valid questions."""
import unittest
from types import SimpleNamespace as NS

from exam_extractor.pdf_layer import Row, Token
from exam_extractor.toeic_scan import recover_detached_question_headers


def rows():
    return [Row(1, y, y + 10, 50, 150,
                [Token(str(n) + '.', 50, 60), Token('What is printed?', 65, 150)], column=1)
            for n, y in [(87, 100), (88, 150)]] + [
        Row(1, 200, 210, 62, 150, [Token('4', 62, 66), Token('will be printed?', 67, 150)], column=1)]


class DetachedOrdinalTest(unittest.TestCase):
    def cache(self, number=92, disagree_stem=False, disagree_glyph=False):
        def recognize(layer, page, bbox, **kwargs):
            if kwargs.get('allowlist'):
                text = str(number + 1) if disagree_glyph and kwargs['pipeline'] == 'P6' else str(number)
                return NS(words=[NS(text=text)])
            stem = 'What will be printed?' if not (disagree_stem and kwargs['pipeline'] == 'P2') else 'What is printed?'
            return NS(words=[NS(text=str(number)+'.', bbox=(50, 200, 60, 210)),
                             NS(text=stem, bbox=(65, 200, 150, 210))])
        return NS(recognize=recognize)

    def test_own_number_does_not_follow_neighboring_ordinals(self):
        source = rows()
        self.assertEqual(1, recover_detached_question_headers(None, source, self.cache()))
        self.assertEqual('92. What will be printed?', source[-1].text)

    def test_both_stem_and_separate_number_glyph_must_agree(self):
        for cache in [self.cache(disagree_stem=True), self.cache(disagree_glyph=True)]:
            source = rows()
            self.assertEqual(0, recover_detached_question_headers(None, source, cache))
            self.assertEqual('4 will be printed?', source[-1].text)

    def test_partial_ordinal_glyph_with_intact_stem_is_recovered(self):
        source = rows()
        source[-1].tokens[-1].text = 'What will be printed?'
        self.assertEqual(1, recover_detached_question_headers(None, source, self.cache()))
        self.assertEqual('92. What will be printed?', source[-1].text)

    def test_single_margin_anchor_cannot_propose_recovery(self):
        source = rows()[1:]
        self.assertEqual(0, recover_detached_question_headers(None, source, self.cache()))

    def test_indented_answer_label_does_not_become_question(self):
        source = rows()
        source[-1].tokens[-1].text = 'a printed option'
        self.assertEqual(0, recover_detached_question_headers(None, source, self.cache()))


if __name__ == '__main__':
    unittest.main()
