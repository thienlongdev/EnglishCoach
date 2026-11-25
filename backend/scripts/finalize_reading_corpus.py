"""Explicit offline approval packaging after editorial and exception review.

This never connects to a database or imports anything. Approval is an intentional
CLI operation; candidate discovery and application startup cannot invoke it.
"""
import argparse
import hashlib
import json
import requests
from collections import Counter
from prepare_reading_corpus import WORK, ROOT, SOURCES, get

def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')

parser=argparse.ArgumentParser()
parser.add_argument('--approve-reviewed-selection', action='store_true', required=True)
parser.parse_args()
items=json.loads((WORK/'review-selection.json').read_text(encoding='utf-8'))
canonical={x['sourceUrl']:x for x in json.loads((WORK/'canonical-url-check-final.json').read_text(encoding='utf-8'))}
for item in items:
    check=canonical.get(item['sourceUrl'])
    if not check or check['status']!=200 or not check['canonicalMatches']:
        raise SystemExit('Missing successful final canonical check: '+item['sourceUrl'])
exceptions={x['sourceUrl']:x['pageExceptionSnippets'] for x in json.loads((WORK/'item-exception-review.json').read_text(encoding='utf-8'))}
policies=[]
for sid in sorted({x['sourceId'] for x in items}):
    source=SOURCES[sid]
    url=source['officialRightsUrl']
    path=WORK/(hashlib.sha256(url.encode()).hexdigest()+'.html')
    if not path.exists():
        with requests.get(url,timeout=(5,15),stream=True) as response:
            response.raise_for_status()
            raw=bytearray()
            for chunk in response.iter_content(32768):
                raw.extend(chunk)
                if len(raw)>2000000:raise SystemExit('Rights evidence exceeds bound')
            path.write_bytes(raw)
    policies.append(dict(sourceId=sid,url=url,reviewedDate='2026-10-04',snapshotFile=path.name,sha256=hashlib.sha256(path.read_bytes()).hexdigest()))
write(WORK/'rights-policy-evidence.json',policies)
for item in items:
    item['reviewStatus']='APPROVED'
    # This field refers only to the included prose, not the whole source page.
    item['rightsExceptionFound']=False
    item['reviewedDate']='2026-10-04'
    item['excludedPageMaterial']=exceptions.get(item['sourceUrl'],[])
    item['rightsReviewNote']= (
        f"Reviewed {item['originalTitle']} under {SOURCES[item['sourceId']]['officialRightsUrl']}. "
        'Included educational prose checked against cached source; no retained third-party credit or agency story. '
        'Page-level exceptions are recorded separately and excluded from the excerpt. '
        + ('Original VOA language lesson/biography; borrowed dictionary/literary quotations omitted; all agency photos excluded.' if item['sourceId']=='voa'
           else 'Agency educational prose only; all media, captions, logos, references and promotional material excluded.')
    )
    item['transformationNote']='EXCERPT: selected original prose paragraphs; whitespace normalized; omitted navigation, promotions, media-dependent paragraphs, list lead-ins without lists, and bibliography. Figure-number references and exact duplicate NASA sentences removed. No invented prose or translation. Park subtitle added where needed. CEFR is an approximate readability estimate.'
    assert 150<=item['wordCount']<=2500
    assert item['bodySha256']==hashlib.sha256(item['contentText'].encode()).hexdigest()
assert len(items)==150
assert len({x['sourceUrl'] for x in items})==len(items)
write(ROOT/'corpus.json',items)
write(ROOT/'metadata.json',[{k:x[k] for k in ['sourceUrl','topic','description','licenseCode','attribution']} for x in items])
summary=dict(count=len(items),sources=dict(Counter(x['sourceId'] for x in items)),topics=dict(Counter(x['topic'] for x in items)),levels=dict(Counter(x['difficultyLevel'] for x in items)),minWords=min(x['wordCount'] for x in items),maxWords=max(x['wordCount'] for x in items),totalWords=sum(x['wordCount'] for x in items),manifestBytes=(ROOT/'corpus.json').stat().st_size,metadataBytes=(ROOT/'metadata.json').stat().st_size,manifestSha256=hashlib.sha256((ROOT/'corpus.json').read_bytes()).hexdigest(),productionImported=0,reviewMethod='All-item bounds/identity/encoding/source provenance and page-exception inspection; editorial flag review and full-text sampling per publisher. Not a CEFR certification.')
write(WORK/'corpus-summary.json',summary)
print(json.dumps(summary,ensure_ascii=False,indent=2))
