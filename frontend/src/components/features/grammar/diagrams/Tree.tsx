'use client';

import React, { useMemo, useState } from 'react';
import { ChevronRight, Maximize2 } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import type { DiagramSpec } from '@/types/grammar';
import { cx } from '@/lib/grammar/format';
import styles from '../grammar.module.css';

export type TreeSpec = Extract<DiagramSpec, { kind: 'tree' }>;

interface PNode { id: string; label: string; word?: string; kids: PNode[] }

/** `[S [NP She] [VP [V has] [VP [V lived] [PP here]]]]` → a tree whose leaves are the words. Returns null if it is not a bracket. */
export function parseBracket(src: string): PNode | null {
  const tokens = src.match(/\[|\]|[^\s[\]]+/g) ?? [];
  let pos = 0;
  const node = (path: string): PNode | null => {
    if (tokens[pos] !== '[') return null;
    pos++;
    const label = tokens[pos];
    if (!label || label === '[' || label === ']') return null;
    pos++;
    const out: PNode = { id: path, label, kids: [] };
    while (pos < tokens.length && tokens[pos] !== ']') {
      if (tokens[pos] === '[') {
        const child = node(`${path}.${out.kids.length}`);
        if (!child) return null;
        out.kids.push(child);
      } else {
        out.kids.push({ id: `${path}.${out.kids.length}`, label: '', word: tokens[pos], kids: [] });
        pos++;
      }
    }
    if (tokens[pos] !== ']') return null;
    pos++;
    return out;
  };
  const root = node('0');
  return root && pos === tokens.length ? root : null;
}

const wordsOf = (n: PNode): string[] => (n.word !== undefined ? [n.word] : n.kids.flatMap(wordsOf));
const isPreTerminal = (n: PNode) => n.word === undefined && n.kids.length > 0 && n.kids.every((k) => k.word !== undefined);

const GLOSS: Record<string, { vi: string; en: string }> = {
  S: { vi: 'Câu', en: 'Sentence' },
  NP: { vi: 'Cụm danh từ', en: 'Noun phrase' },
  VP: { vi: 'Cụm động từ', en: 'Verb phrase' },
  V: { vi: 'Động từ', en: 'Verb' },
  AUX: { vi: 'Trợ động từ', en: 'Auxiliary' },
  DET: { vi: 'Hạn định từ', en: 'Determiner' },
  N: { vi: 'Danh từ', en: 'Noun' },
  ADJ: { vi: 'Tính từ', en: 'Adjective' },
  ADV: { vi: 'Trạng từ', en: 'Adverb' },
  PP: { vi: 'Cụm giới từ', en: 'Prepositional phrase' },
  P: { vi: 'Giới từ', en: 'Preposition' },
  CP: { vi: 'Mệnh đề (CP)', en: 'Clause (CP)' },
  SUB: { vi: 'Mệnh đề phụ', en: 'Subordinate clause' },
  TP: { vi: 'Cụm thì (TP)', en: 'Tense phrase (TP)' },
  AP: { vi: 'Cụm tính từ', en: 'Adjective phrase' },
};

interface Placed {
  id: string; kind: 'branch' | 'pre' | 'folded' | 'word'; label: string; text: string; x: number; y: number; w: number; parent: string | null;
}
const ROW = 66;
const CHIP_H = 34;
const GAP = 14;

function layout(root: PNode, folded: Set<string>): { items: Placed[]; width: number; height: number } {
  const items: Placed[] = [];
  let cursor = 0;
  let deepest = 0;
  const place = (n: PNode, depth: number, parent: string | null): { id: string; x: number } => {
    deepest = Math.max(deepest, depth);
    if (n.word !== undefined) {
      const w = Math.max(54, n.word.length * 9.4 + 30);
      const x = cursor + w / 2;
      cursor += w + GAP;
      items.push({ id: n.id, kind: 'word', label: '', text: n.word, x, y: depth * ROW, w, parent });
      return { id: n.id, x };
    }
    if (folded.has(n.id) && !isPreTerminal(n)) {
      const text = wordsOf(n).join(' ');
      const w = Math.min(230, Math.max(84, text.length * 8.6 + 44));
      const x = cursor + w / 2;
      cursor += w + GAP;
      items.push({ id: n.id, kind: 'folded', label: n.label, text, x, y: depth * ROW, w, parent });
      return { id: n.id, x };
    }
    const at = items.length;
    items.push({ id: n.id, kind: isPreTerminal(n) ? 'pre' : 'branch', label: n.label, text: '', x: 0, y: depth * ROW, w: Math.max(46, n.label.length * 10.5 + 26), parent });
    const kids = n.kids.map((k) => place(k, depth + 1, n.id));
    items[at].x = kids.length ? (kids[0].x + kids[kids.length - 1].x) / 2 : cursor;
    return { id: n.id, x: items[at].x };
  };
  place(root, 0, null);
  return { items, width: Math.max(cursor - GAP, 60), height: deepest * ROW + CHIP_H };
}

