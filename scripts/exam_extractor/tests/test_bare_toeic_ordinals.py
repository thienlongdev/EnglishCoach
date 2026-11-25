import unittest
from types import SimpleNamespace
from unittest.mock import patch

from exam_extractor.pdf_layer import Row, Token
from exam_extractor.toeic_scan import normalize_unpunctuated_questions, reread_bare_question_ordinals, choose_proven_set_ranges, read_ordinal_glyphs


def row(text, page=1, column=0):
    tokens = [Token(word, i * 15, i * 15 + 12) for i, word in enumerate(text.split())]
    return Row(page, 10, 20, 0, len(tokens) * 15, tokens, column=column)


class BareOrdinalsTest(unittest.TestCase):
    def test_complete_spoken_proof_supplements_partial_agreeing_script(self):
        audio = [(71, 73), (74, 76)]
        self.assertEqual((audio, 'AUDIO'), choose_proven_set_ranges([(71, 73)], audio, list(range(71, 77))))

    def test_conflicting_script_cannot_be_overridden(self):
        self.assertEqual((None, 'CONFLICT'), choose_proven_set_ranges([(71, 74)], [(71, 73), (74, 76)], list(range(71, 77))))

    def test_partial_sources_never_create_unannounced_ranges(self):
        script = [(71, 73)]
        self.assertEqual((script, 'SCRIPT'), choose_proven_set_ranges(script, [(71, 73)], list(range(71, 77))))

    def test_confused_prefix_uses_its_own_agreeing_reads(self):
        class Cache:
            def recognize(self, *args, **kwargs):
                return SimpleNamespace(words=[SimpleNamespace(text='44')])
        rows = [row('L4 What are the speakers talking about?')]
        self.assertEqual(1, reread_bare_question_ordinals(None, rows, Cache()))
        self.assertEqual('44.', rows[0].tokens[0].text)

    def test_disagreement_never_repairs_a_number(self):
        class Cache:
            def recognize(self, *args, **kwargs):
                return SimpleNamespace(words=[SimpleNamespace(text='44' if kwargs['pipeline'] == 'P5' else '14')])
        rows = [row('L4 What are the speakers talking about?')]
        self.assertEqual(0, reread_bare_question_ordinals(None, rows, Cache()))
        self.assertEqual('L4', rows[0].tokens[0].text)

    def test_phrase_token_starts_the_printed_stem(self):
        class Cache:
            def recognize(self, *args, **kwargs):
                return SimpleNamespace(words=[SimpleNamespace(text='48')])
        source = row('L8 What does the man suggest?')
        source.tokens = [source.tokens[0], Token('What does the man suggest?', 15, 140)]
        self.assertEqual(1, reread_bare_question_ordinals(None, [source], Cache()))
        self.assertEqual('48.', source.tokens[0].text)
        self.assertEqual('What does the man suggest?', source.tokens[1].text)

    def test_own_glyph_crop_requires_three_of_four_agreeing_reads(self):
        import numpy as np
        image = np.full((100, 100, 3), 255, dtype=np.uint8)
        image[20:60, 20:35] = 0
        image[20:60, 45:60] = 0
        class Cache:
            def __init__(self, reads):
                self.reads = iter(reads)
            def recognize(self, *args, **kwargs):
                return SimpleNamespace(words=[SimpleNamespace(text=next(self.reads))])
        with patch('exam_extractor.toeic_scan.render_region', return_value=image):
            self.assertEqual('44', read_ordinal_glyphs(None, row('L4 Where'), (0, 0, 24, 24),
                                                      Cache(['44', '46', '44', '44'])))
            self.assertIsNone(read_ordinal_glyphs(None, row('L4 Where'), (0, 0, 24, 24),
                                                Cache(['44', '46', '44', '46'])))

    def test_dropped_prefix_requires_a_printed_column_margin(self):
        source = row('What is being offered?')
        class Cache:
            def recognize(self, *args, **kwargs):
                raise AssertionError('No physical ordinal band has been established')
        self.assertEqual(0, reread_bare_question_ordinals(None, [source], Cache()))
        self.assertEqual('What', source.tokens[0].text)

    def test_response_prompt_and_option_block_have_explicit_evidence(self):
        rows = [row('11 Mark your answer on your answer sheet.'),
                row('41 Why is the man calling?'), row('(A) To report a problem'),
                row('(B) To purchase a book'), row('(C) To ask for an estimate'),
                row('(D) To order supplies')]
        self.assertEqual(2, normalize_unpunctuated_questions(rows))
        self.assertEqual('11.', rows[0].tokens[0].text)
        self.assertEqual('41.', rows[1].tokens[0].text)

    def test_preface_passage_and_other_column_do_not_prove_a_question(self):
        rows = [row('47 Korean preface debris'), row('1 First instruction'),
                row('150 employees work here'), row('(A) option', column=1),
                row('(B) option', column=1), row('(C) option', column=1)]
        self.assertEqual(0, normalize_unpunctuated_questions(rows))

    def test_wrapped_stem_preserves_the_printed_number(self):
        rows = [row('44 What are the speakers mainly talking'), row('about?'),
                row('(A) A theater'), row('(B) A play'), row('(C) A restaurant'), row('(D) A movie')]
        self.assertEqual(1, normalize_unpunctuated_questions(rows))
        self.assertEqual('44.', rows[0].tokens[0].text)


if __name__ == '__main__':
    unittest.main()
