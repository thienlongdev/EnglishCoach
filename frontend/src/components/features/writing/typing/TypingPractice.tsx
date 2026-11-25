'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { Keyboard, Clock3, RotateCcw, History, Gauge, Target, Timer, Rows3, ChevronDown, Trophy, ListChecks } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { TypingEngine, randomTypingText, type TypingSource } from '@/lib/writing/typing-engine';
import { readTypingHistory, readLegacyTypingHistory, saveTypingSummary, type TypingSummary, type LegacyTypingSummary } from '@/lib/writing/typing-history';
import { readTypingLines, saveTypingLines, type VisibleTypingLines } from '@/lib/writing/typing-preferences';
import { TypingSources } from './TypingSources';
import { TypingResults, formatTypingTime } from './TypingResults';
import styles from './typing.module.css';
import { WritingHero, glass } from '../glass/WritingGlass';

const durations = [30, 60, 120, 300, 0];
export function TypingPractice({ userId }: { userId: number }) {
  const { locale } = useLanguage(); const vi = locale === 'vi';
  const [source, setSource] = useState<TypingSource>('random');
  const [sourceRevision, setSourceRevision] = useState(0);
  const [duration, setDuration] = useState(60);
  const [lines, setLines] = useState<VisibleTypingLines>(2);
  const durationRef = useRef(duration); durationRef.current = duration;
  const [text, setText] = useState('');
  const [engine, setEngine] = useState(() => new TypingEngine('', 60, true));
  const [, render] = useState(0);
  const [focused, setFocused] = useState(false);
  const [notice, setNotice] = useState('');
  const [recent, setRecent] = useState<TypingSummary[]>([]);
  const [legacy, setLegacy] = useState<LegacyTypingSummary[]>([]);
  const history = [...recent, ...legacy].sort((a,b) => b.finishedAt - a.finishedAt).slice(0,20);
  const input = useRef<HTMLTextAreaElement>(null);
  const practice = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const caret = useRef<HTMLSpanElement>(null);
  const resultSurface = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const saved = useRef<TypingEngine | null>(null);
  const sessionId = useRef('');
  const reset = useCallback((target: string, seconds: number, infinite: boolean) => {
    setEngine(previous => { previous.abort(); return new TypingEngine(target, seconds, infinite); });
    sessionId.current = crypto.randomUUID(); setNotice('');
    if (input.current) input.current.value = '';
  }, []);
  useEffect(() => {
    const initial = randomTypingText(); setText(initial); reset(initial, 60, true);
    setRecent(readTypingHistory(userId));
    setLegacy(readLegacyTypingHistory(userId));
    setLines(readTypingLines());
  }, [userId, reset]);
  const refresh = useCallback(() => {
    if (engine.result && saved.current !== engine) {
      saved.current = engine;
      setRecent(saveTypingSummary(userId, { ...engine.result, id: sessionId.current, source, duration, finishedAt: Date.now() }));
    }
    render(x => x + 1);
  }, [engine, userId, source, duration]);
  useEffect(() => {
    return () => engine.abort();
  }, [engine]);
  useEffect(() => {
    if (engine.phase !== 'RUNNING') return;
    const timer = setInterval(() => { engine.tick(performance.now()); refresh(); }, 250);
    const unload = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    const visible = () => { engine.tick(performance.now()); refresh(); };
    window.addEventListener('beforeunload', unload); document.addEventListener('visibilitychange', visible);
    return () => { clearInterval(timer); window.removeEventListener('beforeunload', unload); document.removeEventListener('visibilitychange', visible); };
  }, [engine, engine.phase, refresh]);
  const chooseText = useCallback((target: string) => {
    setText(target); reset(target, durationRef.current, false);
  }, [reset]);
  const running = engine.phase === 'RUNNING';
  const finished = engine.phase === 'FINISHED';
  const metrics = engine.metrics();
  const wordIndex = Math.max(0, engine.words.findIndex(w => w.end >= engine.position));
  const firstWord = Math.max(0, Math.floor(wordIndex / 60) * 60 - 5);
  const visibleWords = engine.words.slice(firstWord, firstWord + 120);
  const firstPosition = firstWord === 0 ? 0 : visibleWords[0]?.start ?? 0;
  const lastPosition = engine.words[firstWord + visibleWords.length]?.start ?? engine.target.length;
  useLayoutEffect(() => {
    surface.current?.scrollTo({ top: 0, behavior: 'instant' });
    // A shorter practice after results must not inherit a clipped hero.
    const host = practice.current;
    const header = host?.closest('main')?.previousElementSibling;
    if (host && header) {
      const top = host.getBoundingClientRect().top;
      const headerBottom = header.getBoundingClientRect().bottom;
      if (top < headerBottom) {
        let scrollport = host.parentElement;
        while (scrollport && !(/auto|scroll/.test(getComputedStyle(scrollport).overflowY)
          && scrollport.scrollHeight > scrollport.clientHeight)) scrollport = scrollport.parentElement;
        (scrollport ?? document.scrollingElement)?.scrollBy({ top: top - headerBottom - 24, behavior: 'instant' });
      }
    }
  }, [engine]);
  const followCaret = useCallback(() => {
    const box = surface.current, current = caret.current;
    if (!box || !current) return;
    // Read just the active cell; move by lines, within this scrollport only.
    const line = parseFloat(getComputedStyle(box).lineHeight);
    const row = Math.max(0, Math.floor((current.offsetTop - 4) / line));
    const firstRow = Math.round(box.scrollTop / line);
    if (row < firstRow || row >= firstRow + lines) {
      const nextRow = row < firstRow ? row : row - lines + 1;
      box.scrollTo({ top: nextRow * line, behavior: 'instant' });
    }
  }, [lines]);
  useLayoutEffect(followCaret, [followCaret, engine, engine.position, firstPosition]);
  useEffect(() => {
    const box = surface.current;
    if (!box) return;
    // One scrollport observer handles rewrapping (sidebar, fonts and narrow screens).
    const observer = new ResizeObserver(followCaret);
    observer.observe(box);
    return () => observer.disconnect();
  }, [followCaret, engine, finished]);
  useEffect(() => { if (finished) resultSurface.current?.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true }); }, [finished]);
  const entry = (value: string) => { engine.enter(value, performance.now()); refresh(); };
  const changeSource = (next: TypingSource) => {
    const target = next === 'random' ? randomTypingText() : '';
    setSource(next); setText(target); reset(target, duration, next === 'random');
    setSourceRevision(x => x + 1);
  };
  const retry = () => { reset(text, duration, source === 'random'); requestAnimationFrame(() => input.current?.focus({ preventScroll: true })); };
  const newPractice = () => {
    if (source === 'random') { const target = randomTypingText(); setText(target); reset(target, duration, true); }
    else changeSource(source);
  };
  // Hero facts: this tab's own saved summaries (sessionStorage, account-scoped); nothing when there is no history.
  const bestWpm = history.length ? Math.max(...history.map(s => Math.round(s.wpm))) : null;
  const sourceLabels = vi ? ['Từ ngẫu nhiên','Từ bài Reading','Từ bài Writing'] : ['Random Words','From Reading','From Writing'];
  return <div ref={practice} className={`${glass.stack} pb-6`} data-testid="typing-practice">
    <WritingHero
      world="typing"
      titleId="typing-hero-title"
      eyebrow={vi ? 'Luyện gõ · Tốc độ và độ chính xác' : 'Typing · Speed and accuracy'}
      eyebrowIcon={<Keyboard aria-hidden="true" />}
      title={vi ? 'Luyện gõ' : 'English'}
      accent={vi ? 'tiếng Anh' : 'typing practice'}
      lead={vi ? 'Rèn tốc độ, nâng độ chính xác và tự tin hơn khi viết bài thi trên máy tính.' : 'Improve typing speed, accuracy, and confidence for computer-based exams.'}
      stats={history.length ? [
        { value: bestWpm, label: vi ? 'WPM cao nhất gần đây' : 'Best recent WPM', icon: <Trophy aria-hidden="true" /> },
        { value: history.length, label: vi ? 'Bài gần đây' : 'Recent sessions', icon: <ListChecks aria-hidden="true" /> },
      ] : []}
    />
    <section className={`${glass.panel} ${glass.console} min-w-0`} aria-labelledby="typing-console-title">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3"><h2 id="typing-console-title" className="text-base font-bold text-on-surface">{vi ? 'Bài luyện của bạn' : 'Your practice'}</h2><a href="#typing-history" className={`${glass.btn} ${glass.btnGhost} ${glass.btnSm}`}><History size={14} />{vi ? 'Gần đây' : 'Recent'}</a></div>
      <div className="space-y-5" hidden={finished}>
        <div role="tablist" data-guide="ty-source" aria-label={vi ? 'Nguồn bài luyện' : 'Practice source'} className={`${glass.seg} grid w-full grid-cols-3`}>
          {(['random','reading','writing'] as const).map((id, i) => <button key={id} role="tab" aria-selected={source === id} aria-controls="typing-source-panel" disabled={running} onClick={() => changeSource(id)} className={`${glass.segBtn} min-w-0 justify-center px-1 text-xs sm:text-sm`}>
            {sourceLabels[i]}
          </button>)}
        </div>
        <div id="typing-source-panel" role="tabpanel" aria-label={source === 'random' ? (vi ? 'Từ ngẫu nhiên' : 'Random Words') : source === 'reading' ? (vi ? 'Từ bài Reading' : 'From Reading') : (vi ? 'Từ bài Writing' : 'From Writing')}>
          {source !== 'random' && <fieldset disabled={running} className="min-w-0"><TypingSources key={`${userId}:${source}:${sourceRevision}`} source={source} vi={vi} onChoose={chooseText} /></fieldset>}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <div className="flex flex-wrap items-center gap-3"><span className="flex items-center gap-2 text-xs font-bold text-on-surface-variant"><Clock3 size={16} />{vi ? 'Thời gian' : 'Duration'}</span><div className={glass.seg} role="group" aria-label={vi ? 'Thời lượng luyện gõ' : 'Typing duration'}>{durations.map(d => <button key={d} aria-pressed={duration === d} disabled={running} onClick={() => { setDuration(d); reset(text, d, source === 'random'); }} className={`${glass.segBtn} px-3`}>{d === 0 ? (vi ? 'Không giới hạn' : 'Untimed') : d < 60 ? `${d}s` : `${d / 60}m`}</button>)}</div></div>
          <div className="flex flex-wrap items-center gap-3" role="group" aria-label={vi ? 'Số dòng' : 'Visible lines'}><span className="flex items-center gap-2 text-xs font-bold text-on-surface-variant"><Rows3 size={16} />{vi ? 'Số dòng' : 'Visible lines'}</span><div className={glass.seg}>{([2,3,4] as const).map(value => <button key={value} aria-pressed={lines === value} onMouseDown={e => e.preventDefault()} onClick={() => { setLines(value); saveTypingLines(value); }} className={`${glass.segBtn} px-3.5`}>{value}</button>)}</div></div>
        </div>
        <dl className={glass.readouts}>
          <div className={glass.readout} data-live={running || undefined}><Gauge size={20} className="shrink-0 text-primary" aria-hidden="true" /><div className="flex flex-col-reverse gap-1"><dt>{vi ? 'Tốc độ' : 'Speed'}</dt><dd className="tabular-nums">{Math.round(metrics.wpm)} <span className="text-xs font-semibold text-on-surface-variant">WPM</span></dd></div></div>
          <div className={glass.readout} data-live={running || undefined}><Target size={20} className="shrink-0 text-emerald-500" aria-hidden="true" /><div className="flex flex-col-reverse gap-1"><dt>{vi ? 'Chính xác' : 'Accuracy'}</dt><dd data-testid="typing-accuracy">{metrics.accuracy === null ? '—' : `${Math.round(metrics.accuracy)}%`}</dd></div></div>
          <div className={glass.readout} data-live={running || undefined}><Timer size={20} className="shrink-0 text-amber-500" aria-hidden="true" /><div className="flex flex-col-reverse gap-1"><dt>{duration ? (vi ? 'Còn lại' : 'Remaining') : (vi ? 'Đã trôi qua' : 'Elapsed')}</dt><dd data-testid="typing-clock">{formatTypingTime(duration ? Math.max(0, duration - engine.elapsed) : engine.elapsed)}</dd></div></div>
          <div className={`${glass.readout} justify-between`}><div className="flex flex-col gap-1 min-w-0"><span className="text-[0.68rem] font-bold uppercase tracking-[0.06em] text-on-surface-variant">{vi ? 'Trạng thái' : 'Status'}</span><span className="flex min-h-6 items-center gap-2 text-sm font-bold text-on-surface" data-testid="typing-status"><span className={glass.statusDot} data-state={running ? 'busy' : 'idle'} aria-hidden="true" />{running ? (vi ? 'Đang luyện gõ' : 'Typing in progress') : engine.phase === 'ABORTED' ? (vi ? 'Hãy bắt đầu lại' : 'Restart to continue') : (vi ? 'Sẵn sàng luyện gõ' : 'Ready to type')}</span></div><button onClick={retry} aria-label={vi ? 'Bắt đầu lại bài luyện' : 'Restart practice'} title={vi ? 'Bắt đầu lại' : 'Restart'} className={glass.iconBtn}><RotateCcw size={16} /></button></div>
        </dl>
        {text ? <div className={glass.typeStage}>
          <div ref={surface} className={`${styles.viewport} text-on-surface`} style={{ '--typing-lines': lines } as CSSProperties} tabIndex={0} role="region" aria-label={vi ? 'Nội dung luyện gõ' : 'Typing passage'} data-testid="typing-surface" onClick={() => input.current?.focus({ preventScroll: true })}>
            <div aria-hidden="true" className="pointer-events-none">
              {engine.target.slice(firstPosition, lastPosition).map((char, n) => {
                const i = n + firstPosition; const cell = engine.cells[i];
                const wrong = cell !== undefined && cell !== char;
                const state = wrong ? styles.wrong : cell === char ? (engine.historicalErrors.has(i) ? styles.corrected : styles.correct) : '';
                return <span key={i}>{engine.extras.get(i)?.map((extra, j) => <span key={j} className={styles.extra}>{/\s/u.test(extra) ? '␣' : extra}</span>)}<span ref={i === engine.position ? caret : undefined} data-current={i === engine.position || undefined} className={`${state} ${i === engine.position ? styles.current : ''}`} title={wrong ? (vi ? 'Ký tự sai hoặc thiếu' : 'Incorrect or missing character') : undefined}>{char === '\n' ? <>{i === engine.position || wrong ? '↵' : ''}{'\n'}</> : wrong && char === ' ' ? '␣' : char}</span></span>;
              })}
            </div>
          </div>
          <textarea ref={input} aria-label={vi ? 'Vùng nhập luyện gõ' : 'Typing input'} aria-describedby="typing-policy" className="absolute top-0 left-0 h-1 w-full resize-none opacity-0" autoCapitalize="off" autoComplete="off" autoCorrect="off" spellCheck={false} inputMode="text" onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
            onPaste={e => { e.preventDefault(); setNotice(vi ? 'Hãy gõ bằng bàn phím; không hỗ trợ dán nội dung.' : 'Please type using the keyboard; pasted text is blocked.'); }}
            onDrop={e => { e.preventDefault(); setNotice(vi ? 'Không hỗ trợ kéo thả nội dung.' : 'Dropped text is blocked.'); }}
            onDragOver={e => e.preventDefault()}
            onKeyDown={e => { if (composing.current || e.nativeEvent.isComposing) return; if (e.key === 'Backspace') { e.preventDefault(); engine.backspace(performance.now()); refresh(); } else if (e.key === 'Enter') { e.preventDefault(); entry('\n'); } }}
            onCompositionStart={() => { composing.current = true; }}
            onCompositionEnd={e => { composing.current = false; entry(e.data); e.currentTarget.value = ''; }}
            onChange={e => {
              const event = e.nativeEvent as InputEvent;
              if (composing.current || event.isComposing) return;
              if (/Composition/i.test(event.inputType ?? '')) { e.currentTarget.value = ''; return; }
              const value = e.currentTarget.value;
              if (!value) return;
              if (event.inputType && event.inputType !== 'insertText') {
                e.currentTarget.value = ''; setNotice(vi ? 'Chỉ nhận nội dung được gõ; hãy bắt đầu lại nếu dùng tự động điền.' : 'Only typed input is accepted; restart after automated insertion.'); return;
              }
              if (Array.from(value).length > 8) { engine.abort(); setNotice(vi ? 'Nội dung nhập quá dài. Hãy bắt đầu lại và gõ bằng bàn phím.' : 'Bulk input detected. Restart and type using the keyboard.'); refresh(); }
              else entry(value);
              e.currentTarget.value = '';
            }} />
          <button className={`mt-3 ${glass.btn} ${glass.btnGhost} ${glass.btnSm}`} onClick={() => input.current?.focus({ preventScroll: true })}><Keyboard size={14} aria-hidden="true" />{focused ? (vi ? 'Backspace để sửa' : 'Backspace to correct') : (vi ? 'Nhấp để gõ' : 'Click to type')}</button>
          <span className="sr-only" role="status">{vi ? 'Ký tự tiếp theo' : 'Next character'}: {engine.target[engine.position] === ' ' ? (vi ? 'dấu cách' : 'space') : engine.target[engine.position] === '\n' ? (vi ? 'xuống dòng' : 'newline') : engine.target[engine.position]}</span>
        </div> : <p className={`${glass.well} p-6 text-center text-sm text-on-surface-variant`}>{vi ? 'Chọn nội dung tiếng Anh ở trên để bắt đầu.' : 'Choose English content above to begin.'}</p>}
        {notice && <p role="alert" className={`${glass.verdict} text-sm`} data-v="bad">{notice}</p>}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p id="typing-policy" className="text-xs text-on-surface-variant">{vi ? 'Gõ đúng cả hoa/thường và dấu câu. Backspace để sửa. Đổi tab sẽ bỏ bài đang gõ.' : 'Match case and punctuation. Backspace to correct. Changing tabs discards this practice.'}</p>
          <div className={glass.legend} aria-label={vi ? 'Chú giải ký tự' : 'Character legend'}><span className={styles.correct}>{vi ? 'Đúng' : 'Correct'}</span><span className={styles.wrong}>{vi ? 'Sai' : 'Incorrect'}</span><span className={styles.corrected}>{vi ? 'Đã sửa' : 'Corrected'}</span><span className={styles.current}>{vi ? 'Ký tự hiện tại' : 'Current character'}</span></div>
        </div>
      </div>{finished && <div ref={resultSurface}><p className="sr-only" data-testid="typing-status">{vi ? 'Đã hoàn thành' : 'Completed'}</p><TypingResults engine={engine} vi={vi} onRetry={retry} onNew={newPractice} onBack={() => changeSource(source)} /></div>}
    </section>
    <details id="typing-history" className={`${glass.panel} ${glass.details} p-4 sm:p-5`}>
      <summary className="flex cursor-pointer items-center justify-between gap-3 text-sm font-bold text-on-surface"><span className="flex items-center gap-2"><History size={16} className="text-primary" aria-hidden="true" />{vi ? 'Bài luyện gần đây' : 'Recent practice'} <span className={glass.chip}>{history.length}</span></span><ChevronDown size={18} className={glass.chev} aria-hidden="true" /></summary>
      <p className="my-3 text-xs text-on-surface-variant">{vi ? '20 kết quả gần nhất trong tab này; xóa khi đăng xuất. Kết quả cũ ghi rõ độ chính xác theo lượt gõ. Không lưu nội dung bài.' : '20 recent summaries in this tab, cleared on logout. Older results are labelled with keystroke accuracy. Passage text is never stored.'}</p>
      {history.length ? <div className="overflow-x-auto"><table className={glass.historyTable}><thead><tr>{(vi ? ['Ngày','Nguồn','WPM','Chính xác','Thời gian'] : ['Date','Source','WPM','Accuracy','Time']).map(x => <th key={x}>{x}</th>)}</tr></thead><tbody>{history.map(s => <tr key={s.id}><td>{new Date(s.finishedAt).toLocaleString(vi ? 'vi-VN' : 'en-GB', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td><td>{s.source === 'random' ? (vi ? 'Từ ngẫu nhiên' : 'Random Words') : s.source === 'reading' ? 'Reading' : 'Writing'}</td><td className="font-bold text-primary tabular-nums">{Math.round(s.wpm)}</td><td className="tabular-nums">{s.accuracy === null ? '—' : `${Math.round(s.accuracy)}%`}{!('evaluatedWords' in s) && <span className="ml-1 text-[10px]">({vi ? 'lượt gõ cũ' : 'legacy keystrokes'})</span>}</td><td className="tabular-nums">{formatTypingTime(s.seconds)}</td></tr>)}</tbody></table></div> : <p className="text-xs text-on-surface-variant">{vi ? 'Hoàn thành bài luyện đầu tiên để xem kết quả ở đây.' : 'Finish your first practice to see a summary here.'}</p>}
    </details>
  </div>;
}
