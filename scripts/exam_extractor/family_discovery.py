"""Source-proven scanned IELTS chapter discovery, independent of indexed test records."""
from __future__ import annotations
import json,re
from .corpus import TestRecord
from .diagnostics import DiagnosticLog

TEST_LABEL=re.compile(r'(?:(?:Exam\s+Practice|Practice|Training)\s+)?Test\s*(\d{1,2})(?:\s*\(Academic\s+Module\))?',re.I)

def printed_test(text):
    match=TEST_LABEL.fullmatch(text.strip())
    return int(match[1]) if match else None

def badge_words(words):
    from .ocr_engine import OcrWord
    out=list(words)
    for word in words:
        if not re.fullmatch("Test['’]?",word.text.strip(),re.I):continue
        x0,y0,x1,y1=word.bbox;center=(y0+y1)/2
        digits=[v for v in words if re.fullmatch(r'\d{1,2}',v.text.strip()) and x1<=v.bbox[0]<=x1+(y1-y0)*2 and abs((v.bbox[1]+v.bbox[3])/2-center)<max(y1-y0,v.bbox[3]-v.bbox[1])*.7]
        if len(digits)==1:
            v=digits[0];out.append(OcrWord('Test '+v.text,(x0,min(y0,v.bbox[1]),v.bbox[2],max(y1,v.bbox[3])),min(word.conf,v.conf)))
    return out

def proposed_folio(text):
    match=re.fullmatch(r'\s*(\d{1,3})(?:\s*[_\-–]+)?\s*',text)
    return int(match[1]) if match else None

def contents_entries(words):
    """Pair a printed contents label with its own aligned page numeral."""
    entries=[]
    for word in words:
        title=word.text.strip()
        x0,y0,x1,y1=word.bbox;center=(y0+y1)/2
        if re.fullmatch('General',title,re.I):
            continuation=[v for v in words if re.match('^Training\\b',v.text.strip(),re.I) and v.bbox[0]>=x1-(y1-y0)*.3 and abs((v.bbox[1]+v.bbox[3])/2-center)<=max(y1-y0,v.bbox[3]-v.bbox[1])*.7]
            if len(continuation)==1:
                title+=' '+continuation[0].text.strip();x1=continuation[0].bbox[2]
        if title.lower()=='answer':
            continuation=[v for v in words if v.text.strip().lower()=='key' and x1-2<=v.bbox[0]<=x1+(y1-y0)*2 and abs((v.bbox[1]+v.bbox[3])/2-center)<max(y1-y0,v.bbox[3]-v.bbox[1])*.7]
            if len(continuation)==1:title+=' Key';x1=continuation[0].bbox[2]
        if not (printed_test(title) is not None or
                re.match(r'^(?:Audio|Tape)scripts|^General\s+Training|^Listening\s+and\s+Reading\s+Answer|^Answer\s+Key$|^(?:Model|Sample)\b',title,re.I)):
            continue
        numbers=[v for v in words if proposed_folio(v.text) is not None and
                 v.bbox[0]>x1 and abs((v.bbox[1]+v.bbox[3])/2-center)<=max(y1-y0,v.bbox[3]-v.bbox[1])*.7]
        numbers=[v for v in numbers if not any(other.text.strip() and proposed_folio(other.text) is None and x1<other.bbox[0]<v.bbox[0] and abs((other.bbox[1]+other.bbox[3])/2-center)<=max(y1-y0,other.bbox[3]-other.bbox[1])*.7 for other in words)]
        folio_label=None
        if not numbers and printed_test(title) is not None:
            next_tests=[v.bbox[1] for v in words if printed_test(v.text) is not None and v.bbox[1]>y1 and abs(v.bbox[0]-x0)<(y1-y0)*2]
            limit=min(next_tests) if next_tests else float('inf')
            listening=[v for v in words if v.text.strip().lower()=='listening' and y1<=v.bbox[1]<limit and v.bbox[0]>=x0]
            if len(listening)==1:
                v=listening[0];fc=(v.bbox[1]+v.bbox[3])/2
                numbers=[n for n in words if proposed_folio(n.text) is not None and n.bbox[0]>v.bbox[2] and abs((n.bbox[1]+n.bbox[3])/2-fc)<=max(v.bbox[3]-v.bbox[1],n.bbox[3]-n.bbox[1])*.7]
                folio_label=v.bbox
        if not numbers and re.match(r'^General\s+Training|^(?:Model|Sample)\b',title,re.I):
            following=[v for v in words if v.bbox[1]>=y1-(y1-y0)*.2 and v.bbox[1]<=y1+(y1-y0)*1.5 and abs(v.bbox[0]-x0)<(y1-y0)*2 and re.fullmatch(r'Reading|Writing|Academic\s+Module',v.text.strip(),re.I)]
            if len(following)==1:
                v=following[0];fc=(v.bbox[1]+v.bbox[3])/2
                numbers=[n for n in words if proposed_folio(n.text) is not None and n.bbox[0]>v.bbox[2] and abs((n.bbox[1]+n.bbox[3])/2-fc)<=max(v.bbox[3]-v.bbox[1],n.bbox[3]-n.bbox[1])*.7]
                folio_label=v.bbox
        if len(numbers)!=1:continue
        number=proposed_folio(numbers[0].text)
        if number<1:continue
        number_test=printed_test(title)
        kind='TEST' if number_test is not None else 'GENERAL' if title.lower().startswith('general') else 'TRANSCRIPT' if re.match(r'^(?:Audio|Tape)scripts',title,re.I) else 'KEY' if title.lower().startswith(('listening','answer')) else 'END' if re.match('^Sample\\s+Answer\\s+Sheets',title,re.I) else 'SAMPLE'
        entry=dict(kind=kind,test=number_test,printedPage=number)
        if folio_label:entry['folioLabelBox']=folio_label
        entries.append(entry)
    return sorted(entries,key=lambda r:(r['printedPage'],r['kind']))

