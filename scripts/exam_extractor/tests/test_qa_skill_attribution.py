"""Source-recorded skill must survive into QA so independent scopes are not hidden."""
import json
import tempfile
import unittest
from pathlib import Path
from exam_extractor.qa_queue import build_queue, diagnostic_locations, diagnostic_source
from exam_extractor.qa_review import _review_source


class QaSkillAttributionTest(unittest.TestCase):
    def test_owner_technical_decision_is_distinct_and_fingerprint_bound(self):
        from exam_extractor.qa_review import _status, _decision_problem
        decision = dict(entryId='CROP-source', decision='OWNER_APPROVED_TECHNICAL_MEDIA',
                        reviewer='PROJECT_OWNER', reviewedAt='2026-10-07T11:00:00Z',
                        fingerprint='sha256:current', ownerDecisionRef='owner-toeic-media-20261007',
                        humanReviewed=False)
        self.assertIsNone(_decision_problem(decision))
        self.assertEqual('OWNER_APPROVED_TECHNICAL_MEDIA',
                         _status('CROP-source','sha256:current',None,{'CROP-source':decision})[0])
        self.assertEqual('STALE_DECISION',
                         _status('CROP-source','sha256:changed',None,{'CROP-source':decision})[0])
        self.assertIsNotNone(_decision_problem(dict(decision,humanReviewed=True)))

    def test_review_does_not_override_source_with_a_skill_named_file(self):
        entry = dict(scope='READING', source='own.pdf', sha256='a' * 64)
        documents = [dict(path='READING.pdf', sha256='b' * 64), dict(path='own.pdf', sha256='a' * 64)]
        self.assertEqual(dict(path='own.pdf', sha256='a' * 64), _review_source(entry, documents))
        self.assertEqual(dict(path=None, sha256=None), _review_source(dict(scope='READING'), documents))
    def test_multi_document_source_uses_hash_bound_skill_not_document_order(self):
        lc = dict(path='lc.pdf', sha256='a' * 64, role='QUESTION_BOOK')
        rc = dict(path='rc.pdf', sha256='b' * 64, role='QUESTION_BOOK')
        records = [dict(lc, scope='LISTENING'), dict(rc, scope='READING')]
        d = dict(scope='READING/PART_5')
        self.assertEqual(rc, diagnostic_source(dict(documents=[lc, rc]), d, records))
        self.assertEqual(rc, diagnostic_source(dict(documents=[rc, lc]), d, records))
        self.assertEqual({}, diagnostic_source(dict(documents=[lc, rc]), d, []))
        self.assertEqual({}, diagnostic_source(dict(documents=[lc, rc]), d,
                                              [dict(rc, sha256='c' * 64, scope='READING')]))

    def test_new_report_scope_needs_no_manifest_and_ambiguity_stays_unlocated(self):
        documents = [dict(path='first.pdf', role='QUESTION_BOOK', scope='READING'),
                     dict(path='second.pdf', role='QUESTION_BOOK', scope='LISTENING')]
        self.assertEqual(documents[0], diagnostic_source(dict(documents=documents), dict(scope='READING'), []))
        documents[1]['scope'] = 'READING'
        self.assertEqual({}, diagnostic_source(dict(documents=documents), dict(scope='READING'), []))

    def test_option_repairs_preserve_own_question_page_pairs(self):
        d = dict(code='OPTION_LABEL_RECOGNISED', scope='READING', questions='129,154,189', pages='83,91,106')
        report = dict(ocrMetrics=dict(READING=dict(labels=dict(locations=[
            dict(q=129, page=83), dict(q=154, page=91), dict(q=189, page=106)]))))
        locations = diagnostic_locations(report, d)
        self.assertEqual([('129', '83'), ('154', '91'), ('189', '106')],
                         [(x['questions'], x['pages']) for x in locations])
        incomplete = dict(d, pages='83,91')
        self.assertEqual([incomplete], diagnostic_locations(report, incomplete))

    def test_key_table_and_photo_keep_their_source_skill(self):
        with tempfile.TemporaryDirectory() as temporary:
            staging = Path(temporary)
            (staging / "reports/extraction/toeic").mkdir(parents=True)
            (staging / "reports/ocr_keys").mkdir(parents=True)
            report = dict(testId="toeic/synthetic/test-1", documents=[], diagnostics=[],
                          reviewItems=[dict(type="PART1_PHOTO", source="synthetic.pdf", page=1)])
            (staging / "reports/extraction/toeic/synthetic.json").write_text(json.dumps(report))
            key_report = dict(book="synthetic", skill="LISTENING", source="synthetic.pdf", sha256="0" * 64,
                              tests=[dict(test=1, orientation=None, confirmed=0, expected=100, missing=[1,2], page=2)])
            (staging / "reports/ocr_keys/synthetic.json").write_text(json.dumps(key_report))
            entries = {e["subtype"]: e for e in build_queue(staging)["entries"]}
            self.assertEqual("ANSWER_KEY/LISTENING", entries["KEY_TABLE_BLOCK"]["scope"])
            self.assertEqual("LISTENING/PART_1", entries["PART1_PHOTO"]["scope"])
            self.assertNotEqual("APPROVED", entries["KEY_TABLE_BLOCK"].get("status"))
