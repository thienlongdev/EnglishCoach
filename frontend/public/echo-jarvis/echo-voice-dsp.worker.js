// Dedicated Zero-WASM Pure-JS DSP Web Worker for Echo JARVIS (`'self'` CSP compliant).
// Zero binary runtime modules, zero dynamic code generation, zero per-frame heap allocations.
// Runs off the main UI/WebGL2 thread and receives 16 kHz Float32Array(512) mic + ref frames
// directly from `/echo-mic-worklet.js` over a dedicated MessageChannel port.
//
// Pipeline per 32 ms (512-sample) frame:
//   1. 8-Partition 128 ms PBFDAF AEC + GCC-PHAT Delay Estimator + Main/Shadow Benesty NCC DTD
//   2. 1.5 s (24,000-sample) Local Circular Pre-Roll Ring Buffer (0 network bytes in Dormant)
//   3. Exact INT8-Dequantized Silero VAD v5
//   4. Exact 512-pt Log-Mel32 + Hardened Causal openWakeWord (-10.0 silence floor reset,
//      6-step 480 ms post-reset lockout, >= 2 consecutive neural hits, zero acoustic fallback)
//   5. Silent 280 ms Single-Breath Handoff (300 ms / 4,800-sample pre-lead)
//   6. EOU-Fusion v2 + >= 220 ms / +5 dB SNR Pre-Commit Noise Gate + Bounded 10 s / 14 s Follow-Up
//   7. >= 96 ms Post-PBFDAF Benesty NCC Double-Talk Barge-In Probe Slicer

'use strict';

const WAKE_WORD_CLASSES = [
  'negative',
  'hi_echo',
  'hey_echo',
  'hi_echo_jarvis',
  'hey_echo_jarvis',
];

const CLASS_TO_PHRASE = {
  hi_echo: 'Hi Echo',
  hey_echo: 'Hey Echo',
  hi_echo_jarvis: 'Hi Echo Jarvis',
  hey_echo_jarvis: 'Hey Echo Jarvis',
};

const OWW_SILENCE_MEL_FLOOR = -10.0;
const OWW_POST_RESET_WARMUP_STEPS = 6;

const OWW_BACKBONE_SPECS = [
  { inC: 1, outC: 24, kH: 3, kW: 3, padF: 1, hasBias: true, activation: 'clamped_leaky_relu' },
  { inC: 24, outC: 24, kH: 1, kW: 3, padF: 1, hasBias: true, activation: 'clamped_leaky_relu' },
  { inC: 24, outC: 24, kH: 3, kW: 1, padF: 0, hasBias: true, activation: 'clamped_leaky_relu' },
  { inC: 24, outC: 48, kH: 1, kW: 3, padF: 1, hasBias: true, activation: 'clamped_leaky_relu' },
  { inC: 48, outC: 48, kH: 3, kW: 1, padF: 0, hasBias: true, activation: 'clamped_leaky_relu' },
  { inC: 48, outC: 48, kH: 1, kW: 3, padF: 1, hasBias: true, activation: 'clamped_leaky_relu' },
  { inC: 48, outC: 48, kH: 3, kW: 1, padF: 0, hasBias: true, activation: 'clamped_leaky_relu' },
  { inC: 48, outC: 72, kH: 1, kW: 3, padF: 1, hasBias: true, activation: 'clamped_leaky_relu' },
  { inC: 72, outC: 72, kH: 3, kW: 1, padF: 0, hasBias: true, activation: 'clamped_leaky_relu' },
  { inC: 72, outC: 72, kH: 1, kW: 3, padF: 1, hasBias: true, activation: 'clamped_leaky_relu' },
  { inC: 72, outC: 72, kH: 3, kW: 1, padF: 0, hasBias: true, activation: 'clamped_leaky_relu' },
  { inC: 72, outC: 96, kH: 1, kW: 3, padF: 1, hasBias: true, activation: 'clamped_leaky_relu' },
  { inC: 96, outC: 96, kH: 3, kW: 1, padF: 0, hasBias: true, activation: 'clamped_leaky_relu' },
  { inC: 96, outC: 96, kH: 1, kW: 3, padF: 1, hasBias: true, activation: 'clamped_leaky_relu' },
  { inC: 96, outC: 96, kH: 3, kW: 1, padF: 0, hasBias: true, activation: 'clamped_leaky_relu' },
  { inC: 96, outC: 96, kH: 1, kW: 3, padF: 1, hasBias: true, activation: 'clamped_leaky_relu' },
  { inC: 96, outC: 96, kH: 3, kW: 1, padF: 0, hasBias: true, activation: 'clamped_leaky_relu' },
  { inC: 96, outC: 96, kH: 1, kW: 3, padF: 1, hasBias: true, activation: 'clamped_leaky_relu' },
  { inC: 96, outC: 96, kH: 3, kW: 1, padF: 0, hasBias: true, activation: 'clamped_leaky_relu' },
  { inC: 96, outC: 96, kH: 3, kW: 1, padF: 0, hasBias: false, activation: 'linear' },
];

const TEMPORAL_CONV_FREQS = [
  { convIdx: 0, F: 32, inC: 1, stepRows: 8 },
  { convIdx: 2, F: 32, inC: 24, stepRows: 8 },
  { convIdx: 4, F: 16, inC: 48, stepRows: 4 },
  { convIdx: 6, F: 16, inC: 48, stepRows: 4 },
  { convIdx: 8, F: 8, inC: 72, stepRows: 4 },
  { convIdx: 10, F: 8, inC: 72, stepRows: 4 },
  { convIdx: 12, F: 4, inC: 96, stepRows: 2 },
  { convIdx: 14, F: 4, inC: 96, stepRows: 2 },
  { convIdx: 16, F: 2, inC: 96, stepRows: 2 },
  { convIdx: 18, F: 2, inC: 96, stepRows: 2 },
  { convIdx: 19, F: 1, inC: 96, stepRows: 1 },
];

function nowMs() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function fastSigmoid(x) {
  if (x >= 15) return 1;
  if (x <= -15) return 0;
  return 1 / (1 + Math.exp(-x));
}

function float32ToPcm16(src) {
  const out = new Int16Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const v = src[i] > 1 ? 1 : src[i] < -1 ? -1 : src[i];
    out[i] = Math.round(v * 32767);
  }
  return out;
}

function shapeCount(shape) {
  let prod = 1;
  for (let i = 0; i < shape.length; i++) prod *= shape[i];
  return prod;
}

function dequantizeTensorSlice(buffer, desc) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const offset = desc.byteOffset != null ? desc.byteOffset : (desc.offset || 0);
  const count = shapeCount(desc.shape);
  const dtype = desc.dtype || 'int8';
  const out = new Float32Array(count);
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset);

  if (dtype === 'float32') {
    for (let i = 0; i < count; i++) out[i] = view.getFloat32(i * 4, true);
    return out;
  }

  const scales = Array.isArray(desc.scale) ? desc.scale : desc.scales;
  const scalarScale = typeof desc.scale === 'number' ? desc.scale : 1.0;
  const zp = desc.zeroPoint || 0;

  if (scales && scales.length > 1 && desc.shape.length >= 1 && scales.length === desc.shape[0]) {
    const outChannels = desc.shape[0];
    const stride = count / outChannels;
    const int8View = new Int8Array(bytes.buffer, bytes.byteOffset + offset, count);
    for (let c = 0; c < outChannels; c++) {
      const s = scales[c];
      const base = c * stride;
      for (let i = 0; i < stride; i++) {
        out[base + i] = (int8View[base + i] - zp) * s;
      }
    }
    return out;
  }

  const int8View = new Int8Array(bytes.buffer, bytes.byteOffset + offset, count);
  for (let i = 0; i < count; i++) {
    out[i] = (int8View[i] - zp) * scalarScale;
  }
  return out;
}

function normalizeTensorMap(tensors) {
  const map = new Map();
  if (Array.isArray(tensors)) {
    for (let i = 0; i < tensors.length; i++) {
      if (tensors[i] && tensors[i].name) map.set(tensors[i].name, tensors[i]);
    }
  } else if (tensors && typeof tensors === 'object') {
    const entries = Object.entries(tensors);
    for (let i = 0; i < entries.length; i++) {
      const k = entries[i][0];
      const item = entries[i][1];
      if (item) {
        map.set(item.name || k, item);
        map.set(k, item);
      }
    }
  }
  return map;
}

function getRequiredTensor(map, buf, aliases) {
  for (let i = 0; i < aliases.length; i++) {
    const desc = map.get(aliases[i]);
    if (desc) return dequantizeTensorSlice(buf, desc);
  }
  throw new Error('Missing required neural tensor: ' + aliases[0]);
}

function getOptionalTensor(map, buf, aliases) {
  for (let i = 0; i < aliases.length; i++) {
    const desc = map.get(aliases[i]);
    if (desc) return dequantizeTensorSlice(buf, desc);
  }
  return null;
}

function buildAnalyticalMelFilterbank257x32() {
  const sr = 16000;
  const nFft = 512;
  const nMels = 32;
  const fMin = 60;
  const fMax = 7600;
  const hzToMel = (hz) => 2595 * Math.log10(1 + hz / 700);
  const melToHz = (m) => 700 * (Math.pow(10, m / 2595) - 1);
  const melMin = hzToMel(fMin);
  const melMax = hzToMel(fMax);
  const melPts = new Float32Array(nMels + 2);
  for (let i = 0; i < nMels + 2; i++) {
    melPts[i] = melToHz(melMin + ((melMax - melMin) * i) / (nMels + 1));
  }
  const melW = new Float32Array(257 * nMels);
  for (let b = 0; b < 257; b++) {
    const freq = (b * sr) / nFft;
    for (let m = 0; m < nMels; m++) {
      const fL = melPts[m];
      const fC = melPts[m + 1];
      const fR = melPts[m + 2];
      let w = 0;
      if (freq >= fL && freq <= fC && fC > fL) w = (freq - fL) / (fC - fL);
      else if (freq > fC && freq <= fR && fR > fC) w = (fR - freq) / (fR - fC);
      const enorm = 2.0 / Math.max(1, fR - fL);
      melW[b * nMels + m] = w * enorm;
    }
  }
  return melW;
}

