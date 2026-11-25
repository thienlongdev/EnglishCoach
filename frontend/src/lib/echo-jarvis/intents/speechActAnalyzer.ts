/**
 * Deterministic Speech-Act, Quote-Masking, Negation, Hypothetical, and Repair Analyzer (`Plane A`).
 *
 * Prevents surface substring collisions before fast-path compilation or utterance guard evaluation:
 * 1. Masks untrusted quoted spans (`"..."`, `'...'`, `“...”`, `` `...` ``, `«...»`) with `__quoted__`
 *    while preserving English contractions (`don't`, `I'd`, `I'm`, `let's`, `today's`, `what's`).
 * 2. Delegates `METALINGUISTIC_MENTION`, `HYPOTHETICAL_CONDITION`, `NEGATED_OR_DEFERRED`, and
 *    `TRUE_INFO_QUESTION` turns to `Plane B` (`EchoLearnerBrain`) instead of misfiring UI actions
 *    or false `DENIED` guards.
 * 3. Extracts the intended target clause from intra-utterance and discourse `REPAIR_DIRECTIVE` turns.
 * 4. Distinguishes `POLITE_DIRECTIVE` requests ending with `?` from genuine `TRUE_INFO_QUESTION`s.
 */

export const QUOTED_SPAN_TOKEN = '__quoted__';

export type EchoSpeechActKind =
  | 'DIRECT_COMMAND'
  | 'POLITE_DIRECTIVE'
  | 'REPAIR_DIRECTIVE'
  | 'METALINGUISTIC_MENTION'
  | 'HYPOTHETICAL_CONDITION'
  | 'NEGATED_OR_DEFERRED'
  | 'TRUE_INFO_QUESTION';

export interface MaskedQuoteResult {
  readonly masked: string;
  readonly quotedSpans: readonly string[];
  readonly hadQuotes: boolean;
}

export interface SpeechActAnalysis {
  readonly kind: EchoSpeechActKind;
  readonly maskedText: string;
  readonly effectiveText: string;
  readonly hadQuotes: boolean;
  readonly quotedSpans: readonly string[];
  readonly delegatesToBrain: boolean;
  readonly suppressesGuard: boolean;
  readonly reason: string;
}

const VI_DIACRITIC_RE =
  /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;

const INTRA_WORD_CURLY_APOSTROPHE_RE = /(?<=[A-Za-zÀ-ỹ0-9])[’ʼ](?=[A-Za-zÀ-ỹ0-9])/g;

/**
 * Matches fenced code blocks, inline backticks, double quotes, curly quotes, guillemets,
 * markdown blockquotes, and boundary-delimited single-quoted spans while preserving
 * intra-word contractions (`don't`, `I'd`, `I'm`, `let's`, `today's`, `what's`).
 */
