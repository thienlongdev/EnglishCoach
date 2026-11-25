'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Highlighter, Quote, Trash2 } from 'lucide-react';
import type { PublicStimulusDto } from '@/types/exams';
import { segmentText, type CbtHighlight, type CbtRange } from '@/lib/exams/ieltsCbt';
import { stimulusDocuments } from '@/lib/exams/groupPresentation';
import { isImageAsset } from '@/lib/exams/media';
import { ExamAssetImage } from '../ExamAssetImage';
import s from './ieltsCbt.module.css';

/**
 * Reading passage of the IELTS CBT room (2026-11-13) with the reference annotation tools: select text ⇒ a small toolbar
 * "Note" / "Highlight" (keys a / h); click a highlight ⇒ "Delete Highlight". Highlights are TEXT OFFSETS per block
 * (`stimulusId:paragraph`) rendered as segments — React owns the DOM, nothing is wrapped by hand, so they survive
 * re-renders, question / part switches and reloads (the shell persists them per attempt).
 */

interface Block {
  key: string;
  label: string | null;
  text: string;
}

function blocksOf(st: PublicStimulusDto): { docs: Array<{ label: string | null; blocks: Block[] }> } {
  const body: any = st.bodyPayload || {};
  const docs = stimulusDocuments(st.kind, body);
  const split = (text: string, prefix: string): Block[] =>
    text
      .split(/\n\s*\n/)
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t, i) => {
        const m = /^(Paragraph\s+[A-Z]:?|[A-H])\s+(?=\S)/.exec(t);
        return { key: `${prefix}:${i}`, label: m ? m[1] : null, text: m ? t.slice(m[0].length) : t };
      });
  if (docs.segmented) {
    return {
      docs: docs.documents.map((d, di) => ({
        label: d.label,
        blocks: split(d.paragraphs.join('\n\n'), `${st.id}:d${di}`),
      })),
    };
  }
  const raw = body.text || body.content || body.paragraphs || '';
  // Canonical packages carry paragraphs as { id: 'A', text }: the printed paragraph letter is kept as its label.
  let text = Array.isArray(raw)
    ? raw
        .map((p: any) => {
          const t = String(p?.text ?? p ?? '').trim();
          const id = typeof p?.id === 'string' && /^[A-Z]$/.test(p.id) && !t.startsWith(`${p.id} `) ? `${p.id} ` : '';
          return id + t;
        })
        .join('\n\n')
    : String(raw || '');
  if (st.title) {
    const esc = st.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(`^(#{1,4}\\s*)?${esc}\\s*\\n+`, 'i'), '');
  }
  text = text.replace(/^#{1,4}\s+/gm, '');
  return { docs: [{ label: null, blocks: split(text, st.id) }] };
}

function offsetWithin(block: Element, node: Node, offset: number): number {
  const range = document.createRange();
  range.selectNodeContents(block);
  try {
    range.setEnd(node, offset);
  } catch {
    return 0;
  }
  return range.toString().length;
}

/** Text-offset ranges of the current selection, one per passage block it touches. */
function selectionRanges(container: HTMLElement): { ranges: CbtRange[]; text: string; rect: DOMRect } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;
  const text = sel.toString();
  if (!text.trim()) return null;
  const blocks = Array.from(container.querySelectorAll<HTMLElement>('[data-cbt-block]'));
  const ranges: CbtRange[] = [];
  for (const block of blocks) {
    if (!range.intersectsNode(block)) continue;
    const len = (block.textContent || '').length;
    const start = block.contains(range.startContainer) ? offsetWithin(block, range.startContainer, range.startOffset) : 0;
    const end = block.contains(range.endContainer) ? offsetWithin(block, range.endContainer, range.endOffset) : len;
    if (end > start) ranges.push({ block: block.dataset.cbtBlock as string, start, end });
  }
  if (ranges.length === 0) return null;
  return { ranges, text, rect: range.getBoundingClientRect() };
}

export interface CbtPassageProps {
  stimuli: PublicStimulusDto[];
  highlights: CbtHighlight[];
  onHighlight: (ranges: CbtRange[], excerpt: string, withNote: boolean) => void;
  onDeleteHighlight: (id: string) => void;
  onOpenNote: (id: string) => void;
  attemptId?: string;
  emptyText: string;
}

