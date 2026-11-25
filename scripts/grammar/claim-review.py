"""Claim/finish an exclusive independent model-review batch; never grant academic acceptance.

Usage: python scripts/grammar/claim-review.py OWNER [--finish JOB] [--peek]
After finishing a report, --finish validates files/hashes and assigns the next eligible batch.
Author batches must finish first. Authors cannot claim reviews of their own content.
"""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
QUEUE = ROOT / 'docs/grammar/REVIEW-QUEUE.json'
CONTENT = ROOT / 'backend/src/main/resources/grammar/topics'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('owner')
parser.add_argument('--finish')
parser.add_argument('--peek', action='store_true')
args = parser.parse_args()
if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', args.owner):
    parser.error('Use a stable worker identity.')

def read_queue():
    return json.loads(QUEUE.read_text(encoding='utf-8'))

def topic_file(name):
    if not re.fullmatch(r'[a-z0-9-]+/[a-z0-9-]+', name):
        raise ValueError('Unsafe topic identity')
    return CONTENT / (name + '.json')

def fingerprint(name):
    raw = topic_file(name).read_bytes()
    return {'version': json.loads(raw)['version'], 'sha256': hashlib.sha256(raw).hexdigest()}

@contextmanager
def queue_lock():
    with QUEUE.with_suffix('.review-lock').open('a+b') as lock:
        lock.seek(0, os.SEEK_END)
        if not lock.tell():
            lock.write(b'0'); lock.flush()
        deadline = time.monotonic() + 30
        while True:
            try:
                lock.seek(0)
                if os.name == 'nt':
                    import msvcrt
                    msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise TimeoutError('Review queue busy; retry without changing ownership.')
                time.sleep(0.1)
        try:
            yield
        finally:
            lock.seek(0)
            if os.name == 'nt':
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)

reviewed = None
if args.finish:
    snapshot = read_queue()
    previous = next((j for j in snapshot['jobs'] if j['id'] == args.finish), None)
    if not previous or previous.get('owner') != args.owner or previous['state'] not in ('claimed', 'model-reviewed'):
        parser.error('The completed review must belong to this worker.')
    if previous['state'] != 'model-reviewed':
        report = previous['report']
        if not re.fullmatch(r'[A-Za-z0-9_-]+\.md', report):
            parser.error('Unsafe report name')
        report_text = (ROOT / 'docs/grammar' / report).read_text(encoding='utf-8').lower()
        reviewed = {}
        for name in previous['topics']:
            result = subprocess.run(['node', str(ROOT / 'scripts/grammar/validate.mjs'), '--strict', name], cwd=ROOT,
                                    capture_output=True, text=True, encoding='utf-8')
            if result.returncode:
                sys.stderr.write(result.stdout + result.stderr)
                sys.exit(result.returncode)
            reviewed[name] = fingerprint(name)
            if reviewed[name]['sha256'] not in report_text:
                parser.error('Report lacks final SHA256 for ' + name)

with queue_lock():
    data = read_queue()
    if args.finish and reviewed is not None:
        previous = next(j for j in data['jobs'] if j['id'] == args.finish)
        if previous.get('owner') != args.owner or previous['state'] != 'claimed':
            raise RuntimeError('Ownership changed; review queue unchanged.')
        if any(fingerprint(name) != value for name, value in reviewed.items()):
            raise RuntimeError('Content changed during final validation; review again before finishing.')
        if not args.peek:
            previous.update(state='model-reviewed', reviewedVersions=reviewed,
                            reviewedAt=datetime.now(timezone.utc).isoformat())
    author_path = ROOT / 'docs/grammar/QUEUE.json'
    author_jobs = {j['id']: j['state'] for j in json.loads(author_path.read_text(encoding='utf-8'))['jobs']}
    claimed_topics = {t for j in data['jobs'] if j['state'] == 'claimed' for t in j['topics']}
    def eligible(job):
        return (job['state'] == 'queued'
                and args.owner not in job.get('ineligibleOwners', [])
                and not claimed_topics.intersection(job['topics'])
                and all(author_jobs.get(j) == 'completed' for j in job.get('afterAuthorJobs', []))
                and all(topic_file(name).is_file() for name in job['topics']))
    job = next((j for j in data['jobs'] if j['state'] == 'claimed' and j.get('owner') == args.owner
                and (not args.peek or j['id'] != args.finish)), None)
    if job is None:
        job = next((j for j in data['jobs'] if eligible(j)), None)
    if job and not args.peek:
        job['state'] = 'claimed'; job['owner'] = args.owner
    if not args.peek:
        temp = QUEUE.with_suffix('.review-tmp')
        temp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        os.replace(temp, QUEUE)
    print(json.dumps({'job': job, 'queued': sum(j['state'] == 'queued' for j in data['jobs']),
                      'peek': args.peek, 'statusMeaning': 'model review only;not human or academic acceptance'}, ensure_ascii=False))
