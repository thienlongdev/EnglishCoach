/**
 * Four-Tier Permission Engine and Prompt-Injection Defense for Echo JARVIS.
 *
 * Classifies every client intent or raw learner request into:
 * - `AUTO_EXECUTE`: Safe, reversible UI/navigation/lookup/playback actions when no contest/exam/work lock applies.
 * - `CONFIRM_REQUIRED`: Leaving active `isWorkRoute`, `request_logout`, deleting user resources/books/themes/sessions,
 *   or committing study-plan / Learner DNA updates.
 * - `DENIED`: Active `EXAM_SIMULATION` (`/exams/{family}/attempts/{id}`), active strict Sentinel attempts
 *   (`hasActiveStrictSentinelAttempt()`), solving `/grammar/check/{id}` mastery items, SRS auto-rating,
 *   payments/billing/quota mutations, password/MFA/admin mutations, foreign user data, or unallowlisted intents.
 * - `UNSUPPORTED`: Actions outside browser or platform boundaries (external arbitrary URLs, OS apps, raw disk access).
 */

import { hasActiveStrictSentinelAttempt } from '@/lib/sentinel/client';
import {
  type EchoClientIntent,
  isActiveExamSimulationRoute,
  isActiveGrammarCheckRoute,
  isEchoWorkRoute,
  isSameListeningLessonTransition,
  validateEchoClientIntent,
} from './actionSchema';
import { QUOTED_SPAN_TOKEN, analyzeSpeechAct, maskQuotedSpans } from './speechActAnalyzer';

export type PermissionDecision = 'AUTO_EXECUTE' | 'CONFIRM_REQUIRED' | 'DENIED' | 'UNSUPPORTED';

export interface PermissionEvalContext {
  pathname: string;
  searchParams?: { get(name: string): string | null } | URLSearchParams | null;
  hasActiveStrictSentinel?: boolean;
  hasPendingConfirmation?: boolean;
  /** Set true only when consuming a verified learner confirmation for a pending client action. */
  confirmedClientAction?: boolean;
}

export interface PermissionPrompt {
  en: string;
  vi: string;
}

export interface PermissionEvaluation {
  decision: PermissionDecision;
  reason: string;
  intent?: EchoClientIntent;
  prompt?: PermissionPrompt;
  spokenMessageEn?: string;
  spokenMessageVi?: string;
}

export interface DequotedResult {
  stripped: string;
  quotedSegments: string[];
  hadQuotes: boolean;
}

/**
 * Masks untrusted quoted spans with ` __quoted__ ` (never empty `""`) so `Open "anything" reading`
 * never collapses into `Open reading`, while preserving contractions (`don't`, `let's`, `I'm`, `today's`).
 */
export function stripUntrustedQuotes(raw: string): string {
  return maskQuotedSpans(raw).masked;
}

/**
 * Masks untrusted quoted passage/selection text before intent matching so text on screen
 * or highlighted excerpts can NEVER trigger prompt-injected commands.
 */
export function dequoteUntrustedText(raw: string): DequotedResult {
  if (typeof raw !== 'string' || !raw) {
    return { stripped: '', quotedSegments: [], hadQuotes: false };
  }
  const res = maskQuotedSpans(raw);
  const withoutPlaceholders = res.masked
    .replace(new RegExp(`\\b${QUOTED_SPAN_TOKEN}\\b`, 'g'), ' ')
    .replace(/[^A-Za-zÀ-ỹ0-9]+/g, '')
    .trim();
  return {
    stripped: withoutPlaceholders ? res.masked : '',
    quotedSegments: [...res.quotedSpans],
    hadQuotes: res.hadQuotes,
  };
}

