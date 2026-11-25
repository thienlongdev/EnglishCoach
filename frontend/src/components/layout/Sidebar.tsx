"use client"

import { useSearchParams, usePathname } from "next/navigation"
import Link from "next/link"
import { Suspense, useState, useEffect, useSyncExternalStore, type ReactNode } from "react"
import { useSession } from "next-auth/react"
import {
    LayoutDashboard,
    Route,
    BookOpen,
    Layers,
    Gamepad2,
    Mic,
    Headphones,
    ClipboardList,
    PanelLeftClose,
    PanelLeft,
    PenTool,
    Bell,
    Users,
    ShieldAlert,
    Trophy,
    Crown,
    ShieldCheck,
    Loader2,
    ReceiptText,
    Image as ImageIcon,
    Music2,
    ChevronRight,
    Network,
    LampDesk,
    Orbit,
} from "lucide-react"
import { useLanguage } from "@/context/LanguageContext"
import { BrandWhaleIcon } from "@/components/common/BrandWhaleIcon"
import { useAdminFeedbackUnreadCount } from "@/hooks/useFeedback"
import { useCurrentRole } from '@/hooks/useCurrentRole'
import { openWallpaperStudio } from '@/lib/wallpaper/storage'
import { isRootModuleHref, rootModuleOf } from "@/lib/navigation/routes"
import {
    DEFAULT_NAV_PREFERENCES,
    currentNavPreferences,
    navStorageKey,
    subscribeNavPreferences,
} from "@/lib/navigation/preferences"
import { useAutoHideSurface } from "@/lib/navigation/useAutoHideSurface"
import OceanCurrent, { OceanGlyphDefs, type GlyphTone } from "./OceanCurrent"
import styles from "./WorkspaceShell.module.css"

// ─── Learner-facing navigation items ───────────────────────────────────────
// iconColor = the module's fallback tint; tone = its sculpted glyph gradient (OceanGlyphDefs). The active item is the glass capsule.
const NAV_CONFIG = [
    {
        tab: "dashboard",
        labelKey: "home" as const,
        icon: LayoutDashboard,
        tone: "home" as GlyphTone,
        iconColor: "text-sky-600 dark:text-sky-300",
        href: "/dashboard",
    },
    {
        tab: "learningPath",
        labelKey: "learningPath" as const,
        icon: Route,
        tone: "path" as GlyphTone,
        iconColor: "text-cyan-600 dark:text-cyan-300",
        href: "/learning-path?view=list",
    },
    {
        tab: "knowledgeUniverse",
        // own label: the shared label table (lib/exams/labels.ts) is pinned by the Exams presentation contract
        label: ["Vũ trụ tri thức", "Knowledge Universe"] as const,
        icon: Orbit,
        tone: "cosmos" as GlyphTone,
        iconColor: "text-violet-500 dark:text-violet-300",
        href: "/knowledge-universe",
    },
    {
        tab: "flashcards",
        labelKey: "flashcards" as const,
        icon: Layers,
        tone: "cards" as GlyphTone,
        iconColor: "text-indigo-500 dark:text-indigo-300",
        href: "/flashcards",
    },
    {
        tab: "grammar",
        labelKey: "grammar" as const,
        icon: Network,
        tone: "grammar" as GlyphTone,
        iconColor: "text-fuchsia-500 dark:text-fuchsia-300",
        href: "/grammar",
    },
    {
        tab: "games",
        labelKey: "games" as const,
        icon: Gamepad2,
        tone: "games" as GlyphTone,
        iconColor: "text-violet-500 dark:text-violet-300",
        href: "/games",
    },
    {
        tab: "reading",
        labelKey: "reading" as const,
        icon: BookOpen,
        tone: "reading" as GlyphTone,
        iconColor: "text-emerald-600 dark:text-emerald-300",
        href: "/reading",
    },
    {
        tab: "listening",
        labelKey: "listening" as const,
        icon: Headphones,
        tone: "listening" as GlyphTone,
        iconColor: "text-amber-600 dark:text-amber-300",
        href: "/listening",
    },
    {
        tab: "speaking",
        labelKey: "speaking" as const,
        icon: Mic,
        tone: "speaking" as GlyphTone,
        iconColor: "text-rose-500 dark:text-rose-300",
        href: "/speaking",
    },
    {
        tab: "writing",
        labelKey: "writing" as const,
        icon: PenTool,
        tone: "writing" as GlyphTone,
        iconColor: "text-teal-600 dark:text-teal-300",
        href: "/writing",
    },
    {
        tab: "exams",
        labelKey: "exams" as const,
        icon: ClipboardList,
        tone: "exams" as GlyphTone,
        iconColor: "text-blue-600 dark:text-blue-300",
        href: "/exams",
    },
]

