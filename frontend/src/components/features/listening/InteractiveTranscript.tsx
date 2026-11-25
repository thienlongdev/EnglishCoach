import React, { useEffect, useRef, useMemo } from 'react';
import { TranscriptSegment, SegmentHeatmapDto, WordTimestamp } from '../../../types/listening';
import { Play } from 'lucide-react';
import { activeTranscriptSegment, transcriptDisplayBounds } from './transcript-timing';
import styles from './glass/listeningGlass.module.css';

interface InteractiveTranscriptProps {
    words?: WordTimestamp[];
    segments?: TranscriptSegment[];
    currentTime: number; // In seconds from YouTube player
    isPlaying?: boolean;
    onSegmentClick?: (startTimeMs: number) => void;
    onWordClick?: (startTimeSec: number) => void;
    heatmapData?: SegmentHeatmapDto[];
    isBilingual?: boolean;
    translations?: Record<string,string>;
    /** A missing Vietnamese line is being made on this device: keep its place quietly. */
    translationPending?: boolean;
    selectedSegmentId?: number;
    onSegmentSelect?: (id:number) => void;
}

/**
 * Authoritative Word Timestamp Lookup:
 * Binary-searches segment words for the word currently active at currentTime.
 * Active condition: word.start <= currentTime < word.end
 * Returns the index of the active word, or -1 if no word is active (e.g. pause, intro, silence).
 */
function findActiveWordIndex(words: WordTimestamp[], currentTime: number): number {
    if (!words || words.length === 0) return -1;
    if (words[0].start < 0) return -1;

    // Out-of-bounds check: before first word start or after last word end
    if (currentTime < words[0].start || currentTime >= words[words.length - 1].end) {
        return -1;
    }

    let low = 0;
    let high = words.length - 1;

    while (low <= high) {
        const mid = (low + high) >> 1;
        const w = words[mid];

        if (currentTime >= w.start && currentTime < w.end) {
            return mid;
        } else if (currentTime < w.start) {
            high = mid - 1;
        } else {
            low = mid + 1;
        }
    }

    return -1;
}

