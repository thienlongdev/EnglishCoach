import unittest
from types import SimpleNamespace
from unittest.mock import patch
from exam_extractor.qa_review import prove_key_cell_reread


class KeyCellReleaseProofTest(unittest.TestCase):
    def fixture(self):
        pkg={'manifest':{'metadata':{'sourceDocuments':[{'path':'source.pdf','sha256':'pinned'}]}},
             'sections':[{'id':'s','skill':'LISTENING'}],'parts':[{'id':'p','sectionId':'s'}],
             'formGroups':[{'groupId':'g','partId':'p'}],
             'items':[{'id':'i','groupId':'g','optionDefinitions':{'questionNumber':44}}],
             'answerSpecs':[{'itemId':'i','acceptedAnswers':{'values':['A']}}]}
        entry={'subtype':'KEY_CELL_REREAD_ADJUDICATED','questions':'44','scope':'LISTENING/PART_3',
               'sha256':'pinned','source':'source.pdf','testId':'toeic/ybm-vol-2/test-1','page':171}
        cell=SimpleNamespace(number=44,predicted=44,letter='A',adjudicated=True,
                             number_reads=['4','3','44','44','44','44'],letter_reads=['A','A'])
        block=SimpleNamespace(test=1,orientation='ROW_MAJOR',keys=lambda:{44:cell})
        return entry,pkg,cell,block

    def test_only_matching_number_letter_and_source_close(self):
        entry,pkg,cell,block=self.fixture()
        with patch('exam_extractor.qa_review._reread_source_key_blocks',return_value=[block]):
            self.assertIsNotNone(prove_key_cell_reread(entry,pkg))
            cell.number_reads[-4:]=['44','44','45','45']
            self.assertIsNone(prove_key_cell_reread(entry,pkg))
            cell.number_reads[-4:]=['44']*4;cell.letter_reads=['A','B']
            self.assertIsNone(prove_key_cell_reread(entry,pkg))
            cell.letter_reads=['A','A'];cell.letter='B'
            self.assertIsNone(prove_key_cell_reread(entry,pkg))
            cell.letter='A';entry['sha256']='changed'
            self.assertIsNone(prove_key_cell_reread(entry,pkg))
