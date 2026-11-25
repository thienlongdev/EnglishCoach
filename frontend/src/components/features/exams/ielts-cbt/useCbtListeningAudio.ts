'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PublicPartDto } from '@/types/exams';
import { examsApi } from '@/services/examsApi';
import { resolveExamMediaUrl } from '@/lib/exams/media';

/**
 * Listening audio of the IELTS CBT room (2026-11-13). The rules are the existing runtime's (ListeningPlayer), kept
 * byte-for-byte in behaviour and in their session keys so an attempt can move between the two UIs:
 *  - EXAM_SIMULATION: the recording plays once, part after part (one playback grant per part), never paused, never
 *    rewound (forward-only seek guard); like the reference, the test opens on the sound-check screen and the candidate's
 *    Play click starts the recording (this also satisfies browser autoplay rules); after the last part the 2-minute check runs, then `onComplete` (once).
 *    [DOCUMENTED] IDP: on computer "you will have 2 minutes to check your answers".
 *  - PRACTICE: play / pause allowed, no rewind beyond what the player had, the end never opens the 2-minute check and
 *    never completes the section.
 */

export type ListeningPhase = 'waiting' | 'playing' | 'paused' | 'review' | 'ended' | 'unavailable';

function audioAssetOf(part: PublicPartDto | undefined) {
  return part?.groups
    ?.flatMap((g) => g.stimuli || [])
    ?.flatMap((s) => s.assets || [])
    ?.find((a) => a.mimeType?.startsWith('audio') || a.role === 'PRIMARY');
}

