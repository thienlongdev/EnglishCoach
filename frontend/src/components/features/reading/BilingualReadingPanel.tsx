'use client';
import { useMemo, useState } from 'react';
import { RotateCw, Search, X } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import type { BilingualReadingCatalog, BilingualReadingCard } from '@/types/bilingualReading';
import { BilingualReadingCard as Card } from './BilingualReadingCard';
import { apiClient } from '@/services/api-client';
import { useCurrentRole } from '@/hooks/useCurrentRole';
import styles from './glass/readingGlass.module.css';

export function BilingualReadingPanel({ catalog, loading, error, onRetry, onOpen }: { catalog?: BilingualReadingCatalog; loading: boolean; error?: unknown; onRetry?: () => void; onOpen: (card: BilingualReadingCard) => void }) {
  const { locale } = useLanguage();
  const [query, setQuery] = useState('');
  const [type, setType] = useState<'ALL' | 'ARTICLE' | 'STORY'>('ALL');
  const { isAdmin } = useCurrentRole();
  const [receipt, setReceipt] = useState<{manifestSha256: string; applied: boolean; total: number; inserted: number; updated: number; skipped: number}>();
  const [importStatus, setImportStatus] = useState('');
  const [importBusy, setImportBusy] = useState(false);
  const importCorpus = async (apply: boolean) => {
    setImportBusy(true); setImportStatus('');
    try {
      const { data } = await apiClient.post('/reading/admin/bilingual', { apply, allowUpdates: false, manifestSha256: apply ? receipt?.manifestSha256 : null }, { timeout: 120000 });
      setReceipt(data); if (apply) onRetry?.();
    } catch { setImportStatus(locale === 'vi' ? 'Không thể nhập bộ tài liệu. Kiểm tra quyền và cấu hình nhập.' : 'Import failed. Check administrator access and import configuration.'); }
    finally { setImportBusy(false); }
  };
  const filtered = useMemo(() => { const q = query.trim().toLocaleLowerCase(); return (catalog?.content ?? []).filter(card => (type === 'ALL' || card.contentType === type) && (!q || `${card.titleEn} ${card.titleVi ?? ''}`.toLocaleLowerCase().includes(q))); }, [catalog, query, type]);
  const warm = Boolean(catalog);
  const vi = locale === 'vi';
  return <section className="flex flex-col gap-5" aria-label={vi ? 'Kho tài liệu song ngữ' : 'Bilingual Reading'}>
    {isAdmin && <details className={`${styles.panel} ${styles.adminBox}`}><summary>{vi ? 'Quản trị bộ tài liệu song ngữ' : 'Bilingual corpus administration'}</summary><div className="mt-3 flex flex-wrap gap-2"><button disabled={importBusy} type="button" className={styles.miniBtn} onClick={() => void importCorpus(false)}>{vi ? 'Kiểm tra nhập' : 'Preview import'}</button><button disabled={importBusy || !receipt} type="button" className={styles.miniBtn} onClick={() => void importCorpus(true)}>{vi ? 'Nhập bộ tài liệu đã kiểm tra' : 'Apply verified corpus'}</button></div>{receipt && <output className="mt-2 block">{receipt.applied ? 'APPLIED' : 'PREVIEW'} · total {receipt.total} · inserted {receipt.inserted} · updated {receipt.updated} · skipped {receipt.skipped}</output>}{importStatus && <p role="alert">{importStatus}</p>}</details>}
    <div className={`${styles.panel} ${styles.filters}`}>
      <div className={styles.filterRow} data-guide="bi-filter">
        <div className={`${styles.well} ${styles.segment}`}>
          {([['ALL', vi ? 'Tất cả' : 'All', catalog?.totalElements], ['ARTICLE', vi ? 'Bài báo' : 'Articles', catalog?.articleCount], ['STORY', vi ? 'Truyện ngắn' : 'Stories', catalog?.storyCount]] as const).map(([value, label, count]) => (
            <button key={value} type="button" aria-pressed={type === value} onClick={() => setType(value)} className={styles.segBtn}>{label} <span className={styles.segCount}>{count ?? '…'}</span></button>
          ))}
        </div>
        <label className={styles.search}>
          <Search className={styles.searchIcon} aria-hidden="true" />
          <input aria-label={vi ? 'Tìm tài liệu song ngữ' : 'Search bilingual readings'} value={query} onChange={e => setQuery(e.target.value)} placeholder={vi ? 'Tìm theo tiêu đề tiếng Anh hoặc tiếng Việt…' : 'Search English or Vietnamese titles…'} className={styles.field} />
          {query && <button type="button" onClick={() => setQuery('')} aria-label={vi ? 'Xóa tìm kiếm' : 'Clear search'} className={styles.clearBtn}><X className="h-4 w-4" /></button>}
        </label>
      </div>
      <p className={styles.filterNote}>{vi ? 'Đọc đối chiếu tiếng Anh và tiếng Việt theo từng đoạn.' : 'Compare English and Vietnamese segment by segment.'}</p>
    </div>
    {loading && !warm
      ? <div className={styles.grid} role="status" aria-label={vi ? 'Đang tải thư viện song ngữ' : 'Loading bilingual library'}>{Array.from({ length: 8 }).map((_, i) => <div key={i} className={styles.skeleton}><div className={`${styles.skBlock} aspect-[16/7] rounded-none`} /><div className="flex flex-col gap-2.5 p-4"><div className={`${styles.skBlock} h-5 w-5/6`} /><div className={`${styles.skBlock} h-4 w-3/5`} /><div className={`${styles.skBlock} mt-3 h-4 w-28`} /></div></div>)}</div>
      : <div className={styles.grid}>{filtered.map(card => <Card key={card.id} card={card} onClick={() => onOpen(card)} />)}</div>}
    {Boolean(error) && <div role="alert" className={styles.alert}>{vi ? 'Không thể cập nhật thư viện.' : 'Could not update the library.'}<button type="button" onClick={onRetry} className={styles.softBtn}><RotateCw className="h-3.5 w-3.5" aria-hidden="true" />{vi ? 'Thử lại' : 'Retry'}</button></div>}
    {!loading && catalog && filtered.length === 0 && <div className={`${styles.panel} ${styles.empty}`}><span className={styles.emptyIcon}><Search className="h-5 w-5" aria-hidden="true" /></span><h3>{vi ? 'Không tìm thấy tài liệu.' : 'No bilingual readings found.'}</h3>{query && <button type="button" onClick={() => setQuery('')} className={styles.softBtn}>{vi ? 'Xóa tìm kiếm' : 'Clear search'}</button>}</div>}
  </section>;
}
