"""Isolated queue contract tests; the tiny validator is a controlled fixture, not linguistic QA."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

repo = Path(__file__).resolve().parents[2]
live = repo / 'docs/grammar/REVIEW-QUEUE.json'
before = live.read_bytes()
root = Path(tempfile.mkdtemp(prefix='ecgr-review-queue-'))
(root / 'scripts/grammar').mkdir(parents=True)
(root / 'docs/grammar').mkdir(parents=True)
(root / 'backend/src/main/resources/grammar/topics/test').mkdir(parents=True)
shutil.copy2(repo / 'scripts/grammar/claim-review.py', root / 'scripts/grammar/claim-review.py')
(root / 'scripts/grammar/validate.mjs').write_text("process.exit(process.argv.some(x=>x.includes('broken'))?1:0);", encoding='utf-8')
queue = root / 'docs/grammar/REVIEW-QUEUE.json'
authors = root / 'docs/grammar/QUEUE.json'
def write(path, data):
    path.write_text(json.dumps(data), encoding='utf-8')
def topic(name):
    p = root / ('backend/src/main/resources/grammar/topics/test/' + name + '.json')
    write(p, {'slug': name, 'version': 1})
    return p
def job(name, **fields):
    return dict(id=name, state='queued', owner=None, topics=['test/' + name], report=name+'.md', **fields)
def call(owner, *args):
    return subprocess.run([sys.executable, str(root / 'scripts/grammar/claim-review.py'), owner, *args], capture_output=True, text=True, encoding='utf-8')
def claim(owner, *args):
    r = call(owner, *args); assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)['job']
def report(name):
    digest = hashlib.sha256(topic(name).read_bytes()).hexdigest()
    (root / 'docs/grammar' / (name+'.md')).write_text('Fixture review final hash '+digest, encoding='utf-8')

topic('alpha'); topic('beta')
write(authors, {'jobs':[{'id':'author-gamma','state':'claimed'}]})
write(queue, {'jobs':[job('alpha',ineligibleOwners=['author-a']),job('beta'),job('gamma',afterAuthorJobs=['author-gamma'])]})
assert claim('author-a')['id']=='beta'
assert claim('reviewer')['id']=='alpha'
assert claim('reviewer')['id']=='alpha', 'retry must keep same assignment'
assert call('author-a','--finish','alpha').returncode != 0, 'foreign owner refused'
assert call('reviewer','--finish','alpha').returncode != 0, 'report required'
report('alpha'); assert claim('reviewer','--finish','alpha') is None, 'unfinished author batch blocks review'
write(authors, {'jobs':[{'id':'author-gamma','state':'completed'}]})
assert claim('reviewer') is None, 'missing source still blocks review'
topic('gamma'); assert claim('reviewer')['id']=='gamma'
snap=queue.read_bytes(); claim('observer','--peek'); assert queue.read_bytes()==snap, 'peek must not mutate'
data=json.loads(queue.read_text()); data['jobs'] += [job('delta'),job('epsilon')]; write(queue,data)
topic('delta'); topic('epsilon')
workers=[subprocess.Popen([sys.executable,str(root/'scripts/grammar/claim-review.py'),w],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8') for w in ['one','two']]
assigned=[]
for p in workers:
    out,err=p.communicate(); assert p.returncode==0,err; assigned.append(json.loads(out)['job']['id'])
assert set(assigned)=={'delta','epsilon'}, 'simultaneous claims remain distinct'
data=json.loads(queue.read_text());data['jobs'].append(job('broken'));write(queue,data);report('broken')
assert claim('validator-check')['id']=='broken'
assert call('validator-check','--finish','broken').returncode!=0, 'structural rejection blocks review completion'
assert next(j for j in json.loads(queue.read_text())['jobs'] if j['id']=='broken')['state']=='claimed'
assert live.read_bytes()==before,'tests must not claim real work'
print('PASS: author exclusion, readiness, report/hash gate, owner isolation, idempotency, concurrent claims, structural refusal, read-only peek.')
print('Isolated evidence:',root)