/**
 * A parse tree from a bracketed string. Each phrase is a button: click or Enter folds its branch into one chip (its words stay
 * in order), again to open it. The words of the sentence are repeated in a line above, in order, for reading and for screen
 * readers; the tree scrolls inside itself on a phone.
 */
export function TreeDiagram({ spec }: { spec: TreeSpec }) {
  const { locale } = useLanguage();
  const vi = locale === 'vi';
  const root = useMemo(() => parseBracket(spec.bracket), [spec.bracket]);
  const [folded, setFolded] = useState<Set<string>>(() => new Set());
  const laid = useMemo(() => (root ? layout(root, folded) : null), [root, folded]);
  const used = useMemo(() => {
    const seen: string[] = [];
    const walk = (n: PNode) => { if (n.label && !seen.includes(n.label)) seen.push(n.label); n.kids.forEach(walk); };
    if (root) walk(root);
    return seen;
  }, [root]);

  if (!root || !laid) {
    return <p className={styles.treeFallback} lang="en">{spec.bracket}</p>;
  }
  const byId = new Map(laid.items.map((i) => [i.id, i]));
  const toggle = (id: string) => setFolded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const sentence = wordsOf(root).join(' ');

  return (
    <div className={styles.tree}>
      <div className={styles.treeHead}>
        <p className={styles.treeSentence} lang="en">{sentence}</p>
        {folded.size ? (
          <button type="button" className={styles.miniBtn} onClick={() => setFolded(new Set())}>
            <Maximize2 aria-hidden="true" />{vi ? 'Mở tất cả' : 'Open all'}
          </button>
        ) : (
          <span className={styles.treeHint}>{vi ? 'Chọn một cụm để gộp lại' : 'Choose a phrase to fold it'}</span>
        )}
      </div>
      <div className={styles.treeScroll} tabIndex={0} role="region" aria-label={vi ? 'Cây cú pháp, cuộn ngang nếu cần' : 'Parse tree, scroll sideways if needed'}>
        <div className={styles.treeCanvas} style={{ width: laid.width, height: laid.height }}>
          <svg className={styles.treeLinks} width={laid.width} height={laid.height} aria-hidden="true">
            {laid.items.filter((i) => i.parent).map((i) => {
              const p = byId.get(i.parent as string);
              if (!p) return null;
              const y1 = p.y + CHIP_H;
              const y2 = i.y;
              const mid = (y1 + y2) / 2;
              return <path key={i.id} className={styles.treeLink} data-leaf={i.kind === 'word' ? 'true' : 'false'} d={`M${p.x},${y1} C${p.x},${mid} ${i.x},${mid} ${i.x},${y2}`} />;
            })}
          </svg>
          {laid.items.map((i) => {
            const style: React.CSSProperties = { left: i.x - i.w / 2, top: i.y, width: i.w, height: CHIP_H };
            if (i.kind === 'word') return <span key={i.id} className={styles.treeWord} style={style} lang="en">{i.text}</span>;
            if (i.kind === 'pre') return <span key={i.id} className={styles.treeNode} data-label={i.label} data-kind="pre" style={style} title={GLOSS[i.label] ? (vi ? GLOSS[i.label].vi : GLOSS[i.label].en) : undefined}>{i.label}</span>;
            const open = i.kind === 'branch';
            return (
              <button
                key={i.id}
                type="button"
                className={cx(styles.treeNode, styles.treeNodeBtn)}
                data-label={i.label}
                data-kind={i.kind}
                style={style}
                aria-expanded={open}
                title={i.kind === 'folded' ? i.text : GLOSS[i.label] ? (vi ? GLOSS[i.label].vi : GLOSS[i.label].en) : undefined}
                onClick={() => toggle(i.id)}
              >
                <ChevronRight aria-hidden="true" className={styles.treeCaret} data-open={open ? 'true' : 'false'} />
                <span className={styles.treeLabel}>{i.label}</span>
                {i.kind === 'folded' ? <span className={styles.treeFold} lang="en">{i.text}</span> : null}
              </button>
            );
          })}
        </div>
      </div>
      <dl className={styles.treeKey}>
        {used.filter((l) => GLOSS[l]).map((l) => (
          <div key={l} className={styles.treeKeyItem}>
            <dt className={styles.treeNode} data-label={l} data-kind="pre">{l}</dt>
            <dd>{vi ? GLOSS[l].vi : GLOSS[l].en}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
