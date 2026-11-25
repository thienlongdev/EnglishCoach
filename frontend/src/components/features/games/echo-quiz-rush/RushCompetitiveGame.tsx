'use client';
import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { ArrowLeft, Bot, CircleHelp, Copy, Crown, Flag, Play, RotateCcw, Snowflake, Swords, Timer, Repeat2, VolumeX, Volume2, Users, Zap } from 'lucide-react';
import { BrandWhaleIcon } from '@/components/common/BrandWhaleIcon';
import { useLanguage } from '@/context/LanguageContext';
import type { RushConfig, RushSetup } from '@/types/quizRush';
import type { CompetitiveMode } from '@/types/quizRushCompetitive';
import type { SceneHandle, SceneHud, WorldAudio } from './RushScene';
import { RushHowTo } from './RushHowTo';
import { coreSkills, tacticSkills, type SkillId } from './rushSkills';
import { hazardFor } from './rushTrials';
import { REFORGED, hazardsAt } from './rushReforged';
import { RUSH_INITIAL_HUD, orbText } from './rushHudState';
import { useRushCompetition } from './useRushCompetition';
import { RushAudio } from './rushAudio';
import { rushTopicLabel } from './rushTopics';
import { createRush, finishLine, gateCenter, SKYBOUND, wallAt } from './rushModel';
import { rushSourceLinks } from './rushSourceLinks';
import { enterRushFullscreen, leaveRushFullscreen } from './rushFullscreen';
import { RushHeroPicker } from './RushHeroPicker';
import { RushFullscreenButton } from './RushFullscreenButton';
import type { RushHero } from './sky/skyCharacter';
import { RushHud, familyLabels, type HudFeedback } from './RushHud';
import { quizRushApi } from '@/services/quizRushApi';
import type { CompetitiveState } from '@/types/quizRushCompetitive';
import './rush.css';

