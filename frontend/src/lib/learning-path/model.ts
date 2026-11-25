// Echo Learning Path — pure, import-free helpers (destinations + learner wording). Tested by scripts/test-learning-path.mjs.
// Destinations come from a fixed table keyed by task kind; only a positive integer id or an enumerated key is inserted,
// so stored data can never become an arbitrary URL.

export type Locale = 'vi' | 'en';

export interface TaskLike {
  kind: string;
  targetId: number | null;
  targetKey: string | null;
  targetRef?: string | null;
  title: string;
  goalCount: number;
  progress: number;
  status: string;
}

const isId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

/**
 * Writing Coach prompts the path may give, by key (mirrors LearningPathEngine.WRITING_TASKS): the task id the Writing
 * Coach opens, the task's own word minimum (enforced by the free practice submission) and its name.
 */
export const WRITING_TASKS: Record<string, { taskId: string; minWords: number; name: string }> = {
  GENPARA: { taskId: 'gen-paragraph-01', minWords: 80, name: 'The Power of Daily Reading' },
  GENEMAIL: { taskId: 'gen-email-01', minWords: 120, name: 'Catching Up with an Old Friend' },
  GENFREE: { taskId: 'gen-free-01', minWords: 150, name: 'Reflection on Overcoming Adversity' },
  GENESSAY: { taskId: 'gen-essay-01', minWords: 200, name: 'Artificial Intelligence in Society' },
  TOEICEMAIL: { taskId: 'toeic-email-01', minWords: 80, name: 'Client Product Inquiry' },
  TOEICOPINION: { taskId: 'toeic-opinion-01', minWords: 150, name: 'Workplace Flexibility' },
  IELTSOPINION: { taskId: 'ielts-t2-opinion-01', minWords: 250, name: 'Free Higher Education' },
  IELTSDISCUSS: { taskId: 'ielts-t2-discussion-01', minWords: 250, name: 'Technology in Modern Life' },
  IELTSPROBLEM: { taskId: 'ielts-t2-prob-sol-01', minWords: 250, name: 'Urban Traffic Congestion' },
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PART_RE = /^(TOEIC_PART_[1-7]|IELTS_LISTENING_SECTION_[1-4]|IELTS_READING_PASSAGE_[1-3])$/;

/** Exam practice target "<uuid>/<part>" → its parts, or null when it is not exactly that shape. */
export function examTarget(ref: string | null | undefined): { formId: string; part: string } | null {
  if (typeof ref !== 'string') return null;
  const [formId, part, extra] = ref.split('/');
  return extra === undefined && UUID_RE.test(formId ?? '') && PART_RE.test(part ?? '') ? { formId, part } : null;
}

/** "TOEIC_PART_5" → "TOEIC Part 5", "IELTS_LISTENING_SECTION_1" → "IELTS Listening Section 1". */
export function examPartLabel(part: string): string {
  const m = /^(TOEIC|IELTS)_(?:(PART)|LISTENING_(SECTION)|READING_(PASSAGE))_(\d)$/.exec(part);
  if (!m) return part;
  if (m[2]) return `${m[1]} Part ${m[5]}`;
  return m[3] ? `${m[1]} Listening Section ${m[5]}` : `${m[1]} Reading Passage ${m[5]}`;
}

/** Real destination of a task, or null when the task is an in-page action (placement quiz) or its target is invalid. */
export function taskHref(task: Pick<TaskLike, 'kind' | 'targetId' | 'targetKey' | 'targetRef'>): string | null {
  switch (task.kind) {
    // straight into the study of every due card (all decks), not the deck list
    case 'VOCAB_REVIEW': return '/flashcards?review=due';
    case 'DICTATION': return isId(task.targetId) ? `/listening/${task.targetId}/practice` : null;
    case 'READING': return isId(task.targetId) ? `/reading?materialId=${task.targetId}` : null;
    case 'TOPIC_SPEAKING': return '/speaking?mode=topic';
    case 'WRITING': {
      const w = task.targetKey ? WRITING_TASKS[task.targetKey] : undefined;
      return w ? `/writing?view=coach&taskId=${w.taskId}&start=draft` : null;
    }
    case 'EXAM_PRACTICE': {
      const t = examTarget(task.targetRef);
      if (!t || (task.targetKey !== 'IELTS' && task.targetKey !== 'TOEIC') || !t.part.startsWith(task.targetKey)) return null;
      return `/exams/${task.targetKey.toLowerCase()}/tests/${t.formId}?part=${t.part}#practice`;
    }
    default: return null;
  }
}

export const GOALS = ['GENERAL', 'COMMUNICATION', 'IELTS', 'TOEIC'] as const;
export const MINUTES = [15, 30, 45, 60] as const;
export const TARGETS: Record<string, readonly string[]> = {
  GENERAL: ['A1', 'A2', 'B1', 'B2', 'C1'],
  IELTS: ['5.0', '5.5', '6.0', '6.5', '7.0', '7.5'],
  TOEIC: ['450', '550', '650', '750', '850', '900', '950', '990'],
};

export function needsTarget(goal: string): boolean {
  return goal === 'IELTS' || goal === 'TOEIC';
}

const GOAL_LABEL: Record<string, [string, string]> = {
  GENERAL: ['Tiếng Anh tổng quát', 'General English'],
  COMMUNICATION: ['Giao tiếp', 'Communication'],
  IELTS: ['IELTS', 'IELTS'],
  TOEIC: ['TOEIC', 'TOEIC'],
};

export function goalLabel(goal: string, target: string | null, locale: Locale): string {
  const base = (GOAL_LABEL[goal] ?? [goal, goal])[locale === 'vi' ? 0 : 1];
  return target ? `${base} ${target}` : base;
}

export const STAGES: Record<Locale, readonly string[]> = {
  vi: ['Nền tảng', 'Phát triển', 'Củng cố', 'Sẵn sàng mục tiêu'],
  en: ['Foundation', 'Development', 'Consolidation', 'Goal readiness'],
};

export function stageLabel(stage: number, locale: Locale): string {
  const list = STAGES[locale];
  return list[Math.min(Math.max(stage, 1), list.length) - 1];
}

/** Main line of a task card. */
export function taskTitle(task: TaskLike, locale: Locale): string {
  const vi = locale === 'vi';
  const n = task.goalCount;
  switch (task.kind) {
    case 'PLACEMENT': return vi ? 'Bài xếp lớp nhanh' : 'Quick placement quiz';
    case 'VOCAB_REVIEW': return vi ? `Ôn ${n} thẻ từ vựng` : `Review ${n} flashcards`;
    case 'DICTATION': return vi ? `Nghe chép chính tả ${n} câu` : `Dictation: ${n} sentences`;
    case 'READING': return vi ? 'Đọc hết một bài' : 'Read one text to the end';
    case 'TOPIC_SPEAKING': return vi ? `Nói theo chủ đề · ${n} lượt` : `Topic speaking · ${n} ${n === 1 ? 'round' : 'rounds'}`;
    case 'WRITING': {
      const w = task.targetKey ? WRITING_TASKS[task.targetKey] : undefined;
      return w ? (vi ? `Viết bài từ ${w.minWords} từ` : `Write ${w.minWords}+ words`) : (vi ? 'Luyện viết' : 'Writing practice');
    }
    case 'EXAM_PRACTICE': {
      const t = examTarget(task.targetRef);
      const label = t ? examPartLabel(t.part) : task.targetKey ?? '';
      return (vi ? `Luyện đề ${label}` : `Exam practice: ${label}`).trim();
    }
    default: return task.kind;
  }
}

const CEFR = new Set(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']);

/** Second line: the real content title, with the content's (estimated) CEFR level when there is one. */
export function taskSubtitle(task: TaskLike): string | null {
  if (task.kind === 'WRITING') return (task.targetKey && WRITING_TASKS[task.targetKey]?.name) || null;
  const t = (task.title ?? '').trim();
  if (t.length === 0) return null;
  return task.targetKey && CEFR.has(task.targetKey) ? `${t} · ${task.targetKey}` : t;
}

/** Partial progress worth showing ("3/8"); null when not started, done, or a single-step task. */
export function taskProgress(task: TaskLike): string | null {
  if (task.status === 'DONE' || task.goalCount <= 1 || task.progress <= 0) return null;
  return `${Math.min(task.progress, task.goalCount)}/${task.goalCount}`;
}

// Only reasons that say something specific are shown; the generic ones (LITTLE_DATA, GOAL_CORE) would repeat on every
// task of a new learner, so they stay server-side (Echo, explanations) and return null here.
const REASON: Record<string, [string, string]> = {
  PLACEMENT_FIRST: ['Xác định trình độ', 'Find your level'],
  REVIEW_DUE: ['Đến hạn ôn', 'Due for review'],
  LOW_RESULTS: ['Kết quả gần đây còn thấp', 'Recent results are low'],
  KEEP_FRESH: ['Lâu chưa luyện', 'Not practised lately'],
  GOAL_CHECK: ['Kiểm tra theo mục tiêu', 'Goal check'],
  DNA_FOCUS: ['Theo Learner DNA', 'From Learner DNA'],
  CARRIED_OVER: ['Từ hôm trước', 'From an earlier day'],
  SKILL_BALANCE: ['Cân bằng kỹ năng', 'Keeps your skills balanced'],
};

export function reasonLabel(code: string, locale: Locale): string | null {
  const r = REASON[code];
  return r ? r[locale === 'vi' ? 0 : 1] : null;
}

/** "Bắt đầu học" before anything is done today, "Tiếp tục học" after; null when today is complete or empty. */
export function primaryAction(tasks: TaskLike[], locale: Locale): { label: string; task: TaskLike } | null {
  const next = tasks.find((t) => t.status !== 'DONE');
  if (!next) return null;
  const started = tasks.some((t) => t.status === 'DONE' || t.progress > 0);
  return { label: locale === 'vi' ? (started ? 'Tiếp tục học' : 'Bắt đầu học') : started ? 'Continue' : 'Start learning', task: next };
}

export function requirementLabel(r: { code: string; current: number; needed: number }, locale: Locale): string {
  const vi = locale === 'vi';
  const c = Math.min(r.current, r.needed);
  switch (r.code) {
    case 'TASKS': return vi ? `Hoàn thành nhiệm vụ: ${c}/${r.needed}` : `Tasks completed: ${c}/${r.needed}`;
    case 'SKILLS': return vi ? `Kỹ năng đã luyện: ${c}/${r.needed}` : `Skills practised: ${c}/${r.needed}`;
    case 'LEVEL': return vi ? 'Xác định trình độ' : 'Find your level';
    case 'CORE_SKILLS': return vi ? `Kỹ năng trọng tâm đạt yêu cầu: ${c}/${r.needed}` : `Core skills ready: ${c}/${r.needed}`;
    // Writing / Reading without a free score: completed practice tasks (participation, never a quality score)
    case 'PRACTICE_WRITING': return vi ? `Bài viết luyện tập đã nộp: ${c}/${r.needed}` : `Writing practice submitted: ${c}/${r.needed}`;
    case 'PRACTICE_READING': return vi ? `Bài đọc đã hoàn thành: ${c}/${r.needed}` : `Readings completed: ${c}/${r.needed}`;
    default: return r.code;
  }
}

const SKILL: Record<string, [string, string]> = {
  VOCABULARY: ['Từ vựng', 'Vocabulary'],
  LISTENING: ['Nghe', 'Listening'],
  READING: ['Đọc', 'Reading'],
  SPEAKING: ['Nói', 'Speaking'],
  WRITING: ['Viết', 'Writing'],
  ASSESSMENT: ['Đánh giá', 'Assessment'],
};

export function skillLabel(skill: string, locale: Locale): string {
  return (SKILL[skill] ?? [skill, skill])[locale === 'vi' ? 0 : 1];
}

const BAND: Record<string, [string, string]> = {
  UNKNOWN: ['Chưa đủ dữ liệu', 'Not enough data'],
  NEEDS_WORK: ['Cần luyện thêm', 'Needs work'],
  DEVELOPING: ['Đang tiến bộ', 'Developing'],
  STRONG: ['Vững', 'Strong'],
  NOT_MEASURED: ['Chưa đo được', 'Not measured'],
};

export function bandLabel(band: string, locale: Locale): string {
  return (BAND[band] ?? [band, band])[locale === 'vi' ? 0 : 1];
}

/**
 * Starting level line under the goal. A provisional start is never shown as the learner's level: it says the level is
 * not known yet and which content the path starts with.
 */
export function levelLabel(level: string, basis: string, locale: Locale): string {
  const vi = locale === 'vi';
  if (basis === 'PROVISIONAL') return vi ? `Chưa xác định trình độ · bắt đầu với nội dung ${level}` : `Level not known yet · starting with ${level} content`;
  if (basis === 'PLACEMENT') return vi ? `Trình độ ${level} · theo bài xếp lớp` : `Level ${level} · from the placement quiz`;
  return vi ? `Trình độ ${level} · theo đánh giá năng lực` : `Level ${level} · from your assessments`;
}

const DNA_REASON: Record<string, [string, string]> = {
  CARDS_FORGETTING: ['Ôn từ vựng nhiều hơn', 'More vocabulary review'],
  DICTATION_SPELLING: ['Luyện nghe chép nhiều hơn', 'More dictation practice'],
  LISTENING_TRAPS: ['Luyện nghe nhiều hơn', 'More listening practice'],
  PRONUNCIATION_SOUNDS: ['Luyện nói nhiều hơn', 'More speaking practice'],
  SPEAKING_PAUSES: ['Luyện nói trôi chảy hơn', 'More fluent speaking practice'],
  GRAMMAR_PATTERNS: ['Luyện viết nhiều hơn', 'More writing practice'],
  NO_RECENT_SIGNAL: ['Bớt ưu tiên', 'Lower priority'],
};

export function dnaChangeLabel(change: { skill: string; direction: string; reason: string }, locale: Locale): string {
  const vi = locale === 'vi';
  if (change.direction === 'DOWN') return vi ? `${skillLabel(change.skill, locale)}: trở về mức thường` : `${skillLabel(change.skill, locale)}: back to normal`;
  return (DNA_REASON[change.reason] ?? [change.reason, change.reason])[vi ? 0 : 1];
}

export function dnaFactLabel(change: { skill: string; direction: string }, facts: {
  cardsForgetting: number; sounds: string[]; grammar: string[]; listeningMistakes: number; speakingPauses: boolean;
}, locale: Locale): string | null {
  const vi = locale === 'vi';
  if (change.direction !== 'UP') return null;
  switch (change.skill) {
    case 'VOCABULARY': return vi ? `${facts.cardsForgetting} thẻ sắp quên` : `${facts.cardsForgetting} cards slipping`;
    case 'LISTENING': return vi ? `${facts.listeningMistakes} lỗi nghe gần đây` : `${facts.listeningMistakes} recent listening mistakes`;
    case 'SPEAKING':
      if (facts.sounds.length > 0) return (vi ? 'Âm cần luyện: ' : 'Sounds to practise: ') + facts.sounds.join(', ');
      return facts.speakingPauses ? (vi ? 'Ngắt nghỉ khi nói' : 'Pauses while speaking') : null;
    case 'WRITING': return facts.grammar.length > 0 ? (vi ? `${facts.grammar.length} nhóm lỗi ngữ pháp lặp lại` : `${facts.grammar.length} recurring grammar patterns`) : null;
    default: return null;
  }
}
