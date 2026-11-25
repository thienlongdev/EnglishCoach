import type { LucideIcon } from 'lucide-react';
import {
  Bell,
  BookOpen,
  ClipboardList,
  Crown,
  Gamepad2,
  Headphones,
  Image as ImageIcon,
  LampDesk,
  Layers,
  LayoutDashboard,
  Mic,
  Music2,
  Network,
  Orbit,
  PenTool,
  ReceiptText,
  Route,
  ShieldAlert,
  ShieldCheck,
  Trophy,
  Users,
} from 'lucide-react';
import type { GlyphTone } from '@/components/layout/OceanCurrent';
import { isRootModuleHref, rootModuleOf } from './routes';

export type NavCategory = 'learning' | 'sharing' | 'personalize' | 'admin';

export interface NavDestination {
  id: string;
  category: NavCategory;
  href: string | null;
  action?: 'appearance';
  labelKey?: 'home' | 'learningPath' | 'flashcards' | 'grammar' | 'games' | 'reading' | 'listening' | 'speaking' | 'writing' | 'exams' | 'leaderboard' | 'music';
  labelVi: string;
  labelEn: string;
  icon: LucideIcon;
  tone: GlyphTone;
  iconColor: string;
  adminOnly?: boolean;
}

/**
 * Single shared navigation registry used by Classic Sidebar, macOS Liquid Glass Dock,
 * App Library, Navigation Studio, and the FLIP Shared-Element Morph Coordinator.
 */