def own_badge(layer,page,words,cache,expected):
    badges=[v for v in badge_words(words) if printed_test(v.text) is not None]
    if not badges or {printed_test(v.text) for v in badges}!={expected}:return None
    # A chapter can print the same identity in its heading and running header.
    # Read the larger physical badge; conflicting printed digits remain unresolved.
    word=max(badges,key=lambda v:v.bbox[3]-v.bbox[1]);w,h=layer.page_size(page);x0,y0,x1,y1=word.bbox;pad=(y1-y0)*.2
    box=(max(0,x0-pad),max(0,y0-pad),min(w,x1+pad),min(h,y1+pad))
    allowlist='TESTtest0123456789' if re.fullmatch(r'Test\s*\d{1,2}',word.text.strip(),re.I) else 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789()'
    for dpi in [300,450]:
        reads=[]
        for prep in ['P0','P2']:
            result=cache.recognize(layer,page,box,dpi=dpi,pipeline=prep,allowlist=allowlist,boxes_pt=[box])
            if not result or len(result.words)!=1 or result.words[0].conf<.85:break
            match=re.fullmatch(r'(?:(?:EXAMPRACTICE|PRACTICE|TRAINING))?TEST(\d{1,2})(?:\(ACADEMICMODULE\))?',re.sub(r'\s+','',result.words[0].text).upper())
            if not match:break
            reads.append(int(match[1]))
        if reads==[expected,expected]:return dict(page=page,printedTest=expected,reads=reads,bbox=box,dpi=dpi)
    # Widely separated TEST and numeral glyphs can defeat a single word crop.
    # Each physical component must independently agree across both rereads.
    labels=[v for v in words if re.fullmatch("Test['’]?",v.text.strip(),re.I) and box[0]<=v.bbox[0] and v.bbox[2]<=box[2] and box[1]<=v.bbox[1] and v.bbox[3]<=box[3]]
    digits=[v for v in words if v.text.strip()==str(expected) and box[0]<=v.bbox[0] and v.bbox[2]<=box[2] and box[1]<=v.bbox[1] and v.bbox[3]<=box[3]]
    if len(labels)==len(digits)==1:
        for dpi in [300,450]:
            proved=[]
            for glyph,alphabet,literal in [(labels[0],'TESTtest','TEST'),(digits[0],'0123456789',str(expected))]:
                gx0,gy0,gx1,gy1=glyph.bbox;gp=(gy1-gy0)*.2
                crop=(max(0,gx0-gp),max(0,gy0-gp),min(w,gx1+gp),min(h,gy1+gp));reads=[]
                for prep in (['P0','P4'] if literal=='TEST' else ['P0','P2']):
                    result=cache.recognize(layer,page,crop,dpi=dpi,pipeline=prep,allowlist=alphabet,boxes_pt=[crop])
                    reads.append(bool(result and len(result.words)==1 and result.words[0].conf>=.85 and result.words[0].text.strip().upper()==literal))
                proved.append(all(reads))
            if all(proved):return dict(page=page,printedTest=expected,reads=[expected,expected],bbox=box,dpi=dpi,componentGlyphReads=True)
    return None

