'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Flag, X } from 'lucide-react';
import { HAZARD_TEXT, WALL_TEXT } from './RushHud';
import type { HazardKind } from './rushTrials';

/**
 * How to Play — optional, always skippable. Offered by itself at most once (a first Solo start from the hall), never on
 * a multiplayer path (invitation, room code, room creation, Quick Match, Bots, rematch, reconnect); re-openable at any
 * time from "Cách chơi". "Bỏ qua" works from the first card (and starts the race when the guide was opened by a start
 * button); X, Escape and a press outside close it. Every control and rule named here is the game's real one (keys from
 * RushScene, skills from rushSkills, obstacles, walls and orbs from rushReforged).
 */
const STORAGE = 'echo-quiz-rush:howto-v7';
export function howToDismissed() { try { return localStorage.getItem(STORAGE) === 'dismissed'; } catch { return false; } }
function remember(value: boolean) { try { if (value) localStorage.setItem(STORAGE, 'dismissed'); else localStorage.removeItem(STORAGE); } catch { /* private mode */ } }

type Mode = 'solo' | 'bots' | 'multi' | 'practice' | 'general';
type ArtKind = 'goal' | 'controls' | 'obstacles' | 'rising' | 'setback' | 'modes' | 'move' | 'walls' | 'edges' | 'orbs';
function Art({ kind }: { kind: ArtKind }) {
  // Small line illustrations in the HUD's palette (no external images).
  const door = (x: number, c: string, ok?: boolean) => <g key={x}><rect x={x} y={22} width={34} height={46} rx={17} fill="rgba(255,255,255,.06)" stroke={c} strokeWidth={3} />{ok !== undefined && <text x={x + 17} y={52} textAnchor="middle" fontSize={18} fontWeight={800} fill={ok ? '#8ff0cb' : '#ffb3bf'}>{ok ? '✓' : '✕'}</text>}</g>;
  const runner = (x: number, y: number, s = 1) => <g transform={`translate(${x} ${y}) scale(${s})`}><circle cx={0} cy={-26} r={9} fill="#f2c4a2" /><path d="M-9 -30 Q0 -44 11 -31 L12 -22 Q2 -30 -9 -22 Z" fill="#4b2a1f" /><rect x={-7} y={-17} width={14} height={18} rx={6} fill="#30357a" /><path d="M-5 1 L-9 14 M5 1 L9 13" stroke="#2a2f45" strokeWidth={5} strokeLinecap="round" /><path d="M0 -17 Q14 -20 18 -10" stroke="#19b8a6" strokeWidth={4} fill="none" strokeLinecap="round" /></g>;
  return <svg viewBox="0 0 220 110" className="rush-howto-art" aria-hidden="true">
    <defs><linearGradient id="hw-road" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#e8d7b4" /><stop offset="1" stopColor="#b99a6c" /></linearGradient></defs>
    <path d="M60 104 L92 70 L128 70 L160 104 Z" fill="url(#hw-road)" opacity={.85} />
    {kind === 'goal' && <>{door(54, '#5cc8ff', false)}{door(93, '#f6c453', true)}{door(132, '#46d6a8')}{runner(110, 102)}<path d="M110 76 L110 72" stroke="#f6c453" strokeWidth={3} strokeDasharray="3 3" /></>}
    {kind === 'controls' && <>{runner(110, 96)}<path d="M80 80 L60 80 M140 80 L160 80" stroke="#8ff6ff" strokeWidth={4} strokeLinecap="round" markerEnd="" /><path d="M110 58 L110 34" stroke="#f6c453" strokeWidth={4} strokeLinecap="round" /><path d="M100 42 L110 32 L120 42" stroke="#f6c453" strokeWidth={4} fill="none" strokeLinecap="round" /><path d="M64 74 L56 80 L64 86 M156 74 L164 80 L156 86" stroke="#8ff6ff" strokeWidth={4} fill="none" strokeLinecap="round" /></>}
    {kind === 'obstacles' && <><rect x={104} y={40} width={12} height={46} rx={4} fill="#d9c6a3" /><rect x={40} y={78} width={140} height={8} rx={4} fill="#8a5a2e" transform="rotate(-8 110 82)" /><circle cx={170} cy={58} r={12} fill="#a8906c" stroke="#47e6d6" strokeWidth={2} />{runner(78, 100, .9)}<path d="M78 66 Q78 50 92 50" stroke="#f6c453" strokeWidth={3} fill="none" strokeDasharray="4 4" /></>}
    {kind === 'rising' && <><rect x={52} y={60} width={116} height={14} fill="#a8906c" /><rect x={52} y={24} width={116} height={36} fill="#cdb48c" />{door(70, '#5cc8ff')}{door(116, '#f6c453')}<path d="M40 70 L40 40 M34 46 L40 40 L46 46" stroke="#ffb347" strokeWidth={3} fill="none" />{runner(132, 104, .9)}<path d="M132 70 Q140 56 133 50" stroke="#f6c453" strokeWidth={3} fill="none" strokeDasharray="4 4" /></>}
    {kind === 'setback' && <>{runner(84, 100, .9)}<circle cx={84} cy={70} r={22} fill="none" stroke="#5ff0e0" strokeWidth={3} strokeDasharray="6 5" /><path d="M140 60 Q160 70 150 100" stroke="#ffb3bf" strokeWidth={3} fill="none" /><text x={150} y={52} fontSize={13} fontWeight={800} fill="#ffb3bf">!</text></>}
    {kind === 'modes' && <>{runner(70, 102, .8)}{runner(110, 96, .8)}{runner(150, 102, .8)}<path d="M40 22 L180 22" stroke="#f6c453" strokeWidth={3} strokeDasharray="6 6" /><text x={110} y={18} textAnchor="middle" fontSize={11} fontWeight={800} fill="#ffe39a">FINISH</text></>}
    {kind === 'move' && <>{runner(110, 98)}{[['W', 110, 30], ['A', 74, 66], ['S', 110, 66], ['D', 146, 66]].map(([k, x, y]) => <g key={k as string}><rect x={(x as number) - 14} y={(y as number) - 14} width={28} height={28} rx={6} fill="rgba(255,255,255,.08)" stroke="#8ff6ff" strokeWidth={2} /><text x={x as number} y={(y as number) + 5} textAnchor="middle" fontSize={14} fontWeight={800} fill="#e8fbff">{k}</text></g>)}</>}
    {kind === 'walls' && <><rect x={48} y={30} width={124} height={44} rx={4} fill="#cdb48c" />{door(60, '#5cc8ff')}{door(126, '#f6c453')}<path d="M110 84 L110 96 M102 90 L110 98 L118 90" stroke="#ffb347" strokeWidth={3} fill="none" strokeLinecap="round" /><path d="M36 52 L46 52 M174 52 L184 52" stroke="#ffb347" strokeWidth={3} strokeLinecap="round" />{runner(110, 108, .7)}</>}
    {kind === 'edges' && <><path d="M60 104 L92 70 L128 70 L160 104 Z" fill="none" /><path d="M64 100 L92 70" stroke="#f1e6cf" strokeWidth={5} /><path d="M156 100 L128 70" stroke="#ffb3bf" strokeWidth={2} strokeDasharray="4 4" />{runner(146, 92, .8)}<path d="M160 70 Q176 86 170 104" stroke="#ffb3bf" strokeWidth={3} fill="none" markerEnd="" /></>}
    {kind === 'orbs' && <><circle cx={70} cy={58} r={14} fill="#ffc24a" opacity={.9} /><circle cx={110} cy={52} r={14} fill="#5ff0ff" opacity={.9} /><circle cx={150} cy={58} r={14} fill="#b18cff" opacity={.9} />{runner(110, 104, .8)}</>}
  </svg>;
}

