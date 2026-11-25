"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
    AlertCircle,
    BookOpen,
    ChevronRight,
    Clock,
    Filter,
    Headphones,
    Play,
    Plus,
    RefreshCw,
    RotateCcw,
    Search,
    X,
} from "lucide-react";
import { StudioThumb, youtubePoster } from "@/components/features/speaking/studio/SpeakingArt";
import studioStyles from "@/components/features/speaking/studio/speakingStudio.module.css";
import { useModuleEntryScope } from "@/hooks/useModuleEntryResource";
import { useLanguage } from "@/context/LanguageContext";
import {
    SHADOWING_DEFAULT_PAGE_SIZE,
    ShadowingMaterialCard,
    ShadowingSourceFilter,
    parseShPageParam,
    readShadowingViewState,
    revalidateShadowingCatalog,
    useShadowingCatalog,
    useShadowingMaterialCard,
    writeShadowingViewState,
} from "@/services/shadowingCatalogApi";
import { ShadowingPagination } from "./ShadowingPagination";
import styles from "./shadowingLibrary.module.css";

export type { ShadowingMaterialCard };

export interface ShadowingLibrarySectionProps {
    handoffQueryString?: string;
    onOpenImportModal: () => void;
    refreshRevision?: number;
    onResolvedActiveMaterial?: (mat: ShadowingMaterialCard | null) => void;
    activeMaterialId?: number | null;
}

const CEFR_OPTIONS = ["ALL", "A2", "B1", "B2", "C1"] as const;

