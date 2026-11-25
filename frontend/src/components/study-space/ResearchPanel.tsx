'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import useSWR from 'swr';
import {
  Bookmark, BookOpenText, ChevronLeft, ChevronRight, Download, FileUp, Highlighter, Search, Star, Trash2, Upload, ZoomIn, ZoomOut,
} from 'lucide-react';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { studySpaceApi, SWR_KEYS } from '@/lib/study-space/api';
import type { Annotation, ResearchItem } from '@/lib/study-space/types';
import { lookupCanonical } from '@/services/dictionaryEngine';
import { Panel } from './panels';
import { useAccount } from './data';
import s from './studySpace.module.css';
import FlashcardSave from './FlashcardSave';
import type { CanonicalDictionaryEntry } from '@/services/dictionary/types';

const fingerprint = async (file: Blob) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())), x=>x.toString(16).padStart(2,'0')).join('');
const HIGHLIGHT_COLORS = ['#ffe27a', '#9ce8c0', '#a8d6ff', '#efb3fa'];

/**
 * Góc nghiên cứu: a library of research documents. The PDF itself stays in this browser (IndexedDB, one database per
 * account, never uploaded); the metadata, last page, bookmarks, highlights (quote + page + note) and research notes are
 * kept with the account. PDF.js is the same on-demand engine as My Books. No AI: "Tra từ" uses the dictionary.
 */

const MAX_PDF = 60 * 1024 * 1024;
const dbName = (account: string) => `ec-research-v1-u${account}`;
function idb<T>(account: string, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(dbName(account), 1);
    open.onupgradeneeded = () => open.result.createObjectStore('files');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('files', mode);
      const req = run(tx.objectStore('files'));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => open.result.close();
    };
  });
}

