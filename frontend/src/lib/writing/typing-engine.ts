/** Browser-only personal analytics. No rewards, network calls or trusted server scores. */
export type TypingPhase = 'READY' | 'RUNNING' | 'FINISHED' | 'ABORTED';
export type TypingSource = 'random' | 'reading' | 'writing';
export interface TypingSample { seconds: number; wpm: number; raw: number; errors: number; corrections: number; entries: number }
export interface TypingMetrics {
  wpm: number; raw: number; accuracy: number | null; correct: number; incorrect: number;
  correctWords: number; evaluatedWords: number; incompleteWords: number; correctedErrors: number;
  errors: number; corrections: number; seconds: number; consistency: number | null; completion: number; inactive: boolean;
}
interface Edit { position: number; end: number; extra: boolean; wrong: boolean }
export interface TypingWord { start: number; end: number; started?: number; ended?: number }
export const graphemes = (text: string): string[] => Array.from(new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text), x => x.segment);
export function normalizeTypingText(text: string): string {
  return text.normalize('NFC').replace(/\r\n?/g, '\n');
}
export function typingSections(text: string): string[] { return normalizeTypingText(text).split(/\n+/).filter(Boolean); }
export function eligibleEnglish(text: string): boolean {
  const normalized = normalizeTypingText(text);
  const letters = normalized.match(/\p{L}/gu) ?? [];
  // Conservative suitability filter, not a language classifier. Reject Vietnamese prompts.
  return normalized.length >= 8 && normalized.length <= 25000 && letters.length >= 5
    && !/[ăâđêôơưĂÂĐÊÔƠƯ\u1EA0-\u1EF9]/u.test(normalized)
    && letters.filter(x => /[a-z]/i.test(x)).length / letters.length >= 0.8;
}
const WORD_BANK = `the a is and to of in for with on from this that it we you they have be are was will can do make take know think learn read write listen speak work study school student teacher friend family home time day year people world place way life good great new first last next more most some each other only also about after before through between over under again always never often here there where when why how what who which much many few small large long short right left water food book paper word sentence language story question answer idea example practice skill speed clear strong different important useful careful simple possible change grow build help find give use need want feel start finish keep move look see hear tell ask understand remember develop improve share create plan future morning evening country city travel nature science computer number result accurate confidence research education knowledge experience learn together enough better around because while although during both without every still open close part full paragraph grammar English exam keyboard focus progress reason discuss describe compare information community health music garden ocean light quiet beautiful common attention opportunity success`.split(' ');
export function randomTypingText(count = 240, random = Math.random): string {
  const words: string[] = [];
  for (let i = 0; i < count; i++) {
    let word = WORD_BANK[Math.min(WORD_BANK.length - 1, Math.floor(random() * WORD_BANK.length))];
    if (word === words[i - 1]) word = WORD_BANK[(WORD_BANK.indexOf(word) + 1) % WORD_BANK.length];
    words.push(word);
  }
  return words.join(' ');
}
const whitespace = (x: string) => /\s/u.test(x);
const speed = (count: number, seconds: number) => seconds > 0 ? count * 12 / seconds : 0;

/** Fixed target slots; a wrong letter consumes one slot. Extra letters at a separator
 * stay at that boundary; an early separator marks the rest of that word missing.
 * Backspace undoes exactly one entry, including its whole skip. No suffix shifting. */
