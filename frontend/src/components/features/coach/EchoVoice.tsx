'use client';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { captureEchoSpeech, END_OF_TURN_MS, type WarmEchoInput } from './echo-microphone';
import { EchoOmniPlayback, OMNI_VOICES, type EchoSpeaker } from './echo-omni-playback';
import { getBaseUrl } from '@/services/api-client';
import { MessageCircle, Mic, Play, RotateCcw, Square, X } from 'lucide-react';
import { EchoOrb } from './EchoOrb';
// Static imports on purpose (CoachWidget already ships both): the voice presentation must be known on the panel's FIRST
// render. The former lazy import painted the chat first and swapped to the voice stage a tick later (incident 2026-11-25).
import { echoVoiceSessionStore, setVoiceStage } from '@/lib/echo-jarvis/intents';
import { getEchoJarvisRuntime } from '@/lib/echo-jarvis/runtime/echoJarvisRuntime';
import { resolveEchoVoiceRecoveryCopy } from './echo-window';

/** Both microphone modes feed the ordinary, authenticated Echo conversation. */
type Phase = 'off' | 'starting' | 'listening' | 'review' | 'thinking' | 'speaking';
const VI_CHARS = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;
const NOTE_KEY = 'echo_voice_note:v1';

export function speakableSentences(text: string): { text: string; lang: 'vi-VN' | 'en-US' }[] {
  const plain = text.replace(/\*\*/g, '').replace(/^#{1,4}\s+/gm, '').replace(/^\s*[-•]\s+/gm, '').replace(/\[[^\]\n]+->[^\]\n]+\]/g, '');
  return plain.split(/(?<=[.!?…:])\s+|\n+/).map(s => s.trim()).filter(Boolean).slice(0, 24)
    .map(s => ({ text: s, lang: VI_CHARS.test(s) ? 'vi-VN' as const : 'en-US' as const }));
}

// Keep punctuation inside a passage so TTS can phrase adjacent sentences naturally; fastClause releases Clause 0 early.
export function omniPassageLength(tail: string, complete: boolean, fastClause = false) {
  if (complete && tail.length <= 480) return tail.length;
  if (fastClause && tail.length <= 480) {
    const firstSentence = tail.match(/^[\s\S]*?[.!?…:;—]["”’)]?\s+/u);
    if (firstSentence && firstSentence[0].length >= 34) return firstSentence[0].length;
    const firstClause = tail.match(/^[\s\S]*?,["”’)]?\s+/u);
    if (firstClause && firstClause[0].length >= 52) return firstClause[0].length;
  }
  if (tail.length <= 480) {
    const ready = tail.match(/^[\s\S]*[.!?…]["”’)]?\s+/u);
    return ready && ready[0].length >= 210 ? ready[0].length : 0;
  }
  const window = tail.slice(0, 480);
  const sentence = window.match(/^[\s\S]*[.!?…]["”’)]?\s+/u);
  if (sentence && sentence[0].length >= 100) return sentence[0].length;
  const word = window.search(/\s+\S*$/u);
  return word > 0 ? word + 1 : /[\uD800-\uDBFF]$/.test(window) ? 479 : 480;
}

function recognizerClass(): (new () => any) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: new () => any; webkitSpeechRecognition?: new () => any };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

type JarvisRuntimeLike = {
  configure: (opts: { userId: string; voiceId?: 'us_female' | 'us_male' | 'uk_female' | 'uk_male'; locale?: 'en' | 'vi' }) => void;
  setHandsFreeEnabled: (enabled: boolean, opts?: { userInitiated?: boolean }) => Promise<boolean>;
  startActiveVoiceTurn: () => Promise<boolean>;
  interruptCurrentTurn?: () => void;
  enterSleep?: (opts?: { silent?: boolean }) => void;
  retryLastVoiceTurn?: () => Promise<boolean>;
  dismissError?: () => void;
  isSpeechOutputActive?: () => boolean;
};
const jarvis = () => getEchoJarvisRuntime() as unknown as JarvisRuntimeLike;

export function EchoVoice({
  vi,
  busy,
  failedTurn,
  reply,
  onUtterance,
  onInterruptTurn,
  ambientOnly = false,
  userId = '',
  exhausted = false,
}: {
  vi: boolean;
  busy: boolean;
  failedTurn?: boolean;
  reply: { key: string; text: string; complete: boolean } | null;
  onUtterance: (text: string, language: 'vi' | 'en') => void;
  onInterruptTurn: () => void;
  ambientOnly?: boolean;
  userId?: string;
  panelOpen?: boolean;
  activeSessionId?: number | null;
  exhausted?: boolean;
  companionSide?: 'left' | 'right';
  companionPoint?: { x: number; y: number; size: number } | null;
  getHistory?: () => { role: string; content: string }[];
  onAppendTurn?: (userText: string, assistantText: string, cards?: any[], actions?: any[]) => void;
  onOpenPanel?: () => void;
  onOpenWorkspace?: () => void;
  onCollapsePanel?: () => void;
}) {
  // The ONE voice session store, read synchronously (same snapshot as CoachWidget and the companion anchor).
  const snap = useSyncExternalStore(
    echoVoiceSessionStore.subscribe,
    echoVoiceSessionStore.getSnapshot,
    echoVoiceSessionStore.getServerSnapshot,
  );
  const handsFreeWakeOn = Boolean(userId) && snap.handsFreeEnabled;
  const runtimeSpeechDraining =
    Boolean(userId) &&
    snap.entityState !== 'interrupted' &&
    snap.entityState !== 'error' &&
    snap.entityState !== 'disabled' &&
    snap.entityState !== 'sleeping' &&
    jarvis().isSpeechOutputActive?.() === true;
  const runtimeEntityState: string =
    runtimeSpeechDraining &&
    (snap.entityState === 'listening' ||
      snap.entityState === 'understanding' ||
      snap.entityState === 'thinking' ||
      snap.entityState === 'executing')
      ? 'speaking'
      : snap.entityState;
  const runtimeCaption =
    (runtimeEntityState === 'speaking' || runtimeEntityState === 'thinking' || runtimeEntityState === 'executing'
      ? snap.liveCaption.echoSpoken || snap.liveCaption.userPartial
      : snap.liveCaption.userPartial || snap.liveCaption.echoSpoken) || '';

  const [phase, setPhase] = useState<Phase>('off');
  const [interim, setInterim] = useState('');
  const [lang, setLang] = useState<'vi-VN' | 'en-US'>(vi ? 'vi-VN' : 'en-US');
  const language = useRef(lang); language.current = lang;
  const [notice, setNotice] = useState('');
  const [pauseMs, setPauseMs] = useState(END_OF_TURN_MS);
  const [speaker, setSpeaker] = useState<EchoSpeaker>('us_female');
  const omni = useRef<EchoOmniPlayback | null>(null);
  const preview = useRef<HTMLAudioElement | null>(null);
  const [previewing, setPreviewing] = useState(false);
  useEffect(() => {
    try {
      if (localStorage.getItem('echo_voice_wait') === '7000') setPauseMs(7000);
      const value = localStorage.getItem('echo_voice_speaker');
      if (value === 'device' || OMNI_VOICES.some(id => id === value)) setSpeaker(value as EchoSpeaker);
    } catch { /* storage unavailable */ }
    return () => { preview.current?.pause(); omni.current?.stop(); };
  }, []);
  const stopPreview = () => { preview.current?.pause(); preview.current = null; setPreviewing(false); };
  const phaseRef = useRef<Phase>('off'); phaseRef.current = phase;
  const [offerFallback, setOfferFallback] = useState(false);
  const useLocalSpeech = useRef(false);
  const handsFree = useRef(false);
  const recording = useRef<AbortController | null>(null);
  const recognition = useRef<any>(null);
  const nativeDeadline = useRef<number | undefined>(undefined);
  const cursor = useRef(0);
  const queued = useRef(0);
  const completed = useRef(false);
  const epoch = useRef(0);
  const mounted = useRef(true);
  const submitted = useRef(onUtterance); submitted.current = onUtterance;
  const spokenKey = useRef<string | null>(null);
  const meter = useRef<WarmEchoInput | null>(null);
  const meterStarting = useRef(false);
  const interruptRef = useRef<(input?: WarmEchoInput) => void>(() => {});
  const supported = typeof window !== 'undefined' && !!recognizerClass() && 'speechSynthesis' in window;

  const stopMeter = useCallback(() => {
    const m = meter.current; meter.current = null;
    if (!m) return;
    m.node.port.onmessage = null;
    m.stream.getTracks().forEach(t => t.stop());
    void m.context.close().catch(() => {});
  }, []);

  const stopListening = useCallback(() => {
    window.clearTimeout(nativeDeadline.current); nativeDeadline.current = undefined;
    recording.current?.abort(); recording.current = null;
    const r = recognition.current; recognition.current = null;
    if (r) { r.onspeechstart = r.onspeechend = r.onstart = r.onresult = r.onend = r.onerror = null; try { r.abort(); } catch { /* already stopped */ } }
    setInterim('');
  }, []);

  const failed = useCallback((code: string) => {
    phaseRef.current = 'off'; setPhase('off'); stopListening(); stopMeter();
    const messages: Record<string, [string, string]> = {
      'network': ['Dịch vụ nhận giọng nói của trình duyệt không kết nối được.', 'The browser’s speech service could not connect.'],
      'connection_interrupted': ['Kết nối giọng nói tạm gián đoạn. Bạn thử lại nhé.', 'Voice connection briefly interrupted. Please try again.'],
      'service-not-allowed': ['Trình duyệt chặn dịch vụ nhận giọng nói.', 'The browser blocked its speech recognition service.'],
      'unsupported': ['Trình duyệt này chưa hỗ trợ nhận giọng nói.', 'This browser does not support native speech recognition.'],
      'language-not-supported': ['Dịch vụ trình duyệt chưa hỗ trợ ngôn ngữ này.', 'The browser speech service does not support this language.'],
      'not-allowed': ['Trình duyệt chưa cho phép micro. Hãy kiểm tra quyền micro của trang.', 'The browser blocked the microphone. Check the site’s microphone permission.'],
      'mic_unavailable': ['Chưa mở được micro. Hãy kiểm tra quyền micro của trang.', 'Microphone unavailable. Check the site’s microphone permission.'],
      'audio-capture': ['Không thu được âm thanh. Hãy kiểm tra micro đã kết nối và thiết bị đầu vào.', 'Audio capture failed. Check the connected microphone and selected input.'],
      'device-busy': ['Không mở được micro. Hãy kiểm tra ứng dụng khác đang dùng thiết bị.', 'Could not open the microphone. Check whether another app is using it.'],
      'no-speech': ['Chưa nghe thấy lời nói. Bật micro để thử lại.', 'No speech detected. Turn the microphone on to try again.'],
      'speech_unrecognized': ['Echo chưa nghe rõ câu vừa rồi. Bạn nói lại giúp mình nhé.', 'Echo did not catch that clearly. Please try speaking again.'],
      'aborted': ['Trình duyệt đã dừng phiên nghe. Bạn có thể thử lại.', 'The browser stopped listening. You can try again.'],
      'rate': ['Đã đạt giới hạn nhận giọng nói. Hãy thử lại sau.', 'Speech input has reached its limit. Try again later.'],
      'quota_limit': ['Bạn đã dùng hết lượt trò chuyện hôm nay.', 'You have reached today’s conversation allowance.'],
      'service': ['Dịch vụ giọng nói English Coach hiện chưa sẵn sàng. Hãy thử lại sau.', 'English Coach speech recognition is unavailable. Try again later.'],
      'service_busy': ['Echo đang bận một nhịp ngắn. Bạn thử hỏi lại ngay nhé.', 'Echo is momentarily busy. Please try asking again.'],
    };
    const message = messages[code] ?? ['Echo tạm bận một chút. Bạn thử nói lại nhé.', 'Echo is momentarily busy. Please try again.'];
    setNotice(message[vi ? 0 : 1]);
    setOfferFallback(!useLocalSpeech.current && ['network','unsupported','service-not-allowed','language-not-supported'].includes(code));
    useLocalSpeech.current = false;
  }, [stopListening, stopMeter, vi]);

  const listen = useCallback((warm?: WarmEchoInput) => {
    stopListening(); stopMeter();
    phaseRef.current = 'starting'; setPhase('starting');
    const locale = language.current === 'vi-VN' ? 'vi' : 'en';
    const listening = () => { phaseRef.current = 'listening'; setPhase('listening'); };
    const submit = (text: string) => {
      if (!text.trim()) { failed('no-speech'); return; }
      setInterim(''); phaseRef.current = 'thinking'; setPhase('thinking'); submitted.current(text.trim().slice(0,4000), locale);
    };
    if (useLocalSpeech.current) {
      const controller = new AbortController();
      recording.current = controller;
      void captureEchoSpeech(locale, controller.signal, listening, setInterim, pauseMs, warm).then(({text, reviewNeeded}) => {
        if (recording.current !== controller || controller.signal.aborted) return;
        recording.current = null;
        if (!text) { failed('no-speech'); return; }
        if (handsFree.current && !reviewNeeded) { submit(text); return; }
        setInterim(text); phaseRef.current = 'review'; setPhase('review');
      }).catch((err: Error) => {
        if (recording.current !== controller || controller.signal.aborted) return;
        const deviceErrors: Record<string, string> = { NotAllowedError:'not-allowed', NotFoundError:'audio-capture', NotReadableError:'device-busy' };
        failed(deviceErrors[err.name] ?? err.message);
      });
      return;
    }
    const Recognizer = recognizerClass();
    if (!Recognizer) { failed('unsupported'); return; }
    const r = new Recognizer();
    r.lang = language.current; r.interimResults = true; r.continuous = true; r.maxAlternatives = 1;
    let finalText = '';
    recognition.current = r;
    r.onstart = () => { if (recognition.current === r) listening(); };
    let saved = '';
    const finishNative = () => {
      if (recognition.current !== r) return;
      const text = [saved, finalText].join(' ').trim();
      stopListening(); submit(text);
    };
    const deferNative = () => {
      window.clearTimeout(nativeDeadline.current);
      nativeDeadline.current = window.setTimeout(finishNative, pauseMs);
    };
    r.onspeechstart = () => { window.clearTimeout(nativeDeadline.current); nativeDeadline.current = undefined; };
    r.onspeechend = deferNative;
    r.onresult = (event: any) => {
      if (recognition.current !== r) return;
      let partial = ''; finalText = '';
      for (let i = 0; i < event.results.length; i++) {
        const t = event.results[i][0]?.transcript ?? '';
        if (event.results[i].isFinal) finalText += t + ' '; else partial += t;
      }
      setInterim([saved, finalText + partial].join(' ').trim());
      window.clearTimeout(nativeDeadline.current); nativeDeadline.current = undefined;
      if (finalText && !partial) deferNative();
    };
    r.onerror = (event: any) => { if (recognition.current === r) failed(event.error); };
    r.onend = () => {
      if (recognition.current !== r) return;
      if (!finalText.trim() && !saved) { failed('no-speech'); return; }
      saved = [saved, finalText].join(' ').trim(); finalText = '';
      if (nativeDeadline.current === undefined) deferNative();
      try { r.start(); } catch { deferNative(); }
    };
    try { r.start(); } catch { failed('audio-capture'); }
  }, [failed, stopListening, stopMeter, pauseMs]);

  const startMeter = useCallback(async () => {
    if (meter.current || meterStarting.current || !navigator.mediaDevices?.getUserMedia) return;
    const version = epoch.current;
    meterStarting.current = true;
    let pending: MediaStream | undefined;
    let newContext: AudioContext | undefined;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      pending = stream;
      if (!mounted.current || epoch.current !== version || !['thinking','speaking'].includes(phaseRef.current) || meter.current) return;
      const ctx = new AudioContext({sampleRate: 16000});
      newContext = ctx;
      await ctx.audioWorklet.addModule('/echo-mic-worklet.js');
      await ctx.resume();
      if (!mounted.current || epoch.current !== version || !['thinking','speaking'].includes(phaseRef.current)) return;
      const node = new AudioWorkletNode(ctx, 'echo-microphone', {numberOfOutputs: 0});
      ctx.createMediaStreamSource(stream).connect(node);
      const input: WarmEchoInput = {stream, context: ctx, node, preroll: []};
      meter.current = input;
      const retainedFrames = Math.ceil(pauseMs / 100) + 15;
      const recentActivity: boolean[] = [];
      node.port.onmessage = ({data}: MessageEvent<Int16Array>) => {
        if (meter.current !== input || !['thinking', 'speaking'].includes(phaseRef.current)) return;
        input.preroll.push(data);
        if (input.preroll.length > retainedFrames) input.preroll.shift();
        let power = 0;
        for (const sample of data) power += sample * sample;
        recentActivity.push(Math.sqrt(power / data.length) >= 850);
        if (recentActivity.length > 3) recentActivity.shift();
        if (recentActivity.filter(Boolean).length < 2) return;
        if (useLocalSpeech.current) {
          meter.current = null;
          node.port.onmessage = null;
          interruptRef.current(input);
        } else {
          interruptRef.current();
        }
      };
      pending = undefined; newContext = undefined;
    } catch { /* barge-in by voice unavailable: the stop button still works */ }
    finally {
      meterStarting.current = false; pending?.getTracks().forEach(t => t.stop());
      if (newContext) void newContext.close().catch(() => {});
    }
  }, [pauseMs]);

  const abandonSpeech = useCallback(() => {
    epoch.current++; queued.current = 0; cursor.current = 0; completed.current = false;
    omni.current?.stop();
    window.speechSynthesis?.cancel();
  }, []);
  const interrupt = useCallback((warm?: WarmEchoInput) => {
    if (phaseRef.current === 'thinking' || phaseRef.current === 'speaking') {
      abandonSpeech(); onInterruptTurn(); listen(warm);
    }
  }, [abandonSpeech, listen, onInterruptTurn]);
  interruptRef.current = interrupt;
  useEffect(() => {
    if (phase === 'thinking' && handsFree.current) void startMeter();
  }, [phase, startMeter]);

  const turnOff = useCallback(() => {
    useLocalSpeech.current = false; setOfferFallback(false); setNotice('');
    if (phaseRef.current === 'thinking' || phaseRef.current === 'speaking') onInterruptTurn();
    phaseRef.current = 'off'; setPhase('off'); stopListening(); stopMeter(); abandonSpeech();
  }, [abandonSpeech, onInterruptTurn, stopListening, stopMeter]);

  const turnOn = useCallback((fallback = false, live = false) => {
    stopPreview();
    setNotice(''); setOfferFallback(false); useLocalSpeech.current = fallback; handsFree.current = live;
    setVoiceStage(true);
    if (!supported && !fallback) { failed('unsupported'); return; }
    try { if (!fallback && !localStorage.getItem(NOTE_KEY)) { localStorage.setItem(NOTE_KEY, '1');
      setNotice(vi ? 'Giọng nói được trình duyệt chuyển thành chữ (Chrome/Edge có thể dùng dịch vụ nhận dạng của hãng trình duyệt). Echo chỉ nhận văn bản.'
        : 'Your browser turns speech into text (Chrome/Edge may use their vendor’s recognition service). Echo receives text only.'); } } catch { /* storage off */ }
    window.dispatchEvent(new Event('ec:music-pause'));
    spokenKey.current = reply?.key ?? null;
    phaseRef.current = 'listening';
    listen();
  }, [listen, reply?.key, failed, supported, vi]);

  const startUnifiedRuntimeVoice = useCallback(async () => {
    stopPreview();
    setNotice('');
    setOfferFallback(false);
    // Explicit voice entry: the panel shows the voice stage from this frame on, whatever the turn does next.
    setVoiceStage(true);
    if (exhausted || snap.moduleMicActive) return;
    let hasRuntimeStart = false;
    try {
      const rt = jarvis();
      if (rt && typeof rt.startActiveVoiceTurn === 'function') {
        hasRuntimeStart = true;
        await rt.startActiveVoiceTurn();
        return;
      }
    } catch {
      // Fall back gracefully to local capture ONLY if unified runtime throws on boot.
      turnOn(true, true);
      return;
    }
    if (!hasRuntimeStart) {
      turnOn(true, true);
    }
  }, [exhausted, snap.moduleMicActive, turnOn]);

  useEffect(() => {
    if (phaseRef.current !== 'thinking' && phaseRef.current !== 'speaking') return;
    if (!reply) {
      if (failedTurn) {
        abandonSpeech(); stopMeter(); stopListening(); phaseRef.current = 'off'; setPhase('off'); return;
      }
      if (!busy) { abandonSpeech(); listen(); }
      return;
    }
    if (spokenKey.current !== reply.key) {
      spokenKey.current = reply.key; cursor.current = 0; completed.current = false;
    }
    const tail = reply.text.slice(cursor.current);
    completed.current = reply.complete;
    const version = epoch.current;
    let parts: ReturnType<typeof speakableSentences> = [];
    if (speaker !== 'device') {
      let remaining = tail;
      while (remaining.length) {
        const size = omniPassageLength(remaining, reply.complete, cursor.current === 0);
        if (!size) break;
        const passage = remaining.slice(0, size).replace(/\*\*|__|\x60/g, '')
          .replace(/^#{1,6}\s+|^[ \t]*[-•]\s+/gm, '').replace(/\[[^\]\n]+->[^\]\n]+\]/g, '')
          .replace(/\s+/g, ' ').trim();
        cursor.current += size;
        remaining = remaining.slice(size);
        if (!passage) continue;
        omni.current ??= new EchoOmniPlayback();
        queued.current++;
        omni.current.enqueue(passage, speaker, () => {
          if (epoch.current !== version || !mounted.current) return;
          if (phaseRef.current !== 'speaking') { phaseRef.current = 'speaking'; setPhase('speaking'); void startMeter(); }
        }, failedPlayback => {
          if (epoch.current !== version || !mounted.current) return;
          if (failedPlayback) {
            abandonSpeech(); phaseRef.current = 'off'; setPhase('off'); stopMeter();
            setNotice(vi ? 'Echo chưa phát được câu trả lời. Bạn có thể nghe thử hoặc chọn giọng khác.' : 'Echo could not play the reply. Preview a voice or choose another.');
            return;
          }
          queued.current--;
          if (!queued.current && completed.current) listen();
        });
      }
    } else {
      const size = reply.complete ? tail.length : (tail.match(/^[\s\S]*[.!?…]\s+/)?.[0].length ?? 0);
      cursor.current += size;
      parts = speakableSentences(tail.slice(0, size));
    }
    for (const part of parts) {
      const u = new SpeechSynthesisUtterance(part.text);
      u.lang = part.lang; u.rate = part.lang === 'en-US' ? 0.95 : 1;
      const voice = window.speechSynthesis.getVoices().find(v => v.lang?.toLowerCase().startsWith(part.lang.slice(0,2)));
      if (voice) u.voice = voice;
      if (phaseRef.current !== 'speaking') void startMeter();
      queued.current++;
      phaseRef.current = 'speaking'; setPhase('speaking');
      u.onend = u.onerror = () => {
        if (!mounted.current || epoch.current !== version) return;
        queued.current--;
        if (queued.current === 0 && completed.current) listen();
      };
      window.speechSynthesis.speak(u);
    }
    if (queued.current === 0 && completed.current) listen();
  }, [reply, busy, failedTurn, listen, abandonSpeech, startMeter, stopMeter, stopListening, speaker, vi]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false; phaseRef.current = 'off'; stopListening(); stopMeter(); abandonSpeech();
    };
  }, [abandonSpeech, stopListening, stopMeter]);

  const runtimePhase: Phase =
    runtimeEntityState === 'awakening' ? 'starting'
    : runtimeEntityState === 'listening' || runtimeEntityState === 'understanding' ? 'listening'
    : runtimeEntityState === 'thinking' || runtimeEntityState === 'executing' ? 'thinking'
    : runtimeEntityState === 'speaking' ? 'speaking'
    : 'off';
  const runtimeActive = phase === 'off' && runtimePhase !== 'off';
  const effectivePhase: Phase = phase !== 'off' ? phase : runtimePhase;
  // The stage belongs to the presentation the learner chose (store `voiceStage`), not to the current turn state:
  // capture end, ASR, a failed generation, playback end or the follow-up rest never hand the panel back to the chat.
  const stageChosen = snap.voiceStage && Boolean(userId) && !ambientOnly;
  const on = effectivePhase !== 'off' || stageChosen;
  const resting = on && effectivePhase === 'off';
  const [exhaustedBannerDismissed, setExhaustedBannerDismissed] = useState(false);
  useEffect(() => {
    if (!exhausted) setExhaustedBannerDismissed(false);
  }, [exhausted]);
  const voiceError = stageChosen && (snap.lastError || (exhausted && resting && !exhaustedBannerDismissed))
    ? resolveEchoVoiceRecoveryCopy(snap.lastError?.title, snap.lastError?.subtitle, vi, exhausted)
    : null;
  const stageRef = useRef<HTMLDivElement>(null);
  const wasOnRef = useRef(false);
  useEffect(() => {
    const enteredStage = on && !wasOnRef.current;
    wasOnRef.current = on;
    if (!enteredStage || ambientOnly || typeof requestAnimationFrame !== 'function') return;
    const frame = requestAnimationFrame(() => {
      stageRef.current
        ?.querySelector<HTMLButtonElement>('.echo-voice-main:not(:disabled), .echo-voice-side')
        ?.focus?.({ preventScroll: true });
    });
    return () => {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
    };
  }, [on, ambientOnly]);
  useEffect(() => {
    if (busy && !on) { setNotice(''); setOfferFallback(false); }
  }, [busy, on]);
  // A wake word heard while the panel is open is a voice entry too (hands-free "Hi, Echo"): only the transition INTO
  // 'awakening' selects the stage, so an explicit "open the chat" is never overridden by an ongoing turn.
  useEffect(() => {
    if (runtimeEntityState === 'awakening' && userId && !ambientOnly && !echoVoiceSessionStore.getSnapshot().voiceStage) setVoiceStage(true);
  }, [runtimeEntityState, userId, ambientOnly]);

  const stopVoiceSession = useCallback(() => {
    // Explicit exit: back to the typed conversation.
    setVoiceStage(false);
    jarvis().dismissError?.();
    (echoVoiceSessionStore as typeof echoVoiceSessionStore & { clearVoiceError?: () => void }).clearVoiceError?.();
    if (runtimeActive || runtimeEntityState === 'error' || runtimeEntityState === 'interrupted' || runtimeEntityState === 'reconnecting') {
      jarvis().interruptCurrentTurn?.();
      jarvis().enterSleep?.();
      return;
    }
    turnOff();
  }, [runtimeActive, runtimeEntityState, turnOff]);

  const interruptVoiceSession = useCallback(() => {
    if (runtimeActive) {
      jarvis().interruptCurrentTurn?.();
      return;
    }
    interrupt();
  }, [runtimeActive, interrupt]);

  const retryVoiceTurn = useCallback(() => {
    if (busy || exhausted || snap.moduleMicActive) return;
    const rt = jarvis();
    if (typeof rt.retryLastVoiceTurn === 'function') void rt.retryLastVoiceTurn();
    else void rt.startActiveVoiceTurn();
  }, [busy, exhausted, snap.moduleMicActive]);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef(false);
  const dockRef = useRef<HTMLDivElement>(null);
  const endHold = () => { if (hold.current) { clearTimeout(hold.current); hold.current = null; } };
  useEffect(() => { if (on) setSettingsOpen(false); }, [on]);
  useEffect(() => {
    if (!settingsOpen) return;
    const away = (e: PointerEvent) => { if (!dockRef.current?.contains(e.target as Node)) setSettingsOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [settingsOpen]);
  useEffect(() => () => endHold(), []);

  const label = !on ? (vi ? 'Trò chuyện trực tiếp' : 'Start live conversation')
    : snap.moduleMicActive ? (vi ? 'Đang nhường micro cho bài luyện…' : 'Microphone in use by practice…')
    : resting ? (runtimeEntityState === 'reconnecting' ? (vi ? 'Đang kết nối lại…' : 'Reconnecting…')
      : exhausted ? (vi ? 'Đã hết lượt trò chuyện hôm nay' : 'Daily conversation limit reached')
      : handsFreeWakeOn ? (vi ? 'Nói “Hi, Echo” hoặc nhấn micro' : 'Say “Hi, Echo” or tap the mic')
      : (vi ? 'Nhấn micro để nói tiếp' : 'Tap the mic to keep talking'))
    : effectivePhase === 'starting' ? (vi ? 'Đang mở micro…' : 'Starting microphone…')
    : effectivePhase === 'review' ? (vi ? 'Xem lại câu của bạn' : 'Review what you said')
    : effectivePhase === 'listening' ? (vi ? 'Đang nghe…' : 'Listening…')
    : effectivePhase === 'thinking' ? (vi ? 'Echo đang nghĩ…' : 'Echo is thinking…') : (vi ? 'Echo đang nói…' : 'Echo is speaking…');
  const info = vi ? 'Echo JARVIS dùng Smart Turn và WebSocket song công theo thời gian thực để nghe tự nhiên và trả lời tức thì.'
    : 'Echo JARVIS uses real-time full-duplex audio and Smart Turn detection for natural speech and instant responses.';
  const voiceNames: Record<string, string> = vi
    ? { us_female: 'Nữ · Mỹ', us_male: 'Nam · Mỹ', uk_female: 'Nữ · Anh', uk_male: 'Nam · Anh', device: 'Thiết bị' }
    : { us_female: 'US female', us_male: 'US male', uk_female: 'UK female', uk_male: 'UK male', device: 'Device' };

  const spoken = (reply?.text ?? '').replace(/\*\*|__|`/g, '').replace(/\[[^\]\n]+->[^\]\n]+\]/g, '').replace(/\s+/g, ' ').trim();
  const rawCaption = runtimeActive
    ? runtimeCaption
    : (effectivePhase === 'speaking' || effectivePhase === 'thinking' ? spoken : interim);
  const caption = rawCaption.length > 170
    ? '…' + rawCaption.slice(rawCaption.length - 170).replace(/^\S*\s/, '')
    : rawCaption;
  const stageHint = snap.moduleMicActive
    ? (vi ? 'Hoàn tất ghi âm bài luyện để tiếp tục nói với Echo.' : 'Finish your practice recording to talk to Echo again.')
    : effectivePhase === 'listening'
      ? (vi ? 'Cứ nói tự nhiên, Echo đang nghe.' : 'Speak naturally, Echo is listening.')
      : '';
  const switchLang = () => {
    language.current = lang === 'vi-VN' ? 'en-US' : 'vi-VN';
    setLang(language.current);
    if (phaseRef.current === 'listening' || phaseRef.current === 'starting') listen();
  };
  const sendReview = () => {
    if (phaseRef.current !== 'review' || busy || !interim.trim()) return;
    const text = interim.trim(); setInterim(''); phaseRef.current = 'thinking'; setPhase('thinking');
    submitted.current(text, language.current === 'vi-VN' ? 'vi' : 'en');
  };
  const playPreview = () => {
    if (previewing) { stopPreview(); return; }
    const audio = new Audio(getBaseUrl() + '/speaking/tts/preview?voiceId=' + speaker);
    preview.current = audio; setPreviewing(true);
    audio.onended = () => { if (preview.current === audio) stopPreview(); };
    const fail = () => { if (preview.current === audio) { stopPreview(); setNotice(vi ? 'Chưa phát được giọng mẫu.' : 'Could not play the sample.'); } };
    audio.onerror = fail; void audio.play().catch(fail);
  };
  const orbState = effectivePhase === 'listening' || effectivePhase === 'starting' || effectivePhase === 'review' ? 'listening' : effectivePhase === 'speaking' ? 'speaking' : effectivePhase === 'thinking' ? 'thinking' : 'idle';

  const toggleHandsFreeWake = () => {
    const next = !handsFreeWakeOn;
    // Turning JARVIS hands-free on from the panel enters the voice presentation directly (no chat in between).
    if (next) setVoiceStage(true);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('ec:jarvis:toggle-handsfree', { detail: { enabled: next } }));
    }
  };

  // Single-anchor architecture: Ambient Living Entity lives ONCE in `<EchoCompanionAnchor />`.
  if (ambientOnly) return null;

  return <div className="echo-voice" data-phase={effectivePhase}>
    <span id="echo-live-mic-info" className="echo-sr">{info}</span>
    {!on && !exhausted && <div className="echo-voice-dock" ref={dockRef}>
      <button type="button" className="echo-voice-toggle" aria-pressed={false} aria-describedby="echo-live-mic-info"
        aria-label={vi ? 'Trò chuyện trực tiếp với Echo' : 'Start live conversation with Echo'}
        aria-haspopup="dialog" aria-expanded={settingsOpen}
        title={vi ? 'Nhấn để nói · giữ để chọn giọng' : 'Tap to talk · hold for voice settings'}
        disabled={busy}
        onPointerDown={e => { if (e.button !== 0) return; held.current = false; endHold(); hold.current = setTimeout(() => { held.current = true; stopPreview(); setSettingsOpen(true); }, 480); }}
        onPointerUp={endHold} onPointerLeave={endHold} onPointerCancel={endHold}
        onContextMenu={e => { e.preventDefault(); endHold(); setSettingsOpen(true); }}
        onKeyDown={e => {
          if (e.key === 'Escape' && settingsOpen) { e.preventDefault(); e.stopPropagation(); setSettingsOpen(false); return; }
          if (e.key === 'ArrowUp' || e.key === 'ContextMenu' || (e.key === 'Enter' && e.altKey)) { e.preventDefault(); setSettingsOpen(true); }
        }}
        onClick={() => { if (held.current) { held.current = false; return; } if (settingsOpen) { setSettingsOpen(false); return; } void startUnifiedRuntimeVoice(); }}>
        <span className="echo-voice-orb" aria-hidden="true"><Mic size={20} /></span>
      </button>
      {settingsOpen && <div className="echo-voice-settings" role="dialog" aria-label={vi ? 'Cài đặt giọng nói' : 'Voice settings'}
        onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setSettingsOpen(false); dockRef.current?.querySelector<HTMLButtonElement>('.echo-voice-toggle')?.focus(); } }}>
        <p className="echo-voice-settings-title">{vi ? 'Giọng Echo' : 'Echo voice'}</p>
        <div className="echo-voice-chips" role="radiogroup" aria-label={vi ? 'Giọng Echo' : 'Echo voice'}>
          {[...OMNI_VOICES, 'device' as const].map(id => <button type="button" role="radio" key={id} aria-checked={speaker === id} onClick={() => {
            stopPreview(); setSpeaker(id as EchoSpeaker);
            try { localStorage.setItem('echo_voice_speaker', id); } catch { /* optional preference */ }
            if (id !== 'device' && userId) {
              jarvis().configure({ userId, voiceId: id as 'us_female' | 'us_male' | 'uk_female' | 'uk_male' });
            }
          }}>{voiceNames[id]}</button>)}
        </div>
        {speaker !== 'device' && <button type="button" className="echo-voice-preview" onClick={playPreview}>
          {previewing ? <Square size={12} /> : <Play size={12} />}{previewing ? (vi ? 'Dừng nghe thử' : 'Stop preview') : (vi ? 'Nghe thử' : 'Preview voice')}</button>}
        <p className="echo-voice-settings-title">{vi ? 'Chờ trước khi gửi (chế độ dự phòng)' : 'Fallback pause before sending'}</p>
        <div className="echo-voice-chips" role="radiogroup" aria-label={vi ? 'Chờ trước khi gửi' : 'Wait before sending'}>
          {[4000, 7000].map(ms => <button type="button" role="radio" key={ms} aria-checked={pauseMs === ms} onClick={() => {
            setPauseMs(ms); try { localStorage.setItem('echo_voice_wait', String(ms)); } catch { /* optional preference */ }
          }}>{vi ? `${ms / 1000} giây` : `${ms / 1000} seconds`}</button>)}
        </div>
        <div className="echo-voice-modes">
          <button type="button" aria-pressed={handsFreeWakeOn} onClick={toggleHandsFreeWake}>
            {vi
              ? `Gọi rảnh tay "Hi, Echo": ${handsFreeWakeOn ? 'Đang bật' : 'Tắt'}`
              : `Hands-free "Hi, Echo": ${handsFreeWakeOn ? 'On' : 'Off'}`}
          </button>
          <button type="button" disabled={busy} onClick={() => { setSettingsOpen(false); void startUnifiedRuntimeVoice(); }}>
            {vi ? 'Hội thoại thời gian thực JARVIS' : 'JARVIS real-time full-duplex'}
          </button>
          <button type="button" disabled={busy} onClick={() => { setSettingsOpen(false); turnOn(true); }}>{vi ? 'Ghi âm và xem lại' : 'Record and review'}</button>
          {supported && <button type="button" disabled={busy} onClick={() => { setSettingsOpen(false); turnOn(); }}>{vi ? 'Dùng nhận dạng của trình duyệt' : 'Use browser recognition'}</button>}
        </div>
        <p className="echo-voice-settings-note">{info}</p>
      </div>}
    </div>}
    {on && <div ref={stageRef} className="echo-voice-stage" role="region" aria-label={vi ? 'Trò chuyện bằng giọng nói' : 'Voice conversation'}>
      {phase !== 'off' && effectivePhase !== 'review' && <button type="button" className="echo-voice-lang" onClick={switchLang}
        aria-label={vi ? 'Đổi ngôn ngữ nhận giọng nói' : 'Switch recognition language'}>{lang === 'vi-VN' ? 'VI' : 'EN'}</button>}
      <p className="echo-voice-state" role="status">{label}</p>
      <EchoOrb slot="voice" size="lg" state={orbState} />
      {effectivePhase === 'review' ? <div className="echo-voice-review">
        <input className="echo-voice-transcript" aria-label={vi ? 'Bản ghi giọng nói' : 'Voice transcript'} value={interim}
          maxLength={4000} onChange={e => setInterim(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); sendReview(); } }} />
        <div className="echo-voice-review-actions">
          <button type="button" className="echo-voice-chip-main" disabled={busy || !interim.trim()} onClick={sendReview}>{vi ? 'Gửi bản ghi' : 'Send transcript'}</button>
          <button type="button" onClick={() => listen()}>{vi ? 'Thu lại' : 'Record again'}</button>
        </div>
      </div> : <p className="echo-voice-caption" aria-live="polite">{caption || stageHint}</p>}
      {voiceError && <div className="echo-voice-error" role="alert">
        <span>{voiceError.title}</span>
        {voiceError.retryable && snap.lastError?.canRetry !== false && <button type="button" disabled={busy || exhausted || snap.moduleMicActive || effectivePhase === 'thinking' || effectivePhase === 'speaking'} onClick={retryVoiceTurn}><RotateCcw size={13} aria-hidden="true" />{vi ? 'Thử lại' : 'Retry'}</button>}
        <button type="button" aria-label={vi ? 'Đóng thông báo' : 'Dismiss'} onClick={() => {
          setExhaustedBannerDismissed(true);
          jarvis().dismissError?.();
          (echoVoiceSessionStore as typeof echoVoiceSessionStore & { clearVoiceError?: () => void }).clearVoiceError?.();
        }}><X size={13} /></button>
      </div>}
      {offerFallback && <button type="button" className="echo-voice-fallback" disabled={busy || exhausted || snap.moduleMicActive} onClick={() => turnOn(true, true)}>
        {vi ? 'Dùng micro English Coach (gửi âm thanh để chuyển thành chữ)' : 'Use English Coach microphone (send audio for transcription)'}</button>}
      <div className="echo-voice-controls">
        <button type="button" className="echo-voice-side" onClick={stopVoiceSession} aria-label={vi ? 'Quay lại nhắn tin' : 'Back to typing'} title={vi ? 'Quay lại nhắn tin' : 'Back to typing'}><MessageCircle size={20} /></button>
        {effectivePhase === 'speaking' || effectivePhase === 'thinking'
          ? <button type="button" className="echo-voice-main echo-voice-stop" onClick={interruptVoiceSession} aria-label={vi ? 'Ngắt lời Echo' : 'Interrupt Echo'} title={vi ? 'Ngắt lời Echo' : 'Interrupt Echo'}>
            <span className="echo-voice-orb" aria-hidden="true"><Square size={22} /></span></button>
          : resting
          ? <button type="button" className="echo-voice-main" aria-pressed={false} disabled={busy || exhausted || snap.moduleMicActive} onClick={() => { void startUnifiedRuntimeVoice(); }} aria-label={vi ? 'Nói với Echo' : 'Talk to Echo'} title={vi ? 'Nói với Echo' : 'Talk to Echo'}>
            <span className="echo-voice-orb" aria-hidden="true"><Mic size={26} /></span></button>
          : <button type="button" className="echo-voice-main" aria-pressed={true} onClick={() => { if (runtimeActive) jarvis().enterSleep?.(); else turnOff(); }} aria-label={vi ? 'Dừng nghe' : 'Stop listening'} title={vi ? 'Dừng nghe' : 'Stop listening'}>
            <span className="echo-voice-orb" aria-hidden="true"><Mic size={26} /></span></button>}
        <button type="button" className="echo-voice-side" onClick={stopVoiceSession} aria-label={vi ? 'Tắt trò chuyện bằng giọng nói' : 'Turn voice off'} title={vi ? 'Kết thúc' : 'End'}><X size={20} /></button>
      </div>
    </div>}
    {notice && <p className="echo-voice-note" role="status">{notice}<button type="button" onClick={() => { setNotice(''); setOfferFallback(false); }} aria-label={vi ? 'Đóng' : 'Close'}>×</button></p>}
    {!on && offerFallback && <button type="button" className="echo-voice-fallback" disabled={busy} onClick={() => turnOn(true, true)}>
      {vi ? 'Dùng micro English Coach (gửi âm thanh để chuyển thành chữ)' : 'Use English Coach microphone (send audio for transcription)'}</button>}
  </div>;
}
