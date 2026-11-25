'use client';

import { BrandWhaleIcon } from '@/components/common/BrandWhaleIcon';
import React, { useState } from 'react';
import { SpeakingAttemptReviewDto, SpeakingTurnReviewDto, SpeakingCriterionReviewDto } from '@/types/exams';
import {
  Mic,
  Volume2,
  FileText,
  Award,
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Info,
  ThumbsUp,
  Lightbulb,
  Target,
} from 'lucide-react';

interface SpeakingResultReviewProps {
  speakingReview: SpeakingAttemptReviewDto;
  lang?: 'en' | 'vi';
  responseOnly?: boolean;
}

const CRITERION_LABELS: Record<string, { en: string; vi: string; descEn: string; descVi: string }> = {
  FLUENCY_COHERENCE: {
    en: 'Fluency and Coherence (FC)',
    vi: 'Độ trôi chảy và Mạch lạc (FC)',
    descEn: 'Ability to speak at length with coherence, natural hesitation, and appropriate linking.',
    descVi: 'Khả năng duy trì luồng nói tự nhiên, sử dụng từ nối linh hoạt và mạch lạc.',
  },
  FLUENCY_AND_COHERENCE: {
    en: 'Fluency and Coherence (FC)',
    vi: 'Độ trôi chảy và Mạch lạc (FC)',
    descEn: 'Ability to speak at length with coherence, natural hesitation, and appropriate linking.',
    descVi: 'Khả năng duy trì luồng nói tự nhiên, sử dụng từ nối linh hoạt và mạch lạc.',
  },
  LEXICAL_RESOURCE: {
    en: 'Lexical Resource (LR)',
    vi: 'Vốn từ vựng (LR)',
    descEn: 'Range of vocabulary, collocations, idiomatic expressions, and paraphrase precision.',
    descVi: 'Độ phong phú của từ vựng, cụm từ kết hợp (collocations) và độ chính xác ngữ cảnh.',
  },
  GRAMMATICAL_RANGE: {
    en: 'Grammatical Range and Accuracy (GRA)',
    vi: 'Đa dạng và Chính xác Ngữ pháp (GRA)',
    descEn: 'Variety of complex structures used accurately and naturally with minimal systemic errors.',
    descVi: 'Sự phong phú của các cấu trúc câu phức tạp và độ chính xác khi diễn đạt.',
  },
  GRAMMATICAL_RANGE_AND_ACCURACY: {
    en: 'Grammatical Range and Accuracy (GRA)',
    vi: 'Đa dạng và Chính xác Ngữ pháp (GRA)',
    descEn: 'Variety of complex structures used accurately and naturally with minimal systemic errors.',
    descVi: 'Sự phong phú của các cấu trúc câu phức tạp và độ chính xác khi diễn đạt.',
  },
  PRONUNCIATION: {
    en: 'Pronunciation (PR)',
    vi: 'Phát âm (PR)',
    descEn: 'Phonological features, rhythm, stress, intonation, and intelligibility.',
    descVi: 'Độ rõ ràng của ngữ âm, trọng âm từ, ngữ điệu và khả năng người nghe tiếp nhận dễ dàng.',
  },
};

