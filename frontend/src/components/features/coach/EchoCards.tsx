'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { echoIntelligenceApi } from '@/services/echoIntelligenceApi';
import { safeEchoHref } from './echo-window';

/** Structured results built by Echo's server tools (never by model text). Strict React text; hrefs re-validated. */
export interface EchoCardItem { title: string; subtitle?: string | null; meta?: string | null; href?: string | null; status?: string | null }
export interface EchoCardData { type: 'resources' | 'stats' | 'tasks' | 'confirm' | 'memory'; title: string; items: EchoCardItem[]; token?: string | null; note?: string | null }
export interface EchoActionData { type: 'navigate'; href: string; label: string; auto?: boolean }

export function sanitizeCards(value: unknown): EchoCardData[] {
  if (!Array.isArray(value)) return [];
  const types = new Set(['resources', 'stats', 'tasks', 'confirm', 'memory']);
  const text = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : null);
  return value.slice(0, 8).flatMap(card => {
    if (!card || typeof card !== 'object' || !types.has((card as EchoCardData).type)) return [];
    const c = card as EchoCardData;
    const items = (Array.isArray(c.items) ? c.items : []).slice(0, 8).map(i => ({ title: text(i?.title, 120) ?? '', subtitle: text(i?.subtitle, 160),
      meta: text(i?.meta, 80), href: safeEchoHref(i?.href), status: text(i?.status, 24) })).filter(i => i.title);
    const token = c.type === 'confirm' && typeof c.token === 'string' && /^[A-Za-z0-9_-]{20,64}$/.test(c.token) ? c.token : null;
    if (c.type === 'confirm' && !token) return [];
    return [{ type: c.type, title: text(c.title, 120) ?? '', items, token, note: text(c.note, 240) }];
  }).slice(0, 3);
}

export function sanitizeActions(value: unknown): EchoActionData[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 2).flatMap(a => {
    const href = safeEchoHref(a?.href);
    return href && a?.type === 'navigate' && typeof a.label === 'string' ? [{ type: 'navigate' as const, href, label: a.label.slice(0, 80), auto: a.auto === true }] : [];
  });
}

function cardDedupeKey(card: EchoCardData): string {
  if (card.type === 'confirm' && card.token) return `confirm:${card.token}`;
  return `${card.type}|${card.title}|${card.items.map(i => `${i.href ?? ''}:${i.title}`).join(';')}`;
}

export function mergeCards(existing: EchoCardData[], incoming: EchoCardData[]): EchoCardData[] {
  if (!incoming.length) return existing;
  if (!existing.length) return incoming.slice(0, 6);
  const out = [...existing];
  const seen = new Set(out.map(cardDedupeKey));
  for (const card of incoming) {
    const key = cardDedupeKey(card);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(card);
  }
  return out.slice(0, 6);
}

export function mergeActions(existing: EchoActionData[], incoming: EchoActionData[]): EchoActionData[] {
  if (!incoming.length) return existing;
  if (!existing.length) return incoming.slice(0, 6);
  const out = [...existing];
  const indexByHref = new Map<string, number>();
  out.forEach((act, idx) => indexByHref.set(`${act.type}:${act.href}`, idx));
  for (const act of incoming) {
    const key = `${act.type}:${act.href}`;
    const prevIdx = indexByHref.get(key);
    if (prevIdx !== undefined) {
      if (act.auto && !out[prevIdx].auto) out[prevIdx] = { ...out[prevIdx], auto: true };
      continue;
    }
    indexByHref.set(key, out.length);
    out.push(act);
  }
  return out.slice(0, 6);
}

