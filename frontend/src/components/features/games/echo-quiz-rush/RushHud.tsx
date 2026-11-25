'use client';

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, Crown, Eye, Gauge, MoveVertical, PersonStanding, ShieldCheck, TriangleAlert, X } from 'lucide-react';
import type { RushQuestion } from '@/types/quizRush';
import type { SceneHud } from './RushScene';
import { LANE_CSS } from './sky/skyScale';
import { SKYBOUND } from './rushModel';
import type { HazardKind } from './rushTrials';
import { SkillBar, type SkillId, type SkillView } from './rushSkills';
import { useEdgeReveal } from '@/lib/hud/edgeReveal';
import { useSharedKeys } from '@/lib/hud/sharedKeys';
import hudStyles from '@/lib/hud/edge.module.css';
import { RUSH_KEYS, rushView, useRushView } from './rushView';

export const familyLabels: Record<string, [string, string]> = {
  SPELLING_CHOICE: ['Chính tả', 'Spelling'], GRAMMAR_TRAP: ['Ngữ pháp', 'Grammar'], PART_OF_SPEECH: ['Từ loại', 'Word class'],
  COLLOCATION: ['Kết hợp từ', 'Collocation'], PHRASAL_VERB: ['Cụm động từ', 'Phrasal verb'], IDIOM_FRAGMENT: ['Thành ngữ', 'Idiom'], FIXED_EXPRESSION: ['Cụm từ cố định', 'Fixed expression'],
  SPELLING_CORRECTION: ['Sửa chính tả', 'Spelling fix'], MISSING_LETTER: ['Chữ còn thiếu', 'Missing letter'], SYNONYM: ['Đồng nghĩa', 'Synonym'], ANTONYM: ['Trái nghĩa', 'Antonym'], WORD_FAMILY: ['Họ từ', 'Word family'],
};
/** Families whose door labels are spellings or letters (drawn in a monospace face so every letter reads). */
export const MONO_FAMILIES = new Set(['SPELLING_CHOICE', 'SPELLING_CORRECTION', 'MISSING_LETTER']);
/** Version 6 wall motions, named with the one thing to do. */
export const WALL_TEXT: Record<string, { vi: [string, string]; en: [string, string] }> = {
  APPROACH: { vi: ['Tường tiến tới', 'Cả bức tường trượt về phía bạn — vào đúng cửa, cửa sai sẽ đẩy bạn lùi'], en: ['Advancing Wall', 'The whole wall slides toward you — enter the right door; a wrong one shoves you back'] },
  SLIDE: { vi: ['Tường trượt ngang', 'Các cửa trượt qua lại cùng nhau — canh nhịp rồi chạy vào'], en: ['Sliding Wall', 'The doors slide side to side together — time your run in'] },
  TIMED: { vi: ['Cổng hẹn giờ', 'Song chắn hạ xuống theo nhịp — vào khi cửa đang mở'], en: ['Timed Gate', 'Shutters drop in rhythm — go in while the doors are open'] },
  SURGE: { vi: ['Tường cuồng phong', 'Vừa tiến tới vừa trượt ngang — cổng khó nhất'], en: ['Surging Wall', 'Advancing and sliding at once — the hardest gate'] },
};
/** Obstacle names and the one thing to do, in the player's language (also used by the How to Play guide). */
export const HAZARD_TEXT: Record<HazardKind, { vi: [string, string]; en: [string, string] }> = {
  MILL: { vi: ['Cối xay Rune', 'Nhảy qua thanh xoay khi nó quét tới'], en: ['Rune Mill', 'Jump the sweeping beam as it comes'] },
  RAMS: { vi: ['Búa lắc', 'Canh nhịp: chạy qua khi búa đang ở trên cao'], en: ['Swinging Rams', 'Time it: pass while the rams swing high'] },
  BOULDERS: { vi: ['Đá lăn', 'Né những tảng đá lăn tới — bị đá đâm sát mép đường là rơi xuống vực'], en: ['Stonefall Run', 'Dodge the rolling boulders — a hit near the edge throws you off'] },
  SKYFALL: { vi: ['Mưa đá trời', 'Tránh vòng sáng đỏ — khe giữa các làn luôn an toàn'], en: ['Skyfall', 'Avoid the glowing circles — the gaps between lanes are safe'] },
  CHASM: { vi: ['Cầu gãy', 'Nhảy qua khe, hoặc đi thăng bằng trên dầm hẹp'], en: ['Broken Bridge', 'Jump the gap, or balance across the narrow beam'] },
  SAWS: { vi: ['Lưỡi cưa Rune', 'Lưỡi cưa quét ngang đường — chờ nó lướt qua rồi đi'], en: ['Rune Saws', 'Blades sweep across the road — go right after one passes'] },
  CRUSHER: { vi: ['Tường nghiền', 'Hai khối đá đập vào nhau — chỉ qua khi chúng đang mở'], en: ['Crushing Walls', 'Two blocks slam together — cross only while they are open'] },
  GALE: { vi: ['Cầu cuồng phong', 'Cầu hẹp, không lan can — gió giật đẩy ngang, lái ngược chiều gió'], en: ['Gale Bridge', 'A narrow span with no rail — gusts push sideways; steer into the wind'] },
  CRUMBLE: { vi: ['Cầu sụp', 'Từng tấm đá rơi xuống nối tiếp — chạy theo sau làn sụp'], en: ['Crumbling Span', 'Tiles fall one after another — follow right behind the collapse'] },
  DRIFT: { vi: ['Đá trôi', 'Khoảng không với đá nổi trôi ngang — nhảy từ đá này sang đá khác'], en: ['Drifting Stones', 'A void crossed on swaying stones — leap from stone to stone'] },
  BEAM: { vi: ['Cầu gió thăng bằng', 'Dầm rất hẹp, gió giật báo trước rồi đẩy ngang — lái ngược gió liên tục'], en: ['Wind Balance Bridge', 'A very narrow beam; gusts are shown, then push — keep steering into the wind'] },
  STEPS: { vi: ['Đá bậc lơ lửng', 'Nhảy từ đá này sang đá kia — đá rung là sắp chìm, chờ ở đá trước'], en: ['Floating Stepping Stones', 'Leap stone to stone — a shaking stone is about to sink; wait on the one before'] },
  TILT: { vi: ['Đường nghiêng', 'Mặt đường nghiêng mạnh, bạn trượt về mép thấp — lái lên phía cao'], en: ['Tilting Road', 'The road leans hard and you slide to the low edge — steer uphill'] },
  ROLLER: { vi: ['Trụ xoay gai', 'Chạy trên khúc gỗ đang xoay, giữ thăng bằng và nhảy qua gai'], en: ['Spiked Rollers', 'Run along the turning log, keep your balance and hop the pegs'] },
};
/**
 * Touch joystick for manual movement (version 6): drag from the centre, up = forward. Release = stand still. The
 * same scene input the keys write (RushScene.setMove), so touch and keyboard play by one set of rules.
 */
