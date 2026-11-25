// Pure presentation helpers of the Leaderboard UI (Phase 4). No imports on purpose: the node contract
// test (scripts/test-leaderboard-contracts.mjs) loads this file directly with Node's TypeScript stripping.
// Vietnamese strings are the owner's exact labels; English is the secondary locale.

export type Locale = 'vi' | 'en';

interface Option<T extends string> {
  id: T;
  vi: string;
  en: string;
}

export const ACTIVITY_PERIODS: Option<'WEEK' | 'MONTH' | 'ALL_TIME'>[] = [
  { id: 'WEEK', vi: 'Tuần', en: 'Week' },
  { id: 'MONTH', vi: 'Tháng', en: 'Month' },
  { id: 'ALL_TIME', vi: 'Tổng', en: 'All time' },
];

export const ACTIVITY_SCOPES: Option<'GLOBAL' | 'SO_CAP' | 'TRUNG_CAP' | 'CAO_CAP'>[] = [
  { id: 'GLOBAL', vi: 'Bảng chung', en: 'Main board' },
  { id: 'SO_CAP', vi: 'Sơ cấp', en: 'Beginner' },
  { id: 'TRUNG_CAP', vi: 'Trung cấp', en: 'Intermediate' },
  { id: 'CAO_CAP', vi: 'Cao cấp', en: 'Advanced' },
];

/** No READING chip: the Activity board has no reading data source yet (KB 11 L2). */
export const ACTIVITY_GROUPS: Option<'ALL' | 'VOCAB' | 'LISTENING' | 'SPEAKING' | 'WRITING' | 'EXAMS'>[] = [
  { id: 'ALL', vi: 'Tất cả', en: 'All' },
  { id: 'VOCAB', vi: 'Từ vựng', en: 'Vocabulary' },
  { id: 'LISTENING', vi: 'Nghe', en: 'Listening' },
  { id: 'SPEAKING', vi: 'Nói', en: 'Speaking' },
  { id: 'WRITING', vi: 'Viết', en: 'Writing' },
  { id: 'EXAMS', vi: 'Thi thử', en: 'Exams' },
];

/** No Vocabulary board (UNSUPPORTED skill). */
export const PROFICIENCY_BOARDS: Option<'OVERALL' | 'LISTENING' | 'READING' | 'WRITING' | 'SPEAKING'>[] = [
  { id: 'OVERALL', vi: 'Tổng', en: 'Overall' },
  { id: 'LISTENING', vi: 'Nghe', en: 'Listening' },
  { id: 'READING', vi: 'Đọc', en: 'Reading' },
  { id: 'WRITING', vi: 'Viết', en: 'Writing' },
  { id: 'SPEAKING', vi: 'Nói', en: 'Speaking' },
];

export const DIVISIONS: Option<'SO_CAP' | 'TRUNG_CAP' | 'CAO_CAP'>[] = [
  { id: 'SO_CAP', vi: 'Sơ cấp', en: 'Beginner' },
  { id: 'TRUNG_CAP', vi: 'Trung cấp', en: 'Intermediate' },
  { id: 'CAO_CAP', vi: 'Cao cấp', en: 'Advanced' },
];

export function optionLabel(options: Option<string>[], id: string | null | undefined, locale: Locale = 'vi'): string {
  const o = options.find((x) => x.id === id);
  return o ? o[locale] : (id ?? '');
}

export function scopeName(scope: string | null | undefined, locale: Locale = 'vi'): string {
  return optionLabel(ACTIVITY_SCOPES, scope, locale);
}

/** Vietnamese names of the Activity sources (breakdown modal). */
export const SOURCE_NAMES: Record<string, { vi: string; en: string }> = {
  FLASHCARD_REVIEW: { vi: 'Ôn thẻ từ vựng', en: 'Flashcard reviews' },
  FLASHCARD_NEW: { vi: 'Học thẻ mới', en: 'New flashcards' },
  FLASHCARD_MASTERED: { vi: 'Thẻ đã thuộc', en: 'Mastered cards' },
  CARD_BLAST_SOLO: { vi: 'Card Blast', en: 'Card Blast' },
  CARD_BLAST_PVP: { vi: 'Đấu 1v1', en: '1v1 duels' },
  DICTATION: { vi: 'Chép chính tả', en: 'Dictation' },
  SHADOWING: { vi: 'Nói nhại câu', en: 'Shadowing' },
  ROLEPLAY: { vi: 'Hội thoại AI', en: 'AI conversation' },
  WRITING: { vi: 'Viết', en: 'Writing' },
  EXAM_SIMULATION: { vi: 'Thi thử mô phỏng', en: 'Full mock exam' },
  EXAM_PRACTICE: { vi: 'Luyện đề theo kỹ năng', en: 'Skill practice test' },
};

export function sourceName(sourceModule: string, locale: Locale = 'vi'): string {
  return SOURCE_NAMES[sourceModule]?.[locale] ?? sourceModule;
}

