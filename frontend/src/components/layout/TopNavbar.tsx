'use client';

import React, { useState, useEffect, useRef, useSyncExternalStore } from 'react';
import useSWR, { mutate } from 'swr';
import { useSession, signIn } from 'next-auth/react';
import { usePathname, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Bell, CircleHelp, Crown, MessageCircle, Sun, Moon, Search, LogIn, Pin, PinOff } from 'lucide-react';
import {
  DEFAULT_NAV_PREFERENCES,
  currentNavPreferences,
  navStorageKey,
  setNavigationVisibility,
  subscribeNavPreferences,
} from '@/lib/navigation/preferences';
import { useAutoHideSurface } from '@/lib/navigation/useAutoHideSurface';
import { useMessenger } from '@/lib/messenger/store';
import { openGuidePanel } from '@/lib/guide/store';
import { GlobalDictionarySearch } from '@/components/features/dictionary/GlobalDictionarySearch';
import { useLanguage } from '@/context/LanguageContext';
import { UserAvatar } from '@/components/common/UserAvatar';
import { AccountMenu } from './AccountMenu';
import { useUnifiedStreak } from '@/hooks/useUnifiedStreak';
import {
  NOTIFICATION_UNREAD_COUNT_PREFIX,
  NOTIFICATION_LIST_PREFIX,
} from '@/hooks/useNotifications';
import {
  useUserFeedbackUnreadCount,
  useAdminFeedbackUnreadCount,
  USER_FEEDBACK_UNREAD_URL,
  ADMIN_FEEDBACK_UNREAD_URL,
  ADMIN_FEEDBACK_INBOX_PREFIX,
  MY_FEEDBACK_LIST_PREFIX,
} from '@/hooks/useFeedback';
import { NotificationPopover } from '@/components/layout/NotificationPopover';
import { UserFeedbackModal } from '@/components/feedback/UserFeedbackModal';
import { NotificationDetailModal } from '@/components/layout/NotificationDetailModal';
import { NotificationToastContainer } from '@/components/layout/NotificationToast';
import { LearnerNotification } from '@/types/notification';
import { subscribeRealtimeTopic } from '@/services/stompClient';
import { useRealtimeNotifications } from '@/context/NotificationRealtimeContext';
import { useCurrentRole } from '@/hooks/useCurrentRole';
import shell from './WorkspaceShell.module.css';
import CompactMusicPlayer from '@/components/music/CompactMusicPlayer';
import { EchoAnywhereEntry } from '@/components/echoAnywhere/EchoAnywhereEntry';

type Labels = ReturnType<typeof useLanguage>['t'];

/** Title of the current section for the top bar; mirrors the sidebar's active-item mapping. */
function resolveSectionTitle(pathname: string, tab: string | null, t: Labels, vi: boolean): string | null {
  if (pathname === '/') {
    const key = tab ?? 'dashboard';
    if (key === 'dashboard') return t.home;
    if (key === 'flashcards' || key === 'reading' || key === 'writing' || key === 'leaderboard') return t[key];
    return null;
  }
  if (pathname === '/dashboard') return t.home;
  if (pathname === '/flashcards' || pathname === '/reading' || pathname === '/leaderboard') return t[pathname.slice(1) as 'flashcards' | 'reading' | 'leaderboard'];
  if (pathname.startsWith('/grammar')) return t.grammar;
  if (pathname === '/games' || pathname.startsWith('/games/')) return t.games;
  if (pathname.startsWith('/listening')) return t.listening;
  if (pathname.startsWith('/speaking')) return t.speaking;
  if (pathname.startsWith('/writing')) return t.writing;
  if (pathname.startsWith('/exams')) return t.exams;
  if (pathname.startsWith('/community')) return vi ? 'Cộng đồng' : 'Community';
  if (pathname.startsWith('/learning-path')) return t.learningPath;
  if (pathname.startsWith('/knowledge-universe')) return vi ? 'Vũ trụ tri thức' : 'Knowledge Universe';
  if (pathname.startsWith('/progress')) return vi ? 'Tiến trình học tập' : 'Learning progress';
  if (pathname.startsWith('/profile')) return vi ? 'Hồ sơ cá nhân' : 'Profile';
  if (pathname.startsWith('/premium')) return vi ? 'Gói Premium' : 'Premium';
  if (pathname.startsWith('/music')) return vi ? 'Âm nhạc' : 'Echo Music';
  if (pathname.startsWith('/admin')) return vi ? 'Quản trị hệ thống' : 'Administration';
  return null;
}

