"""Read-only diagnostics for a blocked build; never promotes or approves content."""
from collections import Counter, defaultdict
from contextlib import closing
import json
import re
import sqlite3
from statistics import median
from normalize import WORK, normalized
from sources import EVIDENCE, write_json


def spread(values):
    return dict(min=min(values), median=median(values), max=max(values)) if values else None


def main():
    categories=Counter(); lengths=Counter(); samples=Counter(); levels=defaultdict(Counter)
    board=defaultdict(list); links=defaultdict(set); evidence=Counter(); sense_ids=0; phrase_ids=0
    with closing(sqlite3.connect(WORK.as_uri()+'?mode=ro', uri=True)) as db:
        concepts={c:dict(definition=d, examples=json.loads(e), relations=json.loads(r))
                  for c,d,e,r in db.execute('SELECT id,definition,examples,relations FROM concepts')}
        aliases=defaultdict(set)
        for cid,word in db.execute('SELECT s.concept_id,l.normalized_lemma FROM senses s JOIN lexemes l ON l.id=s.lexeme_id'):
            aliases[cid].add(word)
        forms=sum(len(json.loads(f)) for f, in db.execute('SELECT forms FROM lexemes'))
        multiword=db.execute("SELECT count(*) FROM lexemes WHERE normalized_lemma LIKE '% %'").fetchone()[0]
        for body, in db.execute('SELECT body FROM candidates ORDER BY id'):
            row=json.loads(body); c=row['content']; mode=row['mode']
            levels[mode][c.get('cefr','UNKNOWN')]+=1
            sense_ids+=bool(row['senseIds']); phrase_ids+=bool(row['phraseIds'])
            for cid in row['conceptIds']:links[cid].add(mode)
            if mode=='REORDER':
                categories[row['family']]+=1;lengths[len(c['tokens'])]+=1
            elif mode=='EXPLAIN':
                clues=c['progressiveClues']; target=c['target']; cid=row['conceptIds'][0]
                if len(clues)==3 and len(set(map(normalized,clues)))==3:evidence['threeDistinctStrings']+=1
                source_aliases=aliases[cid]-{target}
                if any(re.search(r'\b'+re.escape(a)+r'\b',clue,re.I) for a in source_aliases for clue in clues):
                    evidence['sourceSynonymLeakageCandidates']+=1
                if not {'THREE_USEFUL_CLUES_NOT_ESTABLISHED','TARGET_LEAKAGE'} & set(row['flags']):
                    evidence['withoutExistingMissingOrTargetLeakFlags']+=1
                evidence['acceptedAliases']+=len(c['acceptedAliases'])
                evidence['withForbiddenForms']+=bool(c.get('forbiddenForms'))
            elif mode=='CONQUEST':
                m=c['qualityMetrics']
                for key in ('playableWords','shortWords','longWords','throneWords','minCellCoverage'):
                    board[key].append(m[key])
                for key in ('sixPlus','averagePathLength','rareWordDependence','openingBias'):
                    board[key].append(c[key])
                board['echoCount'].append(len(c['echoCandidates']))
        # Examine every learner-bound sense, not just the first sense used by derive.py.
        learner={(w,p) for w,p in db.execute('SELECT lemma,pos FROM profiles')}
        possible=set()
        for word,pos,cid in db.execute('SELECT l.normalized_lemma,l.pos,s.concept_id FROM senses s JOIN lexemes l ON l.id=s.lexeme_id'):
            if (word,pos) not in learner:continue
            concept=concepts[cid]
            hyper=[concepts[r['target']]['definition'] for r in concept['relations']
                   if r['relType']=='hypernym' and r['target'] in concepts]
            example=[e for e in concept['examples'] if re.search(r'\b'+re.escape(word)+r'\b',e,re.I)]
            if hyper and example and len(set([hyper[0], example[0], concept['definition']]))==3:possible.add(word)
        sample_rows=json.loads((EVIDENCE/'review/samples.json').read_text(encoding='utf-8'))
        for row in sample_rows:samples[row['mode']+':'+row['family']]+=1
    report=dict(reorderCategories=dict(categories),reorderTokenLengths=dict(sorted(lengths.items())),
        largestReorderCategoryPercent=100*max(categories.values())/sum(categories.values()),
        cefr=dict((mode,dict(counts)) for mode,counts in levels.items()),
        explicitWordNetForms=forms,multiwordLexemes=multiword,typedPhraseRecords=0,
        explainEvidence=dict(evidence),targetsWithThreeStringsInAnyLearnerSense=len(possible),
        explainAuditPolicy='String availability is not useful clue progression, source sense selection, or linguistic approval. Source synonym leakage is additional diagnostic evidence; no automatic promotion.',
        boardMetrics={k:spread(v) for k,v in board.items()},
        sharedConcepts=sum(len(modes)>1 for modes in links.values()),
        conceptModePairs=dict(Counter(','.join(sorted(modes)) for modes in links.values() if len(modes)>1)),
        recordsWithSenseIds=sense_ids,recordsWithPhraseIds=phrase_ids,
        conceptLinkCaveat='Reorder links include all WordNet senses for observed lemmas without word-sense disambiguation. These are possible associations, not verified contextual sense links.',
        samples=dict(samples),sampleTotal=len(sample_rows),
        unimplemented=['reorder constrained-order or alternative validator','sense-aware clue progression and forbidden-form validator',
            'typed phrase ingestion and separated license shard','semantic sense and phrase linkage verification',
            'four runtime corpus providers','server review-preview channel','new corpus owner-decision import',
            'cross-mode and cross-session cooldown','bounded recent-user cache','new corpus RAM and lookup measurements'])
    write_json(EVIDENCE/'diagnostics.json',report)
    print(json.dumps(report))


if __name__=='__main__':main()
