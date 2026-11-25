import React, { useState, useEffect, useRef, useMemo, useId, useCallback } from 'react';
import { useNavigationOverlay } from '@/lib/navigation/useAutoHideSurface';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { useMorphPresence } from '@/components/morph/useMorphPresence';
import {
    Search,
    X,
    Volume2,
    Square,
    Loader2,
    BookOpen,
    Languages,
    BookmarkCheck,
    BookmarkPlus,
    Layers,
    ArrowLeft,
    ArrowRight,
    Info,
    RotateCcw,
    MessageSquareQuote,
    Waves,
    CornerDownLeft,
} from 'lucide-react';
import { useSession } from 'next-auth/react';
import { apiClient } from '@/services/api-client';
import {
    lookupCanonical,
    fetchCollocations,
    fetchPhrases,
    normalizeQuery,
    hasValidLexicalContent
} from '@/services/dictionaryEngine';
import {
    CanonicalDictionaryEntry,
    CollocationsResponse,
    PhrasesResponse,
    Sense
} from '@/services/dictionary/types';
import { flashcardMeaningVi } from '@/services/dictionaryRanking';
import { entryTypeLabel, nestSenses, posLabelVi, sanitizeLexicalText } from './lexicon/lexiconText';
import {
    RelationsCard,
    ResultSkeleton,
    SenseChapter,
    SenseSaveState,
    UsagePanel,
    UsageTab,
    VietnameseChapter,
    WordChips,
} from './lexicon/LexiconParts';
import styles from './lexicon/lexicon.module.css';
import { useOverlayTitle } from '@/lib/brand/tabTitle';

/** The dictionary's world in night and day (rendered stills, `docs/dictionary/echo-lexicon-2026-10-24/art`; content-hashed names). */
const ART_NIGHT_1200 = '/assets/dictionary/lexicon-ocean-1200-eba701d2.webp';
const ART_NIGHT_2400 = '/assets/dictionary/lexicon-ocean-2400-6fc21745.webp';
const ART_DAY_1200 = '/assets/dictionary/lexicon-ocean-day-1200-fdc9cb55.webp';
const ART_DAY_2400 = '/assets/dictionary/lexicon-ocean-day-2400-3c53a4f6.webp';

/** Real queries the dictionary answers, offered as a first search (nothing is shown until the learner picks one). */
const FIRST_SEARCHES = [
    { kind: 'Từ vựng', example: 'fall', icon: Search },
    { kind: 'Cụm động từ', example: 'take off', icon: Layers },
    { kind: 'Thành ngữ', example: 'under the weather', icon: MessageSquareQuote },
    { kind: 'Thành ngữ', example: 'break the ice', icon: Waves },
];

const SUGGEST_MIN = 2;
const SUGGEST_DEBOUNCE_MS = 160;

interface Suggestion { word: string; meaning: string | null }

export interface GlobalDictionarySearchProps {
    navigationOwned?: boolean;
    portalHost?: HTMLElement | null;
    customTrigger?: (open: () => void) => React.ReactNode;
}

