'use client';

import React, { useState, useEffect, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { AuthShell } from '@/components/auth/AuthShell';
import { AuthCard } from '@/components/auth/AuthCard';
import { AuthTabs, AuthTabType } from '@/components/auth/AuthTabs';
import type { MascotState } from '@/components/auth/AuthEchoMascot';
import { LoginForm } from '@/components/auth/LoginForm';
import { RegisterForm } from '@/components/auth/RegisterForm';
import { ForgotPasswordForm } from '@/components/auth/ForgotPasswordForm';
import { GoogleLinkState } from '@/components/auth/GoogleLinkState';
import authStyles from '@/components/auth/authGlass.module.css';
import { journeyActive } from '@/lib/journey/journey';
import { sanitizeLocalPath } from '@/lib/sanitize-local-path';

interface AuthPageViewProps {
  defaultTab?: AuthTabType;
  defaultViewState?: 'auth' | 'forgot' | 'google-link';
}

export function AuthPageView({ defaultTab = 'login', defaultViewState = 'auth' }: AuthPageViewProps) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { data: session, status } = useSession();

  const modeParam = searchParams.get('mode');
  const linkRequiredParam = searchParams.get('linkRequired');
  const ticketParam = searchParams.get('ticket') || '';
  const emailParam = searchParams.get('email') || '';
  const fromParam = searchParams.get('from');
  const isFromProfile = fromParam === 'profile';
  const callbackUrlParam = searchParams.get('callbackUrl') || '/dashboard';

  // Safe open redirect guard
  const safeCallbackUrl = sanitizeLocalPath(callbackUrlParam, '/dashboard');

  const [activeTab, setActiveTab] = useState<AuthTabType>(
    modeParam === 'register' ? 'register' : modeParam === 'login' ? 'login' : defaultTab
  );
  const [viewState, setViewState] = useState<'auth' | 'forgot' | 'google-link'>(
    linkRequiredParam === 'true' && ticketParam
      ? 'google-link'
      : modeParam === 'forgot'
      ? 'forgot'
      : defaultViewState
  );
  const [mascotState, setMascotState] = useState<MascotState>('idle');

  // If already authenticated, redirect to destination (except when actively in forgot-password flow)
  useEffect(() => {
    // A journey that is already on its way there does the navigation itself.
    if (status === 'authenticated' && session?.user && viewState !== 'forgot' && !journeyActive()) {
      router.replace(safeCallbackUrl);
    }
  }, [status, session, router, safeCallbackUrl, viewState]);

  // Sync tab with query param
  useEffect(() => {
    if (modeParam === 'register' && activeTab !== 'register') {
      setActiveTab('register');
      setViewState('auth');
    } else if (modeParam === 'login' && activeTab !== 'login') {
      setActiveTab('login');
      setViewState('auth');
    } else if (modeParam === 'forgot') {
      setViewState('forgot');
    }
  }, [modeParam]);

  const handleTabChange = (tab: AuthTabType) => {
    setActiveTab(tab);
    setViewState('auth');
    setMascotState('idle');

    // Update query params while preserving callbackUrl
    const params = new URLSearchParams(searchParams.toString());
    params.set('mode', tab);
    router.replace(`/login?${params.toString()}`, { scroll: false });
  };

  const handleSwitchToRegister = () => {
    handleTabChange('register');
  };

  const handleSwitchToLogin = () => {
    handleTabChange('login');
  };

  const handleOpenForgotPassword = () => {
    setViewState('forgot');
    setMascotState('idle');
  };

  const handleBackToLoginFromForgot = () => {
    if (isFromProfile || status === 'authenticated') {
      router.replace('/profile');
      return;
    }
    setViewState('auth');
    setActiveTab('login');
    setMascotState('idle');
    const params = new URLSearchParams(searchParams.toString());
    params.set('mode', 'login');
    router.replace(`/login?${params.toString()}`, { scroll: false });
  };

  const handleCancelGoogleLink = () => {
    setViewState('auth');
    setActiveTab('login');
    setMascotState('idle');
    const params = new URLSearchParams(searchParams.toString());
    params.delete('linkRequired');
    params.delete('ticket');
    params.delete('email');
    router.replace(`/login?${params.toString()}`, { scroll: false });
  };

  return (
    <AuthShell variant={viewState === 'auth' ? activeTab : 'login'} mood={mascotState}>
      <AuthCard>
        {viewState === 'auth' && (
          <div className="space-y-6">
            {/* Login / Register Segmented Tabs */}
            <AuthTabs activeTab={activeTab} onChange={handleTabChange} />

            {/* Active Form */}
            {activeTab === 'login' ? (
              <LoginForm
                callbackUrl={safeCallbackUrl}
                onForgotPassword={handleOpenForgotPassword}
                onSwitchToRegister={handleSwitchToRegister}
                onMascotStateChange={setMascotState}
              />
            ) : (
              <RegisterForm
                callbackUrl={safeCallbackUrl}
                onSwitchToLogin={handleSwitchToLogin}
                onMascotStateChange={setMascotState}
              />
            )}
          </div>
        )}

        {viewState === 'forgot' && (
          <ForgotPasswordForm
            onBackToLogin={handleBackToLoginFromForgot}
            onMascotStateChange={setMascotState}
            initialEmail={session?.user?.email || emailParam || ''}
            readOnlyEmail={Boolean((isFromProfile || status === 'authenticated') && session?.user?.email)}
            backButtonLabel={isFromProfile || status === 'authenticated' ? 'Quay lại hồ sơ' : undefined}
          />
        )}

        {viewState === 'google-link' && (
          <GoogleLinkState
            email={emailParam}
            ticket={ticketParam}
            callbackUrl={safeCallbackUrl}
            onCancel={handleCancelGoogleLink}
            onMascotStateChange={setMascotState}
          />
        )}
      </AuthCard>
    </AuthShell>
  );
}

/** Server-rendered stand-in while the search parameters resolve: the same scene and card, an empty form. */
export function AuthLoading({ variant }: { variant: 'login' | 'register' }) {
  return (
    <AuthShell variant={variant}>
      <AuthCard>
        <div className={authStyles.skeleton} role="status" aria-label="Đang tải" />
      </AuthCard>
    </AuthShell>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<AuthLoading variant="login" />}>
      <AuthPageView defaultTab="login" />
    </Suspense>
  );
}