export const TEXT = {
  vi: {
    title: 'Bảng xếp hạng',
    tabActivity: 'Thi đua',
    tabProficiency: 'Năng lực',
    activityHint: 'Xếp theo mức độ học tích cực trong kỳ, không phản ánh trình độ.',
    proficiencyHint: 'Xếp theo trình độ đã được xác thực qua bài thi chuẩn hóa (không bắt buộc để tham gia Thi đua).',
    notUpdated: 'Chưa cập nhật',
    activityEmpty: 'Chưa có ai ghi điểm trong kỳ này. Bắt đầu một bài học để mở màn!',
    proficiencyEmpty: 'Chưa có ai được xác thực trình độ ở hạng này.',
    proficiencyEmptyCta: 'Xác thực bằng bài thi chuẩn hóa',
    myRank: 'Hạng của bạn',
    noPoints: 'Chưa có điểm trong kỳ này',
    breakdownButton: 'Điểm của bạn đến từ đâu',
    breakdownEmpty: 'Bạn chưa có điểm nào trong kỳ này.',
    breakdownFootnote:
      'Điểm thi đua có thưởng chuỗi ngày có điểm (tối đa +15%). Chuỗi này tính riêng cho bảng thi đua.',
    retry: 'Thử lại',
    loadError: 'Không tải được dữ liệu.',
    close: 'Đóng',
    yourLevel: 'Trình độ của bạn',
    viewMyLevel: 'Xem trình độ của bạn',
    current: 'Hiện tại',
    peak: 'Cao nhất',
    vocabulary: 'Từ vựng',
    showOnBoard: 'Hiển thị tôi trên bảng năng lực',
    visibilityError: 'Không lưu được cài đặt hiển thị. Vui lòng thử lại.',
    weeklyRank: 'Hạng tuần',
    noWeeklyPoints: 'Chưa có điểm tuần này',
    undetermined: 'Chưa xác định',
    refreshing: 'Đang làm mới',
    podium: 'Bục vinh danh',
    heroSubtitle: 'Thi đua học tập mỗi tuần và xác thực trình độ qua bài thi chuẩn hóa.',
    participantsWeek: 'Người tham gia tuần này',
    yourRankChip: 'Hạng của bạn',
    notRanked: 'Chưa xếp hạng',
    emptySlot: 'Còn trống',
    unrankedTitle: 'Chưa ghi điểm kỳ này',
    loadMore: 'Xem thêm',
    topWeekTitle: 'Top học viên tuần này',
    topMonthTitle: 'Top học viên tháng này',
    seeAll: 'Xem tất cả',
    you: 'Bạn',
    periodRollover: 'Đang sang kỳ mới',
    liveHint: 'Điểm và hạng cập nhật trực tiếp sau mỗi hoạt động',
    excludedRank: 'Không tham gia xếp hạng',
    excludedNote: 'Tài khoản quản trị hoặc thử nghiệm không được xếp hạng. Điểm vẫn được ghi nhận.',
    excludedAdminNote: 'Tài khoản quản trị không tham gia bảng xếp hạng. Điểm vẫn được ghi nhận.',
    excludedTestNote: 'Tài khoản thử nghiệm không tham gia bảng xếp hạng. Điểm vẫn được ghi nhận.',
    excludedInactiveNote: 'Tài khoản chưa kích hoạt không tham gia bảng xếp hạng.',
    placementRequiredRank: 'Chưa vào bảng xếp hạng',
    placementRequiredNote: 'Hoàn thành bài xếp lớp để tham gia xếp hạng — điểm của bạn đã được ghi nhận.',
    pendingRank: 'Đang cập nhật hạng…',
    otherDivisionRank: 'Không thuộc giải này',
    widgetExcluded: 'Không tham gia xếp hạng',
    widgetPlacement: 'Làm bài xếp lớp để vào bảng xếp hạng',
  },
  en: {
    title: 'Leaderboard',
    tabActivity: 'Activity',
    tabProficiency: 'Proficiency',
    activityHint: 'Ranked by how actively you study this period — not by level.',
    proficiencyHint: 'Ranked by level verified through standardized exams (not required for the Activity board).',
    notUpdated: 'Not updated yet',
    activityEmpty: 'Nobody has scored this period yet. Start a lesson to open the board!',
    proficiencyEmpty: 'Nobody has a verified level in this division yet.',
    proficiencyEmptyCta: 'Verify with a standardized exam',
    myRank: 'Your rank',
    noPoints: 'No points this period yet',
    breakdownButton: 'Where your points come from',
    breakdownEmpty: 'You have no points this period yet.',
    breakdownFootnote:
      'Activity points include a bonus for consecutive scoring days (up to +15%). This chain is counted only for the Activity board.',
    retry: 'Retry',
    loadError: 'Could not load data.',
    close: 'Close',
    yourLevel: 'Your level',
    viewMyLevel: 'View your level',
    current: 'Current',
    peak: 'Peak',
    vocabulary: 'Vocabulary',
    showOnBoard: 'Show me on the proficiency board',
    visibilityError: 'Could not save the visibility setting. Please try again.',
    weeklyRank: 'Weekly rank',
    noWeeklyPoints: 'No points this week yet',
    undetermined: 'Not determined',
    refreshing: 'Refreshing',
    podium: 'Podium',
    heroSubtitle: 'Weekly study competition and level verification through standardized exams.',
    participantsWeek: 'Participants this week',
    yourRankChip: 'Your rank',
    notRanked: 'Not ranked',
    emptySlot: 'Open',
    unrankedTitle: 'No points this period',
    loadMore: 'Show more',
    topWeekTitle: 'Top learners this week',
    topMonthTitle: 'Top learners this month',
    seeAll: 'See all',
    you: 'You',
    periodRollover: 'New period starting',
    liveHint: 'Points and ranks update live after every activity',
    excludedRank: 'Not ranked',
    excludedNote: 'Admin and test accounts are not ranked. Your points are still recorded.',
    excludedAdminNote: 'Administrator accounts do not take part in the leaderboard. Your points are still recorded.',
    excludedTestNote: 'Test accounts do not take part in the leaderboard. Your points are still recorded.',
    excludedInactiveNote: 'Inactive accounts do not take part in the leaderboard.',
    placementRequiredRank: 'Not on the board yet',
    placementRequiredNote: 'Finish the placement quiz to join the ranking — your points are already recorded.',
    pendingRank: 'Updating rank…',
    otherDivisionRank: 'Not in this division',
    widgetExcluded: 'Not ranked',
    widgetPlacement: 'Take the placement quiz to join the board',
  },
} as const;

export function formatXp(points: number, locale: Locale = 'vi'): string {
  return `${points.toLocaleString(locale === 'vi' ? 'vi-VN' : 'en-US')} XP`;
}

/**
 * End of the competition PERIOD (weekly / monthly reset) — not a data refresh: points and ranks update live.
 * "Kỳ tuần kết thúc sau 2 ngày 5 giờ" (≥ 1 day), "… 5 giờ 12 phút" (≥ 1 h), "… 12 phút"; null without an end.
 */
export function formatCountdown(endsAt: string | null | undefined, now: Date, locale: Locale = 'vi',
  period: 'WEEK' | 'MONTH' | 'ALL_TIME' = 'WEEK'): string | null {
  if (!endsAt) return null;
  const ms = new Date(endsAt).getTime() - now.getTime();
  if (Number.isNaN(ms)) return null;
  if (ms <= 0) return TEXT[locale].periodRollover;
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const vi = locale === 'vi';
  const d = (n: number) => (vi ? `${n} ngày` : `${n} ${n === 1 ? 'day' : 'days'}`);
  const h = (n: number) => (vi ? `${n} giờ` : `${n} h`);
  const m = (n: number) => (vi ? `${n} phút` : `${n} min`);
  let body: string;
  if (days >= 1) body = `${d(days)} ${h(hours)}`;
  else if (hours >= 1) body = `${h(hours)} ${m(minutes)}`;
  else body = m(Math.max(minutes, 1));
  const month = period === 'MONTH';
  if (vi) return `${month ? 'Kỳ tháng' : 'Kỳ tuần'} kết thúc sau ${body}`;
  return `${month ? 'Month' : 'Week'} ends in ${body}`;
}

/** "Cập nhật lúc HH:mm" in Asia/Ho_Chi_Minh; never refreshed ⇒ "Chưa cập nhật". */
export function formatUpdatedAt(updatedAt: string | null | undefined, locale: Locale = 'vi'): string {
  if (!updatedAt) return TEXT[locale].notUpdated;
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return TEXT[locale].notUpdated;
  const hhmm = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
  return locale === 'vi' ? `Cập nhật lúc ${hhmm}` : `Updated at ${hhmm}`;
}

