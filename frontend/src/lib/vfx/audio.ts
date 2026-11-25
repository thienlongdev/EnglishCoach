/** A read-only bridge to Echo Music's ONE audio engine. Never creates or plays audio. */
export interface AudioBands { bass: number; mid: number; treble: number; level: number; mode: 'live' | 'ambient' | 'silent' }
interface Source { snapshot(): { playing: boolean }; analyser: AnalyserNode | null }
let source: Source | null = null;
let sampled = -Infinity;
let bins: Uint8Array<ArrayBuffer> = new Uint8Array(0);
const bands: AudioBands = { bass: 0, mid: 0, treble: 0, level: 0, mode: 'silent' };
export function bindMusicAnalysis(next: Source) {
  source = next; sampled = -Infinity;
  return () => { if (source === next) { source = null; bands.bass = bands.mid = bands.treble = bands.level = 0; bands.mode = 'silent'; } };
}
export function frequencyBand(data: Uint8Array, sampleRate: number, fftSize: number, from: number, to: number) {
  const a = Math.max(1, Math.ceil(from * fftSize / sampleRate)), b = Math.min(data.length, Math.floor(to * fftSize / sampleRate) + 1);
  if (b <= a) return 0;
  let energy = 0; for (let i = a; i < b; i++) energy += (data[i] / 255) ** 2;
  return Math.sqrt(energy / (b - a));
}
/** Samples at most 20 Hz even when two existing scenes read it. Smooth release on pause. */
export function musicBands(now = performance.now()): Readonly<AudioBands> {
  if (now - sampled < 50) return bands;
  const dt = Math.min(.15, Math.max(0, (now - sampled) / 1000)); sampled = now;
  const playing = !document.hidden && !!source?.snapshot().playing;
  const analyser = playing ? source?.analyser : null;
  let bass = 0, mid = 0, treble = 0;
  if (analyser && analyser.context.state === 'running') {
    if (bins.length !== analyser.frequencyBinCount) bins = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(bins);
    bass = frequencyBand(bins, analyser.context.sampleRate, analyser.fftSize, 40, 250);
    mid = frequencyBand(bins, analyser.context.sampleRate, analyser.fftSize, 250, 2400);
    treble = frequencyBand(bins, analyser.context.sampleRate, analyser.fftSize, 2400, 12000);
    bands.mode = 'live';
  } else bands.mode = playing ? 'ambient' : 'silent';
  const k = 1 - Math.exp(-dt * (playing ? 5 : 3));
  bands.bass += (bass - bands.bass) * k; bands.mid += (mid - bands.mid) * k; bands.treble += (treble - bands.treble) * k;
  bands.level = (bands.bass + bands.mid + bands.treble) / 3;
  return bands;
}
