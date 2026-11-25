/**
 * Echo Guide: the small part in the main bundle (10 §BL). No React and no content here: which guide runs, whether the panel is open, what this account has seen.
 * Local first and per account: a browser never mixes two learners' guides, and no learning content is ever stored. The record survives sign-out (`auth-cache-cleanup`) because it
 * holds only guide ids and states; losing it means a guide may be offered once more, nothing else.
 */
export type GuideRunState = 'offered' | 'started' | 'done' | 'skipped';

export interface GuideEntry {
  s: GuideRunState;
  /** Last meaningful step, for honest resume wording only. */
  step?: number;
  /** Content version it was seen in. */
  v?: number;
  at: number;
}

export interface GuideRecord {
  /** new: guides may be offered as screens open. returning: one quiet invitation, then only on request. Null until the account's history is known. */
  profile: 'new' | 'returning' | null;
  /** The learner's own switch for automatic offers. */
  auto: boolean;
  invited?: boolean;
  guides: Record<string, GuideEntry>;
}

const PREFIX = 'ec_guide:v1:';
const EMPTY: GuideRecord = { profile: null, auto: true, guides: {} };

let account = '';
let record: GuideRecord = EMPTY;
let activeId: string | null = null;
let startStep = 0;
let panelOpen = false;
let offering = false;
let panelReturn: HTMLElement | null = null;
let pendingStart: string | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

function load(id: string): GuideRecord {
  try {
    const raw = localStorage.getItem(PREFIX + id);
    if (!raw) return { ...EMPTY, guides: {} };
    const parsed = JSON.parse(raw) as Partial<GuideRecord>;
    return {
      profile: parsed.profile === 'new' || parsed.profile === 'returning' ? parsed.profile : null,
      auto: parsed.auto !== false,
      invited: parsed.invited === true,
      guides: parsed.guides && typeof parsed.guides === 'object' ? parsed.guides : {},
    };
  } catch {
    return { ...EMPTY, guides: {} };
  }
}
function save() {
  if (!account) return;
  try {
    localStorage.setItem(PREFIX + account, JSON.stringify(record));
  } catch {
    // Storage denied or full: the record lasts for this visit.
  }
}

export const subscribeGuide = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function setGuideAccount(id: string) {
  if (id === account) return;
  account = id;
  record = id ? load(id) : { ...EMPTY, guides: {} };
  activeId = null;
  panelOpen = false;
  pendingStart = null;
  syncDocument();
  emit();
}
export const guideAccount = () => account;
export const guideRecord = () => record;

export function setGuideProfile(profile: 'new' | 'returning') {
  if (record.profile) return;
  // A learner who already has a history is not interrupted: the switch stays theirs, off until they turn it on.
  record = { ...record, profile, auto: profile === 'new' };
  save();
  emit();
}
export function setGuideAuto(auto: boolean) {
  record = { ...record, auto };
  save();
  emit();
}
export function markGuideInvited() {
  record = { ...record, invited: true };
  save();
  emit();
}
export function markGuide(id: string, s: GuideRunState, version?: number, step?: number) {
  const before = record.guides[id];
  // Finished once stays finished: a replay left midway does not undo it.
  const state = before?.s === 'done' && s !== 'done' ? 'done' : s;
  record = { ...record, guides: { ...record.guides, [id]: { s: state, step, v: version ?? before?.v, at: Date.now() } } };
  save();
  emit();
}

function syncDocument() {
  if (typeof document === 'undefined') return;
  if (activeId) document.documentElement.dataset.guideActive = activeId;
  else delete document.documentElement.dataset.guideActive;
}

// ── What is running ──
export const activeGuide = () => activeId;
export const activeGuideStart = () => startStep;
/** The companion rests while a guide runs or the panel is open. */
export const guideBusy = () => !!activeId || panelOpen;
/** Its small words also wait while Echo is asking something else. */
export const guideSpeaking = () => !!activeId || panelOpen || offering;
export function setGuideOffering(value: boolean) {
  if (offering === value) return;
  offering = value;
  emit();
}
export function startGuide(id: string, step = 0) {
  panelOpen = false;
  pendingStart = null;
  activeId = id;
  startStep = step;
  syncDocument();
  emit();
}
export function stopGuide() {
  if (!activeId) return;
  activeId = null;
  syncDocument();
  emit();
}

/** Start after the navigation the panel just made: the runtime begins it once its screen is really there. */
export const pendingGuide = () => pendingStart;
export function setPendingGuide(id: string | null) {
  pendingStart = id;
  emit();
}

// ── The panel ──
export const guidePanelOpen = () => panelOpen;
export function openGuidePanel() {
  panelReturn = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
  panelOpen = true;
  emit();
}
export function closeGuidePanel() {
  if (!panelOpen) return;
  panelOpen = false;
  emit();
  panelReturn?.focus?.({ preventScroll: true });
  panelReturn = null;
}
