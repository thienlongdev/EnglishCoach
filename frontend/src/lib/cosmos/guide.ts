/**
 * Cosmos Learning Guide — what to do next, read only from the learner's own evidence (pure function, no AI, no request).
 * Every recommendation names its evidence (why) and leads to a real action of an existing module; one that cannot lead
 * anywhere useful is not produced. Nothing here predicts memory: "due" is the Flashcards scheduler's own stored date
 * (Memory Tides is the authority), "hard" is the learner's own rating, "fading" is elapsed time since the last evidence.
 */
import { memoryOf } from './memory';
import { missionCandidates } from './missions';
import type { CosmosGraph, CosmosNode } from './types';

export type GuideAction =
  | { kind: 'link'; href: string; label: [string, string] }
  | { kind: 'focus'; node: number; label: [string, string] }
  | { kind: 'constellation'; constellation: number; label: [string, string] }
  | { kind: 'discover'; node: number; label: [string, string] }
  | { kind: 'mission'; node: number; target: 'WRITING'; label: [string, string] };

export interface GuideItem {
  id: string;
  kind: 'due' | 'hard' | 'grammar' | 'saved' | 'fading' | 'expand';
  title: [string, string];
  why: [string, string];
  /** The stars it is about (focus chips), most urgent first, at most 3. */
  nodes: number[];
  primary: GuideAction;
  secondary?: GuideAction;
}

const list = (g: CosmosGraph, idx: number[], max = 3) => idx.slice(0, max).map(i => g.nodes[i].kind === 'grammar' ? g.nodes[i].sub || g.nodes[i].label : g.nodes[i].label).join(', ') + (idx.length > max ? '…' : '');
const isCardWord = (n: CosmosNode) => n.kind === 'word' && n.cardIds.length > 0;
const day = (t: number, vi: boolean) => new Date(t).toLocaleDateString(vi ? 'vi-VN' : 'en-GB', { day: 'numeric', month: 'numeric' });

