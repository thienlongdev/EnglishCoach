import { PracticeMode, WritingSessionStage } from '@/types/writing';

export interface PatternInfo {
  title: string;
  subtitle: string;
  description: string;
}

const CANONICAL_PATTERN_MAP: Record<string, PatternInfo> = {
  CAPITALIZATION_PRONOUN_I: {
    title: 'Viết hoa đại từ "I"',
    subtitle: 'Capitalize Pronoun "I"',
    description: 'Đại từ nhân xưng "I" (tôi) luôn luôn phải viết hoa trong tiếng Anh dù đứng ở bất kỳ vị trí nào trong câu.'
  },
  TEMPORAL_CONSISTENCY: {
    title: 'Tính nhất quán thời gian và thói quen',
    subtitle: 'Temporal and Habitual Consistency',
    description: 'Trạng từ chỉ thói quen mô tả hành vi lặp lại, trong khi mốc thời gian tương lai xác định mô tả một sự kiện đơn lẻ. Cần làm rõ ý định diễn đạt.'
  },
  THIRD_PERSON_SINGULAR_AUXILIARY: {
    title: 'Trợ động từ với chủ ngữ ngôi thứ ba số ít',
    subtitle: 'Third-Person Singular Auxiliary',
    description: "Sử dụng 'does/doesn't' thay vì 'do/don't' với chủ ngữ ngôi thứ ba số ít (he, she, it)."
  },
  SUBJECT_VERB_AGREEMENT: {
    title: 'Sự hòa hợp chủ ngữ – động từ',
    subtitle: 'Subject–Verb Agreement',
    description: 'Động từ phải tương thích về số ít hoặc số nhiều với chủ ngữ chính trong câu.'
  },
  PAST_TENSE_REGULAR_IRREGULAR: {
    title: 'Chia động từ theo mốc thời gian quá khứ',
    subtitle: 'Past Tense Inflection',
    description: 'Sử dụng đúng dạng quá khứ (có quy tắc hoặc bất quy tắc) cho hành động đã kết thúc.'
  },
  ARTICLE_MISSING_BEFORE_SINGULAR_COUNT_NOUN: {
    title: 'Mạo từ trước danh từ đếm được số ít',
    subtitle: 'Singular Countable Noun Article',
    description: 'Danh từ đếm được số ít luôn cần có mạo từ (a/an/the) hoặc từ hạn định đi kèm.'
  },
  PREPOSITION_CHOICE_COLLOCATION: {
    title: 'Giới từ đi kèm',
    subtitle: 'Preposition Collocation',
    description: 'Sử dụng đúng giới từ quy ước đi liền với động từ hoặc tính từ theo văn cảnh.'
  },
  MODAL_AUXILIARY_BARE_INFINITIVE: {
    title: 'Động từ khiếm khuyết + Động từ nguyên mẫu',
    subtitle: 'Modal Verb Bare Infinitive',
    description: "Động từ khiếm khuyết (must, can, should, will...) đi trực tiếp với động từ nguyên mẫu không 'to'."
  },
  COLLOCATION_VERB_NOUN: {
    title: 'Kết hợp Động từ – Danh từ',
    subtitle: 'Verb–Noun Collocation',
    description: "Kết hợp từ tự nhiên theo quy ước tiếng Anh (ví dụ: 'make a decision', không dùng 'do a decision')."
  },
  COLLOCATION_ADJECTIVE_NOUN: {
    title: 'Kết hợp Tính từ – Danh từ',
    subtitle: 'Adjective–Noun Collocation',
    description: "Kết hợp tính từ đi kèm tự nhiên với danh từ (ví dụ: 'heavy rain', không dùng 'powerful rain')."
  },
  VERB_TENSE_CONSISTENCY: {
    title: 'Tính nhất quán của thì',
    subtitle: 'Tense Consistency',
    description: 'Giữ thì động từ đồng nhất xuyên suốt các mệnh đề trong cùng một đoạn văn.'
  },
  RELATIVE_PRONOUN_USAGE: {
    title: 'Đại từ quan hệ',
    subtitle: 'Relative Pronoun Usage',
    description: 'Chọn đại từ quan hệ (who, which, that, whose) phù hợp với danh từ chỉ người hoặc vật.'
  },
  PUNCTUATION_COMMA_SPLICE: {
    title: 'Lỗi nối câu bằng dấu phẩy',
    subtitle: 'Comma Splice Error',
    description: 'Không dùng dấu phẩy đơn lẻ để nối hai mệnh đề độc lập mà không có liên từ kết hợp.'
  },
  DANGLING_MODIFIER: {
    title: 'Mệnh đề bổ nghĩa treo',
    subtitle: 'Dangling Modifier',
    description: 'Chủ ngữ của mệnh đề bổ nghĩa phải trùng khớp với chủ ngữ chính của câu.'
  },
  RUN_ON_SENTENCE: {
    title: 'Câu ghép sai cấu trúc',
    subtitle: 'Run-on Sentence',
    description: 'Tách các mệnh đề độc lập bằng dấu chấm hoặc liên từ kết hợp phù hợp.'
  },
  FRAGMENT_SENTENCE: {
    title: 'Câu chưa hoàn chỉnh',
    subtitle: 'Sentence Fragment',
    description: 'Đảm bảo mỗi câu hoàn chỉnh đều có đủ chủ ngữ và vị ngữ chính.'
  },
  PASSIVE_VOICE_OVERUSE: {
    title: 'Lạm dụng thể bị động',
    subtitle: 'Passive Voice Overuse',
    description: 'Ưu tiên câu chủ động để câu văn trực diện, sống động và gãy gọn hơn.'
  },
  WORDINESS_REDUNDANCY: {
    title: 'Diễn đạt rườm rà, thừa từ',
    subtitle: 'Wordiness and Redundancy',
    description: 'Lược bỏ những từ ngữ không cần thiết để câu văn súc tích và mạch lạc.'
  },
  PARALLEL_STRUCTURE: {
    title: 'Cấu trúc song hành',
    subtitle: 'Parallel Structure',
    description: 'Các từ hoặc cụm từ liệt kê trong câu phải có cùng hình thức ngữ pháp.'
  },
  GENERAL_GRAMMAR_ACCURACY: {
    title: 'Ngữ pháp câu tổng quát',
    subtitle: 'General Grammar Accuracy',
    description: 'Cần đảm bảo cấu trúc câu chuẩn xác, các thành phần ngữ pháp như chủ ngữ, vị ngữ, bổ ngữ liên kết logic.'
  },
  GRAMMAR_SYNTACTIC_ACCURACY: {
    title: 'Cấu trúc cú pháp câu',
    subtitle: 'Grammar Syntactic Accuracy',
    description: 'Sắp xếp các mệnh đề và thành phần câu đúng trật tự cú pháp tiếng Anh chuẩn.'
  },
  ARTICLE_USAGE_A_AN_THE: {
    title: 'Sử dụng mạo từ (a / an / the)',
    subtitle: 'Article Usage (a/an/the)',
    description: 'Dùng mạo từ phù hợp với tính chất xác định hoặc không xác định của danh từ.'
  },
  INVALID_AUXILIARY_VERB_CONSTRUCTION: {
    title: 'Cấu trúc trợ động từ',
    subtitle: 'Auxiliary Verb Construction',
    description: 'Sau trợ động từ hoặc khiếm khuyết từ, động từ chính luôn ở dạng nguyên mẫu không "to".'
  },
  TENSE_ASPECT_ERROR: {
    title: 'Thì và thể của động từ',
    subtitle: 'Tense and Aspect',
    description: 'Lựa chọn thì động từ phù hợp với mốc thời gian và tính chất hành động.'
  },
  UNCOUNTABLE_NOUN_PLURALIZATION: {
    title: 'Danh từ không đếm được',
    subtitle: 'Uncountable Noun Pluralization',
    description: 'Danh từ không đếm được không có dạng số nhiều và không đi trực tiếp với "a/an".'
  },
  PRONOUN_CASE_ERROR: {
    title: 'Dạng thức đại từ (chủ ngữ / tân ngữ)',
    subtitle: 'Pronoun Case',
    description: 'Dùng đại từ chủ ngữ ở vị trí chủ từ và đại từ tân ngữ sau động từ hoặc giới từ.'
  },
  PREPOSITION_USAGE: {
    title: 'Sử dụng giới từ',
    subtitle: 'Preposition Usage',
    description: 'Sử dụng giới từ đúng theo văn cảnh thời gian, địa điểm hoặc đi kèm với động từ/tính từ cụ thể.'
  },
  VERB_FORM_AFTER_PREPOSITION: {
    title: 'Dạng động từ sau giới từ',
    subtitle: 'Verb Form After Preposition',
    description: 'Động từ đứng ngay sau giới từ luôn ở dạng V-ing.'
  },
  CONDITIONAL_SENTENCE_ERROR: {
    title: 'Cấu trúc câu điều kiện',
    subtitle: 'Conditional Sentence',
    description: 'Tuân thủ sự kết hợp thì chuẩn mực giữa mệnh đề if và mệnh đề chính.'
  },
  WORD_FORM_ERROR: {
    title: 'Dạng từ (Từ loại)',
    subtitle: 'Word Form',
    description: 'Sử dụng đúng từ loại (danh từ, động từ, tính từ, trạng từ) tương ứng với vị trí ngữ pháp.'
  },
  SPELLING_ERROR: {
    title: 'Chính tả từ vựng',
    subtitle: 'Spelling',
    description: 'Kiểm tra và viết đúng chính tả từ tiếng Anh.'
  },
  PUNCTUATION_ERROR: {
    title: 'Dấu câu',
    subtitle: 'Punctuation',
    description: 'Sử dụng dấu câu chuẩn xác để phân tách các thành phần ngữ pháp.'
  }
};