def dual_contents_tests(layer,page,words,cache,entries):
    for row in entries:
        if row['kind']!='TEST':continue
        labels=[v for v in words if printed_test(v.text)==row['test']]
        if len(labels)!=1 or not own_badge(layer,page,labels,cache,row['test']):return False
        label=labels[0];folio_box=row.get('folioLabelBox',label.bbox);center=(folio_box[1]+folio_box[3])/2
        numbers=[v for v in words if proposed_folio(v.text)==row['printedPage'] and v.bbox[0]>folio_box[2] and abs((v.bbox[1]+v.bbox[3])/2-center)<=max(folio_box[3]-folio_box[1],v.bbox[3]-v.bbox[1])*.7]
        numbers=[v for v in numbers if not any(other.text.strip() and proposed_folio(other.text) is None and folio_box[2]<other.bbox[0]<v.bbox[0] and abs((other.bbox[1]+other.bbox[3])/2-center)<=max(folio_box[3]-folio_box[1],other.bbox[3]-other.bbox[1])*.7 for other in words)]
        if len(numbers)!=1:return False
        w,h=layer.page_size(page);x0,y0,x1,y1=numbers[0].bbox;pad=(y1-y0)*.2
        box=(max(0,x0-pad),max(0,y0-pad),min(w,x1+pad),min(h,y1+pad))
        confirmed=False
        for refined in [False,True]:
            if refined:box=contents_digit_box(layer,page,box)
            for dpi in [300,450]:
                reads=[]
                for prep in ['P0','P2']:
                    result=cache.recognize(layer,page,box,dpi=dpi,pipeline=prep,allowlist='0123456789',boxes_pt=[box])
                    reads.append(bool(result and len(result.words)==1 and result.words[0].conf>=.85 and result.words[0].text.strip()==str(row['printedPage'])))
                if all(reads):confirmed=True;break
            if confirmed:break
        if not confirmed:return False
    return True

def contents_digit_box(layer,page,box):
    """Isolate the physical numeral ink from a detached underline/noise mark."""
    import cv2
    from .ocr_engine import render_region
    image=render_region(layer,page,box,dpi=450)
    gray=cv2.cvtColor(image,cv2.COLOR_RGB2GRAY)
    ink=cv2.threshold(gray,0,255,cv2.THRESH_BINARY_INV+cv2.THRESH_OTSU)[1]
    stats=cv2.connectedComponentsWithStats(ink)[2][1:]
    if not len(stats):return box
    height=max(int(s[3]) for s in stats)
    glyphs=[s for s in stats if s[3]>=height*.6 and s[4]>=8]
    if not glyphs:return box
    left=min(int(s[0]) for s in glyphs);top=min(int(s[1]) for s in glyphs)
    right=max(int(s[0]+s[2]) for s in glyphs);bottom=max(int(s[1]+s[3]) for s in glyphs)
    scale=72/450;pad=height*.15
    return (max(box[0],box[0]+(left-pad)*scale),max(box[1],box[1]+(top-pad)*scale),min(box[2],box[0]+(right+pad)*scale),min(box[3],box[1]+(bottom+pad)*scale))

