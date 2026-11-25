import { journeyActive } from '@/lib/journey/journey';

/** Screens Echo never offers anything on: the learner is sitting an exam or in a full-screen game. A guide never even starts here. */
const NEVER = [/^\/exams\/[^/]+\/attempts\//, /^\/exams\/[^/]+\/practice\//, /^\/games\/echo-garden/, /^\/games\/echo-quiz-rush/, /^\/speaking\/arena(?:\/|$)/];

export const guideForbiddenHere = (pathname: string) => NEVER.some((pattern) => pattern.test(pathname));

/** The learner is busy, or something else already has the screen: no offer now. Asked again later, never queued up. */
export function offerBlocked() {
  if (journeyActive()) return true;
  // Immersive atlas keeps help explicit through its own question-mark control.
  if (document.querySelector('[data-purpose="odyssey-world"]')) return true;
  // Vũ trụ tri thức: a full 3D universe with its own legend; help stays on the question mark.
  if (document.querySelector('[data-cosmos="ready"]')) return true;
  if (guideForbiddenHere(window.location.pathname)) return true;
  // The conversation with Echo, a dialog, a menu.
  if (findTarget('.echo-panel, [role="dialog"], [role="alertdialog"], [role="menu"], [aria-modal="true"]')) return true;
  // Typing.
  const focus = document.activeElement as HTMLElement | null;
  if (focus && (focus.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(focus.tagName))) return true;
  // Text selected: the learner is reading or about to look something up.
  const selection = window.getSelection?.();
  if (selection && !selection.isCollapsed && selection.toString().trim()) return true;
  // Something is playing.
  for (const media of document.querySelectorAll<HTMLMediaElement>('video, audio')) {
    if (!media.paused && !media.muted && !media.ended) return true;
  }
  // A recording in progress announces itself through the page's own state attribute.
  if (document.querySelector('[data-guide-busy]')) return true;
  // A Focus Mode world or a quiet screen.
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--wp-quiet')) >= 0.85;
}

/** A step's element: the first match that is really on screen (a hidden copy of the same control does not count). */
export function findTarget(selector: string): HTMLElement | null {
  let matches: NodeListOf<HTMLElement>;
  try {
    matches = document.querySelectorAll<HTMLElement>(selector);
  } catch {
    return null;
  }
  for (const el of matches) {
    if (el.closest('[data-guide-layer]')) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    return el;
  }
  return null;
}