export function RushJoystick({ vi, onMove }: { vi: boolean; onMove: (h: number, f: number) => void }) {
  const base = useRef<HTMLDivElement | null>(null), knob = useRef<HTMLSpanElement | null>(null);
  const pointer = useRef<number | null>(null);
  const move = (e: ReactPointerEvent) => {
    const el = base.current; if (!el) return; const r = el.getBoundingClientRect(), radius = r.width / 2;
    let dx = (e.clientX - (r.left + radius)) / radius, dy = (e.clientY - (r.top + radius)) / radius; const len = Math.hypot(dx, dy);
    if (len > 1) { dx /= len; dy /= len; }
    const dead = len < .15; onMove(dead ? 0 : dx, dead ? 0 : -dy);
    if (knob.current) knob.current.style.transform = `translate(${dx * 38}%, ${dy * 38}%)`;
  };
  const end = () => { pointer.current = null; onMove(0, 0); if (knob.current) knob.current.style.transform = ''; };
  return <div ref={base} className="rush-joystick" role="application" aria-label={vi ? 'Cần điều khiển di chuyển: kéo để chạy' : 'Movement stick: drag to run'}
    onPointerDown={e => { if (pointer.current !== null) return; e.preventDefault(); pointer.current = e.pointerId; e.currentTarget.setPointerCapture(e.pointerId); move(e); }} onPointerMove={e => { if (e.pointerId === pointer.current) move(e); }}
    onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}><span ref={knob} /></div>;
}
export interface HudFeedback { kind: 'good' | 'bad' | 'info'; title: string; detail?: string; key: number }
interface Props {
  vi: boolean; hud: SceneHud; question: RushQuestion | null; total: number; walls: number[]; finish: number; ready: boolean;
  feedback: HudFeedback | null; validating: boolean; momentumOn: boolean;
  onSteer: (lane: number) => void; onHold: (direction: number) => void;
  /** Version 6: the joystick axes (−1..1). */
  onMove?: (horizontal: number, forward: number) => void;
  skills: SkillView[]; charges?: number; onSkill: (id: SkillId) => void; onSkillRelease: (id: SkillId) => void; onDeny: (id: SkillId) => void;
  competitive?: { rank: number; racers: number } | null; corner: ReactNode; extra?: ReactNode; countdown: number | null; countdownCaption: string;
  /** Mouse-look is on: the bars step aside. */
  locked?: boolean;
  /** The shared settings and help keys: the shell's own menu and guide. */
  onSettings?: () => void; onHelp?: () => void;
}