def own_listening_heading(layer,page,words,cache):
    """Reread the physical skill glyph when inverse small type is corrupted."""
    if any(re.match(r'^LISTENING(?:\s+(?:MODULE|PART)\b|$)',v.text.strip(),re.I) for v in words):return True
    w,h=layer.page_size(page)
    proposals=[v for v in words if v.bbox[1]<h*.25 and re.match('^LIST',v.text.strip(),re.I)]
    for word in proposals:
        x0,y0,x1,y1=word.bbox;pad=(y1-y0)*.3
        box=(max(0,x0-pad),max(0,y0-pad),min(w,x1+pad),min(h,y1+pad))
        for dpi in [300,450]:
            reads=[]
            for prep in ['P0','P4']:
                r=cache.recognize(layer,page,box,dpi=dpi,pipeline=prep,allowlist='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',boxes_pt=[box])
                reads.append(bool(r and len(r.words)==1 and r.words[0].conf>=.85 and r.words[0].text.strip().upper()=='LISTENING'))
            if all(reads):return True
    return False

def discover_per_test_ielts_family(ex,book):
    """Prove each separate question file from its own chapter badge and final skill."""
    family,collection,record=ex.manifest.books[book]
    sources=[d for d in record.get('source_documents',[]) if d.get('role')=='PER_TEST_BOOK' and d['path'].lower().endswith('.pdf')]
    if family!='IELTS' or collection!='practice-tests-plus' or not sources:return [],None
    cache=ex.region_cache();records=[];windows={};hashes={};proofs={};failures=[]
    for source in sources:
        expected=source.get('test_from_name');layer=ex.layer(source['path'],DiagnosticLog(),'FAMILY_DISCOVERY')
        if not expected or layer is None or layer.sha256!=source.get('sha256'):continue
        w,h=layer.page_size(1);found=None
        for prep in ['P0','P2','P4']:
            read=cache.recognize(layer,1,(0,0,w,h*.25),dpi=180,pipeline=prep)
            if read and own_listening_heading(layer,1,read.words,cache):found=own_badge(layer,1,read.words,cache,expected)
            if found:break
        ew,eh=layer.page_size(layer.page_count)
        ending=cache.recognize(layer,layer.page_count,(0,0,ew,eh*.25),dpi=180,pipeline='P0')
        if not found or not ending or not any(re.match(r'^SPEAKING\s+MODULE\b',v.text.strip(),re.I) for v in ending.words):
            failures.append(dict(source=source['path'],reason='OWN_CHAPTER_OR_FINAL_SKILL_UNRESOLVED'));continue
        indexed=next((t for t in ex.manifest.select(book=book) if t.test_number==expected),None)
        if indexed is None:continue
        raw=dict(indexed.raw,discovery=dict(source=source['path'],sha256=layer.sha256,page=1,printedTest=expected))
        records.append(TestRecord(family,collection,book,indexed.book_title,indexed.test_id,expected,raw,record))
        windows[expected]=(1,layer.page_count);hashes[expected]=layer.sha256;proofs[expected]=found
    profile=dict(source_sha256_by_test=hashes,test_pages=windows,key_pages=(0,-1),printed_identity_proofs=proofs,force_ocr=True,budget=max((b-a+1 for a,b in windows.values()),default=0))
    path=ex.staging/'reports/identity_discovery'/f'{book}.json';path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(dict(book=book,proofs=proofs,failures=failures,profile=profile),indent=2),encoding='utf-8')
    return records,profile if records else None