function parseSileroVadBinary(buf, section) {
  const map = normalizeTensorMap(section.tensors);
  return {
    stftWeight: getRequiredTensor(map, buf, ['stft_conv.weight', 'stft.weight']),
    conv1Weight: getRequiredTensor(map, buf, ['conv1.weight', 'encoder.0.reparam_conv.weight']),
    conv1Bias: getRequiredTensor(map, buf, ['conv1.bias', 'encoder.0.reparam_conv.bias']),
    conv2Weight: getRequiredTensor(map, buf, ['conv2.weight', 'encoder.1.reparam_conv.weight']),
    conv2Bias: getRequiredTensor(map, buf, ['conv2.bias', 'encoder.1.reparam_conv.bias']),
    conv3Weight: getRequiredTensor(map, buf, ['conv3.weight', 'encoder.2.reparam_conv.weight']),
    conv3Bias: getRequiredTensor(map, buf, ['conv3.bias', 'encoder.2.reparam_conv.bias']),
    conv4Weight: getRequiredTensor(map, buf, ['conv4.weight', 'encoder.3.reparam_conv.weight']),
    conv4Bias: getRequiredTensor(map, buf, ['conv4.bias', 'encoder.3.reparam_conv.bias']),
    lstmWeightIh: getRequiredTensor(map, buf, ['lstm_cell.weight_ih', 'decoder.rnn.weight_ih']),
    lstmWeightHh: getRequiredTensor(map, buf, ['lstm_cell.weight_hh', 'decoder.rnn.weight_hh']),
    lstmBiasIh: getRequiredTensor(map, buf, ['lstm_cell.bias_ih', 'decoder.rnn.bias_ih']),
    lstmBiasHh: getRequiredTensor(map, buf, ['lstm_cell.bias_hh', 'decoder.rnn.bias_hh']),
    finalWeight: getRequiredTensor(map, buf, ['final_conv.weight', 'decoder.decoder.2.weight']),
    finalBias: getRequiredTensor(map, buf, ['final_conv.bias', 'decoder.decoder.2.bias']),
  };
}

function parseOpenWakeWordBinary(buf, section) {
  const map = normalizeTensorMap(section.tensors);
  const melW = getOptionalTensor(map, buf, ['melW', '1.melW', 'mel.melW']) || buildAnalyticalMelFilterbank257x32();
  const stftWindow = getOptionalTensor(map, buf, ['stftWindow', 'stft_window', 'window']);
  const convWeights = [];
  const convBiases = [];
  for (let k = 0; k < 20; k++) {
    const onnxPrefix = k === 0 ? 'model/conv2d' : 'model/conv2d_' + k;
    convWeights.push(
      getRequiredTensor(map, buf, [
        'conv' + k + '.weight',
        'backbone.conv' + k + '.weight',
        'embedding.conv' + k + '.weight',
        onnxPrefix + '/Conv2D_weights_fused_bn',
        onnxPrefix + '/Conv2D/ReadVariableOp:0',
      ]),
    );
    if (k === 19) {
      convBiases.push(
        getOptionalTensor(map, buf, ['conv19.bias', 'backbone.conv19.bias', 'embedding.conv19.bias']),
      );
    } else {
      convBiases.push(
        getRequiredTensor(map, buf, [
          'conv' + k + '.bias',
          'backbone.conv' + k + '.bias',
          'embedding.conv' + k + '.bias',
          onnxPrefix + '/Conv2D_bias_fused_bn',
        ]),
      );
    }
  }
  const fc1Desc =
    map.get('head.fc1.weight') ||
    map.get('classifier.fc1.weight') ||
    map.get('head.layer1.weight') ||
    map.get('model.1.weight');
  const fc1Weight = getRequiredTensor(map, buf, [
    'head.fc1.weight',
    'classifier.fc1.weight',
    'head.layer1.weight',
    'model.1.weight',
  ]);
  const fc1Bias = getRequiredTensor(map, buf, [
    'head.fc1.bias',
    'classifier.fc1.bias',
    'head.layer1.bias',
    'model.1.bias',
  ]);
  const hiddenDim = fc1Bias.length;
  const inFeatures = fc1Desc ? fc1Desc.shape[1] : fc1Weight.length / hiddenDim;
  const embeddingFrames = section.embeddingFrames || Math.max(1, Math.round(inFeatures / 96));
  const ln1Weight =
    getOptionalTensor(map, buf, ['head.ln1.weight', 'classifier.ln1.weight', 'head.layernorm1.weight', 'model.2.weight']) ||
    new Float32Array(hiddenDim).fill(1);
  const ln1Bias =
    getOptionalTensor(map, buf, ['head.ln1.bias', 'classifier.ln1.bias', 'head.layernorm1.bias', 'model.2.bias']) ||
    new Float32Array(hiddenDim);
  const fc2Weight = getOptionalTensor(map, buf, ['head.fc2.weight', 'classifier.fc2.weight', 'head.blocks.0.fcn_layer.weight', 'model.4.weight']);
  const fc2Bias = getOptionalTensor(map, buf, ['head.fc2.bias', 'classifier.fc2.bias', 'head.blocks.0.fcn_layer.bias', 'model.4.bias']);
  const ln2Weight = getOptionalTensor(map, buf, ['head.ln2.weight', 'classifier.ln2.weight', 'head.blocks.0.layer_norm.weight', 'model.5.weight']);
  const ln2Bias = getOptionalTensor(map, buf, ['head.ln2.bias', 'classifier.ln2.bias', 'head.blocks.0.layer_norm.bias', 'model.5.bias']);
  const fcOutWeight = getRequiredTensor(map, buf, ['head.fc3.weight', 'head.out.weight', 'head.last_layer.weight', 'classifier.fc3.weight', 'classifier.out.weight', 'model.7.weight']);
  const fcOutBias = getRequiredTensor(map, buf, ['head.fc3.bias', 'head.out.bias', 'head.last_layer.bias', 'classifier.fc3.bias', 'classifier.out.bias', 'model.7.bias']);
  return {
    melW,
    stftWindow,
    convWeights,
    convBiases,
    embeddingFrames,
    numClasses: fcOutBias.length,
    hiddenDim,
    fc1Weight,
    fc1Bias,
    ln1Weight,
    ln1Bias,
    fc2Weight,
    fc2Bias,
    ln2Weight,
    ln2Bias,
    fcOutWeight,
    fcOutBias,
  };
}

class WorkerCircularPcmRingBuffer {
  constructor(capacitySamples) {
    this.buf = new Float32Array(capacitySamples || 24000);
    this.writePos = 0;
    this.filled = 0;
    this.totalWritten = 0;
  }
  clear() {
    this.writePos = 0;
    this.filled = 0;
    this.totalWritten = 0;
    this.buf.fill(0);
  }
  write(samples) {
    const cap = this.buf.length;
    const n = samples.length;
    if (n >= cap) {
      this.buf.set(samples.subarray(n - cap, n), 0);
      this.writePos = 0;
      this.filled = cap;
      this.totalWritten += n;
      return;
    }
    const first = Math.min(n, cap - this.writePos);
    this.buf.set(samples.subarray(0, first), this.writePos);
    const rem = n - first;
    if (rem > 0) this.buf.set(samples.subarray(first, n), 0);
    this.writePos = (this.writePos + n) % cap;
    this.filled = Math.min(cap, this.filled + n);
    this.totalWritten += n;
  }
  readLatest(requested) {
    const count = Math.max(0, Math.min(requested, this.filled));
    const dst = new Float32Array(count);
    if (count === 0) return dst;
    const cap = this.buf.length;
    const start = (this.writePos - count + cap) % cap;
    if (start + count <= cap) {
      dst.set(this.buf.subarray(start, start + count), 0);
    } else {
      const tail = cap - start;
      dst.set(this.buf.subarray(start, cap), 0);
      dst.set(this.buf.subarray(0, count - tail), tail);
    }
    return dst;
  }
  readSinceSample(sinceTotal) {
    const avail = Math.max(0, this.totalWritten - sinceTotal);
    return this.readLatest(Math.min(avail, this.filled));
  }
}

