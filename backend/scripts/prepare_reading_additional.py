"""Explicit offline candidates from two separately rights-reviewed publishers."""
import concurrent.futures as futures
import hashlib
import json
import re
from urllib.parse import urljoin
from prepare_reading_corpus import get, WORK, SOURCES

def item(url,source,topic):
    soup=get(url)
    if not soup or not soup.h1: return None
    title=soup.h1.get_text(' ',strip=True)
    node=soup.select_one('.wsw') if source=='voa' else soup.select_one('.entry-content')
    if not node: return None
    for tag in node.select('figure,figcaption,blockquote,script,style,table,.caption,.media-caption,.media-wrap,.hds-content-cards,.hds-card,.hds-card-grid,.hds-featured-videos,.hds-topic-card, .hds-latest-news,.latest-news-item,.hds-news-item-bubble,.featured-link-list-row,.topic-card'): tag.decompose()
    full=node.get_text(' ',strip=True)
    if source=='voa' and (re.search(r'\b(AP|AFP|Reuters|Associated Press|Agence France)\b',full) or 'adapted from' in full.lower()): return None
    # Require an explicit original VOA Learning English writing credit.
    if source=='voa' and not re.search(r'(wrote|written|prepared|produced).*?(VOA Learning English|Learning English)',full,re.I): return None
    paragraphs=[]
    for p in node.select('p'):
        if p.find_parent('a'): continue
        text=re.sub(r'\s+',' ',p.get_text(' ',strip=True))
        if any(x in text.lower() for x in ['words in this story','words in this article','wrote this','written by','prepared this','produced this','_____','how are you','and that','that’s all','that is all','until next','comments section','i’m anna','i’m bryan','i’m john','i’m jill','i’m caty','i’m ashley']): break
        if len(text.split())<6: continue
        if any(x in text.lower() for x in ['and now words','now, words','now words','welcome to','welcome back','here on voa','let us know','share your','read more','download','credits:','copyright','©','get involved','watch to learn']): continue
        if text not in paragraphs: paragraphs.append(text)
    chosen=[];words=0
    for p in paragraphs:
        if words+len(p.split())>1200: break
        chosen.append(p);words+=len(p.split())
    if words<200 or len(chosen)<3: return None
    body='\n\n'.join(chosen)
    if any(x in body for x in ['<','>','�']):return None
    sentences=max(1,len(re.findall(r'[.!?](?:\s|$)',body)))
    avg=words/sentences;long=sum(len(w.strip('.,;:()'))>=9 for w in body.split())/words
    level='A2' if source=='voa' and avg<13 and long<0.08 else ('B1' if avg<17 and long<0.12 else ('B2' if avg<24 and long<0.2 else 'C1'))
    src=SOURCES[source]
    return dict(sourceId=source,sourceName=src['sourceName'],sourceUrl=url,title=title,contentText=body,wordCount=words,difficultyLevel=level,levelMethod='APPROXIMATE_READABILITY',topic=topic,description=chosen[0][:220].rsplit(' ',1)[0]+'…',licenseCode=src['licenseCode'],attribution=src['attributionTemplate'].format(title=title,sourceUrl=url)+' Plain-text educational excerpt; images, audio and glossary omitted.',contentVariant='EXCERPT',bodySha256=hashlib.sha256(body.encode()).hexdigest(),reviewStatus='DRAFT',rightsExceptionFound=True,rightsReviewNote='',fetchedDate='2026-10-04')

def main():
    candidates={}
    with futures.ThreadPoolExecutor(max_workers=2) as pool:
        indexes=[(f'https://learningenglish.voanews.com/z/{z}?p={page}',topic) for z,topic in [('987','Culture & Language'),('1579','Science & Technology'),('3521','Everyday Life'),('4725','Education')] for page in range(6)]
        for (url,topic),soup in pool.map(lambda x:(x,get(x[0])),indexes):
            if soup:
                for a in soup.select('a[href]'):
                    u=urljoin(url,a['href']).split('#')[0]
                    if u.startswith('https://learningenglish.voanews.com/a/') and u.endswith('.html') and len(candidates)<280:candidates[u]=('voa',topic)
        nasa=['https://science.nasa.gov/earth/'+p+'/' for p in ['climate-change','climate-change/what-is-climate-change','climate-change/causes','climate-change/effects','climate-change/evidence','climate-change/faq','climate-change/mitigation-adaptation','explore/air-quality','explore/atmosphere','explore/oceans','explore/water','explore/land','explore/ice','explore/earth-science-topics','earth-at-night','earth-day']]
        for url,soup in pool.map(lambda u:(u,get(u)),nasa):
            candidates[url]=('nasa-earth','Environment')
            if soup:
                for a in soup.select('main a[href]'):
                    u=urljoin(url,a['href']).split('#')[0]
                    if u.startswith('https://science.nasa.gov/earth/') and '/wp-content/' not in u and '?' not in u and len([k for k in candidates if 'science.nasa.gov' in k])<55:candidates[u]=('nasa-earth','Environment')
        print('additional candidates',len(candidates),flush=True)
        items=[x for x in pool.map(lambda x:item(x[0],*x[1]),candidates.items()) if x]
        (WORK/'additional-drafts.json').write_text(json.dumps(items,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
        print('additional DRAFTS',len(items),flush=True)
if __name__=='__main__':main()
