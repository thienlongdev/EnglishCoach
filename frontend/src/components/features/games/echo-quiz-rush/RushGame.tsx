'use client';
import { useAccount } from '@/components/study-space/data';
import { useAvatarIdentity, writeIdentity } from '@/lib/avatar/identity';
import { encodeLook, normalizeLook } from '@/lib/avatar/look';
import { activeStudyCharacter } from '@/lib/study-space/api';
import type { RushHero } from './sky/skyCharacter';

import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { ArrowLeft, ArrowRight, BookOpen, Bot, CircleHelp, Flag, Pause, Play, RotateCcw, Swords, Trophy, Users, Volume2, VolumeX, Zap } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { BrandWhaleIcon } from '@/components/common/BrandWhaleIcon';
import { quizRushApi } from '@/services/quizRushApi';
import type { RushConfig, RushFeedback, RushQuestion, RushSession, RushSetup } from '@/types/quizRush';
import type { CompetitiveMode } from '@/types/quizRushCompetitive';
import type { SceneHandle, SceneHud, WorldAudio } from './RushScene';
import { RushHud, familyLabels, type HudFeedback } from './RushHud';
import { RushHowTo, howToDismissed } from './RushHowTo';
import { coreSkills, type SkillId } from './rushSkills';
import { finishLine, gateCenter, SKYBOUND, wallAt, createRush } from './rushModel';
import { TRIALS, type Hazard } from './rushTrials';
import { REFORGED, hazardLength6, orbSpot, readingLength6, type Orb, type Wall6 } from './rushReforged';
import { RUSH_INITIAL_HUD, orbText } from './rushHudState';
import { enterRushFullscreen, leaveRushFullscreen } from './rushFullscreen';
import { RushHeroPicker, useRushHero } from './RushHeroPicker';
import { RushFullscreenButton } from './RushFullscreenButton';
import { RushAudio } from './rushAudio';
import { rushTopicLabel } from './rushTopics';
import { rushSourceLinks } from './rushSourceLinks';
import './rush.css';

const Scene = dynamic(() => import('./RushScene'), { ssr: false });
const Attract = dynamic(() => import('./RushAttract'), { ssr: false });
const Competition = dynamic(() => import('./RushCompetitiveGame'), { ssr: false });
const initialHud: SceneHud = RUSH_INITIAL_HUD;
const tutorial: RushQuestion[] = [
  { id: 'tutorial-spelling', family: 'SPELLING_CHOICE', prompt: 'Choose the correctly spelled word.', context: '', options: [{ id: 'lsoe', label: 'lsoe' }, { id: 'lose', label: 'lose' }] },
  { id: 'tutorial-grammar', family: 'GRAMMAR_TRAP', prompt: 'Choose the present-tense verb that agrees with the subject.', context: 'It ___ also because they remind us of who we once were.', options: [{ id: 'are', label: 'are' }, { id: 'is', label: 'is' }] },
  { id: 'tutorial-pos', family: 'PART_OF_SPEECH', prompt: "What is the part of speech of 'broadcasters' here?", context: 'But the [broadcasters] are now pushing to hold on to the additional spectrum space.', options: [{ id: 'noun', label: 'noun' }, { id: 'verb', label: 'verb' }, { id: 'adjective', label: 'adjective' }, { id: 'adverb', label: 'adverb' }] },
];
const tutorialAnswers = ['lose', 'is', 'noun'];
/**
 * The practice course (Sân tập), Course version 7: no railing anywhere; gate 1 stands still with an orb on the way; a
 * broken bridge (beam on the right lane, an orb over the gap) leads to an advancing wall; a Spiked Roller (one log, one
 * peg per ring) leads to a timed gate. Laid out exactly like a server plan (RushReforged.plan) so it plays by the real rules.
 */
const tutorialCourse = (() => {
  const plan: (Hazard['kind'] | null)[] = [null, 'CHASM', 'ROLLER'];
  const motion: Wall6['kind'][] = ['STATIC', 'APPROACH', 'TIMED'];
  let at = 0; const walls: number[] = [], hazards: Hazard[] = [], orbs: Orb[] = [], moves: Wall6[] = [];
  plan.forEach((kind, i) => {
    const start = at;
    if (kind) {
      const from = at + REFORGED.leadIn, h: Hazard = { kind, checkpoint: i, from, to: from + hazardLength6(kind, 1), tier: 1, phase: .4, dir: 1, lane: kind === 'CHASM' ? 2 : -1, salt: 2026 };
      hazards.push(h); const o = orbSpot(h, 1); orbs.push({ id: orbs.length, kind: i === 1 ? 'ENERGY' : 'SPEED', checkpoint: i, ...o }); at = h.to + REFORGED.runout;
    } else orbs.push({ id: orbs.length, kind: 'ENERGY', checkpoint: i, x: 650, y: start + 520, z: REFORGED.body });
    const reading = readingLength6(tutorial[i]); at += reading; walls.push(at);
    const k = motion[i], travel = k === 'APPROACH' ? Math.min(reading - REFORGED.wallRoom, 420) : 0;
    moves.push({ kind: k, tier: 1, phase: 1.5, travel, rest: travel ? 2.9 : 0, advance: travel ? travel * 1.5 / 95 : 0, hold: travel ? 1.2 : 0, retreat: travel ? travel * 1.5 / 260 : 0,
      amp: 0, slidePeriod: 0, shutPeriod: k === 'TIMED' ? 3.8 : 0, openShare: k === 'TIMED' ? .62 : 0 });
  });
  return { walls, hazards, rising: moves.map(m => m.kind === 'RISING'), motion: moves, orbs };
})();
const seconds = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
const DIFFICULTY: { id: RushSetup['difficulty']; vi: [string, string]; en: [string, string] }[] = [
  { id: 'EASY', vi: ['Dễ', 'Khởi động với từ vựng quen thuộc'], en: ['Easy', 'Warm up with familiar words'] },
  { id: 'MEDIUM', vi: ['Vừa', 'Ngữ cảnh, kết hợp từ, cụm động từ'], en: ['Medium', 'Context, collocations, phrasal verbs'] },
  { id: 'HARD', vi: ['Khó', 'Thành ngữ, cách dùng tinh tế'], en: ['Hard', 'Idioms and precise usage'] },
];

