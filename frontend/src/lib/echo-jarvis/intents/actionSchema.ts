/**
 * Canonical client-side App-Intents schema and route allowlist for Echo JARVIS.
 *
 * Plane A intents execute deterministically in the browser against English Coach stores,
 * routers, and typed CustomEvents without fragile DOM scraping or unsafe dynamic code.
 * Every route href matches backend `EchoDestinations.HREF_ALLOW` 1-to-1.
 */

export const ECHO_BG_PRESET_IDS = [
  'pearlescent-abyss',
  'aurora-flow',
  'oceanic-glow',
  'liquid-mesh',
  'nebula-atmosphere',
  'midnight-sapphire',
  'violet-dream',
  'rose-quartz',
  'emerald-depth',
  'arctic-crystal',
] as const;

export type EchoBgPresetId = (typeof ECHO_BG_PRESET_IDS)[number];

const BG_PRESET_SET = new Set<string>(ECHO_BG_PRESET_IDS);

export function isEchoBgPresetId(value: unknown): value is EchoBgPresetId {
  return typeof value === 'string' && BG_PRESET_SET.has(value);
}

export const ECHO_STUDIO_ROOMS = ['background', 'media', 'worlds', 'spatial', 'navigation'] as const;
export type EchoStudioRoom = (typeof ECHO_STUDIO_ROOMS)[number];

export const ECHO_READING_TABS = ['library', 'mybooks', 'bilingual', 'speed'] as const;
export type EchoReadingTab = (typeof ECHO_READING_TABS)[number];

export const ECHO_CEFR_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const;
export type EchoCefrLevel = (typeof ECHO_CEFR_LEVELS)[number];

export const ECHO_READING_WIDTHS = ['narrow', 'comfortable', 'wide'] as const;
export type EchoReadingWidth = (typeof ECHO_READING_WIDTHS)[number];

export const ECHO_BOOK_THEMES = ['paper', 'white', 'dark', 'oled'] as const;
export type EchoBookTheme = (typeof ECHO_BOOK_THEMES)[number];

export const ECHO_MUSIC_COMMANDS = [
  'play',
  'pause',
  'toggle',
  'next',
  'prev',
  'volume_up',
  'volume_down',
  'mute',
  'unmute',
  'shuffle',
] as const;
export type EchoMusicCommand = (typeof ECHO_MUSIC_COMMANDS)[number];

export const ECHO_LISTENING_COMMANDS = [
  'play',
  'pause',
  'toggle',
  'replay',
  'speed',
  'toggle_transcript',
  'switch_dictation',
  'switch_overview',
] as const;
export type EchoListeningCommand = (typeof ECHO_LISTENING_COMMANDS)[number];

export const ECHO_VOICE_CONTROL_COMMANDS = [
  'sleep',
  'mute',
  'unmute',
  'compact',
  'ambient',
  'expand',
  'workspace',
  'captions_on',
  'captions_off',
  'captions_toggle',
] as const;
export type EchoVoiceControlCommand = (typeof ECHO_VOICE_CONTROL_COMMANDS)[number];

export const ECHO_SPEAKING_MODES = ['shadowing', 'roleplay', 'assessment', 'topic'] as const;
export type EchoSpeakingMode = (typeof ECHO_SPEAKING_MODES)[number];

export const ECHO_SPEAKING_HUB_VIEWS = ['practice', 'profile'] as const;
export type EchoSpeakingHubView = (typeof ECHO_SPEAKING_HUB_VIEWS)[number];

export const ECHO_SPEAKING_PROFILE_SUBS = ['overview', 'pronunciation', 'history'] as const;
export type EchoSpeakingProfileSub = (typeof ECHO_SPEAKING_PROFILE_SUBS)[number];

export const ECHO_FLASHCARD_MODES = ['due', 'learned', 'catalog'] as const;
export type EchoFlashcardMode = (typeof ECHO_FLASHCARD_MODES)[number];

export const ECHO_WRITING_ROOMS = [
  'translation',
  'sentence-lab',
  'typing',
  'coach',
  'portfolio',
] as const;
export type EchoWritingRoom = (typeof ECHO_WRITING_ROOMS)[number];

export const ECHO_PRESENTATION_MODES = ['ambient', 'chat', 'immersive'] as const;
export type EchoPresentationMode = (typeof ECHO_PRESENTATION_MODES)[number];

