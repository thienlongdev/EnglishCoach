/**
 * Echo Morph route rules (10 §BN): what motion each screen allows. Plain data, no imports: the main bundle reads it to decide whether the engine loads at all.
 *
 * full   the whole language: card to destination, route passage, overlays, tabs, neighbours gliding, content settling in.
 * calm   a learning surface: arrival, overlays and tabs only. Nothing moves near the work because of what a press inside it changes.
 * still  time-sensitive or the screen paints its own world: overlays fade, and the screen's own arrival is never animated.
 * off    the engine does nothing here (Journey or the attempt runtime owns the screen).
 */
export type MorphLevel = 'full' | 'calm' | 'still' | 'off';

/** The coverage table: first match wins, anything not listed is `full` (a new module inherits the language without registering). */
export const MORPH_ROUTES: { pattern: RegExp; level: MorphLevel; why: string }[] = [
  { pattern: /^\/landing-preview/, level: 'off', why: 'Landing scene owns the screen' },
  { pattern: /^\/(login|register|forgot-password|reset-password|verify-email)/, level: 'off', why: 'Echo Cinematic Journey owns every passage here; Turnstile and forms stay untouched' },
  { pattern: /^\/exams\/[^/]+\/attempts\//, level: 'off', why: 'Exam attempt runtime: pinned, no decoration by law (10 §AU), timers and input first' },
  { pattern: /^\/exams\/[^/]+\/practice\/result/, level: 'calm', why: 'Result review: reading answers' },
  { pattern: /^\/exams\/[^/]+\/practice\//, level: 'still', why: 'Practice attempt: answers and audio first' },
  { pattern: /^\/exams\/[^/]+\/results/, level: 'calm', why: 'Result review' },
  { pattern: /^\/games\/(echo-garden|echo-quiz-rush)/, level: 'still', why: 'Standalone 3D games: own renderer, no shell' },
  { pattern: /^\/games\/.+/, level: 'calm', why: 'Hangman, King Of English, Word Chain paint their own stage and own their state' },
  { pattern: /^\/listening\/[^/]+\/practice/, level: 'calm', why: 'Dictation: typing against the audio' },
  { pattern: /^\/listening\/(?!dashboard)[^/]+/, level: 'calm', why: 'Lesson: video and highlighted transcript' },
  { pattern: /^\/speaking\/shadowing\/dev/, level: 'still', why: 'Microphone acceptance pages' },
  { pattern: /^\/speaking\/arena(?:\/|$)/, level: 'still', why: 'Speaking Arena owns its renderer, camera and live voice controls' },
  { pattern: /^\/speaking\/.+/, level: 'calm', why: 'Speaking session: microphone controls never move' },
  { pattern: /^\/grammar\/(check|practice)/, level: 'calm', why: 'Answering: nothing moves near the work' },
  { pattern: /^\/grammar\/topics\//, level: 'calm', why: 'Reading a lesson' },
  { pattern: /^\/admin/, level: 'calm', why: 'Tables and forms' },
  { pattern: /^\/study-space/, level: 'off', why: 'Không gian học tập owns its full-window world, its own drag and widget motion' },
  { pattern: /^\/knowledge-universe/, level: 'still', why: 'Vũ trụ tri thức owns its 3D camera; overlays fade only' },
];

export function morphLevel(pathname: string, search: URLSearchParams | null): MorphLevel {
  if (pathname === '/' || pathname === '') {
    const tab = search?.get('tab');
    if (!tab || tab === 'landing') return 'off'; // the public Landing
    if (tab === 'writing') return 'calm';
    if (tab === 'reading' && search?.get('materialId')) return 'calm'; // an open article: selection and place in the text
    return 'full';
  }
  if (pathname.startsWith('/reading') && search?.get('materialId')) return 'calm';
  if (pathname.startsWith('/writing')) return 'calm';
  for (const row of MORPH_ROUTES) if (row.pattern.test(pathname)) return row.level;
  return 'full';
}

/** The part of an address that names a screen. Filters, pages and sorts in the query are not a new place. */
export function routeKey(pathname: string, search: URLSearchParams | null): string {
  const tab = search?.get('tab');
  const material = search?.get('materialId');
  return `${pathname}${tab ? `?tab=${tab}` : ''}${material ? `&m=${material}` : ''}`;
}

/** How deep a screen sits: moving deeper rises, moving back settles. */
export function routeDepth(key: string): number {
  return key.split('?')[0].split('/').filter(Boolean).length + (key.includes('&m=') ? 1 : 0);
}

/** Two addresses of one mounted workspace: the workspace animates its own views, the route engine stays out. */
export function sameWorkspace(a: string, b: string): boolean {
  const lesson = /^\/listening\/(?!dashboard)([^/?]+)/;
  const x = a.match(lesson);
  const y = b.match(lesson);
  return !!x && !!y && x[1] === y[1];
}
