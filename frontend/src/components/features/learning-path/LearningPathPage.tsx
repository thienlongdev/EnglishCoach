'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  ArrowRight, BookOpen, BookOpenText, CalendarDays, Check, ChartNoAxesColumn, ClipboardCheck, Clock3, Dna, Flame, Gauge,
  Headphones, Layers, Loader2, MessageCircle, MountainSnow, PencilLine, PenLine, Play, Route, Sprout, Target, Timer, TrendingUp,
  type LucideIcon,
} from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { useLearningPathToday } from '@/hooks/useLearningPath';
import { useUnifiedStreak } from '@/hooks/useUnifiedStreak';
import { learningPathApi } from '@/services/learningPathApi';
import { placementQuizStore } from '@/lib/leaderboard/placementQuizStore';
import { pointerLight } from '@/lib/ui/pointerLight';
import {
  GOALS, MINUTES, TARGETS, dnaChangeLabel, dnaFactLabel, goalLabel, levelLabel, needsTarget, primaryAction, reasonLabel,
  requirementLabel, skillLabel, STAGES, taskHref, taskProgress, taskSubtitle, taskTitle, type Locale,
} from '@/lib/learning-path/model';
import type { DailyMinutes, DnaProposal, GoalInput, LearningGoal, LearningPlanView, LearningTask, StageView, TodayView } from '@/types/learningPath';
import { AscentScene, JourneyBackdrop } from './AscentScene';
import { GoalEnergyRing, type RingState } from './GoalEnergyRing';
import s from './learningPath.module.css';
import MilestoneEffect from '@/components/vfx/MilestoneEffect';

/*
 * Lộ trình học — "Echo Glass · Ascension" (owner brief 2026-10-20). Presentation only: every value comes from
 * POST /learning-path/today (plan, today's tasks, stage + its next requirements, DNA focus) or the shared streak hook the
 * top bar already reads; every action is the one the page had (task links, placement quiz, goal form, Learner DNA dialog).
 * The goal ring shows the goal the learner SET — never progress toward it.
 */

function errorCode(err: unknown): string | null {
  const data = (err as { response?: { data?: { code?: unknown } } })?.response?.data;
  return typeof data?.code === 'string' ? data.code : null;
}

/**
 * Pauses the CSS animations of a section while it is off screen (`data-paused`, no React state, no re-render). A callback
 * ref, so a section that mounts later (after the loading view) is observed too.
 */
function usePauseOffscreen<T extends HTMLElement>() {
  const io = useRef<IntersectionObserver | null>(null);
  useEffect(() => () => io.current?.disconnect(), []);
  return useCallback((el: T | null) => {
    io.current?.disconnect();
    io.current = null;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    io.current = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) delete el.dataset.paused;
      else el.dataset.paused = '';
    });
    io.current.observe(el);
  }, []);
}

/** What the ring's centre says about a goal: label over value ("IELTS" / "7.5"), or the goal's name when it has no target. */
function ringFace(plan: Pick<LearningPlanView, 'goal' | 'target'>, locale: Locale) {
  const vi = locale === 'vi';
  if (plan.target && (plan.goal === 'IELTS' || plan.goal === 'TOEIC')) return { label: plan.goal, value: plan.target, long: false };
  const name = plan.goal === 'COMMUNICATION' ? (vi ? 'Giao tiếp' : 'Communication') : (vi ? 'Tổng quát' : 'General');
  return { label: vi ? 'Tiếng Anh' : 'English', value: name, long: true };
}