function parseBibtex(text: string): Partial<ResearchItem>[] {
  const out: Partial<ResearchItem>[] = [];
  const entries = text.split(/@\w+\s*\{/).slice(1);
  for (const e of entries) {
    const field = (name: string) => {
      const m = new RegExp(`${name}\\s*=\\s*(\\{((?:[^{}]|\\{[^{}]*\\})*)\\}|"([^"]*)"|(\\d+))`, 'i').exec(e);
      return m ? (m[2] ?? m[3] ?? m[4] ?? '').replace(/[{}]/g, '').replace(/\s+/g, ' ').trim() : null;
    };
    const title = field('title');
    if (!title) continue;
    const year = Number(field('year'));
    const url = field('url');
    out.push({
      title, authors: field('author')?.split(/\s+and\s+/i).join('; ') ?? null, year: Number.isFinite(year) && year > 1400 && year < 2200 ? year : null,
      venue: field('journal') ?? field('booktitle') ?? field('publisher'), doi: field('doi'), url: url && /^https?:\/\//.test(url) ? url : null,
    });
  }
  return out;
}

function toBibtex(items: ResearchItem[]): string {
  return items.map((r, i) => {
    const key = `${(r.authors ?? 'ref').split(/[;,\s]/)[0].replace(/[^A-Za-z]/g, '') || 'ref'}${r.year ?? ''}${i}`;
    const f: string[] = [`  title = {${r.title}}`];
    if (r.authors) f.push(`  author = {${r.authors.split(/\s*;\s*/).join(' and ')}}`);
    if (r.year) f.push(`  year = {${r.year}}`);
    if (r.venue) f.push(`  journal = {${r.venue}}`);
    if (r.doi) f.push(`  doi = {${r.doi}}`);
    if (r.url) f.push(`  url = {${r.url}}`);
    return `@article{${key},\n${f.join(',\n')}\n}`;
  }).join('\n\n');
}

export function ResearchPanel({ onClose }: { onClose: () => void }) {
  const account = useAccount();
  const swr = useSWR(account ? SWR_KEYS.research(account) : null, () => studySpaceApi.research());
  const items = useMemo(() => swr.data ?? [], [swr.data]);
  const [sel, setSel] = useState<string | null>(null);
  const [attachmentVersion,setAttachmentVersion]=useState(0);
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);
  const item = items.find((i) => i.id === sel) ?? null;
  const fileInput = useRef<HTMLInputElement>(null);
  const bibInput = useRef<HTMLInputElement>(null);

  const save = async (id: string, patch: Partial<ResearchItem>) => {
    const saved = await studySpaceApi.updateResearch(id, patch);
    await swr.mutate((list = []) => list.map((x) => (x.id === id ? saved : x)), { revalidate: false });
  };
  const importPdf = async (file: File) => {
    setError(null);
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) { setError('Chỉ nhận tệp PDF.'); return; }
    if (file.size > MAX_PDF) { setError('Tệp lớn hơn 60 MB.'); return; }
    const hash = await fingerprint(file);
    for (const existing of items) {
      const known=await idb<string | undefined>(account,'readonly',st=>st.get(`hash:${existing.id}`)) ?? existing.annotations?.find(a=>a.documentHash)?.documentHash;
      if (known === hash) {
        await idb(account,'readwrite',st=>st.put(file,existing.id));
        await idb(account,'readwrite',st=>st.put(hash,`hash:${existing.id}`));
        setAttachmentVersion(v=>v+1);setSel(existing.id); setError('Tệp này đã có trong thư viện — đã mở lại cùng chú thích.'); return;
      }
    }
    let title = file.name.replace(/\.pdf$/i, '');
    let authors: string | null = null;
    try {
      const { pdfImportInfo } = await import('@/components/features/reading/books/engine/pdf');
      const info = await pdfImportInfo(file);
      if (info.title?.trim()) title = info.title.trim();
      if (info.author?.trim()) authors = info.author.trim();
    } catch { /* metadata unreadable: the file name stays the title */ }
    const made = await studySpaceApi.createResearch({ title: title.slice(0, 300), authors, fileName: file.name.slice(0, 200), fileSize: file.size });
    await idb(account, 'readwrite', (st) => st.put(file, made.id));
    await idb(account, 'readwrite', (st) => st.put(hash, `hash:${made.id}`));
    await swr.mutate((list = []) => [made, ...list], { revalidate: false });
    setSel(made.id);
  };
  const importBib = async (file: File) => {
    const entries = parseBibtex(await file.text());
    for (const e of entries.slice(0, 100)) await studySpaceApi.createResearch(e).catch(() => undefined);
    await swr.mutate();
  };
  const exportBib = () => {
    const blob = new Blob([toBibtex(items)], { type: 'application/x-bibtex' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'tai-lieu-nghien-cuu.bib'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  const list = items.filter((i) => !q || `${i.title} ${i.authors ?? ''} ${i.tags ?? ''} ${i.project ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <Panel title="Góc nghiên cứu" icon={<BookOpenText size={20} />} onClose={onClose}
      actions={<div style={{ display: 'flex', gap: 6 }}>
        <button type="button" className={`${s.btn} ${s.primary}`} onClick={() => fileInput.current?.click()}><FileUp size={14} /> Thêm PDF</button>
        <button type="button" className={s.btn} onClick={() => bibInput.current?.click()}><Upload size={14} /> Nhập BibTeX</button>
        <button type="button" className={s.btn} onClick={exportBib} disabled={!items.length}><Download size={14} /> Xuất BibTeX</button>
        <input ref={fileInput} type="file" accept="application/pdf,.pdf" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importPdf(f).catch(() => setError('Không thêm được tài liệu.')); }} />
        <input ref={bibInput} type="file" accept=".bib,text/plain" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importBib(f); }} />
      </div>}>
      {error && <div className={s.chip} style={{ color: 'var(--danger)', marginBottom: 8 }}>{error}</div>}
      <div className={s.researchColumns}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
          <input className={s.input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm theo tên, tác giả, thẻ…" aria-label="Tìm tài liệu" />
          <div className={s.list}>
            {swr.isLoading && <div className={s.hint}>Đang tải…</div>}
            {!swr.isLoading && list.length === 0 && <div className={s.hint}>Chưa có tài liệu. Thêm một tệp PDF hoặc nhập BibTeX.</div>}
            {list.map((r) => (
              <button key={r.id} type="button" className={`${s.row} ${sel === r.id ? s.rowActive : ''}`} onClick={() => setSel(r.id)} style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
                <span style={{ fontWeight: 700, display: 'flex', gap: 6, alignItems: 'center' }}>{r.favorite && <Star size={12} fill="currentColor" />}{r.title}</span>
                <span className={s.hint}>{[r.authors, r.year].filter(Boolean).join(' · ') || (r.fileName ? 'PDF' : 'Chỉ thông tin trích dẫn')}</span>
              </button>
            ))}
          </div>
        </div>
        {item ? <ResearchItemView key={`${item.id}:${attachmentVersion}`} item={item} account={account} onSave={(p) => save(item.id, p)}
          onDelete={async () => { await studySpaceApi.deleteResearch(item.id); await idb(account, 'readwrite', (st) => st.delete(item.id)).catch(() => undefined); setSel(null); await swr.mutate(); }}
          onAttach={async (f) => {
            const hash=await fingerprint(f);
            const expected=item.annotations?.find(a=>a.documentHash)?.documentHash;
            if(expected&&expected!==hash) throw Error('Tệp không trùng với tài liệu đã được đánh dấu.');
            const {openPdfDocument}=await import('@/components/features/reading/books/engine/pdf');
            const check=await openPdfDocument(f);await check.loadingTask.destroy();
            await idb(account,'readwrite',st=>st.put(f,item.id));await idb(account,'readwrite',st=>st.put(hash,`hash:${item.id}`));
            await save(item.id,{fileName:f.name.slice(0,200),fileSize:f.size});
          }} />
          : <div className={s.hint}>Chọn một tài liệu để đọc, đánh dấu và ghi chú.</div>}
      </div>
    </Panel>
  );
}

function ResearchItemView({ item, account, onSave, onDelete, onAttach }: {
  item: ResearchItem; account: string; onSave: (p: Partial<ResearchItem>) => Promise<void>; onDelete: () => Promise<void>; onAttach: (f: File) => Promise<void>;
}) {
  const [tab, setTab] = useState<'read' | 'info' | 'notes'>(item.fileName ? 'read' : 'info');
  const [meta, setMeta] = useState(item);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [missing, setMissing] = useState(false);
  const [page, setPage] = useState(item.lastPage);
  const [zoom, setZoom] = useState(1.2);
  const [selection, setSelection] = useState('');
  const [lookup, setLookup] = useState<string | null>(null);
  const [entry,setEntry]=useState<CanonicalDictionaryEntry|null>(null);
  const [hash,setHash]=useState('');
  const [rects,setRects]=useState<[number,number,number,number][]>([]);
  const [color,setColor]=useState(HIGHLIGHT_COLORS[0]);
  const [rotation,setRotation]=useState(0);
  const [viewport,setViewport]=useState<ReturnType<PDFPageProxy['getViewport']>|null>(null);
  const [annotationBusy,setAnnotationBusy]=useState(false);
  const [readError,setReadError]=useState('');
  const [hits, setHits] = useState<number[] | null>(null);
  const [find, setFind] = useState('');
  const canvas = useRef<HTMLCanvasElement>(null);
  const textLayer = useRef<HTMLDivElement>(null);
  const attachInput = useRef<HTMLInputElement>(null);
  const annotations = item.annotations ?? [];

  useEffect(() => {
    let cancelled = false;
    let opened: PDFDocumentProxy | null = null;
    (async () => {
      const blob = await idb<Blob | undefined>(account, 'readonly', (st) => st.get(item.id)).catch(() => undefined);
      if (!blob) { setMissing(!!item.fileName); return; }
      const digest=await fingerprint(blob);if(cancelled)return;setHash(digest);
      const { openPdfDocument } = await import('@/components/features/reading/books/engine/pdf');
      opened = await openPdfDocument(blob);
      if (cancelled) { void opened.loadingTask.destroy(); return; }
      setDoc(opened);
    })().catch(() => setMissing(true));
    return () => { cancelled = true; void opened?.loadingTask.destroy(); };
  }, [account, item.id, item.fileName]);

  useEffect(() => {
    if (!doc || tab !== 'read') return;
    let task: { cancel: () => void } | null = null;
    let cancelled = false;
    (async () => {
      const p = Math.min(Math.max(1, page), doc.numPages);
      const pg = await doc.getPage(p);
      if (cancelled || !canvas.current) return;
      const vp = pg.getViewport({ scale: zoom * Math.min(2,window.devicePixelRatio || 1), rotation:(pg.rotate+rotation)%360 });
      const c = canvas.current;
      c.width = vp.width; c.height = vp.height;
      c.style.width = `${vp.width / Math.min(2,window.devicePixelRatio || 1)}px`;
      c.style.height = `${vp.height / Math.min(2,window.devicePixelRatio || 1)}px`;
      const r = pg.render({ canvasContext: c.getContext('2d')!, viewport: vp, canvas: c } as never);
      task = r;
      await r.promise.catch(() => undefined);
      if (cancelled || !textLayer.current) return;
      const pdfjs = await import('pdfjs-dist');
      const layer = textLayer.current;
      layer.replaceChildren();
      const cssVp = pg.getViewport({ scale: zoom, rotation:(pg.rotate+rotation)%360 });
      setViewport(cssVp);
      layer.style.width = `${cssVp.width}px`; layer.style.height = `${cssVp.height}px`;
      layer.style.setProperty('--total-scale-factor', String(zoom));
      const tl = new pdfjs.TextLayer({ textContentSource: await pg.getTextContent(), container: layer, viewport: cssVp });
      await tl.render().catch(() => undefined);
    })();
    const t = setTimeout(() => void onSave({ lastPage: page }).catch(() => undefined), 1500);
    return () => { cancelled = true; task?.cancel(); clearTimeout(t); };
  }, [doc, page, zoom, tab, rotation]); // eslint-disable-line react-hooks/exhaustive-deps

  const captureSelection = () => {
    const selected=window.getSelection();const layer=textLayer.current;
    if(!selected?.rangeCount||!layer||!viewport)return;
    const range=selected.getRangeAt(0);
    if(!layer.contains(range.commonAncestorContainer))return;
    const bounds=layer.getBoundingClientRect();
    const boxes=Array.from(range.getClientRects()).filter(r=>r.width>1&&r.height>1).slice(0,150).map(r=>{
      const a=viewport.convertToPdfPoint((r.left-bounds.left)*viewport.width/bounds.width,(r.top-bounds.top)*viewport.height/bounds.height);
      const b=viewport.convertToPdfPoint((r.right-bounds.left)*viewport.width/bounds.width,(r.bottom-bounds.top)*viewport.height/bounds.height);
      return [Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[0],b[0]),Math.max(a[1],b[1])] as [number,number,number,number];
    });
    setRects(boxes);setSelection(selected.toString().trim());setLookup(null);setEntry(null);
  };

  const addAnnotation = async (a: Partial<Annotation>) => {
    if(annotationBusy)return;setAnnotationBusy(true);setReadError('');
    const next: Annotation[] = [...annotations, { id: `a${Date.now().toString(36)}`, page, quote: '', note: '', color: '#ffe27a', createdAt: new Date().toISOString(), ...a }];
    try{await onSave({ annotations: next });setSelection('');setRects([]);window.getSelection()?.removeAllRanges();}
    catch{setReadError('Chưa lưu được đánh dấu. Bạn có thể thử lại.');}
    finally{setAnnotationBusy(false);}
  };
  const search = async () => {
    if (!doc || !find.trim()) return;
    const found: number[] = [];
    const needle = find.toLowerCase();
    for (let i = 1; i <= Math.min(doc.numPages, 500); i++) {
      const tc = await (await doc.getPage(i)).getTextContent();
      if (tc.items.map((x) => ('str' in x ? x.str : '')).join(' ').toLowerCase().includes(needle)) found.push(i);
    }
    setHits(found);
    if (found[0]) setPage(found[0]);
  };
  const lookupWord = async () => {
    const word = selection.trim().split(/\s+/).slice(0, 3).join(' ');
    if (!word) return;
    const e = await lookupCanonical(word, 'en-vi').catch(() => null);
    setEntry(e);
    setLookup(e ? `${e.headword}${e.pronunciations[0]?.ipa ? ` ${e.pronunciations[0].ipa}` : ''}: ${e.generalTranslationVi ?? e.vietnameseSenses?.[0]?.meanings.slice(0, 3).join('; ') ?? e.partsOfSpeech[0]?.senses[0]?.definitionEn ?? '—'}` : 'Không tìm thấy trong từ điển.');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        {([['read', 'Đọc'], ['info', 'Thông tin trích dẫn'], ['notes', 'Ghi chú nghiên cứu']] as const).map(([t, l]) => (
          <button key={t} type="button" className={`${s.btn} ${tab === t ? s.primary : ''}`} onClick={() => setTab(t)}>{l}</button>
        ))}
        <span style={{ flex: 1 }} />
        <button type="button" className={s.iconBtn} aria-pressed={item.favorite} onClick={() => void onSave({ favorite: !item.favorite })} title="Yêu thích"><Star size={15} /></button>
        <button type="button" className={`${s.iconBtn} ${s.danger}`} onClick={() => { if (window.confirm('Xóa tài liệu này khỏi thư viện?')) void onDelete(); }} title="Xóa"><Trash2 size={15} /></button>
      </div>
      {tab === 'read' && (
        <div className={s.pdfColumns}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
            {!doc && !missing && <div className={s.hint}>{item.fileName ? 'Đang mở tài liệu…' : 'Mục này chưa có tệp PDF.'}</div>}
            {(missing || !item.fileName) && (
              <div className={s.stat}>
                <div style={{ fontWeight: 700 }}>{missing ? 'Tệp PDF không có trên trình duyệt này.' : 'Gắn một tệp PDF để đọc.'}</div>
                <p className={s.hint}>Tệp chỉ được lưu trên thiết bị của bạn; thông tin và chú thích vẫn đi theo tài khoản.</p>
                <button type="button" className={s.btn} onClick={() => attachInput.current?.click()}><FileUp size={14} /> Chọn tệp</button>
                <input ref={attachInput} type="file" accept="application/pdf,.pdf" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f && f.size <= MAX_PDF) void onAttach(f).then(() => location.reload()).catch(e=>setReadError(e.message||'Không mở được PDF.')); }} />
              </div>
            )}
            {doc && (
              <>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button type="button" className={s.iconBtn} onClick={() => setPage(Math.max(1, page - 1))} aria-label="Trang trước"><ChevronLeft size={16} /></button>
                  <input className={s.input} style={{ width: 64 }} type="number" min={1} max={doc.numPages} value={page} onChange={(e) => setPage(Math.max(1, Math.min(doc.numPages, Number(e.target.value) || 1)))} aria-label="Trang" />
                  <span className={s.hint}>/ {doc.numPages}</span>
                  <button type="button" className={s.iconBtn} onClick={() => setPage(Math.min(doc.numPages, page + 1))} aria-label="Trang sau"><ChevronRight size={16} /></button>
                  <button type="button" className={s.iconBtn} onClick={() => setZoom(Math.max(0.6, zoom - 0.15))} aria-label="Thu nhỏ"><ZoomOut size={16} /></button>
                  <button type="button" className={s.iconBtn} onClick={() => setZoom(Math.min(2.6, zoom + 0.15))} aria-label="Phóng to"><ZoomIn size={16} /></button>
                  <button type="button" className={s.btn} onClick={()=>{setRotation((rotation+90)%360);setSelection('');}}>Xoay 90°</button>
                  <button type="button" className={s.btn} onClick={() => void addAnnotation({ bookmark: true, quote: `Trang ${page}` })}><Bookmark size={14} /> Đánh dấu trang</button>
                  <form onSubmit={(e) => { e.preventDefault(); void search(); }} style={{ display: 'flex', gap: 4 }}>
                    <input className={s.input} style={{ width: 150 }} value={find} onChange={(e) => setFind(e.target.value)} placeholder="Tìm trong tài liệu" aria-label="Tìm trong tài liệu" />
                    <button type="submit" className={s.iconBtn} aria-label="Tìm"><Search size={15} /></button>
                  </form>
                  {hits && <span className={s.hint}>{hits.length ? `Có ở trang ${hits.slice(0, 12).join(', ')}` : 'Không thấy'}</span>}
                </div>
                {selection && (
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span className={s.chip} style={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>“{selection}”</span>
                    <select aria-label="Màu đánh dấu" className={s.select} style={{width:120}} value={color} onChange={e=>setColor(e.target.value)}>{HIGHLIGHT_COLORS.map((c,i)=><option key={c} value={c}>{['Vàng','Xanh lá','Xanh lam','Tím'][i]}</option>)}</select>
                    <button type="button" disabled={annotationBusy||!rects.length} className={s.btn} onClick={() => void addAnnotation({ quote: selection.slice(0,2000),rects,documentHash:hash,color })}><Highlighter size={14} /> Đánh dấu đoạn</button>
                    <button type="button" className={s.btn} onClick={() => void lookupWord()}><Search size={14} /> Tra từ</button>
                    <FlashcardSave key={selection} text={selection} context={selection} entry={entry}/>
                    {lookup && <span className={s.hint}>{lookup}</span>}
                  </div>
                )}
                <div style={{ overflow: 'auto', flex: 1, minHeight: 300, borderRadius: 14, background: 'rgba(124,108,240,.06)', padding: 10 }}
                  onPointerUp={captureSelection} onKeyUp={captureSelection}>
                  <div style={{ position: 'relative', margin: '0 auto', width: 'fit-content', boxShadow: '0 10px 30px -14px rgba(40,30,120,.4)' }}>
                    <canvas ref={canvas} style={{ display: 'block', background: '#fff' }} />
                    <div aria-hidden="true" className={s.pdfHighlights} data-testid="pdf-highlights">
                      {viewport&&annotations.filter(a=>a.page===page&&a.documentHash===hash).flatMap(a=>(a.rects??[]).map((r,i)=>{
                        const t=viewport.transform;
                        const b=[t[0]*r[0]+t[2]*r[1]+t[4],t[1]*r[0]+t[3]*r[1]+t[5],t[0]*r[2]+t[2]*r[3]+t[4],t[1]*r[2]+t[3]*r[3]+t[5]];
                        return <span key={`${a.id}-${i}`} data-annotation={a.id} style={{position:'absolute',left:Math.min(b[0],b[2]),top:Math.min(b[1],b[3]),width:Math.abs(b[2]-b[0]),height:Math.abs(b[3]-b[1]),background:HIGHLIGHT_COLORS.includes(a.color)?a.color:HIGHLIGHT_COLORS[0],opacity:.45}}/>;
                      }))}
                    </div>
                    <div ref={textLayer} className="textLayer" style={{ position: 'absolute', inset: 0, overflow: 'hidden', lineHeight: 1, opacity: 1, color: 'transparent', userSelect: 'text' }} />
                  </div>
                </div>
              </>
            )}
          </div>
          <div className={s.list}>
            <div style={{ fontWeight: 800 }}>Trích dẫn và dấu trang</div>
            {readError&&<p role="alert" className={s.hint}>{readError}</p>}
            {annotations.length === 0 && <div className={s.hint}>Bôi đen chữ trong trang rồi bấm “Đánh dấu đoạn”.</div>}
            {[...annotations].sort((a, b) => a.page - b.page).map((a) => (
              <div key={a.id} className={s.card} style={{ cursor: 'default' }}>
                <button type="button" className={s.chip} onClick={() => setPage(a.page)}>{a.bookmark ? <Bookmark size={11} /> : <Highlighter size={11} />} Trang {a.page}</button>
                {!a.bookmark && <div style={{ fontSize: 12.5, margin: '6px 0', borderLeft: `3px solid ${a.color}`, paddingLeft: 8 }}>{a.quote}</div>}
                {!a.bookmark&&<select className={s.select} aria-label="Đổi màu đánh dấu" value={a.color} onChange={e=>void onSave({annotations:annotations.map(x=>x.id===a.id?{...x,color:e.target.value}:x)})}>{HIGHLIGHT_COLORS.map((c,i)=><option key={c} value={c}>{['Vàng','Xanh lá','Xanh lam','Tím'][i]}</option>)}</select>}
                <textarea className={s.textarea} style={{ minHeight: 44 }} defaultValue={a.note} placeholder="Ghi chú…" aria-label="Ghi chú cho trích dẫn"
                  onBlur={(e) => { if (e.target.value !== a.note) void onSave({ annotations: annotations.map((x) => (x.id === a.id ? { ...x, note: e.target.value.slice(0, 2000) } : x)) }); }} />
                <button type="button" className={`${s.btn} ${s.danger}`} style={{ padding: '2px 8px', fontSize: 11, marginTop: 4 }} onClick={() => void onSave({ annotations: annotations.filter((x) => x.id !== a.id) })}>Xóa</button>
              </div>
            ))}
          </div>
        </div>
      )}
      {tab === 'info' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10, maxWidth: 820 }}>
          {([['title', 'Tiêu đề'], ['authors', 'Tác giả (ngăn bằng dấu ;)'], ['year', 'Năm'], ['venue', 'Tạp chí / hội nghị / nhà xuất bản'], ['doi', 'DOI'], ['url', 'Đường dẫn (https://…)'], ['project', 'Dự án'], ['tags', 'Thẻ (ngăn bằng dấu phẩy)']] as const).map(([k, l]) => (
            <label key={k} className={s.field}>{l}
              <input className={s.input} value={meta[k] === null || meta[k] === undefined ? '' : String(meta[k])} onChange={(e) => setMeta({ ...meta, [k]: k === 'year' ? (e.target.value ? Number(e.target.value) : null) : e.target.value })} />
            </label>
          ))}
          <div><button type="button" className={`${s.btn} ${s.primary}`} onClick={() => void onSave({ title: meta.title, authors: meta.authors ?? '', year: meta.year, venue: meta.venue ?? '', doi: meta.doi ?? '', url: meta.url ?? '', project: meta.project ?? '', tags: meta.tags ?? '' })}>Lưu thông tin</button></div>
          <p className={s.hint} style={{ gridColumn: '1 / -1' }}>Thông tin trích dẫn do bạn nhập hoặc đọc từ tệp; ứng dụng không tự bịa thêm tác giả, năm hay DOI.</p>
        </div>
      )}
      {tab === 'notes' && (
        <textarea className={s.textarea} style={{ flex: 1, minHeight: 360 }} defaultValue={item.notes} maxLength={50000} placeholder="Ghi chú nghiên cứu: câu hỏi, ý chính, kết luận…" aria-label="Ghi chú nghiên cứu"
          onBlur={(e) => { if (e.target.value !== item.notes) void onSave({ notes: e.target.value }); }} />
      )}
    </div>
  );
}
