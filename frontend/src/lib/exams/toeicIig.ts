/**
 * TOEIC computer-based exam room (IIG-style simulation, owner brief 2026-11-16) — pure presentation model.
 *
 * Reference: REA package C:\REA\artifacts\toeic-iig-real-exam-reference (official IIG mock visual proxy + documented
 * real-exam rules). This file holds only deterministic rules so scripts/test-toeic-iig.mjs can execute it; it has no
 * imports on purpose. Every policy the evidence could not decide is named here and in docs/toeic-exam/IIG_ROOM.md:
 *
 *  [P-LISTEN-UNIT]  Listening advances on authorized audio events. Group-bound recordings expose only their questions.
 *                   Verified prompt offsets can move focus within a recording. Legacy part and section playlists
 *                   retain recording-level focus when cues are absent.
 *                   The screen shows the questions of the recording that is playing; the next recording replaces them;
 *                   earlier recordings are never reachable again. No item-level timer is invented.
 *  [P-LISTEN-LOCK]  An item is answerable while its recording is the current one (simulation: from Start until that
 *                   recording ends or the server deadline closes the section). INFERRED, not measured IIG behaviour.
 *  [P-READ-STEP]    Reading Previous / Next move by screen: Part 5 = one sentence per screen, Part 6 / 7 = one set
 *                   (passage group) per screen, never across into Listening. Selecting an answer never navigates.
 *  [P-MARK]         "Mark item for review" marks ONE item (the current item of the screen), stored per item, independent
 *                   of the answer.
 *  [P-TILES]        Submit warning lists the items that need attention: gray = unanswered, orange = marked (answered and
 *                   unmarked items are omitted, matching the mock figure where answered numbers are skipped). The review
 *                   overview shows every Reading item with an explicit legend (answered = navy, unanswered = gray,
 *                   marked = orange). Colour meanings are INFERRED and always labelled.
 *  [P-CLOCK]        The chip shows the authoritative remaining time of the ACTIVE section (server deadline) as hh:mm:ss;
 *                   the mock's global-looking clock never grants time across sections.
 */

export type IigSkill = 'LISTENING' | 'READING';

export interface IigItemLike {
  placementId: string;
  prompt?: string | null;
  optionDefinitions?: any;
  options?: any;
}
export interface IigGroupLike {
  id: string;
  items?: IigItemLike[];
  stimuli?: Array<{ assets?: Array<{ assetId?: string; mimeType?: string; role?: string }> }>;
}
export interface IigPartLike {
  id?: string;
  partCode?: string | null;
  groups?: IigGroupLike[];
}

export interface IigEntry {
  placementId: string;
  number: number;
  partNumber: number;
  partIndex: number;
  groupId: string;
}

export interface IigScreen {
  key: string;
  partNumber: number;
  partIndex: number;
  groupId: string;
  placementIds: string[];
  numbers: number[];
}

export interface IigUnit {
  /** Index of the recording (0-based, in playback order). */
  index: number;
  /** Part indexes (in the section) this recording covers. */
  partIndexes: number[];
  /** Audio asset of the recording; null when the section has no playable audio. */
  assetId: string | null;
  groupIds?: string[];
}

// ─── Parts / numbering ───────────────────────────────────────────────────────────────────────────────────────────

/** Printed TOEIC part number: from the part code ("LISTENING_PART_3" → 3), else by position inside the section. */
export function iigPartNumber(partCode: string | null | undefined, index: number, skill: IigSkill): number {
  const m = /(\d+)\s*$/.exec(partCode || '');
  const n = m ? Number(m[1]) : NaN;
  if (skill === 'LISTENING') return Number.isFinite(n) && n >= 1 && n <= 4 ? n : Math.min(4, index + 1);
  return Number.isFinite(n) && n >= 5 && n <= 7 ? n : Math.min(7, 5 + index);
}

/** Every item of the section in printed order with its number, part and set. */
export function iigEntries(parts: IigPartLike[], numbers: Map<string, number>, skill: IigSkill): IigEntry[] {
  const out: IigEntry[] = [];
  let fallback = skill === 'READING' ? 101 : 1;
  (parts || []).forEach((part, partIndex) => {
    const partNumber = iigPartNumber(part.partCode, partIndex, skill);
    for (const group of part.groups || []) {
      for (const item of group.items || []) {
        const n = numbers.get(item.placementId) ?? fallback;
        fallback = n + 1;
        out.push({ placementId: item.placementId, number: n, partNumber, partIndex, groupId: group.id });
      }
    }
  });
  return out;
}

/** [P-READ-STEP] Reading screens: Part 5 one item each, Part 6 / 7 one set each; printed order kept. */
export function buildReadingScreens(entries: IigEntry[]): IigScreen[] {
  const screens: IigScreen[] = [];
  for (const e of entries) {
    const perItem = e.partNumber === 5;
    const last = screens[screens.length - 1];
    if (!perItem && last && last.groupId === e.groupId && last.partIndex === e.partIndex) {
      last.placementIds.push(e.placementId);
      last.numbers.push(e.number);
      continue;
    }
    screens.push({
      key: perItem ? `item:${e.placementId}` : `set:${e.groupId}`,
      partNumber: e.partNumber,
      partIndex: e.partIndex,
      groupId: e.groupId,
      placementIds: [e.placementId],
      numbers: [e.number],
    });
  }
  return screens;
}

