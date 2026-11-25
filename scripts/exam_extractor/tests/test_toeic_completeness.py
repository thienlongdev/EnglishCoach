import unittest
from exam_extractor.toeic import FORMATS
from exam_extractor.toeic_completeness import assert_complete_source_package, assert_valid_source_parts


def package(fmt='TOEIC_LR_2016'):
    p = dict(manifest={'metadata': {'sourceIdentity': {'collection': 'ybm'}}},
             specifications=[{'family': 'TOEIC', 'blueprint': {'formatVersion': fmt}}],
             sections=[{'id': 'L', 'skill': 'LISTENING'}, {'id': 'R', 'skill': 'READING'}],
             parts=[], formGroups=[], items=[], answerSpecs=[], stimuli=[], groupStimuli=[],
             assets=[], stimulusAssets=[])
    for n, (lo, hi) in FORMATS[fmt].items():
        skill = 'L' if n <= 4 else 'R'
        part_id = str(n)
        p['parts'].append(dict(id=part_id, sectionId=skill, timingPolicy={'partNumber': n}))
        p['formGroups'].append(dict(partId=part_id, groupId=part_id, ordinal=n))
        for q in range(lo, hi+1):
            item_id = str(q)
            p['items'].append(dict(id=item_id, groupId=part_id, logicalItemKey=f'T_{skill}{q:03}',
                                  ordinal=q, prompt='Source question',
                                  optionDefinitions={'options': [{'id': x, 'text': x+' text'} for x in 'ABCD']}))
            p['answerSpecs'].append(dict(itemId=item_id, acceptedAnswers={'values': ['A']}))
        p['stimuli'].append(dict(id=part_id, bodyPayload={'text': 'Source passage'}))
        p['groupStimuli'].append(dict(groupId=part_id, stimulusId=part_id))
        if n <= 4:
            p['assets'].append(dict(id=part_id, mimeType='audio/mpeg', validationState='VALIDATED'))
            p['stimulusAssets'].append(dict(stimulusId=part_id, assetId=part_id))
    return p


class CompleteSourceGateTest(unittest.TestCase):
    def test_full_current_and_original_format(self):
        for fmt in FORMATS:
            assert_complete_source_package(package(fmt))

    def test_rejects_partial_parts_even_with_complete_keys(self):
        p=package();p['parts']=p['parts'][4:]
        with self.assertRaisesRegex(AssertionError, 'FULL_TOEIC_PARTS_REQUIRED'):
            assert_complete_source_package(p)

    def test_rejects_number_gap_key_audio_and_passage_loss(self):
        mutations=[lambda p: p['items'].pop(), lambda p: p['answerSpecs'].pop(),
                   lambda p: p['assets'].clear(), lambda p: p['groupStimuli'].pop()]
        for mutate in mutations:
            p=package();mutate(p)
            with self.assertRaises(AssertionError):assert_complete_source_package(p)

    def test_valid_part_releases_without_other_parts(self):
        p=package();p['parts']=p['parts'][4:]
        assert_valid_source_parts(p)
        p['items'].pop()
        with self.assertRaisesRegex(AssertionError,'PART_7_INCOMPLETE'):assert_valid_source_parts(p)

    def test_ets_partial_is_separate(self):
        p=package();p['manifest']['metadata']['sourceIdentity']['collection']='ets';p['parts']=[]
        assert_complete_source_package(p)
