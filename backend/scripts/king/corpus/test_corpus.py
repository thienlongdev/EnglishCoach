"""Offline integrity tests; no Spring context, network, DB migrations or approvals."""
import copy
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from build_boards import symmetry
from derive import candidate, fingerprint, semantic, FAMILIES, reorder_tokens
from mine_oanc import annotations
from normalize import normalized, WORK
from quality import acceptance, validate_record
from sources import LOCK, registry, verify, sha256


class SourceGateTests(unittest.TestCase):
    def mutate_lock(self,mutation):
        data=json.loads(LOCK.read_text(encoding='utf-8'));mutation(data['sources'][0])
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'lock.json';path.write_text(json.dumps(data),encoding='utf-8')
            return registry(path)

    def test_lock_has_verified_runtime_licenses(self):
        self.assertEqual(7,sum(s['runtimeEligible'] for s in registry()['sources']))

    def test_missing_license_fails(self):
        with self.assertRaisesRegex(ValueError,'INVALID_SOURCE_LOCK'):
            self.mutate_lock(lambda s:s.pop('licenseId'))

    def test_unknown_license_fails_closed(self):
        with self.assertRaisesRegex(ValueError,'LICENSE_GATE'):
            self.mutate_lock(lambda s:s.update(licenseId='UNKNOWN'))

    def test_validation_only_cannot_be_eligible(self):
        with self.assertRaisesRegex(ValueError,'LICENSE_GATE'):
            self.mutate_lock(lambda s:s.update(validationOnly=True))

    def test_unlocked_checksum_fails(self):
        with self.assertRaisesRegex(ValueError,'UNLOCKED_CHECKSUM'):
            self.mutate_lock(lambda s:s.update(sha256=None))

    def test_checksum_mismatch_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'raw';path.write_bytes(b'corrupt')
            with self.assertRaisesRegex(ValueError,'CHECKSUM_MISMATCH'):
                verify(dict(id='test',sha256='0'*64),path)

    def test_cache_cannot_escape(self):
        with self.assertRaisesRegex(ValueError,'INVALID_CACHE_PATH'):
            self.mutate_lock(lambda s:s.update(cacheFile='../wrong'))


class SemanticTests(unittest.TestCase):
    def setUp(self):
        self.row=candidate('REORDER','SIMPLE','He likes tea.',dict(canonical='He likes tea.'),['oewn-example'],
            [dict(source='oewn',record='sense-id')],['CC-BY-4.0 AND WordNet'])
        self.sources={s['id']:s for s in registry()['sources']}

    def test_cosmetic_identity_is_stable(self):
        self.assertEqual(semantic('REORDER','He likes tea.'),semantic('REORDER',' HE  LIKES tea! '))

    def test_normalized_lemma(self):
        self.assertEqual('colour',normalized(' ＣＯＬＯＵＲ '))

    def test_provenance_change_invalidates_fingerprint(self):
        self.row['sourceRefs'][0]['record']='other-sense'
        self.assertIn('STALE_FINGERPRINT',validate_record(self.row,self.sources,sha256(LOCK)))

    def test_source_version_invalidates_candidate(self):
        self.assertIn('STALE_SOURCE_VERSION',validate_record(self.row,self.sources,'changed'))

    def test_automatic_confidence_never_human_approval(self):
        self.row['humanReview']={'reviewer':'Agent'}
        self.assertIn('UNAUTHORIZED_REVIEW_STATE',validate_record(self.row,self.sources,sha256(LOCK)))

    def test_missing_source_fails(self):
        self.row['sourceRefs']=[dict(source='unknown',record='row')]
        self.assertIn('MISSING_PROVENANCE',validate_record(self.row,self.sources,sha256(LOCK)))

    def test_validation_source_leak_fails(self):
        self.row['sourceRefs']=[dict(source='local-dictionary',record='cat')]
        self.assertIn('INELIGIBLE_SOURCE',validate_record(self.row,self.sources,sha256(LOCK)))

    def test_high_confidence_with_flags_fails(self):
        self.row['confidence']='HIGH_CONFIDENCE_SOURCE_BACKED';self.row['flags']=['ORDER_UNPROVEN']
        self.assertIn('UNRESOLVED_HIGH_CONFIDENCE_FLAGS',validate_record(self.row,self.sources,sha256(LOCK)))

    def test_release_needs_every_family(self):
        counts=dict(REORDER=2000,REFLEX=3000,EXPLAIN=800,CONQUEST=150)
        families=dict.fromkeys(FAMILIES,100);families['IDIOM_FRAGMENT']=99
        blockers=acceptance(counts,families)
        self.assertEqual([dict(code='REFLEX_FAMILY_FLOOR',family='IDIOM_FRAGMENT',target=100,actual=99,gap=1)],blockers)

    def test_another_mode_count_cannot_fill_a_floor(self):
        blockers=acceptance(dict(REFLEX=50000),dict.fromkeys(FAMILIES,100))
        self.assertIn('REORDER_HARD_FLOOR',{b['code'] for b in blockers})

    def test_symmetry_does_not_make_a_new_board(self):
        letters=list('ABCDEFGHIJKLMNOPQRSTUVWXY')
        rotate=list(''.join(''.join(row) for row in zip(*[letters[i:i+5] for i in range(20,-1,-5)])))
        self.assertEqual(symmetry(letters),symmetry(rotate))

    def test_punctuation_cannot_satisfy_token_minimum(self):
        self.assertIsNone(reorder_tokens('We went home .'))
        self.assertIsNone(reorder_tokens('We went - straight home.'))
        self.assertEqual(['They','will','come','tomorrow'],reorder_tokens('They will come tomorrow.'))

    def test_invalid_annotation_offsets_quarantined(self):
        xml=b'<graph xmlns="http://www.xces.org/ns/GrAF/1.0/"><region xml:id="r" anchors="0 10"/><node xml:id="n"><link targets="r"/></node><a label="s" ref="n"/></graph>'
        with self.assertRaisesRegex(ValueError,'OANC_INVALID_OFFSETS'):annotations(xml,'short')


if __name__=='__main__':unittest.main()
