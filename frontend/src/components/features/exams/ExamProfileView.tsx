'use client';

import React, { useState } from 'react';
import {
  IeltsProfileDto,
  ToeicProfileDto,
  MetricSummaryDto,
  ExamFamily,
} from '@/types/exams';
import { EXAM_LABELS } from '@/lib/exams/labels';
import { useLanguage } from '@/context/LanguageContext';
import { BackButton } from './BackButton';
import {
  TrendingUp,
  TrendingDown,
  Minus,
  Award,
  Calendar,
  ExternalLink,
  ShieldCheck,
  AlertCircle,
  BookOpen,
  Headphones,
  PenTool,
  Mic,
  GraduationCap,
  Play,
  ArrowRight,
  Info,
  CheckCircle2,
} from 'lucide-react';
import Link from 'next/link';

interface ExamProfileViewProps {
  initialFamily?: ExamFamily;
  ieltsProfile?: IeltsProfileDto | null;
  toeicProfile?: ToeicProfileDto | null;
  lang?: 'en' | 'vi';
}

export const ExamProfileView: React.FC<ExamProfileViewProps> = ({
  initialFamily = 'IELTS',
  ieltsProfile,
  toeicProfile,
  lang: propLang,
}) => {
  const { language } = useLanguage();
  const lang = propLang || language || 'vi';
  const t = EXAM_LABELS[lang] || EXAM_LABELS.vi;
  const [selectedFamily, setSelectedFamily] = useState<ExamFamily>(initialFamily);
  const [trendSkill, setTrendSkill] = useState<'OVERALL' | 'LISTENING' | 'READING' | 'WRITING' | 'SPEAKING'>('OVERALL');

  const isIelts = selectedFamily === 'IELTS';
  const ieltsObservations = ieltsProfile?.observations || [];
  const toeicObservations = toeicProfile?.observations || [];
  const hasVerifiedObservations = isIelts ? ieltsObservations.length > 0 : toeicObservations.length > 0;

  const renderTrendIcon = (direction?: string) => {
    switch (direction?.toUpperCase()) {
      case 'UP':
        return <TrendingUp className="w-4 h-4 text-emerald-500" />;
      case 'DOWN':
        return <TrendingDown className="w-4 h-4 text-rose-500" />;
      default:
        return <Minus className="w-4 h-4 text-muted-foreground" />;
    }
  };

  const renderMetricCard = (title: string, summary?: MetricSummaryDto, isBand: boolean = false) => {
    if (!summary || summary.latest === undefined || summary.latest === null) {
      return (
        <div className="bg-card border border-border rounded-2xl p-5 space-y-2 shadow-sm">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {title}
          </span>
          <div className="text-2xl font-bold text-muted-foreground/50">
            --
          </div>
          <p className="text-[11px] text-muted-foreground/80">
            {lang === 'vi' ? 'Chưa có bằng chứng thi thử' : 'No verified simulation evidence'}
          </p>
        </div>
      );
    }

    return (
      <div className="bg-card border border-border rounded-2xl p-5 space-y-3 shadow-sm hover:border-primary/40 transition-colors">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {title}
          </span>
          {renderTrendIcon(summary.trendDirection)}
        </div>

        <div className="grid grid-cols-2 gap-2 pt-1 border-t border-border/50">
          <div>
            <span className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground block">
              {lang === 'vi' ? 'MỚI NHẤT' : 'LATEST'}
            </span>
            <span className="text-2xl font-black text-foreground">
              {isBand ? summary.latest.toFixed(1) : summary.latest}
            </span>
          </div>
          <div>
            <span className="text-[10px] uppercase font-bold tracking-wider text-primary block">
              {lang === 'vi' ? 'CAO NHẤT' : 'BEST'}
            </span>
            <span className="text-2xl font-black text-primary">
              {summary.best !== undefined && summary.best !== null
                ? (isBand ? summary.best.toFixed(1) : summary.best)
                : '--'}
            </span>
          </div>
        </div>

        {summary.latestDate && (
          <div className="text-[11px] text-muted-foreground flex items-center gap-1 pt-1">
            <Calendar className="w-3 h-3" />
            <span>{new Date(summary.latestDate).toLocaleDateString()}</span>
          </div>
        )}
      </div>
    );
  };

  const renderTrendChart = (points: Array<{ date: string; score: number }>, maxScore: number = 9) => {
    if (points.length < 2) {
      return (
        <div className="p-8 text-center text-xs text-muted-foreground bg-muted/20 border border-dashed border-border rounded-xl">
          {lang === 'vi'
            ? 'Cần ít nhất 2 kết quả Exam Simulation hợp lệ để vẽ biểu đồ xu hướng dài hạn.'
            : 'At least two verified simulation attempts are required to compute longitudinal trend slope.'}
        </div>
      );
    }

    // Always sort chronologically ASCENDING (oldest to newest)
    const sortedPoints = [...points].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
    );

    const width = 600;
    const height = 180;
    const padding = 36;

    // Distribute evenly by chronological sequence so attempts on the same day remain distinct
    const coords = sortedPoints.map((p, idx) => {
      const x =
        sortedPoints.length > 1
          ? padding + (idx / (sortedPoints.length - 1)) * (width - 2 * padding)
          : width / 2;
      const y = height - padding - (Math.min(maxScore, Math.max(0, p.score)) / maxScore) * (height - 2 * padding);
      return { x, y, score: p.score, date: p.date };
    });

    const pathD = coords.reduce((acc, pt, idx) => {
      return `${acc} ${idx === 0 ? 'M' : 'L'} ${pt.x} ${pt.y}`;
    }, '');

    return (
      <div className="space-y-3">
        <div className="bg-card border border-border rounded-xl p-4 overflow-x-auto">
          <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-44">
            {[0.25, 0.5, 0.75, 1.0].map((ratio) => {
              const y = height - padding - ratio * (height - 2 * padding);
              return (
                <line
                  key={ratio}
                  x1={padding}
                  y1={y}
                  x2={width - padding}
                  y2={y}
                  stroke="currentColor"
                  strokeOpacity="0.1"
                  strokeDasharray="4 4"
                />
              );
            })}

            <path
              d={pathD}
              fill="none"
              stroke="var(--primary, #3b82f6)"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />

            {coords.map((pt, i) => (
              <g key={i}>
                <circle
                  cx={pt.x}
                  cy={pt.y}
                  r="4.5"
                  fill="var(--background, #ffffff)"
                  stroke="var(--primary, #3b82f6)"
                  strokeWidth="2.5"
                />
                <text
                  x={pt.x}
                  y={pt.y - 8}
                  textAnchor="middle"
                  className="text-[11px] font-mono font-bold fill-foreground"
                >
                  {pt.score.toFixed(1)}
                </text>
                <text
                  x={pt.x}
                  y={height - padding + 16}
                  textAnchor="middle"
                  className="text-[10px] font-mono fill-muted-foreground"
                >
                  {new Date(pt.date).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })}
                </text>
              </g>
            ))}
          </svg>
        </div>
      </div>
    );
  };

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-8">
      {/* 1. Back Navigation & Family Selector */}
      <div className="flex flex-col gap-4">
        <div>
          <BackButton
            href="/exams"
            label={t.backToExams || (lang === 'vi' ? 'Quay lại Trung tâm Khảo thí' : 'Back to Exams')}
          />
        </div>

        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 border-b border-border pb-6">
          <div>
            <span className="text-xs font-semibold tracking-wider text-primary uppercase">
              {lang === 'vi' ? 'Hồ sơ Năng lực Khảo thí Chính thức' : 'Official Assessment Registry'}
            </span>
            <h1 className="text-2xl font-bold text-foreground mt-1">
              {t.profileTitle}
            </h1>
            <p className="text-xs text-muted-foreground mt-1 max-w-xl">
              {t.profileDesc}
            </p>
          </div>

          <div className="flex items-center p-1 bg-muted rounded-xl border border-border">
            <button
              id="profile-family-ielts-btn"
              onClick={() => setSelectedFamily('IELTS')}
              className={`px-5 py-2 text-xs font-bold rounded-lg transition-all ${
                selectedFamily === 'IELTS'
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              IELTS Profile
            </button>
            <button
              id="profile-family-toeic-btn"
              onClick={() => setSelectedFamily('TOEIC')}
              className={`px-5 py-2 text-xs font-bold rounded-lg transition-all ${
                selectedFamily === 'TOEIC'
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              TOEIC Profile
            </button>
          </div>
        </div>
      </div>

      {/* 2. Empathetic Empty State (when no trusted simulation exists) */}
      {!hasVerifiedObservations && (
        <div className="bg-card border border-border rounded-2xl p-8 space-y-6 text-center max-w-3xl mx-auto shadow-sm">
          <div className="w-16 h-16 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center mx-auto text-primary">
            <ShieldCheck className="w-8 h-8" />
          </div>

          <div className="space-y-2 max-w-lg mx-auto">
            <h2 className="text-xl font-bold text-foreground">
              {t.noVerifiedEvidence || (lang === 'vi' ? 'Chưa có kết quả Exam Simulation được xác minh.' : 'No verified Exam Simulation results yet.')}
            </h2>
            <p className="text-xs text-muted-foreground leading-relaxed">
              {t.noVerifiedEvidenceDesc || (lang === 'vi'
                ? 'Kết quả Practice không được tính vào Hồ sơ năng lực chính thức. Hãy hoàn thành một bài Exam Simulation hợp lệ để bắt đầu xây dựng hồ sơ của bạn.'
                : 'Practice attempts are excluded from your official competency profile. Complete an eligible Exam Simulation to establish your verified profile.')}
            </p>
          </div>

          {/* Action Call to Action buttons */}
          <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
            <Link
              href="/exams/ielts"
              className="inline-flex items-center gap-2 px-5 py-2.5 bg-primary text-primary-foreground text-xs font-bold rounded-xl hover:bg-primary/90 transition-all shadow-sm"
            >
              <Play className="w-3.5 h-3.5 fill-current" />
              {t.takeIeltsSim || (lang === 'vi' ? 'Thi thử IELTS' : 'Take IELTS Simulation')}
            </Link>

            <Link
              href="/exams/toeic"
              className="inline-flex items-center gap-2 px-5 py-2.5 bg-secondary text-secondary-foreground text-xs font-bold rounded-xl hover:bg-secondary/80 transition-all"
            >
              <Play className="w-3.5 h-3.5 fill-current" />
              {t.takeToeicSim || (lang === 'vi' ? 'Thi thử TOEIC' : 'Take TOEIC Simulation')}
            </Link>
          </div>

          <div className="p-4 bg-muted/40 rounded-xl text-left border border-border/60 text-xs text-muted-foreground flex items-start gap-3">
            <Info className="w-4 h-4 text-primary shrink-0 mt-0.5" />
            <div className="space-y-1">
              <strong className="text-foreground">
                {lang === 'vi' ? 'Quy chuẩn Minh bạch Bằng chứng Khảo thí:' : 'Evidence Truthfulness Standard:'}
              </strong>
              <p>
                {lang === 'vi'
                  ? 'Chế độ Exam Simulation áp dụng thời gian nghiêm ngặt và không hiển thị đáp án trong lúc làm bài. Dữ liệu ghi nhận từ Exam Simulation thể hiện Bằng chứng Mô phỏng (Simulation Evidence) phục vụ theo dõi năng lực học viên. Điểm số chuẩn hóa chính thức (Official Calibrated Score) chỉ áp dụng khi có bảng quy đổi equating/calibration đã qua phê duyệt xác thực.'
                  : 'Exam Simulation enforces strict timed conditions and conceals answers during testing. Scores recorded from Exam Simulation represent Simulation Evidence for tracking learner performance. Official calibrated scaled scores require verified equating/calibration packages.'}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* 3. IELTS Profile Verified Section */}
      {selectedFamily === 'IELTS' && hasVerifiedObservations && (
        <div className="space-y-8">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
            {renderMetricCard(lang === 'vi' ? 'Điểm Tổng' : 'Overall Band', ieltsProfile?.overall, true)}
            {renderMetricCard(lang === 'vi' ? 'Nghe' : 'Listening', ieltsProfile?.listening, true)}
            {renderMetricCard(lang === 'vi' ? 'Đọc' : 'Reading', ieltsProfile?.reading, true)}
            {renderMetricCard(lang === 'vi' ? 'Viết' : 'Writing', ieltsProfile?.writing, true)}
            {renderMetricCard(lang === 'vi' ? 'Nói' : 'Speaking', ieltsProfile?.speaking, true)}
          </div>

          <div className="bg-card border border-border rounded-2xl p-6 space-y-4 shadow-sm">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <h3 className="text-base font-bold text-foreground">
                  {lang === 'vi' ? 'Xu hướng Năng lực Dài hạn' : 'Longitudinal Performance Trend'}
                </h3>
                <p className="text-xs text-muted-foreground">
                  {lang === 'vi'
                    ? 'Điểm số qua các kỳ thi thử mô phỏng chính thức đã hoàn thành theo trình tự thời gian.'
                    : 'Scores across consecutive verified simulation attempts in chronological sequence.'}
                </p>
              </div>
              <div className="flex items-center gap-3">
                {/* Skill Toggles */}
                <div className="flex items-center p-1 bg-muted rounded-xl border border-border">
                  {(['OVERALL', 'LISTENING', 'READING', 'WRITING', 'SPEAKING'] as const).map((sk) => (
                    <button
                      key={sk}
                      id={`trend-toggle-${sk.toLowerCase()}`}
                      onClick={() => setTrendSkill(sk)}
                      className={`px-3 py-1 text-[11px] font-bold rounded-lg transition-all cursor-pointer ${
                        trendSkill === sk
                          ? 'bg-card text-foreground shadow-xs'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {sk === 'OVERALL'
                        ? 'Overall'
                        : sk === 'LISTENING'
                        ? 'L'
                        : sk === 'READING'
                        ? 'R'
                        : sk === 'WRITING'
                        ? 'W'
                        : 'S'}
                    </button>
                  ))}
                </div>

                {ieltsProfile?.confidenceState && (
                  <span className="text-xs font-semibold px-2.5 py-1 rounded bg-muted text-muted-foreground border border-border whitespace-nowrap">
                    Confidence: {ieltsProfile.confidenceState === 'TRUSTED_SIMULATION_EVIDENCE' ? 'SIMULATION_EVIDENCE' : ieltsProfile.confidenceState}
                  </span>
                )}
              </div>
            </div>

            {renderTrendChart(
              ieltsObservations
                .filter((obs) => {
                  if (trendSkill === 'LISTENING') return obs.listening != null;
                  if (trendSkill === 'READING') return obs.reading != null;
                  if (trendSkill === 'WRITING') return obs.writing != null;
                  if (trendSkill === 'SPEAKING') return obs.speaking != null;
                  return obs.overall != null;
                })
                .map((obs) => {
                  let score = obs.overall || 0;
                  if (trendSkill === 'LISTENING') score = obs.listening || 0;
                  else if (trendSkill === 'READING') score = obs.reading || 0;
                  else if (trendSkill === 'WRITING') score = obs.writing || 0;
                  else if (trendSkill === 'SPEAKING') score = obs.speaking || 0;
                  return { date: obs.date, score };
                }),
              9.0
            )}
          </div>

          {/* Evidence Ledger */}
          <div className="bg-card border border-border rounded-2xl p-6 space-y-4 shadow-sm">
            <h3 className="text-base font-bold text-foreground">
              {lang === 'vi' ? 'Sổ Nhật ký Bằng chứng Khảo thí' : 'Evidence Ledger and Observations'}
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead className="text-muted-foreground border-b border-border bg-muted/30">
                  <tr>
                    <th className="py-2.5 px-4 font-semibold">{lang === 'vi' ? 'Ngày nộp' : 'Date'}</th>
                    <th className="py-2.5 px-4 font-semibold">{lang === 'vi' ? 'Phân hệ / Phạm vi' : 'Variant / Scope'}</th>
                    <th className="py-2.5 px-4 font-semibold">{lang === 'vi' ? 'Điểm Tổng' : 'Overall'}</th>
                    <th className="py-2.5 px-4 font-semibold">Listening</th>
                    <th className="py-2.5 px-4 font-semibold">Reading</th>
                    <th className="py-2.5 px-4 font-semibold">Writing</th>
                    <th className="py-2.5 px-4 font-semibold">Speaking</th>
                    <th className="py-2.5 px-4 font-semibold">{lang === 'vi' ? 'Trạng thái' : 'Exposure'}</th>
                    <th className="py-2.5 px-4 font-semibold text-right">{lang === 'vi' ? 'Chi tiết' : 'Action'}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {ieltsObservations.map((obs) => (
                    <tr key={obs.attemptId} className="hover:bg-muted/30 transition-colors">
                      <td className="py-3 px-4 font-mono">{new Date(obs.date).toLocaleDateString()}</td>
                      <td className="py-3 px-4 font-medium">{obs.variant} {obs.scope}</td>
                      <td className="py-3 px-4 font-bold text-primary">
                        {obs.overall != null ? obs.overall.toFixed(1) : '--'}
                      </td>
                      <td className="py-3 px-4">{obs.listening != null ? obs.listening.toFixed(1) : '--'}</td>
                      <td className="py-3 px-4">{obs.reading != null ? obs.reading.toFixed(1) : '--'}</td>
                      <td className="py-3 px-4">{obs.writing != null ? obs.writing.toFixed(1) : '--'}</td>
                      <td className="py-3 px-4">{obs.speaking != null ? obs.speaking.toFixed(1) : '--'}</td>
                      <td className="py-3 px-4">
                        <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/10 text-emerald-600 border border-emerald-500/20">
                          {obs.exposureStatus || 'VERIFIED'}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right">
                        <Link
                          href={`/exams/ielts/results/${obs.attemptId}`}
                          className="inline-flex items-center gap-1 text-primary hover:underline font-semibold"
                        >
                          <span>{lang === 'vi' ? 'Xem kết quả' : 'View Result'}</span>
                          <ArrowRight className="w-3 h-3" />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* 4. TOEIC Profile Verified Section */}
      {selectedFamily === 'TOEIC' && hasVerifiedObservations && (
        <div className="space-y-8">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
            {renderMetricCard('TOEIC Listening and Reading Total (10-990)', toeicProfile?.lrTotal, false)}
            {renderMetricCard(lang === 'vi' ? 'Nghe Listening (5-495)' : 'Listening (5-495)', toeicProfile?.listening, false)}
            {renderMetricCard(lang === 'vi' ? 'Đọc Reading (5-495)' : 'Reading (5-495)', toeicProfile?.reading, false)}
            {renderMetricCard(lang === 'vi' ? 'Nói Speaking (0-200)' : 'Speaking (0-200)', toeicProfile?.speaking, false)}
            {renderMetricCard(lang === 'vi' ? 'Viết Writing (0-200)' : 'Writing (0-200)', toeicProfile?.writing, false)}
          </div>

          <div className="bg-card border border-border rounded-2xl p-6 space-y-4 shadow-sm">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold text-foreground">
                  {lang === 'vi' ? 'Xu hướng Điểm TOEIC Listening và Reading' : 'TOEIC Listening and Reading Performance Trend'}
                </h3>
                <p className="text-xs text-muted-foreground">
                  {lang === 'vi'
                    ? 'Tổng điểm Listening và Reading qua các bài thi thử mô phỏng hợp lệ.'
                    : 'Total score across verified simulation attempts.'}
                </p>
              </div>
            </div>

            {renderTrendChart(
              toeicObservations
                .filter((obs) => obs.lrTotal != null)
                .map((obs) => ({ date: obs.date, score: obs.lrTotal! })),
              990
            )}
          </div>

          {/* Evidence Ledger */}
          <div className="bg-card border border-border rounded-2xl p-6 space-y-4 shadow-sm">
            <h3 className="text-base font-bold text-foreground">
              {lang === 'vi' ? 'Sổ Nhật ký Bằng chứng Khảo thí' : 'Evidence Ledger and Observations'}
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead className="text-muted-foreground border-b border-border bg-muted/30">
                  <tr>
                    <th className="py-2.5 px-4 font-semibold">{lang === 'vi' ? 'Ngày nộp' : 'Date'}</th>
                    <th className="py-2.5 px-4 font-semibold">{lang === 'vi' ? 'Phân hệ' : 'Variant'}</th>
                    <th className="py-2.5 px-4 font-semibold">Listening and Reading Total</th>
                    <th className="py-2.5 px-4 font-semibold">Listening</th>
                    <th className="py-2.5 px-4 font-semibold">Reading</th>
                    <th className="py-2.5 px-4 font-semibold">Speaking</th>
                    <th className="py-2.5 px-4 font-semibold">Writing</th>
                    <th className="py-2.5 px-4 font-semibold">{lang === 'vi' ? 'Trạng thái' : 'Exposure'}</th>
                    <th className="py-2.5 px-4 font-semibold text-right">{lang === 'vi' ? 'Chi tiết' : 'Action'}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {toeicObservations.map((obs) => (
                    <tr key={obs.attemptId} className="hover:bg-muted/30 transition-colors">
                      <td className="py-3 px-4 font-mono">{new Date(obs.date).toLocaleDateString()}</td>
                      <td className="py-3 px-4 font-medium">{obs.variant}</td>
                      <td className="py-3 px-4 font-bold text-primary">
                        {obs.lrTotal != null ? obs.lrTotal : '--'}
                      </td>
                      <td className="py-3 px-4">{obs.listening != null ? obs.listening : '--'}</td>
                      <td className="py-3 px-4">{obs.reading != null ? obs.reading : '--'}</td>
                      <td className="py-3 px-4">{obs.speaking != null ? obs.speaking : '--'}</td>
                      <td className="py-3 px-4">{obs.writing != null ? obs.writing : '--'}</td>
                      <td className="py-3 px-4">
                        <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/10 text-emerald-600 border border-emerald-500/20">
                          {obs.exposureStatus || 'VERIFIED'}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right">
                        <Link
                          href={`/exams/toeic/results/${obs.attemptId}`}
                          className="inline-flex items-center gap-1 text-primary hover:underline font-semibold"
                        >
                          <span>{lang === 'vi' ? 'Xem kết quả' : 'View Result'}</span>
                          <ArrowRight className="w-3 h-3" />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* 5. Clearly Distinct "Practice Insights" Section (Requirement I) */}
      <div className="bg-card/50 border border-border/80 rounded-2xl p-6 space-y-4">
        <div className="flex items-center justify-between border-b border-border/60 pb-3">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-secondary text-secondary-foreground">
              <GraduationCap className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-foreground">
                {lang === 'vi' ? 'Thông tin Luyện tập Thường quy' : 'Practice Insights'}
              </h3>
              <p className="text-xs text-muted-foreground">
                {lang === 'vi'
                  ? 'Theo dõi tiến trình ôn luyện tự do. Số liệu này tách biệt hoàn toàn và không được dùng làm bằng chứng năng lực chính thức.'
                  : 'Track your unconstrained practice. Distinct from verified competency records.'}
              </p>
            </div>
          </div>

          <span className="text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full bg-muted text-muted-foreground border border-border">
            {lang === 'vi' ? 'Tự Đánh Giá' : 'Self-Paced'}
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-1">
          <div className="p-4 rounded-xl bg-background border border-border/60 space-y-1">
            <span className="text-[11px] text-muted-foreground font-medium">
              {lang === 'vi' ? 'Mục tiêu ôn tập' : 'Study Focus'}
            </span>
            <div className="text-sm font-bold text-foreground">
              {isIelts ? 'IELTS Academic / General' : 'TOEIC Part 1 - 7'}
            </div>
            <p className="text-[10px] text-muted-foreground">
              {lang === 'vi' ? 'Luyện tập theo từng phần không giới hạn' : 'Self-paced flexible practice'}
            </p>
          </div>

          <div className="p-4 rounded-xl bg-background border border-border/60 space-y-1">
            <span className="text-[11px] text-muted-foreground font-medium">
              {lang === 'vi' ? 'Cơ chế giải thích' : 'Formative Feedback'}
            </span>
            <div className="text-sm font-bold text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
              <CheckCircle2 className="w-3.5 h-3.5" />
              {lang === 'vi' ? 'Xem đáp án ngay' : 'Instant Review'}
            </div>
            <p className="text-[10px] text-muted-foreground">
              {lang === 'vi' ? 'Hỗ trợ giải thích chi tiết từng câu' : 'Instant explanations available'}
            </p>
          </div>

          <div className="p-4 rounded-xl bg-background border border-border/60 space-y-1">
            <span className="text-[11px] text-muted-foreground font-medium">
              {lang === 'vi' ? 'Bảo lưu bài làm' : 'Resumable Sessions'}
            </span>
            <div className="text-sm font-bold text-primary">
              {lang === 'vi' ? 'Tự động lưu tiến trình' : 'Auto-saved'}
            </div>
            <p className="text-[10px] text-muted-foreground">
              {lang === 'vi' ? 'Tiếp tục làm bài từ Tab Lịch sử bài làm' : 'Resume anytime from Attempt History'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