function formatDay(day: string | null, locale: Locale): string | null {
  const m = day ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(day) : null;
  if (!m) return null;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const text = new Intl.DateTimeFormat(locale === 'vi' ? 'vi-VN' : 'en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(date);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function LearningPathPage() {
  const { locale: rawLocale } = useLanguage();
  const locale: Locale = rawLocale === 'en' ? 'en' : 'vi';
  const vi = locale === 'vi';
  const { data, error, isLoading, mutate } = useLearningPathToday();
  const { streak } = useUnifiedStreak();
  const [editing, setEditing] = useState(false);
  const [dnaOpen, setDnaOpen] = useState(false);
  // a goal change or an applied Learner DNA update never changes today's tasks: it plans the next days
  const [laterNotice, setLaterNotice] = useState(false);
  const heroRef = usePauseOffscreen<HTMLElement>();

  // the placement quiz is one app-wide modal: when it closes, re-check today's tasks once
  const quiz = useSyncExternalStore(placementQuizStore.subscribe, placementQuizStore.getSnapshot, placementQuizStore.getSnapshot);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !quiz.open) void mutate();
    wasOpen.current = quiz.open;
  }, [quiz.open, mutate]);

  if (isLoading && !data) return <LoadingView locale={locale} />;

  if (error && !data) {
    return (
      <Shell>
        <div className={`${s.panel} ${s.errorPanel}`} role="alert">
          <span className={s.errorMark} aria-hidden="true"><Route className="h-6 w-6" /></span>
          <p className={s.errorTitle}>{vi ? 'Chưa tải được lộ trình.' : 'Could not load your path.'}</p>
          <button type="button" className={s.btnGhost} onClick={() => void mutate()}>{vi ? 'Thử lại' : 'Try again'}</button>
        </div>
      </Shell>
    );
  }

  if (!data?.plan) {
    return (
      <Shell>
        <section ref={heroRef} className={`${s.hero} ${s.pauseScope}`} data-onboarding="">
          <AscentScene destination={null} destinationCaption="" />
          <div className={s.heroGrid}>
            <GoalEnergyRing
              label={vi ? 'Lộ trình' : 'Your path'}
              value={vi ? 'Chưa đặt' : 'Not set'}
              caption={vi ? 'Mục tiêu của bạn' : 'Your goal'}
              state="empty"
              surgeKey="none"
              long
            />
            <div className={s.heroCard}>
              <GoalForm
                locale={locale}
                title={vi ? 'Tạo lộ trình của bạn' : 'Create your path'}
                submitLabel={vi ? 'Tạo lộ trình' : 'Create path'}
                onSaved={(view) => mutate(view, { revalidate: false })}
              />
            </div>
          </div>
        </section>
      </Shell>
    );
  }

  const plan = data.plan;
  const action = primaryAction(data.tasks, locale);
  const face = ringFace(plan, locale);
  const goalKey = `${plan.goal}:${plan.target ?? ''}`;
  const streakDays = streak?.currentStreakDays;

  return (
    <Shell>
      <MilestoneEffect kind="stage" value={data.stage?.current} identity={goalKey} />
      <section ref={heroRef} className={`${s.hero} ${s.pauseScope}`} aria-labelledby="lp-title">
        <AscentScene destination={goalLabel(plan.goal, plan.target, locale)} destinationCaption={vi ? 'Đích đến của bạn' : 'Your destination'} />
        <div className={s.heroGrid}>
          <header className={s.heroIntro}>
            <h1 id="lp-title" className={s.heroTitle}>{vi ? 'Lộ trình học của bạn' : 'Your learning path'}</h1>
            <p className={s.heroLead}>
              {vi ? 'Mỗi ngày vài nhiệm vụ thật, từng bước đến mục tiêu của bạn.' : 'A few real tasks a day, step by step toward your goal.'}
            </p>
          </header>

          <GoalEnergyRing
            label={face.label}
            value={face.value}
            long={face.long}
            caption={vi ? 'Mục tiêu của bạn' : 'Your goal'}
            state={editing ? 'editing' : 'ready'}
            surgeKey={goalKey}
          />

          <div className={s.heroCard} {...pointerLight}>
            <div className={s.goalHead}>
              <span className={s.goalIcon} aria-hidden="true"><Target className="h-5 w-5" /></span>
              <div className={s.goalHeadText}>
                <h2 className={s.goalTitle}>{vi ? 'Mục tiêu' : 'Goal'}: {goalLabel(plan.goal, plan.target, locale)}</h2>
                <p className={s.goalLevel}>{levelLabel(plan.level, plan.levelBasis, locale)}</p>
              </div>
              <button type="button" className={s.btnEdit} data-guide="lp-goal-edit" onClick={() => setEditing(true)} aria-haspopup="dialog">
                <PencilLine className="h-4 w-4" aria-hidden="true" />
                <span>{vi ? 'Đổi mục tiêu' : 'Change goal'}</span>
              </button>
            </div>

            <div className={s.stats}>
              <Stat icon={Clock3} tone="sky" label={vi ? 'Thời gian mỗi ngày' : 'Time per day'} value={`${plan.dailyMinutes} ${vi ? 'phút' : 'min'}`} />
              <Stat icon={ChartNoAxesColumn} tone="indigo" label={vi ? 'Trình độ hiện tại' : 'Current level'}
                value={plan.levelBasis === 'PROVISIONAL' ? (vi ? 'Chưa xác định' : 'Not known yet') : plan.level} />
              <Stat icon={Flame} tone="amber" label={vi ? 'Chuỗi ngày học' : 'Learning streak'}
                value={streakDays === undefined ? '—' : `${streakDays} ${vi ? 'ngày' : streakDays === 1 ? 'day' : 'days'}`} />
              <Stat icon={Timer} tone="violet" label={vi ? 'Bài hôm nay' : "Today's tasks"}
                value={data.total > 0 ? `${data.minutes} ${vi ? 'phút' : 'min'}` : '—'} />
            </div>

            {action && (
              <div className={s.heroAction}>
                <PrimaryButton task={action.task as LearningTask} label={action.label} locale={locale} />
                <span className={s.heroNext}>
                  <span className={s.heroNextLabel}>{vi ? 'Tiếp theo' : 'Up next'}</span>
                  <span className={s.heroNextTitle}>{taskTitle(action.task, locale)}</span>
                </span>
              </div>
            )}
            {laterNotice && (
              <p className={s.notice} role="status">
                <CalendarDays className="h-4 w-4 shrink-0" aria-hidden="true" />
                {vi ? 'Áp dụng từ ngày mai. Bài hôm nay giữ nguyên.' : 'Applies from tomorrow. Today stays the same.'}
              </p>
            )}
          </div>
        </div>
      </section>

      {data.stage && <StageTrack current={data.stage.current} next={data.stage.next} locale={locale} />}

      <div className={s.lower}>
        <TodayPanel data={data} locale={locale} />
        <div className={s.side}>
          {data.stage && <NextStagePanel stage={data.stage} locale={locale} />}
          <DnaPanel plan={plan} locale={locale} onOpen={() => setDnaOpen(true)} />
        </div>
      </div>

      {editing && (
        <GlassDialog labelledBy="lp-goal-title" canDismiss onDismiss={() => setEditing(false)}>
          <GoalForm
            locale={locale}
            headingId="lp-goal-title"
            title={vi ? 'Đổi mục tiêu' : 'Change goal'}
            submitLabel={vi ? 'Lưu' : 'Save'}
            initial={{ goal: plan.goal, dailyMinutes: plan.dailyMinutes, target: plan.target }}
            onCancel={() => setEditing(false)}
            onSaved={(view) => { setEditing(false); setLaterNotice(true); void mutate(view, { revalidate: false }); }}
          />
        </GlassDialog>
      )}

      {dnaOpen && <DnaDialog locale={locale} onClose={() => setDnaOpen(false)} onApplied={(view) => { setDnaOpen(false); setLaterNotice(true); void mutate(view, { revalidate: false }); }} />}
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return <div className={s.page}>{children}</div>;
}