/** Status label of a skill bar on "Trình độ của bạn". */
export function skillStatusLabel(status: string | null | undefined, locale: Locale = 'vi'): string {
  const vi = locale === 'vi';
  switch (status) {
    case 'VERIFIED':
      return vi ? 'Đã xác thực' : 'Verified';
    case 'PROVISIONAL':
      return vi ? 'Chưa xác thực bằng bài thi' : 'Not verified by an exam yet';
    case 'STALE':
      return vi ? 'Cần xác thực lại' : 'Needs re-verification';
    case 'UNSUPPORTED':
      return vi ? 'Chưa đủ dữ liệu — sẽ mở khi có bài đánh giá từ vựng' : 'Not enough data — opens once a vocabulary assessment exists';
    case 'UNDETERMINED':
    default:
      return vi ? 'Chưa đủ dữ liệu' : 'Not enough data';
  }
}

/** Mini L·R·W·S chip on the Năng lực board: CEFR only when VERIFIED, else "–". */
export function skillCellText(cell: { cefr: string | null; status: string } | null | undefined): string {
  return cell && cell.status === 'VERIFIED' && cell.cefr ? cell.cefr : '–';
}

/** Six CEFR tick marks on the 0–1000 scale (Proficiency Spec §1 band starts). */
export const CEFR_TICKS: { cefr: string; at: number }[] = [
  { cefr: 'A1', at: 0 },
  { cefr: 'A2', at: 167 },
  { cefr: 'B1', at: 334 },
  { cefr: 'B2', at: 500 },
  { cefr: 'C1', at: 667 },
  { cefr: 'C2', at: 834 },
];

export function ratingPercent(rating: number | null | undefined): number {
  if (rating == null || Number.isNaN(rating)) return 0;
  return Math.max(0, Math.min(100, rating / 10));
}

/** "Hiện tại: B2 · 658 — Cao nhất: C1 · 701" (peak part only when a peak exists). */
export function currentPeakLine(
  overall: { rating: number | null; currentCefr: string | null; peakRating: number | null; peakCefr: string | null },
  locale: Locale = 'vi',
): string | null {
  const t = TEXT[locale];
  if (overall.rating == null || !overall.currentCefr) return null;
  const current = `${t.current}: ${overall.currentCefr} · ${overall.rating}`;
  if (overall.peakRating == null || !overall.peakCefr) return current;
  return `${current} — ${t.peak}: ${overall.peakCefr} · ${overall.peakRating}`;
}

export interface MyRankText {
  rank: string;
  toNext: string | null;
}

/** Eligibility statuses of /leaderboard/activity/me (kept as plain strings: this file imports nothing). */
export type EligibilityStatus = 'RANKED' | 'NO_POINTS' | 'PENDING' | 'OTHER_DIVISION' | 'PLACEMENT_REQUIRED' | 'EXCLUDED';

type MeLike = {
  rank: number | null;
  points?: number;
  pointsToNextRank: number | null;
  nextRank?: number | null;
  eligibility?: string | null;
  /** ADMIN / EXCLUDED_TEST / INACTIVE when eligibility = EXCLUDED (backend knows the exact reason). */
  excludedReason?: string | null;
};

/**
 * Effective status of the caller in the selected partition. The zero state ("Chưa có điểm trong kỳ này") is used ONLY
 * when the selected period / group really has 0 points; an excluded or not-yet-placed learner with XP gets an
 * accurate status instead. Older responses without `eligibility` fall back to points.
 */
export function eligibilityOf(me: MeLike | null | undefined): EligibilityStatus | null {
  if (!me) return null;
  if (me.rank != null) return 'RANKED';
  const e = me.eligibility as EligibilityStatus | null | undefined;
  if (e && e !== 'RANKED') return e;
  return (me.points ?? 0) > 0 ? 'PENDING' : 'NO_POINTS';
}

/** Note under "Hạng của bạn" for statuses that need an explanation (null otherwise). */
export function eligibilityNote(me: MeLike | null | undefined, locale: Locale = 'vi'): string | null {
  const t = TEXT[locale];
  switch (eligibilityOf(me)) {
    case 'EXCLUDED':
      // exact reason from the backend; the generic line only for older responses without it
      return me?.excludedReason === 'ADMIN' ? t.excludedAdminNote
        : me?.excludedReason === 'EXCLUDED_TEST' ? t.excludedTestNote
          : me?.excludedReason === 'INACTIVE' ? t.excludedInactiveNote
            : t.excludedNote;
    case 'PLACEMENT_REQUIRED':
      return t.placementRequiredNote;
    default:
      return null;
  }
}

/** Sticky bar of the Thi đua tab. */
export function myRankText(me: MeLike | null | undefined, locale: Locale = 'vi'): MyRankText {
  const t = TEXT[locale];
  if (!me) return { rank: t.noPoints, toNext: null };
  if (me.rank == null) {
    switch (eligibilityOf(me)) {
      case 'EXCLUDED': return { rank: t.excludedRank, toNext: null };
      case 'PLACEMENT_REQUIRED': return { rank: t.placementRequiredRank, toNext: null };
      case 'PENDING': return { rank: t.pendingRank, toNext: null };
      case 'OTHER_DIVISION': return { rank: t.otherDivisionRank, toNext: null };
      default: return { rank: t.noPoints, toNext: null };
    }
  }
  let toNext: string | null = null;
  if (me.pointsToNextRank != null) {
    const target = me.nextRank ?? Math.max(1, me.rank - 1);
    toNext = locale === 'vi'
      ? `Còn ${me.pointsToNextRank} XP để vượt hạng ${target}`
      : `${me.pointsToNextRank} XP to pass rank ${target}`;
  }
  return { rank: `#${me.rank}`, toNext };
}

export type HeaderKind = 'RANKED' | 'HIDDEN' | 'PENDING' | 'UNDETERMINED' | 'PLACEMENT' | 'PROVISIONAL' | 'STALE';

export interface HeaderState {
  kind: HeaderKind;
  title: string;
  note: string | null;
  cta: { label: string; href: string } | null;
  /** Show the "Bài xếp lớp nhanh" button (learners without any level). */
  placementQuiz?: boolean;
  /** The exam link is optional (placement already done): render it as a secondary action. */
  ctaSecondary?: boolean;
}

/**
 * Năng lực header card from /leaderboard/proficiency/me; null = hide the card (EXCLUDED). `placementCefr` = latest
 * VALID "Bài xếp lớp nhanh" result: shown with "Theo bài xếp lớp" for learners without an exam-based level.
 */
