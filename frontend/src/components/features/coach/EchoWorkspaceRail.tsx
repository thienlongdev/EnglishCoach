'use client';
import React from 'react';
import { Compass, Flame, LineChart, MessageCircle, Orbit } from 'lucide-react';
import { useProficiencyMe } from '@/hooks/useLeaderboard';
import { useUnifiedStreak } from '@/hooks/useUnifiedStreak';
import { EchoOrb } from './EchoOrb';
import type { ProficiencySkill } from '@/types/leaderboard';

const SKILLS: Array<{ key: string; vi: string; en: string }> = [
  { key: 'LISTENING', vi: 'Nghe', en: 'Listening' },
  { key: 'READING', vi: 'Đọc', en: 'Reading' },
  { key: 'WRITING', vi: 'Viết', en: 'Writing' },
  { key: 'SPEAKING', vi: 'Nói', en: 'Speaking' },
  { key: 'VOCABULARY', vi: 'Từ vựng', en: 'Vocabulary' },
];
const STATUS: Record<string, [string, string]> = {
  VERIFIED: ['Đã xác minh', 'Verified'],
  PROVISIONAL: ['Tạm tính', 'Provisional'],
  STALE: ['Đã lâu chưa cập nhật', 'Not updated lately'],
  UNDETERMINED: ['Chưa đủ dữ liệu', 'Not enough evidence'],
  UNSUPPORTED: ['Chưa đo được', 'Not measured yet'],
};
/** A level is shown only where the Proficiency Engine has one (verified / provisional / stale with a CEFR), never guessed. */
const measured = (s: { status: string; cefr: string | null } | undefined) =>
  !!s && !!s.cefr && (s.status === 'VERIFIED' || s.status === 'PROVISIONAL' || s.status === 'STALE');

/**
 * The immersive Echo workspace's left side (owner brief 2026-11-20): Echo itself (the real rendered whale swimming in its lens,
 * the same state ring as the header), the learner's proficiency constellation from `/proficiency/me` (the SWR entry the Profile
 * already uses; read only when this workspace is opened by the learner), the shared streak and today's Echo allowance. Every
 * number is the server's; an unknown is said to be unknown. Shortcuts go to real routes only.
 */
