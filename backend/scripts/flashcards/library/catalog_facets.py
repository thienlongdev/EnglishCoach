"""Build only metadata (never examples, definitions, private source locators or learner progress) for catalogue facets."""
import json,re,sys
from pathlib import Path
R=Path(__file__).resolve().parents[4]
DECKS=R/'backend/src/main/resources/data/decks'
def build():
 out={}
 for f in sorted(DECKS.glob('*.json')):
  d=json.loads(f.read_text(encoding='utf8'));slug=d['slug'];c=d.get('category') or '';words=d.get('words') or []
  tax=d.get('taxonomy') or {};title=d['title'];levels=sorted({w.get('cefr') for w in words if w.get('cefr') in ('A1','A2','B1','B2','C1','C2')})
  types=set()
  for w in words:
   word=w.get('word','').strip()
   if not word:continue
   types.add('phrasal' if c=='PHRASAL_VERBS' else 'idiom' if c=='IDIOMS' else 'collocation' if c=='COLLOCATIONS' and ' ' in word else 'phrase' if ' ' in word else 'word')
  topic=tax.get('topic') or (title.split(' · ',2)[1] if c in ('GENERAL_CEFR','EXAM_READING') and ' · ' in title else title)
  out[slug]={'levels':levels,'forms':sorted(types),'topic':topic,'subtopic':tax.get('subtopic','')}
 (R/'frontend/src/components/features/flashcard/libraryFacets.json').write_text(json.dumps(out,ensure_ascii=False,separators=(',',':')),encoding='utf8')
 print('metadata only',len(out),'decks')
if __name__=='__main__':build()
