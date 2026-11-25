"""Offline King release operations. No network, application DB, or startup approval.

The operator controls this directory (like deployment configuration). Decisions are
attestations, not cryptographic authentication. Never place LOCAL_TEST state in a
production store. Snapshot bytes and all licensed artifact bytes are hash-bound.
"""
import argparse
from collections import Counter, defaultdict
from contextlib import contextmanager, closing
from datetime import datetime, timezone
import gzip
import hashlib
import itertools
import json
import os
from pathlib import Path
import re
import sqlite3
import tempfile
import unicodedata

from derive import fingerprint, FAMILIES
from quality import validate_record
from build_boards import trie, solve, metrics, symmetry
from qualify import leaks
from review_checks import presentation_collisions

VALIDATOR = 'king-snapshot-1'
SUPPORTED_VALIDATORS = (VALIDATOR, 'king-snapshot-2', 'king-snapshot-3')
MODES = ('REFLEX', 'EXPLAIN', 'REORDER', 'CONQUEST')


def encode(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))+'\n').encode('utf-8')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def normalized(text):
    return re.sub(r'\s+', ' ', re.sub(r'[.,!?]', '', unicodedata.normalize('NFKC', text).strip().lower()))


def malformed(value):
    if isinstance(value, str):
        return any(unicodedata.category(c) in {'Cs', 'Cc'} and c not in '\n\r\t' or c == '\ufffd' for c in value)
    if isinstance(value, dict):
        return any(malformed(k) or malformed(v) for k, v in value.items())
    return isinstance(value, list) and any(malformed(v) for v in value)