class WorkerSileroVadV5 {
  constructor(weights) {
    this.weights = weights;
    this.context = new Float32Array(64);
    this.h = new Float32Array(128);
    this.c = new Float32Array(128);
    this.xPad = new Float32Array(640);
    this.mag = new Float32Array(129 * 4);
    this.c1 = new Float32Array(128 * 4);
    this.c2 = new Float32Array(64 * 2);
    this.c3 = new Float32Array(64);
    this.c4 = new Float32Array(128);
    this.gates = new Float32Array(512);
    this.conv4CenterWeight = new Float32Array(128 * 64);
    this.packConv4Center();
  }
  packConv4Center() {
    const src = this.weights.conv4Weight;
    const dst = this.conv4CenterWeight;
    for (let oc = 0; oc < 128; oc++) {
      const ocSrc = oc * 192;
      const ocDst = oc * 64;
      for (let ic = 0; ic < 64; ic++) dst[ocDst + ic] = src[ocSrc + ic * 3 + 1];
    }
  }
  resetState() {
    this.context.fill(0);
    this.h.fill(0);
    this.c.fill(0);
  }
  processFrame512(samples512) {
    const xPad = this.xPad;
    xPad.set(this.context, 0);
    xPad.set(samples512.subarray(0, 512), 64);
    for (let k = 0; k < 64; k++) xPad[576 + k] = xPad[574 - k];
    this.context.set(samples512.subarray(448, 512), 0);

    const stftW = this.weights.stftWeight;
    const mag = this.mag;
    for (let bin = 0; bin < 129; bin++) {
      const reBase = bin * 256;
      const imBase = (129 + bin) * 256;
      const outBase = bin * 4;
      for (let t = 0; t < 4; t++) {
        const xOff = t * 128;
        let re = 0;
        let im = 0;
        for (let k = 0; k < 256; k += 4) {
          const s0 = xPad[xOff + k];
          const s1 = xPad[xOff + k + 1];
          const s2 = xPad[xOff + k + 2];
          const s3 = xPad[xOff + k + 3];
          re += s0 * stftW[reBase + k] + s1 * stftW[reBase + k + 1] + s2 * stftW[reBase + k + 2] + s3 * stftW[reBase + k + 3];
          im += s0 * stftW[imBase + k] + s1 * stftW[imBase + k + 1] + s2 * stftW[imBase + k + 2] + s3 * stftW[imBase + k + 3];
        }
        mag[outBase + t] = Math.sqrt(re * re + im * im);
      }
    }

    const w1 = this.weights.conv1Weight;
    const b1 = this.weights.conv1Bias;
    const c1 = this.c1;
    for (let oc = 0; oc < 128; oc++) {
      const bias = b1[oc];
      let y0 = bias, y1 = bias, y2 = bias, y3 = bias;
      const wOc = oc * 387;
      for (let ic = 0; ic < 129; ic++) {
        const mOff = ic * 4;
        const m0 = mag[mOff], m1 = mag[mOff + 1], m2 = mag[mOff + 2], m3 = mag[mOff + 3];
        const wOff = wOc + ic * 3;
        const wk0 = w1[wOff], wk1 = w1[wOff + 1], wk2 = w1[wOff + 2];
        y0 += m0 * wk1 + m1 * wk2;
        y1 += m0 * wk0 + m1 * wk1 + m2 * wk2;
        y2 += m1 * wk0 + m2 * wk1 + m3 * wk2;
        y3 += m2 * wk0 + m3 * wk1;
      }
      const outOff = oc * 4;
      c1[outOff] = y0 > 0 ? y0 : 0;
      c1[outOff + 1] = y1 > 0 ? y1 : 0;
      c1[outOff + 2] = y2 > 0 ? y2 : 0;
      c1[outOff + 3] = y3 > 0 ? y3 : 0;
    }

    const w2 = this.weights.conv2Weight;
    const b2 = this.weights.conv2Bias;
    const c2 = this.c2;
    for (let oc = 0; oc < 64; oc++) {
      let y0 = b2[oc], y1 = b2[oc];
      const wOc = oc * 384;
      for (let ic = 0; ic < 128; ic++) {
        const xOff = ic * 4;
        const wOff = wOc + ic * 3;
        y0 += c1[xOff] * w2[wOff + 1] + c1[xOff + 1] * w2[wOff + 2];
        y1 += c1[xOff + 1] * w2[wOff] + c1[xOff + 2] * w2[wOff + 1] + c1[xOff + 3] * w2[wOff + 2];
      }
      const outOff = oc * 2;
      c2[outOff] = y0 > 0 ? y0 : 0;
      c2[outOff + 1] = y1 > 0 ? y1 : 0;
    }

    const w3 = this.weights.conv3Weight;
    const b3 = this.weights.conv3Bias;
    const c3 = this.c3;
    for (let oc = 0; oc < 64; oc++) {
      let y0 = b3[oc];
      const wOc = oc * 192;
      for (let ic = 0; ic < 64; ic++) {
        const xOff = ic * 2;
        const wOff = wOc + ic * 3;
        y0 += c2[xOff] * w3[wOff + 1] + c2[xOff + 1] * w3[wOff + 2];
      }
      c3[oc] = y0 > 0 ? y0 : 0;
    }

    const w4c = this.conv4CenterWeight;
    const b4 = this.weights.conv4Bias;
    const c4 = this.c4;
    for (let oc = 0; oc < 128; oc++) {
      let sum = b4[oc];
      const wOff = oc * 64;
      for (let ic = 0; ic < 64; ic += 4) {
        sum += c3[ic] * w4c[wOff + ic] + c3[ic + 1] * w4c[wOff + ic + 1] + c3[ic + 2] * w4c[wOff + ic + 2] + c3[ic + 3] * w4c[wOff + ic + 3];
      }
      c4[oc] = sum > 0 ? sum : 0;
    }

    const wIh = this.weights.lstmWeightIh;
    const wHh = this.weights.lstmWeightHh;
    const bIh = this.weights.lstmBiasIh;
    const bHh = this.weights.lstmBiasHh;
    const h = this.h;
    const c = this.c;
    const gates = this.gates;

    for (let g = 0; g < 512; g++) {
      let sum = bIh[g] + bHh[g];
      const rowOff = g * 128;
      for (let j = 0; j < 128; j += 4) {
        sum +=
          c4[j] * wIh[rowOff + j] + c4[j + 1] * wIh[rowOff + j + 1] + c4[j + 2] * wIh[rowOff + j + 2] + c4[j + 3] * wIh[rowOff + j + 3] +
          h[j] * wHh[rowOff + j] + h[j + 1] * wHh[rowOff + j + 1] + h[j + 2] * wHh[rowOff + j + 2] + h[j + 3] * wHh[rowOff + j + 3];
      }
      gates[g] = sum;
    }

    const fW = this.weights.finalWeight;
    let logit = this.weights.finalBias[0];
    for (let j = 0; j < 128; j++) {
      const iG = fastSigmoid(gates[j]);
      const fG = fastSigmoid(gates[128 + j]);
      const gG = Math.tanh(gates[256 + j]);
      const oG = fastSigmoid(gates[384 + j]);
      const cNext = fG * c[j] + iG * gG;
      const hNext = oG * Math.tanh(cNext);
      c[j] = cNext;
      h[j] = hNext;
      if (hNext > 0) logit += hNext * fW[j];
    }
    return fastSigmoid(logit);
  }
}

class WorkerLogMel32 {
  constructor(melW, customWindow512) {
    this.melW = melW || buildAnalyticalMelFilterbank257x32();
    this.window512 = new Float32Array(512);
    this.overlap480 = new Float32Array(480);
    this.work1760 = new Float32Array(1760);
    this.fftRe = new Float32Array(256);
    this.fftIm = new Float32Array(256);
    this.bitRev256 = new Uint16Array(256);
    this.twiddleCos = new Float32Array(128);
    this.twiddleSin = new Float32Array(128);
    this.unpackCos = new Float32Array(256);
    this.unpackSin = new Float32Array(256);
    this.power257 = new Float32Array(257);
    this.initFftTables(customWindow512);
  }
  reset() {
    this.overlap480.fill(0);
  }
  initFftTables(customWindow512) {
    if (customWindow512 && customWindow512.length === 512) {
      for (let i = 0; i < 512; i++) this.window512[i] = customWindow512[i] * 32768.0;
    } else {
      this.window512.fill(0);
      for (let n = 0; n < 400; n++) {
        this.window512[56 + n] = (0.5 - 0.5 * Math.cos((2 * Math.PI * n) / 400)) * 32768.0;
      }
    }
    for (let i = 0; i < 256; i++) {
      let rev = 0, x = i;
      for (let b = 0; b < 8; b++) { rev = (rev << 1) | (x & 1); x >>>= 1; }
      this.bitRev256[i] = rev;
    }
    for (let k = 0; k < 128; k++) {
      const ang = (-2 * Math.PI * k) / 256;
      this.twiddleCos[k] = Math.cos(ang);
      this.twiddleSin[k] = Math.sin(ang);
    }
    for (let k = 0; k < 256; k++) {
      const ang = (-2 * Math.PI * k) / 512;
      this.unpackCos[k] = Math.cos(ang);
      this.unpackSin[k] = Math.sin(ang);
    }
  }
  computePowerSpectrum512(src, startOffset) {
    const re = this.fftRe, im = this.fftIm, win = this.window512, rev = this.bitRev256;
    for (let n = 0; n < 256; n++) {
      const j = rev[n];
      const idx = startOffset + n * 2;
      re[j] = src[idx] * win[n * 2];
      im[j] = src[idx + 1] * win[n * 2 + 1];
    }
    const tCos = this.twiddleCos, tSin = this.twiddleSin;
    for (let len = 2; len <= 256; len <<= 1) {
      const half = len >> 1;
      const step = 256 / len;
      for (let i = 0; i < 256; i += len) {
        let twIdx = 0;
        for (let k = 0; k < half; k++) {
          const u = i + k, v = u + half;
          const wr = tCos[twIdx], wi = tSin[twIdx];
          twIdx += step;
          const vr = re[v] * wr - im[v] * wi;
          const vi = re[v] * wi + im[v] * wr;
          re[v] = re[u] - vr; im[v] = im[u] - vi;
          re[u] += vr; im[u] += vi;
        }
      }
    }
    const pow = this.power257;
    const dc = re[0] + im[0], nyq = re[0] - im[0];
    pow[0] = dc * dc;
    pow[256] = nyq * nyq;
    const uCos = this.unpackCos, uSin = this.unpackSin;
    for (let k = 1; k < 256; k++) {
      const nk = 256 - k;
      const er = 0.5 * (re[k] + re[nk]);
      const ei = 0.5 * (im[k] - im[nk]);
      const or = 0.5 * (im[k] + im[nk]);
      const oi = 0.5 * (re[nk] - re[k]);
      const xr = er + (or * uCos[k] - oi * uSin[k]);
      const xi = ei + (or * uSin[k] + oi * uCos[k]);
      pow[k] = xr * xr + xi * xi;
    }
  }
  processChunk1280(samples1280, outMel8x32) {
    const work = this.work1760;
    work.set(this.overlap480, 0);
    work.set(samples1280.subarray(0, 1280), 480);
    this.overlap480.set(samples1280.subarray(800, 1280), 0);
    const melW = this.melW, pow = this.power257;
    const invLn10Times10 = 10 / 2.3025851249694824;
    let maxDb = -Infinity;
    for (let f = 0; f < 8; f++) {
      this.computePowerSpectrum512(work, f * 160);
      const rowOff = f * 32;
      for (let m = 0; m < 32; m++) outMel8x32[rowOff + m] = 0;
      for (let b = 0; b < 257; b++) {
        const p = pow[b];
        if (p === 0) continue;
        const wOff = b * 32;
        for (let m = 0; m < 32; m++) outMel8x32[rowOff + m] += p * melW[wOff + m];
      }
      for (let m = 0; m < 32; m++) {
        const clipped = outMel8x32[rowOff + m] < 1e-10 ? 1e-10 : outMel8x32[rowOff + m];
        const db = Math.log(clipped) * invLn10Times10 - 20.0;
        outMel8x32[rowOff + m] = db;
        if (db > maxDb) maxDb = db;
      }
    }
    const floorDb = maxDb - 80;
    for (let i = 0; i < 256; i++) {
      const clamped = outMel8x32[i] < floorDb ? floorDb : outMel8x32[i];
      outMel8x32[i] = clamped * 0.1 + 2.0;
    }
  }
}

function transposeConvWeightToKIO(weightOIHW, spec) {
  const outC = spec.outC, inC = spec.inC, kH = spec.kH, kW = spec.kW;
  const dst = new Float32Array(kH * kW * inC * outC);
  for (let oc = 0; oc < outC; oc++) {
    for (let ic = 0; ic < inC; ic++) {
      for (let kh = 0; kh < kH; kh++) {
        for (let kw = 0; kw < kW; kw++) {
          const kIdx = kh * kW + kw;
          dst[(kIdx * inC + ic) * outC + oc] = weightOIHW[((oc * inC + ic) * kH + kh) * kW + kw];
        }
      }
    }
  }
  return dst;
}