export class TypingEngine {
  phase: TypingPhase = 'READY';
  target: string[];
  cells: Array<string | null | undefined> = [];
  extras = new Map<number, string[]>();
  historicalErrors = new Set<number>();
  words: TypingWord[] = [];
  samples: TypingSample[] = [];
  position = 0;
  entries = 0;
  correctAttempts = 0;
  errors = 0;
  corrections = 0;
  correctedErrors = 0;
  startedAt: number | null = null;
  lastActivity = 0;
  elapsed = 0;
  inactive = false;
  result: TypingMetrics | null = null;
  private edits: Edit[] = [];
  private sampledErrors = 0;
  private sampledCorrections = 0;
  private lastSampleSecond = 0;
  duration: number;
  infinite: boolean;
  constructor(text: string, duration: number, infinite = false) {
    this.duration = duration; this.infinite = infinite;
    this.target = graphemes(normalizeTypingText(text));
    this.indexWords(0);
  }
  private indexWords(offset: number) {
    let start = offset;
    while (start < this.target.length) {
      if (whitespace(this.target[start])) { start++; continue; }
      let end = start + 1;
      while (end < this.target.length && !whitespace(this.target[end])) end++;
      this.words.push({ start, end }); start = end;
    }
  }
  private extend() {
    const offset = this.target.length;
    this.target.push(' ', ...graphemes(randomTypingText()));
    this.indexWords(offset + 1);
  }
  tick(now: number) {
    if (this.phase !== 'RUNNING' || this.startedAt === null) return;
    const actual = Math.max(0, (now - this.startedAt) / 1000);
    this.elapsed = this.duration ? Math.min(actual, this.duration) : actual;
    if (now - this.lastActivity >= 15000) this.inactive = true;
    if (Math.floor(this.elapsed) > this.lastSampleSecond) this.sample();
    if ((this.duration && actual >= this.duration) || actual >= 3600) this.finish(now);
  }
  private sample() {
    if (this.elapsed <= 0) return;
    const m = this.metrics();
    this.samples.push({ seconds: this.elapsed, wpm: m.wpm, raw: m.raw, entries: this.entries,
      errors: this.errors - this.sampledErrors, corrections: this.corrections - this.sampledCorrections });
    this.sampledErrors = this.errors; this.sampledCorrections = this.corrections;
    this.lastSampleSecond = Math.floor(this.elapsed);
    // One-hour maximum and bounded chart history, preserving totals on merged points.
    if (this.samples.length > 600) {
      this.samples = this.samples.reduce<TypingSample[]>((out, point, i, all) => {
        if (i % 2 === 0 && all[i + 1]) out.push({ ...all[i + 1], errors: point.errors + all[i + 1].errors, corrections: point.corrections + all[i + 1].corrections });
        else if (i === all.length - 1) out.push(point);
        return out;
      }, []);
    }
  }
  enter(value: string, now: number) {
    if (!value || this.phase === 'FINISHED' || this.phase === 'ABORTED') return;
    const chars = graphemes(value.normalize('NFC'));
    if (chars.length > 8) return; // composition remains bounded; bulk insertion is not typing
    if (this.phase === 'READY') {
      this.phase = 'RUNNING'; this.startedAt = now; this.lastActivity = now;
      this.samples.push({ seconds: 0, wpm: 0, raw: 0, entries: 0, errors: 0, corrections: 0 });
    }
    this.tick(now);
    if (this.phase !== 'RUNNING') return;
    for (const char of chars) {
      if (this.infinite && this.duration && this.position >= this.target.length - 100) this.extend();
      if (this.position >= this.target.length) break;
      const pos = this.position;
      const expected = this.target[pos];
      this.entries++;
      this.lastActivity = now;
      const word = this.words.find(w => pos >= w.start && pos < w.end);
      if (word && word.started === undefined) word.started = now;
      if (char === expected) this.correctAttempts++;
      else { this.errors++; this.historicalErrors.add(pos); }
      if (char !== expected && whitespace(expected)) {
        const extra = this.extras.get(pos) ?? [];
        extra.push(char); this.extras.set(pos, extra);
        this.edits.push({ position: pos, end: pos, extra: true, wrong: true });
        continue;
      }
      // A space at the start of a word is extra, not a skip of the whole word.
      if (whitespace(char) && !whitespace(expected) && (pos === 0 || whitespace(this.target[pos - 1]))) {
        const extra = this.extras.get(pos) ?? []; extra.push(char); this.extras.set(pos, extra);
        this.edits.push({ position: pos, end: pos, extra: true, wrong: true }); continue;
      }
      let end = pos + 1;
      if (whitespace(char) && !whitespace(expected)) {
        while (end < this.target.length && !whitespace(this.target[end])) end++;
        for (let i = pos; i < end; i++) { this.cells[i] = null; this.historicalErrors.add(i); }
        if (end < this.target.length && this.target[end] === char) { this.cells[end] = char; end++; }
      } else this.cells[pos] = char;
      this.edits.push({ position: pos, end, extra: false, wrong: char !== expected });
      this.position = end;
      for (const w of this.words) if (w.started !== undefined && w.ended === undefined && this.position >= w.end) w.ended = now;
    }
    if (this.infinite && this.duration && this.position >= this.target.length - 100) this.extend();
    if (this.position >= this.target.length) this.finish(now);
  }
  backspace(now: number) {
    if (this.phase !== 'RUNNING') return;
    this.tick(now);
    if (this.phase !== 'RUNNING') return;
    const edit = this.edits.pop(); if (!edit) return;
    this.corrections++; this.lastActivity = now;
    if (edit.wrong) this.correctedErrors++;
    if (edit.extra) {
      const extra = this.extras.get(edit.position)!; extra.pop(); if (!extra.length) this.extras.delete(edit.position);
    } else {
      for (let i = edit.position; i < edit.end; i++) this.cells[i] = undefined;
      this.position = edit.position;
      for (const w of this.words) if (w.end > edit.position) w.ended = undefined;
    }
  }
  abort() { if (this.phase !== 'FINISHED') this.phase = 'ABORTED'; }
  finish(now: number) {
    if (this.phase !== 'RUNNING' || this.startedAt === null) return this.result;
    this.elapsed = Math.max(0, (now - this.startedAt) / 1000);
    this.elapsed = Math.min(this.elapsed, this.duration || 3600);
    if (now - this.lastActivity >= 15000) this.inactive = true;
    if (this.samples.at(-1)?.seconds !== this.elapsed || this.sampledErrors !== this.errors || this.sampledCorrections !== this.corrections) this.sample();
    this.result = Object.freeze(this.metrics()); this.phase = 'FINISHED';
    return this.result;
  }
  wordSpeed(word: TypingWord): number | null {
    if (word.started === undefined || word.ended === undefined || word.ended - word.started < 250) return null;
    return speed(word.end - word.start, (word.ended - word.started) / 1000);
  }
  /** Whitespace after a word belongs to that word, including boundary extras.
   * Attempted incomplete words count once as incorrect, even after deleting an
   * attempt entirely. Untouched words are excluded; completed corrections recover. */
  wordEvaluation(word: TypingWord, index = this.words.indexOf(word)) {
    const from = index === 0 ? 0 : word.start;
    const to = this.words[index + 1]?.start ?? this.target.length;
    const attempted = word.started !== undefined || Array.from(this.extras.keys()).some(p => p >= from && p < to);
    const complete = this.position >= word.end;
    let correct = complete;
    for (let p = from; p < to; p++) {
      if (this.extras.has(p) || (p < word.end && this.cells[p] !== this.target[p])
        || (p >= word.end && this.cells[p] !== undefined && this.cells[p] !== this.target[p])) correct = false;
    }
    return { attempted, complete, correct: attempted && correct };
  }
  metrics(): TypingMetrics {
    if (this.result) return this.result;
    let correct = 0, incorrect = 0;
    for (let i = 0; i < this.position; i++) {
      if (this.cells[i] === this.target[i]) correct++; else if (this.cells[i] !== undefined) incorrect++;
    }
    for (const extra of this.extras.values()) incorrect += extra.length;
    let correctWords = 0, evaluatedWords = 0, incompleteWords = 0;
    for (const [index, word] of this.words.entries()) {
      const state = this.wordEvaluation(word, index);
      if (!state.attempted) continue;
      evaluatedWords++;
      if (state.correct) correctWords++;
      if (!state.complete) incompleteWords++;
    }
    // Five-second raw-entry windows: include idle windows; short sessions report unavailable.
    const windows: number[] = [];
    let start = 0, priorEntries = 0;
    for (const s of this.samples) if (s.seconds - start >= 5) {
      windows.push(speed(s.entries - priorEntries, s.seconds - start)); start = s.seconds; priorEntries = s.entries;
    }
    const mean = windows.reduce((a, b) => a + b, 0) / (windows.length || 1);
    const deviation = Math.sqrt(windows.reduce((a, b) => a + (b - mean) ** 2, 0) / (windows.length || 1));
    return { wpm: speed(correct, this.elapsed), raw: speed(this.entries, this.elapsed),
      accuracy: evaluatedWords ? correctWords / evaluatedWords * 100 : null,
      correctWords, evaluatedWords, incompleteWords, correctedErrors: this.correctedErrors,
      correct, incorrect, errors: this.errors, corrections: this.corrections, seconds: this.elapsed,
      consistency: windows.length >= 2 && mean > 0 ? Math.max(0, Math.min(100, 100 * (1 - deviation / mean))) : null,
      completion: Math.min(100, this.position / Math.max(1, this.target.length) * 100), inactive: this.inactive };
  }
}
