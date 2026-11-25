"use client";

import React, { useState, useEffect, useRef, useCallback, Suspense } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
    Activity,
    AlertCircle,
    AudioLines,
    ChevronRight,
    Clock,
    Filter,
    MessageSquare,
    Mic,
    RefreshCw,
    Search,
    Trash2,
} from "lucide-react";
import { PushToTalkHub } from "@/components/features/speaking/PushToTalkHub";
import { ArenaEntryPanel } from "@/components/features/speaking/arena/ArenaEntryPanel";
import { ImportMaterialModal } from "@/components/features/listening/ImportMaterialModal";
import { SpeakingDashboardHeader } from "@/components/features/speaking/SpeakingDashboardHeader";
import { ContinuePracticeCard } from "@/components/features/speaking/ContinuePracticeCard";
import {
    SpeakingPracticeModes,
    PracticeModeType,
} from "@/components/features/speaking/SpeakingPracticeModes";
import {
    SpeakingProfilePanel,
    ProfileTabType,
} from "@/components/features/speaking/SpeakingProfilePanel";
import {
    ShadowingLibrarySection,
    ShadowingMaterialCard,
} from "@/components/features/speaking/shadowing/ShadowingLibrarySection";
import { StudioBackdrop, categoryTone, youtubePoster } from "@/components/features/speaking/studio/SpeakingArt";
import styles from "@/components/features/speaking/studio/speakingStudio.module.css";
import { useModuleEntryResource, useModuleEntryScope } from "@/hooks/useModuleEntryResource";
import {
    SPEAKING_METADATA_PATH,
    revalidateListeningMaterialResource,
} from "@/services/moduleEntryResources";
import { revalidateShadowingCatalog } from "@/services/shadowingCatalogApi";
import {
    useSpeakingHubEntry,
    revalidateSpeakingProfile,
} from "@/services/speakingProfileApi";
import {
    SpeakingScenarioSummary,
    ScenarioCatalogMetadata,
    ShadowingSessionState,
    getSpeakingContext,
    SpeakingContext,
    deleteCustomScenario,
} from "@/services/speakingApi";
import { CreateCustomScenarioModal } from "@/components/features/speaking/CreateCustomScenarioModal";
import { useLanguage } from "@/context/LanguageContext";
import { echoSrc } from "@/lib/brand/echoCharacters";
import { dispatchEchoModuleReady } from "@/lib/echo/contextBridge";

export type SpeakingHubView = "practice" | "profile";

const CEFR_FILTERS = ["ALL", "A2", "B1", "B2", "C1"];
const VALID_PROFILE_SUBS: readonly ProfileTabType[] = ["overview", "pronunciation", "history"];

function parseHubViewParam(raw?: string | null): SpeakingHubView {
    return raw === "profile" ? "profile" : "practice";
}

function parseProfileSubParam(raw?: string | null): ProfileTabType {
    if (raw === "overview" || raw === "pronunciation" || raw === "history") {
        return raw;
    }
    return "overview";
}

// "Nói theo chủ đề" loads only when its mode is opened (keeps the Speaking entry bundle unchanged)
const TopicSpeakingStudio = dynamic(() => import("@/components/features/speaking/topic/TopicSpeakingStudio"), {
    loading: () => (
        <div className="flex items-center justify-center py-16 text-gray-400 gap-2">
            <RefreshCw className="animate-spin text-indigo-500" size={20} />
        </div>
    ),
});

/** Nearest scrolling ancestor (the app frame scrolls `<main>`, not the window); null ⇒ the window scrolls. */
function scrollParentOf(el: HTMLElement): HTMLElement | null {
    for (let p = el.parentElement; p; p = p.parentElement) {
        const oy = getComputedStyle(p).overflowY;
        if ((oy === "auto" || oy === "scroll") && p.scrollHeight > p.clientHeight) return p;
    }
    return null;
}

/**
 * Brings a just-opened practice workspace into view (`scroll-margin-top` keeps a small gap above it): no jump when its heading is already comfortably visible,
 * instant scroll under prefers-reduced-motion, vertical only (no horizontal movement on mobile).
 */
function revealWorkspace(el: HTMLElement) {
    const parent = scrollParentOf(el);
    const viewTop = parent ? parent.getBoundingClientRect().top : 0;
    const viewHeight = parent ? parent.clientHeight : window.innerHeight;
    const offset = el.getBoundingClientRect().top - viewTop;
    const alreadyVisible = offset >= 0 && offset <= viewHeight * 0.35;
    if (!alreadyVisible) {
        const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
        el.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start", inline: "nearest" });
    }
    el.focus({ preventScroll: true });
}