function applyConv2dNHWC(src, inT, F, spec, wKIO, bias, dst) {
  const inC = spec.inC, outC = spec.outC, kH = spec.kH, kW = spec.kW, padF = spec.padF;
  const outT = inT - kH + 1;
  for (let t = 0; t < outT; t++) {
    for (let f = 0; f < F; f++) {
      const outBase = (t * F + f) * outC;
      if (bias) { for (let oc = 0; oc < outC; oc++) dst[outBase + oc] = bias[oc]; }
      else { for (let oc = 0; oc < outC; oc++) dst[outBase + oc] = 0; }
      for (let kh = 0; kh < kH; kh++) {
        const inRow = t + kh;
        for (let kw = 0; kw < kW; kw++) {
          const inFreq = f + kw - padF;
          if (inFreq < 0 || inFreq >= F) continue;
          const kBase = (kh * kW + kw) * inC * outC;
          const inBase = (inRow * F + inFreq) * inC;
          for (let ic = 0; ic < inC; ic++) {
            const v = src[inBase + ic];
            if (v === 0) continue;
            const wBase = kBase + ic * outC;
            for (let oc = 0; oc < outC; oc++) dst[outBase + oc] += v * wKIO[wBase + oc];
          }
        }
      }
      if (spec.activation === 'clamped_leaky_relu') {
        for (let oc = 0; oc < outC; oc++) {
          const x = dst[outBase + oc];
          const lrelu = x >= 0 ? x : 0.20000000298023224 * x;
          dst[outBase + oc] = lrelu > -0.4000000059604645 ? lrelu : -0.4000000059604645;
        }
      }
    }
  }
  return outT;
}

function applyMaxPool2dNHWC(src, inT, inF, C, poolT, poolF, dst) {
  const outT = Math.floor(inT / poolT);
  const outF = Math.floor(inF / poolF);
  for (let t = 0; t < outT; t++) {
    const t0 = t * poolT;
    for (let f = 0; f < outF; f++) {
      const f0 = f * poolF;
      const outBase = (t * outF + f) * C;
      const firstBase = (t0 * inF + f0) * C;
      for (let c = 0; c < C; c++) dst[outBase + c] = src[firstBase + c];
      for (let dt = 0; dt < poolT; dt++) {
        for (let df = 0; df < poolF; df++) {
          if (dt === 0 && df === 0) continue;
          const candBase = ((t0 + dt) * inF + (f0 + df)) * C;
          for (let c = 0; c < C; c++) {
            if (src[candBase + c] > dst[outBase + c]) dst[outBase + c] = src[candBase + c];
          }
        }
      }
    }
  }
  return { outT, outF };
}

function applyLayerNormReLU(x, gamma, beta) {
  const n = x.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += x[i];
  const mean = sum / n;
  let sq = 0;
  for (let i = 0; i < n; i++) { const d = x[i] - mean; sq += d * d; }
  const invStd = 1 / Math.sqrt(sq / n + 1e-5);
  for (let i = 0; i < n; i++) {
    const norm = (x[i] - mean) * invStd * gamma[i] + beta[i];
    x[i] = norm > 0 ? norm : 0;
  }
}

class WorkerOpenWakeWord {
  constructor(weights) {
    this.weights = weights;
    this.wKIO = weights.convWeights.map((w, idx) => transposeConvWeightToKIO(w, OWW_BACKBONE_SPECS[idx]));
    this.overlaps = new Map();
    this.stepInputs = new Map();
    for (let i = 0; i < TEMPORAL_CONV_FREQS.length; i++) {
      const item = TEMPORAL_CONV_FREQS[i];
      const rowFloats = item.F * item.inC;
      this.overlaps.set(item.convIdx, new Float32Array(2 * rowFloats));
      this.stepInputs.set(item.convIdx, new Float32Array((2 + item.stepRows) * rowFloats));
    }
    this.bufA = new Float32Array(8 * 32 * 48);
    this.bufB = new Float32Array(8 * 32 * 48);
    this.embeddingRing = new Float32Array(weights.embeddingFrames * 96);
    this.hidden1 = new Float32Array(weights.hiddenDim);
    this.hidden2 = new Float32Array(weights.hiddenDim);
    this.probsOut = new Float32Array(5);
    this.lastEmbedding = new Float32Array(96);
    this.stepsSinceReset = 0;
    this.reset();
  }
  get isWarmedUp() {
    return this.stepsSinceReset >= OWW_POST_RESET_WARMUP_STEPS;
  }
  reset() {
    const initMel = new Float32Array(76 * 32).fill(OWW_SILENCE_MEL_FLOOR);
    const seedEmb = this.forwardFullWindow76x32(initMel, true);
    for (let f = 0; f < this.weights.embeddingFrames; f++) {
      this.embeddingRing.set(seedEmb, f * 96);
    }
    this.stepsSinceReset = 0;
    this.probsOut.fill(0);
    this.probsOut[0] = 1;
  }
  forwardFullWindow76x32(mel76x32, seedOverlaps) {
    let cur = new Float32Array(mel76x32);
    let T = 76, F = 32;
    const runConv = (idx) => {
      const spec = OWW_BACKBONE_SPECS[idx];
      if (seedOverlaps && spec.kH === 3) {
        const ov = this.overlaps.get(idx);
        if (ov) ov.set(cur.subarray((T - 2) * F * spec.inC, T * F * spec.inC), 0);
      }
      const nextT = T - spec.kH + 1;
      const next = new Float32Array(nextT * F * spec.outC);
      applyConv2dNHWC(cur, T, F, spec, this.wKIO[idx], this.weights.convBiases[idx], next);
      cur = next; T = nextT;
    };
    const runPool = (pT, pF, C) => {
      const next = new Float32Array(Math.floor(T / pT) * Math.floor(F / pF) * C);
      const dims = applyMaxPool2dNHWC(cur, T, F, C, pT, pF, next);
      cur = next; T = dims.outT; F = dims.outF;
    };
    runConv(0); runConv(1); runConv(2); runPool(2, 2, 24);
    runConv(3); runConv(4); runConv(5); runConv(6); runPool(1, 2, 48);
    runConv(7); runConv(8); runConv(9); runConv(10); runPool(2, 2, 72);
    runConv(11); runConv(12); runConv(13); runConv(14); runPool(1, 2, 96);
    runConv(15); runConv(16); runConv(17); runConv(18); runPool(2, 2, 96);
    runConv(19);
    return cur;
  }
  stepCausal8x32(mel8x32) {
    let curSrc = mel8x32, curDst = this.bufA;
    let T = 8, F = 32;
    const swap = () => {
      const nextSrc = curDst;
      curDst = nextSrc === this.bufA ? this.bufB : this.bufA;
      curSrc = nextSrc;
    };
    const runC = (idx) => {
      const spec = OWW_BACKBONE_SPECS[idx];
      if (spec.kH === 3) {
        const ov = this.overlaps.get(idx);
        const cat = this.stepInputs.get(idx);
        const twoRow = 2 * F * spec.inC;
        const newF = T * F * spec.inC;
        cat.set(ov, 0);
        cat.set(curSrc.subarray(0, newF), twoRow);
        ov.set(cat.subarray(newF, twoRow + newF), 0);
        applyConv2dNHWC(cat, T + 2, F, spec, this.wKIO[idx], this.weights.convBiases[idx], curDst);
      } else {
        applyConv2dNHWC(curSrc, T, F, spec, this.wKIO[idx], this.weights.convBiases[idx], curDst);
      }
      swap();
    };
    const runP = (pT, pF, C) => {
      const dims = applyMaxPool2dNHWC(curSrc, T, F, C, pT, pF, curDst);
      T = dims.outT; F = dims.outF;
      swap();
    };
    runC(0); runC(1); runC(2); runP(2, 2, 24);
    runC(3); runC(4); runC(5); runC(6); runP(1, 2, 48);
    runC(7); runC(8); runC(9); runC(10); runP(2, 2, 72);
    runC(11); runC(12); runC(13); runC(14); runP(1, 2, 96);
    runC(15); runC(16); runC(17); runC(18); runP(2, 2, 96);
    runC(19);
    this.lastEmbedding.set(curSrc.subarray(0, 96), 0);
    this.embeddingRing.copyWithin(0, 96);
    this.embeddingRing.set(this.lastEmbedding, this.embeddingRing.length - 96);

    this.stepsSinceReset += 1;
    if (this.stepsSinceReset < OWW_POST_RESET_WARMUP_STEPS) {
      this.probsOut.fill(0);
      this.probsOut[0] = 1;
      return this.probsOut;
    }

    const w = this.weights, x = this.embeddingRing, h1 = this.hidden1, inLen = x.length, H = w.hiddenDim;
    for (let o = 0; o < H; o++) {
      let sum = w.fc1Bias[o];
      const row = o * inLen;
      for (let i = 0; i < inLen; i += 4) {
        sum += x[i] * w.fc1Weight[row + i] + x[i + 1] * w.fc1Weight[row + i + 1] + x[i + 2] * w.fc1Weight[row + i + 2] + x[i + 3] * w.fc1Weight[row + i + 3];
      }
      h1[o] = sum;
    }
    applyLayerNormReLU(h1, w.ln1Weight, w.ln1Bias);
    let feat = h1;
    if (w.fc2Weight && w.fc2Bias && w.ln2Weight && w.ln2Bias) {
      const h2 = this.hidden2;
      for (let o = 0; o < H; o++) {
        let sum = w.fc2Bias[o];
        const row = o * H;
        for (let i = 0; i < H; i += 4) {
          sum += h1[i] * w.fc2Weight[row + i] + h1[i + 1] * w.fc2Weight[row + i + 1] + h1[i + 2] * w.fc2Weight[row + i + 2] + h1[i + 3] * w.fc2Weight[row + i + 3];
        }
        h2[o] = sum;
      }
      applyLayerNormReLU(h2, w.ln2Weight, w.ln2Bias);
      feat = h2;
    }
    const K = Math.min(5, w.numClasses);
    this.probsOut.fill(0);
    let maxLogit = -Infinity;
    for (let k = 0; k < K; k++) {
      let sum = w.fcOutBias[k];
      const row = k * H;
      for (let i = 0; i < H; i++) sum += feat[i] * w.fcOutWeight[row + i];
      this.probsOut[k] = sum;
      if (sum > maxLogit) maxLogit = sum;
    }
    let expSum = 0;
    for (let k = 0; k < K; k++) {
      const e = Math.exp(this.probsOut[k] - maxLogit);
      this.probsOut[k] = e;
      expSum += e;
    }
    const inv = expSum > 0 ? 1 / expSum : 1;
    for (let k = 0; k < K; k++) this.probsOut[k] *= inv;
    return this.probsOut;
  }
}