/**
 * Touch controls are shown for touch input, not for a screen size: a phone or tablet (no fine pointer) starts with
 * them; any device switches to them on a touch and back to keys on a key press or a mouse move (a touchscreen laptop
 * follows what the player actually uses). Desktop keyboards never see the joystick or the steering pads.
 */
function useTouchInput() {
  const [touch, setTouch] = useState(false);
  useEffect(() => {
    const fine = matchMedia('(any-pointer: fine)');
    setTouch(!fine.matches);
    const pointer = (e: PointerEvent) => { if (e.pointerType === 'touch' || e.pointerType === 'pen') setTouch(true); else if (e.pointerType === 'mouse' && fine.matches) setTouch(false); };
    const key = (e: KeyboardEvent) => { if (fine.matches && /^(Key[WASD]|Arrow|Space)/.test(e.code)) setTouch(false); };
    window.addEventListener('pointerdown', pointer, true); window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('pointerdown', pointer, true); window.removeEventListener('keydown', key, true); };
  }, []);
  return touch;
}

/**
 * The race HUD keeps the middle of the screen for the course. Top centre: progress rail, the question, its context and
 * the answer chips (they mirror the doors left-to-right, same colour and number; on version 6+ a tap marks a door).
 * Top corners: gate count; place, sound, fullscreen, menu. Left edge: short-lived notices (obstacle ahead, rising gate,
 * shields, wall motion, feedback) — never over the runner or the landing ahead. Bottom centre: the skills only (plus the
 * joystick for touch input).
 */