function SpeakingContent() {
    const { locale, t } = useLanguage();
    const vi = locale === "vi";
    const router = useRouter();
    const pathname = usePathname() || "/speaking";
    const searchParams = useSearchParams();
    const scope = useModuleEntryScope();

    const foldText = (text?: string | null) =>
        (text ?? "")
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/đ/g, "d")
            .replace(/Đ/g, "D")
            .toLowerCase();

    const categoryFilters = [
        { value: "ALL", label: t.allCategories || (vi ? "Tất cả chủ đề" : "All Topics") },
        { value: "TRAVEL", label: t.categoryTravel || (vi ? "Du lịch" : "Travel") },
        { value: "DAILY_LIFE", label: t.categoryDailyLife || (vi ? "Đời sống" : "Daily Life") },
        { value: "BUSINESS", label: t.categoryBusiness || (vi ? "Công việc" : "Business") },
    ];

    const sourceType = searchParams.get("sourceType");
    const sourceIdParam = searchParams.get("sourceId");
    const sourceId = sourceIdParam ? parseInt(sourceIdParam, 10) : null;
    const materialIdParam = searchParams.get("materialId");

    useEffect(() => {
        if (materialIdParam && /^\d+$/.test(materialIdParam.trim())) {
            router.replace(`/speaking/shadowing/${materialIdParam.trim()}`);
        }
    }, [materialIdParam, router]);

    const [speakingContext, setSpeakingContext] = useState<SpeakingContext | null>(null);
    const [loadingContext, setLoadingContext] = useState(false);

    // Primary Hub Tab State: defaults to "Luyện tập" ("practice"), supports ?view=profile & ?sub=overview|pronunciation|history
    const initialView = parseHubViewParam(searchParams.get("view"));
    const initialSub = parseProfileSubParam(searchParams.get("sub"));
    const [activeHubView, setActiveHubView] = useState<SpeakingHubView>(initialView);
    const [activeProfileTab, setActiveProfileTab] = useState<ProfileTabType>(initialSub);
    const [pendingProfileSwitch, setPendingProfileSwitch] = useState<{
        sub: ProfileTabType;
    } | null>(null);
    const [isQuickCheckBusyLive, setIsQuickCheckBusyLive] = useState(false);

    // Practice modes: "shadowing" | "roleplay" | "assessment" | "topic"; a link may open one with ?mode= (Learning Path, Echo)
    const modeParam = searchParams.get("mode");
    const linkedMode = (["shadowing", "roleplay", "assessment", "topic"] as const).find((m) => m === modeParam);
    const [selectedPracticeMode, setSelectedPracticeMode] = useState<PracticeModeType>(linkedMode ?? "shadowing");
    // Bumped by every explicit mode activation (Start / Continue / mode card); on first render only for a ?mode= link on practice view.
    const [revealRequest, setRevealRequest] = useState(linkedMode && initialView === "practice" ? 1 : 0);
    const workspaceRef = useRef<HTMLDivElement>(null);
    const quickRef = useRef<HTMLDivElement>(null);
    const hubNavRef = useRef<HTMLDivElement>(null);
    const isQuickCheck = selectedPracticeMode === "assessment";

    const checkQuickCheckActiveCapture = useCallback((): boolean => {
        const container = quickRef.current;
        if (!container) return false;
        return Boolean(container.querySelector(`.${styles.recordOrb}, .${styles.processing}`));
    }, []);

    // Observe Quick Check DOM while mounted so the primary "Luyện tập" tab badge reflects active mic capture without touching PushToTalkHub.tsx
    useEffect(() => {
        if (activeHubView !== "practice" || !isQuickCheck || !quickRef.current || typeof MutationObserver === "undefined") {
            setIsQuickCheckBusyLive(false);
            return;
        }
        const target = quickRef.current;
        const sync = () => setIsQuickCheckBusyLive(checkQuickCheckActiveCapture());
        sync();
        const observer = new MutationObserver(sync);
        observer.observe(target, { childList: true, subtree: true });
        return () => observer.disconnect();
    }, [activeHubView, isQuickCheck, checkQuickCheckActiveCapture]);

    const pushHubUrl = useCallback(
        (nextView: SpeakingHubView, nextSub: ProfileTabType, explicitMode?: PracticeModeType) => {
            if (typeof window === "undefined") return;
            const params = new URLSearchParams(window.location.search);
            const prevView = parseHubViewParam(params.get("view"));
            const prevSub = parseProfileSubParam(params.get("sub"));
            const prevMode = params.get("mode");
            if (nextView === "profile") {
                params.set("view", "profile");
                params.set("sub", nextSub);
            } else {
                params.delete("view");
                params.delete("sub");
                if (explicitMode) {
                    params.set("mode", explicitMode);
                }
            }
            const qs = params.toString();
            const nextHref = qs ? `${pathname}?${qs}` : pathname;
            const currentHref = `${window.location.pathname}${window.location.search}`;
            if (nextHref !== currentHref) {
                const sameEffectiveState =
                    nextView === "profile"
                        ? prevView === "profile" && prevSub === nextSub
                        : prevView === "practice" && (!explicitMode || prevMode === explicitMode);
                if (sameEffectiveState && typeof window.history.replaceState === "function") {
                    window.history.replaceState(null, "", nextHref);
                } else {
                    window.history.pushState(null, "", nextHref);
                }
            }
        },
        [pathname],
    );

    const requestSwitchToProfile = useCallback(
        (sub: ProfileTabType = activeProfileTab, bypassGuard = false) => {
            const safeSub = VALID_PROFILE_SUBS.includes(sub) ? sub : "overview";
            if (!bypassGuard && activeHubView === "practice" && isQuickCheck && checkQuickCheckActiveCapture()) {
                setPendingProfileSwitch({ sub: safeSub });
                return;
            }
            setPendingProfileSwitch(null);
            setActiveProfileTab(safeSub);
            setActiveHubView("profile");
            pushHubUrl("profile", safeSub);
        },
        [activeHubView, activeProfileTab, checkQuickCheckActiveCapture, isQuickCheck, pushHubUrl],
    );

    const switchToPracticeView = useCallback(
        (modeToActivate?: PracticeModeType) => {
            setPendingProfileSwitch(null);
            setActiveHubView("practice");
            if (modeToActivate) {
                setSelectedPracticeMode(modeToActivate);
                setRevealRequest((n) => n + 1);
            }
            pushHubUrl("practice", activeProfileTab, modeToActivate);
        },
        [activeProfileTab, pushHubUrl],
    );

    const handleProfileSubTabChange = useCallback(
        (nextSub: ProfileTabType) => {
            setActiveProfileTab(nextSub);
            if (activeHubView === "profile") {
                pushHubUrl("profile", nextSub);
            }
        },
        [activeHubView, pushHubUrl],
    );

    const activateMode = (mode: PracticeModeType) => {
        if (activeHubView !== "practice") {
            setActiveHubView("practice");
            pushHubUrl("practice", activeProfileTab, mode);
        }
        setSelectedPracticeMode(mode);
        setRevealRequest((n) => n + 1);
    };

    // Sync ?view= / ?sub= / ?mode= from Next searchParams (initial deep links and router navigations)
    useEffect(() => {
        const urlView = parseHubViewParam(searchParams.get("view"));
        const urlSub = parseProfileSubParam(searchParams.get("sub"));
        if (urlView === "profile") {
            if (activeHubView !== "profile") {
                if (isQuickCheck && checkQuickCheckActiveCapture()) {
                    setPendingProfileSwitch({ sub: urlSub });
                } else {
                    setActiveHubView("profile");
                }
            }
            if (urlSub !== activeProfileTab) {
                setActiveProfileTab(urlSub);
            }
        } else if (activeHubView !== "practice" && !searchParams.get("view")) {
            setActiveHubView("practice");
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [searchParams]);

    // Sync Browser Back / Forward (`popstate`) cleanly for instant client history transitions
    useEffect(() => {
        const onPopState = () => {
            const params = new URLSearchParams(window.location.search);
            const nextView = parseHubViewParam(params.get("view"));
            const nextSub = parseProfileSubParam(params.get("sub"));
            const nextModeParam = params.get("mode");
            const validMode = (["shadowing", "roleplay", "assessment", "topic"] as const).find(
                (m) => m === nextModeParam,
            );
            if (nextView === "profile") {
                if (checkQuickCheckActiveCapture()) {
                    setPendingProfileSwitch({ sub: nextSub });
                    return;
                }
                setActiveProfileTab(nextSub);
                setActiveHubView("profile");
            } else {
                setPendingProfileSwitch(null);
                setActiveHubView("practice");
                if (validMode) {
                    setSelectedPracticeMode(validMode);
                }
            }
        };
        window.addEventListener("popstate", onPopState);
        return () => window.removeEventListener("popstate", onPopState);
    }, [checkQuickCheckActiveCapture]);

    // Sync ?mode= deep links when already mounted on /speaking (e.g. Echo JARVIS navigation).
    useEffect(() => {
        if (linkedMode && linkedMode !== selectedPracticeMode) {
            setSelectedPracticeMode(linkedMode);
            if (parseHubViewParam(searchParams.get("view")) === "practice") {
                setRevealRequest((n) => n + 1);
            }
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [linkedMode]);

    // Typed Echo JARVIS speaking_control bridge (`ec:speaking:intent`) + readiness handshake.
    useEffect(() => {
        const onSpeakingIntent = (event: Event) => {
            const customEv = event as CustomEvent<{
                view?: string;
                tab?: string;
                sub?: string;
                mode?: PracticeModeType;
                cefr?: string;
                category?: string;
                query?: string;
            }> & { __ecHandledBySpeakingHub?: boolean };
            const d = customEv.detail;
            if (!d) return;
            customEv.__ecHandledBySpeakingHub = true;

            const requestedProfile = d.view === "profile" || d.tab === "profile";
            const requestedPractice = d.view === "practice" || d.tab === "practice";

            if (requestedProfile) {
                const sub = parseProfileSubParam(d.sub);
                requestSwitchToProfile(sub);
                return;
            }

            if (requestedPractice) {
                switchToPracticeView(
                    d.mode === "shadowing" || d.mode === "roleplay" || d.mode === "assessment" || d.mode === "topic"
                        ? d.mode
                        : undefined,
                );
            } else if (d.mode === "shadowing" || d.mode === "roleplay" || d.mode === "assessment" || d.mode === "topic") {
                setActiveHubView("practice");
                pushHubUrl("practice", activeProfileTab, d.mode);
                setSelectedPracticeMode(d.mode);
                setRevealRequest((n) => n + 1);
            }

            if (typeof d.cefr === "string") {
                const upper = d.cefr.toUpperCase();
                setSelectedCefr(CEFR_FILTERS.includes(upper) ? upper : "ALL");
            }
            if (typeof d.category === "string") {
                setSelectedCategory(d.category.toUpperCase() || "ALL");
            }
            if (typeof d.query === "string") {
                setScenarioQuery(d.query);
            }
        };
        window.addEventListener("ec:speaking:intent", onSpeakingIntent);
        dispatchEchoModuleReady("speaking");
        return () => window.removeEventListener("ec:speaking:intent", onSpeakingIntent);
    }, [activeProfileTab, pushHubUrl, requestSwitchToProfile, switchToPracticeView]);

    // Runs after the selected workspace has been committed; one frame later its layout is final.
    useEffect(() => {
        if (revealRequest === 0) return;
        const frame = requestAnimationFrame(() => {
            const target = isQuickCheck ? quickRef.current : workspaceRef.current;
            if (target) revealWorkspace(target);
        });
        return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [revealRequest]);

    // Paginated Shadowing state & YouTube Import modal state (no eager unpaginated /listening/materials dump!)
    const [isImportModalOpen, setIsImportModalOpen] = useState(false);
    const [shadowingRefreshRevision, setShadowingRefreshRevision] = useState(0);
    const [activeShadowingMaterial, setActiveShadowingMaterial] = useState<ShadowingMaterialCard | null>(null);

    // Role-play scenarios (lazy: metadata on practice view, filtered scenario list only when Role-play mode is selected)
    const { data: catalogMetadata, mutate: mutateMetadata } = useModuleEntryResource<ScenarioCatalogMetadata>(
        SPEAKING_METADATA_PATH,
        activeHubView === "practice",
    );
    const [isCustomScenarioModalOpen, setIsCustomScenarioModalOpen] = useState(false);
    const [selectedCefr, setSelectedCefr] = useState<string>("ALL");
    const [selectedCategory, setSelectedCategory] = useState<string>("ALL");
    const [scenarioQuery, setScenarioQuery] = useState("");
    const scenarioParams = new URLSearchParams();
    if (selectedCefr !== "ALL") scenarioParams.set("cefrLevel", selectedCefr);
    if (selectedCategory !== "ALL") scenarioParams.set("category", selectedCategory);
    const scenarioPath = "/speaking/scenarios" + (scenarioParams.size ? `?${scenarioParams}` : "");
    const {
        data: scenariosData,
        isLoading: scenariosFetching,
        mutate: mutateScenarios,
    } = useModuleEntryResource<SpeakingScenarioSummary[]>(
        scenarioPath,
        activeHubView === "practice" && selectedPracticeMode === "roleplay",
    );
    const scenarios = scenariosData ?? [];
    const loadingScenarios = scenariosData === undefined && scenariosFetching;
    const foldedQuery = foldText(scenarioQuery.trim());
    const shownScenarios = foldedQuery
        ? scenarios.filter((sc) =>
              [sc.title, sc.description, sc.learnerRole, sc.aiRole].some((f) =>
                  foldText(f).includes(foldedQuery),
              ),
          )
        : scenarios;
    const [scenarioToDelete, setScenarioToDelete] = useState<SpeakingScenarioSummary | null>(null);
    const [isDeletingScenario, setIsDeletingScenario] = useState(false);

    const categoryLabel = (key?: string | null) =>
        catalogMetadata?.categories?.find((c) => c.key === key)?.label ||
        categoryFilters.find((c) => c.value === key)?.label ||
        key ||
        "";

    // Lightweight Hub Entry summary (`GET /api/v1/speaking/profile/entry` — 0 heavy pronunciation/history queries on "Luyện tập"!)
    const {
        data: hubEntry,
        isLoading: hubEntryLoading,
        mutate: mutateHubEntry,
    } = useSpeakingHubEntry(true);

    const loadProgressData = useCallback(() => {
        void mutateHubEntry();
        void revalidateSpeakingProfile(scope);
    }, [mutateHubEntry, scope]);

    const fetchCatalogMetadata = () => {
        void mutateMetadata();
    };
    const fetchScenarios = () => {
        void mutateScenarios();
    };

    const handleConfirmDeleteScenario = async () => {
        if (!scenarioToDelete) return;
        setIsDeletingScenario(true);
        try {
            await deleteCustomScenario(scenarioToDelete.id);
            await mutateScenarios(
                (prev) => (prev ?? []).filter((s) => s.id !== scenarioToDelete.id),
                { revalidate: true },
            );
            fetchCatalogMetadata();
            loadProgressData();
            setScenarioToDelete(null);
        } catch (err) {
            console.error("Failed to delete custom scenario:", err);
        } finally {
            setIsDeletingScenario(false);
        }
    };

    // Fetch handoff context if sourceType and sourceId are present
    useEffect(() => {
        if (sourceType && sourceId && !isNaN(sourceId)) {
            setLoadingContext(true);
            getSpeakingContext(sourceType, sourceId)
                .then((ctx) => {
                    setSpeakingContext(ctx);
                    setLoadingContext(false);
                })
                .catch((err) => {
                    console.warn("Failed to resolve speaking context:", err);
                    setSpeakingContext(null);
                    setLoadingContext(false);
                    router.replace("/speaking");
                });
        } else {
            setSpeakingContext(null);
        }
    }, [sourceType, sourceId, router]);

    const clearContext = () => {
        setSpeakingContext(null);
        router.replace(activeHubView === "profile" ? `/speaking?view=profile&sub=${activeProfileTab}` : "/speaking");
    };

    const getHandoffQueryString = () => {
        if (sourceType && sourceId) {
            return `?sourceType=${encodeURIComponent(sourceType)}&sourceId=${encodeURIComponent(sourceId)}`;
        }
        return "";
    };

    const rawActive = hubEntry?.activeSession ?? null;
    const activeSession: ShadowingSessionState | null = rawActive
        ? {
              sessionId: rawActive.sessionId,
              status: rawActive.status,
              mode: rawActive.mode,
              sourceType: rawActive.sourceType ?? undefined,
              sourceId: rawActive.sourceId ?? undefined,
              currentUnitIndex: rawActive.currentUnitIndex,
              completedUnitsCount: rawActive.completedUnitsCount,
              totalUnitsCount: rawActive.totalUnitsCount,
              createdAt: rawActive.createdAt,
              updatedAt: rawActive.updatedAt,
          }
        : null;
    const hasActiveLesson = Boolean(activeSession && activeSession.status === "ACTIVE");
    const activeSessionTitle = rawActive?.materialTitle || activeShadowingMaterial?.title || undefined;
    const rawThumb = rawActive?.thumbnail || activeShadowingMaterial?.thumbnail || null;
    const rawYtId = rawActive?.youtubeVideoId || activeShadowingMaterial?.youtubeVideoId || null;
    const activePoster = rawThumb || youtubePoster(rawYtId);
    const activePosterFallback = rawThumb ? youtubePoster(rawYtId) : null;

    const workTone =
        selectedPracticeMode === "roleplay"
            ? "talk"
            : selectedPracticeMode === "topic"
            ? "topic"
            : "voice";

    const handlePrimaryTabKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "Home" && e.key !== "End") {
            return;
        }
        e.preventDefault();
        if (e.key === "Home") {
            switchToPracticeView();
        } else if (e.key === "End") {
            requestSwitchToProfile();
        } else if (activeHubView === "practice") {
            requestSwitchToProfile();
        } else {
            switchToPracticeView();
        }
    };

    const activeModeReadableLabel =
        selectedPracticeMode === "roleplay"
            ? "Role-play AI"
            : selectedPracticeMode === "assessment"
            ? "Quick Check"
            : selectedPracticeMode === "topic"
            ? vi
                ? "Nói theo chủ đề"
                : "Topic Speaking"
            : "Shadowing";

    return (
        <div className={styles.page} data-loading={hubEntryLoading || loadingContext || undefined}>
            <StudioBackdrop />
            <div className={styles.inner} data-mode={selectedPracticeMode} data-hub-view={activeHubView}>
                {/* ── 1. Hero (heading + Speaking streak / targets) ── */}
                <SpeakingDashboardHeader
                    speakingContext={speakingContext}
                    streakDays={hubEntry ? hubEntry.currentStreakDays : undefined}
                    activeTargetsCount={hubEntry ? hubEntry.activeTargetsCount : undefined}
                    onClearContext={clearContext}
                />

                {/* ── 2. First-Class Primary Tab Navigation ("Luyện tập" | "Hồ sơ luyện nói") ── */}
                <div ref={hubNavRef} className={styles.hubNavRow}>
                    <div
                        className={styles.hubSegDock}
                        data-active-view={activeHubView}
                        style={{ ["--hub-idx" as string]: activeHubView === "profile" ? 1 : 0 }}
                        role="tablist"
                        aria-label={vi ? "Điều hướng chính Luyện nói" : "Speaking hub navigation"}
                        onKeyDown={handlePrimaryTabKeyDown}
                    >
                        <span className={styles.hubSegGlider} aria-hidden="true" />
                        <button
                            id="speaking-hub-tab-practice"
                            type="button"
                            role="tab"
                            aria-selected={activeHubView === "practice"}
                            aria-controls="speaking-hub-practice-stage"
                            data-testid="speaking-hub-tab-practice"
                            onClick={() => switchToPracticeView()}
                            className={styles.hubSegBtn}
                        >
                            <AudioLines />
                            <span>{vi ? "Luyện tập" : "Practice"}</span>
                            {isQuickCheckBusyLive ? (
                                <span className={styles.hubSegBadge}>
                                    <span className={styles.hubSegLiveDot} aria-hidden="true" />
                                    <span>{vi ? "Đang thu" : "Live"}</span>
                                </span>
                            ) : (
                                <span className={styles.hubSegBadge}>
                                    {vi ? "4 chế độ" : "4 modes"}
                                </span>
                            )}
                        </button>

                        <button
                            id="speaking-hub-tab-profile"
                            type="button"
                            role="tab"
                            aria-selected={activeHubView === "profile"}
                            aria-controls="speaking-profile-panel"
                            data-testid="speaking-hub-tab-profile"
                            onClick={() => requestSwitchToProfile()}
                            className={styles.hubSegBtn}
                        >
                            <Activity />
                            <span>{vi ? "Hồ sơ luyện nói" : "Speaking Profile"}</span>
                            {hubEntry && hubEntry.activeTargetsCount > 0 ? (
                                <span className={styles.hubSegBadge}>
                                    {vi
                                        ? `${hubEntry.activeTargetsCount} mục tiêu`
                                        : `${hubEntry.activeTargetsCount} targets`}
                                </span>
                            ) : null}
                        </button>
                    </div>

                    <div className={styles.hubContextStrip} aria-live="polite">
                        <span className={styles.hubContextDot} aria-hidden="true" />
                        <span>
                            {activeHubView === "practice"
                                ? vi
                                    ? `Đang chọn chế độ: ${activeModeReadableLabel}`
                                    : `Selected mode: ${activeModeReadableLabel}`
                                : vi
                                ? "Không gian phân tích âm học V2.2 và lịch sử"
                                : "V2.2 acoustic analytics and session history"}
                        </span>
                    </div>
                </div>

                {/* ── 3A. PRACTICE WORKSPACE ("Luyện tập") ── */}
                {activeHubView === "practice" && (
                    <div id="speaking-hub-practice-stage" style={{ display: "contents" }}>
                        {/* Continue + 4 Practice Modes */}
                        <div className={styles.lead}>
                            <ContinuePracticeCard
                                activeSession={activeSession}
                                title={activeSessionTitle}
                                thumbnail={activePoster}
                                fallbackThumbnail={activePosterFallback}
                                onSelectMode={activateMode}
                                handoffQueryString={getHandoffQueryString()}
                            />
                            <SpeakingPracticeModes
                                selectedMode={selectedPracticeMode}
                                onSelectMode={activateMode}
                                hasActiveLesson={hasActiveLesson}
                            />
                        </div>

                        {/* Arena owns the former duplicate studio column. Its poster loads no 3D runtime. */}
                        <div className={styles.quick}>
                            <ArenaEntryPanel />
                        </div>

                        {/* The original Quick Check is opened by its existing mode card on every screen size. */}
                        {isQuickCheck && (
                            <div
                                ref={quickRef}
                                id="speaking-quick-check"
                                tabIndex={-1}
                                className={styles.work}
                                data-tone="mic"
                            >
                                <PushToTalkHub onComplete={loadProgressData} />
                            </div>
                        )}

                        {/* Main Practice Stage Area (Active Mode Workspace) */}
                        {!isQuickCheck && (
                            <div
                                ref={workspaceRef}
                                id="speaking-workspace"
                                tabIndex={-1}
                                data-testid="speaking-practice-workspace"
                                data-tone={workTone}
                                className={`${styles.panel} ${styles.work} ${selectedPracticeMode === "topic" ? styles.workTopic : ""}`}
                                role="region"
                                aria-label={vi ? "Khu vực luyện tập" : "Practice Area"}
                            >
                                {/* Mode 1: Paginated Shadowing Library (12 cards / 4×3 grid from @b1-shadowing) */}
                                {selectedPracticeMode === "shadowing" && (
                                    <ShadowingLibrarySection
                                        handoffQueryString={getHandoffQueryString()}
                                        onOpenImportModal={() => setIsImportModalOpen(true)}
                                        refreshRevision={shadowingRefreshRevision}
                                        activeMaterialId={activeSession?.sourceId ?? null}
                                        onResolvedActiveMaterial={setActiveShadowingMaterial}
                                    />
                                )}

                                {/* Mode 2: AI Role-Play Scenarios */}
                                {selectedPracticeMode === "roleplay" && (
                                    <div>
                                        <div className={styles.workHead}>
                                            <div>
                                                <span className={styles.workEyebrow}>
                                                    <MessageSquare /> Role-play AI
                                                </span>
                                                <h2 className={styles.workTitle}>
                                                    {vi
                                                        ? "Thư Viện Kịch Bản Hội Thoại Thực Tế"
                                                        : "Conversational Scenario Library"}
                                                </h2>
                                                <p className={styles.workText}>
                                                    {vi
                                                        ? "Lựa chọn kịch bản tình huống đời sống và công việc để rèn luyện phản xạ giao tiếp với phân vai rõ ràng."
                                                        : "Choose real-life and workplace scenarios to build conversational reflexes with clear role distribution."}
                                                </p>
                                            </div>
                                            <button
                                                type="button"
                                                onClick={() => setIsCustomScenarioModalOpen(true)}
                                                className={`${styles.primary} self-start md:self-auto`}
                                            >
                                                <img
                                                    src={echoSrc("social", 24)}
                                                    alt=""
                                                    aria-hidden="true"
                                                    className="w-4 h-4 object-contain"
                                                />
                                                <span>{vi ? "Tạo tình huống" : "Custom Scenario"}</span>
                                            </button>
                                        </div>

                                        {/* Search (this list) · CEFR level · category */}
                                        <div className={styles.toolbar}>
                                            <div className="flex flex-col gap-2 min-w-0">
                                                <div
                                                    className={styles.filterRow}
                                                    role="group"
                                                    aria-label={vi ? "Lọc theo cấp độ CEFR" : "Filter by CEFR level"}
                                                >
                                                    <span className={styles.filterLabel}>
                                                        <Filter /> {t.filterLevel || (vi ? "Cấp độ:" : "Level:")}
                                                    </span>
                                                    {(catalogMetadata?.levels && catalogMetadata.levels.length > 0
                                                        ? [
                                                              {
                                                                  key: "ALL",
                                                                  label: vi ? "Tất cả" : "All",
                                                                  count: catalogMetadata.totalCount,
                                                              },
                                                              ...catalogMetadata.levels,
                                                          ]
                                                        : CEFR_FILTERS.map((lvl) => ({
                                                              key: lvl,
                                                              label: lvl === "ALL" ? (vi ? "Tất cả" : "All") : lvl,
                                                              count: null,
                                                          }))
                                                    ).map((lvl) => (
                                                        <button
                                                            key={lvl.key}
                                                            type="button"
                                                            onClick={() => setSelectedCefr(lvl.key)}
                                                            className={styles.pill}
                                                            aria-pressed={selectedCefr === lvl.key}
                                                        >
                                                            {lvl.label || lvl.key}
                                                            {lvl.count != null && <small>({lvl.count})</small>}
                                                        </button>
                                                    ))}
                                                </div>
                                                <div
                                                    className={styles.filterRow}
                                                    role="group"
                                                    aria-label={vi ? "Lọc theo chủ đề" : "Filter by topic"}
                                                >
                                                    <span className={styles.filterLabel}>
                                                        {vi ? "Chủ đề:" : "Topic:"}
                                                    </span>
                                                    {(catalogMetadata?.categories &&
                                                    catalogMetadata.categories.length > 0
                                                        ? [
                                                              {
                                                                  key: "ALL",
                                                                  label:
                                                                      t.allCategories ||
                                                                      (vi ? "Tất cả chủ đề" : "All Topics"),
                                                                  count: catalogMetadata.totalCount,
                                                              },
                                                              ...catalogMetadata.categories,
                                                          ]
                                                        : categoryFilters.map((c) => ({
                                                              key: c.value,
                                                              label: c.label,
                                                              count: null,
                                                          }))
                                                    ).map((cat) => (
                                                        <button
                                                            key={cat.key}
                                                            type="button"
                                                            onClick={() => setSelectedCategory(cat.key)}
                                                            className={styles.pill}
                                                            aria-pressed={selectedCategory === cat.key}
                                                        >
                                                            {cat.label || categoryLabel(cat.key)}
                                                            {cat.count != null && <small>({cat.count})</small>}
                                                        </button>
                                                    ))}
                                                </div>
                                            </div>
                                            <label className={styles.search}>
                                                <Search aria-hidden="true" />
                                                <input
                                                    type="search"
                                                    value={scenarioQuery}
                                                    onChange={(e) => setScenarioQuery(e.target.value)}
                                                    placeholder={
                                                        vi
                                                            ? "Tìm trong danh sách kịch bản..."
                                                            : "Search these scenarios..."
                                                    }
                                                    aria-label={
                                                        vi
                                                            ? "Tìm kịch bản theo tên, mô tả hoặc vai"
                                                            : "Search scenarios by title, description or role"
                                                    }
                                                />
                                            </label>
                                        </div>
                                        {foldedQuery && !loadingScenarios && scenarios.length > 0 && (
                                            <p className={styles.resultNote} role="status">
                                                {vi
                                                    ? `Hiển thị ${shownScenarios.length} / ${scenarios.length} kịch bản`
                                                    : `Showing ${shownScenarios.length} of ${scenarios.length} scenarios`}
                                            </p>
                                        )}

                                        {/* Scenario Grid */}
                                        {loadingScenarios ? (
                                            <div className={styles.loading} role="status">
                                                <RefreshCw />
                                                <span>
                                                    {vi
                                                        ? "Đang tải danh mục kịch bản hội thoại..."
                                                        : "Loading dialogue scenarios..."}
                                                </span>
                                            </div>
                                        ) : shownScenarios.length === 0 ? (
                                            <div className={styles.empty}>
                                                <MessageSquare />
                                                <h3>
                                                    {vi
                                                        ? "Không tìm thấy kịch bản phù hợp"
                                                        : "No matching scenarios found"}
                                                </h3>
                                                <p>
                                                    {foldedQuery
                                                        ? vi
                                                            ? `Không có kịch bản nào khớp với “${scenarioQuery.trim()}” trong bộ lọc hiện tại.`
                                                            : `No scenario matches “${scenarioQuery.trim()}” with the current filters.`
                                                        : vi
                                                        ? "Thử điều chỉnh bộ lọc cấp độ hoặc chủ đề để xem thêm các kịch bản khác."
                                                        : "Try adjusting level or topic filters to discover more scenarios."}
                                                </p>
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        setSelectedCefr("ALL");
                                                        setSelectedCategory("ALL");
                                                        setScenarioQuery("");
                                                    }}
                                                    className={`${styles.soft} mt-2`}
                                                >
                                                    {t.resetFilters || (vi ? "Đặt lại bộ lọc" : "Reset Filters")}
                                                </button>
                                            </div>
                                        ) : (
                                            <div className={styles.cards}>
                                                {shownScenarios.map((sc) => {
                                                    const { tone, Icon } = categoryTone(sc.category);
                                                    return (
                                                        <article
                                                            key={sc.id}
                                                            className={`${styles.card} ${styles.scenario}`}
                                                            data-tone={tone}
                                                        >
                                                            <div className={styles.scenarioTop}>
                                                                <span className={styles.emblem} aria-hidden="true">
                                                                    <Icon />
                                                                </span>
                                                                <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                                                                    <div className={styles.cardMeta}>
                                                                        <div className={styles.chips}>
                                                                            {sc.category && (
                                                                                <span className={styles.chip}>
                                                                                    {categoryLabel(sc.category)}
                                                                                </span>
                                                                            )}
                                                                            {sc.cefrLevel && (
                                                                                <span
                                                                                    className={`${styles.chip} ${styles.chipNeutral}`}
                                                                                >
                                                                                    {sc.cefrLevel}
                                                                                </span>
                                                                            )}
                                                                            {sc.isCustom && (
                                                                                <span
                                                                                    className={`${styles.chip} ${styles.chipCustom}`}
                                                                                >
                                                                                    {vi ? "Tự tạo" : "Custom"}
                                                                                </span>
                                                                            )}
                                                                        </div>
                                                                        {sc.estimatedMinutes &&
                                                                        sc.estimatedMinutes > 0 ? (
                                                                            <span className={styles.minutes}>
                                                                                <Clock />~{sc.estimatedMinutes}{" "}
                                                                                {vi ? "phút" : "mins"}
                                                                            </span>
                                                                        ) : null}
                                                                    </div>
                                                                    <h3 className={styles.cardTitle}>{sc.title}</h3>
                                                                </div>
                                                            </div>
                                                            <p className={styles.cardText}>{sc.description}</p>
                                                            <div className={styles.roles}>
                                                                <div>
                                                                    <i style={{ background: "#10b981" }} />
                                                                    <span>{vi ? "Bạn đóng vai:" : "Your role:"}</span>
                                                                    <b title={sc.learnerRole}>{sc.learnerRole}</b>
                                                                </div>
                                                                <div>
                                                                    <i style={{ background: "#a855f7" }} />
                                                                    <span>{vi ? "AI đóng vai:" : "AI role:"}</span>
                                                                    <b title={sc.aiRole}>{sc.aiRole}</b>
                                                                </div>
                                                            </div>
                                                            <div className={styles.cardAction}>
                                                                <button
                                                                    type="button"
                                                                    onClick={() =>
                                                                        router.push(
                                                                            `/speaking/roleplay/${sc.id}${getHandoffQueryString()}`,
                                                                        )
                                                                    }
                                                                    className={styles.primary}
                                                                >
                                                                    <span>
                                                                        {vi
                                                                            ? "Xem kịch bản và Mục tiêu"
                                                                            : "View Scenario and Objectives"}
                                                                    </span>
                                                                    <ChevronRight className="ml-auto" />
                                                                </button>
                                                                {sc.isCustom && (
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => setScenarioToDelete(sc)}
                                                                        className={styles.iconBtn}
                                                                        title={vi ? "Xóa kịch bản" : "Delete scenario"}
                                                                        aria-label={
                                                                            vi
                                                                                ? `Xóa kịch bản ${sc.title}`
                                                                                : `Delete scenario ${sc.title}`
                                                                        }
                                                                    >
                                                                        <Trash2 />
                                                                    </button>
                                                                )}
                                                            </div>
                                                        </article>
                                                    );
                                                })}
                                            </div>
                                        )}

                                        <CreateCustomScenarioModal
                                            isOpen={isCustomScenarioModalOpen}
                                            onClose={() => setIsCustomScenarioModalOpen(false)}
                                            onSuccess={(newScenario) => {
                                                setIsCustomScenarioModalOpen(false);
                                                fetchCatalogMetadata();
                                                fetchScenarios();
                                                router.push(
                                                    `/speaking/roleplay/${newScenario.id}${getHandoffQueryString()}`,
                                                );
                                            }}
                                        />

                                        {/* Delete Confirmation Modal */}
                                        {scenarioToDelete && (
                                            <div
                                                className={styles.scrim}
                                                onClick={() => !isDeletingScenario && setScenarioToDelete(null)}
                                                onKeyDown={(e) => {
                                                    if (e.key === "Escape" && !isDeletingScenario) {
                                                        setScenarioToDelete(null);
                                                    }
                                                }}
                                            >
                                                <div
                                                    className={`${styles.dialog} animate-in fade-in zoom-in-95 duration-150`}
                                                    role="alertdialog"
                                                    aria-modal="true"
                                                    aria-labelledby="delete-scenario-title"
                                                    onClick={(e) => e.stopPropagation()}
                                                >
                                                    <div className={styles.dialogHead}>
                                                        <span className={styles.dialogIcon}>
                                                            <Trash2 />
                                                        </span>
                                                        <div>
                                                            <h3
                                                                id="delete-scenario-title"
                                                                className={styles.dialogTitle}
                                                            >
                                                                {vi
                                                                    ? "Xác nhận xóa kịch bản"
                                                                    : "Delete Custom Scenario"}
                                                            </h3>
                                                            <p className={styles.dialogText}>
                                                                {vi
                                                                    ? "Hành động này không thể hoàn tác và sẽ xóa toàn bộ lịch sử luyện tập của kịch bản này."
                                                                    : "This action cannot be undone and will delete all practice history for this scenario."}
                                                            </p>
                                                        </div>
                                                    </div>

                                                    <p className="text-sm leading-relaxed">
                                                        {vi ? (
                                                            <>
                                                                Bạn có chắc chắn muốn xóa kịch bản tự tạo{" "}
                                                                <strong>&ldquo;{scenarioToDelete.title}&rdquo;</strong>{" "}
                                                                này?
                                                            </>
                                                        ) : (
                                                            <>
                                                                Are you sure you want to delete{" "}
                                                                <strong>&ldquo;{scenarioToDelete.title}&rdquo;</strong>?
                                                            </>
                                                        )}
                                                    </p>

                                                    <div className={styles.dialogActions}>
                                                        <button
                                                            type="button"
                                                            autoFocus
                                                            onClick={() => setScenarioToDelete(null)}
                                                            disabled={isDeletingScenario}
                                                            className={styles.soft}
                                                        >
                                                            {vi ? "Hủy" : "Cancel"}
                                                        </button>
                                                        <button
                                                            type="button"
                                                            onClick={handleConfirmDeleteScenario}
                                                            disabled={isDeletingScenario}
                                                            className={`${styles.primary} ${styles.danger}`}
                                                        >
                                                            {isDeletingScenario ? (
                                                                <>
                                                                    <RefreshCw className="animate-spin" />
                                                                    <span>{vi ? "Đang xóa..." : "Deleting..."}</span>
                                                                </>
                                                            ) : (
                                                                <span>{vi ? "Xóa kịch bản" : "Delete"}</span>
                                                            )}
                                                        </button>
                                                    </div>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )}

                                {/* Mode 4: Topic speaking (no AI) */}
                                {selectedPracticeMode === "topic" && <TopicSpeakingStudio />}
                            </div>
                        )}

                        {/* Import YouTube Modal for Shadowing */}
                        <ImportMaterialModal
                            isOpen={isImportModalOpen}
                            onClose={() => setIsImportModalOpen(false)}
                            onSuccess={() => {
                                setIsImportModalOpen(false);
                                setShadowingRefreshRevision((n) => n + 1);
                                void revalidateShadowingCatalog();
                                void revalidateListeningMaterialResource();
                            }}
                        />
                    </div>
                )}

                {/* ── 3B. DEDICATED SPEAKING PROFILE WORKSPACE ("Hồ sơ luyện nói") ── */}
                {activeHubView === "profile" && (
                    <SpeakingProfilePanel
                        isOpen={true}
                        activeTab={activeProfileTab}
                        onTabChange={handleProfileSubTabChange}
                        onJumpToPractice={(mode) => switchToPracticeView(mode ?? selectedPracticeMode)}
                        onReloadSummary={loadProgressData}
                    />
                )}
            </div>

            {/* ── Active Quick Check Recording Safety Guard Modal ── */}
            {pendingProfileSwitch &&
                (() => {
                    const guardModal = (
                        <div
                            className={styles.page}
                            style={{
                                position: "fixed",
                                inset: 0,
                                zIndex: 80,
                                minHeight: 0,
                                background: "transparent",
                                overflow: "visible",
                            }}
                        >
                            <div
                                className={styles.scrim}
                                data-testid="quick-check-leave-guard"
                                onClick={() => setPendingProfileSwitch(null)}
                                onKeyDown={(e) => {
                                    if (e.key === "Escape") setPendingProfileSwitch(null);
                                }}
                            >
                                <div
                                    className={styles.dialog}
                                    role="alertdialog"
                                    aria-modal="true"
                                    aria-labelledby="qc-guard-title"
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    <div className={styles.dialogHead}>
                                        <span className={styles.dialogIcon}>
                                            <AlertCircle />
                                        </span>
                                        <div>
                                            <h3 id="qc-guard-title" className={styles.dialogTitle}>
                                                {vi ? "Đang thu âm hoặc chấm điểm Quick Check" : "Quick Check Recording Active"}
                                            </h3>
                                            <p className={styles.dialogText}>
                                                {vi
                                                    ? "Chuyển sang Hồ sơ luyện nói ngay bây giờ sẽ dừng lượt thu hiện tại của bạn. Bạn muốn ở lại hoàn tất hay dừng để mở hồ sơ?"
                                                    : "Switching to Speaking Profile now will stop your active Quick Check recording. Would you like to continue recording or stop and open your profile?"}
                                            </p>
                                        </div>
                                    </div>

                                    <div className={styles.dialogActions}>
                                        <button
                                            type="button"
                                            autoFocus
                                            onClick={() => setPendingProfileSwitch(null)}
                                            className={styles.soft}
                                        >
                                            <Mic />
                                            <span>{vi ? "Tiếp tục Quick Check" : "Keep Recording"}</span>
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => requestSwitchToProfile(pendingProfileSwitch.sub, true)}
                                            className={`${styles.primary} ${styles.danger}`}
                                        >
                                            <span>{vi ? "Dừng và mở Hồ sơ" : "Stop and Open Profile"}</span>
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    );
                    return typeof document !== "undefined" ? createPortal(guardModal, document.body) : guardModal;
                })()}
        </div>
    );
}

export default function SpeakingPage() {
    const scope = useModuleEntryScope();
    return (
        <Suspense fallback={<div className="p-12 text-center text-gray-400">Loading...</div>}>
            <SpeakingContent key={scope ?? "pending"} />
        </Suspense>
    );
}
