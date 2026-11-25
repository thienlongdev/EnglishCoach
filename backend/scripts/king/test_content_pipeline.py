import copy
import json
import tempfile
import unittest
from pathlib import Path
import content_pipeline as p


class PipelineTest(unittest.TestCase):
    def setUp(self):
        self.records,self.audit=p.prepare(p.import_sources())
        self.item=next(r for r in self.records if r['mode']=='REORDER' and not r['errors'])

    def decision(self, item=None, **changes):
        r=item or self.item
        return dict(id=r['id'],fingerprint=r['fingerprint'],reviewer='TEST_ONLY_OWNER',reviewedAt='2026-10-01T10:00:00Z',
                    decision='APPROVE',acknowledgedWarnings=r['warnings'],**changes)

    def test_deterministic_import_provenance_and_no_approval(self):
        self.assertEqual(self.records,p.prepare(p.import_sources())[0])
        self.assertTrue(all(r['provenance']['sourceRef'] for r in self.records))
        self.assertTrue(all(r['humanReview'] is None for r in self.records))
        self.assertFalse(any(r['reviewStatus'] in {'HUMAN_APPROVED','ACTIVE'} for r in self.records))
        self.assertEqual([],p.active_build(self.records,'TEST_ONLY_OWNER'))

    def test_duplicates_ids_semantics_and_variants(self):
        duplicate=copy.deepcopy(self.item);duplicate['id']='another-id';duplicate['fingerprint']=p.fingerprint(duplicate)
        records,_=p.prepare([self.item,self.item,duplicate])
        self.assertIn('DUPLICATE_ID',records[1]['errors'])
        self.assertIn('SEMANTIC_DUPLICATE',records[2]['errors'])
        self.assertEqual(1,p.report(records)['modes']['REORDER']['uniqueSemantic'])
        self.assertEqual(0,p.report(records)['modes']['REORDER']['shuffles'])

    def test_full_fingerprint_covers_meaning_difficulty_provenance(self):
        for key in ['meaning','difficulty','cefr','sourceRef','canonical']:
            item=copy.deepcopy(self.item);item['content'][key]='changed'
            self.assertNotEqual(p.fingerprint(item),self.item['fingerprint'])
        item=copy.deepcopy(self.item);item['provenance']['sourcePolicy']='changed'
        self.assertNotEqual(p.fingerprint(item),self.item['fingerprint'])

    def test_approval_not_activation_and_stale_active_build_rejected(self):
        reviewed=p.import_decisions([self.item],[self.decision()],'TEST_ONLY_OWNER')
        self.assertEqual('HUMAN_APPROVED',reviewed[0]['reviewStatus'])
        self.assertEqual('ACTIVE',p.active_build(reviewed,'TEST_ONLY_OWNER')[0]['reviewStatus'])
        self.assertEqual('HUMAN_APPROVED',reviewed[0]['reviewStatus'])
        reviewed[0]['content']['meaning']='changed'
        with self.assertRaises(ValueError):p.active_build(reviewed,'TEST_ONLY_OWNER')

    def test_invalid_decisions_fail_atomically(self):
        for field,value in [('fingerprint','old'),('reviewer','not owner'),('reviewedAt','bad'),('decision','ACTIVE'),('acknowledgedWarnings',[])]:
            d=self.decision();d[field]=value
            with self.assertRaises(ValueError):p.import_decisions([self.item],[d],'TEST_ONLY_OWNER')
        d=self.decision()
        with self.assertRaises(ValueError):p.import_decisions([self.item],[d,d],'TEST_ONLY_OWNER')
        with self.assertRaises(ValueError):p.import_decisions([self.item],[d],'')

    def test_reject_and_correct_do_not_activate(self):
        d=self.decision();d['decision']='REJECT'
        rejected=p.import_decisions([self.item],[d],'TEST_ONLY_OWNER')
        self.assertEqual([],p.active_build(rejected,'TEST_ONLY_OWNER'))
        d['decision']='CORRECT';d['correctedContent']=copy.deepcopy(self.item['content']);d['correctedContent']['meaning']='Owner corrected meaning'
        corrected=p.import_decisions([self.item],[d],'TEST_ONLY_OWNER')[0]
        self.assertEqual('DRAFT',corrected['reviewStatus']);self.assertIsNone(corrected['humanReview'])
        self.assertNotEqual(self.item['fingerprint'],corrected['fingerprint'])
        with self.assertRaises(ValueError):p.import_decisions([corrected],[self.decision()],'TEST_ONLY_OWNER')
        pending,audit=p.revalidate_drafts([corrected])
        self.assertEqual('HUMAN_REVIEW_PENDING',pending[0]['reviewStatus'])
        self.assertEqual(['DRAFT','AUTO_VALIDATED','HUMAN_REVIEW_PENDING'],audit[0]['states'])
        self.assertIsNone(pending[0]['humanReview'])

    def test_warnings_and_token_mismatches(self):
        for sentence, warning in [("I don't know the answer.",'CONTRACTION_POLICY'),('Tomorrow we will meet.','ADVERB_POSITION_REVIEW'),('The more you read the more you learn.','REPEATED_TOKEN_INDEX_REVIEW'),('Please turn off the light.','OBJECT_POSITION_ALTERNATIVE_MISSING')]:
            r=copy.deepcopy(self.item);r['content'].update(canonical=sentence,tokens=p.normalized(sentence).split(),family='PHRASAL_VERB',accepted=[]);r['fingerprint']=p.fingerprint(r)
            errors,warnings=p.quality(r);self.assertFalse(errors);self.assertIn(warning,warnings)
        r=copy.deepcopy(self.item);r['content']['tokens']=['bad'];r['fingerprint']=p.fingerprint(r)
        self.assertIn('TOKEN_MISMATCH',p.quality(r)[0])

    def test_reflex_families_and_quality_negative(self):
        reflex=[r for r in self.records if r['mode']=='REFLEX']
        self.assertEqual(p.FAMILIES,{r['content']['family'] for r in reflex})
        for family,field,value,error in [('SPELLING_CHOICE','options',['zzzzzz','necessary'],'IMPLAUSIBLE_SPELLING_DISTRACTOR'),('WORD_FAMILY','prompt','DECIDE','POS_REQUEST_MISSING'),('PART_OF_SPEECH','context',None,'POS_CONTEXT_MISSING'),('SYNONYM','relationSet',[],'RELATION_ANSWER_MISSING'),('COLLOCATION','expression',None,'CANONICAL_EXPRESSION_MISSING')]:
            r=copy.deepcopy(next(r for r in reflex if r['content']['family']==family));r['content'][field]=value;r['fingerprint']=p.fingerprint(r)
            self.assertIn(error,p.quality(r)[0])

    def test_explain_leak_alias_separated_and_progression_review(self):
        for clue in ['umbrella','u m b r e l l a','starts with U']:
            r=copy.deepcopy(next(r for r in self.records if r['id']=='king-e-1'));r['content']['progressiveClues'][0]=clue;r['fingerprint']=p.fingerprint(r)
            self.assertTrue(p.quality(r)[0])
        r=next(r for r in self.records if r['id']=='king-e-3')
        self.assertIn('ALIAS_EQUIVALENCE_REVIEW',r['warnings'])

    def test_malformed_correction_and_warning_tamper_cannot_approve(self):
        d=self.decision();d['decision']='CORRECT';d['correctedContent']={'canonical':None}
        with self.assertRaises(ValueError):p.import_decisions([self.item],[d],'TEST_ONLY_OWNER')
        r=copy.deepcopy(self.item);r['warnings']=[];d=self.decision();d['acknowledgedWarnings']=[]
        with self.assertRaises(ValueError):p.import_decisions([r],[d],'TEST_ONLY_OWNER')

    def test_active_board_reverifies_asserted_metrics(self):
        r=copy.deepcopy(next(r for r in self.records if r['mode']=='CONQUEST'))
        r['content']['qualityMetrics']['playableWords']+=1;r['fingerprint']=p.fingerprint(r)
        d=self.decision();d.update(id=r['id'],fingerprint=r['fingerprint'],acknowledgedWarnings=r['warnings'])
        approved=p.import_decisions([r],[d],'TEST_ONLY_OWNER')
        with self.assertRaisesRegex(ValueError,'ACTIVE_BOARD_SOLVER_MISMATCH'):p.active_build(approved,'TEST_ONLY_OWNER')

    def test_board_threshold_duplicate_and_review_pack_blank(self):
        boards=[r for r in self.records if r['mode']=='CONQUEST'];self.assertEqual(50,len(boards))
        self.assertEqual(50,len({p.semantic_key(r) for r in boards}))
        with tempfile.TemporaryDirectory() as folder:
            out=Path(folder);p.review_pack(out,[self.item]);text=(out/'review.html').read_text()
            self.assertIn(self.item['fingerprint'],text);self.assertIn('Decision: ______',text)
            self.assertFalse('"decision": "APPROVE"' in (out/'candidates.json').read_text())


if __name__=='__main__':unittest.main()
