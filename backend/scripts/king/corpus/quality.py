"""Auditable release gate. No runtime artifact is emitted while a hard floor fails."""
import argparse
from collections import Counter, defaultdict
from contextlib import closing
import html
import json
from pathlib import Path
import random
import sqlite3
from derive import FAMILIES, fingerprint
from normalize import WORK
from sources import CACHE, EVIDENCE, ROOT, LOCK, registry, sha256, write_json
from build_boards import eligible_lexicon, symmetry, trie, solve, metrics


def validate_record(row,sources,lock_hash):
    errors=[]
    if row['sourceLockSha256']!=lock_hash:errors.append('STALE_SOURCE_VERSION')
    if row['fingerprint']!=fingerprint(row):errors.append('STALE_FINGERPRINT')
    if row['humanReview'] is not None or row['reviewStatus']!='HUMAN_REVIEW_PENDING':errors.append('UNAUTHORIZED_REVIEW_STATE')
    if not row['sourceRefs'] or not row['licenseRefs']:errors.append('MISSING_PROVENANCE')
    for ref in row['sourceRefs']:
        source=sources.get(ref.get('source'))
        if not source or not ref.get('record'):errors.append('MISSING_PROVENANCE');continue
        if not source['runtimeEligible'] or source['validationOnly']:errors.append('INELIGIBLE_SOURCE')
        if source['licenseId'] not in row['licenseRefs']:errors.append('MISSING_LICENSE_REFERENCE')
    if row['confidence']=='HIGH_CONFIDENCE_SOURCE_BACKED' and row['flags']:errors.append('UNRESOLVED_HIGH_CONFIDENCE_FLAGS')
    return errors