class WorkerPbfdafAec {
  constructor() {
    this.bitRev512 = new Uint16Array(512);
    this.twCos512 = new Float32Array(256);
    this.twSin512 = new Float32Array(256);
    for (let i = 0; i < 512; i++) {
      let rev = 0, x = i;
      for (let b = 0; b < 9; b++) { rev = (rev << 1) | (x & 1); x >>>= 1; }
      this.bitRev512[i] = rev;
    }
    for (let k = 0; k < 256; k++) {
      const ang = (-2 * Math.PI * k) / 512;
      this.twCos512[k] = Math.cos(ang);
      this.twSin512[k] = Math.sin(ang);
    }
    this.fftRe = new Float32Array(512);
    this.fftIm = new Float32Array(512);
    this.xCurRe = new Float32Array(257);
    this.xCurIm = new Float32Array(257);
    this.yMainRe = new Float32Array(257);
    this.yMainIm = new Float32Array(257);
    this.yShadRe = new Float32Array(257);
    this.yShadIm = new Float32Array(257);
    this.eMainRe = new Float32Array(257);
    this.eMainIm = new Float32Array(257);
    this.eShadRe = new Float32Array(257);
    this.eShadIm = new Float32Array(257);
    this.timeTmp = new Float32Array(512);
    this.yMainTime = new Float32Array(512);
    this.yShadTime = new Float32Array(512);
    this.eMainBlock = new Float32Array(256);
    this.eShadBlock = new Float32Array(256);
    this.xRingRe = new Float32Array(8 * 257);
    this.xRingIm = new Float32Array(8 * 257);
    this.hMainRe = new Float32Array(8 * 257);
    this.hMainIm = new Float32Array(8 * 257);
    this.hShadRe = new Float32Array(8 * 257);
    this.hShadIm = new Float32Array(8 * 257);
    this.psdRef = new Float32Array(257).fill(1e-2);
    this.refHistory = new Float32Array(4096 + 2048);
    this.cleanedBuf = new Float32Array(512);
    this.decMic512 = new Float32Array(512);
    this.decRef512 = new Float32Array(512);
    this.gccDRe = new Float32Array(257);
    this.gccDIm = new Float32Array(257);
    this.gccXRe = new Float32Array(257);
    this.gccXIm = new Float32Array(257);
    this.gccPRe = new Float32Array(257);
    this.gccPIm = new Float32Array(257);
    this.partHead = 0;
    this.blockCounter = 0;
    this.estimatedDelay = 0;
    this.seededOutputLatencySamples = 0;
    this.framesSinceDelayEst = 0;
    this.echoFloorSq = 1e-6;
    this.reverbTailRemainingMs = 0;
    this.smoothPd = 1e-7;
    this.smoothPy = 1e-7;
    this.smoothPeMain = 1e-7;
    this.smoothPeShad = 1e-7;
    this.smoothRdy = 0;
    this.smoothRde = 0;
    this.lastErleDb = 0;
  }
  setOutputLatencyMs(latencyMs) {
    if (!Number.isFinite(latencyMs) || latencyMs < 0) return;
    const seeded = Math.max(0, Math.min(3584, Math.round(latencyMs * 16) - 256));
    this.seededOutputLatencySamples = seeded;
    if (this.blockCounter === 0) this.estimatedDelay = seeded;
  }
  reset() {
    this.xRingRe.fill(0); this.xRingIm.fill(0);
    this.hMainRe.fill(0); this.hMainIm.fill(0);
    this.hShadRe.fill(0); this.hShadIm.fill(0);
    this.psdRef.fill(1e-2);
    this.refHistory.fill(0);
    this.decMic512.fill(0); this.decRef512.fill(0);
    this.partHead = 0; this.blockCounter = 0;
    this.estimatedDelay = this.seededOutputLatencySamples;
    this.framesSinceDelayEst = 0;
    this.echoFloorSq = 1e-6;
    this.reverbTailRemainingMs = 0;
    this.smoothPd = 1e-7; this.smoothPy = 1e-7;
    this.smoothPeMain = 1e-7; this.smoothPeShad = 1e-7;
    this.smoothRdy = 0; this.smoothRde = 0; this.lastErleDb = 0;
  }
  fftComplex512(re, im, inverse) {
    const rev = this.bitRev512;
    for (let i = 0; i < 512; i++) {
      const j = rev[i];
      if (j > i) {
        const tr = re[i], ti = im[i];
        re[i] = re[j]; im[i] = im[j];
        re[j] = tr; im[j] = ti;
      }
    }
    const tCos = this.twCos512, tSin = this.twSin512, sign = inverse ? -1 : 1;
    for (let len = 2; len <= 512; len <<= 1) {
      const half = len >> 1, step = 512 / len;
      for (let i = 0; i < 512; i += len) {
        let tw = 0;
        for (let k = 0; k < half; k++) {
          const u = i + k, v = u + half;
          const wr = tCos[tw], wi = sign * tSin[tw];
          tw += step;
          const vr = re[v] * wr - im[v] * wi;
          const vi = re[v] * wi + im[v] * wr;
          re[v] = re[u] - vr; im[v] = im[u] - vi;
          re[u] += vr; im[u] += vi;
        }
      }
    }
    if (inverse) {
      const invN = 1 / 512;
      for (let i = 0; i < 512; i++) { re[i] *= invN; im[i] *= invN; }
    }
  }
  rfft512(in512, outRe, outIm) {
    this.fftRe.set(in512, 0);
    this.fftIm.fill(0);
    this.fftComplex512(this.fftRe, this.fftIm, false);
    for (let k = 0; k < 257; k++) { outRe[k] = this.fftRe[k]; outIm[k] = this.fftIm[k]; }
  }
  irfft512(inRe, inIm, out512) {
    const re = this.fftRe, im = this.fftIm;
    re[0] = inRe[0]; im[0] = 0;
    re[256] = inRe[256]; im[256] = 0;
    for (let k = 1; k < 256; k++) {
      re[k] = inRe[k]; im[k] = inIm[k];
      re[512 - k] = inRe[k]; im[512 - k] = -inIm[k];
    }
    this.fftComplex512(re, im, true);
    out512.set(re, 0);
  }
  constrainPartition(hRe, hIm, partIdx) {
    const off = partIdx * 257, re = this.fftRe, im = this.fftIm;
    re[0] = hRe[off]; im[0] = 0;
    re[256] = hRe[off + 256]; im[256] = 0;
    for (let k = 1; k < 256; k++) {
      re[k] = hRe[off + k]; im[k] = hIm[off + k];
      re[512 - k] = hRe[off + k]; im[512 - k] = -hIm[off + k];
    }
    this.fftComplex512(re, im, true);
    re.fill(0, 256); im.fill(0);
    this.fftComplex512(re, im, false);
    for (let k = 0; k < 257; k++) { hRe[off + k] = re[k]; hIm[off + k] = im[k]; }
  }
  updateGccPhatDelayEstimate() {
    let refPow = 0, micPow = 0;
    for (let i = 0; i < 512; i++) {
      refPow += this.decRef512[i] * this.decRef512[i];
      micPow += this.decMic512[i] * this.decMic512[i];
    }
    if (refPow < 1e-5 || micPow < 1e-5) return;
    this.rfft512(this.decMic512, this.gccDRe, this.gccDIm);
    this.rfft512(this.decRef512, this.gccXRe, this.gccXIm);
    for (let k = 0; k < 257; k++) {
      const cr = this.gccDRe[k] * this.gccXRe[k] + this.gccDIm[k] * this.gccXIm[k];
      const ci = this.gccDIm[k] * this.gccXRe[k] - this.gccDRe[k] * this.gccXIm[k];
      const mag = Math.sqrt(cr * cr + ci * ci) + 1e-4;
      this.gccPRe[k] = cr / mag;
      this.gccPIm[k] = ci / mag;
    }
    this.irfft512(this.gccPRe, this.gccPIm, this.timeTmp);
    let bestLag = 0, bestPeak = -Infinity, absSum = 0;
    for (let lag = 0; lag <= 448; lag++) {
      const v = this.timeTmp[lag];
      absSum += Math.abs(v);
      if (v > bestPeak) { bestPeak = v; bestLag = lag; }
    }
    if (bestPeak / (absSum / 449 + 1e-6) > 4.2) {
      const det = bestLag * 8;
      if (det < this.estimatedDelay || det > this.estimatedDelay + 1536) {
        const next = Math.max(0, Math.min(3584, det - 128));
        if (Math.abs(next - this.estimatedDelay) >= 256) {
          this.estimatedDelay = next;
          this.hMainRe.fill(0); this.hMainIm.fill(0);
          this.hShadRe.fill(0); this.hShadIm.fill(0);
          this.blockCounter = 0;
          this.smoothPy = 1e-7; this.smoothPeMain = 1e-7; this.smoothPeShad = 1e-7;
          this.smoothRdy = 0; this.smoothRde = 0; this.lastErleDb = 0;
        }
      }
    }
  }
  processFrame512(mic512, ref512, ttsPlaying) {
    if (ttsPlaying) this.reverbTailRemainingMs = 280;
    else if (this.reverbTailRemainingMs > 0) this.reverbTailRemainingMs = Math.max(0, this.reverbTailRemainingMs - 32);
    const active = ttsPlaying || this.reverbTailRemainingMs > 0;
    if (!active) {
      let eSq = 0;
      for (let i = 0; i < 512; i++) eSq += mic512[i] * mic512[i];
      const snrDb = 10 * Math.log10((eSq / 512 + 1e-9) / (this.echoFloorSq + 1e-9));
      return {
        cleanedMic: mic512, coherence: 0, residualToEchoRatio: 1, postNlmsSnrDb: Math.max(0, snrDb),
        echoSuppressed: false, estimatedDelaySamples: this.estimatedDelay, active: false,
        doubleTalkDetected: false, benestyNcc: 0, erleDb: 0,
      };
    }

    const hist = this.refHistory, histLen = hist.length;
    hist.copyWithin(0, 512);
    if (ref512 && ref512.length >= 512) hist.set(ref512.subarray(0, 512), histLen - 512);
    else hist.fill(0, histLen - 512);

    this.decMic512.copyWithin(0, 64);
    this.decRef512.copyWithin(0, 64);
    const refBase = histLen - 512;
    for (let b = 0; b < 64; b++) {
      let mA = 0, rA = 0;
      const off = b * 8;
      for (let k = 0; k < 8; k++) { mA += mic512[off + k]; rA += hist[refBase + off + k]; }
      this.decMic512[448 + b] = mA * 0.125;
      this.decRef512[448 + b] = rA * 0.125;
    }

    this.framesSinceDelayEst += 1;
    if (this.framesSinceDelayEst >= 8) {
      this.framesSinceDelayEst = 0;
      if (this.lastErleDb < 6.0) this.updateGccPhatDelayEstimate();
    }

    const out = this.cleanedBuf;
    let fMic = 1e-9, fErr = 1e-9, fY = 1e-9, fDY = 0, fDE = 0, fRef = 1e-9, dtBlks = 0;

    for (let blk = 0; blk < 2; blk++) {
      const blkOff = blk * 256;
      const xStart = Math.max(0, histLen - 512 + blkOff + 256 - this.estimatedDelay - 512);
      for (let i = 0; i < 512; i++) {
        const s = hist[xStart + i];
        this.timeTmp[i] = s;
        if (i >= 256) fRef += s * s;
      }
      this.partHead = (this.partHead + 1) & 7;
      this.rfft512(this.timeTmp, this.xCurRe, this.xCurIm);
      const hOff = this.partHead * 257;
      this.xRingRe.set(this.xCurRe, hOff);
      this.xRingIm.set(this.xCurIm, hOff);

      this.yMainRe.fill(0); this.yMainIm.fill(0);
      this.yShadRe.fill(0); this.yShadIm.fill(0);
      for (let p = 0; p < 8; p++) {
        const xSlot = ((this.partHead - p) & 7) * 257;
        const hSlot = p * 257;
        for (let k = 0; k < 257; k++) {
          const xr = this.xRingRe[xSlot + k], xi = this.xRingIm[xSlot + k];
          this.yMainRe[k] += this.hMainRe[hSlot + k] * xr - this.hMainIm[hSlot + k] * xi;
          this.yMainIm[k] += this.hMainRe[hSlot + k] * xi + this.hMainIm[hSlot + k] * xr;
          this.yShadRe[k] += this.hShadRe[hSlot + k] * xr - this.hShadIm[hSlot + k] * xi;
          this.yShadIm[k] += this.hShadRe[hSlot + k] * xi + this.hShadIm[hSlot + k] * xr;
        }
      }
      this.irfft512(this.yMainRe, this.yMainIm, this.yMainTime);
      this.irfft512(this.yShadRe, this.yShadIm, this.yShadTime);

      let bPd = 1e-9, bPy = 1e-9, bPeM = 1e-9, bPeS = 1e-9, bRdy = 0, bRde = 0;
      for (let i = 0; i < 256; i++) {
        const d = mic512[blkOff + i];
        const ym = this.yMainTime[256 + i], ys = this.yShadTime[256 + i];
        const em = d - ym, es = d - ys;
        this.eMainBlock[i] = em; this.eShadBlock[i] = es;
        bPd += d * d; bPy += ym * ym; bPeM += em * em; bPeS += es * es; bRdy += d * ym; bRde += d * em;
      }

      this.smoothPd = 0.7 * this.smoothPd + 0.3 * bPd;
      this.smoothPy = 0.7 * this.smoothPy + 0.3 * bPy;
      this.smoothPeMain = 0.7 * this.smoothPeMain + 0.3 * bPeM;
      this.smoothPeShad = 0.7 * this.smoothPeShad + 0.3 * bPeS;
      this.smoothRdy = 0.7 * this.smoothRdy + 0.3 * bRdy;
      this.smoothRde = 0.7 * this.smoothRde + 0.3 * bRde;

      const etaCoh = Math.abs(this.smoothRdy) / (Math.sqrt(this.smoothPd * this.smoothPy) + 1e-9);
      const ncc = Math.abs(this.smoothRde) / (Math.sqrt(this.smoothPd * this.smoothPeMain) + 1e-9);
      const isDt =
        this.blockCounter >= 10 &&
        this.smoothPy > 1e-5 &&
        this.smoothPd > 1e-4 &&
        ((ncc > 0.62 && this.smoothPeMain > 0.35 * this.smoothPd && etaCoh < 0.72) ||
          (this.smoothPeMain > 1.75 * this.smoothPy && etaCoh < 0.55));
      if (isDt) dtBlks += 1;

      let useShad = false;
      if (!isDt && bPeS < 0.88 * bPeM && bPeS < bPd) {
        this.hMainRe.set(this.hShadRe); this.hMainIm.set(this.hShadIm);
        useShad = true;
      } else if (bPeM > 1.45 * bPd && bPd > 1e-5) {
        if (bPeS < bPd) { this.hMainRe.set(this.hShadRe); this.hMainIm.set(this.hShadIm); useShad = true; }
        else { for (let i = 0; i < this.hMainRe.length; i++) { this.hMainRe[i] *= 0.5; this.hMainIm[i] *= 0.5; } }
      }

      const actE = useShad ? this.eShadBlock : this.eMainBlock;
      const actY = useShad ? this.yShadTime : this.yMainTime;
      for (let i = 0; i < 256; i++) {
        const d = mic512[blkOff + i], e = actE[i], y = actY[256 + i];
        out[blkOff + i] = e > 1 ? 1 : e < -1 ? -1 : e;
        fMic += d * d; fErr += e * e; fY += y * y; fDY += d * y; fDE += d * e;
      }

      for (let k = 0; k < 257; k++) {
        let bp = 0;
        for (let p = 0; p < 8; p++) {
          const idx = p * 257 + k;
          bp += this.xRingRe[idx] * this.xRingRe[idx] + this.xRingIm[idx] * this.xRingIm[idx];
        }
        this.psdRef[k] = 0.8 * this.psdRef[k] + 0.2 * bp;
      }

      this.timeTmp.fill(0, 0, 256);
      this.timeTmp.set(this.eShadBlock, 256);
      this.rfft512(this.timeTmp, this.eShadRe, this.eShadIm);

      const updM = !isDt && fRef > 1e-6;
      if (updM) {
        this.timeTmp.fill(0, 0, 256);
        this.timeTmp.set(actE, 256);
        this.rfft512(this.timeTmp, this.eMainRe, this.eMainIm);
      }

      const muS = isDt ? 0.12 : 0.68;
      for (let p = 0; p < 8; p++) {
        const xSlot = ((this.partHead - p) & 7) * 257;
        const hSlot = p * 257;
        for (let k = 0; k < 257; k++) {
          const invP = 1 / (this.psdRef[k] + 0.25);
          const xr = this.xRingRe[xSlot + k], xi = this.xRingIm[xSlot + k];
          const esr = this.eShadRe[k], esi = this.eShadIm[k];
          this.hShadRe[hSlot + k] = this.hShadRe[hSlot + k] * 0.9996 + muS * invP * (esr * xr + esi * xi);
          this.hShadIm[hSlot + k] = this.hShadIm[hSlot + k] * 0.9996 + muS * invP * (esi * xr - esr * xi);
          if (updM) {
            const emr = this.eMainRe[k], emi = this.eMainIm[k];
            this.hMainRe[hSlot + k] += 0.42 * invP * (emr * xr + emi * xi);
            this.hMainIm[hSlot + k] += 0.42 * invP * (emi * xr - emr * xi);
          }
        }
      }
      const rotP = (this.blockCounter % 7) + 1;
      this.constrainPartition(this.hShadRe, this.hShadIm, 0);
      this.constrainPartition(this.hShadRe, this.hShadIm, rotP);
      if (updM) {
        this.constrainPartition(this.hMainRe, this.hMainIm, 0);
        this.constrainPartition(this.hMainRe, this.hMainIm, rotP);
      }
      this.blockCounter += 1;
    }

    const coh = Math.min(1, Math.max(0, Math.sqrt((fDY * fDY) / (fMic * fY + 1e-9))));
    const ratio = fErr / (fY + 1e-7);
    const ncc = Math.min(1, Math.abs(fDE) / (Math.sqrt(fMic * fErr) + 1e-9));
    const erleDb = Math.max(0, 10 * Math.log10((fMic + 1e-9) / (fErr + 1e-9)));
    this.lastErleDb = 0.7 * this.lastErleDb + 0.3 * erleDb;
    const dt = dtBlks > 0;
    const errMeanSq = fErr / 512;
    if (!dt && (coh > 0.45 || ratio < 0.45)) this.echoFloorSq = 0.88 * this.echoFloorSq + 0.12 * Math.max(1e-7, errMeanSq);
    else this.echoFloorSq = Math.max(1e-7, 0.985 * this.echoFloorSq);
    const snrDb = 10 * Math.log10((errMeanSq + 1e-9) / (this.echoFloorSq + 1e-9));
    const echoSuppressed =
      !dt &&
      ((coh > 0.5 && ratio < 0.38) ||
        (fRef > 1e-4 && erleDb > 6.5 && ncc < 0.55) ||
        (fRef > 1e-4 && errMeanSq < this.echoFloorSq * 1.8 && coh > 0.35));
    return {
      cleanedMic: out, coherence: coh, residualToEchoRatio: ratio, postNlmsSnrDb: snrDb,
      echoSuppressed, estimatedDelaySamples: this.estimatedDelay, active: true,
      doubleTalkDetected: dt, benestyNcc: ncc, erleDb,
    };
  }
}

