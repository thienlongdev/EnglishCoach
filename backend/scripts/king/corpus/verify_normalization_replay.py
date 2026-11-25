"""Re-run the original raw adapters in an isolated verification DB and compare truth tables."""
from contextlib import closing
import hashlib,json,sqlite3,sys
import normalize,mine_oanc
from sources import EVIDENCE,ROOT,write_json

TABLES=('concepts','lexemes','senses','profiles','grammar','spelling','documents','sentences','frequency','sentence_annotations','collocations')

def hashes(path):
    result={}
    with closing(sqlite3.connect(path.as_uri()+'?mode=ro',uri=True)) as db:
        for table in TABLES:
            columns=[r[1] for r in db.execute('PRAGMA table_info('+table+')')]
            digest=hashlib.sha256();count=0
            for row in db.execute('SELECT * FROM '+table+' ORDER BY '+','.join('"'+c+'"' for c in columns)):
                digest.update(json.dumps(row,ensure_ascii=False,separators=(',',':')).encode());digest.update(b'\n');count+=1
            result[table]=dict(rows=count,sha256=digest.hexdigest())
    return result

def main():
    original=normalize.WORK;target=ROOT/'.cache/king-corpus/normalization-replay.sqlite'
    out=EVIDENCE/'continuation/raw-replay';out.mkdir(parents=True,exist_ok=True)
    normalize.EVIDENCE=out;sys.argv=['normalize.py','--out',str(target)];normalize.main()
    mine_oanc.WORK=target;mine_oanc.EVIDENCE=out;mine_oanc.main()
    before=hashes(original);after=hashes(target)
    passed=before==after
    write_json(out/'canonical-comparison.json',dict(before=before,after=after,passResult=passed,
        method='Same original normalize.py and mine_oanc.py raw adapters, checksum-verified cached sources, separate verification DB; original canonical tables and Conquest boards untouched. Typed phrase raw replay and final candidate/artifact replay are independently retained.'))
    print('RAW_CANONICAL_REPLAY',passed)
    if not passed:raise SystemExit(1)

if __name__=='__main__':main()
