import { authFetch } from '@/lib/api-session';
import { getBaseUrl } from '@/services/api-client';

// The worklet delivers 100 ms frames at 16 kHz.
export const END_OF_TURN_MS = 4000;
const FRAME_MS = 100;
const CLIP_FRAMES = 200;
const MAX_TURN_FRAMES = 1200;

export type WarmEchoInput = {
  stream: MediaStream;
  context: AudioContext;
  node: AudioWorkletNode;
  preroll: Int16Array[];
};

function possibleCaption(text: string) {
  return /(?:đăng k[ýí]|subscribe).{0,24}(?:kênh|channel)|la\s*la\s*school/iu.test(text);
}

/** Capture one utterance for the private speech service. Keep PCM in memory only. */
export async function captureEchoSpeech(lang: 'vi' | 'en', signal: AbortSignal,
  onReady: () => void, onPartial: (text: string) => void, pauseMs = END_OF_TURN_MS, warm?: WarmEchoInput): Promise<{text: string; reviewNeeded: boolean}> {
  signal.throwIfAborted();
  const stream = warm?.stream ?? await navigator.mediaDevices.getUserMedia({audio: {echoCancellation: true, noiseSuppression: true, channelCount: 1}});
  let ctx: AudioContext | undefined = warm?.context;
  let timer: number | undefined;
  const cleanup = () => {
    window.clearTimeout(timer);
    stream.getTracks().forEach(track => track.stop());
    if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => {});
    ctx = undefined;
  };
  const transcribe = async (chunks: Int16Array[], requestSignal: AbortSignal) => {
    const pcm = new Int16Array(chunks.reduce((count, chunk) => count + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) { pcm.set(chunk, offset); offset += chunk.length; }
    const response = await authFetch(getBaseUrl() + '/ai/chat/transcribe?lang=' + lang, {
      method: 'POST', signal: requestSignal, headers: {'Content-Type':'application/octet-stream'}, body: pcm.buffer,
    });
    if (!response.ok) throw new Error(response.status === 429 ? 'rate' : 'service');
    const result = await response.json();
    if (typeof result.text !== 'string') throw new Error('service');
    return {text: result.text.trim().slice(0, 4000), reviewNeeded: result.reviewNeeded !== false};
  };
  signal.addEventListener('abort', cleanup, {once: true});
  try {
    signal.throwIfAborted();
    const audioContext = warm?.context ?? new AudioContext({sampleRate:16000});
    ctx = audioContext;
    let node = warm?.node;
    if (!node) {
      await audioContext.audioWorklet.addModule('/echo-mic-worklet.js');
      signal.throwIfAborted();
      await audioContext.resume();
      signal.throwIfAborted();
      node = new AudioWorkletNode(audioContext, 'echo-microphone', {numberOfOutputs:0});
      audioContext.createMediaStreamSource(stream).connect(node);
    }
    const microphone = node;
    let prefix = '';
    let needsReview = false;
    let decode: Promise<void> = Promise.resolve();
    let previewBusy = false, lastPreview = -40;
    let segment = 0, lastVoice = 0, voicedFrames = 0, elapsed = 0;
    let frames: Int16Array[] = [];
    let cached: {segment: number; end: number; result: Awaited<ReturnType<typeof transcribe>>} | undefined;
    let ended = false;

    // A full transport clip rolls over while the microphone keeps listening.
    const finishClip = (midWord: boolean) => {
      const index = segment++, end = lastVoice;
      const clip = frames.slice(0, end + 3);
      const voiceSeconds = voicedFrames * FRAME_MS / 1000;
      frames = []; lastVoice = 0; voicedFrames = 0;
      if (!end) return;
      decode = decode.then(async () => {
        signal.throwIfAborted();
        const result = cached?.segment === index && cached.end === end
          ? cached.result : await transcribe(clip, signal);
        prefix = [prefix, result.text].filter(Boolean).join(' ');
        // A very short sound can give Whisper a fluent but implausibly long transcript.
        // Channel outros repeatedly appeared in quiet webcam clips. Let the learner confirm them.
        needsReview ||= possibleCaption(result.text) || midWord || result.reviewNeeded || !result.text ||
          result.text.split(/\s+/u).length > 4 + 6 * voiceSeconds;
        if (!signal.aborted) onPartial(prefix);
      });
      void decode.catch(() => {}); // Propagated by the final await.
    };

    await new Promise<void>((resolve, reject) => {
      let quiet = 0, voiced = 0;
      const preroll: Int16Array[] = [];
      signal.onabort = () => reject(new DOMException('Aborted', 'AbortError'));
      stream.getAudioTracks()[0].onended = () => reject(new Error('audio-capture'));
      timer = window.setTimeout(() => reject(new Error('no-speech')), 26000);
      const acceptFrame = (data: Int16Array, buffered = false) => {
        if (signal.aborted || ended) return;
        let power = 0;
        for (const sample of data) power += sample * sample;
        const loud = Math.sqrt(power / data.length) > 400;
        voiced = loud ? voiced + 1 : 0;
        if (!warm && !elapsed && voiced < 2) {
          preroll.push(data);
          if (preroll.length > 3) preroll.shift();
          return;
        }
        if (!elapsed) { window.clearTimeout(timer); frames.push(...preroll); }
        elapsed++; frames.push(data);
        quiet = loud ? 0 : quiet + 1;
        if (loud) { lastVoice = frames.length; voicedFrames++; }
        if (!buffered && (quiet * FRAME_MS >= pauseMs || elapsed >= MAX_TURN_FRAMES)) {
          ended = true;
          needsReview ||= elapsed >= MAX_TURN_FRAMES;
          finishClip(false);
          resolve();
        } else if ((frames.length >= 150 && quiet >= 4) || frames.length >= CLIP_FRAMES) {
          finishClip(quiet < 4);
        } else if (!buffered && !previewBusy && lastVoice && elapsed - lastPreview >= 40 &&
            (quiet === 6 || (loud && frames.length >= 24))) {
          const index = segment, end = lastVoice;
          const snapshot = frames.slice(0, end + 3);
          previewBusy = true; lastPreview = elapsed;
          decode = decode.then(async () => {
            if (ended || signal.aborted || index !== segment) return;
            try {
              const result = await transcribe(snapshot, signal);
              // Reuse only a complete, padded clip when no further speech arrives.
              if (snapshot.length >= end + 3) cached = {segment: index, end, result};
              if (!ended && !signal.aborted && segment === index && result.text && !possibleCaption(result.text))
                onPartial([prefix, result.text].filter(Boolean).join(' '));
            } catch { /* The final decode can still succeed. */ }
          }).finally(() => { previewBusy = false; });
          void decode.catch(() => {});
        }
      };
      microphone.port.onmessage = ({data}: MessageEvent<Int16Array>) => acceptFrame(data);
      // Never endpoint halfway through the historical buffer. Its last frames just triggered speech.
      for (const frame of warm?.preroll ?? []) acceptFrame(frame, true);
      onReady();
    });
    cleanup();
    await decode;
    signal.throwIfAborted();
    return {text: prefix.slice(0, 4000), reviewNeeded: needsReview || prefix.length > 4000};
  } finally {
    signal.onabort = null;
    signal.removeEventListener('abort', cleanup);
    cleanup();
  }
}