// ---------------------------------------------------------------------------
// Worker DSP Pipeline State Machine
// ---------------------------------------------------------------------------

const aec = new WorkerPbfdafAec();
const prerollRing = new WorkerCircularPcmRingBuffer(24000);

let silero = null;
let logMel = null;
let oww = null;
let neuralReady = false;
let mode = 'disabled';
let ttsPlaying = false;
let postTtsCooldownMs = 0;
let followupExtended = false;
let waitingForResponse = false;
let idleListeningMs = 0;

const accum1280 = new Float32Array(2048);
let accumLen = 0;
const stepSlice1280 = new Float32Array(1280);
const mel8x32 = new Float32Array(256);

const recentVad = new Float32Array(8);
let vadHangoverMs = 0;
let wakePatienceCount = 0;
let wakePatienceClass = 0;
let lastWakeTimestampMs = -10000;

let activeWakePhrase = 'Hi Echo';
let wakeSampleAnchor = 0;
let postWakeElapsedMs = 0;
let postWakeVoicedMs = 0;

let ambientNoiseRmsSq = 1e-6;
let turnSpeaking = false;
let turnVoicedMs = 0;
let turnSilenceMs = 0;
let turnTotalMs = 0;
let turnPeakSnrDb = 0;
let turnSampleOffset = 0;
let dynamicEndpointOverrideMs = null;
let tentativePauseFired = false;
let utteranceChunks = [];

let ttsDoubleTalkMs = 0;
let ttsDoubleTalkSilenceMs = 0;
let ttsDoubleTalkAnchorSample = 0;
let lastBargeInProbeMs = -10000;
let workletPort = null;

const CONFIG = {
  wakeThresholdDormant: 0.58,
  wakePatienceFrames: 2,
  wakeDebounceMs: 1800,
  postTtsWakeCooldownMs: 240,
  singleBreathWindowMs: 280,
  singleBreathPreLeadSamples: 4800,
  singleBreathVadThreshold: 0.45,
  positiveSpeechThreshold: 0.5,
  negativeSpeechThreshold: 0.32,
  preSpeechPadFrames: 15,
  shortCommandTentativeSilenceMs: 320,
  longUtteranceTentativeSilenceMs: 360,
  shortCommandEndpointMs: 560,
  defaultEndpointSilenceMs: 880,
  minCommitVoicedMs: 220,
  minCommitSnrDb: 5.0,
  followupTimeoutMs: 10000,
  followupExtendedTimeoutMs: 14000,
  bargeInProbeVoicedMs: 96,
  bargeInProbeCooldownMs: 350,
  maxUtteranceMs: 25000,
};