export default function TopNavbar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { data: session, status: sessionStatus } = useSession();
  const { locale, t } = useLanguage();
  const [isDark, setIsDark] = useState(false);
  const [isFeedbackModalOpen, setIsFeedbackModalOpen] = useState(false);
  const [childMenuOpen, setChildMenuOpen] = useState(false);
  const notificationButtonRef = useRef<HTMLButtonElement>(null);
  const headerRef = useRef<HTMLElement>(null);

  const routeKey = pathname + '|' + (searchParams.get('tab') ?? '');
  const priorRoute = useRef(routeKey);
  const navAccountId = session?.user ? String((session.user as { id?: string | number }).id ?? '') : '';
  const navKey = navStorageKey(navAccountId);
  const navPrefs = useSyncExternalStore(
    (cb) => subscribeNavPreferences(navKey, cb),
    () => currentNavPreferences(navKey),
    () => DEFAULT_NAV_PREFERENCES,
  );

  // Real-Time Notification Platform Integration (P0-F)
  const {
    unreadCount: realtimeSystemUnread,
    isBellRinging,
    toasts,
    dismissToast,
    isPopoverOpen,
    setIsPopoverOpen,
    selectedNotification,
    setSelectedNotification,
    reconcileWithRest,
  } = useRealtimeNotifications();

  useEffect(() => {
    if (priorRoute.current === routeKey) return;
    priorRoute.current = routeKey;
    setIsPopoverOpen(false);
    setSelectedNotification(null);
    setIsFeedbackModalOpen(false);
  }, [routeKey, setIsPopoverOpen, setSelectedNotification]);

  // Unread Notification & Feedback Counts
  const { isAdmin, isLoading: isRoleLoading } = useCurrentRole();
  const systemUnreadCount = realtimeSystemUnread;
  const { unreadCount: userFeedbackUnreadCount, mutateUnreadCount: mutateUserFeedbackUnread } = useUserFeedbackUnreadCount();
  const { unreadCount: adminFeedbackUnreadCount, mutateUnreadCount: mutateAdminFeedbackUnread } = useAdminFeedbackUnreadCount();

  // STOMP Real-Time Badge Synchronizer (Zero refresh, Instant Push)
  useEffect(() => {
    if (!session?.user || isRoleLoading) return;
    const user = session.user as any;
    const userId = String(user.id || user.sub || user.email || '');
    const userIsAdmin = isAdmin;

    const unsubs: (() => void)[] = [];
    let broadcastJitterTimer: ReturnType<typeof setTimeout> | null = null;

    if (userIsAdmin) {
      // 1. Admin listens to unread feedback count updates
      const unsubAdmin = subscribeRealtimeTopic('/topic/admin/feedback-badge', (data: any) => {
        if (data && typeof data.unreadCount === 'number') {
          mutateAdminFeedbackUnread({ unreadCount: data.unreadCount }, false);
        } else {
          mutateAdminFeedbackUnread();
        }
        mutate((key) => Array.isArray(key) && key[0] === ADMIN_FEEDBACK_INBOX_PREFIX);
      });
      unsubs.push(unsubAdmin);
    } else if (userId) {
      // 2. Regular learner listens to user-specific feedback replies / notification badge
      const unsubUser = subscribeRealtimeTopic(`/topic/user/${userId}/feedback-badge`, (data: any) => {
        if (data && typeof data.unreadCount === 'number') {
          mutateUserFeedbackUnread({ unreadCount: data.unreadCount }, false);
        } else {
          mutateUserFeedbackUnread();
        }
        mutate((key) => Array.isArray(key) && key[0] === MY_FEEDBACK_LIST_PREFIX);
        mutate((key) => Array.isArray(key) && key[0] === NOTIFICATION_UNREAD_COUNT_PREFIX);
      });
      unsubs.push(unsubUser);

      // 3. Regular learner listens to global broadcast announcements (0-15s jitter avoids thundering herd)
      const unsubBroadcast = subscribeRealtimeTopic('/topic/notifications/broadcast', () => {
        if (broadcastJitterTimer) return;
        const delayMs = Math.floor(Math.random() * 15000);
        broadcastJitterTimer = setTimeout(() => {
          broadcastJitterTimer = null;
          reconcileWithRest();
          mutate((key) => Array.isArray(key) && key[0] === NOTIFICATION_UNREAD_COUNT_PREFIX);
          mutate((key) => Array.isArray(key) && key[0] === NOTIFICATION_LIST_PREFIX);
        }, delayMs);
      });
      unsubs.push(unsubBroadcast);
    }

    return () => {
      if (broadcastJitterTimer) {
        clearTimeout(broadcastJitterTimer);
        broadcastJitterTimer = null;
      }
      unsubs.forEach((unsub) => unsub());
    };
  }, [session, isAdmin, isRoleLoading, mutateAdminFeedbackUnread, mutateUserFeedbackUnread, reconcileWithRest]);

  // Deep link from public pages (landing footer "Gửi phản hồi & báo lỗi"): `feedback=open` opens the learner feedback
  // modal once, then the parameter is dropped so a reload does not reopen it.
  useEffect(() => {
    if (!session?.user || isAdmin) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('feedback') !== 'open') return;
    setIsFeedbackModalOpen(true);
    params.delete('feedback');
    const query = params.toString();
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
  }, [session, isAdmin]);

  // For Admin: reflects total unread feedback count (/api/v1/feedback/admin/unread-count)
  // For Learner: reflects system notifications + unread feedback replies (/api/v1/feedback/mine/unread-count)
  const unreadCount = isAdmin
    ? adminFeedbackUnreadCount
    : (systemUnreadCount + userFeedbackUnreadCount);

  // Unified Learning Streak Source across all 10 learning modules (Phase B)
  const { streak } = useUnifiedStreak();
  const currentStreak = streak?.currentStreakDays ?? 0;

  useEffect(() => {
    try {
      const savedTheme = localStorage.getItem('theme');
      const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      if (savedTheme === 'dark' || (!savedTheme && prefersDark)) {
        setIsDark(true);
        document.documentElement.classList.add('dark');
      } else {
        setIsDark(false);
        document.documentElement.classList.remove('dark');
      }
    } catch {
      // ignore
    }
  }, []);

  // The studio can change the appearance too, and "follow system" follows the OS while the page is open.
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setIsDark(root.classList.contains('dark')));
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    const onSystem = (event: MediaQueryListEvent) => {
      try {
        if (!localStorage.getItem('theme')) root.classList.toggle('dark', event.matches);
      } catch {
        // storage denied: the current appearance stays
      }
    };
    media?.addEventListener('change', onSystem);
    return () => {
      observer.disconnect();
      media?.removeEventListener('change', onSystem);
    };
  }, []);

  const toggleTheme = () => {
    const newMode = !isDark;
    setIsDark(newMode);
    try {
      if (newMode) {
        document.documentElement.classList.add('dark');
        localStorage.setItem('theme', 'dark');
      } else {
        document.documentElement.classList.remove('dark');
        localStorage.setItem('theme', 'light');
      }
    } catch {
      // ignore
    }
  };

  const vi = locale === 'vi';
  const sectionTitle = resolveSectionTitle(pathname || '', searchParams.get('tab'), t, vi);
  // One gentle ring when unread notifications first appear or grow (page load included); never a loop.
  const [attentionRing, setAttentionRing] = useState(false);
  const lastUnread = useRef(0);
  useEffect(() => {
    const previous = lastUnread.current;
    lastUnread.current = unreadCount;
    if (unreadCount <= previous || unreadCount === 0) {
      setAttentionRing(false);
      return;
    }
    setAttentionRing(true);
    const timer = setTimeout(() => setAttentionRing(false), 1300);
    return () => clearTimeout(timer);
  }, [unreadCount]);

  const messagesUnread = useMessenger(state => state.unread), messagesAsked = useMessenger(state => state.messageRequests + state.friendRequests), messagesBadge = messagesUnread + messagesAsked;
  const notificationLabel = unreadCount > 0
    ? (vi ? `Có ${unreadCount} thông báo chưa đọc` : `${unreadCount} unread notifications`)
    : (vi ? 'Thông báo' : 'Notifications');

  useEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const syncExpanded = () => {
      const hasOpenMenu =
        header.querySelector('[aria-expanded="true"]:not([data-testid="music-compact-toggle"])') !== null;
      setChildMenuOpen(hasOpenMenu);
    };
    syncExpanded();
    const obs = new MutationObserver(syncExpanded);
    obs.observe(header, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-expanded'] });
    return () => obs.disconnect();
  }, [session, navPrefs.visibility]);

  const topAutoHide = useAutoHideSurface({
    surface: 'topbar',
    visibility: navPrefs.visibility,
    lockedOpen: isPopoverOpen || isFeedbackModalOpen || Boolean(selectedNotification) || childMenuOpen,
  });
  const topPinned = !topAutoHide.isAutoHide;
  const topPinTitle = topPinned
    ? (vi ? 'Luôn hiển thị điều hướng' : 'Navigation always visible')
    : (vi ? 'Tự động ẩn điều hướng' : 'Auto-hide navigation');
  const topPinAria = topPinned
    ? (vi ? 'Luôn hiển thị điều hướng — nhấn để tự động ẩn toàn bộ thanh điều hướng' : 'Navigation always visible — click to auto-hide navigation')
    : (vi ? 'Tự động ẩn điều hướng — nhấn để luôn hiển thị toàn bộ thanh điều hướng' : 'Auto-hide navigation — click to keep navigation visible');

  const headerElement = (
    <header ref={headerRef} className={shell.bar} data-sp-shell="" data-nav-surface="topbar">
        {/* Where am I: the current section (the collapsed rail shows no labels) */}
        <div className="hidden shrink-0 min-[1600px]:block">
          {sectionTitle && (
            <p className={`${shell.pageTitle} truncate`} data-testid="topbar-section-title">{sectionTitle}</p>
          )}
        </div>

        {/* Dictionary: a search field that opens the global dictionary dialog (shrinks first when space is short) */}
        <div className={`${shell.dictionarySlot} shrink-0 md:min-w-0 md:max-w-[20rem] md:flex-1 md:shrink md:[&>div]:block md:[&>div]:w-full`}>
        <GlobalDictionarySearch
          key={routeKey}
          navigationOwned
          customTrigger={(open) => (
            <button
              type="button"
              onClick={open}
              title={vi ? 'Tra từ điển' : 'Dictionary'}
              aria-label={vi ? 'Tra từ điển' : 'Dictionary'}
              data-guide="topbar-dictionary"
              className={`${shell.search} ${shell.raised} ${shell.lift} ${shell.focusRing} md:w-full md:justify-start cursor-pointer`}
            >
              <span className={shell.searchLens} aria-hidden="true">
                <Search className={`${shell.searchIcon} h-[17px] w-[17px]`} strokeWidth={2.4} />
              </span>
              <span className="hidden truncate md:inline">{vi ? 'Tra từ điển…' : 'Look up a word…'}</span>
              {/* the dialog's own shortcut (GlobalDictionarySearch: Ctrl / ⌘ + K) */}
              <kbd className={`${shell.kbd} hidden xl:inline-flex`} aria-hidden="true">Ctrl K</kbd>
            </button>
          )}
        />
        </div>

        <CompactMusicPlayer />

        <div className={`${shell.utilitySlot} ml-auto flex shrink-0 items-center gap-2 sm:gap-2.5`}>
          {/* Utility tray: streak · theme · notifications */}
          <div className={`${shell.tray} ${shell.raised}`}>
            {/* Streak — backed by the unified progress source; authenticated only */}
            {session && (
              <>
                <span
                  className={`${shell.streak} hidden sm:inline-flex items-center gap-1`}
                  title={vi ? `Chuỗi học tập liên tiếp: ${currentStreak} ngày` : `Learning streak: ${currentStreak} days`}
                  aria-label={vi ? `Chuỗi học tập ${currentStreak} ngày` : `Learning streak: ${currentStreak} days`}
                  role="img"
                >
                  <span className="text-[15px] leading-none streak-flame-icon select-none" aria-hidden="true">🔥</span>
                  <span>{currentStreak}</span>
                </span>
                <span className={`${shell.traySep} hidden sm:block`} aria-hidden="true" />
              </>
            )}

            {/* Theme */}
            <button
              type="button"
              onClick={toggleTheme}
              className={`${shell.trayButton} ${shell.focusRing} cursor-pointer`}
              aria-label={isDark ? (vi ? 'Chuyển sang chế độ sáng' : 'Switch to light mode') : (vi ? 'Chuyển sang chế độ tối' : 'Switch to dark mode')}
              aria-pressed={isDark}
              data-guide="topbar-theme"
              title={isDark ? (vi ? 'Chuyển sang chế độ sáng' : 'Switch to Light Mode') : (vi ? 'Chuyển sang chế độ tối' : 'Switch to Dark Mode')}
            >
              {isDark ? <Moon size={17} className="text-sky-300" aria-hidden="true" /> : <Sun size={17} className="text-amber-500" aria-hidden="true" />}
            </button>

            {/* Echo Guide: every guide, what this screen has first (10 §BL) */}
            {session && (
              <button
                type="button"
                onClick={openGuidePanel}
                className={`${shell.trayButton} ${shell.focusRing} cursor-pointer`}
                aria-label={vi ? 'Hướng dẫn' : 'Guides'}
                title={vi ? 'Hướng dẫn' : 'Guides'}
                aria-haspopup="dialog"
                data-guide="topbar-help"
              >
                <CircleHelp size={17} aria-hidden="true" />
              </button>
            )}

            {/* Echo Anywhere: the browser extension (popover + one-time tip; desktop widths only) */}
            <span className="hidden md:contents">
              <EchoAnywhereEntry key={routeKey} trayButtonClass={`${shell.trayButton} ${shell.focusRing} cursor-pointer`} vi={vi} />
            </span>

            <span className={shell.traySep} aria-hidden="true" />

            {/* Echo Messenger: unread conversations, on the page of its own */}
            <Link
              href="/community/messages"
              className={`${shell.trayButton} ${shell.focusRing} relative cursor-pointer`}
              aria-label={messagesBadge > 0 ? (vi ? [messagesUnread > 0 ? `Có ${messagesUnread} tin nhắn chưa đọc` : '', messagesAsked > 0 ? `${messagesAsked} lời mời` : ''].filter(Boolean).join(' và ') : [messagesUnread > 0 ? `${messagesUnread} unread messages` : '', messagesAsked > 0 ? `${messagesAsked} requests` : ''].filter(Boolean).join(' and ')) : (vi ? 'Tin nhắn' : 'Messages')}
              title={vi ? 'Tin nhắn' : 'Messages'}
              data-testid="topbar-messages"
            >
              <MessageCircle className="h-[18px] w-[18px]" aria-hidden="true" />
              {messagesBadge > 0 && <span className={shell.badge}>{messagesBadge > 99 ? '99+' : messagesBadge}</span>}
            </Link>

            {/* Notification Bell */}
            <div className="relative">
              <button
                ref={notificationButtonRef}
                type="button"
                onClick={() => setIsPopoverOpen(!isPopoverOpen)}
                className={`${shell.trayButton} ${unreadCount > 0 ? shell.bellAttention : ''} ${shell.focusRing} cursor-pointer`}
                aria-label={notificationLabel}
                aria-expanded={isPopoverOpen}
                data-guide="topbar-bell"
                title={notificationLabel}
              >
                <Bell
                  className={`h-[18px] w-[18px] ${unreadCount > 0 ? 'fill-amber-400/40' : ''} ${
                    isBellRinging || attentionRing ? 'animate-bell-ring' : ''
                  }`}
                  aria-hidden="true"
                />
                {unreadCount > 0 && (
                  <span className={shell.badge}>{unreadCount > 99 ? '99+' : unreadCount}</span>
                )}
              </button>

              <NotificationPopover
                isOpen={isPopoverOpen}
                onClose={() => setIsPopoverOpen(false)}
                onOpenFeedback={() => setIsFeedbackModalOpen(true)}
                onSelectNotification={(notif) => setSelectedNotification(notif)}
                locale={locale}
                unreadCount={unreadCount}
                triggerRef={notificationButtonRef}
              />
            </div>

            <span className={shell.traySep} aria-hidden="true" />

            {/* Global Pin / Auto-Hide toggle for workspace navigation */}
            <button
              type="button"
              onClick={() => setNavigationVisibility(navKey, topAutoHide.isAutoHide ? 'pinned' : 'autohide')}
              className={`${shell.trayButton} ${topPinned ? shell.pinTrayActive : ''} ${shell.focusRing} cursor-pointer`}
              aria-label={topPinAria}
              aria-pressed={topPinned}
              data-testid="topbar-pin-toggle"
              title={topPinTitle}
            >
              {topPinned ? <Pin size={15} aria-hidden="true" /> : <PinOff size={15} aria-hidden="true" />}
            </button>
          </div>

          {/* Premium (entitlement / checkout lives on /premium) */}
          <Link
            href="/premium"
            className={`${shell.premium} ${shell.focusRing} shrink-0 cursor-pointer`}
            title={vi ? 'Gói Premium' : 'Premium Plan'}
            aria-label={vi ? 'Gói Premium' : 'Premium Plan'}
          >
            <Crown className={`${shell.crown} h-[17px] w-[17px] shrink-0`} strokeWidth={2.3} aria-hidden="true" />
            <span className="hidden xl:inline">Premium</span>
          </Link>

          {/* User Profile / Auth Action */}
          <div className="flex items-center">
            {session ? (
              <AccountMenu key={routeKey} locale={locale}>
                  <UserAvatar
                    className="w-6 h-6 rounded-full"
                    fallbackName={session.user?.name}
                    textClassName="text-xs"
                    showFrame={true}
                    context="navbar"
                    size="xs"
                  />
              </AccountMenu>
            ) : sessionStatus === 'loading' ? (
              // Session still being read: a neutral placeholder of the account capsule, never a "Đăng nhập" flash.
              <span
                role="status"
                aria-label={vi ? 'Đang tải tài khoản' : 'Loading account'}
                className={`${shell.skeleton} block h-11 w-11 rounded-full xl:w-40 xl:rounded-[1.1rem]`}
              />
            ) : (
              <button
                type="button"
                onClick={() => signIn()}
                aria-label={vi ? 'Đăng nhập' : 'Sign in'}
                className={`${shell.authButton} rounded-xl bg-gradient-to-br from-[#0d2a5e] to-[#1656b8] px-4 py-2 text-xs font-bold text-white shadow-sm transition hover:brightness-110 cursor-pointer`}
              >
                <span>{vi ? 'Đăng nhập' : 'Sign in'}</span><LogIn size={17} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
    </header>
  );

  return (
    <div
      className={
        topAutoHide.isAutoHide
          ? `${shell.tokens} ${shell.topBarAutoRoot}`
          : `${shell.tokens} sticky top-0 z-50 w-full`
      }
      data-autohide-owner="topbar"
    >
      {topAutoHide.isAutoHide ? (
        <>
          <div
            aria-hidden="true"
            data-testid="topbar-edge-zone"
            data-autohide-owner="topbar"
            className={shell.topBarEdgeZone}
            data-nav-edge=""
          />
          {!topAutoHide.isRevealed && (
            <button
              type="button"
              data-testid="topbar-touch-handle"
              data-autohide-owner="topbar"
              aria-label={vi ? 'Hiện thanh điều hướng trên' : 'Reveal top bar'}
              className={shell.topBarTouchHandle}
              onClick={topAutoHide.toggleRevealTouch}
            >
              <span className={shell.touchHandleBarHorizontal} aria-hidden="true" />
            </button>
          )}
          <div
            className={`${shell.topBarOverlay} ${navPrefs.layout === 'sidebar' ? shell.topBarOverlayWithSidebar : ''} ${
              topAutoHide.isRevealed ? shell.topBarOverlayVisible : shell.topBarOverlayHidden
            }`}
            data-nav-hit=""
          >
            {headerElement}
          </div>
        </>
      ) : (
        headerElement
      )}

      {/* Feedback Modal for Learner */}
      {!isAdmin && (
        <UserFeedbackModal
          isOpen={isFeedbackModalOpen}
          onClose={() => setIsFeedbackModalOpen(false)}
        />
      )}

      {/* Notification Detail Modal */}
      <NotificationDetailModal
        isOpen={!!selectedNotification}
        notification={selectedNotification}
        onClose={() => setSelectedNotification(null)}
        locale={locale}
      />

      {/* Real-time Notification Corner Toasts */}
      <NotificationToastContainer
        toasts={toasts}
        onDismiss={dismissToast}
        onSelect={(notif) => setSelectedNotification(notif)}
        isPopoverOpen={isPopoverOpen}
      />
    </div>
  );
}
