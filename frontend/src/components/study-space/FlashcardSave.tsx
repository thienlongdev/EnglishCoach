'use client';
import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Layers, X } from 'lucide-react';
import { apiClient } from '@/services/api-client';
import type { CanonicalDictionaryEntry } from '@/services/dictionary/types';
import { flashcardMeaningVi } from '@/services/dictionaryRanking';
import { lookupCanonical } from '@/services/dictionaryEngine';
import s from './studySpace.module.css';
import {useDialogFocus} from './useDialogFocus';

/** Existing /flashcards save and server deduplication. No independent card store or scheduler. */
export default function FlashcardSave({ entry, text, context = '' }: { entry?: CanonicalDictionaryEntry | null; text?: string; context?: string }) {
  const [draft, setDraft] = useState<{ front: string; back: string; example: string; ipa: string } | null>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [saved, setSaved] = useState('');
  const dialog=useRef<HTMLFormElement>(null);useDialogFocus(dialog,()=>{if(!busy)setDraft(null);},!!draft);
  const open = () => { setMessage(''); setDraft({ front: (entry?.headword ?? text ?? '').slice(0,255), back: entry ? flashcardMeaningVi(entry) || entry.partsOfSpeech[0]?.senses[0]?.definitionEn || '' : '', example: (context || entry?.partsOfSpeech[0]?.senses[0]?.examples?.[0] || '').slice(0,1000), ipa: entry?.pronunciations[0]?.ipa ?? '' }); };
  // A word picked from a page has no entry yet: the same dictionary the learner would open fills the meaning and the transcription, which stay editable.
  // Only on this explicit save; never on a hover or a selection (no AI, the ordinary lookup).
  const opened = useRef(0);
  const openFromWord = () => {
    open();
    if (entry || !text) return;
    const ticket = ++opened.current;
    void lookupCanonical(text).then(found => {
      if (!found || ticket !== opened.current) return;
      setDraft(d => d && !d.back.trim() ? { ...d, back: flashcardMeaningVi(found) || found.partsOfSpeech[0]?.senses[0]?.definitionEn || '', ipa: d.ipa || found.pronunciations?.[0]?.ipa || '' } : d);
    }).catch(() => { /* the learner writes the meaning */ });
  };
  return <>
    <button type="button" className={s.btn} onClick={openFromWord} data-testid="flashcard-save"><Layers size={14} /> Lưu Flashcard</button>
    {message && !draft && <p role="status" className={s.hint}>{message}{saved ? <> <a href={`/knowledge-universe?word=${encodeURIComponent(saved)}`}>Xem trong vũ trụ</a></> : null}</p>}
    {draft && createPortal(<div className={s.space} style={{zIndex:2147481500,background:'rgba(15,18,42,.4)',display:'grid',placeItems:'center'}} onKeyDown={e=>{if(e.key==='Escape'&&!busy){e.stopPropagation();setDraft(null);}}}>
      <form ref={dialog} className={`${s.glass} ${s.flashcardEditor}`} role="dialog" aria-modal="true" aria-label="Lưu Flashcard" onSubmit={async e=>{
        e.preventDefault();if(busy||!draft.front.trim()||!draft.back.trim())return;setBusy(true);setMessage('');
        try {const r=await apiClient.post('/flashcards',draft);setSaved(draft.front.trim().toLowerCase());setMessage(r.status===201?'Đã lưu vào Thẻ từ vựng của bạn.':'Từ đã có trong Thẻ từ vựng; không tạo bản trùng.');setDraft(null);}
        catch {setMessage('Chưa lưu được. Nội dung vẫn được giữ để bạn thử lại.');} finally{setBusy(false);}
      }}>
        <div className={s.panelHead}><b style={{flex:1}}>Lưu Flashcard</b><button type="button" className={s.iconBtn} disabled={busy} onClick={()=>setDraft(null)} aria-label="Đóng trình lưu Flashcard"><X size={18}/></button></div>
        <label className={s.field}>Bộ thẻ đích<select className={s.select} aria-label="Bộ thẻ đích"><option>Thẻ cá nhân của tôi</option></select></label>
        <p className={s.hint}>Các bộ SYSTEM là nội dung chung. Thẻ bạn tạo được lưu vào bộ cá nhân trong Thẻ từ vựng.</p>
        <label className={s.field}>Từ hoặc cụm từ<input autoFocus required className={s.input} maxLength={255} value={draft.front} onChange={e=>setDraft({...draft,front:e.target.value})}/></label>
        <label className={s.field}>Nghĩa<textarea required className={s.textarea} maxLength={2000} value={draft.back} onChange={e=>setDraft({...draft,back:e.target.value})}/></label>
        <label className={s.field}>Ngữ cảnh hoặc ví dụ<textarea className={s.textarea} maxLength={1000} value={draft.example} onChange={e=>setDraft({...draft,example:e.target.value})}/></label>
        <label className={s.field}>Phiên âm<input className={s.input} maxLength={255} value={draft.ipa} onChange={e=>setDraft({...draft,ipa:e.target.value})}/></label>
        {message&&<p role="alert" className={s.hint}>{message}</p>}
        <button type="submit" disabled={busy} className={`${s.btn} ${s.primary}`}>{busy?'Đang lưu…':'Lưu vào Thẻ từ vựng'}</button>
      </form>
    </div>,document.body)}
  </>;
}
