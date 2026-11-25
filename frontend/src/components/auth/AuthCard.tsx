'use client';

import React from 'react';
import s from './authGlass.module.css';

interface AuthCardProps {
  children: React.ReactNode;
  className?: string;
}

/** The raised glass form card of the sign-in world (styles: authGlass.module.css `.card`). */
export function AuthCard({ children, className = '' }: AuthCardProps) {
  return (
    <div className={`${s.card} ${className}`} data-purpose="auth-card">
      {children}
    </div>
  );
}

export default AuthCard;
