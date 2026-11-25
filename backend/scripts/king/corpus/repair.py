"""Create an immutable source-proven successor; never alter the input package.

The locked OEWN XML is evidence, not a runtime dependency. Every accepted union
requires exact named-sense proof. No linguistic inference or model is used.
"""
import argparse
from contextlib import closing
import copy
import gzip
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import tempfile
import xml.etree.ElementTree as ET

from derive import fingerprint
from review_checks import presentation_collisions, answer_set
from sources import sha256


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'))


def source_facts(raw, wanted):
    senses = {}; concepts = {}
    with gzip.open(raw, 'rb') as stream:
        for _, element in ET.iterparse(stream, events=('end',)):
            if element.tag == 'LexicalEntry':
                lemma = element.find('Lemma')
                for sense in element.findall('Sense'):
                    if sense.get('id') in wanted:
                        senses[sense.get('id')] = dict(lemma=lemma.get('writtenForm'),
                            pos=lemma.get('partOfSpeech'), concept=sense.get('synset'),
                            relations=[dict(x.attrib) for x in sense.findall('SenseRelation')],
                            forms=[x.get('writtenForm') for x in element.findall('Form')])
                element.clear()
            elif element.tag == 'Synset':
                concepts[element.get('id')] = element.findtext('Definition')
                element.clear()
    if wanted - senses.keys():
        raise ValueError('SOURCE_SENSE_CLOSURE_MISSING')
    for sense in senses.values():
        sense['definition'] = concepts[sense['concept']]
    return senses


def repair_rows(rows, facts):
    """Each collision is decided independently against checksum-verified facts."""
    by = {r['id']: r for r in rows}; decisions = []; metadata = []
    for n, group in enumerate(presentation_collisions(rows), 1):
        pool = [by[i['id']] for i in group['items']]
        union = sorted(set().union(*(answer_set(r) for r in pool)))
        evidence = {}
        if group['mode'] == 'EXPLAIN':
            selected = [facts[r['content']['senseId']] for r in pool]
            if len({s['concept'] for s in selected}) != 1:
                raise ValueError('EXPLAIN_UNION_REQUIRES_SAME_SOURCE_CONCEPT')
            for r, s in zip(pool, selected):
                if s['lemma'] != r['content']['target'] or s['definition'] != r['content']['meaning']:
                    raise ValueError('EXPLAIN_SOURCE_MISMATCH')
                evidence[r['content']['senseId']] = s
            if set(union) != {s['lemma'] for s in selected}:
                raise ValueError('UNPROVEN_ALIAS')
        elif group['family'] in ('ANTONYM', 'WORD_FAMILY'):
            source_ids = {r['content']['senseId'] for r in pool}
            if len(source_ids) != 1: raise ValueError('UNION_REQUIRES_IDENTICAL_SOURCE_SENSE')
            source_id = next(iter(source_ids)); source = facts[source_id]
            typ = 'antonym' if group['family'] == 'ANTONYM' else 'derivation'
            evidence[source_id] = source
            for r in pool:
                c = r['content']; target_id = c['targetSenseId']; target = facts[target_id]
                if not any(x['relType'] == typ and x['target'] == target_id for x in source['relations']):
                    raise ValueError('UNPROVEN_NAMED_RELATION')
                if target['lemma'] != c['canonical']: raise ValueError('SOURCE_TARGET_MISMATCH')
                if group['family'] == 'WORD_FAMILY':
                    if target['definition'] != c['context'] or target['pos'] != 'n':
                        raise ValueError('WORD_FAMILY_VISIBLE_MEANING_MISMATCH')
                elif source['definition'] != c['context']:
                    raise ValueError('ANTONYM_VISIBLE_SENSE_MISMATCH')
                evidence[target_id] = target
        else:
            raise ValueError('NO_SOURCE_PROVEN_REPAIR_STRATEGY')
        decisions.append(dict(groupId=f'original-collision-{n:02}', mode=group['mode'],
            family=group['family'], presentation=group['presentation'], oldItems=group['items'],
            strategy='SOURCE_PROVEN_ACCEPTED_UNION', newAccepted=union,
            sourceFacts=evidence, quarantined=[], reason=(
                'Same named OEWN concept and exact full definition.' if group['mode']=='EXPLAIN' else
                'Every alternative is an explicit relation of the identical source sense; '
                'the target POS and visible target definition also match for word-family.')))
        for r in pool:
            c = r['content']
            if group['mode'] == 'EXPLAIN':
                c['acceptedAliases'] = [a for a in union if a != c['target']]
                c['forbiddenForms'] = sorted(set(c['forbiddenForms']) | set(union) |
                    {form for s in evidence.values() for form in s['forms'] if form})
            else:
                c['accepted'] = [a for a in union if a != c['canonical']]
                c['relationSet'] = union
            r['repair'] = dict(groupId=decisions[-1]['groupId'], rule='SOURCE_PROVEN_ACCEPTED_UNION',
                previousFingerprint=r['fingerprint'], acceptedSourceSenses=sorted(evidence))
            # Keep original provenance, and add every exact supporting sense.
            r['sourceRefs'] = sorted({canonical(ref):ref for ref in r['sourceRefs'] +
                [dict(source='oewn', record=sid) for sid in evidence]}.values(), key=canonical)
    for r in rows:
        c = r['content']
        if r['family'] in ('SYNONYM', 'ANTONYM', 'WORD_FAMILY') and c.get('targetSenseId'):
            sid = c['targetSenseId']; fact = facts[sid]
            if c['canonical'] != fact['lemma'] or c['meaning'] != fact['definition']:
                raise ValueError('RELATION_CANONICAL_MEANING_SOURCE_MISMATCH')
            if c.get('targetDefinition') != fact['definition']:
                metadata.append(dict(id=r['id'], senseId=sid, field='targetDefinition',
                    old=c.get('targetDefinition'), new=fact['definition']))
                c['targetDefinition'] = fact['definition']
                r.setdefault('repair', dict(previousFingerprint=r['fingerprint']))['metadataRule'] = 'EXACT_TARGET_SENSE_DEFINITION'
        r['fingerprint'] = fingerprint(r)
    if presentation_collisions(rows): raise ValueError('UNRESOLVED_PRESENTATION_COLLISION')
    return decisions, metadata