export const NAV_REGISTRY: readonly NavDestination[] = [
  // ── Learning (HỌC TẬP) ───────────────────────────────────────────────────────
  {
    id: 'dashboard',
    category: 'learning',
    href: '/dashboard',
    labelKey: 'home',
    labelVi: 'Trang chủ',
    labelEn: 'Home',
    icon: LayoutDashboard,
    tone: 'home',
    iconColor: 'text-sky-600 dark:text-sky-300',
  },
  {
    id: 'learningPath',
    category: 'learning',
    href: '/learning-path?view=list',
    labelKey: 'learningPath',
    labelVi: 'Lộ trình học',
    labelEn: 'Learning Path',
    icon: Route,
    tone: 'path',
    iconColor: 'text-cyan-600 dark:text-cyan-300',
  },
  {
    id: 'knowledgeUniverse',
    category: 'learning',
    href: '/knowledge-universe',
    labelVi: 'Vũ trụ tri thức',
    labelEn: 'Knowledge Universe',
    icon: Orbit,
    tone: 'cosmos',
    iconColor: 'text-violet-500 dark:text-violet-300',
  },
  {
    id: 'flashcards',
    category: 'learning',
    href: '/flashcards',
    labelKey: 'flashcards',
    labelVi: 'Thẻ từ vựng',
    labelEn: 'Flashcards',
    icon: Layers,
    tone: 'cards',
    iconColor: 'text-indigo-500 dark:text-indigo-300',
  },
  {
    id: 'grammar',
    category: 'learning',
    href: '/grammar',
    labelKey: 'grammar',
    labelVi: 'Ngữ pháp',
    labelEn: 'Grammar',
    icon: Network,
    tone: 'grammar',
    iconColor: 'text-fuchsia-500 dark:text-fuchsia-300',
  },
  {
    id: 'games',
    category: 'learning',
    href: '/games',
    labelKey: 'games',
    labelVi: 'Trò chơi',
    labelEn: 'Games',
    icon: Gamepad2,
    tone: 'games',
    iconColor: 'text-violet-500 dark:text-violet-300',
  },
  {
    id: 'reading',
    category: 'learning',
    href: '/reading',
    labelKey: 'reading',
    labelVi: 'Đọc',
    labelEn: 'Reading',
    icon: BookOpen,
    tone: 'reading',
    iconColor: 'text-emerald-600 dark:text-emerald-300',
  },
  {
    id: 'listening',
    category: 'learning',
    href: '/listening',
    labelKey: 'listening',
    labelVi: 'Nghe',
    labelEn: 'Listening',
    icon: Headphones,
    tone: 'listening',
    iconColor: 'text-amber-600 dark:text-amber-300',
  },
  {
    id: 'speaking',
    category: 'learning',
    href: '/speaking',
    labelKey: 'speaking',
    labelVi: 'Luyện nói',
    labelEn: 'Speaking',
    icon: Mic,
    tone: 'speaking',
    iconColor: 'text-rose-500 dark:text-rose-300',
  },
  {
    id: 'writing',
    category: 'learning',
    href: '/writing',
    labelKey: 'writing',
    labelVi: 'Viết',
    labelEn: 'Writing',
    icon: PenTool,
    tone: 'writing',
    iconColor: 'text-teal-600 dark:text-teal-300',
  },
  {
    id: 'exams',
    category: 'learning',
    href: '/exams',
    labelKey: 'exams',
    labelVi: 'Thi thử',
    labelEn: 'Mock Exams',
    icon: ClipboardList,
    tone: 'exams',
    iconColor: 'text-blue-600 dark:text-blue-300',
  },

  // ── Sharing (CHIA SẺ) ────────────────────────────────────────────────────────
  {
    id: 'leaderboard',
    category: 'sharing',
    href: '/leaderboard',
    labelKey: 'leaderboard',
    labelVi: 'Bảng xếp hạng',
    labelEn: 'Leaderboard',
    icon: Trophy,
    tone: 'rank',
    iconColor: 'text-amber-500 dark:text-amber-300',
  },
  {
    id: 'community',
    category: 'sharing',
    href: '/community',
    labelVi: 'Cộng đồng',
    labelEn: 'Community',
    icon: Users,
    tone: 'community',
    iconColor: 'text-purple-500 dark:text-purple-300',
  },

  // ── Personalization (CÁ NHÂN HÓA) ────────────────────────────────────────────
  {
    id: 'music',
    category: 'personalize',
    href: '/music',
    labelKey: 'music',
    labelVi: 'Âm nhạc',
    labelEn: 'Echo Music',
    icon: Music2,
    tone: 'music',
    iconColor: 'text-violet-500 dark:text-violet-300',
  },
  {
    id: 'appearance',
    category: 'personalize',
    href: null,
    action: 'appearance',
    labelVi: 'Giao diện',
    labelEn: 'Appearance',
    icon: ImageIcon,
    tone: 'wallpaper',
    iconColor: 'text-fuchsia-500 dark:text-fuchsia-300',
  },
  {
    id: 'studySpace',
    category: 'personalize',
    href: '/study-space',
    labelVi: 'Không gian học tập',
    labelEn: 'Study space',
    icon: LampDesk,
    tone: 'space',
    iconColor: 'text-indigo-500 dark:text-indigo-300',
  },

  // ── Administration (HỆ THỐNG — ROLE_ADMIN only via live useCurrentRole) ──────
  {
    id: 'adminNotifications',
    category: 'admin',
    href: '/admin/notifications',
    labelVi: 'Thông báo quản trị',
    labelEn: 'Admin Notifications',
    icon: Bell,
    tone: 'bell',
    iconColor: 'text-sky-600 dark:text-sky-300',
    adminOnly: true,
  },
  {
    id: 'adminCommunity',
    category: 'admin',
    href: '/admin/community',
    labelVi: 'Quản trị cộng đồng',
    labelEn: 'Community Admin',
    icon: ShieldAlert,
    tone: 'admin',
    iconColor: 'text-amber-600 dark:text-amber-300',
    adminOnly: true,
  },
  {
    id: 'adminPremium',
    category: 'admin',
    href: '/admin/premium',
    labelVi: 'Quản lý Premium',
    labelEn: 'Premium Admin',
    icon: Crown,
    tone: 'admin',
    iconColor: 'text-amber-600 dark:text-amber-300',
    adminOnly: true,
  },
  {
    id: 'adminGardenCommerce',
    category: 'admin',
    href: '/admin/garden-commerce',
    labelVi: 'Đối soát Skin Garden',
    labelEn: 'Garden Orders',
    icon: ReceiptText,
    tone: 'admin',
    iconColor: 'text-amber-600 dark:text-amber-300',
    adminOnly: true,
  },
  {
    id: 'adminSecurity',
    category: 'admin',
    href: '/admin/security',
    labelVi: 'Bảo mật quản trị',
    labelEn: 'Admin Security',
    icon: ShieldCheck,
    tone: 'security',
    iconColor: 'text-emerald-600 dark:text-emerald-300',
    adminOnly: true,
  },
];