/** Same composition as the page, no values: nothing jumps when the plan arrives, nothing pretends to be data. */
function LoadingView({ locale }: { locale: Locale }) {
  const vi = locale === 'vi';
  return (
    <Shell>
      <section className={s.hero} aria-busy="true">
        <AscentScene destination={null} destinationCaption="" />
        <div className={s.heroGrid}>
          <div className={s.heroIntro}>
            <span className={`${s.skel} ${s.skelTitle}`} />
            <span className={`${s.skel} ${s.skelLine}`} />
          </div>
          <GoalEnergyRing label={null} value="" caption={vi ? 'Đang tải' : 'Loading'} state="loading" surgeKey="loading" />
          <div className={s.heroCard}>
            <span className={`${s.skel} ${s.skelLine}`} />
            <div className={s.stats}>{[0, 1, 2, 3].map((i) => <span key={i} className={`${s.skel} ${s.skelStat}`} />)}</div>
          </div>
        </div>
        <span className="sr-only" role="status">{vi ? 'Đang tải lộ trình…' : 'Loading your path…'}</span>
      </section>
      <div className={`${s.panel} ${s.skelPanel}`} />
    </Shell>
  );
}

function Stat({ icon: Icon, tone, label, value }: { icon: LucideIcon; tone: string; label: string; value: string }) {
  return (
    <div className={s.stat} data-tone={tone}>
      <span className={s.statIcon} aria-hidden="true"><Icon className="h-5 w-5" /></span>
      <span className={s.statText}>
        <span className={s.statLabel}>{label}</span>
        <span className={s.statValue}>{value}</span>
      </span>
    </div>
  );
}

function PrimaryButton({ task, label, locale }: { task: LearningTask; label: string; locale: Locale }) {
  const href = taskHref(task);
  const inner = (
    <>
      <span className={s.ctaOrb} aria-hidden="true"><Play className="h-4 w-4" fill="currentColor" /></span>
      {label}
      <ArrowRight className={`h-4 w-4 ${s.ctaArrow}`} aria-hidden="true" />
    </>
  );
  if (task.kind === 'PLACEMENT') {
    return <button type="button" className={s.cta} onClick={() => placementQuizStore.open(locale)}>{inner}</button>;
  }
  if (!href) return null;
  return <Link href={href} prefetch={false} className={s.cta}>{inner}</Link>;
}

// ─── Journey: the four real stages (learning-path positions, never certified levels) ───────────────────────────────────