def acceptance(counts,families):
    blockers=[]
    for mode,floor in [('REORDER',2000),('REFLEX',3000),('EXPLAIN',800),('CONQUEST',150)]:
        actual=counts.get(mode,0)
        if actual<floor:blockers.append(dict(code=mode+'_HARD_FLOOR',target=floor,actual=actual,gap=floor-actual))
    for family in FAMILIES:
        actual=families.get(family,0)
        if actual<100:blockers.append(dict(code='REFLEX_FAMILY_FLOOR',family=family,target=100,actual=actual,gap=100-actual))
    return blockers


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--release',action='store_true');args=parser.parse_args()
    lock=registry();sources={s['id']:s for s in lock['sources']};lock_hash=sha256(LOCK)
    counts=Counter();families=Counter();mode_totals=Counter();review_counts=Counter();flags=Counter();errors=Counter();samples=[]
    buckets=defaultdict(list);duplicate_signatures=defaultdict(list);ids=set();semantics=set()
    contribution=Counter();licenses=Counter();all_rows=[]
    with closing(sqlite3.connect(WORK.as_uri()+'?mode=ro',uri=True)) as db:
        for body, in db.execute('SELECT body FROM candidates ORDER BY id'):
            row=json.loads(body);all_rows.append(row);mode_totals[row['mode']]+=1;flags.update(row['flags'])
            errors.update(validate_record(row,sources,lock_hash))
            if row['id'] in ids:errors['DUPLICATE_ID']+=1
            if row['semanticHash'] in semantics:errors['SEMANTIC_DUPLICATE']+=1
            ids.add(row['id']);semantics.add(row['semanticHash']);licenses.update(row['licenseRefs'])
            contribution.update({r['source'] for r in row['sourceRefs']})
            buckets[(row['mode'],row['family'])].append(row)
            if row['confidence']=='HIGH_CONFIDENCE_SOURCE_BACKED':
                counts[row['mode']]+=1
                if row['mode']=='REFLEX':families[row['family']]+=1
            else:review_counts[row['mode']]+=1
            if row['mode']=='REORDER':
                signature=' '.join(sorted(t.get('lemma') or t['text'].lower() for t in row['content']['annotation'] if t['text'].isalpha()))
                duplicate_signatures[signature].append(row['id'])
        canonical={t:db.execute('SELECT count(*) FROM '+t).fetchone()[0] for t in ('concepts','lexemes','senses','profiles','grammar','spelling','sentences','documents')}
        root=trie(eligible_lexicon(db));board_layouts=set()
        for row in all_rows:
            if row['mode']!='CONQUEST':continue
            content=row['content'];paths=solve(content['letters'],root)
            if metrics(paths)!=content['qualityMetrics']:errors['BOARD_SOLVER_MISMATCH']+=1
            layout=symmetry(content['letters'])
            if layout in board_layouts:errors['BOARD_SYMMETRY_DUPLICATE']+=1
            board_layouts.add(layout)
            for echo in content['echoCandidates']:
                path=echo['path']
                if (echo['word'] not in paths or len(set(path))!=len(path) or
                    any(not 0<=i<25 for i in path) or
                    any(max(abs(a//5-b//5),abs(a%5-b%5))!=1 for a,b in zip(path,path[1:])) or
                    ''.join(content['letters'][i].lower() for i in path)!=echo['word']):errors['INVALID_ECHO_PATH']+=1
    blockers=acceptance(counts,families)
    if errors:blockers.append(dict(code='DATA_INTEGRITY_ERRORS',counts=dict(errors)))
    # Export fixed-seed samples and all deficient family counts. Never prefill approvals.
    rng=random.Random(20261004)
    for (mode,family),rows in sorted(buckets.items()):
        samples.extend(rng.sample(rows,min(len(rows),25 if mode=='REFLEX' else 20)))
    for mode in ('REORDER','EXPLAIN','CONQUEST'):
        pool=[r for r in all_rows if r['mode']==mode]
        samples.extend(rng.sample(pool,min(len(pool),25 if mode=='CONQUEST' else 100)))
    samples=list({r['id']:r for r in samples}.values())
    write_json(EVIDENCE/'review/samples.json',samples)
    cards=''.join('<article><h2>'+html.escape(r['id'])+'</h2><pre>'+html.escape(json.dumps(r,ensure_ascii=False,indent=2))+'</pre></article>' for r in samples)
    (EVIDENCE/'review/samples.html').write_text('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>King source candidate samples</title><style>body{font:16px system-ui;max-width:1000px;margin:auto;padding:24px}pre{white-space:pre-wrap;overflow-wrap:anywhere}article{border-top:1px solid #ccc}</style><h1>King source candidate samples</h1><p>Fixed seed 20261004. High confidence is source qualification, not owner approval. Includes qualified and quarantined candidates for comparison. Decision fields are blank.</p>'+cards,encoding='utf-8')
    clusters=[dict(signature=s,ids=ids) for s,ids in sorted(duplicate_signatures.items()) if len(ids)>1]
    write_json(EVIDENCE/'near-duplicate-review.json',dict(method='source-annotated lemmatized token signatures; candidate clusters, not proof of equivalent meanings',clusters=clusters))
    source_summary=[]
    for s in lock['sources']:
        raw=CACHE/s['cacheFile'] if s['cacheFile'] else None
        source_summary.append(dict(**s,downloaded=bool(raw and raw.exists()),rawBytes=raw.stat().st_size if raw and raw.exists() else 0,
                                   candidateContributions=contribution[s['id']]))
    write_json(EVIDENCE/'source-license-report.json',source_summary)
    write_json(EVIDENCE/'source-lock-snapshot.json',lock)
    artifact_path=ROOT/'backend/src/main/resources/data/king/corpus/manifest.json'
    artifact=json.loads(artifact_path.read_text(encoding='utf-8')) if artifact_path.exists() else None
    summary=dict(status='DATA_GATES_FAILED' if blockers else 'DATA_FLOORS_PASS',
        sourceLockSha256=lock_hash,canonical=canonical,totalCandidates=dict(mode_totals),highConfidence=dict(counts),
        reviewNeeded=dict(review_counts),reflexFamilies={f:dict(highConfidence=families[f],candidates=len(buckets.get(('REFLEX',f),[]))) for f in FAMILIES},
        flags=dict(flags),integrityErrors=dict(errors),blockers=blockers,semanticDuplicates=errors['SEMANTIC_DUPLICATE'],
        nearDuplicateClusters=len(clusters),humanApproved=0,productionActive=0,
        runtimeArtifact=artifact,runtimeIntegrated=None,previewReleaseProduced=False,
        rawBytes=sum(s['rawBytes'] for s in source_summary),normalizedBytes=WORK.stat().st_size,
        normalizedSha256=sha256(WORK),sourceContributions=dict(contribution),
        remainingImplementation=[],runtimeVerification='See continuation verification evidence; offline quality does not certify runtime tests.')
    write_json(EVIDENCE/'quality-report.json',summary)
    attribution=['# King corpus working-data attribution','',
        'These offline derivatives are not a deployed runtime release. Data were normalized, filtered and transformed into candidate tasks. No human approval or source endorsement is claimed.','']
    for s in source_summary:
        attribution.extend([f'## {s["name"]}',f'Version: {s["version"]}',f'Source: {s["canonicalUrl"]}',f'License: {s["licenseId"]} ({s["licenseUrl"]})',
            f'Attribution: {s["requiredAttribution"]}',f'Imported: {s["downloaded"]}; candidate contributions: {s["candidateContributions"]}',''])
    attribution.extend(['Princeton notice: licenses/Princeton-WordNet.txt. OEWN terms: licenses/oewn.txt. SCOWL official-speller notice: licenses/scowl.txt. CEFR-J terms: licenses/cefrj-vocabulary.txt. These notices must accompany future redistributed derivatives.'])
    (EVIDENCE/'ATTRIBUTION.md').write_text('\n'.join(attribution)+'\n',encoding='utf-8')
    print(json.dumps({k:summary[k] for k in ('status','totalCandidates','highConfidence','blockers','integrityErrors')}))
    if args.release:
        if blockers:raise SystemExit('RELEASE_BLOCKED: hard floors/integrity failed; no runtime artifact written')
        gate=EVIDENCE/'continuation/verification-gate.json'
        if not gate.exists():raise SystemExit('RELEASE_BLOCKED: retained verification gate required')
        verified=json.loads(gate.read_text(encoding='utf-8'))
        if (not verified.get('passResult') or not verified.get('checks') or
            not all(verified['checks'].values()) or not artifact or
            verified.get('sourceLockSha256')!=lock_hash or
            verified.get('contentBuildSha256')!=artifact['contentBuildSha256'] or
            not verified.get('evidenceHashes')):
            raise SystemExit('RELEASE_BLOCKED: failed or stale verification gate')
        for name,expected in verified['evidenceHashes'].items():
            path=(gate.parent/name).resolve()
            if not path.is_relative_to(gate.parent.resolve()) or not path.is_file() or sha256(path)!=expected:
                raise SystemExit('RELEASE_BLOCKED: stale verification evidence '+name)
        summary.update(runtimeIntegrated=True,reviewPreviewReady=True,
            runtimeVerification='PASS — matching source/build and hash-bound continuation verification evidence',
            previewReleaseProduced=False,
            previewReleaseMeaning='No deployed preview release; qualified deployable resources and local runtime verification are complete.')
        write_json(EVIDENCE/'quality-report.json',summary)


if __name__=='__main__':main()
