'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Trash2 } from 'lucide-react';
import { echoIntelligenceApi, type EchoMemoryItem, type EchoSuggestion } from '@/services/echoIntelligenceApi';
import { safeEchoHref } from './echo-window';

const KIND_VI: Record<string, string> = { EXPLANATION_LANGUAGE: 'Ngôn ngữ giải thích', ANSWER_STYLE: 'Cách trả lời', LEVEL_PREFERENCE: 'Mức độ',
  FOCUS_SKILL: 'Kỹ năng ưu tiên', STATED_GOAL: 'Mục tiêu bạn nói', INTEREST: 'Sở thích', NOTE: 'Ghi chú' };

/** What Echo remembers about the learner (only what they asked it to remember): view, delete one, delete all. */
export function EchoMemoryPanel({ vi }: { vi: boolean }) {
  const [items, setItems] = useState<EchoMemoryItem[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    echoIntelligenceApi.memory().then(list => { if (live) setItems(list); }).catch(() => { if (live) setError(vi ? 'Chưa tải được.' : 'Could not load.'); });
    return () => { live = false; };
  }, [vi]);
  const remove = async (id?: number) => {
    try { if (id === undefined) { await echoIntelligenceApi.forgetAll(); setItems([]); } else { await echoIntelligenceApi.forget(id); setItems(list => (list ?? []).filter(i => i.id !== id)); } }
    catch { setError(vi ? 'Chưa xóa được.' : 'Could not delete.'); }
  };
  return <div className="echo-memory" aria-label={vi ? 'Echo ghi nhớ' : 'Echo remembers'}>
    <p className="echo-memory-intro">{vi ? 'Echo chỉ ghi nhớ điều bạn dặn. Đây không phải điểm hay trình độ của bạn.' : 'Echo only keeps what you asked it to remember. It is never a score or a level.'}</p>
    {error && <p role="alert">{error}</p>}
    {items === null ? <p role="status">{vi ? 'Đang tải…' : 'Loading…'}</p>
      : items.length === 0 ? <p>{vi ? 'Chưa có gì. Ví dụ: “Echo ơi, nhớ là mình thích câu trả lời ngắn.”' : 'Nothing yet. Try: “Echo, remember I prefer short answers.”'}</p>
      : <ul>{items.map(item => <li key={item.id}><span><b>{vi ? (KIND_VI[item.kind] ?? item.kind) : item.kind.toLowerCase().replaceAll('_', ' ')}</b> · {item.value}</span>
          <button type="button" aria-label={vi ? 'Xóa ghi nhớ' : 'Delete note'} onClick={() => void remove(item.id)}><Trash2 size={14} /></button></li>)}</ul>}
    {items && items.length > 1 && <button type="button" className="echo-memory-clear" onClick={() => void remove()}>{vi ? 'Xóa tất cả' : 'Delete all'}</button>}
  </div>;
}

const COOLDOWN_MS = 30 * 60_000;
/** Per account (P0 isolation): another account in the same tab never sees these. */
const cache = new Map<string, { at: number; items: EchoSuggestion[] }>();

/**
 * Proactive help, only when the learner switched it on: deterministic server suggestions (no AI), fetched at most every
 * 30 minutes, each dismissible for the day.
 */
export function EchoSuggestions({ vi, scope }: { vi: boolean; scope: string }) {
  const router = useRouter();
  const day = new Date().toISOString().slice(0, 10);
  const dismissedKey = `echo_suggest_dismissed:v1:${scope}:${day}`;
  const [items, setItems] = useState<EchoSuggestion[]>(() => cache.get(scope)?.items ?? []);
  const [dismissed, setDismissed] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem(dismissedKey) || '[]'); } catch { return []; } });
  useEffect(() => {
    const hit = cache.get(scope);
    if (hit && Date.now() - hit.at < COOLDOWN_MS) { setItems(hit.items); return; }
    cache.set(scope, { at: Date.now(), items: hit?.items ?? [] });
    let live = true;
    echoIntelligenceApi.suggestions(vi ? 'vi' : 'en').then(list => { cache.set(scope, { at: Date.now(), items: list }); if (live) setItems(list); }).catch(() => {});
    return () => { live = false; };
  }, [vi, scope]);
  const dismiss = (key: string) => {
    const next = [...dismissed, key]; setDismissed(next);
    try { localStorage.setItem(dismissedKey, JSON.stringify(next)); } catch { /* storage off */ }
  };
  const shown = items.filter(s => !dismissed.includes(s.key) && safeEchoHref(s.href)).slice(0, 2);
  if (shown.length === 0) return null;
  return <div className="echo-proactive" role="status" aria-live="polite">{shown.map(s => <div key={s.key} className="echo-proactive-item">
    <span>{s.text}</span>
    <span className="echo-proactive-tools">
      <button type="button" onClick={() => { const href = safeEchoHref(s.href); if (href) router.push(href); }}>{s.label} →</button>
      <button type="button" aria-label={vi ? 'Để sau' : 'Later'} onClick={() => dismiss(s.key)}>×</button>
    </span></div>)}</div>;
}

export function proactiveKey(scope: string) { return `echo_proactive:v1:${scope}`; }
export function readProactive(scope: string) { try { return localStorage.getItem(proactiveKey(scope)) === 'on'; } catch { return false; } }
export function writeProactive(scope: string, on: boolean) { try { localStorage.setItem(proactiveKey(scope), on ? 'on' : 'off'); } catch { /* storage off */ } }