export function screenIndexOf(screens: IigScreen[], placementId: string | null | undefined): number {
  if (!placementId) return -1;
  return screens.findIndex((s) => s.placementIds.includes(placementId));
}

export function readingNav(screens: IigScreen[], index: number): { canPrev: boolean; canNext: boolean } {
  return { canPrev: index > 0, canNext: index >= 0 && index < screens.length - 1 };
}

/** Audio asset of a part: the first audio asset of its stimuli. */
export function partAudioAssetId(part: IigPartLike | undefined): string | null {
  for (const g of part?.groups || []) {
    for (const st of g.stimuli || []) {
      for (const a of st.assets || []) {
        if (a?.assetId && (String(a.mimeType || '').toLowerCase().startsWith('audio') || (!a.mimeType && a.role === 'PRIMARY'))) {
          return a.assetId;
        }
      }
    }
  }
  return null;
}

/**
 * [P-LISTEN-UNIT] Recordings in playback order. A part with its own recording opens a unit; a part without one belongs
 * to the recording before it (a whole-section file is attached to the first part only); parts before the first recording
 * join the first unit. Two parts that reference the SAME asset stay in one unit.
 */
export function buildListeningUnits(parts: IigPartLike[]): IigUnit[] {
  const units: IigUnit[] = [];
  // A group-bound playlist names a recording in every group. Section/part-only editions keep their own layout below.
  const groups = parts.flatMap((part, partIndex) => (part.groups || []).map(group => ({
    partIndex, groupId: group.id, assetId: partAudioAssetId({ groups: [group] }),
  })));
  if (groups.length && groups.every(g => g.assetId)) {
    for (const g of groups) {
      const last = units[units.length - 1];
      if (last && last.assetId === g.assetId) {
        last.groupIds!.push(g.groupId);
        if (!last.partIndexes.includes(g.partIndex)) last.partIndexes.push(g.partIndex);
      } else {
        units.push({ index: units.length, partIndexes: [g.partIndex], groupIds: [g.groupId], assetId: g.assetId });
      }
    }
    return units;
  }
  const pending: number[] = [];
  (parts || []).forEach((part, i) => {
    const asset = partAudioAssetId(part);
    const last = units[units.length - 1];
    if (asset && (!last || last.assetId !== asset)) {
      units.push({ index: units.length, partIndexes: [...pending, i], assetId: asset });
      pending.length = 0;
    } else if (last) {
      last.partIndexes.push(i);
    } else {
      pending.push(i);
    }
  });
  if (units.length === 0 && (parts || []).length > 0) {
    units.push({ index: 0, partIndexes: (parts || []).map((_, i) => i), assetId: null });
  }
  return units;
}

// ─── Header ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** "Listening: Questions 1 of 200" / "Reading: Questions 151 - 152 of 200" (mock wording). */
export function iigHeaderTitle(skill: IigSkill, numbers: number[], total: number): string {
  const label = skill === 'LISTENING' ? 'Listening' : 'Reading';
  const valid = numbers.filter((n) => Number.isFinite(n));
  if (valid.length === 0) return `${label}: ${total} Questions`;
  const min = Math.min(...valid);
  const max = Math.max(...valid);
  return `${label}: Questions ${min === max ? min : `${min} - ${max}`} of ${total}`;
}

/** [P-CLOCK] hh:mm:ss (two-digit hours, as in the mock chip). */
export function iigClock(seconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map((v) => String(v).padStart(2, '0')).join(':');
}

// ─── Answers / options ───────────────────────────────────────────────────────────────────────────────────────────

/** Same truth as runnerModel.isAnswered (kept local: this module has no imports). */
export function iigAnswered(value: any): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return true;
  if (Array.isArray(value)) return value.some((v) => iigAnswered(v));
  if (typeof value === 'object') {
    if (value.recordingId) return true;
    const candidates = [value.value, value.choiceId, value.selectedOption, value.textResponse, value.text, value.answerPayload];
    return candidates.some((c) => c !== value && iigAnswered(c));
  }
  return false;
}

export function iigSelected(value: any): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object' && !Array.isArray(value)) {
    const v = value.value ?? value.choiceId ?? value.selectedOption ?? value.answerPayload?.value;
    return typeof v === 'string' ? v.trim() : '';
  }
  return '';
}

export interface IigOption {
  id: string;
  letter: string;
  text: string;
}

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

/**
 * Options of an item in printed order from the canonical payload only (never invented). The printed letter is the id
 * when the id is a single letter, else the position. Listening Parts 1–2 are letters only: their spoken statements
 * must never appear on screen, whatever the payload carries.
 */