export function normalizeAsciiFold(input: string): string {
  return (input || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9_\s.:/?=-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const CONFIRM_VOICE_FOLDED_RE =
  /^(?:yes|yep|yeah|sure|ok|okay|confirm|confirmed|go ahead|do it|approve|yes confirm|yes apply|yes apply it|apply it|dong y|xac nhan|ok luon|duoc|duoc luon|u|vang|da|ap dung|ap dung di|u xac nhan|vang xac nhan|ok xac nhan)$/;

const CANCEL_VOICE_FOLDED_RE =
  /^(?:no|nope|cancel|no cancel|stop|don'?t|don t|dont|do not|do not apply|dont apply|don t apply|never mind|nevermind|abort|stay here|keep working|khong|huy|huy bo|thoi|thoi bo|thoi huy|khoan|khoan da|o lai)$/;

const VI_DIACRITIC_PRESENT_RE =
  /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;

const CONFIRM_LEAD_STRIP_RE =
  /^(?:(?:hi|hey|hello|echo|jarvis|echo jarvis|echo oi|jarvis oi)\s+){1,3}/;

const CONFIRM_TAIL_STRIP_RE =
  /\s+(?:please|now|echo|jarvis|nhe|nha|di|luon)$/g;

/**
 * Matches natural bare confirmation / cancellation utterances ONLY when a confirmation
 * is actively pending (`hasPendingConfirmation === true`).
 * Note: `"không hủy"` is intentionally NOT treated as cancel!
 */
export function matchPendingConfirmationDecision(rawUtterance: string): 'confirm' | 'cancel' | null {
  if (typeof rawUtterance !== 'string' || !rawUtterance.trim()) return null;
  const trimmed = rawUtterance.trim();

  // Diacritic disambiguation: `đúng` ("right/yes") vs `đừng`/`dừng` ("don't/stop")
  if (VI_DIACRITIC_PRESENT_RE.test(trimmed)) {
    const cleanedUnicode = trimmed
      .toLowerCase()
      .replace(/[.!?]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (/^(?:đúng|đúng rồi|ừ đúng|vâng đúng)$/iu.test(cleanedUnicode)) {
      return 'confirm';
    }
    if (/^(?:đừng|đừng làm|thôi đừng|dừng|dừng lại)$/iu.test(cleanedUnicode)) {
      return 'cancel';
    }
  }

  let folded = normalizeAsciiFold(trimmed).replace(/[.!?]+$/g, '').trim();
  folded = folded.replace(CONFIRM_LEAD_STRIP_RE, '').trim();
  if (/\bkhong\s+huy\b/.test(folded)) {
    return null;
  }

  if (CONFIRM_VOICE_FOLDED_RE.test(folded)) return 'confirm';
  if (CANCEL_VOICE_FOLDED_RE.test(folded)) return 'cancel';
  if (!VI_DIACRITIC_PRESENT_RE.test(trimmed) && folded === 'dung') {
    return 'cancel';
  }

  const strippedTail = folded.replace(CONFIRM_TAIL_STRIP_RE, '').trim();
  if (CONFIRM_VOICE_FOLDED_RE.test(strippedTail)) return 'confirm';
  if (CANCEL_VOICE_FOLDED_RE.test(strippedTail)) return 'cancel';
  if (!VI_DIACRITIC_PRESENT_RE.test(trimmed) && strippedTail === 'dung') {
    return 'cancel';
  }

  return null;
}

const PROMPT_INJECTION_RE =
  /\b(ignore (?:all |previous |prior |system )?(?:instructions|rules|guards|prompts)|system override|developer mode|jailbreak|bo qua (?:moi |tat ca )?(?:quy tac|huong dan|lenh))\b/;

const SRS_AUTO_RATE_RE =
  /\b(auto[- ]?rate|rate all (?:my )?(?:cards|flashcards)|mark all (?:cards|flashcards) (?:easy|good)|tu dong cham (?:the|flashcard)|cham tat ca the (?:de|tot)|auto review (?:all )?cards)\b/;

const PAYMENT_MUTATION_RE =
  /\b((?:execute|submit|complete|make|create|place) (?:a )?(?:payment|bank transfer|order|checkout)|charge my card|buy premium automatically|cancel\s+(?:my\s+)?(?:premium\s+)?subscription|(?:grant|give|activate|unlock) (?:me )?(?:free )?premium|free premium|bypass (?:quota|limit|paywall)|thanh toan (?:ngay|tu dong|don hang)|chuyen khoan mua goi|huy\s+(?:goi\s+)?(?:dang\s+ky\s+)?premium|(?:cap|tang|kich hoat) (?:goi )?premium(?: mien phi)?|vuot gioi han luot)\b/;

const SECURITY_ADMIN_MUTATION_RE =
  /\b(change (?:my )?password|reset (?:my )?password to|disable (?:mfa|2fa|two factor)|remove (?:totp|passkey|webauthn)|open admin (?:panel|console)|grant admin|(?:delete|remove|close|wipe) (?:my )?account|log(?:ging)?\s+(?:me\s+)?out|doi mat khau|tat (?:mfa|2fa|xac thuc hai lop)|xoa passkey|xoa (?:vinh vien )?tai khoan|vao trang admin|quyen admin)\b/;

const FOREIGN_USER_DATA_RE =
  /\b((?:read|show|get|open|view|fetch|dump) (?:other|another) (?:user|learner|student|person)(?: s|s)? (?:private |personal |secret )?(?:data|profile|email|messages|sessions|history|score)|xem (?:du lieu|tin nhan|ho so|email|diem) (?:cua )?(?:nguoi dung khac|hoc vien khac|nguoi khac)|doc tin nhan nguoi khac)\b/;

const GRAMMAR_CHECK_SOLVE_RE =
  /\b((?:give|tell|show) me the (?:answer|solution)|solve (?:this|the) (?:question|item|check|test)|which option is correct|dap an (?:cau nay|bai kiem tra)|giai giup cau nay|chon dap an nao)\b/;

const EXTERNAL_UNSUPPORTED_RE =
  /\b(?:(?:open|go to|navigate to|launch|visit|mo|vao|truy cap)\s+(?:https?:\/\/\S+|www\.\S+|[a-z0-9-]+\.(?:com|org|net|io|edu|gov|vn)\b|(?:spotify|discord|telegram|whatsapp|notepad|calculator|finder|explorer|cmd|powershell|terminal)\b)|(?:shut\s*down|restart|reboot)\s+(?:my\s+)?(?:computer|pc|laptop|may tinh)|upload\s+(?:file|folder)\s+from\s+(?:my\s+)?(?:desktop|disk|c:))\b/;

/**
 * Inspects an unquoted learner utterance for hard-denied or sandbox-unsupported requests
 * before any fast-path compilation or execution.
 */
export function detectUtteranceGuard(
  rawUtterance: string,
  ctx: PermissionEvalContext,
): PermissionEvaluation | null {
  const strictActive = ctx.hasActiveStrictSentinel ?? hasActiveStrictSentinelAttempt();
  if (strictActive) {
    return {
      decision: 'DENIED',
      reason: 'strict_sentinel_lockdown',
      prompt: {
        en: 'Echo is paused while a strict-focus contest or exam simulation is active.',
        vi: 'Echo tạm khóa trong suốt phiên thi hoặc lượt đấu chế độ nghiêm ngặt.',
      },
    };
  }

  if (isActiveExamSimulationRoute(ctx.pathname)) {
    return {
      decision: 'DENIED',
      reason: 'active_exam_simulation',
      prompt: {
        en: 'Echo cannot run or assist during an active exam simulation.',
        vi: 'Echo không thể hoạt động hoặc hỗ trợ trong lúc bạn đang làm bài thi thử.',
      },
    };
  }

  const { stripped } = dequoteUntrustedText(rawUtterance);
  const folded = normalizeAsciiFold(stripped);
  if (!folded) return null;

  if (PROMPT_INJECTION_RE.test(folded)) {
    return {
      decision: 'DENIED',
      reason: 'prompt_injection_blocked',
      prompt: {
        en: 'That instruction conflicts with Echo safety boundaries and was blocked.',
        vi: 'Yêu cầu này vi phạm quy tắc an toàn của Echo nên đã bị chặn.',
      },
    };
  }

  // Metalinguistic mentions, hypothetical questions ("If I delete my account, what happens?"),
  // and negated utterances ("Don't delete my account") delegate to Plane B instead of false DENIED!
  const speechAct = analyzeSpeechAct(rawUtterance);
  if (speechAct.suppressesGuard) {
    return null;
  }

  if (isActiveGrammarCheckRoute(ctx.pathname) && GRAMMAR_CHECK_SOLVE_RE.test(folded)) {
    return {
      decision: 'DENIED',
      reason: 'active_grammar_mastery_check',
      prompt: {
        en: 'Echo cannot solve items during an active Grammar Mastery Check. Finish the check first, then we can review every question together.',
        vi: 'Echo không thể giải đáp án trong lúc kiểm tra thành thạo Ngữ pháp. Bạn hoàn thành bài kiểm tra trước rồi mình cùng chữa chi tiết nhé.',
      },
    };
  }

  if (SRS_AUTO_RATE_RE.test(folded)) {
    return {
      decision: 'DENIED',
      reason: 'srs_auto_rate_forbidden',
      prompt: {
        en: 'Flashcard recall ratings belong to your own memory check, so Echo never auto-rates cards.',
        vi: 'Mức độ nhớ thẻ từ vựng cần do chính bạn tự đánh giá nên Echo không tự động chấm thẻ.',
      },
    };
  }

  if (PAYMENT_MUTATION_RE.test(folded)) {
    return {
      decision: 'DENIED',
      reason: 'payment_or_quota_mutation_forbidden',
      prompt: {
        en: 'Echo cannot execute payments or modify quotas. I can open the Premium page so you can review plans directly.',
        vi: 'Echo không thể thực hiện thanh toán hay thay đổi hạn mức. Bạn có thể xem trực tiếp tại trang Gói Premium.',
      },
    };
  }

  if (SECURITY_ADMIN_MUTATION_RE.test(folded)) {
    return {
      decision: 'DENIED',
      reason: 'security_or_admin_mutation_forbidden',
      prompt: {
        en: 'Password, two-factor authentication, and administrator actions must be performed manually by you.',
        vi: 'Đổi mật khẩu, xác thực hai lớp và thao tác quản trị cần được bạn thực hiện trực tiếp.',
      },
    };
  }

  if (FOREIGN_USER_DATA_RE.test(folded)) {
    return {
      decision: 'DENIED',
      reason: 'foreign_user_data_forbidden',
      prompt: {
        en: 'Echo can only access your own learning profile and records.',
        vi: 'Echo chỉ được phép truy cập hồ sơ và dữ liệu học tập của riêng bạn.',
      },
    };
  }

  if (EXTERNAL_UNSUPPORTED_RE.test(folded)) {
    return {
      decision: 'UNSUPPORTED',
      reason: 'outside_platform_sandbox',
      prompt: {
        en: 'Echo can control screens and tools inside English Coach, not external websites or operating system apps.',
        vi: 'Echo chỉ điều khiển các tính năng bên trong English Coach, không mở trang web ngoài hay ứng dụng hệ điều hành.',
      },
    };
  }

  return null;
}

/**
 * Evaluates a candidate `EchoClientIntent` against the 4-tier permission matrix.
 * Deny-by-default: any unknown intent, invalid parameter, or unallowlisted href is rejected.
 */
export function evaluateIntentPermission(
  rawIntent: unknown,
  ctx: PermissionEvalContext,
): PermissionEvaluation {
  const strictActive = ctx.hasActiveStrictSentinel ?? hasActiveStrictSentinelAttempt();
  if (strictActive) {
    return {
      decision: 'DENIED',
      reason: 'strict_sentinel_lockdown',
      prompt: {
        en: 'Echo actions are disabled during an active strict-focus contest or exam simulation.',
        vi: 'Thao tác của Echo bị khóa trong suốt phiên thi hoặc lượt đấu chế độ nghiêm ngặt.',
      },
    };
  }

  if (isActiveExamSimulationRoute(ctx.pathname)) {
    return {
      decision: 'DENIED',
      reason: 'active_exam_simulation',
      prompt: {
        en: 'Echo actions are disabled during an active exam simulation.',
        vi: 'Thao tác của Echo bị khóa trong khi đang làm bài thi thử.',
      },
    };
  }

  const validated = validateEchoClientIntent(rawIntent);
  if (!validated.valid) {
    return {
      decision: validated.tier,
      reason: validated.reason,
      prompt:
        validated.tier === 'UNSUPPORTED'
          ? {
              en: 'That destination or capability is outside English Coach.',
              vi: 'Đích đến hoặc thao tác này nằm ngoài phạm vi của English Coach.',
            }
          : {
              en: 'That action is not permitted.',
              vi: 'Thao tác này không được phép thực hiện.',
            },
    };
  }

  const intent = validated.intent;

  switch (intent.kind) {
    case 'forbidden_attempt':
      return {
        decision: 'DENIED',
        reason: intent.reason,
        intent,
        prompt: {
          en: 'That action is blocked by English Coach integrity and security rules.',
          vi: 'Thao tác này bị chặn theo quy tắc bảo mật và tính minh bạch học tập.',
        },
      };

    case 'unsupported_external':
      return {
        decision: 'UNSUPPORTED',
        reason: 'outside_platform_sandbox',
        intent,
        prompt: {
          en: 'Echo only operates inside English Coach.',
          vi: 'Echo chỉ thực hiện thao tác bên trong English Coach.',
        },
      };

    case 'request_logout':
      if (ctx.confirmedClientAction) {
        return { decision: 'AUTO_EXECUTE', reason: 'confirmed_logout', intent };
      }
      return {
        decision: 'CONFIRM_REQUIRED',
        reason: 'logout_requires_confirmation',
        intent,
        prompt: {
          en: 'Are you sure you want to sign out of English Coach? Say Confirm or Cancel.',
          vi: 'Bạn có chắc muốn đăng xuất khỏi English Coach không? Hãy nói Xác nhận hoặc Hủy.',
        },
      };

    case 'delete_resource':
      if (ctx.confirmedClientAction) {
        return { decision: 'AUTO_EXECUTE', reason: 'confirmed_delete_resource', intent };
      }
      return {
        decision: 'CONFIRM_REQUIRED',
        reason: `delete_${intent.resourceType}_requires_confirmation`,
        intent,
        prompt: {
          en: `Confirm deleting ${intent.label || intent.resourceType.replace(/_/g, ' ')}? Say Confirm or Cancel.`,
          vi: `Xác nhận xóa ${intent.label || 'mục này'}? Hãy nói Xác nhận hoặc Hủy.`,
        },
      };

    case 'plan_or_dna_commit':
      if (ctx.confirmedClientAction) {
        return { decision: 'AUTO_EXECUTE', reason: 'confirmed_plan_or_dna_commit', intent };
      }
      return {
        decision: 'CONFIRM_REQUIRED',
        reason: 'study_plan_or_dna_requires_confirmation',
        intent,
        prompt: {
          en: 'Please confirm before applying changes to your study plan or Learner DNA.',
          vi: 'Vui lòng xác nhận trước khi áp dụng thay đổi cho lộ trình học hoặc Learner DNA.',
        },
      };

    case 'navigate': {
      const currentClean = (ctx.pathname || '').trim();
      const targetPath = intent.href.split('?')[0];
      if (isSameListeningLessonTransition(currentClean, intent.href)) {
        return { decision: 'AUTO_EXECUTE', reason: 'same_listening_workspace_transition', intent };
      }
      const currentFull = currentClean + (ctx.searchParams?.toString?.() ? `?${ctx.searchParams.toString()}` : '');
      if (currentFull === intent.href || (currentClean === targetPath && currentClean === intent.href)) {
        return { decision: 'AUTO_EXECUTE', reason: 'already_on_destination', intent };
      }
      if (
        isEchoWorkRoute(currentClean, ctx.searchParams) &&
        !intent.confirmLeaveWorkRoute &&
        !ctx.confirmedClientAction
      ) {
        const destNameEn = intent.label || intent.href;
        const destNameVi = intent.label || intent.href;
        return {
          decision: 'CONFIRM_REQUIRED',
          reason: 'leaving_active_work_route',
          intent,
          prompt: {
            en: `You have an active practice screen open. Leave this page and open ${destNameEn}?`,
            vi: `Bạn đang ở màn hình luyện tập. Rời trang hiện tại và mở ${destNameVi} nhé?`,
          },
        };
      }
      return { decision: 'AUTO_EXECUTE', reason: 'validated_navigation', intent };
    }

    case 'history_back':
    case 'history_forward': {
      if (
        isEchoWorkRoute(ctx.pathname, ctx.searchParams) &&
        !intent.confirmLeaveWorkRoute &&
        !ctx.confirmedClientAction
      ) {
        return {
          decision: 'CONFIRM_REQUIRED',
          reason: 'leaving_active_work_route',
          intent,
          prompt: {
            en: 'You have an active practice screen open. Confirm leaving this page?',
            vi: 'Bạn đang ở màn hình luyện tập. Xác nhận rời khỏi trang hiện tại nhé?',
          },
        };
      }
      return { decision: 'AUTO_EXECUTE', reason: 'safe_history_navigation', intent };
    }

    case 'voice_confirm': {
      if (!ctx.hasPendingConfirmation) {
        return {
          decision: 'DENIED',
          reason: 'no_pending_confirmation',
          intent,
          prompt: {
            en: 'There is no pending action waiting for confirmation.',
            vi: 'Hiện không có thao tác nào đang chờ xác nhận.',
          },
        };
      }
      return { decision: 'AUTO_EXECUTE', reason: 'pending_confirmation_decision', intent };
    }

    case 'scroll':
    case 'theme_mode':
    case 'ui_font_scale':
    case 'ui_locale':
    case 'nav_layout':
    case 'nav_visibility':
    case 'world_display':
    case 'open_guide':
    case 'open_appearance_studio':
    case 'apply_bg_preset':
    case 'adjust_bg_brightness':
    case 'reset_appearance':
    case 'dictionary_lookup':
    case 'music_control':
    case 'reading_control':
    case 'mybooks_open_last':
    case 'mybooks_reader':
    case 'listening_player':
    case 'speaking_control':
    case 'flashcard_control':
    case 'writing_control':
    case 'undo_last_action':
    case 'voice_control':
      return { decision: 'AUTO_EXECUTE', reason: 'safe_reversible_client_intent', intent };
  }
}
