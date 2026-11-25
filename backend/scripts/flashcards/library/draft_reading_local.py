"""Offline drafting with existing Python, tokenizer and ONNX Runtime CPU. No HTTP inference, custom libraries or private text uploads.
The private output is a candidate pool, not an import path. Each card must pass the corpus builder's attestation and QC gates.
"""
import os,sys,re,json,time,collections
from pathlib import Path
p=Path(sys.argv[1]);sys.path.insert(0,str(p/'runtime'))
import numpy as np,onnxruntime as ort
from tokenizers import Tokenizer
q=p/'completion';model=q/'qwen-onnx';dest=q/'drafted';dest.mkdir(exist_ok=True)
rows=json.loads((q/'draft.json').read_text(encoding='utf8'));here=Path(__file__).resolve().parent
written={v.split(':')[0] for f in (here/'reading').glob('*.txt') for l in f.read_text(encoding='utf8').splitlines() if '|' in l for v in l.split('|')[0].split(';')}
opt=ort.SessionOptions();opt.intra_op_num_threads=12;opt.inter_op_num_threads=1;opt.log_severity_level=3;opt.enable_mem_pattern=False
session=ort.InferenceSession(str(model/'onnx/model_q4.onnx'),sess_options=opt,providers=['CPUExecutionProvider'])
ins={x.name:x for x in session.get_inputs()};outs=[x.name for x in session.get_outputs()]
print('input spec',[(k,ins[k].type,ins[k].shape) for k in list(ins)[:5]],flush=True)
tok=Tokenizer.from_file(str(model/'tokenizer.json'));cfg=json.loads((model/'config.json').read_text())
end=tok.token_to_id('<|im_end|>');pad=tok.token_to_id('<|endoftext|>')
system='''You write learner dictionary cards for Vietnamese speakers. For EACH headword choose one clear standard sense. Write one row with exactly 7 fields separated by |:
headword|part of speech|short Vietnamese meaning|short English definition without the headword|one natural complete English example using the EXACT headword|faithful idiomatic Vietnamese translation|topic
Allowed POS: noun, verb, adjective, adverb, phrase, conjunction, preposition. Topic: evidence, communication, work, civic, nature, science, health, people, change, space, time, arts, money, language, education. Keep sentences short, concrete and original. The sixth field MUST translate the ENTIRE English sentence, not just the headword. Example format: lantern|noun|đèn lồng|a portable lamp with a cover|Mai hung a lantern outside her door.|Mai treo một chiếc đèn lồng bên ngoài cửa nhà mình.|people. Write exactly one row per supplied word, then stop.'''
def gen(groups,maxnew=210):
 prompts=[]
 for group in groups:
  msg='\n'.join(x['word']+' ('+str(x.get('pos') or '')+')' for x in group)
  prompts.append(tok.encode('<|im_start|>system\n'+system+'<|im_end|>\n<|im_start|>user\n'+msg+'<|im_end|>\n<|im_start|>assistant\n',add_special_tokens=False).ids)
 b=len(prompts);width=max(map(len,prompts));ids=np.array([[pad]*(width-len(r))+r for r in prompts],dtype=np.int64)
 mask=(ids!=pad).astype(np.int64);pos=np.maximum(0,np.cumsum(mask,axis=1)-1)
 cache={k:np.zeros((b,cfg['num_key_value_heads'],0,cfg['head_dim']),dtype=np.float16 if v.type=='tensor(float16)' else np.float32) for k,v in ins.items() if k.startswith('past_key_values.')}
 acc=[[] for _ in groups];finished=[False]*b
 for _ in range(maxnew):
  feed={'input_ids':ids,'attention_mask':mask,'position_ids':pos,**cache};out=session.run(None,{k:v for k,v in feed.items() if k in ins})
  nexts=np.argmax(out[0][:,-1,:],axis=1);cache={k.replace('present.','past_key_values.'):v for k,v in zip(outs[1:],out[1:])}
  for j,t in enumerate(nexts):
   if int(t) in {end,pad}:finished[j]=True
   if not finished[j]:acc[j].append(int(t))
  if _%5==4:
   for j,ts in enumerate(acc):
    if finished[j]:continue
    s=tok.decode(ts,skip_special_tokens=True)
    if all(re.search(r'(?im)^\s*'+re.escape(x['word'])+r'\s*\|(?:[^|\n]+\|){5}\s*(?:evidence|communication|work|civic|nature|science|health|people|change|space|time|arts|money|language|education)\b',s) for x in groups[j]):finished[j]=True
  if all(finished):break
  ids=nexts.reshape(b,1).astype(np.int64);pos=mask.sum(axis=1).reshape(b,1);mask=np.concatenate([mask,np.ones((b,1),dtype=np.int64)],axis=1)
 return [tok.decode(ts,skip_special_tokens=True) for ts in acc]
def run():
 for attempt in range(2):
  todo=[x for x in rows if x['word'] not in written and not (dest/(str(x['locations'][0])+'.json')).exists()]
  # Keep disparate concepts out of shared contexts. Input contains ONLY public headwords/POS; no book/example text.
  tasks=[todo[i:i+2] for i in range(0,len(todo),2)]
  for i in range(0,len(tasks),8):
   batch=tasks[i:i+8];start=time.monotonic();texts=gen(batch);saved=0
   for group,t in zip(batch,texts):
    lookup={x['word']:x for x in group}
    for line in t.splitlines():
     parts=[v.strip() for v in line.strip().strip('|').split('|')]
     if len(parts)!=7:continue
     w=parts[0].lower().strip('* ');x=lookup.get(w)
     if not x:continue
     v=dict(zip(('w','pos','vi','def','en','tr','topic'),parts));v['w']=w
     f=dest/(str(x['locations'][0])+'.json');tmp=f.with_suffix('.partial');tmp.write_text(json.dumps(v,ensure_ascii=False),encoding='utf8');tmp.replace(f);saved+=1
   print(attempt,i,'saved',saved,'elapsed',round(time.monotonic()-start,1),flush=True)
if __name__=='__main__':run()
