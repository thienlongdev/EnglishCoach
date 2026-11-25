import json
import tempfile
import unittest
from pathlib import Path
from exam_extractor.qa_queue import build_queue, graphic_scope, numbered_scopes


class AudioQaScopeTest(unittest.TestCase):
    def test_mixed_printed_ordinals_split_by_canonical_spec_without_approval(self):
        entry={'type':'OCR','scope':'READING','questions':'129,154,189','status':'OPEN'}
        result=numbered_scopes(entry,'TOEIC_LR_2016')
        self.assertEqual(['READING/PART_5','READING/PART_7'],[e['scope'] for e in result])
        self.assertEqual(['129','154,189'],[e['questions'] for e in result])
        self.assertTrue(all(e['status']=='OPEN' for e in result))
        self.assertEqual([entry],numbered_scopes(entry,'UNKNOWN'))
        malformed=dict(entry,questions='129,garbled')
        self.assertEqual([malformed],numbered_scopes(malformed,'TOEIC_LR_2016'))

    def test_graphic_ordinals_use_the_actual_toeic_specification(self):
        self.assertEqual('LISTENING/PART_3',graphic_scope({'questions':'62-64'},'TOEIC_LR_2016'))
        self.assertEqual('LISTENING/PART_4',graphic_scope({'questions':'95-97'},'TOEIC_LR_2016'))
        self.assertEqual('LISTENING',graphic_scope({'questions':'69-72'},'TOEIC_LR_2016'))
        self.assertEqual('LISTENING',graphic_scope({'questions':'62-garbled'},'TOEIC_LR_2016'))
        self.assertEqual('LISTENING',graphic_scope({'questions':'62-64'},'UNKNOWN'))

    def test_unresolved_listening_boundaries_keep_uncertainty_in_listening(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'reports').mkdir();(root/'audio_segments').mkdir()
            (root/'reports/audio_segmentation.json').write_text(json.dumps({'recordings':[
                {'testId':'toeic/ybm-vol-2/test-3','parentSha256':'a'*64,'boundaries':[
                    {'between':'1|2','tier':'UNRESOLVED','atS':None,'evidence':[]},
                    {'between':'2|3','tier':'CONFIDENT','atS':100,'evidence':['own announcement']}]}]}))
            (root/'audio_segments/sample.json').write_text(json.dumps({'parentPath':'audio.mp3',
                'parentSha256':'b'*64,'candidates':[{'atS':100,'durS':2,'evidence':['silence'],'tier':'PROBABLE'}]}))
            result=build_queue(root)
            boundaries=[e for e in result['entries'] if e['type']=='AUDIO_BOUNDARY']
            self.assertEqual(2,len(boundaries))
            self.assertEqual({'LISTENING'},{e['scope'] for e in boundaries})
            self.assertEqual({'UNRESOLVED','PROBABLE'},{e['confidence'] for e in boundaries})
            self.assertTrue(all(e.get('status') not in ('APPROVED','CORRECTED','RESOLVED_BY_PROOF') for e in boundaries))
