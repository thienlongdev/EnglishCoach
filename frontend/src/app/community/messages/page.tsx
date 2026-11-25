'use client';

import React, { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import { AuthGuard } from '@/components/common/AuthGuard';
import { useLanguage } from '@/context/LanguageContext';

const EchoMessenger = dynamic(() => import('@/components/messenger/EchoMessenger'), { ssr: false });

/**
 * The Messenger takes the whole workspace area beside the sidebar and under the top bar (64 px): no column width of its own, so it widens when the sidebar folds.
 * It lays its panes out by the width it receives (a container query), not by the window's.
 */
function Messages() {
  const { locale } = useLanguage(), vi = locale === 'vi';
  const params = useSearchParams(), conversation = params.get('c'), view = params.get('view');
  return <div className="flex h-[calc(100dvh-64px)] w-full min-w-0 flex-col p-2 sm:p-3" data-testid="msgr-page">
    <div className="min-h-0 flex-1"><EchoMessenger initial={conversation} back={{ href: '/community', label: vi ? 'Về Cộng đồng' : 'Back to Community' }}
      initialView={view === 'friends' || view === 'requests' || view === 'search' ? view : null} /></div>
  </div>;
}

export default function MessagesPage() {
  return <AuthGuard><Suspense fallback={null}><Messages /></Suspense></AuthGuard>;
}
