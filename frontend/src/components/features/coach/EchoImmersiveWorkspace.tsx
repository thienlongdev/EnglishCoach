'use client';

import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import {
  Activity,
  ArrowUp,
  Captions,
  Check,
  Compass,
  Flame,
  LineChart,
  MessageCircle,
  MessageSquare,
  Mic,
  MicOff,
  Orbit,
  Plus,
  Radio,
  Square,
  Undo2,
  X,
} from 'lucide-react';
import { useProficiencyMe } from '@/hooks/useLeaderboard';
import { useUnifiedStreak } from '@/hooks/useUnifiedStreak';
import type { ProficiencySkill } from '@/types/leaderboard';
import { echoVoiceSessionStore } from '@/lib/echo-jarvis/intents';
import { getEchoJarvisRuntime } from '@/lib/echo-jarvis/runtime/echoJarvisRuntime';
import { EchoMessage } from './EchoMessage';
import type { EchoActionData, EchoCardData } from './EchoCards';
import { EchoOrb } from './EchoOrb';
import {
  resolveEchoVoiceRecoveryCopy,
  safeEchoHref,
  sanitizeEchoActionDetail,
  sanitizeEchoStatusCopy,
} from './echo-window';

export interface EchoImmersiveMessage {
  role: 'user' | 'assistant';
  content: string;
  cards?: EchoCardData[];
  actions?: EchoActionData[];
}

export interface EchoImmersiveWorkspaceProps {
  vi: boolean;
  open: boolean;
  onClose: () => void;
  onOpenChat: () => void;
  presence?: string;
  isPremium?: boolean;
  allowance?: { used: number; limit: number } | null;
  messages?: EchoImmersiveMessage[];
  draft?: string;
  loading?: boolean;
  exhausted?: boolean;
  statusText?: string;
  input?: string;
  onInputChange?: (value: string) => void;
  onSubmitText?: (text: string) => void;
  onInterrupt?: () => void;
  onNewChat?: () => void;
  onNavigate?: (href: string) => void;
}

const SKILLS: Array<{ key: string; vi: string; en: string }> = [
  { key: 'LISTENING', vi: 'Nghe', en: 'Listening' },
  { key: 'READING', vi: 'Đọc', en: 'Reading' },
  { key: 'WRITING', vi: 'Viết', en: 'Writing' },
  { key: 'SPEAKING', vi: 'Nói', en: 'Speaking' },
  { key: 'VOCABULARY', vi: 'Từ vựng', en: 'Vocabulary' },
];

const measured = (s: { status: string; cefr: string | null } | undefined) =>
  Boolean(s && s.cefr && (s.status === 'VERIFIED' || s.status === 'PROVISIONAL' || s.status === 'STALE'));

/**
 * Mode 3 — Deliberately triggered Holographic JARVIS Immersive Command Sanctuary.
 *
 * Features:
 * - Large `236 px` Living 3D Entity (`slot="immersive"`, highest GPU priority `50`, `dpr <= 1.5` cap on iGPU)
 *   framed by concentric holographic precision vernier arcs (static under `prefers-reduced-motion`).
 * - Real Learning DNA Telemetry Ring driven strictly by `/api/v1/proficiency/me` + unified streak +
 *   real daily allowance (unmeasured skills show `?`, zero fabricated scores).
 * - Live Action Telemetry Timeline (`snap.recentActions`) with 1-tap `Undo` and inline Confirm/Cancel.
 * - Full Voice + Text dual-mode command stream synced with the active conversation.
 * - Strictly compositor-only glass surfaces (no blur filters), responsive vertical stack below `960 px`.
 */