export const InteractiveTranscript: React.FC<InteractiveTranscriptProps> = ({
    words,
    segments,
    currentTime,
    isPlaying = false,
    onSegmentClick,
    onWordClick,
    heatmapData,
    isBilingual = false,
    translations = {},
    translationPending = false,
    selectedSegmentId,
    onSegmentSelect,
}) => {
    const listRef = useRef<HTMLDivElement>(null);
    const prevSegmentIndexRef = useRef<number>(-1);
    const manualScrollUntil = useRef(0);

    const displayBounds = useMemo(() => transcriptDisplayBounds(segments ?? []), [segments]);
    // Caption bounds may start after their aligned first words. Use display-only
    // envelopes so the existing authoritative word lookup can render those words.
    const activeSegmentIndex = useMemo(() => {
        if(selectedSegmentId!==undefined)return segments?.findIndex(seg=>seg.id===selectedSegmentId)??-1;
        return activeTranscriptSegment(displayBounds, currentTime);
    }, [displayBounds, currentTime, selectedSegmentId, segments]);
    const activateSegment=(segment:TranscriptSegment)=>{
        onSegmentSelect?.(segment.id);
        if(typeof segment.startTimeMs==='number'&&typeof segment.endTimeMs==='number'&&Number.isFinite(segment.startTimeMs)&&Number.isFinite(segment.endTimeMs)&&segment.endTimeMs>segment.startTimeMs)
            onSegmentClick?.(segment.startTimeMs);
    };

    const getSegmentWords = (seg: TranscriptSegment): WordTimestamp[] => {
        if (seg.words && seg.words.length > 0) {
            return seg.words;
        }
        return seg.text.trim().split(/\s+/).filter(Boolean).map(w => ({
            word: w,
            start: -1,
            end: -1,
        }));
    };

    // Container-scoped auto-scroll: smoothly scroll ONLY the internal transcript container
    // so the active sentence becomes the top-anchored first visible row.
    // NEVER call scrollIntoView or scroll the document/window.
    useEffect(() => {
        if (activeSegmentIndex !== -1 && activeSegmentIndex !== prevSegmentIndexRef.current) {
            prevSegmentIndexRef.current = activeSegmentIndex;
            const container = listRef.current;
            if (container && segments && segments[activeSegmentIndex] && performance.now() >= manualScrollUntil.current) {
                const segElem = document.getElementById(`segment-${segments[activeSegmentIndex].id}`);
                if (segElem) {
                    const containerRect = container.getBoundingClientRect();
                    const elemRect = segElem.getBoundingClientRect();
                    // Distance from container top to element top plus current container scroll
                    const targetScrollTop = container.scrollTop + (elemRect.top - containerRect.top) - 4;
                    container.scrollTo({
                        top: Math.max(0, targetScrollTop),
                        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
                    });
                }
            }
        }
    }, [activeSegmentIndex, segments]);

    const handleWordClick = (startSec: number) => {
        if (startSec < 0) return;
        if (onWordClick) {
            onWordClick(startSec);
        } else if (onSegmentClick) {
            onSegmentClick(startSec * 1000);
        }
    };

    const formatTimestamp = (ms: number) => {
        const totalSec = Math.floor(ms / 1000);
        const m = Math.floor(totalSec / 60).toString().padStart(2, '0');
        const s = (totalSec % 60).toString().padStart(2, '0');
        return `${m}:${s}`;
    };

    if (!segments || segments.length === 0) {
        return (
            <div className={styles.txHidden}>
                <p>Không có transcript khả dụng cho nội dung này.</p>
            </div>
        );
    }

    return (
        <div className={styles.tx}>
            {/* Header for the transcript list */}
            <div className={styles.txMeta}>
                <span>Toàn bộ transcript ({segments.length} câu)</span>
                <span>Bấm câu để chuyển đoạn</span>
            </div>

            {/* Single transcript flow: fixed rows with word-by-word highlight inside the active row */}
            <div ref={listRef} className={`${styles.txList} notranslate`} translate="no" onWheel={()=>{manualScrollUntil.current=performance.now()+6000;}} onTouchStart={()=>{manualScrollUntil.current=performance.now()+6000;}} onKeyDown={()=>{manualScrollUntil.current=performance.now()+6000;}}>
                {segments.map((segment, index) => {
                    const isActive = index === activeSegmentIndex;
                    const segmentWords = getSegmentWords(segment);
                    const activeWordIndex = isActive ? findActiveWordIndex(segmentWords, currentTime) : -1;

                    return (
                        <div
                            key={segment.id}
                            id={`segment-${segment.id}`}
                            onClick={() => activateSegment(segment)}
                            role="button"
                            tabIndex={0}
                            aria-label={segment.text}
                            onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();activateSegment(segment);}}}
                            className={styles.txRow}
                            data-active={isActive}
                        >
                            {isActive && (
                                <div className={styles.txBar} aria-hidden="true" />
                            )}

                            {!isBilingual && <div className={styles.txRowHead}>
                                <div>
                                    <span className={styles.txTime}>
                                        {formatTimestamp(segment.startTimeMs)}
                                    </span>
                                    {segment.speakerName && (
                                        <span className={styles.txSpeaker}>
                                            {segment.speakerName}
                                        </span>
                                    )}
                                    {isActive && (
                                        <span className={styles.txNow}>
                                            Đang phát
                                        </span>
                                    )}
                                </div>

                                <button
                                    type="button"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        activateSegment(segment);
                                    }}
                                    title="Phát đoạn này"
                                    aria-label={`Phát đoạn ${formatTimestamp(segment.startTimeMs)}`}
                                    className={styles.txPlay}
                                >
                                    <Play size={13} className="fill-current" />
                                </button>
                            </div>}

                            {/* Sentence text: stable, only the current word is lit inside the active row (no layout reflow) */}
                            <p translate="no" className={`${styles.txText} notranslate`}>
                                {segmentWords.map((word, wIdx) => {
                                    const isWordActive = isActive && wIdx === activeWordIndex;
                                    return (
                                        <span
                                            key={wIdx}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                if(word.start<0)activateSegment(segment);else handleWordClick(word.start);
                                            }}
                                            className={styles.txWord}
                                            data-active={isWordActive}
                                        >
                                            {word.word}
                                        </span>
                                    );
                                }).reduce<React.ReactNode[]>((all, node, i) => (i ? [...all, ' ', node] : [node]), [])}
                            </p>
                            {isBilingual && (translations[String(segment.id)]
                                ? <p lang="vi" className={styles.txTranslation}>{translations[String(segment.id)]}</p>
                                : translationPending && <p className={styles.txTranslation} data-pending="true" aria-hidden="true">···</p>)}
                        </div>
                    );
                })}
            </div>
        </div>
    );
};
