"""Prepare licensed sense-linked bilingual cards; never ingest a commercial book into the release."""
import collections,csv,gzip,hashlib,json,re,sys,unicodedata
from pathlib import Path
from urllib.parse import quote
HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[3]
sys.path.insert(0,str(HERE.parent/'vocabulary'))
from sources import load_cefr,load_wordnet,sha256
OUT=ROOT/'backend/src/main/resources/data/decks'
REPORT=ROOT/'docs/flashcards/library-20261117'
norm=lambda t:' '.join(unicodedata.normalize('NFC',t).split())
POS={'noun':'noun','verb':'verb','adj':'adjective','adv':'adverb','phrase':'phrase'}
TOPICS={'noun.artifact':('objects','Vật dụng và công nghệ'),'noun.act':('activity','Hoạt động'),'noun.communication':('communication','Giao tiếp'),'noun.cognition':('ideas','Nhận thức và ý tưởng'),'noun.attribute':('qualities','Đặc điểm và tính chất'),'noun.person':('people','Con người'),'noun.location':('places','Địa điểm'),'noun.state':('states','Trạng thái'),'noun.group':('groups','Tổ chức và tập thể'),'noun.time':('time','Thời gian'),'noun.quantity':('quantities','Số lượng'),'noun.food':('food','Thức ăn'),'noun.animal':('animals','Động vật'),'noun.body':('body','Cơ thể'),'noun.substance':('materials','Chất liệu'),'verb.motion':('motion','Chuyển động'),'verb.communication':('speaking','Diễn đạt'),'verb.cognition':('thinking','Suy nghĩ'),'verb.change':('changes','Sự thay đổi'),'verb.social':('social','Tương tác xã hội')}
BAD=re.compile(r'\b(?:từ cổ|thô tục|nghĩa cổ|miệt thị|tục tĩu|slur|nigger|fuck|cunt|đồ đĩ|địt|xem thêm|viết tắt|dạng số|số nhiều của|phân từ của|số nhiều|ít dùng|hiếm dùng|từ hiếm|từ Mỹ|định ngữ|nội động từ|ngoại động từ)\b|[<>{}\[\]=|…]',re.I)
def write_csv(path,cols,rows):
    with path.open('w',encoding='utf-8-sig',newline='') as f:
        out=csv.writer(f);out.writerow(cols);out.writerows(rows)