export function proficiencyHeaderState(
  me: { eligible: boolean; hidden: boolean; rank: number | null; ineligibleReason: string | null } | null | undefined,
  _placementCta: string | null | undefined,
  locale: Locale = 'vi',
  placementCefr: string | null = null,
  /** Nghe / Đọc / Viết / Nói board: the placement level is a general level, not a verified skill level. */
  skillBoard = false,
): HeaderState | null {
  if (!me) return null;
  const vi = locale === 'vi';
  const examCta = { label: TEXT[locale].proficiencyEmptyCta, href: '/exams' };
  if (me.eligible) {
    if (me.rank == null) {
      return { kind: 'PENDING', title: vi ? 'Đã xác thực — bảng đang được cập nhật' : 'Verified — the board is being refreshed', note: null, cta: null };
    }
    if (me.hidden) {
      return {
        kind: 'HIDDEN',
        title: vi ? `Hạng #${me.rank}` : `Rank #${me.rank}`,
        note: vi
          ? `Bạn đang ẩn khỏi bảng năng lực (nếu hiển thị, bạn sẽ ở hạng #${me.rank})`
          : `You are hidden from the proficiency board (you would be #${me.rank})`,
        cta: null,
      };
    }
    return { kind: 'RANKED', title: vi ? `Hạng #${me.rank}` : `Rank #${me.rank}`, note: null, cta: null };
  }
  switch (me.ineligibleReason) {
    case 'EXCLUDED':
      return null;
    case 'PROVISIONAL':
      return {
        kind: 'PROVISIONAL',
        title: vi ? 'Đang xác thực — hoàn thành một bài thi chính thức để lên bảng' : 'Verifying — complete an official exam to join the board',
        note: null,
        cta: examCta,
      };
    case 'STALE':
      return {
        kind: 'STALE',
        title: vi ? 'Cần xác thực lại — đã lâu chưa có bài thi mới' : 'Needs re-verification — no recent exam',
        note: null,
        cta: examCta,
      };
    case 'UNDETERMINED':
    default:
      if (placementCefr) {
        // Placement done ⇒ already in the Thi đua ranking; a standardized exam is an optional extra (never a gate).
        const level = levelWithSource(placementCefr, 'PLACEMENT', locale);
        return {
          kind: 'PLACEMENT',
          title: skillBoard
            ? (vi ? 'Kỹ năng này chưa được xác thực' : 'This skill is not verified yet')
            : `${vi ? 'Trình độ' : 'Level'}: ${level}`,
          note: skillBoard
            ? (vi ? `Trình độ chung: ${level}. ${PLACEMENT_TEXT.vi.optionalVerify}` : `General level: ${level}. ${PLACEMENT_TEXT.en.optionalVerify}`)
            : PLACEMENT_TEXT[locale].optionalVerify,
          cta: { label: PLACEMENT_TEXT[locale].verifyLink, href: '/exams' },
          ctaSecondary: true,
        };
      }
      return {
        kind: 'UNDETERMINED',
        title: vi ? 'Trình độ chưa xác định' : 'Level not determined',
        note: null,
        cta: null,
        placementQuiz: true,
      };
  }
}

/**
 * Empty Năng lực board action: no level at all ⇒ the quick placement quiz (never the exam centre); a placement or
 * exam-based level ⇒ the optional standardized-exam link; EXCLUDED / not loaded (state null) ⇒ nothing.
 */
export function proficiencyEmptyAction(state: HeaderState | null): 'PLACEMENT' | 'VERIFY' | null {
  if (!state) return null;
  return state.placementQuiz ? 'PLACEMENT' : 'VERIFY';
}

/**
 * Leaderboard banner "Vào giải theo trình độ": every learner the backend still marks PLACEMENT_REQUIRED (no VALID quick
 * placement). Admins / excluded accounts get EXCLUDED and never see it; it disappears as soon as a placement is VALID.
 */
export function showPlacementBanner(me: MeLike | null | undefined): boolean {
  return eligibilityOf(me) === 'PLACEMENT_REQUIRED';
}

/** Dashboard widget lines. */
export function widgetLines(
  activity: {
    rank: number | null; scope: string; divisionCefr?: string | null; divisionSource?: string | null;
    points?: number; pointsToNextRank?: number | null; eligibility?: string | null;
  } | null | undefined,
  overall: { status: string; currentCefr: string | null } | null | undefined,
  locale: Locale = 'vi',
): { rank: string; level: string } {
  const t = TEXT[locale];
  const status = activity ? eligibilityOf({ ...activity, pointsToNextRank: activity.pointsToNextRank ?? null }) : null;
  const rank = activity && activity.rank != null
    ? `${t.weeklyRank}: #${activity.rank} (${scopeName(activity.scope, locale)})`
    : status === 'EXCLUDED' ? t.widgetExcluded
      : status === 'PLACEMENT_REQUIRED' ? t.widgetPlacement
        : status === 'PENDING' ? t.pendingRank
          : t.noWeeklyPoints;
  // exam-based level first (with its status label), then the placement-based division level, never A1 by default
  const level = overall && overall.status !== 'UNDETERMINED' && overall.status !== 'UNSUPPORTED' && overall.currentCefr
    ? levelWithSource(overall.currentCefr, overall.status, locale)
    : activity?.divisionSource === 'PLACEMENT' ? levelWithSource(activity.divisionCefr, 'PLACEMENT', locale) : null;
  return { rank, level: level ?? t.undetermined };
}

// ---- Stage 2: podium, widget, letter avatar ------------------------------------------------------

/** Pedestal heights (% of the #1 pedestal): #2 60 %, #1 100 %, #3 48 %. */
export const PODIUM_HEIGHTS: Record<1 | 2 | 3, number> = { 1: 100, 2: 60, 3: 48 };

export interface PodiumSlot<T> {
  place: 1 | 2 | 3;
  item: T | null; // null ⇒ dashed "Còn trống" placeholder
}

/**
 * Visual order #2 – #1 – #3 from the first three ranked items (ties keep their own rank numbers; the slot
 * is the position in the list). Fewer than three items ⇒ placeholders instead of blank boxes.
 */
export function podiumSlots<T>(items: T[]): PodiumSlot<T>[] {
  const at = (i: number): T | null => (i < items.length ? items[i] : null);
  return [
    { place: 2, item: at(1) },
    { place: 1, item: at(0) },
    { place: 3, item: at(2) },
  ];
}

/** Home widget: podium = first three, rows = #4 and #5. */
export function widgetRows<T>(items: T[]): { podium: PodiumSlot<T>[]; rows: T[] } {
  return { podium: podiumSlots(items), rows: items.slice(3, 5) };
}

/** Stable letter-avatar hue from the user id (same colour everywhere for a learner). */
export function letterAvatarHue(userId: number): number {
  const n = Math.abs(Math.trunc(userId)) * 2654435761;
  return n % 360;
}

export function initialOf(name: string | null | undefined): string {
  const t = (name ?? '').trim();
  return t ? t.charAt(0).toUpperCase() : '?';
}

/** Hero chip "Hạng của bạn: #N" / "Chưa xếp hạng". */
export function yourRankChip(rank: number | null | undefined, locale: Locale = 'vi'): string {
  const t = TEXT[locale];
  return rank != null ? `${t.yourRankChip}: #${rank}` : `${t.yourRankChip}: ${t.notRanked}`;
}

/**
 * Default competitive period of BOTH the full leaderboard and the dashboard "Top học viên" card (owner decision
 * 2026-10-02): opening either one shows the same week, so the same learner shows the same XP.
 */
export const DEFAULT_COMPETITIVE_PERIOD = 'WEEK' as const;

