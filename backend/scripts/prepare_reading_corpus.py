"""Offline, bounded candidate preparation. Never called by application startup.

Network: 2 workers, connect/read timeouts 5/15s, max 2MB per response.
Output is DRAFT; human/agent item review is required before application import.
"""
import concurrent.futures as futures
import hashlib
import json
import re
from pathlib import Path
from urllib.parse import urljoin, urlparse
import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1] / 'src/main/resources/data/reading'
WORK = Path(__file__).resolve().parents[2] / 'reading-corpus-evidence'
WORK.mkdir(exist_ok=True)
SOURCES = {s['id']: s for s in json.loads((ROOT/'sources.json').read_text(encoding='utf-8'))}
NPS_ROOTS = {
    'geology': 'Earth Science', 'fossils': 'History of Life', 'caves': 'Earth Science',
    'air': 'Environment', 'oceans': 'Nature', 'pollinators': 'Nature',
    'bats': 'Nature', 'birds': 'Nature', 'nightskies': 'Nature & Space',
    'sound': 'Environment', 'climatechange': 'Environment', 'wilderness': 'Travel & Outdoors',
    'biodiversity': 'Nature', 'science': 'Science & Technology',
    'civilrights': 'Culture & Society', 'americanrevolution': 'History',
    'womenshistory': 'History', 'education': 'Education', 'heritage': 'Culture & Society',
    'tellingallamericansstories': 'History', 'culturalresources': 'Culture & Society',
}
def get(url):
    try:
        path = WORK / (hashlib.sha256(url.encode()).hexdigest()+'.html')
        if path.exists(): return BeautifulSoup(path.read_text(encoding='utf-8'), 'html.parser')
        with requests.get(url, timeout=(5,15), stream=True) as response:
            response.raise_for_status()
            if urlparse(response.url).hostname != urlparse(url).hostname: return None
            raw = bytearray()
            for part in response.iter_content(32768):
                raw.extend(part)
                if len(raw) > 2000000: return None
            text = raw.decode('utf-8',errors='replace')
            if '�' in text: return None
            path.write_text(text,encoding='utf-8')
            return BeautifulSoup(text,'html.parser')
    except requests.RequestException: return None

def links(soup,url,source):
    if not soup: return []
    main = soup.select_one('#main')
    if not main: return []
    found=[]
    for a in main.select('a[href]'):
        u=urljoin(url,a['href']).split('#')[0]
        parsed=urlparse(u)
        if parsed.scheme != 'https' or parsed.query or parsed.hostname != urlparse(url).hostname: continue
        if source=='nps' and not (any(parsed.path.startswith('/subjects/'+s+'/') for s in NPS_ROOTS) or parsed.path.startswith('/articles/') or '/learn/nature/' in parsed.path or '/learn/historyculture/' in parsed.path): continue
        if source=='niddk' and not parsed.path.startswith('/health-information/'): continue
        if any(x in u for x in ['nps-geodiversity-atlas','siteindex','contact','clinical-trials','treatment','diagnosis','symptoms','statistics','espanol','informacion-de','health-professionals','research-funding']): continue
        found.append(u)
    return sorted(set(found))