export function RushHud(p: Props) {
  const t = (a: string, b: string) => p.vi ? a : b;
  const touch = useTouchInput();
  // The corner tools and the skill bar step aside for the course and come back at the edge, on focus or on the HUD key (one system with the study room and
  // Speaking Arena). The rail, the gate count, the place, the question and the notices are never part of it; touch play keeps its controls.
  const edge = useEdgeReveal({ enabled: !touch, locked: p.locked, hold: { bottom: p.countdown !== null } });
  const keys = useSharedKeys({ hud: edge.toggle, settings: p.onSettings, help: p.onHelp }, { taken: RUSH_KEYS });
  const view = useRushView();
  const tools = edge.bind('top', 'tools'), bar = edge.bind('bottom');
  // The question sits under the progress rail's centre: both side columns of the top row take the wider side's width.
  const top = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const row = top.current;
    if (!row || typeof ResizeObserver === 'undefined') return;
    const sides = [row.querySelector<HTMLElement>(':scope > .rush-gate-count'), row.querySelector<HTMLElement>(':scope > .rush-corner')];
    const measure = () => row.style.setProperty('--rush-side', `${Math.ceil(Math.max(0, ...sides.map(n => n?.offsetWidth ?? 0)))}px`);
    const observer = new ResizeObserver(measure);
    sides.forEach(n => { if (n) observer.observe(n); });
    measure();
    return () => observer.disconnect();
  }, []);
  const q = p.question, gates = q?.options.length ?? 0;
  const final = p.hud.checkpoint === p.total - 1;
  const milestone = (p.hud.checkpoint + 1) % 4 === 0 && !final;
  const boost = Math.round(SKYBOUND.momentumStep * Math.min(SKYBOUND.momentumCap, p.hud.streak) * 100);
  const hazard = p.hud.hazard, rising = p.hud.rising;
  const hazardText = hazard ? HAZARD_TEXT[hazard.kind][p.vi ? 'vi' : 'en'] : null;
  const sillShare = rising ? Math.min(1, rising.sill / rising.reach) : 0;
  const v6 = p.hud.reforged, wall = p.hud.wall, wallText = wall && WALL_TEXT[wall.kind] ? WALL_TEXT[wall.kind][p.vi ? 'vi' : 'en'] : null;
  return <>
    <div className="rush-rail" aria-hidden="true">
      <div className="rush-rail-track">
        {p.walls.map((w, i) => <i key={i} className={`rush-rail-notch${i < p.hud.checkpoint ? ' is-done' : ''}${i === p.total - 1 ? ' is-grand' : (i + 1) % 4 === 0 ? ' is-milestone' : ''}`} style={{ left: `${Math.min(100, w / p.finish * 100)}%` }} />)}
        {p.hud.progress.map(r => <b key={r.id} className={`rush-rail-racer${r.local ? ' is-local' : ''}`} data-look={r.look} style={{ left: `${r.t * 100}%` }} />)}
      </div>
    </div>
    <div className="rush-hud-top" ref={top}>
      <div className="rush-gate-count"><span>{t('Cổng', 'Gate')}</span><b>{Math.min(p.hud.checkpoint + 1, p.total)}<small>/{p.total}</small></b></div>
      {q && <div className={`rush-question${final ? ' is-grand' : milestone ? ' is-milestone' : ''}${hazard?.inside ? ' is-dimmed' : ''}`}>
        <div className="rush-question-meta">
          <span className="rush-family">{familyLabels[q.family]?.[p.vi ? 0 : 1] ?? t('Câu hỏi', 'Question')}</span>
          {final && <span className="rush-grand-badge"><Crown size={13} />{t('Cổng Lớn cuối cùng', 'Final Grand Gate')}</span>}
          {milestone && <span className="rush-grand-badge is-milestone">{t('Cổng mốc', 'Milestone gate')}</span>}
          {rising && <span className="rush-grand-badge is-rising">{t('Cổng Thăng Thiên', 'Rising Gate')}</span>}
          {wallText && <span className={`rush-grand-badge is-motion${wall?.closed ? ' is-closed' : ''}`} data-wall={wall?.kind}>{wallText[0]}</span>}
        </div>
        <h2>{q.prompt}</h2>
        {q.context && <p tabIndex={0} aria-label={t('Ngữ cảnh câu hỏi', 'Question context')}>{q.context}</p>}
        <div className="rush-lanes" role="group" aria-label={v6 ? t('Các cổng đáp án — chạm để đánh dấu cửa (bạn tự chạy tới)', 'Answer gates — tap to mark a door (you run there yourself)') : t('Các cổng đáp án, chạm để chạy tới', 'Answer gates, tap to steer')} style={{ gridTemplateColumns: `repeat(${gates}, minmax(0, 1fr))` }}>
          {q.options.map((o, i) => {
            const tried = p.hud.tried.includes(i), aim = p.hud.aim === i, marked = v6 && p.hud.marked === i;
            return <button key={o.id} type="button" className={`rush-lane${aim ? ' is-aim' : ''}${tried ? ' is-tried' : ''}${marked ? ' is-marked' : ''}`} style={{ ['--lane' as string]: LANE_CSS[i % LANE_CSS.length] }}
              aria-pressed={v6 ? marked : aim} aria-label={`${t('Cổng', 'Gate')} ${i + 1}: ${o.label}${tried ? ' — ' + t('đã thử, chưa đúng', 'tried, not correct') : ''}`}
              onPointerDown={e => e.preventDefault()} onClick={() => p.onSteer(i)}>
              <i>{tried ? <X size={13} strokeWidth={3} /> : i + 1}</i>
              <span className={MONO_FAMILIES.has(q.family) ? 'is-mono' : ''}>{o.label}</span>
            </button>;
          })}
        </div>
      </div>}
      <div className="rush-corner">{p.competitive && <div className="rush-place" aria-label={t('Vị trí hiện tại', 'Current position')}><b>#{p.competitive.rank}</b><small>/{p.competitive.racers}</small></div>}<div {...tools} className={`rush-corner-tools ${tools.className}`}>
        <button type="button" className="rush-icon-button" data-testid="rush-view" aria-pressed={view === 'first'} aria-keyshortcuts={keys.camera} title={`${view === 'first' ? t('Theo nhân vật', 'Behind the runner') : t('Góc nhìn thứ nhất', 'First person')} (${keys.camera})`} aria-label={view === 'first' ? t('Chuyển sang nhìn theo nhân vật', 'Switch to behind the runner') : t('Chuyển sang góc nhìn thứ nhất', 'Switch to first person')} onClick={() => rushView.toggle()}>{view === 'first' ? <PersonStanding size={18} /> : <Eye size={18} />}</button>
        {p.corner}</div></div>
      <aside className="rush-side" aria-label={t('Thông báo trên đường', 'Course notices')}>
      <div className="rush-feedback" aria-live="polite">
        {p.validating ? <div className="rush-toast is-info"><b>{t('Echo đang mở khóa…', 'Echo is unsealing…')}</b></div>
          : p.feedback && <div key={p.feedback.key} className={`rush-toast is-${p.feedback.kind}`}><b>{p.feedback.title}</b>{p.feedback.detail && <span>{p.feedback.detail}</span>}</div>}
      </div>
        <div className="rush-alerts" aria-live="polite">
          {hazard && hazardText && <div className={`rush-hazard${hazard.inside ? ' is-inside' : ''}`} data-hazard={hazard.kind}>
            <TriangleAlert size={18} aria-hidden="true" /><b>{hazardText[0]}</b><span>{hazardText[1]}</span>
            {!hazard.inside && <small>{v6 ? `${Math.round(hazard.distance * .02)} m` : `${Math.round(hazard.distance / 212 * 10) / 10}s`}</small>}
          </div>}
          {rising && <div className={`rush-rising${rising.armed ? ' is-armed' : ''}${sillShare >= 1 ? ' is-sealed' : ''}`}>
            <b>{t('Cổng Thăng Thiên', 'Rising Gate')}</b>
            <span>{sillShare >= 1 ? t('Bệ đã quá cao — cổng sẽ hạ xuống rồi nâng lại', 'Out of reach — the gate settles, then climbs again')
              : rising.sill > 0 ? t('Bệ đang nâng: nhảy (Space) vào cửa của bạn!', 'The sill is rising: jump (Space) into your door!')
              : rising.armed ? t('Sắp nâng — chạy nhanh tới cửa đúng', 'About to rise — race to the right door') : t('Cổng này sẽ nâng lên khi bạn tới gần', 'This gate rises as you approach')}</span>
            <i className="rush-rising-gauge" aria-label={t('Độ cao bệ so với tầm nhảy', 'Sill height against your jump reach')}><em style={{ width: `${sillShare * 100}%` }} /></i>
          </div>}
          {p.hud.guard > 0 && p.hud.trials && <div className="rush-guard"><ShieldCheck size={16} aria-hidden="true" />{t('Echo bảo vệ', 'Echo shield')}</div>}
          {wallText && wall && wall.distance < 1300 && !hazard && <div className={`rush-wallnote${wall.closed ? ' is-closed' : ''}`} data-wall={wall.kind}><MoveVertical size={16} aria-hidden="true" /><b>{wallText[0]}</b><span>{wall.closed ? t('Song chắn đang hạ — chờ mở', 'Shutters down — wait for them') : wallText[1]}</span></div>}
          {v6 && (p.hud.speedBuff > 0 || p.hud.shield > 0) && <div className="rush-buffs">
            {p.hud.speedBuff > 0 && <span className="rush-buff is-speed"><Gauge size={14} aria-hidden="true" />{t('Tốc độ', 'Speed')} +25% · {p.hud.speedBuff.toFixed(1)}s</span>}
            {p.hud.shield > 0 && <span className="rush-buff is-guard"><ShieldCheck size={14} aria-hidden="true" />{t('Khiên cầu', 'Orb shield')}</span>}
          </div>}
        </div>
      </aside>
    </div>

    {p.countdown !== null && <div className="rush-countdown" aria-live="polite"><b key={p.countdown}>{p.countdown > 0 ? p.countdown : t('CHẠY!', 'GO!')}</b><span>{p.countdownCaption}</span></div>}

    <div {...bar} className={`rush-bottom${touch ? ' is-touch' : ' is-keys'} ${bar.className}`}>
      <div className="rush-controls">
        {!touch ? null : v6 && p.onMove ? <RushJoystick vi={p.vi} onMove={p.onMove} /> : <div className="rush-steering">
          {[-1, 1].map(direction => <button key={direction} type="button" aria-label={direction < 0 ? t('Chạy trái (← / A)', 'Steer left (← / A)') : t('Chạy phải (→ / D)', 'Steer right (→ / D)')}
            onPointerDown={e => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); p.onHold(direction); }} onPointerUp={() => p.onHold(0)} onPointerCancel={() => p.onHold(0)} onLostPointerCapture={() => p.onHold(0)}>
            {direction < 0 ? <ArrowLeft /> : <ArrowRight />}</button>)}
        </div>}
        <div className={`rush-momentum${p.hud.streak > 0 && p.momentumOn ? ' is-live' : ''}${p.hud.streak >= 4 ? ' is-hot' : ''}`} aria-label={t('Nhịp Echo', 'Echo momentum')}>
          <svg viewBox="0 0 44 44" aria-hidden="true"><circle cx="22" cy="22" r="19" className="rush-momentum-bg" /><circle cx="22" cy="22" r="19" className="rush-momentum-fill" style={{ strokeDasharray: `${Math.min(1, p.hud.streak / SKYBOUND.momentumCap) * 119.4} 119.4` }} /></svg>
          <b>{p.hud.streak}</b>
          <span>{p.momentumOn ? (boost ? `+${boost}%` : t('Nhịp', 'Streak')) : t('Chuỗi', 'Streak')}</span>
        </div>
        <SkillBar vi={p.vi} skills={p.skills} charges={p.charges} onPress={p.onSkill} onRelease={p.onSkillRelease} onDeny={p.onDeny} />
        {p.extra}
      </div>
    </div>
    {edge.hint && !edge.shown.bottom && <div className={hudStyles.hint} role="status" data-testid="hud-hint">{p.vi ? <>Đưa chuột xuống mép dưới hoặc nhấn <kbd>{keys.hud}</kbd> để hiện kỹ năng</> : <>Move to the bottom edge or press <kbd>{keys.hud}</kbd> for your skills</>}</div>}
    {!p.ready && <div className="rush-center-overlay" aria-busy="true"><span>{t('Đang dựng bầu trời…', 'Raising the skyway…')}</span></div>}
  </>;
}

export function ResultIcon({ ok }: { ok: boolean }) { return ok ? <Check size={14} /> : <X size={14} />; }
