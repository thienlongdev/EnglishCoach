import { READING_SYSTEM_CACHE_KEY, readReadingSnapshot } from '@/lib/reading-system-cache';
import { mutate } from "swr";
import { revokeCurrentAvatarObjectUrl } from "@/hooks/useCurrentUserAvatar";
import { disconnectRealtimeClient } from "@/services/stompClient";
import { clearListeningUserCache } from "@/services/listeningCache";
import { clearCommunityUserCache } from "@/services/communityCache";
import { clearWallpaperLibrary } from "@/lib/wallpaper/youtubeLibrary";
import { clearModuleEntryRequests } from "@/services/moduleEntryResources";
import { LISTENING_SYSTEM_CACHE_KEY, preserveSystemListeningSnapshot } from "@/lib/listening-system-cache";
import { cancelAuthenticatedWork } from '@/lib/auth-lifecycle';
import { clearProfileIdentityRequests } from '@/services/profileIdentityResource';
import { clearBoardSnapshots } from '@/services/leaderboardSnapshots';
import { clearContentRequests } from '@/services/contentSystemResources';
import { CONTENT_SYSTEM_CACHE_KEY, readContentSnapshots } from '@/lib/content-system-snapshots';
import { FLASHCARD_SYSTEM_CACHE_KEY, readFlashcardSnapshot } from '@/lib/flashcard-system-cache';
import { disposeFocusEngines } from '@/lib/study-space/focus';

const userScopedCleanups = new Set<() => void>();

/**
 * Registers an in-memory store reset callback to run synchronously during logout / account switch.
 */
export function registerUserScopedCleanup(cleanup: () => void): () => void {
    userScopedCleanups.add(cleanup);
    return () => {
        userScopedCleanups.delete(cleanup);
    };
}

/**
 * Clears all user-specific caches (localStorage, sessionStorage, SWR)
 * while safely preserving application settings (theme, preferred_locale).
 * 
 * Prevents cross-account data leakage across logout and login switches.
 */
export function clearUserScopedCaches() {
    if (typeof window === "undefined") return;

    // Continue every private cleanup even when storage is denied or restoration exceeds quota.
    const safely = (action: () => void) => { try { action(); } catch { /* Continue cleanup. */ } };
    cancelAuthenticatedWork();
    safely(disposeFocusEngines);
    for (const cleanup of userScopedCleanups) safely(cleanup);
    safely(() => {
        const docPip = (window as unknown as { documentPictureInPicture?: { window?: Window | null } }).documentPictureInPicture;
        if (docPip?.window && !docPip.window.closed) docPip.window.close();
    });
    safely(() => {
        void import('@/lib/messenger/store').then((mod) => mod.resetMessengerStore()).catch(() => {});
    });
    safely(() => {
        void import('@/components/study-space/portable').then((mod) => mod.closePortableTimer()).catch(() => {});
    });
    safely(clearProfileIdentityRequests);
    safely(clearBoardSnapshots);
    safely(clearContentRequests);
    clearModuleEntryRequests();
    const systemListening = preserveSystemListeningSnapshot();
    const systemContent = readContentSnapshots();
    const systemReading = readReadingSnapshot();
    const systemFlashcards = readFlashcardSnapshot();
    const preferences = new Map<string, string>();
    safely(() => {
        // ec_echo_anywhere_hint:v1 = "the one-time Echo Anywhere tip was dismissed" (a flag, no account data): shown once per browser.
        for (const key of ["theme", "preferred_locale", "ec_api_url", "ec_echo_anywhere_hint:v1"]) {
            const value = localStorage.getItem(key);
            if (value) preferences.set(key, value);
        }
        // Which guides an account has seen and per-account navigation layout/dock preferences: ids and UI states per account, no learning content (10 §BL).
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            const value =
                key?.startsWith("ec_guide:v1:") || key?.startsWith("ec_nav:v1:")
                    ? localStorage.getItem(key)
                    : null;
            if (key && value) preferences.set(key, value);
        }
    });
    safely(disconnectRealtimeClient);
    safely(clearListeningUserCache);
    safely(clearCommunityUserCache);
    safely(clearWallpaperLibrary);
    safely(() => localStorage.clear());
    // The journey token holds a kind and a time, nothing of the account: the page after sign-out opens on the same water (10 §BK).
    let journeyToken: string | null = null;
    safely(() => { journeyToken = sessionStorage.getItem("ec_journey"); });
    safely(() => sessionStorage.clear());
    if (journeyToken) safely(() => sessionStorage.setItem("ec_journey", journeyToken as string));
    safely(() => { void mutate(() => true, undefined, { revalidate: false }); });
    safely(revokeCurrentAvatarObjectUrl);
    for (const [key, value] of preferences) safely(() => localStorage.setItem(key, value));
    if (systemListening) safely(() => localStorage.setItem(LISTENING_SYSTEM_CACHE_KEY, systemListening));
    if (systemContent) safely(() => localStorage.setItem(CONTENT_SYSTEM_CACHE_KEY, JSON.stringify(systemContent)));
    if (systemReading) safely(() => localStorage.setItem(READING_SYSTEM_CACHE_KEY, JSON.stringify(systemReading)));
    if (systemFlashcards) safely(() => localStorage.setItem(FLASHCARD_SYSTEM_CACHE_KEY, JSON.stringify({ version: 1, cachedAt: systemFlashcards.cachedAt, data: systemFlashcards.data })));
}