export function EchoWorkspaceRail({ vi, presence, allowance, isPremium, onPrompt, onNavigate }: {
  vi: boolean;
  presence: string;
  allowance?: { used: number; limit: number } | null;
  isPremium: boolean;
  onPrompt: (text: string) => void;
  onNavigate: (href: string) => void;
}) {
  const { data: proficiency, error, isLoading } = useProficiencyMe();
  const { streak } = useUnifiedStreak();
  const skills = new Map<string, ProficiencySkill>((proficiency?.skills ?? []).map(s => [s.skill, s]));
  const overall = proficiency?.overall;
  const weakest = SKILLS.map(k => ({ k, s: skills.get(k.key) }))
    .filter(x => measured(x.s) && typeof x.s?.rating === 'number')
    .sort((a, b) => (a.s!.rating as number) - (b.s!.rating as number))[0];
  const R = 78;
  return <aside className="echo-rail" aria-label={vi ? 'Không gian học tập của bạn' : 'Your learning space'}>
    <div className="echo-rail-stage" data-presence={presence} aria-hidden="true">
      <EchoOrb slot="rail" size={142} state={presence} />
    </div>

    <section className="echo-rail-card">
      <h3>{vi ? 'Hồ sơ năng lực' : 'Proficiency profile'}</h3>
      {isLoading && !proficiency ? <p className="echo-rail-muted" role="status">{vi ? 'Đang đọc hồ sơ…' : 'Reading your profile…'}</p>
        : error && !proficiency ? <p className="echo-rail-muted">{vi ? 'Chưa đọc được hồ sơ năng lực lúc này.' : 'Your profile could not be read right now.'}</p>
        : <>
          <svg className="echo-constellation" viewBox="-110 -110 220 220" role="img"
            aria-label={vi ? 'Chòm sao kỹ năng: độ sáng theo độ tin cậy của bằng chứng' : 'Skill constellation: brightness follows the confidence of the evidence'}>
            <circle className="echo-ring-path" r={R} />
            {SKILLS.map((k, i) => {
              const a = (-90 + i * 72) * Math.PI / 180;
              const x = Math.cos(a) * R, y = Math.sin(a) * R;
              const s = skills.get(k.key);
              const known = measured(s);
              const conf = Math.max(0, Math.min(1, s?.confidence ?? 0));
              return <g key={k.key} className="echo-star" data-known={known ? '' : undefined}>
                <line x1={0} y1={0} x2={x} y2={y} style={{ opacity: known ? 0.25 + conf * 0.6 : 0.15 }} />
                <circle cx={x} cy={y} r={known ? 11 + conf * 4 : 11} style={{ opacity: known ? 0.6 + conf * 0.4 : 1 }} />
                <text className="echo-star-level" x={x} y={y} dy="3.2" textAnchor="middle">{known ? s!.cefr : '?'}</text>
                <text x={x} y={y + (y >= 0 ? 27 : -19)} textAnchor="middle">{vi ? k.vi : k.en}</text>
              </g>;
            })}
            <circle className="echo-core" r={22} />
            <text className="echo-core-level" textAnchor="middle" dy="6">{overall && measured({ status: String(overall.status), cefr: overall.currentCefr }) ? overall.currentCefr : '?'}</text>
          </svg>
          <p className="echo-rail-line">
            {overall && measured({ status: String(overall.status), cefr: overall.currentCefr })
              ? (vi ? <>Tổng thể <strong>{overall.currentCefr}</strong> · {STATUS[String(overall.status)]?.[0] ?? overall.confidenceLabel}</>
                : <>Overall <strong>{overall.currentCefr}</strong> · {STATUS[String(overall.status)]?.[1] ?? overall.confidenceLabel}</>)
              : (vi ? 'Chưa đủ bằng chứng để xác định trình độ tổng thể.' : 'Not enough evidence for an overall level yet.')}
          </p>
          {weakest && <button type="button" className="echo-rail-ask" onClick={() => onPrompt(vi
            ? `Kỹ năng ${weakest.k.vi} của mình đang ở mức ${weakest.s!.cefr}. Mình nên luyện gì để cải thiện?`
            : `My ${weakest.k.en} is at ${weakest.s!.cefr}. What should I practise to improve it?`)}>
            {vi ? `Hỏi Echo cách cải thiện ${weakest.k.vi}` : `Ask Echo how to improve ${weakest.k.en}`}
          </button>}
        </>}
    </section>

    <section className="echo-rail-card echo-rail-facts">
      <div><Flame size={16} aria-hidden="true" /><span>{vi ? 'Chuỗi ngày học' : 'Learning streak'}</span>
        <strong>{streak ? `${streak.currentStreakDays} ${vi ? 'ngày' : streak.currentStreakDays === 1 ? 'day' : 'days'}` : '—'}</strong></div>
      <div><MessageCircle size={16} aria-hidden="true" /><span>{vi ? `Tin nhắn Echo ${isPremium ? 'Premium' : ''} hôm nay` : `Echo ${isPremium ? 'Premium ' : ''}messages today`}</span>
        <strong>{allowance ? `${Math.min(allowance.used, allowance.limit)}/${allowance.limit}` : '—'}</strong></div>
    </section>

    <nav className="echo-rail-links" aria-label={vi ? 'Lối tắt học tập' : 'Learning shortcuts'}>
      <button type="button" onClick={() => onNavigate('/learning-path?view=list')}><Compass size={16} aria-hidden="true" />{vi ? 'Lộ trình hôm nay' : 'Today’s path'}</button>
      <button type="button" onClick={() => onNavigate('/progress')}><LineChart size={16} aria-hidden="true" />{vi ? 'Tiến trình học tập' : 'Progress'}</button>
      <button type="button" onClick={() => onNavigate('/knowledge-universe')}><Orbit size={16} aria-hidden="true" />{vi ? 'Vũ trụ tri thức' : 'Knowledge universe'}</button>
    </nav>
  </aside>;
}