const STAGE_ICONS: LucideIcon[] = [Sprout, ChartNoAxesColumn, BookOpen, MountainSnow];
const STAGE_NOTES: Record<Locale, readonly string[]> = {
  vi: ['Làm quen, luyện nhiều kỹ năng, xác định trình độ', 'Luyện đều để kỹ năng trọng tâm vững dần', 'Kỹ năng trọng tâm vững hơn, luyện sâu hơn', 'Luyện sát mục tiêu, xác nhận bằng bài đánh giá'],
  en: ['Get started, practise several skills, find your level', 'Regular practice builds your core skills', 'Stronger core skills, deeper practice', 'Practise close to your goal, confirm with an assessment'],
};
// Track geometry (viewBox 1000 × 150): node centres at the four column centres; the line climbs left to right.
const NODE_Y = [96, 58, 84, 46];
const NODE_X = [125, 375, 625, 875];
const SEGMENTS = [
  `M0 116 C55 116 80 ${NODE_Y[0]} ${NODE_X[0]} ${NODE_Y[0]}`,
  ...NODE_X.slice(1).map((x, i) => `M${NODE_X[i]} ${NODE_Y[i]} C${NODE_X[i] + 110} ${NODE_Y[i]} ${x - 110} ${NODE_Y[i + 1]} ${x} ${NODE_Y[i + 1]}`),
  `M${NODE_X[3]} ${NODE_Y[3]} C930 ${NODE_Y[3]} 960 32 1000 32`,
];

