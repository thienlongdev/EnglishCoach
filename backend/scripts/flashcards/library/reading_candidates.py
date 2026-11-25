"""Private candidate generation; never seeds the database. Requires the existing pinned caches.
The supplied text is used only to disambiguate; public drafts use licensed sources or original wording.
"""
import collections,csv,gzip,hashlib,json,os,re,sqlite3,sys,unicodedata
from pathlib import Path
from docx import Document
HERE=Path(__file__).resolve().parent;ROOT=HERE.parents[3];sys.path.insert(0,str(HERE.parent/'vocabulary'))
from sources import load_wordnet,load_cefr,SQLITE_POS,sha256
cache=Path(sys.argv[1]);out=cache/'completion';out.mkdir(exist_ok=True)
def norm(t):return ' '.join(unicodedata.normalize('NFC',str(t)).split())
def tokens(t):return set(re.findall(r"[^\W\d_]+",norm(t).lower()))-set("a an and or the in to of on for from someone something is that one with not by be người sự của các cái từ những một là tính được có học làm bằng về trạng thái".split())
def sim(a,b):
 a=tokens(a);b=tokens(b);return len(a&b)/max(1,min(len(a),len(b)))
def exact(w,s):
 stems=[w,w+'s',w+'es',w+'ed',w+'d',w+'ing',w.rstrip('e')+'ing']
 if w.endswith('y'):stems+=[w[:-1]+'ies',w[:-1]+'ied']
 return any(re.search(r'(?<![A-Za-z])'+re.escape(t)+r'(?![A-Za-z])',s,re.I) for t in stems)
ALIASES={'apprehed':'apprehend','coral reefs':'coral reef','afforded':'afford','withdrew':'withdraw','deluge with':'deluge','ascribe to':'ascribe','allegiance to somebody':'allegiance','pan american':'pan-american','unleashed':'unleash'}
HELD={'exercise':'exercise directions, not a headword','heading in':'ambiguous direction/phrase; source gloss does not establish an independent lexical sense','hub of the universe':'context-specific epithet; avoid publishing as a general fixed idiom','sirius':'proper star name, outside this general vocabulary selection'}
d=Document(cache/'source.docx');rr=list(csv.DictReader((cache/'docx-candidates.csv').open(encoding='utf-8-sig')))
entries=collections.defaultdict(list)
for r in rr:entries[ALIASES.get(r['term'],r['term'])].append(r)
old=collections.defaultdict(list)
for f in (ROOT/'backend/src/main/resources/data/decks').glob('lib-*.json'):
 for w in json.loads(f.read_text(encoding='utf8'))['words']:old[w['word']].append(f.stem)
db=ROOT/'backend/src/main/resources/lexical/dictionary_en_vi.db';assert sha256(db)=='2b65bea9577c2a4149caa90940c806f321d1c6cfac503ed8bbd9f93e43a0033a'
con=sqlite3.connect(f'file:{db}?mode=ro&immutable=1',uri=True)
sql='select w.word,d.pos,d.definition,wd.example,wd.id,d.id from words w join word_definitions wd on wd.word_id=w.id join definitions d on wd.definition_id=d.id where wd.example is not null'
dictionary=collections.defaultdict(list)
for word,pos,g,e,lid,did in con.execute(sql):
 if word.lower() in entries:dictionary[word.lower()].append((SQLITE_POS.get(pos),norm(g),norm(e),lid,did))
lem,syn=load_wordnet(cache);cefr=load_cefr(cache)
wiki=collections.defaultdict(list)
for l in gzip.open(cache/'viwiki.jsonl.gz','rt',encoding='utf-8'):
 x=json.loads(l);word=x.get('word','').lower()
 if x.get('lang_code')!='en' or word not in entries:continue
 for i,s in enumerate(x.get('senses',[]),1):
  for e in s.get('examples',[]):
   if e.get('ref') or s.get('form_of') or s.get('alt_of') or s.get('tags') or not e.get('translation'):continue
   wiki[word].append(({'adj':'adjective','adv':'adverb'}.get(x.get('pos'),x.get('pos')),norm(' '.join(s.get('glosses',[]))),norm(e['text']),norm(e['translation']),i))
rows=[];ledger=[]
for word,loc in entries.items():
 base={'word':word,'raw':sorted({r['term'] for r in loc}),'locations':[int(r['paragraph']) for r in loc],'week':int(loc[0]['week'])}
 if word in HELD or word in old:
  ledger.append({**base,'outcome':'held' if word in HELD else 'already published','reason':HELD.get(word) or old[word]});continue
 ref=' '.join(p.text for p in d.paragraphs[int(loc[0]['paragraph'])-1:int(loc[0]['paragraph'])+4])
 ref=re.split(r'\bEx(?:ample)?\s*\d*\s*[:.]',ref,1,flags=re.I)[0][:750]
 posref={'noun':'noun','n':'noun','v':'verb','verb':'verb','adj':'adjective','adjective':'adjective','adv':'adverb','adverb':'adverb'}
 wanted={posref[k] for k in re.findall(r'(?:\(|\[|,\s*|\. )\s*(noun|verb|adjective|adverb|n|v|adj|adv)\b',ref,re.I) if k in posref}
 opts=[]
 def add(pos,g,en,vi,source,idx):
  if not pos or not 2<=len(g)<=180 or not 3<=len(en.split())<=25 or not exact(word,en):return
  if re.search(r'[<>{}|=\[\]]|[.]{3}',g+en+(vi or '')) or re.search(r'\b(?:thô tục|từ cổ|miệt thị)\b',g,re.I):return
  score=3*sim(g,ref)+(.9 if pos in wanted else 0)+(.75 if vi else 0)
  if re.search(r'they discussed|used the .* today|talked about the|looked at the .* yesterday|an example of|learned about .* today',en,re.I):score-=3
  if 5<=len(en.split())<=15:score+=.35
  if len(g)>85:score-=.5
  opts.append((score,pos,g,en,vi,source,idx))
 for pos,g,e,lid,did in dictionary[word]:add(pos,g,e,None,'skypedia',lid)
 for pos,g,e,vi,i in wiki[word]:add(pos,g,e,vi,'viwiktionary',i)
 opts.sort(key=lambda v:-v[0])
 if not opts:rows.append({**base,'pos':next(iter(sorted(wanted)),None),'draft':None});continue
 score,pos,g,en,vi,source,idx=opts[0]
 wn=sorted(set(lem.get(word,{}).get(pos,[])),key=lambda k:(-sim(syn[k]['definition'],ref),k))
 best=wn[0] if wn else None;defn=syn[best]['definition'] if best else ''
 rows.append({**base,'pos':pos,'draft':{'vi':g,'en':en,'tr':vi,'src':source,'loc':idx,'def':defn,'syn':best,'level':cefr.get((word,pos))},'alternatives':[(p,gg,ee,v,so,j) for _,p,gg,ee,v,so,j in opts[1:4]]})
(out/'draft.json').write_text(json.dumps(rows,ensure_ascii=False),encoding='utf8')
(out/'preexisting-or-held.json').write_text(json.dumps(ledger,ensure_ascii=False),encoding='utf8')
print('canonical',len(entries),'held or covered',len(ledger),'drafts',len(rows),'missing',sum(not r['draft'] for r in rows),'needs translation',sum(bool(r['draft'] and not r['draft']['tr']) for r in rows))
