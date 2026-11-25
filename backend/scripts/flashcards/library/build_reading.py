"""Build the follow-up corpus. Drafts without a recorded editorial decision or a passing evidence gate stay private.
Snapshot mode writes reviewable release artefacts only. Replaying frozen release files never starts the seeder.
"""
import collections,csv,hashlib,json,re,sys,unicodedata
from pathlib import Path
from sense_supplement import ipa_table
HERE=Path(__file__).resolve().parent;ROOT=HERE.parents[3];sys.path.insert(0,str(HERE.parent/'vocabulary'))
from sources import load_cefr
TOP={'evidence':'Lập luận và bằng chứng','communication':'Diễn đạt và giao tiếp','work':'Công việc và kỹ năng','civic':'Luật lệ và đời sống công','nature':'Thiên nhiên và môi trường','science':'Khoa học và đo lường','health':'Cơ thể và sức khỏe','people':'Con người và quan hệ','change':'Chuyển động và biến đổi','space':'Không gian và vị trí','time':'Thời gian và trình tự','arts':'Nghệ thuật và biểu đạt','money':'Thu nhập và nguồn lực','language':'Từ ngữ và ý nghĩa','education':'Trường học và nghiên cứu'}
POS={'n':'noun','v':'verb','j':'adjective','r':'adverb','p':'phrase','prep':'preposition'}
OUT=ROOT/'backend/src/main/resources/data/decks';REP=ROOT/'docs/flashcards/library-20261117/completion'
def line(s):
 s=' '.join(unicodedata.normalize('NFC',str(s)).strip(' |').split())
 return (s[:1].upper()+s[1:]).rstrip('.')+'.' if s and not s.endswith(('!','?')) else s[:1].upper()+s[1:]
def matches(w,en):
 stem=w.split()[-1];variants=[w,w+'s',w+'ed',w+'d',w+'es',w+'ing',w.rstrip('e')+'ing',w[:-1]+'ies',w[:-1]+'ied',w+w[-1]+'ed',w+w[-1]+'ing']
 return any(re.search(r'(?<![a-z])'+re.escape(t)+r'(?![a-z])',en,re.I) for t in variants)
