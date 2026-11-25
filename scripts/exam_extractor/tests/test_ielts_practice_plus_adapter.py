import unittest
from exam_extractor.adapters.ielts_practice_plus import IeltsPracticePlusAdapter
from exam_extractor.pdf_layer import Row,Token

class PracticePlusAdapterTest(unittest.TestCase):
    def row(self,text,y):return Row(32,y,y+15,20,200,[Token(text,20,200)],'OCR',1)
    def test_printed_module_heading_assigns_skill_and_does_not_enter_prompt(self):
        rows=[self.row('Test 3 (Academic Module)',30),self.row('Listening module (30 minutes)',60),self.row('SECTION 1',100),self.row('Questions 1-10',120)]
        result=IeltsPracticePlusAdapter().annotate([(32,rows)],600,800,question_window=True)
        self.assertTrue(result)
        self.assertTrue(all(r.test==3 and r.skill=='LISTENING' for r in result))
        self.assertFalse(any('module' in r.row.text.lower() for r in result))
    def test_body_word_module_is_not_promoted_to_a_skill_heading(self):
        rows=[self.row('Test 2',30),self.row('READING',60),self.row('Listening module',300)]
        result=IeltsPracticePlusAdapter().annotate([(32,rows)],600,800,question_window=True)
        self.assertEqual('READING',result[-1].skill)
        self.assertEqual('Listening module',result[-1].row.text)
    def test_proven_chapter_identity_survives_a_split_layout_caption(self):
        rows=[self.row('TEST',30),self.row('1',30),self.row('Listening module',60),self.row('Questions 1-10',120)]
        result=IeltsPracticePlusAdapter().annotate([(32,rows)],600,800,question_window=True,proven_test=1)
        self.assertTrue(any(r.test==1 and r.skill=='LISTENING' for r in result))
    def test_mislabeled_full_book_requires_exact_discovery_hash(self):
        from types import SimpleNamespace as NS
        test=NS(raw={'discovery':{'source':'full.pdf','sha256':'verified'}},book_raw={'source_documents':[{'path':'full.pdf','sha256':'verified','role':'ANSWER_KEY'}]},test_number=1)
        self.assertEqual(['full.pdf'],IeltsPracticePlusAdapter().question_documents(test,None))
        test.raw['discovery']['sha256']='different'
        self.assertEqual([],IeltsPracticePlusAdapter().question_documents(test,None))
    def test_unresolved_selection_diagnostic_is_registered(self):
        from exam_extractor.diagnostics import DiagnosticLog
        log=DiagnosticLog();log.add('QUESTION_SOURCE_SELECTION_UNRESOLVED','TEST')
        self.assertEqual('BLOCKING',log.items[0].severity)
