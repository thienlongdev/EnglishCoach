"use client";
import React, {useEffect, useRef, useState} from 'react';
import {UploadCloud, FileText, Loader2, AlertCircle, ClipboardType} from 'lucide-react';
import {glass as s} from './glass/ListeningGlass';
import {useLanguage} from '@/context/LanguageContext';
import {VoiceSelector} from '@/components/features/speaking/VoiceSelector';
import {extractListeningDocument, createListeningDocument, getListeningDocumentJob} from '@/services/listeningDocumentApi';
import {getListeningMaterialById, revalidatePersonalListeningLibrary} from '@/services/listeningApi';
import {authEpoch, assertAuthEpoch} from '@/lib/auth-lifecycle';
import {useSession} from 'next-auth/react';
import type {ListeningMaterialDetail} from '@/types/listening';

export function DocumentImportForm({onSuccess,onBusy}: {onSuccess:(m:ListeningMaterialDetail)=>void;onBusy:(b:boolean)=>void}) {
    const {locale}=useLanguage(); const vi=locale==='vi';
    const {data:session}=useSession(); const user=String((session?.user as any)?.id || session?.user?.email || '');
    const draftKey=`ec_listening_document_draft:${user}`;
    const [mode,setMode]=useState<'upload'|'text'>('upload');
    const [title,setTitle]=useState(''); const [text,setText]=useState('');
    const [file,setFile]=useState<File|null>(null); const [review,setReview]=useState(false);
    const [voice,setVoice]=useState('us_female'); const [busy,setBusy]=useState(false);
    const [error,setError]=useState<string|null>(null); const [jobId,setJobId]=useState<string|null>(null);
    const controller=useRef<AbortController|null>(null); const locked=useRef(false); const editor=useRef<HTMLTextAreaElement>(null);
    useEffect(()=>()=>{controller.current?.abort();},[]);
    useEffect(()=>{
        if(!user)return;
        try {const raw=sessionStorage.getItem(draftKey);if(!raw||raw.length>12000)return;const d=JSON.parse(raw);
            if(d.version===1&&typeof d.title==='string'&&typeof d.text==='string'&&d.text.length<=3000&&typeof d.voice==='string'){
                setTitle(d.title);setText(d.text);setVoice(d.voice);setReview(true);setMode('text');setJobId(typeof d.jobId==='string'?d.jobId:null);
            }
        }catch{};
    },[draftKey,user]);
    function saveDraft(id:string|null) {if(!user)return;try{sessionStorage.setItem(draftKey,JSON.stringify({version:1,title,text,voice,jobId:id}));}catch{}}

    function selectFile(next:File) {
        if(busy) return; setError(null);
        // the shared document recognition limits (backend ReadingImportGuard): PDF 6 MB, PNG / JPG 5 MB
        if(next.size===0 || next.size>(next.type==='application/pdf'?6:5)*1024*1024 || !['application/pdf','image/png','image/jpeg'].includes(next.type)
            || !/\.(pdf|png|jpe?g)$/i.test(next.name)) {
            setError(vi?'Chọn PDF (tối đa 6 MB) hoặc ảnh PNG/JPG (tối đa 5 MB).':'Choose a PDF (up to 6 MB) or a PNG/JPG image (up to 5 MB).'); return;
        }
        setFile(next); setReview(false); setText(''); if(!title.trim()) setTitle(next.name.replace(/\.[^.]+$/,''));
    }
    async function run(action:'review'|'create'|'resume') {
        if(locked.current) return; locked.current=true; setBusy(true); onBusy(true); setError(null);
        const epoch=authEpoch(); const abort=new AbortController(); controller.current=abort;
        try {
            if(action==='review') {
                if(!title.trim()) throw new Error(vi?'Nhập tiêu đề bài nghe.':'Enter a title.');
                const result=mode==='upload' ? await extractListeningDocument(file!,title,abort.signal) : text;
                assertAuthEpoch(epoch); if(!result.trim()) throw new Error(vi?'Không có văn bản để luyện nghe.':'No usable text.');
                setText(result); setReview(true); return;
            }
            if(action==='create')saveDraft(null);
            let job=action==='resume' ? await getListeningDocumentJob(jobId!,abort.signal)
                : await createListeningDocument(title,text,voice,abort.signal);
            assertAuthEpoch(epoch); setJobId(job.id);saveDraft(job.id);
            // Bounded polling; acceptance is READY plus a material, never merely HTTP 202.
            const deadline=Date.now()+6*60*1000;
            while(job.status==='QUEUED'||job.status==='RUNNING') {
                if(Date.now()>deadline) throw new Error(vi?'Bài nghe vẫn đang xử lý. Bấm Kiểm tra để xem lại.':'Still processing. Check again shortly.');
                await new Promise<void>((resolve,reject)=>{const cancel=()=>{clearTimeout(timer);reject(new Error('cancelled'));};const timer=setTimeout(()=>{abort.signal.removeEventListener('abort',cancel);resolve();},5000);abort.signal.addEventListener('abort',cancel,{once:true});});
                job=await getListeningDocumentJob(job.id,abort.signal); assertAuthEpoch(epoch);
            }
            if(job.status==='FAILED') { setJobId(null);saveDraft(null); throw new Error(vi?(job.message||'Chưa thể tạo bài nghe. Vui lòng thử lại.'):'Could not create audio. Your text is preserved; try again.'); }
            if(job.status!=='READY'||!job.materialId) throw new Error(vi?'Bài nghe chưa sẵn sàng.':'Audio is not ready.');
            const material=await getListeningMaterialById(job.materialId); assertAuthEpoch(epoch);
            try{sessionStorage.removeItem(draftKey);}catch{}
            void revalidatePersonalListeningLibrary(); onSuccess(material);
        } catch(e:unknown) {
            if(abort.signal.aborted) return;
            const err=e as {response?:{data?:{message?:string}};message?:string};
            setError(err.response?.data?.message || err.message || (vi?'Không thể xử lý lúc này.':'Could not process this request.'));
        } finally { locked.current=false; if(!abort.signal.aborted){setBusy(false);onBusy(false);} }
    }
    return <div className={s.form} onPaste={e=>{if(mode!=='upload'||review||busy||['INPUT','TEXTAREA'].includes((e.target as HTMLElement).tagName))return;const image=Array.from(e.clipboardData.files).find(f=>f.type.startsWith('image/'));if(image){e.preventDefault();selectFile(image);}}}>
        <div className={s.methods} role="group" aria-label={vi?'Cách nhập tài liệu':'Document input method'}>
            {(['upload','text'] as const).map(value=><button type="button" key={value} disabled={busy} aria-pressed={mode===value} onClick={()=>{setMode(value);setReview(false);setError(null);setJobId(null);}}
                className={s.method}>
                {value==='upload'?<UploadCloud size={16} aria-hidden="true"/>:<ClipboardType size={16} aria-hidden="true"/>}
                {value==='upload'?(vi?'Tải tệp lên':'Upload file'):(vi?'Dán văn bản':'Paste text')}</button>)}
        </div>
        <label className="block"><span className={s.fieldLabel}>{vi?'Tiêu đề bài nghe':'Listening title'} <em>*</em></span>
            <input required maxLength={200} value={title} disabled={busy||!!jobId} onChange={e=>setTitle(e.target.value)} className={s.input}/></label>
        {mode==='upload'&&!review ? <div className={s.drop} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();if(e.dataTransfer.files[0])selectFile(e.dataTransfer.files[0]);}}>
            <UploadCloud size={30} aria-hidden="true"/><p className="font-semibold">{vi?'Kéo thả PDF / PNG / JPG hoặc dán ảnh':'Drop a PDF / PNG / JPG or paste an image'}</p>
            <input type="file" accept="application/pdf,image/png,image/jpeg,.pdf,.png,.jpg,.jpeg" disabled={busy} aria-label={vi?'Chọn tệp':'Choose file'} onChange={e=>{if(e.target.files?.[0])selectFile(e.target.files[0]);}}/>
            <p className={s.hint}>{file?.name || (vi?'PDF tối đa 6 MB · PNG/JPG tối đa 5 MB':'PDF up to 6 MB · PNG/JPG up to 5 MB')}</p>
        </div> : <label className="block"><span className={s.fieldLabel}>{vi?'Nội dung văn bản':'Text content'}</span>
            <textarea ref={editor} value={text} disabled={busy||!!jobId} maxLength={100000} onChange={e=>setText(e.target.value)} rows={8} className={s.area}/>
            <span className={s.hint} data-over={text.length>3000}>{text.length.toLocaleString()} / 3.000 {vi?'ký tự cho bài nghe':'characters per listening material'}</span>
        </label>}
        {review ? <>
            <p className={s.notice} data-kind="info"><FileText size={15} aria-hidden="true"/><span>{vi?'Kiểm tra, sửa lỗi và giữ lại đoạn muốn nghe: tối đa 3.000 ký tự, 16 câu; mỗi câu tối đa 500 ký tự.':'Review and correct the passage: up to 3,000 characters, 16 sentences; 500 characters per sentence.'}</span></p>
            <button type="button" disabled={busy||!!jobId} onClick={()=>{const area=editor.current;if(area&&area.selectionEnd>area.selectionStart)setText(text.slice(area.selectionStart,area.selectionEnd));}} className={`${s.textLink} self-start`}>{vi?'Chỉ giữ phần đang chọn':'Keep selected passage'}</button>
            <fieldset disabled={busy||!!jobId}><legend className={s.fieldLabel}>{vi?'Chọn giọng đọc':'Choose a voice'}</legend>
                <VoiceSelector selectedVoiceId={voice} onSelectVoice={setVoice} compact disabled={busy||!!jobId} labelLocale={locale}/></fieldset>
        </>:null}
        {error?<p role="alert" className={s.notice} data-kind="error"><AlertCircle size={16} aria-hidden="true"/><span>{error}</span></p>:null}
        <button type="button" disabled={busy||!title.trim()||(!review&&(mode==='upload'?!file:!text.trim()))||(review&&!jobId&&(!text.trim()||text.length>3000))}
            onClick={()=>void run(jobId?'resume':review?'create':'review')} className={`${s.btn} ${s.btnPrimary} sticky bottom-0 z-10 w-full`}>
            {busy?<Loader2 size={16} className="animate-spin motion-reduce:animate-none"/>:<FileText size={16}/>}
            {busy?(vi?'Đang xử lý bài nghe…':'Processing…'):jobId?(vi?'Kiểm tra bài nghe':'Check listening material'):review?(vi?'Tạo bài nghe':'Create listening material'):(vi?'Kiểm tra văn bản':'Review text')}</button>
        {busy&&jobId?<p role="status" className={s.hint}>{vi?'Bạn có thể đóng cửa sổ; bài nghe vẫn tiếp tục được tạo.':'You can close this window; generation continues.'}</p>:null}
    </div>;
}
