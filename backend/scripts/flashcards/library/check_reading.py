"""Independent bilingual/lexical QA for local drafts; writes candidates and reasons, never DB data."""
import csv,gzip,json,math,os,re,sqlite3,sys,unicodedata
from pathlib import Path
import numpy as np,torch
from transformers import AutoTokenizer,AutoModel
p=Path(sys.argv[1]);q=p/'completion';here=Path(__file__).resolve().parent;sys.path.insert(0,str(here.parent/'vocabulary'))
from sources import load_wordnet,SQLITE_POS
rows=json.loads((q/'draft.json').read_text(encoding='utf8'));wn,ss=load_wordnet(p)
torch.set_num_threads(5);folder=q/'similarity-model';tok=AutoTokenizer.from_pretrained(folder,local_files_only=True);model=AutoModel.from_pretrained(folder,local_files_only=True).eval()
written={s.split(':')[0] for f in (here/'reading').glob('*.txt') for l in f.read_text(encoding='utf8').splitlines() if '|' in l for s in l.split('|')[0].split(';')}
review={l.split('|')[0] for f in (here/'review').glob('*.txt') for l in f.read_text(encoding='utf8').splitlines() if '|' in l}
def clean(s):return ' '.join(unicodedata.normalize('NFC',s).lower().split())
def key(s):return ' '+re.sub(r'[^\w]+',' ',clean(s)).strip()+' '
def present(w,t):
 opts={w,w+'s',w+'ed',w+'d',w+'es',w+'ing',w.rstrip('e')+'ing',w[:-1]+'ies',w[:-1]+'ied',w+w[-1]+'ed',w+w[-1]+'ing'}
 return any(' '+v+' ' in key(t) for v in opts)
db=here.parents[2]/'src/main/resources/lexical/dictionary_en_vi.db'
assert db.exists()
conn=sqlite3.connect(f'file:{db}?mode=ro&immutable=1',uri=True)
lex={};wanted={x['word'] for x in rows}
for w,pos,g in conn.execute('select w.word,d.pos,d.definition from words w join word_definitions wd on wd.word_id=w.id join definitions d on wd.definition_id=d.id'):
 if w.lower() in wanted and pos in SQLITE_POS:lex.setdefault((w.lower(),SQLITE_POS[pos]),[]).append(g)
drafts={};alltexts=set()
for f in (q/'drafted').glob('*.json'):
 y=json.loads(f.read_text(encoding='utf8'));w=y['w'];pos=y['pos'].strip().lower()
 if w in written or w in review:continue
 gloss=[g for g in lex.get((w,pos),[]) if 2<=len(g)<200][:10]
 defs=[ss[k]['definition'] for k in wn.get(w,{}).get(pos,[]) if k in ss][:12]
 drafts[w]=(y,gloss,defs);alltexts.update([y[k] for k in ('vi','def','en','tr')]+gloss+defs)
sql=sqlite3.connect(q/'qc-vectors.db');sql.execute('create table if not exists vec (text text primary key, v blob not null)')
vec={s:np.frombuffer(v,dtype=np.float32) for s,v in sql.execute('select text,v from vec')};missing=sorted(alltexts-set(vec))
with torch.inference_mode():
 for k in range(0,len(missing),48):
  strings=missing[k:k+48];t=tok(strings,return_tensors='pt',padding=True,truncation=True,max_length=80)
  h=model(**t).last_hidden_state;m=t.attention_mask.unsqueeze(-1);v=torch.nn.functional.normalize((h*m).sum(1)/m.sum(1),p=2,dim=1).numpy()
  for txt,arr in zip(strings,v):vec[txt]=arr;sql.execute('insert or ignore into vec values (?,?)',(txt,arr.tobytes()))
  sql.commit()
out={}
for w,(v,gloss,defs) in drafts.items():
 de,vi,en,tr=[v[s].strip() for s in ('def','vi','en','tr')];trsim=float(vec[en]@vec[tr]);sense=float(vec[vi]@vec[de]);enref=max([float(vec[de]@vec[g]) for g in defs] or [-1]);viref=max([float(vec[vi]@vec[g]) for g in gloss] or [-1]);issues=[]
 if not present(w,en):issues.append('target-not-in-example')
 if not re.search('[À-ỹ]',vi) or not re.search('[À-ỹ]',tr):issues.append('Vietnamese text')
 if not (4<=len(en.split())<=28 and .69<=len(tr.split())/max(1,len(en.split()))<=3):issues.append('incomplete sentence or length')
 if re.findall(r'\d+',en)!=re.findall(r'\d+',tr):issues.append('numeric mismatch')
 if trsim<.84:issues.append('translation not corroborated')
 if sense<.57:issues.append('meaning/definition mismatch')
 if max(enref,viref)<.65 or min(enref,viref)<.20:issues.append('sense/POS not independently supported')
 if key(tr)==key(vi) or len(tr.split())<4 or re.search(r'[一-鿿]|[<>{}|]|\.{3}',de+vi+en+tr):issues.append('bad field or gloss repeated')
 if key(w) in key(de):issues.append('circular definition')
 out[w]={'scores':[round(x,3) for x in (trsim,sense,enref,viref)],'issues':issues,'draft':v}
(q/'qc-results.json').write_text(json.dumps(out,ensure_ascii=False),encoding='utf8')
print('scored',len(out),'passed',sum(not v['issues'] for v in out.values()),'new vectors',len(missing))
