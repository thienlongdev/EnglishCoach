'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { examsApi } from '@/services/examsApi';
import { resolveExamMediaUrl } from '@/lib/exams/media';
import type { IigUnit } from '@/lib/exams/toeicIig';

/**
 * Listening audio of the TOEIC computer-based room (2026-11-16). One <audio> element, one recording at a time.
 *  - EXAM_SIMULATION: the candidate's Start click (browser autoplay rule) begins the first recording; afterwards the
 *    recordings play once, in order, with no pause, rewind or seek (a seek backwards is undone, a browser-imposed pause
 *    is resumed). When the last recording ends `onComplete` runs exactly once (the runtime completes the Listening
 *    section; the server deadline remains the authority if audio fails). [B26 p11; REA 06 / IX17–IX20]
 *  - PRACTICE (existing English Coach policy, Exams Phase 6/7): play / pause allowed, still no rewind; the end of the
 *    audio never completes anything.
 * The current recording index survives a reload of the tab (sessionStorage) so a resumed practice / legacy attempt
 * continues where it was; a strict simulation is ended by Echo Sentinel on reload anyway.
 */

export type ToeicAudioPhase = 'waiting' | 'loading' | 'playing' | 'paused' | 'ended' | 'unavailable';

export function useToeicListeningAudio(input: {
  enabled: boolean;
  units: IigUnit[];
  attemptId: string;
  isSimulation: boolean;
  onComplete?: () => void;
}) {
  const { enabled, units, attemptId, isSimulation, onComplete } = input;
  const storageKey = enabled && attemptId ? `ec_toeic_iig_timeline_${attemptId}` : null;
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
  const [unitIndex, setUnitIndex] = useState(0);
  const [phase, setPhase] = useState<ToeicAudioPhase>('waiting');
  const [restored, setRestored] = useState(false);
  const [volume, setVolumeState] = useState(1);
  const [time, setTime] = useState({ current: 0, duration: 0, unitIndex: -1 });
  const [started, setStarted] = useState(false);
  const grants = useRef(new Map<number, string>());
  const maxTime = useRef(0);
  const completed = useRef(false);
  const unitRef = useRef(unitIndex);
  unitRef.current = unitIndex;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const complete = useCallback(() => {
    setPhase('ended');
    write('done', 'true');
    if (isSimulation && !completed.current) {
      completed.current = true;
      onCompleteRef.current?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSimulation]);

  // Restore after the first paint (identical server / client first render).
  useEffect(() => {
    if (!enabled) return;
    const v = Number(read('unit'));
    if (Number.isFinite(v) && v > 0 && v < units.length) setUnitIndex(v);
    if (read('done') === 'true') complete();
    setRestored(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  const grantFor = useCallback(
    async (idx: number): Promise<string | null> => {
      const cached = grants.current.get(idx);
      if (cached) return cached;
      const assetId = units[idx]?.assetId;
      if (!assetId || !attemptId) return null;
      try {
        const grant: any = await examsApi.createPlaybackGrant(attemptId, assetId);
        const raw = grant?.mediaStreamUrl || grant?.streamUrl;
        if (!raw) return null;
        const url = resolveExamMediaUrl(raw) || raw;
        grants.current.set(idx, url);
        return url;
      } catch {
        return null;
      }
    },
    [units, attemptId]
  );

  const load = useCallback(
    async (idx: number, autoplay: boolean) => {
      if (!units[idx]?.assetId) {
        setPhase('unavailable');
        return;
      }
      setPhase((p) => (p === 'playing' ? p : 'loading'));
      const url = await grantFor(idx);
      const audio = audioRef.current;
      if (!url || !audio) {
        setPhase('unavailable');
        return;
      }
      write('unit', String(idx));
      if (audio.src !== url && audio.currentSrc !== url) {
        maxTime.current = 0;
        audio.src = url;
        audio.load();
      }
      audio.volume = volume;
      if (!autoplay) {
        setPhase((p) => (p === 'loading' ? 'waiting' : p));
        return;
      }
      try {
        await audio.play();
        setPhase('playing');
      } catch {
        // Autoplay refused (no gesture yet): the room shows its Start / Continue control again.
        setStarted(false);
        setPhase('waiting');
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [units, grantFor, volume]
  );

  // Load the current recording (autoplay only once the candidate started); preload the next grant.
  useEffect(() => {
    if (!enabled || !restored || phaseRef.current === 'ended') return;
    void load(unitIndex, started);
    if (unitIndex + 1 < units.length) void grantFor(unitIndex + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, restored, unitIndex]);

  // Native events: forward-only, next recording on end, a simulation is never paused.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !enabled) return;
    const guard = () => {
      if (audio.currentTime < maxTime.current - 0.25) audio.currentTime = maxTime.current;
    };
    const tick = () => {
      if (audio.currentSrc !== grants.current.get(unitRef.current) && audio.src !== grants.current.get(unitRef.current)) {
        const grant = grants.current.get(unitRef.current);
        if (!grant || audio.currentSrc !== new URL(grant, window.location.href).href) return;
      }
      if (audio.currentTime > maxTime.current) maxTime.current = audio.currentTime;
      setTime({ unitIndex: unitRef.current, current: audio.currentTime, duration: Number.isFinite(audio.duration) ? audio.duration : 0 });
    };
    const ended = () => {
      const next = unitRef.current + 1;
      if (next >= units.length) {
        complete();
        return;
      }
      setUnitIndex(next);
    };
    const pause = () => {
      if (isSimulation && !audio.ended && phaseRef.current === 'playing') {
        void audio.play().catch(() => {
          setStarted(false);
          setPhase('waiting');
        });
      }
    };
    const playing = () => setPhase('playing');
    audio.addEventListener('seeking', guard);
    audio.addEventListener('timeupdate', tick);
    audio.addEventListener('loadedmetadata', tick);
    audio.addEventListener('ended', ended);
    audio.addEventListener('pause', pause);
    audio.addEventListener('playing', playing);
    return () => {
      audio.removeEventListener('seeking', guard);
      audio.removeEventListener('timeupdate', tick);
      audio.removeEventListener('loadedmetadata', tick);
      audio.removeEventListener('ended', ended);
      audio.removeEventListener('pause', pause);
      audio.removeEventListener('playing', playing);
    };
  }, [enabled, isSimulation, units.length, complete]);

  /** Candidate's Start / Continue click: the gesture that lets the browser play sound. */
  const start = useCallback(async () => {
    setStarted(true);
    const audio = audioRef.current;
    if (!audio) return;
    if (!audio.src) {
      await load(unitRef.current, true);
      return;
    }
    try {
      await audio.play();
      setPhase('playing');
    } catch {
      setStarted(false);
      setPhase('waiting');
    }
  }, [load]);

  /** Practice only. */
  const togglePause = useCallback(() => {
    if (isSimulation) return;
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      setStarted(true);
      if (!audio.src) {
        void load(unitRef.current, true);
        return;
      }
      void audio.play().then(() => setPhase('playing')).catch(() => undefined);
    } else {
      audio.pause();
      setPhase('paused');
    }
  }, [isSimulation, load]);

  /** Asks for the recording's playback grant again after a failure. */
  const retry = useCallback(() => {
    grants.current.delete(unitRef.current);
    void load(unitRef.current, started);
  }, [load, started]);

  const setVolume = useCallback((v: number) => {
    const clamped = Math.max(0, Math.min(1, v));
    setVolumeState(clamped);
    if (audioRef.current) audioRef.current.volume = clamped;
  }, []);

  return { audioRef, unitIndex, phase, started, time, volume, setVolume, start, togglePause, retry };
}
