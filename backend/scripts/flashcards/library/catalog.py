"""Record bibliographic facts only; no paid content, cover images, or previews."""
import csv,json,requests,concurrent.futures
from pathlib import Path
from bs4 import BeautifulSoup
HERE=Path(__file__).resolve().parent
OUT=HERE.parents[3]/'docs/flashcards/library-20261117'
base='https://dk.com/en-us'
r=requests.get(base+'/collections/big-ideas/products.json?limit=250',timeout=25);r.raise_for_status()
targets=set(('The '+x+' Book').casefold() for x in 'Science|Psychology|Philosophy|History|Politics|Economics|Business|Biology|Physics|Astronomy|Math|Literature|Art|Ecology|Medicine|Chemistry|Technology|Geography|Anthropology|Law|Architecture|Design|Poetry|Movie|Religions|Feminism|Classical Music'.split('|'))
products={}
for p in r.json()['products']:
    if p['title'].casefold() in targets:products.setdefault(p['title'],p)
def item(p):
    u=base+'/products/'+p['handle'];resp=requests.get(u,timeout=30);resp.raise_for_status()
    soup=BeautifulSoup(resp.content,'html.parser');texts=list(soup.stripped_strings)
    def after(s):
        return texts[texts.index(s)+1] if s in texts else ''
    opts=texts[texts.index('Format')+1:texts.index('Buy from a retailer')] if 'Format' in texts and 'Buy from a retailer' in texts else []
    formats=', '.join(dict.fromkeys(x for x in opts if x.casefold() in {'ebook','hardback','paperback','trade paperback','audiobook','audio download'}))
    return dict(title=p['title'],publisher='DK',author=next((v[3:] for v in texts if v.startswith('by ') and len(v)<120),''),isbn=after('ISBN:'),edition=after('Publication date:'),format=formats or p['variants'][0]['title'],price='USD '+p['variants'][0]['price']+' (listed variant)',ebook='yes; retailer purchase; file format/DRM not established' if 'ebook' in formats.lower() else 'not verified',url=u)
with concurrent.futures.ThreadPoolExecutor(4) as ex:dk=list(ex.map(item,products.values()))
fields='title publisher author isbn edition cefr units format price ebook url rights extraction'.split()
def write(name,rows):
    with (OUT/name).open('w',newline='',encoding='utf-8-sig') as f:
        o=csv.DictWriter(f,fieldnames=fields);o.writeheader()
        for row in rows:
            o.writerow(dict({k:'not verified' for k in fields},publisher='Cambridge University Press',**{})|row|dict(rights='No public reuse grant found',extraction='Not acquired; no machine extraction authorized'))
write('dk_big_ideas_inventory.csv',dk)
write('source_catalog.csv',json.loads((HERE/'publishers.json').read_text())+dk)
print('commercial targets',len(dk)+21,'DK',len(dk),'DK ebook listing',sum(x['ebook'].startswith('yes') for x in dk))
