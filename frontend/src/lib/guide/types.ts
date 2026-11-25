/**
 * Echo Guide (owner brief 2026-10-31, 10 §BL): what a guide is made of. Content lives in `guides/*.ts`, the engine in `components/guide`.
 *
 * A guide teaches one real thing, on the real controls. `target` is a CSS selector of an element that exists in the product:
 * prefer `[data-guide="…"]`, or an existing `data-testid` / `id` / role where the component is byte-pinned.
 */
export interface GuideText {
  vi: string;
  en: string;
}

export type GuideLevel = 'orientation' | 'module' | 'feature';

export type GuideModule =
  | 'workspace'
  | 'dashboard'
  | 'learningPath'
  | 'flashcards'
  | 'grammar'
  | 'reading'
  | 'listening'
  | 'speaking'
  | 'writing'
  | 'exams'
  | 'games'
  | 'appearance'
  | 'music'
  | 'community'
  | 'account';

/** How a step ends: the learner presses Next; or does the real thing, seen from the real page. */
export type GuideAdvance =
  | { on: 'next' }
  | { on: 'click' }
  | { on: 'present'; selector: string }
  | { on: 'absent'; selector: string };

export interface GuideStep {
  id: string;
  /** The real element. Null: a short note with no spotlight. */
  target: string | null;
  title: GuideText;
  body: GuideText;
  advance?: GuideAdvance;
  /** Already true on the page (the tab is open, the dialog is up): this step is skipped, forward and back. */
  skipIf?: string;
  /** How long the element may take to appear before the step is skipped. */
  waitMs?: number;
  place?: 'auto' | 'top' | 'bottom' | 'left' | 'right';
  pad?: number;
  /** Echo itself comes to rest on the target (the companion's own place). */
  echoAt?: 'target';
}

export interface GuideDef {
  id: string;
  module: GuideModule;
  level: GuideLevel;
  /** Bump when the words change meaning; never re-offers by itself. */
  version: number;
  title: GuideText;
  summary: GuideText;
  /** The screen the guide belongs to: pathname (exact, or a RegExp source) and root tab. */
  path: string | RegExp;
  tab?: string;
  /** Where the panel takes the learner when they ask for it from elsewhere. Null: it can only start from its own screen (a lesson, an open book). */
  home: string | null;
  /** Must be on screen for the guide to apply here (an open tab, a lobby, a reader). */
  gate?: string;
  /** May Echo offer it by itself, once, the first time this screen opens. */
  offer: boolean;
  /** A screen where the page's own stillness rule applies: only ever offered in the first moments, before the learner has started anything. */
  entryOnly?: boolean;
  /** Only some accounts see the screen (Premium tools). Nothing is ever pushed. */
  steps: GuideStep[];
}

export interface GuideContext {
  pathname: string;
  tab: string | null;
}
