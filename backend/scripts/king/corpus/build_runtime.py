"""Build two compact, indexed, immutable runtime shards from qualified records."""
from collections import Counter
from contextlib import closing
import gzip
import hashlib
import json
from pathlib import Path
import sqlite3
import shutil
from derive import fingerprint,digest
from normalize import WORK
from quality import acceptance,validate_record
from sources import ROOT,LOCK,EVIDENCE,registry,sha256,write_json
from build_boards import eligible_lexicon

OUT=ROOT/'backend/src/main/resources/data/king/corpus'


def build():
    lock=registry();sources={s['id']:s for s in lock['sources']};lockhash=sha256(LOCK)
    with closing(sqlite3.connect(WORK.as_uri()+'?mode=ro',uri=True)) as db:
        rows=[json.loads(b) for b, in db.execute("SELECT body FROM candidates WHERE confidence='HIGH_CONFIDENCE_SOURCE_BACKED' ORDER BY id")]
        lexicon=sorted(eligible_lexicon(db))
    counts=Counter(r['mode'] for r in rows);families=Counter(r['family'] for r in rows if r['mode']=='REFLEX')
    blockers=acceptance(counts,families)
    categories=Counter(r['family'] for r in rows if r['mode']=='REORDER')
    if categories and max(categories.values())/sum(categories.values())>.35:blockers.append(dict(code='REORDER_CATEGORY_DOMINANCE'))
    stronger={'WORD_FAMILY':150,'PART_OF_SPEECH':200,'SYNONYM':250,'ANTONYM':150,'COLLOCATION':200,'PHRASAL_VERB':150,'IDIOM_FRAGMENT':100,'FIXED_EXPRESSION':150,'GRAMMAR_TRAP':200}
    blockers.extend(dict(code='STRONGER_FAMILY_FLOOR',family=f,actual=families[f],required=n) for f,n in stronger.items() if families[f]<n)
    errors=Counter()
    for row in rows:errors.update(validate_record(row,sources,lockhash))
    if errors:blockers.append(dict(code='INTEGRITY',errors=dict(errors)))
    write_json(EVIDENCE/'continuation/runtime-build-gate.json',dict(counts=dict(counts),families=dict(families),categories=dict(categories),blockers=blockers))
    if blockers:raise ValueError('RUNTIME_BUILD_FLOORS_FAILED:'+json.dumps(blockers))
    OUT.mkdir(parents=True,exist_ok=True)
    logical=hashlib.sha256();shards=[]
    for name,share in [('king-core',False),('king-phrases-cc-by-sa',True)]:
        target=OUT/(name+'.sqlite');temp=OUT/(name+'.building.sqlite')
        if temp.exists():temp.unlink()
        selected=[r for r in rows if ('CC-BY-SA-4.0' in r['licenseRefs'])==share]
        with closing(sqlite3.connect(temp)) as dest:
            dest.executescript('''PRAGMA page_size=4096;
            CREATE TABLE manifest(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE content(id TEXT PRIMARY KEY,mode TEXT NOT NULL,family TEXT NOT NULL,difficulty INTEGER NOT NULL,cefr TEXT NOT NULL,semantic_hash TEXT UNIQUE NOT NULL,links TEXT NOT NULL,body TEXT NOT NULL);
            CREATE INDEX buckets ON content(mode,family,difficulty,id);
            CREATE TABLE lexicon(word TEXT PRIMARY KEY);
            CREATE TABLE sources(id TEXT PRIMARY KEY,body TEXT NOT NULL);''')
            shardhash=hashlib.sha256()
            for original in selected:
                r=json.loads(json.dumps(original));r['sourceQualificationFingerprint']=r['fingerprint']
                r['content'].pop('annotation',None);r['fingerprint']=fingerprint(r)
                body=json.dumps(r,ensure_ascii=False,sort_keys=True,separators=(',',':'))
                for h in (logical,shardhash):h.update(body.encode());h.update(b'\n')
                c=r['content'];links=json.dumps(r.get('semanticLinks',[]),sort_keys=True,separators=(',',':'))
                dest.execute('INSERT INTO content VALUES(?,?,?,?,?,?,?,?)',(r['id'],r['mode'],r['family'],c.get('difficulty',3),c.get('cefr','UNKNOWN'),r['semanticHash'],links,body))
            if not share:
                dest.executemany('INSERT INTO lexicon VALUES(?)',((w,) for w in lexicon))
                for word in lexicon:shardhash.update((word+'\n').encode());logical.update((word+'\n').encode())
            sourceids=sorted({s['source'] for r in selected for s in r['sourceRefs']})
            for sid in sourceids:dest.execute('INSERT INTO sources VALUES(?,?)',(sid,json.dumps(sources[sid],sort_keys=True)))
            manifest=dict(schemaVersion='1',buildVersion='king-qualified-2',sourceLockSha256=lockhash,
                          contentSha256=shardhash.hexdigest(),licenseClass='CC-BY-SA-4.0' if share else 'ATTRIBUTED_CORE',
                          humanApproved='0',productionActive='0')
            dest.executemany('INSERT INTO manifest VALUES(?,?)',manifest.items());dest.commit();dest.execute('VACUUM')
        temp.replace(target)
        compressed=target.with_suffix('.sqlite.gz')
        with target.open('rb') as stream,compressed.open('wb') as output,gzip.GzipFile(filename='',fileobj=output,mode='wb',mtime=0,compresslevel=9) as z:
            while data:=stream.read(1048576):z.write(data)
        target.unlink()
        shards.append(dict(name=compressed.name,sha256=sha256(compressed),bytes=compressed.stat().st_size,records=len(selected),shareAlike=share,contentSha256=manifest['contentSha256']))
    manifest=dict(schemaVersion=1,buildVersion='king-qualified-2',sourceLockSha256=lockhash,contentBuildSha256=logical.hexdigest(),shards=shards,
                  counts=dict(counts),families=dict(families),categories=dict(categories),lexiconCount=len(lexicon),humanApproved=0,productionActive=0)
    write_json(OUT/'manifest.json',manifest);write_json(EVIDENCE/'continuation/runtime-artifact.json',manifest)
    notices=OUT/'licenses';notices.mkdir(exist_ok=True)
    attribution=['# King review-preview corpus attribution','',
        'Source-backed offline derivatives. Human approval: 0. No source endorsement is claimed. Definitions and metadata were selected, normalized, filtered and formatted as closed-answer challenges.','']
    used=sorted({ref['source'] for row in rows for ref in row['sourceRefs']})
    for sid in used:
        source=sources[sid];notice=ROOT/source['licenseEvidenceFile'];shutil.copy2(notice,notices/notice.name)
        attribution.extend([f"## {source['name']}",f"Version: {source['version']}",f"Source: {source['canonicalUrl']}",
            f"Attribution: {source['requiredAttribution']}",f"License: {source['licenseId']} ({source['licenseUrl']})",
            f"ShareAlike: {source['shareAlike']}",f"Notice: licenses/{notice.name}",''])
    princeton=EVIDENCE/'licenses/Princeton-WordNet.txt'
    if princeton.exists():shutil.copy2(princeton,notices/princeton.name)
    attribution.extend(['## Wiktionary ShareAlike derivative',
        'The separately distributed king-phrases-cc-by-sa.sqlite.gz derivative is CC BY-SA 4.0. Per-entry attribution URLs are retained in sourceRefs. Wiktionary contributors; extraction by Tatu Ylonen / Wiktextract. Definitions selected and normalized; question choices formatted; all examples, quotations, translations, etymologies and media excluded.',
        'https://creativecommons.org/licenses/by-sa/4.0/ — preserve attribution, modification notices, and the license on redistribution. The ShareAlike shard is separate from the attributed core.',''])
    (OUT/'ATTRIBUTION.md').write_text('\n'.join(attribution),encoding='utf-8')
    shutil.copy2(LOCK,OUT/'sources.lock.json')
    print(json.dumps(manifest))


if __name__=='__main__':build()