export function RushHowTo({ vi, mode, open, onClose, onStart, startLabel }: {
  vi: boolean; mode: Mode; open: boolean; onClose: () => void; onStart?: () => void; startLabel?: string;
}) {
  const t = (a: string, b: string) => vi ? a : b;
  // An automatic offer (opened by a start button) defaults to "don't show again": it is offered once, then only on request.
  const [page, setPage] = useState(0), [hide, setHide] = useState(false);
  const dialog = useRef<HTMLDivElement | null>(null);
  useEffect(() => { if (open) { setPage(0); setHide(howToDismissed() || !!onStart); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const PAGES = 9;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    const keys = (e: KeyboardEvent) => {
      // The guide owns the keyboard while open (Escape must not also pause / resume the race behind it).
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); onClose(); return; }
      if (e.key === 'ArrowRight') { e.stopImmediatePropagation(); setPage(p => Math.min(PAGES - 1, p + 1)); }
      if (e.key === 'ArrowLeft') { e.stopImmediatePropagation(); setPage(p => Math.max(0, p - 1)); }
      if (e.key !== 'Tab' || !dialog.current) return;
      const nodes = Array.from(dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)'));
      if (!nodes.length) return; const first = nodes[0], last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', keys, true);
    return () => { window.removeEventListener('keydown', keys, true); previous?.focus?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, onClose]);
  const kinds: HazardKind[] = ['CHASM', 'MILL', 'SAWS', 'STEPS', 'RAMS', 'BOULDERS', 'CRUMBLE', 'TILT', 'BEAM', 'SKYFALL', 'CRUSHER', 'GALE', 'DRIFT', 'ROLLER'];
  const walls = ['APPROACH', 'SLIDE', 'TIMED', 'SURGE'];
  const pages: { art: ArtKind; title: string; body: ReactNode }[] = [
    { art: 'goal', title: t('Mục tiêu', 'Your goal'), body: <>
      <p>{t('Dẫn nhà thám hiểm của bạn qua con đường trên mây. Mỗi Cổng Tri Thức hỏi một câu tiếng Anh và có một cửa cho mỗi đáp án — tự đi vào cửa của đáp án đúng.', 'Lead your explorer along the skyway. Every Knowledge Gate asks one English question and has one door per answer — walk into the door of the right answer yourself.')}</p>
      <ul><li>{t('Đúng: cửa mở, bạn đi qua. Đúng ngay lần đầu xây Nhịp Echo (+4% tốc độ mỗi bậc, tối đa +20%).', 'Right: the door opens and you walk through. First-try answers build Echo momentum (+4% speed each, up to +20%).')}</li>
        <li>{t('Sai: cửa khóa lại thành đá cho câu này, bạn bị đẩy lùi và Nhịp về 0. Tìm cửa khác.', 'Wrong: that door turns to stone for this question, you are thrown back and momentum resets. Find another door.')}</li>
        <li>{t('Không ai giục bạn: đứng đọc câu hỏi bao lâu tùy thích.', 'Nobody hurries you: stand and read the question as long as you like.')}</li></ul></> },
    { art: 'move', title: t('Di chuyển', 'Moving'), body: <>
      <table className="rush-howto-keys"><tbody>
        <tr><th>{t('Đi tới / lùi', 'Forward / back')}</th><td><kbd>W</kbd> <kbd>S</kbd> {t('hoặc', 'or')} <kbd>↑</kbd> <kbd>↓</kbd></td><td>{t('Cần điều khiển bên trái', 'The left stick')}</td></tr>
        <tr><th>{t('Sang trái / phải', 'Left / right')}</th><td><kbd>A</kbd> <kbd>D</kbd> {t('hoặc', 'or')} <kbd>←</kbd> <kbd>→</kbd></td><td>{t('Kéo cần sang bên', 'Drag the stick sideways')}</td></tr>
        <tr><th>{t('Đi chéo', 'Diagonal')}</th><td><kbd>W</kbd>+<kbd>A</kbd> …</td><td>{t('Kéo chéo', 'Drag diagonally')}</td></tr>
        <tr><th>{t('Tăng tốc', 'Sprint')}</th><td>{t('giữ', 'hold')} <kbd>Shift</kbd></td><td>{t('Giữ nút Tăng tốc — tốn thể lực', 'Hold Sprint — uses stamina')}</td></tr>
      </tbody></table>
      <p className="rush-howto-note">{t('Thả phím là nhân vật dừng lại. Không có tự động chạy. Phím 1–4 chỉ đánh dấu một cửa để dễ nhìn.', 'Let go and your explorer stops. There is no automatic running. Keys 1–4 only mark a door to help you look.')}</p></> },
    { art: 'controls', title: t('Nhảy, né và kỹ năng', 'Jump, dodge and skills'), body: <>
      <table className="rush-howto-keys"><tbody>
        <tr><th>{t('Nhảy', 'Jump')}</th><td><kbd>Space</kbd> {t('(phím nhảy duy nhất)', '(the only jump key)')}</td><td>{t('Nút Nhảy', 'Jump button')}</td></tr>
        <tr><th>{t('Né sang bên', 'Dodge')}</th><td><kbd>Ctrl</kbd> + {t('hướng đang giữ', 'held direction')}</td><td>{t('Nút Né (hồi 1,4 giây)', 'Dodge button (1.4 s cooldown)')}</td></tr>
        <tr><th>Dash</th><td><kbd>F</kbd></td><td>{t('Bứt tốc theo hướng đang đi, hồi 4 giây', 'A burst where you are heading, 4 s cooldown')}</td></tr>
        <tr><th>Echo Rush</th><td><kbd>E</kbd></td><td>{t('Nạp bằng cổng đúng và Cầu Năng lượng; đầy thì bùng tốc 3 giây', 'Charged by correct gates and Energy orbs; full = 3 s surge')}</td></tr>
        <tr><th>{t('Tạm dừng', 'Pause')}</th><td><kbd>Esc</kbd></td><td>{t('Nút tạm dừng', 'Pause button')}</td></tr>
      </tbody></table>
      <p className="rush-howto-note">{t('Trong khi đua, rời trang (kể cả Ctrl+W) sẽ được hỏi lại trước.', 'While racing, leaving the page (even Ctrl+W) asks you first.')}</p></> },
    { art: 'walls', title: t('Cổng Tri Thức chuyển động', 'Moving Knowledge Gates'), body: <>
      <ul className="rush-howto-hazards">{walls.map(k => <li key={k}><b>{WALL_TEXT[k][vi ? 'vi' : 'en'][0]}</b><span>{WALL_TEXT[k][vi ? 'vi' : 'en'][1]}</span></li>)}
        <li><b>{t('Cổng Thăng Thiên', 'Rising Gate')}</b><span>{t('Bệ đá nâng cổng lên — nhảy (Space) vào cửa trước khi bệ quá cao.', 'A plinth lifts the gate — jump (Space) into your door before the sill is out of reach.')}</span></li></ul>
      <p className="rush-howto-note">{t('Tường tiến tới chỉ đi đến một giới hạn rồi lui lại; luôn có chỗ đứng đọc an toàn. Mọi cửa chuyển động cùng nhau — chuyển động không gợi ý đáp án.', 'An advancing wall stops at a limit and retreats; there is always a safe place to stand and read. All doors move together — motion never hints at an answer.')}</p></> },
    { art: 'edges', title: t('Không có lan can', 'No railings'), body: <>
      <ul><li>{t('Con đường trên mây không có lan can ở bất cứ đâu: đi quá mép là rơi xuống vực thật.', 'The sky road has no railing anywhere: step past an edge and you really fall.')}</li>
        <li>{t('Bị chướng ngại hất về phía mép, bị gió đẩy hay trượt trên đường nghiêng cũng có thể làm bạn rơi.', 'A knock toward the edge, a gust or a slide on a leaning road can send you over too.')}</li>
        <li>{t('Rơi rồi? Echo đưa bạn trở lại phía sau chỗ rơi (trước chướng ngại nếu bạn rơi trong đó), có khiên bảo vệ một lúc.', 'Fell? Echo brings you back a little behind where you fell (before the obstacle if you fell in one), shielded for a moment.')}</li></ul></> },
    { art: 'obstacles', title: t('Chướng ngại vật', 'Obstacles'), body: <>
      <ul className="rush-howto-hazards">{kinds.map(k => <li key={k}><b>{HAZARD_TEXT[k][vi ? 'vi' : 'en'][0]}</b><span>{HAZARD_TEXT[k][vi ? 'vi' : 'en'][1]}</span></li>)}</ul>
      <p className="rush-howto-note">{t('Chướng ngại nhanh và khó dần về phía đích. Mỗi cái đều báo trước và luôn có cách vượt qua.', 'Obstacles get faster and harder toward the finish. Each warns you first, and there is always a way through.')}</p></> },
    { art: 'orbs', title: t('Quả cầu', 'Orbs'), body: <>
      <ul className="rush-howto-hazards">
        <li><b>{t('Cầu Tốc độ (vàng)', 'Speed Orb (gold)')}</b><span>{t('+25% tốc độ trong 4 giây (không cộng dồn).', '+25% speed for 4 s (does not stack).')}</span></li>
        <li><b>{t('Cầu Năng lượng (xanh)', 'Energy Orb (cyan)')}</b><span>{t('+35 năng lượng Echo Rush.', '+35 Echo Rush energy.')}</span></li>
        <li><b>{t('Cầu Khiên (tím)', 'Guard Orb (violet)')}</b><span>{t('Đỡ một cú va chạm trong 12 giây (không đỡ được cú rơi).', 'Blocks one hit within 12 s (not a fall).')}</span></li></ul>
      <p className="rush-howto-note">{t('Nhiều quả cầu nằm ở chỗ khó: trên khe cầu gãy (phải nhảy) hay giữa hai lưỡi cưa. Mỗi người lấy được mỗi quả một lần.', 'Many orbs sit somewhere bold: over a gap (jump for it) or between the saws. Each racer can take each orb once.')}</p></> },
    { art: 'setback', title: t('Va chạm và hồi phục', 'Hits and recovery'), body: <>
      <ul><li>{t('Bị đánh trúng: bạn bị hất lùi một chút rồi tự đi tiếp. Nhịp Echo vẫn giữ.', 'Hit: you are knocked back a little, then move on. Your momentum is kept.')}</li>
        <li>{t('Cú va mạnh gần mép đường có thể hất bạn xuống vực.', 'A hard hit near the edge can throw you into the abyss.')}</li>

        <li>{t('Sau mỗi lần trúng hoặc rơi, khiên Echo bảo vệ bạn khoảng 1,5 giây (nhân vật nhấp nháy).', 'After a hit or a fall, Echo’s shield protects you for about 1.5 s (the runner shimmers).')}</li></ul></> },
    { art: 'modes', title: t('Solo và đua cùng người khác', 'Solo and racing others'), body: <>
      <ul><li>{t('Solo: tự chọn độ khó, chủ đề và số cổng. Máy chủ lưu kết quả.', 'Solo: your difficulty, topic and gate count. The server saves your result.')}</li>
        <li>{t('Echo Bots, Quick Match, Phòng riêng (2–5 người): cùng câu hỏi, mỗi người một thứ tự cửa. Máy chủ quyết định chuyển động, va chạm, quả cầu, đúng sai và người thắng.', 'Echo Bots, Quick Match, Private Rooms (2–5): the same questions, each racer their own door order. The server decides movement, hits, orbs, answers and the winner.')}</li>
        <li>{t('Mở cổng đúng để nhận lượt Chiến thuật — Khóa băng (Z), Bẫy thời gian (X), Đổi vị trí (C). Không dùng được gần chướng ngại.', 'Correct gates earn Tactics — Ice Lock (Z), Time Snare (X), Position Swap (C). Never near an obstacle.')}</li>
        <li>{t('Cuộc đua kết thúc khi mọi người về đích, hoặc 60 giây sau người về đầu tiên.', 'A race ends when everyone finishes, or 60 seconds after the first finisher.')}</li></ul></> },
  ];
  if (!open) return null;
  const last = page === pages.length - 1;
  const p = pages[page];
  const close = (start: boolean) => { remember(hide); onClose(); if (start) onStart?.(); };
  return <div className="rush-howto-cover" onPointerDown={e => { if (e.target === e.currentTarget) close(false); }}>
    <div ref={dialog} className="rush-howto" role="dialog" aria-modal="true" aria-labelledby="rush-howto-title" data-mode={mode}>
      <header>
        <span className="rush-eyebrow">{t('CÁCH CHƠI', 'HOW TO PLAY')} · {page + 1}/{pages.length}</span>
        <button type="button" className="rush-icon-button" aria-label={t('Đóng hướng dẫn', 'Close the guide')} onClick={() => close(false)}><X size={18} /></button>
      </header>
      <Art kind={p.art} />
      <h2 id="rush-howto-title">{p.title}</h2>
      <div className="rush-howto-body">{p.body}</div>
      <nav className="rush-howto-dots" aria-label={t('Các trang hướng dẫn', 'Guide pages')}>{pages.map((x, i) => <button key={i} type="button" aria-label={`${i + 1}. ${x.title}`} aria-current={i === page ? 'step' : undefined} onClick={() => setPage(i)} />)}</nav>
      <label className="rush-howto-remember">
        <input type="checkbox" checked={hide} onChange={e => setHide(e.target.checked)} />
        <span>{t('Không hiện lại (vẫn mở được bằng nút “Cách chơi”)', 'Don’t show again (still available from “How to play”)')}</span>
      </label>
      <footer>
        <button type="button" className="rush-text-button rush-howto-skip" data-testid="rush-howto-skip" onClick={() => close(!!onStart)}>{t('Bỏ qua', 'Skip')}</button>
        <span className="rush-howto-pager">
          <button type="button" className="rush-secondary" disabled={page === 0} onClick={() => setPage(x => Math.max(0, x - 1))}><ChevronLeft size={18} />{t('Trước', 'Back')}</button>
          {!last && <button type="button" className="rush-secondary" data-autofocus onClick={() => setPage(x => Math.min(pages.length - 1, x + 1))}>{t('Tiếp', 'Next')}<ChevronRight size={18} /></button>}
          {onStart ? <button type="button" className="rush-primary" data-autofocus={last ? true : undefined} onClick={() => close(true)}><Flag size={18} />{startLabel ?? t('Vào cuộc đua', 'Start the race')}</button>
            : last && <button type="button" className="rush-primary" data-autofocus onClick={() => close(false)}>{t('Đã hiểu', 'Got it')}</button>}
        </span>
      </footer>
    </div>
  </div>;
}
