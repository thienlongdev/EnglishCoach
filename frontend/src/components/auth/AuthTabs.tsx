'use client';

import React from 'react';
import { motion } from 'framer-motion';
import { useLanguage } from '@/context/LanguageContext';
import s from './authGlass.module.css';

export type AuthTabType = 'login' | 'register';

interface AuthTabsProps {
  activeTab: AuthTabType;
  onChange: (tab: AuthTabType) => void;
  className?: string;
}

export function AuthTabs({ activeTab, onChange, className = '' }: AuthTabsProps) {
  const { locale } = useLanguage();
  const tabs: Array<[AuthTabType, string]> = [
    ['login', locale === 'vi' ? 'Đăng nhập' : 'Sign In'],
    ['register', locale === 'vi' ? 'Đăng ký' : 'Sign Up'],
  ];

  return (
    <div
      role="tablist"
      aria-label={locale === 'vi' ? 'Phương thức xác thực' : 'Authentication method'}
      className={`${s.tabs} ${className}`}
      data-purpose="auth-tab-switch"
    >
      {tabs.map(([tab, label]) => (
        <button key={tab} type="button" role="tab" aria-selected={activeTab === tab} onClick={() => onChange(tab)} className={s.tab}>
          {activeTab === tab && (
            <motion.span layoutId="activeAuthTabPill" className={s.tabPill} transition={{ type: 'spring', stiffness: 500, damping: 35 }} />
          )}
          {label}
        </button>
      ))}
    </div>
  );
}

export default AuthTabs;
