"""Full deterministic, offline owner-review preparation. Never approves or activates."""
from collections import Counter, defaultdict
from contextlib import closing
import gzip
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import tempfile

import snapshot as op
from review_checks import answer_set, presentation_collisions, runtime_normalized

ROOT = Path(__file__).resolve().parents[4]
PACKAGE = ROOT / 'docs/king-of-english/corpus/production-review/packages/king-corpus-2026-10-05-v3'
OUTPUT = ROOT / 'docs/king-of-english/corpus/production-review'
EXPECTED = '695c39043dac52dddc95d5b7bd3b0ac012a7498f94067c3230ab112483bf4b4c'
SEED = 'king-production-review-20261005-v3'


def write(name, value):
    (OUTPUT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def load_rows():
    rows = []
    with tempfile.TemporaryDirectory(prefix='king-review-') as tmp:
        for spec in json.loads((PACKAGE / 'manifest.json').read_bytes())['shards']:
            path = Path(tmp) / spec['name']
            path.write_bytes(gzip.decompress((PACKAGE / spec['name']).read_bytes()))
            with closing(sqlite3.connect(path.as_uri() + '?mode=ro&immutable=1', uri=True)) as db:
                rows.extend(json.loads(body) for body, in db.execute('select body from content order by id'))
    return sorted(rows, key=lambda r: r['id'])


def text_fields(value, prefix='content'):
    if isinstance(value, str):
        yield prefix, value
    elif isinstance(value, dict):
        for key, child in value.items():
            yield from text_fields(child, prefix + '.' + key)
    elif isinstance(value, list):
        for i, child in enumerate(value):
            yield from text_fields(child, prefix + '.' + str(i))


def main():
    definition, _ = op.validate_package(PACKAGE, 'king-corpus-2026-10-05-v3', '3','king-snapshot-3')
    if op.sha(op.encode(definition)) != EXPECTED:
        raise SystemExit('KING_SNAPSHOT_CHANGED')
    retained = OUTPUT/'candidate-store'
    if (retained / (definition['snapshotId']+'.json')).read_bytes() != op.encode(definition):
        raise SystemExit('KING_SNAPSHOT_CHANGED')
    repairs=json.loads((PACKAGE/'corpus-repairs.json').read_bytes())
    rows = load_rows(); by = {r['id']: r for r in rows}
    collisions = presentation_collisions(rows)
    bad_ids = {i['id'] for g in collisions for i in g['items']}
    report = definition['report']
    warnings = Counter(w['code'] for w in report['warnings'])
    risks = defaultdict(set); risk_fields = defaultdict(list)
    buckets = defaultdict(list); answer_frequency = Counter()
    for r in rows:
        c = r['content']; mode = r['mode']
        answer = c.get('canonical', c.get('target', ''))
        answer_frequency[(mode, runtime_normalized(answer))] += 1
    for r in rows:
        c = r['content']; mode = r['mode']; item_id = r['id']
        answer = c.get('canonical', c.get('target', ''))
        size = len(answer.split()) if mode == 'REORDER' else len(answer)
        if mode == 'CONQUEST': size = c['qualityMetrics']['playableWords']
        length = 'SHORT' if size <= (8 if mode != 'REORDER' else 8) else 'MEDIUM' if size <= (15 if mode != 'REORDER' else 16) else 'LONG'
        freq = answer_frequency[(mode, runtime_normalized(answer))]
        pattern = 'RARE_ANSWER' if freq == 1 else 'REPEATED_ANSWER'
        category = c.get('pos', r['family'])
        dimensions = [('mode', mode), ('difficulty', str(c.get('difficulty', 'NOT_APPLICABLE'))),
                      ('category', category), ('length', length), ('answerPattern', pattern)]
        buckets['|'.join([mode, category, str(c.get('difficulty', 'NOT_APPLICABLE')), length, pattern])].append(item_id)
        for dim, value in dimensions: buckets[mode + ':' + dim + ':' + value].append(item_id)
        for field, text in text_fields(c):
            if '\ufffd' in text or re.search(r'(?:Ã.|Â[\u0080-\u00bf]|â[\u0080-\u00bf]|ï¿½)', text):
                risks['SUSPICIOUS_ENCODING_HEURISTIC'].add(item_id); risk_fields[item_id].append(field)
            if re.search(r'\b(?:TODO|FIXME|placeholder|lorem ipsum)\b', text, re.I):
                risks['PLACEHOLDER_WORD_HEURISTIC'].add(item_id); risk_fields[item_id].append(field)
        if mode == 'EXPLAIN':
            clues = c['progressiveClues']
            if len(op.normalized(clues[0]).split()) <= 4: risks['SHORT_INITIAL_CLUE'].add(item_id)
            fragments = [op.normalized(x) for x in clues[0].split(';')]
            if len(set(fragments)) < len(fragments): risks['REPEATED_INITIAL_CLAUSE'].add(item_id)
            if re.search(r'\b(?:law|computer science|chemistry|physics|biology|mathematics|finance|music)\b', '|'.join(clues), re.I):
                risks['TECHNICAL_CLUE_LANGUAGE'].add(item_id)
            if len(clues[-1]) >= 200: risks['LONG_FINAL_CLUE'].add(item_id)
            if c['target'] in ('thing', 'entity', 'object', 'act', 'being'): risks['GENERAL_TARGET'].add(item_id)
        if mode == 'REFLEX' and r['family'] == 'SPELLING_CORRECTION' and len(answer) <= 3:
            risks['SHORT_SPELLING_OPEN_ANSWER'].add(item_id)
        if mode == 'REORDER' and len(c['tokens']) <= 2: risks['TWO_CHUNK_REORDER'].add(item_id)
        if mode == 'CONQUEST':
            if c['rareWordDependence'] >= .25: risks['BOARD_RARE_WORD_SHARE_GE_25_PERCENT'].add(item_id)
            if c['qualityMetrics']['minCellCoverage'] <= 2: risks['BOARD_AT_MIN_CELL_COVERAGE_FLOOR'].add(item_id)
    clusters = []; cluster_categories = Counter()
    for number, cluster in enumerate(report['reviewRequired'], 1):
        pool = [by[i] for i in cluster['ids']]
        if cluster['mode'] == 'EXPLAIN':
            sets = [{op.normalized(r['content']['target']), *[op.normalized(a) for a in r['content']['acceptedAliases']]} for r in pool]
            category = 'EXPLAIN_EQUIVALENT_ACCEPTED_SET' if all(s == sets[0] for s in sets) else 'EXPLAIN_ACCEPTANCE_VARIANTS_REVIEW'
            if category.endswith('REVIEW'): risks[category].update(cluster['ids'])
        else:
            contents = {json.dumps(r['content'], sort_keys=True, ensure_ascii=False) for r in pool}
            presented = {json.dumps({k:r['content'].get(k) for k in ('prompt','context','tokens','options')}, sort_keys=True) for r in pool}
            category = 'REFLEX_EXACT_CONTENT_DUPLICATE' if len(contents) == 1 else 'REFLEX_SAME_PRESENTATION_SAME_ANSWER' if len(presented) == 1 and len({answer_set(r) for r in pool}) == 1 else 'REFLEX_CONTEXT_OR_METADATA_VARIANTS'
        cluster_categories[category] += 1
        clusters.append(dict(cluster=number, mode=cluster['mode'], category=category, ids=cluster['ids'],
                             risk='OBJECTIVE_ANSWER_COLLISION' if bad_ids.intersection(cluster['ids']) else 'VARIETY_OR_LANGUAGE_REVIEW',
                             sourceRefs={r['id']:r['sourceRefs'] for r in pool}))
        buckets['clusterCategory:' + category].extend(cluster['ids'])
    # Near duplicates: source token bags (Reorder), full accepted sets (Explain).
    # These are bounded deterministic signatures, not a claim of exhaustive semantic similarity.
    similar = defaultdict(list)
    for r in rows:
        c = r['content']
        if r['mode'] == 'REORDER': key = tuple(sorted(re.findall(r'[a-z]+', c['canonical'].lower())))
        elif r['mode'] == 'EXPLAIN': key = tuple(sorted({op.normalized(c['target']), *map(op.normalized,c['acceptedAliases'])}))
        else: continue
        similar[(r['mode'], key)].append(r['id'])
    near = [dict(mode=mode, ids=ids, method='TOKEN_BAG' if mode=='REORDER' else 'ACCEPTED_SET') for (mode,key),ids in sorted(similar.items()) if len(ids)>1]
    for group in near: buckets['nearSignature:' + group['mode']].extend(group['ids'])
    for warning in report['warnings']: buckets['warning:' + warning['code']].append(warning['id'])
    for code, ids in risks.items(): buckets['risk:' + code].extend(ids)
    reasons = defaultdict(set); strata = {}
    def rank(item_id): return hashlib.sha256((SEED + '|' + item_id).encode()).hexdigest()
    for bucket, ids in sorted(buckets.items()):
        population = sorted(set(ids)); selected = sorted(population, key=rank)[:2]
        strata[bucket] = dict(population=len(population), sampleIds=selected)
        for item_id in selected: reasons[item_id].add(bucket)
    random_ids = {}
    for mode in op.MODES:
        selected = sorted([r['id'] for r in rows if r['mode']==mode], key=rank)[:20]
        random_ids[mode] = selected
        for item_id in selected: reasons[item_id].add('deterministicRandom:' + mode)
    for item_id in bad_ids: reasons[item_id].add('BLOCKING_COLLISION')
    for group in repairs['decisions']:
        for item in group['oldItems']: reasons[item['id']].add('ALL_ORIGINAL_COLLISION_REPAIRS')
    for warning in report['warnings']:
        if warning['code']=='DUPLICATE_TOKEN_IDENTITIES': reasons[warning['id']].add('ALL_DUPLICATE_TOKEN_CASES')
    boards = [r for r in rows if r['mode']=='CONQUEST']
    board_ranges = {key:dict(min=min(r['content']['qualityMetrics'][key] for r in boards),max=max(r['content']['qualityMetrics'][key] for r in boards)) for key in ('playableWords','shortWords','longWords','throneWords','minCellCoverage')}
    OUTPUT.mkdir(parents=True, exist_ok=True)
    write('review-samples.json',dict(snapshotId=definition['snapshotId'], fingerprint=EXPECTED, seed=SEED,
          selectionMethod='SHA256(seed|item ID); lowest two per occupied stratum, 20 random per mode, all blockers and duplicate-token cases',
          strata=strata, randomSamples=random_ids, samples=[dict(id=i, mode=by[i]['mode'], family=by[i]['family'],
          reasons=sorted(reasons[i]), content=by[i]['content'], sourceRefs=by[i]['sourceRefs']) for i in sorted(reasons)]))
    write('review-findings.json',dict(fingerprint=EXPECTED, blockingGroups=collisions, blockingIds=sorted(bad_ids),
          originalCollisionRepairs=repairs['decisions'],metadataCorrections=repairs['metadataCorrections'],
          baselineBlockingFindings=report['findings'], warningCategories={k:dict(count=n,ids=[w['id'] for w in report['warnings'] if w['code']==k]) for k,n in sorted(warnings.items())},
          reviewClusters=clusters, nearSignatureClusters=near,
          highRiskOutliers={k:dict(count=len(ids),ids=sorted(ids),severity='HUMAN_REVIEW_EVIDENCE_ONLY') for k,ids in sorted(risks.items())},
          fieldEvidence=dict(risk_fields)))
    summary = dict(snapshotId=definition['snapshotId'], version=definition['version'], fingerprint=EXPECTED,
          status='FINAL_CANDIDATE_LOCAL_VERIFICATION', validatorVersion=definition['validatorVersion'], exactFingerprintRevalidated=True, coverage=report['coverage'],
          baselineCounts=report['counts'], baselineBlocking=0, baselineQuarantined=0, warnings=len(report['warnings']),
          warningCategories=dict(warnings), reviewClusters=len(clusters), clusterCategories=dict(cluster_categories),
          objectiveBlockingGroups=len(collisions), objectiveBlockingItems=len(bad_ids), collisionFamilies=dict(Counter(g['family'] for g in collisions)),
          proposedQuarantineIds=sorted(bad_ids), highRiskOutlierCounts={k:len(v) for k,v in sorted(risks.items())},
          nearSignatureGroups=dict(Counter(x['mode'] for x in near)), samples=len(reasons), occupiedStrata=len(strata),
          distributions=report['distributions'], boardMetricRanges=board_ranges,
          sourceVersions=definition['sourceVersions'], artifactHashes=definition['artifacts'],
          artifactHashesUnchanged=False, productionApproval='NOT REQUESTED; READINESS IN PROGRESS',
          productionActivation='NOT RUN', evidencePaths=['review-findings.json','review-samples.json'],
          limits=['No NLP or human linguistic perfection claim','Checksum-locked OEWN raw XML replayed for all relation/Explain senses; other upstream sources not replayed in this phase',
                  'No production operation or credential access','Near signatures are not exhaustive fuzzy matching',
                  'Conquest has no actual difficulty bands; all 150 boards and 10023 lexicon keys retained'])
    candidate_store = OUTPUT / 'candidate-store'
    if (candidate_store / 'state.json').exists():
        ledger = op.state(candidate_store)
        record, candidate = op.verify(candidate_store, 'king-corpus-2026-10-05-v2', ledger)
        excluded = {f['id'] for f in candidate['report']['findings']}
        if len(excluded)!=25 or record['approval'] is not None or ledger['active'] is not None:
            raise SystemExit('CANDIDATE_ELIGIBILITY_OR_STATE_MISMATCH')
        summary['intermediateV2'] = dict(snapshotId=candidate['snapshotId'], version=candidate['version'],
            fingerprint=record['fingerprint'], validatorVersion=candidate['validatorVersion'],
            counts=candidate['report']['counts'], quarantined=len(excluded),
            blockingFindings=len(candidate['report']['findings']), warnings=len(candidate['report']['warnings']),
            reviewClusters=candidate['report']['duplicateClusters'], approval=None, active=None,
            status='INTERMEDIATE_UNAPPROVED; NOT PRODUCTION_CANDIDATE')
    summary['rejectedV1']=dict(snapshotId='king-corpus-2026-10-05-v1', fingerprint='2fa26f0750751501bebbb38b495583006d334f3b7398ea324fb9e3074df7398e',status='REJECTED_FOR_PRODUCTION')
    summary['originalCollisionItemsRepaired']=repairs['repairedCollisionItems']
    summary['sourceMetadataCorrections']=len(repairs['metadataCorrections'])
    write('review-summary.json',summary)
    print(json.dumps({k:summary[k] for k in ('status','objectiveBlockingGroups','objectiveBlockingItems','clusterCategories','highRiskOutlierCounts','samples','occupiedStrata')},indent=2))


if __name__ == '__main__': main()
