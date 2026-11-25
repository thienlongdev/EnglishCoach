/**
 * Echo Study Space — Personal Life-Simulation Routine and Orientation Controller.
 * Connects room exploration with real study habits (desk preparation, room care, Focus sessions, reading/modules).
 * Account-scoped in localStorage; zero network or AI calls; supports both Guided Play and Free Exploration.
 */

export type StudyPlayStyle = 'guided' | 'free';
export type RoutineStepId = 'workspace' | 'care' | 'focus' | 'learn';

export interface RoutineProgressState {
  version: 1;
  onboarded: boolean;
  playStyle: StudyPlayStyle;
  day: string;
  completed: RoutineStepId[];
  visits: number;
  lastSeenAt: number;
}

export interface LiveRoutineSignals {
  atDesk: boolean;
  lampLit: boolean;
  windowFresh: boolean;
  didCareAction: boolean;
  focusActiveOrDone: boolean;
  engagedLearning: boolean;
}

export interface RoutineStepDef {
  id: RoutineStepId;
  titleVi: string;
  titleEn: string;
  hintVi: string;
  hintEn: string;
  benefitVi: string;
  benefitEn: string;
  actionLabelVi?: string;
  actionLabelEn?: string;
}

export const ROUTINE_STEPS: readonly RoutineStepDef[] = [
  {
    id: 'workspace',
    titleVi: 'Chuẩn bị góc học tập',
    titleEn: 'Prepare your study desk',
    hintVi: 'Đi tới bàn học và nhấn E để ngồi vào ghế, bật đèn bàn hoặc mở rèm đón sáng.',
    hintEn: 'Walk to your desk and press E to sit down, switch on a lamp, or open the curtains.',
    benefitVi: 'Tạo tư thế sẵn sàng trước khi bước vào phiên học.',
    benefitEn: 'Sets a calm physical anchor before studying.',
    actionLabelVi: 'Vào bàn học',
    actionLabelEn: 'Go to desk',
  },
  {
    id: 'focus',
    titleVi: 'Khởi động phiên Tập trung',
    titleEn: 'Start a Focus session',
    hintVi: 'Nhấn F hoặc mở máy tính trên bàn để bật Đồng hồ tập trung Pomodoro.',
    hintEn: 'Press F or use your desk computer to start a Pomodoro Focus timer.',
    benefitVi: 'Ghi nhận thời gian tập trung thực tế vào chuỗi học tập của bạn.',
    benefitEn: 'Logs real focused time toward your study streak.',
    actionLabelVi: 'Bật Tập trung',
    actionLabelEn: 'Open Focus',
  },
  {
    id: 'learn',
    titleVi: 'Đọc sách hoặc mở bài học',
    titleEn: 'Read or practice English',
    hintVi: 'Đến kệ sách nhấn E để mở sách, hoặc chọn Thư viện Đọc ngay trong phòng.',
    hintEn: 'Approach the bookshelf and press E to read, or open Reading inside your room.',
    benefitVi: 'Kết nối trực tiếp không gian sống với tài liệu tiếng Anh của bạn.',
    benefitEn: 'Connects your personal room directly to English materials.',
    actionLabelVi: 'Mở Thư viện Đọc',
    actionLabelEn: 'Open Reading',
  },
  {
    id: 'care',
    titleVi: 'Chăm sóc không gian sống',
    titleEn: 'Care for your room',
    hintVi: 'Dùng chổi hoặc cây lau nhà trên giá để dọn phòng, pha một tách trà hoặc tưới cây.',
    hintEn: 'Use the broom or mop from the rack to tidy up, brew tea, or water your plant.',
    benefitVi: 'Giữ căn phòng sạch thoáng và duy trì thói quen sinh hoạt đều đặn.',
    benefitEn: 'Keeps your personal corner clean and welcoming.',
  },
];

const VALID_STEPS = new Set<RoutineStepId>(['workspace', 'focus', 'learn', 'care']);

export function todayIso(now = Date.now()): string {
  const d = new Date(now);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function studyRoutineKey(account: string | number | null | undefined): string {
  const clean = String(account ?? '').replace(/[^\w-]/g, '');
  return `ec_study_sim:v1:${clean ? `u${clean}` : 'guest'}`;
}

export function defaultRoutineState(now = Date.now()): RoutineProgressState {
  return {
    version: 1,
    onboarded: false,
    playStyle: 'guided',
    day: todayIso(now),
    completed: [],
    visits: 0,
    lastSeenAt: now,
  };
}

export function normalizeRoutineState(raw: unknown, now = Date.now()): RoutineProgressState {
  const today = todayIso(now);
  if (!raw || typeof raw !== 'object') return defaultRoutineState(now);
  const v = raw as Partial<RoutineProgressState>;
  const sameDay = typeof v.day === 'string' && v.day === today;
  const completed: RoutineStepId[] = [];
  if (sameDay && Array.isArray(v.completed)) {
    for (const item of v.completed) {
      if (VALID_STEPS.has(item as RoutineStepId) && !completed.includes(item as RoutineStepId)) {
        completed.push(item as RoutineStepId);
      }
    }
  }
  return {
    version: 1,
    onboarded: v.onboarded === true,
    playStyle: v.playStyle === 'free' ? 'free' : 'guided',
    day: today,
    completed,
    visits: typeof v.visits === 'number' && Number.isFinite(v.visits) ? Math.max(0, Math.floor(v.visits)) : 0,
    lastSeenAt: typeof v.lastSeenAt === 'number' && Number.isFinite(v.lastSeenAt) ? v.lastSeenAt : now,
  };
}

export function readRoutineState(key: string, now = Date.now()): RoutineProgressState {
  if (typeof window === 'undefined') return defaultRoutineState(now);
  try {
    const raw = localStorage.getItem(key);
    return raw ? normalizeRoutineState(JSON.parse(raw), now) : defaultRoutineState(now);
  } catch {
    return defaultRoutineState(now);
  }
}

export function writeRoutineState(key: string, state: RoutineProgressState): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(key, JSON.stringify(state));
  } catch {
    // Storage unavailable: keep session state in memory.
  }
}

export function evaluateSatisfiedSteps(signals: LiveRoutineSignals): RoutineStepId[] {
  const out: RoutineStepId[] = [];
  if (signals.atDesk || signals.lampLit || signals.windowFresh) out.push('workspace');
  if (signals.focusActiveOrDone) out.push('focus');
  if (signals.engagedLearning) out.push('learn');
  if (signals.didCareAction) out.push('care');
  return out;
}

export function greetingForHour(hour: number, vi: boolean, returning: boolean): string {
  if (!returning) {
    return vi ? 'Chào mừng đến Không gian học tập' : 'Welcome to your Study Space';
  }
  if (hour >= 5 && hour < 12) return vi ? 'Chào buổi sáng · Góc học tập của bạn' : 'Good morning · Your study corner';
  if (hour >= 12 && hour < 18) return vi ? 'Chào buổi chiều · Tiếp tục nhịp học' : 'Good afternoon · Continue your rhythm';
  return vi ? 'Buổi tối yên tĩnh · Góc học tập của bạn' : 'Quiet evening · Your study corner';
}
