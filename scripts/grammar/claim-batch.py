"""Claim an exclusive queued author batch. Local authoring only; never touches topic content.

Usage: python scripts/grammar/claim-batch.py OWNER [--finish JOB] [--peek]
Finish validates the completed job before releasing it, then claims the next queued batch.
The initial/reserved batches in WORKERS.json must finish before using this queue.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
QUEUE = ROOT / 'docs/grammar/QUEUE.json'
CONTENT = ROOT / 'backend/src/main/resources/grammar/topics'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('owner')
parser.add_argument('--finish')
parser.add_argument('--peek', action='store_true')
args = parser.parse_args()
if not args.owner or len(args.owner) > 100:
    parser.error('Use a short stable worker name.')

# Validate before taking the short assignment lock; unrelated workers keep writing.
if args.finish:
    snapshot = json.loads(QUEUE.read_text(encoding='utf-8'))
    previous = next((j for j in snapshot['jobs'] if j['id'] == args.finish), None)
    if not previous or previous['owner'] != args.owner or previous['state'] not in ('claimed', 'completed'):
        parser.error('The finished job must belong to this worker.')
    for topic in previous['topics']:
        if not (CONTENT / (topic + '.json')).is_file():
            parser.error('Missing finished topic: ' + topic)
        result = subprocess.run(['node', str(ROOT / 'scripts/grammar/validate.mjs'), topic], cwd=ROOT, capture_output=True, text=True, encoding='utf-8')
        if result.returncode:
            sys.stderr.write(result.stdout + result.stderr)
            sys.exit(result.returncode)

with QUEUE.with_suffix('.claim-lock').open('a+b') as lock:
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
                raise TimeoutError('Author queue is busy; retry without changing ownership.')
            time.sleep(0.1)
    try:
        data = json.loads(QUEUE.read_text(encoding='utf-8'))
        if args.finish:
            previous = next(j for j in data['jobs'] if j['id'] == args.finish)
            if previous['owner'] != args.owner:
                raise RuntimeError('Ownership changed; no queue write performed.')
            if not args.peek:
                previous['state'] = 'completed'
        # A retry returns the same assignment rather than reserving a second batch.
        job = next((j for j in data['jobs'] if j['state'] == 'claimed' and j['owner'] == args.owner and (not args.peek or j['id'] != args.finish)), None)
        if job is None:
            job = next((j for j in data['jobs'] if j['state'] == 'queued'), None)
        if job is not None and not args.peek:
            job['state'] = 'claimed'; job['owner'] = args.owner
        if not args.peek:
            temp = QUEUE.with_suffix('.tmp')
            temp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
            os.replace(temp, QUEUE)
        print(json.dumps({'job': job, 'remainingQueued': sum(j['state'] == 'queued' for j in data['jobs']), 'peek': args.peek}, ensure_ascii=False))
    finally:
        lock.seek(0)
        if os.name == 'nt':
            msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
