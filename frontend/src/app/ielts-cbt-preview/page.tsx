'use client';

import React, { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { notFound, useSearchParams } from 'next/navigation';
import { IeltsCbtShell } from '@/components/features/exams/ielts-cbt/IeltsCbtShell';
import { IELTS_CBT_SAMPLE } from '@/lib/exams/ieltsCbtSample';
import { buildQuestionNumbers } from '@/lib/exams/runnerModel';
import { examsApi } from '@/services/examsApi';

/**
 * DEVELOPMENT-ONLY preview of the IELTS CBT room over the self-authored sample exam (2026-11-13). Used by the visual
 * regression and functional journeys (`frontend/scripts/ielts-cbt-journey.cjs`). It talks to no server: playback grants
 * are answered locally (generated tones, drawn SVG figures) and answers stay in memory. A production build answers 404.
 *   ?skill=reading|listening|writing  ?mode=practice  ?t=<seconds left>  ?audio=<seconds per part>  ?save=error
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
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 1200), true);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

const MAP_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="560" height="320" viewBox="0 0 560 320" font-family="Arial" font-size="16">
<rect x="2" y="2" width="556" height="316" fill="#fff" stroke="#000" stroke-width="2"/>
<text x="250" y="312" >Entrance</text><rect x="240" y="300" width="80" height="18" fill="none" stroke="#000"/>
<rect x="20" y="20" width="150" height="110" fill="none" stroke="#000"/><text x="88" y="80" font-weight="bold">A</text>
<rect x="200" y="20" width="160" height="110" fill="none" stroke="#000"/><text x="275" y="80" font-weight="bold">B</text>
<rect x="390" y="20" width="150" height="110" fill="none" stroke="#000"/><text x="460" y="80" font-weight="bold">C</text>
<rect x="20" y="170" width="150" height="110" fill="none" stroke="#000"/><text x="88" y="230" font-weight="bold">D</text>
<rect x="200" y="170" width="70" height="80" fill="none" stroke="#000"/><text x="228" y="215" font-weight="bold">E</text>
<rect x="290" y="170" width="70" height="80" fill="none" stroke="#000"/><text x="318" y="215" font-weight="bold">F</text>
<rect x="390" y="170" width="150" height="110" fill="none" stroke="#000"/><text x="460" y="230" font-weight="bold">G</text>
<text x="200" y="155" font-size="13">Main corridor</text></svg>`;

const CHART_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="560" height="380" viewBox="0 0 560 380" font-family="Arial" font-size="14">
<text x="280" y="24" text-anchor="middle" font-size="18">Visitors to three city libraries, 2015 and 2025</text>
<line x1="70" y1="320" x2="540" y2="320" stroke="#000"/><line x1="70" y1="50" x2="70" y2="320" stroke="#000"/>
${[0, 20, 40, 60, 80, 100, 120].map((v) => `<text x="60" y="${324 - v * 2.2}" text-anchor="end">${v}</text><line x1="70" y1="${320 - v * 2.2}" x2="540" y2="${320 - v * 2.2}" stroke="#ccc"/>`).join('')}
${[['North', 62, 48], ['Central', 115, 96], ['Harbour', 30, 71]].map(([n, a, b], i) => `<rect x="${110 + i * 150}" y="${320 - (a as number) * 2.2}" width="40" height="${(a as number) * 2.2}" fill="#333"/><rect x="${152 + i * 150}" y="${320 - (b as number) * 2.2}" width="40" height="${(b as number) * 2.2}" fill="#aaa"/><text x="${151 + i * 150}" y="342" text-anchor="middle">${n}</text>`).join('')}
<text x="20" y="190" transform="rotate(-90 20 190)" text-anchor="middle">Visitors (thousands)</text>
<rect x="210" y="356" width="14" height="14" fill="#333"/><text x="230" y="368">2015</text><rect x="300" y="356" width="14" height="14" fill="#aaa"/><text x="320" y="368">2025</text></svg>`;

const FIGURE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="200" viewBox="0 0 480 200" font-family="Arial" font-size="16"><rect x="1" y="1" width="478" height="198" fill="#fff" stroke="#999" stroke-dasharray="6 4"/><text x="240" y="105" text-anchor="middle" fill="#555">Figure (media not available in the local preview)</text></svg>`;

function svgUrl(svg: string) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// Local playback grants, installed before the first render (child effects run before a parent's, so an effect would
// be too late for the first image / audio request). Development preview only.
const previewAudio = new Map<string, string>();
if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'production') {
  (examsApi as any).createPlaybackGrant = async (_attempt: string, assetId: string) => {
    const extraAudio: string[] = (window as any).__CBT_PREVIEW_AUDIO_IDS__ || [];
    if (assetId.startsWith('sample-audio') || extraAudio.includes(assetId)) {
      let url = previewAudio.get(assetId);
      if (!url) {
        url = toneWav(Number(new URLSearchParams(window.location.search).get('audio') || 8), 300 + Number(assetId.match(/(\d)/)?.[1] || 1) * 60);
        previewAudio.set(assetId, url);
      }
      return { streamUrl: url, mediaStreamUrl: url };
    }
    const url = svgUrl(assetId.startsWith('sample-map') ? MAP_SVG : assetId.startsWith('sample-chart') ? CHART_SVG : FIGURE_SVG);
    return { streamUrl: url, mediaStreamUrl: url };
  };
}

function Preview() {
  const params = useSearchParams();
  // A real exam manifest may be injected by the journey (window.__CBT_PREVIEW_MANIFEST__) to render bank content.
  const exam: typeof IELTS_CBT_SAMPLE = (typeof window !== 'undefined' && (window as any).__CBT_PREVIEW_MANIFEST__) || IELTS_CBT_SAMPLE;
  const skillParam = (params.get('skill') || 'reading').toUpperCase();
  const practice = params.get('mode') === 'practice';
  const saveError = params.get('save') === 'error';
  const sectionIndex = Math.max(0, exam.sections.findIndex((s) => s.skill === skillParam));
  const [active, setActive] = useState(sectionIndex);
  const section = exam.sections[active];
  const [responses, setResponses] = useState<Record<string, any>>({});
  const [remaining, setRemaining] = useState(() => Number(params.get('t') || section.durationSeconds));
  const [events, setEvents] = useState<string[]>([]);

  useEffect(() => {
    if (practice) return;
    const t = window.setInterval(() => setRemaining((r) => Math.max(0, r - 1)), 1000);
    return () => window.clearInterval(t);
  }, [practice]);

  const numbers = useMemo(() => buildQuestionNumbers(section.parts, 1), [section]);
  const log = useCallback((e: string) => setEvents((prev) => [...prev, e]), []);

  return (
    <div data-testid="cbt-preview" data-events={events.join('|')} data-responses={JSON.stringify(responses)}>
      <IeltsCbtShell
        key={section.id}
        attemptId="preview-attempt"
        manifest={exam}
        attemptState={{} as any}
        section={section}
        skill={section.skill as 'READING' | 'LISTENING' | 'WRITING'}
        questionNumbers={numbers}
        responses={responses}
        remainingSeconds={remaining}
        isSimulation={!practice}
        isUntimed={practice}
        isLastSection={active === exam.sections.length - 1}
        saveStatus={saveError ? 'ERROR' : 'SAVED'}
        onAnswer={(pid, value) => {
          if (!practice && remaining <= 0) return;
          setResponses((prev) => ({ ...prev, [pid]: value }));
        }}
        onRetrySave={() => log('retry')}
        onSubmit={async () => log('submit')}
        onAdvanceSection={async () => {
          log(`advance:${section.skill}`);
          setActive((i) => Math.min(exam.sections.length - 1, i + 1));
          setRemaining(exam.sections[Math.min(exam.sections.length - 1, active + 1)].durationSeconds);
        }}
        onCompleteListening={() => log('listening-complete')}
        onExit={() => log('exit')}
      />
    </div>
  );
}

export default function IeltsCbtPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <Suspense fallback={null}>
      <Preview />
    </Suspense>
  );
}