/**
 * Transforms an internal enum/pattern code into a learner-friendly bilingual representation.
 * Internal taxonomy strings are never exposed directly to the learner.
 */
export function formatPatternCode(code?: string): PatternInfo {
  if (!code) {
    return {
      title: 'Điểm ngữ pháp cần lưu ý',
      subtitle: '',
      description: 'Quy tắc diễn đạt tự nhiên và chính xác trong ngữ cảnh viết.'
    };
  }

  const clean = code.trim().toUpperCase();
  if (CANONICAL_PATTERN_MAP[clean]) {
    return CANONICAL_PATTERN_MAP[clean];
  }

  // Fallback: convert SCREAMING_SNAKE_CASE to Title Case without "Quy tắc:" prefix
  const words = clean.split('_');
  const titleCase = words
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');

  return {
    title: titleCase,
    subtitle: '',
    description: 'Quy tắc diễn đạt tự nhiên và chính xác trong ngữ cảnh viết.'
  };
}

/**
 * Safely resolves a learner-facing title for any pattern or issue.
 * If the input title is missing, or is an internal technical identifier (SCREAMING_SNAKE_CASE),
 * it converts it through the canonical Vietnamese mapping or friendly title case.
 */
export function getPatternDisplayTitle(title?: string, patternCode?: string): string {
  // If patternCode matches our canonical dictionary, prioritize that localized title
  if (patternCode) {
    const cleanCode = patternCode.trim().toUpperCase();
    if (CANONICAL_PATTERN_MAP[cleanCode]) {
      return CANONICAL_PATTERN_MAP[cleanCode].title;
    }
  }

  // If title is already human-friendly (not a SCREAMING_SNAKE_CASE enum)
  if (title && title.trim().length > 0) {
    const isScreamingSnake = /^[A-Z0-9_]+$/.test(title.trim()) && title.includes('_');
    if (!isScreamingSnake) {
      return title.trim();
    }
  }

  // Fallback to formatting the patternCode or title
  return formatPatternCode(patternCode || title).title;
}

