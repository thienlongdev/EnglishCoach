"""Generate the small read-only overlay for the original November library. Never re-seed a published deck."""
from pathlib import Path
import hashlib,json,re,sys
HERE=Path(__file__).resolve().parent;ROOT=HERE.parents[3]
def ipa_table(p):
 assert hashlib.sha256(p.read_bytes()).hexdigest()=='2af6f154a5c363275f052d1f85acedef38ed185ca9745aa4314be77f6b70de67'
 out={}
 for line in p.read_text(encoding='utf8').splitlines():
  a=line.split('\t')
  if len(a)==2 and re.fullmatch(r'/[^/,;\d\[\]]+/',a[1]):out[a[0].lower()]=a[1]
 return out
def main(p):
 ipa=ipa_table(p);defs=dict(l.split('|',1) for l in (HERE/'sense-glosses.txt').read_text(encoding='utf8').splitlines() if l)
 pinned=json.loads((ROOT/'docs/flashcards/library-20261117/import_manifest.json').read_text())['decks'];out={};used=set();counts=[0,0]
 for src in pinned:
  f=ROOT/'backend/src/main/resources/data/decks'/(src['slug']+'.json')
  assert hashlib.sha256(f.read_bytes()).hexdigest()==src['sha256']
  for w in json.loads(f.read_text(encoding='utf8'))['words']:
   word=w['word'];de=None if w['meanings'] else defs[word];ip=None if w.get('ipa') else ipa.get(word)
   if de:used.add(word);counts[0]+=1
   if ip:counts[1]+=1
   if de or ip:out[src['slug']+'|'+word]={'meaning':w['general_translation_vi'],'definition':de,'ipa':ip}
 assert used==set(defs)
 dest=ROOT/'backend/src/main/resources/data/vocabulary/initial-sense-supplement.json'
 dest.parent.mkdir(exist_ok=True);dest.write_text(json.dumps(out,ensure_ascii=False,indent=1),encoding='utf8')
 print('original definitions / missing IPA filled',counts)
if __name__=='__main__':main(Path(sys.argv[1]))