function resetTurnState() {
  turnSpeaking = false;
  turnVoicedMs = 0;
  turnSilenceMs = 0;
  turnTotalMs = 0;
  turnPeakSnrDb = 0;
  turnSampleOffset = 0;
  dynamicEndpointOverrideMs = null;
  tentativePauseFired = false;
  utteranceChunks = [];
}

function collectRecentTurnPcm16(maxSamples) {
  let total = 0;
  for (let i = 0; i < utteranceChunks.length; i++) total += utteranceChunks[i].length;
  const take = Math.min(total, maxSamples);
  const out = new Int16Array(take);
  let cursor = take;
  for (let i = utteranceChunks.length - 1; i >= 0 && cursor > 0; i--) {
    const c = utteranceChunks[i];
    const n = Math.min(c.length, cursor);
    out.set(c.subarray(c.length - n, c.length), cursor - n);
    cursor -= n;
  }
  return out;
}

function commitActiveUtterance(reason) {
  if (utteranceChunks.length === 0) {
    resetTurnState();
    return;
  }
  if (reason !== 'manual-commit' && (turnVoicedMs < CONFIG.minCommitVoicedMs || turnPeakSnrDb < CONFIG.minCommitSnrDb)) {
    const dropped = { type: 'utterance-discarded', reason: 'noise-gate', voicedMs: turnVoicedMs, peakSnrDb: turnPeakSnrDb };
    resetTurnState();
    self.postMessage(dropped);
    return;
  }
  let totalLen = 0;
  for (let i = 0; i < utteranceChunks.length; i++) totalLen += utteranceChunks[i].length;
  const merged = new Int16Array(totalLen);
  let off = 0;
  for (let i = 0; i < utteranceChunks.length; i++) {
    merged.set(utteranceChunks[i], off);
    off += utteranceChunks[i].length;
  }
  const ev = {
    type: 'speech-end',
    reason,
    voicedMs: turnVoicedMs,
    totalMs: turnTotalMs,
    peakSnrDb: turnPeakSnrDb,
    utterancePcm16: merged,
  };
  resetTurnState();
  idleListeningMs = 0;
  self.postMessage(ev, [merged.buffer]);
}

function processFrame512(mic512, ref512, timestampMs) {
  if (mode === 'disabled' || !mic512 || mic512.length < 512) return;
  const ts = typeof timestampMs === 'number' ? timestampMs : nowMs();
  const frameStartMs = nowMs();

  if (postTtsCooldownMs > 0) postTtsCooldownMs = Math.max(0, postTtsCooldownMs - 32);

  const aecRes = aec.processFrame512(mic512, ref512, ttsPlaying);
  const clean = aecRes.cleanedMic;
  prerollRing.write(clean);

  let rmsSq = 0;
  for (let i = 0; i < 512; i++) rmsSq += clean[i] * clean[i];
  rmsSq /= 512;
  const rms = Math.sqrt(rmsSq);

  let pSpeech = neuralReady && silero ? silero.processFrame512(clean) : 0;
  if (aecRes.echoSuppressed) pSpeech = 0;

  if (!turnSpeaking && !ttsPlaying && pSpeech < 0.25) {
    ambientNoiseRmsSq = 0.94 * ambientNoiseRmsSq + 0.06 * Math.max(1e-7, Math.min(0.01, rmsSq));
  }
  const frameSnrDb = 10 * Math.log10((rmsSq + 1e-9) / (ambientNoiseRmsSq + 1e-9));

  recentVad.copyWithin(0, 1);
  recentVad[7] = pSpeech;
  if (pSpeech >= 0.12) vadHangoverMs = 400;
  else if (vadHangoverMs > 0) vadHangoverMs = Math.max(0, vadHangoverMs - 32);

  // Post lightweight VAD frame telemetry only while active/speaking (0 main-thread wakeups during quiet Dormant!)
  if (mode !== 'dormant' || pSpeech >= 0.12) {
    self.postMessage({
      type: 'vad-frame',
      pSpeech,
      rms,
      postNlmsSnrDb: aecRes.postNlmsSnrDb,
      echoSuppressed: aecRes.echoSuppressed,
      coherence: aecRes.coherence,
      doubleTalkDetected: aecRes.doubleTalkDetected,
      benestyNcc: aecRes.benestyNcc,
      erleDb: aecRes.erleDb,
      timestampMs: ts,
    });
  }

  if (mode === 'dormant') {
    stepWakeAccumulator(clean, aecRes.echoSuppressed, ts, frameStartMs);
  } else if (mode === 'tts-speaking') {
    stepBargeInProbe(aecRes, pSpeech, ts);
  } else if (mode === 'post-wake-window') {
    stepPostWakeWindow(pSpeech, ts);
  } else if (mode === 'active-listening') {
    stepActiveListening(clean, pSpeech, frameSnrDb, ts);
  }
}

function stepWakeAccumulator(clean512, echoSuppressed, ts, frameStartMs) {
  accum1280.set(clean512.subarray(0, 512), accumLen);
  accumLen += 512;
  while (accumLen >= 1280) {
    stepSlice1280.set(accum1280.subarray(0, 1280), 0);
    const rem = accumLen - 1280;
    if (rem > 0) accum1280.copyWithin(0, 1280, accumLen);
    accumLen = rem;

    if (!neuralReady || !logMel || !oww) {
      wakePatienceCount = 0;
      wakePatienceClass = 0;
      continue;
    }

    logMel.processChunk1280(stepSlice1280, mel8x32);

    if (!oww.isWarmedUp) {
      oww.stepCausal8x32(mel8x32);
      wakePatienceCount = 0;
      wakePatienceClass = 0;
      continue;
    }

    if (echoSuppressed || ttsPlaying || postTtsCooldownMs > 0 || ts - lastWakeTimestampMs < CONFIG.wakeDebounceMs) {
      if (!echoSuppressed && !ttsPlaying) {
        oww.stepCausal8x32(mel8x32);
      }
      wakePatienceCount = 0;
      wakePatienceClass = 0;
      continue;
    }

    let maxRecentVad = 0;
    for (let i = 0; i < 8; i++) if (recentVad[i] > maxRecentVad) maxRecentVad = recentVad[i];
    if (vadHangoverMs <= 0 && maxRecentVad < 0.12) {
      wakePatienceCount = 0;
      wakePatienceClass = 0;
      continue;
    }

    const probs = oww.stepCausal8x32(mel8x32);
    let detectedClass = 0, confidence = 0;
    for (let k = 1; k < 5; k++) {
      if (probs[k] > confidence) { confidence = probs[k]; detectedClass = k; }
    }

    if (detectedClass >= 1 && confidence >= CONFIG.wakeThresholdDormant && maxRecentVad >= 0.35) {
      if (wakePatienceClass === detectedClass) wakePatienceCount += 1;
      else { wakePatienceClass = detectedClass; wakePatienceCount = 1; }

      if (wakePatienceCount >= CONFIG.wakePatienceFrames) {
        const className = WAKE_WORD_CLASSES[detectedClass];
        const phrase = CLASS_TO_PHRASE[className] || 'Hi Echo';
        lastWakeTimestampMs = ts;
        wakePatienceCount = 0;
        wakePatienceClass = 0;
        oww.reset();
        activeWakePhrase = phrase;
        wakeSampleAnchor = prerollRing.totalWritten;
        postWakeElapsedMs = 0;
        postWakeVoicedMs = 0;
        idleListeningMs = 0;
        mode = 'post-wake-window';
        const prerollF32 = prerollRing.readLatest(24000);
        self.postMessage(
          {
            type: 'wake',
            phrase,
            className,
            confidence,
            timestampMs: ts,
            detectionLatencyMs: nowMs() - frameStartMs,
            engine: 'neural-oww',
            prerollPcmF32: prerollF32,
          },
          [prerollF32.buffer],
        );
        break;
      }
    } else {
      wakePatienceCount = 0;
      wakePatienceClass = 0;
    }
  }
}

function stepPostWakeWindow(pSpeech, ts) {
  postWakeElapsedMs += 32;
  if (postWakeElapsedMs > 32 && pSpeech >= CONFIG.singleBreathVadThreshold) {
    postWakeVoicedMs += 32;
  }
  if (postWakeVoicedMs >= 96) {
    const anchorWithLead = Math.max(0, wakeSampleAnchor - CONFIG.singleBreathPreLeadSamples);
    const openingF32 = prerollRing.readSinceSample(anchorWithLead);
    const openingPcm16 = float32ToPcm16(openingF32);
    const streamCopy = new Int16Array(openingPcm16);

    mode = 'active-listening';
    idleListeningMs = 0;
    resetTurnState();
    turnSpeaking = true;
    turnVoicedMs = postWakeVoicedMs;
    turnTotalMs = postWakeElapsedMs;
    turnPeakSnrDb = CONFIG.minCommitSnrDb + 5;
    utteranceChunks.push(openingPcm16);
    turnSampleOffset = openingPcm16.length;

    self.postMessage(
      {
        type: 'single-breath',
        phrase: activeWakePhrase,
        timestampMs: ts,
        postWakeVoicedMs,
        turn1OpeningPcm16: streamCopy,
      },
      [streamCopy.buffer],
    );
    return;
  }
  if (postWakeElapsedMs >= CONFIG.singleBreathWindowMs) {
    mode = 'active-listening';
    idleListeningMs = 0;
    resetTurnState();
    self.postMessage({ type: 'post-wake-cleared', singleBreath: false, timestampMs: ts });
  }
}

function stepBargeInProbe(aecRes, pSpeech, ts) {
  const isDt = !aecRes.echoSuppressed && pSpeech >= 0.58 && (aecRes.doubleTalkDetected || aecRes.postNlmsSnrDb >= 6.0);
  if (isDt) {
    if (ttsDoubleTalkMs === 0) {
      ttsDoubleTalkAnchorSample = Math.max(0, prerollRing.totalWritten - 512);
    }
    ttsDoubleTalkMs += 32;
    ttsDoubleTalkSilenceMs = 0;
    if (ttsDoubleTalkMs >= CONFIG.bargeInProbeVoicedMs && ts - lastBargeInProbeMs >= CONFIG.bargeInProbeCooldownMs) {
      lastBargeInProbeMs = ts;
      const probePcm16 = float32ToPcm16(prerollRing.readLatest(10240));
      self.postMessage(
        { type: 'barge-in-probe', pcm16: probePcm16, voicedMs: ttsDoubleTalkMs, timestampMs: ts },
        [probePcm16.buffer],
      );
    }
  } else {
    ttsDoubleTalkSilenceMs += 32;
    if (ttsDoubleTalkSilenceMs >= 160) {
      ttsDoubleTalkMs = 0;
      ttsDoubleTalkAnchorSample = 0;
    }
  }
}