def extract(url,topic,source):
    soup=get(url)
    if not soup or not soup.h1: return None
    title=soup.h1.get_text(' ',strip=True)
    if any(x in title.lower() for x in ['geodiversity atlas','what we do','policies','regulations','older version','master list','resource inventory','publications on','news','events','program','in the field']): return None
    containers=soup.select('.ArticleTextGroup, .text-content-size') if source=='nps' else soup.select('.health-detail-content')
    if not containers: return None
    paragraphs=[]
    for node in containers:
        for tag in node.select('figure, figcaption, blockquote, script, style, table, .caption, .image-caption, .dk-review-date, .references'): tag.decompose()
        for p in node.select('p'):
            text=re.sub(r'\s+',' ',p.get_text(' ',strip=True))
            if len(text.split()) < 10: continue
            if any(x in text.lower() for x in ['photo', 'image credit', 'copyright', 'all rights reserved', 'courtesy', 'written by', 'author:', 'by permission', '©', 'references', 'last updated', 'last reviewed', 'clinical trial', 'for more information', 'visit our', 'watch the video']): continue
            if any(c in text for c in ['“','”','"','<','>','�']): continue
            if text not in paragraphs: paragraphs.append(text)
    # Keep a contiguous introduction excerpt and end at a complete paragraph.
    chosen=[];words=0
    for p in paragraphs:
        n=len(p.split())
        if words+n > 1200: break
        chosen.append(p);words+=n
    if words < 150 or len(chosen)<2: return None
    body='\n\n'.join(chosen)
    # Readability is an estimate, never a CEFR certification.
    sentence_count=max(1,len(re.findall(r'[.!?](?:\s|$)',body)))
    avg=words/sentence_count
    long_fraction=sum(len(w.strip('.,;:()'))>=9 for w in body.split())/words
    level='B1' if avg<17 and long_fraction<0.12 else ('B2' if avg<24 and long_fraction<0.2 else 'C1')
    src=SOURCES[source]
    return dict(sourceId=source,sourceName=src['sourceName'],sourceUrl=url,title=title,contentText=body,
        wordCount=words,difficultyLevel=level,levelMethod='APPROXIMATE_READABILITY',topic=topic,
        description=chosen[0][:220].rsplit(' ',1)[0]+'…',licenseCode=src['licenseCode'],
        attribution=src['attributionTemplate'].format(title=title,sourceUrl=url)+' Plain-text educational excerpt; images, captions, quotations and reference lists omitted.',
        contentVariant='EXCERPT',bodySha256=hashlib.sha256(body.encode()).hexdigest(),reviewStatus='DRAFT',
        rightsExceptionFound=True,rightsReviewNote='',fetchedDate='2026-10-04')

def main():
    seeds=[('https://www.nps.gov/subjects/'+s+'/index.htm',topic,'nps') for s,topic in NPS_ROOTS.items()]
    seeds += [('https://www.nps.gov/subjects/geology/'+x+'.htm','Earth Science','nps') for x in ['rocks','landforms','volcanoes','minerals','plate-tectonics']]
    seeds += [('https://www.nps.gov/'+park+'/learn/nature/index.htm','Nature','nps') for park in ['yell','yose','grca','ever','olym','dena','acad','glac','grsm','jotr','seki','badl','crla','romo','redw','zion','arch','cany','mora','havo']]
    seeds += [('https://www.nps.gov/'+park+'/learn/historyculture/index.htm','History','nps') for park in ['inde','wori','samo','sapu','jame','colo','bost','safr','frdo','tuin','memy','mawa']]
    seeds += [('https://www.niddk.nih.gov/health-information/'+s,'Health & Everyday Life','niddk') for s in ['weight-management','digestive-diseases','diabetes','kidney-disease','diet-nutrition']]
    candidates={u:(topic,src) for u,topic,src in seeds};frontier=list(seeds)
    with futures.ThreadPoolExecutor(max_workers=2) as pool:
        for depth in range(3):
            results=pool.map(lambda item:(item,get(item[0])),frontier)
            next_frontier=[]
            for (url,topic,src),soup in results:
                for u in links(soup,url,src)[:18]:
                    if u not in candidates and len(candidates)<650:
                        new_topic = next((v for k,v in NPS_ROOTS.items() if '/subjects/'+k+'/' in u),topic)
                        candidates[u]=(new_topic,src);next_frontier.append((u,new_topic,src))
            frontier=next_frontier
            print('discovery',depth,len(candidates),flush=True)
        items=[]
        for item in pool.map(lambda x:extract(x[0],x[1][0],x[1][1]),list(candidates.items())):
            if item: items.append(item)
        (WORK/'drafts.json').write_text(json.dumps(items,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
        (WORK/'candidate-urls.json').write_text(json.dumps(candidates,indent=2)+'\n',encoding='utf-8')
        print('DRAFT items',len(items),flush=True)
if __name__=='__main__': main()