export function useCbtListeningAudio(input: {
  /** Only a Listening section runs the recording (other sections must never touch the Listening timeline keys). */
  enabled: boolean;
  parts: PublicPartDto[];
  attemptId: string;
  isSimulation: boolean;
  remainingSeconds?: number;
  onComplete?: () => void;
}) {
  const { enabled, parts, attemptId, isSimulation, remainingSeconds, onComplete } = input;
  const storageKey = enabled && attemptId ? `ec_listening_timeline_${attemptId}` : null;
  const read = (suffix: string): string | null => {
    if (typeof window === 'undefined' || !storageKey) return null;
    try {
      return sessionStorage.getItem(`${storageKey}_${suffix}`);
    } catch {
      return null;
    }
  };
  const write = (suffix: string, value: string) => {
    if (!storageKey) return;
    try {
      sessionStorage.setItem(`${storageKey}_${suffix}`, value);
    } catch {
      /* storage unavailable: state stays in memory */
    }
  };

  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Restored from the tab's session after the first paint (identical server / client first render).
  const [partIndex, setPartIndex] = useState<number>(0);
  const [phase, setPhase] = useState<ListeningPhase>('waiting');
  const [reviewRemaining, setReviewRemaining] = useState<number>(120);
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const v = Number(read('audio_part'));
    if (Number.isFinite(v) && v > 0) setPartIndex(v);
    if (read('final_review') === 'true') {
      const deadline = Number(read('review_deadline'));
      setReviewRemaining(Number.isFinite(deadline) && deadline > 0 ? Math.max(0, Math.floor((deadline - Date.now()) / 1000)) : 120);
      setPhase('review');
    }
    setRestored(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
  const [volume, setVolumeState] = useState(1);
  const [needsGesture, setNeedsGesture] = useState(enabled && isSimulation);
  const maxTime = useRef(0);
  const grants = useRef(new Map<number, string>());
  const completed = useRef(false);
  const continuePlaying = useRef(false);
  // The reference opens every Listening test with the sound-check screen; the recording starts on the candidate's Play.
  const started = useRef(false);
  const partRef = useRef(partIndex);
  partRef.current = partIndex;

  const grantFor = useCallback(
    async (idx: number): Promise<string | null> => {
      const cached = grants.current.get(idx);
      if (cached) return cached;
      const asset = audioAssetOf(parts[idx]);
      if (!asset?.assetId || !attemptId) return null;
      try {
        const grant: any = await examsApi.createPlaybackGrant(attemptId, asset.assetId);
        const raw = grant.mediaStreamUrl || grant.streamUrl;
        if (!raw) return null;
        const url = resolveExamMediaUrl(raw) || raw;
        grants.current.set(idx, url);
        return url;
      } catch {
        return null;
      }
    },
    [parts, attemptId]
  );

  const enterReview = useCallback(() => {
    if (!isSimulation) {
      setPhase('ended');
      return;
    }
    setPhase('review');
    if (read('final_review') !== 'true') {
      write('final_review', 'true');
      write('review_deadline', String(Date.now() + 120_000));
      setReviewRemaining(120);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSimulation]);

  const load = useCallback(
    async (idx: number, autoplay: boolean) => {
      // Parts without their own recording are skipped (a whole-section recording is attached to its first part only).
      let target = idx;
      while (target < parts.length && !audioAssetOf(parts[target])) target += 1;
      if (target >= parts.length) {
        if (idx === 0) setPhase('unavailable');
        else enterReview();
        return;
      }
      if (target !== idx) {
        setPartIndex(target);
        return;
      }
      const url = await grantFor(idx);
      const audio = audioRef.current;
      if (!url || !audio) {
        if (!url) setPhase('unavailable');
        return;
      }
      write('audio_part', String(idx));
      if (audio.src !== url && audio.currentSrc !== url) {
        maxTime.current = 0;
        audio.src = url;
        audio.load();
      }
      if (!autoplay) return;
      try {
        await audio.play();
        setNeedsGesture(false);
        setPhase('playing');
      } catch {
        setNeedsGesture(true);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [parts.length, grantFor, enterReview]
  );

  // Initial / part change load (not during the review).
  useEffect(() => {
    if (!enabled || !restored || phase === 'review' || phase === 'ended') return;
    void load(partIndex, (isSimulation && started.current) || continuePlaying.current);
    continuePlaying.current = false;
    // Preload the next part's grant for a seamless change.
    if (partIndex + 1 < parts.length) void grantFor(partIndex + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, restored, partIndex, isSimulation, parts.length]);

  // Server timeline: the simulation section ends ≤ 2 minutes from now ⇒ the check period (same as the classic runner).
  useEffect(() => {
    if (enabled && isSimulation && remainingSeconds !== undefined && remainingSeconds > 0 && remainingSeconds <= 120 && phase !== 'review') {
      setPhase('review');
      setReviewRemaining(Math.min(120, remainingSeconds));
    }
  }, [enabled, isSimulation, remainingSeconds, phase]);

  // 2-minute check countdown, then complete exactly once.
  useEffect(() => {
    if (!enabled || phase !== 'review') return;
    const t = window.setInterval(() => {
      setReviewRemaining((prev) => {
        if (prev <= 1) {
          window.clearInterval(t);
          if (!completed.current) {
            completed.current = true;
            onComplete?.();
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => window.clearInterval(t);
  }, [enabled, phase, onComplete]);

  // Native events: forward-only in simulation, next part on end.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const guard = () => {
      if (isSimulation && audio.currentTime < maxTime.current - 0.25) audio.currentTime = maxTime.current;
    };
    const time = () => {
      if (audio.currentTime > maxTime.current) maxTime.current = audio.currentTime;
      guard();
    };
    const ended = () => {
      const next = partRef.current + 1;
      if (next >= parts.length) {
        enterReview();
        return;
      }
      continuePlaying.current = true;
      setPartIndex(next);
    };
    const pause = () => {
      // A simulation recording is never paused by the candidate; a browser pause (tab policy) is resumed.
      if (isSimulation && !audio.ended && phase === 'playing') void audio.play().catch(() => setNeedsGesture(true));
    };
    audio.addEventListener('seeking', guard);
    audio.addEventListener('timeupdate', time);
    audio.addEventListener('ended', ended);
    audio.addEventListener('pause', pause);
    return () => {
      audio.removeEventListener('seeking', guard);
      audio.removeEventListener('timeupdate', time);
      audio.removeEventListener('ended', ended);
      audio.removeEventListener('pause', pause);
    };
  }, [isSimulation, parts.length, enterReview, phase]);

  const start = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;
    started.current = true;
    if (!audio.src) await load(partRef.current, false);
    try {
      await audio.play();
      setNeedsGesture(false);
      setPhase('playing');
    } catch {
      setNeedsGesture(true);
    }
  }, [load]);

  const togglePause = useCallback(() => {
    if (isSimulation) return;
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      void audio.play().then(() => setPhase('playing')).catch(() => undefined);
    } else {
      audio.pause();
      setPhase('paused');
    }
  }, [isSimulation]);

  const setVolume = useCallback((v: number) => {
    const clamped = Math.max(0, Math.min(1, v));
    setVolumeState(clamped);
    if (audioRef.current) audioRef.current.volume = clamped;
  }, []);

  return { audioRef, phase, partIndex, reviewRemaining, needsGesture, start, togglePause, volume, setVolume };
}
