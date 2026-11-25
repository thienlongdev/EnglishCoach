// Same-origin AudioWorkletProcessor ('self' CSP compliant; zero external imports, zero dynamic eval).
// Supports two processorOptions.mode contracts:
//   1. 'legacy-int16' (default): emits 1600-sample (100 ms @ 16 kHz) Int16Array frames (100% backwards-compatible
//      with echo-microphone.ts and EchoVoice.tsx, now upgraded with arbitrary sampleRate -> 16 kHz anti-aliased resampling).
//   2. 'jarvis-f32': emits 512-sample (32 ms @ 16 kHz) Float32Array mic frames + optional input[1] 16 kHz TTS reference
//      frames with zero per-quantum heap allocations inside process().

const TARGET_SAMPLE_RATE = 16000;
const LEGACY_FRAME_SAMPLES = 1600;
const JARVIS_FRAME_SAMPLES = 512;

class EchoMicrophoneProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.mode = opts.mode === 'jarvis-f32' ? 'jarvis-f32' : 'legacy-int16';
    const scopeRate = typeof sampleRate === 'number' && sampleRate > 0 ? sampleRate : TARGET_SAMPLE_RATE;
    this.inRate = typeof opts.inputSampleRate === 'number' && opts.inputSampleRate > 0 ? opts.inputSampleRate : scopeRate;
    this.ratio = this.inRate / TARGET_SAMPLE_RATE;

    // Continuous anti-aliased boxcar / linear resampler state for input[0] (microphone)
    this.micPhase = 0;
    this.micAcc = 0;
    this.micPrev = 0;
    this.micPrev2 = 0;

    // Lockstep resampler state for optional input[1] (TTS playback reference tap)
    this.refPhase = 0;
    this.refAcc = 0;
    this.refPrev = 0;
    this.refPrev2 = 0;
    this.refEnergySq = 0;

    // Legacy 100 ms Int16 buffer (transferred to preserve exact zero-copy ArrayBuffer contract for echo-microphone.ts)
    this.samples = new Int16Array(LEGACY_FRAME_SAMPLES);
    this.offset = 0;

    // Pre-allocated zero-GC buffers for 'jarvis-f32' (structured-cloned by C++ port serializer with zero JS allocations)
    this.micF32 = new Float32Array(JARVIS_FRAME_SAMPLES);
    this.refF32 = new Float32Array(JARVIS_FRAME_SAMPLES);
    this.jarvisOffset = 0;
    this.seq = 0;

    this.msgMicOnly = {
      type: 'jarvis-frame',
      seq: 0,
      sampleRate: TARGET_SAMPLE_RATE,
      mic: this.micF32,
      ref: null,
      hasRef: false,
    };
    this.msgWithRef = {
      type: 'jarvis-frame',
      seq: 0,
      sampleRate: TARGET_SAMPLE_RATE,
      mic: this.micF32,
      ref: this.refF32,
      hasRef: true,
    };

    // Optional direct MessagePort to Dedicated DSP Worker (`echo-voice-dsp.worker.js`) so 16 kHz frames
    // bypass the React/WebGL2 main thread completely when running in browser!
    this.workerPort = null;

    this.port.onmessage = (event) => {
      const data = event && event.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'reset') {
        this.resetState();
      } else if (data.type === 'set-mode' && (data.mode === 'jarvis-f32' || data.mode === 'legacy-int16')) {
        this.mode = data.mode;
        this.resetState();
      } else if (data.type === 'attach-worker-port') {
        this.workerPort = data.port || (event.ports && event.ports[0]) || null;
      } else if (data.type === 'detach-worker-port') {
        this.workerPort = null;
      }
    };
  }

  resetState() {
    this.micPhase = 0;
    this.micAcc = 0;
    this.micPrev = 0;
    this.micPrev2 = 0;
    this.refPhase = 0;
    this.refAcc = 0;
    this.refPrev = 0;
    this.refPrev2 = 0;
    this.refEnergySq = 0;
    this.offset = 0;
    this.jarvisOffset = 0;
  }

  emitSamplePair(micSample, refSample, refConnected) {
    const clampedMic = micSample > 1 ? 1 : micSample < -1 ? -1 : micSample;
    if (this.mode === 'legacy-int16') {
      this.samples[this.offset++] = Math.round(clampedMic * 32767);
      if (this.offset === LEGACY_FRAME_SAMPLES) {
        this.port.postMessage(this.samples, [this.samples.buffer]);
        this.samples = new Int16Array(LEGACY_FRAME_SAMPLES);
        this.offset = 0;
      }
      return;
    }

    const idx = this.jarvisOffset++;
    this.micF32[idx] = clampedMic;
    const clampedRef = refConnected ? (refSample > 1 ? 1 : refSample < -1 ? -1 : refSample) : 0;
    this.refF32[idx] = clampedRef;
    this.refEnergySq += clampedRef * clampedRef;

    if (this.jarvisOffset === JARVIS_FRAME_SAMPLES) {
      const nextSeq = ++this.seq;
      const activeRef = refConnected && this.refEnergySq > 1e-11;
      const targetPort = this.workerPort || this.port;
      if (activeRef) {
        this.msgWithRef.seq = nextSeq;
        targetPort.postMessage(this.msgWithRef);
      } else {
        this.msgMicOnly.seq = nextSeq;
        targetPort.postMessage(this.msgMicOnly);
      }
      this.jarvisOffset = 0;
      this.refEnergySq = 0;
    }
  }

  process(inputs) {
    const micInput = inputs[0];
    if (!micInput || !micInput[0] || micInput[0].length === 0) {
      return true;
    }
    const micCh0 = micInput[0];
    const micCh1 = micInput.length > 1 ? micInput[1] : null;
    const len = micCh0.length;

    const refInput = inputs.length > 1 ? inputs[1] : null;
    const refCh0 = refInput && refInput.length > 0 ? refInput[0] : null;
    const refCh1 = refInput && refInput.length > 1 ? refInput[1] : null;
    const refConnected = Boolean(refCh0 && refCh0.length === len);

    const ratio = this.ratio;

    // Fast path 1: exact 16 kHz native AudioContext
    if (ratio === 1) {
      for (let i = 0; i < len; i++) {
        const m = micCh1 ? (micCh0[i] + micCh1[i]) * 0.5 : micCh0[i];
        const r = refConnected ? (refCh1 ? (refCh0[i] + refCh1[i]) * 0.5 : refCh0[i]) : 0;
        this.emitSamplePair(m, r, refConnected);
      }
      return true;
    }

    // Fast path 2: exact 48 kHz -> 16 kHz (3:1 decimation with 4-tap anti-aliased triangular/boxcar low-pass FIR
    // [1, 2, 2, 1] / 6, placing a deep stopband null above 8 kHz Nyquist while keeping < 7 kHz consonants crisp)
    if (ratio === 3) {
      let phase = this.micPhase;
      let mPrev = this.micPrev;
      let mPrev2 = this.micPrev2;
      let rPrev = this.refPrev;
      let rPrev2 = this.refPrev2;
      let mMid = this.micAcc;
      let rMid = this.refAcc;

      for (let i = 0; i < len; i++) {
        const m = micCh1 ? (micCh0[i] + micCh1[i]) * 0.5 : micCh0[i];
        const r = refConnected ? (refCh1 ? (refCh0[i] + refCh1[i]) * 0.5 : refCh0[i]) : 0;
        if (phase === 0) {
          mPrev2 = mPrev;
          mPrev = m;
          rPrev2 = rPrev;
          rPrev = r;
          phase = 1;
        } else if (phase === 1) {
          mMid = m;
          rMid = r;
          phase = 2;
        } else {
          // 4-sample span [mPrev2, mPrev, mMid, m] weighted [1, 2, 2, 1] / 6
          const outM = (mPrev2 + (mPrev + mMid) * 2 + m) * 0.16666666666666666;
          const outR = refConnected ? (rPrev2 + (rPrev + rMid) * 2 + r) * 0.16666666666666666 : 0;
          mPrev = m;
          rPrev = r;
          phase = 0;
          this.emitSamplePair(outM, outR, refConnected);
        }
      }

      this.micPhase = phase;
      this.micPrev = mPrev;
      this.micPrev2 = mPrev2;
      this.refPrev = rPrev;
      this.refPrev2 = rPrev2;
      this.micAcc = mMid;
      this.refAcc = rMid;
      return true;
    }

    // General path A: Downsampling (inRate > 16000, e.g. 44100 Hz, 24000 Hz, 32000 Hz, 96000 Hz)
    // Continuous-time boxcar area integration over each exact 1/16000s output interval + 2-tap pre-smoothing.
    if (ratio > 1) {
      const invRatio = 1 / ratio;
      let phase = this.micPhase;
      let mAcc = this.micAcc;
      let rAcc = this.refAcc;
      let mPrev = this.micPrev;
      let rPrev = this.refPrev;

      for (let i = 0; i < len; i++) {
        const rawM = micCh1 ? (micCh0[i] + micCh1[i]) * 0.5 : micCh0[i];
        const rawR = refConnected ? (refCh1 ? (refCh0[i] + refCh1[i]) * 0.5 : refCh0[i]) : 0;
        // Light 2-tap anti-alias pre-filter [0.5, 0.5] before continuous boxcar integration
        const m = (mPrev + rawM) * 0.5;
        const r = refConnected ? (rPrev + rawR) * 0.5 : 0;
        mPrev = rawM;
        rPrev = rawR;

        let rem = 1.0;
        while (phase + rem >= ratio) {
          const take = ratio - phase;
          const outM = (mAcc + take * m) * invRatio;
          const outR = refConnected ? (rAcc + take * r) * invRatio : 0;
          rem -= take;
          phase = 0;
          mAcc = 0;
          rAcc = 0;
          this.emitSamplePair(outM, outR, refConnected);
        }
        mAcc += rem * m;
        rAcc += rem * r;
        phase += rem;
      }

      this.micPhase = phase;
      this.micAcc = mAcc;
      this.refAcc = rAcc;
      this.micPrev = mPrev;
      this.refPrev = rPrev;
      return true;
    }

    // General path B: Upsampling (inRate < 16000, e.g. 8000 Hz Bluetooth HFP) via linear interpolation
    let pos = this.micPhase;
    let mPrev = this.micPrev;
    let rPrev = this.refPrev;
    for (let i = 0; i < len; i++) {
      const m = micCh1 ? (micCh0[i] + micCh1[i]) * 0.5 : micCh0[i];
      const r = refConnected ? (refCh1 ? (refCh0[i] + refCh1[i]) * 0.5 : refCh0[i]) : 0;
      while (pos <= 1.0) {
        const outM = mPrev + (m - mPrev) * pos;
        const outR = refConnected ? rPrev + (r - rPrev) * pos : 0;
        this.emitSamplePair(outM, outR, refConnected);
        pos += ratio;
      }
      pos -= 1.0;
      mPrev = m;
      rPrev = r;
    }
    this.micPhase = pos;
    this.micPrev = mPrev;
    this.refPrev = rPrev;
    return true;
  }
}

registerProcessor('echo-microphone', EchoMicrophoneProcessor);