export const NAV_IDS: readonly string[] = NAV_REGISTRY.map((item) => item.id);
const NAV_BY_ID = new Map<string, NavDestination>(NAV_REGISTRY.map((item) => [item.id, item]));

export const DEFAULT_DOCK_PINNED: readonly string[] = [
  'dashboard',
  'learningPath',
  'knowledgeUniverse',
  'flashcards',
  'grammar',
  'games',
  'reading',
  'listening',
  'speaking',
  'writing',
  'exams',
  'leaderboard',
  'community',
  'appearance',
];

export function findNavDestination(id: string): NavDestination | undefined {
  return NAV_BY_ID.get(id);
}

export function isKnownNavId(id: unknown): id is string {
  return typeof id === 'string' && NAV_BY_ID.has(id);
}

export function authorizedDestinations(isAdmin: boolean): NavDestination[] {
  return NAV_REGISTRY.filter((item) => !item.adminOnly || isAdmin);
}

export function navLabel(item: NavDestination, vi: boolean, t?: Record<string, unknown>): string {
  if (item.labelKey && t && typeof t[item.labelKey] === 'string' && (t[item.labelKey] as string).trim()) {
    return t[item.labelKey] as string;
  }
  return vi ? item.labelVi : item.labelEn;
}

export function navCategoryLabel(category: NavCategory, vi: boolean): string {
  switch (category) {
    case 'learning':
      return vi ? 'Học tập' : 'Learning';
    case 'sharing':
      return vi ? 'Chia sẻ' : 'Community';
    case 'personalize':
      return vi ? 'Cá nhân hóa' : 'Personalize';
    case 'admin':
      return vi ? 'Hệ thống' : 'System';
  }
}

/** Canonical URL-to-destination resolver shared by Sidebar and Liquid Glass Dock. */
export function resolveActiveNavId(pathname: string, tabParam: string | null): string {
  if (pathname.startsWith('/admin/notifications')) return 'adminNotifications';
  if (pathname.startsWith('/admin/community')) return 'adminCommunity';
  if (pathname.startsWith('/admin/premium')) return 'adminPremium';
  if (pathname.startsWith('/admin/garden-commerce')) return 'adminGardenCommerce';
  if (pathname.startsWith('/admin/security')) return 'adminSecurity';
  if (pathname === '/music' || pathname.startsWith('/music/')) return 'music';
  if (pathname.startsWith('/study-space')) return 'studySpace';
  if (pathname === '/games' || pathname.startsWith('/games/')) return 'games';
  if (pathname === '/grammar' || pathname.startsWith('/grammar/')) return 'grammar';
  if (pathname.startsWith('/learning-path')) return 'learningPath';
  if (pathname.startsWith('/knowledge-universe')) return 'knowledgeUniverse';
  if (pathname.startsWith('/listening')) return 'listening';
  if (pathname.startsWith('/speaking')) return 'speaking';
  if (pathname.startsWith('/writing')) return 'writing';
  if (pathname.startsWith('/exams')) return 'exams';
  if (pathname.startsWith('/community')) return 'community';
  if (pathname.startsWith('/leaderboard')) return 'leaderboard';
  const root = rootModuleOf(pathname);
  if (root) return root;
  if (pathname === '/' && tabParam) return tabParam;
  return 'dashboard';
}

/** Shared navigation click handler preserving root-module native history pushState (zero RSC round-trip). */
export function handleSharedModuleNavigate(
  event: { preventDefault: () => void },
  targetId: string,
  href: string,
  activeId: string,
  pendingId: string | null,
  setPendingId: (next: string | null) => void,
  pathname: string,
  onAfterTrigger?: () => void,
): void {
  if ((activeId === targetId && !pendingId) || pendingId === targetId) {
    event.preventDefault();
    onAfterTrigger?.();
    return;
  }
  setPendingId(targetId);
  onAfterTrigger?.();
  if (rootModuleOf(pathname) && isRootModuleHref(href)) {
    event.preventDefault();
    window.history.pushState(null, '', href);
  }
}