export function ShadowingLibrarySection({
    handoffQueryString = "",
    onOpenImportModal,
    refreshRevision,
    onResolvedActiveMaterial,
    activeMaterialId,
}: ShadowingLibrarySectionProps) {
    const { locale, t } = useLanguage();
    const vi = locale === "vi";
    const router = useRouter();
    const pathname = usePathname() || "/speaking";
    const searchParams = useSearchParams();
    const scope = useModuleEntryScope();

    const headingRef = useRef<HTMLHeadingElement>(null);

    const rawShPageParam = searchParams.get("shPage");
    const urlPageOnRender = parseShPageParam(rawShPageParam);

    const initialHydrated = useMemo(() => {
        if (urlPageOnRender !== null) {
            const saved = readShadowingViewState(scope);
            return {
                page: urlPageOnRender,
                cefr: saved?.cefr ?? "ALL",
                accent: saved?.accent ?? "ALL",
                source: saved?.source ?? ("ALL" as ShadowingSourceFilter),
                q: saved?.q ?? "",
            };
        }
        const saved = readShadowingViewState(scope);
        return {
            page: saved?.page ?? 1,
            cefr: saved?.cefr ?? "ALL",
            accent: saved?.accent ?? "ALL",
            source: saved?.source ?? ("ALL" as ShadowingSourceFilter),
            q: saved?.q ?? "",
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const [currentPage, setCurrentPage] = useState<number>(initialHydrated.page);
    const [selectedCefr, setSelectedCefr] = useState<string>(initialHydrated.cefr);
    const [selectedAccent, setSelectedAccent] = useState<string>(initialHydrated.accent);
    const [selectedSource, setSelectedSource] = useState<ShadowingSourceFilter>(initialHydrated.source);
    const [searchInput, setSearchInput] = useState<string>(initialHydrated.q);
    const [debouncedQuery, setDebouncedQuery] = useState<string>(initialHydrated.q);

    const hydratedScopeRef = useRef<string | null>(scope);
    const prevRawShPageParamRef = useRef<string | null>(rawShPageParam);
    const pendingUrlRawRef = useRef<{ expected: string | null; at: number } | null>(null);
    const prevRefreshRevisionRef = useRef<number | undefined>(refreshRevision);

    const syncUrlPage = useCallback(
        (nextPage: number) => {
            const expectedRaw = nextPage <= 1 ? null : String(nextPage);
            const baseQuery =
                typeof window !== "undefined" && window.location && typeof window.location.search === "string"
                    ? window.location.search
                    : searchParams.toString();
            const params = new URLSearchParams(baseQuery);
            const currentRawInUrl = params.get("shPage");
            const effectiveRaw =
                pendingUrlRawRef.current !== null ? pendingUrlRawRef.current.expected : currentRawInUrl;

            if (effectiveRaw === expectedRaw && currentRawInUrl === expectedRaw) {
                return;
            }
            if (nextPage <= 1) {
                params.delete("shPage");
            } else {
                params.set("shPage", String(nextPage));
            }
            const qs = params.toString();
            const target = qs ? `${pathname}?${qs}` : pathname;
            pendingUrlRawRef.current = { expected: expectedRaw, at: Date.now() };
            router.replace(target, { scroll: false });
        },
        [pathname, router, searchParams]
    );

    const scrollHeadingIntoView = useCallback(() => {
        if (typeof window === "undefined") return;
        requestAnimationFrame(() => {
            const el = headingRef.current;
            if (!el) return;
            const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
            el.scrollIntoView({
                behavior: reduceMotion ? "auto" : "smooth",
                block: "start",
                inline: "nearest",
            });
            el.focus({ preventScroll: true });
        });
    }, []);

    // Hydrate user-scoped session state when authenticated identity resolves or changes,
    // and ensure URL reflects restored page on mount (e.g. returning from /speaking/shadowing/[id]).
    useEffect(() => {
        if (hydratedScopeRef.current === scope) {
            if (scope && urlPageOnRender === null && currentPage > 1) {
                syncUrlPage(currentPage);
            }
            return;
        }
        hydratedScopeRef.current = scope;
        if (!scope) {
            setCurrentPage(1);
            setSelectedCefr("ALL");
            setSelectedAccent("ALL");
            setSelectedSource("ALL");
            setSearchInput("");
            setDebouncedQuery("");
            return;
        }

        const saved = readShadowingViewState(scope);
        const restoredPage = urlPageOnRender ?? saved?.page ?? 1;
        const restoredCefr = saved?.cefr ?? "ALL";
        const restoredAccent = saved?.accent ?? "ALL";
        const restoredSource = saved?.source ?? "ALL";
        const restoredQ = saved?.q ?? "";

        setCurrentPage(restoredPage);
        setSelectedCefr(restoredCefr);
        setSelectedAccent(restoredAccent);
        setSelectedSource(restoredSource);
        setSearchInput(restoredQ);
        setDebouncedQuery(restoredQ);

        if (urlPageOnRender === null && restoredPage > 1) {
            syncUrlPage(restoredPage);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [scope]);

    // Sync external URL ?shPage=N changes (e.g. Browser Back / Forward while mounted),
    // strictly decoupled from our own in-flight async router.replace() calls.
    useEffect(() => {
        if (rawShPageParam === prevRawShPageParamRef.current) {
            return;
        }
        prevRawShPageParamRef.current = rawShPageParam;

        const pending = pendingUrlRawRef.current;
        if (pending !== null) {
            if (rawShPageParam === pending.expected) {
                pendingUrlRawRef.current = null;
                return;
            }
            if (Date.now() - pending.at < 1500) {
                // Ignore stale intermediate searchParams frames while our programmatic replace settles.
                return;
            }
            pendingUrlRawRef.current = null;
        }

        const nextFromUrl = parseShPageParam(rawShPageParam) ?? 1;
        setCurrentPage((prev) => (prev === nextFromUrl ? prev : nextFromUrl));
    }, [rawShPageParam]);

    // Sync Browser Back / Forward popstate immediately against window.location.search.
    useEffect(() => {
        if (typeof window === "undefined") return;
        const onPopState = () => {
            pendingUrlRawRef.current = null;
            if (!window.location || typeof window.location.search !== "string") return;
            const popRaw = new URLSearchParams(window.location.search).get("shPage");
            prevRawShPageParamRef.current = popRaw;
            const nextFromPop = parseShPageParam(popRaw) ?? 1;
            setCurrentPage((prev) => (prev === nextFromPop ? prev : nextFromPop));
        };
        window.addEventListener("popstate", onPopState);
        return () => window.removeEventListener("popstate", onPopState);
    }, []);

    // Persist current view state into user-scoped sessionStorage whenever page or filters settle.
    useEffect(() => {
        if (!scope) return;
        writeShadowingViewState(scope, {
            page: currentPage,
            cefr: selectedCefr,
            accent: selectedAccent,
            source: selectedSource,
            q: debouncedQuery,
        });
    }, [scope, currentPage, selectedCefr, selectedAccent, selectedSource, debouncedQuery]);

    // Debounce text search and reset to page 1 when search text changes.
    useEffect(() => {
        const trimmed = searchInput.trim();
        if (trimmed === debouncedQuery) return;
        const timer = window.setTimeout(() => {
            setDebouncedQuery(trimmed);
            setCurrentPage(1);
            syncUrlPage(1);
        }, 220);
        return () => window.clearTimeout(timer);
    }, [searchInput, debouncedQuery, syncUrlPage]);

    // Refresh catalog and jump to newest imported lesson on page 1 when ImportMaterialModal completes.
    useEffect(() => {
        if (refreshRevision === undefined || refreshRevision === prevRefreshRevisionRef.current) {
            return;
        }
        prevRefreshRevisionRef.current = refreshRevision;
        setCurrentPage(1);
        syncUrlPage(1);
        void revalidateShadowingCatalog();
    }, [refreshRevision, syncUrlPage]);

    // Support Echo JARVIS speaking_control intent filters when Shadowing is active.
    useEffect(() => {
        const onSpeakingIntent = (event: Event) => {
            const detail = (event as CustomEvent<{
                mode?: string;
                cefr?: string;
                query?: string;
            }>).detail;
            if (!detail) return;
            if (detail.mode && detail.mode !== "shadowing") return;
            let filterChanged = false;
            if (typeof detail.cefr === "string") {
                const upper = detail.cefr.trim().toUpperCase();
                const nextCefr = (CEFR_OPTIONS as readonly string[]).includes(upper) ? upper : "ALL";
                setSelectedCefr(nextCefr);
                filterChanged = true;
            }
            if (typeof detail.query === "string") {
                const nextQ = detail.query.trim();
                setSearchInput(nextQ);
                setDebouncedQuery(nextQ);
                filterChanged = true;
            }
            if (filterChanged) {
                setCurrentPage(1);
                syncUrlPage(1);
            }
        };
        window.addEventListener("ec:speaking:intent", onSpeakingIntent);
        return () => window.removeEventListener("ec:speaking:intent", onSpeakingIntent);
    }, [syncUrlPage]);

    const {
        data: catalogPage,
        error: catalogError,
        isLoading: catalogLoading,
        isValidating: catalogValidating,
        mutate: mutateCatalog,
    } = useShadowingCatalog({
        page: Math.max(0, currentPage - 1),
        size: SHADOWING_DEFAULT_PAGE_SIZE,
        cefr: selectedCefr,
        accent: selectedAccent,
        source: selectedSource,
        q: debouncedQuery,
    });

    const items = catalogPage?.content ?? [];
    const totalElements = catalogPage?.totalElements ?? 0;
    const totalPages = catalogPage?.totalPages ?? 0;
    const isClampingOutOfRange = Boolean(
        catalogPage &&
            catalogPage.totalPages > 0 &&
            (currentPage > catalogPage.totalPages ||
                (items.length === 0 && catalogPage.page >= catalogPage.totalPages))
    );
    const isInitialLoading = !scope || (catalogPage === undefined && catalogLoading) || isClampingOutOfRange;
    const isTransitioning = catalogPage !== undefined && catalogValidating && !isClampingOutOfRange;

    // Clamp currentPage if filters/deletions or out-of-range ?shPage=N exceed available totalPages.
    useEffect(() => {
        if (!catalogPage) return;

        if (catalogPage.totalPages > 0 && currentPage > catalogPage.totalPages && catalogPage.page === currentPage - 1) {
            const clamped = catalogPage.totalPages;
            setCurrentPage(clamped);
            syncUrlPage(clamped);
            writeShadowingViewState(scope, {
                page: clamped,
                cefr: selectedCefr,
                accent: selectedAccent,
                source: selectedSource,
                q: debouncedQuery,
            });
        } else if (catalogPage.totalPages === 0 && currentPage > 1 && catalogPage.page === currentPage - 1) {
            setCurrentPage(1);
            syncUrlPage(1);
            writeShadowingViewState(scope, {
                page: 1,
                cefr: selectedCefr,
                accent: selectedAccent,
                source: selectedSource,
                q: debouncedQuery,
            });
        }
    }, [
        catalogPage,
        currentPage,
        syncUrlPage,
        scope,
        selectedCefr,
        selectedAccent,
        selectedSource,
        debouncedQuery,
    ]);

    // Resolve active lesson metadata for ContinuePracticeCard without loading full unpaginated catalog.
    const activeInCurrentPage = useMemo(
        () => (activeMaterialId != null ? items.find((m) => m.id === activeMaterialId) ?? null : null),
        [activeMaterialId, items]
    );
    const { data: fetchedActiveCard } = useShadowingMaterialCard(
        activeMaterialId,
        activeMaterialId != null && activeInCurrentPage === null
    );
    const resolvedActiveMaterial = activeMaterialId == null ? null : (activeInCurrentPage ?? fetchedActiveCard ?? null);

    useEffect(() => {
        if (!onResolvedActiveMaterial) return;
        onResolvedActiveMaterial(resolvedActiveMaterial);
    }, [onResolvedActiveMaterial, resolvedActiveMaterial]);

    const handleSourceChange = (nextSource: ShadowingSourceFilter) => {
        if (nextSource === selectedSource) return;
        setSelectedSource(nextSource);
        setCurrentPage(1);
        syncUrlPage(1);
    };

    const handleCefrChange = (nextCefr: string) => {
        if (nextCefr === selectedCefr) return;
        setSelectedCefr(nextCefr);
        setCurrentPage(1);
        syncUrlPage(1);
    };

    const handleClearFilters = () => {
        setSelectedSource("ALL");
        setSelectedCefr("ALL");
        setSelectedAccent("ALL");
        setSearchInput("");
        setDebouncedQuery("");
        setCurrentPage(1);
        syncUrlPage(1);
    };

    const handlePageChange = (nextPage: number) => {
        const clamped = totalPages > 0 ? Math.max(1, Math.min(totalPages, nextPage)) : 1;
        if (clamped === currentPage) return;
        setCurrentPage(clamped);
        syncUrlPage(clamped);
        writeShadowingViewState(scope, {
            page: clamped,
            cefr: selectedCefr,
            accent: selectedAccent,
            source: selectedSource,
            q: debouncedQuery,
        });
        scrollHeadingIntoView();
    };

    const handleOpenLesson = (materialId: number) => {
        writeShadowingViewState(scope, {
            page: currentPage,
            cefr: selectedCefr,
            accent: selectedAccent,
            source: selectedSource,
            q: debouncedQuery,
        });
        syncUrlPage(currentPage);
        router.push(`/speaking/shadowing/${materialId}${handoffQueryString}`);
    };

    const hasActiveFilters =
        selectedSource !== "ALL" ||
        selectedCefr !== "ALL" ||
        selectedAccent !== "ALL" ||
        debouncedQuery.length > 0;

    const minutesLabel = (seconds: number) =>
        seconds < 60
            ? `${Math.max(0, Math.round(seconds))} ${vi ? "giây" : "s"}`
            : `${Math.round(seconds / 60)} ${vi ? "phút" : "min"}`;

    const sourceOptions: Array<{ key: ShadowingSourceFilter; label: string }> = [
        { key: "ALL", label: vi ? "Tất cả" : "All" },
        { key: "SYSTEM", label: vi ? "Thư viện chuẩn" : "System" },
        { key: "USER", label: vi ? "Của tôi" : "Personal" },
    ];

    return (
        <div className={styles.section} data-testid="shadowing-library-section">
            <div className={studioStyles.workHead}>
                <div>
                    <span className={studioStyles.workEyebrow}>
                        <Headphones /> Shadowing
                    </span>
                    <h2
                        ref={headingRef}
                        id="shadowing-library-heading"
                        tabIndex={-1}
                        className={`${studioStyles.workTitle} ${styles.headingAnchor}`}
                    >
                        {vi ? "Thư viện bài luyện Shadowing" : "Shadowing Practice Library"}
                    </h2>
                    <p className={studioStyles.workText}>
                        {vi
                            ? "Chọn một bài nghe để bắt đầu luyện nói Shadowing từng câu với đồng bộ audio chính xác."
                            : "Select an audio passage to begin sentence-by-sentence shadowing with aligned audio."}
                    </p>
                </div>
                <button
                    type="button"
                    data-guide="sh-import"
                    onClick={onOpenImportModal}
                    className={`${studioStyles.primary} self-start md:self-auto`}
                >
                    <Plus />
                    <span>{vi ? "Thêm bài từ YouTube" : "Add from YouTube"}</span>
                </button>
            </div>

            {/* Filter and Search Toolbar */}
            <div className={studioStyles.toolbar}>
                <div className={styles.filterStack}>
                    <div
                        className={studioStyles.filterRow}
                        role="group"
                        aria-label={vi ? "Lọc theo nguồn bài nghe" : "Filter by material source"}
                    >
                        <span className={studioStyles.filterLabel}>
                            <BookOpen /> {vi ? "Nguồn:" : "Source:"}
                        </span>
                        {sourceOptions.map((opt) => (
                            <button
                                key={opt.key}
                                type="button"
                                onClick={() => handleSourceChange(opt.key)}
                                className={studioStyles.pill}
                                aria-pressed={selectedSource === opt.key}
                                data-testid={`shadowing-source-${opt.key.toLowerCase()}`}
                            >
                                {opt.label}
                            </button>
                        ))}
                    </div>

                    <div
                        className={studioStyles.filterRow}
                        role="group"
                        aria-label={vi ? "Lọc theo cấp độ CEFR" : "Filter by CEFR level"}
                    >
                        <span className={studioStyles.filterLabel}>
                            <Filter /> {t.filterLevel || (vi ? "Cấp độ:" : "Level:")}
                        </span>
                        {CEFR_OPTIONS.map((lvl) => (
                            <button
                                key={lvl}
                                type="button"
                                onClick={() => handleCefrChange(lvl)}
                                className={studioStyles.pill}
                                aria-pressed={selectedCefr === lvl}
                                data-testid={`shadowing-cefr-${lvl.toLowerCase()}`}
                            >
                                {lvl === "ALL" ? (vi ? "Tất cả" : "All") : lvl}
                            </button>
                        ))}
                    </div>
                </div>

                <label className={styles.searchWrap}>
                    <Search className={styles.searchIcon} aria-hidden="true" />
                    <input
                        type="search"
                        value={searchInput}
                        onChange={(e) => setSearchInput(e.target.value)}
                        placeholder={vi ? "Tìm theo tiêu đề, chủ đề hoặc kênh..." : "Search by title, topic or channel..."}
                        aria-label={vi ? "Tìm bài luyện Shadowing" : "Search shadowing lessons"}
                        className={styles.searchInput}
                        data-testid="shadowing-search-input"
                    />
                    {searchInput.length > 0 && (
                        <button
                            type="button"
                            onClick={() => {
                                setSearchInput("");
                                setDebouncedQuery("");
                                setCurrentPage(1);
                                syncUrlPage(1);
                            }}
                            className={styles.searchClear}
                            aria-label={vi ? "Xóa từ khóa tìm kiếm" : "Clear search query"}
                        >
                            <X />
                        </button>
                    )}
                </label>
            </div>

            {!isInitialLoading && !catalogError && (hasActiveFilters || totalElements > 0) && (
                <div className={styles.statusRow}>
                    <p className={styles.statusText} role="status">
                        {vi ? (
                            <>
                                Tổng cộng <strong>{totalElements}</strong> bài luyện Shadowing
                                {totalPages > 1 ? ` · Trang ${Math.min(currentPage, totalPages)} / ${totalPages}` : ""}
                            </>
                        ) : (
                            <>
                                <strong>{totalElements}</strong> shadowing lessons
                                {totalPages > 1 ? ` · Page ${Math.min(currentPage, totalPages)} of ${totalPages}` : ""}
                            </>
                        )}
                    </p>
                    {hasActiveFilters && (
                        <button
                            type="button"
                            onClick={handleClearFilters}
                            className={styles.resetLink}
                            data-testid="shadowing-reset-filters"
                        >
                            <RotateCcw size={13} />
                            <span>{t.resetFilters || (vi ? "Đặt lại bộ lọc" : "Reset Filters")}</span>
                        </button>
                    )}
                </div>
            )}

            {isInitialLoading ? (
                <div className={studioStyles.loading} role="status" data-testid="shadowing-loading">
                    <RefreshCw />
                    <span>{vi ? "Đang tải danh sách bài Shadowing..." : "Loading shadowing materials..."}</span>
                </div>
            ) : catalogError && !catalogPage ? (
                <div className={studioStyles.empty} role="alert" data-testid="shadowing-error">
                    <AlertCircle />
                    <h3>{vi ? "Không thể tải thư viện Shadowing" : "Unable to load Shadowing library"}</h3>
                    <p>
                        {vi
                            ? "Đã xảy ra sự cố kết nối khi tải danh mục bài luyện. Vui lòng thử lại."
                            : "A connection issue occurred while loading lessons. Please try again."}
                    </p>
                    <button
                        type="button"
                        onClick={() => void mutateCatalog()}
                        className={`${studioStyles.soft} mt-2`}
                    >
                        <RefreshCw />
                        <span>{vi ? "Thử lại" : "Retry"}</span>
                    </button>
                </div>
            ) : items.length === 0 ? (
                <div className={studioStyles.empty} data-testid="shadowing-empty">
                    <BookOpen />
                    <h3>
                        {hasActiveFilters
                            ? vi
                                ? "Không tìm thấy bài luyện Shadowing phù hợp"
                                : "No matching shadowing lessons found"
                            : vi
                              ? "Chưa có bài nghe nào trong thư viện"
                              : "No audio materials in your library yet"}
                    </h3>
                    <p>
                        {hasActiveFilters
                            ? debouncedQuery
                                ? vi
                                    ? `Không có bài nghe nào khớp với “${debouncedQuery}” trong bộ lọc hiện tại.`
                                    : `No audio lesson matches “${debouncedQuery}” with the current filters.`
                                : vi
                                  ? "Thử điều chỉnh bộ lọc nguồn hoặc cấp độ để xem thêm các bài luyện khác."
                                  : "Try adjusting source or level filters to discover more lessons."
                            : vi
                              ? "Bạn có thể thêm bài nghe mới trực tiếp từ YouTube để bắt đầu Shadowing."
                              : "You can import new materials directly from YouTube to start shadowing."}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
                        {hasActiveFilters ? (
                            <button
                                type="button"
                                onClick={handleClearFilters}
                                className={studioStyles.soft}
                            >
                                <RotateCcw />
                                <span>{t.resetFilters || (vi ? "Đặt lại bộ lọc" : "Reset Filters")}</span>
                            </button>
                        ) : (
                            <>
                                <button type="button" onClick={onOpenImportModal} className={studioStyles.primary}>
                                    <Plus />
                                    <span>{vi ? "Thêm bài từ YouTube" : "Add from YouTube"}</span>
                                </button>
                                <button
                                    type="button"
                                    onClick={() => router.push("/listening")}
                                    className={studioStyles.soft}
                                >
                                    {vi ? "Khám phá thư viện Listening" : "Explore Listening Library"}
                                </button>
                            </>
                        )}
                    </div>
                </div>
            ) : (
                <>
                    <div
                        className={`${styles.grid} ${isTransitioning ? styles.gridUpdating : ""}`}
                        data-testid="shadowing-cards-grid"
                    >
                        {items.slice(0, SHADOWING_DEFAULT_PAGE_SIZE).map((mat) => {
                            const poster = mat.thumbnail || youtubePoster(mat.youtubeVideoId);
                            const fallbackPoster = mat.thumbnail ? youtubePoster(mat.youtubeVideoId) : null;
                            return (
                                <article
                                    key={mat.id}
                                    className={studioStyles.card}
                                    data-tone="voice"
                                    data-testid="shadowing-material-card"
                                >
                                    <div className={studioStyles.thumb} aria-hidden="true">
                                        <div className={studioStyles.thumbFallback}>
                                            <svg className={studioStyles.thumbWave} viewBox="0 0 120 40">
                                                <path d="M4 20 C 14 4, 24 4, 34 20 S 54 36, 64 20 S 84 4, 94 20 S 110 32, 116 20" />
                                            </svg>
                                            <b>{mat.channel || mat.topic || "Shadowing"}</b>
                                        </div>
                                        <StudioThumb src={poster} fallbackSrc={fallbackPoster} />
                                        {mat.durationSeconds > 0 && (
                                            <span className={studioStyles.thumbBadge}>
                                                <Clock />
                                                {minutesLabel(mat.durationSeconds)}
                                            </span>
                                        )}
                                    </div>
                                    <div className={studioStyles.cardBody}>
                                        {(mat.cefrLevel || mat.accent || !mat.isSystem) && (
                                            <div className={studioStyles.chips}>
                                                {mat.cefrLevel && <span className={studioStyles.chip}>{mat.cefrLevel}</span>}
                                                {mat.accent && (
                                                    <span className={`${studioStyles.chip} ${studioStyles.chipNeutral}`}>
                                                        {mat.accent}
                                                    </span>
                                                )}
                                                {!mat.isSystem && (
                                                    <span className={`${studioStyles.chip} ${studioStyles.chipCustom}`}>
                                                        {vi ? "Của tôi" : "Personal"}
                                                    </span>
                                                )}
                                            </div>
                                        )}
                                        <h3 className={studioStyles.cardTitle}>{mat.title}</h3>
                                        {mat.topic && <p className={studioStyles.cardText}>{mat.topic}</p>}
                                        <div className={studioStyles.cardAction}>
                                            <button
                                                type="button"
                                                data-guide="sh-item"
                                                onClick={() => handleOpenLesson(mat.id)}
                                                className={studioStyles.primary}
                                            >
                                                <Play className="fill-current" />
                                                <span>{vi ? "Bắt đầu Shadowing" : "Start Shadowing"}</span>
                                                <ChevronRight className="ml-auto opacity-70" />
                                            </button>
                                        </div>
                                    </div>
                                </article>
                            );
                        })}
                    </div>

                    <ShadowingPagination
                        currentPage={totalPages > 0 ? Math.min(currentPage, totalPages) : 1}
                        totalPages={totalPages}
                        totalElements={totalElements}
                        pageSize={catalogPage?.size ?? SHADOWING_DEFAULT_PAGE_SIZE}
                        currentItemCount={items.length}
                        disabled={isInitialLoading}
                        vi={vi}
                        onPageChange={handlePageChange}
                    />
                </>
            )}
        </div>
    );
}

export default ShadowingLibrarySection;