def build(package, output, raw):
    package = Path(package).resolve(); output = Path(output).resolve(); raw = Path(raw).resolve()
    if output.exists(): raise ValueError('IMMUTABLE_PACKAGE_ALREADY_EXISTS')
    lock = json.loads((package/'sources.lock.json').read_bytes())
    source = next(s for s in lock['sources'] if s['id']=='oewn')
    if sha256(raw) != source['sha256']: raise ValueError('LOCKED_RAW_SOURCE_HASH_MISMATCH')
    manifest = json.loads((package/'manifest.json').read_bytes()); rows = []; dbs = []
    with tempfile.TemporaryDirectory(prefix='king-repair-') as tmp:
        for spec in manifest['shards']:
            if sha256(package/spec['name']) != spec['sha256']: raise ValueError('INPUT_SHARD_CHANGED')
            path = Path(tmp)/spec['name'].removesuffix('.gz')
            path.write_bytes(gzip.decompress((package/spec['name']).read_bytes())); dbs.append((spec,path))
            with closing(sqlite3.connect(path)) as db:
                rows.extend(json.loads(body) for body, in db.execute('select body from content order by id'))
        wanted = {sid for r in rows if r['family'] in ('SYNONYM','ANTONYM','WORD_FAMILY') or r['mode']=='EXPLAIN'
                  for sid in r.get('senseIds',[])}
        facts = source_facts(raw, wanted); decisions, metadata = repair_rows(rows, facts)
        by = {r['id']:r for r in rows}; output.mkdir(parents=True)
        for name in ('sources.lock.json','ATTRIBUTION.md'): shutil.copyfile(package/name,output/name)
        shutil.copytree(package/'licenses',output/'licenses')
        logical = hashlib.sha256()
        for spec, path in dbs:
            shard = hashlib.sha256()
            with closing(sqlite3.connect(path)) as db:
                for item_id, in db.execute('select id from content order by id').fetchall():
                    body = canonical(by[item_id]); data = (body+'\n').encode('utf8')
                    shard.update(data); logical.update(data)
                    db.execute('update content set body=? where id=?',(body,item_id))
                for word, in db.execute('select word from lexicon order by word'):
                    data = (word+'\n').encode(); shard.update(data); logical.update(data)
                db.execute("update manifest set value=? where key='contentSha256'",(shard.hexdigest(),))
                db.commit(); db.execute('VACUUM')
            target = output/spec['name']
            with path.open('rb') as stream, target.open('wb') as dest, gzip.GzipFile(filename='',mode='wb',fileobj=dest,mtime=0,compresslevel=9) as z:
                shutil.copyfileobj(stream,z)
            spec.update(sha256=sha256(target), bytes=target.stat().st_size, contentSha256=shard.hexdigest())
        manifest['contentBuildSha256'] = logical.hexdigest()
        (output/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
        proof = dict(schemaVersion=1,repairVersion='king-source-repair-1',sourceSha256=source['sha256'],
            predecessorArtifacts={name:sha256(package/name) for name in ('manifest.json',*[s['name'] for s in manifest['shards']])},
            decisions=decisions,metadataCorrections=metadata,repairedCollisionItems=sum(len(g['oldItems']) for g in decisions))
        (output/'corpus-repairs.json').write_text(canonical(proof)+'\n',encoding='utf8')
        with (output/'ATTRIBUTION.md').open('a',encoding='utf8') as f:
            f.write('\n\n## Source-proven scoring repair\nAccepted alternatives were reconciled against checksum-locked OEWN 2025 named senses. '
                    'Original definitions and provenance retained; target-definition metadata corrected to the exact named sense. '
                    'See corpus-repairs.json for every decision. No source endorsement or human approval claimed.\n')
    return proof


if __name__ == '__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--package',required=True);p.add_argument('--output',required=True);p.add_argument('--source',required=True)
    a=p.parse_args();result=build(a.package,a.output,a.source)
    print(json.dumps(dict(groups=len(result['decisions']),repaired=result['repairedCollisionItems'],metadataCorrections=len(result['metadataCorrections']))))
