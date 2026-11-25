import unittest
from unittest.mock import patch,Mock
from types import SimpleNamespace as NS
from exam_extractor.pipeline import Extractor


class IeltsFamilyDiscoveryTest(unittest.TestCase):
    def extractor(self,own=('TEST2','TEST2'),sha='hash'):
        basis=NS(family='IELTS',collection='cambridge',book='fixture',book_title='Fixture',test_id='ielts/fixture/test-1',test_number=1,
            raw={'audio':[{'source':'only-test1.mp3'}]},book_raw={'source_documents':[{'path':'source.pdf','sha256':'hash'}]})
        ex=Extractor.__new__(Extractor);ex.manifest=NS(select=lambda **k:[basis]);ex.layer=Mock(return_value=NS(sha256=sha,page_size=lambda p:(600,800)))
        values=iter(own)
        def read(*a,**k):
            word=NS(text=next(values) if 'boxes_pt' in k else 'Test 2',conf=1,bbox=(20,40,100,60))
            return NS(words=[word])
        ex.region_cache=Mock(return_value=NS(recognize=read))
        return ex,basis

    def run_discovery(self,ex):
        with patch.dict('exam_extractor.pipeline.IELTS_SCAN_PROFILES',{'fixture':{'source_sha256':'hash','test_pages':{1:(1,10),2:(11,20)}}}):
            return ex.family_tests('fixture')

    def test_two_own_reads_add_identity_without_inheriting_audio(self):
        ex,basis=self.extractor();tests=self.run_discovery(ex)
        self.assertEqual([1,2],[t.test_number for t in tests]);self.assertIs(basis,tests[0])
        self.assertEqual([],tests[1].raw['audio'])
        self.assertEqual({'source':'source.pdf','sha256':'hash','page':11,'printedTest':2},tests[1].raw['discovery'])

    def test_expected_window_never_supplies_missing_or_conflicting_digits(self):
        for own in (('TEST2','TEST3'),('TEST3','TEST3'),('TEST','TEST')):
            ex,basis=self.extractor(own)
            self.assertEqual([basis],self.run_discovery(ex))

    def test_another_source_hash_refuses_discovery_before_ocr(self):
        ex,basis=self.extractor(sha='another-edition')
        self.assertEqual([basis],self.run_discovery(ex));ex.region_cache.assert_not_called()
