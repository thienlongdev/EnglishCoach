"""Deterministic qualification of the existing canonical corpus.

This stage changes source confidence only. It never writes an owner decision.
All added clue text is an exact source string or an identified source fragment.
"""
from collections import Counter, defaultdict
from contextlib import closing
import itertools
import json
import re
import sqlite3
from derive import candidate, fingerprint, digest
from normalize import WORK, normalized
from sources import EVIDENCE, LOCK, sha256, write_json

HIGH = 'HIGH_CONFIDENCE_SOURCE_BACKED'
STOP = set('a an the of to in on for by with and or that which is are be as at from it something someone any'.split())
UNSAFE = re.compile(r'\b(?:fuck\w*|shit\w*|nigger\w*|sex\w*|suicid\w*|rape\w*|murder\w*|penis|vagina|porn\w*|cunt|slut|whore)\b', re.I)


def lexical_tokens(s):
    return set(re.findall(r'[a-z]+', normalized(s))) - STOP


def leaks(text, forms):
    # Same letter-separator policy used by the runtime clue guard.
    return any(re.search(r'(?<![a-z])' + r'[\W_]*'.join(map(re.escape, re.sub('[^a-z]', '', normalized(f)))) + r'(?![a-z])', normalized(text))
               for f in forms if re.sub('[^a-z]', '', normalized(f)))


def promote(row, proof):
    row.update(confidence=HIGH, flags=[], qualification=proof, derivationVersion='king-qualified-2')
    row['fingerprint'] = fingerprint(row)
    return row


class LexicalEvidence:
    def __init__(self, db):
        self.profiles = {(w,p):l for w,p,l in db.execute('SELECT lemma,pos,level FROM profiles ORDER BY level DESC')}
        self.frequency = dict(db.execute('SELECT word,count FROM frequency'))
        self.concepts = {i:dict(pos=p, definition=d, examples=json.loads(e), relations=json.loads(r), senses=[])
                         for i,p,d,e,r in db.execute('SELECT id,pos,definition,examples,relations FROM concepts')}
        self.senses = {}
        self.words = defaultdict(list)
        for sid,lid,cid,rel,w,p,forms,original in db.execute('SELECT s.id,l.id,s.concept_id,s.relations,l.normalized_lemma,l.pos,l.forms,l.lemma FROM senses s JOIN lexemes l ON l.id=s.lexeme_id ORDER BY s.id'):
            s = dict(id=sid,lexeme=lid,concept=cid,relations=json.loads(rel),word=w,pos=p,
                     originalLemma=original,forms=sorted({normalized(f['writtenForm']) for f in json.loads(forms)}))
            self.senses[sid] = s
            self.words[w].append(s)
            self.concepts[cid]['senses'].append(s)
        self.children=defaultdict(set)
        for cid,c in self.concepts.items():
            if not any((s['word'],s['pos']) in self.profiles for s in c['senses']):continue
            for r in c['relations']:
                if r['relType']=='hypernym':self.children[r['target']].add(cid)

    def exact_links(self, row, senses):
        row['senseIds'] = sorted({s['id'] for s in senses})
        row['conceptIds'] = sorted({s['concept'] for s in senses})
        row['semanticLinks'] = [dict(confidence='EXACT_SENSE',senseId=s['id'],conceptId=s['concept'],lexemeId=s['lexeme']) for s in senses]

    def weak_links(self, row, words):
        row['senseIds'] = []; row['conceptIds'] = []
        row['semanticLinks'] = [dict(confidence='LEXEME_ONLY',lexemeId=lid) for lid in sorted({s['lexeme'] for w in words for s in self.words.get(w,[])})]


