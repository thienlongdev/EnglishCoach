"""Stream only typed English phrase definitions from raw Wiktextract.

No translations, quotations, audio, etymologies or merged postprocessed fields
are imported. The entire derivative remains in a separately licensed shard.
"""
from collections import Counter
from contextlib import closing
import gzip
import json
import re
import sqlite3
from urllib.parse import quote
from derive import digest, fingerprint
from normalize import WORK, normalized
from sources import CACHE, EVIDENCE, LOCK, ROOT, sha256, write_json, registry, verify

RAW='kaikki-en-20260928.jsonl.gz'
RAW_SHA='504d55e7053c742ffe24b49a6ebd0c8261a1cd4b352702a1940547088829f5e1'
BAD={'archaic','obsolete','dated','rare','historical','offensive','vulgar','slang','derogatory','regional','dialectal','nonstandard','uncommon','UK','US','Australia','Scotland','Ireland','figuratively-obsolete'}


def phrase_type(record,sense):
    categories=set(record.get('categories',[])+sense.get('categories',[]))
    tags=set(sense.get('tags',[]))
    if record.get('pos')=='verb' and 'English phrasal verbs' in categories:return 'PHRASAL_VERB'
    if 'idiomatic' in tags or 'English idioms' in categories:return 'IDIOM_FRAGMENT'
    if record.get('pos') in {'phrase','prep_phrase'}:return 'FIXED_EXPRESSION'


def main():
    verify(dict(id='kaikki',sha256=RAW_SHA),CACHE/RAW)
    registry()  # verify all existing license evidence before touching the index
    stats=Counter(); rows={}
    with closing(sqlite3.connect(WORK)) as db:
        learner={w for w, in db.execute('SELECT DISTINCT lemma FROM profiles')}
        freq=dict(db.execute('SELECT word,count FROM frequency'))
        with gzip.open(CACHE/RAW,'rt',encoding='utf-8') as stream:
            for line in stream:
                stats['rawLines']+=1
                if '"lang_code": "en"' not in line:continue
                r=json.loads(line)
                if r.get('lang_code')!='en':continue
                expression=r['word']; word=normalized(expression)
                if expression!=word or not re.fullmatch(r'[a-z]+(?: [a-z]+){1,6}',word):continue
                pieces=word.split()
                if any(freq.get(w,0)<5 for w in pieces) or sum(w in learner for w in pieces)/len(pieces)<.7:continue
                for index,s in enumerate(r.get('senses',[])):
                    family=phrase_type(r,s)
                    if not family:continue
                    stats['typedSenses']+=1
                    tags=set(s.get('tags',[]))
                    if tags&BAD or s.get('form_of') or s.get('alt_of'):stats['excludedRegisterOrForm']+=1;continue
                    gloss=s.get('glosses',[])
                    if len(gloss)!=1 or not 3<=len(gloss[0].split())<=65:stats['excludedGloss']+=1;continue
                    meaning=gloss[0]
                    if re.search(r'fuck|shit|nigger|sex|suicid|rape|murder|penis|vagina|porn|cunt|slut|whore',word+' '+meaning,re.I):continue
                    if re.search(r'\b(?:obsolete|archaic|rare|historical|offensive|vulgar)\b',meaning,re.I):continue
                    if family=='PHRASAL_VERB' and (len(pieces)>3 or pieces[0] not in learner):continue
                    url='https://en.wiktionary.org/wiki/'+quote(expression.replace(' ','_'))+'#English'
                    sid='wiktionary:'+digest([word,r.get('pos'),index,meaning])[:24]
                    pid='phrase:'+digest(word)[:24]
                    body=dict(id=sid,phraseId=pid,expression=word,family=family,meaning=meaning,
                              pos=r.get('pos'),verb=pieces[0] if family=='PHRASAL_VERB' else None,
                              particle=' '.join(pieces[1:]) if family=='PHRASAL_VERB' else None,
                              sourceId='kaikki',licenseId='CC-BY-SA-4.0',shareAlike=True,
                              attribution=url,tags=sorted(tags),typeEvidence=dict(categories=sorted(c for c in set(r.get('categories',[])+s.get('categories',[])) if c in {'English idioms','English phrasal verbs'}),tags=sorted(tags),pos=r.get('pos')),
                              sourceRecord=dict(word=expression,pos=r.get('pos'),senseIndex=index),
                              sourceSha256=RAW_SHA,shard='wiktionary-cc-by-sa-4.0',
                              modifications='Typed entry definition selected; metadata filtered; no quotation or third-party example imported.')
                    body['fingerprint']=digest(body)
                    rows[sid]=body
                if stats['rawLines']%1000000==0:print('SCAN',stats['rawLines'],'PHRASES',len(rows),flush=True)
        db.execute('CREATE TABLE IF NOT EXISTS phrases(id TEXT PRIMARY KEY,expression TEXT,family TEXT,body TEXT)')
        db.execute('DELETE FROM phrases')
        db.executemany('INSERT INTO phrases VALUES(?,?,?,?)',((r['id'],r['expression'],r['family'],json.dumps(r,sort_keys=True,ensure_ascii=False)) for r in sorted(rows.values(),key=lambda r:r['id'])))
        db.commit()
    stats.update(Counter(r['family'] for r in rows.values()))
    write_json(EVIDENCE/'continuation/phrase-ingestion.json',dict(counts=dict(stats),rawSha256=RAW_SHA,sourceUrl='https://kaikki.org/dictionary/raw-wiktextract-data.jsonl.gz',excludedFields=['examples','quotations','translations','etymologies','sounds'],runtimeShard='wiktionary-cc-by-sa-4.0'))
    print(json.dumps(dict(stats)))


if __name__=='__main__':main()
