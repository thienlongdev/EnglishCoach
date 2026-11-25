"""Cross-confirm learner lexical combinations against the full annotated OANC.

The original retained-sentence statistics remain untouched. This separate
population is explicitly identified and uses matching token marginals.
"""
from collections import Counter
from contextlib import closing
import hashlib
import json
import math
import re
import sqlite3
import zipfile
from derive import candidate,digest,fingerprint
from mine_oanc import annotations
from normalize import WORK,normalized
from sources import CACHE,EVIDENCE,registry,verify,write_json
from qualify import promote,leaks,UNSAFE


def main():
    source=next(s for s in registry()['sources'] if s['id']=='oanc');verify(source,CACHE/source['cacheFile'])
    pairs=Counter();documents=Counter();marginals=Counter();patterns={};stats=Counter()
    with closing(sqlite3.connect(WORK)) as db:
        learner={w for w, in db.execute('SELECT DISTINCT lemma FROM profiles')}
        terms={}
        for sid,lid,cid,w,pos,definition in db.execute('SELECT s.id,l.id,s.concept_id,l.normalized_lemma,l.pos,c.definition FROM senses s JOIN lexemes l ON l.id=s.lexeme_id JOIN concepts c ON c.id=s.concept_id ORDER BY s.id'):
            parts=w.split()
            if len(parts)!=2 or not all(re.fullmatch('[a-z]+',x) and x in learner for x in parts):continue
            if pos!='noun' or UNSAFE.search(w+' '+definition) or leaks(definition,[w,parts[1]]):continue
            if not 4<=len(definition.split())<=60:continue
            terms.setdefault(tuple(parts),dict(senseId=sid,lexemeId=lid,conceptId=cid,meaning=definition))
        with zipfile.ZipFile(CACHE/source['cacheFile']) as z:
            for doc, in db.execute('SELECT id FROM documents ORDER BY id'):
                base='OANC-GrAF/data/'+doc
                text=z.read(base+'.txt').decode('utf-8')
                try:tagged=annotations(z.read(base+'-hepple.xml'),text,True)
                except (ValueError,KeyError):stats['annotationRejected']+=1;continue
                tokens=[(normalized(text[a:b]),f['msd'],a,b) for a,b,f in tagged]
                marginals.update(w for w,pos,a,b in tokens if re.fullmatch('[a-z]+',w) and not pos.startswith('NNP'))
                local=Counter()
                for (a,ap,astart,aend),(b,bp,bstart,bend) in zip(tokens,tokens[1:]):
                    if (a,b) not in terms or not text[aend:bstart].isspace():continue
                    if ap.startswith('JJ') and bp.startswith('NN') and not bp.startswith('NNP'):pattern='ADJECTIVE_NOUN'
                    elif ap.startswith('NN') and bp.startswith('NN') and not ap.startswith('NNP') and not bp.startswith('NNP'):pattern='NOUN_NOUN'
                    else:continue
                    local[(a,b)]+=1;patterns[(a,b)]=pattern
                pairs.update(local);documents.update(local.keys());stats['documents']+=1
                if stats['documents']%1000==0:print('COLLOCATION DOCUMENTS',stats['documents'],flush=True)
        rows=[]
        for pair,count in sorted(pairs.items()):
            if count<5 or documents[pair]<3:continue
            a,b=pair;ev=terms[pair];score=14+math.log2(2*count/(marginals[a]+marginals[b]))
            if score<5:continue
            # Distractors have no exact lexical-combination entry with this
            # first word in the selected learner noun-combination population.
            distractors=[]
            for _,other in sorted(terms):
                if other==b or (a,other) in terms or other in distractors:continue
                distractors.append(other)
                if len(distractors)==3:break
            if len(distractors)<3:continue
            expression=a+' '+b;pid='phrase:'+digest(expression)[:24]
            row=candidate('REFLEX','COLLOCATION',expression,dict(expression=expression,canonical=b,accepted=[],
                          prompt='Complete the documented word combination: '+a+' ___',context=ev['meaning'],meaning=ev['meaning'],
                          options=sorted([b]+distractors),frequency=count,documentFrequency=documents[pair],logDice=score,
                          marginalCounts=[marginals[a],marginals[b]],statisticPopulation='ALL_CANONICAL_OANC_WRITTEN_ANNOTATED_DOCUMENT_TOKENS',
                          pattern=patterns[pair],difficulty=3,cefr='UNKNOWN',difficultySource='ESTIMATED'),[ev['conceptId']],
                          [dict(source='oanc',record='full-written-combination:'+expression),dict(source='oewn',record=ev['senseId'])],
                          ['LicenseRef-OANC-Unrestricted','CC-BY-4.0 AND WordNet'])
            row.update(phraseIds=[pid],senseIds=[ev['senseId']],semanticLinks=[dict(confidence='PHRASE_EXACT',phraseId=pid),
                       dict(confidence='EXACT_SENSE',senseId=ev['senseId'],conceptId=ev['conceptId'],lexemeId=ev['lexemeId'])])
            rows.append(promote(row,dict(rule='EXACT_WORDNET_LEARNER_NOUN_COMBINATION_PLUS_OANC_SPREAD_ASSOCIATION_AND_CLOSED_BLANK',
                                        minimumFrequency=5,minimumDocuments=3,minimumLogDice=5)))
        for r in rows:
            db.execute('INSERT OR REPLACE INTO candidates VALUES(?,?,?,?,?,?)',(r['id'],r['mode'],r['family'],r['confidence'],r['semanticHash'],json.dumps(r,sort_keys=True,ensure_ascii=False)))
        db.commit()
    write_json(EVIDENCE/'continuation/collocation-mining.json',dict(stats=dict(stats),lexicalCombinations=len(terms),qualified=len(rows),population='ALL_CANONICAL_OANC_WRITTEN_ANNOTATED_DOCUMENT_TOKENS',originalRetainedSentenceStatisticsModified=False))
    print('QUALIFIED COLLOCATIONS',len(rows))


if __name__=='__main__':main()
