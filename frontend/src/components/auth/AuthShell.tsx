'use client';

import React, { useEffect } from 'react';
import Link from 'next/link';
import { preload } from 'react-dom';
import { ArrowLeft, Layers3, Route, Gift, UsersRound } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { BrandWhaleIcon } from '@/components/common/BrandWhaleIcon';
import { AuthScene } from './AuthScene';
import { AuthOcean } from './ocean/AuthOcean';
import type { MascotState } from './AuthEchoMascot';
import s from './authGlass.module.css';
import { echoSrc } from '@/lib/brand/echoCharacters';
import { journeyActive, journeyGo } from '@/lib/journey/journey';
import { AUTH_STILLS } from '@/lib/journey/stills';

interface AuthShellProps {
  children: React.ReactNode;
  /** Which story the page tells: sign-in (day sea) or registration (dawn sea). Other auth views use the sign-in story. */
  variant?: 'login' | 'register';
  /** What the form reports to Echo (focus, show password, sending, success, error). */
  mood?: MascotState;
}

type Value = { tone: string; icon: React.ReactNode; title: [string, string]; text: [string, string] };

// Only real product facts: the Learning Path, Echo (the AI coach), the four skills + IELTS / TOEIC practice, the free daily
// AI allowance, the Community. No user counts, ratings or promises.
const STORY: Record<'login' | 'register', { chip: [string, string]; lead: [string, string]; accent: [string, string]; tail: [string, string]; values: Value[] }> = {
  login: {
    chip: ['Chào mừng trở lại', 'Welcome back'],
    lead: ['Cùng Echo tiếp tục hành trình chinh phục ', 'Continue your journey with Echo to master '],
    accent: ['tiếng Anh', 'English'],
    tail: [' của bạn', ''],
    values: [
      { tone: 'path', icon: <Route size={22} strokeWidth={2.2} />, title: ['Lộ trình học của riêng bạn', 'Your own learning path'], text: ['Nhiệm vụ mỗi ngày theo mục tiêu bạn đặt', 'Daily tasks shaped by the goal you set'] },
      { tone: 'echo', icon: <BrandWhaleIcon clean size="sm" className="h-7 w-7" priority />, title: ['Echo luôn đồng hành', 'Echo by your side'], text: ['Hỏi Echo khi gặp từ khó, câu khó', 'Ask Echo whenever a word or sentence is hard'] },
      { tone: 'skills', icon: <Layers3 size={22} strokeWidth={2.2} />, title: ['Đủ bốn kỹ năng', 'All four skills'], text: ['Nghe · Nói · Đọc · Viết và thi thử IELTS, TOEIC', 'Listening · Speaking · Reading · Writing, IELTS and TOEIC practice'] },
    ],
  },
  register: {
    chip: ['Tham gia cùng Echo', 'Join Echo'],
    lead: ['Tạo tài khoản miễn phí, bắt đầu hành trình tiếng Anh ', 'Create a free account and start your English journey '],
    accent: ['ngay hôm nay', 'today'],
    tail: ['', ''],
    values: [
      { tone: 'free', icon: <Gift size={22} strokeWidth={2.2} />, title: ['Bắt đầu miễn phí', 'Start for free'], text: ['Mỗi ngày đều có lượt dùng AI miễn phí', 'Free AI uses every day'] },
      { tone: 'path', icon: <Route size={22} strokeWidth={2.2} />, title: ['Lộ trình học cá nhân hóa', 'A personal learning path'], text: ['Theo trình độ và mục tiêu của bạn', 'Built around your level and your goal'] },
      { tone: 'people', icon: <UsersRound size={22} strokeWidth={2.2} />, title: ['Cộng đồng học viên', 'A learner community'], text: ['Chia sẻ, hỏi đáp và tiến bộ cùng nhau', 'Share, ask and improve together'] },
    ],
  },
};

export function AuthShell({ children, variant = 'login', mood = 'idle' }: AuthShellProps) {
  const { locale } = useLanguage();
  const vi = locale === 'vi';
  const pick = (pair: [string, string]) => (vi ? pair[0] : pair[1]);
  const story = STORY[variant];
  const scene = variant === 'register' ? 'dawn' : 'day';
  // The world's first paint comes with the HTML, not after the stylesheet.
  preload(AUTH_STILLS[scene].wide, { as: 'image', fetchPriority: 'high', media: '(min-width: 900px) and (min-aspect-ratio: 95/100)' });
  preload(AUTH_STILLS[scene].tall, { as: 'image', fetchPriority: 'high', media: '(max-width: 899.98px), (max-aspect-ratio: 95/100)' });
  // Home through the passage; a modified click (new tab, new window) stays a plain link.
  const goHome = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    if (journeyActive() || journeyGo('/')) event.preventDefault();
  };

  // The sign-in pages have no top bar, so they apply the learner's saved theme themselves (same rule as TopNavbar).
  useEffect(() => {
    try {
      const saved = localStorage.getItem('theme');
      const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.classList.toggle('dark', saved === 'dark' || (!saved && prefersDark));
    } catch {
      // ignore
    }
  }, []);

  return (
    <div className={s.shell} data-scene={scene} data-purpose="auth-standalone-shell">
      {/* The CSS world paints first (server markup, no-WebGL fallback); the living 3D ocean takes over above it. */}
      <AuthScene scene={scene} mood={mood} />
      <AuthOcean sky={scene} mood={mood} />

      <header className={s.top}>
        <Link href="/" onClick={goHome} className={s.brand} aria-label="English Coach">
          <span className={s.brandMark} aria-hidden="true">
            {/* eslint-disable-next-line @next/next/no-img-element -- the official small brand asset (AGENTS §16) */}
            <img src={echoSrc('official', 34)} alt="" width={34} height={34} />
          </span>
          <span>
            <span className={s.brandName}>EnglishCoach</span>
            <span className={s.brandTag}>{vi ? 'Lộ trình bứt phá tiếng Anh' : 'Your English breakthrough path'}</span>
          </span>
        </Link>
        <Link href="/" onClick={goHome} className={s.homeLink}>
          <ArrowLeft size={15} strokeWidth={2.4} aria-hidden="true" />
          <span>{vi ? 'Quay về trang chủ' : 'Back to home'}</span>
        </Link>
      </header>

      <main className={s.main}>
        <section className={s.story} aria-labelledby="auth-story-title">
          <span className={s.chip}>
            <span className={s.chipMark} aria-hidden="true"><BrandWhaleIcon clean size="xs" className="h-4 w-4" priority /></span>
            {pick(story.chip)}
          </span>
          <h1 id="auth-story-title" className={s.headline}>
            {pick(story.lead)}<span className={s.accent}>{pick(story.accent)}</span>{pick(story.tail)}
          </h1>
          <ul className={s.values}>
            {story.values.map((value) => (
              <li key={value.tone} className={s.value} data-tone={value.tone}>
                <span className={s.valueIcon} aria-hidden="true">{value.icon}</span>
                <span>
                  <span className={s.valueTitle}>{pick(value.title)}</span>
                  <span className={s.valueText}>{pick(value.text)}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>

        <div className={s.formCol}>{children}</div>
      </main>

      <footer className={s.foot}>© {new Date().getFullYear()} English Coach. All rights reserved.</footer>
    </div>
  );
}

export default AuthShell;