export const ECHO_ENTITY_STATES = [
  'disabled',
  'dormant',
  'awakening',
  'listening',
  'understanding',
  'thinking',
  'speaking',
  'executing',
  'interrupted',
  'reconnecting',
  'sleeping',
  'error',
] as const;
export type EchoEntityState = (typeof ECHO_ENTITY_STATES)[number];
export type EntityVisualState = EchoEntityState;

export const ECHO_DELETE_RESOURCE_TYPES = [
  'flashcard',
  'reading_material',
  'listening_material',
  'local_book',
  'bg_theme',
  'bg_all',
  'writing_session',
  'speaking_scenario',
  'echo_session',
] as const;
export type EchoDeleteResourceType = (typeof ECHO_DELETE_RESOURCE_TYPES)[number];

export const ECHO_FORBIDDEN_REASONS = [
  'exam_assist',
  'grammar_check_answer',
  'srs_auto_rate',
  'payment_mutation',
  'security_auth_mutation',
  'admin_mutation',
  'foreign_user_data',
] as const;
export type EchoForbiddenReason = (typeof ECHO_FORBIDDEN_REASONS)[number];

/**
 * 1:1 mirror of backend `EchoDestinations.HREF_ALLOW` covering all 66 validated destinations
 * across 21+ modules (zero external URLs, zero admin routes, zero unverified IDs).
 */
