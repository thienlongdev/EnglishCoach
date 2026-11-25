'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { apiClient } from '@/services/api-client';
import type { ReadingCatalog } from '@/lib/reading-system-cache';
import type { ReadingMaterial } from '@/components/features/reading/ReadingCard';
import type { TypingWritingCategory } from '@/types/writing';
import { writingApi } from '@/services/writingApi';
import { eligibleEnglish, normalizeTypingText, typingSections, type TypingSource } from '@/lib/writing/typing-engine';
import { glass } from '../glass/WritingGlass';

interface Props { source: Exclude<TypingSource, 'random'>; vi: boolean; onChoose: (text: string) => void }
interface Choice { id: string; title: string; text?: string }
const selectClass = `${glass.select} w-full min-w-0 text-sm`;
export function TypingSources({ source, vi, onChoose }: Props) {
  const [library, setLibrary] = useState('SYSTEM');
  const [category, setCategory] = useState<TypingWritingCategory>('sentence');
  const [hasNext, setHasNext] = useState(false);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [choices, setChoices] = useState<Choice[]>([]);
  const [selected, setSelected] = useState('');
  const [sections, setSections] = useState<string[]>([]);
  const [fullText, setFullText] = useState('');
  const [section, setSection] = useState('full');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const detailRequest = useRef<AbortController | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const timer = setTimeout(() => { setQuery(search); setPage(0); }, 300);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    const controller = new AbortController();
    detailRequest.current?.abort();
    setSelected(''); setSections([]); setFullText(''); setChoices([]); onChoose('');
    setLoading(true); setError(false);
    const config = { signal: controller.signal, timeout: 15000 };
    async function load() {
      try {
        if (source === 'reading') {
          const { data } = await apiClient.get<ReadingCatalog>('/reading/catalog', { ...config, params: { library, page, size: 24, search: query } });
          if (controller.signal.aborted) return;
          setChoices(data.content.map(x => ({ id: String(x.id), title: x.title }))); setPages(data.totalPages);
        } else {
          const data = await writingApi.getTypingSources(category, page, controller.signal);
          if (controller.signal.aborted) return;
          setChoices(data.content.map(x => ({ id: x.id, title: `${category === 'draft' ? x.title : (vi ? (category === 'sentence' ? 'Luyện dịch câu' : 'Luyện dịch đoạn văn') : x.title)} · ${new Date(x.savedAt).toLocaleString(vi ? 'vi-VN' : 'en-GB')}` })));
          setHasNext(data.hasNext);
        }
      } catch { if (!controller.signal.aborted) setError(true); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }
    void load();
    return () => { controller.abort(); detailRequest.current?.abort(); };
  }, [source, library, category, page, query, reload, onChoose, vi]);
  async function choose(id: string) {
    detailRequest.current?.abort();
    const controller = new AbortController(); detailRequest.current = controller;
    setSelected(id); setSections([]); setFullText(''); onChoose(''); setError(false);
    if (!id) return;
    setLoading(true);
    try {
      let text = choices.find(x => x.id === id)?.text ?? '';
      if (source === 'reading') {
        const { data } = await apiClient.get<ReadingMaterial>(`/reading/materials/${id}`, { signal: controller.signal, timeout: 15000 });
        text = data.contentText || data.canonicalDocument?.plainText || '';
      } else {
        const data = await writingApi.getTypingSource(category, id, controller.signal);
        text = data.text ?? '';
      }
      if (controller.signal.aborted) return;
      const parts = typingSections(text).filter(eligibleEnglish);
      setSections(parts); setSection('full');
      // Large documents still expose their eligible paragraphs; never silently truncate a full article.
      const normalized = normalizeTypingText(text);
      const full = eligibleEnglish(normalized) ? normalized : '';
      setFullText(full);
      if (full) onChoose(full);
      else if (parts.length) { setSection('0'); onChoose(parts[0]); }
    } catch { if (!controller.signal.aborted) setError(true); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }
  return <div className={`${glass.well} space-y-3 p-4`}>
    <div className="grid gap-3 sm:grid-cols-2">
      {source === 'reading' ? <label className="space-y-1 text-xs text-on-surface-variant"><span>{vi ? 'Thư viện' : 'Library'}</span>
        <select aria-label={vi ? 'Thư viện' : 'Library'} className={selectClass} value={library} onChange={e => { setLibrary(e.target.value); setPage(0); }}>
          <option value="SYSTEM">{vi ? 'Thư viện Reading' : 'Reading library'}</option>
          <option value="USER">{vi ? 'Bài Reading của tôi' : 'My readings'}</option>
        </select>
      </label> : <label className="space-y-1 text-xs text-on-surface-variant sm:col-span-2"><span>{vi ? 'Nguồn Writing' : 'Writing source'}</span><select aria-label={vi ? 'Nguồn Writing' : 'Writing source'} className={selectClass} value={category} onChange={e => { setCategory(e.target.value as TypingWritingCategory); setPage(0); }}><option value="sentence">{vi ? 'Luyện dịch câu' : 'Sentence Translation'}</option><option value="paragraph">{vi ? 'Luyện dịch đoạn văn' : 'Paragraph Translation'}</option><option value="draft">{vi ? 'Bản nháp Writing' : 'Writing Drafts'}</option></select></label>}
      {source === 'reading' && <label className="space-y-1 text-xs text-on-surface-variant"><span>{vi ? 'Tìm bài' : 'Find a reading'}</span><input className="w-full min-w-0 min-h-10 rounded-[0.85rem] bg-surface-container-lowest px-3 text-sm text-on-surface placeholder:text-outline" value={search} onChange={e => setSearch(e.target.value)} placeholder={vi ? 'Tìm theo tiêu đề…' : 'Search titles…'} /></label>}
      <label className="space-y-1 text-xs text-on-surface-variant sm:col-span-2"><span>{vi ? 'Chọn nội dung' : 'Choose content'}</span>
        <select aria-label={vi ? 'Chọn nội dung' : 'Choose content'} className={selectClass} value={selected} disabled={loading} onChange={e => void choose(e.target.value)}>
          <option value="">{vi ? 'Chọn một bài để luyện gõ…' : 'Choose a passage to type…'}</option>
          {choices.map(x => <option key={x.id} value={x.id}>{x.title}</option>)}
        </select>
      </label>
      {sections.length > 0 && <label className="space-y-1 text-xs text-on-surface-variant sm:col-span-2"><span>{vi ? 'Phần luyện gõ' : 'Practice section'}</span>
        <select aria-label={vi ? 'Phần luyện gõ' : 'Practice section'} className={selectClass} value={section} onChange={e => { setSection(e.target.value); onChoose(e.target.value === 'full' ? fullText : sections[Number(e.target.value)]); }}>
          {fullText && <option value="full">{vi ? 'Toàn bộ nội dung' : 'Full passage'}</option>}
          {sections.map((s, i) => <option key={i} value={String(i)}>{vi ? 'Đoạn' : 'Paragraph'} {i + 1} · {s.slice(0, 70)}{s.length > 70 ? '…' : ''}</option>)}
        </select>
      </label>}
    </div>
    {loading && <p className="flex gap-2 text-sm text-on-surface-variant" role="status"><Loader2 className="h-4 w-4 animate-spin" />{vi ? 'Đang tải nội dung…' : 'Loading content…'}</p>}
    {error && <p role="alert" className="text-sm text-error">{vi ? 'Không tải được nội dung. Quyền truy cập có thể đã thay đổi.' : 'Content could not be loaded. Access may have changed.'} <button className="underline" onClick={() => { setReload(x => x + 1); }}>{vi ? 'Thử lại' : 'Retry'}</button></p>}
    {!loading && !error && (!choices.length || (selected && !sections.length)) && <p role="status" className="text-sm text-on-surface-variant">{vi ? 'Chưa có nội dung tiếng Anh phù hợp để luyện gõ.' : 'No suitable English text is available for typing.'}</p>}
    {(source === 'reading' ? pages > 1 : page > 0 || hasNext) && <div className="flex items-center justify-end gap-3 text-xs text-on-surface-variant">
      <button aria-label={vi ? 'Trang trước' : 'Previous page'} disabled={!page || loading} onClick={() => setPage(x => x - 1)} className="rounded-lg p-2 disabled:opacity-30"><ChevronLeft size={18} /></button><span>{page + 1}{source === 'reading' ? ` / ${pages}` : ''}</span>
      <button aria-label={vi ? 'Trang sau' : 'Next page'} disabled={(source === 'reading' ? page + 1 >= pages : !hasNext) || loading} onClick={() => setPage(x => x + 1)} className="rounded-lg p-2 disabled:opacity-30"><ChevronRight size={18} /></button>
    </div>}
  </div>;
}