def validate_item(row, sources, lock_hash, lexicon, root):
    """Runtime correctness only. Linguistic naturalness remains human sampling."""
    errors = []
    warnings = []
    try:
        errors.extend(validate_record(row, sources, lock_hash))
        if malformed(row): errors.append('MALFORMED_UNICODE')
        if not re.fullmatch(r'kc-(reflex|explain|reorder|conquest)-[a-f0-9]{24}', row['id']): errors.append('INVALID_ID')
        if not re.fullmatch('[a-f0-9]{64}', row['semanticHash']): errors.append('INVALID_SEMANTIC_HASH')
        if row['mode'] not in MODES or not row['id'].startswith('kc-'+row['mode'].lower()+'-'): errors.append('INVALID_MODE')
        if row['confidence'] != 'HIGH_CONFIDENCE_SOURCE_BACKED': errors.append('UNQUALIFIED_CONTENT')
        for link in row.get('semanticLinks', []):
            field = {'PHRASE_EXACT':'phraseId','EXACT_SENSE':'senseId','LEXEME_ONLY':'lexemeId','UNKNOWN':None}.get(link.get('confidence'), 'INVALID')
            if field == 'INVALID' or field and not link.get(field): errors.append('INVALID_LINK')
        c = row['content']; mode = row['mode']; family = row['family']
        if mode != 'CONQUEST':
            if type(c.get('difficulty')) is not int or not 1 <= c['difficulty'] <= 5: errors.append('INVALID_DIFFICULTY')
            if c.get('cefr') not in ('A1','A2','B1','B2','C1','C2','UNKNOWN'): errors.append('INVALID_CEFR')
            if c.get('cefr') == 'UNKNOWN': warnings.append('CEFR_UNKNOWN_REVIEW_SAMPLING')
            if not isinstance(c.get('meaning'), str) or not c['meaning'].strip(): errors.append('MISSING_MEANING')
        if mode in ('REORDER', 'REFLEX'):
            answer = c['canonical']; accepted = c.get('accepted', []); prompt = c['prompt']
            if not isinstance(answer, str) or not normalized(answer): errors.append('EMPTY_ANSWER')
            if not isinstance(prompt, str) or not prompt.strip(): errors.append('EMPTY_PROMPT')
            if not isinstance(accepted, list) or any(not isinstance(a, str) or not normalized(a) for a in accepted): errors.append('INVALID_ACCEPTED')
            answers = [normalized(answer)] + [normalized(a) for a in accepted]
            if len(set(answers)) != len(answers): warnings.append('REDUNDANT_ACCEPTED_ANSWER')
            tokens = c.get('tokens', [])
            if not isinstance(tokens, list) or any(not isinstance(t,str) or not t.strip() for t in tokens): errors.append('INVALID_TOKENS')
            if mode == 'REORDER':
                if not 2 <= len(tokens) <= 24: errors.append('INVALID_TOKEN_COUNT')
                # Chunk boundaries are indivisible at runtime. A word multiset alone is insufficient.
                n = len(tokens)
                for a in [answer]+accepted:
                    words = normalized(a).split(); chunks = [normalized(t).split() for t in tokens]
                    def reconstruct(at, used):
                        if at == len(words): return len(used) == n
                        return any(reconstruct(at+len(t), used|{i}) for i,t in enumerate(chunks)
                                   if i not in used and words[at:at+len(t)] == t)
                    if not reconstruct(0,set()): errors.append('IMPOSSIBLE_RECONSTRUCTION'); break
                if len(set(tokens)) != len(tokens): warnings.append('DUPLICATE_TOKEN_IDENTITIES')
            else:
                if family not in FAMILIES: errors.append('INVALID_FAMILY')
                if family == 'LETTER_SCRAMBLE' and (Counter(''.join(tokens)) != Counter(answer) or len(tokens)<2): errors.append('BROKEN_SCRAMBLE')
                if family == 'MISSING_LETTER' and (type(c.get('missingIndex')) is not int or not 0 <= c['missingIndex'] < len(prompt) or prompt[c['missingIndex']] != '_' or len(answer)!=1): errors.append('INVALID_MISSING_LETTER')
                if family == 'SPELLING_CORRECTION' and normalized(prompt)==normalized(answer): errors.append('IDENTICAL_SPELLING')
                if c.get('options'):
                    options = [normalized(o) for o in c['options']]
                    if len(options)<2 or len(set(options))!=len(options) or normalized(answer) not in options: errors.append('INVALID_OPTIONS')
                if family == 'SPELLING_CHOICE' and not c.get('options'): errors.append('MISSING_OPTIONS')
                if family in ('SYNONYM','ANTONYM') and answer not in c.get('relationSet',[]): errors.append('INVALID_RELATION')
                if family == 'PART_OF_SPEECH':
                    context=c.get('context',''); start=c.get('occurrenceStart'); end=c.get('occurrenceEnd')
                    if answer not in ('noun','verb','adjective','adverb','pronoun','preposition','conjunction','determiner','interjection') or type(start)!=int or type(end)!=int or not 0<=start<end<=len(context): errors.append('INVALID_POS_OCCURRENCE')
                if family in ('COLLOCATION','PHRASAL_VERB','IDIOM_FRAGMENT','FIXED_EXPRESSION') and not c.get('expression'): errors.append('MISSING_EXPRESSION')
        elif mode == 'EXPLAIN':
            target=c['target']; aliases=c['acceptedAliases']; clues=c['progressiveClues']
            if not re.fullmatch(r"[a-z]+(?:[ '-][a-z]+)*",target): errors.append('INVALID_TARGET')
            if any(not isinstance(a,str) or not normalized(a) for a in aliases): errors.append('INVALID_ALIAS')
            if len(set(map(normalized,aliases)))!=len(aliases) or normalized(target) in map(normalized,aliases): warnings.append('REDUNDANT_ALIAS')
            if len(clues)!=3 or any(not isinstance(clue,str) or not clue.strip() or len(clue)>400 or leaks(clue,[target]+aliases+c['forbiddenForms']) for clue in clues): errors.append('INVALID_CLUES')
            if c['pos'] not in ('noun','verb','adjective','adverb'): errors.append('INVALID_POS')
        elif mode == 'CONQUEST':
            letters=c['letters']
            if len(letters)!=25 or any(not re.fullmatch('[A-Z]',l) for l in letters): errors.append('INVALID_BOARD'); return errors,warnings
            paths=solve(letters,root); q=metrics(paths)
            if q != c['qualityMetrics']: errors.append('BOARD_METRICS_MISMATCH')
            if q['playableWords']<50 or q['shortWords']<20 or q['longWords']<8 or q['throneWords']<8 or q['minCellCoverage']<2: errors.append('DEAD_BOARD')
            candidates=c['echoCandidates']
            if not 24<=len(candidates)<=32 or len({x['word'] for x in candidates})!=len(candidates): errors.append('INVALID_ECHO_CANDIDATES')
            for x in candidates:
                path=x['path']; word=x['word']
                if word not in lexicon or not 3<=len(word)<=8 or len(path)!=len(word) or len(set(path))!=len(path) or any(type(i)!=int or not 0<=i<25 for i in path) or any(max(abs(a//5-b//5),abs(a%5-b%5))!=1 for a,b in zip(path,path[1:])) or ''.join(letters[i].lower() for i in path)!=word: errors.append('INVALID_WORD_PATH')
    except (KeyError, TypeError, ValueError, AttributeError, IndexError, RecursionError):
        errors.append('INVALID_SCHEMA')
    return sorted(set(errors)), sorted(set(warnings))


def validate_package(package, snapshot_id, version, validator_version=VALIDATOR):
    if validator_version not in SUPPORTED_VALIDATORS:
        raise ValueError('UNSUPPORTED_VALIDATOR_VERSION')
    package=Path(package).resolve()
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}',snapshot_id) or not version: raise ValueError('INVALID_SNAPSHOT_ID_VERSION')
    manifest=json.loads((package/'manifest.json').read_bytes()); lock_bytes=(package/'sources.lock.json').read_bytes()
    lock_hash=sha(lock_bytes); lock=json.loads(lock_bytes); sources={s['id']:s for s in lock['sources']}
    if manifest['sourceLockSha256']!=lock_hash or manifest['schemaVersion']!=1 or manifest['buildVersion']!='king-qualified-2': raise ValueError('INCOMPATIBLE_PACKAGE')
    if manifest['humanApproved']!=0 or manifest['productionActive']!=0: raise ValueError('ITEM_APPROVAL_NOT_SNAPSHOT_APPROVAL')
    files={'manifest.json':sha((package/'manifest.json').read_bytes()),'sources.lock.json':lock_hash,'ATTRIBUTION.md':sha((package/'ATTRIBUTION.md').read_bytes())}
    repairs = None
    if validator_version == 'king-snapshot-3' and (package/'corpus-repairs.json').exists():
        repair_bytes=(package/'corpus-repairs.json').read_bytes()
        files['corpus-repairs.json']=sha(repair_bytes)
        repairs=json.loads(repair_bytes)
        if repairs.get('schemaVersion')!=1 or repairs.get('repairVersion')!='king-source-repair-1' or repairs.get('sourceSha256')!=sources['oewn']['sha256']:
            raise ValueError('INVALID_REPAIR_SOURCE_CLOSURE')
    # Exact notices from source lock, plus the bundled upstream WordNet notice.
    for name in sorted({Path(s['licenseEvidenceFile']).name for s in lock['sources'] if s['runtimeEligible'] and not s['validationOnly']}|{'Princeton-WordNet.txt'}):
        path=package/'licenses'/name
        if path.exists(): files['licenses/'+name]=sha(path.read_bytes())
    rows=[]; lexicon=[]; logical=hashlib.sha256(); metadata_errors={}
    with tempfile.TemporaryDirectory(prefix='king-validate-') as tmp:
        for spec in manifest['shards']:
            name=spec['name']
            if name not in ('king-core.sqlite.gz','king-phrases-cc-by-sa.sqlite.gz'): raise ValueError('INVALID_SHARD')
            compressed=(package/name).read_bytes(); files[name]=sha(compressed)
            if files[name]!=spec['sha256']: raise ValueError('SHARD_HASH_MISMATCH')
            p=Path(tmp)/(name+'.sqlite'); p.write_bytes(gzip.decompress(compressed))
            with closing(sqlite3.connect(p.as_uri()+'?mode=ro&immutable=1',uri=True)) as db:
                meta=dict(db.execute('select key,value from manifest'))
                if meta.get('schemaVersion')!='1' or meta.get('buildVersion')!='king-qualified-2' or meta.get('sourceLockSha256')!=lock_hash or meta.get('licenseClass')!=('CC-BY-SA-4.0' if spec['shareAlike'] else 'ATTRIBUTED_CORE'): raise ValueError('SHARD_METADATA_MISMATCH')
                h=hashlib.sha256(); shard_rows=0
                for item_id,mode,family,difficulty,cefr,semantic,links,body in db.execute('select id,mode,family,difficulty,cefr,semantic_hash,links,body from content order by id'):
                    data=(body+'\n').encode(); h.update(data); logical.update(data); shard_rows+=1
                    try:
                        r=json.loads(body)
                        c=r['content']
                        if (item_id,mode,family,difficulty,cefr,semantic)!=(r['id'],r['mode'],r['family'],c.get('difficulty',3),c.get('cefr','UNKNOWN'),r['semanticHash']) or json.loads(links)!=r.get('semanticLinks',[]) or ('CC-BY-SA-4.0' in r['licenseRefs'])!=spec['shareAlike']: metadata_errors[item_id]='INDEX_BODY_MISMATCH'
                        rows.append(r)
                    except (ValueError,KeyError,TypeError): rows.append({'id':item_id,'mode':mode}); metadata_errors[item_id]='INVALID_SERIALIZATION'
                for word, in db.execute('select word from lexicon order by word'):
                    lexicon.append(word); data=(word+'\n').encode(); h.update(data); logical.update(data)
                if h.hexdigest()!=spec['contentSha256'] or meta.get('contentSha256')!=h.hexdigest() or shard_rows!=spec['records']: raise ValueError('LOGICAL_HASH_COUNT_MISMATCH')
    if logical.hexdigest()!=manifest['contentBuildSha256']: raise ValueError('BUILD_HASH_MISMATCH')
    if dict(Counter(r['mode'] for r in rows))!=manifest['counts'] or len(lexicon)!=manifest['lexiconCount']: raise ValueError('PACKAGE_COUNT_MISMATCH')
    for r in rows:
        for ref in r.get('sourceRefs',[]):
            source=sources.get(ref.get('source'))
            if source:
                notice='licenses/'+Path(source['licenseEvidenceFile']).name
                if files.get(notice)!=source['licenseSha256']: raise ValueError('LICENSE_NOTICE_MISSING_OR_CHANGED')
    collision_ids = {item['id'] for group in presentation_collisions(rows) for item in group['items']} if validator_version in ('king-snapshot-2','king-snapshot-3') else set()
    if repairs:
        from review_checks import answer_set
        by={r['id']:r for r in rows}
        for group in repairs['decisions']:
            for previous in group['oldItems']:
                row=by[previous['id']]
                if sorted(answer_set(row))!=group['newAccepted'] or row.get('repair',{}).get('groupId')!=group['groupId']:
                    raise ValueError('REPAIR_ACCEPTED_SET_MISMATCH')
        for correction in repairs['metadataCorrections']:
            if by[correction['id']]['content'].get(correction['field'])!=correction['new']:
                raise ValueError('REPAIR_METADATA_MISMATCH')
    duplicate_ids={i for i,n in Counter(r['id'] for r in rows).items() if n>1}
    valid_words=[]; findings=[]; word_counts=Counter(lexicon)
    for word in sorted(set(lexicon)):
        if not re.fullmatch('[a-z]{3,8}',word) or word_counts[word]>1:
            findings.append(dict(id=word,mode='LEXICON',severity='BLOCKING',code='INVALID_LEXICON_KEY',validator=VALIDATOR))
        else: valid_words.append(word)
    word_set=set(valid_words); root=trie(word_set); eligible=defaultdict(list); stats={}; seen={}; signatures=defaultdict(list); samples=defaultdict(list)
    warnings=[]; review=[]; outliers=[]; distributions=defaultdict(Counter)
    for mode in MODES: stats[mode]=dict(total=0,valid=0,quarantined=0,warnings=0)
    for r in sorted(rows,key=lambda x:(x['id'],x['mode'])):
        item_id=r['id']; mode=r['mode']; stats.setdefault(mode,dict(total=0,valid=0,quarantined=0,warnings=0)); stats[mode]['total']+=1
        errors,ws=validate_item(r,sources,lock_hash,word_set,root)
        if validator_version == 'king-snapshot-3':
            if mode=='REFLEX' and r.get('family') in ('ANTONYM','SYNONYM','WORD_FAMILY'):
                if not set([c for c in [r.get('content',{}).get('canonical')]+r.get('content',{}).get('accepted',[])]) <= set(r.get('content',{}).get('relationSet',[])):
                    errors.append('ACCEPTED_RELATION_CLOSURE_MISMATCH')
            if mode=='EXPLAIN':
                c3=r.get('content',{})
                if not set(c3.get('acceptedAliases',[])) <= set(c3.get('forbiddenForms',[])):
                    errors.append('ALIAS_FORBIDDEN_CLOSURE_MISMATCH')
        if item_id in duplicate_ids: errors.append('DUPLICATE_ID')
        if item_id in metadata_errors: errors.append(metadata_errors[item_id])
        if item_id in collision_ids: errors.append('IDENTICAL_PRESENTATION_DIFFERENT_ACCEPTED_ANSWERS')
        semantic=r.get('semanticHash'); c=r.get('content',{})
        # Identical semantic truth is invalid; repeated answers / similar templates need review, not exclusion.
        if semantic and semantic in seen: errors.append('SEMANTIC_DUPLICATE')
        if semantic: seen[semantic]=item_id
        if errors: key=item_id
        elif mode=='CONQUEST' and 'letters' in c:
            key=symmetry(c['letters']) if len(c['letters'])==25 else item_id
        elif mode=='EXPLAIN': key=normalized('|'.join(c.get('progressiveClues',[])))
        else: key=normalized(c.get('prompt',''))+'|'+normalized(c.get('canonical',''))
        signatures[(mode,key)].append(item_id)
        if errors:
            stats[mode]['quarantined']+=1
            findings.extend(dict(id=item_id,mode=mode,severity='BLOCKING',code=code,validator=VALIDATOR) for code in sorted(set(errors)))
        else:
            stats[mode]['valid']+=1; eligible[mode].append(item_id)
            distributions[mode+':difficulty'][str(c.get('difficulty',3))]+=1
            distributions[mode+':cefr'][c.get('cefr','UNKNOWN')]+=1
            distributions[mode+':category'][c.get('pos',r.get('family','UNKNOWN'))]+=1
            bucket=mode+':'+c.get('pos',r.get('family','UNKNOWN'))
            samples[bucket].append(r)
        stats[mode]['warnings']+=len(ws)
        warnings.extend(dict(id=item_id,mode=mode,severity='WARNING',code=w,validator=VALIDATOR) for w in ws)
    for (mode,key),ids in sorted(signatures.items()):
        if len(ids)>1: review.append(dict(mode=mode,ids=ids,code='NORMALIZED_CONTENT_CLUSTER',severity='REVIEW_REQUIRED'))
    sample=[]
    for bucket,pool in sorted(samples.items()):
        sample.extend(sorted(pool,key=lambda r:sha((VALIDATOR+'|'+r['id']).encode()))[:20])
    stats['LEXICON']=dict(total=len(lexicon),valid=len(valid_words),quarantined=len(lexicon)-len(valid_words),warnings=0)
    report=dict(validatorVersion=VALIDATOR,coverage=sum(v['total'] for v in stats.values()),counts=stats,findings=findings,warnings=warnings,reviewRequired=review,
                samplingRequired=['Linguistic naturalness','Clue discrimination and ambiguity','Estimated difficulty','Topic suitability'],
                outliers=outliers,distributions={k:dict(v) for k,v in sorted(distributions.items())},duplicateClusters=len(review),sampleIds=[r['id'] for r in sample])
    if validator_version != VALIDATOR:
        report['validatorVersion'] = validator_version
        for finding in findings + warnings:
            finding['validator'] = validator_version
    definition=dict(schemaVersion=1,snapshotId=snapshot_id,version=version,validatorVersion=validator_version,validationResult='AUTO_VALIDATED',
                    artifacts=files,sourceVersions={s['id']:s['version'] for s in lock['sources']},contentBuildSha256=manifest['contentBuildSha256'],
                    eligibleIds={mode:eligible[mode] for mode in MODES},eligibleLexicon=valid_words,report=report)
    return definition,sample


@contextmanager
def locked(store):
    store=Path(store); store.mkdir(parents=True,exist_ok=True); lock=store/'operator.lock'
    fd=os.open(lock,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
    try: yield store
    finally: os.close(fd); lock.unlink()


def atomic(path,value):
    path=Path(path); data=encode(value)
    with tempfile.NamedTemporaryFile(dir=path.parent,delete=False) as f:
        temp=Path(f.name); f.write(data); f.flush(); os.fsync(f.fileno())
    try: os.replace(temp,path)
    finally: temp.unlink(missing_ok=True)


def state(store):
    p=Path(store)/'state.json'
    return json.loads(p.read_bytes()) if p.exists() else dict(schemaVersion=1,snapshots={},active=None,events=[])


def now(): return datetime.now(timezone.utc).isoformat()


def create(store,package,snapshot_id,version,validator_version=VALIDATOR,portable_package=False):
    definition,sample=validate_package(package,snapshot_id,version) if validator_version == VALIDATOR else validate_package(package,snapshot_id,version,validator_version)
    data=encode(definition); digest=sha(data)
    with locked(store) as store:
        s=state(store)
        if snapshot_id in s['snapshots']: raise ValueError('IMMUTABLE_SNAPSHOT_ALREADY_EXISTS')
        p=store/(snapshot_id+'.json')
        if p.exists(): raise ValueError('IMMUTABLE_SNAPSHOT_FILE_EXISTS')
        p.write_bytes(data)
        package_path=os.path.relpath(Path(package).resolve(),store.resolve()) if portable_package else str(Path(package).resolve())
        s['snapshots'][snapshot_id]=dict(fingerprint=digest,package=package_path,createdAt=now(),reviewStatus='HUMAN_REVIEW_PENDING',approval=None)
        s['events'].append(dict(operation='VALIDATE',snapshotId=snapshot_id,fingerprint=digest,at=now()))
        atomic(store/'state.json',s)
        atomic(store/(snapshot_id+'.review.json'),dict(snapshotId=snapshot_id,fingerprint=digest,report=definition['report'],sample=sample))
    return digest


def verify(store,snapshot_id,s):
    record=s['snapshots'][snapshot_id]; p=Path(store)/(snapshot_id+'.json'); data=p.read_bytes()
    if sha(data)!=record['fingerprint']: raise ValueError('STALE_SNAPSHOT_FINGERPRINT')
    definition=json.loads(data)
    validator=definition['validatorVersion']
    package=Path(store)/record['package']
    expected,_=validate_package(package,snapshot_id,definition['version']) if validator == VALIDATOR else validate_package(package,snapshot_id,definition['version'],validator)
    if encode(expected)!=data: raise ValueError('CHANGED_CONTENT_OR_VALIDATION')
    return record,definition


def decide(store,snapshot_id,fingerprint_value,reviewer,target,decision,acknowledge):
    if target not in ('LOCAL_TEST','PRODUCTION') or decision not in ('APPROVE','REJECT') or not reviewer.strip() or not acknowledge: raise ValueError('EXPLICIT_REVIEW_ATTESTATION_REQUIRED')
    with locked(store) as store:
        s=state(store); record,definition=verify(store,snapshot_id,s)
        if target=='PRODUCTION' and definition['validatorVersion']!='king-snapshot-3': raise ValueError('PRODUCTION_REQUIRES_REPAIRED_VALIDATOR')
        if record['fingerprint']!=fingerprint_value: raise ValueError('EXACT_FINGERPRINT_REQUIRED')
        if record['approval'] is not None or record['reviewStatus']=='REJECTED': raise ValueError('DECISION_ALREADY_RECORDED')
        record['reviewStatus']='HUMAN_APPROVED' if decision=='APPROVE' else 'REJECTED'
        record['approval']=dict(fingerprint=fingerprint_value,reviewer=reviewer,decision=decision,target=target,at=now(),acknowledgedReview=True,
                                kind='LOCAL_OWNER_TEST' if target=='LOCAL_TEST' else 'HUMAN_PACKAGE_REVIEW')
        if definition['validatorVersion']=='king-snapshot-3':
            record['approval'].update(snapshotId=snapshot_id,validatorVersion=definition['validatorVersion'],packageHashes=definition['artifacts'])
        s['events'].append(dict(operation=decision,snapshotId=snapshot_id,fingerprint=fingerprint_value,target=target,at=now()))
        atomic(store/'state.json',s)


def activate(store,snapshot_id,fingerprint_value,target,rollback=False):
    with locked(store) as store:
        s=state(store); record,definition=verify(store,snapshot_id,s); approval=record.get('approval')
        if target=='PRODUCTION' and definition['validatorVersion']!='king-snapshot-3': raise ValueError('PRODUCTION_REQUIRES_REPAIRED_VALIDATOR')
        if record['fingerprint']!=fingerprint_value or record['reviewStatus']!='HUMAN_APPROVED' or not approval or approval['decision']!='APPROVE' or approval['fingerprint']!=fingerprint_value or approval['target']!=target: raise ValueError('EXACT_APPROVED_SNAPSHOT_REQUIRED')
        if definition['validatorVersion']=='king-snapshot-3' and (approval.get('snapshotId')!=snapshot_id or approval.get('validatorVersion')!=definition['validatorVersion'] or approval.get('packageHashes')!=definition['artifacts']): raise ValueError('EXACT_PACKAGE_APPROVAL_REQUIRED')
        if rollback and not any(e['operation']=='ACTIVATE' and e.get('snapshotId')==snapshot_id and e.get('target')==target for e in s['events']): raise ValueError('NOT_PREVIOUSLY_ACTIVE')
        previous=s['active']
        s['active']=dict(snapshotId=snapshot_id,fingerprint=fingerprint_value,target=target,activatedAt=now(),previous=previous['snapshotId'] if previous else None,
                         status='LOCAL_TEST_ACTIVE' if target=='LOCAL_TEST' else 'PRODUCTION_ACTIVE')
        s['events'].append(dict(operation='ROLLBACK' if rollback else 'ACTIVATE',**s['active']))
        atomic(store/'state.json',s)


def deactivate(store):
    with locked(store) as store:
        s=state(store); s['events'].append(dict(operation='DEACTIVATE',previous=s['active'],at=now())); s['active']=None; atomic(store/'state.json',s)


def main():
    p=argparse.ArgumentParser(description=__doc__); p.add_argument('--store',required=True)
    sub=p.add_subparsers(dest='command',required=True)
    v=sub.add_parser('validate'); v.add_argument('--package',required=True); v.add_argument('--id',required=True); v.add_argument('--version',required=True)
    v.add_argument('--validator-version', choices=SUPPORTED_VALIDATORS, default=VALIDATOR)
    v.add_argument('--portable-package',action='store_true',help='Store the package path relative to the ledger (same host/container layout).')
    for command in ('approve','reject','activate','rollback'):
        c=sub.add_parser(command); c.add_argument('--id',required=True); c.add_argument('--fingerprint',required=True); c.add_argument('--target',choices=['LOCAL_TEST','PRODUCTION'],required=True)
        if command in ('approve','reject'): c.add_argument('--reviewer',required=True); c.add_argument('--acknowledge-review',action='store_true',required=True)
    sub.add_parser('inspect'); sub.add_parser('deactivate'); args=p.parse_args()
    if args.command=='validate': print(create(args.store,args.package,args.id,args.version,args.validator_version,args.portable_package))
    elif args.command in ('approve','reject'): decide(args.store,args.id,args.fingerprint,args.reviewer,args.target,'APPROVE' if args.command=='approve' else 'REJECT',args.acknowledge_review)
    elif args.command in ('activate','rollback'): activate(args.store,args.id,args.fingerprint,args.target,args.command=='rollback')
    elif args.command=='deactivate': deactivate(args.store)
    else: print(json.dumps(state(args.store),indent=2))


if __name__=='__main__': main()
