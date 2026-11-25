'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { Rocket, ArrowRight, CheckCircle } from 'lucide-react';
import { journeyActive, journeyGo } from '@/lib/journey/journey';
import { signalCelebrate, signalCta } from './ocean/oceanSignals';
import { OceanReef } from './ocean/OceanReef';
import styles from './landing.module.css';

export function FinalCTA() {
  const { data: session } = useSession();
  const router = useRouter();
  const isAuthenticated = !!(session && session.user);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  const ctaOn = () => signalCta(primaryRef.current, true);
  const ctaOff = () => signalCta(null, false);

  useEffect(() => {
    const el = cardRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin: '-80px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const handleAction = () => {
    signalCelebrate();
    const to = isAuthenticated ? '/dashboard' : `/login?mode=register&callbackUrl=${encodeURIComponent('/dashboard')}`;
    if (journeyActive() || journeyGo(to)) return;
    router.push(to);
  };

  return (
    <section className="relative overflow-hidden pb-24 pt-44 sm:pt-52" data-purpose="final-cta-section">
      {/* The deep reef: the journey ends among glowing coral. */}
      <OceanReef side="left" variant="final" seed={41} className="h-[220px] w-[46vw] max-w-[520px] opacity-90" />
      <OceanReef side="right" variant="final" seed={57} className="h-[190px] w-[40vw] max-w-[460px] opacity-90" />
      <div className="relative max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Echo's last lap: high above the card, then behind its glass. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-4 -top-36 bottom-0 sm:-top-44"
          data-whale-lane="final"
          data-whale-path="orbit"
          data-whale-size="250,210,150"
          data-whale-v="0.13,0.55"
          data-whale-amp="0.38"
          data-whale-period="20"
          data-whale-say="Hẹn gặp bạn ở bài học đầu tiên nhé!"
        />
        <div
          ref={cardRef}
          className={`${styles.oceanGlassRadiant} rounded-3xl p-8 sm:p-14 text-center space-y-6 overflow-hidden transition-[opacity,transform] duration-[900ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none motion-reduce:opacity-100 motion-reduce:translate-y-0 motion-reduce:scale-100 ${
            inView ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 translate-y-10 scale-[0.97]'
          }`}
        >
          
          {/* Ambient Glow */}
          <div className="absolute top-0 right-1/4 w-80 h-80 rounded-full bg-cyan-400/20 blur-[90px] pointer-events-none" />
          <div className="absolute bottom-0 left-1/4 w-80 h-80 rounded-full bg-indigo-500/20 blur-[90px] pointer-events-none" />

          <div className="relative z-10 max-w-2xl mx-auto space-y-4">
            <span className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-white/10 text-xs font-semibold text-cyan-200 border border-white/20">
              <Rocket className="w-3.5 h-3.5 text-cyan-300" aria-hidden="true" />
              Mặt nước đang chờ bạn
            </span>

            <h2 className="text-3xl sm:text-5xl font-black text-white tracking-tight">
              Chuyến lặn thật bắt đầu từ bài học đầu tiên
            </h2>

            <p className="text-slate-300 text-sm sm:text-base leading-relaxed">
              Mọi thứ bạn vừa thử đều có trong bàn học của bạn: từ vựng, bốn kỹ năng, lộ trình, đề thi IELTS và TOEIC, cùng Echo đi bên cạnh mỗi ngày.
            </p>

            <div className="pt-4 flex flex-col sm:flex-row items-center justify-center gap-4">
              <button
                ref={primaryRef}
                type="button"
                onClick={handleAction}
                onPointerEnter={ctaOn}
                onPointerLeave={ctaOff}
                onFocus={ctaOn}
                onBlur={ctaOff}
                className="w-full sm:w-auto px-8 py-4 rounded-2xl bg-gradient-to-r from-indigo-500 via-indigo-600 to-cyan-500 hover:brightness-110 active:scale-98 text-white font-bold text-base shadow-xl shadow-indigo-600/30 transition-all flex items-center justify-center gap-2 cursor-pointer"
              >
                <span>{isAuthenticated ? 'Vào bàn học ngay' : 'Bắt đầu học miễn phí ngay'}</span>
                <ArrowRight className="w-4 h-4" />
              </button>

              {!isAuthenticated && (
                <button
                  type="button"
                  onClick={() => router.push(`/login?mode=login&callbackUrl=${encodeURIComponent('/dashboard')}`)}
                  className="w-full sm:w-auto px-6 py-4 rounded-2xl bg-white/10 hover:bg-white/15 text-slate-200 hover:text-white font-semibold text-sm transition-all border border-white/15 cursor-pointer"
                >
                  Đăng nhập tài khoản
                </button>
              )}
            </div>

            <div className="pt-4 flex flex-wrap items-center justify-center gap-6 text-xs text-slate-400">
              <span className="flex items-center gap-1.5">
                <CheckCircle className="w-3.5 h-3.5 text-emerald-400" /> Bắt đầu miễn phí
              </span>
              <span className="flex items-center gap-1.5">
                <CheckCircle className="w-3.5 h-3.5 text-emerald-400" /> Có lượt dùng AI miễn phí mỗi ngày
              </span>
              <span className="flex items-center gap-1.5">
                <CheckCircle className="w-3.5 h-3.5 text-emerald-400" /> Học ngay trên trình duyệt
              </span>
            </div>
          </div>

        </div>
      </div>
    </section>
  );
}
