'use client';

import React, { useEffect, useRef } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Compass } from 'lucide-react';
import { journeyActive, journeyGo } from '@/lib/journey/journey';
import { BrandWhaleIcon } from '@/components/common/BrandWhaleIcon';
import { EchoStandby } from './EchoStandby';
import { signalCelebrate, signalCta } from './ocean/oceanSignals';
import { OceanReef } from './ocean/OceanReef';
import styles from './landing.module.css';

interface LandingHeroProps {
  /** Echo's still (the 3D Echo is late, being handed over to, or unavailable); null = the 3D Echo alone. */
  echoStill?: 'standby' | 'handoff' | 'still' | null;
}

const PROOF = [
  { value: '4 kỹ năng', label: 'Nghe • Nói • Đọc • Viết', tone: 'text-white' },
  { value: 'TOEIC và IELTS', label: 'Lộ trình và đề thi thử', tone: 'text-cyan-300' },
  { value: 'AI Echo', label: 'Góp ý cho từng bài luyện', tone: 'text-indigo-200' },
];

export function LandingHero({ echoStill = null }: LandingHeroProps) {
  const { data: session, status } = useSession();
  const router = useRouter();
  const primaryRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const isAuthenticated = status === 'authenticated' && !!session?.user;

  // The title's light only moves while someone can see it.
  useEffect(() => {
    const title = titleRef.current;
    if (!title) return;
    const watch = new IntersectionObserver(([entry]) => {
      title.dataset.flowing = entry.isIntersecting ? '1' : '0';
    });
    watch.observe(title);
    return () => watch.disconnect();
  }, []);

  // Through the passage (10 §BK): Echo swims out and the next place opens. A second press changes nothing; without the host the plain navigation still works.
  const go = (to: string) => {
    if (journeyActive() || journeyGo(to)) return;
    router.push(to);
  };

  const handlePrimaryCTA = () => {
    signalCelebrate();
    go(isAuthenticated ? '/dashboard' : `/login?mode=register&callbackUrl=${encodeURIComponent('/dashboard')}`);
  };

  const handleSignIn = () => {
    signalCelebrate();
    go(isAuthenticated ? '/dashboard' : `/login?mode=login&callbackUrl=${encodeURIComponent('/dashboard')}`);
  };

  const scrollToFeatures = () => {
    document.getElementById('features-section')?.scrollIntoView({ behavior: 'smooth' });
  };

  const ctaOn = () => signalCta(primaryRef.current, true);
  const ctaOff = () => signalCta(null, false);

  return (
    <section
      className="relative flex min-h-[100svh] w-full flex-col overflow-hidden"
      data-purpose="public-landing-hero"
    >
      {/* Echo's water in the hero: near pass high above the title, far pass behind it. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 bottom-[14%] sm:inset-x-[3%] lg:inset-x-[6%]"
        data-whale-lane="hero"
        data-whale-path="orbit"
        data-whale-size="270,230,150"
        data-whale-v="0.17,0.56"
        data-whale-amp="0.4"
        data-whale-period="22"
        data-whale-say="Rảnh rỗi thì cùng Echo học tiếng Anh nhé bạn!"
      />

      {/* Foreground reef framing the lower corners, and a pool of deeper water that keeps the copy crisp. */}
      <OceanReef side="left" seed={11} className="h-[34vh] max-h-[340px] w-[46vw] max-w-[600px] opacity-80 sm:opacity-100" />
      <OceanReef side="right" seed={23} className="h-[28vh] max-h-[280px] w-[40vw] max-w-[500px] opacity-80 sm:opacity-100" />
      <div aria-hidden="true" className={styles.readPool} />

      {/* A soft band of deeper water under the top bar keeps the wordmark legible beneath the bright surface. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-[#031038]/50 via-[#031038]/20 to-transparent" />

      {/* Top bar */}
      <header className="relative z-10 mx-auto flex w-full max-w-7xl items-center justify-between px-4 pt-5 sm:px-6 lg:px-8">
        <button
          type="button"
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          className={`group flex items-center gap-2.5 rounded-xl ${styles.fadeUp}`}
          aria-label="EnglishCoach — về đầu trang"
        >
          {/* The transparent mark, lifted off the water by a soft glow — never the boxed app-icon frame. */}
          <BrandWhaleIcon variant="clean" size="md" priority className="h-10 w-10 [filter:drop-shadow(0_2px_5px_rgba(3,16,52,0.65))_drop-shadow(0_0_12px_rgba(125,211,252,0.35))] sm:h-11 sm:w-11" />
          <span className="text-base font-black tracking-tight text-white drop-shadow-[0_1px_10px_rgba(3,16,52,0.75)] sm:text-lg">
            English<span className="bg-gradient-to-r from-cyan-200 to-sky-100 bg-clip-text text-transparent">Coach</span>
          </span>
        </button>
        <button
          type="button"
          onClick={handleSignIn}
          className={`rounded-xl border border-white/20 bg-[#06194a]/55 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-[#020c28]/30 backdrop-blur-md transition-colors hover:border-white/25 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 ${styles.fadeUp}`}
          style={{ ['--d' as string]: '120ms' }}
        >
          {isAuthenticated ? 'Vào bàn học' : 'Đăng nhập'}
        </button>
      </header>

      {echoStill && <EchoStandby state={echoStill} />}

      <div className="relative mx-auto flex w-full max-w-6xl flex-1 flex-col items-center justify-end px-4 pb-[clamp(2rem,6vh,4.5rem)] pt-[clamp(9.5rem,27vh,17rem)] text-center sm:px-6">
        <span
          className={`inline-flex items-center gap-2 rounded-full border border-indigo-300/25 bg-indigo-500/10 px-3.5 py-1.5 text-xs font-semibold text-indigo-100 backdrop-blur-md ${styles.fadeUp}`}
          style={{ ['--d' as string]: '80ms' }}
        >
          <span className={`h-1.5 w-1.5 rounded-full bg-cyan-300 ${styles.pulseDot}`} aria-hidden="true" />
          Nền tảng học tiếng Anh ứng dụng AI
        </span>

        <h1 ref={titleRef} className={`${styles.heroTitle} mt-6 text-balance text-white`}>
          <span className={styles.line}>
            <span className={styles.lineInner} style={{ ['--d' as string]: '140ms' }}>
              <span className={styles.flow}>Hành trình tiếng Anh</span>
            </span>
          </span>
          <span className={styles.line}>
            <span className={styles.lineInner} style={{ ['--d' as string]: '260ms' }}>
              <span className={styles.flow} style={{ ['--flow-from' as string]: '-34%' }}>từ bỡ ngỡ đến </span>
              <span className={styles.shimmer}>bứt phá</span>
            </span>
          </span>
        </h1>

        <p
          className={`mt-6 max-w-[54ch] text-balance text-[15px] leading-relaxed text-slate-300 sm:text-lg ${styles.fadeUp}`}
          style={{ ['--d' as string]: '480ms' }}
        >
          Người bạn đồng hành AI dẫn lối hành trình làm chủ tiếng Anh toàn diện — từ phát triển vốn từ, tự tin 4 kỹ năng
          đến chinh phục mục tiêu TOEIC và IELTS mỗi ngày.
        </p>

        <div
          className={`mt-9 flex w-full flex-col items-center justify-center gap-3.5 sm:w-auto sm:flex-row sm:gap-4 ${styles.fadeUp}`}
          style={{ ['--d' as string]: '600ms' }}
        >
          <button
            ref={primaryRef}
            type="button"
            id="hero-primary-cta"
            onClick={handlePrimaryCTA}
            onPointerEnter={ctaOn}
            onPointerLeave={ctaOff}
            onFocus={ctaOn}
            onBlur={ctaOff}
            className="group relative flex w-full items-center justify-center gap-2.5 overflow-hidden rounded-2xl bg-gradient-to-r from-indigo-600 via-indigo-500 to-cyan-500 px-8 py-4 text-base font-bold text-white shadow-[0_18px_50px_-12px_rgba(79,70,229,0.65)] transition-[transform,filter] duration-300 hover:brightness-110 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 focus-visible:ring-offset-2 focus-visible:ring-offset-[#060d27] sm:w-auto"
          >
            <span className="pointer-events-none absolute inset-y-0 -left-1/2 w-1/2 -skew-x-12 bg-gradient-to-r from-transparent via-white/25 to-transparent opacity-0 transition-[transform,opacity] duration-700 group-hover:translate-x-[300%] group-hover:opacity-100 motion-reduce:hidden" />
            <span>{isAuthenticated ? 'Tiếp tục học ngay' : 'Bắt đầu học thử miễn phí'}</span>
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
          </button>

          <button
            type="button"
            onClick={scrollToFeatures}
            className="flex w-full items-center justify-center gap-2 rounded-2xl border border-white/15 bg-white/[0.06] px-6 py-4 text-sm font-semibold text-slate-200 backdrop-blur-md transition-colors hover:border-white/25 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 sm:w-auto"
          >
            <Compass className="h-4 w-4 text-cyan-300" />
            <span>Khám phá tính năng</span>
          </button>
        </div>

        <ul
          className={`mt-12 grid w-full max-w-3xl grid-cols-3 divide-x divide-white/[0.08] border-t border-white/[0.08] pt-6 ${styles.fadeUp}`}
          style={{ ['--d' as string]: '760ms' }}
        >
          {PROOF.map((item) => (
            <li key={item.value} className="flex flex-col items-center gap-1 px-2 sm:px-4">
              <span className={`text-base font-extrabold tracking-tight sm:text-2xl ${item.tone}`}>{item.value}</span>
              <span className="text-[10px] leading-tight text-slate-400 sm:text-xs">{item.label}</span>
            </li>
          ))}
        </ul>

        <span className={`mt-10 hidden lg:block ${styles.cue}`} aria-hidden="true" />
      </div>
    </section>
  );
}
