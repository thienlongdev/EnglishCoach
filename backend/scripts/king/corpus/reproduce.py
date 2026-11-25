"""Repeat candidate derivation and compare ordered full logical records."""
from contextlib import closing
import hashlib
import sqlite3
import subprocess
import sys
from pathlib import Path
from normalize import WORK
from sources import EVIDENCE, ROOT, write_json


def logical_hash():
    digest=hashlib.sha256()
    with closing(sqlite3.connect(WORK.as_uri()+'?mode=ro', uri=True)) as db:
        for body, in db.execute('SELECT body FROM candidates ORDER BY id'):
            digest.update(body.encode('utf-8')); digest.update(b'\n')
    return digest.hexdigest()


def main():
    before=logical_hash()
    artifact=ROOT/'backend/src/main/resources/data/king/corpus/manifest.json'
    import json
    build_before=json.loads(artifact.read_text(encoding='utf-8'))['contentBuildSha256']
    commands=[]
    with (EVIDENCE/'repeat-derive-execution.txt').open('w',encoding='utf-8') as log:
        for script in ('derive.py','ingest_phrases.py','mine_collocations.py','qualify.py','build_runtime.py'):
            command=[sys.executable,'-X','utf8',str(Path(__file__).parent/script)]
            log.write('\nCOMMAND: '+str(command)+'\n');log.flush()
            result=subprocess.run(command,cwd=ROOT,stdout=log,stderr=subprocess.STDOUT)
            commands.append(dict(command=command,exitCode=result.returncode))
            if result.returncode:break
    after=logical_hash()
    build_after=json.loads(artifact.read_text(encoding='utf-8'))['contentBuildSha256']
    passed=result.returncode==0 and before==after and build_before==build_after
    write_json(EVIDENCE/'reproducibility.json',dict(
        method='Repeat existing derivation, raw typed phrase ingestion, full OANC collocation mining, qualification and runtime packaging from verified cached sources; normalization evidence retained separately; boards preserved.',
        before=before, after=after,buildBefore=build_before,buildAfter=build_after,commands=commands,exitCode=result.returncode, passResult=passed))
    print('REPEAT_DERIVATION',result.returncode,passed)
    if not passed:raise SystemExit(1)


if __name__=='__main__':main()
