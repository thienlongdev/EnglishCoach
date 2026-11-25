export type EchoMode = 'collapsed' | 'compact' | 'expanded';
export interface EchoGeometry { x: number; y: number; width: number; height: number }
export const ECHO_WINDOW_KEY = 'echo_window_preferences';
export function clampGeometry(value: unknown, viewport: { width: number; height: number }): EchoGeometry {
  const v = (value && typeof value === 'object' ? value : {}) as Partial<EchoGeometry>;
  const number = (n: unknown, fallback: number) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 100000 ? n : fallback;
  const maxWidth = Math.max(1, viewport.width - 24), maxHeight = Math.max(1, viewport.height - 24);
  const width = Math.min(maxWidth, Math.max(Math.min(480, maxWidth), number(v.width, 660)));
  const height = Math.min(maxHeight, Math.max(Math.min(380, maxHeight), number(v.height, 680)));
  return { width, height, x: Math.min(Math.max(12, number(v.x, viewport.width - width - 28)), Math.max(12, viewport.width - width - 12)),
    y: Math.min(Math.max(12, number(v.y, viewport.height - height - 28)), Math.max(12, viewport.height - height - 12)) };
}
export function restoreWindow(raw: string | null, viewport: { width: number; height: number }) {
  let parsed: { mode?: unknown; geometry?: unknown } = {};
  try { parsed = JSON.parse(raw || '{}') || {}; } catch { /* Recover corrupt preferences. */ }
  return { mode: (['collapsed', 'compact', 'expanded'].includes(String(parsed.mode)) ? parsed.mode : 'collapsed') as EchoMode,
    geometry: clampGeometry(parsed.geometry, viewport) };
}
export function sessionStorageKey(scope: string) { return `echo_coach_active_session_id:${scope}`; }
export const ECHO_ACTIONS: Record<string, { vi: string; en: string; route: string }> = {
  '[Speaking AI -> Shadowing Studio]': { vi: 'Luyện phát âm', en: 'Shadowing practice', route: '/speaking?mode=shadowing' },
  '[Speaking AI -> Quick Check Part 1]': { vi: 'Luyện nói', en: 'Speaking practice', route: '/speaking?mode=assessment' },
  '[Writing Studio -> Sentence Lab]': { vi: 'Luyện đặt câu', en: 'Sentence practice', route: '/writing?view=sentence-lab' },
  '[Exams -> Listening Section 3 Practice]': { vi: 'Luyện nghe', en: 'Listening practice', route: '/exams' },
  '[Flashcards -> Ôn tập ngay]': { vi: 'Ôn từ vựng', en: 'Review vocabulary', route: '/flashcards' },
  '[Lộ trình học -> Hôm nay]': { vi: 'Lộ trình hôm nay', en: "Today's path", route: '/learning-path' },
};
/**
 * Every href Echo may navigate to (server route registry EchoDestinations.HREF_ALLOW, mirrored). A model never supplies a URL:
 * the server builds hrefs from typed destinations, and the client re-validates before any navigation.
 */