/** Periods of the small switch on the dashboard card (Tổng stays on the full board). */
export const WIDGET_PERIODS = ACTIVITY_PERIODS.filter((p) => p.id !== 'ALL_TIME') as Option<'WEEK' | 'MONTH'>[];

/** URL of the full board opened from the home widget: Bảng chung + the period shown on the card. */
export function widgetSeeAllHref(period: 'WEEK' | 'MONTH' = DEFAULT_COMPETITIVE_PERIOD): string {
  return `/leaderboard?lbPeriod=${period}&lbScope=GLOBAL`;
}

export const WIDGET_SEE_ALL_HREF = widgetSeeAllHref();

/** Card title: "Top học viên tuần này" / "Top học viên tháng này" — always the period actually requested. */
export function topLearnersTitle(period: 'WEEK' | 'MONTH', locale: Locale = 'vi'): string {
  return period === 'MONTH' ? TEXT[locale].topMonthTitle : TEXT[locale].topWeekTitle;
}

/**
 * "28/09 – 04/10" from the board API's periodStartsAt / periodEndsAt (end is EXCLUSIVE, so its previous instant is the
 * last day), dd/MM in Asia/Ho_Chi_Minh — the authoritative backend window, never recomputed on the client.
 */
export function periodRangeLabel(startsAt: string | null | undefined, endsAt: string | null | undefined): string | null {
  if (!startsAt || !endsAt) return null;
  const s = new Date(startsAt);
  const e = new Date(new Date(endsAt).getTime() - 1);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e < s) return null;
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit' });
  return `${fmt.format(s)} – ${fmt.format(e)}`;
}

// ---- Stage 3: placement quiz, level source labels, Năng lực groups, promotion notice ------------

/** Source label shown next to every level (division level, Năng lực groups, "Trình độ của bạn"). */
export function levelSourceLabel(source: string | null | undefined, locale: Locale = 'vi'): string | null {
  const vi = locale === 'vi';
  switch (source) {
    case 'VERIFIED':
      return vi ? 'Đã xác thực' : 'Verified';
    case 'PROVISIONAL':
      return vi ? 'Đang xác thực' : 'Verifying';
    case 'STALE':
      return vi ? 'Cần xác thực lại' : 'Needs re-verification';
    case 'PLACEMENT':
      return vi ? 'Theo bài xếp lớp' : 'From placement quiz';
    default:
      return null;
  }
}

/** "B1 · Theo bài xếp lớp" (level without a known source ⇒ level only). */
export function levelWithSource(cefr: string | null | undefined, source: string | null | undefined, locale: Locale = 'vi'): string | null {
  if (!cefr) return null;
  const label = levelSourceLabel(source, locale);
  return label ? `${cefr} · ${label}` : cefr;
}

/** Questions per quick placement attempt (server default 3 vocabulary + 3 grammar × A1–C1; `/placement/me.itemCount` wins). */
export const PLACEMENT_DEFAULT_ITEMS = 30;

/** Rough duration shown to the learner: ~8 s per multiple-choice question, at least 3 minutes. */
export function placementMinutes(items: number): number {
  return Math.max(3, Math.round((items * 8) / 60));
}

