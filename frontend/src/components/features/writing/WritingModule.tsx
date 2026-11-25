'use client';

import React from 'react';
import dynamic from 'next/dynamic';
import { useSearchParams, useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { useModuleEntryResource } from '@/hooks/useModuleEntryResource';
import { WRITING_CAPABILITIES_PATH, WRITING_PROFILE_PATH, TRANSLATION_CATALOG_PATH } from '@/services/moduleEntryResources';
import { parseWritingRouteState, buildWritingUrl } from '@/lib/writing/route-state';
import { WritingView, SentenceLabSubView, WritingCapabilities, WritingProfile } from '@/types/writing';
import { WritingStudioHeader } from './WritingStudioHeader';
import { TranslationPractice } from './translation/TranslationPractice';
import { SentenceLab } from './sentence-lab/SentenceLab';
import { WritingCoach } from './coach/WritingCoach';
import { Portfolio } from './portfolio/Portfolio';
import { WritingErrorBoundary } from './shared/WritingErrorBoundary';
import { WritingStudio, StudioLoading, StatePanel, glass, type WritingWorld } from './glass/WritingGlass';
import { SentenceLabErrorBoundary } from './sentence-lab/SentenceLabErrorBoundary';
import { ShieldAlert } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { dispatchEchoModuleReady } from '@/lib/echo/contextBridge';

const TypingPractice = dynamic(() => import('./typing/TypingPractice').then(m => m.TypingPractice));

export const WritingModule: React.FC = () => {
  const { locale, t } = useLanguage();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { data: session, status: authStatus } = useSession();

  const routeState = parseWritingRouteState(searchParams);

  // Independent entry reads: profile never gates the shell or translation catalog.
  const { data: capabilities, error: capabilitiesError } = useModuleEntryResource<WritingCapabilities>(WRITING_CAPABILITIES_PATH);
  useModuleEntryResource<WritingProfile>(WRITING_PROFILE_PATH);
  useModuleEntryResource(TRANSLATION_CATALOG_PATH, routeState.view === 'translation' || routeState.view === 'for-you');

  // Each Writing room is a world of the studio (translation is also the 'for-you' alias).
  const world: WritingWorld = routeState.view === 'sentence-lab' ? 'lab' : routeState.view === 'typing' ? 'typing'
    : routeState.view === 'coach' ? 'coach' : routeState.view === 'portfolio' ? 'portfolio' : 'translation';

  const handleSelectView = (view: WritingView) => {
    const url = buildWritingUrl({ view });
    router.push(url);
  };

  const handleNavigateToTranslation = (sessionId?: string, mode?: string) => {
    const url = buildWritingUrl({
      view: 'translation',
      sessionId: sessionId || undefined,
      mode: mode !== undefined ? mode : routeState.mode
    });
    router.push(url);
  };

  const handleSelectSentenceLabSubView = (subView: SentenceLabSubView, patternCode?: string) => {
    const url = buildWritingUrl({ ...routeState, view: 'sentence-lab', subView, patternCode });
    router.push(url);
  };

  const handleNavigateToCoach = (sessionId?: string, taskId?: string) => {
    const url = buildWritingUrl({
      view: 'coach',
      sessionId: sessionId || undefined,
      taskId: taskId || undefined,
    });
    router.push(url);
  };

  const handleNavigateToSentenceLab = (subView: SentenceLabSubView = 'check', patternCode?: string) => {
    const url = buildWritingUrl({ view: 'sentence-lab', subView, patternCode });
    router.push(url);
  };

  const handleOpenPortfolioSession = (sessionId: string) => {
    const url = buildWritingUrl({ view: 'coach', sessionId });
    router.push(url);
  };

  React.useEffect(() => {
    const onWritingIntent = (event: Event) => {
      const d = (event as CustomEvent<{ room?: string; mode?: string } | undefined>).detail;
      if (!d) return;
      const room = d.room;
      const modeUpper = typeof d.mode === 'string' ? d.mode.trim().toUpperCase() : '';
      const modeLower = typeof d.mode === 'string' ? d.mode.trim().toLowerCase() : '';

      if (room === 'sentence-lab' || modeLower === 'mistakes' || modeLower === 'check') {
        const subView: SentenceLabSubView = modeLower === 'mistakes' ? 'mistakes' : 'check';
        router.push(buildWritingUrl({ view: 'sentence-lab', subView }));
        return;
      }
      if (room === 'translation' || modeUpper === 'PARAGRAPH' || modeUpper === 'SENTENCE') {
        router.push(
          buildWritingUrl({
            view: 'translation',
            mode: modeUpper === 'PARAGRAPH' ? 'PARAGRAPH' : undefined,
          }),
        );
        return;
      }
      if (room === 'typing' || room === 'coach' || room === 'portfolio') {
        router.push(buildWritingUrl({ view: room }));
      }
    };
    window.addEventListener('ec:writing:intent', onWritingIntent);
    dispatchEchoModuleReady('writing', { view: routeState.view, mode: routeState.mode });
    return () => window.removeEventListener('ec:writing:intent', onWritingIntent);
  }, [router, routeState.view, routeState.mode]);

  if (authStatus === 'loading' || !capabilities || !capabilities.enabled) {
    return (
      <WritingStudio world={world}>
        <WritingStudioHeader activeView={routeState.view} onSelectView={handleSelectView} />
        <div className={glass.floor}>
          <div className={glass.floorInner}>
            {authStatus === 'loading' || (!capabilities && !capabilitiesError) ? (
              <StudioLoading text={t.loadingWritingStudio} />
            ) : (
              <StatePanel icon={<ShieldAlert />} title={locale === 'vi' ? 'Phòng viết tạm ngưng' : 'Writing Studio is paused'} text={t.writingMaintenanceDesc} kind="error" />
            )}
          </div>
        </div>
      </WritingStudio>
    );
  }

  if (authStatus === 'unauthenticated' || !session?.user) {
    return (
      <WritingStudio world={world}>
        <div className={glass.floor}>
          <div className={`${glass.floorInner} max-w-lg`}>
            <StatePanel
              icon={<ShieldAlert />}
              title={locale === 'vi' ? 'Cần đăng nhập' : 'Sign in required'}
              text={locale === 'vi' ? 'Đăng nhập để mở Phòng viết và lịch sử luyện viết của bạn.' : 'Please sign in to open your writing studio and learning history.'}
            />
          </div>
        </div>
      </WritingStudio>
    );
  }

  // Derive numeric user ID from authenticated session
  const userId = Number((session.user as any).id);

  return (
    <WritingStudio world={world}>
      {/* Studio header + five-tab rail: always rendered and navigable */}
      <WritingStudioHeader
        activeView={routeState.view}
        onSelectView={handleSelectView}
      />

      {/* Studio Learning Floor / Canvas Container */}
      <main className={glass.floor}>
        <div className={glass.floorInner}>
          {(routeState.view === 'translation' || routeState.view === 'for-you') && (
            <WritingErrorBoundary>
              <TranslationPractice
                key={userId}
                userId={userId}
                sessionId={routeState.sessionId}
                initialMode={routeState.mode?.toUpperCase() === 'PARAGRAPH' ? 'PARAGRAPH' : 'SENTENCE'}
                onNavigateSession={handleNavigateToTranslation}
              />
            </WritingErrorBoundary>
          )}

          {routeState.view === 'sentence-lab' && (
            <SentenceLabErrorBoundary>
              <SentenceLab
                activeSubView={routeState.subView || 'check'}
                initialPatternCode={routeState.patternCode}
                onSelectSubView={handleSelectSentenceLabSubView}
              />
            </SentenceLabErrorBoundary>
          )}

          {routeState.view === 'typing' && (
            <WritingErrorBoundary>
              <TypingPractice key={userId} userId={userId} />
            </WritingErrorBoundary>
          )}

          {routeState.view === 'coach' && (
            <WritingErrorBoundary>
              <WritingCoach
                initialSessionId={routeState.sessionId}
                initialTaskId={routeState.taskId}
                userId={userId}
              />
            </WritingErrorBoundary>
          )}

          {routeState.view === 'portfolio' && (
            <WritingErrorBoundary>
              <Portfolio
                onOpenSession={handleOpenPortfolioSession}
                onNavigateToCoach={() => handleNavigateToCoach()}
              />
            </WritingErrorBoundary>
          )}
        </div>
      </main>
    </WritingStudio>
  );
};
