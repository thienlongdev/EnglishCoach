"""Deterministic boards from the licensed learner/frequency/spelling intersection."""
import argparse
from collections import Counter
from contextlib import closing
import json
from pathlib import Path
import random
import re
import sqlite3
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
from generate_boards import trie, solve, metrics
from derive import candidate
from normalize import WORK
from sources import EVIDENCE, write_json


def symmetry(letters):
    variants=[];grid=[letters[i:i+5] for i in range(0,25,5)]
    for _ in range(4):
        variants.extend([''.join(sum(grid,[])),''.join(sum([row[::-1] for row in grid],[]))])
        grid=[list(row) for row in zip(*grid[::-1])]
    return min(variants)


def eligible_lexicon(db):
    return {w for w, in db.execute('''SELECT DISTINCT l.normalized_lemma FROM lexemes l
        JOIN spelling s ON s.word=l.normalized_lemma
        JOIN frequency f ON f.word=l.normalized_lemma WHERE f.count>=5 AND f.documents>=3''')
        if re.fullmatch('[a-z]{3,8}',w) and not re.search('fuck|shit|nigger|sexual|suicide|rape|murder',w)
        and w not in {'sex','penis','vagina','porn','semen','cunt','cock','dick','ass','bitch','slut','whore'}}


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--count',type=int,default=150)
    parser.add_argument('--attempts',type=int,default=20000);args=parser.parse_args()
    if args.count<1 or args.attempts<1:parser.error('count and attempts must be positive')
    rejected=Counter();boards=[];layouts=set();distributions=Counter()
    with closing(sqlite3.connect(WORK)) as db:
        frequency=dict(db.execute('SELECT word,count FROM frequency'))
        eligible=eligible_lexicon(db)
        root=trie(eligible)
        weighted='AAAAAAAEEEEEEEEEEIIIIIOOOOOUUUUUNNNNNRRRRRRSSSSSSTTTTTTLLLLDDDDGGCCMMBBPPHHFFWWYYVK'
        for seed in range(100000,100000+args.attempts):
            rng=random.Random(seed);letters=[rng.choice(weighted) for _ in range(25)]
            layout=symmetry(letters);distribution=''.join(sorted(letters))
            if layout in layouts:rejected['SYMMETRY_DUPLICATE']+=1;continue
            if distributions[distribution]:rejected['LETTER_DISTRIBUTION_DUPLICATE']+=1;continue
            paths=solve(letters,root);m=metrics(paths)
            if m['playableWords']<150 or m['shortWords']<20 or m['longWords']<8 or m['throneWords']<8 or m['minCellCoverage']<2:
                rejected['BOARD_QUALITY']+=1;continue
            choices=sorted(paths,key=lambda w:(12 not in paths[w],-len(w),w))[:32]
            lengths=Counter(len(w) for w in paths)
            content=dict(letters=letters,seed=seed,qualityMetrics=m,
                lengthCounts=dict(lengths),sixPlus=sum(n for length,n in lengths.items() if length>=6),
                averagePathLength=sum(len(w) for w in paths)/len(paths),
                rareWordDependence=sum(frequency[w]<=10 for w in paths)/len(paths),
                rareWordPolicy='OANC written-token frequency <=10 (eligible minimum5); measured proportion of playable words',
                properNameDependence='OEWN_2025_COMMON_WORDS_ONLY; NOT_HUMAN_CERTIFIED',
                echoCandidates=[dict(word=w,path=list(paths[w])) for w in choices],
                openingBias=max(m['cellCoverage'])/sum(m['cellCoverage']))
            row=candidate('CONQUEST','BOARD',layout,content,[],
                [dict(source=s,record='eligible-lexicon-intersection') for s in ('oewn','oanc','scowl-us','scowl-gb')],
                ['CC-BY-4.0 AND WordNet','LicenseRef-OANC-Unrestricted','LicenseRef-ESDB-Permissive'],high=True)
            boards.append(row);layouts.add(layout);distributions[distribution]+=1
            if len(boards)%25==0:print('BOARDS '+str(len(boards)),flush=True)
            if len(boards)==args.count:break
        db.execute("DELETE FROM candidates WHERE mode='CONQUEST'")
        db.executemany('INSERT INTO candidates VALUES(?,?,?,?,?,?)',((r['id'],r['mode'],r['family'],r['confidence'],r['semanticHash'],json.dumps(r,sort_keys=True)) for r in boards))
        db.commit()
    write_json(EVIDENCE/'board-build.json',dict(boards=len(boards),eligibleLexicon=len(eligible),rejects=dict(rejected),attemptLimit=args.attempts,
        floor=args.count,floorPass=len(boards)>=args.count,symmetryDuplicates=0,distributionDuplicates=0,humanApproved=0,
        note='Eligible lexicon uses OEWN common-word release + SCOWL spelling roots + OANC frequency >=5 in >=3 documents. CEFR not inferred. Rare-word dependence is relative to that policy, not human naturalness.'))
    print(json.dumps(dict(boards=len(boards),eligibleLexicon=len(eligible),rejects=dict(rejected))))
    if len(boards)<args.count:raise SystemExit('BOARD_FLOOR_FAILED: no padding')


if __name__=='__main__':main()