def read(p,mode):
 q=p/'completion';RELEASE=mode=='publish';REP.mkdir(parents=True,exist_ok=True)
 rows=json.loads((q/'draft.json').read_text(encoding='utf8'));old=json.loads((q/'preexisting-or-held.json').read_text(encoding='utf8'));target={x['word']:x for x in rows};drafts={}
 for f in (q/'drafted').glob('*.json'):
  v=json.loads(f.read_text(encoding='utf8'));drafts[v['w']]=v
 qc=json.loads((q/'qc-results.json').read_text(encoding='utf8')) if (q/'qc-results.json').exists() else {}
 approved={};audit={}
 for w,y in qc.items():
  if y['issues'] or w not in target:continue
  approved[w]=dict(y['draft']);audit[w]=('source-and-parallel-gated',y['scores'])
 for f in sorted((HERE/'reading').glob('*.txt')):
  topic=None
  for l in f.read_text(encoding='utf8').splitlines():
   if not l:continue
   if l.startswith('@'):topic=l[1:];continue
   terms,en,tr=l.split('|')
   for term in terms.split(';'):
    w,pos,vi,de=term.split(':')
    if w not in target or (w in audit and audit[w][0]=='authored'):continue
    approved[w]=dict(w=w,pos=POS[pos],vi=vi,**{'def':de},en=en,tr=tr,topic=topic);audit[w]=('authored',f.name)
 for f in sorted((HERE/'review').glob('*.txt')):
  for l in f.read_text(encoding='utf8').splitlines():
   if not l.strip():continue
   cols=l.split('|');w=cols[0]
   if w not in target:continue
   if w in audit and audit[w][0]=='authored':continue
   y=dict(drafts.get(w,{'w':w,'topic':'evidence'}))
   for k,val in zip(['vi','tr','en','def','pos','topic'],cols[1:]):
    if val not in ('','='):y[k]=val
   approved[w]=y;audit[w]=('editorially-revised',f.name)
 ipa=ipa_table(q/'en_US.txt');cefr=load_cefr(p);groups=collections.defaultdict(list);decisions=[];bad=[];allcards={}
 for row in rows:
  w=row['word'];y=approved.get(w)
  if not y:
   reasons=qc.get(w,{}).get('issues') or ['no acceptable bilingual example produced']
   decisions.append([w,'held','; '.join(reasons),'']);continue
  for k in ['pos','vi','def','en','tr','topic']:
   if not isinstance(y.get(k),str) or not y[k].strip():bad.append((w,k))
  if any(x[0]==w for x in bad):continue
  if not matches(w,y['en']):bad.append((w,'example lacks lemma or allowed inflection'));continue
  if not re.search('[À-ỹ]',y['tr']+' '+y['vi']) or re.search('[一-鿿]|[<>{}|]',y['en']+y['tr']+y['vi']+y['def']):bad.append((w,'invalid text'));continue
  if y['pos'] not in {'noun','verb','adjective','adverb','phrase','preposition','conjunction'}:bad.append((w,'POS'));continue
  topic=y['topic'].lower().strip(' .*');topic={'technology':'science','body':'health','emotion':'people','law':'civic','business':'money'}.get(topic,topic);topic=topic if topic in TOP else 'language'
  de=line(y['def']);en=line(y['en']);tr=line(y['tr']);vi=line(y['vi'])
  source={'dataset':'EnglishCoach Reading Lab','license':'EnglishCoach original; authorized for this site','reference':'private headword index; no source-book text','sourceId':hashlib.sha256((w+'|'+y['pos']+'|'+vi).encode()).hexdigest()[:20],'paragraphs':row['locations'],'wordType':'phrase' if ' ' in w else 'word','review':audit[w][0]}
  if w in ipa:source['ipa']='ipa-dict en_US 972cd67; one listed pronunciation'
  lv=cefr.get((w,y['pos']))
  if lv:source['cefr']='CEFR-J 1.5' if lv in ('A1','A2','B1','B2') else 'Octanove 1.0'
  item={'word':w,'pos':y['pos'],'ipa':ipa.get(w),'cefr':lv,'general_translation_vi':vi,'meanings':[de],'examples':[en],'examples_vi':[tr],'source_kind':'reader','source':source}
  groups[topic].append(item);allcards[w]=item;decisions.append([w,'accepted',audit[w][0],topic])
 for x in old:decisions.append([x['word'],x['outcome'],str(x['reason']),''])
 if bad:print('ERROR',len(bad),bad)
 if RELEASE and bad:raise ValueError('fix invalid records before release')
 dest=OUT if RELEASE else q/'pilot';dest.mkdir(exist_ok=True);mf=[];stats=collections.Counter()
 for topic,words in sorted(groups.items()):
  words.sort(key=lambda v:v['word']);parts=(len(words)+54)//55
  for i in range(parts):
   batch=words[len(words)*i//parts:len(words)*(i+1)//parts];slug=f'lib-reader-{topic}-{i+1:02}'
   sub=TOP[topic];title='Đọc học thuật · '+sub+(f" · {batch[0]['word']} – {batch[-1]['word']}" if parts>1 else '')
   obj={'slug':slug,'title':title,'description':'Học từ qua tình huống, đối chiếu nghĩa và đọc câu Anh–Việt.','category':'READING_LAB','themeColor':['indigo','emerald','sky','violet'][len(mf)%4],'icon':'book','sortOrder':340+len(mf),'curated':True,'taxonomy':{'collection':'Luyện thi','category':'Đọc IELTS và TOEFL','topic':sub,'subtopic':'Đọc hiểu trong ngữ cảnh','deck':title},'words':batch}
   blob=json.dumps(obj,ensure_ascii=False,indent=1)+'\n';sha=hashlib.sha256(blob.encode()).hexdigest();f=dest/(slug+'.json')
   if RELEASE and f.exists() and hashlib.sha256(f.read_bytes()).hexdigest()!=sha:raise ValueError('existing release differs; use a new edition')
   f.write_bytes(blob.encode());mf.append({'slug':slug,'topic':topic,'cards':len(batch),'sha256':sha})
 for _,outcome,_,_ in decisions:stats[outcome]+=1
 result={'counts':dict(stats),'newCards':len(allcards),'sensesWithEnglishDefinition':len(allcards),'ipa':sum(bool(v['ipa']) for v in allcards.values()),'cefr':sum(bool(v['cefr']) for v in allcards.values()),'decks':mf,'invalid':bad}
 out=REP if RELEASE else q
 (out/'reading-manifest.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8')
 with (out/'coverage.csv').open('w',newline='',encoding='utf-8-sig') as h:
  c=csv.writer(h);c.writerow(['headword','decision','evidence_or_reason','topic']);c.writerows(sorted(decisions))
 print('coverage',dict(stats),'invalid',len(bad),'decks',len(mf))
if __name__=='__main__':read(Path(sys.argv[1]),sys.argv[2])
