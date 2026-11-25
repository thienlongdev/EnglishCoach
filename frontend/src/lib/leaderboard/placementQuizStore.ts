import type { Locale } from './format';

/**
 * One app-wide placement quiz modal. Its open state lives here (not in the button that opened it) because every entry
 * button is rendered conditionally on the learner's level / eligibility: after a VALID submit the revalidated caches
 * hide the button, and a modal owned by that button would unmount and take the result screen with it.
 * `PlacementQuizHost` (mounted once in `app/providers.tsx`) renders the modal from this store.
 */
export type PlacementQuizView = 'quiz' | 'level';

export interface PlacementQuizStoreState {
  open: boolean;
  view: PlacementQuizView;
  locale: Locale;
}

let state: PlacementQuizStoreState = { open: false, view: 'quiz', locale: 'vi' };
const listeners = new Set<() => void>();

function set(next: PlacementQuizStoreState) {
  state = next;
  listeners.forEach((l) => l());
}

export const placementQuizStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  getSnapshot(): PlacementQuizStoreState {
    return state;
  },
  /** Idempotent: a second click while the modal is open never opens a second quiz. */
  open(locale: Locale) {
    if (state.open && state.view === 'quiz') return;
    set({ open: true, view: 'quiz', locale });
  },
  /** Result screen → "Xem trình độ của bạn": the same modal shows the learner's level card. */
  showLevel() {
    if (!state.open) return;
    set({ ...state, view: 'level' });
  },
  close() {
    if (!state.open) return;
    set({ ...state, open: false, view: 'quiz' });
  },
};
