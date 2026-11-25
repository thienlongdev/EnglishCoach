"use client";

import React, { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import useSWR, { mutate } from 'swr';
import {
    Headphones,
    Plus,
    ArrowRight,
    Activity,
    Clock,
    Search,
    X,
    Compass,
    User,
    ArrowLeft,
    Layers,
    Subtitles,
    Library,
    FileText,
    MonitorPlay,
    RotateCw,
    WifiOff,
    Waves,
    Play
} from 'lucide-react';
import { ListeningFilterBar } from '../../components/features/listening/ListeningFilterBar';
import { ListeningMaterialCard } from '../../components/features/listening/ListeningMaterialCard';
import { SharedListeningCard } from '../../components/features/listening/SharedListeningCard';
import { ImportMaterialModal } from '../../components/features/listening/ImportMaterialModal';
import {
    glass as s,
    ListeningHero,
    MediaPicture,
    SkeletonGrid,
    StatePanel,
    categoryIdentity,
    categoryLabel,
    sortCategories,
    formatClock,
    youtubeThumb
} from '../../components/features/listening/glass/ListeningGlass';
import { ListeningMaterialSummary, ListeningMaterialDetail, ListeningCategory } from '../../types/listening';
import {
    buildPersonalListeningPath,
    revalidatePersonalListeningLibrary,
    deleteListeningMaterial
} from '../../services/listeningApi';
import {
    getCachedPersonalListening,
    saveCachedPersonalListening,
    addPersonalListeningMaterial,
    removePersonalListeningMaterial,
    saveActiveListeningUser
} from '../../services/listeningCache';
import { useLanguage } from '@/context/LanguageContext';
import { fetchModuleEntry } from "@/services/moduleEntryResources";
import { useListeningSystemCategories, useModuleEntryScope } from "@/hooks/useModuleEntryResource";
import { useSession } from 'next-auth/react';
import { useCurrentRole } from '@/hooks/useCurrentRole';

// Stable empty fallbacks so memo/effect dependencies do not change on every render.
const NO_CATEGORIES: ListeningCategory[] = [];
const NO_PERSONAL_MATERIALS: ListeningMaterialSummary[] = [];

const listeningKeyFetcher = <T,>([path, scope]: [string, string | number]) => fetchModuleEntry<T>(path, String(scope));

const LEVEL_ORDER = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

/** Library finder: lesson length bands (minutes) and the topics whose lessons are animated or illustrated stories. */
type LengthBand = 'ALL' | 'SHORT' | 'MID' | 'LONG';
const LENGTH_BANDS: { id: LengthBand; vi: string; en: string; test: (s: number) => boolean }[] = [
    { id: 'ALL', vi: 'Mọi độ dài', en: 'Any length', test: () => true },
    { id: 'SHORT', vi: 'Dưới 5 phút', en: 'Under 5 min', test: (s) => s > 0 && s < 300 },
    { id: 'MID', vi: '5 đến 12 phút', en: '5 to 12 min', test: (s) => s >= 300 && s <= 720 },
    { id: 'LONG', vi: 'Trên 12 phút', en: 'Over 12 min', test: (s) => s > 720 },
];
const ANIMATED_TOPICS = new Set(['Animated Stories', 'Animated Conversations', 'Kids and Family']);
const isAnimatedLesson = (item: { topic?: string | null; channel?: string | null }) =>
    ANIMATED_TOPICS.has(item.topic ?? '') || item.channel === 'TED-Ed';

const totalDuration = (seconds: number) => {
    if (seconds <= 0) return '—';
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    return h > 0 ? `${h} giờ ${m} phút` : `${Math.max(1, m)} phút`;
};

export default function ListeningPage() {
    const scope = useModuleEntryScope();
    return <ListeningContent key={scope ?? "pending"} />;
}

function ListeningContent() {
    const { locale, t } = useLanguage();
    const vi = locale === 'vi';
    const { data: session } = useSession();
    const currentUserId = session?.user ? Number((session.user as any).id) : null;
    const { isAdmin } = useCurrentRole();
    // Personal hydration requires the authenticated identity; never trust a stored active-user pointer.
    const sessionUserScope = useModuleEntryScope();
    const userScope = sessionUserScope;

    // Sync active user identity
    useEffect(() => {
        if (sessionUserScope) {
            saveActiveListeningUser(sessionUserScope);
        }
    }, [sessionUserScope]);

    // Section switcher: 'library' (Kho Listening) vs 'personal' (Bài nghe của tôi)
    const [activeTab, setActiveTab] = useState<'library' | 'personal'>('library');

    // System Content Box State
    const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

    // Category Drilldown Filter State
    const [categorySearch, setCategorySearch] = useState('');
    const [categoryLevel, setCategoryLevel] = useState<string>('ALL');

    // Library-wide finder (local filter over the catalogue already loaded: no request)
    const [finderQuery, setFinderQuery] = useState('');
    const [finderLevel, setFinderLevel] = useState<string>('ALL');
    const [finderLength, setFinderLength] = useState<LengthBand>('ALL');
    const [finderAnimated, setFinderAnimated] = useState(false);

    // Personal Materials filters (list is strictly personalOnly=true)
    const [cefrLevel, setCefrLevel] = useState('');
    const [topic, setTopic] = useState('');
    const [accent, setAccent] = useState('');

    // Import modal state
    const [isImportOpen, setIsImportOpen] = useState(false);

    // "Continue" entry: the last lesson this browser opened (genuine localStorage history; no progress is claimed).
    const [continueMaterial, setContinueMaterial] = useState<{
        id: number;
        title: string;
        cefrLevel: string;
        accent: string;
        topic: string;
        audioUrl?: string;
        durationSeconds?: number | null;
    } | null>(null);

    // Persistent cache pre-hydration
    const personalPath = buildPersonalListeningPath(cefrLevel, topic, accent);
    const cachedPersonal = userScope ? getCachedPersonalListening(userScope, personalPath) : undefined;

    const { data: categoriesData, isLoading: categoriesFetching, error: categoriesError, mutate: retryCategories } = useListeningSystemCategories();
    const categories = useMemo(() => sortCategories(categoriesData ?? NO_CATEGORIES), [categoriesData]);
    const categoriesLoading = categoriesData === undefined && categoriesFetching;

    // Bai nghe cua toi: user-owned rows only (server scopes by the authenticated principal). Explicitly
    // revalidated after import/delete and by cross-tab sync when a practice session completes.
    const {
        data: personalData,
        isLoading: personalFetching,
        error: personalError,
        mutate: mutatePersonal
    } = useSWR<ListeningMaterialSummary[]>(
        userScope ? [personalPath, userScope] : null,
        listeningKeyFetcher,
        {
            revalidateOnFocus: false,
            revalidateIfStale: true,
            dedupingInterval: 30_000,
            keepPreviousData: false,
            fallbackData: cachedPersonal,
            onSuccess: (fresh) => {
                if (userScope && fresh) {
                    saveCachedPersonalListening(userScope, personalPath, fresh);
                }
            }
        }
    );
    const personalMaterials = personalData ?? cachedPersonal ?? NO_PERSONAL_MATERIALS;
    const personalLoading = personalData === undefined && personalFetching;

    // Check localStorage for continue listening session
    useEffect(() => {
        if (!userScope) return;
        try {
            const saved = localStorage.getItem("ec_last_listening_material");
            if (saved) {
                const parsed = JSON.parse(saved);
                if (parsed && parsed.id) {
                    setContinueMaterial(parsed);
                }
            }
        } catch {
            // Ignore parse errors
        }
    }, [personalMaterials, categories]);

    const handleClearPersonalFilters = () => {
        setCefrLevel('');
        setTopic('');
        setAccent('');
    };

    const handleDeletePersonalMaterial = async (id: number) => {
        const confirmed = window.confirm(
            t.deleteMaterialPrompt || "Bạn có chắc chắn muốn xóa bài nghe này không? Toàn bộ transcript và bài tập liên quan sẽ bị xóa."
        );
        if (!confirmed) return;

        try {
            await deleteListeningMaterial(id);
            if (userScope) {
                removePersonalListeningMaterial(userScope, id);
            }
            await mutatePersonal(prev => prev?.filter(m => m.id !== id), { revalidate: false });
            void revalidatePersonalListeningLibrary();
            if (continueMaterial?.id === id) {
                setContinueMaterial(null);
                localStorage.removeItem("ec_last_listening_material");
            }
        } catch (err) {
            console.error("Failed to delete material", err);
            alert("Không thể xóa tài liệu. Vui lòng thử lại sau.");
        }
    };

    const handleImportSuccess = (created: ListeningMaterialDetail) => {
        setIsImportOpen(false);
        setActiveTab('personal');
        setSelectedCategory(null);
        // Show the unfiltered personal list so the new item is visible; the badge derives from that list.
        handleClearPersonalFilters();
        if (!userScope || !created) return;
        // Server-returned row, newest first (matches the backend ORDER BY id DESC). The modal then
        // revalidates every personal list from the server. SYSTEM catalogue is never touched.
        const { segments: _segments, ...createdSummary } = created;
        addPersonalListeningMaterial(userScope, createdSummary);
        mutate<ListeningMaterialSummary[]>(
            [buildPersonalListeningPath(), userScope],
            current => current && !current.some(m => m.id === created.id) ? [createdSummary, ...current] : current,
            { revalidate: false }
        );
    };

    // Active Category Object
    const activeCategoryObj = useMemo(() => {
        if (!selectedCategory) return null;
        return categories.find(c => c.topic === selectedCategory) || null;
    }, [categories, selectedCategory]);

    // Levels that really occur in the opened collection (no level choice that can only return nothing).
    const categoryLevels = useMemo(() => {
        const found = new Set((activeCategoryObj?.items || []).map(item => item.level?.toUpperCase()).filter(Boolean) as string[]);
        const rank = (level: string) => (LEVEL_ORDER.includes(level) ? LEVEL_ORDER.indexOf(level) : LEVEL_ORDER.length);
        return [...found].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    }, [activeCategoryObj]);

    // Filtered Items within the selected category
    const filteredCategoryItems = useMemo(() => {
        if (!activeCategoryObj) return [];
        return (activeCategoryObj.items || []).filter(item => {
            if (categoryLevel !== 'ALL' && item.level?.toUpperCase() !== categoryLevel.toUpperCase()) {
                return false;
            }
            if (categorySearch.trim()) {
                const q = categorySearch.toLowerCase().trim();
                const matchTitle = item.title?.toLowerCase().includes(q);
                const matchChannel = item.channel?.toLowerCase().includes(q);
                if (!matchTitle && !matchChannel) {
                    return false;
                }
            }
            return true;
        });
    }, [activeCategoryObj, categoryLevel, categorySearch]);

    const allSystemItems = useMemo(() => categories.flatMap(c => c.items || []), [categories]);
    const libraryLevels = useMemo(() => {
        const found = new Set(allSystemItems.map(item => item.level?.toUpperCase()).filter(Boolean) as string[]);
        return LEVEL_ORDER.filter(level => found.has(level));
    }, [allSystemItems]);
    const finderActive = finderQuery.trim() !== '' || finderLevel !== 'ALL' || finderLength !== 'ALL' || finderAnimated;
    const finderResults = useMemo(() => {
        if (!finderActive) return [];
        const q = finderQuery.toLowerCase().trim();
        const band = LENGTH_BANDS.find(b => b.id === finderLength) ?? LENGTH_BANDS[0];
        return allSystemItems.filter(item => {
            if (finderLevel !== 'ALL' && item.level?.toUpperCase() !== finderLevel) return false;
            if (finderLength !== 'ALL' && !band.test(item.durationSeconds ?? 0)) return false;
            if (finderAnimated && !isAnimatedLesson(item)) return false;
            if (q) {
                const haystack = `${item.title ?? ''} ${item.channel ?? ''} ${item.topic ?? ''} ${categoryLabel(item.topic, true)}`.toLowerCase();
                if (!haystack.includes(q)) return false;
            }
            return true;
        });
    }, [allSystemItems, finderActive, finderQuery, finderLevel, finderLength, finderAnimated]);
    const clearFinder = () => { setFinderQuery(''); setFinderLevel('ALL'); setFinderLength('ALL'); setFinderAnimated(false); };

    // Total System Videos Count
    const totalSystemVideos = useMemo(() => {
        return categories.reduce((sum, c) => sum + (c.count || 0), 0);
    }, [categories]);
    const practiceReadyCount = useMemo(() => categories.reduce((sum, c) => sum + (c.items || []).filter(i => i.practiceAvailable).length, 0), [categories]);
    const filledTopics = useMemo(() => categories.filter(c => c.count > 0).length, [categories]);

    const personalStats = useMemo(() => {
        const docs = personalMaterials.filter(m => m.sourceType === 'DOCUMENT').length;
        return {
            docs,
            videos: personalMaterials.length - docs,
            seconds: personalMaterials.reduce((sum, m) => sum + (m.durationSeconds > 0 ? m.durationSeconds : 0), 0),
        };
    }, [personalMaterials]);

    // The last opened lesson, resolved against the lists this page already holds.
    const activeHero = useMemo(() => {
        if (!continueMaterial) return null;
        const matchedPersonal = personalMaterials.find(m => m.id === continueMaterial.id);
        if (matchedPersonal) {
            return {
                id: matchedPersonal.id,
                sourceType: matchedPersonal.sourceType ?? 'VIDEO',
                title: matchedPersonal.title,
                cefrLevel: matchedPersonal.sourceType === 'DOCUMENT' ? matchedPersonal.cefrLevel || null : matchedPersonal.cefrLevel,
                accent: matchedPersonal.sourceType === 'DOCUMENT' ? null : matchedPersonal.accent,
                topic: matchedPersonal.topic,
                thumbnail: matchedPersonal.sourceType === 'DOCUMENT' ? null : youtubeThumb(matchedPersonal.youtubeVideoId, matchedPersonal.audioUrl),
                durationSeconds: matchedPersonal.durationSeconds,
                origin: vi ? 'Bài nghe của tôi' : 'My listening',
            };
        }
        for (const cat of categories) {
            const matchedShared = (cat.items || []).find(m => m.id === continueMaterial.id);
            if (matchedShared) {
                return {
                    id: matchedShared.id,
                    sourceType: 'VIDEO' as const,
                    title: matchedShared.title,
                    cefrLevel: matchedShared.level,
                    accent: matchedShared.accent,
                    topic: matchedShared.topic,
                    thumbnail: matchedShared.thumbnail || youtubeThumb(matchedShared.youtubeVideoId),
                    durationSeconds: matchedShared.durationSeconds,
                    origin: 'Kho Listening',
                };
            }
        }
        return null;
    }, [continueMaterial, personalMaterials, categories, vi]);

    const personalFiltered = Boolean(cefrLevel || topic || accent);
    const openImport = () => setIsImportOpen(true);
    // Hero numbers: "…" while loading, "—" when the list could not be read (never a fake 0).
    const catalogStat = (value: React.ReactNode) => categoriesLoading ? '…' : (categoriesData === undefined ? '—' : value);
    const personalStat = (value: React.ReactNode) => personalLoading ? '…' : (personalData === undefined && !cachedPersonal ? '—' : value);
    const world = activeTab;

    return (
        <div className={s.page} data-world={world}>
            <div className={s.inner}>
                {activeTab === 'library' ? (
                    <ListeningHero
                        world="library"
                        titleId="listening-hero-library"
                        eyebrow="Echo Sonic Universe"
                        eyebrowIcon={<Headphones size={14} aria-hidden="true" />}
                        title={t.listeningLibrary || 'Thư viện Luyện nghe'}
                        lead={t.listeningLibraryDesc || "Luyện nghe tiếng Anh chuyên sâu qua video YouTube tuyển chọn và tài liệu cá nhân với transcript tương tác và bài tập chép chính tả."}
                        stats={[
                            { value: catalogStat(totalSystemVideos), label: vi ? 'Bài nghe tuyển chọn' : 'Curated lessons', icon: <Library size={16} /> },
                            { value: catalogStat(filledTopics), label: vi ? 'Chủ đề' : 'Topics', icon: <Compass size={16} /> },
                            { value: catalogStat(practiceReadyCount), label: vi ? 'Có bài chính tả' : 'With dictation', icon: <Subtitles size={16} /> },
                        ]}
                        actions={<HeroActions vi={vi} onImport={openImport} />}
                    />
                ) : (
                    <ListeningHero
                        world="personal"
                        titleId="listening-hero-personal"
                        eyebrow={vi ? 'Bài nghe của tôi' : 'My listening'}
                        eyebrowIcon={<User size={14} aria-hidden="true" />}
                        title={vi ? 'Không gian nghe của riêng bạn' : 'Your private listening room'}
                        lead={vi
                            ? 'Video YouTube và tài liệu bạn đã nhập, lưu riêng cho tài khoản của bạn. Mở lại, nghe theo transcript và luyện chép chính tả bất cứ lúc nào.'
                            : 'The YouTube videos and documents you imported, kept for your account only. Reopen them, follow the transcript and practise dictation any time.'}
                        stats={[
                            { value: personalStat(personalMaterials.length), label: personalFiltered ? (vi ? 'Bài nghe (đang lọc)' : 'Lessons (filtered)') : (vi ? 'Bài nghe đã lưu' : 'Saved lessons'), icon: <Layers size={16} /> },
                            { value: personalStat(personalStats.videos), label: 'Video YouTube', icon: <MonitorPlay size={16} /> },
                            { value: personalStat(personalStats.docs), label: vi ? 'Tài liệu / văn bản' : 'Documents / text', icon: <FileText size={16} /> },
                            { value: personalStat(totalDuration(personalStats.seconds)), label: vi ? 'Tổng thời lượng' : 'Total length', icon: <Clock size={16} /> },
                        ]}
                        actions={<HeroActions vi={vi} onImport={openImport} />}
                    />
                )}

                {/* Section switcher: Kho Listening (SYSTEM) vs Bài nghe của tôi (own) */}
                <div className={`${s.panel} ${s.worldTabs}`} role="tablist" aria-label={vi ? 'Thư viện luyện nghe' : 'Listening libraries'} data-guide="ls-tabs">
                    <button
                        type="button"
                        role="tab"
                        id="ls-tab-library"
                        aria-selected={activeTab === 'library'}
                        aria-controls="ls-panel"
                        data-tone="science"
                        onClick={() => {
                            setActiveTab('library');
                        }}
                        className={s.worldTab}
                    >
                        <Compass size={17} aria-hidden="true" />
                        <span>Kho Listening</span>
                        {totalSystemVideos > 0 && <span className={s.tabCount}>{totalSystemVideos} bài</span>}
                    </button>
                    <button
                        type="button"
                        role="tab"
                        id="ls-tab-personal"
                        aria-selected={activeTab === 'personal'}
                        aria-controls="ls-panel"
                        data-tone="talks"
                        onClick={() => {
                            setActiveTab('personal');
                            setSelectedCategory(null);
                        }}
                        className={s.worldTab}
                    >
                        <User size={17} aria-hidden="true" />
                        <span>Bài nghe của tôi</span>
                        {personalMaterials.length > 0 && <span className={s.tabCount}>{personalMaterials.length}</span>}
                    </button>
                </div>

                {/* Continue: the last lesson this browser opened (no invented progress) */}
                {activeHero && (
                    <section className={`${s.panel} ${s.resume} ${s.rise}`} aria-label={t.continueListening || 'Tiếp tục nghe'} data-tone={categoryIdentity(activeHero.topic).tone}>
                        <div className={s.resumeThumb}>
                            <MediaPicture
                                src={activeHero.thumbnail}
                                alt=""
                                label={activeHero.sourceType === 'DOCUMENT' ? (vi ? 'Âm thanh từ tài liệu' : 'Document audio') : activeHero.origin}
                                title={activeHero.title}
                                tone={activeHero.sourceType === 'DOCUMENT' ? 'document' : categoryIdentity(activeHero.topic).tone}
                                priority
                            />
                        </div>
                        <div className="min-w-0">
                            <p className={s.resumeKicker}>{t.continueListening || 'Tiếp tục nghe'} · {activeHero.origin}</p>
                            <h2 className={s.resumeTitle}>{activeHero.title}</h2>
                            <div className={s.resumeMeta}>
                                {activeHero.cefrLevel && <span className={s.meta}>{activeHero.cefrLevel}</span>}
                                {activeHero.accent && <span className={s.meta}>{activeHero.accent}</span>}
                                {activeHero.topic && <span className={s.meta}>{categoryLabel(activeHero.topic, vi)}</span>}
                                {formatClock(activeHero.durationSeconds) && <span className={s.meta}><Clock size={12} aria-hidden="true" />{formatClock(activeHero.durationSeconds)}</span>}
                            </div>
                        </div>
                        <Link href={`/listening/${activeHero.id}`} className={`${s.btn} ${s.btnPrimary}`}>
                            <span>{t.continuePracticeListening || 'Tiếp tục luyện nghe'}</span>
                            <ArrowRight size={18} aria-hidden="true" />
                        </Link>
                    </section>
                )}

                <div id="ls-panel" role="tabpanel" aria-labelledby={activeTab === 'library' ? 'ls-tab-library' : 'ls-tab-personal'} className="flex flex-col gap-5">
                    {/* TAB 1: KHO LISTENING (SYSTEM CONTENT) */}
                    {activeTab === 'library' && (
                        selectedCategory === null ? (
                            <>
                                <div className={`${s.sectionHead} ec-wp-plate`}>
                                    <div>
                                        <h2 className={s.sectionTitle}>{vi ? 'Chủ đề nổi bật' : 'Featured topics'}</h2>
                                        <p className={s.sectionLead}>
                                            Nội dung tuyển chọn từ các kênh uy tín nhất, được chuẩn hóa transcript và bài tập chép chính tả theo cấp độ.
                                        </p>
                                    </div>
                                    {!categoriesLoading && totalSystemVideos > 0 && (
                                        <span className={s.sectionNote}><Waves size={15} aria-hidden="true" />{totalSystemVideos} {vi ? 'bài nghe trong' : 'lessons in'} {filledTopics} {vi ? 'chủ đề' : 'topics'}</span>
                                    )}
                                </div>

                                {!categoriesLoading && allSystemItems.length > 0 && (
                                    <div className={`${s.panel} ${s.toolbar} ${s.finder}`} data-guide="ls-finder" role="search" aria-label={vi ? 'Tìm bài nghe trong Kho Listening' : 'Find lessons in the library'}>
                                        <label className={s.search}>
                                            <span className="sr-only">{vi ? 'Tìm bài nghe' : 'Find a lesson'}</span>
                                            <Search size={16} aria-hidden="true" />
                                            <input
                                                type="text"
                                                value={finderQuery}
                                                onChange={(e) => setFinderQuery(e.target.value)}
                                                placeholder={vi ? 'Tìm bài nghe theo tên, kênh hoặc chủ đề...' : 'Find a lesson by title, channel or topic...'}
                                            />
                                            {finderQuery && (
                                                <button type="button" onClick={() => setFinderQuery('')} className={s.searchClear} aria-label={vi ? 'Xóa tìm kiếm' : 'Clear search'}>
                                                    <X size={15} />
                                                </button>
                                            )}
                                        </label>
                                        <div className="flex flex-wrap gap-2">
                                        <div className={s.seg} role="group" aria-label={vi ? 'Cấp độ' : 'Level'}>
                                            {['ALL', ...libraryLevels].map(lvl => (
                                                <button key={lvl} type="button" aria-pressed={finderLevel === lvl} onClick={() => setFinderLevel(lvl)} className={s.segBtn}>
                                                    {lvl === 'ALL' ? (vi ? 'Mọi cấp độ' : 'All levels') : lvl}
                                                </button>
                                            ))}
                                        </div>
                                        <div className={s.seg} role="group" aria-label={vi ? 'Độ dài' : 'Length'}>
                                            {LENGTH_BANDS.map(band => (
                                                <button key={band.id} type="button" aria-pressed={finderLength === band.id} onClick={() => setFinderLength(band.id)} className={s.segBtn}>
                                                    {vi ? band.vi : band.en}
                                                </button>
                                            ))}
                                        </div>
                                        <div className={s.seg} role="group" aria-label={vi ? 'Hình thức' : 'Format'}>
                                            <button type="button" aria-pressed={finderAnimated} onClick={() => setFinderAnimated(v => !v)} className={s.segBtn}>
                                                {vi ? 'Hoạt hình và truyện kể' : 'Animation and stories'}
                                            </button>
                                        </div>
                                        </div>
                                    </div>
                                )}

                                {categoriesLoading ? (
                                    <SkeletonGrid count={6} />
                                ) : finderActive ? (
                                    finderResults.length > 0 ? (
                                        <>
                                            <p className={s.resultLine}>
                                                <span><strong>{finderResults.length}</strong> / {allSystemItems.length} {vi ? 'bài nghe khớp bộ lọc' : 'lessons match'}</span>
                                                <button type="button" onClick={clearFinder} className={`${s.btn} ${s.btnGhost} ${s.btnSm}`}>{vi ? 'Xóa bộ lọc' : 'Clear filters'}</button>
                                            </p>
                                            <div className={s.mediaGrid}>
                                                {finderResults.map(item => <SharedListeningCard key={item.id} item={item} />)}
                                            </div>
                                        </>
                                    ) : (
                                        <StatePanel
                                            icon={<Search size={26} />}
                                            title={vi ? 'Không tìm thấy bài nghe phù hợp' : 'No matching lessons'}
                                            text={vi ? 'Thử từ khóa khác, hoặc nới rộng cấp độ và độ dài.' : 'Try another word, or widen the level and length.'}
                                            actions={<button type="button" onClick={clearFinder} className={`${s.btn} ${s.btnPrimary}`}>{vi ? 'Xóa bộ lọc' : 'Clear filters'}</button>}
                                        />
                                    )
                                ) : categories.length === 0 ? (
                                    categoriesError ? (
                                        <StatePanel
                                            kind="error"
                                            icon={<WifiOff size={26} />}
                                            title={vi ? 'Chưa tải được Kho Listening' : 'Could not load the library'}
                                            text={vi ? 'Kết nối tới máy chủ bị gián đoạn. Nội dung của bạn không bị ảnh hưởng.' : 'The connection to the server was interrupted. Your content is not affected.'}
                                            actions={<button type="button" onClick={() => void retryCategories()} className={`${s.btn} ${s.btnPrimary}`}><RotateCw size={16} aria-hidden="true" />{vi ? 'Thử lại' : 'Try again'}</button>}
                                        />
                                    ) : (
                                        <StatePanel icon={<Headphones size={26} />} title={vi ? 'Kho Listening đang trống' : 'The library is empty'} text={vi ? 'Chưa có bài nghe tuyển chọn nào được xuất bản.' : 'No curated lessons have been published yet.'} />
                                    )
                                ) : (
                                    <div className={s.catGrid}>
                                        {categories.map((category, index) => {
                                            const identity = categoryIdentity(category.topic);
                                            const Icon = identity.icon;
                                            const pictures = (category.items || [])
                                                .map(item => item.thumbnail || youtubeThumb(item.youtubeVideoId))
                                                .filter((u): u is string => Boolean(u))
                                                .slice(0, 3);
                                            const previewItem = category.items && category.items.length > 0 ? category.items[0] : null;
                                            return (
                                                <button
                                                    key={category.topic}
                                                    type="button"
                                                    data-tone={identity.tone}
                                                    className={`${s.catCard} ${s.rise}`}
                                                    style={{ animationDelay: `${Math.min(index, 8) * 45}ms` }}
                                                    onClick={() => {
                                                        setSelectedCategory(category.topic);
                                                        setCategorySearch('');
                                                        setCategoryLevel('ALL');
                                                    }}
                                                    aria-label={`${categoryLabel(category.topic, vi)}: ${category.count} ${vi ? 'bài học' : 'lessons'}`}
                                                >
                                                    {pictures.length > 0 ? (
                                                        <div className={s.catMosaic} data-count={pictures.length} aria-hidden="true">
                                                            {/* eslint-disable-next-line @next/next/no-img-element */}
                                                            {pictures.map(src => <span key={src}><img src={src} alt="" loading="lazy" decoding="async" draggable={false} /></span>)}
                                                        </div>
                                                    ) : <div className={s.catEmpty} aria-hidden="true" />}
                                                    <div className={s.catVeil} aria-hidden="true" />
                                                    <div className={s.catTop}>
                                                        <span className={s.catEmblem} aria-hidden="true"><Icon size={22} /></span>
                                                        <span className={s.catCount}>{category.count} bài học</span>
                                                    </div>
                                                    <div className={s.catBody}>
                                                        <span className={s.catTitle}>{categoryLabel(category.topic, vi)}</span>
                                                        {identity.sources && <span className={s.catSources}>{identity.sources}</span>}
                                                        <span className={s.catDesc}>{identity.description}</span>
                                                        <span className={s.catFoot}>
                                                            <span>
                                                                {previewItem
                                                                    ? <>{previewItem.channel ? `${previewItem.channel} · ` : ''}{previewItem.title}</>
                                                                    : (vi ? 'Chưa có bài trong chủ đề này' : 'No lessons in this topic yet')}
                                                            </span>
                                                            <span className={s.catGo} aria-hidden="true"><ArrowRight size={17} /></span>
                                                        </span>
                                                    </div>
                                                </button>
                                            );
                                        })}
                                    </div>
                                )}
                            </>
                        ) : (
                            /* An opened collection */
                            <CollectionView
                                vi={vi}
                                topic={selectedCategory}
                                category={activeCategoryObj}
                                levels={categoryLevels}
                                level={categoryLevel}
                                setLevel={setCategoryLevel}
                                search={categorySearch}
                                setSearch={setCategorySearch}
                                items={filteredCategoryItems}
                                onBack={() => setSelectedCategory(null)}
                            />
                        )
                    )}

                    {/* TAB 2: BÀI NGHE CỦA TÔI (USER PERSONAL CONTENT ONLY) */}
                    {activeTab === 'personal' && (
                        <>
                            <div className={`${s.sectionHead} ec-wp-plate`}>
                                <div>
                                    <h2 className={s.sectionTitle}>Bài nghe của tôi</h2>
                                    <p className={s.sectionLead}>
                                        Các video YouTube và tài liệu cá nhân bạn đã nhập. Chỉ có bạn mới có quyền xem và luyện tập.
                                    </p>
                                </div>
                            </div>

                            <ListeningFilterBar
                                cefrLevel={cefrLevel}
                                setCefrLevel={setCefrLevel}
                                topic={topic}
                                setTopic={setTopic}
                                accent={accent}
                                setAccent={setAccent}
                                onClear={handleClearPersonalFilters}
                            />

                            {personalLoading ? (
                                <SkeletonGrid count={4} />
                            ) : personalMaterials.length > 0 ? (
                                <>
                                    <p className={s.resultLine}>
                                        <span><strong>{personalMaterials.length}</strong> {vi ? 'bài nghe' : 'lessons'}{personalFiltered ? (vi ? ' khớp bộ lọc' : ' match the filters') : ''}</span>
                                    </p>
                                    <div className={s.mediaGrid}>
                                        {personalMaterials.map(material => {
                                            const canDelete = Boolean(
                                                isAdmin ||
                                                (currentUserId != null && material.ownerUserId != null && material.ownerUserId === currentUserId && !material.isSystem)
                                            );
                                            return (
                                                <ListeningMaterialCard
                                                    key={material.id}
                                                    material={material}
                                                    onDelete={canDelete ? handleDeletePersonalMaterial : undefined}
                                                />
                                            );
                                        })}
                                    </div>
                                </>
                            ) : personalError ? (
                                <StatePanel
                                    kind="error"
                                    icon={<WifiOff size={26} />}
                                    title={vi ? 'Chưa tải được bài nghe của bạn' : 'Could not load your lessons'}
                                    text={vi ? 'Kết nối tới máy chủ bị gián đoạn. Bài nghe của bạn vẫn được lưu an toàn.' : 'The connection was interrupted. Your lessons are still saved.'}
                                    actions={<button type="button" onClick={() => void mutatePersonal()} className={`${s.btn} ${s.btnPrimary}`}><RotateCw size={16} aria-hidden="true" />{vi ? 'Thử lại' : 'Try again'}</button>}
                                />
                            ) : (
                                <StatePanel
                                    icon={<Headphones size={28} />}
                                    title={personalFiltered ? (t.emptyListeningFiltered || "Không tìm thấy bài nghe") : (t.emptyListeningTitle || "Chưa có bài nghe cá nhân")}
                                    text={personalFiltered
                                        ? (t.emptyListeningFilteredDesc || "Thử thay đổi bộ lọc để xem các bài nghe khác.")
                                        : "Nhập video từ YouTube bất kỳ để hệ thống tự động trích xuất transcript từng từ và tạo bài tập chép chính tả cho riêng bạn. Dùng nút Import ở phía trên."}
                                    actions={personalFiltered ? (
                                        <button type="button" onClick={handleClearPersonalFilters} className={`${s.btn} ${s.btnPrimary}`}>
                                            {t.clearListeningFilters || "Xóa bộ lọc"}
                                        </button>
                                    ) : undefined}
                                />
                            )}
                        </>
                    )}
                </div>

                {/* Import Modal */}
                <ImportMaterialModal
                    isOpen={isImportOpen}
                    onClose={() => setIsImportOpen(false)}
                    onSuccess={handleImportSuccess}
                />
            </div>
        </div>
    );
}

/** The one Import entry of /listening (owner rule: a single import CTA) + the statistics route. */
function HeroActions({ vi, onImport }: { vi: boolean; onImport: () => void }) {
    return (
        <>
            <button type="button" onClick={onImport} className={s.heroBtn} data-guide="ls-import">
                <Plus size={18} aria-hidden="true" />
                <span>Import</span>
            </button>
            <Link href="/listening/dashboard" className={s.heroBtnGlass}>
                <Activity size={17} aria-hidden="true" />
                <span>{vi ? 'Thống kê luyện nghe' : 'Listening Stats'}</span>
            </Link>
        </>
    );
}

function CollectionView({ vi, topic, category, levels, level, setLevel, search, setSearch, items, onBack }: {
    vi: boolean;
    topic: string;
    category: ListeningCategory | null;
    levels: string[];
    level: string;
    setLevel: (v: string) => void;
    search: string;
    setSearch: (v: string) => void;
    items: ListeningCategory['items'];
    onBack: () => void;
}) {
    const identity = categoryIdentity(topic);
    const name = categoryLabel(topic, vi);
    const Icon = identity.icon;
    const all = category?.items || [];
    const strip = all.map(i => i.thumbnail || youtubeThumb(i.youtubeVideoId)).filter((u): u is string => Boolean(u)).slice(0, 4);
    const ready = all.filter(i => i.practiceAvailable).length;
    const filtered = level !== 'ALL' || search.trim() !== '';
    return (
        <div className="flex flex-col gap-5" data-tone={identity.tone}>
            <button type="button" onClick={onBack} className={s.back}>
                <ArrowLeft size={16} aria-hidden="true" />
                <span>Quay lại Kho Listening</span>
            </button>

            <section className={`${s.coll} ${s.rise}`} aria-labelledby="ls-collection-title">
                <div className={s.collStrip} aria-hidden="true">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {strip.map(src => <span key={src}><img src={src} alt="" decoding="async" draggable={false} /></span>)}
                </div>
                <div className={s.collVeil} aria-hidden="true" />
                <div className={s.collBody}>
                    <span className={s.catEmblem} aria-hidden="true"><Icon size={22} /></span>
                    <h2 id="ls-collection-title" className={s.collTitle}>{name}</h2>
                    <p className="text-sm leading-relaxed text-slate-200/90 max-w-xl">{identity.description}</p>
                    <div className={s.collMeta}>
                        <span className={s.darkChip} data-accent="">{category?.count || 0} bài học</span>
                        {ready > 0 && <span className={s.darkChip}><Subtitles size={13} aria-hidden="true" />{ready} {vi ? 'có bài chính tả' : 'with dictation'}</span>}
                        {identity.sources && <span className={s.darkChip}>{identity.sources}</span>}
                    </div>
                </div>
            </section>

            <div className={`${s.panel} ${s.toolbar}`}>
                <label className={s.search}>
                    <span className="sr-only">{vi ? `Tìm trong ${name}` : `Search ${name}`}</span>
                    <Search size={16} aria-hidden="true" />
                    <input
                        type="text"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder={vi ? `Tìm trong ${name} theo tên video, kênh...` : `Search ${name} by title or channel...`}
                    />
                    {search && (
                        <button type="button" onClick={() => setSearch('')} className={s.searchClear} aria-label={vi ? 'Xóa tìm kiếm' : 'Clear search'}>
                            <X size={15} />
                        </button>
                    )}
                </label>
                {levels.length > 1 && (
                    <div className={s.seg} role="group" aria-label={vi ? 'Cấp độ' : 'Level'}>
                        {['ALL', ...levels].map((lvl) => (
                            <button key={lvl} type="button" aria-pressed={level === lvl} onClick={() => setLevel(lvl)} className={s.segBtn}>
                                {lvl === 'ALL' ? 'Tất cả cấp độ' : lvl}
                            </button>
                        ))}
                    </div>
                )}
            </div>

            {items.length > 0 ? (
                <>
                    <p className={s.resultLine}>
                        <span><strong>{items.length}</strong> / {all.length} {vi ? 'bài nghe' : 'lessons'}</span>
                    </p>
                    <div className={s.mediaGrid}>
                        {items.map(item => (
                            <SharedListeningCard key={item.id} item={item} />
                        ))}
                    </div>
                </>
            ) : (
                <StatePanel
                    icon={filtered ? <Search size={26} /> : <Play size={26} />}
                    title={filtered ? 'Không tìm thấy bài nghe trong mục này' : (vi ? 'Chủ đề này chưa có bài nghe' : 'No lessons in this topic yet')}
                    text={filtered ? 'Thử tìm với từ khóa khác hoặc chuyển sang cấp độ CEFR khác.' : (vi ? 'Các bài nghe tuyển chọn sẽ xuất hiện ở đây khi được xuất bản.' : 'Curated lessons appear here once published.')}
                    actions={filtered ? (
                        <button type="button" onClick={() => { setSearch(''); setLevel('ALL'); }} className={`${s.btn} ${s.btnPrimary}`}>
                            Xóa bộ lọc
                        </button>
                    ) : undefined}
                />
            )}
        </div>
    );
}
