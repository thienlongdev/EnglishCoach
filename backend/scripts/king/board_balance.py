"""Offline exhaustive board metrics and strategic score-composition stress.
No production claims. The reference simulation is independent of runtime engines;
engine simulations are separately recorded by KingPhase4QualificationTest.
"""
import json
import random
from pathlib import Path
import generate_boards as g


def game(paths, seed, moves, cap=None, first=0):
    rng=random.Random(seed);remaining=dict(paths);owners=[-1]*25;points=[0,0]
    for turn in range(min(moves,len(paths))):
        player=(turn+first)%2
        # Compare territorial greedy against random word spam; same legal corpus.
        if player==0:
            word=max(remaining,key=lambda w:(sum(owners[i]!=player for i in remaining[w])*2+(5 if 12 in remaining[w] else 0),len(w),w))
        else: word=rng.choice(sorted(remaining))
        path=remaining.pop(word);points[player]+=min(4,len(word)-2)
        for cell in path:owners[cell]=player
    word=sum(min(p,cap) if cap is not None else p for p in points)
    territories=[owners.count(i)*2 for i in range(2)];throne=[5 if owners[12]==i else 0 for i in range(2)]
    scores=[(min(points[i],cap) if cap is not None else points[i])+territories[i]+throne[i] for i in range(2)]
    total=word+sum(territories)+sum(throne)
    return dict(word=word/total*100,territory=sum(territories)/total*100,throne=sum(throne)/total*100,
                strategicWin=scores[0]>scores[1],scores=scores)


def main():
    boards=json.loads(g.OUTPUT.read_text());trie=g.trie(g.corpus());report=[]
    for b in boards:
        paths=g.solve(b['letters'],trie);q=g.metrics(paths)
        assert q==b['qualityMetrics'] and g.quality(q,paths)
        top=sum(q['cellCoverage'][:10]);bottom=sum(q['cellCoverage'][15:]);bias=abs(top-bottom)/(top+bottom)
        simulations={}
        for moves in (30,60,120,180):
            before=[game(paths,n,moves) for n in range(20)]
            after=[game(paths,n,moves,20) for n in range(20)]
            reverse=[game(paths,n,moves,20,1) for n in range(20)]
            simulations[str(moves)]=dict(before={key:sum(x[key] for x in before)/20 for key in ('word','territory','throne','strategicWin')},
                                         wordCap20={key:sum(x[key] for x in after)/20 for key in ('word','territory','throne','strategicWin')},
                                         strategicWinWhenActsSecond=sum(x['strategicWin'] for x in reverse)/20)
        report.append(dict(id=b['id'],fingerprint=b['fingerprint'],playableWords=len(paths),threeLetterCount=sum(len(w)==3 for w in paths),
                           fourLetterCount=sum(len(w)==4 for w in paths),fivePlusCount=sum(len(w)>=5 for w in paths),throneWords=q['throneWords'],
                           averagePathLength=sum(map(len,paths.values()))/len(paths),cellCoverage=q['cellCoverage'],openingRegionCoverageBias=bias,
                           simulations=simulations))
    out=g.ROOT/'docs/king-of-english/phase4/board-balance.json'
    out.write_text(json.dumps(dict(boards=report,method='All 50 boards, exhaustive read-only corpus solver; 20 seeds per move budget, alternating greedy territory versus random word selection and reversed first action. No geographic opening restriction exists in Conquest; coverage bias is a diagnostic, not a human first-player estimate.',productionCapacityClaim=False),indent=2)+'\n')
    print(json.dumps(dict(boards=len(report),maxRegionBias=max(x['openingRegionCoverageBias'] for x in report),
                         stress180WordPercentBefore=sum(x['simulations']['180']['before']['word'] for x in report)/len(report),
                         stress180WordPercentWithCap20=sum(x['simulations']['180']['wordCap20']['word'] for x in report)/len(report))))


if __name__=='__main__':main()