def discover_cambridge_family(ex,book):
    """Use dual-read contents and own chapter badges; offsets propose reads only."""
    family,collection,record=ex.manifest.books[book]
    if collection=='practice-tests-plus' and any(d.get('role')=='PER_TEST_BOOK' for d in record.get('source_documents',[])):
        return discover_per_test_ielts_family(ex,book)
    def failed(reason,**details):
        path=ex.staging/'reports/identity_discovery'/f'{book}_failure.json'
        path.parent.mkdir(parents=True,exist_ok=True)
        path.write_text(json.dumps(dict(book=book,reason=reason,details=details),indent=2),encoding='utf-8')
        return [],None
    if family!='IELTS' or (collection not in ('cambridge','practice-tests-plus') and book!='ielts-trainer-2-general'):return [],None
    # A filename-derived manifest role cannot exclude a complete printed book.
    # Contents and chapter proofs below determine whether it contains questions.
    sources=[d for d in record.get('source_documents',[]) if (d.get('role')=='QUESTION_BOOK' or collection=='practice-tests-plus') and d['path'].lower().endswith('.pdf')]
    if len(sources)!=1:return [],None
    source=sources[0];layer=ex.layer(source['path'],DiagnosticLog(),'FAMILY_DISCOVERY')
    if layer is None or layer.sha256!=source.get('sha256'):return [],None
    cache=ex.region_cache();entries=[];contents_page=None
    for page in range(1,min(10,layer.page_count)+1):
        w,h=layer.page_size(page);box=(0,0,w,h)
        first=cache.recognize(layer,page,box,dpi=180,pipeline='P0')
        if not first:continue
        headings=[v for v in first.words if re.fullmatch('contents',v.text.strip(),re.I)]
        if not headings:
            from difflib import SequenceMatcher
            for word in first.words:
                if word.bbox[3]>h*.2 or SequenceMatcher(None,word.text.upper(),'CONTENTS').ratio()<.7:continue
                x0,y0,x1,y1=word.bbox;pad=(y1-y0)*.2
                crop=(max(0,x0-pad),max(0,y0-pad),min(w,x1+pad),min(h,y1+pad));proved=[]
                for prep in ['P0','P4']:
                    read=cache.recognize(layer,page,crop,dpi=300,pipeline=prep,allowlist='CONTENTScontents',boxes_pt=[crop])
                    proved.append(bool(read and len(read.words)==1 and read.words[0].text.strip().upper()=='CONTENTS' and read.words[0].conf>=.85))
                if all(proved):headings.append(word)
        if not headings:continue
        proposed=contents_entries(first.words)
        if len([r for r in proposed if r['kind']=='TEST'])<2:continue
        if not dual_contents_tests(layer,page,first.words,cache,proposed):continue
        entries=proposed;contents_page=page;break
    if not entries:return failed('CONTENTS_DUAL_READ_UNRESOLVED')
    tests=[r for r in entries if r['kind']=='TEST'];proofs=[]
    for row in tests:
        found=None
        proposal=row['printedPage']+(proofs[0]['page']-proofs[0]['printedPage'] if proofs else 0)
        for page in sorted(range(max(contents_page+1,row['printedPage']-12),min(layer.page_count,row['printedPage']+12)+1),key=lambda p:abs(p-proposal)):
            w,h=layer.page_size(page)
            for prep in ['P0','P2','P4']:
                result=cache.recognize(layer,page,(0,0,w,h*.65),dpi=180,pipeline=prep)
                if not result or not own_listening_heading(layer,page,result.words,cache):continue
                found=own_badge(layer,page,result.words,cache,row['test'])
                if found:break
            if found:break
        if found:proofs.append(dict(found,printedPage=row['printedPage']))
    if len(proofs)!=len(tests):return failed('CHAPTER_DUAL_READ_UNRESOLVED',proved=proofs,expected=[r['test'] for r in tests])
    proofs.sort(key=lambda r:r['page'])
    if [r['printedTest'] for r in proofs]!=[r['test'] for r in tests]:return failed('CHAPTER_ORDER_UNRESOLVED')
    offsets={r['page']-r['printedPage'] for r in proofs}
    if len(offsets)!=1:return failed('CONTENTS_FOLIO_MAPPING_UNRESOLVED')
    offset=next(iter(offsets));boundaries={}
    for row in entries:
        if row['kind']=='TEST':continue
        page=row['printedPage']+offset
        if not 1<=page<=layer.page_count:continue
        w,h=layer.page_size(page);box=(0,0,w,h*.45)
        reads=[]
        for prep in ['P0','P2']:
            result=cache.recognize(layer,page,box,dpi=220,pipeline=prep)
            text=' '.join(v.text for v in result.words) if result else ''
            pattern={'TRANSCRIPT':r'\b(?:Audio|Tape)scripts?\b','GENERAL':r'\bGeneral\s+Training\b','KEY':r'\b(?:Listening\b.*\bReading\b.*\bAnswer\s*keys?|Answer\s*key)\b','SAMPLE':r'\b(?:Sample|Model)\b.*\b(?:Writing|answers?)\b','END':r'\bSample\s+Answer\s+Sheets\b'}[row['kind']]
            reads.append(bool(re.search(pattern,text,re.I)))
        if not all(reads):
            inverse=cache.recognize(layer,page,box,dpi=220,pipeline='P4')
            inverse_text=' '.join(v.text for v in inverse.words) if inverse else ''
            if sum(reads)+int(bool(re.search(pattern,inverse_text,re.I)))>=2:reads=[True,True]
        if not all(reads) and row['kind'] in ('GENERAL','TRANSCRIPT','KEY'):
            from difflib import SequenceMatcher
            literals={'GENERAL':['GENERAL','TRAINING'],'TRANSCRIPT':['TAPESCRIPTS'],'KEY':['ANSWER','KEY']}[row['kind']]
            heading=cache.recognize(layer,page,box,dpi=220,pipeline='P0')
            verified=[]
            for literal in literals:
                choices=[v for v in (heading.words if heading else []) if v.bbox[3]<h*.2 and SequenceMatcher(None,v.text.upper().strip('_'),literal).ratio()>=.7]
                if len(choices)!=1:verified.append(False);continue
                x0,y0,x1,y1=choices[0].bbox;pad=(y1-y0)*.2
                crop=(max(0,x0-pad),max(0,y0-pad),min(w,x1+pad),min(h,y1+pad));proved=False
                for dpi in [300,450]:
                    own=[]
                    for prep in ['P0','P2','P4']:
                        read=cache.recognize(layer,page,crop,dpi=dpi,pipeline=prep,allowlist=''.join(sorted(set(literal+literal.lower()))),boxes_pt=[crop])
                        own.append(bool(read and len(read.words)==1 and read.words[0].text.strip().upper()==literal and read.words[0].conf>=.85))
                    if sum(own)>=2:proved=True;break
                verified.append(proved)
            if all(verified):reads=[True,True]
        if all(reads):boundaries.setdefault(row['kind'],page)
    end_candidates=[p for kind,p in boundaries.items() if kind in ['TRANSCRIPT','GENERAL','END','KEY','SAMPLE'] and p>proofs[-1]['page']]
    if not end_candidates:return failed('BACK_MATTER_BOUNDARY_UNRESOLVED',boundaries=boundaries)
    end=min(end_candidates)-1
    key_start=boundaries.get('KEY')
    key_ends=[p for kind,p in boundaries.items() if kind in ['SAMPLE','TRANSCRIPT'] and key_start and p>key_start]
    key_end=min(key_ends) if key_ends else None
    keys=(key_start,key_end-1) if key_start and key_end and key_end>key_start else (0,-1)
    windows={r['printedTest']:(r['page'],proofs[i+1]['page']-1 if i+1<len(proofs) else end) for i,r in enumerate(proofs)}
    profile=dict(source_sha256=layer.sha256,test_pages=windows,key_pages=keys,printed_identity_proofs={r['printedTest']:r for r in proofs},force_ocr=True,budget=max(b-a+1 for a,b in windows.values())+max(0,keys[1]-keys[0]+1))
    evidence=dict(book=book,source=source['path'],sha256=layer.sha256,contentsPage=contents_page,contents=entries,chapterProofs=proofs,boundaries=boundaries,profile=profile)
    path=ex.staging/'reports/identity_discovery'/f'{book}.json';path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(evidence,indent=2),encoding='utf-8')
    records=[]
    for row in proofs:
        number=row['printedTest'];tid=f'ielts/{book}/test-{number}'
        indexed=next((t for t in ex.manifest.select(book=book) if t.test_number==number),None)
        raw=dict(test_id=tid,test_number=number,identified_by=['OWN_PRINTED_CONTENTS_AND_CHAPTER_DUAL_READ'],source_documents=[],audio=indexed.raw.get('audio',[]) if indexed else [],extraction_readiness='NEEDS_REVIEW',answer_key_status='UNKNOWN_NEEDS_OCR',transcript_status='UNKNOWN_NEEDS_OCR',flags=['PIPELINE_DISCOVERED_PRINTED_CHAPTER'],discovery=dict(source=source['path'],sha256=layer.sha256,page=row['page'],printedTest=number))
        records.append(TestRecord(family,collection,book,record.get('title') or book,tid,number,raw,record))
    return records,profile
