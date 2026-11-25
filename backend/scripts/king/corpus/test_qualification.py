"""Adversarial source qualification and replay tests, without runtime services."""
import json
import sqlite3
import unittest
from qualify import constrained_reorder, leaks, structural_category, LexicalEvidence, explain_choices
from ingest_phrases import phrase_type
from normalize import WORK


def tagged(text,tags):
    return [dict(text=w.strip(','),pos=p) for w,p in zip(text.rstrip('.!?').split(),tags.split())]


class ReorderTests(unittest.TestCase):
    def test_typed_particle_stays_with_verb_and_unproven_separability_is_reviewed(self):
        text='We turn off the light.'
        tokens=tagged(text,'PRP VBP RP DT NN')
        self.assertIsNone(constrained_reorder(text,tokens))
        r=constrained_reorder(text,tokens,phrasal={'turn off'})
        self.assertIn('turn off',r['tokens'])
        separated='We turn the light off.'
        self.assertIsNone(constrained_reorder(separated,tagged(separated,'PRP VBP DT NN RP'),phrasal={'turn off'}))

    def test_modal_passive_conditional_relative_and_question_structures(self):
        cases=[('We can watch the concert.','PRP MD VB DT NN','MODAL'),
               ('They were watched by the teacher.','PRP VBD VBN IN DT NN','PASSIVE'),
               ('Do they watch the concert?','VBP PRP VB DT NN','YES_NO_QUESTION')]
        for text,tags,category in cases:
            self.assertIsNotNone(constrained_reorder(text,tagged(text,tags)))
            self.assertEqual(category,structural_category(text,tagged(text,tags)))
        text='If we watch birds, we see the sky.'
        tags='IN PRP VBP NNS PRP VBP DT NN'
        self.assertIsNotNone(constrained_reorder(text,tagged(text,tags)))

    def test_object_cannot_move_after_prepositional_adjunct(self):
        text='We watch the concert on television.'
        r=constrained_reorder(text,tagged(text,'PRP VBP DT NN IN NN'))
        self.assertIsNotNone(r)
        self.assertNotIn('We watch on television the concert',r['accepted'])

    def test_time_adjunct_is_accepted_in_both_positions(self):
        text='We watched the concert yesterday.'
        r=constrained_reorder(text,tagged(text,'PRP VBD DT NN RB'))
        self.assertIn('yesterday We watched the concert',r['accepted'])

    def test_negative_auxiliary_stays_in_a_constituent(self):
        text='We do not watch the concert.'
        r=constrained_reorder(text,tagged(text,'PRP VBP RB VB DT NN'))
        self.assertIn('do not watch',r['tokens'])
        self.assertEqual('NEGATIVE',structural_category(text,tagged(text,'PRP VBP RB VB DT NN')))

    def test_ambiguous_coordination_is_quarantined(self):
        text='We watch birds and cats today.'
        self.assertIsNone(constrained_reorder(text,tagged(text,'PRP VBP NNS CC NNS RB')))

    def test_scope_sensitive_adverb_is_quarantined(self):
        text='We watched the concert only.'
        self.assertIsNone(constrained_reorder(text,tagged(text,'PRP VBD DT NN RB')))

    def test_question_opening_is_preserved(self):
        text='Why do they watch the concert?'
        r=constrained_reorder(text,tagged(text,'WRB VBP PRP VB DT NN'))
        self.assertEqual(['WH','AUX','SUBJECT','VERB','OBJECT'],r['proof']['roles'])


class ExplainTests(unittest.TestCase):
    def test_obfuscated_spelling_leak_is_rejected(self):
        self.assertTrue(leaks('It is a c-a-t.', ['cat']))
        self.assertFalse(leaks('It is a category.', ['cat']))

    def test_alias_and_source_forms_are_checked(self):
        self.assertTrue(leaks('These are children.', ['child','children']))

    def test_real_all_sense_selector_binds_every_clue(self):
        with sqlite3.connect(WORK.as_uri()+'?mode=ro',uri=True) as db:
            ev=LexicalEvidence(db)
            found=0
            for word in sorted(ev.words):
                choices=explain_choices(ev,word)
                if not choices:continue
                _,sense,clues,aliases,forms,proof=choices[0]
                self.assertEqual(sense['originalLemma'],sense['originalLemma'].lower())
                self.assertFalse(any(r['relType']=='domain_topic' for r in ev.concepts[sense['concept']]['relations']))
                self.assertEqual(sense['id'],proof['senseId'])
                self.assertEqual(ev.concepts[sense['concept']]['definition'],clues[2])
                a,b,c=proof['candidateSetSizes']
                self.assertLess(b,a);self.assertLessEqual(c,b)
                self.assertFalse(any(leaks(clue,forms) for clue in clues))
                for alias in aliases:self.assertIn(sense['concept'],{s['concept'] for s in ev.words[alias]})
                found+=1
                if found==50:break
            self.assertEqual(50,found)


class TypedPhraseTests(unittest.TestCase):
    def test_verb_preposition_alone_is_not_phrasal_evidence(self):
        self.assertIsNone(phrase_type(dict(pos='verb'),dict(glosses=['To walk near something.'])))

    def test_explicit_phrasal_category_requires_verb_pos(self):
        self.assertEqual('PHRASAL_VERB',phrase_type(dict(pos='verb'),dict(categories=['English phrasal verbs'])))
        self.assertIsNone(phrase_type(dict(pos='noun'),dict(categories=['English phrasal verbs'])))

    def test_idiom_requires_explicit_evidence(self):
        self.assertEqual('IDIOM_FRAGMENT',phrase_type(dict(pos='noun'),dict(tags=['idiomatic'])))
        self.assertIsNone(phrase_type(dict(pos='noun'),dict()))


if __name__=='__main__':unittest.main()