export default function RushRoot() {
  const { data: auth } = useSession();
  const scope = (auth?.user as { id?: string })?.id ?? auth?.user?.email;
  return scope ? <RushGame key={scope} /> : <div className="rush-root" aria-busy="true" />;
}

function RushGame() {
  const { locale } = useLanguage(), vi = locale === 'vi';
  const [screen, setScreen] = useState<'MENU' | 'SETUP' | 'RACE' | 'RESULTS'>('MENU');
  const [setup, setSetup] = useState<RushSetup>({ difficulty: 'EASY', topic: 'MIXED', checkpoints: 8 });
  const [config, setConfig] = useState<RushConfig | null>(null), [session, setSession] = useState<RushSession | null>(null);
  const [saved, setSaved] = useState<RushSession | null>(null), [history, setHistory] = useState<RushSession[]>([]);
  const [question, setQuestion] = useState<RushQuestion | null>(null), [hud, setHud] = useState(initialHud);
  const [loading, setLoading] = useState(false), [ready, setReady] = useState(false), [paused, setPaused] = useState(false);
  const [error, setError] = useState(''), [feedback, setFeedback] = useState<HudFeedback | null>(null), [tutorialMode, setTutorialMode] = useState(false);
  const [muted, setMuted] = useState(false), [volume, setVolume] = useState(.32), [reduced, setReduced] = useState(false), [raceKey, setRaceKey] = useState(0);
  const [musicLevel, setMusicLevel] = useState(1), [effectsLevel, setEffectsLevel] = useState(1);
  const [attribution, setAttribution] = useState(false), [webgl, setWebgl] = useState(true);
  const [competitive, setCompetitive] = useState<CompetitiveMode | null>(null);
  const [celebrating, setCelebrating] = useState(false);
  const [hallFailed, setHallFailed] = useState<'' | 'auth' | 'network'>(''), [hallTry, setHallTry] = useState(0);
  const [howTo, setHowTo] = useState<{ start?: () => void } | null>(null);
  const [savedHeroChoice, setSavedHero] = useRushHero();
  // One player, one appearance: who they are and what they wear come with them from the Study Space and the Arena.
  const account = useAccount();
  const identity = useAvatarIdentity(account, activeStudyCharacter);
  const hero: RushHero = identity.at > 0 ? identity.hero : savedHeroChoice;
  const avatar = encodeLook(normalizeLook(hero, identity.look));
  const setHero = (next: RushHero) => { setSavedHero(next); if (account) writeIdentity(account, { hero: next, look: normalizeLook(next, identity.look), at: Date.now() }); };
  const lastOrb = useRef(0);
  const scene = useRef<SceneHandle | null>(null), sessionRef = useRef<RushSession | null>(null), qRef = useRef<RushQuestion | null>(null);
  const abort = useRef<AbortController | null>(null), alive = useRef(true), busy = useRef(false), startKey = useRef<string | null>(null);
  const pending = useRef<{ questionId: string; optionId: string; requestId: string } | null>(null), audio = useRef<RushAudio | null>(null);
  const tutorialIndex = useRef(0), tutorialMistakes = useRef(0), tutorialStreak = useRef(0), tutorialBest = useRef(0), tutorialMissed = useRef(false);
  const pauseDialog = useRef<HTMLElement | null>(null), feedbackKey = useRef(0), lastCount = useRef(-1), lastPhase = useRef('');
  const t = (a: string, b: string) => vi ? a : b;
  useEffect(() => {
    alive.current = true; let current = true; abort.current = new AbortController(); audio.current = new RushAudio(); const preference = audio.current.snapshot(); setMuted(preference.muted); setVolume(preference.volume); setMusicLevel(preference.music); setEffectsLevel(preference.effects);
    const params = new URLSearchParams(location.search);
    if (params.has('rushRoom') || params.has('rushInvite')) setCompetitive(params.has('rushInvite') ? 'PRIVATE' : 'BOTS');
    const media = matchMedia('(prefers-reduced-motion: reduce)'), change = () => setReduced(media.matches); change(); media.addEventListener('change', change);
    return () => { current = false; alive.current = false; abort.current?.abort(); audio.current?.dispose(); media.removeEventListener('change', change); scene.current = null; if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {}); };
    // Scope remount owns all requests, private state and audio.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // The hall needs the race configuration; a saved race and the history are extras. A failed configuration read is tried
  // again by itself (a deploy restarts the server for a minute), then offers "Thử lại" — never a dead hall with every mode off.
  useEffect(() => {
    const ctl = new AbortController(); let current = true;
    const status = (e: unknown) => (e as { response?: { status?: number } })?.response?.status;
    const attempt = async (n: number): Promise<void> => {
      try { const c = await quizRushApi.config(ctl.signal); if (current) { setConfig(c); setHallFailed(''); } }
      catch (e) {
        if (!current || ctl.signal.aborted) return;
        const auth = status(e) === 401 || status(e) === 403;
        if (!auth && n < 2) { await new Promise(r => setTimeout(r, 1200 * (n + 1))); if (current) return attempt(n + 1); return; }
        setHallFailed(auth ? 'auth' : 'network');
      }
    };
    void attempt(0);
    void quizRushApi.active(ctl.signal).then(s => { if (current) setSaved(s); }).catch(() => {});
    void quizRushApi.history(ctl.signal).then(h => { if (current) setHistory(h); }).catch(() => {});
    return () => { current = false; ctl.abort(); };
  }, [hallTry]);
  const say = (kind: HudFeedback['kind'], title: string, detail?: string) => setFeedback({ kind, title, detail, key: ++feedbackKey.current });
  const setRace = (value: RushSession | null) => { sessionRef.current = value; setSession(value); };
  const present = (value: RushQuestion | null) => { qRef.current = value; setQuestion(value); scene.current?.advance(value); };
  const pause = () => { scene.current?.pause(); audio.current?.pause(); setPaused(true); };
  const [locked, setLocked] = useState(false);
  const resume = () => { if (error) return; scene.current?.resume(); audio.current?.resume(); setPaused(false); };
  /** Preparation music begins with the first lobby gesture (browsers never autoplay). */
  const lobbyMusic = async () => { if (!audio.current) return; await audio.current.unlock(); if (screen === 'MENU' || screen === 'SETUP') audio.current.lobby(); };
  useEffect(() => {
    if (!paused) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = pauseDialog.current; dialog?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
    const trap = (e: KeyboardEvent) => { if (e.key !== 'Tab' || !dialog) return; const nodes = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input, a[href]')); if (!nodes.length) return; const first = nodes[0], last = nodes[nodes.length - 1]; if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); } };
    window.addEventListener('keydown', trap); return () => { window.removeEventListener('keydown', trap); previous?.focus(); };
  }, [paused]);
  useEffect(() => {
    if (screen !== 'RACE') return;
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { if (paused) resume(); else pause(); } };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, paused, error]);
  // Countdown beeps, the GO cue and the adaptive score follow the HUD (10 Hz).
  useEffect(() => {
    if (screen !== 'RACE' || !ready) return;
    const a = audio.current;
    if (hud.phase === 'COUNTDOWN' && hud.countdown !== lastCount.current && hud.countdown > 0) { lastCount.current = hud.countdown; a?.play('count'); }
    if (lastPhase.current === 'COUNTDOWN' && hud.phase === 'RUNNING') { a?.go(); a?.play('go'); }
    lastPhase.current = hud.phase;
    a?.setMood({ streak: hud.streak, tension: !!qRef.current && hud.remaining < 900 && ['RUNNING', 'VALIDATING', 'STUMBLE'].includes(hud.phase), finale: hud.phase === 'FINISHING' || hud.phase === 'FINISHED', close: false, rush: hud.skill === 'ECHO RUSH' });
    // An orb taken: name it and what it did (the scene already played its sound).
    if (hud.orb && hud.orb.serial !== lastOrb.current) { lastOrb.current = hud.orb.serial; say('good', orbText(hud.orb.kind, vi)[0], orbText(hud.orb.kind, vi)[1]); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hud, screen, ready]);
  const begin = async (isTutorial = false, resumeSaved = false) => {
    if (busy.current) return; enterRushFullscreen(); busy.current = true; setLoading(true); setError('');
    try {
      await audio.current?.unlock(); audio.current?.startRace();
      let next: RushSession | null = null;
      if (!isTutorial) {
        if (resumeSaved && saved) next = await quizRushApi.get(saved.id, abort.current?.signal);
        else { startKey.current ??= crypto.randomUUID(); next = await quizRushApi.start(setup, startKey.current, abort.current?.signal); startKey.current = null; }
      }
      if (!alive.current) return;
      tutorialIndex.current = 0; tutorialMistakes.current = 0; tutorialStreak.current = 0; tutorialBest.current = 0; tutorialMissed.current = false; lastOrb.current = 0;
      setTutorialMode(isTutorial); setRace(next);
      present(isTutorial ? tutorial[0] : next?.question ?? null); setSaved(next); pending.current = null; setReady(false); setPaused(false); setHud(initialHud); setFeedback(null); setCelebrating(false);
      lastCount.current = -1; lastPhase.current = ''; setRaceKey(k => k + 1); setScreen('RACE');
    } catch { leaveRushFullscreen(); audio.current?.stopRace(); if (alive.current) setError(t('Không thể bắt đầu. Kiểm tra kết nối hoặc chọn ít cổng hơn; một số chủ đề không có đủ câu ở độ khó này.', 'Could not start. Check your connection or choose fewer checkpoints; some topics have insufficient questions at this difficulty.')); }
    finally { busy.current = false; if (alive.current) setLoading(false); }
  };
  const celebrateCorrect = (streak: number, explanation?: string) => {
    audio.current?.play('correct');
    if (streak >= 2) audio.current?.play('combo', streak);
    const boost = Math.round(SKYBOUND.momentumStep * Math.min(SKYBOUND.momentumCap, streak) * 100);
    say('good', streak >= 2 ? t(`Chính xác! Nhịp ${streak}`, `Correct! Streak ${streak}`) : t('Chính xác! Cổng đang mở', 'Correct! The gate opens'),
      [boost ? t(`+${boost}% tốc độ`, `+${boost}% speed`) : '', explanation ?? ''].filter(Boolean).join(' · ').slice(0, 200) || undefined);
  };
  const submit = async (index: number) => {
    if (busy.current) return;
    const q = qRef.current; if (!q || !q.options[index]) return;
    if (tutorialMode) {
      const correct = q.options[index].id === tutorialAnswers[tutorialIndex.current];
      if (!correct) { tutorialMistakes.current++; tutorialMissed.current = true; tutorialStreak.current = 0; }
      else { tutorialStreak.current = tutorialMissed.current ? 0 : tutorialStreak.current + 1; tutorialBest.current = Math.max(tutorialBest.current, tutorialStreak.current); tutorialMissed.current = false; }
      scene.current?.resolve(correct, tutorialStreak.current);
      if (correct) celebrateCorrect(tutorialStreak.current); else { audio.current?.play('wrong'); say('bad', t('Cổng đóng — đổi hướng, thử cửa khác', 'Sealed — steer to another door')); }
      return;
    }
    const race = sessionRef.current; if (!race) return;
    pending.current ??= { questionId: q.id, optionId: q.options[index].id, requestId: crypto.randomUUID() };
    busy.current = true;
    try {
      const result: RushFeedback = await quizRushApi.answer(race.id, pending.current.questionId, pending.current.optionId, pending.current.requestId, abort.current?.signal);
      if (!alive.current) return;
      setRace(result.session); setSaved(result.session); pending.current = null; setError('');
      scene.current?.resolve(result.correct, result.session.streak);
      if (result.correct) celebrateCorrect(result.session.streak ?? 0, result.explanation);
      else { audio.current?.play('wrong'); say('bad', t('Cổng chưa đúng — đổi hướng, thử cửa khác', 'Not this door — steer to another'), t('Nhịp Echo đã về 0', 'Echo momentum reset')); }
    } catch {
      if (alive.current) { pause(); setError(t('Mất kết nối. Thử lại sẽ giữ nguyên lựa chọn này.', 'Connection interrupted. Retry safely resends this selection.')); }
    } finally { busy.current = false; }
  };
  useEffect(() => { if (!feedback) return; const timer = setTimeout(() => setFeedback(null), feedback.detail && feedback.detail.length > 40 ? 3600 : 2300); return () => clearTimeout(timer); }, [feedback]);
  useEffect(() => { if (screen !== 'RACE' && screen !== 'RESULTS') leaveRushFullscreen(); }, [screen]);
  const next = () => {
    if (tutorialMode) { tutorialIndex.current++; present(tutorial[tutorialIndex.current] ?? null); }
    else present(sessionRef.current?.question ?? null);
    const reached = tutorialMode ? tutorialIndex.current : sessionRef.current?.checkpoint ?? 0, last = (tutorialMode ? 3 : sessionRef.current?.total ?? 0) - 1;
    if (qRef.current && reached === last && last > 0) say('info', t('Cổng Lớn cuối cùng!', 'The final Grand Gate!'), t('Nhiều cửa nhất — đọc kỹ', 'The widest choice — read carefully'));
  };
  const finish = async () => {
    if (tutorialMode) { setCelebrating(true); audio.current?.play('finish'); audio.current?.results(); setScreen('RESULTS'); return; }
    const race = sessionRef.current; if (!race || busy.current) return; busy.current = true;
    try {
      const result = await quizRushApi.finish(race.id, abort.current?.signal);
      if (!alive.current) return; setRace(result); setSaved(null); setHistory(h => [result, ...h.filter(s => s.id !== result.id)].slice(0, 20));
      setCelebrating(true); audio.current?.play('finish'); audio.current?.results(); setScreen('RESULTS'); setError('');
    } catch { if (alive.current) { setError(t('Chưa lưu được kết quả. Nhấn lưu lại.', 'The result has not been saved. Retry saving.')); setPaused(true); } }
    finally { busy.current = false; }
  };
  const exit = () => { scene.current?.pause(); audio.current?.stopRace(); setScreen('MENU'); setPaused(false); setError(''); scene.current = null; setCelebrating(false); };
  const discard = async () => {
    if (!saved || busy.current) return; busy.current = true; setLoading(true);
    try { await quizRushApi.abandon(saved.id, abort.current?.signal); if (alive.current) { setSaved(null); setError(''); } }
    catch { if (alive.current) setError(t('Chưa thể kết thúc lượt cũ. Thử lại sau.', 'Could not close the saved race. Please retry.')); }
    finally { busy.current = false; if (alive.current) setLoading(false); }
  };
  const hold = (horizontal: number) => { if (scene.current) { scene.current.input.horizontal = horizontal; scene.current.input.target = null; } };
  // Version 6: an answer chip marks its door (a reading aid); older courses keep run-to-door steering.
  const steer = (lane: number) => { const q = qRef.current; if (!scene.current || !q) return; if (hud.reforged) scene.current.aim(hud.marked === lane ? -1 : lane); else scene.current.input.target = gateCenter(lane, q.options.length); };
  const moveStick = (h: number, f: number) => scene.current?.setMove(h, f);
  // Every skill button and its key share one path: the scene's input / handle.
  const skill = (id: SkillId) => {
    const s = scene.current; if (!s) return;
    if (id === 'jump') s.jump(); else if (id === 'dodge') s.dodge(s.input.horizontal || undefined);
    else if (id === 'sprint') s.input.sprint = true; else if (id === 'dash') s.input.dash = true; else if (id === 'rush') s.input.rush = true;
  };
  const skillRelease = (id: SkillId) => { if (id === 'sprint' && scene.current) scene.current.input.sprint = false; };
  const deny = () => audio.current?.play('deny');
  /** Solo start: the guide first unless the player turned it off after seeing it. */
  const start = (practice = false) => { if (howToDismissed()) void begin(practice); else setHowTo({ start: () => void begin(practice) }); };
  const toggleAudio = async () => { const value = !muted; setMuted(value); audio.current?.setMuted(value); if (!value) { await audio.current?.unlock(); if (screen === 'RACE') audio.current?.startRace(); else if (screen === 'RESULTS') audio.current?.results(); else audio.current?.lobby(); audio.current?.play('ui'); } };
  const result = session;
  const audioState = audio.current?.snapshot();
  if (competitive) return <Competition config={config} initialMode={competitive} onSolo={() => setCompetitive(null)} hero={hero} avatar={avatar} onHero={setHero} />;

  const total = tutorialMode ? 3 : session?.total ?? 3;
  const course = tutorialMode ? { courseVersion: REFORGED.hardcore, spacing: 2800, boundaries: tutorialCourse.walls, hazards: tutorialCourse.hazards, rising: tutorialCourse.rising, walls: tutorialCourse.motion, orbs: tutorialCourse.orbs }
    : { courseVersion: session?.courseVersion ?? 1, spacing: session?.spacing ?? 1100, boundaries: session?.boundaries ?? [], hazards: session?.hazards ?? [], rising: session?.rising ?? [], walls: session?.walls ?? [], orbs: session?.orbs ?? [] };
  const model = createRush(total, 0, 3, course.spacing, course.courseVersion, course.boundaries);
  void TRIALS;
  const running = ready && !paused && ['RUNNING', 'FINISHING'].includes(hud.phase);
  const skills = coreSkills(vi, { trials: hud.trials, running, airborne: hud.airborne, stamina: hud.stamina, sprinting: hud.skill === 'SPRINT', dashCooldown: hud.dash, dashing: hud.skill === 'DASH',
    energy: hud.energy, rushing: hud.skill === 'ECHO RUSH', dodgeCooldown: hud.dodge, reforged: hud.reforged });
  const walls = Array.from({ length: total }, (_, i) => wallAt(model, i)), finishAt = finishLine(model);
  const sceneMounted = (screen === 'RACE' || screen === 'RESULTS' && celebrating) && raceKey > 0;
  const best = history.reduce((m, h) => Math.max(m, h.bestStreak ?? 0), 0);
  const accuracy = (c: number, w: number) => Math.round(c / Math.max(1, c + w) * 100);
  const resultCorrect = tutorialMode ? 3 : result?.correct ?? 0, resultWrong = tutorialMode ? tutorialMistakes.current : result?.incorrect ?? 0;
  const resultBest = tutorialMode ? tutorialBest.current : result?.bestStreak;

  return <div className="rush-root" data-screen={screen} data-audio-context={audioState?.state ?? 'locked'} data-audio-active={audioState?.active ? 'true' : 'false'} data-audio-paused={audioState?.paused ? 'true' : 'false'} data-audio-muted={muted ? 'true' : 'false'} data-audio-volume={volume} data-audio-output={audioState?.output.toFixed(5) ?? '0'} data-audio-nodes={audioState?.nodes ?? 0} data-audio-scene={audioState?.scene ?? 'off'}>
    {!sceneMounted && <div className="rush-sky-backdrop">{webgl && <Attract reduced={reduced} hero={hero} avatar={avatar} onFailed={() => setWebgl(false)} />}</div>}
    {screen !== 'RACE' && <header className="rush-topbar">
      <Link href="/games" className="rush-back" onClick={() => { if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {}); }}><ArrowLeft size={18} /><span>{t('Thư viện trò chơi', 'Games Library')}</span></Link>
      <div className="rush-top-actions">
        <button aria-label={t('Bật/tắt âm thanh', 'Toggle sound')} onClick={() => void toggleAudio()}>{muted ? <VolumeX size={18} /> : <Volume2 size={18} />}</button>
        <RushFullscreenButton vi={vi} />
      </div>
    </header>}

    {(screen === 'MENU' || screen === 'SETUP') && <main className="rush-lobby" onPointerDown={() => { if (!muted && audioState?.scene !== 'lobby') void lobbyMusic(); }}>
      <section className="rush-hero">
        <span className="rush-eyebrow">ECHO QUIZ RUSH · SKYBOUND</span>
        <h1>{t('Chạy qua', 'Race the')}<br /><em>{t('bầu trời tri thức', 'sky of knowledge')}</em></h1>
        <p>{t('Tự điều khiển nhà thám hiểm qua những cây cầu không lan can, lưỡi cưa, cối xay và bức tường đang tiến tới. Đọc câu hỏi, chạy vào đúng cánh cửa — mỗi lần đúng ngay lần đầu, Nhịp Echo đẩy bạn nhanh hơn.', 'Steer your explorer yourself across open bridges, saws, mills and advancing walls. Read the question, run into the right door — every first-try answer builds Echo momentum.')}</p>
        <div className="rush-account" aria-label={t('Tiến trình của bạn', 'Your progress')}>
          {history.length > 0 ? <>
            <div><b>{history.length}{history.length >= 20 ? '+' : ''}</b><span>{t('chuyến đã về đích', 'journeys finished')}</span></div>
            <div><b>{history[0].correct}/{history[0].total}</b><span>{t('cổng ở lượt gần nhất', 'gates last run')}</span></div>
            {best > 0 && <div><b>{best}</b><span>{t('chuỗi đúng dài nhất', 'best streak')}</span></div>}
            <button className="rush-text-button" onClick={() => { setRace(history[0]); setTutorialMode(false); setCelebrating(false); setScreen('RESULTS'); }}>{t('Xem lượt gần nhất', 'View latest run')}</button>
          </> : <span className="rush-account-empty">{t('Chuyến đi đầu tiên của bạn đang chờ trên mây.', 'Your first journey is waiting above the clouds.')}</span>}
        </div>
      </section>

      {screen === 'MENU' ? <section className="rush-modes" aria-label={t('Chọn chế độ', 'Choose a mode')}>
        <RushHeroPicker vi={vi} hero={hero} onChange={setHero} avatar={avatar} />
        {saved && <div className="rush-saved"><div><b>{t('Hành trình đang chờ', 'Your journey is waiting')}</b><span>{saved.checkpoint}/{saved.total} {t('cổng đã mở', 'gates opened')}</span></div>
          <button className="rush-primary" disabled={loading} onClick={() => void begin(false, true)}><Play size={18} />{t('Tiếp tục', 'Resume')}</button>
          <button className="rush-text-button" disabled={loading} onClick={() => void discard()}>{t('Kết thúc lượt cũ', 'Close it')}</button></div>}
        <button className="rush-mode is-solo" disabled={loading || !config?.available || !!saved} onClick={() => setScreen('SETUP')}>
          <span className="rush-mode-icon"><Flag /></span><b>{t('Hành trình Solo', 'Solo Journey')}</b><small>{t('Tự chọn độ khó, chủ đề, 3–20 cổng', 'Your difficulty, topic, 3–20 gates')}</small><ArrowRight className="rush-mode-go" />
        </button>
        <button className="rush-mode is-bots" disabled={!config?.available} onClick={() => setCompetitive('BOTS')}>
          <span className="rush-mode-icon"><Bot /></span><b>{t('Đua cùng Echo Bots', 'Race Echo Bots')}</b><small>{t('4 đối thủ Echo · 3 mức độ', '4 Echo rivals · 3 levels')}</small><ArrowRight className="rush-mode-go" />
        </button>
        <button className="rush-mode is-quick" disabled={!config?.available} onClick={() => setCompetitive('QUICK')}>
          <span className="rush-mode-icon"><Swords /></span><b>Quick Match</b><small>{t('Người chơi thật · 2–5 người', 'Real players · 2–5 racers')}</small><ArrowRight className="rush-mode-go" />
        </button>
        <button className="rush-mode is-private" disabled={!config?.available} onClick={() => setCompetitive('PRIVATE')}>
          <span className="rush-mode-icon"><Users /></span><b>{t('Phòng riêng', 'Private Room')}</b><small>{t('Mời bạn bè · 1v1 đến 5 người', 'Invite friends · 1v1 to 5')}</small><ArrowRight className="rush-mode-go" />
        </button>
        <div className="rush-lobby-help">
          <button className="rush-secondary" onClick={() => setHowTo({})}><CircleHelp size={16} />{t('Cách chơi', 'How to play')}</button>
          <button className="rush-secondary" disabled={loading} onClick={() => start(true)}><BookOpen size={16} />{t('Sân tập · 3 cổng', 'Practice · 3 gates')}</button>
        </div>
        {error && <p className="rush-error" role="alert">{error}</p>}
        {hallFailed && !config && <div className="rush-hall-retry" role="alert"><p className="rush-error">{hallFailed === 'auth' ? t('Phiên đăng nhập đã hết hạn. Đăng nhập lại để chơi.', 'Your session has expired. Sign in again to play.') : t('Chưa tải được Echo Quiz Rush. Kiểm tra kết nối rồi thử lại.', 'Echo Quiz Rush did not load. Check your connection and try again.')}</p>
          {hallFailed === 'auth' ? <Link className="rush-secondary" href="/login">{t('Đăng nhập', 'Sign in')}</Link> : <button className="rush-secondary" onClick={() => { setHallFailed(''); setHallTry(v => v + 1); }}><RotateCcw size={16} />{t('Thử lại', 'Try again')}</button>}</div>}
        {!config?.available && !error && !hallFailed && <p className="rush-service-note">{config ? t('Nội dung chưa sẵn sàng. Bạn vẫn có thể chơi hướng dẫn.', 'Content is unavailable. You can still play the tutorial.') : t('Đang tải…', 'Loading…')}</p>}
        <button className="rush-text-button rush-source-link" onClick={() => setAttribution(v => !v)}>{t('Nguồn câu hỏi, âm thanh và hình ảnh', 'Question, audio and art sources')}</button>
        {attribution && <div className="rush-attribution"><p>{t('Câu hỏi dùng nguồn King Of English hiện có. Hướng dẫn không lưu thành tích. Nhạc và hiệu ứng âm thanh được tổng hợp gốc trong trình duyệt. Nhân vật, đảo, chướng ngại vật và vật liệu 3D là tác phẩm gốc của English Coach (Blender, tạo bằng mã); Echo là mô hình cá voi CC BY 4.0 (Blue Colossus Studio).', 'Questions reuse the existing King Of English source. Tutorials save nothing. Music and sound effects are original, synthesised in the browser. The runner, islands, obstacles and 3D materials are original English Coach art (made in Blender from code); Echo is the CC BY 4.0 whale model by Blue Colossus Studio.')}</p><pre>{config?.attribution}</pre></div>}
      </section>
      : <section className="rush-panel" aria-label={t('Thiết lập hành trình', 'Journey setup')}>
        <span className="rush-eyebrow">{t('HÀNH TRÌNH SOLO', 'SOLO JOURNEY')}</span>
        <fieldset><legend>{t('Độ khó', 'Difficulty')}</legend><div className="rush-difficulty">{DIFFICULTY.map(d => <button key={d.id} aria-pressed={setup.difficulty === d.id} onClick={() => setSetup(s => ({ ...s, difficulty: d.id, topic: config?.topics[d.id]?.includes(s.topic) ? s.topic : 'MIXED' }))}><b>{(vi ? d.vi : d.en)[0]}</b><small>{(vi ? d.vi : d.en)[1]}</small></button>)}</div></fieldset>
        <label>{t('Chủ đề', 'Topic')}<select aria-label={t('Chủ đề', 'Topic')} value={setup.topic} onChange={e => setSetup(s => ({ ...s, topic: e.target.value as RushSetup['topic'] }))}>
          {(config?.topics[setup.difficulty] ?? ['MIXED']).map(topic => <option key={topic} value={topic}>{rushTopicLabel(topic, vi)}</option>)}
        </select></label>
        <fieldset><legend>{t('Số cổng', 'Gates')}</legend><div className="rush-options">{[3, 8, 12, 20].map(n => <button key={n} aria-pressed={setup.checkpoints === n} onClick={() => setSetup(s => ({ ...s, checkpoints: n }))}>{n}</button>)}</div></fieldset>
        <p className="rush-service-note">{t('Bạn tự di chuyển: không bấm phím thì nhân vật đứng yên, cứ đứng đọc câu hỏi bao lâu tùy thích. Chướng ngại nhanh và khó dần về phía đích.', 'You move yourself: no key, no movement — stand and read for as long as you like. Obstacles get faster and harder toward the finish.')}</p>
        <div className="rush-control-guide"><span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> / <kbd>↑</kbd><kbd>←</kbd><kbd>↓</kbd><kbd>→</kbd> {t('Di chuyển', 'Move')}</span><span><kbd>Space</kbd> {t('Nhảy', 'Jump')}</span><span><kbd>Ctrl</kbd> {t('Né', 'Dodge')}</span><span><kbd>Shift</kbd> {t('Tăng tốc', 'Sprint')}</span><span><kbd>F</kbd> Dash</span><span><kbd>E</kbd> Echo Rush</span><span><kbd>1</kbd>–<kbd>4</kbd> {t('Đánh dấu cửa', 'Mark a door')}</span><small>{t('Điện thoại: cần điều khiển bên trái để chạy; các nút kỹ năng bên phải.', 'Phones: the stick on the left moves you; skill buttons sit at the right.')}</small>
          <button type="button" className="rush-text-button" onClick={() => setHowTo({})}><CircleHelp size={14} />{t('Xem hướng dẫn đầy đủ', 'Open the full guide')}</button></div>
        <button className="rush-primary" disabled={loading || !config?.available} onClick={() => start()}><Flag size={18} />{loading ? t('Đang chuẩn bị…', 'Preparing…') : t('Xuất phát', 'Let’s race')}</button>
        <button className="rush-text-button" onClick={() => setScreen('MENU')}>{t('Quay lại', 'Back')}</button>
        {error && <p className="rush-error" role="alert">{error}</p>}
      </section>}
    </main>}

    {sceneMounted && <div className="rush-stage"><Scene key={raceKey} hero={hero} avatar={avatar} total={total} checkpoint={tutorialMode ? 0 : session?.checkpoint ?? 0} question={question} reduced={reduced} localLabel={t('Bạn', 'You')} spacing={course.spacing} courseVersion={course.courseVersion} boundaries={course.boundaries} streak={tutorialMode ? 0 : session?.streak ?? 0}
      hazards={course.hazards} rising={course.rising} walls={course.walls} orbs={course.orbs}
      onReady={handle => { scene.current = handle; setReady(true); if (paused) handle.pause(); }} onLock={setLocked}
      onGate={i => void submit(i)} onNext={next} onFinish={() => void finish()} onHud={setHud} onHidden={() => { if (screen === 'RACE') { audio.current?.pause(); setPaused(true); } }}
      onWorldAudio={(event: WorldAudio, value?: number, pan?: number) => { if (event !== 'finish' && event !== 'overtake') audio.current?.world(event, value ?? 1, pan ?? 0); }}
      onAmbience={(kind, level, pan) => audio.current?.ambience(kind, level, pan)}
      onObstacle={kind => {
        if (kind === 'post') { audio.current?.play('post'); say('bad', t('Va vào tường đá', 'You hit the stone'), hud.reforged ? t('Cửa sai, cửa đã khóa hay song chắn đang hạ — đi vào giữa một cửa đang mở', 'A sealed door, a shutter or stone — walk into the middle of an open door') : t('Chạy vào giữa một cổng', 'Aim for the middle of a doorway')); }
        if (kind === 'sill') say('bad', t('Bệ đã quá cao!', 'The sill is out of reach!'), t('Cổng sẽ hạ xuống — chạy nhanh rồi nhảy sớm hơn', 'The gate settles — run faster and jump earlier'));
        if (kind === 'knock') say('bad', t('Trúng chướng ngại!', 'Hit by an obstacle!'), t('Khiên Echo bảo vệ bạn một nhịp', 'Echo shield protects you for a moment'));
        if (kind === 'fall') say('bad', t('Rơi khỏi cầu!', 'You fell!'), hud.reforged ? t('Đoạn cầu này không có lan can — Echo đưa bạn trở lại trước chướng ngại', 'No railing here — Echo brings you back before the obstacle') : t('Echo đưa bạn trở lại trước khe — nhớ nhảy (Space)', 'Echo brings you back before the gap — remember to jump (Space)'));
      }}
      onError={() => { setError(t('Thiết bị không dựng được thế giới 3D (WebGL). Thoát và thử trình duyệt khác.', 'This device could not start the 3D world (WebGL). Exit and try another browser.')); setPaused(true); }} /></div>}

    {screen === 'RACE' && <main className="rush-race" aria-label={t('Cuộc đua', 'Race')}>
      <RushHud vi={vi} hud={hud} question={question} total={total} walls={walls} finish={finishAt} ready={ready} feedback={feedback} validating={hud.phase === 'VALIDATING'} momentumOn={course.courseVersion >= SKYBOUND.version}
        onSteer={steer} onHold={hold} onMove={moveStick} skills={skills} onSkill={skill} onSkillRelease={skillRelease} onDeny={deny}
        locked={locked} onSettings={() => { if (paused) resume(); else pause(); }} onHelp={() => { if (!paused) pause(); setHowTo({}); }}
        countdown={ready && hud.phase === 'COUNTDOWN' && !paused ? hud.countdown : null} countdownCaption={t('Sẵn sàng cho hành trình', 'Your adventure begins')}
        corner={<><button className="rush-icon-button" aria-label={t('Tạm dừng', 'Pause')} onClick={pause}><Pause size={18} /></button><button className="rush-icon-button" aria-label={t('Bật/tắt âm thanh', 'Toggle sound')} aria-pressed={!muted} onClick={() => void toggleAudio()}>{muted ? <VolumeX size={18} /> : <Volume2 size={18} />}</button><RushFullscreenButton vi={vi} className="rush-icon-button" /><button className="rush-icon-button" aria-label={t('Cách chơi', 'How to play')} onClick={() => { pause(); setHowTo({}); }}><CircleHelp size={18} /></button></>}
        extra={tutorialMode ? <div className="rush-tutorial-tip"><BrandWhaleIcon className="h-6 w-6" /><span>{tutorialIndex.current === 0 ? t('Giữ W (hoặc ↑) để chạy, A / D để sang ngang; thả phím là đứng lại. Lấy quả cầu xanh rồi đi vào cửa “lose”.', 'Hold W (or ↑) to run, A / D to move sideways; let go to stop. Grab the blue orb, then walk into the “lose” door.') : tutorialIndex.current === 1 ? t('Cầu gãy, không lan can: nhấn Space ngay trước khe (nhảy cao để lấy quả cầu) — hoặc đi dầm hẹp bên phải. Rồi bức tường tiến về phía bạn: vào đúng cửa!', 'Broken bridge, no railing: press Space right before the gap (jump high for the orb) — or walk the beam on the right. Then the wall advances on you: take the right door!') : t('Trụ xoay gai: bước lên khúc gỗ đang xoay, giữ A / D ngược chiều xoay để đứng giữa và nhấn Space nhảy qua từng gai. Rồi cổng chớp: vào khi song chắn đang mở!', 'Spiked roller: step onto the turning log, steer A / D against its spin to stay on top and press Space to hop each peg. Then the timed gate: go in while its shutters are up!')}</span></div> : null} />
      <div className="sr-only">{question?.options.map((o, i) => <button key={o.id} onClick={() => steer(i)}>{t('Chạy tới', 'Steer to')} {o.label}</button>)}</div>
      {paused && <div className="rush-pause-cover"><section ref={pauseDialog} role="dialog" aria-modal="true" aria-labelledby="rush-pause-title" className="rush-panel">
        <h2 id="rush-pause-title">{t('Nghỉ một nhịp', 'Take a breath')}</h2><p>{t('Bầu trời đang chờ bạn.', 'The skyway is waiting for you.')}</p>
        {error && <p className="rush-error" role="alert">{error}</p>}
        {pending.current && <button className="rush-primary" onClick={() => { const p = pending.current; if (p) { setError(''); void submit(qRef.current?.options.findIndex(o => o.id === p.optionId) ?? 0).then(() => { if (!pending.current) { scene.current?.resume(); setPaused(false); } }); } }}>{t('Thử lại lựa chọn', 'Retry this selection')}</button>}
        {hud.phase === 'FINISHED' && error ? <button className="rush-primary" onClick={() => void finish()}>{t('Lưu lại kết quả', 'Retry saving result')}</button> : <button className="rush-primary" disabled={!!error} onClick={resume}><Play size={18} />{t('Tiếp tục', 'Resume')}</button>}
        <label>{t('Âm lượng chung', 'Master volume')}<input type="range" min="0" max="1" step=".05" value={volume} onChange={e => { const value = Number(e.target.value); setVolume(value); audio.current?.setVolume(value); }} /></label>
        <label>{t('Nhạc nền', 'Music')}<input type="range" min="0" max="1" step=".05" value={musicLevel} onChange={e => { const value = Number(e.target.value); setMusicLevel(value); audio.current?.setMusic(value); }} /></label>
        <label>{t('Hiệu ứng âm thanh', 'Sound effects')}<input type="range" min="0" max="1" step=".05" value={effectsLevel} onChange={e => { const value = Number(e.target.value); setEffectsLevel(value); audio.current?.setEffects(value); }} /></label>
        <button className="rush-secondary" onClick={() => setHowTo({})}><CircleHelp size={16} />{t('Cách chơi', 'How to play')}</button>
        <button className="rush-secondary" onClick={() => void toggleAudio()}>{muted ? t('Bật âm thanh', 'Sound on') : t('Tắt âm thanh', 'Mute')}</button>
        <button className="rush-secondary" onClick={exit}>{t('Về menu · giữ lượt hiện tại', 'Menu · keep current race')}</button>
      </section></div>}
    </main>}

    <RushHowTo vi={vi} mode={tutorialMode ? 'practice' : 'solo'} open={!!howTo} onClose={() => setHowTo(null)} onStart={howTo?.start} startLabel={howTo?.start ? t('Vào cuộc đua', 'Start the race') : undefined} />
    {screen === 'RESULTS' && <main className="rush-results"><section className="rush-panel rush-result-card">
      <span className="rush-eyebrow">{tutorialMode ? t('HƯỚNG DẪN HOÀN TẤT', 'TUTORIAL COMPLETE') : t('HÀNH TRÌNH HOÀN TẤT', 'JOURNEY COMPLETE')}</span>
      <h1><Trophy className="rush-trophy" />{resultWrong === 0 ? t('Hoàn hảo! Không sai cổng nào', 'Flawless! No wrong door') : t('Bạn đã chinh phục bầu trời!', 'You conquered the sky!')}</h1>
      <div className="rush-result-stats">
        <div><b>{seconds(tutorialMode ? hud.elapsed * 1000 : result?.elapsedMs ?? 0)}</b><span>{t('Thời gian', 'Time')}</span></div>
        <div><b>{resultCorrect}</b><span>{t('Cổng đã mở', 'Gates opened')}</span></div>
        <div><b>{resultWrong}</b><span>{t('Lần chọn sai', 'Wrong tries')}</span></div>
        <div><b>{accuracy(resultCorrect, resultWrong)}%</b><span>{t('Độ chính xác', 'Accuracy')}</span></div>
        {resultBest !== undefined && <div className="is-streak"><b><Zap size={18} />{resultBest}</b><span>{t('Chuỗi đúng dài nhất', 'Best streak')}</span></div>}
        {hud.trials && celebrating && <div><b>{hud.knocks + hud.falls}</b><span>{t('Lần vấp chướng ngại', 'Obstacle setbacks')}</span></div>}
      </div>
      <p className="rush-service-note">{tutorialMode ? t('Hướng dẫn không lưu kết quả hoặc thưởng.', 'Tutorial results and rewards are not saved.') : t('Máy chủ đã lưu. Thời gian gồm cả lúc tạm dừng và kết nối lại.', 'Saved by the server. Time includes pauses and reconnects.')}</p>
      {!tutorialMode && result && <div className="rush-review"><h2>{t('Ôn lại các cổng', 'Review your gates')}</h2>{result.review.map((r, i) => <details key={i} className={r.mistakes > 0 ? 'is-missed' : ''} open={r.mistakes > 0 && i < 3}>
        <summary><span className="rush-review-index">{i + 1}</span><span>{familyLabels[r.family]?.[vi ? 0 : 1] ?? r.family}</span><b>{r.answer}</b><small>{r.mistakes > 0 ? `${r.mistakes} ${t('lần sai', 'wrong')}` : t('Đúng ngay', 'First try')}</small></summary>
        <p>{r.prompt}</p>{r.context && <p className="rush-review-context">{r.context}</p>}{r.explanation && r.explanation !== r.context && <p>{r.explanation}</p>}
        {rushSourceLinks(r.sourceRefs).map(url => <p key={url}><a href={url} target="_blank" rel="noopener noreferrer" className="rush-text-button">{t('Nguồn câu hỏi', 'Question source')} · {new URL(url).hostname}</a></p>)}
      </details>)}</div>}
      <div className="rush-result-actions">
        <button className="rush-primary" onClick={() => void begin(tutorialMode)}><RotateCcw size={18} />{t('Chạy lại', 'Race again')}</button>
        <button className="rush-secondary" onClick={() => { setScreen('SETUP'); setError(''); setCelebrating(false); audio.current?.lobby(); }}>{t('Chọn hành trình khác', 'Choose another journey')}</button>
        <button className="rush-secondary" onClick={() => { setCelebrating(false); audio.current?.lobby(); setCompetitive('BOTS'); }}><Bot size={16} />{t('Thử đua cùng Echo Bots', 'Try racing Echo Bots')}</button>
        <Link className="rush-text-button" href="/games">{t('Về thư viện trò chơi', 'Back to Games Library')}</Link>
      </div>
      {error && <p role="alert" className="rush-error">{error}</p>}
    </section></main>}
  </div>;
}