export const ECHO_HREF = /^\/(dashboard|progress|profile|leaderboard|music|premium|games(\/(word-chain|king-of-english|hangman|echo-garden|echo-quiz-rush|echo-spelling))?|community(\/messages)?|study-space(\/timer)?|learning-path(\?view=(list|odyssey))?|grammar(\/topics\/[a-z0-9-]{1,80}|\/(stories|lab|detective)(\/[a-z0-9_-]{1,80})?|\/(library|mistakes|practice|ielts|toeic|real-world))?|flashcards(\?(review=(due|learned)|deck=\d{1,12}))?|reading(\?(materialId=\d{1,12}|(section|tab)=(library|mybooks|bilingual|speed)))?|listening(\/dashboard|\/\d{1,12}(\/practice)?)?|speaking(\/arena|\/(roleplay|shadowing)\/\d{1,12}|\?(mode=(shadowing|roleplay|assessment|topic)|view=profile(&sub=(overview|pronunciation|history))?))?|writing(\?(view=sentence-lab|w=(translation(&mode=PARAGRAPH)?|sentence-lab(&lab=(check|mistakes))?|typing|coach|portfolio)))?|exams(\/(ielts|toeic|profile))?|knowledge-universe(\?word=[A-Za-z%0-9'-]{1,60})?)$/;
export function safeEchoHref(href: unknown): string | null {
  return typeof href === 'string' && href.length <= 160 && ECHO_HREF.test(href) ? href : null;
}
/** Screens where an automatic navigation could lose unsaved work: Echo offers a button instead. */
export function isWorkRoute(pathname: string, search?: { get(name: string): string | null } | null) {
  return /^\/(writing|grammar\/check|exams\/[^/]+\/(attempts|practice)|listening\/\d+\/practice|study-space|speaking\/(shadowing|roleplay|session))/.test(pathname)
    || (pathname === '/writing' && !!search?.get('sessionId'));
}
export function messageActions(content: string) {
  return Object.entries(ECHO_ACTIONS).filter(([tag]) => content.includes(tag)).slice(0, 2).map(([tag, action]) => ({ tag, ...action }));
}

export type EchoVoiceRecoveryKind =
  | 'mic_unavailable'
  | 'speech_unrecognized'
  | 'connection_interrupted'
  | 'service_busy'
  | 'quota_limit';

export interface EchoVoiceRecoveryCopy {
  kind: EchoVoiceRecoveryKind;
  title: string;
  subtitle?: string;
  retryable: boolean;
}

const RAW_TECHNICAL_ERROR_RE =
  /^(?:failed|error|unknown|null|undefined|nan|ws_error|ws_closed|asr_failed|llm_failed|tts_failed|turn_failed|stream_failed|internal_error|bad_request|service_unavailable|gateway_timeout|timeout|aborted|network_error|http[_\s-]?\d{3}|\d{3})$/i;

const INTERNAL_LEAK_SUBSTRING_RE =
  /\b(?:Request path cannot be relayed|OpenRouter|Cloudflare|Exception|Stacktrace|ECONNREFUSED|ETIMEDOUT|HTTP\s+[45]\d{2}|status\s+code\s+[45]\d{2}|TypeError|SyntaxError)\b/i;

export function classifyEchoVoiceError(rawCodeOrText: unknown, exhausted = false): EchoVoiceRecoveryKind {
  if (exhausted) return 'quota_limit';
  const raw = typeof rawCodeOrText === 'string' ? rawCodeOrText.trim() : '';
  const lower = raw.toLowerCase();
  if (!lower) return 'service_busy';
  if (
    lower.includes('quota') ||
    lower.includes('coach_daily') ||
    lower.includes('coach_premium') ||
    lower.includes('exhausted') ||
    lower.includes('daily limit') ||
    lower.includes('hết lượt') ||
    lower === 'daily'
  ) {
    return 'quota_limit';
  }
  if (
    lower.includes('mic_unavailable') ||
    lower.includes('not-allowed') ||
    lower.includes('notallowed') ||
    lower.includes('permission') ||
    lower.includes('audio-capture') ||
    lower.includes('device-busy') ||
    lower.includes('notfounderror') ||
    lower.includes('notreadableerror') ||
    lower.includes('quyền micro') ||
    lower.includes('mở được micro')
  ) {
    return 'mic_unavailable';
  }
  if (
    lower.includes('speech_unrecognized') ||
    lower.includes('no-speech') ||
    lower.includes('no_speech') ||
    lower.includes('empty_transcript') ||
    lower.includes('chưa nghe rõ') ||
    lower.includes('chưa nghe thấy')
  ) {
    return 'speech_unrecognized';
  }
  if (
    lower.includes('connection_interrupted') ||
    lower.includes('ws_closed') ||
    lower.includes('ws_error') ||
    lower.includes('network') ||
    lower.includes('disconnect') ||
    lower.includes('reconnect') ||
    lower.includes('timeout') ||
    lower === 'connection' ||
    lower.includes('gián đoạn')
  ) {
    return 'connection_interrupted';
  }
  return 'service_busy';
}

export function isRawTechnicalEchoText(value: unknown): boolean {
  if (typeof value !== 'string') return true;
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (RAW_TECHNICAL_ERROR_RE.test(trimmed)) return true;
  if (INTERNAL_LEAK_SUBSTRING_RE.test(trimmed)) return true;
  if (/^[a-z0-9]+(?:[_-][a-z0-9]+){1,5}$/i.test(trimmed)) return true;
  return false;
}

export function resolveEchoVoiceRecoveryCopy(
  rawTitle: unknown,
  rawSubtitle: unknown,
  vi: boolean,
  exhausted = false,
): EchoVoiceRecoveryCopy {
  const combined = [rawTitle, rawSubtitle].filter(v => typeof v === 'string' && v.trim()).join(' ');
  const kind = classifyEchoVoiceError(combined, exhausted);

  const catalog: Record<EchoVoiceRecoveryKind, { vi: string; en: string; retryable: boolean }> = {
    mic_unavailable: {
      vi: 'Chưa mở được micro. Bạn kiểm tra quyền micro rồi thử lại nhé.',
      en: 'Microphone unavailable. Check mic permission and try again.',
      retryable: true,
    },
    speech_unrecognized: {
      vi: 'Echo chưa nghe rõ câu vừa rồi. Bạn nói lại giúp mình nhé.',
      en: 'Echo did not catch that clearly. Please try speaking again.',
      retryable: true,
    },
    connection_interrupted: {
      vi: 'Kết nối giọng nói tạm gián đoạn. Nhấn thử lại để tiếp tục nhé.',
      en: 'Voice connection briefly interrupted. Tap retry to continue.',
      retryable: true,
    },
    service_busy: {
      vi: 'Echo đang bận một nhịp ngắn. Bạn thử hỏi lại ngay nhé.',
      en: 'Echo is momentarily busy. Please try asking again.',
      retryable: true,
    },
    quota_limit: {
      vi: 'Bạn đã dùng hết lượt trò chuyện hôm nay.',
      en: 'You have reached today’s conversation allowance.',
      retryable: false,
    },
  };

  const fallback = catalog[kind];
  const cleanTitle = typeof rawTitle === 'string' && !isRawTechnicalEchoText(rawTitle) ? rawTitle.trim().slice(0, 140) : '';
  const cleanSub = typeof rawSubtitle === 'string' && !isRawTechnicalEchoText(rawSubtitle) ? rawSubtitle.trim().slice(0, 180) : '';

  return {
    kind,
    title: cleanTitle || (vi ? fallback.vi : fallback.en),
    subtitle: cleanTitle && cleanSub ? cleanSub : undefined,
    retryable: fallback.retryable,
  };
}

export function sanitizeEchoStatusCopy(rawStatus: unknown, vi: boolean): string {
  if (typeof rawStatus !== 'string') return '';
  const trimmed = rawStatus.trim();
  if (!trimmed) return '';
  if (isRawTechnicalEchoText(trimmed)) {
    return vi ? 'Echo đang xử lý…' : 'Echo is working…';
  }
  return trimmed.slice(0, 120);
}

export function sanitizeEchoActionDetail(rawDetail: unknown, status: string | undefined, vi: boolean): string {
  if (typeof rawDetail === 'string' && !isRawTechnicalEchoText(rawDetail)) {
    return rawDetail.trim().slice(0, 140);
  }
  if (status === 'failed') return vi ? 'Chưa hoàn tất thao tác' : 'Action did not complete';
  if (status === 'denied') return vi ? 'Thao tác bị từ chối' : 'Action declined';
  if (status === 'confirm_required') return vi ? 'Đang chờ xác nhận' : 'Awaiting confirmation';
  return vi ? 'Đã thực hiện thao tác' : 'Action completed';
}