export function iigOptions(item: IigItemLike | null | undefined, partNumber: number): IigOption[] {
  const defs = (item && (item.optionDefinitions || item.options)) || null;
  const list: any[] = Array.isArray(defs)
    ? defs
    : defs && typeof defs === 'object'
    ? defs.options || defs.choices || defs.items || defs.values || []
    : [];
  const out: IigOption[] = [];
  const lettersOnly = partNumber === 1 || partNumber === 2;
  list.forEach((o) => {
    if (o === null || o === undefined) return;
    let id: string;
    let text = '';
    if (typeof o === 'string' || typeof o === 'number') {
      id = String(o);
    } else {
      const raw = o.id ?? o.key ?? o.label;
      if (raw === null || raw === undefined || String(raw).trim() === '') return;
      id = String(raw);
      // Same text fields as runnerModel.itemOptions (original-practice packages print their text in `label`);
      // a label that served as the id is not repeated as text.
      const labelText = o.id != null || o.key != null ? o.label : undefined;
      text = String(o.text ?? labelText ?? o.content ?? o.value ?? o.body ?? '').trim();
    }
    const letter = /^[A-Fa-f]$/.test(id.trim()) ? id.trim().toUpperCase() : LETTERS[out.length] || String(out.length + 1);
    // A leading "(A)" / "A." / "A:" / "A -" that repeats the printed letter is dropped (it is drawn as the letter);
    // a text that is only the letter is no text. Exact case: a lower-case "a" is an answer (the article), not letter A.
    const escaped = letter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const cleaned = new RegExp(`^\\(?\\s*${escaped}\\s*[).:]?\\s*$`).test(text)
      ? ''
      : text.replace(new RegExp(`^(\\(\\s*${escaped}\\s*\\)\\s*|${escaped}[.):]\\s+|${escaped}\\s+-\\s+)`), '').trim();
    out.push({ id, letter, text: lettersOnly ? '' : cleaned });
  });
  return out;
}

/** Question line: Parts 1 / 2 never print the spoken wording (mock: "1. Question 1"); others print their stem. */
export function iigQuestionLine(number: number, partNumber: number, prompt: string | null | undefined): string {
  // A printed number at the start ("147.", "(131)") is not repeated; a stem that is only a blank marker
  // ("(131) ______", the Part 6 gap) has no words to print (mock: "133. Question 133").
  const stem = (prompt || '').trim().replace(new RegExp(`^\\(?${number}\\)?\\s*[.):]?\\s*`), '').trim();
  const words = stem.replace(/[\s_.\-…]+/g, '');
  if (partNumber === 1 || partNumber === 2 || !words) return `${number}. Question ${number}`;
  return `${number}. ${stem}`;
}

// ─── Review tiles ────────────────────────────────────────────────────────────────────────────────────────────────

export type IigTileStatus = 'answered' | 'unanswered' | 'marked';

export function iigTileStatus(answered: boolean, marked: boolean): IigTileStatus {
  if (marked) return 'marked';
  return answered ? 'answered' : 'unanswered';
}

export interface IigTilePart {
  partNumber: number;
  tiles: Array<{ placementId: string; number: number; status: IigTileStatus }>;
}

/** Tiles by Part. `attentionOnly` ([P-TILES] submit warning) keeps unanswered or marked items only. */
export function iigTileParts(
  entries: IigEntry[],
  responses: Record<string, any>,
  marked: Set<string> | string[],
  attentionOnly: boolean
): IigTilePart[] {
  const markedSet = marked instanceof Set ? marked : new Set(marked || []);
  const parts: IigTilePart[] = [];
  for (const e of entries) {
    const status = iigTileStatus(iigAnswered(responses?.[e.placementId]), markedSet.has(e.placementId));
    if (attentionOnly && status === 'answered') continue;
    let p = parts.find((x) => x.partNumber === e.partNumber);
    if (!p) {
      p = { partNumber: e.partNumber, tiles: [] };
      parts.push(p);
    }
    p.tiles.push({ placementId: e.placementId, number: e.number, status });
  }
  return parts;
}

export function iigCounts(entries: IigEntry[], responses: Record<string, any>, marked: Set<string> | string[]) {
  const markedSet = marked instanceof Set ? marked : new Set(marked || []);
  let answered = 0;
  let unanswered = 0;
  let flagged = 0;
  for (const e of entries) {
    if (iigAnswered(responses?.[e.placementId])) answered += 1;
    else unanswered += 1;
    if (markedSet.has(e.placementId)) flagged += 1;
  }
  return { answered, unanswered, marked: flagged, total: entries.length };
}

/** Submit warning copy (mock wording for the unanswered case). */
export function iigSubmitMessage(unanswered: number, marked: number): { heading: string; message: string } {
  if (unanswered > 0) return { heading: 'NOTIFICATION', message: 'You have unanswered questions. Submit anyway?' };
  if (marked > 0) return { heading: 'NOTIFICATION', message: 'You have questions marked for review. Submit anyway?' };
  return { heading: 'SUBMIT', message: 'You have answered all questions. Submit your test now?' };
}