/** One class recipe for every sidebar entry (learning, sharing and admin), so states can never drift apart. */
function navItemClass(active: boolean, collapsed: boolean) {
    return [
        "group",
        styles.item,
        collapsed ? styles.itemCollapsed : styles.itemExpanded,
        active ? styles.itemActive : "",
    ].join(" ")
}

function iconClass(active: boolean, tint: string) {
    return [styles.icon, active ? "" : tint].join(" ")
}

/** Gradient paint of a module glyph (falls back to the tint colour where the paint server is unavailable). */
function tonePaint(tone: GlyphTone) {
    return `url(#ec-og-${tone})`
}

/** The small glass well an icon sits in: lit in the module's tone, brighter on hover, crystal on the active capsule. */
function Glyph({ tone, morphId, children }: { tone: GlyphTone; morphId?: string; children: ReactNode }) {
    return <span className={styles.glyph} data-tone={tone} data-nav-morph-id={morphId} aria-hidden="true">{children}</span>
}

/** Collapsed-rail label: shown on hover and on keyboard focus (the link keeps its own accessible name). */
function RailTip({ label }: { label: string }) {
    return <span className={styles.tip} aria-hidden="true">{label}</span>
}

interface SidebarInnerProps {
    isAutoHide?: boolean
    isRevealed?: boolean
}

