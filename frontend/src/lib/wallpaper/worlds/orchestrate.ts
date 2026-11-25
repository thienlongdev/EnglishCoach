import { useEffect, useState } from 'react';
import type { WorldParams } from './types';
import type { GlassTint } from '@/types/wallpaper';
import { legacyView } from '@/lib/navigation/routes';

/**
 * What the background engine needs to know about the rest of the app in order to behave: how quiet a world should be
 * on the current screen. Decided from the route (client-side only, nothing is reported anywhere) and from typing.
 */

export type WorldFrameParams = WorldParams;

export const GLASS_TINTS: Record<Exclude<GlassTint, 'auto'>, string | null> = {
  neutral: null,
  ocean: '56 170 248',
  dusk: '236 112 170',
  forest: '52 196 150',
};

/**
 * 0 = free roaming, 1 = deep focus. The more a screen is about reading, listening or typing, the quieter the world
 * around it. Exam attempts, standalone games and dictation never get here: the engine is not even mounted, or rests.
 */
export function quietnessOf(path: string, query: string | null): number {
  const { pathname, tab } = legacyView(path, query);
  if (pathname === '/' || pathname === '') {
    if (!tab || tab === 'dashboard') return 0;
    if (tab === 'leaderboard') return 0.2;
    return 0.55; // reading, listening, speaking, writing, flashcards as root tabs
  }
  if (pathname.startsWith('/music') || pathname === '/games') return 0.12;
  if (pathname.startsWith('/profile') || pathname.startsWith('/progress') || pathname.startsWith('/learning-path') || pathname.startsWith('/community')) return 0.28;
  if (/^\/listening\/[^/]+/.test(pathname)) return 0.88; // a lesson with its video and transcript
  if (pathname.startsWith('/speaking/') || pathname.startsWith('/reading/') || pathname.startsWith('/writing/')) return 0.85;
  return 0.55;
}

/** True while the learner types in a field: motion around a caret is the one thing that really distracts. */
export function useTypingQuiet(): boolean {
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    const isField = (node: EventTarget | null) => {
      const el = node as HTMLElement | null;
      if (!el?.tagName) return false;
      if (el.isContentEditable || el.tagName === 'TEXTAREA') return true;
      return el.tagName === 'INPUT' && !/^(checkbox|radio|range|button|submit|file|color)$/i.test((el as HTMLInputElement).type);
    };
    const onIn = (event: FocusEvent) => setTyping(isField(event.target));
    const onOut = () => setTyping(false);
    document.addEventListener('focusin', onIn);
    document.addEventListener('focusout', onOut);
    return () => {
      document.removeEventListener('focusin', onIn);
      document.removeEventListener('focusout', onOut);
    };
  }, []);
  return typing;
}