/**
 * Returns user-friendly Vietnamese labels and details for each sentence practice mode.
 */
export function getPracticeModeLabel(mode: PracticeMode): {
  title: string;
  shortLabel: string;
  desc: string;
  icon: string;
} {
  switch (mode) {
    case 'COMBINE':
      return {
        title: 'Kết hợp câu',
        shortLabel: 'Kết hợp',
        desc: 'Ghép các mệnh đề đơn thành câu phức mạch lạc và tinh gọn.',
        icon: 'merge_type'
      };
    case 'REPAIR':
      return {
        title: 'Sửa lỗi câu',
        shortLabel: 'Sửa lỗi',
        desc: 'Khắc phục các lỗi ngữ pháp trọng tâm và từ đi kèm chưa chuẩn.',
        icon: 'build'
      };
    case 'EXPAND':
      return {
        title: 'Mở rộng câu',
        shortLabel: 'Mở rộng',
        desc: 'Phát triển câu ngắn với trạng ngữ, mệnh đề quan hệ và chi tiết bổ trợ.',
        icon: 'open_in_full'
      };
    case 'REWRITE_NATURALLY':
      return {
        title: 'Viết lại tự nhiên',
        shortLabel: 'Tự nhiên',
        desc: 'Chuyển đổi lối diễn đạt gượng gạo thành văn phong tiếng Anh tự nhiên.',
        icon: 'auto_fix_high'
      };
    case 'PARAPHRASE':
      return {
        title: 'Diễn đạt lại',
        shortLabel: 'Diễn đạt lại',
        desc: 'Thay đổi cấu trúc câu và từ vựng mà vẫn bảo toàn ý nghĩa ban đầu.',
        icon: 'sync_alt'
      };
    case 'CHANGE_REGISTER':
      return {
        title: 'Chuyển đổi văn phong',
        shortLabel: 'Văn phong',
        desc: 'Chuyển đổi linh hoạt giữa văn phong học thuật trang trọng và giao tiếp thân mật.',
        icon: 'tune'
      };
    case 'IMPROVE_COHESION':
      return {
        title: 'Cải thiện liên kết',
        shortLabel: 'Liên kết',
        desc: 'Sử dụng từ nối và phép liên kết ý để tạo mạch văn trôi chảy.',
        icon: 'link'
      };
    default:
      return {
        title: 'Luyện câu trọng tâm',
        shortLabel: 'Luyện tập',
        desc: 'Rèn luyện khả năng diễn đạt câu tiếng Anh chính xác.',
        icon: 'edit'
      };
  }
}

