/**
 * What the browser tab says (owner brief 2026-10-31, 10 §BJ). A pure table used by the server (first paint) and the client.
 * The public landing page is exactly "English Coach"; every other screen is named after what is on it, with no brand suffix and no slogan.
 *
 * `living` says how much the tab may move on that screen:
 *   rich   hubs: the tab lives; the companion may also say a rare word
 *   calm   libraries and practice lists: the tab lives
 *   still  someone is reading a lesson, taking dictation or sitting an exam: nothing moves
 */
export const BRAND_TITLE = 'English Coach';
export const TITLE_MAX = 64;

export type TabLiving = 'rich' | 'calm' | 'still';
export interface PageTitle { title: string; living: TabLiving; landing: boolean }
type Locale = 'vi' | 'en';
type Row = [vi: string, en: string, living: TabLiving];

const ROOT_TABS: Record<string, Row> = {
  dashboard: ['Hôm nay học gì?', 'What to learn today', 'rich'],
  flashcards: ['Ôn tập từ vựng', 'Vocabulary review', 'calm'],
  reading: ['Đọc chuyên sâu', 'Deep reading', 'calm'],
  writing: ['Luyện viết', 'Writing practice', 'calm'],
  speaking: ['Luyện nói', 'Speaking practice', 'calm'],
  leaderboard: ['Bảng xếp hạng', 'Leaderboard', 'rich'],
};

const EXACT: Record<string, Row> = {
  '/dashboard': ROOT_TABS.dashboard,
  '/reading': ROOT_TABS.reading,
  '/writing': ROOT_TABS.writing,
  '/flashcards': ROOT_TABS.flashcards,
  '/leaderboard': ROOT_TABS.leaderboard,
  '/grammar': ['Ngữ pháp', 'Grammar', 'rich'],
  '/listening': ['Thư viện luyện nghe', 'Listening library', 'calm'],
  '/listening/dashboard': ['Thống kê luyện nghe', 'Listening stats', 'calm'],
  '/speaking': ['Luyện nói', 'Speaking practice', 'calm'],
  '/exams': ['Thi thử', 'Mock exams', 'calm'],
  '/exams/profile': ['Hồ sơ đánh giá', 'Assessment profile', 'calm'],
  '/games': ['Thư viện trò chơi', 'Games library', 'rich'],
  '/games/echo-quiz-rush': ['Echo Quiz Rush', 'Echo Quiz Rush', 'still'],
  '/games/echo-spelling': ['Echo Spelling', 'Echo Spelling', 'still'],
  '/games/echo-garden': ['Echo Garden', 'Echo Garden', 'still'],
  '/speaking/arena': ['Speaking Arena', 'Speaking Arena', 'still'],
  '/games/hangman': ['Đoán từ', 'Hangman', 'still'],
  '/games/king-of-english': ['Vua Tiếng Anh', 'King Of English', 'still'],
  '/games/word-chain': ['Nối từ', 'Word Chain', 'still'],
  '/community': ['Cộng đồng', 'Community', 'rich'],
  '/community/messages': ['Tin nhắn', 'Messages', 'calm'],
  '/learning-path': ['Lộ trình học', 'Learning path', 'rich'],
  '/knowledge-universe': ['Vũ trụ tri thức', 'Knowledge universe', 'calm'],
  '/profile': ['Hồ sơ của tôi', 'My profile', 'rich'],
  '/progress': ['Tiến độ học tập', 'Learning progress', 'rich'],
  '/premium': ['Gói Premium', 'Premium', 'rich'],
  '/echo-anywhere': ['Echo Anywhere', 'Echo Anywhere', 'calm'],
  '/huong-dan': ['Hướng dẫn tự học tiếng Anh', 'Hướng dẫn tự học tiếng Anh', 'still'],
  '/huong-dan/nghe-chep-chinh-ta': ['Cách luyện nghe chép chính tả tiếng Anh', 'Cách luyện nghe chép chính tả tiếng Anh', 'still'],
  '/huong-dan/hoc-tu-trong-ngu-canh': ['Cách học từ tiếng Anh trong ngữ cảnh', 'Cách học từ tiếng Anh trong ngữ cảnh', 'still'],
  '/echo-anywhere/connect': ['Kết nối Echo Anywhere', 'Connect Echo Anywhere', 'still'],
  '/music': ['Âm nhạc', 'Music', 'rich'],
  '/study-space': ['Không gian học tập', 'Study space', 'calm'],
  '/study-space/timer': ['Đồng hồ tập trung', 'Focus timer', 'still'],
  '/login': ['Đăng nhập', 'Sign in', 'calm'],
  '/register': ['Đăng ký', 'Create account', 'calm'],
  '/forgot-password': ['Quên mật khẩu', 'Forgot password', 'calm'],
  '/reset-password': ['Đặt lại mật khẩu', 'Reset password', 'calm'],
  '/verify-email': ['Xác minh email', 'Verify email', 'calm'],
};

const PATTERNS: [RegExp, Row][] = [
  [/^\/exams\/[^/]+\/attempts\//, ['Đang làm bài thi', 'Exam in progress', 'still']],
  [/^\/exams\/[^/]+\/practice\/result\//, ['Kết quả luyện đề', 'Practice result', 'still']],
  [/^\/exams\/[^/]+\/practice\//, ['Luyện đề', 'Exam practice', 'still']],
  [/^\/exams\/[^/]+\/results\//, ['Kết quả bài thi', 'Exam result', 'still']],
  [/^\/exams\/[^/]+\/tests\//, ['Thi thử', 'Mock exams', 'calm']],
  [/^\/exams\/toeic/i, ['Thi thử TOEIC', 'TOEIC exams', 'calm']],
  [/^\/exams\/ielts/i, ['Thi thử IELTS', 'IELTS exams', 'calm']],
  [/^\/listening\/[^/]+\/practice/, ['Chép chính tả', 'Dictation', 'still']],
  [/^\/listening\/[^/]+/, ['Bài nghe', 'Listening lesson', 'still']],
  [/^\/speaking\/roleplay\//, ['Hội thoại Role-play', 'Role-play', 'still']],
  [/^\/speaking\/shadowing\//, ['Luyện Shadowing', 'Shadowing', 'still']],
  [/^\/grammar\/(topics|check|practice)/, ['Ngữ pháp', 'Grammar', 'still']],
  [/^\/grammar\//, ['Ngữ pháp', 'Grammar', 'calm']],
  [/^\/admin/, ['Quản trị', 'Administration', 'calm']],
];

export function resolvePageTitle(pathname: string, tab: string | null, locale: Locale): PageTitle {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (path === '/' || path === '') {
    if (!tab || tab === 'landing') return { title: BRAND_TITLE, living: 'calm', landing: true };
    const row = ROOT_TABS[tab];
    return row ? named(row, locale) : { title: BRAND_TITLE, living: 'calm', landing: false };
  }
  if (path.startsWith('/landing-preview')) return { title: BRAND_TITLE, living: 'calm', landing: true };
  const exact = EXACT[path];
  if (exact) return named(exact, locale);
  for (const [pattern, row] of PATTERNS) if (pattern.test(path)) return named(row, locale);
  return { title: BRAND_TITLE, living: 'calm', landing: false };
}

function named(row: Row, locale: Locale): PageTitle {
  return { title: locale === 'en' ? row[1] : row[0], living: row[2], landing: false };
}

/** Long lesson or book titles stay readable; never a broken word plus a mile of tab. */
export function shortTitle(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= TITLE_MAX) return clean;
  const cut = clean.slice(0, TITLE_MAX - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > TITLE_MAX * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
