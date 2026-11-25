/**
 * Route coverage of Echo Spatial: what the one experience does on every screen. One selected preset stays selected
 * everywhere; a learning screen keeps the identity (tint, rim, transitions) and lowers everything that moves near the work.
 *
 * env        the 3D scene behind the content: live (reacts to the pointer) | calm (slow, far quieter) | off (the screen paints its own)
 * surfaces   cards: play (depth, light, motion) | still (rim and fixed depth only, nothing moves near the work) | off
 * transition route change: full | fade | off
 * type       the preset's heading effect may run
 * overlay    the pointer light layer above the content may run
 * lens       the gallery room can open over this page's real items
 */
export type EnvLevel = 'live' | 'calm' | 'off';
export type SurfaceLevel = 'play' | 'still' | 'off';
export type TransitionLevel = 'full' | 'fade' | 'off';

export interface SpatialProfile {
  id: string;
  env: EnvLevel;
  surfaces: SurfaceLevel;
  transition: TransitionLevel;
  type: boolean;
  overlay: boolean;
  lens: boolean;
  /** 0 = free roaming, 1 = deep focus: slows the scene and its reaction to the pointer. */
  calm: number;
}

const rich = (id: string, lens = true): SpatialProfile => ({ id, env: 'live', surfaces: 'play', transition: 'full', type: true, overlay: true, lens, calm: 0 });
const social = (id: string): SpatialProfile => ({ id, env: 'live', surfaces: 'play', transition: 'full', type: true, overlay: false, lens: false, calm: 0.25 });
const library = (id: string): SpatialProfile => ({ id, env: 'calm', surfaces: 'play', transition: 'full', type: true, overlay: false, lens: true, calm: 0.45 });
const study = (id: string): SpatialProfile => ({ id, env: 'calm', surfaces: 'still', transition: 'fade', type: false, overlay: false, lens: false, calm: 0.85 });
const ownScene = (id: string): SpatialProfile => ({ id, env: 'off', surfaces: 'still', transition: 'fade', type: false, overlay: false, lens: false, calm: 1 });
const inert = (id: string): SpatialProfile => ({ id, env: 'off', surfaces: 'off', transition: 'off', type: false, overlay: false, lens: false, calm: 1 });

/** `search`: the page's query string. Only the keys that change what is on screen are looked at. */
export function spatialProfile(pathname: string, search: URLSearchParams | null): SpatialProfile {
  const tab = search?.get('tab') ?? null;
  if (pathname === '/study-space') return { id: 'study-space', env: 'live', surfaces: 'off', transition: 'off', type: false, overlay: false, lens: false, calm: 0.15 };
  if (pathname === '/' || pathname === '') {
    if (!tab || tab === 'dashboard') return rich('dashboard');
    if (tab === 'leaderboard') return rich('leaderboard', false);
    if (tab === 'flashcards') return library('flashcards');
    if (tab === 'reading') return search?.get('materialId') ? study('reading-article') : library('reading');
    if (tab === 'listening') return library('listening');
    if (tab === 'speaking') return library('speaking');
    if (tab === 'writing') return study('writing');
    return library(`tab-${tab}`);
  }
  if (pathname === '/dashboard') return rich('dashboard');
  if (/^\/grammar\/(topics|check|practice)/.test(pathname)) return study('grammar-lesson'); // reading a lesson, answering: nothing moves near the work
  if (pathname.startsWith('/grammar')) return library('grammar');
  if (pathname.startsWith('/games')) {
    if (pathname === '/games') return rich('games');
    return ownScene('game'); // Hangman, King Of English, Word Chain paint their own stage (Garden and Rush have no shell at all)
  }
  if (pathname.startsWith('/premium')) return ownScene('premium');
  if (pathname.startsWith('/music')) return social('music');
  if (pathname.startsWith('/profile')) return social('profile');
  if (pathname.startsWith('/progress')) return social('progress');
  if (pathname.startsWith('/leaderboard')) return rich('leaderboard', false);
  if (pathname.startsWith('/community')) return { ...social('community'), env: 'calm', calm: 0.45 };
  if (pathname.startsWith('/knowledge-universe')) return ownScene('knowledge-universe'); // Vũ trụ tri thức paints its own universe
  if (pathname.startsWith('/learning-path')) return social('learning-path');
  if (/^\/listening\/[^/]+\/practice/.test(pathname)) return inert('dictation'); // typing against a clock, the wallpaper rests here too
  if (/^\/listening\/dashboard/.test(pathname)) return library('listening-stats');
  if (/^\/listening\/[^/]+/.test(pathname)) return study('listening-lesson'); // the video, its controls and the highlighted transcript
  if (pathname.startsWith('/listening')) return library('listening');
  if (/^\/speaking\/arena(?:\/|$)/.test(pathname)) return ownScene('speaking-arena');
  if (/^\/speaking\/.+/.test(pathname)) return study('speaking-session'); // microphone, timers
  if (pathname.startsWith('/speaking')) return library('speaking');
  if (pathname.startsWith('/writing')) return study('writing');
  if (pathname.startsWith('/reading')) return search?.get('materialId') ? study('reading-article') : library('reading');
  if (pathname.startsWith('/flashcards')) return library('flashcards');
  if (/^\/exams\/[^/]+\/practice\/result/.test(pathname) || /^\/exams\/[^/]+\/results/.test(pathname)) return study('exam-result');
  if (/^\/exams\/[^/]+\/practice\//.test(pathname)) return inert('exam-practice'); // the attempt itself: nothing moves
  if (pathname.startsWith('/exams')) return library('exams');
  if (pathname.startsWith('/admin')) return { ...study('admin'), surfaces: 'off' };
  return library('other');
}

/**
 * The routes outside the workspace shell, where the engine is not mounted at all (kept here so the coverage matrix
 * is complete and testable). The preference is untouched and the experience returns on the next workspace screen.
 */
export const OUTSIDE_SHELL: { route: string; why: string }[] = [
  { route: '/speaking/arena', why: 'Speaking Arena owns the WebGL scene and spatial voice; no competing wallpaper or Spatial renderer' },
  { route: '/ (public landing), /landing-preview', why: 'Paints its own 3D ocean; a second GPU scene would compete with it' },
  { route: '/login, /register, /forgot-password, /reset-password, /verify-email', why: 'Sign-in ocean and the Turnstile widget stay exactly as they are' },
  { route: '/exams/[family]/attempts/[attemptId]', why: 'Exam attempt runtime: pinned, no shell, no decoration by law (10 §AU)' },
  { route: '/games/echo-garden, /games/echo-quiz-rush', why: 'Standalone full-screen 3D games with no shell; never a competing renderer' },
  { route: '/study-space/timer', why: 'Portable timer has no decorative renderer' },
  { route: '/echo-anywhere, /echo-anywhere/connect', why: 'Public page of the browser extension and its account connection: own design, no shell' },
];