/**
 * Returns localized stage titles and descriptions for Writing Coach.
 */
export function getStageLabel(stage: WritingSessionStage): {
  title: string;
  stepNumber: number;
  desc: string;
} {
  switch (stage) {
    case 'UNDERSTANDING':
      return {
        title: 'Đọc hiểu đề bài',
        stepNumber: 1,
        desc: 'Phân tích yêu cầu, xác định đối tượng người đọc và mục tiêu bài viết'
      };
    case 'PLANNING':
      return {
        title: 'Lập dàn ý',
        stepNumber: 1,
        desc: 'Xây dựng luận điểm chính và cấu trúc các đoạn văn'
      };
    case 'DRAFTING':
      return {
        title: 'Bản nháp',
        stepNumber: 2,
        desc: 'Thể hiện ý tưởng thành các đoạn văn hoàn chỉnh trên trang viết'
      };
    case 'ANALYZING':
      return {
        title: 'Đang phân tích',
        stepNumber: 3,
        desc: 'Hệ thống đang quét cú pháp, từ vựng và tính liên kết'
      };
    case 'FEEDBACK_READY':
      return {
        title: 'Đánh giá và Gợi ý',
        stepNumber: 3,
        desc: 'Xem nhận xét chuyên sâu và các điểm gợi ý nâng cấp câu từ'
      };
    case 'REVISING':
      return {
        title: 'Chỉnh sửa và Hoàn thiện',
        stepNumber: 4,
        desc: 'Khắc phục các điểm hạn chế và nâng cấp văn phong cho bản nháp tiếp theo'
      };
    case 'COMPLETED':
      return {
        title: 'Hoàn thành bài viết',
        stepNumber: 4,
        desc: 'Bài viết đã hoàn thiện và được lưu vào hồ sơ học tập của bạn'
      };
    default:
      return {
        title: 'Không gian viết',
        stepNumber: 1,
        desc: 'Từng bước hoàn thiện kỹ năng viết tiếng Anh'
      };
  }
}