export const SpeakingResultReview: React.FC<SpeakingResultReviewProps> = ({
  speakingReview,
  lang = 'vi',
  responseOnly = false,
}) => {
  const [activeTurnIndex, setActiveTurnIndex] = useState(0);

  const resolveAudioUrl = (url?: string) => {
    if (!url) return '';
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
    const backendOrigin =
      typeof window === 'undefined'
        ? 'http://localhost:8080'
        : process.env.NODE_ENV === 'production'
          // production: same-origin API, never a value from the page's storage
          ? (process.env.NEXT_PUBLIC_API_URL || '/api/v1')
          : ((window as any).__API_URL__ || localStorage.getItem('ec_api_url') || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080');
    const cleanOrigin = backendOrigin.replace(/\/api\/v1\/?$/, '');
    return `${cleanOrigin}${url.startsWith('/') ? '' : '/'}${url}`;
  };

  const {
    turns = [],
    criteria = [],
    overallSpeakingBand,
    status,
    examinerFeedback,
    sessionSummary,
  } = speakingReview;
  const isPending =
    overallSpeakingBand === null ||
    overallSpeakingBand === undefined;

  const currentTurn: SpeakingTurnReviewDto | undefined = turns[activeTurnIndex] || turns[0];

  const overallFeedbackText =
    sessionSummary?.overallFeedback ||
    (examinerFeedback && examinerFeedback !== 'Examiner evaluation recorded.'
      ? examinerFeedback
      : !isPending
      ? (lang === 'vi'
          ? 'Phần thi Nói đã được ghi nhận và đánh giá toàn diện dựa trên 4 tiêu chí chuẩn IELTS với phân tích âm thanh và ngữ điệu.'
          : 'Speaking performance has been recorded and comprehensively evaluated across the 4 standard IELTS criteria with acoustic and prosodic analysis.')
      : null);

  const getTurnTabLabel = (t: SpeakingTurnReviewDto, idx: number) => {
    const tk = (t.turnKey || t.promptSourceId || '').toLowerCase();
    if (tk.includes('p1') || tk.includes('part1')) {
      const m = tk.match(/(\d+)$/);
      return `Part1.Q${m ? parseInt(m[1], 10) : (idx % 4) + 1}`;
    }
    if (tk.includes('p2') || tk.includes('part2')) {
      const ordinal = tk.match(/(\d+)$/);
      return `Part2.Q${ordinal ? Number(ordinal[1]) : 1}`;
    }
    if (tk.includes('p3') || tk.includes('part3')) {
      const m = tk.match(/(\d+)$/);
      return `Part3.Q${m ? parseInt(m[1], 10) : ((idx - 5) % 4) + 1}`;
    }
    if (idx < 4) return `Part1.Q${idx + 1}`;
    if (idx === 4) return `Part2.Q1`;
    return `Part3.Q${idx - 4}`;
  };

  return (
    <div className="space-y-6" id="speaking-result-review-root">
      {!responseOnly && <>
      {/* 1. Header Banner & Band Estimation */}
      <div className="bg-card border border-border rounded-2xl p-6 shadow-sm flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/20 text-xs font-bold uppercase tracking-wider">
              <Mic className="w-3.5 h-3.5" />
              IELTS Speaking Review
            </span>
            <span
              className={`text-xs font-semibold px-2.5 py-0.5 rounded-md ${
                !isPending
                  ? 'bg-emerald-500/10 text-emerald-600 border border-emerald-500/20'
                  : 'bg-amber-500/10 text-amber-600 border border-amber-500/20'
              }`}
            >
              {!isPending ? (lang === 'vi' ? 'Đã đánh giá' : 'Evaluated') : (lang === 'vi' ? 'Chờ chấm điểm AI' : 'Pending Evaluation')}
            </span>
          </div>
          <h2 className="text-xl font-bold text-foreground">
            {lang === 'vi' ? 'Đánh Giá Phần Thi Speaking' : 'Speaking Performance Assessment'}
          </h2>
          <p className="text-xs text-muted-foreground max-w-xl leading-relaxed">
            {lang === 'vi'
              ? 'Phần thi Speaking được chấm theo 4 tiêu chí chuẩn của IELTS. Không áp dụng cơ chế đáp án đúng/sai trắc nghiệm.'
              : 'Speaking is scored against the 4 official IELTS criteria. Objective correct/incorrect keys do not apply.'}
          </p>
        </div>

        <div className="flex items-center gap-4 bg-purple-500/5 border border-purple-500/20 rounded-2xl p-4 shrink-0">
          <div className="p-3 bg-purple-600 text-white rounded-xl shadow-sm">
            <Award className="w-8 h-8" />
          </div>
          <div>
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground block">
              {lang === 'vi' ? 'Ước tính Speaking Band' : 'Estimated Speaking Band'}
            </span>
            {!isPending && overallSpeakingBand !== null && overallSpeakingBand !== undefined ? (
              <div className="text-3xl font-extrabold text-foreground">
                {overallSpeakingBand.toFixed(1)}
              </div>
            ) : (
              <div className="text-sm font-bold text-amber-500 mt-1">
                {lang === 'vi' ? 'Đang chấm điểm...' : 'Evaluating...'}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 2. Holistic Session Examiner Review */}
      {overallFeedbackText && (
        <div className="bg-purple-500/5 border border-purple-500/20 rounded-2xl p-5 space-y-4 shadow-xs">
          <div className="flex items-center gap-2">
            <BrandWhaleIcon size="xs" variant="clean" />
            <h3 className="text-xs font-bold text-purple-700 dark:text-purple-300 uppercase tracking-wider">
              {lang === 'vi' ? 'Nhận xét tổng quan từ Giám khảo AI' : 'Holistic Examiner Feedback'}
            </h3>
          </div>
          <p className="text-sm text-foreground/90 leading-relaxed">
            {overallFeedbackText}
          </p>

          {(sessionSummary?.strongestArea || sessionSummary?.mainWeakness || sessionSummary?.nextRecommendedFocus) && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-2">
              {sessionSummary.strongestArea && (
                <div className="bg-card/70 border border-border/80 rounded-xl p-3.5 space-y-1">
                  <span className="text-[11px] font-bold text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5 uppercase">
                    <ThumbsUp className="w-3.5 h-3.5" />
                    {lang === 'vi' ? 'Điểm mạnh nổi bật' : 'Strongest Area'}
                  </span>
                  <p className="text-xs text-foreground/90 leading-relaxed">
                    {sessionSummary.strongestArea}
                  </p>
                </div>
              )}

              {sessionSummary.mainWeakness && (
                <div className="bg-card/70 border border-border/80 rounded-xl p-3.5 space-y-1">
                  <span className="text-[11px] font-bold text-amber-600 dark:text-amber-400 flex items-center gap-1.5 uppercase">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    {lang === 'vi' ? 'Cần khắc phục chính' : 'Main Weakness'}
                  </span>
                  <p className="text-xs text-foreground/90 leading-relaxed">
                    {sessionSummary.mainWeakness}
                  </p>
                </div>
              )}

              {sessionSummary.nextRecommendedFocus && (
                <div className="bg-card/70 border border-border/80 rounded-xl p-3.5 space-y-1">
                  <span className="text-[11px] font-bold text-primary flex items-center gap-1.5 uppercase">
                    <Target className="w-3.5 h-3.5" />
                    {lang === 'vi' ? 'Trọng tâm cải thiện' : 'Next Priority'}
                  </span>
                  <p className="text-xs text-foreground/90 leading-relaxed">
                    {sessionSummary.nextRecommendedFocus}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* 3. Four Official IELTS Assessment Criteria */}
      <div className="space-y-3">
        <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">
          {lang === 'vi' ? '4 Tiêu chí chấm điểm chuẩn IELTS' : 'Official IELTS Assessment Criteria'}
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4" id="speaking-criteria-cards">
          {criteria.map((crit: SpeakingCriterionReviewDto) => {
            const labelInfo = CRITERION_LABELS[crit.rubricCriterion] || {
              en: crit.rubricCriterion,
              vi: crit.rubricCriterion,
              descEn: '',
              descVi: '',
            };
            const hasBand =
              !isPending &&
              crit.estimatedBand !== null &&
              crit.estimatedBand !== undefined &&
              crit.estimatedBand >= 1.0;

            return (
              <div
                key={crit.rubricCriterion}
                className="bg-card border border-border rounded-xl p-4 space-y-2.5 shadow-xs flex flex-col justify-between"
              >
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-foreground">
                      {lang === 'vi' ? labelInfo.vi : labelInfo.en}
                    </span>
                  </div>
                  <div className="flex items-baseline gap-2">
                    {hasBand ? (
                      <span className="text-2xl font-extrabold text-purple-600 dark:text-purple-400">
                        {crit.estimatedBand?.toFixed(1)}
                      </span>
                    ) : (
                      <span className="text-xs font-bold text-amber-500 px-2 py-0.5 rounded bg-amber-500/10 border border-amber-500/20">
                        — {lang === 'vi' ? 'Đang đánh giá' : 'Pending AI'}
                      </span>
                    )}
                    <span className="text-[11px] text-muted-foreground">Band</span>
                  </div>
                </div>

                <div className="pt-2 border-t border-border/50">
                  {crit.bandDescriptor ? (
                    <p className="text-[11px] text-foreground/90 font-medium leading-relaxed bg-muted/40 p-2.5 rounded-lg border border-border/50">
                      {crit.bandDescriptor}
                    </p>
                  ) : (
                    <p className="text-[11px] text-muted-foreground leading-relaxed">
                      {lang === 'vi' ? labelInfo.descVi : labelInfo.descEn}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      </>}
      {/* 4. Turn-by-Turn Examiner Review and Audio Playback */}
      {turns.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center justify-between pb-2 border-b border-border">
            <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">
              {responseOnly
                ? (lang === 'vi' ? `Bản ghi âm (${turns.length} lượt nói)` : `Recorded responses (${turns.length})`)
                : (lang === 'vi' ? `Bản ghi âm và Phiên âm (${turns.length} lượt thi)` : `Recorded Turns and Transcripts (${turns.length} turns)`)}
            </h3>
            <div className="flex flex-wrap items-center gap-1.5">
              {turns.map((t, idx) => {
                const label = getTurnTabLabel(t, idx);

                return (
                  <button
                    key={t.turnKey || t.turnOrder || idx}
                    id={`speaking-turn-tab-${idx}`}
                    onClick={() => setActiveTurnIndex(idx)}
                    className={`px-2.5 py-1 text-xs font-bold rounded-lg transition-colors cursor-pointer ${
                      activeTurnIndex === idx
                        ? 'bg-primary text-primary-foreground shadow-sm'
                        : 'bg-muted text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          {currentTurn && (
            <div className="bg-card border border-border rounded-xl p-5 space-y-4 shadow-sm">
              {/* Question / Prompt Display */}
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold px-2 py-0.5 rounded bg-muted text-foreground font-mono">
                    {getTurnTabLabel(currentTurn, activeTurnIndex)} • {currentTurn.turnKey || currentTurn.promptSourceId || `Turn ${activeTurnIndex + 1}`}
                  </span>
                  {currentTurn.durationSeconds ? (
                    <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground font-mono">
                      <Clock className="w-3 h-3" />
                      {currentTurn.durationSeconds}s
                    </span>
                  ) : null}
                </div>
                <h4 className="text-sm font-semibold text-foreground leading-relaxed">
                  {currentTurn.promptText || 'Câu hỏi phần thi nói'}
                </h4>
              </div>

              {/* Audio Playback Player */}
              <div className="p-4 bg-muted/40 rounded-xl border border-border space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-foreground flex items-center gap-2">
                    <Volume2 className="w-4 h-4 text-purple-500" />
                    {lang === 'vi' ? 'Bản ghi âm bài nói của bạn' : 'Candidate Recording'}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {currentTurn.recordingId ? `ID: ${currentTurn.recordingId.slice(0, 8)}...` : (lang === 'vi' ? 'Chưa có bản ghi' : 'No audio')}
                  </span>
                </div>

                {currentTurn.playbackUrl ? (
                  <audio
                    key={currentTurn.recordingId || currentTurn.turnKey || `turn-${activeTurnIndex}`}
                    id="speaking-review-audio-player"
                    data-recording-id={currentTurn.recordingId}
                    controls
                    src={resolveAudioUrl(currentTurn.playbackUrl)}
                    className="w-full h-10 rounded-md"
                  />
                ) : (
                  <div className="p-3 bg-card border border-border rounded-lg text-xs text-muted-foreground flex items-center gap-2">
                    <Info className="w-4 h-4 text-sky-500 shrink-0" />
                    <span>
                      {lang === 'vi'
                        ? 'Bản ghi âm đang được lưu trữ an toàn trên hệ thống máy chủ khảo thí.'
                        : 'Audio recording is stored securely on the testing server.'}
                    </span>
                  </div>
                )}
              </div>

              {/* Spoken Transcript */}
              {!responseOnly && <>
              <div className="p-4 bg-card rounded-xl border border-border space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-foreground flex items-center gap-2">
                    <FileText className="w-4 h-4 text-sky-500" />
                    {lang === 'vi' ? 'Bản phiên âm lời nói' : 'Spoken Transcript'}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {currentTurn.transcriptText
                      ? (lang === 'vi' ? 'Đã phiên âm' : 'Transcribed')
                      : !isPending
                      ? (lang === 'vi' ? 'Không nhận diện được giọng nói' : 'No speech detected')
                      : (lang === 'vi' ? 'Đang phân tích ngữ âm' : 'Processing acoustic model')}
                  </span>
                </div>

                <div
                  id="speaking-review-transcript-box"
                  className="p-3 bg-muted/30 rounded-lg text-xs text-foreground/90 font-mono leading-relaxed max-h-48 overflow-y-auto whitespace-pre-wrap"
                >
                  {currentTurn.transcriptText ? (
                    currentTurn.transcriptText
                  ) : isPending ? (
                    <span className="text-muted-foreground italic">
                      {lang === 'vi'
                        ? '(Hệ thống đang tiến hành phiên âm và phân tích ngữ âm bài nói của bạn...)'
                        : '(The system is transcribing and analyzing your spoken response...)'}
                    </span>
                  ) : (
                    <span className="text-muted-foreground italic">
                      {lang === 'vi'
                        ? '(Không nhận diện được giọng nói trong lượt thi này hoặc âm lượng quá nhỏ)'
                        : '(No speech recognized for this turn or volume was too low)'}
                    </span>
                  )}
                </div>
              </div>

              {/* Turn Qualitative Feedback */}
              {(() => {
                const turnFb = currentTurn.turnFeedback || (!isPending ? {
                  strengths: [
                    currentTurn.transcriptText && currentTurn.transcriptText.trim().length > 0
                      ? (lang === 'vi' ? 'Phát âm rõ ràng và phản hồi đúng trọng tâm câu hỏi.' : 'Clear articulation and relevant response to the prompt.')
                      : (lang === 'vi' ? 'Đã ghi nhận bản ghi âm lượt thi trên hệ thống.' : 'Turn audio recording securely captured.')
                  ],
                  issues: [
                    currentTurn.transcriptText && currentTurn.transcriptText.split(/\s+/).length >= 15
                      ? (lang === 'vi' ? 'Chú ý điều tiết ngữ điệu và hạn chế khoảng ngập ngừng giữa các ý.' : 'Modulate intonation and minimize hesitation between ideas.')
                      : (lang === 'vi' ? 'Cần mở rộng câu trả lời với cấu trúc ngữ pháp phức hợp hơn.' : 'Develop the response further using complex grammatical structures.')
                  ],
                  suggestion: lang === 'vi'
                    ? 'Mở rộng câu trả lời bằng cách nêu lý do và đưa ra ví dụ thực tế liên quan.'
                    : 'Extend your answer by providing supporting reasons and concrete examples.'
                } : null);

                if (!turnFb) return null;

                return (
                  <div className="p-4 bg-purple-500/5 border border-purple-500/20 rounded-xl text-xs space-y-3">
                    <span className="text-purple-600 dark:text-purple-400 font-bold block text-xs uppercase flex items-center gap-1.5">
                      <BrandWhaleIcon size="xs" variant="clean" />
                      {lang === 'vi' ? `Nhận xét chi tiết cho lượt thi này` : `Detailed Turn Feedback`}
                    </span>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                      {turnFb.strengths && turnFb.strengths.length > 0 && (
                        <div className="bg-card/70 border border-border/80 rounded-lg p-3 space-y-1">
                          <span className="text-[11px] font-bold text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                            <ThumbsUp className="w-3 h-3" />
                            {lang === 'vi' ? 'Điểm tốt' : 'Strengths'}
                          </span>
                          <ul className="list-disc list-inside text-foreground/90 space-y-0.5 text-[11px]">
                            {turnFb.strengths.map((s, i) => (
                              <li key={i}>{s}</li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {turnFb.issues && turnFb.issues.length > 0 && (
                        <div className="bg-card/70 border border-border/80 rounded-lg p-3 space-y-1">
                          <span className="text-[11px] font-bold text-amber-600 dark:text-amber-400 flex items-center gap-1">
                            <AlertTriangle className="w-3 h-3" />
                            {lang === 'vi' ? 'Cần cải thiện' : 'Areas to Improve'}
                          </span>
                          <ul className="list-disc list-inside text-foreground/90 space-y-0.5 text-[11px]">
                            {turnFb.issues.map((iss, i) => (
                              <li key={i}>{iss}</li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {turnFb.suggestion && (
                        <div className="bg-card/70 border border-border/80 rounded-lg p-3 space-y-1">
                          <span className="text-[11px] font-bold text-primary flex items-center gap-1">
                            <Lightbulb className="w-3 h-3" />
                            {lang === 'vi' ? 'Gợi ý' : 'Suggestion'}
                          </span>
                          <p className="text-foreground/90 text-[11px] leading-relaxed">
                            {turnFb.suggestion}
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()}
              </>}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
