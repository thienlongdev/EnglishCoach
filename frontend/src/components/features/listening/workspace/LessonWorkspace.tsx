"use client";

import {useSession} from "next-auth/react";
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import Link from 'next/link';
import { useParams, usePathname, useSearchParams } from 'next/navigation';
import {
    ArrowLeft,
    Headphones,
    Subtitles,
    SpellCheck,
    Activity,
    Clock,
    Globe,
    Users,
    Mic2,
    ExternalLink,
    FileText,
    Eye,
    EyeOff,
    MonitorPlay,
    Volume2,
    Play,
    Trophy,
    RotateCcw,
    PencilLine,
    ListChecks
} from 'lucide-react';
import { getListeningMaterialById, getMaterialHeatmap, getListeningExercises, completeListeningSession } from '../../../../services/listeningApi';
import { ListeningMaterialDetail, SegmentHeatmapDto, ListeningExercise, TranscriptSegment, WordTimestamp } from '../../../../types/listening';
import { AdvancedAudioPlayer, AdvancedAudioPlayerRef } from '../AdvancedAudioPlayer';
import { DictationExercise, DictationAttemptOutcome } from '../DictationExercise';
import { BilingualTranscript } from '../BilingualTranscript';
import { SentencePicker } from '../SentencePicker';
import { glass as s, LoadingState, StatePanel, VOICE_LABEL, categoryLabel, formatClock } from '../glass/ListeningGlass';
import { useLanguage } from '@/context/LanguageContext';
import { getCachedListeningDetail, saveCachedListeningDetail } from '../../../../services/listeningCache';
import { useContentTitle } from '@/lib/brand/tabTitle';
import { resolveInitialExerciseIndex } from '@/lib/listeningPractice';
import { useListeningCheckpoint } from '@/hooks/useListeningCheckpoint';
import { listeningSentenceAtTime } from '@/lib/listeningCheckpoint';
import { morphIn } from '@/lib/morph/tokens';
import {
    clearEchoWorkspaceContext,
    dispatchEchoModuleReady,
    publishEchoWorkspaceContext,
} from '@/lib/echo/contextBridge';

/**
 * The one lesson workspace (10 §BN). Overview and Dictation are two views of this mounted tree, in the lesson layout: the player keeps one DOM position, so its
 * iframe is never recreated and playback, position and speed survive a switch; a typed draft, the active sentence and the run stay mounted in their hidden view.
 * Both route files render nothing. The view comes from the pathname, and a switch uses native history (no server round trip), like the root tabs.
 * `allowFreeSeek` is on in both views: it keeps the player's clock running while paused, and native scrubbing has nothing to cancel in Overview.
 */

/** Where the learner was when they left for Thống kê or the library: a number per account and lesson, nothing else. */
const lastPositions = new Map<string, number>();

function lessonUrl(id: number | null, view: 'overview' | 'practice'): string {
    return view === 'practice' ? `/listening/${id}/practice` : `/listening/${id}`;
}

function OverviewTranscript({ material, heatmapData, isPlaying, active, subscribe, seek, getTime }: {
    material: ListeningMaterialDetail;
    heatmapData: SegmentHeatmapDto[];
    isPlaying: boolean;
    active: boolean;
    subscribe: (listener: (time: number) => void) => () => void;
    seek: (time: number) => void;
    getTime: () => number;
}) {
    // The clock only reaches this subtree while it is on screen: the page around it never re-renders at the player's 20 Hz.
    const [currentTime, setCurrentTime] = useState(0);
    useEffect(() => {
        if (!active) return;
        setCurrentTime(getTime());
        return subscribe(setCurrentTime);
    }, [active, subscribe, getTime]);
    return (
        <BilingualTranscript
            lessonId={material.id}
            segments={material.segments}
            currentTime={currentTime}
            isPlaying={isPlaying}
            onSegmentClick={(time) => {
                seek(time / 1000);
                setCurrentTime(time / 1000);
            }}
            heatmapData={heatmapData}
        />
    );
}

export default function LessonWorkspace() {
    const {data:session,status}=useSession();
    const route=useParams();
    const pathname=usePathname()||'';
    if(status !== 'authenticated') return <div className={s.page} data-world={pathname.endsWith('/practice')?'dictation':undefined}><LoadingState text="Đang mở phòng nghe…"/></div>;
    const userScope=String((session?.user as any)?.id || session?.user?.email);
    return <LessonContent key={`${userScope}:${route?.id}`} userScope={userScope}/>;
}

