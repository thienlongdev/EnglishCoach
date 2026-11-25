'use client';
import { useEffect, useId, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import dynamic from 'next/dynamic';
import { ArrowRight, BookOpenText, Check, Crown, Link2, Play, Swords, User, Users, Zap, Hexagon, Layers3 } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { BrandWhaleIcon } from '@/components/common/BrandWhaleIcon';
import { KingArtwork } from './KingArtwork';
import { KingShell } from './KingShell';
import { KING_ART } from './kingArt';
import { isPlayable, KING_MODES, PLAY_FLOWS } from './domain';
import type { KingMode, PlayFlow } from './domain';
import type { KingLaunch } from './realtimeTypes';
import { apiClient } from '@/services/api-client';
import { modeAvailable, availabilityMessage } from './capabilities';
import type { KingCapability } from './capabilities';
import styles from './king.module.css';

const KingArena = dynamic(() => import('./KingArena'), { loading: () => <p role="status" className="p-8 text-center text-white">Đang mở đấu trường… / Opening the arena…</p> });

/** Mode copy: what each game really asks of the learner (no invented mechanic). */
const MODES: Record<KingMode, { vi: string; en: string; tagVi: string; tagEn: string; copyVi: string; copyEn: string; chips: [string, string][]; icon: typeof Zap }> = {
  REFLEX: { vi: 'Phản xạ', en: 'Reflex', tagVi: 'Rèn phản xạ', tagEn: 'Quick thinking', icon: Zap,
    copyVi: 'Tối đa 13 câu trong 90 giây. Chính tả, từ loại, đồng nghĩa, kết hợp từ — trả lời trước khi đồng hồ khép lại.',
    copyEn: 'Up to 13 questions in 90 seconds. Spelling, word class, synonyms, collocations — answer before the clock closes.',
    chips: [['Nhanh tay', 'Fast hands'], ['Mỗi câu một lượt', 'One try each']] },
  EXPLAIN: { vi: 'Giải nghĩa', en: 'Meaning', tagVi: 'Hiểu sâu từ vựng', tagEn: 'Deep vocabulary', icon: BookOpenText,
    copyVi: 'Một từ bí mật hiện dần qua những gợi ý tiếng Anh. Đoán đúng càng sớm, điểm càng cao.',
    copyEn: 'A hidden word revealed through English clues. The sooner you find it, the more you score.',
    chips: [['Gợi ý tiếng Anh', 'English clues'], ['Đổi vai khi đấu', 'Swap roles in duels']] },
  REORDER: { vi: 'Xâu chuỗi', en: 'Sentence Chain', tagVi: 'Kết nối cấu trúc', tagEn: 'Sentence logic', icon: Layers3,
    copyVi: 'Kéo, thả và sắp xếp các cụm từ thành một câu tiếng Anh hoàn chỉnh, đúng cấu trúc.',
    copyEn: 'Drag, drop and reorder chunks into one complete, well-formed English sentence.',
    chips: [['Kéo thả', 'Drag and drop'], ['Cấu trúc câu', 'Sentence structure']] },
  CONQUEST: { vi: 'Soán ngôi', en: 'Crown Conquest', tagVi: 'Thử thách ngôi vương', tagEn: 'Throne challenge', icon: Hexagon,
    copyVi: 'Nối chữ trên bàn 4 × 4 đến 7 × 7 thành từ, chiếm lãnh thổ và giành ô ngai vàng ở trung tâm.',
    copyEn: 'Link letters on a 4 × 4 to 7 × 7 board into words, capture territory and take the central throne.',
    chips: [['Chiến thuật', 'Strategy'], ['Chiếm ô', 'Capture tiles']] },
};
const FLOWS: Record<PlayFlow, { vi: string; en: string; descVi: string; descEn: string }> = {
  SOLO: { vi: 'Tự luyện', en: 'Solo', descVi: 'Một mình, theo nhịp của bạn.', descEn: 'On your own, at your pace.' },
  ECHO: { vi: 'Đấu Echo', en: 'Echo duel', descVi: 'Thi cùng Echo theo cấp độ bạn chọn.', descEn: 'Race Echo at the level you choose.' },
  QUICK_MATCH: { vi: '1v1', en: '1v1', descVi: 'Ghép với người đang chờ cùng chế độ.', descEn: 'Paired with a player waiting in the same mode.' },
  PRIVATE_ROOM: { vi: 'Tạo / Vào phòng', en: 'Create / Join room', descVi: 'Mời bạn bè bằng mã phòng 8 ký tự.', descEn: 'Invite a friend with an 8-character code.' },
};
/** Soán ngôi boards (owner 2026-10-29); the clocks are the server's (`config.conquestSizes`), these are the defaults. */
const BOARD_SIZES: { size: number; vi: string; en: string; ms: number }[] = [
  { size: 4, vi: 'Dễ', en: 'Easy', ms: 120_000 }, { size: 5, vi: 'Trung bình', en: 'Normal', ms: 180_000 },
  { size: 6, vi: 'Khó', en: 'Hard', ms: 270_000 }, { size: 7, vi: 'Siêu khó', en: 'Expert', ms: 360_000 }];
const clock = (ms: number, vi: boolean) => { const m = Math.floor(ms / 60_000), s = Math.round(ms % 60_000 / 1000); return vi ? `${m} phút${s ? ` ${s} giây` : ''}` : `${m} min${s ? ` ${s} s` : ''}`; };
/** The last board size picked in this tab (kept while the learner moves between the lobby and the arena). */
let rememberedSize = 5;
const ECHO_LEVELS: [string, string, string][] = [['EASY', 'Dễ', 'Easy'], ['MEDIUM', 'Vừa', 'Medium'], ['HARD', 'Khó', 'Hard'], ['KING', 'Vua', 'King']];

function Segmented<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (value: T) => void }) {
  const id = useId();
  return <div className={styles.setting}>
    <span className={styles.settingLabel} id={id}>{label}</span>
    <div role="radiogroup" aria-labelledby={id} className={styles.segmented}>
      {options.map(([key, text]) => <button key={String(key)} type="button" role="radio" aria-checked={value === key} className={styles.segment} onClick={() => onChange(key)}>{text}</button>)}
    </div>
  </div>;
}