const SAFE_QUOTE_MASK_RE =
  /```[\s\S]*?```|`[^`]*`|"[^"]*"|“[^”]*”|„[^”]*”|«[^»]*»|‘[^’]*’|(?:^|\n)\s*>[^\n]*|(?:^|(?<=[\s(\[{,:;=]))'(?:[^'\n]|(?<=[A-Za-z0-9])'(?=[A-Za-z0-9]))+'(?=\s|$|[.,!?:;)\]}])/g;

function foldSpeechText(input: string): string {
  return (input || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9_'\s.:/?=-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripLeadingVocatives(folded: string): string {
  return folded
    .replace(
      /^(?:(?:hi|high|hey|hello|ok|okay|yo|echo|jarvis|echo jarvis|echo oi|jarvis oi|ban oi|anh oi|chi oi|em oi|nay)\s+){1,4}/,
      '',
    )
    .trim();
}

/**
 * Replaces untrusted quoted spans with ` __quoted__ ` (never empty `""`), preventing
 * `Open "anything" reading` from collapsing into `Open reading`.
 */
export function maskQuotedSpans(raw: string): MaskedQuoteResult {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { masked: '', quotedSpans: [], hadQuotes: false };
  }
  const normalizedApostrophes = raw.replace(INTRA_WORD_CURLY_APOSTROPHE_RE, "'");
  const quotedSpans: string[] = [];
  const masked = normalizedApostrophes
    .replace(SAFE_QUOTE_MASK_RE, (match) => {
      quotedSpans.push(match);
      return ` ${QUOTED_SPAN_TOKEN} `;
    })
    .replace(/\s+/g, ' ')
    .trim();
  return {
    masked,
    quotedSpans,
    hadQuotes: quotedSpans.length > 0,
  };
}

const METALINGUISTIC_QUOTED_CUE_RE =
  /\b(?:mean|means|meaning|translate|translation|in vietnamese|in english|into vietnamese|into english|tieng viet|tieng anh|nghia la|co nghia|la gi|dich|pronounce|pronunciation|phat am|spell|spelled|spelling|danh van|how to say|say in|grammar)\b/;

const METALINGUISTIC_LEADING_RE =
  /^(?:what does|what is the meaning of|how do (?:i|you|we) (?:say|translate|pronounce|spell|use)|translate\b|dich(?:\s+cum|\s+cau|\s+tu|\s+doan|\s+sang)?\b)/;

const METALINGUISTIC_TRAILING_RE =
  /\b(?:nghia la gi|co nghia la gi|co nghia gi|dich sang tieng (?:viet|anh)|trong tieng (?:viet|anh) la gi)\s*[.!?]*$/;

const HYPOTHETICAL_RE =
  /\b(?:if i (?:said|say|ask|asked|click|clicked|tap|tapped|open|opened|delete|deleted|cancel|cancelled|canceled|reset|turn|turned|switch|switched|log\s*out|logged\s*out|sign\s*out|signed\s*out)|what (?:would happen|happens|will happen) if|suppose i\b|assuming i\b|neu (?:minh|toi|em|tui|anh|chi) (?:noi|bam|nhan|mo|xoa|huy|dang xuat|thoat|tat|bat|chuyen|dat lai)|gia su (?:minh|toi|em|tui))\b/;

const POSITIVE_UI_TOGGLE_EN_RE =
  /\b(?:turn off|switch off|disable|hide|auto[- ]?hide|mute|unmute|pause|stop)\s+(?:the\s+)?(?:dark mode|dark theme|light mode|night mode|hands[- ]?free|wake word|captions?|subtitles?|transcript|navigation|sidebar|dock|menu|music|audio|lesson|listening|mic|microphone)\b/;

const POSITIVE_UI_TOGGLE_VI_RE =
  /\b(?:tat|an|tu an|tam dung|dung|ngung)\s+(?:che do (?:toi|sang|ranh tay)|nen toi|giao dien toi|hands[- ]?free|phu de(?:\s+echo)?|loi thoai|transcript|thanh (?:dieu huong|ben)|dock|menu|nhac|bai nghe|nghe|mic|micro)\b/;

const NEGATED_EN_RE =
  /\b(?:don(?:'|\s+)?t|dont|do not|never|avoid|no need to|not now|not yet|wait before|hold off on|do not want to|don(?:'|\s+)?t want to|dont want to|rather not|let(?:'|\s+)?s not|lets not)\b/;

const NEGATED_EN_TRAILING_RE = /\b(?:not right now|not yet|maybe later)\s*[.!?]*$/;

const NEGATED_VI_UNICODE_RE =
  /(?:^|\s)(?:đừng(?:\s+vội)?|thôi\s+đừng|(?<!tài\s)khoan(?:\s+(?:hãy|đã|vội|mở|chuyển|vào|xóa))?|chưa(?:\s+(?:cần|muốn|mở|vào|chuyển|vội))?|không\s+(?:cần|muốn|mở|chuyển|vào|đi|xóa|đăng\s+xuất|thoát))(?=\s|$|[.,!?])/iu;

const NEGATED_VI_UNICODE_TRAILING_RE =
  /(?:^|\s)(?:chưa\s+đã|(?<!tài\s)khoan\s+đã|để\s+sau(?:\s+nhé|\s+nha)?)\s*[.!?]*$/iu;

const NEGATED_VI_ASCII_RE =
  /\b(?:dung\s+(?:voi|mo|chuyen|vao|di|xoa|dang\s+xuat|thoat)|thoi\s+dung|(?<!tai\s)khoan\s+(?:hay|da|voi|mo|chuyen|vao)|(?<!tai\s)khoan$|(?:^|\s)chua\s+(?:can|muon|mo|vao|chuyen|voi)|khong\s+(?:can|muon|mo|chuyen|vao|di|xoa|dang\s+xuat|thoat))\b/;

const NEGATED_VI_ASCII_TRAILING_RE =
  /\b(?:chua\s+da|(?<!tai\s)khoan\s+da|de\s+sau(?:\s+nhe|\s+nha)?)\s*[.!?]*$/;

const INTRA_REPAIR_EN_RE =
  /^.+?(?:,\s*|\s+[—–-]\s*|\.\.\.\s*|\s+)(?:wait\s*,?\s*(?:no|actually|instead)|no\s*,?\s*wait|oh\s+wait(?:\s*,?\s*no)?|sorry\s*,?\s*(?:no\s*,?\s*)?(?:i\s+mean|i\s+meant)|i\s+meant|scratch\s+that|never\s*mind\s*,|actually\s*,|actually(?=\s+(?:open|go|navigate|take|bring|switch|launch|enter|show|turn|enable|disable|play|pause|scroll|set|use)\b)|instead\s*,)\s*,?\s*(.+)$/i;

const INTRA_REPAIR_VI_RE =
  /^.+?(?:,\s*|\s+[—–-]\s*|\.\.\.\s*|\s+)(?:khoan\s*,?\s*không\s+phải|khoan\s*,?\s*khong\s+phai|không\s+phải\s*,|khong\s+phai\s*,|à\s+nhầm|a\s+nham|à\s+quên|a\s+quen|à\s+không|a\s+khong|ờ\s+không|o\s+khong|nhầm\s*,|nham\s*,|ý\s+(?:mình|tôi|em)\s+là|y\s+(?:minh|toi|em)\s+la|thôi(?=\s+(?:mở|mo|chuyển|chuyen|vào|vao|đưa|dua|cho|bật|bat|tắt|tat)(?:\s|$))|thay\s+vào\s+đó|thay\s+vao\s+do)\s*,?\s*(.+)$/iu;

const NEGATED_PREFIX_REPAIR_RE =
  /^(?:don'?t|do not|không|khong|đừng)\s+[^,;.!?]+,\s*((?:open|go to|take me to|switch to|launch|enter|show|bring up|pull up|jump into|mở|mo|chuyển|chuyen|vào|vao|đưa|dua|cho|xem)(?:\s+.+))$/iu;

const LEADING_REPAIR_EN_RE =
  /^(?:actually|instead|on second thought|rather|wait\s*,?\s*(?:no\s*,?\s*)?)\s*,?\s+(.+)$/i;

const LEADING_REPAIR_VI_RE =
  /^(?:(?:khoan\s*,?\s*không\s+phải|khoan\s*,?\s*khong\s+phai|à\s+không|a\s+khong|à\s+nhầm|a\s+nham|thay\s+vào\s+đó|thay\s+vao\s+do)\s*,?\s+(.+)|(?:thôi|thoi)\s*,?\s+((?:mở|mo|chuyển|chuyen|vào|vao|đưa|dua|cho|bật|bat|tắt|tat|quay|cuộn|cuon|xem)(?:\s+.+)))$/iu;

const TRAILING_REPAIR_MARKER_RE =
  /\s+(?:instead|thay\s+vào\s+đó|thay\s+vao\s+do)\s*([.!?]*)$/iu;

const TRUE_INFO_QUESTION_EN_RE =
  /^(?:what\b|why\b|how\s+(?:many|much|long|often|far|do|does|did|can\s+i\s+improve|to\b|is\b|are\b|about\b)|when\b|where\b|which\b|who\b|whose\b|is\s+(?:my|there|this|it|that)\b|are\s+(?:my|there|these)\b|am\s+i\b|do\s+i\b|does\s+(?:my|this|it)\b|did\s+i\b|have\s+i\b|should\s+i\b|tell\s+me\s+(?:whether|if|about|why|how|what)\b|explain\b)/;

const TRUE_INFO_QUESTION_VI_RE =
  /\b(?:giai thich|tai sao|vi sao|nhu the nao|ra sao|bao nhieu|khi nao|luc nao|o dau|ai la|co cai thien khong|co tien bo khong|co tot khong|co dung khong|co phai khong|la sao)\b/;

const POLITE_QUESTION_EN_LEADING_RE =
  /^(?:(?:please\s+)?(?:can|could|would|will)\s+you\b|(?:may|can|could)\s+i\b)/;

const POLITE_QUESTION_EN_TRAILING_RE =
  /,?\s*(?:please|will\s+you|would\s+you|could\s+you|can\s+you)\s*\?+$/;

const POLITE_QUESTION_VI_ENDING_RE =
  /\b(?:duoc\s+khong|khong|giup\s+(?:minh|toi|em|tui)|cho\s+(?:minh|toi|em|tui)|nhe|nha|ha|hen|nghen)\s*\?+$/;

const ACTION_OR_NAV_VERB_CUE_RE =
  /\b(?:open|go|navigate|take|bring|pull|jump|head|review|switch|change|launch|enter|show|visit|turn|enable|disable|set|use|apply|darken|brighten|reset|customize|look up|define|continue|resume|increase|decrease|make|zoom|filter|play|pause|stop|next|previous|prev|skip|shuffle|replay|repeat|slow|speed|scroll|pin|auto-hide|embed|undo|revert|log out|logout|sign out|mute|unmute|sleep|mo|xem|vao|vo|di|dua|chuyen|doi|bat|tat|an|hien|ghim|cuon|keo|luot|tang|giam|dat lai|khoi phuc|tra|doc|lat|loc|phat|tam dung|nghe|quay|tro|hoan tac|dang xuat)\b/;

function extractRepairDirective(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  let candidate: string | null = null;

  const intraEn = INTRA_REPAIR_EN_RE.exec(trimmed);
  if (intraEn?.[1]) {
    candidate = intraEn[1].trim();
  } else {
    const intraVi = INTRA_REPAIR_VI_RE.exec(trimmed);
    if (intraVi?.[1]) {
      candidate = intraVi[1].trim();
    } else {
      const negPivot = NEGATED_PREFIX_REPAIR_RE.exec(trimmed);
      if (negPivot?.[1]) {
        candidate = negPivot[1].trim();
      } else {
        const leadEn = LEADING_REPAIR_EN_RE.exec(trimmed);
        if (leadEn?.[1]) {
          candidate = leadEn[1].trim();
        } else {
          const leadVi = LEADING_REPAIR_VI_RE.exec(trimmed);
          if (leadVi) {
            candidate = (leadVi[1] || leadVi[2] || '').trim();
          } else if (TRAILING_REPAIR_MARKER_RE.test(trimmed)) {
            candidate = trimmed.replace(TRAILING_REPAIR_MARKER_RE, '$1').trim();
          }
        }
      }
    }
  }

  if (!candidate) return null;
  candidate = candidate
    .replace(/^[,;—–-]+\s*/, '')
    .replace(TRAILING_REPAIR_MARKER_RE, '$1')
    .trim();
  return candidate || null;
}

function isNegatedOrDeferredClause(rawText: string, foldedText: string): boolean {
  if (!foldedText) return false;
  if (POSITIVE_UI_TOGGLE_EN_RE.test(foldedText) || POSITIVE_UI_TOGGLE_VI_RE.test(foldedText)) {
    return false;
  }
  if (NEGATED_EN_RE.test(foldedText) || NEGATED_EN_TRAILING_RE.test(foldedText)) {
    return true;
  }
  if (VI_DIACRITIC_RE.test(rawText)) {
    if (NEGATED_VI_UNICODE_RE.test(rawText) || NEGATED_VI_UNICODE_TRAILING_RE.test(rawText)) {
      return true;
    }
    return false;
  }
  return NEGATED_VI_ASCII_RE.test(foldedText) || NEGATED_VI_ASCII_TRAILING_RE.test(foldedText);
}

/**
 * Classifies the primary speech act of a raw learner utterance (`< 0.15 ms`).
 */
export function analyzeSpeechAct(rawUtterance: string): SpeechActAnalysis {
  const raw = typeof rawUtterance === 'string' ? rawUtterance.trim() : '';
  if (!raw) {
    return {
      kind: 'DIRECT_COMMAND',
      maskedText: '',
      effectiveText: '',
      hadQuotes: false,
      quotedSpans: [],
      delegatesToBrain: false,
      suppressesGuard: false,
      reason: 'empty',
    };
  }

  const maskedRes = maskQuotedSpans(raw);
  const maskedText = maskedRes.masked;
  const foldedMasked = foldSpeechText(maskedText);
  const coreFolded = stripLeadingVocatives(foldedMasked);

  // 1. Metalinguistic mention (`What does "open reading" mean?`, `Translate "sign out" into Vietnamese`)
  if (
    (maskedRes.hadQuotes && METALINGUISTIC_QUOTED_CUE_RE.test(coreFolded)) ||
    METALINGUISTIC_LEADING_RE.test(coreFolded) ||
    METALINGUISTIC_TRAILING_RE.test(coreFolded)
  ) {
    return {
      kind: 'METALINGUISTIC_MENTION',
      maskedText,
      effectiveText: maskedText,
      hadQuotes: maskedRes.hadQuotes,
      quotedSpans: maskedRes.quotedSpans,
      delegatesToBrain: true,
      suppressesGuard: true,
      reason: 'metalinguistic_mention',
    };
  }

  // 2. Hypothetical / conditional (`If I delete my account, what happens?`)
  if (HYPOTHETICAL_RE.test(coreFolded)) {
    return {
      kind: 'HYPOTHETICAL_CONDITION',
      maskedText,
      effectiveText: maskedText,
      hadQuotes: maskedRes.hadQuotes,
      quotedSpans: maskedRes.quotedSpans,
      delegatesToBrain: true,
      suppressesGuard: true,
      reason: 'hypothetical_condition',
    };
  }

  // 3. Discourse / intra-utterance repair (`open reading, wait no, open listening`)
  const repaired = extractRepairDirective(maskedText);
  const effectiveText = repaired ?? maskedText;
  const foldedEffective = stripLeadingVocatives(foldSpeechText(effectiveText));

  // 4. Negated or deferred directive (`Don't open reading`, `Don't delete my account`, `Khoan mở phần nói`)
  if (isNegatedOrDeferredClause(effectiveText, foldedEffective)) {
    return {
      kind: 'NEGATED_OR_DEFERRED',
      maskedText,
      effectiveText,
      hadQuotes: maskedRes.hadQuotes,
      quotedSpans: maskedRes.quotedSpans,
      delegatesToBrain: true,
      suppressesGuard: true,
      reason: 'negated_or_deferred',
    };
  }

  // 5. True information-seeking question vs Polite directive with `?`
  if (TRUE_INFO_QUESTION_EN_RE.test(foldedEffective) || TRUE_INFO_QUESTION_VI_RE.test(foldedEffective)) {
    return {
      kind: 'TRUE_INFO_QUESTION',
      maskedText,
      effectiveText,
      hadQuotes: maskedRes.hadQuotes,
      quotedSpans: maskedRes.quotedSpans,
      delegatesToBrain: true,
      suppressesGuard: false,
      reason: 'true_info_question',
    };
  }

  if (/\?\s*$/.test(effectiveText)) {
    const foldedWithQuestion = `${foldedEffective}?`;
    const isPoliteFrame =
      POLITE_QUESTION_EN_LEADING_RE.test(foldedEffective) ||
      POLITE_QUESTION_EN_TRAILING_RE.test(foldedWithQuestion) ||
      POLITE_QUESTION_VI_ENDING_RE.test(foldedWithQuestion);
    if (isPoliteFrame && ACTION_OR_NAV_VERB_CUE_RE.test(foldedEffective)) {
      return {
        kind: repaired ? 'REPAIR_DIRECTIVE' : 'POLITE_DIRECTIVE',
        maskedText,
        effectiveText: effectiveText.replace(/\?+\s*$/, '').trim(),
        hadQuotes: maskedRes.hadQuotes,
        quotedSpans: maskedRes.quotedSpans,
        delegatesToBrain: false,
        suppressesGuard: false,
        reason: repaired ? 'repaired_polite_directive' : 'polite_question_directive',
      };
    }
    return {
      kind: 'TRUE_INFO_QUESTION',
      maskedText,
      effectiveText,
      hadQuotes: maskedRes.hadQuotes,
      quotedSpans: maskedRes.quotedSpans,
      delegatesToBrain: true,
      suppressesGuard: false,
      reason: 'unframed_question_mark',
    };
  }

  if (repaired) {
    return {
      kind: 'REPAIR_DIRECTIVE',
      maskedText,
      effectiveText,
      hadQuotes: maskedRes.hadQuotes,
      quotedSpans: maskedRes.quotedSpans,
      delegatesToBrain: false,
      suppressesGuard: false,
      reason: 'discourse_repair',
    };
  }

  return {
    kind: 'DIRECT_COMMAND',
    maskedText,
    effectiveText,
    hadQuotes: maskedRes.hadQuotes,
    quotedSpans: maskedRes.quotedSpans,
    delegatesToBrain: false,
    suppressesGuard: false,
    reason: 'direct_command',
  };
}