export function EchoCards({ cards, actions, vi }: { cards: EchoCardData[]; actions: EchoActionData[]; vi: boolean }) {
  const router = useRouter();
  const go = (href: string | null | undefined) => { const safe = safeEchoHref(href); if (safe) router.push(safe); };
  return <>
    {cards.map((card, i) => card.type === 'confirm' ? <EchoConfirmCard key={i} card={card} vi={vi} />
      : <div key={i} className={`echo-card echo-card-${card.type}`}>
        <div className="echo-card-title">{card.title}</div>
        <ul>{card.items.map((item, j) => <li key={j}>
          {item.href && card.type !== 'stats'
            ? <button type="button" className="echo-card-row" onClick={() => go(item.href)}>
                <span className="echo-card-main">{card.type === 'tasks' && <span className="echo-card-check" aria-hidden="true">{item.status === 'DONE' ? '✓' : '○'}</span>}{item.title}</span>
                {(item.subtitle || item.meta) && <span className="echo-card-sub">{[item.subtitle, item.meta].filter(Boolean).join(' · ')}</span>}
              </button>
            : <div className="echo-card-row">
                <span className="echo-card-main">{item.title}</span>
                {card.type === 'stats' ? <span className="echo-card-value">{item.subtitle}</span> : null}
                {(card.type === 'stats' ? item.meta : [item.subtitle, item.meta].filter(Boolean).join(' · ')) && <span className="echo-card-sub">{card.type === 'stats' ? item.meta : [item.subtitle, item.meta].filter(Boolean).join(' · ')}</span>}
              </div>}
        </li>)}</ul>
        {card.note && <p className="echo-card-note">{card.note}</p>}
      </div>)}
    {actions.length > 0 && <div className="echo-actions">{actions.map(action =>
      <button type="button" key={action.href} onClick={() => go(action.href)}>{action.label} →</button>)}</div>}
  </>;
}

/** PREVIEW → learner presses Confirm → the server re-validates and commits once (single-use token). */
function EchoConfirmCard({ card, vi }: { card: EchoCardData; vi: boolean }) {
  const [state, setState] = useState<'idle' | 'busy' | 'applied' | 'cancelled' | 'failed'>('idle');
  const [savedCards, setSavedCards] = useState<number | null>(null);
  const decide = async (decision: 'CONFIRM' | 'CANCEL') => {
    if (!card.token || state !== 'idle') return;
    setState('busy');
    try {
      const r = await echoIntelligenceApi.decide(card.token, decision) as { status?: string; savedCards?: number };
      if (typeof r.savedCards === 'number' && r.savedCards > 0) setSavedCards(r.savedCards);
      setState(r.status === 'APPLIED' ? 'applied' : 'cancelled');
    } catch { setState('failed'); }
  };
  const appliedNote = savedCards !== null
    ? (vi ? `Đã lưu ${savedCards} thẻ ghi nhớ.` : `Saved ${savedCards} flashcards.`)
    : (vi ? 'Đã xác nhận và áp dụng.' : 'Confirmed and applied.');
  return <div className="echo-card echo-card-confirm" role="group" aria-label={card.title}>
    <div className="echo-card-title">{card.title}</div>
    <ul>{card.items.map((item, j) => <li key={j} className="echo-card-row">
      <span className="echo-card-main">{item.title}</span>
      <span className="echo-card-sub">
        {item.meta ? <>{item.meta} → <strong>{item.subtitle ?? '—'}</strong></> : <strong>{item.subtitle ?? '—'}</strong>}
      </span>
    </li>)}</ul>
    {card.note && <p className="echo-card-note">{card.note}</p>}
    {state === 'idle' || state === 'busy'
      ? <div className="echo-confirm-buttons">
          <button type="button" disabled={state === 'busy'} onClick={() => void decide('CONFIRM')}>{vi ? 'Xác nhận' : 'Confirm'}</button>
          <button type="button" disabled={state === 'busy'} onClick={() => void decide('CANCEL')}>{vi ? 'Hủy' : 'Cancel'}</button>
        </div>
      : <p role="status" className="echo-card-note">{state === 'applied' ? appliedNote
        : state === 'cancelled' ? (vi ? 'Đã hủy, dữ liệu giữ nguyên.' : 'Cancelled; nothing was changed.')
        : (vi ? 'Thay đổi này đã hết hạn hoặc không còn hợp lệ. Bạn hỏi lại Echo nhé.' : 'This change expired or is no longer valid. Please ask Echo again.')}</p>}
  </div>;
}