function LessonContent({userScope}:{userScope:string}) {
    const { locale } = useLanguage();
    const vi = locale === 'vi';
    const params = useParams();
    const pathname = usePathname() || '';
    const searchParams = useSearchParams();
    const segmentParam = searchParams.get('segment');
    const startParam = searchParams.get('start');
    const endParam = searchParams.get('end');
    const view: 'overview' | 'practice' = pathname.endsWith('/practice') ? 'practice' : 'overview';

    const id = typeof params?.id === 'string' ? parseInt(params.id, 10) : null;
    const initialCached = id ? getCachedListeningDetail(userScope, id) : undefined;

    const [material, setMaterial] = useState<ListeningMaterialDetail | null>(initialCached || null);
    useContentTitle(material?.title);
    const [loading, setLoading] = useState(!initialCached);
    const [heatmapData, setHeatmapData] = useState<SegmentHeatmapDto[]>([]);
    const [isPlaying, setIsPlaying] = useState(false);
    const [showTranscript, setShowTranscript] = useState(true);

    const [exercises, setExercises] = useState<ListeningExercise[]>([]);
    const [exercisesLoading, setExercisesLoading] = useState(false);
    const [currentIndex, setCurrentIndex] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [isDictationStarted, setIsDictationStarted] = useState(false);
    const [hideVideo, setHideVideo] = useState(false);
    const [videoSize, setVideoSize] = useState<'normal' | 'compact'>('normal');
    const [activeSessionId, setActiveSessionId] = useState<number | null>(null);
    // The latest outcome per sentence of THIS run (server responses as returned) → the end-of-run summary.
    const [outcomes, setOutcomes] = useState<Record<number, DictationAttemptOutcome>>({});
    const [finished, setFinished] = useState(false);

    const playerRef = useRef<AdvancedAudioPlayerRef>(null);

    // A view's data and account state load the first time that view is shown, and stay for the life of the lesson.
    const [overviewSeen, setOverviewSeen] = useState(view === 'overview');
    const [practiceSeen, setPracticeSeen] = useState(view === 'practice');
    useEffect(() => { if (view === 'overview') setOverviewSeen(true); else setPracticeSeen(true); }, [view]);

    const checkpoint=useListeningCheckpoint(userScope,practiceSeen?id:null);
    const initialized=useRef(false);
    const [pickerOpen,setPickerOpen]=useState(false);
    const lastPosition=useRef(0);
    const observedPosition=useRef(0);
    const checkpointRef=useRef(checkpoint);checkpointRef.current=checkpoint;
    const viewRef=useRef(view);viewRef.current=view;

    const positionKey = `${userScope}:${id}`;
    const timeListeners = useRef(new Set<(time: number) => void>());
    const subscribeTime = useCallback((listener: (time: number) => void) => {
        timeListeners.current.add(listener);
        return () => { timeListeners.current.delete(listener); };
    }, []);
    const getObservedTime = useCallback(() => observedPosition.current, []);
    const seekFromTranscript = useCallback((time: number) => {
        playerRef.current?.seekTo(time);
        observedPosition.current = time;
    }, []);

    /** A switch of view is native history: the App Router follows it, nothing is fetched and nothing is mounted again. */
    const goToView = useCallback((next: 'overview' | 'practice', event?: React.MouseEvent) => {
        if (event && (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)) return;
        event?.preventDefault();
        window.history.pushState(null, '', lessonUrl(id, next));
    }, [id]);

    useEffect(() => {
        if (!id) return;

        let isMounted = true;
        if (!material) setLoading(true);

        getListeningMaterialById(id).then((matData) => {
            if (isMounted) {
                setMaterial(matData);
                setLoading(false);
                saveCachedListeningDetail(userScope, id, matData);

                // Save to localStorage for the "continue" entry of the library (the last opened lesson only).
                try {
                    localStorage.setItem("ec_last_listening_material", JSON.stringify({
                        id: matData.id,
                        title: matData.title,
                        cefrLevel: matData.cefrLevel,
                        accent: matData.accent,
                        topic: matData.topic,
                        audioUrl: matData.audioUrl,
                        durationSeconds: matData.durationSeconds,
                        timestamp: Date.now()
                    }));
                } catch {
                    // Ignore storage errors
                }
            }
        }).catch((err: unknown) => {
            console.error("Failed to load material", err);
            if (isMounted) setLoading(false);
        });

        return () => {
            isMounted = false;
        };
    }, [id]);

    useEffect(() => {
        if (!id || !overviewSeen) return;
        let isMounted = true;
        getMaterialHeatmap(id).then((heatData) => {
            if (isMounted) setHeatmapData(heatData);
        }).catch((err: unknown) => {
            console.error("Failed to fetch heatmap data", err);
        });
        return () => { isMounted = false; };
    }, [id, overviewSeen]);

    useEffect(() => {
        if (!id || !practiceSeen) return;
        let isMounted = true;
        setExercisesLoading(true);
        getListeningExercises(id).then((exData) => {
            if (isMounted) {
                setExercises(exData.filter(ex => ex.exerciseType === 'DICTATION'));
                setExercisesLoading(false);
            }
        }).catch((err: unknown) => {
            console.error(err);
            if (isMounted) {
                setError("Không thể tải dữ liệu bài tập chính tả.");
                setExercisesLoading(false);
            }
        });
        return () => { isMounted = false; };
    }, [id, practiceSeen]);

    // Back in the lesson after Thống kê or the library: the same place in the video, without starting it.
    const placeRestored = useRef(false);
    useEffect(() => {
        if (!material || placeRestored.current) return;
        placeRestored.current = true;
        const place = lastPositions.get(positionKey);
        if (place && place > 1 && !segmentParam && !startParam) {
            playerRef.current?.seekTo(place);
            observedPosition.current = place;
        }
    }, [material, positionKey, segmentParam, startParam]);
    useEffect(() => () => { if (observedPosition.current > 1) lastPositions.set(positionKey, observedPosition.current); }, [positionKey]);

    // One-time checkpoint/deep-link restoration. Subsequent playback never triggers a seek effect.
    useEffect(() => {
        if (!practiceSeen || !material || exercises.length === 0 || !checkpoint.ready || initialized.current) return;
        initialized.current=true;
        const selected=checkpoint.state.selectedSegmentId;
        const savedIndex=selected?exercises.findIndex(ex=>ex.transcriptSegmentId===selected):-1;
        const initialIdx=segmentParam||startParam?resolveInitialExerciseIndex(exercises,segmentParam,startParam,material.segments):Math.max(0,savedIndex);
        setCurrentIndex(initialIdx);
        const savedPosition=checkpoint.state.position??0;
        // Arriving from Overview with the video already moving: the learner's place on screen wins over the saved one.
        const live=observedPosition.current>0.5;
        if(!live){
            lastPosition.current=savedPosition;
            observedPosition.current=savedPosition;
            if(!segmentParam&&!startParam&&savedPosition>0)playerRef.current?.seekTo(savedPosition);
        }else lastPosition.current=observedPosition.current;
        const preferences=checkpoint.state.preferences;
        if(preferences){setRepeatCount(preferences.repeatCount);setReplayGap(preferences.replayGap);playerRef.current?.setPlaybackRate(preferences.speed);}
        if(segmentParam||startParam)setIsDictationStarted(true);
    }, [practiceSeen, material, exercises, checkpoint.ready, segmentParam, startParam]);

    // A sentence replay belongs to Dictation: Overview plays the lesson freely, from where it is.
    const previousView = useRef(view);
    const wrapRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (previousView.current === view) return;
        previousView.current = view;
        if (view === 'overview') playerRef.current?.clearLoop();
        const root = wrapRef.current;
        if (root) root.querySelectorAll<HTMLElement>('[data-lesson-view-in]').forEach((el, i) => morphIn(el, i));
    }, [view]);

    const currentExercise = exercises[currentIndex];
    const matchedSegment = currentExercise && material
        ? material.segments.find(s => s.id === currentExercise.transcriptSegmentId) || null
        : null;

    function getExactClipBoundaries(seg: TranscriptSegment | null): { startSec: number; endSec: number } {
        if (!seg) return { startSec: 0, endSec: 0 };
        if (seg.words && seg.words.length > 0) {
            const validWords = seg.words.filter((w: WordTimestamp) => typeof w.start === 'number' && typeof w.end === 'number' && w.end >= w.start);
            if (validWords.length > 0) {
                const firstWord = validWords[0];
                const lastWord = validWords[validWords.length - 1];
                return {
                    startSec: Math.max(0, firstWord.start),
                    endSec: Math.max(firstWord.start + 0.05, lastWord.end)
                };
            }
        }
        return {
            startSec: seg.startTimeMs / 1000,
            endSec: seg.endTimeMs / 1000
        };
    }

    function getActiveBoundaries(seg: TranscriptSegment | null): { startSec: number; endSec: number } {
        const standard = getExactClipBoundaries(seg);
        const initialExercise=exercises[resolveInitialExerciseIndex(exercises,segmentParam,startParam,material?.segments??[])];
        if (startParam && endParam && seg?.id===initialExercise?.transcriptSegmentId) {
            const s = parseFloat(startParam);
            const e = parseFloat(endParam);
            if (!isNaN(s) && !isNaN(e) && e > s) {
                if (Math.abs(standard.startSec - s) <= 5.0) {
                    return { startSec: s, endSec: e };
                }
            }
        }
        return standard;
    }

    const [repeatCount, setRepeatCount] = useState<number>(5);
    const [replayGap, setReplayGap] = useState<number>(0.5);

    const isLast = currentIndex === exercises.length - 1;
    const isFirst = currentIndex === 0;

    const hasTiming=(seg:TranscriptSegment|null)=>!!seg&&typeof seg.startTimeMs==='number'&&typeof seg.endTimeMs==='number'&&Number.isFinite(seg.startTimeMs)&&Number.isFinite(seg.endTimeMs)&&seg.startTimeMs>=0&&seg.endTimeMs>seg.startTimeMs;
    const selectSentence=(index:number,play=true)=>{
        const ex=exercises[index];const seg=material?.segments.find(s=>s.id===ex?.transcriptSegmentId);
        if(!ex||!seg)return;
        setFinished(false);setCurrentIndex(index);setIsDictationStarted(true);
        const bounds=getActiveBoundaries(seg);
        if(hasTiming(seg))observedPosition.current=bounds.startSec;
        checkpoint.update(prev=>({...prev,selectedSegmentId:seg.id,...(hasTiming(seg)?{position:bounds.startSec}:{})}));
        if(play&&hasTiming(seg))playerRef.current?.setLoop(bounds.startSec,bounds.endSec,true,repeatCount,replayGap);
        else playerRef.current?.clearLoop();
    };
    const selectById=(segmentId:number)=>{const index=exercises.findIndex(ex=>ex.transcriptSegmentId===segmentId);if(index>=0)selectSentence(index);};

    const handleStartDictation = () => {
        setIsDictationStarted(true);
        if(checkpoint.hasProgress&&!segmentParam&&!startParam){playerRef.current?.clearLoop();playerRef.current?.seekTo(checkpoint.state.position??0);return;}
        if (hasTiming(matchedSegment) && playerRef.current) {
            const { startSec, endSec } = getActiveBoundaries(matchedSegment);
            playerRef.current.setLoop(startSec, endSec, true, repeatCount, replayGap);
        }
    };

    const handleReplay = (repeats: number = repeatCount, gap: number = replayGap) => {
        if (hasTiming(matchedSegment) && playerRef.current) {
            const { startSec, endSec } = getActiveBoundaries(matchedSegment);
            playerRef.current.setLoop(startSec, endSec, true, repeats, gap);
        }
    };

    const listeningCmdRef = useRef<(detail: { command?: string; speed?: number }) => void>(() => {});
    listeningCmdRef.current = (d) => {
        if (d.command === 'play') playerRef.current?.play();
        else if (d.command === 'pause') playerRef.current?.pause();
        else if (d.command === 'toggle') { if (isPlaying) playerRef.current?.pause(); else playerRef.current?.play(); }
        else if (d.command === 'replay') { if (view === 'practice' && hasTiming(matchedSegment)) handleReplay(); else { playerRef.current?.seekTo(Math.max(0, observedPosition.current - 5)); playerRef.current?.play(); } }
        else if (d.command === 'speed' && typeof d.speed === 'number' && Number.isFinite(d.speed)) playerRef.current?.setPlaybackRate(Math.max(0.5, Math.min(2, d.speed)));
        else if (d.command === 'toggle_transcript') setShowTranscript(prev => !prev);
        else if (d.command === 'switch_dictation') goToView('practice');
        else if (d.command === 'switch_overview') goToView('overview');
    };
    useEffect(() => {
        const onCmd = (e: Event) => listeningCmdRef.current((e as CustomEvent).detail || {});
        window.addEventListener('ec:listening:command', onCmd);
        if (id && Number.isSafeInteger(id) && id > 0) {
            publishEchoWorkspaceContext({
                source: 'listening-workspace',
                kind: 'LISTENING_LESSON',
                id,
                playbackTimeSec: Math.max(0, Math.floor(observedPosition.current)),
            });
            dispatchEchoModuleReady('listening', { id });
        }
        return () => {
            window.removeEventListener('ec:listening:command', onCmd);
            clearEchoWorkspaceContext('listening-workspace');
        };
    }, [id]);


    const handleNext = async () => {
        if (!isLast) {
            selectSentence(currentIndex+1);
        } else {
            if (activeSessionId) {
                try {
                    await completeListeningSession(activeSessionId);
                } catch (e) {
                    console.error("Failed to complete session:", e);
                }
            }
            playerRef.current?.pause();
            setFinished(true);
        }
    };

    const handlePrev = () => {
        if (!isFirst) {
            selectSentence(currentIndex-1);
        }
    };

    const handleOutcome = (outcome: DictationAttemptOutcome) => {
        // The latest attempt of a sentence wins; a slow server answer to an earlier attempt never overwrites it.
        setOutcomes(prev => {
            const current = prev[outcome.exerciseId];
            return current && current.seq > outcome.seq ? prev : { ...prev, [outcome.exerciseId]: outcome };
        });
        if(outcome.response){
            const ex=exercises.find(ex=>ex.id===outcome.exerciseId);const segmentId=ex?.transcriptSegmentId;
            if(segmentId)checkpoint.update(prev=>{
                const old=prev.entries[String(segmentId)];
                const status=outcome.kind==='revealed'?'revealed':outcome.response?.isCorrect?'completed':'evaluated';
                const {id,isCorrect,accuracyPercentage,primaryErrorCategory}=outcome.response!;
                return {...prev,entries:{...prev.entries,[String(segmentId)]:{draft:old?.draft??outcome.response!.rawUserAnswer,status:old?.status==='completed'?'completed':status,evaluation:{id,isCorrect,accuracyPercentage,primaryErrorCategory}}}};
            });
        }
    };

    const handleRunAgain = () => {
        // A new run: the completed session is not reused (the server opens a new one on the first saved answer).
        setOutcomes({});
        setActiveSessionId(null);
        selectSentence(0);
    };

    const summary = useMemo(() => {
        const list = Object.values(outcomes);
        const own = list.filter(o => o.kind !== 'revealed' && typeof o.response?.accuracyPercentage === 'number');
        const avg = own.length ? own.reduce((sum, o) => sum + (o.response!.accuracyPercentage as number), 0) / own.length : null;
        return {
            done: list.length,
            correct: list.filter(o => o.kind === 'correct').length,
            revealed: list.filter(o => o.kind === 'revealed').length,
            notYet: list.filter(o => o.kind === 'incorrect').length,
            average: avg,
        };
    }, [outcomes]);

    // Stable callbacks: the memoised player never re-renders because a parent did. Each view's work is decided here, from the view on screen.
    const materialRef = useRef(material);materialRef.current = material;
    const exercisesRef = useRef(exercises);exercisesRef.current = exercises;
    const lastPublishedSecRef = useRef(-10);
    const onPlayerTime = useCallback((time: number, playing?: boolean) => {
        observedPosition.current = time;
        const sec = Math.max(0, Math.floor(time));
        const activeId = materialRef.current?.id;
        if (activeId && Math.abs(sec - lastPublishedSecRef.current) >= 2) {
            lastPublishedSecRef.current = sec;
            publishEchoWorkspaceContext({
                source: 'listening-workspace',
                kind: 'LISTENING_LESSON',
                id: activeId,
                playbackTimeSec: sec,
            });
        }
        timeListeners.current.forEach((listener) => listener(time));
        if (typeof playing === 'boolean' && viewRef.current === 'overview') setIsPlaying(playing);
        if (viewRef.current !== 'practice' || !checkpointRef.current.ready) return;
        if (Math.abs(time - lastPosition.current) >= 5 || (!playing && Math.abs(time - lastPosition.current) > .4)) {
            lastPosition.current = time;
            checkpointRef.current.update(prev => ({ ...prev, position: time }));
        }
    }, []);
    const onPlayerSeek = useCallback((time: number) => {
        observedPosition.current = time;
        const m = materialRef.current;
        if (viewRef.current !== 'practice' || !m) return;
        const index = listeningSentenceAtTime(m.segments, time);
        const seg = m.segments[index];
        const exerciseIndex = exercisesRef.current.findIndex(ex => ex.transcriptSegmentId === seg?.id);
        if (exerciseIndex >= 0) {
            setCurrentIndex(exerciseIndex);
            setFinished(false);
            setIsDictationStarted(true);
            checkpointRef.current.update(prev => ({ ...prev, selectedSegmentId: seg.id, position: time }));
        }
    }, []);
    const onPlayerRate = useCallback((speed: number) => {
        if (viewRef.current !== 'practice') return;
        checkpointRef.current.update(prev => ({ ...prev, preferences: { repeatCount: prev.preferences?.repeatCount ?? 5, replayGap: prev.preferences?.replayGap ?? 0.5, speed } }));
    }, []);

    const inPractice = view === 'practice';
    const world = !material ? undefined : inPractice ? 'dictation' : (material.isSystem === false || material.sourceType === 'DOCUMENT' ? 'personal' : 'library');

    if (loading) {
        return <div className={s.page} data-world={inPractice ? 'dictation' : undefined}><LoadingState text={inPractice ? "Đang thiết lập phòng luyện chính tả..." : "Đang tải phòng nghe studio..."} /></div>;
    }

    if (!material) {
        return (
            <div className={s.page} data-world={inPractice ? 'dictation' : undefined}>
                <div className={`${s.inner} ${s.innerNarrow}`}>
                    <StatePanel
                        kind="error"
                        icon={<Headphones size={26} />}
                        title="Không tìm thấy tài liệu"
                        text="Tài liệu luyện nghe này có thể đã bị xóa hoặc đường dẫn không hợp lệ."
                        actions={<Link href="/listening" className={`${s.btn} ${s.btnPrimary}`}><ArrowLeft size={16} aria-hidden="true" />Quay lại thư viện</Link>}
                    />
                </div>
            </div>
        );
    }

    const isDocument = material.sourceType === 'DOCUMENT';
    const hasTranscript = Boolean(material.hasTranscript && material.segments && material.segments.length > 0);
    const duration = formatClock(material.durationSeconds);
    const voice = material.voiceId ? VOICE_LABEL[material.voiceId] : undefined;
    const avgText = summary.average === null ? '—' : `${Math.round(summary.average * 10) / 10}%`;
    const completedCount=Object.values(checkpoint.state.entries).filter(entry=>entry.status==='completed').length;
    const practiceSegments=material.segments.filter(seg=>exercises.some(ex=>ex.transcriptSegmentId===seg.id));
    const practiceReady = exercises.length > 0 && !exercisesLoading && !error;

    return (
        <div className={s.page} data-world={world} ref={wrapRef}>
            <div className={s.inner}>
                {!inPractice && (
                /* Masthead: what am I listening to, and which practice exists */
                <header className={`${s.panel} ${s.studioHead}`} data-lesson-view-in="" data-morph-hero="lesson">
                    <div className="min-w-0">
                        <nav className={s.crumbs} aria-label={vi ? 'Đường dẫn' : 'Breadcrumb'}>
                            <Link href="/listening" className={s.back}>
                                <ArrowLeft size={15} aria-hidden="true" />
                                <span>Quay lại thư viện</span>
                            </Link>
                            <span aria-hidden="true">/</span>
                            <span>Listening Studio</span>
                        </nav>
                        <h1 className={s.studioTitle}>{material.title}</h1>
                        <div className={s.metaRow}>
                            <span className={s.meta} data-accent="">
                                {isDocument ? <FileText size={12} aria-hidden="true" /> : <MonitorPlay size={12} aria-hidden="true" />}
                                {isDocument ? (vi ? 'Tài liệu / Văn bản' : 'Document / Text') : 'YouTube'}
                            </span>
                            {material.cefrLevel && !isDocument && <span className={s.meta}>Level {material.cefrLevel}</span>}
                            {!isDocument && material.accent && <span className={s.meta}><Globe size={12} aria-hidden="true" />{material.accent} Accent</span>}
                            {isDocument && voice && <span className={s.meta}><Mic2 size={12} aria-hidden="true" />{vi ? voice : material.voiceId}</span>}
                            {!isDocument && material.speakerCount ? <span className={s.meta}><Users size={12} aria-hidden="true" />{material.speakerCount === 1 ? 'Monologue' : 'Dialogue'}</span> : null}
                            {!isDocument && material.channel && <span className={s.meta}>{material.channel}</span>}
                            {material.topic && <span className={s.meta}>{categoryLabel(material.topic, vi)}</span>}
                            {duration && <span className={s.meta}><Clock size={12} aria-hidden="true" />{duration}</span>}
                            <Link href={`/knowledge-universe?source=LISTENING:${encodeURIComponent(String(material.id))}`} className={s.meta}>{vi ? 'Xem trong vũ trụ' : 'See in the universe'}</Link>
                        </div>
                    </div>

                    <nav className={s.modeNav} aria-label={vi ? 'Chế độ' : 'Mode'} data-guide="ls-modes">
                        <span className={s.modeLink} aria-current="page">
                            <Subtitles size={15} aria-hidden="true" />
                            <span>{vi ? 'Tổng quan' : 'Overview'}</span>
                        </span>
                        {material.practiceAvailable ? (
                            <Link href={lessonUrl(id, 'practice')} className={s.modeLink} onClick={(event) => goToView('practice', event)}>
                                <SpellCheck size={15} aria-hidden="true" />
                                <span>{vi ? 'Chính tả' : 'Dictation'}</span>
                            </Link>
                        ) : (
                            <span title="Bài này chưa có transcript luyện nghe" className={s.modeLink} aria-disabled="true">
                                <SpellCheck size={15} aria-hidden="true" />
                                <span>{vi ? 'Chính tả' : 'Dictation'}</span>
                            </span>
                        )}
                        <Link href="/listening/dashboard" className={s.modeLink}>
                            <Activity size={15} aria-hidden="true" />
                            <span>{vi ? 'Thống kê' : 'Analytics'}</span>
                        </Link>
                    </nav>
                </header>
                )}

                {inPractice && (
                /* Header: lesson, instruction, real counters */
                <header className={`${s.panel} ${s.dictHead}`} data-lesson-view-in="">
                    <div className="flex items-start gap-3 min-w-0">
                        <Link href={lessonUrl(id, 'overview')} onClick={(event) => goToView('overview', event)} className={s.back}>
                            <ArrowLeft size={15} aria-hidden="true" />
                            <span className="whitespace-nowrap">Quay lại</span>
                        </Link>
                        <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                                <h1 className="text-lg md:text-xl font-bold tracking-tight" style={{ color: 'var(--ink)', overflowWrap: 'anywhere' }}>
                                    {material.title}
                                </h1>
                                {!isDocument && material.cefrLevel && <span className={s.meta} data-accent="">{material.cefrLevel}</span>}
                                {isDocument && material.cefrLevel && <span className={s.meta}>{material.cefrLevel}</span>}
                                {material.accent && !isDocument && <span className={s.meta}>Giọng: {material.accent}</span>}
                            </div>
                            <p className={`${s.muted} text-xs mt-1`}>
                                Nghe từng đoạn và viết lại chính xác những gì bạn nghe được.
                            </p>
                        </div>
                    </div>

                    {practiceReady && (
                    <div className={s.counter}>
                        <div className={s.counterBox}>
                            <span>Tổng câu</span>
                            <b>{exercises.length} câu</b>
                        </div>
                        <div className={s.counterBox}>
                            <span>Hiện tại</span>
                            <b>{finished ? exercises.length : currentIndex + 1} / {exercises.length}</b>
                        </div>
                    </div>
                    )}
                </header>
                )}

                {inPractice && practiceReady && (
                <div className={`${s.panel} ${s.checkpointBar}`} data-lesson-view-in="">
                    <div className={s.checkpointActions}>
                        <button type="button" className={`${s.btn} ${s.btnPrimary} ${s.btnSm}`} disabled={!checkpoint.ready||checkpoint.saving} onClick={()=>{checkpoint.update(prev=>({...prev,selectedSegmentId:matchedSegment?.id,position:observedPosition.current}));void checkpoint.save();}}>{checkpoint.saving?(vi?'Đang lưu…':'Saving…'):(vi?'Lưu tiến độ':'Save progress')}</button>
                        <button type="button" className={`${s.btn} ${s.btnSoft} ${s.btnSm}`} disabled={!checkpoint.ready} onClick={()=>setPickerOpen(true)}>{vi?'Chọn câu':'Choose sentence'}</button>
                        <button type="button" className={`${s.btn} ${s.btnGhost} ${s.btnSm}`} disabled={!checkpoint.ready} onClick={()=>selectSentence(0)}>{vi?'Học từ đầu':'Start from beginning'}</button>
                        {checkpoint.hasProgress&&!isDictationStarted&&<button type="button" className={`${s.btn} ${s.btnSoft} ${s.btnSm}`} onClick={handleStartDictation}>{vi?'Tiếp tục học':'Resume learning'}</button>}
                    </div>
                    <p role="status" className={s.saveMessage}>{checkpoint.message||(checkpoint.ready?(vi?'Bản nháp tự động lưu theo tài khoản và bài nghe.':'Drafts autosave for this account and lesson.'):(vi?'Đang đồng bộ tiến độ…':'Syncing progress…'))}</p>
                    {checkpoint.message.includes('Khôi phục')&&<button type="button" className={`${s.btn} ${s.btnSoft} ${s.btnSm}`} onClick={checkpoint.recoverLocal}>Khôi phục bản nháp</button>}
                    {!checkpoint.ready&&checkpoint.message&&<button type="button" className={`${s.btn} ${s.btnSoft} ${s.btnSm}`} onClick={checkpoint.retry}>{vi?'Thử lại':'Retry'}</button>}
                </div>
                )}
                {pickerOpen&&<SentencePicker segments={practiceSegments} selectedId={matchedSegment?.id} state={checkpoint.state} onSelect={selectById} onClose={()=>setPickerOpen(false)}/>}

                <div className={inPractice ? s.dictGrid : s.studioGrid}>
                    {/* The media stage: one element for both views, the player itself is never covered and never mounted twice */}
                    <div className={inPractice ? s.dictMedia : s.studioMain}>
                        <div className={s.stage}>
                            <div className={inPractice && videoSize === 'compact' ? 'max-w-sm mx-auto w-full' : 'w-full'}>
                                <div className={`${isDocument ? s.docStage : s.stageScreen} ${isDocument ? '' : 'aspect-video'}`} style={{ position: 'relative' }} data-morph-hero="media">
                                    <AdvancedAudioPlayer
                                        ref={playerRef}
                                        audioUrl={material.audioUrl}
                                        allowFreeSeek
                                        onUserSeek={onPlayerSeek}
                                        onTimeUpdate={onPlayerTime}
                                        onPlaybackRateChange={onPlayerRate}
                                        onPlaybackStateChange={setIsPlaying}
                                    />

                                    {/* Audio focus: the video is hidden so only the sound remains (decoration does not measure audio) */}
                                    {inPractice && hideVideo && !isDocument && (
                                        <div className={s.audioFocus} data-playing={isPlaying}>
                                            <div className={s.focusRings} aria-hidden="true">
                                                <i /><i /><i />
                                                <b><Volume2 size={24} /></b>
                                            </div>
                                            <span className={s.darkChip}><Headphones size={12} aria-hidden="true" />{vi ? 'Chế độ chỉ nghe' : 'Audio only'}</span>
                                            <h3 className="font-bold text-sm">Đã ẩn video — Tập trung nghe âm thanh</h3>
                                            <p className="text-xs max-w-xs" style={{ color: 'rgb(199 210 254 / 0.8)' }}>
                                                Nhận diện ngữ điệu và phát âm mà không bị chi phối bởi khẩu hình.
                                            </p>
                                        </div>
                                    )}
                                </div>
                            </div>

                            {!inPractice && (
                            <div className={s.stageBar} data-lesson-view-in="">
                                <div className={s.stageInfo}>
                                    <span className={s.stageGlyph} aria-hidden="true"><Headphones size={17} /></span>
                                    <div className="min-w-0">
                                        <p className="font-bold text-white">{hasTranscript
                                            ? (isDocument ? (vi ? 'Transcript đồng bộ theo câu' : 'Sentence-level transcript') : 'Đồng bộ từ vựng theo thời gian thực')
                                            : (vi ? 'Chế độ xem và nghe' : 'Watch and listen')}</p>
                                        <p className={s.liveDot} data-on={isPlaying} aria-live="polite"><i aria-hidden="true" />{isPlaying ? (vi ? 'Đang phát' : 'Playing') : (vi ? 'Đã dừng' : 'Paused')}</p>
                                    </div>
                                </div>
                                {material.practiceAvailable ? (
                                    <Link href={lessonUrl(id, 'practice')} className={s.stageCta} onClick={(event) => goToView('practice', event)}>
                                        <SpellCheck size={16} aria-hidden="true" />
                                        <span>Bắt đầu Dictation</span>
                                    </Link>
                                ) : (
                                    <span className={s.stageCta} aria-disabled="true" title="Bài này chưa có transcript luyện nghe">
                                        <SpellCheck size={16} aria-hidden="true" />
                                        <span>Chưa hỗ trợ Dictation</span>
                                    </span>
                                )}
                            </div>
                            )}

                            {inPractice && !isDocument && (
                                <div className={s.mediaTools} data-lesson-view-in="">
                                    <label className="inline-flex items-center gap-2">
                                        <span>Kích thước:</span>
                                        <select
                                            value={videoSize}
                                            onChange={(e) => setVideoSize(e.target.value as 'normal' | 'compact')}
                                            className={s.darkSelect}
                                        >
                                            <option value="normal">Tiêu chuẩn</option>
                                            <option value="compact">Gọn nhẹ</option>
                                        </select>
                                    </label>

                                    <button
                                        type="button"
                                        onClick={() => setHideVideo(prev => !prev)}
                                        className={s.darkBtn}
                                        aria-pressed={hideVideo}
                                    >
                                        {hideVideo ? (
                                            <>
                                                <Eye size={14} aria-hidden="true" />
                                                <span>{vi ? 'Hiện video' : 'Show Video'}</span>
                                            </>
                                        ) : (
                                            <>
                                                <EyeOff size={14} aria-hidden="true" />
                                                <span>{vi ? 'Ẩn video' : 'Hide Video'}</span>
                                            </>
                                        )}
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Overview: companion transcript. Kept mounted once seen, its place and its translations stay. */}
                    {overviewSeen && (
                    <aside className={`${s.side} ${inPractice ? s.viewOff : ''}`} aria-label="Transcript" data-lesson-view-in="">
                        <section className={`${s.panel} ${s.txPanel}`}>
                            <div className={s.txHead}>
                                <h2 className={s.txTitle}>
                                    <Subtitles size={18} className="text-[var(--wink)]" aria-hidden="true" />
                                    Transcript
                                </h2>
                                {hasTranscript && (
                                    <button type="button" onClick={() => setShowTranscript(v => !v)} className={s.txToggle} aria-expanded={showTranscript}>
                                        {showTranscript
                                            ? <span className="inline-flex items-center gap-1.5"><EyeOff size={14} aria-hidden="true" />{vi ? 'Ẩn transcript' : 'Hide transcript'}</span>
                                            : <span className="inline-flex items-center gap-1.5"><Eye size={14} aria-hidden="true" />{vi ? 'Hiện transcript' : 'Show transcript'}</span>}
                                    </button>
                                )}
                            </div>
                            {hasTranscript ? (
                                showTranscript ? (
                                    <div className="flex-1 min-h-0">
                                        <OverviewTranscript
                                            material={material}
                                            heatmapData={heatmapData}
                                            isPlaying={isPlaying}
                                            active={!inPractice}
                                            subscribe={subscribeTime}
                                            seek={seekFromTranscript}
                                            getTime={getObservedTime}
                                        />
                                    </div>
                                ) : (
                                    <div className={s.txHidden}>
                                        <EyeOff size={26} aria-hidden="true" />
                                        <p>{vi ? 'Transcript đang ẩn — hãy nghe trước, rồi mở lại để đối chiếu.' : 'Transcript hidden — listen first, then reveal it to check.'}</p>
                                    </div>
                                )
                            ) : (
                                <div className={s.txHidden}>
                                    <span className={s.stateIcon} aria-hidden="true"><Headphones size={24} /></span>
                                    <h3 className={s.stateTitle}>Bài này chưa có transcript luyện nghe</h3>
                                    <p className={s.stateText}>Tài liệu này hiện được lưu trữ ở chế độ xem và nghe (Watch-only). Bạn có thể thưởng thức nội dung video đầy đủ trên player.</p>
                                    {material.audioUrl && !isDocument && (
                                        <a
                                            href={material.audioUrl.startsWith('http') ? material.audioUrl : `https://www.youtube.com/watch?v=${material.audioUrl}`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className={`${s.btn} ${s.btnSoft} ${s.btnSm}`}
                                        >
                                            <ExternalLink size={14} aria-hidden="true" />
                                            <span>Mở xem trên YouTube</span>
                                        </a>
                                    )}
                                </div>
                            )}
                        </section>
                    </aside>
                    )}

                    {/* Dictation: setup → active dictation → end-of-run summary. Kept mounted once seen: the typed answer and the active sentence stay. */}
                    {practiceSeen && (
                    <div className={`min-w-0 ${inPractice ? '' : s.viewOff}`} data-lesson-view-in="">
                        {error || (!exercisesLoading && exercises.length === 0) ? (
                            <StatePanel
                                kind={error ? 'error' : 'empty'}
                                icon={<Headphones size={26} />}
                                title={error ? error : 'Chưa có bài tập chính tả'}
                                text="Rất tiếc, video này chưa được phân đoạn câu để luyện chính tả hoặc đang trong quá trình đồng bộ âm thanh."
                                actions={
                                    <Link href={lessonUrl(id, 'overview')} onClick={(event) => goToView('overview', event)} className={`${s.btn} ${s.btnPrimary}`}>
                                        <ArrowLeft size={16} aria-hidden="true" /> Quay lại bài nghe
                                    </Link>
                                }
                            />
                        ) : exercisesLoading ? (
                            <LoadingState text="Đang thiết lập phòng luyện chính tả..." />
                        ) : finished ? (
                            <section className={`${s.panel} ${s.complete} ${s.rise}`} aria-labelledby="dictation-complete-title" role="status">
                                <span className={s.completeBadge} aria-hidden="true"><Trophy size={32} /></span>
                                <div>
                                    <h2 id="dictation-complete-title" className={s.completeTitle}>{vi ? 'Hoàn thành lượt luyện' : 'Run complete'}</h2>
                                    <p className={`${s.muted} text-sm mt-1 max-w-md`}>
                                        {vi
                                            ? 'Tóm tắt các câu bạn đã làm trong lượt này. Các câu đã kiểm tra được lưu lại; Thống kê luyện nghe được tính từ các lượt đã hoàn thành.'
                                            : 'A summary of the sentences you worked on in this run. Checked sentences are saved; listening statistics are built from completed runs.'}
                                    </p>
                                </div>
                                <div className={s.completeGrid}>
                                    <div className={s.completeStat}><b>{summary.done} / {exercises.length}</b><span>{vi ? 'Câu đã làm' : 'Sentences worked'}</span></div>
                                    <div className={s.completeStat}><b>{summary.correct}</b><span>{vi ? 'Chép đúng hoàn toàn' : 'Fully correct'}</span></div>
                                    <div className={s.completeStat}><b>{summary.revealed}</b><span>{vi ? 'Đã xem đáp án' : 'Answer revealed'}</span></div>
                                    <div className={s.completeStat}><b>{avgText}</b><span>{vi ? 'Độ chính xác máy chấm (câu tự chép)' : 'Recorded accuracy (own answers)'}</span></div>
                                </div>
                                {summary.notYet > 0 && (
                                    <p className={`${s.notice} max-w-xl`} data-kind="info">
                                        <PencilLine size={16} aria-hidden="true" />
                                        <span>{vi ? `${summary.notYet} câu chưa chép đúng ở lần kiểm tra cuối — hãy luyện lại khi bạn sẵn sàng.` : `${summary.notYet} sentences were not yet correct at the last check.`}</span>
                                    </p>
                                )}
                                <div className={s.stateActions}>
                                    <Link href={lessonUrl(id, 'overview')} onClick={(event) => goToView('overview', event)} className={`${s.btn} ${s.btnPrimary}`}>
                                        <ArrowLeft size={16} aria-hidden="true" />{vi ? 'Về bài nghe' : 'Back to the lesson'}
                                    </Link>
                                    <Link href="/listening/dashboard" className={`${s.btn} ${s.btnSoft}`}>
                                        <Activity size={16} aria-hidden="true" />{vi ? 'Xem thống kê luyện nghe' : 'Listening statistics'}
                                    </Link>
                                    <button type="button" onClick={handleRunAgain} className={`${s.btn} ${s.btnGhost}`}>
                                        <RotateCcw size={16} aria-hidden="true" />{vi ? 'Luyện lại từ câu 1' : 'Start again from sentence 1'}
                                    </button>
                                </div>
                            </section>
                        ) : !isDictationStarted ? (
                            <section className={`${s.panel} ${s.setup} ${s.rise}`} aria-labelledby="dictation-setup-title">
                                <span className={s.stateIcon} aria-hidden="true"><Headphones size={28} /></span>
                                <div className="max-w-md">
                                    <h2 id="dictation-setup-title" className="text-xl md:text-2xl font-bold" style={{ color: 'var(--ink)' }}>
                                        Bắt đầu luyện chép chính tả
                                    </h2>
                                    <p className={`${s.muted} text-sm leading-relaxed mt-2`}>
                                        {vi ? 'Chọn bất kỳ câu nào để luyện, hoặc tua đến đoạn bạn muốn nghe. Bản nháp và các câu đã hoàn thành luôn được giữ lại.' : 'Practise any sentence or seek to the passage you want. Your drafts and completed work are retained.'}
                                    </p>
                                </div>

                                <ol className={s.setupSteps}>
                                    <li className={s.setupStep}><b><i>1</i>Lắng nghe</b><p>Nghe kỹ ngữ điệu và các từ khóa chính.</p></li>
                                    <li className={s.setupStep}><b><i>2</i>Chép lại</b><p>Gõ lại những gì nghe được vào ô nhập.</p></li>
                                    <li className={s.setupStep}><b><i>3</i>Kiểm tra</b><p>Nhấn Enter để nhận đối chiếu lỗi sai.</p></li>
                                </ol>

                                <div className="flex flex-wrap items-center justify-center gap-2">
                                    <span className={s.meta}><ListChecks size={13} aria-hidden="true" />{exercises.length} câu</span>
                                    <span className={s.meta}>Tab = {vi ? 'nghe lại' : 'replay'}</span>
                                    <span className={s.meta}>Enter = {vi ? 'kiểm tra' : 'check'}</span>
                                </div>

                                <button type="button" data-guide="dt-start" disabled={!checkpoint.ready} onClick={handleStartDictation} className={`${s.btn} ${s.btnPrimary}`} style={{ minHeight: '3.2rem', padding: '0 1.8rem', fontSize: '1rem' }}>
                                    <Play size={18} className="fill-current" aria-hidden="true" />
                                    <span>Bắt đầu chính tả</span>
                                </button>
                            </section>
                        ) : currentExercise ? (
                            /* ACTIVE DICTATION EXERCISE WORKSPACE */
                            <DictationExercise
                                key={currentExercise.id}
                                exercise={currentExercise}
                                segment={matchedSegment}
                                onNext={handleNext}
                                onPrev={handlePrev}
                                onReplay={handleReplay}
                                onPlay={() => playerRef.current?.play()}
                                onPause={() => playerRef.current?.pause()}
                                isPlaying={isPlaying}
                                isLast={isLast}
                                isFirst={isFirst}
                                currentIndex={currentIndex}
                                totalCount={exercises.length}
                                savedSentence={checkpoint.state.entries[String(matchedSegment?.id)]}
                                completedCount={completedCount}
                                onOpenPicker={()=>setPickerOpen(true)}
                                onDraftChange={draft=>{if(matchedSegment)checkpoint.update(prev=>({...prev,selectedSegmentId:matchedSegment.id,entries:{...prev.entries,[String(matchedSegment.id)]:{...prev.entries[String(matchedSegment.id)],draft,status:prev.entries[String(matchedSegment.id)]?.status??'draft'}}}));}}
                                repeatCount={repeatCount}
                                onRepeatCountChange={repeatCount=>{setRepeatCount(repeatCount);checkpoint.update(prev=>({...prev,preferences:{repeatCount,replayGap,speed:prev.preferences?.speed??1}}));}}
                                replayGap={replayGap}
                                onReplayGapChange={replayGap=>{setReplayGap(replayGap);checkpoint.update(prev=>({...prev,preferences:{repeatCount,replayGap,speed:prev.preferences?.speed??1}}));}}
                                activeSessionId={activeSessionId}
                                onSessionCreated={(sid) => setActiveSessionId(sid)}
                                onAttemptOutcome={handleOutcome}
                            />
                        ) : null}
                    </div>
                    )}
                </div>
            </div>
        </div>
    );
}