export const GlobalDictionarySearch: React.FC<GlobalDictionarySearchProps> = ({ customTrigger, portalHost, navigationOwned = false }) => {
    const [isOpen, setIsOpen] = useState(false);
    useOverlayTitle(isOpen ? 'Từ điển' : null);
    const [mounted, setMounted] = useState(false);

    // Keep Follow-System OS theme switches synchronized with html.dark even on immersive routes without TopNavbar.
    useEffect(() => {
        if (!isOpen || typeof window === 'undefined') return;
        const media = window.matchMedia?.('(prefers-color-scheme: dark)');
        if (!media) return;
        const onSystemChange = (event: MediaQueryListEvent) => {
            try {
                if (!localStorage.getItem('theme')) {
                    document.documentElement.classList.toggle('dark', event.matches);
                }
            } catch {
                // Storage denied: preserve active class on html.
            }
        };
        media.addEventListener('change', onSystemChange);
        return () => media.removeEventListener('change', onSystemChange);
    }, [isOpen]);

    // Search state
    const [query, setQuery] = useState('');
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState<CanonicalDictionaryEntry | null>(null);
    const [error, setError] = useState('');
    const [errorRetry, setErrorRetry] = useState<string | null>(null);

    // Tabs
    const [mainTab, setMainTab] = useState<'dictionary' | 'usage'>('dictionary');
    const [dictMode, setDictMode] = useState<'en-en' | 'en-vi'>('en-en');
    const [usageSubTab, setUsageSubTab] = useState<UsageTab>('collocations');
    // until the learner picks a group, the first group with data (in this order) is shown, even if it arrives last
    const pickedSubTab = useRef(false);

    // Progressive data for the related-phrases tab
    const [collocationsData, setCollocationsData] = useState<CollocationsResponse | null>(null);
    const [phrasesData, setPhrasesData] = useState<PhrasesResponse | null>(null);
    const [loadingUsage, setLoadingUsage] = useState(false);

    // Senses expansion state (per POS index)
    const [expandedPosMap, setExpandedPosMap] = useState<Record<number, boolean>>({});
    // Examples expansion state (per sense key)
    const [expandedExamplesMap, setExpandedExamplesMap] = useState<Record<string, boolean>>({});

    // Audio state
    const [playingRegion, setPlayingRegion] = useState<string | null>(null);
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

    // Save flashcard state
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [saveError, setSaveError] = useState('');
    const [senseSave, setSenseSave] = useState<SenseSaveState>(null);

    // History stack for back navigation
    const [history, setHistory] = useState<string[]>([]);

    // Suggestions (local corpus, `GET /dictionary/v2/suggest`; no AI)
    const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
    const [suggestOpen, setSuggestOpen] = useState(false);
    const [activeSuggestion, setActiveSuggestion] = useState(-1);
    // the value the field was given by a pick / navigation: it opens no suggestion list
    const suppressSuggest = useRef<string | null>(null);
    const composing = useRef(false);
    // the pending suggestion request: a search cancels it (a late list must never cover the answer)
    const suggestAbort = useRef<AbortController | null>(null);

    // A newer search always wins: answers of older ones are dropped (fast typing, back, related words)
    const requestIdRef = useRef(0);
    const dialogRef = useRef<HTMLDivElement | null>(null);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const exploreRef = useRef<HTMLDivElement | null>(null);
    const returnFocusRef = useRef<HTMLElement | null>(null);
    const titleId = useId();
    const listId = useId();

    const { data: session } = useSession();

    const open = useCallback(() => {
        returnFocusRef.current = (typeof document !== 'undefined' ? document.activeElement : null) as HTMLElement | null;
        setIsOpen(true);
    }, []);

    useEffect(() => {
        setMounted(true);
        const handleKeyDown = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
                e.preventDefault();
                open();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [open]);

    // Another module may ask to look a word up ("Tra trong Từ điển" in Vũ trụ tri thức): an explicit click, same lookup path.
    const searchRef = useRef<(word: string) => void>(() => {});
    useEffect(() => {
        const onLookup = (e: Event) => {
            const word = (e as CustomEvent<{ word?: string }>).detail?.word;
            open();
            if (typeof word === 'string' && word.trim()) { setQuery(word); searchRef.current(word); }
        };
        window.addEventListener('ec:dictionary:lookup', onLookup);
        return () => window.removeEventListener('ec:dictionary:lookup', onLookup);
    }, [open]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the latest search function, refreshed after every render
    useEffect(() => { searchRef.current = (w: string) => { void executeSearch(w); }; });

    // Stop audio when closing or changing result
    const stopAudio = () => {
        if (audioRef.current) {
            audioRef.current.pause();
            audioRef.current.currentTime = 0;
            audioRef.current = null;
        }
        if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
            window.speechSynthesis.cancel();
        }
        setPlayingRegion(null);
    };

    useEffect(() => {
        return () => stopAudio();
    }, [result]);

    const close = useCallback(() => {
        stopAudio();
        setIsOpen(false);
        setSuggestOpen(false);
        const back = returnFocusRef.current;
        if (back && typeof back.focus === 'function') setTimeout(() => back.focus(), 0);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const presence = useMorphPresence(isOpen && mounted, dialogRef, { trigger: returnFocusRef, onDismiss: close });
    useNavigationOverlay(navigationOwned && presence.present);
    React.useLayoutEffect(() => {
        if (isOpen && mounted) inputRef.current?.focus({ preventScroll: true });
    }, [isOpen, mounted]);

    // Handle primary search
    const executeSearch = async (searchTerm: string, mode: 'en-en' | 'en-vi' = dictMode) => {
        const clean = normalizeQuery(searchTerm);
        if (!clean) return;
        const id = ++requestIdRef.current;

        setLoading(true);
        setError('');
        setErrorRetry(null);
        setSaved(false);
        setSaveError('');
        setSenseSave(null);
        suggestAbort.current?.abort();
        setSuggestOpen(false);
        stopAudio();

        try {
            const data = await lookupCanonical(clean, mode);
            if (id !== requestIdRef.current) return;
            if (!data || !hasValidLexicalContent(data)) {
                setError(`Không tìm thấy từ hoặc cụm từ "${clean}" trong từ điển.`);
                setResult(null);
            } else {
                setExpandedPosMap({});
                setExpandedExamplesMap({});
                if (data.headword !== result?.headword) {
                    setCollocationsData(null);
                    setPhrasesData(null);
                }
                setResult(data);
                // Phrases the entry already carries show at once; collocations always come from their own endpoint
                // (stored payloads may hold an older, unfiltered list)
                if (data.phrasalVerbs?.length || data.idioms?.length || data.expressions?.length) {
                    setPhrasesData({
                        word: data.headword,
                        phrasalVerbs: data.phrasalVerbs || [],
                        idioms: data.idioms || [],
                        expressions: data.expressions || []
                    });
                }
                exploreRef.current?.scrollTo({ top: 0 });
            }
        } catch (err: any) {
            if (id !== requestIdRef.current) return;
            setError(err?.message || "Lỗi khi tra từ điển");
            setErrorRetry(clean);
            setResult(null);
        } finally {
            if (id === requestIdRef.current) setLoading(false);
        }
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (suggestOpen && activeSuggestion >= 0 && suggestions[activeSuggestion]) {
            pickSuggestion(suggestions[activeSuggestion].word);
            return;
        }
        suppressSuggest.current = query.trim();
        executeSearch(query);
    };

    // Switch between EN-EN and EN-VI: the entry carries both layers (one payload per word), so nothing is fetched again
    const handleModeSwitch = (newMode: 'en-en' | 'en-vi') => {
        setDictMode(newMode);
    };

    // Usage combinations availability
    const hasCollocations = (collocationsData?.groups?.some(g => g.items && g.items.length > 0)) || false;
    const hasPhrasalVerbs = (phrasesData?.phrasalVerbs && phrasesData.phrasalVerbs.length > 0) || false;
    const hasIdioms = (phrasesData?.idioms && phrasesData.idioms.length > 0) || false;
    const hasExpressions = (phrasesData?.expressions && phrasesData.expressions.length > 0) || false;
    const hasUsageContent = hasCollocations || hasPhrasalVerbs || hasIdioms || hasExpressions;

    const isSingleWord = !!(result?.headword && !result.headword.trim().includes(' '));
    // Show the second tab only when real usage combinations exist (or during background fetch for words)
    const canShowUsageTab = !!(result && (
        hasUsageContent || (isSingleWord && loadingUsage)
    ));

    // Progressively load usage combinations for single-word entries (multi-word entries send no related-data request).
    // An answer for a word the learner has already left is dropped.
    useEffect(() => {
        if (!result?.headword) {
            setCollocationsData(null);
            setPhrasesData(null);
            return;
        }
        if (!isSingleWord) {
            setLoadingUsage(false);
            return;
        }
        const headword = result.headword;
        let alive = true;
        setLoadingUsage(true);
        Promise.all([
            fetchCollocations(headword).then(res => {
                if (!alive || !res) return;
                setCollocationsData(res.groups?.some(g => g.items?.length) ? res : null);
            }).catch(() => null),
            fetchPhrases(headword).then(res => {
                if (!alive || !res) return;
                setPhrasesData(prev => {
                    if (!prev || prev.word !== res.word) return res;
                    const merge = <T extends { phrase: string }>(a: T[] = [], b: T[] = []) => {
                        const out = [...a];
                        for (const item of b) {
                            if (!out.some(p => p.phrase.toLowerCase() === item.phrase.toLowerCase())) out.push(item);
                        }
                        return out;
                    };
                    return {
                        word: res.word || prev.word,
                        phrasalVerbs: merge(prev.phrasalVerbs, res.phrasalVerbs),
                        idioms: merge(prev.idioms, res.idioms),
                        expressions: merge(prev.expressions, res.expressions)
                    };
                });
            }).catch(() => null)
        ]).finally(() => { if (alive) setLoadingUsage(false); });
        return () => { alive = false; };
    }, [result?.headword, isSingleWord]);

    // If the second tab becomes unavailable, fall back to the first
    useEffect(() => {
        if (!canShowUsageTab && mainTab === 'usage') {
            setMainTab('dictionary');
        }
    }, [canShowUsageTab, mainTab]);

    // another tab or group starts at the top of the reading page
    useEffect(() => { exploreRef.current?.scrollTo({ top: 0 }); }, [mainTab, usageSubTab]);

    // a new word starts again from the first group (declared first: it runs before the choice below)
    useEffect(() => { pickedSubTab.current = false; }, [result?.headword]);

    // Auto-select the first available child category with real data
    useEffect(() => {
        if (!hasUsageContent) return;
        const has: Record<UsageTab, boolean> = {
            collocations: hasCollocations,
            phrasal_verbs: hasPhrasalVerbs,
            idioms: hasIdioms,
            expressions: hasExpressions,
        };
        const first = (['collocations', 'phrasal_verbs', 'idioms', 'expressions'] as UsageTab[]).find(t => has[t]);
        if (!first) return;
        if (!pickedSubTab.current) {
            if (usageSubTab !== first) setUsageSubTab(first);
        } else if (!has[usageSubTab]) {
            setUsageSubTab(first);
        }
    }, [hasCollocations, hasPhrasalVerbs, hasIdioms, hasExpressions, usageSubTab, hasUsageContent]);


    // Compact preview of related phrases at the end of the first tab
    const previewItems = useMemo(() => {
        if (!hasUsageContent) return [];
        const items: string[] = [];
        if (phrasesData?.phrasalVerbs?.length) {
            for (const pv of phrasesData.phrasalVerbs.slice(0, 2)) {
                if (!items.includes(pv.phrase)) items.push(pv.phrase);
            }
        }
        if (collocationsData?.groups?.length) {
            for (const g of collocationsData.groups) {
                for (const item of g.items || []) {
                    if (items.length < 4 && !items.includes(item.phrase) && item.hasExactEntry) {
                        items.push(item.phrase);
                    }
                }
            }
        }
        const allIdioms = [...(phrasesData?.idioms || []), ...(phrasesData?.expressions || [])];
        if (allIdioms.length && items.length < 5) {
            for (const idm of allIdioms.slice(0, 1)) {
                if (!items.includes(idm.phrase)) items.push(idm.phrase);
            }
        }
        return items.slice(0, 5);
    }, [hasUsageContent, phrasesData, collocationsData]);

    // Audio player
    const playPronunciation = (audioUrl?: string, ipa?: string, region: string = 'General') => {
        window.dispatchEvent(new Event('ec:music-pause'));
        stopAudio();
        setPlayingRegion(region);

        if (audioUrl) {
            try {
                const audio = new Audio(audioUrl);
                audioRef.current = audio;
                audio.onended = () => setPlayingRegion(null);
                audio.onerror = () => fallbackTts(result?.headword || query, region);
                audio.play().catch(() => fallbackTts(result?.headword || query, region));
                return;
            } catch {
                fallbackTts(result?.headword || query, region);
                return;
            }
        }

        fallbackTts(result?.headword || query, region);
    };

    const fallbackTts = (text: string, region: string) => {
        if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
            window.speechSynthesis.cancel();
            const utterance = new SpeechSynthesisUtterance(text);
            utteranceRef.current = utterance;
            utterance.lang = region === 'UK' ? 'en-GB' : 'en-US';

            const voices = window.speechSynthesis.getVoices();
            const voice = voices.find(v =>
                region === 'UK' ? (v.lang.includes('GB') || v.name.includes('UK')) : (v.lang.includes('US') || v.name.includes('United States'))
            );
            if (voice) utterance.voice = voice;

            utterance.onend = () => setPlayingRegion(null);
            utterance.onerror = () => setPlayingRegion(null);
            window.speechSynthesis.speak(utterance);
        } else {
            setPlayingRegion(null);
        }
    };

    // Save to Flashcards
    const handleSaveFlashcard = async () => {
        if (!result || !session) return;
        setSaving(true);
        setSaveError('');
        try {
            const front = result.headword;
            let back = result.generalTranslationVi || "";
            let example = "";

            if (result.partsOfSpeech?.length && result.partsOfSpeech[0].senses?.length) {
                const firstSense = result.partsOfSpeech[0].senses[0];
                // one rule for every save button: the general meaning leads (a sense text never shadows it)
                const meaningVi = flashcardMeaningVi(result);
                if (dictMode === 'en-vi' && meaningVi) {
                    back = meaningVi;
                } else if (firstSense.definitionEn) {
                    back = firstSense.definitionEn;
                } else if (meaningVi) {
                    back = meaningVi;
                }
                if (firstSense.examples?.length) {
                    example = firstSense.examples[0];
                }
            }

            await apiClient.post("/flashcards", { front, back: back || "No definition", example });
            setSaved(true);
        } catch (err: any) {
            console.error("Save to flashcards failed:", err);
            const reason = typeof err?.response?.data?.message === 'string' && err.response.status < 500 ? err.response.data.message : '';
            setSaveError(reason ? `Chưa lưu được: ${reason}` : 'Chưa lưu được Flashcard. Hãy thử lại.');
        } finally {
            setSaving(false);
        }
    };

    // Save a specific sense to Flashcards
    const handleSaveSpecificSense = async (sense: Sense, pos: string, key: string) => {
        if (!result || !session) return;
        setSenseSave({ key, state: 'saving' });
        try {
            const front = result.headword;
            const back = (dictMode === 'en-vi' && sense.translationVi)
                ? `(${pos}) ${sense.translationVi}`
                : `(${pos}) ${sense.definitionEn || sense.translationVi || 'No definition'}`;
            const example = sense.examples?.length ? sense.examples[0] : '';

            await apiClient.post("/flashcards", { front, back, example });
            setSenseSave({ key, state: 'saved' });
            setTimeout(() => setSenseSave(prev => (prev?.key === key && prev.state === 'saved' ? null : prev)), 3000);
        } catch (err) {
            console.error("Save specific sense failed:", err);
            setSenseSave({ key, state: 'error' });
        }
    };

    // Clickable lexical navigation with history tracking
    const navigateTo = (term: string) => {
        const clean = normalizeQuery(term);
        if (!clean) return;
        if (result?.headword && result.headword.toLowerCase() !== clean.toLowerCase()) {
            setHistory(prev => [...prev, result.headword]);
        }
        suppressSuggest.current = term.trim();
        setQuery(term);
        executeSearch(term);
        setMainTab('dictionary');
    };

    const handleBack = () => {
        if (history.length === 0) return;
        const prevHistory = [...history];
        const prevTerm = prevHistory.pop()!;
        setHistory(prevHistory);
        suppressSuggest.current = prevTerm.trim();
        setQuery(prevTerm);
        executeSearch(prevTerm);
        setMainTab('dictionary');
    };

    const togglePosExpansion = (posIdx: number) => {
        setExpandedPosMap(prev => ({ ...prev, [posIdx]: !prev[posIdx] }));
    };

    const toggleExampleExpansion = (key: string) => {
        setExpandedExamplesMap(prev => ({ ...prev, [key]: !prev[key] }));
    };

    // Suggestions while typing: debounced, bounded, cancelled when outdated; never while an IME composes
    const trimmed = query.trim();
    useEffect(() => {
        if (!isOpen) return;
        if (suppressSuggest.current !== null && suppressSuggest.current === trimmed) {
            suppressSuggest.current = null;
            setSuggestOpen(false);
            return;
        }
        suppressSuggest.current = null;
        if (composing.current || trimmed.length < SUGGEST_MIN || trimmed.length > 40) {
            setSuggestions([]);
            setSuggestOpen(false);
            return;
        }
        const controller = new AbortController();
        suggestAbort.current = controller;
        const timer = setTimeout(() => {
            if (controller.signal.aborted) return;
            apiClient.get<Suggestion[]>('/dictionary/v2/suggest', { params: { q: trimmed, limit: 6 }, signal: controller.signal })
                .then(res => {
                    if (controller.signal.aborted) return;
                    const rows = Array.isArray(res.data) ? res.data.slice(0, 6) : [];
                    setSuggestions(rows);
                    setActiveSuggestion(-1);
                    setSuggestOpen(rows.length > 0 && !(rows.length === 1 && rows[0].word.toLowerCase() === trimmed.toLowerCase() && result?.headword?.toLowerCase() === trimmed.toLowerCase()));
                })
                .catch(() => { if (!controller.signal.aborted) setSuggestions([]); });
        }, SUGGEST_DEBOUNCE_MS);
        return () => { clearTimeout(timer); controller.abort(); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [trimmed, isOpen]);

    const pickSuggestion = (word: string) => {
        suppressSuggest.current = word.trim();
        setQuery(word);
        setSuggestOpen(false);
        if (result?.headword && result.headword.toLowerCase() !== word.toLowerCase()) {
            setHistory(prev => [...prev, result.headword]);
        }
        executeSearch(word);
        setMainTab('dictionary');
    };

    const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (!suggestOpen || suggestions.length === 0) return;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActiveSuggestion(i => (i + 1) % suggestions.length);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActiveSuggestion(i => (i <= 0 ? suggestions.length - 1 : i - 1));
        }
    };

    // Dialog keyboard: Escape closes the suggestion list first, then the dialog; Tab stays inside the dialog
    const onDialogKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Escape') {
            e.stopPropagation();
            if (suggestOpen) {
                setSuggestOpen(false);
                return;
            }
            close();
            return;
        }
        if (e.key !== 'Tab' || !dialogRef.current) return;
        const focusables = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
        )).filter(el => el.offsetParent !== null || el === document.activeElement);
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
        }
    };

    const jumpToPos = (posIdx: number) => {
        setMainTab('dictionary');
        requestAnimationFrame(() => {
            document.getElementById(`lex-pos-${posIdx}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
        });
    };

    // ── derived presentation (every value is the entry's own) ──
    const englishSenses = !!result?.partsOfSpeech?.some(g => g.senses?.some(s => !!s.definitionEn));
    const posOccurrence = useMemo(() => {
        const seen: Record<string, number> = {};
        return (result?.partsOfSpeech || []).map(g => {
            const k = g.partOfSpeech.toLowerCase();
            seen[k] = (seen[k] || 0) + 1;
            return seen[k];
        });
    }, [result]);
    const posNames = useMemo(() => {
        const names: string[] = [];
        for (const g of result?.partsOfSpeech || []) {
            const vi = posLabelVi(g.partOfSpeech);
            if (!names.includes(vi)) names.push(vi);
        }
        return names;
    }, [result]);
    // Overview: the first sense of each part of speech, in the dictionary's own order (never a guessed ranking)
    const overview = useMemo(() => {
        if (!result) return [];
        if (dictMode === 'en-vi' && result.vietnameseSenses?.length) {
            return result.vietnameseSenses.slice(0, 4).map(g => ({
                pos: posLabelVi(g.partOfSpeech),
                text: sanitizeLexicalText(g.meanings[0]),
                sub: g.meanings.slice(1, 3).map(m => sanitizeLexicalText(m)).join(' · '),
                posIdx: result.partsOfSpeech.findIndex(p => p.partOfSpeech.toLowerCase() === g.partOfSpeech.toLowerCase()),
            })).filter(o => o.text);
        }
        return result.partsOfSpeech.slice(0, 4).map((g, posIdx) => {
            // the first meaning as the chapter shows it (a parent's own words, not its sub-senses run together)
            const first = nestSenses(g.senses || []).find(n => n.gloss || n.sense.translationVi);
            return {
                pos: posLabelVi(g.partOfSpeech),
                text: sanitizeLexicalText(first?.gloss || first?.sense.translationVi),
                sub: '',
                posIdx,
            };
        }).filter(o => o.text);
    }, [result, dictMode]);
    const generalVi = result?.generalTranslationVi ? sanitizeLexicalText(result.generalTranslationVi) : '';
    const showGeneralVi = !!generalVi && (dictMode === 'en-vi' || !englishSenses);
    const usageCounts: Record<UsageTab, number> = {
        collocations: (collocationsData?.groups || []).reduce((n, g) => n + (g.items?.length || 0), 0),
        phrasal_verbs: phrasesData?.phrasalVerbs?.length || 0,
        idioms: phrasesData?.idioms?.length || 0,
        expressions: phrasesData?.expressions?.length || 0,
    };
    const usageTabs: { id: UsageTab; label: string }[] = [
        { id: 'collocations', label: 'Collocations' },
        { id: 'phrasal_verbs', label: 'Phrasal Verbs' },
        { id: 'idioms', label: 'Idioms' },
        { id: 'expressions', label: 'Expressions' },
    ];
    const view = result ? 'result' : loading ? 'loading' : error ? 'error' : 'empty';

    const identity = result && (
        <aside className={styles.identity} aria-label="Mục từ">
            <p className={styles.kind}>{entryTypeLabel(result.entryType)}</p>
            <h1 className={styles.headword} lang="en">{result.headword}</h1>

            <div className={styles.pronRow}>
                {result.pronunciations?.map((p, idx) => {
                    const region = p.region || 'General';
                    const playing = playingRegion === region;
                    const regionName = region === 'UK' ? 'Anh – Anh' : region === 'US' ? 'Anh – Mỹ' : '';
                    return (
                        <div key={idx} className={styles.pron}>
                            {regionName && <span className={styles.pronRegion}>{region}</span>}
                            {p.ipa && <span className={styles.ipa}>{p.ipa}</span>}
                            <button
                                type="button"
                                onClick={() => playPronunciation(p.audioUrl, p.ipa, region)}
                                className={styles.speak}
                                data-playing={playing || undefined}
                                aria-label={playing ? 'Dừng phát âm' : `Phát âm ${regionName}`.trim()}
                                title={`Phát âm ${regionName}`.trim()}
                            >
                                {playing ? <Square className={styles.stopIcon} /> : <Volume2 />}
                            </button>
                        </div>
                    );
                })}
                {(!result.pronunciations || result.pronunciations.length === 0) && (
                    <button type="button" onClick={() => playPronunciation(undefined, undefined, 'General')} className={styles.speakWide} aria-label="Phát âm">
                        {playingRegion === 'General' ? <Square className={styles.stopIcon} /> : <Volume2 />}
                        <span>Phát âm</span>
                    </button>
                )}
                {result.cefr && <span className={styles.cefr} title="Cấp độ CEFR theo nguồn từ điển">{result.cefr}</span>}
            </div>

            {result.searchedForm && result.searchedForm.toLowerCase() !== result.headword.toLowerCase() && (
                <p className={styles.inflection}>
                    <Info aria-hidden="true" />
                    <span>Đang tra dạng <strong>“{result.searchedForm}”</strong> ({result.inflectionNote || 'Dạng biến thể của ' + result.headword})</span>
                </p>
            )}

            {session && (
                <div className={styles.saveWrap}>
                    <button
                        type="button"
                        onClick={handleSaveFlashcard}
                        disabled={saving || saved}
                        className={styles.save}
                        data-state={saved ? 'saved' : saving ? 'saving' : 'idle'}
                    >
                        {saving ? <Loader2 className={styles.spin} /> : saved ? <BookmarkCheck /> : <BookmarkPlus />}
                        <span>{saved ? 'Đã lưu Flashcard' : saving ? 'Đang lưu…' : 'Lưu Flashcard'}</span>
                    </button>
                    {saveError && <p className={styles.saveError} role="alert">{saveError}</p>}
                    {/* Vũ trụ tri thức: the word's own star (a link; it opens nothing else and calls no AI) */}
                    <a className={styles.save} href={`/knowledge-universe?word=${encodeURIComponent(result.headword.trim().toLowerCase())}`}
                        onClick={() => close()} data-state="idle">
                        <span>Xem trong vũ trụ</span>
                    </a>
                </div>
            )}

            {showGeneralVi && (
                <div className={styles.general}>
                    <span className={styles.generalLabel}>Nghĩa chung</span>
                    <span className={styles.generalText}>{generalVi}</span>
                </div>
            )}

            {posNames.length > 0 && (
                <div className={styles.facts}>
                    <span className={styles.factLabel}>Loại từ</span>
                    <span className={styles.factValue}>{posNames.join(' · ')}</span>
                </div>
            )}

            {overview.length > 0 && (
                <nav className={styles.overview} aria-label="Tóm tắt nghĩa">
                    <p className={styles.overviewTitle}>{dictMode === 'en-vi' && result.vietnameseSenses?.length ? 'Nghĩa tiếng Việt chính' : 'Nghĩa đầu tiên mỗi loại từ'}</p>
                    <ol>
                        {overview.map((o, i) => (
                            <li key={i}>
                                <button
                                    type="button"
                                    onClick={() => (o.posIdx >= 0 ? jumpToPos(o.posIdx) : undefined)}
                                    className={styles.overviewItem}
                                    disabled={o.posIdx < 0}
                                >
                                    <span className={styles.overviewNo} aria-hidden="true">{i + 1}</span>
                                    <span className={styles.overviewText}>
                                        <span className={styles.overviewPos}>{o.pos}</span>
                                        <span className={styles.overviewMain}>{o.text}</span>
                                        {o.sub && <span className={styles.overviewSub}>{o.sub}</span>}
                                    </span>
                                </button>
                            </li>
                        ))}
                    </ol>
                </nav>
            )}
        </aside>
    );

    const dictionaryTab = result && (
        <>
            {dictMode === 'en-vi' && (result.vietnameseSenses?.length ?? 0) > 0 && englishSenses && (
                <VietnameseChapter groups={result.vietnameseSenses!} source={result.vietnameseSource} />
            )}
            {result.partsOfSpeech?.map((group, posIdx) => (
                <SenseChapter
                    key={`${result.headword}-${posIdx}`}
                    group={group}
                    posIdx={posIdx}
                    occurrence={posOccurrence[posIdx] || 1}
                    headword={result.headword}
                    mode={dictMode}
                    expanded={!!expandedPosMap[posIdx]}
                    onToggle={() => togglePosExpansion(posIdx)}
                    expandedExamples={expandedExamplesMap}
                    onToggleExamples={toggleExampleExpansion}
                    canSave={!!session}
                    onSaveSense={handleSaveSpecificSense}
                    senseSave={senseSave}
                    onNavigate={navigateTo}
                />
            ))}
            {((result.synonyms?.length ?? 0) > 0 || (result.antonyms?.length ?? 0) > 0) && (
                <RelationsCard synonyms={result.synonyms || []} antonyms={result.antonyms || []} onNavigate={navigateTo} />
            )}
            {isSingleWord && previewItems.length > 0 && (
                <section className={`${styles.chapter} ${styles.previewCard}`} aria-labelledby="lex-preview-h">
                    <header className={styles.chapterHead}>
                        <h3 id="lex-preview-h" className={styles.chapterTitle}>Cụm từ thường gặp</h3>
                        <button type="button" onClick={() => setMainTab('usage')} className={styles.textButton}>
                            Xem tất cả <ArrowRight aria-hidden="true" />
                        </button>
                    </header>
                    <WordChips words={previewItems} tone="plain" label="" onNavigate={navigateTo} initial={5} />
                </section>
            )}
            {result.source && <p className={styles.sourceNote}>Nguồn định nghĩa: {result.source}</p>}
        </>
    );

    // Modal portal
    const modal = presence.present && mounted ? createPortal(
        <div
            className={styles.scrim}
            onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
        >
            <div
                {...presence.panelProps}
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                className={styles.lexicon}
                data-view={view}
                data-mode={dictMode}
                onKeyDown={onDialogKeyDown}
            >
                {/* the world: sunlit morning sea in light mode, starry sapphire ocean in dark mode (decoration only) */}
                <div className={styles.stage} aria-hidden="true">
                    <img
                        className={styles.stageDay}
                        data-testid="dictionary-stage-day"
                        src={ART_DAY_1200}
                        srcSet={`${ART_DAY_1200} 1200w, ${ART_DAY_2400} 2400w`}
                        sizes="(max-width: 900px) 100vw, 1240px"
                        alt=""
                        decoding="async"
                        draggable={false}
                    />
                    <img
                        className={styles.stageNight}
                        data-testid="dictionary-stage-night"
                        src={ART_NIGHT_1200}
                        srcSet={`${ART_NIGHT_1200} 1200w, ${ART_NIGHT_2400} 2400w`}
                        sizes="(max-width: 900px) 100vw, 1240px"
                        alt=""
                        decoding="async"
                        draggable={false}
                    />
                    <span className={styles.motes}><i /><i /><i /><i /><i /><i /></span>
                </div>

                <div className={styles.top}>
                    <button type="button" className="ec-morph-handle" aria-label="Đóng từ điển" {...presence.handleProps} />
                    <div className={styles.bar}>
                        <div className={styles.brand}>
                            <span className={styles.brandLens} aria-hidden="true"><BookOpen /></span>
                            <h2 id={titleId} className={styles.title}>Từ điển</h2>
                            {history.length > 0 && (
                                <button
                                    type="button"
                                    onClick={handleBack}
                                    className={styles.back}
                                    title={`Quay lại: ${history[history.length - 1]}`}
                                >
                                    <ArrowLeft aria-hidden="true" />
                                    <span>Quay lại: <strong>{history[history.length - 1]}</strong></span>
                                </button>
                            )}
                        </div>
                        <button onClick={close} aria-label="Đóng từ điển" className={styles.close} type="button">
                            <X />
                        </button>
                    </div>

                    <form onSubmit={handleSubmit} className={styles.search} role="search" data-loading={loading || undefined}>
                        <Search className={styles.searchLens} aria-hidden="true" />
                        <input
                            ref={inputRef}
                            type="text"
                            role="combobox"
                            data-guide="dictionary-input"
                            aria-expanded={suggestOpen}
                            aria-controls={listId}
                            aria-autocomplete="list"
                            aria-activedescendant={suggestOpen && activeSuggestion >= 0 ? `${listId}-${activeSuggestion}` : undefined}
                            aria-label="Tra từ, phrasal verb hoặc thành ngữ"
                            placeholder="Tra từ, phrasal verb hoặc thành ngữ… (vd. fall, take off, under the weather)"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            onKeyDown={onInputKeyDown}
                            onCompositionStart={() => { composing.current = true; }}
                            onCompositionEnd={(e) => { composing.current = false; setQuery((e.target as HTMLInputElement).value); }}
                            onBlur={() => setTimeout(() => setSuggestOpen(false), 120)}
                            className={styles.input}
                            autoComplete="off"
                            spellCheck={false}
                            lang="en"
                            autoFocus
                        />
                        {query && (
                            <button
                                type="button"
                                onClick={() => { setQuery(''); setSuggestOpen(false); inputRef.current?.focus(); }}
                                className={styles.clear}
                                aria-label="Xoá ô tìm kiếm"
                            >
                                <X />
                            </button>
                        )}
                        <button
                            type="submit"
                            // never disabled while a word loads: a disabled default button blocks Enter, and a newer
                            // search simply wins (request id)
                            disabled={!query.trim()}
                            className={styles.submit}
                            title="Tìm kiếm"
                            aria-label="Tìm kiếm"
                        >
                            {loading ? <Loader2 className={styles.spin} /> : <Search />}
                        </button>
                        <span className={styles.progress} aria-hidden="true" />
                        {suggestOpen && suggestions.length > 0 && (
                            <ul id={listId} role="listbox" aria-label="Gợi ý từ" className={styles.suggest}>
                                {suggestions.map((s, i) => (
                                    <li
                                        key={s.word}
                                        id={`${listId}-${i}`}
                                        role="option"
                                        aria-selected={i === activeSuggestion}
                                        className={styles.suggestItem}
                                        onMouseDown={(e) => { e.preventDefault(); pickSuggestion(s.word); }}
                                        onMouseEnter={() => setActiveSuggestion(i)}
                                    >
                                        <span className={styles.suggestWord} lang="en">{s.word}</span>
                                        {s.meaning && <span className={styles.suggestMeaning}>{sanitizeLexicalText(s.meaning)}</span>}
                                        {i === activeSuggestion && <CornerDownLeft className={styles.suggestEnter} aria-hidden="true" />}
                                    </li>
                                ))}
                            </ul>
                        )}
                    </form>

                    <div className={styles.rail}>
                        <div className={styles.tabs} role="tablist" aria-label="Chế độ xem" data-guide="dictionary-tabs">
                            <button
                                type="button"
                                role="tab"
                                aria-selected={mainTab === 'dictionary'}
                                onClick={() => setMainTab('dictionary')}
                                className={styles.tab}
                            >
                                <BookOpen aria-hidden="true" />
                                <span>Tra nghĩa</span>
                            </button>
                            {canShowUsageTab && (
                                <button
                                    type="button"
                                    role="tab"
                                    aria-selected={mainTab === 'usage'}
                                    onClick={() => setMainTab('usage')}
                                    className={styles.tab}
                                >
                                    <Layers aria-hidden="true" />
                                    <span>Cụm từ liên quan</span>
                                    {loadingUsage && !hasUsageContent && <Loader2 className={`${styles.spin} ${styles.tabSpin}`} aria-hidden="true" />}
                                </button>
                            )}
                        </div>

                        {mainTab === 'dictionary' && (
                            <div className={styles.modes} role="group" aria-label="Ngôn ngữ định nghĩa">
                                <span className={styles.modesIcon} aria-hidden="true"><Languages /></span>
                                <button type="button" aria-pressed={dictMode === 'en-en'} onClick={() => handleModeSwitch('en-en')} className={styles.mode}>
                                    EN–EN
                                </button>
                                <button type="button" aria-pressed={dictMode === 'en-vi'} onClick={() => handleModeSwitch('en-vi')} className={styles.mode}>
                                    EN–VI
                                </button>
                            </div>
                        )}
                    </div>
                </div>

                <div className={styles.body} aria-busy={loading}>
                    {view === 'empty' && (
                        <div className={styles.welcome}>
                            <div className={styles.constellation}>
                                {FIRST_SEARCHES.map(({ kind, example, icon: Icon }, i) => (
                                    <button
                                        key={example}
                                        type="button"
                                        className={styles.star}
                                        data-slot={i}
                                        onClick={() => { suppressSuggest.current = example; setQuery(example); executeSearch(example); }}
                                    >
                                        <span className={styles.starIcon} aria-hidden="true"><Icon /></span>
                                        <span className={styles.starText}>
                                            <span className={styles.starKind}>{kind}</span>
                                            <span className={styles.starWord} lang="en">{example}</span>
                                        </span>
                                    </button>
                                ))}
                            </div>
                            <div className={styles.welcomeCopy}>
                                <p className={styles.welcomeTitle}>Hôm nay bạn muốn hiểu từ nào?</p>
                                <p className={styles.welcomeText}>
                                    Nhập một từ, cụm động từ hoặc thành ngữ tiếng Anh để xem nghĩa, phát âm, ví dụ và các cụm từ đi kèm.
                                </p>
                                <p className={styles.keys} aria-label="Phím tắt">
                                    <span><kbd>Ctrl</kbd><kbd>K</kbd> mở từ điển</span>
                                    <span><kbd>Enter</kbd> tra</span>
                                    <span><kbd>↑</kbd><kbd>↓</kbd> chọn gợi ý</span>
                                    <span><kbd>Esc</kbd> đóng</span>
                                </p>
                            </div>
                        </div>
                    )}

                    {view === 'loading' && <ResultSkeleton />}

                    {view === 'error' && (
                        <div className={styles.notice} role="alert">
                            <span className={styles.noticeIcon} aria-hidden="true"><Search /></span>
                            <p className={styles.noticeTitle}>{error}</p>
                            {errorRetry ? (
                                <button type="button" className={styles.retry} onClick={() => executeSearch(errorRetry)}>
                                    <RotateCcw aria-hidden="true" /> Thử lại
                                </button>
                            ) : (
                                <p className={styles.noticeText}>Hãy kiểm tra chính tả, hoặc thử dạng gốc của từ (ví dụ “run” thay cho “running”).</p>
                            )}
                        </div>
                    )}

                    {result && (
                        <div className={styles.result} data-stale={loading || undefined} key={result.headword}>
                            {identity}
                            <div className={styles.explore}>
                                <div className={styles.exploreNav}>
                                    {mainTab === 'dictionary' ? (
                                        <div className={styles.posNav} role="navigation" aria-label="Loại từ">
                                            {result.partsOfSpeech.map((g, posIdx) => (
                                                <button key={posIdx} type="button" className={styles.posJump} onClick={() => jumpToPos(posIdx)}>
                                                    {posLabelVi(g.partOfSpeech)}
                                                    {(posOccurrence[posIdx] || 1) > 1 && <sup>{posOccurrence[posIdx]}</sup>}
                                                    <span>{g.senses?.length || 0}</span>
                                                </button>
                                            ))}
                                        </div>
                                    ) : (
                                        <div className={styles.subTabs} role="tablist" aria-label="Nhóm cụm từ">
                                            {usageTabs.filter(t => usageCounts[t.id] > 0 || (t.id === 'collocations' && loadingUsage && isSingleWord)).map(t => (
                                                <button
                                                    key={t.id}
                                                    type="button"
                                                    role="tab"
                                                    aria-selected={usageSubTab === t.id}
                                                    onClick={() => { pickedSubTab.current = true; setUsageSubTab(t.id); }}
                                                    className={styles.subTab}
                                                >
                                                    {t.label}
                                                    {usageCounts[t.id] > 0 && <span>{usageCounts[t.id]}</span>}
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </div>
                                <div className={styles.exploreScroll} ref={exploreRef}>
                                    {mainTab === 'dictionary' ? dictionaryTab : (
                                        <UsagePanel
                                            tab={usageSubTab}
                                            headword={result.headword}
                                            loading={loadingUsage}
                                            collocations={collocationsData}
                                            phrasalVerbs={phrasesData?.phrasalVerbs || []}
                                            idioms={phrasesData?.idioms || []}
                                            expressions={phrasesData?.expressions || []}
                                            onNavigate={navigateTo}
                                        />
                                    )}
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>,
        portalHost ?? document.body
    ) : null;

    return (
        <div className="relative inline-block">
            {customTrigger ? (
                customTrigger(open)
            ) : (
                <button
                    onClick={open}
                    className="flex items-center gap-2 bg-black dark:bg-slate-800 text-white px-4 py-2 rounded-xl hover:bg-slate-800 dark:hover:bg-slate-700 font-medium transition-colors cursor-pointer"
                    title="Từ điển (Ctrl+K)"
                >
                    <Languages size={18} />
                    <span>Tra từ điển</span>
                </button>
            )}
            {modal}
        </div>
    );
};
