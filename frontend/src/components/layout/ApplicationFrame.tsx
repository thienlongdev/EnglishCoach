'use client';

import React, { Suspense, useEffect, useSyncExternalStore } from 'react';
import dynamic from 'next/dynamic';
import { usePathname, useSearchParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { useDeskPage } from '@/lib/study-space/useDeskPage';
import { restoreUiFontScaleForUser } from '@/lib/echo-jarvis/intents/actionDispatcher';
import WallpaperStage from '@/components/wallpaper/WallpaperStage';
import EchoAtmosphere from '@/components/atmosphere/EchoAtmosphere';
import WallpaperStudioHost from '@/components/wallpaper/WallpaperStudioHost';
import SpatialHost from '@/components/spatial/SpatialHost';
import { useWorldDisplay } from '@/lib/ui/worldDisplay';
import {
  DEFAULT_NAV_PREFERENCES,
  currentNavPreferences,
  navStorageKey,
  subscribeNavPreferences,
} from '@/lib/navigation/preferences';

interface ApplicationFrameProps {
  children: React.ReactNode;
}

// Public reading and landing pages do not render workspace navigation.
const Sidebar = dynamic(() => import('@/components/layout/Sidebar'));
const TopNavbar = dynamic(() => import('@/components/layout/TopNavbar'));
const AdaptiveDock = dynamic(() => import('@/components/navigation/AdaptiveDock'), { ssr: false });
const NavigationMorphLayer = dynamic(() => import('@/components/navigation/NavigationMorphLayer'), { ssr: false });
const GlobalDictionarySearch = dynamic(
  () => import('@/components/features/dictionary/GlobalDictionarySearch').then((m) => m.GlobalDictionarySearch),
  { ssr: false },
);
const OdysseyReturn = dynamic(() => import('@/components/features/learning-path/odyssey/OdysseyReturn'), { ssr: false });
const FocusBridge = dynamic(() => import('@/components/study-space/FocusBridge'), { ssr: false });

function ApplicationFrameContent({ children }: ApplicationFrameProps) {
  const pathname = usePathname() || '';
  const searchParams = useSearchParams();
  const { data: session } = useSession();
  const isAuthenticated = !!(session && session.user);
  const navUserId = session?.user ? String((session.user as { id?: string | number }).id ?? '') : '';
  const navKey = navStorageKey(navUserId);
  const navPrefs = useSyncExternalStore(
    (cb) => subscribeNavPreferences(navKey, cb),
    () => currentNavPreferences(navKey),
    () => DEFAULT_NAV_PREFERENCES,
  );
  const [odysseyDisplay] = useWorldDisplay('odyssey');
  const [cosmosDisplay] = useWorldDisplay('cosmos');
  useEffect(() => {
    restoreUiFontScaleForUser(navUserId);
  }, [navUserId]);
  if (useDeskPage()) return <main data-app-scroll="" className="h-dvh w-full overflow-auto bg-surface text-on-surface">{children}</main>;

  // Quiet mode: active exam simulation runtime routes for authenticated users
  const isQuietRuntime = isAuthenticated && pathname.includes('/exams/') && pathname.includes('/attempts/');
  // Development-only IELTS CBT room preview (the page itself answers 404 in production builds).
  const isLandingPreview = pathname.startsWith('/landing-preview') || pathname.startsWith('/ielts-cbt-preview') || pathname.startsWith('/toeic-iig-preview');

  // Public landing page: when at root '/' without any ?tab=... parameter, or with ?tab=landing
  const tabParam = searchParams.get('tab');
  const isPublicLanding = pathname === '/' && (!tabParam || tabParam === 'landing');

  // Standalone auth pages: login, register, forgot/reset password, email verification
  const isAuthRoute =
    pathname.startsWith('/login') ||
    pathname.startsWith('/register') ||
    pathname.startsWith('/forgot-password') ||
    pathname.startsWith('/reset-password') ||
    pathname.startsWith('/verify-email');

  // Standalone full-screen game mode: Echo Garden (/games/echo-garden)
  // Absolutely no EnglishCoach navigation chrome (sidebar, top navbar, rails) is rendered.
  const isEchoGarden = pathname === '/games/echo-garden' || pathname.startsWith('/games/echo-garden/');

  const isQuizRush = pathname === '/games/echo-quiz-rush' || pathname.startsWith('/games/echo-quiz-rush/');
  const isSpelling = pathname === '/games/echo-spelling' || pathname.startsWith('/games/echo-spelling/');

  const isSpeakingArena = pathname === '/speaking/arena' || pathname.startsWith('/speaking/arena/');

  // The ONE background engine and its studio. A single element: the workspace and Không gian học tập are exclusive branches.
  const background = (
    <>
      {/* Hình nền: the one background engine (under everything) + the studio, loaded only when the sidebar opens it. */}
      <WallpaperStage />
      <WallpaperStudioHost />
    </>
  );

  // Không gian học tập: no sidebar or top bar; the ONE appearance background stays under the learner's room.
  const isStudyTimer = pathname === '/study-space/timer';
  const isStudySpace = !isStudyTimer && (pathname === '/study-space' || pathname.startsWith('/study-space/'));
  if (isStudyTimer) {
    return <main data-purpose="standalone-route" className="min-h-screen w-full"><FocusBridge />{children}</main>;
  }
  if (isStudySpace) {
    return (
      <div data-purpose="study-space" className="fixed inset-0 h-[100dvh] w-[100dvw] overflow-hidden bg-surface text-on-surface">
        {background}
        <SpatialHost />
        <FocusBridge />
        <main data-app-scroll="" data-spatial-exclude="" className="relative z-10 h-full w-full overflow-hidden">{children}</main>
      </div>
    );
  }

  const isOdyssey = pathname === '/learning-path' && searchParams.get('view') === 'odyssey';
  const isCosmos = pathname === '/knowledge-universe' || pathname.startsWith('/knowledge-universe/');
  // Immersive worlds (Echo Odyssey, Vũ trụ tri thức): by default the world fills the application viewport with no
  // sidebar or top bar; "embedded" puts it in the ordinary content area. Both modes are THIS workspace tree — only
  // sibling chrome is added or removed around the same <main> — so a switch never remounts the world's canvas.
  const world = isOdyssey ? 'odyssey' : isCosmos && isAuthenticated ? 'cosmos' : null;
  const immersive = world !== null && (world === 'odyssey' ? odysseyDisplay : cosmosDisplay) === 'immersive';

  if (isEchoGarden || isQuizRush || isSpeakingArena || isSpelling) {
    return (
      <div data-purpose="standalone-route" className="fixed inset-0 h-[100dvh] w-[100dvw] overflow-hidden bg-[#0c142b] text-slate-100 antialiased font-sans select-none z-0">
        <main className="h-full w-full overflow-hidden">
          {children}
        </main>
      </div>
    );
  }

  // Echo Anywhere: the public page of the browser extension and its account-connection page (own design, no shell).
  const isEchoAnywhere = pathname === '/echo-anywhere' || pathname.startsWith('/echo-anywhere/');

  const isGuide = pathname === '/huong-dan' || pathname.startsWith('/huong-dan/');
  if (isQuietRuntime || isLandingPreview || isPublicLanding || isAuthRoute || isEchoAnywhere || isGuide) {
    return (
      <div data-purpose="standalone-route" className="min-h-screen w-full overflow-x-hidden bg-slate-950 text-slate-100 antialiased font-sans">
        <main className="flex-1 min-w-0 h-full flex flex-col">
          {children}
        </main>
      </div>
    );
  }

  return (
    <div className={immersive ? 'flex fixed inset-0 h-[100dvh] w-full overflow-hidden bg-[#050b18]' : 'flex h-screen overflow-clip bg-surface text-on-surface relative'}
      data-atmosphere-frame={immersive ? undefined : ''} data-purpose={immersive ? `${world}-world` : undefined} data-world-display={world ? (immersive ? 'immersive' : 'embedded') : undefined}>
      {/* Echo Ocean: the frame's own default look, under the one background engine (anything chosen in Giao diện covers it). */}
      {!immersive && <EchoAtmosphere />}
      {!immersive && background}
      {/* Không gian 3D: renders nothing and loads nothing unless the learner turned it on. */}
      {!immersive && <SpatialHost />}
      {isAuthenticated && !immersive && <FocusBridge />}
      {!immersive && <Sidebar />}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden relative z-10">
        {!immersive && <TopNavbar />}
        {isAuthenticated && !immersive && <OdysseyReturn />}
        {/* data-app-scroll: the workspace's one scrolling viewport (modules save / restore their place in it).
            A world owns its whole area: nothing scrolls around it, in either mode. */}
        <main
          className={
            world
              ? 'flex-1 min-h-0 overflow-hidden'
              : navPrefs.layout === 'dock' && navPrefs.visibility === 'pinned'
                ? 'flex-1 overflow-y-auto pb-24'
                : 'flex-1 overflow-y-auto'
          }
          style={world ? undefined : { fontSize: 'calc(1rem * var(--ec-ui-font-scale, 1))' }}
          data-app-scroll=""
          data-spatial-exclude={world ? '' : undefined}
        >
          {children}
        </main>
        {/* Immersive worlds have no top bar, so the dictionary it carries is kept here without a field: "Tra từ" in a world
            (and Ctrl / ⌘ + K) opens the same dialog through ec:dictionary:lookup. */}
        {isAuthenticated && immersive && <div hidden><GlobalDictionarySearch customTrigger={() => null} /></div>}
      </div>
      {!immersive && <AdaptiveDock />}
      {!immersive && <NavigationMorphLayer />}
    </div>
  );
}

export default function ApplicationFrame({ children }: ApplicationFrameProps) {
  return (
    <Suspense fallback={<div className="min-h-screen w-full bg-slate-950 text-slate-100" />}>
      <ApplicationFrameContent>{children}</ApplicationFrameContent>
    </Suspense>
  );
}
