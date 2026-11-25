"""Real artifact validation and local lifecycle tests; all writes are temporary."""
import copy
import json
import gzip
import hashlib
import shutil
import sqlite3
from pathlib import Path
import tempfile
import unittest
from contextlib import closing
from unittest.mock import patch
import snapshot as op
from review_checks import presentation_collisions

PACKAGE=Path(__file__).resolve().parents[3]/'src/main/resources/data/king/corpus'


class SnapshotTest(unittest.TestCase):
    def test_v3_restores_source_proven_unions_and_binds_repairs(self):
        package=Path(__file__).resolve().parents[4]/'docs/king-of-english/corpus/production-review/packages/king-corpus-2026-10-05-v3'
        definition,_=op.validate_package(package,'king-corpus-2026-10-05-v3','3','king-snapshot-3')
        self.assertEqual('695c39043dac52dddc95d5b7bd3b0ac012a7498f94067c3230ab112483bf4b4c',op.sha(op.encode(definition)))
        self.assertEqual([],definition['report']['findings'])
        self.assertEqual(31251,sum(definition['report']['counts'][m]['valid'] for m in op.MODES))
        self.assertIn('corpus-repairs.json',definition['artifacts'])
        proof=json.loads((package/'corpus-repairs.json').read_bytes())
        self.assertEqual(12,len(proof['decisions']));self.assertEqual(25,proof['repairedCollisionItems'])
        self.assertEqual(616,len(proof['metadataCorrections']))
        with tempfile.TemporaryDirectory() as d:
            base=Path(d)/'host'; ledger=base/'state'; artifacts=base/'packages'/definition['snapshotId']
            shutil.copytree(package,artifacts)
            digest=op.create(ledger,artifacts,definition['snapshotId'],'3','king-snapshot-3',True)
            self.assertEqual('../packages/'+definition['snapshotId'],op.state(ledger)['snapshots'][definition['snapshotId']]['package'].replace('\\','/'))
            moved=Path(d)/'container';base.rename(moved);ledger=moved/'state'
            op.decide(ledger,definition['snapshotId'],digest,'EXPLICIT LOCAL TEST FIXTURE','LOCAL_TEST','APPROVE',True)
            self.assertIsNone(op.state(ledger)['active'],'Approval does not activate')
            op.activate(ledger,definition['snapshotId'],digest,'LOCAL_TEST')
            op.deactivate(ledger)
            op.activate(ledger,definition['snapshotId'],digest,'LOCAL_TEST',rollback=True)
            self.assertEqual(digest,op.state(ledger)['active']['fingerprint'])
        with self.assertRaisesRegex(ValueError,'UNSUPPORTED_VALIDATOR'):
            op.validate_package(package,'future','99','king-snapshot-999')

    @classmethod
    def setUpClass(cls):
        cls.definition,cls.sample=op.validate_package(PACKAGE,'test-release','1')
        cls.sources={s['id']:s for s in json.loads((PACKAGE/'sources.lock.json').read_bytes())['sources']}

    def test_full_coverage_and_determinism(self):
        again,_=op.validate_package(PACKAGE,'test-release','1')
        self.assertEqual(op.encode(self.definition),op.encode(again))
        expected={'REFLEX':26583,'EXPLAIN':2425,'REORDER':2093,'CONQUEST':150,'LEXICON':10023}
        for mode,n in expected.items():
            self.assertEqual(dict(total=n,valid=n,quarantined=0,warnings=self.definition['report']['counts'][mode]['warnings']),self.definition['report']['counts'][mode])
        self.assertEqual(41274,self.definition['report']['coverage'])
        self.assertEqual(0,len(self.definition['report']['findings']))
        self.assertGreater(len(self.definition['report']['warnings']),0)
        self.assertGreater(self.definition['report']['duplicateClusters'],0)

    def test_mode_mutations_are_blocking_and_warnings_are_separate(self):
        for mode in ('REORDER','REFLEX','EXPLAIN','CONQUEST'):
            row=copy.deepcopy(next(r for r in self.sample if r['mode']==mode))
            row['content']={};row['fingerprint']=op.fingerprint(row)
            errors,_=op.validate_item(row,self.sources,row['sourceLockSha256'],set(),{})
            self.assertIn('INVALID_SCHEMA',errors)
        row=copy.deepcopy(next(r for r in self.sample if r['mode']=='REORDER'))
        row['content']['tokens']=['impossible','reconstruction'];row['fingerprint']=op.fingerprint(row)
        self.assertIn('IMPOSSIBLE_RECONSTRUCTION',op.validate_item(row,self.sources,row['sourceLockSha256'],set(),{})[0])
        row=copy.deepcopy(next(r for r in self.sample if r['mode']=='EXPLAIN'))
        row['content']['progressiveClues'][0]=row['content']['target'];row['fingerprint']=op.fingerprint(row)
        self.assertIn('INVALID_CLUES',op.validate_item(row,self.sources,row['sourceLockSha256'],set(),{})[0])

    def test_exact_approval_activation_rollback_and_deactivation(self):
        with tempfile.TemporaryDirectory() as d:
            # Reuse the real deterministic result; operation verification still checks exact bytes.
            with patch.object(op,'validate_package',return_value=(copy.deepcopy(self.definition),self.sample)):
                h=op.create(d,PACKAGE,'test-release','1')
                with self.assertRaises(ValueError): op.activate(d,'test-release',h,'LOCAL_TEST')
                with self.assertRaises(ValueError): op.decide(d,'test-release','0'*64,'local-owner','LOCAL_TEST','APPROVE',True)
                with self.assertRaisesRegex(ValueError,'PRODUCTION_REQUIRES_REPAIRED_VALIDATOR'): op.decide(d,'test-release',h,'SYNTHETIC TEST FIXTURE','PRODUCTION','APPROVE',True)
                op.decide(d,'test-release',h,'LOCAL OWNER TEST','LOCAL_TEST','APPROVE',True)
                with self.assertRaises(ValueError): op.activate(d,'test-release',h,'PRODUCTION')
                op.activate(d,'test-release',h,'LOCAL_TEST')
                self.assertEqual('LOCAL_TEST_ACTIVE',op.state(d)['active']['status'])
                self.assertEqual('LOCAL_OWNER_TEST',op.state(d)['snapshots']['test-release']['approval']['kind'])
            second=copy.deepcopy(self.definition);second['snapshotId']='test-release-2';second['version']='2'
            with patch.object(op,'validate_package',return_value=(second,self.sample)):
                h2=op.create(d,PACKAGE,'test-release-2','2')
                op.decide(d,'test-release-2',h2,'LOCAL OWNER TEST','LOCAL_TEST','APPROVE',True)
                with self.assertRaises(ValueError):op.activate(d,'test-release-2',h2,'LOCAL_TEST',rollback=True)
                op.activate(d,'test-release-2',h2,'LOCAL_TEST')
                self.assertEqual('test-release',op.state(d)['active']['previous'])
            with patch.object(op,'validate_package',return_value=(copy.deepcopy(self.definition),self.sample)):
                op.activate(d,'test-release',h,'LOCAL_TEST',rollback=True)
                self.assertEqual('test-release-2',op.state(d)['active']['previous'])
                op.deactivate(d); self.assertIsNone(op.state(d)['active'])
                op.activate(d,'test-release',h,'LOCAL_TEST',rollback=True)
                self.assertEqual(h,op.state(d)['active']['fingerprint'])
                changed=copy.deepcopy(self.definition);changed['eligibleIds']['REFLEX'].pop()
                Path(d,'test-release.json').write_bytes(op.encode(changed))
                with self.assertRaises(ValueError): op.activate(d,'test-release',h,'LOCAL_TEST')

    def test_changed_package_cannot_inherit_approval(self):
        with tempfile.TemporaryDirectory() as d:
            with patch.object(op,'validate_package',return_value=(self.definition,self.sample)):
                h=op.create(d,PACKAGE,'test-release','1')
            changed=copy.deepcopy(self.definition);changed['artifacts']['manifest.json']='0'*64
            with patch.object(op,'validate_package',return_value=(changed,self.sample)):
                with self.assertRaisesRegex(ValueError,'CHANGED_CONTENT'): op.decide(d,'test-release',h,'owner','LOCAL_TEST','APPROVE',True)

    def test_concurrent_operator_and_immutable_identity(self):
        with tempfile.TemporaryDirectory() as d:
            with op.locked(d):
                with self.assertRaises(FileExistsError):
                    with op.locked(d): pass
            with patch.object(op,'validate_package',return_value=(self.definition,self.sample)):
                op.create(d,PACKAGE,'test-release','1')
                with self.assertRaises(ValueError): op.create(d,PACKAGE,'test-release','1')

    def test_one_bad_item_is_quarantined_without_blocking_full_package(self):
        with tempfile.TemporaryDirectory() as d:
            package=Path(d)/'package';package.mkdir()
            for name in self.definition['artifacts']:
                target=package/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(PACKAGE/name,target)
            manifest=json.loads((package/'manifest.json').read_bytes());logical=hashlib.sha256();bad_id=None
            for spec in manifest['shards']:
                dbpath=Path(d)/spec['name'];dbpath.write_bytes(gzip.decompress((package/spec['name']).read_bytes()))
                with closing(sqlite3.connect(dbpath)) as db:
                    if spec['name']=='king-core.sqlite.gz':
                        bad_id,body=db.execute("select id,body from content where mode='REFLEX' order by id limit 1").fetchone()
                        row=json.loads(body);row['content']['canonical']='';row['fingerprint']=op.fingerprint(row)
                        db.execute('update content set body=? where id=?',(json.dumps(row,ensure_ascii=False,sort_keys=True,separators=(',',':')),bad_id));db.commit()
                    h=hashlib.sha256()
                    for body, in db.execute('select body from content order by id'):
                        data=(body+'\n').encode();h.update(data);logical.update(data)
                    for word, in db.execute('select word from lexicon order by word'):
                        data=(word+'\n').encode();h.update(data);logical.update(data)
                    db.execute("update manifest set value=? where key='contentSha256'",(h.hexdigest(),));db.commit()
                data=gzip.compress(dbpath.read_bytes(),mtime=0);(package/spec['name']).write_bytes(data)
                spec.update(sha256=op.sha(data),contentSha256=h.hexdigest(),bytes=len(data))
            manifest['contentBuildSha256']=logical.hexdigest();(package/'manifest.json').write_bytes(op.encode(manifest))
            definition,_=op.validate_package(package,'quarantine-test','1');counts=definition['report']['counts']['REFLEX']
            self.assertEqual(26582,counts['valid']);self.assertEqual(1,counts['quarantined']);self.assertEqual(counts['total'],counts['valid']+counts['quarantined'])
            self.assertNotIn(bad_id,definition['eligibleIds']['REFLEX']);self.assertIn('EMPTY_ANSWER',[x['code'] for x in definition['report']['findings'] if x['id']==bad_id])
            for mode in ('REORDER','EXPLAIN','CONQUEST'): self.assertEqual(self.definition['eligibleIds'][mode],definition['eligibleIds'][mode])

    def test_presentation_collision_only_blocks_objective_answer_conflicts(self):
        row = dict(id='a', mode='REFLEX', family='WORD_FAMILY', sourceRefs=[],
                   content=dict(prompt='Related noun?', context='Same meaning', canonical='advertisement', accepted=[]))
        other = copy.deepcopy(row); other['id']='b'; other['content']['canonical']='advertising'
        self.assertEqual(1, len(presentation_collisions([row, other])))
        other['content']['context']='A different sense'
        self.assertEqual([], presentation_collisions([row, other]))
        other['content']['context']='Same meaning'
        row['content']['accepted']=['advertising']; other['content']['accepted']=['advertisement']
        self.assertEqual([], presentation_collisions([row, other]))

    def test_v2_quarantine_and_v1_fingerprint_compatibility(self):
        retained=Path(__file__).resolve().parents[4]/'docs/king-of-english/corpus/snapshot-activation/snapshot-definition.json'
        v1,_=op.validate_package(PACKAGE,'king-corpus-2026-10-05-v1','1')
        self.assertEqual(retained.read_bytes(),op.encode(v1))
        v2,_=op.validate_package(PACKAGE,'king-corpus-2026-10-05-v2','2','king-snapshot-2')
        self.assertEqual(19,v2['report']['counts']['REFLEX']['quarantined'])
        self.assertEqual(26564,v2['report']['counts']['REFLEX']['valid'])
        self.assertEqual(6,v2['report']['counts']['EXPLAIN']['quarantined'])
        self.assertEqual(2419,v2['report']['counts']['EXPLAIN']['valid'])
        self.assertEqual(25,len(v2['report']['findings']))
        self.assertEqual({'IDENTICAL_PRESENTATION_DIFFERENT_ACCEPTED_ANSWERS'}, {f['code'] for f in v2['report']['findings']})
        for mode in ('REORDER','CONQUEST'):
            self.assertEqual(v1['eligibleIds'][mode],v2['eligibleIds'][mode])
        self.assertEqual(v1['eligibleLexicon'],v2['eligibleLexicon'])
        with tempfile.TemporaryDirectory() as d:
            op.create(d,PACKAGE,'king-corpus-2026-10-05-v2','2','king-snapshot-2')
            record,definition=op.verify(d,'king-corpus-2026-10-05-v2',op.state(d))
            self.assertIsNone(record['approval']); self.assertIsNone(op.state(d)['active'])
            self.assertEqual('king-snapshot-2',definition['validatorVersion'])


if __name__=='__main__': unittest.main()