export function CbtPassage({ stimuli, highlights, onHighlight, onDeleteHighlight, onOpenNote, attemptId, emptyText }: CbtPassageProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [adder, setAdder] = useState<{ x: number; y: number; ranges: CbtRange[]; text: string } | null>(null);
  const [popover, setPopover] = useState<{ x: number; y: number; id: string } | null>(null);

  const readSelection = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const found = selectionRanges(el);
    if (!found) {
      setAdder(null);
      return;
    }
    const above = found.rect.top > 120;
    setPopover(null);
    setAdder({
      x: Math.max(8, found.rect.left + found.rect.width / 2 - 56),
      y: above ? found.rect.top - 54 : found.rect.bottom + 8,
      ranges: found.ranges,
      text: found.text,
    });
  }, []);

  const act = useCallback(
    (withNote: boolean) => {
      if (!adder) return;
      onHighlight(adder.ranges, adder.text.replace(/\s+/g, ' ').trim(), withNote);
      window.getSelection()?.removeAllRanges();
      setAdder(null);
    },
    [adder, onHighlight]
  );

  useEffect(() => {
    if (!adder) return;
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (k === 'h') {
        e.preventDefault();
        act(false);
      } else if (k === 'a') {
        e.preventDefault();
        act(true);
      } else if (k === 'escape') setAdder(null);
    };
    const onScroll = () => setAdder(null);
    window.addEventListener('keydown', onKey);
    ref.current?.closest('[data-cbt-pane]')?.addEventListener('scroll', onScroll, { passive: true });
    const pane = ref.current?.closest('[data-cbt-pane]');
    return () => {
      window.removeEventListener('keydown', onKey);
      pane?.removeEventListener('scroll', onScroll);
    };
  }, [adder, act]);

  useEffect(() => {
    if (!popover) return;
    const close = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest('[data-cbt-popover]') && !t.closest('[data-cbt-hl]')) setPopover(null);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [popover]);

  const byBlock = new Map<string, CbtHighlight[]>();
  for (const h of highlights) {
    const list = byBlock.get(h.block) || [];
    list.push(h);
    byBlock.set(h.block, list);
  }

  const renderBlock = (b: Block) => (
    <p key={b.key} className={s.passageBlock}>
      {b.label && (
        <span className={s.passageLabel} data-cbt-skip>
          {b.label}
        </span>
      )}
      <span data-cbt-block={b.key}>
        {segmentText(b.text, byBlock.get(b.key) || []).map((seg, i) =>
          seg.highlightId ? (
            <span
              key={i}
              className={s.hl}
              data-cbt-hl={seg.highlightId}
              data-note={seg.hasNote}
              data-focus={popover?.id === seg.highlightId}
              onClick={(e) => {
                if (window.getSelection()?.toString()) return;
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setAdder(null);
                setPopover({ x: Math.max(8, e.clientX - 34), y: r.bottom + 6, id: seg.highlightId as string });
              }}
            >
              {seg.text}
            </span>
          ) : (
            <React.Fragment key={i}>{seg.text}</React.Fragment>
          )
        )}
      </span>
    </p>
  );

  const popoverHasNote = popover ? highlights.some((h) => h.id === popover.id && h.note != null) : false;

  return (
    <div ref={ref} className={s.passage} onMouseUp={readSelection} onKeyUp={(e) => e.shiftKey && readSelection()} translate="no">
      {stimuli.length === 0 && <p className={s.unavailable}>{emptyText}</p>}
      {stimuli.map((st) => {
        const parsed = blocksOf(st);
        const images = (st.assets || []).filter((a) => isImageAsset(a) && a.delivery === 'PLAYBACK_GRANT' && a.assetId);
        return (
          <article key={st.id}>
            {st.title && <h2 className={s.passageTitle}>{st.title}</h2>}
            {parsed.docs.map((d, di) => (
              <React.Fragment key={di}>
                {d.label && <p className={s.docLabel}>{d.label}</p>}
                {d.blocks.map(renderBlock)}
              </React.Fragment>
            ))}
            {images.map((a) => (
              <div key={a.assetId} className={s.passageFigure}>
                <ExamAssetImage className={s.figureImg} attemptId={attemptId} asset={a} alt={(st.bodyPayload as any)?.altText || st.title || 'Figure'} />
              </div>
            ))}
          </article>
        );
      })}

      {adder && (
        <div className={s.adder} style={{ left: adder.x, top: adder.y }} role="toolbar" aria-label="Annotation" data-testid="cbt-adder">
          <button type="button" className={s.adderBtn} title="Note (a)" onMouseDown={(e) => e.preventDefault()} onClick={() => act(true)}>
            <Quote aria-hidden />
            Note
          </button>
          <button type="button" className={s.adderBtn} title="Highlight (h)" onMouseDown={(e) => e.preventDefault()} onClick={() => act(false)}>
            <Highlighter aria-hidden />
            Highlight
          </button>
        </div>
      )}
      {popover && (
        <div className={s.adder} style={{ left: popover.x, top: popover.y }} data-cbt-popover role="toolbar" aria-label="Highlight">
          {popoverHasNote && (
            <button
              type="button"
              className={s.adderBtn}
              onClick={() => {
                onOpenNote(popover.id);
                setPopover(null);
              }}
            >
              <Quote aria-hidden />
              Note
            </button>
          )}
          <button
            type="button"
            className={s.adderBtn}
            data-testid="cbt-delete-highlight"
            onClick={() => {
              onDeleteHighlight(popover.id);
              setPopover(null);
            }}
          >
            <Trash2 aria-hidden />
            Delete Highlight
          </button>
        </div>
      )}
    </div>
  );
}