function handoffBargeInToActiveTurn(startTurn, ts) {
  const capturedVoicedMs = ttsDoubleTalkMs;
  const capturedSilenceMs = ttsDoubleTalkSilenceMs;
  const anchorSample = ttsDoubleTalkAnchorSample;

  ttsPlaying = false;
  postTtsCooldownMs = 0;
  waitingForResponse = false;
  ttsDoubleTalkMs = 0;
  ttsDoubleTalkSilenceMs = 0;
  ttsDoubleTalkAnchorSample = 0;
  mode = 'active-listening';
  idleListeningMs = 0;
  resetTurnState();

  if (startTurn === false || capturedVoicedMs < 64 || capturedSilenceMs > 480) {
    return;
  }

  const sinceSample = Math.max(
    prerollRing.totalWritten - 19200,
    Math.max(0, anchorSample - 5120),
  );
  const openingF32 = prerollRing.readSinceSample(sinceSample);
  if (openingF32.length < 512) return;

  const openingPcm16 = float32ToPcm16(openingF32);
  const startCopy = new Int16Array(openingPcm16);
  turnSpeaking = true;
  turnVoicedMs = capturedVoicedMs;
  turnSilenceMs = capturedSilenceMs;
  turnTotalMs = Math.max(capturedVoicedMs, Math.round((openingPcm16.length / 16000) * 1000));
  turnPeakSnrDb = Math.max(CONFIG.minCommitSnrDb + 3, 10);
  utteranceChunks = [openingPcm16];
  turnSampleOffset = openingPcm16.length;

  self.postMessage({ type: 'speech-start', timestampMs: ts, prerollPcm16: startCopy }, [startCopy.buffer]);
}

function stepActiveListening(clean512, pSpeech, frameSnrDb, ts) {
  if (!turnSpeaking) {
    if (pSpeech >= CONFIG.positiveSpeechThreshold) {
      waitingForResponse = false;
      idleListeningMs = 0;
      turnSpeaking = true;
      turnVoicedMs = 32;
      turnSilenceMs = 0;
      turnTotalMs = 32;
      turnPeakSnrDb = frameSnrDb;
      tentativePauseFired = false;

      const prerollPcm16 = float32ToPcm16(prerollRing.readLatest(CONFIG.preSpeechPadFrames * 512));
      const startCopy = new Int16Array(prerollPcm16);
      utteranceChunks = [prerollPcm16];
      turnSampleOffset = prerollPcm16.length;

      self.postMessage({ type: 'speech-start', timestampMs: ts, prerollPcm16: startCopy }, [startCopy.buffer]);
      return;
    }

    if (waitingForResponse) {
      idleListeningMs = 0;
      return;
    }

    idleListeningMs += 32;
    const limitMs = followupExtended ? CONFIG.followupExtendedTimeoutMs : CONFIG.followupTimeoutMs;
    if (idleListeningMs >= limitMs) {
      const elapsed = idleListeningMs;
      idleListeningMs = 0;
      mode = 'dormant';
      resetTurnState();
      self.postMessage({ type: 'followup-timeout', idleMs: elapsed, timestampMs: ts });
    }
    return;
  }

  const pcm16 = float32ToPcm16(clean512);
  const streamCopy = new Int16Array(pcm16);
  const offsetBefore = turnSampleOffset;
  utteranceChunks.push(pcm16);
  turnSampleOffset += pcm16.length;
  turnTotalMs += 32;
  self.postMessage({ type: 'streaming-pcm16', pcm16: streamCopy, sampleOffset: offsetBefore }, [streamCopy.buffer]);

  if (pSpeech >= CONFIG.negativeSpeechThreshold) {
    turnVoicedMs += 32;
    if (frameSnrDb > turnPeakSnrDb) turnPeakSnrDb = frameSnrDb;
    turnSilenceMs = 0;
    tentativePauseFired = false;
  } else {
    turnSilenceMs += 32;
  }

  const isShort = turnVoicedMs <= 900;
  const tentativeMs = isShort ? CONFIG.shortCommandTentativeSilenceMs : CONFIG.longUtteranceTentativeSilenceMs;
  const endpointMs =
    dynamicEndpointOverrideMs !== null
      ? dynamicEndpointOverrideMs
      : isShort
        ? CONFIG.shortCommandEndpointMs
        : CONFIG.defaultEndpointSilenceMs;
  const effectiveEndpointMs = turnVoicedMs < CONFIG.minCommitVoicedMs ? Math.min(endpointMs, 360) : endpointMs;

  if (!tentativePauseFired && turnSilenceMs >= tentativeMs && turnVoicedMs >= 160) {
    tentativePauseFired = true;
    const recentPcm16 = collectRecentTurnPcm16(128000);
    self.postMessage(
      { type: 'tentative-pause', silenceMs: turnSilenceMs, voicedMs: turnVoicedMs, recentPcm16 },
      [recentPcm16.buffer],
    );
  }

  if (turnSilenceMs >= effectiveEndpointMs) {
    commitActiveUtterance('silence');
  } else if (turnTotalMs >= CONFIG.maxUtteranceMs) {
    commitActiveUtterance('max-duration');
  }
}

async function loadModelsFromUrl(baseUrl) {
  try {
    const cleanBase = String(baseUrl || '/echo-jarvis/models').replace(/\/+$/, '');
    const mRes = await fetch(cleanBase + '/manifest.json', { credentials: 'same-origin' });
    if (!mRes.ok) throw new Error('Manifest HTTP ' + mRes.status);
    const manifest = await mRes.json();
    const sSec = manifest.sileroVad || (manifest.models && manifest.models.sileroVad);
    const oSec = manifest.openWakeWord || (manifest.models && manifest.models.openWakeWord);
    if (!sSec || !oSec) throw new Error('Missing model manifest sections');

    const [sBuf, oBuf] = await Promise.all([
      fetch(cleanBase + '/' + sSec.file, { credentials: 'same-origin' }).then((r) => r.arrayBuffer()),
      fetch(cleanBase + '/' + oSec.file, { credentials: 'same-origin' }).then((r) => r.arrayBuffer()),
    ]);

    const sW = parseSileroVadBinary(sBuf, sSec);
    const oW = parseOpenWakeWordBinary(oBuf, oSec);
    silero = new WorkerSileroVadV5(sW);
    logMel = new WorkerLogMel32(oW.melW, oW.stftWindow);
    oww = new WorkerOpenWakeWord(oW);
    neuralReady = true;
    wakePatienceCount = 0;
    wakePatienceClass = 0;
    self.postMessage({ type: 'weights-loaded', ok: true });
  } catch (err) {
    neuralReady = false;
    self.postMessage({ type: 'weights-loaded', ok: false, error: err && err.message ? err.message : 'load-failed' });
  }
}

function handleWorkletMessage(ev) {
  const data = ev && ev.data;
  if (!data || data.type !== 'jarvis-frame') return;
  processFrame512(data.mic, data.hasRef ? data.ref : null, nowMs());
}

self.onmessage = (ev) => {
  const msg = ev && ev.data;
  if (!msg || typeof msg !== 'object') return;

  switch (msg.type) {
    case 'load-weights':
      void loadModelsFromUrl(msg.baseUrl);
      break;
    case 'attach-worklet-port': {
      if (workletPort) workletPort.onmessage = null;
      workletPort = msg.port || (ev.ports && ev.ports[0]) || null;
      if (workletPort) workletPort.onmessage = handleWorkletMessage;
      break;
    }
    case 'set-mode': {
      const next = msg.mode;
      if (next !== mode) {
        mode = next;
        idleListeningMs = 0;
        ttsDoubleTalkMs = 0;
        ttsDoubleTalkSilenceMs = 0;
        ttsDoubleTalkAnchorSample = 0;
        if (next === 'dormant' || next === 'disabled') {
          waitingForResponse = false;
          resetTurnState();
          wakePatienceCount = 0;
          wakePatienceClass = 0;
        }
      }
      break;
    }
    case 'set-tts-playing': {
      const playing = Boolean(msg.playing);
      if (ttsPlaying && !playing) {
        postTtsCooldownMs = CONFIG.postTtsWakeCooldownMs;
        waitingForResponse = false;
        idleListeningMs = 0;
        wakePatienceCount = 0;
        wakePatienceClass = 0;
        ttsDoubleTalkMs = 0;
        ttsDoubleTalkSilenceMs = 0;
        ttsDoubleTalkAnchorSample = 0;
      }
      ttsPlaying = playing;
      break;
    }
    case 'set-output-latency-ms':
      aec.setOutputLatencyMs(Number(msg.latencyMs) || 0);
      break;
    case 'set-dynamic-endpoint-ms':
      dynamicEndpointOverrideMs = Math.max(240, Math.min(1150, Number(msg.waitMs) || CONFIG.defaultEndpointSilenceMs));
      break;
    case 'set-followup-extended':
      followupExtended = Boolean(msg.extended);
      break;
    case 'set-waiting-response':
      waitingForResponse = Boolean(msg.waiting);
      if (waitingForResponse) idleListeningMs = 0;
      break;
    case 'abort-turn':
      resetTurnState();
      idleListeningMs = 0;
      break;
    case 'barge-in-handoff':
      handoffBargeInToActiveTurn(msg.startTurn !== false, nowMs());
      break;
    case 'commit':
      commitActiveUtterance(msg.reason || 'manual-commit');
      break;
    case 'reset':
      aec.reset();
      if (silero) silero.resetState();
      if (logMel) logMel.reset();
      if (oww) oww.reset();
      prerollRing.clear();
      accumLen = 0;
      recentVad.fill(0);
      vadHangoverMs = 0;
      wakePatienceCount = 0;
      wakePatienceClass = 0;
      postTtsCooldownMs = 0;
      waitingForResponse = false;
      idleListeningMs = 0;
      ttsDoubleTalkMs = 0;
      ttsDoubleTalkSilenceMs = 0;
      ttsDoubleTalkAnchorSample = 0;
      ambientNoiseRmsSq = 1e-6;
      resetTurnState();
      break;
    case 'frame':
      processFrame512(msg.mic, msg.ref || null, msg.timestampMs);
      break;
    default:
      break;
  }
};

self.postMessage({ type: 'ready' });
