/**
 * Zero-LLM Bilingual Fast-Path Intent and Compound Utterance Compiler (`< 15 ms` budget).
 *
 * Parses natural English and Vietnamese utterances (including Northern and Southern ASR variants
 * and compound `and / then / rồi / và / sau đó` clauses) into typed `EchoClientIntent[]` plans
 * with instant localized spoken acknowledgements.
 *
 * Returns `null` whenever pedagogical reasoning, personal analytics, translation, explanation,
 * or server catalog DB search is needed so `EchoLearnerBrain` handles those turns seamlessly.
 */

import {
  type EchoBgPresetId,
  type EchoBookTheme,
  type EchoCefrLevel,
  type EchoClientIntent,
  type EchoReadingTab,
  type EchoReadingWidth,
  type EchoStudioRoom,
} from './actionSchema';
import {
  type PermissionEvalContext,
  type PermissionEvaluation,
  dequoteUntrustedText,
  detectUtteranceGuard,
  matchPendingConfirmationDecision,
  normalizeAsciiFold,
} from './permissionEngine';
import {
  type EchoSalientResource,
  getSessionSalientResources,
  resolveSalienceUtterance,
} from './salienceTracker';
import { QUOTED_SPAN_TOKEN, analyzeSpeechAct } from './speechActAnalyzer';
import { hasActivePendingConfirmation } from './voiceSessionStore';

export interface FastPathCompileOptions {
  pathname?: string;
  searchParams?: { get(name: string): string | null } | URLSearchParams | null;
  hasActiveStrictSentinel?: boolean;
  hasPendingConfirmation?: boolean;
  salientResources?: readonly EchoSalientResource[] | null;
  sessionId?: number | string | null;
}

export interface FastPathMatch {
  language: 'en' | 'vi';
  spokenAck: string;
  intents: EchoClientIntent[];
  clauses: string[];
  elapsedMs: number;
}

export interface GuardEvaluationWithSpeech extends PermissionEvaluation {
  spokenMessageEn: string;
  spokenMessageVi: string;
}

export interface UtteranceCompileOutcome {
  guard: GuardEvaluationWithSpeech | null;
  fastPath: FastPathMatch | null;
}

interface CompiledClause {
  intents: EchoClientIntent[];
  ackEn: string;
  ackVi: string;
}

const nowMs = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

const VI_DIACRITIC_RE =
  /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;

const VI_LEXICAL_CUE_RE =
  /\b(mo|bat|tat|chuyen|doi|tang|giam|cuon|keo|luot|sach|tu sach|ke sach|tu dien|tra tu|tra cuu|ngu phap|the tu|on the|xac nhan|dong y|huy|dang xuat|cua toi|cua ban|gan nhat|che do|giao dien|tieng viet|tieng anh|bai nghe|bai doc|am nhac|di ngu|quay lai|tro lai|thanh ben|co chu|phu de|chep chinh ta|luyen noi|luyen viet|luyen nghe|luyen doc|ky nang|nhiem vu|lo trinh|thi thu|bang xep hang|cong dong|khong gian hoc|hoan tac|ho so|phat am|lich su)\b/;

export function detectUtteranceLanguage(raw: string): 'en' | 'vi' {
  if (VI_DIACRITIC_RE.test(raw)) return 'vi';
  const folded = normalizeAsciiFold(raw);
  if (VI_LEXICAL_CUE_RE.test(folded)) return 'vi';
  return 'en';
}

/**
 * Pedagogical, analytical, explanatory, or catalog-search cues that MUST delegate to Plane B
 * (`EchoLearnerBrain` + backend principal-scoped tools).
 */
const BRAIN_DELEGATION_RE =
  /\b(suitable (?:for (?:my|a)|practice (?:scenario|passage|lesson|exercise)|scenario|passage)|for my level|appropriate for|recommend|suggest|find me\b|search for\b|pick (?:a|me)|choose a\b|explain|why\b|how do (?:i|you|we)|how can i improve|what does\b|what is the difference|difference between|translate\b|correct my\b|check my (?:grammar|writing|sentence|essay)|quiz me|test me on|practice (?:speaking|conversation) with me|how many (?:cards|flashcards|days|messages|words)|my streak|my (?:ielts|toeic) (?:band|score)|recent learning progress|practice next|study plan|create (?:a )?flashcards?|save this word|phu hop|trinh do cua (?:minh|toi|em)|goi y|tim cho (?:minh|toi|em|tui)|tim giup|chon giup|giai thich|tai sao|vi sao|khac nhau|nghia la gi|(?<!luyen )dich (?:sang|giup|cau|doan)|sua loi|kiem tra cau|bao nhieu (?:the|ngay|tin nhan|luot)|chuoi ngay hoc|diem (?:ielts|toeic)|tien trinh hoc gan day|nen luyen gi|ke hoach hoc|tao the tu)\b/;

const POLITE_PREFIX_RE =
  /^(?:(?:hi|high|hey|hello|ok|okay|yo|echo|jarvis|echo jarvis|echo oi|jarvis oi|ban oi|anh oi|chi oi|em oi|nay|e)\s+){0,4}(?:(?:please|kindly|can you|could you|would you|will you|may i|can i|could i|i want to|i d like to|id like to|i would like to|i d love to|id love to|i would love to|i need to|let me|let s|lets|help me(?:\s+to)?|hay|vui long|lam on|(?:minh|toi|em|tui|anh|chi)\s+(?:muon|can)|(?:giup|gium|dum|cho|dua)\s+(?:minh|toi|em|tui)|nho\s+(?:ban|echo(?:\s+jarvis)?|jarvis)|ban(?=\s+(?:mo|vao|chuyen|dua|cho|giup|bat|tat|an|hien|quay|cuon|tang|giam|xem)\b))\s+){1,3}/;

const POLITE_VOCATIVE_ONLY_PREFIX_RE =
  /^(?:(?:hi|high|hey|hello|ok|okay|yo|echo|jarvis|echo jarvis|echo oi|jarvis oi|ban oi|anh oi|chi oi|em oi|nay|e)\s+){1,4}/;

const WEBSITE_CONTAINER_SUFFIX_RE =
  /\s+(?:(?:in|on|inside|within|from|at|into|across)\s+(?:(?:my|the|this|our)\s+)?(?:english\s+coach(?:\s+[a-z0-9_-]+)?|website|web\s*app|site|app|application|platform|portal|workspace|system)|(?:trong|tren|o|tai)\s+(?:trang\s+web|website|web|ung\s+dung|app|cong\s+thong\s+tin|nen\s+tang|he\s+thong|english\s+coach)(?:\s+cua\s+(?:minh|toi|em|tui|ban|chung\s+ta))?)$/g;

const POLITE_SUFFIX_RE =
  /\s+(?:please|now|right now|for me|thanks|thank you|duoc khong|echo oi|jarvis oi|(?:di|nhe|nha|voi|luon|ngay|ha|hen|khong)\s+(?:echo(?:\s+jarvis)?|jarvis|ban)|(?:cho|giup|gium|dum)\s+(?:minh|toi|em|tui)(?:\s+(?:xem|coi)(?:\s+voi|\s+thu)?)?|nhe|nha|nha ban|nghen|hen|ha|voi|dum|gium|luon|ngay|di|khong)$/g;

function cleanClause(raw: string): string {
  let s = normalizeAsciiFold(raw).replace(/[.!?:,]+$/g, '').replace(/\s+/g, ' ').trim();
  let prev = '';
  while (s && s !== prev) {
    prev = s;
    s = s.replace(POLITE_PREFIX_RE, '').replace(POLITE_VOCATIVE_ONLY_PREFIX_RE, '').trim();
  }
  prev = '';
  while (s && s !== prev) {
    prev = s;
    s = s.replace(WEBSITE_CONTAINER_SUFFIX_RE, '').replace(POLITE_SUFFIX_RE, '').trim();
  }
  return s;
}

/**
 * Allows a single quoted lexical headword ONLY when preceded directly by an unquoted dictionary command,
 * e.g. `look up "break the ice"`, `look up the word "meticulous" in the dictionary for me`, or `tra từ "resilient"`.
 * Any other quoted text is stripped as untrusted.
 */