export function EchoImmersiveWorkspace({
  vi,
  open,
  onClose,
  onOpenChat,
  presence = 'idle',
  isPremium = false,
  allowance = null,
  messages = [],
  draft = '',
  loading = false,
  exhausted = false,
  statusText = '',
  input,
  onInputChange,
  onSubmitText,
  onInterrupt,
  onNewChat,
  onNavigate,
}: EchoImmersiveWorkspaceProps) {
  const router = useRouter();
  const snap = useSyncExternalStore(
    echoVoiceSessionStore.subscribe,
    echoVoiceSessionStore.getSnapshot,
    echoVoiceSessionStore.getServerSnapshot,
  );
  const { data: proficiency, isLoading: profLoading } = useProficiencyMe();
  const { streak } = useUnifiedStreak();

  const [localInput, setLocalInput] = useState('');
  const streamRef = useRef<HTMLDivElement>(null);
  const confirmBannerIdRef = useRef(`echo-imm-confirm-${Math.random().toString(36).slice(2, 8)}`);
  const effectiveInput = input !== undefined ? input : localInput;

  const setInputValue = (val: string) => {
    if (onInputChange) onInputChange(val);
    else setLocalInput(val);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const pane = streamRef.current;
    if (pane) pane.scrollTo({ top: pane.scrollHeight, behavior: 'auto' });
  }, [open, messages.length, draft, snap.liveCaption.echoSpoken]);

  if (!open || snap.strictSentinelLocked) return null;

  const voiceActive =
    snap.entityState !== 'disabled' &&
    snap.entityState !== 'dormant' &&
    snap.entityState !== 'sleeping';
  const entityState = voiceActive ? snap.entityState : presence;
  const isBusy =
    loading ||
    snap.entityState === 'speaking' ||
    snap.entityState === 'thinking' ||
    snap.entityState === 'understanding' ||
    snap.entityState === 'executing';

  const skillsMap = new Map<string, ProficiencySkill>(
    (proficiency?.skills ?? []).map((s) => [s.skill, s]),
  );
  const overall = proficiency?.overall;
  const overallMeasured =
    overall && measured({ status: String(overall.status), cefr: overall.currentCefr });
  const weakest = SKILLS.map((k) => ({ k, s: skillsMap.get(k.key) }))
    .filter((x) => measured(x.s) && typeof x.s?.rating === 'number')
    .sort((a, b) => (a.s!.rating as number) - (b.s!.rating as number))[0];

  const handleNavigate = (href: string) => {
    const safe = safeEchoHref(href);
    if (!safe) return;
    if (onNavigate) onNavigate(safe);
    else {
      onClose();
      router.push(safe);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = effectiveInput.trim();
    if (!clean || exhausted) return;
    setInputValue('');
    if (onSubmitText) {
      onSubmitText(clean);
    } else {
      void getEchoJarvisRuntime().submitTextTurn(clean);
    }
  };

  const handleQuickPrompt = (prompt: string) => {
    if (onSubmitText) {
      onSubmitText(prompt);
    } else {
      void getEchoJarvisRuntime().submitTextTurn(prompt);
    }
  };

  const handlePrimaryVoice = () => {
    const rt = getEchoJarvisRuntime();
    if (isBusy) {
      rt.interruptCurrentTurn();
      onInterrupt?.();
      return;
    }
    if (snap.entityState === 'listening' || snap.entityState === 'awakening') {
      rt.enterSleep();
      return;
    }
    void rt.startActiveVoiceTurn();
  };

  const R = 74;
  const visibleMessages = messages.length > 1 ? messages.slice(1) : [];
  const safeStatusText = sanitizeEchoStatusCopy(statusText, vi);
  const storeLastError = (snap as { lastError?: { title?: string; subtitle?: string; canRetry?: boolean } | null }).lastError ?? null;
  const workspaceError =
    !snap.pendingConfirmation && (snap.entityState === 'error' || Boolean(storeLastError))
      ? resolveEchoVoiceRecoveryCopy(storeLastError?.title ?? snap.activeToast?.title, storeLastError?.subtitle ?? snap.activeToast?.subtitle, vi, exhausted)
      : null;

  return (
    <div className="echo-imm-overlay" data-testid="echo-immersive-workspace">
      <div className="echo-imm-scrim" aria-hidden="true" onClick={onClose} />
      <section
        className="echo-imm-shell"
        role="dialog"
        aria-modal="true"
        aria-label={vi ? 'Không gian Echo' : 'Echo Workspace'}
      >
        <header className="echo-imm-topbar">
          <div className="echo-imm-brand">
            <span className="echo-imm-signal" data-live={snap.wsConnected ? '' : undefined} aria-hidden="true" />
            <h2>{vi ? 'Không gian Echo' : 'Echo Workspace'}</h2>
            {safeStatusText && <span className="echo-imm-status">{safeStatusText}</span>}
          </div>

          <div className="echo-imm-mode-bar" role="group" aria-label={vi ? 'Chế độ hiển thị' : 'Presentation mode'}>
            <button type="button" onClick={onClose}>
              {vi ? 'Thu gọn nổi' : 'Ambient'}
            </button>
            <button type="button" onClick={onOpenChat}>
              <MessageSquare size={13} aria-hidden="true" />
              <span>{vi ? 'Khung chat' : 'Chat'}</span>
            </button>
            <button type="button" aria-pressed="true" className="echo-imm-mode-active">
              <Radio size={13} aria-hidden="true" />
              <span>{vi ? 'Không gian' : 'Workspace'}</span>
            </button>
          </div>

          <div className="echo-imm-top-actions">
            {onNewChat && (
              <button
                type="button"
                className="echo-imm-icon-btn"
                aria-label={vi ? 'Hội thoại mới' : 'New conversation'}
                title={vi ? 'Hội thoại mới' : 'New conversation'}
                onClick={onNewChat}
              >
                <Plus size={16} />
              </button>
            )}
            <button
              type="button"
              className="echo-imm-icon-btn"
              aria-label={vi ? 'Đóng không gian Echo' : 'Close Echo Workspace'}
              onClick={onClose}
            >
              <X size={17} />
            </button>
          </div>
        </header>

        <div className="echo-imm-grid">
          {/* Left Holographic Core + Real Learning DNA Telemetry */}
          <aside className="echo-imm-core-col" aria-label={vi ? 'Lõi tương tác và hồ sơ học tập' : 'Living Core and learning telemetry'}>
            <div className="echo-imm-stage" data-entity-state={entityState}>
              <svg className="echo-imm-gimbal-svg" viewBox="0 0 280 280" aria-hidden="true">
                <circle className="echo-imm-gimbal-outer" cx="140" cy="140" r="130" />
                <circle className="echo-imm-gimbal-inner" cx="140" cy="140" r="114" />
              </svg>
              <EchoOrb slot="immersive" size={192} state={entityState} />
            </div>

            <div className="echo-imm-voice-deck">
              <button
                type="button"
                className="echo-imm-voice-primary"
                data-active={voiceActive ? '' : undefined}
                disabled={exhausted}
                onClick={handlePrimaryVoice}
              >
                {isBusy ? <Square size={15} /> : <Mic size={16} />}
                <span>
                  {isBusy
                    ? vi ? 'Dừng' : 'Stop'
                    : snap.entityState === 'listening'
                      ? vi ? 'Tạm nghỉ' : 'Pause'
                      : vi ? 'Nói với Echo' : 'Speak'}
                </span>
              </button>

              <button
                type="button"
                className="echo-imm-voice-chip"
                aria-pressed={snap.handsFreeEnabled}
                onClick={() => {
                  const next = !snap.handsFreeEnabled;
                  if (!next) {
                    echoVoiceSessionStore.clearActiveToast();
                    echoVoiceSessionStore.clearPendingConfirmation();
                    echoVoiceSessionStore.clearLiveCaption();
                    (echoVoiceSessionStore as typeof echoVoiceSessionStore & { clearVoiceError?: () => void }).clearVoiceError?.();
                  }
                  void getEchoJarvisRuntime().setHandsFreeEnabled(next, {
                    userInitiated: true,
                  });
                }}
              >
                <Radio size={13} aria-hidden="true" />
                <span>Hi, Echo</span>
              </button>

              <button
                type="button"
                className="echo-imm-voice-chip"
                aria-pressed={snap.captionsEnabled}
                aria-label={vi ? 'Bật hoặc tắt phụ đề' : 'Toggle captions'}
                onClick={() => echoVoiceSessionStore.setCaptionsEnabled(!snap.captionsEnabled)}
              >
                <Captions size={13} aria-hidden="true" />
                <span>CC</span>
              </button>

              <button
                type="button"
                className="echo-imm-voice-chip"
                aria-pressed={snap.muted}
                aria-label={snap.muted ? (vi ? 'Bật micro' : 'Unmute') : (vi ? 'Tắt tiếng' : 'Mute')}
                onClick={() => getEchoJarvisRuntime().setMuted(!snap.muted)}
              >
                {snap.muted ? <MicOff size={13} /> : <Mic size={13} />}
              </button>
            </div>

            {/* Real Learning DNA Ring from /api/v1/proficiency/me */}
            <section className="echo-imm-card">
              <div className="echo-imm-card-head">
                <h3>{vi ? 'Bản đồ năng lực' : 'Learning DNA'}</h3>
                <span>{overallMeasured ? overall!.currentCefr : '?'}</span>
              </div>
              {profLoading && !proficiency ? (
                <p className="echo-imm-muted">{vi ? 'Đang tải hồ sơ năng lực…' : 'Loading proficiency…'}</p>
              ) : (
                <svg
                  className="echo-constellation"
                  viewBox="-110 -110 220 220"
                  role="img"
                  aria-label={vi ? 'Biểu đồ năng lực 5 kỹ năng' : 'Five-skill proficiency ring'}
                >
                  <circle className="echo-ring-path" r={R} />
                  {SKILLS.map((k, i) => {
                    const a = ((-90 + i * 72) * Math.PI) / 180;
                    const x = Math.cos(a) * R;
                    const y = Math.sin(a) * R;
                    const s = skillsMap.get(k.key);
                    const known = measured(s);
                    const conf = Math.max(0, Math.min(1, s?.confidence ?? 0));
                    return (
                      <g key={k.key} className="echo-star" data-known={known ? '' : undefined}>
                        <line x1={0} y1={0} x2={x} y2={y} style={{ opacity: known ? 0.25 + conf * 0.6 : 0.15 }} />
                        <circle cx={x} cy={y} r={known ? 11 + conf * 4 : 11} style={{ opacity: known ? 0.65 + conf * 0.35 : 1 }} />
                        <text className="echo-star-level" x={x} y={y} dy="3.2" textAnchor="middle">
                          {known ? s!.cefr : '?'}
                        </text>
                        <text x={x} y={y + (y >= 0 ? 26 : -18)} textAnchor="middle">
                          {vi ? k.vi : k.en}
                        </text>
                      </g>
                    );
                  })}
                  <circle className="echo-core" r={21} />
                  <text className="echo-core-level" textAnchor="middle" dy="5">
                    {overallMeasured ? overall!.currentCefr : '?'}
                  </text>
                </svg>
              )}

              <div className="echo-imm-metrics">
                <div>
                  <Flame size={14} aria-hidden="true" />
                  <span>{vi ? 'Chuỗi ngày' : 'Streak'}</span>
                  <strong>
                    {streak
                      ? `${streak.currentStreakDays} ${vi ? 'ngày' : streak.currentStreakDays === 1 ? 'day' : 'days'}`
                      : '—'}
                  </strong>
                </div>
                <div>
                  <MessageCircle size={14} aria-hidden="true" />
                  <span>{vi ? (isPremium ? 'Lượt Premium' : 'Lượt hôm nay') : isPremium ? 'Premium today' : 'Today'}</span>
                  <strong>{allowance ? `${Math.min(allowance.used, allowance.limit)}/${allowance.limit}` : '—'}</strong>
                </div>
              </div>

              {weakest && (
                <button
                  type="button"
                  className="echo-rail-ask"
                  onClick={() =>
                    handleQuickPrompt(
                      vi
                        ? `Kỹ năng ${weakest.k.vi} của mình đang ở mức ${weakest.s!.cefr}. Gợi ý bài luyện phù hợp giúp mình nhé.`
                        : `My ${weakest.k.en} is at ${weakest.s!.cefr}. Recommend a focused practice next.`,
                    )
                  }
                >
                  {vi ? `Luyện ${weakest.k.vi} ngay` : `Focus on ${weakest.k.en}`}
                </button>
              )}
            </section>

            <nav className="echo-imm-shortcuts" aria-label={vi ? 'Lối tắt nhanh' : 'Quick navigation'}>
              <button type="button" onClick={() => handleNavigate('/learning-path?view=list')}>
                <Compass size={14} aria-hidden="true" />
                <span>{vi ? 'Lộ trình' : 'Path'}</span>
              </button>
              <button type="button" onClick={() => handleNavigate('/progress')}>
                <LineChart size={14} aria-hidden="true" />
                <span>{vi ? 'Tiến độ' : 'Progress'}</span>
              </button>
              <button type="button" onClick={() => handleNavigate('/knowledge-universe')}>
                <Orbit size={14} aria-hidden="true" />
                <span>{vi ? 'Vũ trụ' : 'Cosmos'}</span>
              </button>
            </nav>
          </aside>

          {/* Right Stream: Action Telemetry + Conversation + Dual Command Composer */}
          <div className="echo-imm-stream-col">
            {(snap.recentActions.length > 0 || snap.canUndoLastAction) && (
              <div className="echo-imm-timeline" aria-label={vi ? 'Nhật ký thao tác gần đây' : 'Recent actions'}>
                <span className="echo-imm-timeline-label">
                  <Activity size={13} aria-hidden="true" />
                  <span>{vi ? 'Thao tác' : 'Actions'}</span>
                </span>
                <div className="echo-imm-timeline-pills">
                  {snap.recentActions.slice(0, 3).map((act) => (
                    <span key={act.id} className="echo-imm-act-pill" data-status={act.status}>
                      {sanitizeEchoActionDetail(act.detail, act.status, vi)}
                    </span>
                  ))}
                </div>
                {snap.canUndoLastAction && (
                  <button
                    type="button"
                    className="echo-imm-undo-btn"
                    onClick={() => void getEchoJarvisRuntime().undoLastUiAction()}
                  >
                    <Undo2 size={12} aria-hidden="true" />
                    <span>{vi ? 'Hoàn tác' : 'Undo'}</span>
                  </button>
                )}
              </div>
            )}

            {workspaceError && (
              <div className="echo-imm-confirm-banner" role="status">
                <span>{workspaceError.title}</span>
                <div className="echo-imm-confirm-btns">
                  {workspaceError.retryable && (storeLastError?.canRetry !== false) && (
                    <button
                      type="button"
                      className="echo-toast-btn-retry"
                      onClick={() => {
                        const rt = getEchoJarvisRuntime() as ReturnType<typeof getEchoJarvisRuntime> & {
                          retryLastVoiceTurn?: () => Promise<boolean>;
                          dismissError?: () => void;
                        };
                        rt.dismissError?.();
                        (echoVoiceSessionStore as typeof echoVoiceSessionStore & { clearVoiceError?: () => void }).clearVoiceError?.();
                        echoVoiceSessionStore.clearActiveToast();
                        if (typeof rt.retryLastVoiceTurn === 'function') void rt.retryLastVoiceTurn();
                        else void rt.startActiveVoiceTurn();
                      }}
                    >
                      <span>{vi ? 'Thử lại' : 'Retry'}</span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="echo-toast-btn-secondary"
                    onClick={() => {
                      const rt = getEchoJarvisRuntime() as ReturnType<typeof getEchoJarvisRuntime> & {
                        dismissError?: () => void;
                      };
                      rt.dismissError?.();
                      (echoVoiceSessionStore as typeof echoVoiceSessionStore & { clearVoiceError?: () => void }).clearVoiceError?.();
                      echoVoiceSessionStore.clearActiveToast();
                      if (snap.entityState === 'error') {
                        echoVoiceSessionStore.setEntityState(snap.handsFreeEnabled ? 'dormant' : 'disabled');
                      }
                    }}
                  >
                    {vi ? 'Đóng' : 'Dismiss'}
                  </button>
                </div>
              </div>
            )}

            {snap.pendingConfirmation && (
              <div
                className="echo-imm-confirm-banner"
                role="region"
                aria-labelledby={confirmBannerIdRef.current}
              >
                <span id={confirmBannerIdRef.current}>
                  {vi ? snap.pendingConfirmation.summaryVi : snap.pendingConfirmation.summaryEn}
                </span>
                <div className="echo-imm-confirm-btns">
                  <button
                    type="button"
                    className="echo-toast-btn-primary"
                    onClick={() => void getEchoJarvisRuntime().confirmPendingAction()}
                  >
                    <Check size={13} aria-hidden="true" />
                    <span>{vi ? 'Xác nhận' : 'Confirm'}</span>
                  </button>
                  <button
                    type="button"
                    className="echo-toast-btn-secondary"
                    onClick={() => void getEchoJarvisRuntime().cancelPendingAction()}
                  >
                    <span>{vi ? 'Hủy' : 'Cancel'}</span>
                  </button>
                </div>
              </div>
            )}

            <div ref={streamRef} className="echo-imm-log" role="log" aria-live="polite">
              {visibleMessages.length === 0 && !draft && !snap.liveCaption.echoSpoken ? (
                <div className="echo-imm-empty">
                  <h3>{vi ? 'Sẵn sàng đồng hành cùng bạn' : 'Ready for your next command'}</h3>
                  <p>
                    {vi
                      ? 'Nói hoặc nhập câu hỏi, mở bài đọc, kiểm tra tiến độ, tạo thẻ từ vựng hay luyện nói.'
                      : 'Speak or type to open passages, review progress, prepare flashcards, or start speaking practice.'}
                  </p>
                  <div className="echo-imm-starters">
                    <button
                      type="button"
                      onClick={() =>
                        handleQuickPrompt(
                          vi
                            ? 'Xem lại tiến độ học gần đây và gợi ý bài luyện tiếp theo'
                            : 'Review my recent learning progress and recommend my next practice',
                        )
                      }
                    >
                      {vi ? 'Xem tiến độ và gợi ý bài tiếp theo' : 'Review progress and next practice'}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        handleQuickPrompt(
                          vi
                            ? 'Tìm bài đọc phù hợp với trình độ của mình'
                            : 'Find a reading passage matched to my level',
                        )
                      }
                    >
                      {vi ? 'Tìm bài đọc phù hợp trình độ' : 'Find a level-matched reading'}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        handleQuickPrompt(
                          vi
                            ? 'Mở phần Luyện nói và chuẩn bị một tình huống phù hợp'
                            : 'Open Speaking and prepare a suitable practice scenario',
                        )
                      }
                    >
                      {vi ? 'Chuẩn bị tình huống luyện nói' : 'Prepare a speaking scenario'}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {visibleMessages.map((msg, idx) => (
                    <EchoMessage key={idx} {...msg} />
                  ))}
                  {draft && (
                    <div className="echo-message echo-message-assistant echo-message-live" aria-live="off">
                      <div className="echo-text">{draft}</div>
                    </div>
                  )}
                  {!draft && snap.captionsEnabled && (snap.liveCaption.userPartial || snap.liveCaption.echoSpoken) && (
                    <div className="echo-imm-live-line">
                      {snap.liveCaption.echoSpoken || snap.liveCaption.userPartial}
                    </div>
                  )}
                </>
              )}
            </div>

            <form className="echo-imm-composer" onSubmit={handleSubmit}>
              <input
                type="text"
                value={effectiveInput}
                maxLength={4000}
                disabled={exhausted}
                aria-label={vi ? 'Nhập lệnh hoặc câu hỏi cho Echo' : 'Type a command or question for Echo'}
                placeholder={
                  vi
                    ? 'Nhập lệnh hoặc câu hỏi tiếng Anh…'
                    : 'Type a command or ask Echo anything…'
                }
                onChange={(e) => setInputValue(e.target.value)}
              />
              {isBusy ? (
                <button
                  type="button"
                  className="echo-imm-send-btn"
                  aria-label={vi ? 'Dừng' : 'Stop'}
                  onClick={() => {
                    getEchoJarvisRuntime().interruptCurrentTurn();
                    onInterrupt?.();
                  }}
                >
                  <Square size={15} />
                </button>
              ) : (
                <button
                  type="submit"
                  className="echo-imm-send-btn"
                  disabled={!effectiveInput.trim() || exhausted}
                  aria-label={vi ? 'Gửi' : 'Send'}
                >
                  <ArrowUp size={16} />
                </button>
              )}
            </form>
          </div>
        </div>
      </section>
    </div>
  );
}
