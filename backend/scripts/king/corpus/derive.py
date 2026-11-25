"""Evidence-bound candidates, with linguistic uncertainty kept separate from review.

Automatic source confidence NEVER creates a human approval. A release gate must
inspect every family before publishing any runtime artifact.
"""
from collections import Counter, defaultdict
from contextlib import closing
import hashlib
import json
import math
import re
import sqlite3
from normalize import WORK, normalized
from sources import EVIDENCE, write_json, registry, sha256, LOCK

FAMILIES=('LETTER_SCRAMBLE','MISSING_LETTER','SPELLING_CORRECTION','SPELLING_CHOICE',
          'WORD_FAMILY','PART_OF_SPEECH','SYNONYM','ANTONYM','COLLOCATION','PHRASAL_VERB',
          'IDIOM_FRAGMENT','GRAMMAR_TRAP','FIXED_EXPRESSION')
SOURCE_LOCK_SHA=sha256(LOCK)


def digest(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()


def semantic(kind,text):
    return digest([kind,re.sub(r'[^\w\s\'-]','',normalized(text))])


def fingerprint(record):
    return digest({k:v for k,v in record.items() if k not in {'fingerprint','humanReview','reviewStatus'}})


def candidate(mode,family,key,content,concepts,source_refs,licenses,flags=(),high=False):
    identity=semantic(mode,key)
    row=dict(id='kc-'+mode.lower()+'-'+identity[:24],mode=mode,family=family,
             semanticHash=identity,conceptIds=sorted(set(concepts)),phraseIds=[],senseIds=[],
             content=content,sourceRefs=source_refs,licenseRefs=sorted(set(licenses)),
             confidence='HIGH_CONFIDENCE_SOURCE_BACKED' if high else 'SOURCE_BACKED_REVIEW_NEEDED',
             flags=sorted(set(flags)),reviewStatus='HUMAN_REVIEW_PENDING',humanReview=None,
             sourceLockSha256=SOURCE_LOCK_SHA,
             derivationVersion='king-source-candidates-1',fingerprint='')
    row['fingerprint']=fingerprint(row)
    return row


def category(sentence):
    s=normalized(sentence)
    if s.endswith('?'):return 'WH_QUESTION' if re.match(r'(who|what|where|when|why|how)\b',s) else 'YES_NO_QUESTION'
    for family,pattern in [('CONDITIONAL',r'\bif\b'),('NEGATIVE',r"\bnot\b|n't\b"),
        ('PRESENT_PERFECT',r'\b(has|have) (been|\w+ed)\b'),('MODAL',r'\b(can|could|should|must|may|might)\b'),
        ('FUTURE',r'\b(will|shall)\b'),('PRESENT_CONTINUOUS',r'\b(is|are|am) \w+ing\b'),
        ('PASSIVE',r'\b(is|are|was|were) \w+ed\b'),('PAST_SIMPLE',r'\b(was|were|did)\b'),
        ('RELATIVE_CLAUSE',r'\b(which|whose|whom)\b')]:
        if re.search(pattern,s):return family
    return 'UNCLASSIFIED_STRUCTURE'


def reorder_tokens(sentence):
    tokens=sentence.rstrip('.!?').split()
    # Whitespace-delimited punctuation is not a meaningful mobile puzzle tile.
    if not 4<=len(tokens)<=14 or any(not any(c.isalpha() for c in token) for token in tokens):
        return None
    return tokens


def main():
    lock=registry();sources={s['id']:s for s in lock['sources']};rows=[];rejects=Counter()
    with closing(sqlite3.connect(WORK)) as db:
        if db.execute("SELECT value FROM manifest WHERE key='sourceLockSha256'").fetchone()[0]!=sha256(LOCK):
            raise ValueError('SOURCE_VERSION_CHANGED_REBUILD_REQUIRED')
        db.executescript('''CREATE TABLE IF NOT EXISTS candidates(id TEXT PRIMARY KEY,mode TEXT NOT NULL,family TEXT NOT NULL,confidence TEXT NOT NULL,semantic_hash TEXT UNIQUE NOT NULL,body TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS candidate_bucket ON candidates(mode,family,confidence);''')
        learner={(w,p):level for w,p,level in db.execute('SELECT lemma,pos,level FROM profiles ORDER BY lemma,pos,level DESC')}
        words=defaultdict(list);senses={};concepts={};spell={w for w, in db.execute('SELECT DISTINCT word FROM spelling')}
        freq={w:c for w,c in db.execute('SELECT word,count FROM frequency')}
        for id,pos,definition,examples,relations,_ in db.execute('SELECT * FROM concepts'):
            concepts[id]=dict(pos=pos,definition=definition,examples=json.loads(examples),relations=json.loads(relations),lemmas=[])
        for sid,lid,cid,relations,w,pos,forms in db.execute('SELECT s.id,l.id,s.concept_id,s.relations,l.normalized_lemma,l.pos,l.forms FROM senses s JOIN lexemes l ON l.id=s.lexeme_id ORDER BY s.id'):
            sense=dict(id=sid,lemma=w,pos=pos,concept=cid,relations=json.loads(relations))
            senses[sid]=sense;words[w].append(sense);concepts[cid]['lemmas'].append(w)
            for form in json.loads(forms):spell.add(normalized(form['writtenForm']))
        valid_forms=spell|set(words)|set(freq)
        anagrams=defaultdict(set);masks=defaultdict(set)
        for form in sorted(valid_forms):
            if re.fullmatch('[a-z]{4,12}',form):
                anagrams[''.join(sorted(form))].add(form)
                m=len(form)//2;masks[form[:m]+'_'+form[m+1:]].add(form)
        common=sorted(w for w in words if re.fullmatch('[a-z]{4,12}',w) and w in spell and
            any((w,s['pos']) in learner for s in words[w]) and freq.get(w,0)>=5)
        # One spelling semantic task per lemma across ALL four presentation families.
        for index,w in enumerate(common):
            family=FAMILIES[index%4];sense=next(s for s in words[w] if (w,s['pos']) in learner)
            if re.search(r'fuck|shit|nigger|sexual|suicide|rape|murder',w):
                rejects['SENSITIVE_LEMMA']+=1;continue
            if family=='LETTER_SCRAMBLE' and len(anagrams[''.join(sorted(w))])!=1:
                rejects['ANAGRAM_ALTERNATIVE']+=1;continue
            if family=='MISSING_LETTER' and len(masks[w[:len(w)//2]+'_'+w[len(w)//2+1:]])!=1:
                rejects['MISSING_LETTER_ALTERNATIVE']+=1;continue
            level=learner[(w,sense['pos'])];middle=len(w)//2
            typo=next((w[:i]+w[i+1]+w[i]+w[i+2:] for i in range(1,len(w)-1)
                       if w[i]!=w[i+1] and w[:i]+w[i+1]+w[i]+w[i+2:] not in valid_forms),None)
            if family in {'SPELLING_CORRECTION','SPELLING_CHOICE'} and not typo:
                rejects['NO_SAFE_SPELLING_DISTRACTOR']+=1;continue
            content=dict(lemma=w,canonical=w,prompt=w,tokens=[],options=[],accepted=[],
                meaning=concepts[sense['concept']]['definition'],difficulty={'A1':1,'A2':2,'B1':3,'B2':4}[level],
                cefr=level,difficultySource='CEFR_J',cefrPos=sense['pos'],missingIndex=None)
            if family=='LETTER_SCRAMBLE':content.update(prompt='Arrange the letters.',tokens=list(w))
            elif family=='MISSING_LETTER':content.update(prompt=w[:middle]+'_'+w[middle+1:],canonical=w[middle],missingIndex=middle)
            elif family=='SPELLING_CORRECTION':content.update(prompt=typo)
            else:content.update(prompt='Choose the correctly spelled word.',options=[typo,w])
            rows.append(candidate('REFLEX',family,'SPELLING:'+w,content,[sense['concept']],
                [dict(source='oewn',record=sense['id']),dict(source='cefrj-vocabulary',record=w+':'+sense['pos']),
                 dict(source='scowl-us' if db.execute("SELECT 1 FROM spelling WHERE word=? AND dialect='US'",(w,)).fetchone() else 'scowl-gb',record=w),
                 dict(source='oanc',record='frequency:'+w)],['CC-BY-4.0 AND WordNet','LicenseRef-CEFR-J-Attribution','LicenseRef-ESDB-Permissive','LicenseRef-OANC-Unrestricted'],high=True))
        pair_seen=set()
        for sid,sense in sorted(senses.items()):
            w=sense['lemma'];cid=sense['concept']
            if (w,sense['pos']) not in learner:continue
            c=concepts[cid]
            # Synonyms remain inside ONE named WordNet synset, accompanied by its definition.
            targets=[t for t in sorted(set(c['lemmas'])) if t!=w and (t,sense['pos']) in learner and re.fullmatch('[a-z]+',t)]
            relations=[('SYNONYM',t,cid) for t in targets]
            for relation in sense['relations']:
                if relation['relType'] not in {'antonym','derivation'}:continue
                target=senses.get(relation['target'])
                if target and (target['lemma'],target['pos']) in learner:
                    relations.append(('ANTONYM' if relation['relType']=='antonym' else 'WORD_FAMILY',target['lemma'],target['concept']))
            for family,target,tcid in relations:
                key=(family,tuple(sorted((cid,tcid))),tuple(sorted((w,target))))
                if key in pair_seen:continue
                pair_seen.add(key)
                rows.append(candidate('REFLEX',family,json.dumps(key),dict(lemma=w,canonical=target,
                    prompt=f'{family}: {w}',senseClue=c['definition'],targetDefinition=concepts[tcid]['definition'],
                    accepted=targets if family=='SYNONYM' else [target],difficultySource='CEFR_J',cefr=learner[(w,sense['pos'])]),
                    [cid,tcid],[dict(source='oewn',record=sid),dict(source='cefrj-vocabulary',record=w+':'+sense['pos'])],
                    ['CC-BY-4.0 AND WordNet','LicenseRef-CEFR-J-Attribution'],['SENSE_AND_REGISTER_REVIEW']))
        sentence_seen=set();pos_seen=set();grammar_seen=set()
        for sid,text,tokens_json in db.execute('SELECT s.id,s.text,a.body FROM sentences s JOIN sentence_annotations a ON a.id=s.id ORDER BY s.id'):
            tokens=json.loads(tokens_json);key=semantic('REORDER',text)
            puzzle_tokens=reorder_tokens(text)
            if puzzle_tokens is None:rejects['REORDER_TOKEN_POLICY']+=1;continue
            if key in sentence_seen:rejects['NORMALIZED_SENTENCE_DUPLICATE']+=1;continue
            sentence_seen.add(key)
            linked=sorted({s['concept'] for t in tokens for s in words.get(normalized(t.get('lemma') or t['text']),[])})
            # Corpus correctness is not an order-uniqueness proof. No alternative is invented.
            rows.append(candidate('REORDER',category(text),text,dict(canonical=text,tokens=puzzle_tokens,
                accepted=[],cefr='UNKNOWN',difficultySource='UNKNOWN',annotation=tokens),linked,
                [dict(source='oanc',record=sid)],['LicenseRef-OANC-Unrestricted'],['ORDER_AMBIGUITY_UNPROVEN','CONTEXT_INDEPENDENCE_REVIEW','GRAMMAR_CATEGORY_ESTIMATED']))
            for t in tokens:
                w=normalized(t['text']);lemma=normalized(t.get('lemma') or w)
                pos={'NN':'noun','NNS':'noun','VB':'verb','VBD':'verb','VBG':'verb','VBN':'verb','VBP':'verb','VBZ':'verb','JJ':'adjective','JJR':'adjective','JJS':'adjective','RB':'adverb'}.get(t['pos'])
                if not pos or (lemma,pos) not in learner or len({s['pos'] for s in words.get(lemma,[])})!=1 or (lemma,pos) in pos_seen:continue
                pos_seen.add((lemma,pos))
                rows.append(candidate('REFLEX','PART_OF_SPEECH',lemma+':'+pos,dict(prompt=w,context=text,canonical=pos,
                    occurrenceStart=t['start'],occurrenceEnd=t['end'],annotation=t['pos']),
                    [s['concept'] for s in words.get(lemma,[])],[dict(source='oanc',record=sid),dict(source='oewn',record=lemma)],
                    ['LicenseRef-OANC-Unrestricted','CC-BY-4.0 AND WordNet'],['AUTOMATIC_POS_ANNOTATION_REVIEW']))
            if re.match(r'^(He|She|It) is\b',text) and key not in grammar_seen:
                grammar_seen.add(key)
                rows.append(candidate('REFLEX','GRAMMAR_TRAP','SUBJECT_AGREEMENT:'+text,dict(context=text.replace(' is ',' ___ ',1),
                    canonical='is',options=['are','is'],grammarRule='third-person singular subject, present be'),linked,
                    [dict(source='oanc',record=sid)],['LicenseRef-OANC-Unrestricted'],['CONTEXT_INDEPENDENCE_REVIEW']))
        filtered_frequency=Counter()
        for body, in db.execute('SELECT body FROM sentence_annotations'):
            filtered_frequency.update(normalized(t['text']) for t in json.loads(body) if re.fullmatch('[A-Za-z]+',t['text']))
        for first,second,pattern,count,documents in db.execute('SELECT * FROM collocations ORDER BY first,second,pattern'):
            score=14+math.log2(2*count/max(1,filtered_frequency[first]+filtered_frequency[second]))
            rows.append(candidate('REFLEX','COLLOCATION',first+' '+second,dict(expression=first+' '+second,canonical=second,
                frequency=count,documentFrequency=documents,logDice=score,pattern=pattern,
                marginalCounts=[filtered_frequency[first],filtered_frequency[second]],
                statisticPopulation='OANC retained annotated sentence spans'),[],
                [dict(source='oanc',record='collocation:'+first+' '+second)],['LicenseRef-OANC-Unrestricted'],['COLLOCATION_MEANING_AND_UNIQUE_ANSWER_REVIEW']))
        for w in sorted(words):
            eligible=[s for s in words[w] if (w,s['pos']) in learner]
            if not eligible:continue
            sense=eligible[0];c=concepts[sense['concept']]
            hypernyms=[concepts[r['target']]['definition'] for r in c['relations'] if r['relType']=='hypernym' and r['target'] in concepts]
            examples=[e for e in c['examples'] if re.search(r'\b'+re.escape(w)+r'\b',e,re.I)]
            clues=([hypernyms[0]] if hypernyms else [])+([re.sub(r'\b'+re.escape(w)+r'\b','[target]',examples[0],flags=re.I)] if examples else [])+[c['definition']]
            flags=['CLUE_PROGRESSION_AND_SENSE_REVIEW']
            if len(clues)!=3 or len(set(clues))!=3:flags.append('THREE_USEFUL_CLUES_NOT_ESTABLISHED')
            if any(re.search(r'\b'+re.escape(w)+r'\b',clue,re.I) for clue in clues):flags.append('TARGET_LEAKAGE')
            rows.append(candidate('EXPLAIN','LEXICAL_TARGET',w,dict(target=w,acceptedAliases=[],progressiveClues=clues,
                meaning=c['definition'],cefr=learner[(w,sense['pos'])],difficultySource='CEFR_J',pos=sense['pos']),
                [sense['concept']],[dict(source='oewn',record=sense['id']),dict(source='cefrj-vocabulary',record=w+':'+sense['pos'])],
                ['CC-BY-4.0 AND WordNet','LicenseRef-CEFR-J-Attribution'],flags))
        db.execute("DELETE FROM candidates WHERE mode!='CONQUEST'");seen=set()
        for row in rows:
            if row['semanticHash'] in seen:rejects['DUPLICATE_CANDIDATE']+=1;continue
            seen.add(row['semanticHash'])
            db.execute('INSERT INTO candidates VALUES(?,?,?,?,?,?)',(row['id'],row['mode'],row['family'],row['confidence'],row['semanticHash'],json.dumps(row,ensure_ascii=False,sort_keys=True)))
        db.commit()
        counts=db.execute('SELECT mode,family,confidence,count(*) FROM candidates GROUP BY mode,family,confidence').fetchall()
    write_json(EVIDENCE/'derivation.json',dict(counts=counts,rejects=dict(rejects),humanApproved=0,active=0));print(json.dumps(dict(counts=counts,rejects=dict(rejects))))


if __name__=='__main__':main()
