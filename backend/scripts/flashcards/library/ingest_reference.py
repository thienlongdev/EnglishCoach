"""Register and extract a lawfully supplied PRIVATE reference. No output is publishable by default.
Usage: python ingest_reference.py record.json PRIVATE_OUTPUT
record: {id, path, sha256, permission: "owner-provided-private-study"|"open-reuse",
         license, source_url, [ocr_pages: [1,2]], [ocr_permitted: true]}.
Optional English OCR uses installed Tesseract or locally cached EasyOCR weights; no whole-document OCR mode.
"""
import csv,hashlib,json,subprocess,sys,tempfile,zipfile
from pathlib import Path,PurePosixPath
from xml.etree import ElementTree as ET
from urllib.parse import unquote
from bs4 import BeautifulSoup
from docx import Document
from docx.table import Table
from docx.text.paragraph import Paragraph

def digest(f):
    h=hashlib.sha256()
    with f.open('rb') as i:
        for block in iter(lambda:i.read(1<<20),b''):h.update(block)
    return h.hexdigest()

def extract(f,r):
    ext=f.suffix.lower()
    if ext=='.docx':
        d=Document(f)
        for i,el in enumerate(d.element.body,1):
            if el.tag.endswith('}p'):
                p=Paragraph(el,d);yield f'body/{i}/{p.style.name}',p.text
            elif el.tag.endswith('}tbl'):
                for j,row in enumerate(Table(el,d).rows,1):yield f'body/{i}/row/{j}',[c.text for c in row.cells]
    elif ext=='.epub':
        with zipfile.ZipFile(f) as z:
            if 'META-INF/encryption.xml' in z.namelist() or any(i.flag_bits&1 for i in z.infolist()):raise ValueError('encrypted resource: skip')
            def part(n):
                if z.getinfo(n).file_size>24<<20:raise ValueError('oversized EPUB part')
                return z.read(n)
            opf=ET.fromstring(part('META-INF/container.xml')).find('.//{*}rootfile').get('full-path')
            package=ET.fromstring(part(opf));items={e.get('id'):e.get('href') for e in package.findall('.//{*}manifest/{*}item')}
            for i,node in enumerate(package.findall('.//{*}spine/{*}itemref'),1):
                n=str(PurePosixPath(opf).parent/unquote(items[node.get('idref')]))
                html=BeautifulSoup(part(n),'html.parser')
                for j,el in enumerate(html.select('h1,h2,h3,p,li,tr'),1):yield f'spine/{i}/{n}/{el.name}/{j}',el.get_text(' ',strip=True)
    elif ext=='.pdf':
        import pymupdf
        ocr=set(r.get('ocr_pages',[]))
        if len(ocr)>3 or (ocr and not r.get('ocr_permitted')):raise ValueError('select at most three permitted OCR pilot pages')
        with pymupdf.open(f) as d:
            if d.needs_pass:raise ValueError('password protected: skip')
            if not ocr.issubset(range(1,len(d)+1)):raise ValueError('OCR page out of range')
            for i,page in enumerate(d,1):
                t=page.get_text()
                if not t.strip() and i in ocr:
                    if page.rect.get_area()*(150/72)**2>15_000_000:raise ValueError('oversized OCR page')
                    with tempfile.TemporaryDirectory() as td:
                        pix=Path(td)/'page.png';page.get_pixmap(dpi=150).save(str(pix))
                        import shutil
                        if shutil.which('tesseract'):
                            t=subprocess.run(['tesseract',str(pix),'stdout','-l','eng'],capture_output=True,text=True,check=True,timeout=60).stdout
                        else:
                            import easyocr
                            if i==min(ocr) or 'reader' not in locals():
                                reader=easyocr.Reader(['en'],gpu=False,download_enabled=False,verbose=False)
                            t='\n'.join(reader.readtext(str(pix),detail=0,paragraph=False))
                yield f'page/{i}',t
    elif ext in {'.csv','.tsv','.txt','.jsonl','.json'}:
        with f.open(encoding='utf-8-sig',newline='') as fd:
            if ext=='.json':
                if f.stat().st_size>32<<20:raise ValueError('use JSONL for large input')
                obj=json.load(fd);it=obj if isinstance(obj,list) else [obj]
            elif ext in {'.csv','.tsv'}:it=csv.DictReader(fd,delimiter='\t' if ext=='.tsv' else ',')
            else:it=(json.loads(l) if ext=='.jsonl' else l.rstrip('\r\n') for l in fd)
            for i,row in enumerate(it,1):yield f'record/{i}',row
    else:raise ValueError('unsupported format')

def main(reg,out):
    import re,shutil
    r=json.loads(reg.read_text(encoding='utf-8-sig'));f=Path(r['path']).resolve(strict=True)
    if r['permission'] not in ('owner-provided-private-study','open-reuse') or not r.get('license') or not r.get('source_url'):raise ValueError('record access decision and provenance')
    if not re.fullmatch(r'[a-z0-9-]{1,64}',r['id']) or digest(f)!=r['sha256']:raise ValueError('bad id or checksum')
    root=Path(__file__).resolve().parents[4]
    if out.resolve().is_relative_to(root):raise ValueError('private output must be outside repository')
    out.mkdir(parents=True,exist_ok=True);dest=out/(r['id']+'-'+r['sha256'][:16]+'.jsonl')
    tmp=dest.with_suffix('.partial')
    n=0
    with tmp.open('w',encoding='utf-8') as o:
        for loc,data in extract(f,r):
            if o.tell()>256<<20 or (n%250==0 and shutil.disk_usage(out).free<2<<30):raise ValueError('storage limit')
            o.write(json.dumps({'source':r['id'],'location':loc,'content':data},ensure_ascii=False)+'\n');n+=1
    tmp.replace(dest);print(n,'structural records, output sha256',digest(dest))
if __name__=='__main__':main(Path(sys.argv[1]),Path(sys.argv[2]))
