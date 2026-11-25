"use client";

import { SessionProvider, useSession } from "next-auth/react";
import { usePathname } from 'next/navigation';
import React, { Suspense, useEffect, useRef, useSyncExternalStore } from "react";
import { authEnding, subscribeAuthLifecycle, beginAuthenticatedSession } from '@/lib/auth-lifecycle';
import { clearUserScopedCaches } from '@/lib/auth-cache-cleanup';
import { SWRConfig } from "swr";
import { LanguageProvider } from "@/context/LanguageContext";
import { NotificationRealtimeProvider } from "@/context/NotificationRealtimeContext";
import { PlacementQuizHost } from "@/components/features/leaderboard/PlacementQuizHost";
import { MusicProvider } from '@/components/music/MusicProvider';
import EchoTabIdentity from '@/components/brand/EchoTabIdentity';
import JourneyHost from '@/components/journey/JourneyHost';
import GuideHost from '@/components/guide/GuideHost';
import MorphHost from '@/components/morph/MorphHost';
import journeyStyles from '@/components/journey/journey.module.css';
import { journeyHoldsAccount, journeyHoldsGuest, subscribeJourney } from '@/lib/journey/journey';
import dynamic from 'next/dynamic';
import { useDeskPage } from '@/lib/study-space/useDeskPage';

const CoachWidget = dynamic(() => import('@/components/features/coach/CoachWidget').then((m) => m.CoachWidget), { ssr: false });
const MessengerHost = dynamic(() => import('@/components/messenger/MessengerHost'), { ssr: false });

function ArenaAwareCoach() {
    const pathname = usePathname() ?? '';
    // Fully unmount to abort the previous conversation and stop all companion/discovery hooks.
    return pathname === '/speaking/arena' || pathname.startsWith('/speaking/arena/') ? null : <CoachWidget />;
}

function AuthScopeLifecycle() {
    const { data: session, status } = useSession();
    const scope = status === 'authenticated' ? (session?.user as { id?: string })?.id : null;
    const previous = useRef<string | null>(null);
    useEffect(() => {
        if (status === 'loading') return;
        if (previous.current && previous.current !== scope) clearUserScopedCaches();
        previous.current = scope ?? null;
        // A logout-in-progress must never be reopened by a stale SessionProvider render.
        if (scope && !authEnding()) beginAuthenticatedSession();
    }, [scope, status]);
    return null;
}
/** The Messenger's cards and its share of the realtime queue belong to a signed-in account, on every page. Its code loads when the page has settled, never before it. */
function MessengerForAccount() {
    const { data: session, status } = useSession();
    const id = Number((session?.user as { id?: string | number })?.id ?? 0);
    const [ready, setReady] = React.useState(false);
    useEffect(() => {
        if (status !== 'authenticated' || !id) return;
        const run = () => setReady(true);
        const idle = (window as Window & { requestIdleCallback?: (fn: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
        if (idle) idle(run, { timeout: 2500 }); else window.setTimeout(run, 1200);
    }, [status, id]);
    return ready && status === 'authenticated' && id ? <MessengerHost key={id} account={id} /> : null;
}
function AccountChildren({ children }: { children: React.ReactNode }) {
    const { data: session } = useSession();
    const id = (session?.user as { id?: string })?.id ?? 'guest';
    // A guest's own sign-in may keep its sea until the passage covers it (10 §BK): the guest view holds no account data. Never another account's view.
    const held = useSyncExternalStore(subscribeJourney, journeyHoldsGuest, () => false);
    const shown = useRef(id);
    if (!(held && shown.current === 'guest')) shown.current = id;
    // Account transitions remount view-local overlays and forms before they can show previous data.
    return <React.Fragment key={shown.current}>{children}</React.Fragment>;
}

export function Providers({ children }: { children: React.ReactNode }) {
    const inDesk = useDeskPage();
    const ending = useSyncExternalStore(subscribeAuthLifecycle, authEnding, () => false);
    // Sign-out: the page stays until the current covers it (10 §BK); requests already stopped at the press.
    const held = useSyncExternalStore(subscribeJourney, journeyHoldsAccount, () => false);
    useEffect(() => {
        // Ensure BFF CSRF token context is initialized for same-origin mutations
        if (typeof document !== "undefined" && !document.cookie.includes("ec.csrf=")) {
            fetch("/api/auth/csrf-context").catch(() => {});
        }
    }, []);

    return (
        <SessionProvider>
            <AuthScopeLifecycle />
            <SWRConfig
                value={{
                    revalidateOnFocus: false,
                    keepPreviousData: true,
                    dedupingInterval: 30000,
                }}
            >
                <LanguageProvider>
                    <EchoTabIdentity />
                    <Suspense fallback={null}><JourneyHost /></Suspense>
                    <Suspense fallback={null}><MorphHost /></Suspense>
                    {ending && !held ? <div role="status" className={journeyStyles.leaving}><span className="sr-only">Đang đăng xuất… / Signing out…</span></div> : <NotificationRealtimeProvider enabled={!inDesk}>
                        <AccountChildren>{inDesk ? children : <>
                            <MusicProvider>{children}<Suspense fallback={null}><ArenaAwareCoach /></Suspense><MessengerForAccount /></MusicProvider>
                            <Suspense fallback={null}><GuideHost /></Suspense>
                        </>}</AccountChildren>
                        {/* App-wide placement quiz modal: survives the eligibility flip after a submit. */}
                        <PlacementQuizHost />
                    </NotificationRealtimeProvider>}
                </LanguageProvider>
            </SWRConfig>
        </SessionProvider>
    );
}
