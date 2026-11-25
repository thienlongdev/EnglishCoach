"""Offline solver evidence for near-cap retained state; never shipped to clients."""
from contextlib import closing
import json,sqlite3
from build_boards import eligible_lexicon,trie,solve
from normalize import WORK
from sources import EVIDENCE,write_json

def main():
    with closing(sqlite3.connect(WORK.as_uri()+'?mode=ro',uri=True)) as db:
        root=trie(eligible_lexicon(db));result={}
        for body, in db.execute("SELECT body FROM candidates WHERE mode='CONQUEST' ORDER BY id"):
            row=json.loads(body);paths=solve(row['content']['letters'],root)
            result[row['id']]=sorted(paths)[:179]
    write_json(EVIDENCE/'continuation/preview-board-memory-words.json',result)
    print('SOURCE_VALID_BOARDS',len(result),'MIN_RETAINED_WORDS',min(map(len,result.values())))

if __name__=='__main__':main()