function StageTrack({ current, next, locale }: { current: number; next: StageView['next']; locale: Locale }) {
  const vi = locale === 'vi';
  const ref = usePauseOffscreen<HTMLElement>();
  const stage = Math.min(Math.max(current, 1), 4);
  const tasksReq = next.find((r) => r.code === 'TASKS');
  // lit = the lead-in plus every segment up to the current node; the rest of the way is a dotted, unlit line
  const lit = SEGMENTS.slice(0, stage).join(' ');
  const dim = SEGMENTS.slice(stage).join(' ');
  return (
    <section ref={ref} aria-labelledby="lp-stages" className={`${s.journey} ${s.pauseScope}`}>
      <JourneyBackdrop />
      <div className={s.journeyHead}>
        <span className={s.panelIcon} data-tone="sky" aria-hidden="true"><Route className="h-5 w-5" /></span>
        <div className={s.journeyHeadText}>
          <h2 id="lp-stages" className={s.panelTitle}>{vi ? 'Hành trình đến mục tiêu' : 'Your journey'}</h2>
          <p className={s.panelLead}>
            {vi ? `4 giai đoạn · Bạn đang ở giai đoạn ${stage}: ${STAGES.vi[stage - 1]}` : `4 stages · You are at stage ${stage}: ${STAGES.en[stage - 1]}`}
          </p>
        </div>
        <Link href="/progress" prefetch={false} className={s.btnGhost}>
          {vi ? 'Tiến trình học tập' : 'Learning progress'}
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </Link>
      </div>
      <div className={s.track}>
        <svg className={s.trackSvg} viewBox="0 0 1000 150" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id="lp-track" x1="0" y1="0" x2="1000" y2="0" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#22d3ee" />
              <stop offset="0.5" stopColor="#6366f1" />
              <stop offset="1" stopColor="#c084fc" />
            </linearGradient>
          </defs>
          {dim && <path className={s.trackDim} d={dim} />}
          <path className={s.trackHalo} d={lit} />
          <path className={s.trackLit} d={lit} stroke="url(#lp-track)" />
          <path className={s.trackPulse} d={lit} pathLength="100" />
        </svg>
        <ol className={s.stages} aria-label={vi ? 'Các giai đoạn' : 'Stages'}>
          {STAGES[locale].map((name, i) => {
            const n = i + 1;
            const state = n < stage ? 'done' : n === stage ? 'now' : 'later';
            const Icon = STAGE_ICONS[i];
            return (
              <li key={name} className={s.stage} data-state={state} data-step={n} aria-current={state === 'now' ? 'step' : undefined}>
                <span className={s.node} aria-hidden="true">
                  {state === 'now' && <><i className={s.nodeHalo} /><i className={s.nodePulse} /></>}
                  <Icon className={s.nodeIcon} />
                  {state === 'done' && <span className={s.nodeCheck}><Check className="h-3 w-3" strokeWidth={3.5} /></span>}
                </span>
                <span className={s.stageText}>
                  <span className={s.stageName}>
                    {n}. {name}
                    {state === 'now' && <span className={s.nowChip}>{vi ? 'Hiện tại' : 'Current'}</span>}
                  </span>
                  <span className={s.stageNote}>{STAGE_NOTES[locale][i]}</span>
                  <span className={s.stageStatus}>
                    {state === 'done' && (vi ? 'Đã qua' : 'Passed')}
                    {state === 'later' && (vi ? 'Chưa đến' : 'Ahead')}
                    {state === 'now' && (tasksReq
                      ? (vi ? `Nhiệm vụ: ${Math.min(tasksReq.current, tasksReq.needed)}/${tasksReq.needed}` : `Tasks: ${Math.min(tasksReq.current, tasksReq.needed)}/${tasksReq.needed}`)
                      : (vi ? 'Giai đoạn cuối' : 'Final stage'))}
                  </span>
                </span>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}

// ─── Today ────────────────────────────────────────────────────────────────────────────────────────────────────────────

function TodayPanel({ data, locale }: { data: TodayView; locale: Locale }) {
  const vi = locale === 'vi';
  const allDone = data.total > 0 && data.done === data.total;
  const day = formatDay(data.day, locale);
  return (
    <section aria-labelledby="lp-today" className={`${s.panel} ${s.today}`}>
      <div className={s.todayHead}>
        <span className={s.panelIcon} data-tone="indigo" aria-hidden="true"><CalendarDays className="h-5 w-5" /></span>
        <div className={s.todayHeadText}>
          <h2 id="lp-today" className={s.panelTitle}>{vi ? 'Hôm nay học gì?' : 'What to learn today?'}</h2>
          {day && <p className={s.panelLead}>{day}</p>}
        </div>
        {data.total > 0 && (
          <div className={s.dayMeter}>
            <span className={s.dayCount}>{data.done}/{data.total} {vi ? 'hoàn thành' : 'done'}</span>
            <span className={s.daySegments} aria-hidden="true">
              {data.tasks.map((t) => <i key={t.id} data-done={t.status === 'DONE' || undefined} />)}
            </span>
          </div>
        )}
      </div>

      {data.total === 0 && (
        <p className={s.emptyNote}>{vi ? 'Hôm nay chưa có bài phù hợp. Hãy quay lại sau.' : 'No suitable task today. Check back later.'}</p>
      )}

      <ol className={s.tasks}>
        {data.tasks.map((t) => <TaskRow key={t.id} task={t} locale={locale} />)}
      </ol>

      {allDone && (
        <p className={s.allDone} role="status">
          <span className={s.allDoneMark} aria-hidden="true"><Check className="h-4 w-4" strokeWidth={3} /></span>
          {vi ? 'Bạn đã hoàn thành hôm nay.' : 'Today is complete.'}
        </p>
      )}
    </section>
  );
}

const KIND: Record<string, { icon: LucideIcon; tone: string }> = {
  PLACEMENT: { icon: Gauge, tone: 'sky' },
  VOCAB_REVIEW: { icon: Layers, tone: 'violet' },
  DICTATION: { icon: Headphones, tone: 'cyan' },
  READING: { icon: BookOpenText, tone: 'emerald' },
  TOPIC_SPEAKING: { icon: MessageCircle, tone: 'amber' },
  WRITING: { icon: PenLine, tone: 'rose' },
  EXAM_PRACTICE: { icon: ClipboardCheck, tone: 'indigo' },
};

function TaskRow({ task, locale }: { task: LearningTask; locale: Locale }) {
  const vi = locale === 'vi';
  const done = task.status === 'DONE';
  const href = taskHref(task);
  const subtitle = taskSubtitle(task);
  const progress = taskProgress(task);
  const reason = reasonLabel(task.reason, locale);
  const meta = KIND[task.kind] ?? { icon: Route, tone: 'sky' };
  const Icon = meta.icon;
  const actionable = !done && (task.kind === 'PLACEMENT' || !!href);
  const body = (
    <>
      <span className={s.taskIcon} aria-hidden="true"><Icon className="h-5 w-5" /></span>
      <span className={s.taskBody}>
        <span className={s.taskTitle}>{taskTitle(task, locale)}</span>
        {subtitle && <span className={s.taskSub}>{subtitle}</span>}
        {(reason || progress) && !done && (
          <span className={s.taskTags}>
            {progress && <span className={s.tag} data-kind="progress">{progress}</span>}
            {reason && <span className={s.tag}>{reason}</span>}
          </span>
        )}
      </span>
      <span className={s.taskCheck} data-done={done || undefined} aria-hidden="true">{done && <Check className="h-3.5 w-3.5" strokeWidth={3} />}</span>
      <span className={s.taskFoot}>
        <span className={s.taskTime}>
          {done ? (vi ? 'Đã xong' : 'Done') : <><Clock3 className="h-4 w-4" aria-hidden="true" />{task.minutes} {vi ? 'phút' : 'min'}</>}
        </span>
        {actionable && (
          <span className={s.taskGo} aria-hidden="true">
            {task.progress > 0 ? (vi ? 'Tiếp tục' : 'Continue') : (vi ? 'Bắt đầu' : 'Start')}
            <Play className="h-3 w-3" fill="currentColor" />
          </span>
        )}
      </span>
    </>
  );
  const rowProps = { className: s.taskRow, 'data-tone': meta.tone, 'data-done': done || undefined } as const;
  if (done) return <li><div {...rowProps}>{body}</div></li>;
  if (task.kind === 'PLACEMENT') return <li><button type="button" {...rowProps} onClick={() => placementQuizStore.open(locale)}>{body}</button></li>;
  if (!href) return <li><div {...rowProps}>{body}</div></li>;
  return <li><Link href={href} prefetch={false} {...rowProps} data-link="">{body}</Link></li>;
}

// ─── Next stage requirements (server values only) ─────────────────────────────────────────────────────────────────────

function NextStagePanel({ stage, locale }: { stage: StageView; locale: Locale }) {
  const vi = locale === 'vi';
  const current = Math.min(Math.max(stage.current, 1), 4);
  const nextName = current < 4 ? STAGES[locale][current] : null;
  return (
    <section aria-labelledby="lp-next" className={s.panel}>
      <div className={s.panelHead}>
        <span className={s.panelIcon} data-tone="cyan" aria-hidden="true"><TrendingUp className="h-5 w-5" /></span>
        <div className={s.panelHeadText}>
          <h2 id="lp-next" className={s.panelTitle}>
            {nextName ? (vi ? `Đến giai đoạn ${nextName}` : `Toward ${nextName}`) : (vi ? 'Giai đoạn cuối' : 'Final stage')}
          </h2>
          <p className={s.panelLead}>
            {nextName ? (vi ? 'Điều kiện để chuyển sang giai đoạn tiếp theo' : 'What moves you to the next stage') : (vi ? 'Bạn đang ở giai đoạn cuối của lộ trình' : 'You are at the last stage of the path')}
          </p>
        </div>
      </div>
      {stage.next.length > 0 && (
        <ul className={s.reqs}>
          {stage.next.map((r) => {
            const pct = r.code === 'LEVEL' ? (r.met ? 100 : 0) : r.needed > 0 ? Math.round((Math.min(r.current, r.needed) / r.needed) * 100) : (r.met ? 100 : 0);
            return (
              <li key={r.code} className={s.req} data-met={r.met || undefined}>
                <span className={s.reqLine}>
                  <span className={s.reqDot} aria-hidden="true">{r.met && <Check className="h-3 w-3" strokeWidth={3.5} />}</span>
                  <span className={s.reqLabel}>{requirementLabel(r, locale)}</span>
                  <span className="sr-only">{r.met ? (vi ? '(đã đạt)' : '(met)') : (vi ? '(chưa đạt)' : '(not yet)')}</span>
                </span>
                <span className={s.reqBar} aria-hidden="true"><i style={{ width: `${pct}%` }} /></span>
              </li>
            );
          })}
        </ul>
      )}
      {stage.assessmentNeeded && (
        <p className={s.assess}>
          {vi ? 'Cần một bài đánh giá để xác nhận mục tiêu.' : 'An assessment is needed to confirm your goal.'}{' '}
          <Link href="/exams" prefetch={false} className={s.inlineLink}>{vi ? 'Thi thử' : 'Take a test'}</Link>
        </p>
      )}
    </section>
  );
}

// ─── Learner DNA: the plan's current focus (from an applied proposal) + the explicit update action ─────────────────────

const FOCUS_SKILLS = ['LISTENING', 'SPEAKING', 'READING', 'WRITING', 'VOCABULARY'] as const;
const HELIX = Array.from({ length: 11 }, (_, i) => i);

function DnaPanel({ plan, locale, onOpen }: { plan: LearningPlanView; locale: Locale; onOpen: () => void }) {
  const vi = locale === 'vi';
  const ref = usePauseOffscreen<HTMLElement>();
  const raised = FOCUS_SKILLS.filter((k) => (plan.focus?.[k] ?? 0) > 0);
  const updated = plan.focusUpdatedAt ? new Date(plan.focusUpdatedAt) : null;
  const updatedText = updated && !Number.isNaN(updated.getTime())
    ? new Intl.DateTimeFormat(vi ? 'vi-VN' : 'en-GB', { day: 'numeric', month: 'numeric', year: 'numeric', timeZone: 'Asia/Ho_Chi_Minh' }).format(updated)
    : null;
  return (
    <section ref={ref} aria-labelledby="lp-dna" className={`${s.panel} ${s.dna} ${s.pauseScope}`}>
      <div className={s.dnaHelix} aria-hidden="true">
        {HELIX.map((i) => <span key={i} style={{ '--i': i } as React.CSSProperties}><i /><b /><i /></span>)}
      </div>
      <div className={s.panelHead}>
        <span className={s.panelIcon} data-tone="violet" aria-hidden="true"><Dna className="h-5 w-5" /></span>
        <div className={s.panelHeadText}>
          <h2 id="lp-dna" className={s.panelTitle}>Learner DNA</h2>
          <p className={s.panelLead}>
            {vi ? 'Xem 7 ngày học gần nhất để đề xuất kỹ năng nên ưu tiên cho những ngày tới. Chỉ chạy khi bạn bấm, bạn quyết định có áp dụng.' : 'Reads your last 7 days to suggest which skills to favour in the coming days. Runs only when you ask; you decide whether to apply it.'}
          </p>
        </div>
      </div>
      <div className={s.focusBlock}>
        <p className={s.focusLabel}>{vi ? 'Đang ưu tiên thêm' : 'Currently favoured'}</p>
        <ul className={s.focusChips}>
          {FOCUS_SKILLS.map((k) => (
            <li key={k} className={s.focusChip} data-on={raised.includes(k) || undefined}>
              {skillLabel(k, locale)}
              <span className="sr-only">{raised.includes(k) ? (vi ? '(đang ưu tiên thêm)' : '(favoured)') : ''}</span>
            </li>
          ))}
        </ul>
        <p className={s.focusNote}>
          {raised.length === 0
            ? (vi ? 'Chưa có kỹ năng nào được ưu tiên thêm.' : 'No skill is favoured yet.')
            : (vi ? `Theo lần cập nhật${updatedText ? ` ngày ${updatedText}` : ''}.` : `From the update${updatedText ? ` of ${updatedText}` : ''}.`)}
        </p>
      </div>
      <button type="button" className={s.btnDna} onClick={onOpen} aria-haspopup="dialog">
        <Dna className="h-4 w-4" aria-hidden="true" />
        {vi ? 'Cập nhật bằng Learner DNA' : 'Update with Learner DNA'}
      </button>
    </section>
  );
}

// ─── Dialogs ──────────────────────────────────────────────────────────────────────────────────────────────────────────

function GlassDialog({ labelledBy, canDismiss, onDismiss, children }: { labelledBy: string; canDismiss: boolean; onDismiss: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const allowed = useRef(canDismiss);
  allowed.current = canDismiss;

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (allowed.current) { e.preventDefault(); dismiss.current(); }
        return;
      }
      if (e.key !== 'Tab' || !ref.current) return;
      const items = Array.from(ref.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), a[href]'))
        .filter((el) => el.offsetParent !== null || el.tagName === 'INPUT');
      if (items.length === 0) { e.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); opener?.focus(); };
  }, []);

  return (
    <div className={s.overlay} onMouseDown={(e) => { if (e.target === e.currentTarget && allowed.current) dismiss.current(); }}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={labelledBy} className={s.dialog}>
        {children}
      </div>
    </div>
  );
}

function GoalForm({ locale, title, submitLabel, initial, headingId, onSaved, onCancel }: {
  locale: Locale; title: string; submitLabel: string; initial?: GoalInput; headingId?: string;
  onSaved: (view: TodayView) => void; onCancel?: () => void;
}) {
  const vi = locale === 'vi';
  const [goal, setGoal] = useState<LearningGoal>(initial?.goal ?? 'GENERAL');
  const [minutes, setMinutes] = useState<DailyMinutes>(initial?.dailyMinutes ?? 30);
  const [target, setTarget] = useState<string | null>(initial?.target ?? null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const targets = TARGETS[goal] ?? [];
  const targetMissing = needsTarget(goal) && !(target && targets.includes(target));
  const Heading = headingId ? 'h2' : 'h1';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (targetMissing || saving) return;
    setSaving(true);
    setFailed(false);
    try {
      onSaved(await learningPathApi.setGoal({ goal, dailyMinutes: minutes, target: needsTarget(goal) || goal === 'GENERAL' ? target : null }));
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className={s.form}>
      <Heading id={headingId} className={s.formTitle}>{title}</Heading>
      <Choice legend={vi ? 'Mục tiêu' : 'Goal'} name="lp-goal" value={goal}
        options={GOALS.map((g) => ({ value: g, label: goalLabel(g, null, locale) }))}
        onChange={(v) => { setGoal(v as LearningGoal); setTarget(null); }} />
      <Choice legend={vi ? 'Thời gian mỗi ngày' : 'Time per day'} name="lp-minutes" value={String(minutes)}
        options={MINUTES.map((m) => ({ value: String(m), label: `${m} ${vi ? 'phút' : 'min'}` }))}
        onChange={(v) => setMinutes(Number(v) as DailyMinutes)} />
      {(needsTarget(goal) || goal === 'GENERAL') && (
        <Choice legend={goal === 'GENERAL' ? (vi ? 'Đích CEFR mong muốn (tùy chọn)' : 'Desired CEFR destination (optional)') : vi ? `Điểm mục tiêu ${goal}` : `${goal} target`} name="lp-target" value={target ?? ''}
          options={targets.map((t) => ({ value: t, label: t }))} onChange={setTarget} />
      )}
      {failed && <p role="alert" className={s.formError}>{vi ? 'Chưa lưu được. Thử lại nhé.' : 'Could not save. Please try again.'}</p>}
      <div className={s.formActions}>
        <button type="submit" className={s.cta} disabled={saving || targetMissing}>
          {saving
            ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            : <span className={s.ctaOrb} aria-hidden="true"><Check className="h-4 w-4" strokeWidth={3} /></span>}
          {submitLabel}
        </button>
        {onCancel && <button type="button" className={s.btnGhost} onClick={onCancel} disabled={saving}>{vi ? 'Hủy' : 'Cancel'}</button>}
      </div>
    </form>
  );
}

function Choice({ legend, name, value, options, onChange }: {
  legend: string; name: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void;
}) {
  return (
    <fieldset className={s.choice}>
      <legend className={s.choiceLegend}>{legend}</legend>
      <div className={s.choiceRow}>
        {options.map((o) => (
          <label key={o.value} className={s.choiceItem}>
            <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} className={`peer sr-only ${s.choiceInput}`} />
            <span className={s.choicePill}>{o.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function DnaDialog({ locale, onClose, onApplied }: { locale: Locale; onClose: () => void; onApplied: (view: TodayView) => void }) {
  const vi = locale === 'vi';
  const [proposal, setProposal] = useState<DnaProposal | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'applying' | 'error'>('loading');
  const [code, setCode] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // one analysis per explicit click (StrictMode / re-render safe)
    started.current = true;
    learningPathApi.proposeDna()
      .then((p) => { setProposal(p); setState('ready'); })
      .catch((e) => { setCode(errorCode(e)); setState('error'); });
  }, []);

  const close = () => {
    if (proposal && state === 'ready') void learningPathApi.cancelDna(proposal.id).catch(() => undefined);
    onClose();
  };

  const apply = async () => {
    if (!proposal) return;
    setState('applying');
    try {
      onApplied(await learningPathApi.applyDna(proposal.id));
    } catch (e) {
      setCode(errorCode(e));
      setState('error');
    }
  };

  const errorText = code === 'RATE_LIMITED'
    ? (vi ? 'Bạn đã cập nhật nhiều lần hôm nay. Thử lại vào ngày mai.' : 'You have updated many times today. Try again tomorrow.')
    : code === 'STALE' || code === 'EXPIRED'
      ? (vi ? 'Đề xuất đã cũ. Hãy cập nhật lại.' : 'This proposal is out of date. Please update again.')
      : (vi ? 'Chưa cập nhật được. Lộ trình hiện tại vẫn giữ nguyên.' : 'Could not update. Your current path is unchanged.');

  return (
    <GlassDialog labelledBy="lp-dna-title" canDismiss={state !== 'applying'} onDismiss={close}>
      <div className={s.dialogHead}>
        <span className={s.panelIcon} data-tone="violet" aria-hidden="true"><Dna className="h-5 w-5" /></span>
        <h2 id="lp-dna-title" className={s.formTitle}>{vi ? 'Cập nhật bằng Learner DNA' : 'Update with Learner DNA'}</h2>
      </div>
      {state === 'loading' && (
        <p className={s.dialogText} role="status">
          <Loader2 className="h-5 w-5 animate-spin text-sky-500 motion-reduce:animate-none" aria-hidden="true" />
          {vi ? 'Đang xem 7 ngày học gần nhất…' : 'Reading your last 7 days…'}
        </p>
      )}
      {state === 'error' && <p role="alert" className={s.dialogText}>{errorText}</p>}
      {(state === 'ready' || state === 'applying') && proposal && (
        proposal.changes.length === 0 ? (
          <p className={s.dialogText}>{vi ? 'Lộ trình hiện tại đã phù hợp với 7 ngày gần nhất.' : 'Your current path already fits the last 7 days.'}</p>
        ) : (
          <ul className={s.changes}>
            {proposal.changes.map((c) => {
              const fact = dnaFactLabel(c, proposal.facts, locale);
              return (
                <li key={c.skill} className={s.change}>
                  <span className={s.changeTitle}>{dnaChangeLabel(c, locale)}</span>
                  {fact && <span className={s.changeFact}>{fact}</span>}
                </li>
              );
            })}
          </ul>
        )
      )}
      <div className={s.formActions} data-end="">
        {(state === 'ready' || state === 'applying') && proposal && proposal.changes.length > 0 ? (
          <>
            <button type="button" className={s.btnGhost} onClick={close} disabled={state === 'applying'}>{vi ? 'Giữ nguyên' : 'Keep current'}</button>
            <button type="button" className={s.cta} onClick={apply} disabled={state === 'applying'}>
              {state === 'applying'
                ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                : <span className={s.ctaOrb} aria-hidden="true"><Check className="h-4 w-4" strokeWidth={3} /></span>}
              {vi ? 'Áp dụng' : 'Apply'}
            </button>
          </>
        ) : (
          <button type="button" className={s.btnGhost} onClick={close} disabled={state === 'loading'}>{vi ? 'Đóng' : 'Close'}</button>
        )}
      </div>
    </GlassDialog>
  );
}
