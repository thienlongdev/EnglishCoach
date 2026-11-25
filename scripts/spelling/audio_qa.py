"""Offline pronunciation smoke check with the already cached Whisper tiny.en model.
ASR agreement is supporting evidence, not human pronunciation certification.
"""
import json
from pathlib import Path
import numpy as np
import soundfile as sf
from scipy.signal import resample_poly
import torch
from transformers import WhisperProcessor, WhisperForConditionalGeneration

root=Path(__file__).resolve().parents[2]
base=root/'backend/src/main/resources/data/spelling'
catalog=json.loads((base/'catalog.json').read_text('utf-8'))
torch.set_num_threads(4)
processor=WhisperProcessor.from_pretrained('openai/whisper-tiny.en',local_files_only=True)
model=WhisperForConditionalGeneration.from_pretrained('openai/whisper-tiny.en',local_files_only=True).eval()
samples=['ocean','garden','tomato','flower','morning','electricity','cinnamon','architecture','conscience','refrigerator','rhythm','pronunciation']
results=[]
for word in samples:
    clip=next(a for a in catalog['audio'] if a['key']==word)
    audio,rate=sf.read(base/'audio'/clip['file'])
    if audio.ndim>1:audio=audio.mean(axis=1)
    if rate!=16000:audio=resample_poly(audio,16000,rate)
    inputs=processor(audio.astype(np.float32),sampling_rate=16000,return_tensors='pt')
    with torch.inference_mode():ids=model.generate(**inputs,max_new_tokens=80)
    transcript=processor.batch_decode(ids,skip_special_tokens=True)[0]
    row={'word':word,'expectedSpeech':clip['text'],'transcript':transcript,'containsExpectedWord':word in transcript.lower(),'durationMs':clip['durationMs']}
    results.append(row);print(json.dumps(row),flush=True)
out=root/'docs/echo-spelling/2026-11-18/audio-qa.json'
out.write_text(json.dumps({'method':'existing cached Whisper tiny.en, CPU, no network','limitation':'ASR agreement is not human pronunciation certification','samples':results},indent=2)+'\n','utf-8')
