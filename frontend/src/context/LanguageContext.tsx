'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { usePathname } from 'next/navigation';
import { UI_LABELS, SupportedLocale } from '@/lib/exams/labels';

export type TranslationDict = typeof UI_LABELS['vi'];

export type TranslatorFunction = TranslationDict & {
  (key: string, fallback?: string): string;
};

function createTranslator(locale: SupportedLocale): TranslatorFunction {
  const dict = UI_LABELS[locale] || UI_LABELS.vi;
  const fn = (key: string, fallback?: string): string => {
    if (key in dict && typeof (dict as any)[key] === 'string') {
      return (dict as any)[key];
    }
    return fallback || key;
  };
  return Object.assign(fn, dict);
}

const FALLBACK_TRANSLATOR = createTranslator('vi');
const NOOP_SET_LOCALE = () => { };
const FALLBACK_LANGUAGE_VALUE: LanguageContextValue = {
  locale: 'vi',
  language: 'vi',
  setLocale: NOOP_SET_LOCALE,
  setLanguage: NOOP_SET_LOCALE,
  t: FALLBACK_TRANSLATOR,
};

interface LanguageContextValue {
  locale: SupportedLocale;
  language: SupportedLocale;
  setLocale: (locale: SupportedLocale) => void;
  setLanguage: (locale: SupportedLocale) => void;
  t: TranslatorFunction;
}

const LanguageContext = createContext<LanguageContextValue | undefined>(undefined);

export const LanguageProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // Native Vietnamese-First UI
  const [locale, setLocaleState] = useState<SupportedLocale>('vi');
  const pathname = usePathname();
  useEffect(() => {
    const vietnamese = pathname === '/' || pathname?.startsWith('/echo-anywhere') || pathname?.startsWith('/huong-dan');
    document.documentElement.lang = vietnamese ? 'vi' : locale;
  }, [pathname, locale]);

  useEffect(() => {
    try {
      // Clear any residual googtrans cookie or storage from former runtime injection
      if (typeof document !== 'undefined') {
        document.cookie = 'googtrans=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;';
        document.cookie = 'googtrans=; expires=Thu, 01 Jan 1970 00:00:00 UTC; domain=' + window.location.hostname + '; path=/;';
      }
      localStorage.removeItem('googtrans');
      sessionStorage.removeItem('googtrans');

      const saved = localStorage.getItem('preferred_locale') as SupportedLocale | null;
      if (saved === 'en' || saved === 'vi') {
        setLocaleState(saved);
      }
    } catch {
      // ignore storage errors
    }
  }, []);

  const setLocale = useCallback((newLocale: SupportedLocale) => {
    setLocaleState(newLocale);
    try {
      localStorage.setItem('preferred_locale', newLocale);
    } catch {
      // ignore storage errors
    }
  }, []);

  const t = useMemo(() => createTranslator(locale), [locale]);

  const value = useMemo<LanguageContextValue>(
    () => ({ locale, language: locale, setLocale, setLanguage: setLocale, t }),
    [locale, setLocale, t]
  );

  return (
    <LanguageContext.Provider value={value}>
      {children}
    </LanguageContext.Provider>
  );
};

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) {
    // Fallback if rendered outside LanguageProvider
    return FALLBACK_LANGUAGE_VALUE;
  }
  return context;
}
