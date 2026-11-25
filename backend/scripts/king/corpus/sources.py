"""Locked upstream downloads. Never queries a runtime dictionary or substitutes mirrors."""
import argparse
import hashlib
import json
import re
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
HERE = Path(__file__).resolve().parent
CACHE = ROOT / '.cache/king-corpus/raw'
EVIDENCE = ROOT / 'docs/king-of-english/corpus'
LOCK = HERE / 'sources.lock.json'


def sha256(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')


def registry(path=LOCK):
    data = json.loads(path.read_text(encoding='utf-8'))
    seen = set()
    required = {'id','name','canonicalUrl','downloadUrl','version','snapshotDate','sha256',
                'licenseId','licenseUrl','licenseClass','commercialUseStatus','redistributionStatus',
                'shareAlike','requiredAttribution','runtimeEligible','validationOnly','notes'}
    for source in data['sources']:
        if required - source.keys() or source['id'] in seen:
            raise ValueError('INVALID_SOURCE_LOCK')
        seen.add(source['id'])
        if source.get('cacheFile') and Path(source['cacheFile']).name != source['cacheFile']:
            raise ValueError('INVALID_CACHE_PATH')
        if source['downloadUrl'] and not re.fullmatch('[0-9a-f]{64}', source['sha256'] or ''):
            raise ValueError('UNLOCKED_CHECKSUM:'+source['id'])
        if source['runtimeEligible']:
            if (source['validationOnly'] or source['licenseClass'] not in
                {'TIER_A_PERMISSIVE_OR_CLEAR_COMMERCIAL','TIER_B_SHARE_ALIKE'} or
                source['licenseId'] in {'UNKNOWN','UNVERIFIED',''} or
                source['commercialUseStatus'] != 'ALLOWED' or
                not source['requiredAttribution']):
                raise ValueError('LICENSE_GATE:'+source['id'])
            evidence = ROOT / source['licenseEvidenceFile']
            if sha256(evidence) != source['licenseSha256']:
                raise ValueError('LICENSE_EVIDENCE_CHANGED:'+source['id'])
    return data


def verify(source, path):
    if sha256(path) != source['sha256']:
        raise ValueError('CHECKSUM_MISMATCH:'+source['id'])


def fetch(source):
    CACHE.mkdir(parents=True, exist_ok=True)
    target = CACHE / source['cacheFile']
    if target.exists():
        verify(source, target)
        return target
    temporary = target.with_suffix(target.suffix+'.part')
    # Failed transfers remain visibly partial. Reusable completed cache is always verified.
    request = urllib.request.Request(source['downloadUrl'], headers={'User-Agent':'KingCorpusOffline/1.0'})
    with urllib.request.urlopen(request, timeout=45) as response, temporary.open('wb') as stream:
        while block := response.read(1024*1024):
            stream.write(block)
    verify(source, temporary)
    temporary.replace(target)
    return target


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['fetch','verify'])
    parser.add_argument('--source', action='append')
    args = parser.parse_args()
    ledger = []
    for source in registry()['sources']:
        if not source['downloadUrl'] or args.source and source['id'] not in args.source:
            continue
        try:
            path = fetch(source) if args.action == 'fetch' else CACHE / source['cacheFile']
            verify(source, path)
            row = dict(id=source['id'], status='VERIFIED', bytes=path.stat().st_size, sha256=sha256(path))
        except Exception as error:
            row = dict(id=source['id'],status='BLOCKED',cause=str(error))
        ledger.append(row)
        print(json.dumps(row), flush=True)
    write_json(EVIDENCE / ('downloads-'+args.action+'.json'),ledger)
    if any(row['status'] != 'VERIFIED' for row in ledger):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