export const PLACEMENT_TEXT = {
  vi: {
    title: 'Bài xếp lớp nhanh',
    resumeTitle: 'Bạn có bài xếp lớp đang làm dở',
    resumeProgress: (a: number, n: number) => `Đã hoàn thành ${a}/${n} câu`,
    resume: 'Tiếp tục',
    restart: 'Làm lại từ đầu',
    restartConfirmTitle: 'Làm lại từ đầu?',
    restartConfirmBody: 'Bài đang làm dở sẽ bị hủy và bạn bắt đầu một bài 30 câu mới.',
    restartConfirm: 'Hủy bài cũ và làm lại',
    back: 'Quay lại',
    exitTitle: 'Thoát bài xếp lớp?',
    exitBody: (a: number, n: number) => `Bạn đang làm dở bài xếp lớp (${a}/${n}). Tiến độ của bạn đã được lưu. Bạn có chắc muốn thoát?`,
    keepGoing: 'Tiếp tục làm',
    exitQuiz: 'Thoát bài',
    saving: 'Đang lưu…',
    saved: (time: string) => `Đã lưu lúc ${time}`,
    saveRetry: 'Chưa lưu được — đang thử lại',
    submitFailedTitle: 'Chưa gửi được bài',
    submitFailedBody: 'Câu trả lời của bạn vẫn được giữ nguyên. Kiểm tra kết nối rồi gửi lại.',
    readyTitle: 'Bạn đã trả lời đủ câu hỏi',
    readyBody: 'Gửi bài để nhận kết quả xếp lớp.',
    resubmit: 'Gửi bài',
    resultDisclaimer: 'Dựa trên câu hỏi từ vựng và ngữ pháp — là ước lượng ban đầu, không phải chứng chỉ và không thay cho bài thi kỹ năng Nghe / Nói / Đọc / Viết.',
    introLead: (n: number) => `Khoảng ${placementMinutes(n)} phút · ${n} câu từ vựng và ngữ pháp`,
    introHow: 'Mỗi câu là một câu tiếng Anh có chỗ trống. Chọn đáp án đúng nhất. Câu hỏi đi từ A1 đến C1.',
    introWarning: 'Nếu không biết, hãy bấm "Tôi chưa biết" thay vì đoán: đoán sai bị trừ điểm, bỏ qua thì không.',
    introNote: 'Đây là bài xếp lớp nhanh, không phải bài thi chứng chỉ. Kết quả xác định trình độ ban đầu, xếp bạn vào giải và mở quyền tham gia bảng xếp hạng.',
    start: 'Bắt đầu',
    skip: 'Tôi chưa biết',
    skillVocabulary: 'Từ vựng',
    skillGrammar: 'Ngữ pháp',
    keyboardHint: 'Phím tắt: 1–4 chọn đáp án · 0 Tôi chưa biết',
    progress: (i: number, n: number) => `Câu ${i}/${n}`,
    skillScore: (v: string, g: string) => `Từ vựng ${v} · Ngữ pháp ${g}`,
    outdatedNotice: 'Bài xếp lớp đã được nâng cấp (từ vựng + ngữ pháp). Hãy làm lại để có kết quả chính xác hơn.',
    submitting: 'Đang chấm bài…',
    resultTitle: 'Ước lượng ban đầu',
    resultSource: 'Theo bài xếp lớp',
    lowConfidence: 'Kết quả có độ tin cậy thấp — bạn có thể làm lại sau.',
    verifyLink: 'Xác thực bằng bài thi chuẩn hóa',
    optionalVerify: 'Xác thực bằng bài thi chuẩn hóa là tùy chọn — giúp bạn lên bảng Năng lực.',
    resultJoined: 'Bạn đã có thể tham gia bảng xếp hạng Thi đua.',
    resultDivision: 'Giải',
    viewBoard: 'Xem bảng xếp hạng',
    viewLevel: 'Xem trình độ của bạn',
    correctCount: (c: number, n: number) => `${c} / ${n} câu đúng`,
    invalidTitle: 'Kết quả không hợp lệ',
    invalidBody: 'Bạn trả lời đúng câu khó nhưng sai nhiều câu dễ — có vẻ như đã chọn ngẫu nhiên. Hãy làm lại cẩn thận.',
    retry: 'Làm lại',
    lockedTitle: 'Bạn đã làm bài xếp lớp gần đây',
    lockedBody: (date: string) => `Bạn có thể làm lại từ ngày ${date}.`,
    retakeOn: (date: string) => `Làm lại từ ngày ${date}`,
    takeQuiz: 'Làm bài xếp lớp nhanh',
    retakeQuiz: 'Làm lại bài xếp lớp',
    error: 'Không thể tải bài xếp lớp. Vui lòng thử lại.',
    expired: 'Bài làm đã hết hạn. Hãy bắt đầu lại.',
    close: 'Đóng',
    ctaCardTitle: 'Vào giải theo trình độ',
    ctaCardBody: 'Làm bài xếp lớp nhanh để xác định trình độ ban đầu và tham gia bảng xếp hạng.',
    ctaCardMeta: (n: number) => `Khoảng ${placementMinutes(n)} phút · ${n} câu · không phải bài thi chứng chỉ`,
    divisionCta: 'Làm bài xếp lớp để vào giải theo trình độ',
    dismiss: 'Để sau',
    yourPlacement: 'Bài xếp lớp',
    yourDivision: 'Giải của bạn',
    promotionTitle: 'Bạn đã được nâng giải',
  },
  en: {
    title: 'Quick placement quiz',
    resumeTitle: 'You have an unfinished placement quiz',
    resumeProgress: (a: number, n: number) => `${a}/${n} questions answered`,
    resume: 'Continue',
    restart: 'Start over',
    restartConfirmTitle: 'Start over?',
    restartConfirmBody: 'Your unfinished attempt will be discarded and a new 30-question quiz starts.',
    restartConfirm: 'Discard and start over',
    back: 'Back',
    exitTitle: 'Leave the placement quiz?',
    exitBody: (a: number, n: number) => `You are in the middle of the placement quiz (${a}/${n}). Your progress is saved. Do you want to leave?`,
    keepGoing: 'Keep going',
    exitQuiz: 'Leave quiz',
    saving: 'Saving…',
    saved: (time: string) => `Saved at ${time}`,
    saveRetry: 'Not saved yet — retrying',
    submitFailedTitle: 'Could not submit',
    submitFailedBody: 'Your answers are kept. Check your connection and submit again.',
    readyTitle: 'All questions answered',
    readyBody: 'Submit to get your placement result.',
    resubmit: 'Submit',
    resultDisclaimer: 'Based on vocabulary and grammar questions — an initial estimate, not a certificate, and no substitute for a Listening / Speaking / Reading / Writing exam.',
    introLead: (n: number) => `About ${placementMinutes(n)} minutes · ${n} vocabulary and grammar questions`,
    introHow: 'Each question is an English sentence with a gap. Choose the best answer. Questions go from A1 to C1.',
    introWarning: "If you do not know, press \"I don't know yet\" instead of guessing: wrong guesses cost points, skipping does not.",
    introNote: 'This is a quick placement, not a certification exam. The result sets your starting level, places you in a division and lets you join the leaderboard.',
    start: 'Start',
    skip: "I don't know yet",
    skillVocabulary: 'Vocabulary',
    skillGrammar: 'Grammar',
    keyboardHint: "Shortcuts: 1–4 choose an answer · 0 I don't know yet",
    progress: (i: number, n: number) => `Question ${i}/${n}`,
    skillScore: (v: string, g: string) => `Vocabulary ${v} · Grammar ${g}`,
    outdatedNotice: 'The placement quiz was upgraded (vocabulary + grammar). Retake it for a more accurate result.',
    submitting: 'Scoring…',
    resultTitle: 'Initial estimate',
    resultSource: 'From placement quiz',
    lowConfidence: 'Low-confidence result — you can retake it later.',
    verifyLink: 'Verify with a standardized exam',
    optionalVerify: 'Verifying with a standardized exam is optional — it puts you on the Proficiency board.',
    resultJoined: 'You can now take part in the Activity leaderboard.',
    resultDivision: 'Division',
    viewBoard: 'View the leaderboard',
    viewLevel: 'View your level',
    correctCount: (c: number, n: number) => `${c} / ${n} correct`,
    invalidTitle: 'Invalid result',
    invalidBody: 'You answered hard questions right but many easy ones wrong — it looks random. Please retake it carefully.',
    retry: 'Retake',
    lockedTitle: 'You took the placement quiz recently',
    lockedBody: (date: string) => `You can retake it from ${date}.`,
    retakeOn: (date: string) => `Retake from ${date}`,
    takeQuiz: 'Take the quick placement quiz',
    retakeQuiz: 'Retake the placement quiz',
    error: 'Could not load the placement quiz. Please try again.',
    expired: 'This attempt has expired. Please start again.',
    close: 'Close',
    ctaCardTitle: 'Join a level division',
    ctaCardBody: 'Take the quick placement quiz to set your starting level and join the leaderboard.',
    ctaCardMeta: (n: number) => `About ${placementMinutes(n)} minutes · ${n} questions · not a certification exam`,
    divisionCta: 'Take the placement quiz to join a level division',
    dismiss: 'Later',
    yourPlacement: 'Placement quiz',
    yourDivision: 'Your division',
    promotionTitle: 'You moved up a division',
  },
} as const;

/** "Đã lưu lúc 15:42" — HH:mm in Asia/Ho_Chi_Minh. */
export function placementSavedLine(iso: string | null | undefined, locale: Locale = 'vi'): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  return PLACEMENT_TEXT[locale].saved(time);
}

