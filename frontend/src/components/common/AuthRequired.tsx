'use client';

import React from 'react';
import { signIn } from 'next-auth/react';
import { Lock } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';

export interface AuthRequiredProps {
  title?: string;
  description?: string;
  buttonText?: string;
  className?: string;
}

export function AuthRequired({
  title,
  description,
  buttonText,
  className = '',
}: AuthRequiredProps) {
  const { locale } = useLanguage();

  const defaultTitle = locale === 'vi' ? 'Đăng nhập để tiếp tục' : 'Sign in to continue';
  const defaultDescription =
    locale === 'vi'
      ? 'Bạn cần đăng nhập để sử dụng tính năng này.'
      : 'You need to sign in to use this feature.';
  const defaultButtonText = locale === 'vi' ? 'Đăng nhập' : 'Sign in';

  return (
    <div
      data-purpose="auth-required-screen"
      className={`flex flex-col items-center justify-center py-20 sm:py-28 px-4 text-center ${className}`}
    >
      <div className="w-14 h-14 rounded-2xl bg-indigo-50 dark:bg-indigo-950/50 border border-indigo-100 dark:border-indigo-900/60 text-indigo-600 dark:text-indigo-400 flex items-center justify-center mb-4 shadow-xs">
        <Lock className="w-6 h-6" />
      </div>
      <h2 className="ec-wp-plate text-xl sm:text-2xl font-bold text-slate-900 dark:text-white mb-2 tracking-tight">
        {title || defaultTitle}
      </h2>
      <p className="ec-wp-plate text-sm text-slate-500 dark:text-slate-400 mb-6 max-w-sm leading-relaxed">
        {description || defaultDescription}
      </p>
      <button
        type="button"
        onClick={() => signIn()}
        className="rounded-full bg-indigo-600 hover:bg-indigo-700 active:scale-95 px-7 py-2.5 text-sm font-semibold text-white transition-all shadow-sm shadow-indigo-600/25 cursor-pointer"
      >
        {buttonText || defaultButtonText}
      </button>
    </div>
  );
}

export default AuthRequired;
