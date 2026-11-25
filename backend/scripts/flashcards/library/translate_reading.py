"""Local, private draft translations only. No external inference; results need an explicit editorial decision."""
import os,sys,json
from pathlib import Path
p=Path(sys.argv[1]);sys.path.insert(0,str(p/'runtime'))
import torch
from transformers import MarianMTModel,MarianTokenizer
torch.set_num_threads(min(6,os.cpu_count() or 2))
q=p/'completion';rows=json.loads((q/'draft.json').read_text(encoding='utf8'));dest=q/'mt.json';cache=json.loads(dest.read_text(encoding='utf8')) if dest.exists() else {}
items=list(dict.fromkeys(r['draft']['en'] for r in rows if r['draft'] and not r['draft']['tr'] and r['draft']['en'] not in cache))
model=MarianMTModel.from_pretrained(p/'opus-en-vi',local_files_only=True).eval()
tok=MarianTokenizer.from_pretrained(p/'opus-en-vi',local_files_only=True)
with torch.inference_mode():
 for i in range(0,len(items),16):
  inp=tok(items[i:i+16],return_tensors='pt',padding=True,truncation=True,max_length=128)
  tr=tok.batch_decode(model.generate(**inp,num_beams=3,max_new_tokens=80),skip_special_tokens=True)
  cache.update(zip(items[i:i+16],tr));tmp=dest.with_suffix('.partial');tmp.write_text(json.dumps(cache,ensure_ascii=False),encoding='utf8');tmp.replace(dest)
print('cached translations',len(cache))
