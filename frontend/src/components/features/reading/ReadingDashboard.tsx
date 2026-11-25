"use client";

import { useEffect, useLayoutEffect, useState, useMemo, useRef, type KeyboardEvent, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { BookOpen, BookMarked, Plus, ArrowRight, Zap, FileText, Trash2, Loader2, Search, X, ClipboardPaste, Languages, RotateCw, Library, Layers, CheckCircle2, Newspaper, Feather, Gauge, Rows3, Keyboard } from "lucide-react";
import { useSession } from "next-auth/react";
import { useModuleEntryResource, useModuleEntryScope } from "@/hooks/useModuleEntryResource";
import { useReadingCatalog } from '@/hooks/useReadingCatalog';
import { authEpoch, authEnding } from '@/lib/auth-lifecycle';
import { READING_PROGRESS_PATH, revalidateReadingUserCatalog } from "@/services/moduleEntryResources";
import { apiClient } from "@/services/api-client";
import ReadingCard, { ReadingMaterial } from "./ReadingCard";
import { ImportMaterialModal } from "./ImportMaterialModal";
import { InteractiveReader } from "./InteractiveReader";
import { SpeedReader } from "./SpeedReader";
import { ReadingErrorBoundary } from "./ReadingErrorBoundary";
import { useBilingualReadingCatalog } from '@/hooks/useBilingualReading';
import type { BilingualReadingCard } from '@/types/bilingualReading';
import { BilingualReadingPanel } from './BilingualReadingPanel';
import { BilingualReader } from './BilingualReader';
import styles from "./glass/readingGlass.module.css";
import { ReadingHero, type HeroStat } from "./glass/ReadingHero";
import { ReadingCover, topicFamily } from "./glass/ReadingCover";

import { useLanguage } from "@/context/LanguageContext";
import { useCurrentRole } from '@/hooks/useCurrentRole';
import { useContentTitle } from '@/lib/brand/tabTitle';
import { PageJump } from '@/components/common/PageJump';
import { dispatchEchoModuleReady } from '@/lib/echo/contextBridge';

/** Counts of the learner's own shelf, reported by My Books (undefined = still opening, null = not available here). */
export type BookShelfSummary = { all: number; reading: number; finished: number } | null | undefined;

// My Books (personal local ebook reader) loads only when its tab is opened: no EPUB / PDF engine in the Reading entry.
const MyBooksTab = dynamic(() => import("./books/MyBooksTab"), {
    ssr: false,
    loading: () => (
        <div role="status" className="grid grid-cols-2 gap-x-5 gap-y-7 pt-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6" aria-label="Loading My Books">
            {Array.from({ length: 6 }).map((_, i) => <div key={i} className="aspect-[2/3] rounded-lg bg-stone-200/70 motion-safe:animate-pulse dark:bg-white/[0.06]" />)}
        </div>
    ),
});

type ReadingTab = "library" | "mybooks" | "bilingual" | "speed";

// Layout effects only exist in the browser (the server render keeps the indicator at its resting place).
const useClientLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

function CardSkeleton() {
    return (
        <div role="status" aria-label="Loading library" className={styles.skeleton}>
            <span className="sr-only">Loading library</span>
            <div aria-hidden="true" className="flex h-full flex-col">
                <div className={`${styles.skBlock} aspect-[16/7] rounded-none`} />
                <div className="flex flex-col gap-2.5 p-4">
                    <div className={`${styles.skBlock} h-5 w-5/6`} />
                    <div className={`${styles.skBlock} h-5 w-3/5`} />
                    <div className={`${styles.skBlock} mt-1 h-3 w-full`} />
                    <div className={`${styles.skBlock} h-3 w-4/5`} />
                    <div className="mt-3 flex justify-between">
                        <div className={`${styles.skBlock} h-4 w-28`} />
                        <div className={`${styles.skBlock} h-7 w-20`} />
                    </div>
                </div>
            </div>
        </div>
    );
}

/** Shown while one reading's body loads: the reader's own shape, so opening never flashes an empty page. */
function ReaderSkeleton({ vi }: { vi: boolean }) {
    return (
        <div className={styles.page} data-world="library">
            <div role="status" aria-live="polite" className="mx-auto w-full max-w-3xl px-4 py-6">
                <span className="sr-only">{vi ? "Đang mở bài đọc…" : "Opening reading…"}</span>
                <div aria-hidden="true" className="motion-safe:animate-pulse">
                    <div className={`${styles.panel} mb-6 h-14`} />
                    <div className={`${styles.panel} overflow-hidden`}>
                        <div className={`${styles.skBlock} h-36 rounded-none`} />
                        <div className="px-6 py-8 sm:px-12">
                            <div className={`${styles.skBlock} h-4 w-40`} />
                            <div className={`${styles.skBlock} mt-5 h-9 w-11/12`} />
                            <div className={`${styles.skBlock} mt-3 h-9 w-2/3`} />
                            <div className="mt-10 space-y-3">
                                {Array.from({ length: 7 }).map((_, i) => (
                                    <div key={i} className={`${styles.skBlock} h-3.5 ${i % 3 === 2 ? "w-3/4" : "w-full"}`} />
                                ))}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

function EmptyState({ onImportClick }: { onImportClick: () => void }) {
    const { t } = useLanguage();
    return (
        <div className={`${styles.panel} ${styles.empty}`}>
            <div className={styles.emptyIcon}>
                <BookOpen className="h-7 w-7" />
            </div>
            <h3>{t.emptyReadingTitle}</h3>
            <p>{t.emptyReadingDesc}</p>
            <button type="button" onClick={onImportClick} className={styles.primaryBtn}>
                <Plus className="h-4 w-4" />
                <span>{t.importFirstMaterial}</span>
            </button>
        </div>
    );
}

// Map difficulty levels to sortable rank
const CEFR_ORDER: Record<string, number> = {
    A1: 1,
    BEGINNER: 1,
    A2: 2,
    ELEMENTARY: 2,
    B1: 3,
    INTERMEDIATE: 3,
    B2: 4,
    UPPER_INTERMEDIATE: 4,
    C1: 5,
    ADVANCED: 5,
    C2: 6,
};

const CEFR_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

/** The workspace's scrolling viewport (ApplicationFrame `data-app-scroll`). */
function appScroller(): HTMLElement | null {
    return typeof document === "undefined" ? null : document.querySelector<HTMLElement>("[data-app-scroll]");
}

function prefersReducedMotion(): boolean {
    return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function ReadingDashboard() {
    const scope = useModuleEntryScope();
    return <ReadingContent key={scope ?? "pending"} />;
}

function ReadingContent() {
    const { locale, t } = useLanguage();
    const vi = locale === "vi";
    const { data: session } = useSession();
    const currentUserId = session?.user ? Number((session.user as any).id) : null;
    const { isAdmin } = useCurrentRole();

    const [library, setLibrary] = useState<"SYSTEM" | "USER">("SYSTEM");
    const [page, setPage] = useState(0);
    const [search, setSearch] = useState("");
    const [query, setQuery] = useState("");
    const [topic, setTopic] = useState("");
    const [level, setLevel] = useState("");
    const [sortBy, setSortBy] = useState<"recent" | "length" | "cefr">("recent");
    useEffect(() => { const timer = setTimeout(() => { setQuery(search); setPage(0); }, 300); return () => clearTimeout(timer); }, [search]);
    useEffect(() => { setPage(0); }, [sortBy]);
    const catalog = useReadingCatalog(library, page, query, topic, level, sortBy);
    const systemSummary = useReadingCatalog("SYSTEM", 0, "", "", "", "recent");
    const userSummary = useReadingCatalog("USER", 0, "", "", "", "recent");
    const { data: progress } = useModuleEntryResource<{materialId: number; scrollPercentage: number; material?: ReadingMaterial}[]>(READING_PROGRESS_PATH);
    const materials = useMemo(() => catalog.data?.content ?? [], [catalog.data]);
    const materialsError = catalog.error;
    const mutateMaterials = catalog.mutate;
    const isLoading = catalog.data === undefined && !catalog.error;
    // Last known page count: the pager keeps its place while the next page loads (no layout jump at the bottom).
    const knownPages = useRef<number | null>(null);
    if (catalog.data) knownPages.current = catalog.data.totalPages;
    const totalPages = catalog.data?.totalPages ?? knownPages.current;
    const [opening, setOpening] = useState(false);
    const detailSequence = useRef(0);
    useEffect(() => () => { detailSequence.current++; }, []);
    const [mutationError, setError] = useState<string | null>(null);
    const error = mutationError ?? (materialsError ? (vi ? "Không thể tải danh sách tài liệu đọc." : "Could not load the reading library.") : null);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [modalTab, setModalTab] = useState<"upload" | "text">("upload");
    const [selectedMaterial, setSelectedMaterial] = useState<ReadingMaterial | null>(null);
    const [activeTab, setActiveTab] = useState<ReadingTab>("library");
    const [selectedBilingual, setSelectedBilingual] = useState<BilingualReadingCard | null>(null);
    const bilingualCatalog = useBilingualReadingCatalog(activeTab === 'bilingual' || Boolean(selectedBilingual));
    useContentTitle(activeTab === 'mybooks' ? (locale === 'en' ? 'My books' : 'Sách của tôi') : activeTab === 'bilingual' ? (locale === 'en' ? 'Bilingual reading' : 'Đọc song ngữ') : activeTab === 'speed' ? (locale === 'en' ? 'Speed reading' : 'Đọc nhanh') : null, 'section');
    useContentTitle(selectedMaterial?.title ?? selectedBilingual?.titleEn);
    const [continueMaterial, setContinueMaterial] = useState<ReadingMaterial | null>(null);
    const [savedVocabCount, setSavedVocabCount] = useState<number>(0);
    const [readProgress, setReadProgress] = useState<number>(0);
    const [bookSummary, setBookSummary] = useState<BookShelfSummary>(undefined);
    const [speedActive, setSpeedActive] = useState(false);

    const [materialToDelete, setMaterialToDelete] = useState<ReadingMaterial | null>(null);
    const [isDeleting, setIsDeleting] = useState(false);

    // Where the learner was in the library when they opened a reading (restored when they come back).
    const libraryScroll = useRef<number | null>(null);
    const resultsRef = useRef<HTMLElement>(null);
    const tablistRef = useRef<HTMLDivElement>(null);
    const [indicator, setIndicator] = useState<{ x: number; w: number } | null>(null);

    const router = useRouter();
    const searchParams = useSearchParams();
    const pathname = usePathname();
    const hydratedInitialTabRef = useRef(false);

    useEffect(() => {
        const rawSection = searchParams.get("section") ?? searchParams.get("tab");
        if (rawSection === "speed" || rawSection === "library" || rawSection === "mybooks" || rawSection === "bilingual") {
            hydratedInitialTabRef.current = true;
            setActiveTab(rawSection);
            try { localStorage.setItem("readingActiveTab", rawSection); } catch { /* ignore */ }
            if (rawSection !== "bilingual") setSelectedBilingual(null);
            if (rawSection !== "speed") setSpeedActive(false);
            if (!searchParams.get("materialId")) setSelectedMaterial(null);
            return;
        }
        if (!hydratedInitialTabRef.current) {
            hydratedInitialTabRef.current = true;
            if (!searchParams.get("materialId")) {
                const savedTab = localStorage.getItem("readingActiveTab");
                if (savedTab === "speed" || savedTab === "library" || savedTab === "mybooks" || savedTab === "bilingual") {
                    setActiveTab(savedTab);
                    return;
                }
            }
        }
        // Navigating back to bare `/reading` after initial mount returns cleanly to `library` without stale localStorage override!
        if (!searchParams.get("materialId")) {
            setActiveTab("library");
            try { localStorage.setItem("readingActiveTab", "library"); } catch { /* ignore */ }
            setSelectedBilingual(null);
            setSpeedActive(false);
        }
    }, [searchParams]);

    useEffect(() => {
        const onIntent = (event: Event) => {
            const d = (event as CustomEvent<{ tab?: string; filterLevel?: string; filterTopic?: string; searchQuery?: string }>).detail;
            if (!d) return;
            if (d.tab === "library" || d.tab === "mybooks" || d.tab === "bilingual" || d.tab === "speed") {
                setActiveTab(d.tab);
                try { localStorage.setItem("readingActiveTab", d.tab); } catch { /* ignore */ }
                setSelectedMaterial(null);
                if (d.tab !== "bilingual") setSelectedBilingual(null);
                if (d.tab !== "speed") setSpeedActive(false);
            }
            if (typeof d.filterLevel === "string") { setLevel(d.filterLevel); setPage(0); }
            if (typeof d.filterTopic === "string") { setTopic(d.filterTopic); setPage(0); }
            if (typeof d.searchQuery === "string") { setSearch(d.searchQuery); setQuery(d.searchQuery); setPage(0); }
        };
        window.addEventListener("ec:reading:intent", onIntent);
        dispatchEchoModuleReady("reading", { tab: activeTab });
        return () => window.removeEventListener("ec:reading:intent", onIntent);
    }, []);

    const handleTabSwitch = (tab: ReadingTab) => {
        setActiveTab(tab);
        localStorage.setItem("readingActiveTab", tab);
        if (tab !== 'bilingual') setSelectedBilingual(null);
        if (tab !== 'speed') setSpeedActive(false);
    };

    const fetchMaterials = () => mutateMaterials();

    const loadDetail = async (id: number) => {
        const sequence = ++detailSequence.current, epoch = authEpoch();
        setOpening(true); setError(null);
        try {
            const { data } = await apiClient.get<ReadingMaterial>(`/reading/materials/${id}`, { timeout: 15000 });
            if (sequence === detailSequence.current && epoch === authEpoch() && !authEnding()) setSelectedMaterial(data);
        } catch { if (sequence === detailSequence.current && epoch === authEpoch()) setError(vi ? 'Không thể mở bài đọc.' : 'Unable to open reading.'); }
        finally { if (sequence === detailSequence.current && epoch === authEpoch()) setOpening(false); }
    };
    useEffect(() => {
        const id = Number(searchParams.get("materialId"));
        if (Number.isSafeInteger(id) && id > 0) void loadDetail(id);
        else { detailSequence.current++; setOpening(false); setSelectedMaterial(null); }
    }, [searchParams]);

    // The reader fills the workspace viewport: start it at the top once it (or its skeleton) is on screen — not at click
    // time, which would jump the library before the reading appears.
    const readerShown = opening || Boolean(selectedMaterial);
    useEffect(() => {
        if (readerShown) appScroller()?.scrollTo({ top: 0 });
    }, [readerShown]);

    // Back in the library: return to the card the learner left from (one frame after the grid is painted).
    useEffect(() => {
        if (selectedMaterial || opening || libraryScroll.current == null) return;
        const top = libraryScroll.current;
        libraryScroll.current = null;
        const frame = requestAnimationFrame(() => appScroller()?.scrollTo({ top }));
        return () => cancelAnimationFrame(frame);
    }, [selectedMaterial, opening]);

    // The active-tab light follows the chosen tab (measured; nothing moves when the measurement is unavailable).
    useClientLayoutEffect(() => {
        const list = tablistRef.current;
        const on = list?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
        if (!list || !on) return;
        const measure = () => setIndicator({ x: on.offsetLeft, w: on.offsetWidth });
        measure();
        const ro = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
        ro?.observe(list);
        return () => ro?.disconnect();
    }, [activeTab, selectedMaterial, opening, selectedBilingual, speedActive, systemSummary.data, bilingualCatalog.data]);

    // Determine Continue Reading hero material
    useEffect(() => {
        if (materials.length === 0 && !progress?.length) {
            setContinueMaterial(null);
            return;
        }

        const lastReadId = localStorage.getItem("ec_last_read_material_id");
        let target = progress?.[0]?.material ?? materials.find(m => progress?.some(p => p.materialId === m.id));
        if (lastReadId) {
            const found = materials.find((m) => m.id.toString() === lastReadId) ?? progress?.find(p => p.materialId.toString() === lastReadId)?.material;
            if (found) target = found;
        }
        setContinueMaterial(target ?? null);

        // Check if there are saved highlights for this material
        if (target) {
            const savedHtml = localStorage.getItem(`ec_highlights_${target.id}`);
            if (savedHtml) {
                const count = (savedHtml.match(/selection-highlight|bg-yellow-|bg-green-|bg-blue-|bg-pink-/g) || []).length;
                setSavedVocabCount(count);
            } else {
                setSavedVocabCount(0);
            }

            const savedProgress = localStorage.getItem(`ec_reading_progress_${target.id}`);
            if (savedProgress) {
                setReadProgress(Number(savedProgress) || 0);
            } else {
                setReadProgress(Math.max(0, Math.min(100, progress?.find(p => p.materialId === target.id)?.scrollPercentage ?? 0)));
            }
        }
    }, [materials, progress]);

    // Opening a reading is a view of this already-mounted page: native history (integrated with useSearchParams, which
    // loads the body above) avoids a server-component round trip before the body request can even start.
    const handleOpenMaterial = (m: ReadingMaterial) => {
        localStorage.setItem("ec_last_read_material_id", m.id.toString());
        const scroller = appScroller();
        libraryScroll.current = scroller ? scroller.scrollTop : null;
        setOpening(true); // the reader's skeleton answers the click in the same frame
        const params = new URLSearchParams(searchParams.toString());
        params.set("materialId", m.id.toString());
        window.history.pushState(null, "", `${pathname}?${params.toString()}`);
    };

    const closeReader = () => {
        setSelectedMaterial(null);
        const params = new URLSearchParams(searchParams.toString());
        params.delete("materialId");
        window.history.pushState(null, "", `${pathname}?${params.toString()}`);
    };

    const handleSpeakingHandoff = (m: ReadingMaterial) => {
        router.push(`/speaking?sourceType=READING&sourceId=${m.id}`);
    };

    const handleDeleteMaterial = (m: ReadingMaterial) => {
        setMaterialToDelete(m);
    };

    const handleConfirmDelete = async () => {
        if (!materialToDelete) return;
        setIsDeleting(true);
        try {
            await apiClient.delete(`/reading/materials/${materialToDelete.id}`);
            await revalidateReadingUserCatalog();
            await mutateMaterials();

            if (continueMaterial?.id === materialToDelete.id) {
                localStorage.removeItem("ec_last_read_material_id");
                localStorage.removeItem(`ec_highlights_${materialToDelete.id}`);
                localStorage.removeItem(`ec_reading_progress_${materialToDelete.id}`);
                const remaining = materials.filter((m) => m.id !== materialToDelete.id);
                setContinueMaterial(remaining.length > 0 ? remaining[0] : null);
            }

            setMaterialToDelete(null);
        } catch (err: unknown) {
            console.error("Failed to delete reading material:", err);
            setError(vi ? "Không thể xóa bài đọc. Vui lòng thử lại sau." : "Failed to delete reading material. Please try again.");
        } finally {
            setIsDeleting(false);
        }
    };

    const sortedMaterials = useMemo(() => {
        const copy = [...materials];
        if (sortBy === "length") {
            copy.sort((a, b) => (a.wordCount || 0) - (b.wordCount || 0));
        } else if (sortBy === "cefr") {
            copy.sort((a, b) => {
                const rankA = CEFR_ORDER[a.difficultyLevel?.toUpperCase()] || 3;
                const rankB = CEFR_ORDER[b.difficultyLevel?.toUpperCase()] || 3;
                return rankA - rankB;
            });
        }
        return copy;
    }, [materials, sortBy]);

    const filtersActive = Boolean(search || topic || level);
    const clearFilters = () => { setSearch(""); setQuery(""); setTopic(""); setLevel(""); setPage(0); };
    const switchLibrary = (next: "SYSTEM" | "USER") => { setLibrary(next); setPage(0); setTopic(""); };
    const goToPage = (next: number) => {
        setPage(next);
        const section = resultsRef.current;
        if (section && section.getBoundingClientRect().top < 0) section.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    };
    // Topics come from the stable first SYSTEM page (they are the corpus' topics, not the current page's).
    const topics = systemSummary.data?.topics ?? catalog.data?.topics ?? [];
    const systemTotal = systemSummary.data?.totalElements;
    const userTotal = userSummary.data?.totalElements;
    const continueMinutes = continueMaterial && continueMaterial.wordCount > 0
        ? Math.max(1, Math.round((continueMaterial.wordCount * (100 - readProgress)) / 100 / 200))
        : null;
    const continueCefr = continueMaterial?.difficultyLevel?.trim() || null;

    if (opening) return <ReaderSkeleton vi={vi} />;
    if (selectedMaterial) {
        return (
            <ReadingErrorBoundary onReset={closeReader}>
                <InteractiveReader material={selectedMaterial} onBack={closeReader} />
            </ReadingErrorBoundary>
        );
    }
    if (selectedBilingual) {
        return (
            <div className={styles.page} data-world="bilingual">
                <div className={styles.inner}>
                    <BilingualReader key={selectedBilingual.id} card={selectedBilingual} onBack={() => setSelectedBilingual(null)} />
                </div>
            </div>
        );
    }

    const tabs: Array<{ id: ReadingTab; label: string; icon: ReactNode; badge: ReactNode }> = [
        { id: "library", label: t.khoTaiLieu, icon: <BookOpen aria-hidden="true" />, badge: systemTotal ?? '…' },
        { id: "mybooks", label: vi ? 'Sách của tôi' : 'My Books', icon: <Library aria-hidden="true" />, badge: null },
        { id: "bilingual", label: vi ? 'Song ngữ' : 'Bilingual', icon: <Languages aria-hidden="true" />, badge: bilingualCatalog.data?.totalElements ?? '…' },
        { id: "speed", label: t.speedReading, icon: <Zap aria-hidden="true" />, badge: t.speedReadingNew },
    ];
    const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
        const i = tabs.findIndex((tab) => tab.id === activeTab);
        const next = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : null;
        if (next === null) return;
        e.preventDefault();
        const target = tabs[(next + tabs.length) % tabs.length];
        handleTabSwitch(target.id);
        requestAnimationFrame(() => tablistRef.current?.querySelector<HTMLElement>(`[data-tab="${target.id}"]`)?.focus());
    };

    const shelfValue = (n: number | undefined) => (bookSummary === undefined ? "…" : bookSummary === null ? "—" : n);
    const hero: Record<ReadingTab, { eyebrow: string; eyebrowIcon: ReactNode; title: string; lead: string; note?: ReactNode; stats: HeroStat[]; actions?: ReactNode }> = {
        library: {
            eyebrow: vi ? "Không gian đọc" : "Reading space",
            eyebrowIcon: <BookOpen className="h-3.5 w-3.5" aria-hidden="true" />,
            title: t.activeReading,
            lead: t.activeReadingDesc,
            stats: [
                { value: systemTotal ?? "…", label: vi ? "bài đọc chọn lọc" : "curated readings", icon: <BookOpen /> },
                { value: systemSummary.data ? topics.length : "…", label: vi ? "chủ đề" : "topics", icon: <Layers /> },
                { value: userTotal ?? "…", label: vi ? "bài của tôi" : "of my own", icon: <FileText /> },
            ],
            actions: (
                <>
                    <button type="button" onClick={() => { setModalTab("upload"); setIsModalOpen(true); }} className={styles.heroPrimary}>
                        <Plus className="h-4 w-4" />
                        <span>{t.importDocument}</span>
                    </button>
                    <button type="button" onClick={() => { setModalTab("text"); setIsModalOpen(true); }} className={styles.heroSecondary}>
                        <ClipboardPaste className="h-4 w-4" aria-hidden="true" />
                        <span>{vi ? "Dán văn bản" : "Paste text"}</span>
                    </button>
                </>
            ),
        },
        mybooks: {
            eyebrow: vi ? "Tủ sách riêng" : "Personal library",
            eyebrowIcon: <Library className="h-3.5 w-3.5" aria-hidden="true" />,
            title: vi ? "Sách của tôi" : "My Books",
            lead: vi ? "Đọc sách EPUB, PDF và TXT của bạn như một cuốn sách thật. Sách nằm trên thiết bị này, không được tải lên máy chủ." : "Read your EPUB, PDF and TXT books like a real book. Books stay on this device and are never uploaded.",
            stats: [
                { value: shelfValue(bookSummary?.all), label: vi ? "cuốn sách" : "books", icon: <Library /> },
                { value: shelfValue(bookSummary?.reading), label: vi ? "đang đọc" : "reading", icon: <BookMarked /> },
                { value: shelfValue(bookSummary?.finished), label: vi ? "đã đọc xong" : "finished", icon: <CheckCircle2 /> },
            ],
        },
        bilingual: {
            eyebrow: vi ? "Song ngữ Anh – Việt" : "English – Vietnamese",
            eyebrowIcon: <Languages className="h-3.5 w-3.5" aria-hidden="true" />,
            title: vi ? "Đọc song ngữ" : "Bilingual reading",
            lead: vi ? "Đọc song song tiếng Anh và tiếng Việt theo từng đoạn, so sánh cách diễn đạt của hai ngôn ngữ và mở rộng vốn từ một cách tự nhiên." : "Read English and Vietnamese side by side, segment by segment: compare how each language says it and grow your vocabulary naturally.",
            stats: [
                { value: bilingualCatalog.data?.totalElements ?? "…", label: vi ? "bài song ngữ" : "bilingual readings", icon: <Languages /> },
                { value: bilingualCatalog.data?.articleCount ?? "…", label: vi ? "bài báo" : "articles", icon: <Newspaper /> },
                { value: bilingualCatalog.data?.storyCount ?? "…", label: vi ? "truyện ngắn" : "short stories", icon: <Feather /> },
            ],
        },
        speed: {
            eyebrow: vi ? "Phòng luyện tập trung" : "Focus lab",
            eyebrowIcon: <Zap className="h-3.5 w-3.5" aria-hidden="true" />,
            title: t.speedReading,
            lead: vi ? "Từng từ hoặc từng cụm từ hiện ra ở tốc độ bạn chọn: luyện giữ tập trung, bớt đọc thầm và tăng dần nhịp đọc trôi chảy." : "One word or one phrase at a time, at the speed you choose: practise steady focus, less subvocalising and a smoother reading pace.",
            stats: [
                { value: "150–650", label: vi ? "từ / phút (WPM)" : "words / min (WPM)", icon: <Gauge /> },
                { value: "1–3", label: vi ? "từ mỗi cụm" : "words per chunk", icon: <Rows3 /> },
                { value: "Space", label: vi ? "tạm dừng · tiếp tục" : "pause · resume", icon: <Keyboard /> },
            ],
        },
    };
    const h = hero[activeTab];

    return (
        <div className={styles.page} data-world={activeTab}>
            <div className={styles.inner}>
                {!(activeTab === "speed" && speedActive) && (
                    <ReadingHero world={activeTab} eyebrow={h.eyebrow} eyebrowIcon={h.eyebrowIcon} title={h.title} lead={h.lead} note={h.note} stats={h.stats} actions={h.actions} />
                )}

                {/* World tabs: library · my books · bilingual · speed reading */}
                <div className={styles.tabsWrap}>
                    <div ref={tablistRef} role="tablist" aria-label={vi ? "Chế độ đọc" : "Reading modes"} onKeyDown={onTabKey} className={`${styles.panel} ${styles.tabs}`} data-guide="reading-tabs">
                        <span aria-hidden="true" className={styles.tabIndicator} data-tone={activeTab} style={indicator ? { width: indicator.w, transform: `translateX(${indicator.x}px)` } : { opacity: 0 }} />
                        {tabs.map((tab) => {
                            const on = activeTab === tab.id;
                            return (
                                <button key={tab.id} type="button" role="tab" data-tab={tab.id} data-tone={tab.id} aria-selected={on} tabIndex={on ? 0 : -1} onClick={() => handleTabSwitch(tab.id)} className={styles.tab}>
                                    <span className={styles.tabIcon} aria-hidden="true">{tab.icon}</span>
                                    <span>{tab.label}</span>
                                    {tab.badge !== null && <span className={styles.tabBadge}>{tab.badge}</span>}
                                </button>
                            );
                        })}
                    </div>
                </div>

                {activeTab === "library" && <section className={`${styles.panel} ${styles.filters}`} aria-label="Reading library filters" data-guide="reading-filters">
                    <div className={styles.filterRow}>
                        <div className={`${styles.well} ${styles.segment}`}>
                            <button type="button" onClick={() => switchLibrary("SYSTEM")} aria-pressed={library === "SYSTEM"} className={styles.segBtn}>{vi ? 'Kho bài đọc' : 'SYSTEM Library'} <span className={styles.segCount}>{systemTotal ?? '…'}</span></button>
                            <button type="button" onClick={() => switchLibrary("USER")} aria-pressed={library === "USER"} className={styles.segBtn}><span className="sm:hidden">{vi ? 'Của tôi' : 'Mine'}</span><span className="hidden sm:inline">{vi ? 'Bài đọc của tôi' : 'My Readings'}</span> <span className={styles.segCount}>{userTotal ?? '…'}</span></button>
                        </div>
                        <p className="sr-only" aria-live="polite">
                            {library === "SYSTEM"
                                ? `${systemTotal ?? "…"} readings in SYSTEM Library`
                                : `${userTotal ?? "…"} readings in My Readings`}
                        </p>
                        <div className={styles.search}>
                            <Search className={styles.searchIcon} aria-hidden="true" />
                            <input
                                type="search"
                                aria-label="Search readings"
                                placeholder={vi ? 'Tìm theo tiêu đề bài đọc…' : 'Search by title…'}
                                value={search}
                                onChange={e => setSearch(e.target.value)}
                                className={styles.field}
                            />
                            {search && (
                                <button type="button" onClick={() => setSearch("")} aria-label={vi ? "Xóa tìm kiếm" : "Clear search"} className={styles.clearBtn}>
                                    <X className="h-4 w-4" />
                                </button>
                            )}
                        </div>
                        <div className={styles.selects}>
                            <select aria-label="CEFR" value={level} onChange={e => { setLevel(e.target.value); setPage(0); }} className={styles.select}>
                                <option value="">{vi ? 'Mọi trình độ' : 'All levels'}</option>
                                {CEFR_LEVELS.map(l => <option key={l} value={l}>CEFR {l}</option>)}
                            </select>
                            <select aria-label={t.sortLabel || (vi ? 'Sắp xếp' : 'Sort')} value={sortBy} onChange={(e) => setSortBy(e.target.value as any)} className={styles.select}>
                                <option value="recent">{t.sortRecent}</option>
                                <option value="length">{t.sortLength}</option>
                                <option value="cefr">{t.sortCefr}</option>
                            </select>
                        </div>
                    </div>
                    {library === "SYSTEM" && topics.length > 0 && (
                        <div role="group" aria-label={vi ? "Chủ đề" : "Topic"} className={styles.chips}>
                            {["", ...topics].map((value) => (
                                <button key={value || "all"} type="button" aria-pressed={topic === value} onClick={() => { setTopic(value); setPage(0); }} className={styles.chip}>
                                    {value || (vi ? 'Mọi chủ đề' : 'All topics')}
                                </button>
                            ))}
                        </div>
                    )}
                </section>}
                {/* Error banner */}
                {error && (
                    <div role="alert" className={styles.alert}>
                        <span>{error}</span>
                        <button type="button" onClick={() => { setError(null); void mutateMaterials(); }} className={styles.softBtn}>
                            <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
                            {vi ? "Thử lại" : "Retry"}
                        </button>
                    </div>
                )}

                {/* TAB CONTENT */}
                {activeTab === "library" && (
                    <div className="flex flex-col gap-7">
                        {/* Continue reading: the learner's own last reading and stored progress. */}
                        {continueMaterial && (
                            <section aria-label={vi ? "Đọc tiếp gần đây" : "Continue reading"} className={`${styles.panel} ${styles.resume}`} data-tone="library">
                                <div className={styles.resumeCover}>
                                    <ReadingCover family={continueMaterial.isSystem ? topicFamily(continueMaterial.topic) : "personal"} seed={continueMaterial.id} word={continueMaterial.isSystem ? continueMaterial.topic : null} />
                                </div>
                                <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className={styles.resumeTag}><BookMarked className="h-3 w-3" aria-hidden="true" />{t.continueReading}</span>
                                        <span className="text-xs font-semibold" style={{ color: "var(--ink-3)" }}>
                                            {t.readProgress} {readProgress}%{continueMinutes != null && t.minutesLeft ? ` · ${t.minutesLeft.replace('{count}', String(continueMinutes))}` : ""}
                                        </span>
                                    </div>
                                    <h2 className={styles.resumeTitle}>{continueMaterial.title}</h2>
                                    <div className={styles.resumeMeta}>
                                        {continueCefr && <span className={styles.levelTag}>CEFR {continueCefr}</span>}
                                        {continueMaterial.wordCount > 0 && <span className="tabular-nums">{continueMaterial.wordCount.toLocaleString(vi ? "vi-VN" : "en-US")} {vi ? "từ" : "words"}</span>}
                                        {savedVocabCount > 0 && (
                                            <span className="font-semibold text-amber-700 dark:text-amber-300">
                                                {savedVocabCount} {vi ? 'từ vựng mới đã lưu' : 'new vocabulary saved'}
                                            </span>
                                        )}
                                    </div>
                                    <div className="mt-3 flex items-center gap-3">
                                        <div className={styles.meter} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={readProgress} aria-label={t.readProgress}>
                                            <span style={{ width: `${readProgress}%` }} />
                                        </div>
                                        <span className="text-xs font-bold tabular-nums" style={{ color: "var(--ink-2)" }}>{readProgress}%</span>
                                    </div>
                                </div>
                                <button type="button" onClick={() => handleOpenMaterial(continueMaterial)} className={styles.primaryBtn}>
                                    <span>{t.continueReadingBtn}</span>
                                    <ArrowRight className="h-4 w-4" />
                                </button>
                            </section>
                        )}

                        {/* All materials */}
                        <section ref={resultsRef} aria-label={t.allMaterials} className="scroll-mt-4 flex flex-col gap-4">
                            <div className={styles.sectionHead}>
                                <div className="ec-wp-plate">
                                    <h2 className={styles.sectionTitle}>
                                        {library === "SYSTEM" ? (vi ? "Kho bài đọc" : "Reading library") : (vi ? "Bài đọc của tôi" : "My readings")}
                                    </h2>
                                    <p className={styles.sectionSub} aria-hidden="true">
                                        {catalog.data
                                            ? `${catalog.data.totalElements} ${vi ? "bài đọc" : "readings"}${catalog.data.totalPages > 1 ? ` · ${vi ? "Trang" : "Page"} ${page + 1}/${catalog.data.totalPages}` : ""}`
                                            : (vi ? "Đang tải…" : "Loading…")}
                                    </p>
                                </div>
                                {filtersActive && (
                                    <button type="button" onClick={clearFilters} className={styles.ghostBtn}>
                                        <X className="h-3.5 w-3.5" aria-hidden="true" />
                                        {vi ? "Xóa bộ lọc" : "Clear filters"}
                                    </button>
                                )}
                            </div>

                            <div className={styles.grid} data-guide="reading-grid">
                                {isLoading ? (
                                    Array.from({ length: 6 }).map((_, i) => <CardSkeleton key={i} />)
                                ) : sortedMaterials.length === 0 && !error ? (
                                    library === "SYSTEM" ? (
                                        <div className={`${styles.panel} ${styles.empty}`}>
                                            <span className={styles.emptyIcon}><Search className="h-5 w-5" aria-hidden="true" /></span>
                                            <h3>{vi ? 'Không có bài đọc phù hợp.' : 'No matching readings.'}</h3>
                                            <p>{vi ? 'Thử từ khóa khác, chọn chủ đề hoặc trình độ khác.' : 'Try another keyword, topic or level.'}</p>
                                            {filtersActive && (
                                                <button type="button" onClick={clearFilters} className={styles.softBtn}>
                                                    {vi ? "Xóa bộ lọc" : "Clear filters"}
                                                </button>
                                            )}
                                        </div>
                                    ) : <EmptyState
                                        onImportClick={() => {
                                            setModalTab("upload");
                                            setIsModalOpen(true);
                                        }}
                                    />
                                ) : (
                                    sortedMaterials.map((m) => {
                                        const canDelete = Boolean(
                                            library === "USER" && !m.isSystem
                                        );
                                        return (
                                            <ReadingCard
                                                key={m.id}
                                                material={m}
                                                onClick={() => handleOpenMaterial(m)}
                                                onSpeakingClick={() => handleSpeakingHandoff(m)}
                                                canDelete={canDelete}
                                                onDelete={() => handleDeleteMaterial(m)}
                                            />
                                        );
                                    })
                                )}
                            </div>
                        </section>
                        {totalPages != null && totalPages > 1 && (
                            <div className={styles.pager}>
                                <PageJump page={page + 1} pages={totalPages} vi={vi} label={vi ? 'Trang bài đọc' : 'Reading pages'}
                                    onPage={(n) => { if (catalog.data || n - 1 < page) goToPage(n - 1); }} />
                            </div>
                        )}

                        {/* Quick custom text area */}
                        {(library !== "USER" || (userTotal ?? 0) === 0) && <section className={`${styles.panel} ${styles.quick}`}>
                            <span className={styles.quickIcon} aria-hidden="true">
                                <FileText className="h-5 w-5" />
                            </span>
                            <div className="min-w-0 flex-1 space-y-1">
                                <p className="text-sm font-bold" style={{ color: "var(--ink)" }}>
                                    {vi ? 'Thêm bài đọc từ bất kỳ trang web nào' : 'Add reading material from anywhere'}
                                </p>
                                <p className="text-xs leading-relaxed" style={{ color: "var(--ink-3)" }}>
                                    {vi ? 'Dán trực tiếp văn bản, bài báo tiếng Anh hoặc tải file PDF để English Coach trích xuất từ vựng và câu mẫu.' : 'Paste English text or articles to extract vocabulary, analyze CEFR levels, and read actively.'}
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={() => {
                                    setModalTab("text");
                                    setIsModalOpen(true);
                                }}
                                className={styles.softBtn}
                            >
                                <ClipboardPaste className="h-4 w-4" aria-hidden="true" />
                                <span>{vi ? 'Dán văn bản nhanh' : 'Quick Paste Text'}</span>
                            </button>
                        </section>}
                    </div>
                )}

                {activeTab === "mybooks" && <MyBooksTab onSummary={setBookSummary} />}

                {activeTab === "bilingual" && (
                    <BilingualReadingPanel catalog={bilingualCatalog.data} loading={bilingualCatalog.isLoading} error={bilingualCatalog.error} onRetry={() => void bilingualCatalog.mutate()} onOpen={setSelectedBilingual} />
                )}

                {/* SPEED READING TAB */}
                {activeTab === "speed" && (
                    <div className="w-full">
                        <SpeedReader materials={materials} onActiveChange={setSpeedActive} />
                    </div>
                )}
            </div>

            {/* IMPORT MODAL */}
            {isModalOpen && (
                <ImportMaterialModal
                    initialTab={modalTab}
                    onClose={() => setIsModalOpen(false)}
                    onSuccess={() => {
                        setIsModalOpen(false);
                        setLibrary("USER"); setPage(0); setSearch(""); setQuery(""); setTopic(""); setLevel(""); setSortBy("recent");
                        void revalidateReadingUserCatalog();
                    }}
                />
            )}

            {/* DELETE CONFIRMATION MODAL */}
            {materialToDelete && (
                <div className={styles.scrim} onClick={() => !isDeleting && setMaterialToDelete(null)}>
                    <div
                        role="dialog"
                        aria-modal="true"
                        aria-label={vi ? "Xác nhận xóa bài đọc" : "Delete Reading Material"}
                        className={`${styles.panel} ${styles.dialog} animate-in fade-in zoom-in-95 duration-150`}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className={styles.dialogHead}>
                            <div className="flex items-start gap-3.5">
                                <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-rose-50 text-rose-600 dark:bg-rose-950/50 dark:text-rose-400">
                                    <Trash2 className="h-5 w-5" />
                                </div>
                                <div>
                                    <h3 className={styles.dialogTitle}>{vi ? "Xác nhận xóa bài đọc" : "Delete Reading Material"}</h3>
                                    <p className="mt-0.5 text-xs" style={{ color: "var(--ink-3)" }}>{vi ? "Hành động này không thể hoàn tác." : "This action cannot be undone."}</p>
                                </div>
                            </div>
                        </div>
                        <p className={styles.dialogBody}>
                            {vi ? (
                                <>Bạn có chắc chắn muốn xóa bài đọc <strong style={{ color: "var(--ink)" }}>"{materialToDelete.title}"</strong> này?</>
                            ) : (
                                <>Are you sure you want to delete <strong style={{ color: "var(--ink)" }}>"{materialToDelete.title}"</strong>?</>
                            )}
                        </p>
                        <div className={styles.dialogActions}>
                            <button type="button" onClick={() => setMaterialToDelete(null)} disabled={isDeleting} className={styles.softBtn}>
                                {vi ? "Hủy" : "Cancel"}
                            </button>
                            <button type="button" onClick={handleConfirmDelete} disabled={isDeleting} className="inline-flex h-11 items-center gap-1.5 rounded-[0.95rem] bg-rose-600 px-4 text-sm font-bold text-white shadow-sm transition hover:bg-rose-700 disabled:opacity-50 cursor-pointer">
                                {isDeleting ? (
                                    <>
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        <span>{vi ? "Đang xóa..." : "Deleting..."}</span>
                                    </>
                                ) : (
                                    <span>{vi ? "Xóa" : "Delete"}</span>
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