def main(cache,mode):
    lock=json.loads((HERE.parent/'vocabulary/sources.lock.json').read_text())['sources']
    for l in lock:
        if l['id'] in {'oewn-2025','cefrj-vocabulary-1.5','octanove-c1c2-1.0'}:assert sha256(cache/l['file'])==l['sha256']
    wh='1f0abd21982660b5fc2eff5eb3fbacbed2d9fe8f476af794dbed0d927ffb8187'
    assert sha256(cache/'viwiki.jsonl.gz')==wh
    wn,ss=load_wordnet(cache);levels=load_cefr(cache)
    doc={r['term']:r for r in csv.DictReader((cache/'docx-candidates.csv').open(encoding='utf-8-sig')) if r['status']=='structured'}
    groups=collections.defaultdict(list); counts=collections.Counter();seen=set();samples=[]
    held=set("extol suffice conspicuous tenacious veritable alternative version hurt live think personal quiet good great sweet very culture night jet match rain sea type woman depend expect fail return wonder certainly empty mean most possible wet affair author desert mystery purpose quality range analyse permit touch former inconvenient numerous slightly surely unlikely certainty council decline deed general leadership notion prize tendency thunder trend modest neat packed scarcely so-called ultimately ambassador motion plot segment tract connote removed verbatim latitude overtake fund pattern principle lately surely correct full only decent former verity talk concrete scarcely slight dear plentiful altar care not culture".split())
    for l in gzip.open(cache/'viwiki.jsonl.gz','rt',encoding='utf-8'):
        x=json.loads(l)
        if x.get('lang_code')!='en':continue
        counts['input_entries']+=1
        word=x['word'];pos=POS.get(x.get('pos'));level=levels.get((word,pos))
        if word in held:continue  # editorial review of both sides of the pinned bilingual examples
        if not pos or not re.fullmatch("[a-z]+(?:[ '-][a-z]+){0,3}",word) or not (level or word in doc):continue
        ids=wn.get(word,{}).get(pos,[]);files={ss[k]['lexfile'] for k in ids if k in ss}
        for i,s in enumerate(x.get('senses',[]),1):
            if not s.get('examples'):continue
            counts['extracted_senses']+=1
            gloss=norm(' '.join(s.get('glosses',[])))
            if not 2<=len(gloss)<=145 or '(' in gloss or s.get('form_of') or s.get('tags') or s.get('alt_of') or BAD.search(gloss):continue
            # The pilot exposed archaic senses of common A1/A2 words and weak example translations.
            # Require a simple first sense with a substantive gloss attested in the actual Vietnamese example.
            if i!=1 or len(gloss)>85 or ';' in gloss or word in {'it','not','galore','spawn','choose','gravitate','overlook'}:continue
            for e in s['examples']:
                en=norm(e.get('text',''));vi=norm(e.get('translation',''))
                if e.get('ref') or e.get('type')=='quote' or not(4<=len(en.split())<=20 and 3<=len(vi.split())<=34) or not re.search(r'[À-ỹ]',vi):continue
                if not re.search(r'(?<![a-z])'+re.escape(word)+r'(?![a-z])',en,re.I) or BAD.search(en+' '+vi) or re.search(r'[();/:&]',en+' '+vi):continue
                if en.lower().startswith('to ') or not any(c.isalpha() for c in gloss):continue
                wording=[t.strip(' .!?').casefold() for t in gloss.split(',')]
                if not any(len(t)>=3 and re.search(r'(?<!\w)'+re.escape(t)+r'(?!\w)',vi,re.I) for t in wording):continue
                if word in seen:counts['other_senses_or_duplicates_held']+=1;break
                lex=next(iter(files)) if len(files)==1 else ''
                topic,title=TOPICS.get(lex,{'noun':('nouns','Danh từ trong ngữ cảnh'),'verb':('actions','Động từ trong ngữ cảnh'),'adjective':('describing','Từ miêu tả'),'adverb':('adverbs','Trạng từ trong ngữ cảnh')}.get(pos,('expressions','Cụm từ trong ngữ cảnh')))
                if word in doc:
                    cat,band='EXAM_READING','Đọc học thuật';group='reading'
                else:cat,band,group='GENERAL_CEFR',level,level.lower()
                key=(cat,group,band,topic,title)
                source={'dataset':'viwiktionary','url':'https://vi.wiktionary.org/wiki/'+quote(word.replace(' ','_'))+'#Tiếng_Anh','pos':pos,'sense':i,'license':'CC BY-SA 4.0','attribution':'Các tác giả Wiktionary tiếng Việt, qua Wiktextract / Kaikki','adaptation':'Selected sense and bilingual example; spacing normalized.'}
                if word in doc:source['privateReference']={'week':int(doc[word]['week']),'paragraph':int(doc[word]['paragraph'])}
                if level:source['level']='CEFR-J 1.5' if level in ('A1','A2','B1','B2') else 'Octanove C1/C2 1.0'
                defs=[]
                if len(set(ids))==1 and len([q for q in x['senses'] if q.get('glosses')])==1:
                    sid=ids[0];de=ss[sid]['definition']
                    if de and len(de)<245:defs=[de];source['oewn2025']=sid
                ipa=next((v['ipa'] for v in x.get('sounds',[]) if re.fullmatch(r'/[^/\d\[\]]{1,50}/',v.get('ipa',''))),None)
                # Display normalization only; keep source URL, POS and sense ordinal.
                def sentence(t):
                    return t[:1].upper()+t[1:]+('' if t.endswith(('.', '!', '?')) else '.')
                groups[key].append(dict(word=word,pos=pos,ipa=ipa,cefr=level,general_translation_vi=gloss,meanings=defs,examples=[sentence(en)],examples_vi=[sentence(vi)],source=source))
                seen.add(word);break
    # Compact thin facets within the same level and part of speech. Never mix CEFR bands to fill a deck.
    compact=collections.defaultdict(list)
    for (cat,group,band,topic,title),ws in groups.items():
        if len(ws)<12 or topic in {'nouns','actions','describing','adverbs'}:
            for v in ws:
                p='things' if v['pos']=='noun' else 'description' if v['pos'] in {'adjective','adverb'} else 'actions'
                label={'things':'Sự vật và khái niệm','description':'Miêu tả và bổ nghĩa','actions':'Hành động trong ngữ cảnh'}[p]
                compact[cat,group,band,p,label].append(v)
        else:compact[cat,group,band,topic,title].extend(ws)
    decks=[]
    for (cat,group,band,topic,title),ws in sorted(compact.items()):
        ws.sort(key=lambda v:v['word'])
        parts=max(1,(len(ws)+54)//55)
        for i in range(parts):
            words=ws[len(ws)*i//parts:len(ws)*(i+1)//parts]
            label=f'{band} · {title}'+(f" · {words[0]['word']} – {words[-1]['word']}" if parts>1 else '')
            decks.append(dict(slug=f'lib-{group}-{topic}-{i+1}',title=label,category=cat,description='Nghĩa và ví dụ song ngữ theo từng ngữ cảnh. Nguồn: Wiktionary tiếng Việt (CC BY-SA 4.0).',themeColor='indigo' if cat=='EXAM_READING' else 'sky',icon='book',sortOrder=200+len(decks),curated=True,words=words))
    originals=HERE/'originals.txt'
    if originals.exists():
        for line in originals.read_text(encoding='utf-8').splitlines():
            if not line.strip():continue
            if line.startswith('@'):
                slug,title,cat,desc=line[1:].split('|')
                d=dict(slug='lib-'+slug,title=title,category=cat,description=desc,themeColor='emerald' if cat=='BIG_IDEAS' else 'violet',icon='book',sortOrder=100+len(decks),curated=True,words=[])
                decks.append(d);continue
            word,pos,vi,de,en,tr=line.split('|')
            assert re.search(r'\b'+re.escape(word)+r'\b',en,re.I),(word,en)
            assert word not in [x['word'] for x in d['words']] and all([pos,vi,de,tr])
            d['words'].append(dict(word=word,pos=pos,cefr=levels.get((word,pos)),general_translation_vi=vi,meanings=[de],examples=[en],examples_vi=[tr],source={'dataset':'EnglishCoach Original','id':d['slug']+'/'+word,'license':'EnglishCoach original; authorized for this site'}))
    inventory=[];manifest=[]
    for d in decks:
        assert d['words'] and len({w['word'] for w in d['words']})==len(d['words'])
        for v in d["words"]:v["source_kind"]="wiki" if v["source"]["dataset"]=="viwiktionary" else "original"
        blob=json.dumps(d,ensure_ascii=False,indent=1)+'\n'
        if mode=='publish':(OUT/(d['slug']+'.json')).write_text(blob,encoding='utf-8',newline='\n')
        manifest.append({'slug':d['slug'],'cards':len(d['words']),'sha256':hashlib.sha256(blob.encode()).hexdigest()})
        inventory.append((d['category'],d['title'],d['slug'],len(d['words'])))
        samples.extend((d['slug'],v['word'],v['general_translation_vi'],v['examples'][0],v['examples_vi'][0]) for v in [d['words'][len(d['words'])//2]])
    write_csv(cache/'samples.csv',['deck','term','meaning','en','vi'],samples)
    write_csv(cache/'all-candidates.csv',['word','pos','gloss','example','translation'],[(v['word'],v['pos'],v['general_translation_vi'],v['examples'][0],v['examples_vi'][0]) for d in decks for v in d['words'] if v['source']['dataset']=='viwiktionary'])
    out=REPORT if mode=='publish' else cache
    write_csv(out/'deck_inventory.csv',['collection','topic_or_deck','slug','cards'],inventory)
    counts['wiki_accepted']=len(seen);counts['total_card_links']=sum(x['cards'] for x in manifest);counts['decks']=len(decks);counts['excluded_candidate_senses']=counts['extracted_senses']-len(seen)
    (out/'import_manifest.json').write_text(json.dumps({'mode':mode,'wiki_sha256':wh,'counts':counts,'decks':manifest},ensure_ascii=False,indent=2),encoding='utf-8')
    print(dict(counts))
if __name__=='__main__':main(Path(sys.argv[1]),sys.argv[2])