const Scene = dynamic(() => import('./RushScene'), { ssr: false });
const Attract = dynamic(() => import('./RushAttract'), { ssr: false });
const skills = [{ id: 'ICE_LOCK', vi: 'Khóa băng', en: 'Ice Lock', Icon: Snowflake }, { id: 'TIME_SNARE', vi: 'Bẫy thời gian', en: 'Time Snare', Icon: Timer }, { id: 'POSITION_SWAP', vi: 'Đổi vị trí', en: 'Position Swap', Icon: Repeat2 }];
const time = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s)) % 60).padStart(2, '0')}`;
const initialHud: SceneHud = RUSH_INITIAL_HUD;
const errorText: Record<string, [string, string]> = {
  READING_PROTECTED: ['Đổi vị trí dùng sau khi đọc câu hỏi và trước khi cổng xuất hiện.', 'Swap after reading the question, before the doors appear.'],
  HOST_REMOVED: ['Chủ phòng đã mời bạn ra. Bạn có thể chọn cuộc đua mới.', 'The host removed you. You can choose another race.'],
  CONNECTION_LOST: ['Mất kết nối. Echo đang kết nối lại; cuộc đua vẫn tiếp tục.', 'Connection lost. Reconnecting; the race clock continues.'],
  CONNECTION_TIMEOUT: ['Chưa kết nối được. Nhấn thử lại.', 'Connection timed out. Retry to reconnect.'], AUTH_REQUIRED: ['Cần đăng nhập lại để kết nối.', 'Sign in again to connect.'],
  REQUEST_TIMEOUT: ['Chưa có xác nhận. Thử lại gửi cùng yêu cầu an toàn.', 'No acknowledgement yet. Retry sends the same safe request.'],
  SESSION_REPLACED: ['Cuộc đua đã mở ở tab khác. Đóng tab kia rồi kết nối lại.', 'This racer is controlled by another tab. Close it and reconnect.'],
  ROOM_NOT_FOUND: ['Phòng không tồn tại, đã hết hạn hoặc bạn không thuộc phòng.', 'Room unavailable, expired or not yours.'],
  ROOM_FULL: ['Phòng đã đủ năm người.', 'The room already has five racers.'], NOT_READY: ['Cần ít nhất hai người, tất cả sẵn sàng.', 'At least two connected, ready racers are required.'],
  HOST_ONLY: ['Chỉ chủ phòng thực hiện được thao tác này.', 'Only the host can do that.'], NO_CHARGE: ['Mở một cổng đúng để nhận lượt kỹ năng.', 'Open a correct gate to earn a tactical charge.'],
  COOLDOWN: ['Kỹ năng đang hồi.', 'That ability is cooling down.'], TARGET_PROTECTED: ['Đối thủ đang có bảo vệ.', 'That racer is protected.'], GATE_PROTECTED: ['Không dùng kỹ năng sát cổng.', 'Abilities are protected near gates.'],
  TARGET_OUT_OF_RANGE: ['Chọn người ở cùng chặng và cách tối đa 600 đơn vị.', 'Choose a racer on the same checkpoint within 600 units.'],
  ABILITY_UNAVAILABLE: ['Kỹ năng chỉ dùng khi cả hai đang chạy.', 'Both racers must be running to use that ability.'],
  RATE_LIMITED: ['Thao tác quá nhanh. Đợi một nhịp rồi thử lại.', 'Too many commands. Wait briefly and retry.'],
  ALREADY_IN_ROOM: ['Bạn vẫn đang ở một cuộc đua khác — Echo đưa bạn trở lại đó. Rời phòng ấy để chọn cuộc đua mới.', 'You still belong to another race — Echo takes you back to it. Leave it to choose a new race.'],
  CONTENT_CHANGED: ['Nguồn câu hỏi đã thay đổi. Trở về để tạo lượt mới.', 'Question source changed. Return to start a new race.'],
  ROOM_UNAVAILABLE: ['Chưa thể lưu phòng. Thử lại sau.', 'The room could not be saved. Please retry.'],
  HAZARD_PROTECTED: ['Không dùng chiến thuật khi bạn hoặc đối thủ đang ở gần chướng ngại.', 'Tactics are blocked while you or the target are at an obstacle.'],
};
const modeName = (m: CompetitiveMode, vi: boolean) => m === 'BOTS' ? (vi ? 'Echo Bots' : 'Echo Bots') : m === 'QUICK' ? 'Quick Match' : vi ? 'Phòng riêng' : 'Private Room';

export default function RushCompetitiveGame({ config, onSolo, initialMode = 'BOTS', hero = 'LYRA', avatar = '', onHero }: { avatar?: string; config: RushConfig | null; onSolo: () => void; initialMode?: CompetitiveMode; hero?: RushHero; onHero?: (hero: RushHero) => void }) {
  const { locale } = useLanguage(), vi = locale === 'vi', t = (a: string, b: string) => vi ? a : b;
  const game = useRushCompetition(hero, avatar), s = game.state, own = s?.players.find(p => p.id === s.you);
  const [mode, setMode] = useState<CompetitiveMode>(initialMode), [setup, setSetup] = useState<RushSetup>({ difficulty: 'EASY', topic: 'MIXED', checkpoints: 8 });
  const [level, setLevel] = useState('MEDIUM'), [code, setCode] = useState(''), [target, setTarget] = useState(''), [muted, setMuted] = useState(false), [volume, setVolume] = useState(.32), [reduced, setReduced] = useState(false), [copied, setCopied] = useState(false), [menu, setMenu] = useState(false), [tactics, setTactics] = useState(false);
  const [audioRevision, setAudioRevision] = useState(0), [hud, setHud] = useState(initialHud), [ready, setReady] = useState(false), [webgl, setWebgl] = useState(true);
  const [feedback, setFeedback] = useState<HudFeedback | null>(null);
  const [locked, setLocked] = useState(false);
  const [howTo, setHowTo] = useState<{ start?: () => void } | null>(null), [musicLevel, setMusicLevel] = useState(1), [effectsLevel, setEffectsLevel] = useState(1);
  const course = useRef<{ match: string; hazards: NonNullable<CompetitiveState['hazards']>; rising: boolean[]; walls: NonNullable<CompetitiveState['walls']>; orbs: NonNullable<CompetitiveState['orbs']> }>({ match: '', hazards: [], rising: [], walls: [], orbs: [] });
  const lastOrb = useRef(0);
  const handle = useRef<SceneHandle | null>(null), audio = useRef<RushAudio | null>(null), answerIds = useRef(new Map<string, string>()), lastPhase = useRef(''), lastStatus = useRef(''), lastSkill = useRef(0), feedbackKey = useRef(0), lastCount = useRef(-1);
  const [history, setHistory] = useState<CompetitiveState[]>([]);
  const say = (kind: HudFeedback['kind'], title: string, detail?: string) => setFeedback({ kind, title, detail, key: ++feedbackKey.current });
  useEffect(() => { if (s) return; const abort = new AbortController(); quizRushApi.competitiveHistory(abort.signal).then(setHistory).catch(() => {}); return () => abort.abort(); }, [s]);
  useEffect(() => { if (!menu) return; const previous = document.activeElement as HTMLElement | null; const dialog = document.querySelector<HTMLElement>('[aria-labelledby="rush-comp-menu-title"]'); const items = () => Array.from(dialog?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []); items()[0]?.focus(); const trap = (e: KeyboardEvent) => { if (e.key !== 'Tab') return; const buttons = items(), first = buttons[0], last = buttons.at(-1); if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); } }; window.addEventListener('keydown', trap); return () => { window.removeEventListener('keydown', trap); previous?.focus(); }; }, [menu]);
  useEffect(() => { audio.current = new RushAudio(); const preference = audio.current.snapshot(); setMuted(preference.muted); setVolume(preference.volume); setMusicLevel(preference.music); setEffectsLevel(preference.effects); const media = matchMedia('(prefers-reduced-motion: reduce)'), change = () => setReduced(media.matches); change(); media.addEventListener('change', change); return () => { audio.current?.dispose(); media.removeEventListener('change', change); game.inputEnabled.current = false; if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {}); }; }, [game.inputEnabled]);
  const racing = !!s && !['WAITING', 'QUEUED', 'FINISHED', 'CANCELED'].includes(s.status);
  // The course plan travels with command answers / pre-race broadcasts: keep the last one for this match.
  if (s && (s.matchId !== course.current.match || s.hazards)) {
    const same = s.matchId === course.current.match;
    course.current = { match: s.matchId, hazards: s.hazards ?? (same ? course.current.hazards : []), rising: s.rising ?? (same ? course.current.rising : []), walls: s.walls ?? (same ? course.current.walls : []), orbs: s.orbs ?? (same ? course.current.orbs : []) };
  }
  // The guide never opens by itself on a multiplayer path (invitation, room code, room creation, Quick Match, Bots,
  // rematch, reconnect): it is only ever opened from "Cách chơi". A race starting closes a guide left open.
  useEffect(() => { if (racing) setHowTo(null); }, [racing]);
  const results = !!s && ['FINISHED', 'CANCELED'].includes(s.status);
  useEffect(() => { game.inputEnabled.current = racing && !menu && !tactics && !howTo; }, [racing, menu, tactics, howTo, game.inputEnabled]);
  useEffect(() => { if (!racing) return; if (menu || tactics) audio.current?.pause(); else audio.current?.resume(); }, [racing, menu, tactics]);
  // A race never pauses, so leaving the window only lets go of the held keys (the scene does that) and quiets the sound while
  // the tab is hidden. It used to open the race menu, which switched input off: back in the window, the racer stood still
  // under a held key until "Tiếp tục điều khiển" was found.
  useEffect(() => { if (!racing) return; const back = () => { if (!document.hidden && !menu && !tactics) audio.current?.resume(); }; document.addEventListener('visibilitychange', back); return () => document.removeEventListener('visibilitychange', back); }, [racing, menu, tactics]);
  useEffect(() => {
    if (!s) return;
    if (lastStatus.current !== s.status) {
      if (['FINISHED', 'CANCELED'].includes(s.status)) {
        const me = s.players.find(p => p.id === s.you);
        if (s.status === 'FINISHED' && lastStatus.current) audio.current?.play(me?.rank === 1 ? 'victory' : 'defeat');
        audio.current?.results(); setAudioRevision(v => v + 1); leaveRushFullscreen();
      }
      if (lastStatus.current === 'COUNTDOWN' && s.status === 'RUNNING') { audio.current?.go(); audio.current?.play('go'); }
    }
    lastStatus.current = s.status;
  }, [s]);
  useEffect(() => {
    if (!s || !own) return;
    // The answer of the door the server holds this racer at, under one request id per door: kept alive (resent with that
    // id) for as long as the server still shows the racer there, so a lost message or acknowledgement never leaves them
    // standing at the wall, and the server's receipt makes every repeat the same single answer.
    const option = s.question?.options[s.personal.selected];
    if (own.phase === 'VALIDATING' && s.question && option && game.connected) {
      const key = s.matchId + ':' + s.question.id + ':' + s.personal.selected;
      let id = answerIds.current.get(key);
      if (!id) { id = crypto.randomUUID(); answerIds.current.set(key, id); if (answerIds.current.size > 64) answerIds.current.delete(answerIds.current.keys().next().value!); }
      game.ensure('answer', { questionId: s.question.id, optionId: option.id }, id);
    }
    if (lastPhase.current !== own.phase) {
      const streak = own.streak ?? 0, boost = Math.round(SKYBOUND.momentumStep * Math.min(SKYBOUND.momentumCap, streak) * 100);
      if (own.phase === 'OPENING') { audio.current?.play('correct'); if (streak >= 2) audio.current?.play('combo', streak); say('good', streak >= 2 ? t(`Chính xác! Nhịp ${streak}`, `Correct! Streak ${streak}`) : t('Chính xác! Cổng đang mở', 'Correct! The gate opens'), boost ? t(`+${boost}% tốc độ · +1 lượt kỹ năng`, `+${boost}% speed · +1 tactical charge`) : t('+1 lượt kỹ năng', '+1 tactical charge')); }
      if (own.phase === 'STUMBLE') { if (s.personal.rejected >= 0) { audio.current?.play('wrong'); say('bad', t('Cổng chưa đúng — đổi hướng, thử cửa khác', 'Not this door — steer to another'), t('Nhịp Echo đã về 0', 'Echo momentum reset')); } else { audio.current?.play('post'); say('bad', t('Va vào tường đá', 'You hit the stone'), t('Chạy vào giữa một cổng', 'Aim for the middle of a doorway')); } }
      if (own.phase === 'FINISHED') say('good', t(`Về đích · hạng ${own.rank || '—'}`, `Finished · place ${own.rank || '—'}`));
      if (own.phase === 'KNOCKED') say('bad', t('Trúng chướng ngại!', 'Hit by an obstacle!'), t('Khiên Echo bảo vệ bạn một nhịp', 'Echo shield protects you for a moment'));
      if (own.phase === 'FALLING') say('bad', t('Rơi khỏi cầu!', 'You fell!'), t('Echo đưa bạn trở lại trước chướng ngại', 'Echo brings you back before the obstacle'));
      lastPhase.current = own.phase;
    }
    if (own.skillSerial !== lastSkill.current) { if (own.lastSkill) audio.current?.play(own.lastSkill === 'ICE_LOCK' ? 'ice' : own.lastSkill === 'TIME_SNARE' ? 'snare' : 'swap'); lastSkill.current = own.skillSerial; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s, own, game.connected, game.ensure]);
  useEffect(() => {
    if (!racing || !s || !own) return;
    if (hud.phase === 'COUNTDOWN' && hud.countdown > 0 && hud.countdown !== lastCount.current) { lastCount.current = hud.countdown; audio.current?.play('count'); }
    const close = s.players.some(p => p.id !== s.you && p.connected && p.checkpoint === own.checkpoint && Math.abs(p.y - own.y) < 350);
    audio.current?.setMood({ streak: own.streak ?? 0, tension: !!s.question && hud.remaining < 900 && ['RUNNING', 'VALIDATING', 'STUMBLE'].includes(own.phase), finale: own.phase === 'FINISHING', close, rush: s.personal.rushTime > 0 });
    // A pickup the server confirmed: name it.
    if (hud.orb && hud.orb.serial !== lastOrb.current) { lastOrb.current = hud.orb.serial; const [title, detail] = orbText(hud.orb.kind, vi); say('good', title, detail); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hud, racing, s, own]);
  useEffect(() => { if (!feedback) return; const timer = setTimeout(() => setFeedback(null), 2300); return () => clearTimeout(timer); }, [feedback]);
  useEffect(() => { if (!racing) return; const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { setMenu(v => !v); if (handle.current) handle.current.input.sprint = false; } }; window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape); }, [racing]);
  const launchNow = async () => { if (mode !== 'PRIVATE') enterRushFullscreen(); await audio.current?.unlock(); audio.current?.lobby(); game.send(mode === 'BOTS' ? 'bots' : mode === 'QUICK' ? 'quick' : 'create', { setup: { ...setup, botLevel: mode === 'BOTS' ? level : null } }); };
  const launch = launchNow;
  /** A room code (6 characters, any case, spaces / dashes ignored), an invitation (32 hex) or a pasted invitation link. */
  const joinKey = (value: string) => {
    const link = /rushInvite=([a-f0-9]{32})/i.exec(value)?.[1] ?? (/^\s*[a-f0-9]{32}\s*$/i.test(value) ? value.trim() : '');
    if (link) return link.toLowerCase();
    const code = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    return /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/.test(code) ? code : '';
  };
  const join = () => { const key = joinKey(code); if (key) game.send('join', { invitation: key }); };
  const [copiedCode, setCopiedCode] = useState(false);
  const copyCode = async () => { if (!s?.code) return; try { await navigator.clipboard.writeText(s.code); setCopiedCode(true); } catch { setCopiedCode(false); } };
  const boost = (name: 'dash' | 'rush') => { if (s && ['RUNNING', 'FINISHING'].includes(s.status) && own?.phase === 'RUNNING' && game.connected) game.send(name); };
  const toggleAudio = async () => { const value = !muted; setMuted(value); audio.current?.setMuted(value); if (!value) { await audio.current?.unlock(); if (racing) audio.current?.startRace(); else audio.current?.lobby(); audio.current?.play('ui'); } };
  const hold = (direction: number) => { if (handle.current) { handle.current.input.horizontal = direction; handle.current.input.target = null; } };
  // Version 6: an answer chip only marks its door; nobody is steered automatically.
  const steer = (lane: number) => { if (!handle.current || !s?.question) return; if (hud.reforged) handle.current.aim(hud.marked === lane ? -1 : lane); else handle.current.input.target = gateCenter(lane, s.question.options.length); };
  const moveStick = (h: number, f: number) => handle.current?.setMove(h, f);
  const invite = s?.invitation ? `${location.origin}/games/echo-quiz-rush?rushInvite=${s.invitation}` : '';
  const copy = async () => { try { await navigator.clipboard.writeText(invite); setCopied(true); } catch { setCopied(false); } };
  const peers = s?.players.filter(p => p.id !== s.you && p.connected && p.phase === 'RUNNING') ?? [];
  const selected = peers.find(p => p.id === target) ?? peers[0];
  const leave = () => { if (game.send('leave')) { audio.current?.stopRace(); leaveRushFullscreen(); setTactics(false); game.inputEnabled.current = false; setMenu(false); setReady(false); } };
  const errors = game.error && (errorText[game.error]?.[vi ? 0 : 1] ?? t('Thao tác chưa được chấp nhận. Kiểm tra phòng và thử lại.', 'The command was not accepted. Check the room and retry.'));
  const standings = s ? [...s.players].sort((a, b) => (a.rank || 99) - (b.rank || 99) || b.y - a.y) : [];
  const audioState = audio.current?.snapshot(); void audioRevision;
  const model = s ? createRush(s.total, 0, 3, s.spacing ?? 1100, s.courseVersion ?? 1, s.boundaries ?? []) : null;
  const walls = model ? Array.from({ length: model.total }, (_, i) => wallAt(model, i)) : [];
  const swapRoom = s && s.courseVersion >= REFORGED.version ? 400 : 1700;
  const swapBlocked = (id: string) => id === 'POSITION_SWAP' && !!s && !!own && s.courseVersion >= 2 && (s.personal.phaseTime < 2.5 || wallAt(model!, own.checkpoint) - own.y <= swapRoom || !!selected && wallAt(model!, selected.checkpoint) - selected.y <= swapRoom);
  // Tactics target: the chosen rival, else the nearest one the rules allow (same checkpoint, within 600, no obstacle).
  const nearObstacle = (cp: number, y: number) => (s && s.courseVersion >= REFORGED.version ? hazardsAt(course.current.hazards, cp) : [hazardFor(course.current.hazards, cp)]).some(h => !!h && y > h.from - 450 && y < h.to + 140);
  const validTarget = (p: { checkpoint: number; y: number }) => !!own && p.checkpoint === own.checkpoint && Math.abs(p.y - own.y) <= 600 && !nearObstacle(p.checkpoint, p.y);
  const autoTarget = selected && validTarget(selected) ? selected : [...peers].filter(validTarget).sort((a, b) => Math.abs(a.y - (own?.y ?? 0)) - Math.abs(b.y - (own?.y ?? 0)))[0];
  const tacticBlock = (id: SkillId) => {
    if (!s || !own || own.phase !== 'RUNNING' || !game.connected) return t('Chỉ dùng khi đang chạy', 'Only while running');
    if (!autoTarget) return t('Chưa có đối thủ hợp lệ ở gần (cùng chặng, trong 600)', 'No valid rival nearby (same checkpoint, within 600)');
    if (nearObstacle(own.checkpoint, own.y)) return t('Không dùng gần chướng ngại', 'Not near an obstacle');
    if (swapBlocked(id)) return t('Đổi vị trí dùng sau khi đọc câu hỏi và trước khi cổng xuất hiện', 'Swap after reading, before the doors appear');
    return null;
  };
  const runningNow = !!s && ['RUNNING', 'FINISHING'].includes(s.status) && own?.phase === 'RUNNING' && game.connected && !game.pending && !menu;
  const skillViews = s ? [...coreSkills(vi, { trials: hud.trials, running: runningNow, airborne: hud.airborne, stamina: s.personal.stamina, sprinting: hud.skill === 'SPRINT', dashCooldown: s.personal.dashCooldown,
    dashing: s.personal.dashTime > 0, energy: s.personal.energy, rushing: s.personal.rushTime > 0, dodgeCooldown: hud.dodge, reforged: hud.reforged }),
    ...(s.players.length > 1 ? tacticSkills(vi, s.personal.charges, s.personal.cooldowns, s.elapsed, tacticBlock) : [])] : [];
  const useSkill = (id: SkillId) => {
    const h = handle.current;
    if (id === 'jump') h?.jump(); else if (id === 'dodge') h?.dodge(h.input.horizontal || undefined);
    else if (id === 'sprint') { if (h) h.input.sprint = true; }
    else if (id === 'dash' || id === 'rush') boost(id);
    else if (autoTarget && game.send('skill', { skill: id, targetId: autoTarget.id })) audio.current?.play('ui');
  };
  const releaseSkill = (id: SkillId) => { if (id === 'sprint' && handle.current) handle.current.input.sprint = false; };
  const deny = () => audio.current?.play('deny');
  // Tactics keys (the movement keys live in RushScene): Z Ice Lock · X Time Snare · C Position Swap.
  useEffect(() => {
    if (!racing) return;
    const keys = (e: KeyboardEvent) => {
      if (e.repeat || menu || (e.target instanceof HTMLElement && e.target.closest('input,select,[role="dialog"]'))) return;
      const id = ({ KeyZ: 'ICE_LOCK', KeyX: 'TIME_SNARE', KeyC: 'POSITION_SWAP' } as Record<string, SkillId>)[e.code];
      if (!id) return;
      const skill = skillViews.find(v => v.id === id);
      if (!skill) return;
      e.preventDefault(); if (skill.ready) useSkill(id); else deny();
    };
    window.addEventListener('keydown', keys); return () => window.removeEventListener('keydown', keys);
  });

  return <div className="rush-root rush-competitive" data-screen={racing ? 'COMPETITIVE_RACE' : results ? 'COMPETITIVE_RESULTS' : s ? 'COMPETITIVE_LOBBY' : 'COMPETITIVE_MENU'} data-audio-context={audioState?.state ?? 'locked'} data-audio-active={audioState?.active ? 'true' : 'false'} data-audio-paused={audioState?.paused ? 'true' : 'false'} data-audio-muted={muted ? 'true' : 'false'} data-audio-volume={volume} data-audio-output={audioState?.output.toFixed(5) ?? '0'} data-audio-nodes={audioState?.nodes ?? 0} data-audio-scene={audioState?.scene ?? 'off'}>
    {!(s && (racing || results)) && <div className="rush-sky-backdrop">{webgl && <Attract reduced={reduced} hero={hero} avatar={avatar} onFailed={() => setWebgl(false)} />}</div>}
    {!racing && <header className="rush-topbar"><Link href="/games" className="rush-back"><ArrowLeft size={18} /><span>{t('Thư viện trò chơi', 'Games Library')}</span></Link>
      <div className="rush-top-actions"><span className="rush-connection" role="status">{game.connected ? t('Đã kết nối', 'Connected') : t('Đang kết nối', 'Connecting')}{game.rtt !== null && game.connected ? ` · ${Math.round(game.rtt)}ms` : ''}</span><button aria-label={t('Bật/tắt âm thanh', 'Toggle sound')} onClick={() => void toggleAudio()}>{muted ? <VolumeX size={18} /> : <Volume2 size={18} />}</button><RushFullscreenButton vi={vi} /></div>
    </header>}

    {!s && <main className="rush-lobby rush-comp-entry">
      <section className="rush-hero"><span className="rush-eyebrow">{t('ĐUA CÙNG NHAU · SKYBOUND', 'RACE TOGETHER · SKYBOUND')}</span><h1>{t('Cùng một câu hỏi,', 'One question,')}<br /><em>{t('mỗi người một cánh cửa', 'every racer their own door')}</em></h1>
        <p>{t('Mọi người cùng đọc một câu hỏi, nhưng thứ tự cửa của mỗi người được xáo riêng — không ai chép được đáp án. Máy chủ quyết định đúng sai, vị trí và người thắng.', 'Everyone reads the same question, but each racer’s door order is shuffled privately — nobody can copy. The server decides answers, positions and the winner.')}</p>
        <div className="rush-world-chips"><span>2–5 {t('người', 'racers')}</span><span>{t('Câu hỏi chung', 'Shared questions')}</span><span>{t('Không xếp hạng', 'Unranked')}</span></div>
        <button className="rush-text-button" onClick={onSolo}><ArrowLeft size={14} />{t('Về sảnh Echo Quiz Rush', 'Back to the Echo Quiz Rush hall')}</button></section>
      <section className="rush-panel"><span className="rush-eyebrow">{t('CHỌN CUỘC ĐUA', 'CHOOSE YOUR RACE')}</span>
        {onHero && <RushHeroPicker vi={vi} hero={hero} onChange={onHero} avatar={avatar} compact />}
        <div className="rush-comp-modes">{(['BOTS', 'QUICK', 'PRIVATE'] as const).map(m => <button key={m} aria-pressed={mode === m} onClick={() => { setMode(m); void audio.current?.unlock().then(() => audio.current?.lobby()); }}><span className="rush-mode-icon">{m === 'BOTS' ? <Bot /> : m === 'QUICK' ? <Swords /> : <Users />}</span><b>{m === 'BOTS' ? 'Echo Bots' : m === 'QUICK' ? 'Quick Match' : t('Phòng riêng', 'Private Room')}</b><small>{m === 'BOTS' ? t('Bốn Echo có nhịp đua riêng', 'Four Echo racers, real decisions') : m === 'QUICK' ? t('Ghép người chơi thật', 'Match with real players') : t('Mời bạn cùng chạy', 'Invite friends to race')}</small></button>)}</div>
        <fieldset><legend>{t('Độ khó câu hỏi', 'Question difficulty')}</legend><div className="rush-options">{(['EASY', 'MEDIUM', 'HARD'] as const).map((d, i) => <button key={d} aria-pressed={setup.difficulty === d} onClick={() => setSetup(v => ({ ...v, difficulty: d, topic: 'MIXED' }))}>{(vi ? ['Dễ', 'Vừa', 'Khó'] : ['Easy', 'Medium', 'Hard'])[i]}</button>)}</div></fieldset>
        <label>{t('Chủ đề', 'Topic')}<select aria-label={t('Chủ đề', 'Topic')} value={setup.topic} onChange={e => setSetup(v => ({ ...v, topic: e.target.value as RushSetup['topic'] }))}>{(config?.topics[setup.difficulty] ?? ['MIXED']).map(v => <option key={v} value={v}>{rushTopicLabel(v, vi)}</option>)}</select></label>
        <fieldset><legend>{t('Số cổng', 'Gates')}</legend><div className="rush-options">{[3, 8, 12, 20].map(n => <button key={n} aria-pressed={setup.checkpoints === n} onClick={() => setSetup(v => ({ ...v, checkpoints: n }))}>{n}</button>)}</div></fieldset>
        {mode === 'BOTS' && <label>{t('Nhịp của Echo', 'Echo difficulty')}<select aria-label={t('Nhịp của Echo', 'Echo difficulty')} value={level} onChange={e => setLevel(e.target.value)}>{['EASY', 'MEDIUM', 'HARD'].map((v, i) => <option key={v} value={v}>{(vi ? ['Nhẹ nhàng', 'Cân bằng', 'Thử thách'] : ['Relaxed', 'Balanced', 'Challenging'])[i]}</option>)}</select></label>}
        <button className="rush-secondary" onClick={() => setHowTo({})}><CircleHelp size={16} />{t('Cách chơi', 'How to play')}</button>
        <button className="rush-primary" disabled={!game.connected || game.pending || !config?.available} onClick={() => void launch()}><Flag size={18} />{mode === 'BOTS' ? t('Đua cùng Echo', 'Race Echo Bots') : mode === 'QUICK' ? t('Tìm cuộc đua', 'Find a race') : t('Tạo phòng', 'Create room')}</button>
        {mode === 'PRIVATE' && <form className="rush-join" onSubmit={e => { e.preventDefault(); if (game.connected && !game.pending) join(); }}><label>{t('Nhập mã phòng', 'Enter room code')}<input data-testid="rush-room-code-input" aria-label={t('Mã phòng (6 ký tự) hoặc liên kết mời', 'Room code (6 characters) or invitation link')} placeholder="7K3M8P" value={code} maxLength={200} onChange={e => setCode(e.target.value)} autoComplete="off" autoCapitalize="characters" spellCheck={false} enterKeyHint="go" /></label><button type="submit" className="rush-secondary" disabled={!game.connected || game.pending || !joinKey(code)}>{t('Vào phòng', 'Join room')}</button></form>}
        <p className="rush-service-note">{t('Mỗi người tự điều khiển nhân vật (WASD / mũi tên, Space nhảy, Ctrl né). Mở cổng đúng để nhận lượt kỹ năng: Khóa băng, Bẫy thời gian, Đổi vị trí. Đúng ngay lần đầu xây Nhịp Echo — nhanh hơn tới 20%.', 'Everyone steers their own explorer (WASD / arrows, Space jump, Ctrl dodge). Open correct gates to earn tactical charges: Ice Lock, Time Snare, Position Swap. First-try answers build Echo momentum — up to 20% faster.')}</p>{errors && <p className="rush-error" role="alert">{errors}</p>}{!game.connected && <button className="rush-secondary" onClick={game.retry}>{t('Kết nối lại', 'Reconnect')}</button>}
        {history.length > 0 && <details className="rush-match-history"><summary>{t('Cuộc đua gần đây', 'Recent races')} · {history.length}</summary>{history.map(h => { const p = h.players.find(v => v.id === h.you); return <p key={h.roomId}>{modeName(h.mode, vi)} · {p?.rank ? `#${p.rank}` : p?.phase === 'DNF' ? 'DNF' : t('Đã hủy', 'Canceled')} · {p?.checkpoint ?? 0}/{h.total}</p>; })}</details>}
      </section></main>}

    {s && !racing && !results && <main className="rush-results"><section className="rush-panel rush-room-card"><span className="rush-eyebrow">{s.mode === 'QUICK' ? 'QUICK MATCH' : t('PHÒNG RIÊNG', 'PRIVATE ROOM')}</span><h1>{s.status === 'QUEUED' ? t('Đang tìm bạn đồng hành', 'Finding fellow racers') : t('Sẵn sàng trên mây', 'Ready above the clouds')}</h1><p>{s.status === 'QUEUED' ? t('Ghép tối đa năm người có cùng cài đặt. Bắt đầu sau 10 giây khi có ít nhất hai người; chờ tối đa 90 giây.', 'Matching up to five humans with identical settings. Starts after 10 seconds with at least two; queue expires at 90 seconds.') : t('Mọi người sẵn sàng, chủ phòng bắt đầu. Lời mời hết hạn sau 15 phút.', 'Everyone readies, then the host starts. Invitations expire after 15 minutes.')}</p>
      <ol className="rush-room-players">{s.players.map(p => <li key={p.id}><span className={`rush-player-dot rush-dot-${p.id}`} /><b>{p.name}{p.id === s.you ? ` · ${t('Bạn', 'You')}` : ''}<small className="rush-player-hero">{p.hero === 'KAI' ? 'Kai' : 'Lyra'}</small></b><span>{!p.connected ? t('Mất kết nối', 'Disconnected') : p.ready ? t('Sẵn sàng', 'Ready') : t('Đang chuẩn bị', 'Preparing')}</span>{s.host && p.id !== s.you && s.mode === 'PRIVATE' && <button className="rush-text-button" disabled={game.pending} onClick={() => game.send('kick', { targetId: p.id })}>{t('Mời ra', 'Remove')}</button>}</li>)}</ol>
      {s.code && <div className="rush-room-code"><span>{t('Mã phòng', 'Room code')}</span><b data-testid="rush-room-code" aria-label={s.code.split('').join(' ')}>{s.code}</b><button className="rush-secondary" onClick={() => void copyCode()}><Copy size={16} />{copiedCode ? t('Đã sao chép mã', 'Code copied') : t('Sao chép mã', 'Copy code')}</button></div>}
      {s.invitation && <details className="rush-invitation"><summary>{t('Liên kết mời', 'Invitation link')}</summary><input readOnly aria-label={t('Liên kết mời', 'Invitation link')} value={invite} onFocus={e => e.target.select()} /><code data-testid="rush-invite-code">{s.invitation}</code><button className="rush-secondary" onClick={() => void copy()}><Copy size={16} />{copied ? t('Đã sao chép', 'Copied') : t('Sao chép liên kết', 'Copy link')}</button></details>}
      {s.mode === 'PRIVATE' && <><button className="rush-primary" disabled={game.pending || !game.connected} onClick={() => { if (!own?.ready) enterRushFullscreen(); game.send('ready', { ready: !own?.ready }); }}><Play size={18} />{own?.ready ? t('Chưa sẵn sàng', 'Not ready') : t('Tôi sẵn sàng', 'I’m ready')}</button>{s.host && <button className="rush-primary" disabled={game.pending || s.players.length < 2 || s.players.some(p => !p.ready || !p.connected)} onClick={() => { enterRushFullscreen(); game.send('start'); }}>{t('Bắt đầu cuộc đua', 'Start race')}</button>}</>}
      <button className="rush-secondary" disabled={game.pending} onClick={leave}>{s.status === 'QUEUED' ? t('Hủy tìm trận', 'Cancel queue') : t('Rời phòng', 'Leave room')}</button>{errors && <p className="rush-error" role="alert">{errors}</p>}
    </section></main>}

    {s && (racing || results) && <div className="rush-stage"><Scene key={s.matchId} hero={own?.hero ?? hero} avatar={own?.look ?? avatar} total={s.total} checkpoint={own?.checkpoint ?? 0} question={s.question} reduced={reduced} spacing={s.spacing ?? 1100} courseVersion={s.courseVersion} boundaries={s.boundaries ?? []} streak={own?.streak ?? 0}
      hazards={course.current.hazards} rising={course.current.rising} walls={course.current.walls} orbs={course.current.orbs}
      network={{ enabled: () => game.connected && game.inputEnabled.current, snapshot: game.snapshot, onInput: game.updateInput, onBoost: boost, localLabel: t('Bạn', 'You'), rtt: () => game.rttRef.current, sentAt: game.sentAt }}
      onReady={h => { handle.current = h; setReady(true); audio.current?.startRace(); if (s.status === 'RUNNING') audio.current?.go(); }} onLock={setLocked} onGate={() => {}} onNext={() => {}} onFinish={() => {}} onHud={setHud}
      onHidden={() => { if (racing && document.hidden) audio.current?.pause(); }} onWorldAudio={(event: WorldAudio, value?: number, pan?: number) => { if (event !== 'finish' && event !== 'overtake') audio.current?.world(event, value ?? 1, pan ?? 0); else if (event === 'overtake') audio.current?.play('overtake'); }}
      onAmbience={(kind, level, pan) => audio.current?.ambience(kind, level, pan)}
      onError={() => { setWebgl(false); setMenu(true); }} onObstacle={kind => { if (kind === 'sill') say('bad', t('Bệ đã quá cao!', 'The sill is out of reach!'), t('Cổng sẽ hạ xuống — chạy nhanh rồi nhảy sớm hơn', 'The gate settles — run faster and jump earlier')); }} /></div>}

    {racing && s && <main className="rush-race">
      <RushHud vi={vi} hud={hud} question={s.question} total={s.total} walls={walls} finish={model ? finishLine(model) : 1} ready={ready} feedback={feedback} validating={own?.phase === 'VALIDATING'} momentumOn={(s.courseVersion ?? 1) >= SKYBOUND.version}
        onSteer={steer} onHold={hold} onMove={moveStick} skills={skillViews} charges={s.personal.charges} onSkill={useSkill} onSkillRelease={releaseSkill} onDeny={deny}
        competitive={{ rank: hud.rank, racers: hud.racers }}
        countdown={s.status === 'COUNTDOWN' ? Math.max(1, Math.ceil(-s.elapsed)) : null} countdownCaption={t('Cùng một vạch xuất phát', 'One starting line')}
        locked={locked} onSettings={() => { setMenu(v => !v); setTactics(false); }} onHelp={() => setHowTo({})}
        corner={<><button className="rush-icon-button" aria-label={t('Menu cuộc đua', 'Race menu')} onClick={() => { setMenu(true); setTactics(false); }}><Users size={18} /></button><button className="rush-icon-button" aria-label={t('Bật/tắt âm thanh', 'Toggle sound')} aria-pressed={!muted} onClick={() => void toggleAudio()}>{muted ? <VolumeX size={18} /> : <Volume2 size={18} />}</button><RushFullscreenButton vi={vi} className="rush-icon-button" /></>}
        extra={s.players.length > 1 ? <label className="rush-target"><span>{t('Mục tiêu', 'Target')}</span><select aria-label={t('Đối thủ mục tiêu cho Chiến thuật', 'Tactics target')} value={target || ''} onChange={e => { setTarget(e.target.value); e.currentTarget.blur(); }}>
          <option value="">{t('Gần nhất', 'Nearest')}{autoTarget ? ` · ${autoTarget.name}` : ''}</option>{peers.map(p => <option key={p.id} value={p.id}>{p.id.slice(1)} · {p.name}</option>)}</select></label> : null} />
      {(own?.effect || errors || s.recovery) && <div className="rush-comp-notice" role="status">{errors || (own?.effect ? skills.find(v => v.id === own.effect)?.[vi ? 'vi' : 'en'] : s.recovery === 'SERVER_RECOVERED' ? t('Đã khôi phục mốc lưu chung; thời gian gián đoạn không tính vào cuộc đua.', 'Recovered the last shared save; server downtime is excluded.') : t('Máy chủ chưa lưu được. Cuộc đua đang chờ khôi phục.', 'Persistence interrupted. Waiting for recovery.'))}</div>}
      <div className="sr-only">{s.question?.options.map((o, i) => <button key={o.id} onClick={() => steer(i)}>{t('Chạy tới', 'Steer to')} {o.label}</button>)}</div>
      {own?.phase === 'FINISHED' && <div className="rush-comp-finish"><b>{t('Bạn đã về đích', 'You finished')} · #{own.rank}</b><span>{t('Chờ các bạn hoàn thành · tối đa 60 giây', 'Waiting for remaining racers · up to 60 seconds')}</span></div>}
      {menu && <div className="rush-pause-cover"><section className="rush-panel" role="dialog" aria-modal="true" aria-labelledby="rush-comp-menu-title"><h2 id="rush-comp-menu-title">{t('Menu cuộc đua', 'Race menu')}</h2><p>{t('Cuộc đua vẫn tiếp tục. Rời lượt sẽ ghi nhận không hoàn thành.', 'The race continues. Leaving records a DNF.')}</p><button className="rush-primary" autoFocus onClick={() => setMenu(false)}>{t('Tiếp tục điều khiển', 'Keep racing')}</button><label>{t('Âm lượng chung', 'Master volume')}<input type="range" min="0" max="1" step=".05" value={volume} onChange={e => { const value = Number(e.target.value); setVolume(value); audio.current?.setVolume(value); }} /></label>
        <label>{t('Nhạc nền', 'Music')}<input type="range" min="0" max="1" step=".05" value={musicLevel} onChange={e => { const value = Number(e.target.value); setMusicLevel(value); audio.current?.setMusic(value); }} /></label>
        <label>{t('Hiệu ứng âm thanh', 'Sound effects')}<input type="range" min="0" max="1" step=".05" value={effectsLevel} onChange={e => { const value = Number(e.target.value); setEffectsLevel(value); audio.current?.setEffects(value); }} /></label>
        <button className="rush-secondary" onClick={() => setHowTo({})}><CircleHelp size={16} />{t('Cách chơi', 'How to play')}</button><button className="rush-secondary" onClick={() => void toggleAudio()}>{muted ? t('Bật âm thanh', 'Sound on') : t('Tắt âm thanh', 'Mute')}</button><button className="rush-secondary" onClick={game.retry}>{t('Kết nối / gửi lại yêu cầu', 'Reconnect / retry command')}</button><button className="rush-secondary" onClick={leave}>{t('Rời cuộc đua', 'Leave race')}</button>{!webgl && <p className="rush-error" role="alert">{t('Thiết bị không dựng được thế giới 3D (WebGL).', 'This device could not start the 3D world (WebGL).')}</p>}</section></div>}
    </main>}

    {results && s && <main className="rush-results"><section className="rush-panel rush-result-card"><span className="rush-eyebrow">{t('KẾT QUẢ MÁY CHỦ', 'SERVER-CONFIRMED RESULTS')} · {modeName(s.mode, vi)}</span><h1>{s.status === 'CANCELED' ? t('Cuộc đua đã đóng', 'Race closed') : own?.rank === 1 ? <><Crown className="rush-trophy" />{t('Chạm mây đầu tiên!', 'First to the clouds!')}</> : t('Một hành trình cùng nhau', 'A journey together')}</h1><p>{s.reason === 'QUEUE_EXPIRED' ? t('Chưa tìm được người phù hợp trong 90 giây.', 'No compatible racer joined within 90 seconds.') : s.reason === 'HOST_LEFT' ? t('Chủ phòng đã rời trước khi bắt đầu.', 'The host left before the race began.') : own?.rank && own.rank > 1 ? t('Mỗi cổng mở đúng là một từ bạn đã nắm. Chạy lại để giành bục cao nhất!', 'Every door you opened is English you now own. Race again for the top step!') : t('Thứ hạng và thời gian do máy chủ xác nhận. Không có điểm thưởng hay xếp hạng nền tảng.', 'Placements and times are server-confirmed. No platform rewards or ranked progression.')}</p>
      <ol className="rush-podium">{standings.map(p => <li key={p.id} className={`${p.id === s.you ? 'is-you' : ''}${p.rank === 1 ? ' is-first' : ''}`}><b className="rush-result-rank">{p.rank ? `#${p.rank}` : '—'}</b><span className={`rush-player-dot rush-dot-${p.id}`} /><b>{p.name}{p.bot ? ' · Bot' : p.id === s.you ? ` · ${t('Bạn', 'You')}` : ''}</b><span>{p.finishAt >= 0 ? time(p.finishAt) : p.phase === 'DNF' ? 'DNF' : t('Đã hủy', 'Canceled')}</span></li>)}</ol>
      <div className="rush-result-stats"><div><b>{own?.checkpoint ?? 0}</b><span>{t('Cổng đã mở', 'Gates opened')}</span></div><div><b>{s.personal.mistakes}</b><span>{t('Lần thử sai', 'Wrong tries')}</span></div><div><b>{Math.round((own?.checkpoint ?? 0) / Math.max(1, (own?.checkpoint ?? 0) + s.personal.mistakes) * 100)}%</b><span>{t('Độ chính xác', 'Accuracy')}</span></div><div><b>{own && own.finishAt >= 0 ? time(own.finishAt) : own?.phase === 'DNF' ? 'DNF' : '—'}</b><span>{t('Thời gian', 'Time')}</span></div>{s.personal.bestStreak !== undefined && <div className="is-streak"><b><Zap size={18} />{s.personal.bestStreak}</b><span>{t('Chuỗi đúng dài nhất', 'Best streak')}</span></div>}</div>
      <div className="rush-review"><h2>{t('Ôn lại các cổng', 'Review your gates')}</h2>{s.review.map((q, i) => <details key={i} className={q.mistakes > 0 ? 'is-missed' : ''}><summary><span className="rush-review-index">{i + 1}</span><span>{familyLabels[q.family]?.[vi ? 0 : 1] ?? q.family}</span><b>{q.answer}</b><small>{q.mistakes > 0 ? `${q.mistakes} ${t('lần sai', 'wrong')}` : t('Đúng ngay', 'First try')}</small></summary><p>{q.prompt}</p>{q.context && <p className="rush-review-context">{q.context}</p>}{q.explanation && q.explanation !== q.context && <p>{q.explanation}</p>}{rushSourceLinks(q.sourceRefs).map(url => <p key={url}><a href={url} target="_blank" rel="noopener noreferrer" className="rush-text-button">{t('Nguồn câu hỏi', 'Question source')} · {new URL(url).hostname}</a></p>)}</details>)}</div>
      <div className="rush-result-actions">{s.status === 'FINISHED' && s.players.every(p => p.phase !== 'DNF') && <button className="rush-primary" disabled={game.pending || !game.connected} onClick={() => { enterRushFullscreen(); game.send('rematch'); }}><RotateCcw size={18} />{t('Cùng đua lại', 'Race together again')} · {s.rematchVotes}/{s.players.filter(p => !p.bot).length}</button>}
        <button className="rush-secondary" disabled={game.pending} onClick={leave}>{t('Chọn cuộc đua mới', 'Choose a new race')}</button><button className="rush-text-button" onClick={() => { leave(); onSolo(); }}>{t('Về sảnh', 'Back to the hall')}</button></div>{errors && <p className="rush-error" role="alert">{errors}</p>}
    </section></main>}
    {game.error && s && !racing && <button className="rush-comp-retry" onClick={game.retry}>{t('Thử lại', 'Retry')}</button>}
    <RushHowTo vi={vi} mode={mode === 'BOTS' ? 'bots' : 'multi'} open={!!howTo} onClose={() => setHowTo(null)} onStart={howTo?.start} startLabel={mode === 'BOTS' ? t('Đua cùng Echo', 'Race Echo Bots') : mode === 'QUICK' ? t('Tìm cuộc đua', 'Find a race') : t('Tiếp tục', 'Continue')} />
  </div>;
}