const SAFE_DICT_TAIL_QUOTE_RE =
  /^([^"'`“”‘’«»?]+?)\s+["“‘']([A-Za-z][A-Za-z0-9' -]{0,48})["”’'](?:\s+(?:(?:in|from|on|inside|into|using|at)\s+(?:(?:the|my|our|your|english)\s+)?dictionary|(?:trong|o|ở|tren|trên|bang|bằng)\s+(?:cuon\s+|cuốn\s+)?(?:tu\s+dien|từ\s+điển)|for\s+(?:me|us)|please|right\s+now|now|(?:giup|giúp|cho|dum|dùm|gium|giùm)\s+(?:minh|mình|toi|tôi|em|tui)|nhe|nhé|nha|voi|với|di|đi)+)*\s*[.!?]?$/iu;

const SAFE_DICT_PREFIX_FOLDED_RE =
  /\b(?:look up(?: (?:the |a |an )?(?:word|vocabulary|vocab|term|phrase|idiom))?|define(?: (?:the |a |an )?(?:word|vocabulary|vocab|term|phrase|idiom))?|dictionary for|tra(?:\s+cuu)?(?:\s+nghia(?:\s+cua)?)?(?:\s+(?:tu(?:\s+vung)?|cum\s+tu|thanh\s+ngu))?)$/;

const DICT_COMMAND_PREFIX_RE =
  /^(?:open (?:the |my )?dictionary (?:and |to )?(?:look up|search(?: for)?|find|check)|search (?:(?:in|the|my) )?dictionary for|check (?:(?:in|the|my) )?dictionary for|look up|define|mo tu dien(?:\s+va)?\s+(?:tra(?:\s+cuu)?|tim)|tra cuu(?:\s+nghia(?:\s+cua)?)?|tra nghia(?:\s+cua)?|tra tu dien|tra tu vung|tra cum tu|tra thanh ngu|tra tu)\s+(.+)$/;

const DICT_LEADING_LABEL_RE =
  /^(?:(?:the\s+)?meaning\s+of(?:\s+(?:the|a|an|this))?|(?:(?:the|a|an|this)\s+)?(?:word|vocabulary|vocab|term|phrase|idiom|expression)\b|(?:nghia\s+cua\s+)?(?:tu\s+vung|cum\s+tu|thanh\s+ngu|tu)\b)\s+/;

const DICT_TRAILING_LOCATIVE_OR_POLITE_RE =
  /\s+(?:(?:in|from|on|inside|into|using|at|via|with)\s+(?:(?:the|a|an|my|our|your|this|english|built[- ]?in|echo)\s+){0,2}dictionary\b.*|(?:trong|o|tren|bang|vao|tai)\s+(?:cuon\s+|bo\s+)?tu\s+dien\b.*|(?:for\s+(?:me|us)|please|right\s+now|thanks|thank\s+you|(?:giup|gium|dum|cho)\s+(?:minh|toi|em|tui)(?:\s+(?:voi|nhe|nha))?|duoc\s+khong|nhe|nha)\b.*)$/;

function extractDictionaryHeadword(cleaned: string): string | null {
  const m = DICT_COMMAND_PREFIX_RE.exec(cleaned);
  if (!m?.[1]) return null;
  let slot = m[1].replace(/^['"“”‘’`]+|['"“”‘’`]+$/g, '').trim();
  let hadExplicitWordLabel = false;
  let prev = '';
  while (slot && slot !== prev) {
    prev = slot;
    const strippedLead = slot.replace(DICT_LEADING_LABEL_RE, '').trim();
    if (strippedLead && strippedLead !== slot) {
      hadExplicitWordLabel = true;
      slot = strippedLead;
    }
  }
  prev = '';
  while (slot && slot !== prev) {
    prev = slot;
    slot = slot.replace(DICT_TRAILING_LOCATIVE_OR_POLITE_RE, '').trim();
  }
  slot = slot.replace(/^['"“”‘’`]+|['"“”‘’`]+$/g, '').replace(/\s+/g, ' ').trim();
  if (!slot || slot.length > 48 || !/^[a-z][a-z0-9' -]*$/.test(slot)) {
    return null;
  }
  if (!hadExplicitWordLabel && /^(?:(?:the|my|english)\s+)?dictionary$|^tu\s+dien$/.test(slot)) {
    return null;
  }
  if (BRAIN_DELEGATION_RE.test(slot)) {
    return null;
  }
  return slot;
}

function sanitizeUtteranceQuotes(raw: string): { text: string; blockedByQuotes: boolean } {
  const trimmed = (raw || '').trim();
  if (!trimmed) return { text: '', blockedByQuotes: false };

  const tailQuoted = SAFE_DICT_TAIL_QUOTE_RE.exec(trimmed);
  if (tailQuoted && SAFE_DICT_PREFIX_FOLDED_RE.test(normalizeAsciiFold(tailQuoted[1]))) {
    return { text: `${tailQuoted[1]} ${tailQuoted[2]}`, blockedByQuotes: false };
  }

  const { stripped, hadQuotes } = dequoteUntrustedText(trimmed);
  if (hadQuotes) {
    // If the learner quoted passage text without an explicit unquoted command, never execute quoted words.
    if (!stripped) return { text: '', blockedByQuotes: true };
  }
  return { text: stripped, blockedByQuotes: false };
}

// ---------------------------------------------------------------------------
// Preset Catalog Lookup Table (EN + VI names -> canonical presetId)
// ---------------------------------------------------------------------------

const BG_PRESET_MATCHERS: ReadonlyArray<{
  id: EchoBgPresetId;
  enName: string;
  viName: string;
  patterns: readonly string[];
}> = [
  {
    id: 'pearlescent-abyss',
    enName: 'Pearlescent Abyss',
    viName: 'Vực Sâu Ngọc Trai',
    patterns: ['pearlescent abyss', 'pearl abyss', 'vuc sau ngoc trai', 'ngoc trai'],
  },
  {
    id: 'aurora-flow',
    enName: 'Aurora Flow',
    viName: 'Dải Cực Quang',
    patterns: ['aurora flow', 'dai cuc quang', 'cuc quang', 'aurora'],
  },
  {
    id: 'oceanic-glow',
    enName: 'Oceanic Glow',
    viName: 'Ánh Sáng Đại Dương',
    patterns: ['oceanic glow', 'anh sang dai duong', 'ocean glow'],
  },
  {
    id: 'liquid-mesh',
    enName: 'Liquid Mesh',
    viName: 'Lụa Sắc Lưu Chuyển',
    patterns: ['liquid mesh', 'lua sac luu chuyen', 'lua sac'],
  },
  {
    id: 'nebula-atmosphere',
    enName: 'Nebula Atmosphere',
    viName: 'Khí Quyển Tinh Vân',
    patterns: ['nebula atmosphere', 'khi quyen tinh van', 'tinh van', 'nebula'],
  },
  {
    id: 'midnight-sapphire',
    enName: 'Midnight Sapphire',
    viName: 'Lam Ngọc Nửa Đêm',
    patterns: ['midnight sapphire', 'lam ngoc nua dem', 'lam ngoc', 'sapphire'],
  },
  {
    id: 'violet-dream',
    enName: 'Violet Dream',
    viName: 'Giấc Mơ Tử Đinh Hương',
    patterns: ['violet dream', 'giac mo tu dinh huong', 'tu dinh huong'],
  },
  {
    id: 'rose-quartz',
    enName: 'Rose Quartz',
    viName: 'Thạch Anh Hồng',
    patterns: ['rose quartz', 'thach anh hong'],
  },
  {
    id: 'emerald-depth',
    enName: 'Emerald Depth',
    viName: 'Lục Bảo Sâu Thẳm',
    patterns: ['emerald depth', 'luc bao sau tham', 'luc bao'],
  },
  {
    id: 'arctic-crystal',
    enName: 'Arctic Crystal',
    viName: 'Tinh Thể Bắc Cực',
    patterns: ['arctic crystal', 'tinh the bac cuc'],
  },
];

// ---------------------------------------------------------------------------
// Navigation Destination Table (Longest / Most-Specific Phrases First!)
// ---------------------------------------------------------------------------

interface NavEntry {
  phrases: readonly string[];
  href: string;
  en: string;
  vi: string;
  extraIntents?: readonly EchoClientIntent[];
}

const NAV_ENTRIES: readonly NavEntry[] = [
  // Learning Path & Odyssey
  {
    phrases: [
      'echo odyssey',
      'odyssey world',
      'odyssey',
      'the gioi odyssey',
      'hanh trinh odyssey',
    ],
    href: '/learning-path?view=odyssey',
    en: 'Echo Odyssey',
    vi: 'Echo Odyssey',
  },
  {
    phrases: [
      'todays learning path tasks',
      'today s learning path tasks',
      'today learning path tasks',
      'learning path tasks',
      'my learning path tasks',
      'daily learning path tasks',
      'todays study tasks',
      'today s study tasks',
      'todays tasks',
      'today tasks',
      'today s tasks',
      'today plan',
      'learning path',
      'nhiem vu lo trinh hoc hom nay',
      'nhiem vu trong lo trinh hoc hom nay',
      'nhiem vu lo trinh hom nay',
      'nhiem vu hoc tap hom nay',
      'danh sach nhiem vu hom nay',
      'nhiem vu hom nay',
      'lo trinh hoc hom nay',
      'lo trinh hom nay',
      'lo trinh hoc tap',
      'lo trinh hoc',
      'lo trinh',
    ],
    href: '/learning-path?view=list',
    en: "Today's tasks",
    vi: 'Nhiệm vụ hôm nay',
  },

  // Reading sub-tabs
  {
    phrases: [
      'my books',
      'my bookshelf',
      'bookshelf',
      'personal bookshelf',
      'tu sach',
      'ke sach',
      'tu sach cua ban',
      'tu sach cua minh',
      'tu sach cua toi',
      'ke sach cua ban',
      'ke sach cua minh',
      'ke sach cua toi',
      'sach cua minh',
      'sach cua toi',
    ],
    href: '/reading?section=mybooks',
    en: 'My Books',
    vi: 'Tủ sách của bạn',
    extraIntents: [{ kind: 'reading_control', tab: 'mybooks' }],
  },
  {
    phrases: ['bilingual reading', 'doc song ngu', 'bai doc song ngu'],
    href: '/reading?section=bilingual',
    en: 'Bilingual Reading',
    vi: 'Đọc song ngữ',
    extraIntents: [{ kind: 'reading_control', tab: 'bilingual' }],
  },
  {
    phrases: ['speed reading', 'speed reader', 'doc nhanh', 'luyen doc nhanh'],
    href: '/reading?section=speed',
    en: 'Speed Reading',
    vi: 'Đọc nhanh',
    extraIntents: [{ kind: 'reading_control', tab: 'speed' }],
  },

  // Speaking sub-routes
  {
    phrases: ['speaking arena', 'echo archipelago', 'dau truong noi', 'dao luyen noi', 'arena'],
    href: '/speaking/arena',
    en: 'Speaking Arena',
    vi: 'Đấu trường luyện nói',
  },
  {
    phrases: [
      'pronunciation analytics',
      'pronunciation profile',
      'pronunciation stats',
      'speaking pronunciation',
      'speaking profile pronunciation',
      'pronunciation section of my profile',
      'pronunciation section of my speaking profile',
      'pronunciation section of profile',
      'pronunciation tab of my profile',
      'pronunciation in my speaking profile',
      'pronunciation in my profile',
      'pronunciation from my profile',
      'pronunciation tab',
      'phan tich phat am',
      'phan tich phat am cua toi',
      'phan tich phat am cua minh',
      'phan phat am trong ho so luyen noi',
      'muc phat am trong ho so luyen noi',
      'phat am trong ho so luyen noi',
      'phan phat am trong ho so',
      'muc phat am trong ho so',
      'ho so phat am',
      'thong ke phat am',
      'chi so phat am',
    ],
    href: '/speaking?view=profile&sub=pronunciation',
    en: 'Pronunciation Analytics',
    vi: 'Phân tích phát âm',
    extraIntents: [{ kind: 'speaking_control', view: 'profile', sub: 'pronunciation' }],
  },
  {
    phrases: [
      'speaking history',
      'speaking session history',
      'speaking sessions',
      'lich su luyen noi',
      'lich su luyen noi cua toi',
      'lich su luyen noi cua minh',
      'lich su phien noi',
    ],
    href: '/speaking?view=profile&sub=history',
    en: 'Speaking History',
    vi: 'Lịch sử luyện nói',
    extraIntents: [{ kind: 'speaking_control', view: 'profile', sub: 'history' }],
  },
  {
    phrases: [
      'speaking profile',
      'speaking analytics',
      'speaking progress',
      'speaking stats',
      'speaking statistics',
      'speaking overview',
      'ho so luyen noi',
      'ho so luyen noi cua toi',
      'ho so luyen noi cua minh',
      'phan tich luyen noi',
      'thong ke luyen noi',
      'tong quan luyen noi',
    ],
    href: '/speaking?view=profile',
    en: 'Speaking Profile',
    vi: 'Hồ sơ luyện nói',
    extraIntents: [{ kind: 'speaking_control', view: 'profile' }],
  },
  {
    phrases: [
      'shadowing studio',
      'shadowing practice',
      'speaking shadowing',
      'shadowing',
      'luyen phat am shadowing',
      'luyen noi shadowing',
      'che do shadowing',
      'nhai giong',
    ],
    href: '/speaking?mode=shadowing',
    en: 'Shadowing Studio',
    vi: 'Luyện phát âm Shadowing',
  },
  {
    phrases: ['speaking quick check', 'pronunciation check', 'quick check', 'kiem tra noi nhanh', 'kiem tra phat am'],
    href: '/speaking?mode=assessment',
    en: 'Speaking Quick Check',
    vi: 'Kiểm tra nói nhanh',
  },
  {
    phrases: ['roleplay scenarios', 'roleplay studio', 'speaking roleplay', 'roleplay', 'nhap vai giao tiep', 'luyen hoi thoai nhap vai'],
    href: '/speaking?mode=roleplay',
    en: 'Speaking Roleplay',
    vi: 'Hội thoại nhập vai',
  },
  {
    phrases: ['topic speaking', 'speak by topic', 'noi theo chu de'],
    href: '/speaking?mode=topic',
    en: 'Topic Speaking',
    vi: 'Nói theo chủ đề',
  },

  // Writing rooms
  {
    phrases: ['paragraph translation', 'dich doan van', 'luyen dich doan van', 'luyen dich doan'],
    href: '/writing?w=translation&mode=PARAGRAPH',
    en: 'Paragraph Translation',
    vi: 'Luyện dịch đoạn văn',
  },
  {
    phrases: ['sentence mistakes', 'writing mistakes', 'loi dat cau', 'loi viet thuong gap'],
    href: '/writing?w=sentence-lab&lab=mistakes',
    en: 'Recurring Sentence Mistakes',
    vi: 'Lỗi đặt câu thường gặp',
  },
  {
    phrases: ['writing sentence lab', 'sentence lab', 'sentence check', 'phong luyen dat cau', 'luyen dat cau', 'kiem tra dat cau'],
    href: '/writing?w=sentence-lab',
    en: 'Sentence Lab',
    vi: 'Phòng luyện đặt câu',
  },
  {
    phrases: ['typing practice', 'writing typing', 'luyen go tieng anh', 'luyen danh may'],
    href: '/writing?w=typing',
    en: 'Typing Practice',
    vi: 'Luyện gõ tiếng Anh',
  },
  {
    phrases: ['writing coach', 'essay studio', 'essay coach', 'phong viet luan', 'luyen viet luan'],
    href: '/writing?w=coach',
    en: 'Writing Coach',
    vi: 'Phòng luyện viết luận',
  },
  {
    phrases: ['writing portfolio', 'essay portfolio', 'portfolio', 'bo suu tap bai viet', 'ho so bai viet'],
    href: '/writing?w=portfolio',
    en: 'Writing Portfolio',
    vi: 'Bộ sưu tập bài viết',
  },
  {
    phrases: ['translation studio', 'translation practice', 'luyen dich cau', 'luyen dich'],
    href: '/writing?w=translation',
    en: 'Translation Practice',
    vi: 'Luyện dịch',
  },

  // Grammar sub-routes
  {
    phrases: ['grammar mistakes', 'loi ngu phap cua ban', 'loi ngu phap'],
    href: '/grammar/mistakes',
    en: 'Grammar Mistakes',
    vi: 'Lỗi ngữ pháp của bạn',
  },
  {
    phrases: ['grammar practice', 'luyen tap ngu phap', 'luyen ngu phap', 'bai tap ngu phap'],
    href: '/grammar/practice',
    en: 'Grammar Practice',
    vi: 'Luyện ngữ pháp',
  },
  {
    phrases: ['grammar library', 'thu vien ngu phap'],
    href: '/grammar/library',
    en: 'Grammar Library',
    vi: 'Thư viện ngữ pháp',
  },
  {
    phrases: ['grammar stories', 'cau chuyen ngu phap', 'truyen ngu phap'],
    href: '/grammar/stories',
    en: 'Grammar Stories',
    vi: 'Câu chuyện ngữ pháp',
  },
  {
    phrases: ['grammar lab', 'phong thi nghiem ngu phap'],
    href: '/grammar/lab',
    en: 'Grammar Lab',
    vi: 'Phòng thí nghiệm ngữ pháp',
  },
  {
    phrases: ['grammar detective', 'tham tu ngu phap'],
    href: '/grammar/detective',
    en: 'Grammar Detective',
    vi: 'Thám tử ngữ pháp',
  },
  {
    phrases: ['ielts grammar', 'grammar for ielts', 'ngu phap ielts'],
    href: '/grammar/ielts',
    en: 'IELTS Grammar',
    vi: 'Ngữ pháp IELTS',
  },
  {
    phrases: ['toeic grammar', 'grammar for toeic', 'ngu phap toeic'],
    href: '/grammar/toeic',
    en: 'TOEIC Grammar',
    vi: 'Ngữ pháp TOEIC',
  },
  {
    phrases: ['real world grammar', 'real-world grammar', 'ngu phap thuc te', 'ngu phap doi song'],
    href: '/grammar/real-world',
    en: 'Real-World Grammar',
    vi: 'Ngữ pháp thực tế',
  },

  // Flashcards sub-routes
  {
    phrases: [
      'learned flashcards',
      'learned cards',
      'review learned flashcards',
      'review learned cards',
      'my learned flashcards',
      'my learned cards',
      'on the tu da hoc',
      'on the da hoc',
      'the tu da hoc',
      'the da hoc',
    ],
    href: '/flashcards?review=learned',
    en: 'Review Learned Cards',
    vi: 'Ôn thẻ đã học',
  },
  {
    phrases: [
      'due flashcards',
      'due cards',
      'review due flashcards',
      'review due cards',
      'my due flashcards',
      'my due cards',
      'flashcards due today',
      'flashcards due',
      'due flashcards today',
      'review cards',
      'the tu den han',
      'the den han hom nay',
      'the den han',
      'on the tu den han',
      'on the den han hom nay',
      'on the den han',
      'on tu vung ngay',
    ],
    href: '/flashcards?review=due',
    en: 'Review Due Cards',
    vi: 'Ôn thẻ đến hạn',
  },

  // Listening dashboard
  {
    phrases: ['listening dashboard', 'listening analytics', 'thong ke luyen nghe', 'thong ke nghe', 'bang thong ke nghe'],
    href: '/listening/dashboard',
    en: 'Listening Analytics',
    vi: 'Thống kê luyện nghe',
  },

  // Exams sub-routes
  {
    phrases: ['assessment profile', 'exam profile', 'ho so danh gia nang luc', 'ho so danh gia'],
    href: '/exams/profile',
    en: 'Assessment Profile',
    vi: 'Hồ sơ đánh giá năng lực',
  },
  {
    phrases: ['ielts exams', 'ielts mock test', 'ielts tests', 'thi thu ielts', 'de thi ielts'],
    href: '/exams/ielts',
    en: 'IELTS Mock Exams',
    vi: 'Thi thử IELTS',
  },
  {
    phrases: ['toeic exams', 'toeic mock test', 'toeic tests', 'thi thu toeic', 'de thi toeic'],
    href: '/exams/toeic',
    en: 'TOEIC Mock Exams',
    vi: 'Thi thử TOEIC',
  },

  // Games sub-routes
  {
    phrases: ['word chain', 'game noi tu', 'tro choi noi tu', 'noi tu'],
    href: '/games/word-chain',
    en: 'Word Chain',
    vi: 'Trò chơi Nối từ',
  },
  {
    phrases: ['king of english', 'soan ngoi', 'vua tieng anh'],
    href: '/games/king-of-english',
    en: 'King of English',
    vi: 'Vua Tiếng Anh',
  },
  {
    phrases: ['hangman', 'doan tu', 'tro choi doan tu'],
    href: '/games/hangman',
    en: 'Hangman',
    vi: 'Trò chơi Đoán từ',
  },
  {
    phrases: ['echo garden', 'vuon echo', 'khu vuon echo'],
    href: '/games/echo-garden',
    en: 'Echo Garden',
    vi: 'Khu vườn Echo',
  },
  {
    phrases: ['echo quiz rush', 'quiz rush', 'dua toc do tu vung'],
    href: '/games/echo-quiz-rush',
    en: 'Echo Quiz Rush',
    vi: 'Echo Quiz Rush',
  },
  {
    phrases: ['echo spelling', 'spelling bee', 'danh van tieng anh', 'thi danh van'],
    href: '/games/echo-spelling',
    en: 'Echo Spelling',
    vi: 'Echo Spelling',
  },

  // Study Space timer & Community messages
  {
    phrases: ['study timer', 'pomodoro timer', 'focus timer', 'dong ho pomodoro', 'hen gio hoc tap', 'dong ho tap trung'],
    href: '/study-space/timer',
    en: 'Study Timer',
    vi: 'Đồng hồ tập trung',
  },
  {
    phrases: ['community messages', 'echo messenger', 'messenger', 'tin nhan cong dong', 'hop thu tin nhan'],
    href: '/community/messages',
    en: 'Messages',
    vi: 'Tin nhắn cộng đồng',
  },

  // Root & Core Module Hubs
  {
    phrases: [
      'home dashboard',
      'main dashboard',
      'dashboard home',
      'dashboard',
      'home page',
      'home screen',
      'home',
      'trang chu',
      'man hinh chinh',
      'bang dieu khien',
    ],
    href: '/dashboard',
    en: 'Dashboard',
    vi: 'Trang chủ',
  },
  {
    phrases: ['learning progress', 'my progress', 'progress', 'tien trinh hoc tap', 'tien trinh', 'thong ke tien do'],
    href: '/progress',
    en: 'Progress',
    vi: 'Tiến trình học tập',
  },
  {
    phrases: ['my profile', 'account profile', 'profile', 'ho so ca nhan', 'trang ca nhan'],
    href: '/profile',
    en: 'Profile',
    vi: 'Hồ sơ cá nhân',
  },
  {
    phrases: ['leaderboard rankings', 'global rankings', 'top rankings', 'leaderboard', 'rankings', 'ranking', 'bang xep hang', 'xep hang'],
    href: '/leaderboard',
    en: 'Leaderboard',
    vi: 'Bảng xếp hạng',
  },
  {
    phrases: ['knowledge universe', 'cosmos', 'vu tru tri thuc'],
    href: '/knowledge-universe',
    en: 'Knowledge Universe',
    vi: 'Vũ trụ tri thức',
  },
  {
    phrases: ['study space', 'echo life', 'khong gian hoc tap'],
    href: '/study-space',
    en: 'Study Space',
    vi: 'Không gian học tập',
  },
  {
    phrases: ['echo music', 'music hub', 'music page', 'trang am nhac', 'phong am nhac'],
    href: '/music',
    en: 'Echo Music',
    vi: 'Âm nhạc',
  },
  {
    phrases: ['premium plans', 'premium page', 'premium', 'goi premium', 'nang cap premium'],
    href: '/premium',
    en: 'Premium',
    vi: 'Gói Premium',
  },
  {
    phrases: ['community', 'cong dong'],
    href: '/community',
    en: 'Community',
    vi: 'Cộng đồng',
  },
  {
    phrases: ['games hub', 'games', 'tro choi', 'khu tro choi'],
    href: '/games',
    en: 'Games',
    vi: 'Trò chơi',
  },
  {
    phrases: ['flashcards', 'flashcard', 'vocabulary cards', 'the tu vung', 'on tu vung', 'tu vung'],
    href: '/flashcards',
    en: 'Flashcards',
    vi: 'Thẻ từ vựng',
  },
  {
    phrases: ['reading library', 'reading', 'luyen doc', 'phan doc', 'muc doc', 'bai doc', 'doc'],
    href: '/reading',
    en: 'Reading',
    vi: 'Đọc',
  },
  {
    phrases: ['listening library', 'listening', 'luyen nghe', 'phan nghe', 'muc nghe', 'nghe'],
    href: '/listening',
    en: 'Listening',
    vi: 'Nghe',
  },
  {
    phrases: ['speaking studio', 'speaking', 'luyen noi', 'phan noi', 'muc noi', 'noi'],
    href: '/speaking',
    en: 'Speaking',
    vi: 'Luyện nói',
  },
  {
    phrases: ['writing studio', 'writing', 'luyen viet', 'phan viet', 'muc viet', 'viet'],
    href: '/writing',
    en: 'Writing',
    vi: 'Viết',
  },
  {
    phrases: ['grammar academy', 'grammar', 'ngu phap', 'phan ngu phap', 'hoc ngu phap'],
    href: '/grammar',
    en: 'Grammar',
    vi: 'Ngữ pháp',
  },
  {
    phrases: ['mock exams', 'exams', 'exam hub', 'thi thu', 'phong thi thu'],
    href: '/exams',
    en: 'Mock Exams',
    vi: 'Thi thử',
  },
];

const NAV_VERB_RE =
  /^(?:open|go over to|go to|navigate to|take me over to|take me into|take me to|bring me to|bring up|pull up|head over to|head to|move to|jump into|jump to|dive into|switch my screen to|switch over to|switch to|launch|enter|show me|show|visit|review|practice|study|train|mo|xem qua|xem|vao|vo|di toi|di den|toi|den|dua minh toi|dua minh den|dua minh sang|dua tui qua|dua tui vo|chuyen sang|chuyen qua|chuyen den|chuyen toi|sang|qua|bat|luyen tap|luyen|on(?=\s+(?:the|tu\s+vung|flashcard)))\s+(.+)$/;

const RELATIVE_PARAPHRASE_EN_RE =
  /^(?:the\s+)?(?:section|place|area|page|module|room|hub|zone|space)\s+where\s+(?:i|we|you)\s+(?:can\s+)?(?:practice|learn|study|train|do)\s+(.+)$/;

const RELATIVE_PARAPHRASE_VI_RE =
  /^(?:cho|noi|phan|khu\s+vuc|khu|trang|muc|goc)\s+(?:de\s+)?(?:(?:minh|toi|em|tui|chung\s+ta)\s+)?(?:co\s+the\s+)?(?:luyen\s+tap|luyen|hoc\s+tap|hoc|tap)\s+(.+)$/;

const LEADING_DETERMINER_RE = /^(?:the|a|an|my|our|this)\s+/;
const TRAILING_POSSESSIVE_VI_RE = /\s+cua\s+(?:minh|toi|em|tui|ban|chung\s+ta)$/;

const LOCATIVE_SECTION_SUFFIX_RE =
  /\s+(?:(?:in|on|inside|within|from|at|into|of)\s+(?:(?:my|the|this|our)\s+)?(?:english\s+coach(?:\s+[a-z0-9_-]+)?|(?:[a-z]+\s+)?(?:section|module|hub|area|studio|profile|page|dashboard)|portal|site|website|web\s*app|app|application|platform|workspace|system)|(?:trong|tren|o|tai)\s+(?:(?:phan|muc|khu\s+vuc|trang|ho\s+so)\s+[a-z0-9\s]+|ho\s+so(?:\s+ca\s+nhan|\s+cua\s+(?:minh|toi|ban))?|trang\s+chu))$/;

const LEADING_CONTAINER_NOUN_VI_RE =
  /^(?:ky\s+nang|tro\s+choi|game|the\s+gioi|khu\s+vuc|man\s+hinh|che\s+do|tinh\s+nang|cong\s+cu|chuc\s+nang|luyen\s+tap|bai\s+tap|phan|muc|trang|khu|goc|phong|luyen|hoc)\s+/;

const TRAILING_CONTAINER_NOUN_RE =
  /\s+(?:(?:in\s+)?(?:full\s*screen|fullscreen|full\s+viewport|immersive(?:\s+mode)?)|toan\s+man\s+hinh|che\s+do\s+toan\s+man\s+hinh|tran\s+vien|module|section|area|zone|space|world|games?|rankings?|hub|studio|room|page|screen|tab|view|feature|part|tool|mode|practice|training|exercises|exercise)$/;

function findExactNavEntry(candidate: string): NavEntry | null {
  if (!candidate) return null;
  for (const entry of NAV_ENTRIES) {
    for (const phrase of entry.phrases) {
      if (candidate === phrase) {
        return entry;
      }
    }
  }
  return null;
}

/**
 * Resolves a navigation target phrase by checking specific sub-destinations FIRST
 * (`speaking profile`, `pronunciation analytics`, `grammar practice`, `study space`, `my books`)
 * before peeling relative paraphrases, possessives, and generic domain container nouns
 * (`module`, `section`, `area`, `practice`, `phan`, `khu vuc`, `luyen tap`) layer-by-layer.
 */
function resolveConceptSlotNavEntry(rawTarget: string): NavEntry | null {
  let cur = rawTarget.trim().replace(/\s+/g, ' ');
  if (!cur || cur.includes(QUOTED_SPAN_TOKEN)) return null;

  const direct = findExactNavEntry(cur);
  if (direct) return direct;

  // Unwrap relative paraphrases ("the section where I can practice speaking", "chỗ để mình luyện nói")
  const relEn = RELATIVE_PARAPHRASE_EN_RE.exec(cur);
  if (relEn?.[1]) {
    cur = relEn[1].trim();
    const hit = findExactNavEntry(cur);
    if (hit) return hit;
  } else {
    const relVi = RELATIVE_PARAPHRASE_VI_RE.exec(cur);
    if (relVi?.[1]) {
      cur = relVi[1].trim();
      const hit = findExactNavEntry(cur);
      if (hit) return hit;
    }
  }

  // Strip outer determiners / possessives while preserving exact sub-destinations like "my books" (already checked above)
  const strippedDet = cur.replace(LEADING_DETERMINER_RE, '').replace(TRAILING_POSSESSIVE_VI_RE, '').trim();
  if (strippedDet && strippedDet !== cur) {
    cur = strippedDet;
    const hit = findExactNavEntry(cur);
    if (hit) return hit;
  }

  // Iteratively peel prepositional locatives and outer container nouns one layer at a time,
  // re-checking specific sub-destinations at each step
  for (let step = 0; step < 6; step++) {
    let next = cur;
    if (LOCATIVE_SECTION_SUFFIX_RE.test(next)) {
      const peeledLoc = next.replace(LOCATIVE_SECTION_SUFFIX_RE, '').trim();
      if (peeledLoc) {
        next = peeledLoc;
        const hit = findExactNavEntry(next);
        if (hit) return hit;
      }
    }
    if (TRAILING_CONTAINER_NOUN_RE.test(next)) {
      const peeled = next.replace(TRAILING_CONTAINER_NOUN_RE, '').trim();
      if (peeled) {
        next = peeled;
        const hit = findExactNavEntry(next);
        if (hit) return hit;
      }
    }
    if (LEADING_CONTAINER_NOUN_VI_RE.test(next)) {
      const peeled = next.replace(LEADING_CONTAINER_NOUN_VI_RE, '').trim();
      if (peeled) {
        next = peeled;
        const hit = findExactNavEntry(next);
        if (hit) return hit;
      }
    }
    const reDet = next.replace(LEADING_DETERMINER_RE, '').replace(TRAILING_POSSESSIVE_VI_RE, '').trim();
    if (reDet && reDet !== next) {
      next = reDet;
      const hit = findExactNavEntry(next);
      if (hit) return hit;
    }
    if (next === cur) break;
    cur = next;
  }

  return findExactNavEntry(cur);
}

// ---------------------------------------------------------------------------
// Single-Clause Deterministic Matcher
// ---------------------------------------------------------------------------

function compileSingleClause(
  rawClause: string,
  hasPendingConfirm: boolean,
  currentPathname: string,
  salientResources?: readonly EchoSalientResource[] | null,
): CompiledClause | null {
  // 1. Pending Confirmation Decision (checked first so bare "yes", "ok", "no", "don't", "khoan" resolve cleanly)
  if (hasPendingConfirm) {
    const decision = matchPendingConfirmationDecision(rawClause);
    if (decision === 'confirm') {
      return {
        intents: [{ kind: 'voice_confirm', decision: 'confirm' }],
        ackEn: 'Confirmed.',
        ackVi: 'Đã xác nhận.',
      };
    }
    if (decision === 'cancel') {
      return {
        intents: [{ kind: 'voice_confirm', decision: 'cancel' }],
        ackEn: 'Cancelled.',
        ackVi: 'Đã hủy thao tác.',
      };
    }
  }

  const clauseSpeechAct = analyzeSpeechAct(rawClause);
  if (clauseSpeechAct.delegatesToBrain) {
    return null;
  }

  const cleaned = cleanClause(clauseSpeechAct.effectiveText);
  if (!cleaned || cleaned.length > 160 || cleaned.includes(QUOTED_SPAN_TOKEN)) return null;

  // 1b. Discourse Salience & Anaphora ("open it", "open the second one", "mở gợi ý số 2", "take me back")
  // Evaluated before `BRAIN_DELEGATION_RE` so anchored ordinal nouns like "mở gợi ý số 2" / "open suggestion 2" resolve!
  const salienceResolved = resolveSalienceUtterance(cleaned, salientResources);
  if (salienceResolved) {
    return {
      intents: salienceResolved.intents,
      ackEn: salienceResolved.ackEn,
      ackVi: salienceResolved.ackVi,
    };
  }

  // Bail out if clause asks a pedagogical / analytical / catalog-search question
  if (BRAIN_DELEGATION_RE.test(cleaned)) {
    return null;
  }

  // 2. Voice Control (`sleep`, `mute`, `unmute`, `compact`, `expand`, `workspace`)
  if (
    /^(?:go to sleep|sleep|sleep mode|stop listening|rest now|turn off hands[- ]?free|disable hands[- ]?free|disable wake word|di ngu|di ngu di|tam nghi|tam nghi di|ngung nghe|tat che do ranh tay|tat hands[- ]?free)$/.test(
      cleaned,
    )
  ) {
    return {
      intents: [{ kind: 'voice_control', command: 'sleep' }],
      ackEn: 'Going to sleep. Say Hey Echo whenever you need me.',
      ackVi: 'Mình tạm nghỉ nhé. Gọi Hey Echo bất cứ khi nào bạn cần.',
    };
  }
  if (/^(?:mute|mute mic|mute microphone|tat mic|tat micro)$/.test(cleaned)) {
    return {
      intents: [{ kind: 'voice_control', command: 'mute' }],
      ackEn: 'Microphone muted.',
      ackVi: 'Đã tắt micro.',
    };
  }
  if (/^(?:unmute|unmute mic|unmute microphone|bat mic|mo mic|bat micro)$/.test(cleaned)) {
    return {
      intents: [{ kind: 'voice_control', command: 'unmute' }],
      ackEn: 'Microphone active.',
      ackVi: 'Đã bật micro.',
    };
  }
  if (/^(?:compact mode|minimize echo|minimize chat|thu gon echo|thu nho khung chat|che do thu gon)$/.test(cleaned)) {
    return {
      intents: [{ kind: 'voice_control', command: 'compact' }],
      ackEn: 'Switched to compact mode.',
      ackVi: 'Đã chuyển sang chế độ thu gọn.',
    };
  }
  if (/^(?:expand chat|expand echo|expanded mode|mo rong echo|mo rong khung chat)$/.test(cleaned)) {
    return {
      intents: [{ kind: 'voice_control', command: 'expand' }],
      ackEn: 'Expanded Echo chat.',
      ackVi: 'Đã mở rộng khung trò chuyện.',
    };
  }
  if (
    /^(?:open echo workspace|immersive workspace|full echo workspace|khong gian echo toan man hinh|mo khong gian echo)$/.test(
      cleaned,
    )
  ) {
    return {
      intents: [{ kind: 'voice_control', command: 'workspace' }],
      ackEn: 'Opened Echo workspace.',
      ackVi: 'Đã mở không gian Echo toàn màn hình.',
    };
  }
  if (/^(?:ambient mode|orb mode|che do ambient)$/.test(cleaned)) {
    return {
      intents: [{ kind: 'voice_control', command: 'ambient' }],
      ackEn: 'Switched to ambient orb mode.',
      ackVi: 'Đã chuyển sang chế độ cầu nổi gọn nhẹ.',
    };
  }
  if (/^(?:turn on captions|enable captions|show captions|bat phu de echo|hien phu de echo)$/.test(cleaned)) {
    return {
      intents: [{ kind: 'voice_control', command: 'captions_on' }],
      ackEn: 'Captions enabled.',
      ackVi: 'Đã bật phụ đề Echo.',
    };
  }
  if (/^(?:turn off captions|disable captions|hide captions|tat phu de echo|an phu de echo)$/.test(cleaned)) {
    return {
      intents: [{ kind: 'voice_control', command: 'captions_off' }],
      ackEn: 'Captions hidden.',
      ackVi: 'Đã tắt phụ đề Echo.',
    };
  }

  // 2b. Undo Last Reversible UI Action
  if (
    /^(?:undo(?: that| last(?: action| change)?)?|revert(?: that| last(?: action| change)?)?|hoan tac(?: thao tac(?: vua roi| gan nhat)?| lai)?|quay lai thao tac truoc)$/.test(
      cleaned,
    )
  ) {
    return {
      intents: [{ kind: 'undo_last_action' }],
      ackEn: 'Undoing the last action.',
      ackVi: 'Đang hoàn tác thao tác vừa rồi.',
    };
  }

  // 3. Sign Out / Logout (`CONFIRM_REQUIRED` enforced in permissionEngine)
  if (/^(?:log out|logout|sign out|sign me out|log me out|dang xuat|thoat tai khoan)$/.test(cleaned)) {
    return {
      intents: [{ kind: 'request_logout' }],
      ackEn: 'Please confirm if you want to sign out.',
      ackVi: 'Vui lòng xác nhận nếu bạn muốn đăng xuất.',
    };
  }

  // 4. History Back / Forward
  if (
    /^(?:go back|back|previous (?:screen|page)|navigate back|(?:quay lai|tro lai|lui lai|quay ve|ve)(?: trang truoc| man hinh truoc)?|trang truoc)$/.test(
      cleaned,
    )
  ) {
    return {
      intents: [{ kind: 'history_back' }],
      ackEn: 'Going back.',
      ackVi: 'Đang quay lại trang trước.',
    };
  }
  if (/^(?:go forward|navigate forward|tien toi|chuyen tiep trang)$/.test(cleaned)) {
    return {
      intents: [{ kind: 'history_forward' }],
      ackEn: 'Going forward.',
      ackVi: 'Đang tiến tới.',
    };
  }

  // 5. Page Scrolling (`[data-app-scroll]`)
  if (
    /^(?:scroll (?:all the way )?to (?:the )?top|back to (?:the )?top|go to (?:the )?top|(?:cuon|keo|luot)\s+len\s+(?:dau\s+trang|tren\s+cung)|len\s+(?:dau\s+trang|tren\s+cung)|ve\s+dau\s+trang)$/.test(
      cleaned,
    )
  ) {
    return {
      intents: [{ kind: 'scroll', target: 'top' }],
      ackEn: 'Scrolled to the top.',
      ackVi: 'Đã cuộn lên đầu trang.',
    };
  }
  if (
    /^(?:scroll (?:all the way )?to (?:the )?bottom|go to (?:the )?bottom|(?:cuon|keo|luot)\s+xuong\s+(?:cuoi\s+trang|duoi\s+cung)|xuong\s+(?:cuoi\s+trang|duoi\s+cung)|ve\s+cuoi\s+trang)$/.test(
      cleaned,
    )
  ) {
    return {
      intents: [{ kind: 'scroll', target: 'bottom' }],
      ackEn: 'Scrolled to the bottom.',
      ackVi: 'Đã cuộn xuống cuối trang.',
    };
  }
  if (
    /^(?:scroll down(?:\s+a\s+(?:bit|little)|(?:\s+further|\s+more))?|page down|move down|(?:cuon|keo|luot)\s+(?:trang\s+)?xuong(?:\s+duoi|\s+phia\s+duoi|\s+mot\s+chut|\s+xiu|\s+ti|\s+nua)?)$/.test(
      cleaned,
    )
  ) {
    return {
      intents: [{ kind: 'scroll', target: 'down' }],
      ackEn: 'Scrolled down.',
      ackVi: 'Đã cuộn xuống.',
    };
  }
  if (
    /^(?:scroll up(?:\s+a\s+(?:bit|little)|(?:\s+further|\s+more))?|page up|move up|(?:cuon|keo|luot)\s+(?:trang\s+)?len(?:\s+tren|\s+phia\s+tren|\s+mot\s+chut|\s+xiu|\s+ti|\s+nua)?)$/.test(
      cleaned,
    )
  ) {
    return {
      intents: [{ kind: 'scroll', target: 'up' }],
      ackEn: 'Scrolled up.',
      ackVi: 'Đã cuộn lên.',
    };
  }

  // 6. Theme Mode (`light | dark | system`)
  if (
    /^(?:(?:switch to|turn on|enable|use|set|chuyen sang|chuyen qua|bat|doi sang|dung)\s+)?(?:dark mode|dark theme|night mode|che do toi|nen toi|giao dien toi)$/.test(
      cleaned,
    )
  ) {
    return {
      intents: [{ kind: 'theme_mode', mode: 'dark' }],
      ackEn: 'Switched to dark mode.',
      ackVi: 'Đã chuyển sang chế độ tối.',
    };
  }
  if (
    /^(?:(?:switch to|turn on|enable|use|set|chuyen sang|chuyen qua|bat|doi sang|dung)\s+)?(?:light mode|light theme|day mode|che do sang|nen sang|giao dien sang)$/.test(
      cleaned,
    ) ||
    /^(?:turn off|switch off|disable|exit)\s+(?:dark mode|dark theme|night mode)$/.test(cleaned) ||
    /^(?:tat)\s+(?:che do toi|nen toi|giao dien toi)$/.test(cleaned)
  ) {
    return {
      intents: [{ kind: 'theme_mode', mode: 'light' }],
      ackEn: 'Switched to light mode.',
      ackVi: 'Đã chuyển sang chế độ sáng.',
    };
  }
  if (
    /^(?:(?:switch to|use|set|chuyen sang|doi sang|dung)\s+)?(?:system theme|system mode|auto theme|giao dien he thong|theo he thong)$/.test(
      cleaned,
    )
  ) {
    return {
      intents: [{ kind: 'theme_mode', mode: 'system' }],
      ackEn: 'Set theme to match your system.',
      ackVi: 'Đã đặt giao diện theo hệ thống.',
    };
  }

  // 7. UI Locale (`vi | en`)
  if (
    /^(?:switch (?:ui |interface |app |language )?to vietnamese|change language to vietnamese|vietnamese interface|chuyen (?:giao dien |ngon ngu )?(?:sang |qua )?tieng viet|doi sang tieng viet|dung tieng viet)$/.test(
      cleaned,
    )
  ) {
    return {
      intents: [{ kind: 'ui_locale', locale: 'vi' }],
      ackEn: 'Switched interface language to Vietnamese.',
      ackVi: 'Đã chuyển ngôn ngữ giao diện sang tiếng Việt.',
    };
  }
  if (
    /^(?:switch (?:ui |interface |app |language )?to english|change language to english|english interface|chuyen (?:giao dien |ngon ngu )?(?:sang |qua )?tieng anh|doi giao dien sang tieng anh)$/.test(
      cleaned,
    )
  ) {
    return {
      intents: [{ kind: 'ui_locale', locale: 'en' }],
      ackEn: 'Switched interface language to English.',
      ackVi: 'Đã chuyển ngôn ngữ giao diện sang tiếng Anh.',
    };
  }

  // 8. Navigation Layout & Pin/Auto-Hide (`sidebar | dock`, `pinned | autohide`)
  if (
    /^(?:(?:switch to|use|enable|show|chuyen sang|chuyen qua|dung|bat)\s+)?(?:macos dock|dock layout|dock navigation|dock mode|thanh dock|che do dock|giao dien dock)$/.test(
      cleaned,
    )
  ) {
    return {
      intents: [{ kind: 'nav_layout', layout: 'dock' }],
      ackEn: 'Switched navigation to the Dock.',
      ackVi: 'Đã chuyển thanh điều hướng sang dạng Dock.',
    };
  }
  if (
    /^(?:(?:switch to|use|enable|show|chuyen sang|chuyen qua|dung|bat)\s+)?(?:sidebar|sidebar layout|sidebar navigation|thanh ben|che do thanh ben)$/.test(
      cleaned,
    )
  ) {
    return {
      intents: [{ kind: 'nav_layout', layout: 'sidebar' }],
      ackEn: 'Switched navigation to the sidebar.',
      ackVi: 'Đã chuyển về thanh điều hướng bên cạnh.',
    };
  }
  if (
    /^(?:(?:auto[- ]?hide|hide) (?:the )?(?:sidebar|dock|navigation(?: bar)?|menu)|(?:tu an|an) (?:thanh ben|thanh dieu huong|dock|menu))$/.test(
      cleaned,
    )
  ) {
    return {
      intents: [{ kind: 'nav_visibility', visibility: 'autohide' }],
      ackEn: 'Enabled auto-hide for navigation.',
      ackVi: 'Đã bật chế độ tự ẩn thanh điều hướng.',
    };
  }
  if (
    /^(?:pin (?:the )?(?:sidebar|dock|navigation|menu)|keep (?:sidebar|navigation) visible|ghim (?:thanh ben|thanh dieu huong|dock|menu))$/.test(
      cleaned,
    )
  ) {
    return {
      intents: [{ kind: 'nav_visibility', visibility: 'pinned' }],
      ackEn: 'Pinned the navigation bar.',
      ackVi: 'Đã ghim cố định thanh điều hướng.',
    };
  }

  // 9. World Display (`odyssey | cosmos` <-> `immersive | embedded`)
  if (/^(?:embed|embedded mode for|floating mode for|thu nho khung)\s+(?:echo\s+)?(odyssey|cosmos|knowledge universe|vu tru tri thuc)$/.test(cleaned)) {
    const world = cleaned.includes('odyssey') ? 'odyssey' : 'cosmos';
    return {
      intents: [{ kind: 'world_display', world, display: 'embedded' }],
      ackEn: 'Switched world view to embedded workspace mode.',
      ackVi: 'Đã chuyển sang chế độ hiển thị trong khung làm việc.',
    };
  }
  if (/^(?:immersive mode for|fullscreen mode for|full viewport)\s+(?:echo\s+)?(odyssey|cosmos|knowledge universe|vu tru tri thuc)$/.test(cleaned)) {
    const world = cleaned.includes('odyssey') ? 'odyssey' : 'cosmos';
    return {
      intents: [{ kind: 'world_display', world, display: 'immersive' }],
      ackEn: 'Switched world view to immersive mode.',
      ackVi: 'Đã chuyển sang chế độ tràn viền.',
    };
  }

  // 10. Open Guide Panel
  if (/^(?:open (?:echo )?guide|show guide|app tour|mo huong dan|xem huong dan su dung)$/.test(cleaned)) {
    return {
      intents: [{ kind: 'open_guide' }],
      ackEn: 'Opened Echo Guide.',
      ackVi: 'Đã mở bảng hướng dẫn Echo.',
    };
  }

  // 11. Background Studio: 10 Curated Presets, Brightness, Reset, and Studio Modal
  for (const preset of BG_PRESET_MATCHERS) {
    for (const phrase of preset.patterns) {
      if (
        cleaned === phrase ||
        cleaned === `${phrase} background` ||
        cleaned === `${phrase} theme` ||
        new RegExp(
          `^(?:apply|set|use|switch|change|enable|doi|chuyen|chon|ap dung|bat)(?:\\s+(?:background|theme|wallpaper|nen|hinh nen|giao dien|mau nen))?(?:\\s+(?:to|sang|qua|thanh))?\\s+${phrase}(?:\\s+(?:background|theme|preset))?$`,
        ).test(cleaned)
      ) {
        return {
          intents: [{ kind: 'apply_bg_preset', presetId: preset.id }],
          ackEn: `Applied the ${preset.enName} background.`,
          ackVi: `Đã đổi nền sang ${preset.viName}.`,
        };
      }
    }
  }

  if (
    /^(?:darken (?:the )?background|dim (?:the )?background|make (?:the )?background darker|lower background brightness|lam toi nen|giam do sang nen|cho nen toi hon)$/.test(
      cleaned,
    )
  ) {
    return {
      intents: [{ kind: 'adjust_bg_brightness', delta: -15 }],
      ackEn: 'Darkened the background.',
      ackVi: 'Đã giảm độ sáng nền.',
    };
  }
  if (
    /^(?:brighten (?:the )?background|make (?:the )?background brighter|increase background brightness|lam sang nen|tang do sang nen|cho nen sang hon)$/.test(
      cleaned,
    )
  ) {
    return {
      intents: [{ kind: 'adjust_bg_brightness', delta: 15 }],
      ackEn: 'Brightened the background.',
      ackVi: 'Đã tăng độ sáng nền.',
    };
  }
  if (
    /^(?:reset (?:the )?(?:appearance|background|wallpaper)(?: to (?:default|echo ocean))?|default (?:appearance|background)|restore default (?:look|appearance|background)|dat lai (?:nen|giao dien)(?: mac dinh)?|khoi phuc (?:nen|giao dien) mac dinh|ve (?:nen|giao dien) mac dinh)$/.test(
      cleaned,
    )
  ) {
    return {
      intents: [{ kind: 'reset_appearance' }],
      ackEn: 'Restored the default Echo Ocean appearance.',
      ackVi: 'Đã khôi phục giao diện Echo Ocean mặc định.',
    };
  }
  if (
    /^(?:(?:open|show|launch|bring up|pull up|go to|switch to)\s+(?:(?:the|my)\s+)?(?:appearance|background|wallpaper|media|worlds?|world display|spatial|navigation|nav|theme)\s+(?:studio(?:\s+settings|\s+panel|\s+room)?|settings|preferences|panel|room)|(?:open|show|launch|bring up|pull up)\s+(?:the\s+)?appearance\s+studio(?:\s+(?:for\s+)?(?:background|media|worlds?|spatial|navigation|nav))?|customize\s+(?:(?:the|my)\s+)?(?:background|appearance|wallpaper|media|worlds?|spatial|navigation)(?:\s+(?:studio|settings))?|(?:mo|vao|xem|bat)\s+(?:bang\s+)?(?:cai\s+dat\s+|tuy\s+chinh\s+|studio\s+)?(?:giao\s+dien|hinh\s+nen|the\s+gioi|khong\s+gian|thanh\s+dieu\s+huong)(?:\s+studio)?|mo\s+(?:appearance|background|navigation|worlds?)\s+studio(?:\s+settings)?|tuy\s+chinh\s+(?:hinh\s+nen|giao\s+dien|the\s+gioi|thanh\s+dieu\s+huong))$/.test(
      cleaned,
    )
  ) {
    let room: EchoStudioRoom | undefined;
    if (/\b(?:navigation|nav|thanh dieu huong)\b/.test(cleaned)) room = 'navigation';
    else if (/\b(?:worlds?|the gioi)\b/.test(cleaned)) room = 'worlds';
    else if (/\b(?:spatial|khong gian)\b/.test(cleaned)) room = 'spatial';
    else if (/\b(?:wallpaper|media|hinh nen)\b/.test(cleaned)) room = 'media';
    else if (/\bbackground\b/.test(cleaned)) room = 'background';
    return {
      intents: [{ kind: 'open_appearance_studio', ...(room ? { room } : {}) }],
      ackEn: 'Opened Appearance Studio.',
      ackVi: 'Đã mở bảng tùy chỉnh Giao diện.',
    };
  }

  // 12. Global Dictionary Lookup (`ec:dictionary:lookup`)
  if (/^(?:open (?:the |my )?dictionary|launch (?:the )?dictionary|mo tu dien|bat tu dien)$/.test(cleaned)) {
    return {
      intents: [{ kind: 'dictionary_lookup', word: '' }],
      ackEn: 'Opened the dictionary.',
      ackVi: 'Đã mở từ điển.',
    };
  }
  const dictWord = extractDictionaryHeadword(cleaned);
  if (dictWord) {
    return {
      intents: [{ kind: 'dictionary_lookup', word: dictWord }],
      ackEn: `Looking up "${dictWord}" in the dictionary.`,
      ackVi: `Đang tra từ "${dictWord}" trong từ điển.`,
    };
  }

  // 13. My Books (`open my last book`, `BookReader` themes and page turns)
  if (
    /^(?:open (?:my )?(?:last|latest|recent|most recent|current) book(?: (?:and )?(?:continue|resume)(?: reading)?(?: (?:from )?where i (?:stopped|left off))?)?|continue (?:reading )?(?:my )?(?:last |latest |recent |current )?book(?: (?:from )?where i (?:stopped|left off))?|resume (?:reading )?(?:my )?(?:last |latest |recent |current )?book(?: (?:from )?where i (?:stopped|left off))?|mo (?:cuon )?sach (?:doc )?gan (?:day )?nhat(?: (?:va |roi )?(?:doc tiep|tiep tuc doc|tiep tuc)(?: (?:tu |o )?(?:cho|doan|trang) (?:dang dung|da dung|doc do))?)?|mo sach dang doc(?: do)?(?: (?:va |roi )?(?:doc tiep|tiep tuc)(?: (?:tu |o )?(?:cho|doan|trang) (?:dang dung|da dung|doc do))?)?|doc tiep sach(?: cua toi| cua minh)?(?: (?:tu |o )?(?:cho|doan|trang) (?:dang dung|da dung|doc do))?)$/.test(
      cleaned,
    )
  ) {
    return {
      intents: [{ kind: 'mybooks_open_last' }],
      ackEn: 'Opening your most recent book.',
      ackVi: 'Đang mở cuốn sách bạn đọc gần nhất.',
    };
  }

  const bookThemeMatch =
    /^(?:(?:switch|set|change|use|doi|chuyen)(?:\s+(?:reader|book|sach|trang sach))?(?:\s+(?:theme|background|mode|nen|che do))?(?:\s+(?:to|sang|qua))?\s+)(paper|sepia|white|oled|giay|giay vang|trang|den oled)(?:\s+(?:theme|mode|reader))?$/.exec(
      cleaned,
    );
  if (bookThemeMatch) {
    const rawT = bookThemeMatch[1];
    let theme: EchoBookTheme = 'paper';
    let labelEn = 'paper';
    let labelVi = 'giấy ấm';
    if (rawT === 'white' || rawT === 'trang') {
      theme = 'white';
      labelEn = 'white';
      labelVi = 'trắng sáng';
    } else if (rawT === 'oled' || rawT === 'den oled') {
      theme = 'oled';
      labelEn = 'OLED dark';
      labelVi = 'đen OLED';
    }
    return {
      intents: [{ kind: 'mybooks_reader', theme }],
      ackEn: `Switched reader theme to ${labelEn}.`,
      ackVi: `Đã đổi nền đọc sách sang ${labelVi}.`,
    };
  }

  if (
    /^(?:next page|turn (?:the )?page|flip page|trang sau|trang tiep theo|lat trang(?: tiep(?: theo)?)?)$/.test(
      cleaned,
    )
  ) {
    return {
      intents: [{ kind: 'mybooks_reader', page: 'next' }],
      ackEn: 'Turned to the next page.',
      ackVi: 'Đã lật sang trang tiếp theo.',
    };
  }
  if (/^(?:previous page|prev page|turn back (?:a )?page|trang truoc|lat lai trang truoc)$/.test(cleaned)) {
    return {
      intents: [{ kind: 'mybooks_reader', page: 'prev' }],
      ackEn: 'Turned to the previous page.',
      ackVi: 'Đã quay lại trang trước.',
    };
  }

  // 14. Global UI Font Scale, Reading Typography & Filters (`ui_font_scale`, `reading_control`, `mybooks_reader`)
  if (
    /^(?:increase (?:the )?(?:font|text) size|make (?:the )?(?:font|text) (?:larger|bigger)|larger (?:font|text)|bigger (?:font|text)|zoom in text|(?:tang co chu|cho chu to|chu to|phong to chu)(?: len| hon)?(?: mot chut| xiu| ti)?)$/.test(
      cleaned,
    )
  ) {
    return {
      intents: [
        { kind: 'ui_font_scale', delta: 0.08 },
        { kind: 'reading_control', fontDelta: 2 },
        { kind: 'mybooks_reader', fontDelta: 2 },
      ],
      ackEn: 'Increased the font size.',
      ackVi: 'Đã tăng cỡ chữ.',
    };
  }
  if (
    /^(?:decrease (?:the )?(?:font|text) size|make (?:the )?(?:font|text) smaller|smaller (?:font|text)|reduce font size|(?:giam co chu|cho chu nho|chu nho|thu nho chu)(?: xuong| lai| hon| di)?(?: mot chut| xiu| ti)?)$/.test(
      cleaned,
    )
  ) {
    return {
      intents: [
        { kind: 'ui_font_scale', delta: -0.08 },
        { kind: 'reading_control', fontDelta: -2 },
        { kind: 'mybooks_reader', fontDelta: -2 },
      ],
      ackEn: 'Decreased the font size.',
      ackVi: 'Đã giảm cỡ chữ.',
    };
  }
  if (
    /^(?:reset (?:the )?(?:font|text) size|default (?:font|text) size|dat lai co chu|co chu mac dinh)$/.test(
      cleaned,
    )
  ) {
    return {
      intents: [
        { kind: 'ui_font_scale', scale: 1.0 },
        { kind: 'reading_control', fontSize: 18 },
        { kind: 'mybooks_reader', fontSize: 18 },
      ],
      ackEn: 'Reset the font size to default.',
      ackVi: 'Đã đặt lại cỡ chữ mặc định.',
    };
  }
  if (
    /^(?:wide (?:reading )?(?:width|layout|column)|widen reading column|kho doc rong|mo rong kho doc)$/.test(cleaned)
  ) {
    return {
      intents: [{ kind: 'reading_control', width: 'wide' as EchoReadingWidth }],
      ackEn: 'Set reading width to wide.',
      ackVi: 'Đã chuyển sang khổ đọc rộng.',
    };
  }
  if (
    /^(?:narrow (?:reading )?(?:width|layout|column)|kho doc hep|thu hep kho doc)$/.test(cleaned)
  ) {
    return {
      intents: [{ kind: 'reading_control', width: 'narrow' as EchoReadingWidth }],
      ackEn: 'Set reading width to narrow.',
      ackVi: 'Đã chuyển sang khổ đọc hẹp.',
    };
  }
  if (
    /^(?:comfortable (?:reading )?(?:width|layout)|default reading width|kho doc vua|kho doc tieu chuan)$/.test(
      cleaned,
    )
  ) {
    return {
      intents: [{ kind: 'reading_control', width: 'comfortable' as EchoReadingWidth }],
      ackEn: 'Set reading width to comfortable.',
      ackVi: 'Đã đặt khổ đọc tiêu chuẩn.',
    };
  }

  const filterLevelMatch =
    /^(?:filter (?:reading )?(?:by )?(?:level )?|loc (?:bai doc )?(?:theo )?(?:trinh do |cap do )?)(a1|a2|b1|b2|c1|c2)$/.exec(
      cleaned,
    );
  if (filterLevelMatch) {
    const level = filterLevelMatch[1].toUpperCase() as EchoCefrLevel;
    return {
      intents: [{ kind: 'reading_control', filterLevel: level }],
      ackEn: `Filtered Reading by level ${level}.`,
      ackVi: `Đã lọc bài đọc theo trình độ ${level}.`,
    };
  }

  const switchReadingTabMatch =
    /^(?:switch to |open )?(library|my books|bookshelf|bilingual|speed) tab$/.exec(cleaned) ||
    /^(?:chuyen sang |mo )?tab (thu vien|tu sach|sach cua toi|song ngu|doc nhanh)$/.exec(cleaned);
  if (switchReadingTabMatch) {
    const rawTab = switchReadingTabMatch[1];
    let tab: EchoReadingTab = 'library';
    if (rawTab === 'my books' || rawTab === 'bookshelf' || rawTab === 'tu sach' || rawTab === 'sach cua toi') {
      tab = 'mybooks';
    } else if (rawTab === 'bilingual' || rawTab === 'song ngu') tab = 'bilingual';
    else if (rawTab === 'speed' || rawTab === 'doc nhanh') tab = 'speed';
    return {
      intents: [
        ...(currentPathname === '/reading'
          ? []
          : ([{ kind: 'navigate', href: tab === 'library' ? '/reading' : `/reading?section=${tab}` }] as EchoClientIntent[])),
        { kind: 'reading_control', tab },
      ],
      ackEn: `Switched Reading to ${tab}.`,
      ackVi: tab === 'mybooks' ? 'Đang mở Tủ sách của bạn.' : 'Đã chuyển tab trong mục Đọc.',
    };
  }

  // Bare bookshelf / tủ sách noun-phrase shortcut (`"bookshelf"`, `"tủ sách"`, `"my books"`)
  if (
    /^(?:bookshelf|my bookshelf|my books|personal bookshelf|tu sach|ke sach|tu sach cua ban|tu sach cua minh|tu sach cua toi|ke sach cua ban|ke sach cua minh|ke sach cua toi|sach cua minh|sach cua toi)$/.test(
      cleaned,
    )
  ) {
    return {
      intents: [
        { kind: 'navigate', href: '/reading?section=mybooks', label: 'My Books' },
        { kind: 'reading_control', tab: 'mybooks' },
      ],
      ackEn: 'Opening My Books.',
      ackVi: 'Đang mở Tủ sách của bạn.',
    };
  }

  // 15. Echo Music Controls
  if (/^(?:play music|start music|resume music|phat nhac|bat nhac|mo nhac nghe|tiep tuc nhac)$/.test(cleaned)) {
    return {
      intents: [{ kind: 'music_control', command: 'play' }],
      ackEn: 'Playing Echo Music.',
      ackVi: 'Đang phát nhạc.',
    };
  }
  if (/^(?:pause music|stop music|tam dung nhac|dung nhac|tat nhac)$/.test(cleaned)) {
    return {
      intents: [{ kind: 'music_control', command: 'pause' }],
      ackEn: 'Paused music.',
      ackVi: 'Đã tạm dừng nhạc.',
    };
  }
  if (/^(?:mute music|tat tieng nhac)$/.test(cleaned)) {
    return {
      intents: [{ kind: 'music_control', command: 'mute' }],
      ackEn: 'Muted music.',
      ackVi: 'Đã tắt tiếng nhạc.',
    };
  }
  if (/^(?:unmute music|bat tieng nhac|mo tieng nhac)$/.test(cleaned)) {
    return {
      intents: [{ kind: 'music_control', command: 'unmute' }],
      ackEn: 'Unmuted music.',
      ackVi: 'Đã bật tiếng nhạc.',
    };
  }
  if (/^(?:toggle music|bat tat nhac)$/.test(cleaned)) {
    return {
      intents: [{ kind: 'music_control', command: 'toggle' }],
      ackEn: 'Toggled music playback.',
      ackVi: 'Đã chuyển trạng thái phát nhạc.',
    };
  }
  if (/^(?:next song|next track|skip song|skip track|bai tiep theo|qua bai|chuyen bai nhac)$/.test(cleaned)) {
    return {
      intents: [{ kind: 'music_control', command: 'next' }],
      ackEn: 'Skipped to the next track.',
      ackVi: 'Đã chuyển sang bài tiếp theo.',
    };
  }
  if (/^(?:previous song|previous track|prev track|bai truoc|quay lai bai truoc)$/.test(cleaned)) {
    return {
      intents: [{ kind: 'music_control', command: 'prev' }],
      ackEn: 'Went back to the previous track.',
      ackVi: 'Đã quay lại bài nhạc trước.',
    };
  }
  if (/^(?:music louder|increase music volume|turn up (?:the )?music|tang am luong nhac|cho nhac to len)$/.test(cleaned)) {
    return {
      intents: [{ kind: 'music_control', command: 'volume_up' }],
      ackEn: 'Turned up the music volume.',
      ackVi: 'Đã tăng âm lượng nhạc.',
    };
  }
  if (/^(?:music quieter|decrease music volume|turn down (?:the )?music|giam am luong nhac|cho nhac nho xuong)$/.test(cleaned)) {
    return {
      intents: [{ kind: 'music_control', command: 'volume_down' }],
      ackEn: 'Lowered the music volume.',
      ackVi: 'Đã giảm âm lượng nhạc.',
    };
  }
  if (/^(?:shuffle music|toggle shuffle|tron bai|phat ngau nhien)$/.test(cleaned)) {
    return {
      intents: [{ kind: 'music_control', command: 'shuffle' }],
      ackEn: 'Toggled music shuffle.',
      ackVi: 'Đã bật tắt chế độ phát ngẫu nhiên.',
    };
  }

  // 16. Listening Workspace Player Controls (`ec:listening:command`)
  if (
    /^(?:play (?:the )?(?:lesson|audio)|resume (?:the )?(?:lesson|audio)|phat bai nghe|tiep tuc bai nghe|chay bai nghe)$/.test(
      cleaned,
    )
  ) {
    return {
      intents: [{ kind: 'listening_player', command: 'play' }],
      ackEn: 'Playing the listening audio.',
      ackVi: 'Đang phát bài nghe.',
    };
  }
  if (
    /^(?:pause (?:the )?(?:lesson|audio)|stop (?:the )?(?:lesson|audio)|tam dung bai nghe|dung bai nghe)$/.test(cleaned)
  ) {
    return {
      intents: [{ kind: 'listening_player', command: 'pause' }],
      ackEn: 'Paused the listening audio.',
      ackVi: 'Đã tạm dừng bài nghe.',
    };
  }
  if (
    /^(?:replay(?: sentence| segment)?|repeat sentence|play that sentence again|nghe lai(?: cau nay)?|phat lai cau(?: nay)?)$/.test(
      cleaned,
    )
  ) {
    return {
      intents: [{ kind: 'listening_player', command: 'replay' }],
      ackEn: 'Replaying the current sentence.',
      ackVi: 'Đang phát lại câu hiện tại.',
    };
  }
  if (
    /^(?:(?:toggle|hide|show) transcript|(?:an|hien|bat tat) (?:phu de|loi thoai|transcript))$/.test(cleaned)
  ) {
    return {
      intents: [{ kind: 'listening_player', command: 'toggle_transcript' }],
      ackEn: 'Toggled the lesson transcript.',
      ackVi: 'Đã bật tắt phụ đề bài nghe.',
    };
  }
  if (/^(?:switch to dictation|start dictation|open dictation mode|chuyen sang chep chinh ta|bat chep chinh ta)$/.test(cleaned)) {
    return {
      intents: [{ kind: 'listening_player', command: 'switch_dictation' }],
      ackEn: 'Switched to Dictation view.',
      ackVi: 'Đã chuyển sang chế độ chép chính tả.',
    };
  }
  if (/^(?:switch to overview|lesson overview|chuyen ve tong quan bai nghe|xem tong quan bai nghe)$/.test(cleaned)) {
    return {
      intents: [{ kind: 'listening_player', command: 'switch_overview' }],
      ackEn: 'Switched to Lesson Overview.',
      ackVi: 'Đã chuyển về tổng quan bài nghe.',
    };
  }
  const speedNumericMatch =
    /^(?:(?:set )?(?:playback |audio |listening )?speed(?: to)?|toc do(?: nghe| phat)?)\s*(0\.5|0\.75|1(?:\.0)?|1\.25|1\.5|1\.75|2(?:\.0)?)x?$/.exec(
      cleaned,
    );
  if (speedNumericMatch) {
    const speed = Number(speedNumericMatch[1]);
    return {
      intents: [{ kind: 'listening_player', command: 'speed', speed }],
      ackEn: `Set playback speed to ${speed}x.`,
      ackVi: `Đã đặt tốc độ phát ${speed}x.`,
    };
  }
  if (/^(?:slow down (?:the )?audio|slower playback|nghe cham lai|giam toc do nghe)$/.test(cleaned)) {
    return {
      intents: [{ kind: 'listening_player', command: 'speed', speed: 0.75 }],
      ackEn: 'Set playback speed to 0.75x.',
      ackVi: 'Đã giảm tốc độ nghe xuống 0.75x.',
    };
  }
  if (/^(?:speed up (?:the )?audio|faster playback|nghe nhanh hon|tang toc do nghe)$/.test(cleaned)) {
    return {
      intents: [{ kind: 'listening_player', command: 'speed', speed: 1.25 }],
      ackEn: 'Set playback speed to 1.25x.',
      ackVi: 'Đã tăng tốc độ nghe lên 1.25x.',
    };
  }

  // 17. Knowledge Universe Word Deep-Link (`open knowledge universe for resilient`)
  const cosmosWordMatch =
    /^(?:open|show|explore|see|mo|xem|kham pha)\s+([a-z][a-z' -]{0,36})\s+in (?:the )?(?:knowledge universe|cosmos)$/.exec(
      cleaned,
    ) ||
    /^(?:xem|mo|kham pha)\s+tu\s+([a-z][a-z' -]{0,36})\s+trong vu tru tri thuc$/.exec(cleaned);
  if (cosmosWordMatch) {
    const w = cosmosWordMatch[1].trim().toLowerCase();
    const encoded = w.replace(/ /g, '%20').replace(/'/g, '%27');
    return {
      intents: [{ kind: 'navigate', href: `/knowledge-universe?word=${encoded}`, label: `Knowledge Universe: ${w}` }],
      ackEn: `Opening "${w}" in the Knowledge Universe.`,
      ackVi: `Đang mở từ "${w}" trong Vũ trụ tri thức.`,
    };
  }

  // 18. Explicit & Concept-Slot Navigation across all 66+ module routes
  const navVerbMatch = NAV_VERB_RE.exec(cleaned);
  if (navVerbMatch) {
    const entry = resolveConceptSlotNavEntry(navVerbMatch[1]);
    if (entry) {
      const intents: EchoClientIntent[] = [
        { kind: 'navigate', href: entry.href, label: entry.en },
        ...(entry.extraIntents ?? []),
      ];
      return {
        intents,
        ackEn: `Opening ${entry.en}.`,
        ackVi: `Đang mở ${entry.vi}.`,
      };
    }
  }

  return null;
}

const COMPOUND_SPLIT_RE =
  /(?:,\s*|\s+)(?:and then|after that|then|and|rồi sau đó|sau đó|xong rồi|rồi|và|roi sau do|sau do|xong roi|roi|va)\s+/i;

function joinAcks(clauses: CompiledClause[], lang: 'en' | 'vi'): string {
  if (clauses.length === 1) {
    return lang === 'vi' ? clauses[0].ackVi : clauses[0].ackEn;
  }
  const parts = clauses.map((c) =>
    (lang === 'vi' ? c.ackVi : c.ackEn).replace(/[.!]+$/, '').trim(),
  );
  if (lang === 'vi') {
    return `${parts.join(' và ')}.`;
  }
  return `${parts.join(' and ')}.`;
}

function resolveCompileOptions(
  optionsOrPathname?: FastPathCompileOptions | string,
  hasPendingConfirmation?: boolean,
  salientResources?: readonly EchoSalientResource[] | null,
): FastPathCompileOptions {
  if (typeof optionsOrPathname === 'string') {
    return {
      pathname: optionsOrPathname,
      ...(hasPendingConfirmation !== undefined ? { hasPendingConfirmation } : {}),
      ...(salientResources !== undefined ? { salientResources } : {}),
    };
  }
  return optionsOrPathname ?? {};
}

/**
 * Compiles a natural EN/VI utterance in `< 15 ms` with zero LLM calls, or returns `null`
 * when `EchoLearnerBrain` / backend tools should handle the turn.
 */
export function compileFastPathUtterance(
  rawUtterance: string,
  options: FastPathCompileOptions = {},
): FastPathMatch | null {
  const outcome = evaluateAndCompileUtterance(rawUtterance, options);
  if (outcome.guard) return null;
  return outcome.fastPath;
}

/**
 * Full Plane-A entry point returning BOTH any immediate `DENIED`/`UNSUPPORTED` guard
 * AND any compiled `FastPathMatch` (`< 15 ms` end-to-end).
 */
export function evaluateAndCompileUtterance(
  rawUtterance: string,
  optionsOrPathname: FastPathCompileOptions | string = {},
  legacyHasPendingConfirmation?: boolean,
  legacySalientResources?: readonly EchoSalientResource[] | null,
): UtteranceCompileOutcome {
  const start = nowMs();
  const options = resolveCompileOptions(
    optionsOrPathname,
    legacyHasPendingConfirmation,
    legacySalientResources,
  );
  const pathname =
    options.pathname ?? (typeof window !== 'undefined' ? window.location.pathname : '/dashboard');
  const hasPendingConfirm = Boolean(
    options.hasPendingConfirmation ?? hasActivePendingConfirmation(),
  );
  const ctx: PermissionEvalContext = {
    pathname,
    searchParams: options.searchParams ?? null,
    hasActiveStrictSentinel: options.hasActiveStrictSentinel,
    hasPendingConfirmation: hasPendingConfirm,
  };

  const guard = detectUtteranceGuard(rawUtterance, ctx);
  if (guard) {
    return {
      guard: {
        ...guard,
        spokenMessageEn: guard.prompt?.en ?? 'That action is not permitted.',
        spokenMessageVi: guard.prompt?.vi ?? 'Thao tác này không được phép thực hiện.',
      },
      fastPath: null,
    };
  }

  const language = detectUtteranceLanguage(rawUtterance);

  // Active confirmation takes precedence over negation speech-acts so bare "no", "don't", "khoan" cancel cleanly!
  if (hasPendingConfirm) {
    const confirmDecision = matchPendingConfirmationDecision(rawUtterance);
    if (confirmDecision) {
      const ack =
        confirmDecision === 'confirm'
          ? language === 'vi'
            ? 'Đã xác nhận.'
            : 'Confirmed.'
          : language === 'vi'
            ? 'Đã hủy thao tác.'
            : 'Cancelled.';
      return {
        guard: null,
        fastPath: {
          language,
          spokenAck: ack,
          intents: [{ kind: 'voice_confirm', decision: confirmDecision }],
          clauses: [rawUtterance.trim()],
          elapsedMs: Math.max(0, nowMs() - start),
        },
      };
    }
  }

  const speechAct = analyzeSpeechAct(rawUtterance);
  if (speechAct.delegatesToBrain) {
    return { guard: null, fastPath: null };
  }

  const { text: dictOrMaskedText, blockedByQuotes } = sanitizeUtteranceQuotes(
    speechAct.kind === 'REPAIR_DIRECTIVE' || speechAct.kind === 'POLITE_DIRECTIVE'
      ? speechAct.effectiveText
      : rawUtterance,
  );
  const text =
    speechAct.kind === 'REPAIR_DIRECTIVE' || speechAct.kind === 'POLITE_DIRECTIVE'
      ? speechAct.effectiveText
      : dictOrMaskedText;
  if (blockedByQuotes || !text || text.length > 260) {
    return { guard: null, fastPath: null };
  }

  const salientResources =
    options.salientResources !== undefined
      ? options.salientResources
      : getSessionSalientResources(options.sessionId ?? null);

  // First try atomic single-clause match (handles phrases like "look up bread and butter" without over-splitting).
  const single = compileSingleClause(text, hasPendingConfirm, pathname, salientResources);
  if (single) {
    return {
      guard: null,
      fastPath: {
        language,
        spokenAck: joinAcks([single], language),
        intents: single.intents,
        clauses: [text],
        elapsedMs: Math.max(0, nowMs() - start),
      },
    };
  }

  // Otherwise try compound splitting (`and / then / rồi / và / sau đó`), up to 5 sequential clauses.
  const rawParts = text
    .split(COMPOUND_SPLIT_RE)
    .map((p) => p.trim())
    .filter(Boolean);

  if (rawParts.length >= 2 && rawParts.length <= 5) {
    const compiledClauses: CompiledClause[] = [];
    let simulatedPath = pathname;

    for (const part of rawParts) {
      const compiled = compileSingleClause(part, hasPendingConfirm, simulatedPath, salientResources);
      if (!compiled) {
        // Mixed-Intent Delegation: ANY clause requiring Plane-B reasoning delegates the entire turn!
        return { guard: null, fastPath: null };
      }
      compiledClauses.push(compiled);
      for (const intent of compiled.intents) {
        if (intent.kind === 'navigate') {
          simulatedPath = intent.href.split('?')[0];
        } else if (intent.kind === 'mybooks_open_last') {
          simulatedPath = '/reading';
        }
      }
    }

    const intents = compiledClauses.flatMap((c) => c.intents);
    return {
      guard: null,
      fastPath: {
        language,
        spokenAck: joinAcks(compiledClauses, language),
        intents,
        clauses: rawParts,
        elapsedMs: Math.max(0, nowMs() - start),
      },
    };
  }

  return { guard: null, fastPath: null };
}

/** Alias expected by `EchoJarvisRuntime` & `CoachWidget` (returns both `guard` and `fastPath` outcome). */
export const compileEchoFastPath = evaluateAndCompileUtterance;
