'use client';
import { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Check, RotateCcw, ArrowRight, Crown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { KingShell } from './KingShell';
import { localContent } from './sampleBank';
import { shuffledTokenIds, startSession, transitionSession } from './domain';
import type { SoloAction } from './domain';

export default function ReorderSolo({ vi, onQuit }: { vi: boolean; onQuit: () => void }) {
  const [state, setState] = useState(() => startSession(localContent, Date.now()));
  const reduced = useReducedMotion(); const heading = useRef<HTMLHeadingElement>(null); const next = useRef<HTMLButtonElement>(null);
  const item = localContent.get(state.challengeIds[state.index]);
  const settled = state.feedback === 'CORRECT' || state.feedback === 'REVEALED';
  // No timer/listener/subscription/cache. State retains five IDs and current token indexes only.
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [state.index, state.status]);
  useEffect(() => { if (settled) next.current?.focus({ preventScroll: true }); }, [settled]);
  const send = (action: SoloAction) => { if (item) setState(previous => transitionSession(previous, action, item)); };
  const restart = () => { setState(previous => startSession(localContent, previous.seed + 1)); heading.current?.focus({ preventScroll: true }); };
  if (state.status === 'FINISHED') return <KingShell vi={vi} onQuit={onQuit} score={state.score} progress={`${state.results.length}/${state.challengeIds.length}`}>
    <section className="mx-auto max-w-2xl py-8 text-center"><Crown className="mx-auto mb-5 h-12 w-12 text-amber-600 dark:text-amber-300" aria-hidden="true" />
      <h2 ref={heading} tabIndex={-1} className="text-3xl font-bold">{vi ? 'Hoàn thành phiên luyện' : 'Practice complete'}</h2><p className="mt-4 text-on-surface-variant">{vi ? 'Câu ghép đúng' : 'Sentences solved'}: {state.results.filter(result => result.correct).length}/{state.results.length}</p>
      <p className="mt-2 text-sm text-on-surface-variant">{vi ? 'Điểm cục bộ, không được lưu vào tiến độ học tập hay bảng xếp hạng.' : 'Local score, not saved to learning progress or leaderboards.'}</p>
      <div className="mt-8 flex flex-wrap justify-center gap-3"><Button type="button" onClick={restart} className="min-h-12 px-5"><RotateCcw />{vi ? 'Luyện lại' : 'Restart'}</Button><Button type="button" variant="outline" onClick={onQuit} className="min-h-12 px-5">{vi ? 'Về sảnh King' : 'King lobby'}</Button></div>
      <ol className="mt-8 space-y-3 text-left">{state.results.map(result => { const reviewed = localContent.get(result.challengeId)!; return <li key={result.challengeId} className="border-b border-outline-variant/50 pb-3"><p className="font-semibold">{result.correct ? (vi ? 'Đúng' : 'Correct') : (vi ? 'Đã xem đáp án' : 'Answer revealed')} · {reviewed.canonicalAnswer}</p><p className="mt-1 text-sm text-on-surface-variant">{reviewed.explanation[vi ? 'vi' : 'en']}</p></li>; })}</ol>
    </section>
  </KingShell>;
  if (!item) return <KingShell vi={vi} onQuit={onQuit}><p role="alert">{vi ? 'Chưa tải được câu luyện. Về sảnh để thử lại.' : 'Challenge unavailable. Return to the lobby and retry.'}</p></KingShell>;
  const order = shuffledTokenIds(item, state.seed, state.index);
  const token = (id: number, placed: boolean) => <motion.button type="button" key={id} layout={!reduced} initial={false}
    whileTap={reduced ? undefined : { scale: .97 }} transition={{ type: 'spring', stiffness: 420, damping: 32 }}
    disabled={settled} onClick={() => send({ type: placed ? 'UNDO' : 'PLACE', token: id })}
    aria-label={`${placed ? (vi ? 'Bỏ' : 'Remove') : (vi ? 'Đặt' : 'Place')} ${item.tokens[id]}`}
    className={`min-h-12 min-w-12 max-w-full break-words rounded-lg border px-4 py-3 text-base font-semibold shadow-sm ${placed ? 'border-primary/60 bg-primary/10 text-on-surface' : 'border-outline-variant bg-surface-container-lowest text-on-surface hover:border-primary'} disabled:opacity-70`}>{item.tokens[id]}</motion.button>;
  return <KingShell vi={vi} onQuit={onQuit} score={state.score} progress={`${state.index + 1}/${state.challengeIds.length}`}>
    <section className="mx-auto w-full min-w-0 max-w-4xl py-3 sm:py-6" aria-labelledby="reorder-heading">
      <p className="mb-3 text-xs font-semibold uppercase tracking-[.2em] text-on-surface-variant">{vi ? 'Xâu chuỗi / Tự luyện' : 'Reorder / Solo'} · {item.cefr}</p>
      <h2 ref={heading} id="reorder-heading" tabIndex={-1} className="text-2xl font-bold sm:text-3xl">{vi ? 'Ghép các mảnh thành một câu.' : 'Build a sentence, piece by piece.'}</h2>
      <p className="mt-3 text-on-surface-variant">{vi ? item.meaning.vi : 'Use every tile once. Sentence punctuation is optional.'}</p>
      <div className="mt-8 min-h-32 border-b-2 border-primary/40 py-5" role="group" aria-label={vi ? 'Câu của bạn' : 'Your sentence'}>
        <div className="flex flex-wrap gap-2">{state.selected.map(id => token(id, true))}</div>
        {!state.selected.length && <p className="py-4 text-sm text-on-surface-variant">{vi ? 'Chạm một mảnh từ bên dưới để bắt đầu.' : 'Tap a word tile below to begin.'}</p>}
      </div>
      <div className="mt-6 flex min-h-28 flex-wrap content-start gap-2" role="group" aria-label={vi ? 'Mảnh từ có sẵn' : 'Available tiles'}>{order.filter(id => !state.selected.includes(id)).map(id => token(id, false))}</div>
      <p className="mt-3 text-xs text-on-surface-variant">{vi ? 'Chạm mảnh đã đặt để bỏ. Dùng Tab và Enter hoặc Space với bàn phím.' : 'Tap a placed tile to undo. Use Tab and Enter or Space on a keyboard.'}</p>
      <div role="status" aria-live="polite" aria-atomic="true" className="my-6 min-h-16 text-sm leading-relaxed">
        {state.feedback === 'WRONG' && <p className="text-amber-800 dark:text-amber-200">{vi ? 'Thứ tự này chưa đúng. Thử ghép lại nhé.' : 'This order is not accepted. Try rearranging the tiles.'} {item.explanation[vi ? 'vi' : 'en']}</p>}
        {settled && <><p className="flex items-center gap-2 font-semibold">{state.feedback === 'CORRECT' ? <><Check className="h-4 w-4 text-primary" />{vi ? 'Đúng rồi! +10 điểm' : 'Correct! +10 points'}</> : (vi ? 'Cùng xem cách ghép câu.' : 'Review how the sentence fits.')}</p><p className="mt-2 font-semibold">{item.canonicalAnswer}</p><p className="mt-1 text-on-surface-variant">{item.explanation[vi ? 'vi' : 'en']}</p></>}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-outline-variant/50 pt-5">
        <Button type="button" variant="ghost" disabled={settled || !state.selected.length} onClick={() => send({ type: 'CLEAR' })} className="min-h-12 px-4"><RotateCcw />{vi ? 'Xóa câu' : 'Clear'}</Button>
        <div className="flex flex-wrap gap-3">{!settled && <Button type="button" variant="outline" onClick={() => send({ type: 'REVEAL' })} className="min-h-12 px-4">{vi ? 'Xem đáp án' : 'Reveal answer'}</Button>}
          {settled ? <Button ref={next} type="button" onClick={() => send({ type: 'NEXT' })} className="min-h-12 px-5">{state.index + 1 === state.challengeIds.length ? (vi ? 'Xem kết quả' : 'View result') : (vi ? 'Câu tiếp theo' : 'Next challenge')}<ArrowRight /></Button>
            : <Button type="button" disabled={state.selected.length !== item.tokens.length} onClick={() => send({ type: 'SUBMIT' })} className="min-h-12 px-5">{vi ? 'Kiểm tra' : 'Check answer'}<Check /></Button>}
        </div>
      </div>
    </section>
  </KingShell>;
}
