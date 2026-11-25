import copy
import unittest
from exam_extractor.audio_segment import apply_ordered_spoken_parts


class SpokenOrdinalAudioTest(unittest.TestCase):
    def fixture(self):
        data={'checks':{'classes':'NOT_BIMODAL'},'boundaries':[
            {'between':k,'tier':'UNRESOLVED','evidence':[]} for k in ('1|2','2|3','3|4')]}
        cues=[{'kind':'PART','n':n,'atS':t,'windowStartS':t-2,'pos':0} for n,t in ((2,100),(3,300),(4,500))]
        cues.extend({'kind':'NUMBER','n':n,'atS':t} for n,t in ((6,80),(7,120),(31,280),(70,480)))
        cues.extend({'kind':'SET','a':a,'b':b,'atS':t} for a,b,t in ((32,34,320),(71,73,520)))
        return data,cues,[(90,10),(290,10),(490,10)]

    def run_fixture(self,change=lambda d,c,p:None):
        data,cues,pauses=self.fixture();change(data,cues,pauses)
        return apply_ordered_spoken_parts(data,cues,pauses,700,'TOEIC_LR_2016')

    def test_all_four_corroborated_parts_have_ordered_nonoverlapping_ranges(self):
        result=self.run_fixture()
        self.assertEqual(['CONFIDENT']*3,[b['tier'] for b in result['boundaries']])
        self.assertEqual([(0,98000),(98000,298000),(298000,498000),(498000,700000)],
                         [(s['startMs'],s['endMs']) for s in result['segments']])
        self.assertTrue(all(s['method']=='TOEIC_SPOKEN_PART_ORDINAL_CLOSURE_V1' for s in result['segments']))

    def test_missing_first_number_never_gets_supplied_from_specification(self):
        result=self.run_fixture(lambda d,c,p:c.__setitem__(slice(None),[x for x in c if x.get('a')!=71]))
        self.assertEqual('UNRESOLVED',result['boundaries'][2]['tier'])
        self.assertEqual(['CONFIDENT','CONFIDENT','UNRESOLVED','UNRESOLVED'],[s['tier'] for s in result['segments']])

    def test_wrong_preceding_number_rejects_cut(self):
        def change(d,c,p):
            next(x for x in c if x.get('n')==31)['n']=30
        result=self.run_fixture(change)
        self.assertEqual('UNRESOLVED',result['boundaries'][1]['tier'])

    def test_unanchored_announcement_cannot_create_a_cut(self):
        result=self.run_fixture(lambda d,c,p:p.__setitem__(0,(85,10)))
        self.assertEqual('UNRESOLVED',result['boundaries'][0]['tier'])

    def test_duplicate_part_announcements_remain_unresolved(self):
        result=self.run_fixture(lambda d,c,p:c.append({'kind':'PART','n':2,'atS':130,'windowStartS':128,'pos':0}))
        self.assertEqual('UNRESOLVED',result['boundaries'][0]['tier'])

    def test_pause_classified_existing_model_is_not_replaced(self):
        data,cues,pauses=self.fixture();data['answerPauses']=[(50,3,'SHORT')];original=copy.deepcopy(data)
        self.assertEqual(original,apply_ordered_spoken_parts(data,cues,pauses,700,'TOEIC_LR_2016'))

    def test_failed_classification_without_candidate_uses_own_ordinals(self):
        def change(d,c,p):
            d['answerPauses']=[(50,3,'SHORT')]
            d['checks']={'S2_order':False}
            for b in d['boundaries']:
                b.update(tier='AMBIGUOUS',evidence=['silence only'])
        result=self.run_fixture(change)
        self.assertEqual(['CONFIDENT']*3,[b['tier'] for b in result['boundaries']])

    def test_existing_candidate_is_preserved_even_when_classes_fail(self):
        def change(d,c,p):
            d['checks']={'S2_order':False}
            d['boundaries'][1].update(tier='AMBIGUOUS',atS=250,evidence=['conflict'])
        result=self.run_fixture(change)
        self.assertEqual(250,result['boundaries'][1]['atS'])
        self.assertEqual('AMBIGUOUS',result['boundaries'][1]['tier'])
