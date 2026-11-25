'use client';

import React, { useEffect, useRef, useState } from 'react';
import { YOUTUBE_PLAYER_ORIGINS, youtubeBackgroundUrl } from '@/lib/wallpaper/media';
import type { WallpaperStatus } from '@/types/wallpaper';
import styles from './WallpaperStage.module.css';

/**
 * YouTube's own embedded player as a background layer of the ONE engine (WallpaperStage). Owner decision 2026-10-19
 * (OpenQuiz-style): the player sits behind the workspace, muted, looping, without its control bar. YouTube's embed rules
 * on overlays / autoplay visibility are not met by this use (RESEARCH_AND_RELEASE.md §11) — accepted by the owner.
 *
 * The page talks to the player only through the IFrame API's documented message channel (`enablejsapi=1`, this page's
 * origin): no third-party script is loaded here, nothing of the player's DOM is touched, no stream is extracted.
 * Playback is claimed only from the player's own reports: state PLAYING (1) with `currentTime` advancing between two
 * reports. An error report (embedding off, private, removed) or 20 s without that proof is a failure; the engine then
 * keeps the previous wallpaper.
 *
 * The latest reported state / time are mirrored on the frame's wrapper (`data-yt-state`, `data-yt-time`) without a React
 * render, so a browser test can observe the player without reaching into YouTube's frame.
 */

const READY_TIMEOUT_MS = 20_000;
const LISTEN_EVERY_MS = 250;
/** YouTube player states (IFrame API). */
const PLAYING = 1;
const ENDED = 0;

type Reply = { event?: string; info?: unknown };

function parse(data: unknown): Reply | null {
  if (typeof data !== 'string' || data.length > 100_000) return null;
  try {
    const value = JSON.parse(data) as unknown;
    return value && typeof value === 'object' ? (value as Reply) : null;
  } catch {
    return null;
  }
}

export default function YouTubeBackdrop({
  videoId,
  active,
  onProven,
  onFail,
}: {
  videoId: string;
  /** Decode (play) now; false = paused (hidden tab, open studio, resting route, outgoing layer). */
  active: boolean;
  onProven: () => void;
  onFail: (reason: WallpaperStatus['reason']) => void;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  // Built once per layer from the validated id and this page's origin.
  const [src] = useState(() => youtubeBackgroundUrl(videoId, window.location.origin));
  const [ready, setReady] = useState(false);
  const activeRef = useRef(active);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);
  const callbacks = useRef({ onProven, onFail });
  useEffect(() => {
    callbacks.current = { onProven, onFail };
  }, [onProven, onFail]);

  const send = (func: string, args: unknown[] = []) => {
    frameRef.current?.contentWindow?.postMessage(
      JSON.stringify({ event: 'command', func, args, id: 1, channel: 'widget' }),
      YOUTUBE_PLAYER_ORIGINS[0],
    );
  };

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    let settled = false;
    let heard = false;
    let lastTime = -1;
    // The player reports only what changed: its state and its clock arrive in separate messages.
    let lastState: number | null = null;
    const settle = (outcome: 'proven' | WallpaperStatus['reason']) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      if (outcome === 'proven') callbacks.current.onProven();
      else callbacks.current.onFail(outcome);
    };
    // A hidden tab may not play: the clock only runs while the page is visible.
    const arm = (): number =>
      window.setTimeout(() => {
        if (document.visibilityState === 'hidden') timeout = arm();
        else settle('timeout');
      }, READY_TIMEOUT_MS);
    let timeout = arm();

    // The IFrame API handshake: "listening" until the player answers (a message to a frame that has not loaded the
    // player yet is dropped by the browser: the target origin does not match).
    const listen = () =>
      frame.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), YOUTUBE_PLAYER_ORIGINS[0]);
    const listenTimer = window.setInterval(() => {
      if (heard) window.clearInterval(listenTimer);
      else listen();
    }, LISTEN_EVERY_MS);
    const onLoad = () => {
      if (!heard) listen();
    };
    frame.addEventListener('load', onLoad);

    const mirror = (state: number | null, time: number | null) => {
      const wrap = wrapRef.current;
      if (!wrap) return;
      if (state !== null) wrap.dataset.ytState = String(state);
      if (time !== null) wrap.dataset.ytTime = time.toFixed(2);
    };

    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || !YOUTUBE_PLAYER_ORIGINS.includes(event.origin)) return;
      const reply = parse(event.data);
      if (!reply?.event) return;
      if (!heard) {
        heard = true;
        window.clearInterval(listenTimer);
        send('addEventListener', ['onStateChange']);
        send('addEventListener', ['onError']);
      }
      if (reply.event === 'onReady' || reply.event === 'initialDelivery') {
        setReady(true);
        send('mute');
        if (activeRef.current) send('playVideo');
      } else if (reply.event === 'onError') {
        const code = Number(reply.info);
        mirror(-2, null);
        settle(code === 5 ? 'decode' : 'blocked');
      } else if (reply.event === 'onStateChange') {
        const state = Number(reply.info);
        lastState = state;
        mirror(state, null);
        // `loop` + `playlist` repeat the video; restart it ourselves if the player still reports the end.
        if (state === ENDED && activeRef.current) {
          send('seekTo', [0, true]);
          send('playVideo');
        }
      } else if (reply.event === 'infoDelivery' && reply.info && typeof reply.info === 'object') {
        const info = reply.info as { playerState?: unknown; currentTime?: unknown };
        if (typeof info.playerState === 'number') lastState = info.playerState;
        const time = typeof info.currentTime === 'number' && Number.isFinite(info.currentTime) ? info.currentTime : null;
        mirror(lastState, time);
        if (time !== null) {
          // Proof of playback: PLAYING and the player's own clock moved forward between two reports.
          if (lastState === PLAYING && lastTime >= 0 && time > lastTime) settle('proven');
          lastTime = time;
        }
      }
    };
    window.addEventListener('message', onMessage);
    return () => {
      settled = true;
      window.clearTimeout(timeout);
      window.clearInterval(listenTimer);
      frame.removeEventListener('load', onLoad);
      window.removeEventListener('message', onMessage);
    };
    // One handshake per layer (the frame's src never changes).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pause while hidden / held / resting / leaving; play again after.
  useEffect(() => {
    if (!ready) return;
    send(active ? 'playVideo' : 'pauseVideo');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, ready]);

  return (
    // `inert`: the player can never take focus, a click or a key — the learning interface above it stays the only target.
    <div ref={wrapRef} className={styles.ytWrap} data-testid="wallpaper-youtube-background" data-youtube-id={videoId} inert>
      <iframe
        ref={frameRef}
        className={styles.ytFrame}
        src={src}
        title="YouTube"
        allow="autoplay; encrypted-media"
        referrerPolicy="strict-origin-when-cross-origin"
        tabIndex={-1}
      />
    </div>
  );
}