def explain_choices(ev, word):
    results=[]
    for s in ev.words[word]:
        if (word,s['pos']) not in ev.profiles: continue
        if s['originalLemma']!=s['originalLemma'].lower():continue
        c=ev.concepts[s['concept']]; definition=c['definition']
        if any(r['relType'] in {'domain_topic','instance_hypernym'} for r in c['relations']):continue
        if not 10 <= len(definition.split()) <= 65 or len(definition)>400 or UNSAFE.search(definition): continue
        # Aliases are restricted to learner-profile words in the SAME synset.
        aliases=sorted({x['word'] for x in c['senses'] if x['word']!=word and
                        (x['word'],x['pos']) in ev.profiles and x['originalLemma']==x['originalLemma'].lower() and re.fullmatch('[a-z]+',x['word'])})
        forbidden=sorted({word,*s['forms'],*aliases,*[f for a in aliases for x in ev.words[a] if x['concept']==s['concept'] for f in x['forms']]})
        if leaks(definition,forbidden):continue
        hypers=[ev.concepts[r['target']] for r in c['relations'] if r['relType']=='hypernym' and r['target'] in ev.concepts]
        for h in hypers:
            broad=h['definition']
            if not 3<=len(broad.split())<=50 or len(broad)>400 or UNSAFE.search(broad) or leaks(broad,forbidden):continue
            hyperid=next(r['target'] for r in c['relations'] if r['relType']=='hypernym' and ev.concepts.get(r['target']) is h)
            population=ev.children[hyperid]
            if len(population)<2 or len(lexical_tokens(broad))<3:continue
            words=definition.split()
            # An explicitly marked excerpt is useful evidence, not an invented claim.
            for n in range(max(5,len(words)//2),len(words)-2):
                fragment=' '.join(words[:n])+' …'
                added=lexical_tokens(fragment)-lexical_tokens(broad)
                final_added=lexical_tokens(definition)-lexical_tokens(fragment)
                if len(added)<3 or not final_added or leaks(fragment,forbidden):continue
                excerpt_signature=lexical_tokens(fragment)
                final_signature=lexical_tokens(definition)
                stage2={cid for cid in population if excerpt_signature<=lexical_tokens(ev.concepts[cid]['definition'])}
                stage3={cid for cid in stage2 if final_signature<=lexical_tokens(ev.concepts[cid]['definition'])}
                if s['concept'] not in stage3 or not len(stage3)<=len(stage2)<len(population):continue
                clues=[broad,fragment,definition]
                if len(set(map(normalized,clues)))!=3:continue
                proof=dict(rule='DIRECT_HYPERNYM_THEN_SAME_SENSE_DEFINITION_EXCERPT_THEN_FULL_DEFINITION',
                           senseId=s['id'],hypernymDefinition=broad,excerptWordCount=n,
                           excerptDiscriminativeTokens=sorted(added),finalAdditionalTokens=sorted(final_added),
                           discriminationPopulation='LEARNER_BOUND_DIRECT_HYPONYM_CONCEPT_DEFINITIONS',
                           candidateSetSizes=[len(population),len(stage2),len(stage3)],
                           clueSources=[dict(source='oewn',record=hyperid),
                                        dict(source='oewn',record=s['id'],field='definition',prefixWords=n),dict(source='oewn',record=s['id'],field='definition')])
                score=(len(added)+len(final_added),ev.frequency.get(word,0),-len(definition),s['id'])
                results.append((score,s,clues,aliases,forbidden,proof));break
    return sorted(results,key=lambda x:x[0],reverse=True)


def qualify_explain(ev, row, diagnostics):
    word=row['content']['target']
    choices=explain_choices(ev,word)
    diagnostics['allSenseTargetsEvaluated']+=1
    if not choices:return row
    _,s,clues,aliases,forbidden,proof=choices[0]
    c=ev.concepts[s['concept']]
    row['content'].update(progressiveClues=clues,acceptedAliases=aliases,forbiddenForms=forbidden,
                          meaning=c['definition'],senseId=s['id'],pos=s['pos'],cefr=ev.profiles[(word,s['pos'])],
                          difficulty={'A1':1,'A2':2,'B1':3,'B2':4}[ev.profiles[(word,s['pos'])]])
    row['sourceRefs']=[dict(source='oewn',record=s['id']),dict(source='cefrj-vocabulary',record=word+':'+s['pos'])]
    ev.exact_links(row,[s]);return promote(row,proof)


def qualify_relation(ev,row):
    c=row['content'];source=next((ev.senses.get(r['record']) for r in row['sourceRefs'] if r['source']=='oewn'),None)
    if not source:return row
    if source['originalLemma']!=source['originalLemma'].lower():return row
    concept=ev.concepts[source['concept']]
    if UNSAFE.search(c['lemma']+' '+c['canonical']+' '+concept['definition']):return row
    if not re.fullmatch('[a-z]+',c['lemma']) or not re.fullmatch('[a-z]+',c['canonical']):return row
    targets=[]
    if row['family']=='SYNONYM':
        targets=[s for s in concept['senses'] if s['word']!=source['word'] and s['originalLemma']==s['originalLemma'].lower() and (s['word'],s['pos']) in ev.profiles and re.fullmatch('[a-z]+',s['word'])]
    else:
        typ='antonym' if row['family']=='ANTONYM' else 'derivation'
        targets=[ev.senses[r['target']] for r in source['relations'] if r['relType']==typ and r['target'] in ev.senses]
        targets=[s for s in targets if s['word']==c['canonical'] and s['originalLemma']==s['originalLemma'].lower()]
    if not targets:return row
    target=next((s for s in targets if s['word']==c['canonical']),targets[0])
    if row['family']=='WORD_FAMILY':
        if target['word']==source['word']:return row
        # A named target POS and sense disambiguate transformations with multiple derivations.
        c['prompt']=f"Find the related {target['pos']} of '{source['word']}' for this meaning."
        c['context']=ev.concepts[target['concept']]['definition']
        accepted=sorted({s['word'] for s in targets if s['pos']==target['pos'] and s['concept']==target['concept']})
    else:
        c['prompt']=f"Find a {'synonym' if row['family']=='SYNONYM' else 'source-linked antonym'} of '{source['word']}' in this sense."
        c['context']=concept['definition'];accepted=sorted({s['word'] for s in targets})
    c.update(canonical=target['word'],accepted=[w for w in accepted if w!=target['word']],relationSet=accepted,
             meaning=ev.concepts[target['concept']]['definition'],senseId=source['id'],targetSenseId=target['id'],
             difficulty={'A1':1,'A2':2,'B1':3,'B2':4}[c['cefr']])
    ev.exact_links(row,[source,target])
    return promote(row,dict(rule='EXPLICIT_NAMED_SENSE_RELATION',sourceSense=source['id'],targetSenses=[s['id'] for s in targets]))


def qualify_pos(db,ev,row):
    c=row['content'];ref=next(r['record'] for r in row['sourceRefs'] if r['source']=='oanc')
    sentence=db.execute('SELECT text,start FROM sentences WHERE id=?',(ref,)).fetchone()
    if not sentence:return row
    text,start=sentence;a,b=c['occurrenceStart']-start,c['occurrenceEnd']-start
    # Whitespace normalization can invalidate absolute-to-relative offsets. Locate by the
    # exact annotated token only when it has one occurrence; otherwise retain for review.
    word=c.get('occurrenceText')
    if not word:
        word=text[c['occurrenceStart']:c['occurrenceEnd']] if row.get('qualification') else c['prompt']
    c['occurrenceText']=word
    found=list(re.finditer(r'(?<!\w)'+re.escape(word)+r'(?!\w)',text,re.I))
    if len(found)!=1:return row
    a,b=found[0].span()
    if c['annotation'] in {'VBG','VBN'}:return row  # participial noun/adjective ambiguity
    c.update(occurrenceStart=a,occurrenceEnd=b,prompt=f"What is the part of speech of '{text[a:b]}' here?",
             context=text,options=['noun','verb','adjective','adverb'],difficulty=2,cefr='UNKNOWN',difficultySource='ESTIMATED',
             meaning=f"OANC occurrence annotation: {c['annotation']}")
    ev.weak_links(row,[normalized(text[a:b])])
    return promote(row,dict(rule='UNIQUE_OCCURRENCE_POS_WITH_SINGLE_LEXICAL_WORD_CLASS',annotation=c['annotation'],relativeSpan=[a,b]))


def structural_category(text, tokens):
    s=normalized(text); tags=[t['pos'] for t in tokens]
    if re.match(r'^(?:never|rarely|seldom|hardly|scarcely|no sooner|not only)\b',s) and any(t in {'MD','VBD','VBP','VBZ'} for t in tags):return 'INVERSION'
    if text.endswith('?'):
        return 'WH_QUESTION' if tags and tags[0] in {'WP','WRB','WDT'} else 'YES_NO_QUESTION'
    checks=[('CONDITIONAL',r'\bif\b'),('NEGATIVE',r"\bnot\b|n't\b"),
            ('PRESENT_PERFECT',r'\b(?:has|have) (?:been|\w+ed)\b'),
            ('FUTURE',r'\b(?:will|shall)\b'),('MODAL',r'\b(?:can|could|must|should|may|might|would)\b'),
            ('PRESENT_CONTINUOUS',r'\b(?:am|is|are) \w+ing\b'),
            ('PASSIVE',r'\b(?:am|is|are|was|were|be|been) \w+ed\b'),
            ('RELATIVE_CLAUSE',r'\b(?:which|whose|whom)\b')]
    for category,pattern in checks:
        if re.search(pattern,s):return category
    if re.search(r'\b(?:has|have)\b',s) and 'VBN' in tags:return 'PRESENT_PERFECT'
    if 'VBD' in tags:return 'PAST_SIMPLE'
    if 'RB' in tags:return 'ADVERB_PLACEMENT'
    if 'IN' in tags:return 'PREPOSITIONAL_STRUCTURE'
    if any(t in {'VBZ','VBP'} for t in tags):return 'PRESENT_SIMPLE'
    return 'ADVANCED_CHUNK'


def phrase_structures(text, evidence):
    """Exact expression identity only; this does not claim a contextual phrase sense."""
    words=normalized(re.sub('[,.!?]','',text)).split()
    matches=[]
    for size in range(7,1,-1):
        for start in range(len(words)-size+1):
            expression=' '.join(words[start:start+size])
            if expression in evidence:matches.extend(evidence[expression])
    return sorted(matches,key=lambda p:(-len(p['expression'].split()),p['id']))


def structural_labels(text, tokens):
    """Orthogonal affirmative label alongside the primary tense/structure bucket."""
    category=structural_category(text,tokens);labels={category}
    if category in {'PRESENT_SIMPLE','PAST_SIMPLE'} and ',' not in text and not any(t['pos'] in {'CC','WDT'} for t in tokens):
        labels.add('SIMPLE_AFFIRMATIVE')
    return labels


def constrained_reorder(text, annotation, internal=False, phrasal=frozenset()):
    """Recognize a conservative clause grammar, with source-bound constituent chunks.

    NP internal order and auxiliary/verb chains are preserved. All complement
    permutations are enumerated, so adjunct placement is not silently penalized.
    The prompt explicitly anchors the initial subject; this avoids reversible
    subject/object noun phrases without falsely claiming sense disambiguation.
    """
    if not internal and re.match(r'^(?:If|When|After|Before|Although|While|Because)\b',text) and text.count(',')==1:
        first,second=text.rstrip('.!?').split(',',1)
        ts=[t for t in annotation if t['text'].isalpha()]
        cut=len(first.split())
        a=constrained_reorder(' '.join(t['text'] for t in ts[1:cut])+'.',ts[1:cut],True,phrasal)
        b=constrained_reorder(second.strip()+'.',ts[cut:],True,phrasal)
        if a and b:
            condition=first.strip(); chunks=[condition]+b['tokens']
            if not 3<=len(chunks)<=7:return None
            canonical=' '.join(chunks)
            accepted=sorted({' '.join([condition]+x.split()) for x in b['accepted']}|
                            {' '.join(b['tokens']+[condition])})
            return dict(tokens=chunks,canonical=canonical,accepted=[x for x in accepted if x!=canonical],
                        prompt='Arrange the subordinate clause and main clause chunks.',roles=['SUBORDINATE']+b['proof']['roles'],
                        proof=dict(rule='TWO_INDEPENDENTLY_RECOGNIZED_CLAUSES_SUBORDINATE_CHUNK',
                                   subordinate=a['proof'],main=b['proof'],conditionMovement=True))
    if not internal and ',' not in text:
        ts=[t for t in annotation if t['text'].isalpha()]
        indices=[i for i,t in enumerate(ts) if t['pos']=='WDT' and normalized(t['text']) in {'that','which'}]
        if len(indices)==1:
            cut=indices[0]
            a=constrained_reorder(' '.join(t['text'] for t in ts[:cut])+'.',ts[:cut],False,phrasal)
            b=constrained_reorder(' '.join(t['text'] for t in ts[cut:])+'.',ts[cut:],True,phrasal)
            if a and b and a['proof']['roles'][-1]=='OBJECT':
                chunks=a['tokens'][:-1]+[a['tokens'][-1]+' '+' '.join(t['text'] for t in ts[cut:])]
                return dict(tokens=chunks,canonical=' '.join(chunks),accepted=[],
                            prompt='Arrange the clause chunks. Keep the relative clause with its noun.',roles=a['proof']['roles'],
                            proof=dict(rule='OBJECT_NOUN_WITH_RECOGNIZED_SUBJECT_RELATIVE_CLAUSE',main=a['proof'],relative=b['proof']))
    checked=text
    if internal and re.match(r'^(?:that|which)\b',text,re.I):checked=re.sub(r'^\w+','',text)
    if re.search(r"[;:'\"()\-]|\b(?:this|that|these|those|here|there|such|then|however|therefore)\b",checked,re.I):return None
    ts=[t for t in annotation if t['text'].isalpha()]
    if not (3 if internal else 5)<=len(ts)<=14 or any(t['pos'] in {'CC','NNP','NNPS','POS'} or t['pos']=='WDT' and not(internal and i==0) for i,t in enumerate(ts)):return None
    # A unique lexical token sequence prevents malformed or split source annotations.
    if normalized(' '.join(t['text'] for t in ts))!=normalized(re.sub('[,.!?]','',text)):return None
    subjectives={'i','you','he','she','we','they'}
    def np(i):
        start=i
        if internal and i==0 and ts[i]['pos']=='WDT' and normalized(ts[i]['text']) in {'which','that'}:return 1
        if i<len(ts) and ts[i]['pos']=='PRP' and normalized(ts[i]['text']) in subjectives|{'it','me','him','her','us','them'}:return i+1
        if i<len(ts) and ts[i]['pos'] in {'DT','PRP$','CD'}:i+=1
        while i<len(ts) and ts[i]['pos'] in {'JJ','JJR','JJS','CD'}:i+=1
        before=i
        while i<len(ts) and ts[i]['pos'] in {'NN','NNS'}:i+=1
        if i==before:return start
        # Nominal "of" complements stay attached to their head noun. They are
        # never shuffled as free clause adjuncts ("the end of the road").
        while i<len(ts) and normalized(ts[i]['text'])=='of':
            end=np(i+1)
            if end<=i+1:break
            i=end
        return i
    question=text.endswith('?'); wh=question and ts[0]['pos'] in {'WP','WRB'}
    chunks=[]; roles=[]; i=0
    def add(a,b,role):
        chunks.append(' '.join(t['text'] for t in ts[a:b]));roles.append(role)
    if question:
        if wh:add(0,1,'WH');i=1
        if i>=len(ts) or normalized(ts[i]['text']) not in {'do','does','did','am','is','are','was','were','can','could','will','would','should','have','has'}:return None
        add(i,i+1,'AUX');i+=1
    end=np(i)
    if end==i:return None
    if ts[i]['pos']=='PRP' and normalized(ts[i]['text']) not in subjectives|{'it'}:return None
    add(i,end,'SUBJECT');i=end;verbstart=i
    if i<len(ts) and ts[i]['pos']=='RB' and normalized(ts[i]['text']) in {'always','never','often','usually','sometimes','already'}:i+=1
    if i<len(ts) and ts[i]['pos']=='MD':i+=1
    while i<len(ts) and (ts[i]['pos'].startswith('VB') or normalized(ts[i]['text'])=='not'):i+=1
    phrase=None
    if i<len(ts) and ts[i]['pos']=='RP' and i>verbstart:
        phrase=normalized((ts[i-1].get('lemma') or ts[i-1]['text'])+' '+ts[i]['text'])
        if phrase not in phrasal:return None
        i+=1
    if i==verbstart:
        if not question or normalized(chunks[1 if wh else 0]) not in {'am','is','are','was','were'}:return None
    else:add(verbstart,i,'VERB')
    complements=[]
    while i<len(ts):
        start=i
        if ts[i]['pos']=='TO' and i+1<len(ts) and ts[i+1]['pos']=='VB':
            # Keep an infinitival clause intact, after independently checking its
            # verb and NP/PP complements against the same conservative grammar.
            j=i+2
            while j<len(ts) and ts[j]['pos'].startswith('VB'):j+=1
            while j<len(ts):
                before=j
                if ts[j]['pos'] in {'IN','TO'}:j=np(j+1)
                else:j=np(j)
                if j<=before:return None
            i=j;role='INFINITIVE'
        elif ts[i]['pos'] in {'IN','TO'}:
            i=np(i+1)
            if i<=start+1:return None
            role='PP'
        elif ts[i]['pos']=='RB' and i+1<len(ts) and ts[i+1]['pos'].startswith('JJ'):
            i+=1
            while i<len(ts) and ts[i]['pos'].startswith('JJ'):i+=1
            role='PREDICATE_ADJECTIVE'
        elif ts[i]['pos']=='RB':
            while i<len(ts) and ts[i]['pos']=='RB':i+=1
            role='ADVERB'
        elif ts[i]['pos'].startswith('JJ'):
            while i<len(ts) and ts[i]['pos'].startswith('JJ'):i+=1
            role='PREDICATE_ADJECTIVE'
        else:
            i=np(i);role='OBJECT'
            if i==start:return None
        complements.append((' '.join(t['text'] for t in ts[start:i]),role))
    if (not complements and not internal) or len(complements)>3:return None
    if sum(role=='OBJECT' for _,role in complements)>1:return None
    if sum(role=='PREDICATE_ADJECTIVE' for _,role in complements)>1:return None
    # No generic movable adverbs: scope-sensitive placement needs review.
    if any(role=='ADVERB' and normalized(chunk) not in {'today','yesterday','tomorrow'} for chunk,role in complements):return None
    base=chunks[:];accepted=[]
    fixed=[(chunk,role) for chunk,role in complements if role not in {'PP','ADVERB'}]
    adjuncts=[(chunk,role) for chunk,role in complements if role in {'PP','ADVERB'}]
    if len(fixed)>1:return None
    # Object, predicative adjective and infinitive stay immediately after the
    # verb. Only whole adjuncts move; never accept PP-before-object nonsense.
    if complements[:len(fixed)]!=fixed:return None
    for permutation in itertools.permutations(adjuncts):
        candidate_chunks=base+[chunk for chunk,_ in fixed+list(permutation)]
        accepted.append(' '.join(candidate_chunks))
    # Time adjuncts may move to the front; preserve the whole adjunct chunk.
    for chunk,role in complements:
        if role=='ADVERB':accepted.append(' '.join([chunk]+base+[x for x,r in complements if x!=chunk]))
    for chunk,role in complements:add_text=chunk;chunks.append(add_text);roles.append(role)
    if not (2 if internal else 3)<=len(chunks)<=7:return None
    canonical=' '.join(chunks)
    accepted=sorted(set(accepted)-{canonical})
    return dict(tokens=chunks,canonical=canonical,accepted=accepted,
                prompt='Arrange the clause chunks. Keep the subject before its verb; keep the question opening first.' if question else
                       'Arrange the clause chunks. Begin with the capitalized subject; put its verb next.',
                roles=roles,proof=dict(rule='SOURCE_POS_CONSTITUENT_CHUNKS_V1',roles=roles,phrasalExpression=phrase,
                      subjectAnchor=True,alternatives='WHOLE_ADJUNCT_PERMUTATIONS_AND_TIME_FRONTING',
                      acceptedOrderCount=1+len(accepted)))


def qualify_reorder(ev,row):
    c=row['content'];text=c.get('sourceText',c.get('meaning') if row.get('qualification') else c['canonical']);annotation=c['annotation']
    c['sourceText']=text
    row['family']=structural_category(text,annotation)
    proof=constrained_reorder(text,annotation,phrasal=ev.phrasal)
    if not proof:
        row.update(confidence='SOURCE_BACKED_REVIEW_NEEDED',flags=['CONSTRAINED_GRAMMAR_NOT_PROVEN'])
        row.pop('qualification',None)
        return row
    qualification=proof.pop('proof');proof.pop('roles');c.update(proof)
    if qualification['rule']=='TWO_INDEPENDENTLY_RECOGNIZED_CLAUSES_SUBORDINATE_CHUNK' and not text.startswith('If '):row['family']='ADVANCED_CHUNK'
    if qualification['rule']=='OBJECT_NOUN_WITH_RECOGNIZED_SUBJECT_RELATIVE_CLAUSE':row['family']='RELATIVE_CLAUSE'
    if qualification.get('phrasalExpression'):
        expression=qualification['phrasalExpression'];pid='phrase:'+digest(expression)[:24]
        row['family']='PHRASAL_VERB';row['phraseIds']=[pid]
        row['semanticLinks'].append(dict(confidence='PHRASE_EXACT',phraseId=pid))
        qualification['phraseTypeSource']='kaikki:'+expression
        row['sourceRefs']=[r for r in row['sourceRefs'] if r['source']!='kaikki']+[dict(source='kaikki',record='typed-phrasal-expression:'+expression,
                               url='https://en.wiktionary.org/wiki/'+expression.replace(' ','_')+'#English')]
        row['licenseRefs']=sorted(set(row['licenseRefs'])|{'CC-BY-SA-4.0'})
        row['shard']='wiktionary-cc-by-sa-4.0'
    c.update(meaning=text,cefr='UNKNOWN',difficultySource='ESTIMATED',difficulty=min(5,max(1,len(c['tokens'])-2)))
    matches=phrase_structures(text,getattr(ev,'phrase_evidence',{}))
    if matches:
        p=matches[0];row['family']={'IDIOM_FRAGMENT':'IDIOM'}.get(p['family'],p['family'])
        pid='phrase:'+digest(p['expression'])[:24]
        row['phraseIds']=sorted(set(row.get('phraseIds',[]))|{pid})
        row['semanticLinks'].append(dict(confidence='PHRASE_EXACT',phraseId=pid))
        row['sourceRefs']=[r for r in row['sourceRefs'] if r['source']!='kaikki']+[dict(source='kaikki',record=p['id'],url=p['attribution'])]
        row['licenseRefs']=sorted(set(row['licenseRefs'])|{'CC-BY-SA-4.0'})
        row['shard']='wiktionary-cc-by-sa-4.0'
        qualification['phraseIdentityEvidence']=dict(record=p['id'],expression=p['expression'],type=p['family'],contextualSenseClaim=False)
    else:
        collocations=phrase_structures(text,getattr(ev,'collocation_evidence',{}))
        if collocations:
            p=collocations[0];row['family']='COLLOCATION';pid=p['phraseIds'][0]
            row['phraseIds']=[pid];row['semanticLinks'].append(dict(confidence='PHRASE_EXACT',phraseId=pid))
            qualification['collocationIdentityEvidence']=dict(record=p['id'],expression=p['expression'],contextualSenseClaim=False)
    return promote(row,qualification)


def qualify_grammar(db,ev,row):
    c=row['content']
    if not re.match(r'^(He|She|It) ___\b',c['context']):return row
    if c['options']!=['are','is'] or c['canonical']!='is':return row
    grammarid=31 if c['context'].startswith('It ') else 9
    grammar=json.loads(db.execute('SELECT body FROM grammar WHERE id=?',(grammarid,)).fetchone()[0])
    if grammar['Grammatical Item'] not in {'he/she is','It is'}:raise ValueError('GRAMMAR_PROFILE_CHANGED')
    # The blank replaces present BE immediately after a singular subject.
    # No alternative tense or contraction is offered as a distractor.
    c.update(prompt='Choose the present-tense verb that agrees with the subject.',
             meaning=c['grammarRule'],cefr='A1',difficulty=1,difficultySource='CEFR_J_GRAMMAR_PROFILE',
             grammarProfile=grammar['ID'])
    row['sourceRefs']=[r for r in row['sourceRefs'] if r['source']!='cefrj-grammar']+[dict(source='cefrj-grammar',record=str(grammarid))]
    row['licenseRefs']=sorted(set(row['licenseRefs'])|{'LicenseRef-CEFR-J-Attribution'})
    ev.weak_links(row,[])
    return promote(row,dict(rule='SINGULAR_SUBJECT_PRESENT_BE_FINITE_CHOICES',profileId=grammar['ID'],validOptions=['is'],invalidOptions=['are']))


def qualified_phrases(db):
    records=[json.loads(b) for b, in db.execute('SELECT body FROM phrases ORDER BY id')]
    byfamily=defaultdict(list)
    for p in records:
        if leaks(p['meaning'],[p['expression']]):continue
        byfamily[p['family']].append(p)
    seen=set();rows=[]
    for family,pool in sorted(byfamily.items()):
        for p in pool:
            if p['expression'] in seen:continue
            # Closed choice: a named definition and lexical type constrain the
            # answer. Every distractor is a different typed phrase with a
            # distinct definition, disjoint headword, and low gloss overlap.
            tokens=lexical_tokens(p['meaning']);options=[p['expression']]
            for q in pool:
                if q['expression']==p['expression'] or q['expression'].split()[0]==p['expression'].split()[0]:continue
                qt=lexical_tokens(q['meaning'])
                if not tokens or not qt or len(tokens&qt)/len(tokens|qt)>.12:continue
                if p['expression'].split()[-1]==q['expression'].split()[-1]:continue
                options.append(q['expression'])
                if len(options)==4:break
            if len(options)!=4:continue
            seen.add(p['expression'])
            content=dict(expression=p['expression'],canonical=p['expression'],accepted=[],options=sorted(options),
                         prompt='Choose the expression for this source meaning.',context=p['meaning'],meaning=p['meaning'],
                         fragment=p['expression'].rsplit(' ',1)[0]+' ___',senseId=p['id'],
                         verb=p['verb'],particle=p['particle'],cefr='UNKNOWN',difficultySource='ESTIMATED',difficulty=3,
                         attribution=p['attribution'],licenseId=p['licenseId'],shareAlike=True)
            row=candidate('REFLEX',family,p['expression'],content,[],[dict(source='kaikki',record=p['id'],url=p['attribution'])],['CC-BY-SA-4.0'])
            row.update(senseIds=[p['id']],phraseIds=[p['phraseId']],shard=p['shard'],
                       semanticLinks=[dict(confidence='PHRASE_EXACT',phraseId=p['phraseId'],senseId=p['id'])])
            rows.append(promote(row,dict(rule='TYPED_ENTRY_DEFINITION_CLOSED_CHOICES',typeEvidence=p['typeEvidence'],
                                        sourceFingerprint=p['fingerprint'],excludedFields=['examples','quotations','translations'])))
    return rows


def main():
    stats=Counter(); counts=Counter()
    with closing(sqlite3.connect(WORK)) as db:
        if db.execute("SELECT value FROM manifest WHERE key='sourceLockSha256'").fetchone()[0]!=sha256(LOCK):raise ValueError('STALE_WORKING_SOURCE_LOCK')
        ev=LexicalEvidence(db)
        ev.phrase_evidence=defaultdict(list)
        ev.collocation_evidence=defaultdict(list)
        for body, in db.execute("SELECT body FROM candidates WHERE mode='REFLEX' AND family='COLLOCATION' AND confidence='HIGH_CONFIDENCE_SOURCE_BACKED' ORDER BY id"):
            r=json.loads(body);r['expression']=r['content']['expression'];ev.collocation_evidence[r['expression']].append(r)
        if db.execute("SELECT 1 FROM sqlite_master WHERE name='phrases'").fetchone():
            for body, in db.execute('SELECT body FROM phrases ORDER BY id'):
                p=json.loads(body);ev.phrase_evidence[p['expression']].append(p)
        ev.phrasal={w for w, in db.execute("SELECT DISTINCT expression FROM phrases WHERE family='PHRASAL_VERB'")} if db.execute("SELECT 1 FROM sqlite_master WHERE name='phrases'").fetchone() else set()
        phrase_rows=qualified_phrases(db) if db.execute("SELECT 1 FROM sqlite_master WHERE name='phrases'").fetchone() else []
        for row in phrase_rows:
            db.execute('INSERT OR REPLACE INTO candidates VALUES(?,?,?,?,?,?)',(row['id'],row['mode'],row['family'],row['confidence'],row['semanticHash'],json.dumps(row,sort_keys=True,ensure_ascii=False)))
        rows=[json.loads(b) for b, in db.execute('SELECT body FROM candidates ORDER BY id')]
        for row in rows:
            if row['mode']=='EXPLAIN' or row['mode']=='REFLEX' and row['family'] in {'SYNONYM','ANTONYM','WORD_FAMILY','PART_OF_SPEECH'}:
                row.update(confidence='SOURCE_BACKED_REVIEW_NEEDED',flags=['QUALIFICATION_NOT_ESTABLISHED'])
            if row['mode']=='EXPLAIN':row=qualify_explain(ev,row,stats)
            elif row['mode']=='REFLEX' and row['family'] in {'SYNONYM','ANTONYM','WORD_FAMILY'}:row=qualify_relation(ev,row)
            elif row['mode']=='REFLEX' and row['family']=='PART_OF_SPEECH':row=qualify_pos(db,ev,row)
            elif row['mode']=='REFLEX' and row['family']=='GRAMMAR_TRAP':row=qualify_grammar(db,ev,row)
            elif row['mode']=='REORDER':
                ev.weak_links(row,[normalized(t.get('lemma') or t['text']) for t in row['content']['annotation']])
                row=qualify_reorder(ev,row)
            elif row['mode']=='REFLEX' and row['family'] in {'LETTER_SCRAMBLE','MISSING_LETTER','SPELLING_CORRECTION','SPELLING_CHOICE'}:
                ev.weak_links(row,[row['content'].get('lemma','')])
            row['fingerprint']=fingerprint(row)
            db.execute('UPDATE candidates SET family=?,confidence=?,body=? WHERE id=?',(row['family'],row['confidence'],json.dumps(row,ensure_ascii=False,sort_keys=True),row['id']))
            if row['confidence']==HIGH:counts[row['mode']+':'+row['family']]+=1
        db.commit()
    write_json(EVIDENCE/'continuation/qualification.json',dict(highConfidence=dict(counts),diagnostics=dict(stats),humanApproved=0,productionActive=0))
    print(json.dumps(dict(counts)))


if __name__=='__main__':main()
