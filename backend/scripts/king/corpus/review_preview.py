"""Create fixed samples of runtime-qualified content and separate ambiguity cases."""
from collections import Counter,defaultdict
from contextlib import closing
import html,json,random,sqlite3
from normalize import WORK
from sources import EVIDENCE,ROOT,write_json
from qualify import structural_labels

def main():
    with closing(sqlite3.connect(WORK.as_uri()+'?mode=ro',uri=True)) as db:
        rows=[json.loads(b) for b, in db.execute("SELECT body FROM candidates ORDER BY id")]
    qualified=[r for r in rows if r['confidence']=='HIGH_CONFIDENCE_SOURCE_BACKED']
    rng=random.Random(20261004);buckets=defaultdict(list)
    for row in qualified:buckets[(row['mode'],row['family'])].append(row)
    samples=[]
    for (mode,family),pool in sorted(buckets.items()):samples.extend(rng.sample(pool,min(len(pool),15 if mode=='REFLEX' else 10 if mode!='EXPLAIN' else 80)))
    ambiguous=[r for r in rows if r['mode']=='REORDER' and r['confidence']!='HIGH_CONFIDENCE_SOURCE_BACKED']
    ambiguity_samples=rng.sample(ambiguous,min(30,len(ambiguous)))
    links=Counter(l['confidence'] for r in qualified for l in r.get('semanticLinks',[]))
    concept_modes=defaultdict(set);phrase_modes=defaultdict(set)
    for r in qualified:
        for l in r.get('semanticLinks',[]):
            if l['confidence']=='EXACT_SENSE':concept_modes[l['conceptId']].add(r['mode'])
            if l['confidence']=='PHRASE_EXACT':phrase_modes[l['phraseId']].add(r['mode'])
    cefr={}
    for mode in ('REORDER','REFLEX','EXPLAIN','CONQUEST'):
        pool=[r for r in qualified if r['mode']==mode]
        cefr[mode]=dict(levels=dict(Counter(r['content'].get('cefr','UNKNOWN') for r in pool)),
                       evidence=dict(Counter(r['content'].get('difficultySource','UNKNOWN') for r in pool)))
    signatures=defaultdict(list)
    for r in qualified:
        if r['mode']=='REORDER':signatures[' '.join(sorted(t.get('lemma') or t['text'].lower() for t in r['content']['annotation'] if t['text'].isalpha()))].append(r['id'])
    summary=dict(highConfidence=dict(Counter(r['mode'] for r in qualified)),families=dict(Counter(r['family'] for r in qualified if r['mode']=='REFLEX')),
                 categories=dict(Counter(r['family'] for r in qualified if r['mode']=='REORDER')),cefr=cefr,semanticLinks=dict(links),
                 exactCrossModeConcepts=sum(len(v)>1 for v in concept_modes.values()),crossModePhrases=sum(len(v)>1 for v in phrase_modes.values()),
                 distinctPhraseIds=len(phrase_modes),distinctConceptIds=len(concept_modes),
                 qualifiedNearDuplicateClusters=[ids for ids in signatures.values() if len(ids)>1],
                 ambiguityQuarantined=len(ambiguous),acceptedAlternativeItems=sum(bool(r['content'].get('accepted')) for r in qualified if r['mode']=='REORDER'),
                 structuralLabels=dict(Counter(label for r in qualified if r['mode']=='REORDER' for label in structural_labels(r['content']['sourceText'],r['content']['annotation']))),
                 sampleCounts=dict(Counter(r['mode'] for r in samples)),humanApproved=0,productionActive=0,
                 warnings=['Distribution goals are not all met; hard floors and category cap are separate gates.',
                           'Estimated difficulty is not direct CEFR. Unknown CEFR stays UNKNOWN.',
                           'Capitalized OEWN senses and explicitly specialist-domain Explain senses are excluded; source glosses can still be formal.',
                           'Unproven separable particle orders remain quarantined. Qualified phrasal verb chunks cannot be split.',
                           'Exact phrase occurrence links do not assert a contextual phrase sense.',
                           'Closed phrase choices use exact typed source meanings and conservative distractors; human pedagogy review remains pending.',
                           'Token-bag near-duplicate clusters are review hints, not proof of semantic equivalence.'])
    out=EVIDENCE/'review';out.mkdir(exist_ok=True)
    write_json(out/'runtime-summary.json',summary);write_json(out/'runtime-samples.json',samples);write_json(out/'ambiguity-samples.json',ambiguity_samples)
    def card(r):
        c=r['content'];refs=' '.join(html.escape(str(x)) for x in r['sourceRefs'])
        return '<article><h2>'+html.escape(r['mode']+' / '+r['family'])+'</h2><p>'+html.escape(r['id'])+'</p><p>'+html.escape(c.get('prompt',c.get('target',c.get('canonical','Board'))))+'</p><details><summary>Content and qualification evidence</summary><pre>'+html.escape(json.dumps(r,ensure_ascii=False,indent=2))+'</pre></details><p>'+refs+'</p><label>Owner decision (blank): <input></label><label>Comment: <textarea></textarea></label></article>'
    notice=(ROOT/'backend/src/main/resources/data/king/corpus/ATTRIBUTION.md').read_text(encoding='utf-8')
    output='<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>King qualified runtime review</title><style>body{font:16px system-ui;max-width:1000px;margin:auto;padding:24px}pre{white-space:pre-wrap;overflow-wrap:anywhere}article{border-top:1px solid #aaa;padding:20px 0}label{display:block;margin-top:12px}textarea{display:block;width:95%}</style><h1>King review preview</h1><p>Fixed seed 20261004. Every primary sample is from the qualified runtime population. Human approval and production active: zero. Form fields are temporary review notes and are not an approval manifest.</p><details open><summary>Counts, categories, CEFR and warnings</summary><pre>'+html.escape(json.dumps(summary,ensure_ascii=False,indent=2))+'</pre></details><details><summary>Attribution and licenses</summary><pre>'+html.escape(notice)+'</pre></details>'+''.join(card(r) for r in samples)+'<h1>Quarantined ambiguity examples</h1>'+''.join(card(r) for r in ambiguity_samples)
    (out/'runtime-review.html').write_text(output,encoding='utf-8')
    print(json.dumps(summary,ensure_ascii=False))

if __name__=='__main__':main()
