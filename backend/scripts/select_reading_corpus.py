"""Reproduce the editorial selection, still DRAFT until item review is recorded."""
import hashlib
import json
import re
from collections import Counter
from prepare_reading_corpus import WORK

def read(name): return json.loads((WORK/name).read_text(encoding='utf-8'))
nps=read('drafts.json');extra=read('additional-drafts.json');psych=read('psychology-drafts.json')
NPS=[0,91,2,4,17,18,19,20,21,22,23,24,25,26,28,30,92,34,35,254,38,80,121,41,42,43,44,45,46,113,48,61,62,64,65,68,69,70,79,122,82,84,86,87,98,99,101,102,108,112,114,118,125,128,133,138,153,154,155,129]
NIDDK=[158,161,162,163,165,178,180,181,204,205]
NASA=[70,71,72,73,74,76,78,80,82,83]
NIMH=[10,6,12,3,4,5,7,9,11,14]
voa=[i for n,i in enumerate(extra[:70]) if n not in {8,12,25,57,62,69}][:59]+[extra[68]]
selected=[nps[n] for n in NPS]+voa+[nps[n] for n in NIDDK]+[extra[n] for n in NASA]+[psych[n] for n in NIMH]
selected[128]=read('replacement-drafts.json')[0]
selected[6]=nps[66]
selected[4]=nps[67]  # Age of Dinosaurs credits AGI-authored text: excluded.
assert len(selected)==150
parks={'yell':'Yellowstone','yose':'Yosemite','ever':'Everglades','olym':'Olympic','acad':'Acadia','glac':'Glacier','grca':'Grand Canyon','jotr':'Joshua Tree','seki':'Sequoia and Kings Canyon','badl':'Badlands','redw':'Redwood','zion':'Zion','arch':'Arches','cany':'Canyonlands','mora':'Mount Rainier','havo':'Hawaiʻi Volcanoes'}
for item in selected:
    body=item['contentText'];paras=body.split('\n\n');clean=[];skip_next=False
    for p in paras:
        if skip_next:skip_next=False;continue
        lower=p.lower()
        if re.search(r'(?i)(see (?:map|figure|chart)|(?:image|images|diagram|chart|table|map|dots) (?:above|below)|this (?:360|video|visualization)|the (?:green|yellow|red|purple) (?:and|dots))',p):continue
        if item['sourceId'] in {'nimh','niddk'} and re.search(r'(?i)(listed below|the following|roadblocks below|three sections|some activities you can try|for instance,?$)',p):continue
        if item['sourceId']=='nimh' and item['title']=='Bipolar Disorder' and lower.startswith('to diagnose'):break
        if item['sourceId']=='nimh' and item['title']=='Bipolar Disorder' and ('outlined above' in lower or 'three basic types' in lower):continue
        if item['sourceId']=='nasa-earth' and ('"' in p or 'Worldview browser' in p):continue
        if item['sourceId']=='nps' and any(x in lower for x in ['ipcc, 2014:', 'chart above', 'diagram below', 'below are some rock types']): continue
        if item['sourceId']=='nps' and 'sound gallery' in lower:
            p=p[:p.index('What sounds are meaningful')].strip(); lower=p.lower()
        if item['sourceId']=='voa' and (lower.startswith(('on this program', 'and now, words and their stories', 'welcome to words and their stories', 'now, words and their stories', 'from voa learning english, this is')) or 'let’s listen' in lower or 'under false representations' in lower): continue
        if item['sourceId']=='nasa-earth' and ('Watch to discover' in p or p.endswith('…')):continue
        if item['sourceId']=='nasa-earth' and item['title']=='Freshwater' and not p.endswith('.'):continue
        p=re.sub(r'\s*\(figure \d+\)', '', p, flags=re.I)
        if item['sourceId']=='nasa-earth':
            sentences_in_paragraph=re.split(r'(?<=[.!?])\s+',p)
            p=' '.join(dict.fromkeys(sentences_in_paragraph))
        if item['sourceId'] in {'niddk','nimh'} and (p[-1:] in {':',','} or not re.search(r'[.!?]$',p) or re.search(r'(?i)\b(such as|are|include|depends on|to consider|may depend on)$',p)): continue
        if item['sourceId'] in {'niddk','nimh'} and any(x in lower for x in ['figure ', 'table ', 'myplate offers', 'watch this video', 'watch, download', 'great: helpful', 'learn about symptoms', 'in this case,', 'food tracker', 'check out the following', 'try these tips', 'read this fact sheet']):continue
        if item['sourceId']=='niddk' and item['title']=='Artificial Pancreas' and lower.startswith('you need a prescription'):break
        if item['sourceId']=='nimh' and item['title']=='Understanding Psychosis' and ('treat' in lower or 'recovery' in lower):break
        if item['sourceId']=='nimh' and item['title']=='I’m So Stressed Out! Fact Sheet':
            if lower.startswith(('learning what causes','if you are struggling','if you or someone')):continue
            p=re.sub(r' Read more about anxiety disorders\s*\.', '', p)
        if any(x in lower for x in ['parks and plates','geodiversity atlas','park home','npshistory.com','download or screenshot','print out your copy','floppy disk','social media','tag your posts','start a conversation','comments section','comment section','send us an email','click on','website is produced in concert','email nps_', 'biomarkers clinical trials','national institutes of health (nih) conduct','always talk with your health care provider before you participate','sample food tracker in figure','the global "one' ]): continue
        if re.search(r'(?i)\b(?:19|20)\d{2}\. .*?(?:report|journal|bulletin|science|doi|press|research|university|climate|water)',p) or 'irma.nps.gov' in lower or 'national park service, fort collins' in lower or 'available at http' in lower or 'doi.org' in lower: continue
        if re.search(r'(?i)^(learn more|download|visit |check out|explore these|find out|print |for more|to learn|find tips|you can learn|what do you|let.s listen|today.s question|please |data for |more information)',p):continue
        if re.search(r'(?i)said,$',p):continue
        if item['sourceId']=='nps' and (lower.startswith('president harry') or lower.startswith('significance:') or 'view current threatened' in lower or 'included due to similarity' in lower): continue
        if item['sourceId']=='nimh' and any(t in lower for t in ['choosing the right treatment plan','decide which treatment option','resource’s inclusion','help you find mental health resources']):continue
        if item['sourceId']=='voa' and any(x in lower for x in ['merriam','oxford english dictionary','cambridge','dictionary.com','malcolm gladwell','here are parts of that poem']):
            skip_next='here is an example' in lower;continue
        if item['sourceId']=='nasa-earth' and any(x in lower for x in ['enable javascript','earth observatory image','earth observatory animation','story by','ozone 101 shows']):continue
        if item['sourceId']=='nimh' and any(x in lower for x in ['mental health minute','read more about','learn more about','find tips','visit our','talk with','talk to','contact','find help','qualified health care','provider can','the following is not a comprehensive']):continue
        if item['sourceId']=='niddk' and 'clinical' in lower: continue
        if p.endswith(':'):continue
        clean.append(p)
    # Psychopathology readings stop before treatment guidance. Keep educational explanations.
    if item['sourceId']=='nimh' and item['title'] in ['Depression','Seasonal Affective Disorder','Attention-Deficit/Hyperactivity Disorder: What You Need to Know','Obsessive-Compulsive Disorder: When Unwanted Thoughts or Repetitive Behaviors Take Over']:
        cutoff=next((n for n,p in enumerate(clean) if re.search(r'(?i)medications? (can|are)|psychotherapy (can|is)|treated with|treatment for|treatments for',p)),len(clean))
        clean=clean[:cutoff]
    body='\n\n'.join(clean)
    sentences=max(1,len(re.findall(r'[.!?](?:\s|$)',body)));avg=len(body.split())/sentences;long=sum(len(w.strip('.,;:()'))>=9 for w in body.split())/len(body.split())
    item['difficultyLevel']='A2' if item['sourceId']=='voa' and avg<13 and long<0.08 else ('B1' if avg<17 and long<0.12 else ('B2' if avg<24 and long<0.2 else 'C1'))
    item['contentText']=body;item['wordCount']=len(body.split());item['bodySha256']=hashlib.sha256(body.encode()).hexdigest()
    item['originalTitle']=item['title']
    if item['sourceId']=='nps':
        park=item['sourceUrl'].split('/')[3]
        if park in parks and len(item['title'])<40:item['title']+=' — '+parks[park]
        title=item['title'].lower()
        if any(x in title for x in ['climate','pollution','air quality','fire','restoration','environment','invasive','non-native','endangered','extinction']):item['topic']='Environment'
        elif any(x in title for x in ['geology','mineral','rock','landform','karst','tectonic','volcan','dunes','arid','river','hydrolog','coast','cave']):item['topic']='Earth Science'
        elif any(x in title for x in ['civil rights','amendment','women','tuskegee','booker','carver','redwood parks and beyond']):item['topic']='History & Society'
    if item['sourceId']=='voa':
        title=item['title'].lower()
        item['topic']='Education & Language'
        if any(x in title for x in ['power couple','kitchen-table','gangbusters','pay dirt','mold','wringer','goal','state-of-the-art','divide and conquer','out of the gate','dialed in']):item['topic']='Business & Work'
        elif any(x in title for x in ['rome','year','ancient history','married','presidents','pearl','lucky stars','tie the knot']):item['topic']='Culture & Society'
        elif any(x in title for x in ['phone','food for thought','gut','knee','partners','head and shoulders','swimming','handy','trash','north star','spread','blessings']):item['topic']='Everyday Life'
        elif any(x in title for x in ['mars','wright','invent','space exploration','technology','helicopter']):item['topic']='Science & Technology'
    item['description']=clean[0][:220].rsplit(' ',1)[0]+'…'
    item['sourceSnapshotSha256']=hashlib.sha256((WORK/(hashlib.sha256(item['sourceUrl'].encode()).hexdigest()+'.html')).read_bytes()).hexdigest()
    if 'obsessive-compulsive-disorder-when-unwanted-thoughts-take-over' in item['sourceUrl']:
        item['fetchedUrl']=item['sourceUrl']
        item['sourceUrl']=item['sourceUrl'].replace('when-unwanted-thoughts-take-over','when-unwanted-thoughts-or-repetitive-behaviors-take-over')
        item['attribution']=item['attribution'].replace(item['fetchedUrl'],item['sourceUrl'])
    item['rightsReviewNote']=''
    if item['wordCount']<150: print('SHORT',item['title'],item['wordCount'])
(WORK/'review-selection.json').write_text(json.dumps(selected,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print('Selected DRAFTS',len(selected),'sources',dict(Counter(i['sourceId'] for i in selected)),'topics',dict(Counter(i['topic'] for i in selected)))
