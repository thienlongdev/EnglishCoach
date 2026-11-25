import { apiClient } from '@/services/api-client';
import { authEpoch, authEnding } from '@/lib/auth-lifecycle';
import React, { useState, useEffect, useRef } from 'react';
import { Play, Pause, RotateCcw, X, Clipboard, Library, ChevronRight, BookOpen, Gauge, Rows3, Timer, TextCursorInput, Square, FastForward } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { ReadingMaterial } from './ReadingCard';
import styles from './glass/readingGlass.module.css';
import { echoSrc } from '@/lib/brand/echoCharacters';

interface SpeedReaderProps {
    materials?: ReadingMaterial[];
    initialText?: string;
    /** Told whether a practice session is on screen (the page then gives the stage the whole view). */
    onActiveChange?: (active: boolean) => void;
}

export const SpeedReader: React.FC<SpeedReaderProps> = ({ materials = [], initialText = '', onActiveChange }) => {
    const { locale } = useLanguage();
    const [text, setText] = useState(initialText);
    const [selectedMaterial, setSelectedMaterial] = useState<ReadingMaterial>();
    const [wpm, setWpm] = useState<number>(300);
    const [chunkSize, setChunkSize] = useState<number>(1);
    const [pauseAtPunctuation, setPauseAtPunctuation] = useState(true);
    const [skipStopwords, setSkipStopwords] = useState(false);

    // Engine & Runtime States
    const [isPlaying, setIsPlaying] = useState(false);
    const [isPaused, setIsPaused] = useState(false);
    const [isCompleted, setIsCompleted] = useState(false);
    const [chunks, setChunks] = useState<string[][]>([]);
    const [currentIndex, setCurrentIndex] = useState(0);
    const [startTime, setStartTime] = useState<number>(0);
    const [elapsedSeconds, setElapsedSeconds] = useState<number>(0);

    // Modal / Drawer state for choosing from library
    const [isLibraryOpen, setIsLibraryOpen] = useState(false);
    const [libraryError, setLibraryError] = useState('');
    const [libraryLoading, setLibraryLoading] = useState(false);
    const selectionSequence = useRef(0);
    useEffect(() => () => { selectionSequence.current++; }, []);

    useEffect(() => { onActiveChange?.(isPlaying); }, [isPlaying, onActiveChange]);
    useEffect(() => () => onActiveChange?.(false), [onActiveChange]);

    // Live word and char count
    const wordsCount = text.trim() ? text.trim().split(/\s+/).length : 0;
    const charsCount = text.length;
    const estimatedSeconds = wordsCount > 0 ? Math.ceil((wordsCount / (Number(wpm) || 300)) * 60) : 0;

    // Timer effect for RSVP display
    useEffect(() => {
        if (!isPlaying || isPaused || currentIndex >= chunks.length) {
            if (currentIndex >= chunks.length && isPlaying && chunks.length > 0) {
                setIsPlaying(false);
                setIsCompleted(true);
            }
            return;
        }

        const currentChunk = chunks[currentIndex];
        const lastWord = currentChunk[currentChunk.length - 1] || '';
        const hasPunctuation = /[.,!?;:]$/.test(lastWord);

        // Base delay calculation: (60,000 ms / WPM) * Words in Chunk
        let delay = (60000 / Number(wpm)) * Number(chunkSize);

        // Add 1.5x delay multiplier if ending in punctuation
        if (pauseAtPunctuation && hasPunctuation) {
            delay *= 1.5;
        }

        const timer = setTimeout(() => {
            setCurrentIndex(prev => prev + 1);
        }, delay);

        return () => clearTimeout(timer);
    }, [isPlaying, isPaused, currentIndex, chunks, wpm, chunkSize, pauseAtPunctuation]);

    // Track elapsed time during active reading
    useEffect(() => {
        let interval: NodeJS.Timeout | null = null;
        if (isPlaying && !isPaused) {
            interval = setInterval(() => {
                setElapsedSeconds(prev => prev + 1);
            }, 1000);
        }
        return () => {
            if (interval) clearInterval(interval);
        };
    }, [isPlaying, isPaused]);

    // Spacebar listener to toggle pause/resume, and Esc to stop
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (!isPlaying) return;
            if (e.code === 'Space') {
                e.preventDefault();
                setIsPaused(prev => !prev);
            } else if (e.code === 'Escape') {
                e.preventDefault();
                handleExit();
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isPlaying]);

    const handleStart = () => {
        if (!text.trim()) return;

        const activeWpm = Number(wpm) > 0 ? Number(wpm) : 300;
        const activeChunkSize = Number(chunkSize) > 0 ? Number(chunkSize) : 1;

        setWpm(activeWpm);
        setChunkSize(activeChunkSize);

        let rawWords = text.trim().split(/\s+/).filter(w => w.length > 0);

        if (skipStopwords) {
            const stops = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'am', 'in', 'on', 'at', 'to', 'for', 'of', 'with']);
            rawWords = rawWords.filter(w => !stops.has(w.toLowerCase().replace(/[^a-z]/g, '')));
        }

        const newChunks: string[][] = [];
        for (let i = 0; i < rawWords.length; i += activeChunkSize) {
            newChunks.push(rawWords.slice(i, i + activeChunkSize));
        }

        setChunks(newChunks);
        setCurrentIndex(0);
        setStartTime(Date.now());
        setElapsedSeconds(0);
        setIsCompleted(false);
        setIsPaused(false);
        setIsPlaying(true);
    };

    const handleExit = () => {
        setIsPlaying(false);
        setIsPaused(false);
        setIsCompleted(false);
        setCurrentIndex(0);
    };

    const handleRestart = () => {
        setCurrentIndex(0);
        setElapsedSeconds(0);
        setIsCompleted(false);
        setIsPaused(false);
        setIsPlaying(true);
    };

    const handlePasteClipboard = async () => {
        try {
            if (navigator.clipboard && navigator.clipboard.readText) {
                const clipText = await navigator.clipboard.readText();
                if (clipText.trim()) {
                    setText(clipText.trim()); setSelectedMaterial(undefined);
                }
            }
        } catch {
            // Clipboard access might be blocked in some browser permissions
        }
    };

    const handleSelectMaterial = async (mat: ReadingMaterial) => {
        const sequence = ++selectionSequence.current, epoch = authEpoch();
        setLibraryLoading(true); setLibraryError('');
        try {
            const detail = mat.contentText ? mat : (await apiClient.get<ReadingMaterial>(`/reading/materials/${mat.id}`, { timeout: 15000 })).data;
            if (sequence !== selectionSequence.current || epoch !== authEpoch() || authEnding()) return;
            if (!detail.contentText?.trim()) throw new Error('No reading text');
            setText(detail.contentText.trim()); setSelectedMaterial(detail); setIsLibraryOpen(false);
        } catch { if (sequence === selectionSequence.current && epoch === authEpoch()) setLibraryError(locale === 'vi' ? 'Không thể mở bài đọc.' : 'Unable to open reading.'); }
        finally { if (sequence === selectionSequence.current && epoch === authEpoch()) setLibraryLoading(false); }
    };

    // Focal point renderer for RSVP word display
    const renderFocalChunk = (chunk: string[] | undefined) => {
        if (!chunk || chunk.length === 0) return null;
        const wordString = chunk.join(' ');

        // If single word, highlight the optimal recognition point (ORP) near the center
        if (chunk.length === 1 && wordString.length > 1) {
            const orpIndex = Math.min(Math.floor(wordString.length * 0.35), wordString.length - 1);
            const before = wordString.slice(0, orpIndex);
            const focal = wordString[orpIndex];
            const after = wordString.slice(orpIndex + 1);

            return (
                <span className="inline-flex items-center tracking-wide">
                    <span>{before}</span>
                    <span className="text-rose-500 font-bold dark:text-rose-400 underline decoration-rose-400/40 underline-offset-8">
                        {focal}
                    </span>
                    <span>{after}</span>
                </span>
            );
        }

        return <span>{wordString}</span>;
    };

    const vi = locale === 'vi';
    const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    const unit = chunkSize > 1 ? (vi ? 'Cụm' : 'Chunk') : (vi ? 'Từ' : 'Word');

    // ==========================================
    // 1. ACTIVE TRAINING SCREEN (RSVP RUNNER)
    // ==========================================
    if (isPlaying) {
        const currentProgress = chunks.length > 0 ? ((currentIndex + 1) / chunks.length) * 100 : 0;
        const pct = Math.min(100, Math.round(currentProgress));
        const ringLen = 2 * Math.PI * 52;

        return (
            <div className={`${styles.session} animate-in fade-in duration-200`}>
                <svg width="0" height="0" aria-hidden="true" className="absolute">
                    <defs><linearGradient id="rg-ring" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#6366f1" /><stop offset="1" stopColor="#a855f7" /></linearGradient></defs>
                </svg>
                <section className={`${styles.panel} ${styles.stage}`} aria-label={vi ? 'Phiên luyện đọc nhanh' : 'Speed reading session'}>
                    {/* Runner Top Bar */}
                    <div className={styles.stageTop}>
                        <div className="flex flex-wrap items-center gap-2">
                            <span className={styles.pill} data-strong="">{wpm} WPM</span>
                            <span className={styles.pill}>{vi ? `Cụm ${chunkSize} từ` : `Chunk ${chunkSize}`}</span>
                            <span className={styles.pill}>{pauseAtPunctuation ? (vi ? 'Dừng dấu câu: Bật' : 'Punctuation pause: on') : (vi ? 'Dừng dấu câu: Tắt' : 'Punctuation pause: off')}</span>
                        </div>
                        <div className="flex items-center gap-3">
                            <span className="text-sm font-semibold tabular-nums" style={{ color: 'var(--ink-2)' }}>
                                {unit} <b style={{ color: 'var(--ink)' }}>{currentIndex + 1}</b> / {chunks.length}
                            </span>
                            <button type="button" onClick={handleExit} className={styles.softBtn}>
                                <X className="w-3.5 h-3.5" />
                                <span>{vi ? 'Thoát' : 'Exit'}</span>
                            </button>
                        </div>
                    </div>

                    {/* Main Focal Display: a calm field, guide marks above and below the recognition point */}
                    <div className={styles.focusField}>
                        <span className={styles.focusGuide} style={{ top: '22%' }} aria-hidden="true" />
                        <div className={`${styles.focusWord} font-reading min-h-[90px] flex items-center justify-center`} aria-live="off">
                            {renderFocalChunk(chunks[currentIndex])}
                        </div>
                        <span className={styles.focusGuide} style={{ bottom: '22%' }} aria-hidden="true" />
                        {isPaused && (
                            <div className={styles.focusPaused} role="status">
                                {vi ? 'Đang tạm dừng • Nhấn Space hoặc nút Tiếp tục' : 'Paused • Press Space or Resume'}
                            </div>
                        )}
                    </div>

                    {/* Progress Track (moves with the engine's own index) */}
                    <div className={styles.progressLine} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={vi ? 'Tiến trình bài đọc' : 'Reading progress'}>
                        <span style={{ width: `${Math.min(currentProgress, 100)}%` }} />
                    </div>

                    <div className={styles.stageFoot}>
                        <div className={styles.keys}>
                            <span className={styles.kbd}>Space</span>
                            <span>{vi ? 'Tạm dừng / Tiếp tục' : 'Pause / Resume'}</span>
                            <span aria-hidden="true">•</span>
                            <span className={styles.kbd}>Esc</span>
                            <span>{vi ? 'Thoát' : 'Exit'}</span>
                        </div>

                        <div className={styles.playRow}>
                            <button type="button" onClick={handleRestart} className={styles.softBtn}>
                                <RotateCcw className="w-3.5 h-3.5" />
                                <span>{vi ? 'Đọc lại' : 'Restart'}</span>
                            </button>
                            <button
                                type="button"
                                onClick={() => setIsPaused(prev => !prev)}
                                className={styles.playBtn}
                                aria-label={isPaused ? (vi ? 'Tiếp tục' : 'Resume') : (vi ? 'Tạm dừng' : 'Pause')}
                                title={isPaused ? (vi ? 'Tiếp tục' : 'Resume') : (vi ? 'Tạm dừng' : 'Pause')}
                            >
                                {isPaused ? <Play className="w-5 h-5 fill-current" /> : <Pause className="w-5 h-5" />}
                            </button>
                            <button type="button" onClick={handleExit} className={`${styles.softBtn} ${styles.dangerBtn}`}>
                                <Square className="w-3.5 h-3.5" />
                                <span>{vi ? 'Kết thúc' : 'End'}</span>
                            </button>
                        </div>
                    </div>
                </section>

                {/* Session facts: the engine's own counters only */}
                <aside className={styles.side} aria-label={vi ? 'Tiến trình phiên' : 'Session progress'}>
                    <div className={`${styles.panel} ${styles.sideCard}`}>
                        <h3 className={styles.sideTitle}><Gauge className="h-4 w-4" aria-hidden="true" style={{ color: 'var(--wink)' }} />{vi ? 'Tiến trình bài đọc' : 'Progress'}</h3>
                        <div className={styles.ring}>
                            <svg viewBox="0 0 120 120" aria-hidden="true">
                                <circle className={styles.ringTrack} cx="60" cy="60" r="52" />
                                <circle className={styles.ringFill} cx="60" cy="60" r="52" strokeDasharray={ringLen} strokeDashoffset={ringLen * (1 - pct / 100)} />
                            </svg>
                            <strong>{pct}%</strong>
                        </div>
                        <dl className={styles.facts}>
                            <div><dt>{vi ? (chunkSize > 1 ? 'Đã đọc (cụm)' : 'Đã đọc (từ)') : (chunkSize > 1 ? 'Read (chunks)' : 'Read (words)')}</dt><dd>{currentIndex + 1} / {chunks.length}</dd></div>
                            <div><dt>{vi ? 'Thời gian' : 'Time'}</dt><dd>{clock(elapsedSeconds)}</dd></div>
                            <div><dt>{vi ? 'Tốc độ đặt' : 'Set speed'}</dt><dd>{wpm} WPM</dd></div>
                        </dl>
                    </div>
                </aside>
            </div>
        );
    }

    // ==========================================
    // 2. COMPLETION STATE
    // ==========================================
    if (isCompleted) {
        return (
            <div className={`${styles.panel} ${styles.done} animate-in fade-in zoom-in-95 duration-200`}>
                <div className={styles.doneMark}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={echoSrc('scholar', 24)} alt="" aria-hidden="true" />
                </div>

                <h2 className="text-2xl font-bold" style={{ color: 'var(--ink)' }}>{vi ? 'Hoàn thành bài luyện đọc!' : 'Practice complete!'}</h2>
                <p className="text-sm mt-2" style={{ color: 'var(--ink-3)' }}>
                    {vi ? 'Bạn vừa hoàn thành luyện đọc theo kỹ thuật RSVP Reader với tốc độ đã chọn.' : 'You finished an RSVP reading run at the speed you chose.'}
                </p>

                {/* Measurable Metrics: the run's own values */}
                <dl className={styles.doneStats}>
                    <div className={styles.well}>
                        <dt>{vi ? 'Tổng số từ' : 'Words'}</dt>
                        <dd>{wordsCount}</dd>
                    </div>
                    <div className={styles.well}>
                        <dt>{vi ? 'Tốc độ cài đặt' : 'Set speed'}</dt>
                        <dd style={{ color: 'var(--wink)' }}>{wpm} WPM</dd>
                    </div>
                    <div className={styles.well}>
                        <dt>{vi ? 'Thời gian đọc' : 'Reading time'}</dt>
                        <dd>{elapsedSeconds} {vi ? 'giây' : 's'}</dd>
                    </div>
                </dl>

                {/* Action Buttons */}
                <div className={styles.doneActions}>
                    <button type="button" onClick={handleRestart} className={styles.primaryBtn}>
                        <RotateCcw className="w-4 h-4" />
                        <span>{vi ? 'Luyện lại bài này' : 'Practise again'}</span>
                    </button>
                    <button
                        type="button"
                        onClick={() => {
                            setWpm(prev => Math.min(prev + 25, 650));
                            handleRestart();
                        }}
                        className={styles.softBtn}
                    >
                        <FastForward className="w-4 h-4" />
                        <span>{vi ? 'Tăng tốc (+25 WPM)' : 'Faster (+25 WPM)'}</span>
                    </button>
                    <button type="button" onClick={handleExit} className={styles.softBtn}>
                        <span>{vi ? 'Thiết lập bài mới' : 'New setup'}</span>
                    </button>
                </div>
            </div>
        );
    }

    // ==========================================
    // 3. SPEED READING SETUP (the lab)
    // ==========================================
    const GAUGE_LEN = Math.PI * 80;
    const frac = Math.max(0, Math.min(1, (Number(wpm) - 150) / 500));
    return (
        <div className="flex flex-col gap-5">
            <svg width="0" height="0" aria-hidden="true" className="absolute">
                <defs><linearGradient id="rg-gauge" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#38bdf8" /><stop offset="0.55" stopColor="#6366f1" /><stop offset="1" stopColor="#a855f7" /></linearGradient></defs>
            </svg>
            <div className={styles.lab}>
                {/* Passage */}
                <section className={`${styles.panel} ${styles.labPanel}`} aria-labelledby="speed-passage-title">
                    <div className={styles.labHead}>
                        <div>
                            <h2 id="speed-passage-title" className={styles.labTitle}><span className={styles.labTitleIcon}><TextCursorInput /></span>{vi ? 'Thiết lập phòng luyện đọc' : 'Set up your practice'}</h2>
                            <p className={styles.labSub}>{vi ? 'Hỗ trợ mắt loại bỏ thói quen đọc thầm, gia tăng tốc độ nhận diện ngữ nghĩa.' : 'Helps your eyes drop subvocalising and recognise meaning faster.'}</p>
                        </div>
                        {/* Quick Action Chips */}
                        <div className="flex flex-wrap items-center gap-2">
                            <button type="button" onClick={handlePasteClipboard} className={styles.miniBtn}>
                                <Clipboard className="w-3.5 h-3.5" />
                                <span>{vi ? 'Dán từ clipboard' : 'Paste from clipboard'}</span>
                            </button>
                            {materials.length > 0 && (
                                <button type="button" onClick={() => setIsLibraryOpen(true)} className={styles.miniBtn}>
                                    <Library className="w-3.5 h-3.5" />
                                    <span>{vi ? `Chọn từ kho tài liệu (${materials.length})` : `Choose from the library (${materials.length})`}</span>
                                </button>
                            )}
                        </div>
                    </div>

                    <label htmlFor="reading-text" className="mb-2 block text-xs font-bold uppercase tracking-[0.12em]" style={{ color: 'var(--ink-3)' }}>{vi ? 'Văn bản luyện tập' : 'Practice text'}</label>
                    <div className={styles.editor}>
                        <textarea
                            id="reading-text"
                            rows={9}
                            value={text}
                            onChange={e => { setText(e.target.value); setSelectedMaterial(undefined); }}
                            placeholder={vi ? "Dán đoạn văn bản tiếng Anh bạn muốn luyện đọc tại đây..." : "Paste English text to start speed reading here..."}
                        />
                        <div className={styles.editorFoot}>
                            <span><b>{wordsCount}</b> {vi ? 'từ' : 'words'} • <b>{charsCount}</b> {vi ? 'ký tự' : 'characters'}</span>
                            <span className="inline-flex items-center gap-1.5"><Timer className="h-3.5 w-3.5" aria-hidden="true" />{vi ? `Thời gian ước tính: ~${estimatedSeconds} giây` : `Estimated: ~${estimatedSeconds} s`}</span>
                        </div>
                    </div>

                    {selectedMaterial?.isSystem && selectedMaterial.attribution && (
                        <aside className="mt-3 text-xs leading-relaxed" style={{ color: 'var(--ink-3)' }}>
                            <p className="m-0">{selectedMaterial.attribution}</p>
                            <p className="m-0">{selectedMaterial.licenseCode} · CEFR {vi ? 'ước tính' : 'estimate'}</p>
                            {selectedMaterial.sourceUrl?.startsWith('https://') && <a href={selectedMaterial.sourceUrl} target="_blank" rel="noopener noreferrer" className="underline">{vi ? 'Đọc tại nguồn' : 'Read original source'}</a>}
                        </aside>
                    )}
                </section>

                {/* Instruments: the engine's four settings and the start */}
                <section className={`${styles.panel} ${styles.labPanel} flex flex-col gap-3`} aria-labelledby="speed-controls-title">
                    <h2 id="speed-controls-title" className={styles.labTitle}><span className={styles.labTitleIcon}><Gauge /></span>{vi ? 'Bảng điều khiển' : 'Controls'}</h2>

                    <div className={`${styles.well} ${styles.control}`}>
                        <div className={styles.controlHead}>
                            <label htmlFor="speed-wpm" className={styles.controlLabel}>{vi ? 'Tốc độ đọc' : 'Reading speed'}</label>
                            <span className={styles.pill} data-strong="">{wpm} WPM</span>
                        </div>
                        <div className={styles.gauge} aria-hidden="true">
                            <svg viewBox="0 0 200 112">
                                <path className={styles.gaugeTrack} d="M20 100 A80 80 0 0 1 180 100" />
                                <path className={styles.gaugeFill} d="M20 100 A80 80 0 0 1 180 100" strokeDasharray={GAUGE_LEN} strokeDashoffset={GAUGE_LEN * (1 - frac)} />
                            </svg>
                            <div className={styles.gaugeValue}><strong>{wpm}</strong><span>WPM</span></div>
                        </div>
                        <input
                            id="speed-wpm"
                            type="range"
                            min="150"
                            max="650"
                            step="25"
                            value={wpm}
                            onChange={e => setWpm(Number(e.target.value))}
                            className={`${styles.range} mt-2`}
                        />
                        <div className={styles.scale}>
                            <span>150 ({vi ? 'Chậm' : 'Slow'})</span>
                            <span>300 ({vi ? 'Chuẩn' : 'Standard'})</span>
                            <span>650 ({vi ? 'Rất nhanh' : 'Very fast'})</span>
                        </div>
                    </div>

                    <div className={`${styles.well} ${styles.control}`}>
                        <span className={styles.controlLabel} id="speed-chunk-label"><Rows3 className="mr-1.5 inline h-4 w-4 align-[-3px]" aria-hidden="true" style={{ color: 'var(--wink)' }} />{vi ? 'Cụm từ (Chunk size)' : 'Chunk size'}</span>
                        <div className={styles.sizes} role="group" aria-labelledby="speed-chunk-label">
                            {[1, 2, 3].map(size => (
                                <button key={size} type="button" aria-pressed={chunkSize === size} onClick={() => setChunkSize(size)} className={styles.segBtn}>
                                    {size} {vi ? 'từ' : size === 1 ? 'word' : 'words'}
                                </button>
                            ))}
                        </div>
                        <p className={styles.controlHint}>
                            {chunkSize === 1 && (vi ? 'Hiển thị từng từ một tâm điểm mắt' : 'One word at a time at the focal point')}
                            {chunkSize === 2 && (vi ? 'Hiển thị cụm 2 từ giảm tần suất đảo mắt' : 'Pairs of words: fewer eye jumps')}
                            {chunkSize === 3 && (vi ? 'Hiển thị cụm 3 từ tối đa hóa trường nhìn' : 'Groups of three: the widest span')}
                        </p>
                    </div>

                    <div className={`${styles.well} ${styles.control}`}>
                        <div className={styles.controlHead}>
                            <span className={styles.controlLabel} id="speed-pause-label">{vi ? 'Tạm dừng ở dấu câu' : 'Pause at punctuation'}</span>
                            <button type="button" role="switch" aria-checked={pauseAtPunctuation} aria-labelledby="speed-pause-label" onClick={() => setPauseAtPunctuation(!pauseAtPunctuation)} className={styles.switch}><span /></button>
                        </div>
                        <p className={styles.controlHint}>{vi ? 'Chậm lại 1.5x khi gặp dấu chấm, phẩy giúp não nắm trọn ngữ nghĩa.' : 'Slows down 1.5× at full stops and commas so meaning lands.'}</p>
                    </div>

                    <div className={`${styles.well} ${styles.control}`}>
                        <div className={styles.controlHead}>
                            <span className={styles.controlLabel} id="speed-stop-label">{vi ? 'Lọc Stopwords' : 'Filter stopwords'}</span>
                            <button type="button" role="switch" aria-checked={skipStopwords} aria-labelledby="speed-stop-label" onClick={() => setSkipStopwords(!skipStopwords)} className={styles.switch}><span /></button>
                        </div>
                        <p className={styles.controlHint}>{vi ? 'Lược mạo từ (the, a, is...) để rèn kỹ năng Skimming từ khóa cốt lõi.' : 'Skips articles and small words (the, a, is…) to practise skimming for key words.'}</p>
                    </div>

                    {/* Primary Launch Action */}
                    <button type="button" onClick={handleStart} disabled={!text.trim()} className={`${styles.primaryBtn} ${styles.startBtn}`}>
                        <Play className="w-4 h-4 fill-current" />
                        <span>{vi ? 'BẮT ĐẦU LUYỆN ĐỌC' : 'START READING'}</span>
                    </button>
                    <p className="m-0 flex flex-wrap items-center justify-center gap-1.5 text-xs" style={{ color: 'var(--ink-3)' }}>
                        {vi ? 'Nhấn phím' : 'Press'} <span className={styles.kbd}>Space</span> {vi ? 'trong lúc đọc để Tạm dừng / Tiếp tục bất kỳ lúc nào.' : 'while reading to pause / resume at any time.'}
                    </p>
                </section>
            </div>

            {/* Quick Helpful Guide Cards */}
            <div className={styles.tips}>
                {[
                    [vi ? 'Cố định tiêu điểm mắt' : 'Hold your focal point', vi ? 'Giữ mắt tại vạch đỏ trung tâm, không đảo mắt sang trái phải để tối đa hóa tốc độ nạp thông tin.' : 'Keep your eyes on the red centre mark instead of moving them left and right.'],
                    [vi ? 'Triệt tiêu đọc thầm' : 'Drop subvocalising', vi ? 'Không phát âm từng từ trong đầu. Hãy để não bộ nhận diện chữ viết thành hình ảnh và ý niệm.' : 'Do not pronounce each word in your head; let the words land as shapes and ideas.'],
                    [vi ? 'Tăng dần ngưỡng WPM' : 'Raise the WPM gradually', vi ? 'Bắt đầu ở mức 250 - 300 WPM, tăng thêm 25 WPM mỗi tuần khi tỷ lệ đọc hiểu đạt trên 80%.' : 'Start around 250–300 WPM and add 25 WPM a week once you understand over 80%.'],
                ].map(([title, body], i) => (
                    <div key={title} className={`${styles.panel} ${styles.tip}`}>
                        <span className={styles.tipNum}>{i + 1}</span>
                        <div>
                            <h3>{title}</h3>
                            <p>{body}</p>
                        </div>
                    </div>
                ))}
            </div>

            {/* Library Picker Modal */}
            {isLibraryOpen && (
                <div className={`${styles.scrim} animate-in fade-in duration-150`} onClick={() => setIsLibraryOpen(false)}>
                    <div role="dialog" aria-modal="true" aria-label={vi ? 'Chọn từ kho tài liệu' : 'Choose from the library'} className={`${styles.panel} ${styles.dialog} ${styles.dialogWide}`} onClick={(e) => e.stopPropagation()}>
                        <div className={styles.dialogHead}>
                            <div className="flex items-center gap-2.5">
                                <Library className="w-4 h-4" style={{ color: 'var(--wink)' }} />
                                <h3 className={styles.dialogTitle}>{vi ? 'Chọn từ kho tài liệu' : 'Choose from the library'}</h3>
                            </div>
                            <button type="button" onClick={() => setIsLibraryOpen(false)} aria-label={vi ? 'Đóng' : 'Close'} className={styles.clearBtn} style={{ position: 'static', transform: 'none' }}>
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        <div className={styles.dialogBody}>
                            {libraryLoading && <p role="status">{vi ? 'Đang mở bài đọc…' : 'Opening reading…'}</p>}
                            {libraryError && <p role="alert" className="text-rose-600 dark:text-rose-300">{libraryError}</p>}
                            {materials.map(mat => (
                                <button
                                    key={mat.id}
                                    type="button"
                                    disabled={libraryLoading} onClick={() => void handleSelectMaterial(mat)}
                                    className={styles.listItem}
                                >
                                    <div className="min-w-0 pr-4">
                                        <div className="truncate text-sm font-semibold" style={{ color: 'var(--ink)' }}>
                                            {mat.title}
                                        </div>
                                        <div className="mt-0.5 flex items-center gap-2 text-xs" style={{ color: 'var(--ink-3)' }}>
                                            {mat.difficultyLevel?.trim() && <><span className="font-semibold" style={{ color: 'var(--wink)' }}>{mat.difficultyLevel}</span><span>•</span></>}
                                            <span><BookOpen className="mr-1 inline h-3 w-3 align-[-2px]" aria-hidden="true" />{mat.wordCount || (mat.contentText ? mat.contentText.split(/\s+/).length : 0)} {vi ? 'từ' : 'words'}</span>
                                        </div>
                                    </div>
                                    <ChevronRight className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--ink-3)' }} />
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};