/**
 * Localized dimension names for evaluation verdicts.
 */
export function getDimensionLabel(dim: string): string {
  const map: Record<string, string> = {
    Grammar: 'Ngữ pháp',
    Naturalness: 'Độ tự nhiên',
    Vocabulary: 'Từ vựng',
    Cohesion: 'Tính liên kết',
    Task: 'Đáp ứng yêu cầu',
    Style: 'Văn phong',
    register: 'Văn phong phù hợp',
    TASK_FULFILLMENT: 'Đáp ứng yêu cầu',
    COHERENCE_COHESION: 'Mạch lạc và Liên kết',
    LEXICAL_RESOURCE: 'Vốn từ vựng',
    GRAMMATICAL_RANGE_ACCURACY: 'Ngữ pháp và Cấu trúc',
    GRAMMATICAL_RANGE: 'Độ đa dạng ngữ pháp',
    GRAMMATICAL_ACCURACY: 'Độ chính xác ngữ pháp'
  };
  return map[dim] || dim;
}

/**
 * Localized trend status badge for skill metrics.
 */
export function getTrendLabel(trend?: string): { label: string; colorClass: string } {
  const norm = (trend || '').toUpperCase();
  switch (norm) {
    case 'IMPROVING':
      return {
        label: 'Tiến bộ',
        colorClass: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800/40'
      };
    case 'STEADY':
      return {
        label: 'Ổn định',
        colorClass: 'bg-blue-500/10 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800/40'
      };
    case 'NEEDS_WORK':
      return {
        label: 'Cần cải thiện',
        colorClass: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800/40'
      };
    case 'INSUFFICIENT_DATA':
    default:
      return {
        label: 'Chưa đủ dữ liệu',
        colorClass: 'bg-surface-container text-on-surface-variant border border-surface-variant/40'
      };
  }
}

/**
 * Localized severity labels for feedback issues.
 */
export function getSeverityLabel(severity: string): { label: string; color: string } {
  const norm = severity.toUpperCase();
  switch (norm) {
    case 'CRITICAL':
      return { label: 'Lỗi nghiêm trọng', color: 'text-error' };
    case 'MAJOR':
      return { label: 'Cần sửa đổi', color: 'text-amber-600 dark:text-amber-400' };
    case 'MINOR':
      return { label: 'Điểm tinh chỉnh', color: 'text-secondary' };
    case 'SUGGESTION':
      return { label: 'Gợi ý nâng cao', color: 'text-primary' };
    default:
      return { label: 'Gợi ý', color: 'text-on-surface-variant' };
  }
}

/**
 * Localized category labels for writing tasks.
 */
export function getCategoryLabel(cat?: string): string {
  if (!cat) return 'Ngữ pháp và Diễn đạt';
  const map: Record<string, string> = {
    Capitalization: 'Viết hoa',
    Orthography: 'Chính tả và Viết hoa',
    Punctuation: 'Dấu câu',
    Grammar: 'Ngữ pháp',
    Spelling: 'Chính tả',
    Vocabulary: 'Từ vựng',
    Cohesion: 'Tính liên kết',
    Naturalness: 'Độ tự nhiên',
    'Temporal Consistency': 'Tính nhất quán thời gian',
    IELTS_TASK1: 'IELTS Task 1',
    IELTS_TASK2: 'IELTS Task 2',
    TOEIC_WRITING: 'TOEIC Writing',
    GENERAL_ACADEMIC: 'General / Academic',
    Everyday: 'Đời sống và Suy ngẫm',
    Academic: 'Học thuật và Luận điểm',
    Work: 'Công việc và Chuyên môn',
    Creative: 'Sáng tạo và Tự sự',
    General: 'Tổng quát',
    'Opinion & Argument': 'Nghị luận và Quan điểm',
    'Problem & Solution': 'Vấn đề và Giải pháp',
    'Cause & Effect': 'Nguyên nhân và Kết quả',
    Comparison: 'So sánh và Đối chiếu'
  };
  return map[cat] || cat;
}