/** At most `max` recommendations, in priority order. `now` = the moment the evidence was read. */
export function learningGuide(g: CosmosGraph, now = g.generatedAt, max = 3): GuideItem[] {
  const out: GuideItem[] = [];
  const words = g.nodes.filter(isCardWord);
  const mem = new Map(words.map(n => [n.i, memoryOf(n, now)]));

  // 1. Due by the Flashcards scheduler (studied, not mastered, next review stored and passed): the oldest first.
  const due = words.filter(n => n.dueAt > 0 && n.dueAt <= now && n.stage !== 'saved').sort((a, b) => a.dueAt - b.dueAt).map(n => n.i);
  if (due.length) {
    const first = g.nodes[due[0]].dueAt;
    out.push({ id: 'due', kind: 'due', nodes: due.slice(0, 3),
      title: [`Hôm nay nên củng cố ${due.length} ngôi sao`, `Strengthen ${due.length} star${due.length > 1 ? 's' : ''} today`],
      why: [`Lịch ôn của Thẻ từ vựng đã đến hạn (sớm nhất từ ${day(first, true)}): ${list(g, due)}.`, `Your Flashcards schedule says they are due (earliest since ${day(first, false)}): ${list(g, due)}.`],
      primary: { kind: 'link', href: '/flashcards?review=learned', label: ['Ôn ngay', 'Review now'] } });
  }

  // 2. Repeatedly hard: the constellation holding most stars whose latest own rating was "Khó" (≥ 2 of them).
  const hard = words.filter(n => { const s = mem.get(n.i)!.state; return s === 'weak' || s === 'mistaken'; });
  const byCons = new Map<number, number[]>();
  for (const n of hard) if (n.constellation >= 0) byCons.set(n.constellation, [...(byCons.get(n.constellation) ?? []), n.i]);
  const worst = [...byCons.entries()].filter(([, v]) => v.length >= 2).sort((a, b) => b[1].length - a[1].length)[0];
  if (worst) {
    const c = g.constellations[worst[0]];
    out.push({ id: `hard:${c.key}`, kind: 'hard', nodes: worst[1].slice(0, 3),
      title: [`Bạn thường gặp khó với nhóm "${c.vi}"`, `The "${c.en}" group is often hard for you`],
      why: [`Lần ôn gần nhất bạn tự chọn Khó cho ${worst[1].length} từ: ${list(g, worst[1])}. Đây là đánh giá của bạn, không phải lỗi được chấm.`, `Your own latest rating was Hard for ${worst[1].length} words: ${list(g, worst[1])}. Your own rating, not a graded error.`],
      primary: { kind: 'link', href: '/flashcards?review=learned', label: ['Ôn nhóm này', 'Review them'] },
      secondary: { kind: 'constellation', constellation: c.i, label: ['Xem chòm sao', 'Show the group'] } });
  }

  // 3. Grammar topics the Academy marked for review.
  const grammar = g.nodes.filter(n => n.kind === 'grammar' && n.weak).map(n => n.i);
  if (grammar.length) {
    const n = g.nodes[grammar[0]];
    out.push({ id: `grammar:${n.ref}`, kind: 'grammar', nodes: grammar.slice(0, 3),
      title: ['Chủ điểm ngữ pháp cần ôn lại', 'A grammar topic needs review'],
      why: [`Grammar Academy ghi nhận cần ôn lại: ${list(g, grammar)}.`, `Grammar Academy marked it for review: ${list(g, grammar)}.`],
      primary: { kind: 'link', href: `/grammar/topics/${encodeURIComponent(n.ref)}`, label: ['Mở chủ điểm', 'Open topic'] } });
  }

  // 4. Saved but never reviewed (own cards): the scheduler holds them as due; nothing is claimed about them yet.
  const saved = words.filter(n => n.stage === 'saved').sort((a, b) => b.discoveredAt - a.discoveredAt).map(n => n.i);
  if (saved.length) out.push({ id: 'saved', kind: 'saved', nodes: saved.slice(0, 3),
    title: [`${saved.length} thẻ đã lưu nhưng chưa ôn lần nào`, `${saved.length} saved card${saved.length > 1 ? 's' : ''} never reviewed`],
    why: [`Bạn đã lưu ${list(g, saved)} nhưng chưa có lần ôn nào được ghi nhận.`, `You saved ${list(g, saved)} but no review is recorded yet.`],
    primary: { kind: 'link', href: '/flashcards?review=due', label: ['Học lần đầu', 'First study'] } });

  // 5. Fading and not due: no evidence for 30+ days. The action is a cross-skill mission (completed only by server evidence).
  const writable = new Set(missionCandidates(g, 'WRITING', 400));
  const fading = words.filter(n => { const m = mem.get(n.i)!; return (m.state === 'fading' || m.state === 'atRisk') && !(n.dueAt > 0 && n.dueAt <= now) && writable.has(n.i); })
    .sort((a, b) => mem.get(a.i)!.lastAt - mem.get(b.i)!.lastAt).map(n => n.i);
  if (fading.length) {
    const n = g.nodes[fading[0]], days = Math.round((now - mem.get(n.i)!.lastAt) / 86_400_000);
    out.push({ id: `fading:${n.id}`, kind: 'fading', nodes: fading.slice(0, 3),
      title: [`"${n.label}" đang mờ dần`, `"${n.label}" is fading`],
      why: [`Không có bằng chứng mới trong ${days} ngày. Dùng lại từ trong một bài viết là cách gặp lại nó ở kỹ năng khác.`, `No new evidence for ${days} days. Using it in a piece of writing meets it again in another skill.`],
      primary: { kind: 'mission', node: n.i, target: 'WRITING', label: ['Nhận nhiệm vụ Viết', 'Start a writing mission'] },
      secondary: { kind: 'focus', node: n.i, label: ['Xem ngôi sao', 'Show the star'] } });
  }

  // 6. Expand: the studied word with the most verified, unlearned WordNet neighbours (the inspector offers "Lưu Flashcard").
  const grow = words.filter(n => n.frontier.length >= 2 && n.stage !== 'saved').sort((a, b) => b.frontier.length - a.frontier.length || b.ratings.length - a.ratings.length)[0];
  if (grow) {
    const c = g.constellations[grow.constellation];
    const names = grow.frontier.slice(0, 3).map(f => f.lemma).join(', ');
    out.push({ id: `expand:${grow.id}`, kind: 'expand', nodes: [grow.i],
      title: [`Mở rộng chòm sao${c ? ` "${c.vi}"` : ''}`, `Grow the${c ? ` "${c.en}"` : ''} group`],
      why: [`WordNet nối "${grow.label}" với ${names} — những từ bạn chưa học.`, `WordNet links "${grow.label}" to ${names} — words you have not learned.`],
      primary: { kind: 'discover', node: grow.i, label: ['Xem từ liên quan', 'See related words'] } });
  }
  return out.slice(0, max);
}
