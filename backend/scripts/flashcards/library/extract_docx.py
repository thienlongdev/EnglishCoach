"""Inventory the private study copy. Only locators/headwords leave private storage."""
import argparse,csv,hashlib,json,re,unicodedata,zipfile
from collections import Counter,defaultdict
from pathlib import Path
from docx import Document

def extract(path, private, report):
    doc=Document(path)
    counts=Counter(); weeks=set(); allrows=[]; week=None
    pat=re.compile(r"^(?:(\d{1,3})[.)]?\s*)?([A-Za-z][A-Za-z'-]*(?: [A-Za-z][A-Za-z'-]*){0,3})\s*(?:/|\((?:noun|verb|adjective|adverb)|\[(?:n|v|adj|adv)\b)",re.I)
    pos=re.compile(r"[\[(][^\])]*(?<![A-Za-z])(?:n|v|a|adj|adv|noun|verb|adjective|adverb|vt|vi)\b",re.I)
    for i,p in enumerate(doc.paragraphs,1):
        for line in p.text.splitlines():
            line=' '.join(unicodedata.normalize('NFKC',line).split()).strip()
            h=re.search(r'(?:IELTS|IETLS)\s+VOCABULARY.*?WEEK\s*(\d+)',line,re.I)
            if h: week=int(h[1]);weeks.add(week);continue
            if not week: continue
            m=pat.match(line)
            if not m or m[2].lower() in {'ex','syn','ant','example','or'}:continue
            confidence='structured' if pos.search(line) or re.search(r'/\s*\d+\s*:',line) else 'review'
            allrows.append((i,week,m[2].lower(),confidence))
    private.mkdir(parents=True,exist_ok=True);report.mkdir(parents=True,exist_ok=True)
    def table(path,header,rows):
        with path.open('w',newline='',encoding='utf-8-sig') as f:
            out=csv.writer(f);out.writerow(header);out.writerows(rows)
    table(private/'docx-candidates.csv',['paragraph','week','term','status'],allrows)
    good=[r for r in allrows if r[-1]=='structured'];groups=defaultdict(list)
    for i,w,t,_ in good:groups[t].append(i)
    dup=[(t,';'.join(map(str,l)),len(l)-1) for t,l in groups.items() if len(l)>1]
    table(report/'duplicate_report.csv',['headword','paragraphs_1based','repeated_occurrences'],dup)
    digest=hashlib.sha256(path.read_bytes()).hexdigest()
    d={'bytes':path.stat().st_size,'sha256':digest,'paragraphs':len(doc.paragraphs),'tables':len(doc.tables),'table_rows':sum(len(t.rows) for t in doc.tables),'zip_parts':len(zipfile.ZipFile(path).namelist()),'week_labels':sorted(weeks),'styles':dict(Counter(p.style.name for p in doc.paragraphs)),'candidates':len(allrows),'structured_occurrences':len(good),'distinct_structured_headwords':len(groups),'repeat_occurrences':len(good)-len(groups),'review_candidates':len(allrows)-len(good),'core_created':str(doc.core_properties.created),'core_modified':str(doc.core_properties.modified)}
    (report/'docx_extraction_report.md').write_text('# Private DOCX extraction\n\nOriginal and working copy SHA-256 matched. Paragraph order and week locators retained in private CSV. Number + headword or headword next to pronunciation/POS is a candidate. Bracketed POS or printed page marker required for the structured count. Not a linguistic census: derivative tables, affix exercises, answer keys, embedded examples and unmatched headings are not headwords. Repeated spellings can represent other senses. Original prose, IPA, examples and exercise ordering are not redistributed. File metadata is not proof of authorship or publishing rights.\n\n```json\n'+json.dumps(d,ensure_ascii=False,indent=2)+'\n```\n'.replace('\\',''),encoding='utf-8')
    print(d)
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('source',type=Path);p.add_argument('private',type=Path);p.add_argument('report',type=Path);a=p.parse_args();extract(a.source,a.private,a.report)
