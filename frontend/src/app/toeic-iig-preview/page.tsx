'use client';

import React, { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { notFound, useSearchParams } from 'next/navigation';
import { ToeicIigShell } from '@/components/features/exams/toeic-iig/ToeicIigShell';
import { TOEIC_IIG_SAMPLE } from '@/lib/exams/toeicIigSample';
import { buildQuestionNumbers } from '@/lib/exams/runnerModel';
import { examsApi } from '@/services/examsApi';

/**
 * DEVELOPMENT-ONLY preview of the TOEIC IIG-style room over the self-authored sample (2026-11-16). Used by
 * `frontend/scripts/toeic-iig-journey.cjs` for the visual comparison and the behaviour journey. It talks to no server:
 * playback grants are answered locally (generated tones, drawn SVG figures), answers / marks stay in memory. A production
 * build answers 404.   ?skill=listening|reading  ?mode=practice  ?t=<seconds left>  ?audio=<seconds per part>
 *                     ?save=error  ?submit=fail
 */

function toneWav(seconds: number, freq: number): string {
  const rate = 8000;
  const n = Math.max(1, Math.floor(seconds * rate));
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o: number, str: string) => [...str].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  w(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 900), true);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

const PHOTO = (variant: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="760" height="500" viewBox="0 0 760 500">
<rect width="760" height="500" fill="#d9d9d9"/><rect y="330" width="760" height="170" fill="#9a9a9a"/>
<rect x="${variant === 1 ? 200 : 120}" y="250" width="360" height="24" fill="#555"/><rect x="${variant === 1 ? 220 : 140}" y="274" width="12" height="90" fill="#555"/><rect x="${variant === 1 ? 528 : 448}" y="274" width="12" height="90" fill="#555"/>
<circle cx="${variant === 1 ? 300 : 520}" cy="170" r="36" fill="#333"/><rect x="${variant === 1 ? 270 : 490}" y="206" width="60" height="110" rx="14" fill="#333"/>
<rect x="${variant === 1 ? 410 : 230}" y="200" width="110" height="50" fill="#777"/>
<text x="20" y="485" font-family="Arial" font-size="16" fill="#222">Drawn placeholder photograph ${variant} (preview only)</text></svg>`;

const TABLE = `<svg xmlns="http://www.w3.org/2000/svg" width="520" height="300" viewBox="0 0 520 300" font-family="Arial" font-size="18">
<rect x="1" y="1" width="518" height="298" fill="#fff" stroke="#222"/><text x="260" y="34" text-anchor="middle" font-weight="bold">Study rooms</text>
${['Room 1|4 seats|Projector', 'Room 2|6 seats|Whiteboard', 'Room 3|8 seats|Projector', 'Room 4|12 seats|Video screen']
  .map((r, i) => r.split('|').map((c, j) => `<text x="${30 + j * 170}" y="${90 + i * 52}">${c}</text>`).join('') + `<line x1="10" x2="510" y1="${106 + i * 52}" y2="${106 + i * 52}" stroke="#bbb"/>`)
  .join('')}</svg>`;

const CHART = `<svg xmlns="http://www.w3.org/2000/svg" width="560" height="360" viewBox="0 0 560 360" font-family="Arial" font-size="15">
<text x="280" y="26" text-anchor="middle" font-size="18" font-weight="bold">Monthly visitors (hundreds)</text>
<line x1="60" y1="310" x2="540" y2="310" stroke="#000"/><line x1="60" y1="50" x2="60" y2="310" stroke="#000"/>
${[['March', 9], ['April', 14], ['May', 11], ['June', 17]].map(([m, v], i) => `<rect x="${100 + i * 110}" y="${310 - (v as number) * 14}" width="56" height="${(v as number) * 14}" fill="#4a4a4a"/><text x="${128 + i * 110}" y="332" text-anchor="middle">${m}</text>`).join('')}</svg>`;

const svgUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

const previewAudio = new Map<string, string>();
if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'production') {
  (examsApi as any).createPlaybackGrant = async (_attempt: string, assetId: string) => {
    const extraAudio: string[] = (window as any).__IIG_PREVIEW_AUDIO_IDS__ || [];
    if (assetId.startsWith('sample-audio') || extraAudio.includes(assetId)) {
      let url = previewAudio.get(assetId);
      if (!url) {
        url = toneWav(Number(new URLSearchParams(window.location.search).get('audio') || 6), 280 + (assetId.charCodeAt(assetId.length - 1) % 6) * 70);
        previewAudio.set(assetId, url);
      }
      return { streamUrl: url, mediaStreamUrl: url };
    }
    const svg = assetId === 'sample-photo-1' ? PHOTO(1) : assetId === 'sample-photo-2' ? PHOTO(2) : assetId.startsWith('sample-table') ? TABLE : CHART;
    return { streamUrl: svgUrl(svg), mediaStreamUrl: svgUrl(svg) };
  };
}

function Preview() {
  const params = useSearchParams();
  // A real exam manifest may be injected by scripts/toeic-iig-real-packages.cjs (window.__IIG_PREVIEW_MANIFEST__).
  const exam: typeof TOEIC_IIG_SAMPLE = (typeof window !== 'undefined' && (window as any).__IIG_PREVIEW_MANIFEST__) || TOEIC_IIG_SAMPLE;
  const practice = params.get('mode') === 'practice';
  const start = Math.max(0, exam.sections.findIndex((s) => s.skill === (params.get('skill') || 'listening').toUpperCase()));
  const [active, setActive] = useState(start);
  const section = exam.sections[active];
  const [responses, setResponses] = useState<Record<string, any>>({});
  const [flags, setFlags] = useState<Set<string>>(new Set());
  const [remaining, setRemaining] = useState(() => Number(params.get('t') || section.durationSeconds));
  const [events, setEvents] = useState<string[]>([]);
  const log = useCallback((e: string) => setEvents((prev) => [...prev, e]), []);

  useEffect(() => {
    if (practice) return;
    const t = window.setInterval(() => setRemaining((r) => Math.max(0, r - 1)), 1000);
    return () => window.clearInterval(t);
  }, [practice]);

  const numbers = useMemo(() => buildQuestionNumbers(section.parts, section.skill === 'READING' ? 101 : 1), [section]);

  return (
    <div data-testid="iig-preview" data-events={events.join('|')} data-responses={JSON.stringify(responses)} data-flags={[...flags].join(',')}>
      <ToeicIigShell
        key={section.id}
        attemptId="preview-attempt"
        manifest={exam}
        attemptState={{} as any}
        section={section}
        skill={section.skill as 'LISTENING' | 'READING'}
        questionNumbers={numbers}
        responses={responses}
        flaggedPlacements={flags}
        onToggleFlag={(pid) =>
          setFlags((prev) => {
            const next = new Set(prev);
            if (next.has(pid)) next.delete(pid);
            else next.add(pid);
            log(`flag:${pid}:${next.has(pid)}`);
            return next;
          })
        }
        remainingSeconds={remaining}
        isSimulation={!practice}
        isUntimed={practice}
        isLastSection={active === exam.sections.length - 1}
        saveStatus={params.get('save') === 'error' ? 'ERROR' : 'SAVED'}
        onAnswer={(pid, value) => setResponses((prev) => ({ ...prev, [pid]: value }))}
        onRetrySave={() => log('retry')}
        onSubmit={async () => {
          log('submit');
          if (params.get('submit') === 'fail') throw new Error('preview failure');
        }}
        onCompleteListening={
          practice
            ? undefined
            : () => {
                log('listening-complete');
                setActive((i) => Math.min(exam.sections.length - 1, i + 1));
                setRemaining(exam.sections[Math.min(exam.sections.length - 1, active + 1)].durationSeconds);
              }
        }
        onExit={practice ? () => log('exit') : undefined}
        lang={params.get('lang') === 'vi' ? 'vi' : 'en'}
      />
    </div>
  );
}

export default function ToeicIigPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <Suspense fallback={null}>
      <Preview />
    </Suspense>
  );
}