export const ECHO_JARVIS_HREF_ALLOW =
  /^\/(dashboard|progress|profile|leaderboard|music|premium|games(\/(word-chain|king-of-english|hangman|echo-garden|echo-quiz-rush|echo-spelling))?|community(\/messages)?|study-space(\/timer)?|learning-path(\?view=(list|odyssey))?|grammar(\/topics\/[a-z0-9-]{1,80}|\/(stories|lab|detective)(\/[a-z0-9_-]{1,80})?|\/(library|mistakes|practice|ielts|toeic|real-world))?|flashcards(\?(review=(due|learned)|deck=\d{1,12}))?|reading(\?(materialId=\d{1,12}|(section|tab)=(library|mybooks|bilingual|speed)))?|listening(\/dashboard|\/\d{1,12}(\/practice)?)?|speaking(\/arena|\/(roleplay|shadowing)\/\d{1,12}|\?(mode=(shadowing|roleplay|assessment|topic)|view=profile(&sub=(overview|pronunciation|history))?))?|writing(\?(view=sentence-lab|w=(translation(&mode=PARAGRAPH)?|sentence-lab(&lab=(check|mistakes))?|typing|coach|portfolio)))?|exams(\/(ielts|toeic|profile))?|knowledge-universe(\?word=[A-Za-z%0-9'-]{1,60})?)$/;

export const MAX_ECHO_HREF_LENGTH = 160;

export function safeEchoJarvisHref(href: unknown): string | null {
  if (typeof href !== 'string') return null;
  const trimmed = href.trim();
  if (!trimmed || trimmed.length > MAX_ECHO_HREF_LENGTH) return null;
  return ECHO_JARVIS_HREF_ALLOW.test(trimmed) ? trimmed : null;
}

/**
 * Screens where leaving automatically could discard unsaved work or interrupt active practice.
 */
export function isEchoWorkRoute(
  pathname: string,
  search?: { get(name: string): string | null } | URLSearchParams | null,
): boolean {
  if (!pathname) return false;
  if (
    /^\/(writing|exams\/[^/]+\/(attempts|practice)|listening\/\d+\/practice|study-space|speaking\/(shadowing|roleplay|session)|grammar\/check\/)/.test(
      pathname,
    )
  ) {
    return true;
  }
  return pathname === '/writing' && Boolean(search?.get('sessionId'));
}

export function isActiveExamSimulationRoute(pathname: string): boolean {
  return /^\/exams\/[^/]+\/attempts\/[^/]+/.test(pathname || '');
}

export function isActiveGrammarCheckRoute(pathname: string): boolean {
  return /^\/grammar\/check\/[^/]+/.test(pathname || '');
}

/**
 * Full-screen 3D WebGL worlds or strict contest screens where Echo releases GPU stage / unmounts UI.
 */
export function isImmersive3dWorldRoute(
  pathname: string,
  search?: { get(name: string): string | null } | URLSearchParams | null,
): boolean {
  if (!pathname) return false;
  if (
    pathname === '/speaking/arena' ||
    pathname.startsWith('/speaking/arena/') ||
    pathname === '/study-space' ||
    (pathname.startsWith('/study-space/') && !pathname.startsWith('/study-space/timer')) ||
    pathname === '/games/echo-garden' ||
    pathname.startsWith('/games/echo-garden/') ||
    pathname === '/games/echo-quiz-rush' ||
    pathname.startsWith('/games/echo-quiz-rush/') ||
    pathname === '/games/echo-spelling' ||
    pathname.startsWith('/games/echo-spelling/')
  ) {
    return true;
  }
  if (
    (pathname === '/learning-path' || pathname.startsWith('/learning-path/')) &&
    search?.get('view') === 'odyssey'
  ) {
    return true;
  }
  return false;
}

/**
 * Zero-remount check (`10 §BN`): switching Overview `/listening/{id}` <-> Dictation `/listening/{id}/practice`
 * within the exact same lesson `{id}` keeps `<LessonWorkspace />` mounted without losing audio or draft state.
 */
export function isSameListeningLessonTransition(currentPathname: string, targetHref: string): boolean {
  const cur = /^\/listening\/(\d{1,12})(?:\/practice)?$/.exec(currentPathname || '');
  const next = /^\/listening\/(\d{1,12})(?:\/practice)?$/.exec((targetHref || '').split('?')[0]);
  return Boolean(cur && next && cur[1] === next[1]);
}

export type EchoClientIntent =
  | {
      kind: 'navigate';
      href: string;
      label?: string;
      confirmLeaveWorkRoute?: boolean;
    }
  | {
      kind: 'history_back';
      confirmLeaveWorkRoute?: boolean;
    }
  | {
      kind: 'history_forward';
      confirmLeaveWorkRoute?: boolean;
    }
  | {
      kind: 'scroll';
      target: 'up' | 'down' | 'top' | 'bottom';
      amountPx?: number;
    }
  | {
      kind: 'theme_mode';
      mode: 'light' | 'dark' | 'system';
    }
  | {
      kind: 'ui_font_scale';
      delta?: number;
      scale?: number;
    }
  | {
      kind: 'ui_locale';
      locale: 'vi' | 'en';
    }
  | {
      kind: 'nav_layout';
      layout: 'sidebar' | 'dock';
    }
  | {
      kind: 'nav_visibility';
      visibility: 'pinned' | 'autohide';
    }
  | {
      kind: 'world_display';
      world: 'odyssey' | 'cosmos';
      display: 'immersive' | 'embedded';
    }
  | {
      kind: 'open_guide';
    }
  | {
      kind: 'open_appearance_studio';
      room?: EchoStudioRoom;
    }
  | {
      kind: 'apply_bg_preset';
      presetId: EchoBgPresetId;
    }
  | {
      kind: 'adjust_bg_brightness';
      delta: number;
      calmMotion?: boolean;
    }
  | {
      kind: 'reset_appearance';
    }
  | {
      kind: 'dictionary_lookup';
      word: string;
    }
  | {
      kind: 'music_control';
      command: EchoMusicCommand;
    }
  | {
      kind: 'reading_control';
      tab?: EchoReadingTab;
      filterLevel?: EchoCefrLevel | '';
      filterTopic?: string;
      searchQuery?: string;
      fontDelta?: number;
      fontSize?: number;
      width?: EchoReadingWidth;
    }
  | {
      kind: 'mybooks_open_last';
      query?: string;
    }
  | {
      kind: 'mybooks_reader';
      theme?: EchoBookTheme;
      fontDelta?: number;
      fontSize?: number;
      page?: 'next' | 'prev';
    }
  | {
      kind: 'listening_player';
      command: EchoListeningCommand;
      speed?: number;
    }
  | {
      kind: 'speaking_control';
      view?: EchoSpeakingHubView;
      sub?: EchoSpeakingProfileSub;
      mode?: EchoSpeakingMode;
      cefr?: EchoCefrLevel | '';
      category?: string;
      query?: string;
      scenarioId?: number;
    }
  | {
      kind: 'flashcard_control';
      mode?: EchoFlashcardMode;
      deckId?: number;
      searchQuery?: string;
    }
  | {
      kind: 'writing_control';
      room?: EchoWritingRoom;
      mode?: string;
    }
  | {
      kind: 'undo_last_action';
    }
  | {
      kind: 'voice_confirm';
      decision: 'confirm' | 'cancel';
    }
  | {
      kind: 'voice_control';
      command: EchoVoiceControlCommand;
    }
  | {
      kind: 'request_logout';
    }
  | {
      kind: 'delete_resource';
      resourceType: EchoDeleteResourceType;
      resourceId?: string;
      label?: string;
    }
  | {
      kind: 'plan_or_dna_commit';
      token: string;
      actionType: 'plan_change' | 'dna_update' | 'flashcard_batch_commit';
    }
  | {
      kind: 'forbidden_attempt';
      reason: EchoForbiddenReason;
    }
  | {
      kind: 'unsupported_external';
      detail: string;
    };

export type EchoIntentValidationResult =
  | { valid: true; intent: EchoClientIntent }
  | { valid: false; reason: string; tier: 'DENIED' | 'UNSUPPORTED' };

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const EXTERNAL_URL_RE = /^(?:https?:|javascript:|data:|vbscript:|file:|mailto:|tel:|\/\/)/i;
const DICT_WORD_RE = /^[A-Za-z][A-Za-z0-9' -]{0,59}$/;
const TOKEN_ID_RE = /^[A-Za-z0-9_-]{1,96}$/;

function hasDangerousKeys(obj: Record<string, unknown>): boolean {
  for (const key of Object.keys(obj)) {
    if (DANGEROUS_KEYS.has(key)) return true;
  }
  return false;
}

function clampInt(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(n)));
}

/**
 * Strictly validates an untrusted or compiled intent payload before permission evaluation or execution.
 * Enforces deny-by-default for unknown intent kinds, out-of-range values, and unallowlisted URLs.
 */
export function validateEchoClientIntent(raw: unknown): EchoIntentValidationResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, reason: 'invalid_intent_object', tier: 'DENIED' };
  }
  const obj = raw as Record<string, unknown>;
  if (hasDangerousKeys(obj)) {
    return { valid: false, reason: 'prototype_pollution_blocked', tier: 'DENIED' };
  }
  const kind = obj.kind;
  if (typeof kind !== 'string') {
    return { valid: false, reason: 'missing_intent_kind', tier: 'DENIED' };
  }

  switch (kind) {
    case 'navigate': {
      const rawHref = typeof obj.href === 'string' ? obj.href.trim() : '';
      if (!rawHref) return { valid: false, reason: 'missing_href', tier: 'DENIED' };
      if (EXTERNAL_URL_RE.test(rawHref)) {
        if (/^(?:javascript:|data:|vbscript:)/i.test(rawHref)) {
          return { valid: false, reason: 'unsafe_uri_scheme', tier: 'DENIED' };
        }
        return { valid: false, reason: 'external_url_unsupported', tier: 'UNSUPPORTED' };
      }
      if (/^\/admin(?:\/|$)/i.test(rawHref)) {
        return { valid: false, reason: 'admin_route_denied', tier: 'DENIED' };
      }
      const safeHref = safeEchoJarvisHref(rawHref);
      if (!safeHref) {
        return { valid: false, reason: 'href_not_in_allowlist', tier: 'DENIED' };
      }
      const label = typeof obj.label === 'string' ? obj.label.trim().slice(0, 80) : undefined;
      return {
        valid: true,
        intent: {
          kind: 'navigate',
          href: safeHref,
          ...(label ? { label } : {}),
          ...(obj.confirmLeaveWorkRoute === true ? { confirmLeaveWorkRoute: true } : {}),
        },
      };
    }

    case 'history_back':
    case 'history_forward':
      return {
        valid: true,
        intent: {
          kind,
          ...(obj.confirmLeaveWorkRoute === true ? { confirmLeaveWorkRoute: true } : {}),
        },
      };

    case 'scroll': {
      if (obj.target !== 'up' && obj.target !== 'down' && obj.target !== 'top' && obj.target !== 'bottom') {
        return { valid: false, reason: 'invalid_scroll_target', tier: 'DENIED' };
      }
      const amountPx =
        typeof obj.amountPx === 'number' && Number.isFinite(obj.amountPx)
          ? clampInt(obj.amountPx, 80, 2400)
          : undefined;
      return { valid: true, intent: { kind: 'scroll', target: obj.target, ...(amountPx ? { amountPx } : {}) } };
    }

    case 'theme_mode':
      if (obj.mode !== 'light' && obj.mode !== 'dark' && obj.mode !== 'system') {
        return { valid: false, reason: 'invalid_theme_mode', tier: 'DENIED' };
      }
      return { valid: true, intent: { kind: 'theme_mode', mode: obj.mode } };

    case 'ui_font_scale': {
      const delta =
        typeof obj.delta === 'number' && Number.isFinite(obj.delta)
          ? Math.max(-0.25, Math.min(0.25, Math.round(obj.delta * 100) / 100))
          : undefined;
      const scale =
        typeof obj.scale === 'number' && Number.isFinite(obj.scale)
          ? Math.max(0.9, Math.min(1.25, Math.round(obj.scale * 100) / 100))
          : undefined;
      if (delta === undefined && scale === undefined) {
        return { valid: false, reason: 'empty_ui_font_scale', tier: 'DENIED' };
      }
      return {
        valid: true,
        intent: {
          kind: 'ui_font_scale',
          ...(delta !== undefined ? { delta } : {}),
          ...(scale !== undefined ? { scale } : {}),
        },
      };
    }

    case 'ui_locale':
      if (obj.locale !== 'vi' && obj.locale !== 'en') {
        return { valid: false, reason: 'invalid_ui_locale', tier: 'DENIED' };
      }
      return { valid: true, intent: { kind: 'ui_locale', locale: obj.locale } };

    case 'nav_layout':
      if (obj.layout !== 'sidebar' && obj.layout !== 'dock') {
        return { valid: false, reason: 'invalid_nav_layout', tier: 'DENIED' };
      }
      return { valid: true, intent: { kind: 'nav_layout', layout: obj.layout } };

    case 'nav_visibility':
      if (obj.visibility !== 'pinned' && obj.visibility !== 'autohide') {
        return { valid: false, reason: 'invalid_nav_visibility', tier: 'DENIED' };
      }
      return { valid: true, intent: { kind: 'nav_visibility', visibility: obj.visibility } };

    case 'world_display':
      if ((obj.world !== 'odyssey' && obj.world !== 'cosmos') || (obj.display !== 'immersive' && obj.display !== 'embedded')) {
        return { valid: false, reason: 'invalid_world_display', tier: 'DENIED' };
      }
      return { valid: true, intent: { kind: 'world_display', world: obj.world, display: obj.display } };

    case 'open_guide':
      return { valid: true, intent: { kind: 'open_guide' } };

    case 'open_appearance_studio': {
      if (obj.room !== undefined && !(ECHO_STUDIO_ROOMS as readonly unknown[]).includes(obj.room)) {
        return { valid: false, reason: 'invalid_studio_room', tier: 'DENIED' };
      }
      return {
        valid: true,
        intent: {
          kind: 'open_appearance_studio',
          ...(obj.room ? { room: obj.room as EchoStudioRoom } : {}),
        },
      };
    }

    case 'apply_bg_preset':
      if (!isEchoBgPresetId(obj.presetId)) {
        return { valid: false, reason: 'invalid_bg_preset_id', tier: 'DENIED' };
      }
      return { valid: true, intent: { kind: 'apply_bg_preset', presetId: obj.presetId } };

    case 'adjust_bg_brightness': {
      if (typeof obj.delta !== 'number' || !Number.isFinite(obj.delta)) {
        return { valid: false, reason: 'invalid_bg_brightness_delta', tier: 'DENIED' };
      }
      return {
        valid: true,
        intent: {
          kind: 'adjust_bg_brightness',
          delta: clampInt(obj.delta, -60, 60),
          ...(obj.calmMotion === true ? { calmMotion: true } : {}),
        },
      };
    }

    case 'reset_appearance':
      return { valid: true, intent: { kind: 'reset_appearance' } };

    case 'dictionary_lookup': {
      const word = typeof obj.word === 'string' ? obj.word.trim().replace(/\s+/g, ' ') : '';
      if (word && !DICT_WORD_RE.test(word)) {
        return { valid: false, reason: 'invalid_dictionary_word', tier: 'DENIED' };
      }
      return { valid: true, intent: { kind: 'dictionary_lookup', word } };
    }

    case 'music_control':
      if (!(ECHO_MUSIC_COMMANDS as readonly unknown[]).includes(obj.command)) {
        return { valid: false, reason: 'invalid_music_command', tier: 'DENIED' };
      }
      return { valid: true, intent: { kind: 'music_control', command: obj.command as EchoMusicCommand } };

    case 'reading_control': {
      const tab = obj.tab;
      if (tab !== undefined && !(ECHO_READING_TABS as readonly unknown[]).includes(tab)) {
        return { valid: false, reason: 'invalid_reading_tab', tier: 'DENIED' };
      }
      const filterLevel = obj.filterLevel;
      if (
        filterLevel !== undefined &&
        filterLevel !== '' &&
        !(ECHO_CEFR_LEVELS as readonly unknown[]).includes(filterLevel)
      ) {
        return { valid: false, reason: 'invalid_reading_level', tier: 'DENIED' };
      }
      const width = obj.width;
      if (width !== undefined && !(ECHO_READING_WIDTHS as readonly unknown[]).includes(width)) {
        return { valid: false, reason: 'invalid_reading_width', tier: 'DENIED' };
      }
      const filterTopic =
        typeof obj.filterTopic === 'string' ? obj.filterTopic.trim().slice(0, 60) : undefined;
      const searchQuery =
        typeof obj.searchQuery === 'string' ? obj.searchQuery.trim().slice(0, 80) : undefined;
      const fontDelta =
        typeof obj.fontDelta === 'number' && Number.isFinite(obj.fontDelta)
          ? clampInt(obj.fontDelta, -10, 10)
          : undefined;
      const fontSize =
        typeof obj.fontSize === 'number' && Number.isFinite(obj.fontSize)
          ? clampInt(obj.fontSize, 15, 28)
          : undefined;
      if (
        tab === undefined &&
        filterLevel === undefined &&
        filterTopic === undefined &&
        searchQuery === undefined &&
        fontDelta === undefined &&
        fontSize === undefined &&
        width === undefined
      ) {
        return { valid: false, reason: 'empty_reading_control', tier: 'DENIED' };
      }
      return {
        valid: true,
        intent: {
          kind: 'reading_control',
          ...(tab !== undefined ? { tab: tab as EchoReadingTab } : {}),
          ...(filterLevel !== undefined ? { filterLevel: filterLevel as EchoCefrLevel | '' } : {}),
          ...(filterTopic !== undefined ? { filterTopic } : {}),
          ...(searchQuery !== undefined ? { searchQuery } : {}),
          ...(fontDelta !== undefined ? { fontDelta } : {}),
          ...(fontSize !== undefined ? { fontSize } : {}),
          ...(width !== undefined ? { width: width as EchoReadingWidth } : {}),
        },
      };
    }

    case 'mybooks_open_last': {
      const query = typeof obj.query === 'string' ? obj.query.trim().slice(0, 80) : undefined;
      return { valid: true, intent: { kind: 'mybooks_open_last', ...(query ? { query } : {}) } };
    }

    case 'mybooks_reader': {
      const theme = obj.theme;
      if (theme !== undefined && !(ECHO_BOOK_THEMES as readonly unknown[]).includes(theme)) {
        return { valid: false, reason: 'invalid_book_theme', tier: 'DENIED' };
      }
      const page = obj.page;
      if (page !== undefined && page !== 'next' && page !== 'prev') {
        return { valid: false, reason: 'invalid_book_page_direction', tier: 'DENIED' };
      }
      const fontDelta =
        typeof obj.fontDelta === 'number' && Number.isFinite(obj.fontDelta)
          ? clampInt(obj.fontDelta, -10, 10)
          : undefined;
      const fontSize =
        typeof obj.fontSize === 'number' && Number.isFinite(obj.fontSize)
          ? clampInt(obj.fontSize, 14, 32)
          : undefined;
      if (theme === undefined && page === undefined && fontDelta === undefined && fontSize === undefined) {
        return { valid: false, reason: 'empty_mybooks_reader_control', tier: 'DENIED' };
      }
      return {
        valid: true,
        intent: {
          kind: 'mybooks_reader',
          ...(theme !== undefined ? { theme: theme as EchoBookTheme } : {}),
          ...(page !== undefined ? { page } : {}),
          ...(fontDelta !== undefined ? { fontDelta } : {}),
          ...(fontSize !== undefined ? { fontSize } : {}),
        },
      };
    }

    case 'listening_player': {
      if (!(ECHO_LISTENING_COMMANDS as readonly unknown[]).includes(obj.command)) {
        return { valid: false, reason: 'invalid_listening_command', tier: 'DENIED' };
      }
      let speed: number | undefined;
      if (obj.command === 'speed') {
        if (typeof obj.speed !== 'number' || !Number.isFinite(obj.speed)) {
          return { valid: false, reason: 'missing_listening_speed', tier: 'DENIED' };
        }
        speed = Math.max(0.5, Math.min(2.0, Math.round(obj.speed * 100) / 100));
      }
      return {
        valid: true,
        intent: {
          kind: 'listening_player',
          command: obj.command as EchoListeningCommand,
          ...(speed !== undefined ? { speed } : {}),
        },
      };
    }

    case 'speaking_control': {
      const rawView = obj.view ?? obj.tab;
      if (rawView !== undefined && !(ECHO_SPEAKING_HUB_VIEWS as readonly unknown[]).includes(rawView)) {
        return { valid: false, reason: 'invalid_speaking_view', tier: 'DENIED' };
      }
      const sub = obj.sub;
      if (sub !== undefined && !(ECHO_SPEAKING_PROFILE_SUBS as readonly unknown[]).includes(sub)) {
        return { valid: false, reason: 'invalid_speaking_profile_sub', tier: 'DENIED' };
      }
      const view =
        rawView !== undefined
          ? (rawView as EchoSpeakingHubView)
          : sub !== undefined
            ? 'profile'
            : undefined;
      const mode = obj.mode;
      if (mode !== undefined && !(ECHO_SPEAKING_MODES as readonly unknown[]).includes(mode)) {
        return { valid: false, reason: 'invalid_speaking_mode', tier: 'DENIED' };
      }
      const cefr = obj.cefr;
      if (cefr !== undefined && cefr !== '' && !(ECHO_CEFR_LEVELS as readonly unknown[]).includes(cefr)) {
        return { valid: false, reason: 'invalid_speaking_cefr', tier: 'DENIED' };
      }
      const category = typeof obj.category === 'string' ? obj.category.trim().slice(0, 60) : undefined;
      const query = typeof obj.query === 'string' ? obj.query.trim().slice(0, 80) : undefined;
      const scenarioId =
        typeof obj.scenarioId === 'number' && Number.isSafeInteger(obj.scenarioId) && obj.scenarioId > 0 && obj.scenarioId <= 1_000_000_000
          ? obj.scenarioId
          : undefined;
      if (
        view === undefined &&
        sub === undefined &&
        mode === undefined &&
        cefr === undefined &&
        !category &&
        !query &&
        scenarioId === undefined
      ) {
        return { valid: false, reason: 'empty_speaking_control', tier: 'DENIED' };
      }
      return {
        valid: true,
        intent: {
          kind: 'speaking_control',
          ...(view !== undefined ? { view } : {}),
          ...(sub !== undefined ? { sub: sub as EchoSpeakingProfileSub } : {}),
          ...(mode !== undefined ? { mode: mode as EchoSpeakingMode } : {}),
          ...(cefr !== undefined ? { cefr: cefr as EchoCefrLevel | '' } : {}),
          ...(category ? { category } : {}),
          ...(query ? { query } : {}),
          ...(scenarioId !== undefined ? { scenarioId } : {}),
        },
      };
    }

    case 'flashcard_control': {
      const mode = obj.mode;
      if (mode !== undefined && !(ECHO_FLASHCARD_MODES as readonly unknown[]).includes(mode)) {
        return { valid: false, reason: 'invalid_flashcard_mode', tier: 'DENIED' };
      }
      const deckId =
        typeof obj.deckId === 'number' && Number.isSafeInteger(obj.deckId) && obj.deckId > 0 && obj.deckId <= 1_000_000_000
          ? obj.deckId
          : undefined;
      const searchQuery = typeof obj.searchQuery === 'string' ? obj.searchQuery.trim().slice(0, 80) : undefined;
      if (mode === undefined && deckId === undefined && !searchQuery) {
        return { valid: false, reason: 'empty_flashcard_control', tier: 'DENIED' };
      }
      return {
        valid: true,
        intent: {
          kind: 'flashcard_control',
          ...(mode !== undefined ? { mode: mode as EchoFlashcardMode } : {}),
          ...(deckId !== undefined ? { deckId } : {}),
          ...(searchQuery ? { searchQuery } : {}),
        },
      };
    }

    case 'writing_control': {
      const room = obj.room;
      if (room !== undefined && !(ECHO_WRITING_ROOMS as readonly unknown[]).includes(room)) {
        return { valid: false, reason: 'invalid_writing_room', tier: 'DENIED' };
      }
      const mode = typeof obj.mode === 'string' ? obj.mode.trim().slice(0, 40) : undefined;
      if (room === undefined && !mode) {
        return { valid: false, reason: 'empty_writing_control', tier: 'DENIED' };
      }
      return {
        valid: true,
        intent: {
          kind: 'writing_control',
          ...(room !== undefined ? { room: room as EchoWritingRoom } : {}),
          ...(mode ? { mode } : {}),
        },
      };
    }

    case 'undo_last_action':
      return { valid: true, intent: { kind: 'undo_last_action' } };

    case 'voice_confirm':
      if (obj.decision !== 'confirm' && obj.decision !== 'cancel') {
        return { valid: false, reason: 'invalid_voice_confirm_decision', tier: 'DENIED' };
      }
      return { valid: true, intent: { kind: 'voice_confirm', decision: obj.decision } };

    case 'voice_control':
      if (!(ECHO_VOICE_CONTROL_COMMANDS as readonly unknown[]).includes(obj.command)) {
        return { valid: false, reason: 'invalid_voice_control_command', tier: 'DENIED' };
      }
      return { valid: true, intent: { kind: 'voice_control', command: obj.command as EchoVoiceControlCommand } };

    case 'request_logout':
      return { valid: true, intent: { kind: 'request_logout' } };

    case 'delete_resource': {
      if (!(ECHO_DELETE_RESOURCE_TYPES as readonly unknown[]).includes(obj.resourceType)) {
        return { valid: false, reason: 'invalid_delete_resource_type', tier: 'DENIED' };
      }
      const resourceId =
        typeof obj.resourceId === 'string' && TOKEN_ID_RE.test(obj.resourceId)
          ? obj.resourceId
          : undefined;
      const label = typeof obj.label === 'string' ? obj.label.trim().slice(0, 80) : undefined;
      return {
        valid: true,
        intent: {
          kind: 'delete_resource',
          resourceType: obj.resourceType as EchoDeleteResourceType,
          ...(resourceId ? { resourceId } : {}),
          ...(label ? { label } : {}),
        },
      };
    }

    case 'plan_or_dna_commit': {
      if (
        typeof obj.token !== 'string' ||
        !TOKEN_ID_RE.test(obj.token) ||
        (obj.actionType !== 'plan_change' &&
          obj.actionType !== 'dna_update' &&
          obj.actionType !== 'flashcard_batch_commit')
      ) {
        return { valid: false, reason: 'invalid_plan_or_dna_commit', tier: 'DENIED' };
      }
      return { valid: true, intent: { kind: 'plan_or_dna_commit', token: obj.token, actionType: obj.actionType } };
    }

    case 'forbidden_attempt':
      if (!(ECHO_FORBIDDEN_REASONS as readonly unknown[]).includes(obj.reason)) {
        return { valid: false, reason: 'unknown_forbidden_reason', tier: 'DENIED' };
      }
      return { valid: true, intent: { kind: 'forbidden_attempt', reason: obj.reason as EchoForbiddenReason } };

    case 'unsupported_external': {
      const detail = typeof obj.detail === 'string' ? obj.detail.trim().slice(0, 120) : 'external_action';
      return { valid: true, intent: { kind: 'unsupported_external', detail } };
    }

    default:
      return { valid: false, reason: `unknown_intent_kind:${kind.slice(0, 40)}`, tier: 'DENIED' };
  }
}
