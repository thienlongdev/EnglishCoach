"""Read-only source-binding audit and deliberate Explain mismatch/leak probes."""
from collections import Counter
from contextlib import closing
import copy,json,sqlite3
from normalize import WORK,normalized
from qualify import LexicalEvidence,leaks,lexical_tokens
from sources import EVIDENCE,write_json

def explain_errors(row,ev):
    c=row['content'];proof=row.get('qualification',{});s=ev.senses.get(c.get('senseId'));errors=[]
    if not s or s['id']!=proof.get('senseId') or not any(ref['source']=='oewn' and ref['record']==s['id'] for ref in row['sourceRefs']):return ['SENSE_MISMATCH']
    concept=ev.concepts[s['concept']];clues=c['progressiveClues'];aliases=c['acceptedAliases'];forms=c['forbiddenForms']
    if s['word']!=c['target'] or s['originalLemma']!=s['originalLemma'].lower():errors.append('PROPER_OR_TARGET_MISMATCH')
    if any(r['relType']=='domain_topic' for r in concept['relations']):errors.append('SPECIALIST_DOMAIN')
    hypers=[r['target'] for r in concept['relations'] if r['relType']=='hypernym' and r['target'] in ev.concepts]
    if len(clues)!=3:return errors+['THREE_CLUES_REQUIRED']
    if clues[2]!=concept['definition'] or clues[0] not in [ev.concepts[h]['definition'] for h in hypers]:errors.append('SENSE_MISMATCH')
    n=proof['excerptWordCount']
    if clues[1]!=' '.join(concept['definition'].split()[:n])+' …':errors.append('EXCERPT_MISMATCH')
    if any(leaks(clue,forms) for clue in clues):errors.append('TARGET_ALIAS_OR_SPELLING_LEAK')
    if not {c['target'],*aliases,*s['forms']}<=set(forms):errors.append('MISSING_FORBIDDEN_FORM')
    for alias in aliases:
        if not any(x['word']==alias and x['originalLemma']==x['originalLemma'].lower() for x in concept['senses']):errors.append('ALIAS_SENSE_MISMATCH')
    sizes=proof['candidateSetSizes']
    if not sizes[2]<=sizes[1]<sizes[0] or len(set(map(normalized,clues)))!=3 or not lexical_tokens(clues[2])-lexical_tokens(clues[1]):errors.append('PROGRESSION_MISMATCH')
    return errors

def main():
    with closing(sqlite3.connect(WORK.as_uri()+'?mode=ro',uri=True)) as db:
        ev=LexicalEvidence(db);rows=[json.loads(b) for b, in db.execute("SELECT body FROM candidates WHERE mode='EXPLAIN' AND confidence='HIGH_CONFIDENCE_SOURCE_BACKED' ORDER BY id")]
    errors=Counter(error for row in rows for error in explain_errors(row,ev));probes=Counter()
    for row in rows:
        wrong=copy.deepcopy(row);wrong['content']['progressiveClues'][2]='A definition from an unrelated source sense.'
        assert 'SENSE_MISMATCH' in explain_errors(wrong,ev);probes['senseMismatchRejected']+=1
        for form in [row['content']['target'],*row['content']['acceptedAliases']]:
            wrong=copy.deepcopy(row);wrong['content']['progressiveClues'][0]='A clue containing '+form+'.'
            assert 'TARGET_ALIAS_OR_SPELLING_LEAK' in explain_errors(wrong,ev);probes['targetOrAliasLeakRejected']+=1
    result=dict(targetsAudited=len(rows),errors=dict(errors),probes=dict(probes),passResult=not errors)
    write_json(EVIDENCE/'continuation/source-binding-audit.json',result);print(json.dumps(result))
    if errors:raise SystemExit(1)

if __name__=='__main__':main()
