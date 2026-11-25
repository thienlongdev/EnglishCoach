"""Bounded offline text-only educational candidates from NIMH; no application writes."""
import concurrent.futures as futures
import hashlib
import json
import re
from prepare_reading_corpus import get, WORK, SOURCES

PAGES = ['topics/caring-for-your-mental-health','topics/child-and-adolescent-mental-health','topics/brain-stimulation-therapies',
    'publications/so-stressed-out-fact-sheet','publications/the-teen-brain-7-things-to-know',
    'publications/understanding-the-link-between-chronic-disease-and-depression','publications/my-mental-health-do-i-need-help',
    'publications/older-adults-and-mental-health','publications/depression',
    'publications/anxiety-disorders','publications/attention-deficit-hyperactivity-disorder-what-you-need-to-know',
    'publications/understanding-psychosis','publications/seasonal-affective-disorder','publications/post-traumatic-stress-disorder-ptsd',
    'publications/children-and-mental-health','publications/bipolar-disorder','publications/obsessive-compulsive-disorder-when-unwanted-thoughts-take-over',
    'publications/eating-disorders','topics/mental-health-medications','topics/technology-and-the-future-of-mental-health-treatment']
def prepare(path):
    url='https://www.nimh.nih.gov/health/'+path
    soup=get(url)
    if not soup or not soup.h1: return None
    node=soup.select_one('article#main_content_inner, .node__content')
    if not node:return None
    for tag in node.select('figure,figcaption,blockquote,script,style,table'):tag.decompose()
    paragraphs=[];words=0
    for p in node.select('p'):
        text=re.sub(r'\s+',' ',p.get_text(' ',strip=True))
        if any(x in text.lower() for x in ['reprints', 'nih publication', 'the information in this publication', 'u.s. department of health']): break
        if len(text.split())<10 or any(x in text.lower() for x in ['español','copyright','©','reprints','reprinting','clinical trial','988','911','information about','visit our','nimh.nih.gov','publication no','revised 20','clinical research']):continue
        if words+len(text.split())>1200:break
        if text not in paragraphs:paragraphs.append(text);words+=len(text.split())
    if words<150 or len(paragraphs)<2:return None
    body='\n\n'.join(paragraphs);src=SOURCES['nimh'];title=soup.h1.get_text(' ',strip=True)
    avg=words/max(1,len(re.findall(r'[.!?](?:\s|$)',body)));long=sum(len(w)>=9 for w in body.split())/words
    return dict(sourceId='nimh',sourceName=src['sourceName'],sourceUrl=url,title=title,contentText=body,wordCount=words,difficultyLevel='B1' if avg<17 and long<0.12 else ('B2' if avg<24 and long<0.2 else 'C1'),levelMethod='APPROXIMATE_READABILITY',topic='Psychology',description=paragraphs[0][:220].rsplit(' ',1)[0]+'…',licenseCode=src['licenseCode'],attribution=src['attributionTemplate'].format(title=title,sourceUrl=url)+' Plain-text educational excerpt; images and reference lists omitted.',contentVariant='EXCERPT',bodySha256=hashlib.sha256(body.encode()).hexdigest(),reviewStatus='DRAFT',rightsExceptionFound=True,rightsReviewNote='',fetchedDate='2026-10-04')
if __name__=='__main__':
    with futures.ThreadPoolExecutor(max_workers=2) as pool: items=[x for x in pool.map(prepare,PAGES) if x]
    (WORK/'psychology-drafts.json').write_text(json.dumps(items,ensure_ascii=False,indent=2)+'\n',encoding='utf-8');print('NIMH DRAFTS',len(items))