export function KingGame() {
  const { locale } = useLanguage(); const vi = locale === 'vi';
  const [mode, setMode] = useState<KingMode>('REFLEX');
  const [championship, setChampionship] = useState(false);
  const [flow, setFlow] = useState<PlayFlow>('SOLO');
  const [playing, setPlaying] = useState(false);
  const [size, setSizeState] = useState(rememberedSize);
  const setSize = (value: number) => { rememberedSize = value; setSizeState(value); };
  const [length, setLength] = useState(10), [difficulty, setDifficulty] = useState(0), [bot, setBot] = useState('MEDIUM'), [joinCode, setJoinCode] = useState('');
  const [sessionLaunch, setSessionLaunch] = useState<KingLaunch | null>(null);
  const launch = useRef<HTMLButtonElement>(null);
  const hero = useRef<HTMLElement>(null);
  const returning = useRef(false);
  const [capability, setCapability] = useState<KingCapability | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    apiClient.get('/king-of-english/config', {signal:controller.signal}).then(response => {if(!controller.signal.aborted)setCapability(response.data);}).catch(() => {if(!controller.signal.aborted)setCapability(null);});
    return () => controller.abort();
  }, []);
  const localPreview = capability?.playEnabled === true;
  const allModes = KING_MODES.every(key => modeAvailable(capability, key));
  const playable = isPlayable(mode, flow, localPreview) && (championship ? allModes : modeAvailable(capability, mode));
  useEffect(() => {
    const room = new URLSearchParams(window.location.search).get('room');
    if (localPreview && room && /^[A-F0-9]{8}$/.test(room)) {
      setSessionLaunch({ mode: 'REORDER', flow: 'PRIVATE_ROOM', length: 10, difficulty: 0, bot: 'MEDIUM', recover: true });
      setPlaying(true);
    }
  }, [localPreview]);
  const returnToLobby = () => {
    returning.current = true;
    const url = new URL(window.location.href);
    url.searchParams.delete('room');
    window.history.replaceState(window.history.state, '', url);
    setPlaying(false);
  };
  useEffect(() => { if (!playing && returning.current) { launch.current?.focus({ preventScroll: true }); returning.current = false; } }, [playing]);
  // A gentle parallax on the hero art for a fine pointer; CSS variables only, no listener or render per move.
  const tilt = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType !== 'mouse' || !hero.current || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const box = hero.current.getBoundingClientRect();
    hero.current.style.setProperty('--px', ((event.clientX - box.left) / box.width - 0.5).toFixed(3));
    hero.current.style.setProperty('--py', ((event.clientY - box.top) / box.height - 0.5).toFixed(3));
  };
  const modeName = (key: KingMode) => vi ? MODES[key].vi : MODES[key].en;
  const chosen = championship ? (vi ? 'Đại Chiến 4 Vòng' : 'Four-Round Championship') : modeName(mode);
  const showDifficulty = championship || mode !== 'CONQUEST';
  const showSize = !championship && mode === 'CONQUEST';
  const sizes = BOARD_SIZES.map(b => ({ ...b, ms: capability?.conquestSizes?.find(x => x.size === b.size)?.ms ?? b.ms }));
  const start = () => { if (playable) { setSessionLaunch({ mode: championship ? 'CHAMPIONSHIP' : mode, flow, length, difficulty, bot, joinCode: flow === 'PRIVATE_ROOM' ? joinCode || undefined : undefined, size: showSize ? size : undefined }); setPlaying(true); } };
  if (playing && sessionLaunch) return <KingArena vi={vi} launch={sessionLaunch} onQuit={returnToLobby} />;
  return <KingShell vi={vi}>
    <section ref={hero} className={styles.hero} aria-labelledby="king-title" onPointerMove={tilt}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className={`${styles.heroArt} ${styles.heroNight}`} src={KING_ART.hero} alt="" aria-hidden="true" width={2560} height={1080} fetchPriority="high" decoding="async" />
      {/* Same Blender scene, with daylight sky, lighting and reflections. CSS follows the existing root theme before hydration. */}
      <img className={`${styles.heroArt} ${styles.heroDay}`} src={KING_ART.heroDay} alt="" aria-hidden="true" width={2560} height={1080} fetchPriority="high" decoding="async" />
      <div className={styles.heroScrim} aria-hidden="true" />
      <div className={styles.heroCopy}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className={styles.heroCrown} src={KING_ART.crown} alt="" aria-hidden="true" width={320} height={256} />
        <p className={styles.eyebrow}>English Coach · Games</p>
        <h1 id="king-title" className={styles.wordmark}><span className={styles.wmTop}>KING OF</span><span className={styles.wmMain}>ENGLISH</span></h1>
        <p className={styles.tagline}>Words · Wit · Mastery</p>
        <span className={styles.viBadge}><Crown className="h-4 w-4" aria-hidden="true" />Vua Tiếng Anh</span>
        <p className={styles.heroLead}>{vi ? 'Bốn thử thách, một vương miện. Thử tài từ vựng, cấu trúc câu và chiến thuật — mỗi câu trả lời đều để lại một điều đáng nhớ.' : 'Four challenges, one crown. Test your vocabulary, sentence sense and strategy — every answer leaves you something to remember.'}</p>
        <div className={styles.heroFacts}>
          <span className={styles.heroFact}><Layers3 aria-hidden="true" />{vi ? '4 chế độ chơi' : '4 game modes'}</span>
          <span className={styles.heroFact}><Users aria-hidden="true" />{vi ? 'Tự luyện · Echo · 1v1 · Phòng riêng' : 'Solo · Echo · 1v1 · Private room'}</span>
          <span className={styles.heroFact}><Crown aria-hidden="true" />{vi ? 'Đại Chiến 4 Vòng' : 'Four-Round Championship'}</span>
        </div>
      </div>
    </section>

    <section aria-labelledby="king-mode-heading" className={styles.section}>
      <header className={styles.sectionHead}><span className={styles.step} aria-hidden="true">01</span><h2 id="king-mode-heading" className={styles.sectionTitle}>{vi ? 'Chọn thử thách' : 'Choose a challenge'}</h2>
        <p className={styles.sectionHint}>{vi ? 'Mỗi chế độ là một vùng đất riêng của vương quốc.' : 'Every mode is its own land of the kingdom.'}</p></header>
      <div className={styles.modeGrid}>
        {KING_MODES.map(key => { const M = MODES[key]; const Icon = M.icon; const available = modeAvailable(capability, key); return (
          <button key={key} type="button" data-king-mode={key} data-mode={key.toLowerCase()} aria-pressed={!championship && mode === key} disabled={!available}
            onClick={() => { setMode(key); setChampionship(false); }} className={styles.modeCard}>
            <KingArtwork mode={key} className={styles.modeArt} eager />
            <span className={styles.modeShade} aria-hidden="true" />
            <span className={styles.modeTag}><Icon aria-hidden="true" />{vi ? M.tagVi : M.tagEn}</span>
            <span className={styles.modeCheck} aria-hidden="true"><Check className="h-4 w-4" /></span>
            <span className={styles.modeBody}>
              <strong className={styles.modeName}>{modeName(key)}</strong>
              <span className={styles.modeCopy}>{vi ? M.copyVi : M.copyEn}</span>
              <span className={styles.modeChips}>{M.chips.map(([cv, ce]) => <span key={cv} className={styles.modeChip}>{vi ? cv : ce}</span>)}</span>
              {capability && !available && <span className={styles.modeUnavailable}>{vi ? 'Chưa có nội dung khả dụng' : 'No available content'}</span>}
            </span>
          </button>); })}
      </div>
      <button type="button" aria-pressed={championship} onClick={() => setChampionship(true)} disabled={!allModes} className={styles.champ}>
        <span className={styles.champIcon} aria-hidden="true"><Crown /></span>
        <span><span className={styles.champTitle}>{vi ? 'Đại Chiến 4 Vòng' : 'Four-Round Championship'}</span>
          <span className={styles.champCopy}>{vi ? 'Chinh phục cả bốn thử thách trong một trận. Mỗi vòng tối đa 100 điểm, tổng 400.' : 'Conquer all four challenges in one match. Up to 100 points a round, 400 in all.'}</span></span>
        <span className={styles.champPath} aria-hidden="true">{KING_MODES.map((key, index) => <span key={key} className="contents"><span className={`${styles.champNode} ${styles.flowAccent}`} data-mode={key.toLowerCase()}><b>{index + 1}</b>{modeName(key)}</span>{index < 3 && <span className={styles.champArrow}>›</span>}</span>)}</span>
      </button>
    </section>

    <section aria-labelledby="king-flow-heading" className={styles.section}>
      <header className={styles.sectionHead}><span className={styles.step} aria-hidden="true">02</span><h2 id="king-flow-heading" className={styles.sectionTitle}>{vi ? 'Chọn cách chơi' : 'Choose how to play'}</h2>
        <p className={styles.sectionHint}>{vi ? 'Đang chọn' : 'Selected'}: <strong>{chosen}</strong></p></header>
      <div className={styles.flowGrid}>
        {PLAY_FLOWS.map(key => <button type="button" key={key} aria-pressed={flow === key} onClick={() => setFlow(key)} className={styles.flowCard}>
          <span className={styles.flowIcon} aria-hidden="true">{key === 'ECHO' ? <BrandWhaleIcon size="sm" character="tech" /> : key === 'SOLO' ? <User /> : key === 'QUICK_MATCH' ? <Swords /> : <Link2 />}</span>
          <span className={styles.flowTitle}>{vi ? FLOWS[key].vi : FLOWS[key].en}</span>
          <span className={styles.flowDesc}>{vi ? FLOWS[key].descVi : FLOWS[key].descEn}</span>
          <span className={styles.flowCheck} aria-hidden="true" />
        </button>)}
      </div>
      {playable && showSize && <div className={styles.sizePick} role="radiogroup" aria-label={vi ? 'Kích thước bàn' : 'Board size'}>
        {sizes.map(b => <button key={b.size} type="button" role="radio" aria-checked={size === b.size} onClick={() => setSize(b.size)} className={styles.sizeCard}>
          <span className={styles.sizeGlyph} style={{ ['--n' as string]: b.size }} aria-hidden="true">{Array.from({ length: b.size * b.size }, (_, i) => <i key={i} />)}</span>
          <span className={styles.sizeName}>{b.size} × {b.size}</span>
          <span className={styles.sizeLevel}>{vi ? b.vi : b.en}</span>
          <span className={styles.sizeTime}>{clock(b.ms, vi)}</span>
        </button>)}
      </div>}
      {playable && (showDifficulty || flow === 'ECHO' || flow === 'PRIVATE_ROOM') && <div className={styles.settings}>
        {flow === 'SOLO' && mode === 'REORDER' && !championship && <Segmented label={vi ? 'Số câu' : 'Session length'} value={length} options={[5, 10, 15, 20].map(n => [n, String(n)] as [number, string])} onChange={setLength} />}
        {showDifficulty && <Segmented label={vi ? 'Độ khó tối đa' : 'Maximum difficulty'} value={difficulty} options={[[0, vi ? 'Trộn' : 'Mixed'], ...[1, 2, 3, 4, 5].map(n => [n, String(n)] as [number, string])]} onChange={setDifficulty} />}
        {flow === 'ECHO' && <Segmented label={vi ? 'Cấp độ Echo' : 'Echo level'} value={bot} options={ECHO_LEVELS.map(([key, v, e]) => [key, vi ? v : e] as [string, string])} onChange={setBot} />}
        {flow === 'PRIVATE_ROOM' && <label className={styles.setting}><span className={styles.settingLabel}>{vi ? 'Mã phòng' : 'Room code'}</span>
          <input maxLength={8} value={joinCode} placeholder={vi ? 'Để trống để tạo phòng' : 'Blank to create'} aria-describedby="king-room-note" onChange={e => setJoinCode(e.target.value.toUpperCase().replace(/[^A-F0-9]/g,''))} className={styles.roomInput} />
          <span id="king-room-note" className={styles.settingNote}>{vi ? 'Nhập mã 8 ký tự bạn được mời để vào phòng; để trống để tạo phòng mới. Cả hai cùng bấm Sẵn sàng để bắt đầu.' : 'Enter the 8-character code you were invited with; leave blank to create a new room. Both players press Ready to begin.'}</span></label>}
      </div>}
    </section>

    <div className={styles.launch}>
      <div className={styles.launchSummary}>
        <p className={styles.launchPick}>{chosen}<span>·</span>{vi ? FLOWS[flow].vi : FLOWS[flow].en}{showDifficulty && <><span>·</span>{difficulty === 0 ? (vi ? 'Độ khó trộn' : 'Mixed difficulty') : `${vi ? 'Độ khó tối đa' : 'Max difficulty'} ${difficulty}`}</>}{showSize && <><span>·</span>{size} × {size} · {clock(sizes.find(b => b.size === size)?.ms ?? 180_000, vi)}</>}</p>
        <p role="status" aria-live="polite" id="king-availability" className={styles.launchStatus}>{availabilityMessage(capability, playable, vi)}</p>
      </div>
      <button ref={launch} type="button" disabled={!playable || (flow === 'PRIVATE_ROOM' && !!joinCode && joinCode.length !== 8)} aria-describedby="king-availability" onClick={start} className={`${styles.cta} min-h-12`}>
        <Play aria-hidden="true" />{flow === 'PRIVATE_ROOM' ? (joinCode ? (vi ? 'Vào phòng' : 'Join room') : (vi ? 'Tạo phòng' : 'Create room')) : flow === 'QUICK_MATCH' ? (vi ? 'Tìm đối thủ' : 'Find an opponent') : (vi ? 'Bắt đầu' : 'Start')}<ArrowRight aria-hidden="true" />
      </button>
    </div>
    {capability?.attribution && <div className={styles.credits}>
      <p>Wiktionary contributors / Wiktextract. Phrase content adapted under <a href="https://creativecommons.org/licenses/by-sa/4.0/">CC BY-SA 4.0</a>. Other sources and notices accompany the corpus artifact. Echo whale model: CC BY 4.0.</p>
      <details><summary>{vi ? 'Nguồn và giấy phép nội dung' : 'Content sources and licenses'}</summary><pre>{capability.attribution}</pre></details>
    </div>}
  </KingShell>;
}
