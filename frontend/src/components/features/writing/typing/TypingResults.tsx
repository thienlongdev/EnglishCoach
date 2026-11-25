'use client';
import { useState } from 'react';
import { AlertCircle, RotateCcw, ArrowLeft, Shuffle } from 'lucide-react';
import type { TypingEngine, TypingSample } from '@/lib/writing/typing-engine';
import styles from './typing.module.css';
import { glass } from '../glass/WritingGlass';

export const formatTypingTime = (seconds: number) => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
export const speedTier = (wpm: number | null) => wpm === null ? styles.neutral : [styles.tier0, styles.tier1, styles.tier2, styles.tier3, styles.tier4, styles.tier5][wpm < 40 ? 0 : wpm < 60 ? 1 : wpm < 80 ? 2 : wpm < 100 ? 3 : wpm <= 120 ? 4 : 5];
function SpeedChart({ samples, vi }: { samples: TypingSample[]; vi: boolean }) {
  const [selected, setSelected] = useState<number | null>(null);
  const maxTime = Math.max(1, samples.at(-1)?.seconds ?? 1);
  const maxSpeed = Math.max(20, Math.ceil(Math.max(...samples.map(s => Math.max(s.wpm, s.raw))) / 20) * 20);
  const x = (s: TypingSample) => 48 + s.seconds / maxTime * 742;
  const y = (n: number) => 200 - n / maxSpeed * 165;
  const path = (field: 'wpm' | 'raw') => samples.map((s, i) => `${i ? 'L' : 'M'}${x(s).toFixed(2)},${y(s[field]).toFixed(2)}`).join(' ');
  const point = selected === null ? null : samples[selected];
  return <div className={`${glass.chartWell} space-y-2`}>
    <h3 className="text-sm font-bold text-on-surface">{vi ? 'Tốc độ theo thời gian' : 'Speed over time'}</h3>
    <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-on-surface-variant"><span className="text-primary">━ WPM</span><span>┄ {vi ? 'Tốc độ thô' : 'Raw WPM'}</span><span className={styles.errorText}>● {vi ? 'Lỗi' : 'Errors'}</span><span className={styles.correctionText}>○ {vi ? 'Sửa' : 'Corrections'}</span></div>
    <svg className="w-full text-on-surface-variant" viewBox="0 0 820 235" role="img" aria-label={vi ? 'Biểu đồ WPM và tốc độ thô, với các mốc lỗi và sửa lỗi' : 'WPM and raw speed chart with error and correction markers'} onMouseMove={e => {
      const rect = e.currentTarget.getBoundingClientRect(); const seconds = Math.max(0, Math.min(maxTime, ((e.clientX - rect.left) / rect.width * 820 - 48) / 742 * maxTime));
      setSelected(samples.reduce((best, s, i) => Math.abs(s.seconds - seconds) < Math.abs(samples[best].seconds - seconds) ? i : best, 0));
    }} onMouseLeave={() => setSelected(null)}>
      {[0, 1, 2, 3, 4].map(i => <g key={i}><line x1="48" x2="790" y1={y(maxSpeed * i / 4)} y2={y(maxSpeed * i / 4)} stroke="currentColor" opacity=".15" strokeDasharray="3 4" /><text x="38" y={y(maxSpeed * i / 4) + 4} textAnchor="end" fontSize="11" fill="currentColor">{Math.round(maxSpeed * i / 4)}</text><text x={48 + i / 4 * 742} y="223" fontSize="11" textAnchor="middle" fill="currentColor">{Math.round(maxTime * i / 4)}s</text></g>)}
      <path d={path('raw')} fill="none" stroke="currentColor" strokeWidth="1.5" opacity=".35" />
      <defs><linearGradient id="typing-wpm-line" x1="48" x2="790" y1="0" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" style={{ stopColor: "var(--w1)" }} /><stop offset="1" style={{ stopColor: "var(--w2)" }} /></linearGradient></defs>
      <path d={path('wpm')} fill="none" stroke="url(#typing-wpm-line)" strokeWidth="2.75" strokeLinejoin="round" strokeLinecap="round" />
      {samples.map((s, i) => <g key={i}>{s.errors > 0 && <circle cx={x(s)} cy={y(s.wpm)} r="4" className={styles.errorDot}><title>{formatTypingTime(s.seconds)} · {s.errors} {vi ? 'lỗi' : 'errors'}</title></circle>}{s.corrections > 0 && <circle cx={x(s)} cy={y(s.raw)} r="4" className={styles.correctionDot}><title>{formatTypingTime(s.seconds)} · {s.corrections} {vi ? 'sửa' : 'corrections'}</title></circle>}</g>)}
      {point && <g><line x1={x(point)} x2={x(point)} y1="25" y2="200" stroke="currentColor" opacity=".3" /><circle cx={x(point)} cy={y(point.wpm)} r="5" className="fill-primary" /></g>}
    </svg>
    <label className="flex flex-wrap items-center gap-3 text-xs text-on-surface-variant"><span>{vi ? 'Khám phá biểu đồ' : 'Explore the chart'}</span><input type="range" className="min-w-0 flex-1 accent-primary" min="0" max={Math.max(0, samples.length - 1)} value={selected ?? Math.max(0, samples.length - 1)} onChange={e => setSelected(Number(e.target.value))} aria-label={vi ? 'Mốc thời gian biểu đồ' : 'Chart time sample'} /></label>
    <p className="min-h-5 text-xs text-on-surface-variant" aria-live="polite">{point ? `${formatTypingTime(point.seconds)} · ${Math.round(point.wpm)} WPM · ${Math.round(point.raw)} ${vi ? 'thô' : 'raw'} · ${point.errors} ${vi ? 'lỗi' : 'errors'} · ${point.corrections} ${vi ? 'sửa' : 'corrections'}` : (vi ? 'Di chuột hoặc dùng thanh trượt để xem từng mốc.' : 'Hover or use the slider to inspect each sample.')}</p>
  </div>;
}
export function TypingResults({ engine, vi, onRetry, onNew, onBack }: { engine: TypingEngine; vi: boolean; onRetry: () => void; onNew: () => void; onBack: () => void }) {
  const m = engine.result!;
  return <section className="space-y-6" aria-label={vi ? 'Kết quả luyện gõ' : 'Typing results'} data-testid="typing-results">
    <div className={glass.resultHead}>
      <div className="space-y-2"><span className={`${glass.chip} ${glass.chipInk}`}>{vi ? 'Đã hoàn thành · Luyện tập cá nhân' : 'Completed · Personal practice'}</span><h2 className="text-2xl font-bold tracking-tight text-on-surface" tabIndex={-1}>{vi ? 'Kết quả luyện gõ' : 'Your typing results'}</h2></div>
      <div className={glass.bigStats}>
        <div className={glass.bigStat}><p>{vi ? 'Tốc độ' : 'Speed'}</p><p>{Math.round(m.wpm)}<small>wpm</small></p></div>
        <div className={glass.bigStat} data-tone="acc"><p>{vi ? 'Độ chính xác' : 'Accuracy'}</p><p>{m.accuracy === null ? '—' : Math.round(m.accuracy)}<small>%</small></p></div>
      </div>
    </div>
    {m.inactive && <p className={`${glass.verdict} text-sm`} data-v="warn" role="status"><AlertCircle size={18} className="shrink-0" />{vi ? 'Phát hiện khoảng thời gian ngừng gõ khá lâu trong bài luyện (từ 15 giây).' : 'Extended inactivity detected during this session (15 seconds or more).'}</p>}
    <dl className={glass.metricGrid}>
      {[[vi ? 'Tốc độ thô' : 'Raw WPM', Math.round(m.raw)], [vi ? 'Đúng' : 'Correct', m.correct], [vi ? 'Sai còn lại' : 'Remaining errors', m.incorrect], [vi ? 'Thời gian' : 'Time', formatTypingTime(m.seconds)], [vi ? 'Ổn định' : 'Consistency', m.consistency === null ? '—' : `${Math.round(m.consistency)}%`], [vi ? 'Sửa (Backspace)' : 'Corrections', m.corrections], [vi ? 'Lượt gõ sai' : 'Error entries', m.errors], [vi ? 'Lỗi đã sửa' : 'Corrected mistakes', m.correctedErrors], [vi ? 'Từ đúng / đã gõ' : 'Correct / attempted words', `${m.correctWords} / ${m.evaluatedWords}`], [vi ? 'Từ chưa xong' : 'Incomplete words', m.incompleteWords], [vi ? 'Hoàn thành' : 'Completion', `${Math.round(m.completion)}%`]].map(([label, value]) => <div key={label} className={glass.metric}><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl>
    <div className="space-y-3">
      <h3 className="text-sm font-bold text-on-surface">{vi ? 'Bản xem lại theo từng từ' : 'Word-by-word review'}</h3>
      <div className="flex flex-wrap gap-3 text-xs font-semibold" aria-label={vi ? 'Chú giải tốc độ từng từ' : 'Word speed legend'}>{['0–40','40–60','60–80','80–100','100–120','121+'].map((s, i) => <span key={s} className={speedTier(i * 20 + 30)}>{s} WPM</span>)}</div>
      <div className={`${glass.well} max-h-48 overflow-auto p-4 text-lg leading-loose [overflow-wrap:anywhere] whitespace-pre-wrap`} tabIndex={0} aria-label={vi ? 'Bản xem lại: gạch liền là lỗi còn lại, gạch chấm là lỗi đã sửa' : 'Review: solid underlines mark remaining errors; dotted underlines mark corrected errors'}>
        {engine.words.filter(w => engine.wordEvaluation(w).attempted).map(w => <span key={w.start} className={speedTier(engine.wordSpeed(w))}>
          {Array.from({ length: Math.min(w.end, Math.max(engine.position, w.start + (engine.extras.has(w.start) ? 1 : 0))) - w.start }, (_, j) => {
            const i = w.start + j; const wrong = engine.cells[i] !== engine.target[i] && engine.cells[i] !== undefined;
            return <span key={i}>{engine.extras.get(i)?.map((c, n) => <span key={`extra${n}`} className={styles.reviewError} title={vi ? 'Ký tự thừa' : 'Extra character'}>{c === ' ' ? '␣' : c}</span>)}<span className={wrong ? styles.reviewError : engine.cells[i] === engine.target[i] && engine.historicalErrors.has(i) ? styles.reviewCorrected : undefined} title={wrong ? (vi ? 'Sai hoặc thiếu ký tự' : 'Incorrect or missing character') : engine.cells[i] === engine.target[i] && engine.historicalErrors.has(i) ? (vi ? 'Lỗi đã sửa' : 'Corrected error') : undefined}>{engine.target[i]}</span></span>;
          })}
          {!engine.wordEvaluation(w).complete && <span className={styles.neutral} title={vi ? 'Từ chưa hoàn tất' : 'Incomplete word'}>…</span>}
          {Array.from({ length: Math.max(0, Math.min(engine.words[engine.words.indexOf(w) + 1]?.start ?? engine.target.length, engine.position + (engine.extras.has(engine.position) ? 1 : 0)) - w.end) }, (_, j) => {
            const i = w.end + j;
            return <span key={`separator${i}`}>{engine.extras.get(i)?.map((c, n) => <span key={n} className={styles.reviewError}>{/\s/u.test(c) ? '␣' : c}</span>)}{engine.cells[i] !== undefined && <span className={engine.cells[i] !== engine.target[i] ? styles.reviewError : undefined}>{engine.target[i]}</span>}</span>;
          })}
        </span>)}
      </div>
      <p className="text-xs text-on-surface-variant">{vi ? 'Màu thể hiện tốc độ từng từ. Gạch liền: sai/thiếu/thừa; gạch chấm: lỗi đã sửa. Từ chưa đủ mẫu có màu trung tính.' : 'Color shows word speed. Solid underline: wrong/missing/extra; dotted underline: corrected. Unreliable word samples stay neutral.'}</p>
    </div>
    <SpeedChart samples={engine.samples} vi={vi} />
    <details className="text-xs text-on-surface-variant"><summary className="cursor-pointer">{vi ? 'Cách tính kết quả' : 'How scoring works'}</summary><p className="mt-2 leading-relaxed">{vi ? 'WPM = số ký tự đúng còn lại ÷ 5 ÷ phút thực tế. Tốc độ thô đếm mọi lần nhập, kể cả gõ lại. Độ chính xác = từ đúng ÷ từ đã gõ. Từ đã sửa hoàn toàn được tính đúng; từ đã thử nhưng chưa hoàn tất (kể cả đã xóa) tính sai một lần. Từ chưa gõ không tính; chưa có từ thì hiển thị —. Lỗi lịch sử và Backspace được đếm riêng. Ổn định dựa trên biến động tốc độ thô ở cửa sổ 5 giây (cần ít nhất hai mẫu). Tốc độ từ dùng ký tự mục tiêu và thời gian từ lần gõ đầu đến cuối, tối thiểu 250 ms; lần sửa cũng tính thời gian. Thời gian ngừng gõ vẫn tính.' : 'WPM = remaining correct characters ÷ 5 ÷ real minutes. Raw WPM counts all character entries, including retyping. Accuracy = correct words ÷ attempted words. Fully corrected words are correct; attempted incomplete words (including erased attempts) count once as incorrect. Untouched words are excluded; no attempted words shows —. Historical errors and Backspaces are separate. Consistency uses raw-speed variation over five-second windows (at least two samples). Word speed uses target characters and first-to-last entry time, at least 250 ms, including correction time. Idle time counts.'}</p></details>
    <div className="flex flex-wrap gap-3"><button onClick={onRetry} className={`${glass.btn} ${glass.btnPrimary}`}><RotateCcw size={16} />{vi ? 'Gõ lại' : 'Retry'}</button><button onClick={onNew} className={`${glass.btn} ${glass.btnSoft}`}><Shuffle size={16} />{vi ? 'Bài luyện mới' : 'New practice'}</button><button onClick={onBack} className={`${glass.btn} ${glass.btnGhost}`}><ArrowLeft size={16} />{vi ? 'Chọn bài luyện' : 'Practice selection'}</button></div>
  </section>;
}