/** Two ways forward on the Năng lực tab: quick placement (primary) and standardized exam (optional). */
export const PATHS_TEXT = {
  vi: {
    quickTitle: 'Bài xếp lớp nhanh',
    quickMeta: (n: number) => `Khoảng ${placementMinutes(n)} phút · ${n} câu`,
    quickSkills: 'Từ vựng + Ngữ pháp',
    quickBody: 'Ước lượng trình độ ban đầu và tham gia bảng xếp hạng',
    quickCta: 'Làm bài xếp lớp nhanh',
    quickRetake: 'Làm lại bài xếp lớp nhanh',
    quickResume: 'Tiếp tục bài đang làm',
    quickBadge: 'Nhanh nhất',
    stdTitle: 'Bài thi chuẩn hóa',
    stdMeta: 'IELTS / TOEIC / bài thi đầy đủ',
    stdBody: 'Xác thực năng lực chuyên sâu',
    stdCta: 'Thi để xác thực',
    stdVerifyCta: 'Xác thực bằng bài thi chuẩn hóa',
    stdShort: 'Thi chuẩn hóa',
    optional: 'Tùy chọn',
    undetermined: 'Chưa xác định trình độ',
    placementEstimate: 'Ước lượng ban đầu từ bài xếp lớp nhanh.',
    emptyPlaced: (cefr: string) => `Bạn đang ở ${cefr} theo bài xếp lớp nhanh.`,
  },
  en: {
    quickTitle: 'Quick placement',
    quickMeta: (n: number) => `About ${placementMinutes(n)} min · ${n} questions`,
    quickSkills: 'Vocabulary + Grammar',
    quickBody: 'Estimate your starting level and join the leaderboard',
    quickCta: 'Take the quick placement quiz',
    quickRetake: 'Retake the quick placement quiz',
    quickResume: 'Continue your unfinished quiz',
    quickBadge: 'Fastest',
    stdTitle: 'Standardized exam',
    stdMeta: 'IELTS / TOEIC / full exam',
    stdBody: 'In-depth verification',
    stdCta: 'Take an exam to verify',
    stdVerifyCta: 'Verify with a standardized exam',
    stdShort: 'Standardized exam',
    optional: 'Optional',
    undetermined: 'Level not determined',
    placementEstimate: 'Initial estimate from the quick placement quiz.',
    emptyPlaced: (cefr: string) => `You are at ${cefr} according to the quick placement quiz.`,
  },
} as const;

export type PathsMode = 'NONE' | 'PLACEMENT';

/**
 * Which two-path card the Năng lực tab shows (null = none: exam-based states keep their own header, EXCLUDED nothing).
 * NONE = no level at all (quick placement first); PLACEMENT = quick result only (retake + optional verification).
 */
export function proficiencyPathsMode(state: HeaderState | null): PathsMode | null {
  if (!state) return null;
  if (state.kind === 'UNDETERMINED') return 'NONE';
  if (state.kind === 'PLACEMENT') return 'PLACEMENT';
  return null;
}

/** dd/MM/yyyy in Asia/Ho_Chi_Minh (retake dates). */
export function formatVnDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
}

/** Progress bar width (0–100) after `answered` of `total` questions. */
export function placementProgress(answered: number, total: number): number {
  if (!total || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((answered / total) * 100)));
}

/** Keyboard shortcut of a question: 1–4 / a–d = option index 0–3, 0 = "Tôi chưa biết" ('skip'), else null. */
export function placementKeyAnswer(key: string): number | 'skip' | null {
  if (key === '0') return 'skip';
  const digit = ['1', '2', '3', '4'].indexOf(key);
  if (digit >= 0) return digit;
  const letter = ['a', 'b', 'c', 'd'].indexOf(key.toLowerCase());
  return key.length === 1 && letter >= 0 ? letter : null;
}

/** "Từ vựng 14/20 · Ngữ pháp 12/20" on the result screen; null when the API gave no counts. */
export function placementSkillLine(
  r: { vocabulary?: { correct: number; total: number }; grammar?: { correct: number; total: number } } | null | undefined,
  locale: Locale = 'vi',
): string | null {
  if (!r || !r.vocabulary || !r.grammar) return null;
  return PLACEMENT_TEXT[locale].skillScore(`${r.vocabulary.correct}/${r.vocabulary.total}`, `${r.grammar.correct}/${r.grammar.total}`);
}

/** "24 / 30 câu đúng" on the result screen (vocabulary + grammar); null when the API gave no counts. */
export function placementCorrectLine(
  r: { vocabulary?: { correct: number; total: number }; grammar?: { correct: number; total: number } } | null | undefined,
  locale: Locale = 'vi',
): string | null {
  if (!r || !r.vocabulary || !r.grammar) return null;
  return PLACEMENT_TEXT[locale].correctCount(r.vocabulary.correct + r.grammar.correct, r.vocabulary.total + r.grammar.total);
}

/** Splits a prompt at its single blank for rendering: ["She ", " a teacher."]; no blank ⇒ [prompt, '']. */
export function splitPrompt(prompt: string): [string, string] {
  const i = prompt.indexOf('___');
  return i < 0 ? [prompt, ''] : [prompt.slice(0, i), prompt.slice(i + 3)];
}

/** "N người chưa xác định trình độ". */
export function undeterminedCountLine(n: number, locale: Locale = 'vi'): string {
  const v = n.toLocaleString(locale === 'vi' ? 'vi-VN' : 'en-US');
  return locale === 'vi' ? `${v} người chưa xác định trình độ` : `${v} ${n === 1 ? 'learner has' : 'learners have'} no determined level`;
}

export const OTHERS_TEXT = {
  vi: { verifying: 'Đang xác thực', placement: 'Theo bài xếp lớp' },
  en: { verifying: 'Verifying', placement: 'From placement quiz' },
} as const;

/** Anti-sandbagging notice (division raised one step; never lowered). */
export function promotionNotice(toCefr: string | null | undefined, toDivision: string | null | undefined, locale: Locale = 'vi'): string | null {
  if (!toCefr) return null;
  const div = toDivision ? optionLabel(ACTIVITY_SCOPES, toDivision, locale) : null;
  return locale === 'vi'
    ? `Bạn đã được nâng lên ${toCefr}${div ? ` (giải ${div})` : ''} vì phần lớn điểm gần đây đến từ nội dung khó hơn trình độ xếp lớp.`
    : `You were moved up to ${toCefr}${div ? ` (${div} division)` : ''} because most of your recent points came from content above your placement level.`;
}

/** True when a learner has a division level (never defaulted to A1). */
export function hasDivisionLevel(me: { division: string | null } | null | undefined): boolean {
  return !!me && me.division != null;
}

/** Sticky bar line "Giải của bạn: Trung cấp · B1 · Theo bài xếp lớp"; null without a division level. */
export function divisionLine(
  me: { division: string | null; divisionCefr: string | null; divisionSource: string | null } | null | undefined,
  locale: Locale = 'vi',
): string | null {
  if (!me || !me.division) return null;
  const level = levelWithSource(me.divisionCefr, me.divisionSource, locale);
  return `${PLACEMENT_TEXT[locale].yourDivision}: ${scopeName(me.division, locale)}${level ? ` · ${level}` : ''}`;
}

// ---- Gamification UX v2: season label, empty state, motivation line, next-rank progress ---------
// Everything below derives from data the board endpoints already return (no new API, no invented numbers).

/** Backend fallback display name (`LeaderboardDisplayRepository.FALLBACK_NAME`): never used as a rival's name. */
export const FALLBACK_DISPLAY_NAME = 'Người học';

/** Per-learner backend fallback ("Học viên #123", no public name set) or the legacy placeholder. */
export function isFallbackName(name: string | null | undefined): boolean {
  if (!name) return true;
  return name === FALLBACK_DISPLAY_NAME || /^Học viên #\d+$/.test(name);
}

