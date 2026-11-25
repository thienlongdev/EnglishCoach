import copy
import json
import threading
import time
import types
from unittest.mock import Mock
import pytest
from app.services import listening_youtube_service as L
from app.services.listening_trace import Trace, PipelineCancelled, current
from app.tests.test_listening_pipeline_law import stubbed


def test_unusable_captions_fall_back_to_same_decoded_audio(stubbed):
    import numpy as np
    stubbed.setattr(L, '_captions_via_timedtext', lambda *a: ([L._text_segment('tiny', 0, 2)], 'captions-auto'))
    seen=[]
    def transcribe(audio):
        assert isinstance(audio, np.ndarray)
        seen.append(audio)
        return [L._text_segment('the fox is here and the fox is in the woods today',1,5)]
    stubbed.setattr(L,'transcribe_segments',transcribe)
    stubbed.setattr(L,'align_loaded_audio',lambda segments,audio: segments)
    stubbed.setattr(L,'assess_transcript_timing',lambda *a: {'alignedWordRatio':1})
    result=L.fetch_youtube_metadata_and_captions('BF3bXji-J7I')
    assert len(seen)==1 and result['timing']['transcript'].startswith('local-asr:')


def test_manual_caption_in_another_english_code_beats_auto(monkeypatch):
    response=Mock()
    response.__enter__=Mock(return_value=response)
    response.__exit__=Mock(return_value=False)
    response.read.return_value=json.dumps({'events':[{'tStartMs':100,'dDurationMs':1000,'segs':[{'utf8':'The fox is here.'}]}]}).encode()
    opened=Mock(return_value=response)
    monkeypatch.setattr(L.urllib.request,'urlopen',opened)
    segments,source=L._captions_via_timedtext('VjTJvwgJnGc',{'en-GB':[{'ext':'json3','url':'https://manual.example'}]},
                                           {'en':[{'ext':'json3','url':'https://auto.example'}]})
    assert source=='captions-manual'
    assert opened.call_args.args[0].full_url=='https://manual.example'
    assert all(w['start'] is None for w in segments[0]['words'])


def test_stage_records_content_free_timing_and_cancellation():
    event=threading.Event()
    stages=[]
    trace=Trace('receipt',stages.append,event)
    assert trace.call('captions',lambda:42)==42
    assert trace.stages[0]['success'] and trace.stages[0]['elapsedMs']>=0
    assert stages==['captions']
    event.set()
    with pytest.raises(PipelineCancelled): trace.call('alignment',lambda:None)
    assert stages==['captions']


def test_metadata_is_reused_without_another_extraction_or_mp3_conversion(monkeypatch,tmp_path):
    options=[]
    class Downloader:
        def __init__(self,opts): options.append(opts)
        def __enter__(self):return self
        def __exit__(self,*args):pass
        def extract_info(self,*args,**kwargs):raise AssertionError('duplicate metadata extraction')
        def process_info(self,info):
            assert info['url']=='https://audio.example/native'
            (tmp_path/'VjTJvwgJnGc.m4a').write_bytes(b'a'*2048)
        def prepare_filename(self,info):return str(tmp_path/'VjTJvwgJnGc.m4a')
    monkeypatch.setattr(L,'yt_dlp',types.SimpleNamespace(YoutubeDL=Downloader))
    trace=Trace();trace.metadata={'url':'https://audio.example/native','ext':'m4a'}
    token=current.set(trace)
    try:
        assert L.download_youtube_audio('https://youtube.com/watch?v=VjTJvwgJnGc','VjTJvwgJnGc',str(tmp_path)).endswith('.m4a')
    finally:current.reset(token)
    assert 'postprocessors' not in options[0]
    assert options[0]['format']=='bestaudio/best'


def test_jobs_reuse_one_gpu_computation_and_cancel_before_start(monkeypatch):
    from app.services import listening_jobs as J
    entered=threading.Event(); release=threading.Event()
    def pipeline(video,trace):
        entered.set();release.wait(3);trace.check();return {'segments':[]}
    monkeypatch.setattr(J,'fetch_youtube_metadata_and_captions',pipeline)
    a='11111111-1111-4111-8111-111111111111'
    b='22222222-2222-4222-8222-222222222222'
    assert J.submit(a,'VjTJvwgJnGc')['status']=='QUEUED'
    assert entered.wait(2)
    assert J.submit(a,'VjTJvwgJnGc')['status']=='RUNNING'
    J.submit(b,'VjTJvwgJnGc');J.cancel(b);J.cancel(a);release.set()
    J._queue.join()
    assert J.get(a)['status']=='CANCELLED'
    assert J.get(b)['status']=='CANCELLED'
    assert J.get(a,True).get('result') is None


def test_cancel_tombstone_prevents_late_dispatch():
    from app.services import listening_jobs as J
    receipt='33333333-3333-4333-8333-333333333333'
    J.cancel(receipt)
    assert J.submit(receipt,'VjTJvwgJnGc')['status']=='CANCELLED'
