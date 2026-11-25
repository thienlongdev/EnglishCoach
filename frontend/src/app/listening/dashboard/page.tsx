"use client";

import React, { useState, useEffect, useCallback } from 'react';
import {
    Activity,
    PieChart,
    ArrowLeft,
    CheckCircle2,
    AlertCircle,
    VolumeX,
    Shuffle,
    PlusCircle,
    SpellCheck,
    HelpCircle,
    Target,
    ListChecks,
    WifiOff,
    RotateCw,
    Headphones
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { getListeningDNA } from '../../../services/listeningApi';
import { ErrorDNADto, RepresentativeErrorItem, AlignedDiffItem } from '../../../types/listening';
import { glass as s, ListeningHero, LoadingState, StatePanel, errorLabel } from '../../../components/features/listening/glass/ListeningGlass';
import { useLanguage } from '@/context/LanguageContext';
import { useSession } from 'next-auth/react';
import { getCachedListeningDNA, saveCachedListeningDNA, getActiveListeningUser } from '../../../services/listeningCache';

/** Category → tone of its bar (the order of the bars is the server's percentages, largest first). */
const CATEGORY_TONE: Record<string, string> = {
    MINOR_SPELLING: 'everyday', MISSING_WORD: 'news', EXTRA_WORD: 'talks', WRONG_WORD: 'work', PHONETIC_CONFUSION: 'science', PUNCTUATION_ERROR: 'culture',
};

export default function AnalyticsDashboard() {
    const { locale } = useLanguage();
    const vi = locale === 'vi';
    const router = useRouter();
    const { data: session } = useSession();
    const userScope = session?.user ? ((session.user as any).id || session.user.email) : (typeof window !== 'undefined' ? getActiveListeningUser() : null);

    const initialCached = userScope ? getCachedListeningDNA(userScope) : undefined;
    const [dna, setDna] = useState<ErrorDNADto | null>(initialCached || null);
    const [loading, setLoading] = useState(!initialCached);
    const [loadFailed, setLoadFailed] = useState(false);
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        let isMounted = true;
        if (!dna) setLoading(true);

        getListeningDNA().then((data: ErrorDNADto) => {
            if (isMounted) {
                setDna(data);
                setLoading(false);
                setLoadFailed(false);
                if (userScope) {
                    saveCachedListeningDNA(userScope, data);
                }
            }
        }).catch((err: unknown) => {
            console.error("Failed to fetch listening statistics:", err);
            if (isMounted) {
                setLoading(false);
                setLoadFailed(true);
            }
        });
        return () => { isMounted = false; };
    }, [userScope, attempt]);

    const retry = useCallback(() => { setLoadFailed(false); setAttempt(n => n + 1); }, []);

    if (loading) {
        return <div className={s.page} data-world="stats"><LoadingState text={vi ? 'Đang tải thống kê luyện nghe...' : 'Loading listening statistics...'} /></div>;
    }

    const {
        overallAccuracy,
        totalAttempts = 0,
        errorBreakdownPercentage,
        topMissingWords = [],
        topExtraWords = [],
        topSubstitutions = [],
        topSpellingErrors = [],
        representativeErrors = []
    } = dna || {};

    const hasData = Boolean(
        dna &&
        overallAccuracy !== null &&
        overallAccuracy !== undefined &&
        (totalAttempts > 0 || (representativeErrors && representativeErrors.length > 0))
    );

    const safeErrorDNA: Record<string, number> = errorBreakdownPercentage || {};
    const errors = Object.entries(safeErrorDNA).sort((a, b) => b[1] - a[1]);

    const hasDetailedErrors = topMissingWords.length > 0 ||
                              topExtraWords.length > 0 ||
                              topSubstitutions.length > 0 ||
                              topSpellingErrors.length > 0;

    const times = vi ? 'lần' : 'times';
    const accuracy = hasData ? overallAccuracy as number : null;
    const ring = 2 * Math.PI * 70;

    return (
        <div className={s.page} data-world="stats">
            <div className={s.inner}>
                <button onClick={() => router.push('/listening')} className={s.back}>
                    <ArrowLeft size={15} aria-hidden="true" />
                    <span className="whitespace-nowrap">{vi ? 'Quay lại Thư viện' : 'Back to Library'}</span>
                </button>

                <ListeningHero
                    world="stats"
                    titleId="listening-stats-title"
                    eyebrow={vi ? 'Đài quan sát luyện nghe' : 'Listening observatory'}
                    eyebrowIcon={<Activity size={14} aria-hidden="true" />}
                    title={vi ? 'Thống kê luyện nghe' : 'Listening Statistics'}
                    lead={vi
                        ? 'Tổng hợp độ chính xác, phân bổ lỗi thường gặp và chi tiết các lỗi Dictation thực tế.'
                        : 'Summary of accuracy, common error distribution, and actual dictation mistakes from completed sessions.'}
                    stats={hasData ? [
                        { value: `${(overallAccuracy as number).toFixed(1)}%`, label: vi ? 'Độ chính xác tổng quan' : 'Overall accuracy', icon: <Target size={16} /> },
                        ...(totalAttempts > 0 ? [{ value: totalAttempts, label: vi ? 'Lượt chép đã chấm' : 'Scored attempts', icon: <ListChecks size={16} /> }] : []),
                    ] : []}
                />

                {loadFailed && !dna ? (
                    <StatePanel
                        kind="error"
                        icon={<WifiOff size={26} />}
                        title={vi ? 'Chưa tải được thống kê' : 'Could not load statistics'}
                        text={vi ? 'Kết nối tới máy chủ bị gián đoạn. Kết quả luyện tập của bạn không bị ảnh hưởng.' : 'The connection was interrupted. Your practice results are not affected.'}
                        actions={<button type="button" onClick={retry} className={`${s.btn} ${s.btnPrimary}`}><RotateCw size={16} aria-hidden="true" />{vi ? 'Thử lại' : 'Try again'}</button>}
                    />
                ) : !hasData ? (
                    /* Honest empty state if no completed runs */
                    <StatePanel
                        icon={<PieChart size={28} />}
                        title={vi ? 'Chưa có dữ liệu thống kê' : 'No statistics available yet'}
                        text={vi
                            ? 'Chưa có dữ liệu thống kê. Hãy hoàn thành một bài chính tả để bắt đầu.'
                            : 'No statistics available. Complete a full dictation session to get started.'}
                        actions={
                            <button onClick={() => router.push('/listening')} className={`${s.btn} ${s.btnPrimary}`}>
                                <Headphones size={16} aria-hidden="true" /> {vi ? 'Đến Thư viện Luyện nghe' : 'Go to Listening Library'}
                            </button>
                        }
                    />
                ) : (
                    <>
                        {loadFailed && (
                            <p className={s.notice} data-kind="warn" role="status">
                                <AlertCircle size={16} aria-hidden="true" />
                                <span>{vi ? 'Đang hiển thị số liệu đã lưu trên thiết bị; chưa cập nhật được từ máy chủ.' : 'Showing the copy saved on this device; the server could not be reached.'}</span>
                                <button type="button" onClick={retry} className={s.textLink}>{vi ? 'Thử lại' : 'Retry'}</button>
                            </p>
                        )}

                        {/* 1. Overall accuracy + error distribution */}
                        <div className={s.statsTop}>
                            <section className={`${s.panel} ${s.gauge}`} aria-labelledby="ls-accuracy">
                                <h2 id="ls-accuracy" className={s.menuLabel}>{vi ? 'Độ chính xác tổng quan' : 'Overall Accuracy'}</h2>
                                <div className={s.gaugeRing}>
                                    <svg viewBox="0 0 160 160" aria-hidden="true">
                                        <defs>
                                            <linearGradient id="ls-gauge" x1="0" y1="0" x2="160" y2="160" gradientUnits="userSpaceOnUse">
                                                <stop stopColor="#06b6d4" /><stop offset="0.6" stopColor="#7c3aed" /><stop offset="1" stopColor="#f59e0b" />
                                            </linearGradient>
                                        </defs>
                                        <circle cx="80" cy="80" r="70" stroke="var(--well-line)" strokeWidth="12" fill="none" />
                                        <circle cx="80" cy="80" r="70" stroke="url(#ls-gauge)" strokeWidth="12" fill="none" strokeLinecap="round"
                                            strokeDasharray={`${ring * Math.min(100, Math.max(0, accuracy ?? 0)) / 100} ${ring}`} />
                                    </svg>
                                    <div className={s.gaugeValue}>
                                        <b>{(overallAccuracy as number).toFixed(1)}%</b>
                                        <span>{vi ? 'độ chính xác' : 'accuracy'}</span>
                                    </div>
                                </div>
                                <span className="inline-flex items-center gap-1.5 text-xs font-semibold" style={{ color: 'var(--ok)' }}>
                                    <CheckCircle2 size={14} aria-hidden="true" />
                                    <span>{vi ? 'Dựa trên kết quả Dictation thực tế' : 'Based on real completed dictation runs'}</span>
                                </span>
                            </section>

                            <section className={`${s.panel} p-5 md:p-6 flex flex-col gap-5`} aria-labelledby="ls-distribution">
                                <div className={s.cardHead}>
                                    <h2 id="ls-distribution" className={s.cardTitleSm}>
                                        <span className={s.glyph} data-tone="talks" aria-hidden="true"><PieChart size={17} /></span>
                                        <span>{vi ? 'Phân bổ nhóm lỗi' : 'Error Distribution'}</span>
                                    </h2>
                                    <span className={s.meta}>{vi ? 'Theo WER thực tế' : 'WER Alignment'}</span>
                                </div>

                                {errors.length === 0 ? (
                                    <p className={`${s.muted} text-sm text-center py-8`}>
                                        {vi ? 'Chưa ghi nhận lỗi nào trong các bài đã hoàn thành.' : 'No errors recorded in completed exercises.'}
                                    </p>
                                ) : (
                                    <div className={s.bars}>
                                        {errors.map(([category, percent], i) => (
                                            <div key={category} className={s.barRow} data-tone={CATEGORY_TONE[category] || 'other'}>
                                                <div>
                                                    <span>{errorLabel(category, vi)}</span>
                                                    <b>{percent.toFixed(1)}%</b>
                                                </div>
                                                <div className={s.barTrack} role="img" aria-label={`${errorLabel(category, vi)}: ${percent.toFixed(1)}%`}>
                                                    <i style={{ width: `${Math.min(100, Math.max(0, percent))}%`, animationDelay: `${i * 80}ms` }} />
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </section>
                        </div>

                        {/* 2. Your specific word errors */}
                        <section className="flex flex-col gap-4" aria-labelledby="ls-words">
                            <div className={`${s.sectionHead} ec-wp-plate`}>
                                <div>
                                    <h2 id="ls-words" className={s.sectionTitle}>{vi ? 'Lỗi cụ thể của bạn' : 'Your Specific Word Errors'}</h2>
                                    <p className={s.sectionLead}>
                                        {vi
                                            ? 'Các từ bạn thường xuyên bỏ sót, nghe nhầm hoặc viết sai khi làm Dictation'
                                            : 'Exact words you frequently miss, substitute, or misspell during dictation'}
                                    </p>
                                </div>
                            </div>

                            {!hasDetailedErrors ? (
                                <StatePanel icon={<AlertCircle size={24} />} title={vi ? 'Chưa đủ dữ liệu để phân tích lỗi chi tiết.' : 'Insufficient data for detailed error diagnosis.'} />
                            ) : (
                                <div className={s.errGrid}>
                                    <WordCard tone="news" icon={<VolumeX size={16} />} title={vi ? 'Bỏ sót nhiều nhất' : 'Most Missed'} empty={vi ? 'Không có từ bị bỏ sót' : 'No missing words'}
                                        rows={topMissingWords.map(item => ({ key: item.word, word: <span className={s.errWord}>{item.word}</span>, count: item.count }))} times={times} />
                                    <WordCard tone="work" icon={<Shuffle size={16} />} title={vi ? 'Nghe nhầm / Thay thế' : 'Substitutions'} empty={vi ? 'Không có từ nghe nhầm' : 'No substitutions'}
                                        rows={topSubstitutions.map(item => ({ key: item.expectedWord + item.userWord, word: <span><span className={s.errWord}>{item.expectedWord}</span><span className={s.arrow}>→</span><span style={{ color: 'var(--bad)' }} className="font-bold">{item.userWord}</span></span>, count: item.count }))} times={times} />
                                    <WordCard tone="talks" icon={<PlusCircle size={16} />} title={vi ? 'Viết thừa' : 'Extra Words'} empty={vi ? 'Không có từ viết thừa' : 'No extra words'}
                                        rows={topExtraWords.map(item => ({ key: item.word, word: <span className={s.errWord}>{item.word}</span>, count: item.count }))} times={times} />
                                    <WordCard tone="everyday" icon={<SpellCheck size={16} />} title={vi ? 'Lỗi chính tả' : 'Spelling Errors'} empty={vi ? 'Không có lỗi chính tả' : 'No spelling errors'}
                                        rows={topSpellingErrors.map(item => ({ key: item.expectedWord + item.userWord, word: <span><span className={s.errWord}>{item.expectedWord}</span><span className={s.arrow}>→</span><span style={{ color: 'var(--warn)' }} className="font-bold underline">{item.userWord}</span></span>, count: item.count }))} times={times} />
                                </div>
                            )}
                        </section>

                        {/* 3. Representative incorrect attempts (server-aligned word diffs) */}
                        {representativeErrors && representativeErrors.length > 0 && (
                            <section className="flex flex-col gap-4" aria-labelledby="ls-reps">
                                <div className={`${s.sectionHead} ec-wp-plate`}>
                                    <div>
                                        <h2 id="ls-reps" className={`${s.sectionTitle} inline-flex items-center gap-2`}>
                                            <HelpCircle size={22} aria-hidden="true" style={{ color: 'var(--wink)' }} />
                                            {vi ? 'Những câu bạn thường gặp lỗi' : 'Representative Incorrect Attempts'}
                                        </h2>
                                        <p className={s.sectionLead}>
                                            {vi
                                                ? 'So sánh trực quan giữa câu phát âm đúng và câu bạn đã gõ'
                                                : 'Visual comparison of expected audio sentences and your typed answers'}
                                        </p>
                                    </div>
                                </div>

                                <div className="flex flex-col gap-3">
                                    {representativeErrors.map((rep: RepresentativeErrorItem, idx: number) => (
                                        <article key={idx} className={`${s.panel} ${s.rep}`}>
                                            <div className={s.repLine}>
                                                <span style={{ color: 'var(--ok)' }}>{vi ? 'Câu đúng' : 'Expected'}</span>
                                                <span className="font-semibold">&ldquo;{rep.expectedSentence}&rdquo;</span>
                                            </div>
                                            <div className={s.repLine}>
                                                <span>{vi ? 'Bạn nhập' : 'You typed'}</span>
                                                <span>&ldquo;{rep.rawUserAnswer || <i>(trống)</i>}&rdquo;</span>
                                            </div>
                                            <div className={s.diffs} aria-label={vi ? 'Chi tiết khác biệt từng từ' : 'Word-by-word differences'}>
                                                {rep.alignedDiffs.map((diff: AlignedDiffItem, dIdx: number) => {
                                                    const type = ['MATCH', 'MISSING', 'EXTRA', 'SPELLING'].includes(diff.type) ? diff.type : 'SUBSTITUTION';
                                                    return (
                                                        <span key={dIdx} className={s.diff} data-t={type}>
                                                            {type === 'MATCH' && <span>{diff.expectedWord}</span>}
                                                            {type === 'MISSING' && <span className="line-through">{diff.expectedWord}</span>}
                                                            {type === 'EXTRA' && <span className="font-bold">+{diff.userWord}</span>}
                                                            {(type === 'SPELLING' || type === 'SUBSTITUTION') && (
                                                                <span>{diff.expectedWord}<span className={s.arrow}>→</span><span className={type === 'SPELLING' ? 'underline' : 'font-bold'}>{diff.userWord}</span></span>
                                                            )}
                                                            {type !== 'MATCH' && diff.label && <small>{diff.label}</small>}
                                                        </span>
                                                    );
                                                })}
                                            </div>
                                        </article>
                                    ))}
                                </div>
                            </section>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}

function WordCard({ tone, icon, title, empty, rows, times }: { tone: string; icon: React.ReactNode; title: string; empty: string; rows: { key: string; word: React.ReactNode; count: number }[]; times: string }) {
    return (
        <section className={`${s.panel} ${s.errCard}`} data-tone={tone}>
            <h3 className={s.cardTitleSm}>
                <span className={s.glyph} aria-hidden="true">{icon}</span>
                <span className="text-sm">{title}</span>
            </h3>
            {rows.length === 0 ? (
                <p className={`${s.muted} text-sm`}>{empty}</p>
            ) : (
                <ul className={s.errList}>
                    {rows.map(row => (
                        <li key={row.key}>
                            {row.word}
                            <span className={s.errCount}>{row.count} {times}</span>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}
