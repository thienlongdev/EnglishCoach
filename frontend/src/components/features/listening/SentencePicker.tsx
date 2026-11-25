'use client';
import { useEffect, useRef, useState, useMemo } from 'react';
import type { TranscriptSegment, ListeningWorkspaceState } from '@/types/listening';
import { useLanguage } from '@/context/LanguageContext';
import { glass as s } from './glass/ListeningGlass';

export function SentencePicker({ segments, selectedId, state, onSelect, onClose }: {
    segments: TranscriptSegment[]; selectedId?: number; state: ListeningWorkspaceState;
    onSelect: (id: number) => void; onClose: () => void;
}) {
    const { locale } = useLanguage();const vi = locale === 'vi';
    const dialog = useRef<HTMLDialogElement>(null);
    const [query, setQuery] = useState('');const [page, setPage] = useState(0);
    useEffect(() => { dialog.current?.showModal();dialog.current?.querySelector('input')?.focus(); }, []);
    const matches = useMemo(() => segments.map((segment,index) => ({ segment,index })).filter(({ segment,index }) =>
        !query.trim() || String(index+1) === query.trim() || segment.text.toLocaleLowerCase().includes(query.toLocaleLowerCase())), [segments,query]);
    const pages = Math.max(1,Math.ceil(matches.length/40));const activePage = Math.min(page,pages-1);
    return <dialog ref={dialog} onCancel={onClose} onClose={onClose} className={s.picker} aria-labelledby="listening-picker-title">
        <div className={s.pickerHead}><h2 id="listening-picker-title">{vi?'Chọn câu':'Choose sentence'}</h2><button type="button" onClick={onClose} className={s.iconBtn} aria-label={vi?'Đóng':'Close'}>×</button></div>
        <label className={s.pickerSearch}>{vi?'Số câu hoặc nội dung':'Sentence number or text'}<input autoFocus value={query} onChange={e=>{setQuery(e.target.value);setPage(0);}} placeholder={vi?'Nhập số câu hoặc tìm kiếm…':'Enter a number or search…'}/></label>
        <div className={s.pickerList}>{matches.slice(activePage*40,(activePage+1)*40).map(({segment,index})=>{
            const entry=state.entries[String(segment.id)];const status=entry?.status==='completed'?(vi?'Đã hoàn thành':'Completed'):entry?.status==='revealed'?(vi?'Đã xem đáp án':'Revealed'):entry?.draft||entry?.status==='evaluated'?(vi?'Đang luyện':'In progress'):(vi?'Chưa bắt đầu':'Not started');
            return <button type="button" key={segment.id} className={s.pickerRow} aria-current={selectedId===segment.id?'true':undefined} onClick={()=>{onSelect(segment.id);onClose();}}><b>{index+1}</b><span>{segment.text}<small>{status}</small></span></button>;
        })}{!matches.length&&<p>{vi?'Không tìm thấy câu.':'No sentences found.'}</p>}</div>
        <div className={s.pickerFoot}><button type="button" className={`${s.btn} ${s.btnSoft}`} disabled={activePage===0} onClick={()=>setPage(activePage-1)}>{vi?'Trước':'Previous'}</button><span>{activePage+1}/{pages}</span><button type="button" className={`${s.btn} ${s.btnSoft}`} disabled={activePage===pages-1} onClick={()=>setPage(activePage+1)}>{vi?'Tiếp':'Next'}</button></div>
    </dialog>;
}