export const UX_TEXT = {
  vi: {
    season: 'Mùa giải',
    week: 'Tuần',
    emptyTitle: 'Bắt đầu hành trình xếp hạng',
    emptyBody: 'Học tập để tên bạn xuất hiện trên bảng xếp hạng.',
    emptyCta: 'Học ngay để ghi điểm',
    leading: 'Bạn đang dẫn đầu bảng xếp hạng',
    topGroup: 'Bạn đang ở nhóm dẫn đầu',
    firstPoints: 'Hoàn thành một bài học để ghi điểm đầu tiên kỳ này',
    filterPeriod: 'Kỳ',
    filterScope: 'Phạm vi',
    filterGroup: 'Kỹ năng',
    showUnranked: 'Xem học viên chưa ghi điểm',
    hideUnranked: 'Thu gọn',
    progressLabel: 'Tiến độ lên hạng',
  },
  en: {
    season: 'Season',
    week: 'Week',
    emptyTitle: 'Start your ranking journey',
    emptyBody: 'Study to get your name on the leaderboard.',
    emptyCta: 'Study now to score',
    leading: 'You are leading the board',
    topGroup: 'You are in the leading group',
    firstPoints: 'Finish a lesson to score your first points this period',
    filterPeriod: 'Period',
    filterScope: 'Scope',
    filterGroup: 'Skill',
    showUnranked: 'Show learners without points',
    hideUnranked: 'Collapse',
    progressLabel: 'Progress to the next rank',
  },
} as const;

/** Href of the empty-state CTA: flashcards are the quickest way to score (FLASHCARD_NEW / REVIEW). */
export const EMPTY_CTA_HREF = '/flashcards';

/** ISO week (Monday start) of `now` in Asia/Ho_Chi_Minh — the same week boundary as the WEEK board. */
export function seasonWeek(now: Date): { week: number; year: number } {
  const vn = new Date(now.getTime() + 7 * 3_600_000); // UTC+7, no DST
  const d = new Date(Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day); // Thursday of this ISO week
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return { week, year: d.getUTCFullYear() };
}

/** Hero badge "Mùa giải · Tuần 40/2026". */
export function seasonLabel(now: Date, locale: Locale = 'vi'): string {
  const { week, year } = seasonWeek(now);
  const t = UX_TEXT[locale];
  return `${t.season} · ${t.week} ${week}/${year}`;
}

/**
 * Share of the way to the next rank: points / (points + pointsToNextRank), 0–100. Rank #1 (no row above) ⇒ 100;
 * unranked ⇒ 0. pointsToNextRank = (points of the row above) − mine + 1 (API), so the bar never reaches 100 early.
 */
export function nextRankProgress(
  me: { rank: number | null; points: number; pointsToNextRank: number | null } | null | undefined,
): number {
  if (!me || me.rank == null) return 0;
  if (me.pointsToNextRank == null) return 100;
  const total = me.points + me.pointsToNextRank;
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((me.points / total) * 100)));
}

export type MotivationTone = 'lead' | 'top' | 'chase' | 'start';

/**
 * One competitive line under "Hạng của bạn". Rival name only when the row ranked `nextRank` is in the loaded
 * top list and has a real display name (never the "Người học" fallback); otherwise the rank number.
 */
export function motivationLine(
  me: {
    userId?: number; rank: number | null; pointsToNextRank: number | null; nextRank?: number | null;
    points?: number; eligibility?: string | null;
  } | null | undefined,
  items: { rank: number; userId: number; displayName: string }[],
  locale: Locale = 'vi',
): { tone: MotivationTone; text: string } | null {
  if (!me) return null;
  const t = UX_TEXT[locale];
  // "first points" only when the selected period really has 0 points (never next to existing XP)
  if (me.rank == null) return eligibilityOf(me) === 'NO_POINTS' ? { tone: 'start', text: t.firstPoints } : null;
  if (me.rank === 1 && me.pointsToNextRank == null) return { tone: 'lead', text: t.leading };
  let chase: string | null = null;
  if (me.pointsToNextRank != null) {
    const target = me.nextRank ?? Math.max(1, me.rank - 1);
    const rival = items.find((i) => i.rank === target && i.userId !== me.userId);
    const name = rival && !isFallbackName(rival.displayName) ? rival.displayName : null;
    chase = locale === 'vi'
      ? `Còn ${me.pointsToNextRank} XP để vượt ${name ?? `hạng ${target}`}`
      : `${me.pointsToNextRank} XP to pass ${name ?? `rank ${target}`}`;
  }
  if (me.rank <= 3) return { tone: 'top', text: chase ? `${t.topGroup} · ${chase}` : t.topGroup };
  return chase ? { tone: 'chase', text: chase } : null;
}

// ---- Echo Hall of Champions (2026-10-30): the hall's own words (presentation only) -----------------------------------

export const HALL_TEXT = {
  vi: {
    hallName: 'Echo Hall of Champions',
    lead: 'Nơi vinh danh những học viên chăm chỉ và tiến bộ nhất của English Coach.',
    modeLabel: 'Chế độ xếp hạng',
    achievementTitle: 'Thành tích của bạn',
    periodXp: 'XP kỳ này',
    lifetimeXp: 'Tổng tích lũy',
    rank: 'Hạng',
    emptyHall: 'Sảnh vinh danh đang chờ nhà vô địch đầu tiên',
    champion: 'Quán quân',
    rollTitle: 'Bảng vinh danh',
    colRank: 'Hạng',
    colLearner: 'Học viên',
    colPoints: 'Điểm',
    colLevel: 'Trình độ',
    seasonInfo: 'Thông tin kỳ',
    periodRange: 'Thời gian',
    participants: 'Người tham gia',
    filters: 'Bộ lọc bảng xếp hạng',
    rollEmpty: 'Chưa có học viên nào ngoài bục vinh danh.',
    levelBoard: 'Bảng năng lực',
  },
  en: {
    hallName: 'Echo Hall of Champions',
    lead: 'Where English Coach celebrates its most dedicated and improving learners.',
    modeLabel: 'Ranking mode',
    achievementTitle: 'Your achievements',
    periodXp: 'XP this period',
    lifetimeXp: 'All-time XP',
    rank: 'Rank',
    emptyHall: 'The Hall awaits its first champion',
    champion: 'Champion',
    rollTitle: 'Roll of honour',
    colRank: 'Rank',
    colLearner: 'Learner',
    colPoints: 'Points',
    colLevel: 'Level',
    seasonInfo: 'This period',
    periodRange: 'Dates',
    participants: 'Participants',
    filters: 'Leaderboard filters',
    rollEmpty: 'No learners beyond the podium yet.',
    levelBoard: 'Proficiency board',
  },
} as const;

/** The signed-in learner's own name for the hall: never an e-mail address (same rule as the board's public names). */
export function publicSelfName(name: string | null | undefined): string | null {
  if (!name) return null;
  const cleaned = name
    .replace(/\(?\s*[^\s()<>@]+@[^\s()<>@]+\s*\)?/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–·|]+|[\s\-–·|]+$/g, '')
    .trim();
  return cleaned || null;
}