// ─── Inner component (wrapped in Suspense for useSearchParams) ─────────────
function SidebarInner(props: SidebarInnerProps = {}) {
    const [isCollapsed, setIsCollapsed] = useState(false)
    const [pendingTab, setPendingTab] = useState<string | null>(null)
    const [intentTab, setIntentTab] = useState<string | null>(null)

    useEffect(() => {
        const mobile = window.matchMedia('(max-width: 767px)')
        const collapseOnMobile = () => { if (mobile.matches) setIsCollapsed(true) }
        collapseOnMobile()
        mobile.addEventListener('change', collapseOnMobile)
        return () => mobile.removeEventListener('change', collapseOnMobile)
    }, [])

    useEffect(() => {
        if (typeof document === 'undefined') return
        document.documentElement.style.setProperty('--ec-sidebar-width', isCollapsed ? '72px' : '264px')
        return () => {
            document.documentElement.style.removeProperty('--ec-sidebar-width')
        }
    }, [isCollapsed])

    const searchParams = useSearchParams()
    const pathname = usePathname()

    // Map URL state onto activeTab, catching Next.js nested folder routes like /listening, /speaking, /writing
    let activeTab: string = rootModuleOf(pathname) ?? searchParams.get("tab") ?? "dashboard"
    if (pathname === "/music" || pathname.startsWith("/music/")) {
        activeTab = "music"
    } else if (pathname === "/games" || pathname.startsWith("/games/")) {
        activeTab = "games"
    } else if (pathname === "/grammar" || pathname.startsWith("/grammar/")) {
        activeTab = "grammar"
    } else if (pathname.startsWith("/learning-path")) {
        activeTab = "learningPath"
    } else if (pathname.startsWith("/knowledge-universe")) {
        activeTab = "knowledgeUniverse"
    } else if (pathname.startsWith("/listening")) {
        activeTab = "listening"
    } else if (pathname.startsWith("/speaking")) {
        activeTab = "speaking"
    } else if (pathname.startsWith("/writing")) {
        activeTab = "writing"
    } else if (pathname.startsWith("/exams")) {
        activeTab = "exams"
    } else if (pathname.startsWith("/community")) {
        activeTab = "community"
    } else if (pathname === "/" && !searchParams.get("tab")) {
        activeTab = "dashboard"
    }

    const { locale, t } = useLanguage()
    const vi = locale === "vi"

    // live backend role (users.role): the admin section follows the DB, not the login-time session copy
    const { isAdmin } = useCurrentRole()
    const { unreadCount: adminFeedbackUnread } = useAdminFeedbackUnreadCount()

    const studySpaceLabel = vi ? "Không gian học tập" : "Study space"

    // Phones: the expanded sidebar is a drawer, so choosing a destination closes it again.
    const closeDrawerOnPhone = () => {
        if (window.matchMedia('(max-width: 767px)').matches) setIsCollapsed(true)
    }

    useEffect(() => {
        if (pendingTab === activeTab) setPendingTab(null)
    }, [activeTab, pendingTab])

    useEffect(() => {
        if (!pendingTab) return
        const timeout = window.setTimeout(() => setPendingTab(null), 15_000)
        return () => window.clearTimeout(timeout)
    }, [pendingTab])

    const handleModuleNavigate = (
        event: { preventDefault: () => void },
        tab: string,
        href: string,
    ) => {
        // Bounded duplicates: the current module or the destination already on its way is a no-op. Choosing a
        // DIFFERENT module while one is loading is allowed (the newer navigation wins), so the rail never freezes.
        if ((activeTab === tab && !pendingTab) || pendingTab === tab) {
            event.preventDefault()
            return
        }
        setPendingTab(tab)
        closeDrawerOnPhone()
        if (rootModuleOf(pathname) && isRootModuleHref(href)) {
            event.preventDefault()
            // These modules are views of one mounted layout and need no new server-component payload. Next.js keeps
            // usePathname/useSearchParams synchronized with native history and Back/Forward.
            window.history.pushState(null, "", href)
        }
    }

    const leaderboardLabel = t.leaderboard || (vi ? "Bảng xếp hạng" : "Leaderboard")
    const communityLabel = vi ? "Cộng đồng" : "Community"
    const wallpaperLabel = vi ? "Giao diện" : "Appearance"
    const adminNotificationsActive = pathname.startsWith("/admin/notifications")
    // Optimistic highlight: the pill moves to the chosen module on click, while the page loads; aria-current stays on
    // the page that is actually shown.
    const shownTab = pendingTab ?? activeTab
    const widthClass = props.isAutoHide
        ? `${styles.railAutoHide} ${props.isRevealed ? "" : styles.railHidden}`
        : isCollapsed
            ? "w-[72px]"
            : "w-[72px] max-md:z-[80] md:w-[264px]"

    return (
        <aside
            data-purpose="main-navigation-sidebar"
            data-autohide-owner="sidebar"
            className={`${styles.tokens} ${styles.rail} z-40 select-none transition-[width] duration-[300ms] ease-[cubic-bezier(.2,.8,.2,1)] max-md:transition-none motion-reduce:transition-none ${widthClass}`}
        >
            <OceanGlyphDefs />
            {!isCollapsed && (
                <button
                    type="button"
                    className={styles.scrim}
                    aria-label={vi ? "Đóng thanh điều hướng" : "Close navigation"}
                    onClick={() => setIsCollapsed(true)}
                />
            )}
            <div
                data-sp-shell=""
                data-nav-surface="sidebar"
                className={[
                    styles.panel,
                    "motion-reduce:transition-none",
                    // clip, never hidden: `overflow-x: hidden` would turn the panel into a vertical scroll container, and the
                    // few pixels of an equipped frame's canvas below the identity dock then gave it a full-height scrollbar
                    isCollapsed ? `w-[60px] overflow-visible ${styles.panelRail}` : `w-[252px] overflow-x-clip ${styles.drawerOpen}`,
                ].join(" ")}
                onKeyDown={(event) => {
                    if (event.key === "Escape" && !isCollapsed && window.matchMedia('(max-width: 767px)').matches) setIsCollapsed(true)
                }}
            >
                {/* ── Brand + collapse toggle ─────────────────────────── */}
                <div className={`${styles.brandRow} ${isCollapsed ? "justify-center px-2" : "justify-between gap-2.5 px-3.5"}`}>
                    {isCollapsed ? (
                        <button
                            type="button"
                            onClick={() => setIsCollapsed(false)}
                            aria-label={vi ? "Mở rộng thanh điều hướng" : "Expand navigation"}
                            aria-expanded={false}
                            className={`${styles.iconButton} ${styles.tipHost} relative cursor-pointer`}
                        >
                            <PanelLeft className="h-[17px] w-[17px]" />
                            <RailTip label={vi ? "Mở rộng thanh điều hướng" : "Expand navigation"} />
                        </button>
                    ) : (
                        <>
                            <Link
                                href="/dashboard"
                                prefetch={false}
                                onClick={closeDrawerOnPhone}
                                className="flex min-w-0 flex-1 items-center gap-3 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                            >
                                <span className={styles.brandMark}>
                                    <BrandWhaleIcon variant="clean" size="sm" priority className="relative h-7 w-7 drop-shadow-[0_2px_6px_rgba(34,211,238,0.45)]" />
                                </span>
                                <span className={`${styles.brandText} min-w-0 flex-1`}>
                                    <span className={`${styles.brandName} block truncate`}>
                                        English<span className={styles.brandAccent}>Coach</span>
                                    </span>
                                    <span className={`${styles.brandTagline} block truncate`}>
                                        {t.pathwayTagline || (vi ? "Lộ trình bứt phá" : "Breakthrough Path")}
                                    </span>
                                </span>
                            </Link>

                            <button
                                type="button"
                                onClick={() => setIsCollapsed(true)}
                                aria-label={vi ? "Thu gọn thanh điều hướng" : "Collapse navigation"}
                                aria-expanded={true}
                                title={vi ? "Thu gọn thanh điều hướng" : "Collapse navigation"}
                                className={`${styles.iconButton} shrink-0 cursor-pointer`}
                            >
                                <PanelLeftClose className="h-4 w-4" />
                            </button>
                        </>
                    )}
                </div>

                {/* ── Navigation (learning, sharing, administration) ───────────── */}
                <nav
                    data-guide="sidebar-nav"
                    aria-label={vi ? "Điều hướng chính" : "Main navigation"}
                    className={`${styles.nav} overflow-y-auto overflow-x-hidden ${isCollapsed ? styles.navRail : `custom-scrollbar ${styles.navOpen}`}`}
                >
                    <OceanCurrent itemClass={styles.item} />
                    {!isCollapsed && (
                        <div className={styles.sectionLabel}>{vi ? "HỌC TẬP" : "LEARNING"}</div>
                    )}

                    {NAV_CONFIG.map(({ tab, labelKey, label: ownLabel, icon: Icon, tone, iconColor, href }) => {
                        const isActive = activeTab === tab
                        const isShown = shownTab === tab
                        const isPending = pendingTab === tab
                        const label = ownLabel ? (vi ? ownLabel[0] : ownLabel[1]) : (labelKey ? t[labelKey] : "") || tab

                        return (
                            <Link
                                key={tab}
                                href={href}
                                prefetch={!isRootModuleHref(href) && intentTab === tab ? null : false}
                                onMouseEnter={() => setIntentTab(tab)}
                                onMouseLeave={() => setIntentTab(current => current === tab ? null : current)}
                                onFocus={() => setIntentTab(tab)}
                                onBlur={() => setIntentTab(current => current === tab ? null : current)}
                                onNavigate={(event) => handleModuleNavigate(event, tab, href)}
                                aria-label={label}
                                data-guide={`nav-${tab}`}
                                data-nav-item-id={tab}
                                aria-current={isActive ? "page" : undefined}
                                aria-busy={isPending || undefined}
                                scroll={false}
                                className={navItemClass(isShown, isCollapsed)}
                            >
                                <Glyph tone={tone} morphId={tab}><Icon className={iconClass(isShown, iconColor)} stroke={tonePaint(tone)} /></Glyph>
                                {!isCollapsed && <span className={styles.label}>{label}</span>}
                                {!isCollapsed && isPending ? (
                                    <Loader2 className="ml-auto h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                                ) : !isCollapsed && isShown && (
                                    <span className={styles.activeMark} aria-hidden="true" />
                                )}
                                {isCollapsed && isPending && <span className={styles.pendingRing} aria-hidden="true" />}
                                {isCollapsed && <RailTip label={label} />}
                            </Link>
                        )
                    })}

                    {/* ── CHIA SẺ: Bảng xếp hạng directly above Cộng đồng (Leaderboard Stage 2.1) ── */}
                    <div className={styles.divider} />
                    {!isCollapsed && (
                        <div className={styles.sectionLabel}>{vi ? "CHIA SẺ" : "COMMUNITY"}</div>
                    )}
                    <Link
                        href="/leaderboard"
                        prefetch={false}
                        onNavigate={(event) => handleModuleNavigate(event, "leaderboard", "/leaderboard")}
                        scroll={false}
                        data-nav="leaderboard"
                        data-nav-item-id="leaderboard"
                        aria-label={leaderboardLabel}
                        aria-current={activeTab === "leaderboard" ? "page" : undefined}
                        className={navItemClass(activeTab === "leaderboard" && !pendingTab || pendingTab === "leaderboard", isCollapsed)}
                    >
                        <Glyph tone="rank" morphId="leaderboard"><Trophy className={iconClass(shownTab === "leaderboard", "text-amber-500 dark:text-amber-300")} stroke={tonePaint("rank")} /></Glyph>
                        {!isCollapsed && <span className={styles.label}>{leaderboardLabel}</span>}
                        {!isCollapsed && pendingTab === "leaderboard" ? (
                            <Loader2 className="ml-auto h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                        ) : !isCollapsed && shownTab === "leaderboard" && (
                            <span className={styles.activeMark} aria-hidden="true" />
                        )}
                        {isCollapsed && pendingTab === "leaderboard" && <span className={styles.pendingRing} aria-hidden="true" />}
                        {isCollapsed && <RailTip label={leaderboardLabel} />}
                    </Link>
                    <Link
                        href="/community"
                        prefetch={false}
                        onNavigate={(event) => handleModuleNavigate(event, "community", "/community")}
                        data-nav-item-id="community"
                        aria-label={communityLabel}
                        aria-current={activeTab === "community" ? "page" : undefined}
                        aria-busy={pendingTab === "community" || undefined}
                        className={navItemClass(shownTab === "community", isCollapsed)}
                    >
                        <Glyph tone="community" morphId="community"><Users className={iconClass(shownTab === "community", "text-purple-500 dark:text-purple-300")} stroke={tonePaint("community")} /></Glyph>
                        {!isCollapsed && <span className={styles.label}>{communityLabel}</span>}
                        {!isCollapsed && pendingTab === "community" ? (
                            <Loader2 className="ml-auto h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                        ) : !isCollapsed && shownTab === "community" && <span className={styles.activeMark} aria-hidden="true" />}
                        {isCollapsed && pendingTab === "community" && <span className={styles.pendingRing} aria-hidden="true" />}
                        {isCollapsed && <RailTip label={communityLabel} />}
                    </Link>

                    {/* ── Admin Section (ROLE_ADMIN only; the server enforces every admin route itself) ── */}
                    {isAdmin && (
                        <div className={styles.adminZone}>
                            <div className={styles.divider} />
                            {!isCollapsed && (
                                <div className={`${styles.sectionLabel} ${styles.adminLabel}`}>{vi ? "HỆ THỐNG" : "SYSTEM"}</div>
                            )}
                            <Link
                                href="/admin/notifications"
                                prefetch={false}
                                onClick={closeDrawerOnPhone}
                                data-nav-item-id="adminNotifications"
                                aria-label={adminFeedbackUnread > 0
                                    ? `${vi ? "Thông báo" : "Notifications"} (${adminFeedbackUnread})`
                                    : (vi ? "Thông báo" : "Notifications")}
                                aria-current={adminNotificationsActive ? "page" : undefined}
                                className={navItemClass(adminNotificationsActive, isCollapsed)}
                            >
                                <Glyph tone="bell" morphId="adminNotifications"><Bell className={iconClass(adminNotificationsActive, "text-sky-600 dark:text-sky-300")} stroke={tonePaint("bell")} /></Glyph>
                                {isCollapsed && adminFeedbackUnread > 0 && (
                                    <span className={styles.countDot}>{adminFeedbackUnread > 99 ? '99+' : adminFeedbackUnread}</span>
                                )}
                                {!isCollapsed && <span className={styles.label}>{vi ? "Thông báo" : "Notifications"}</span>}
                                {!isCollapsed && adminFeedbackUnread > 0 && (
                                    <span className={styles.count}>{adminFeedbackUnread > 99 ? '99+' : adminFeedbackUnread}</span>
                                )}
                                {!isCollapsed && adminFeedbackUnread === 0 && adminNotificationsActive && (
                                    <span className={styles.activeMark} aria-hidden="true" />
                                )}
                                {isCollapsed && (
                                    <RailTip label={`${vi ? "Thông báo" : "Notifications"}${adminFeedbackUnread > 0 ? ` (${adminFeedbackUnread})` : ""}`} />
                                )}
                            </Link>

                            <Link
                                href="/admin/community"
                                prefetch={false}
                                onClick={closeDrawerOnPhone}
                                data-nav-item-id="adminCommunity"
                                aria-label={vi ? "Quản trị cộng đồng" : "Community Admin"}
                                aria-current={pathname.startsWith("/admin/community") ? "page" : undefined}
                                className={navItemClass(pathname.startsWith("/admin/community"), isCollapsed)}
                            >
                                <Glyph tone="admin" morphId="adminCommunity"><ShieldAlert className={iconClass(pathname.startsWith("/admin/community"), "text-amber-600 dark:text-amber-300")} stroke={tonePaint("admin")} /></Glyph>
                                {!isCollapsed && <span className={styles.label}>{vi ? "Quản trị cộng đồng" : "Community Admin"}</span>}
                                {isCollapsed && <RailTip label={vi ? "Quản trị cộng đồng" : "Community Admin"} />}
                            </Link>

                            <Link
                                href="/admin/premium"
                                prefetch={false}
                                onClick={closeDrawerOnPhone}
                                data-testid="sidebar-admin-premium"
                                data-nav-item-id="adminPremium"
                                aria-label={vi ? "Quản lý Premium" : "Premium Admin"}
                                aria-current={pathname.startsWith("/admin/premium") ? "page" : undefined}
                                className={navItemClass(pathname.startsWith("/admin/premium"), isCollapsed)}
                            >
                                <Glyph tone="admin" morphId="adminPremium"><Crown className={iconClass(pathname.startsWith("/admin/premium"), "text-amber-600 dark:text-amber-300")} stroke={tonePaint("admin")} /></Glyph>
                                {!isCollapsed && <span className={styles.label}>{vi ? "Quản lý Premium" : "Premium Admin"}</span>}
                                {isCollapsed && <RailTip label={vi ? "Quản lý Premium" : "Premium Admin"} />}
                            </Link>

                            <Link
                                href="/admin/garden-commerce"
                                prefetch={false}
                                onClick={closeDrawerOnPhone}
                                data-testid="sidebar-admin-garden-commerce"
                                data-nav-item-id="adminGardenCommerce"
                                aria-label={vi ? "Đối soát Skin Garden" : "Garden Orders"}
                                aria-current={pathname.startsWith("/admin/garden-commerce") ? "page" : undefined}
                                className={navItemClass(pathname.startsWith("/admin/garden-commerce"), isCollapsed)}
                            >
                                <Glyph tone="admin" morphId="adminGardenCommerce"><ReceiptText className={iconClass(pathname.startsWith("/admin/garden-commerce"), "text-amber-600 dark:text-amber-300")} stroke={tonePaint("admin")} /></Glyph>
                                {!isCollapsed && <span className={styles.label}>{vi ? "Đối soát Skin Garden" : "Garden Orders"}</span>}
                                {isCollapsed && <RailTip label={vi ? "Đối soát Skin Garden" : "Garden Orders"} />}
                            </Link>

                            <Link
                                href="/admin/security"
                                prefetch={false}
                                onClick={closeDrawerOnPhone}
                                data-testid="sidebar-admin-security"
                                data-nav-item-id="adminSecurity"
                                aria-label={vi ? "Bảo mật quản trị" : "Admin Security"}
                                aria-current={pathname.startsWith("/admin/security") ? "page" : undefined}
                                className={navItemClass(pathname.startsWith("/admin/security"), isCollapsed)}
                            >
                                <Glyph tone="security" morphId="adminSecurity"><ShieldCheck className={iconClass(pathname.startsWith("/admin/security"), "text-emerald-600 dark:text-emerald-300")} stroke={tonePaint("security")} /></Glyph>
                                {!isCollapsed && <span className={styles.label}>{vi ? "Bảo mật quản trị" : "Admin Security"}</span>}
                                {isCollapsed && <RailTip label={vi ? "Bảo mật quản trị" : "Admin Security"} />}
                            </Link>
                        </div>
                    )}
                </nav>

                {/* One shared glass dock; all three actions use the same row, glyph and interaction recipes. */}
                <div data-testid="sidebar-personalization" className={`${styles.personalize} ${isCollapsed ? styles.personalizeRail : ""}`}>
                    <OceanCurrent itemClass={styles.item} />
                    <Link href="/music" prefetch={false} onClick={closeDrawerOnPhone}
                        aria-label={t.music} aria-current={pathname === '/music' ? 'page' : undefined}
                        data-testid="sidebar-music" data-nav-item-id="music" className={navItemClass(pathname === '/music', isCollapsed)}>
                        <Glyph tone="music" morphId="music"><Music2 className={iconClass(pathname === '/music', 'text-violet-500 dark:text-violet-300')} stroke={tonePaint("music")} /></Glyph>
                        {!isCollapsed && <span className={styles.label}>{t.music}</span>}
                        {!isCollapsed && pathname === '/music' && <span className={styles.activeMark} aria-hidden="true" />}
                        {isCollapsed && <RailTip label={t.music} />}
                    </Link>
                    <button
                        type="button"
                        onClick={() => { closeDrawerOnPhone(); openWallpaperStudio() }}
                        aria-haspopup="dialog"
                        aria-label={wallpaperLabel}
                        data-testid="sidebar-wallpaper"
                        data-nav-item-id="appearance"
                        className={`${navItemClass(false, isCollapsed)} cursor-pointer`}
                    >
                        <span className={`${styles.glyph} ${styles.wpGlyph}`} data-tone="wallpaper" data-nav-morph-id="appearance" aria-hidden="true">
                            <ImageIcon className={`${iconClass(false, "text-fuchsia-500 dark:text-fuchsia-300")} ${styles.wpIcon}`} stroke={tonePaint("wallpaper")} />
                            <span className={styles.wpSwatch} />
                        </span>
                        {!isCollapsed && <span className={styles.label}>{wallpaperLabel}</span>}
                        {!isCollapsed && <ChevronRight className={styles.opensPanel} aria-hidden="true" />}
                        {isCollapsed && <RailTip label={wallpaperLabel} />}
                    </button>
                    <Link
                        href="/study-space"
                        prefetch={false}
                        onClick={closeDrawerOnPhone}
                        aria-label={studySpaceLabel}
                        aria-current={pathname.startsWith('/study-space') ? 'page' : undefined}
                        data-testid="sidebar-study-space"
                        data-nav-item-id="studySpace"
                        className={navItemClass(pathname.startsWith('/study-space'), isCollapsed)}
                    >
                        <Glyph tone="space" morphId="studySpace"><LampDesk className={iconClass(pathname.startsWith('/study-space'), "text-indigo-500 dark:text-indigo-300")} stroke={tonePaint("space")} /></Glyph>
                        {!isCollapsed && <span className={styles.label}>{studySpaceLabel}</span>}
                        {!isCollapsed && pathname.startsWith('/study-space') && <span className={styles.activeMark} aria-hidden="true" />}
                        {isCollapsed && <RailTip label={studySpaceLabel} />}
                    </Link>
                </div>
            </div>
        </aside>
    )
}

function SidebarHost() {
    const { data: session } = useSession()
    const { locale } = useLanguage()
    const vi = locale === "vi"
    const userId = session?.user ? String((session.user as { id?: string | number }).id ?? "") : ""
    const storageKey = navStorageKey(userId)

    const prefs = useSyncExternalStore(
        (cb) => subscribeNavPreferences(storageKey, cb),
        () => currentNavPreferences(storageKey),
        () => DEFAULT_NAV_PREFERENCES,
    )

    const autoHide = useAutoHideSurface({
        surface: "sidebar",
        visibility: prefs.visibility,
    })

    if (prefs.layout === "dock") {
        return null
    }

    return (
        <>
            {autoHide.isAutoHide && (
                <>
                    <div
                        aria-hidden="true"
                        data-testid="sidebar-edge-zone"
                        data-autohide-owner="sidebar"
                        className={styles.sidebarEdgeZone}
                        data-nav-edge=""
                    />
                    {!autoHide.isRevealed && (
                        <button
                            type="button"
                            data-testid="sidebar-touch-handle"
                            data-autohide-owner="sidebar"
                            aria-label={vi ? "Hiện thanh điều hướng bên" : "Reveal sidebar navigation"}
                            className={styles.sidebarTouchHandle}
                            onClick={autoHide.toggleRevealTouch}
                        >
                            <span className={styles.touchHandleBarVertical} aria-hidden="true" />
                        </button>
                    )}
                </>
            )}
            <SidebarInner
                isAutoHide={autoHide.isAutoHide}
                isRevealed={autoHide.isRevealed}
            />
        </>
    )
}

// ─── Exported wrapper (Suspense boundary for useSearchParams) ──────────────
export default function Sidebar() {
    return (
        <Suspense fallback={
            <aside className={`${styles.tokens} ${styles.rail} w-[72px]`}>
                <div className={`${styles.panel} ${styles.panelRail} w-[60px]`} />
            </aside>
        }>
            <SidebarHost />
        </Suspense>
    )
}
