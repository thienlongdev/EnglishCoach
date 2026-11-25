'use client';

import React from 'react';
import Image from 'next/image';
import { BrandWhaleIcon } from '@/components/common/BrandWhaleIcon';
import { useSession, signIn } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { useLanguage } from '@/context/LanguageContext';
import { Rocket, ArrowRight, Compass, ShieldCheck } from 'lucide-react';

interface LandingNavbarProps {
  onStartLearning?: () => void;
}

export function LandingNavbar({ onStartLearning }: LandingNavbarProps) {
  const { data: session, status } = useSession();
  const { locale, setLocale } = useLanguage();
  const router = useRouter();

  const isAuthenticated = status === 'authenticated' && !!session?.user;

  const scrollToSection = (id: string) => {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth' });
    }
  };

  const handleAuthAction = () => {
    if (isAuthenticated) {
      router.push('/dashboard');
    } else if (onStartLearning) {
      onStartLearning();
    } else {
      router.push(`/login?mode=register&callbackUrl=${encodeURIComponent('/dashboard')}`);
    }
  };

  return (
    <header className="sticky top-0 z-50 w-full backdrop-blur-xl bg-slate-950/70 border-b border-indigo-900/30 transition-colors">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-18 flex items-center justify-between">
        
        {/* Brand Logo with Whale Icon */}
        <div
          onClick={() => router.push('/')}
          className="flex items-center gap-3 cursor-pointer group select-none"
        >
          <div className="group-hover:scale-105 transition-transform shrink-0">
            <BrandWhaleIcon size="md" priority />
          </div>
          <div>
            <span className="text-lg font-black tracking-tight text-white flex items-center gap-1.5">
              English<span className="text-transparent bg-clip-text bg-gradient-to-r from-cyan-300 to-indigo-300">Coach</span>
            </span>
            <span className="block text-[10px] font-mono font-medium text-indigo-300/80 -mt-1 tracking-wider uppercase">
              AI Learning Ecosystem
            </span>
          </div>
        </div>

        {/* Desktop Navigation Links */}
        <nav className="hidden md:flex items-center gap-7 text-sm font-medium text-slate-300">
          <button
            type="button"
            onClick={() => scrollToSection('features-section')}
            className="hover:text-cyan-300 transition-colors cursor-pointer"
          >
            {locale === 'vi' ? 'Tính năng' : 'Features'}
          </button>
          <button
            type="button"
            onClick={() => scrollToSection('speaking-ai-section')}
            className="hover:text-cyan-300 transition-colors cursor-pointer"
          >
            Speaking AI
          </button>
          <button
            type="button"
            onClick={() => scrollToSection('exams-section')}
            className="hover:text-cyan-300 transition-colors cursor-pointer"
          >
            IELTS / TOEIC
          </button>
          <button
            type="button"
            onClick={() => scrollToSection('journey-section')}
            className="hover:text-cyan-300 transition-colors cursor-pointer"
          >
            {locale === 'vi' ? 'Lộ trình học' : 'Roadmap'}
          </button>
        </nav>

        {/* Right Actions: Language Switch & Auth CTA */}
        <div className="flex items-center gap-3">
          {/* Language Switch */}
          <button
            type="button"
            onClick={() => setLocale(locale === 'vi' ? 'en' : 'vi')}
            className="px-2.5 py-1 rounded-xl bg-white/10 hover:bg-white/15 border border-white/15 text-xs font-mono font-semibold text-slate-200 transition-all cursor-pointer"
            title="Đổi ngôn ngữ giao diện"
          >
            {locale.toUpperCase()}
          </button>

          {isAuthenticated ? (
            <button
              type="button"
              onClick={() => router.push('/dashboard')}
              className="px-4 py-2 rounded-xl bg-gradient-to-r from-indigo-600 to-indigo-500 hover:from-indigo-500 hover:to-indigo-400 text-white text-xs font-bold transition-all shadow-md shadow-indigo-600/30 flex items-center gap-2 cursor-pointer"
            >
              <span>{locale === 'vi' ? 'Tiếp tục học' : 'Go to Dashboard'}</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => router.push(`/login?mode=login&callbackUrl=${encodeURIComponent('/dashboard')}`)}
                className="hidden sm:inline-flex px-3.5 py-2 text-xs font-semibold text-slate-200 hover:text-white transition-colors cursor-pointer"
              >
                {locale === 'vi' ? 'Đăng nhập' : 'Sign in'}
              </button>

              <button
                type="button"
                onClick={handleAuthAction}
                className="px-4 py-2 rounded-xl bg-gradient-to-r from-indigo-600 via-indigo-500 to-cyan-500 hover:brightness-110 text-white text-xs font-bold transition-all shadow-lg shadow-indigo-600/25 flex items-center gap-1.5 cursor-pointer"
              >
                <Rocket className="w-3.5 h-3.5 text-cyan-200" aria-hidden="true" />
                <span>{locale === 'vi' ? 'Bắt đầu học' : 'Get Started'}</span>
              </button>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
