import { MUSIC_CATALOG } from './catalog';
import { getTrack, listTracks, readSettings, writeSettings, saveTrack, deleteTrack, editTrack } from './storage';
import { prepareImport } from './import';
import { nextIndex } from './model';
import type { MusicTrack, RepeatMode } from './model';

export interface MusicState {
  ready: boolean; library: MusicTrack[]; queue: string[]; current: MusicTrack | null;
  playing: boolean; loading: boolean; time: number; duration: number; volume: number;
  shuffle: boolean; repeat: RepeatMode; error: string | null; focus: string | null;
  importing: boolean; importResult: { added: number; failed: number } | null;
  /** The learner started music in this tab: only then does the header show its player. */
  engaged: boolean;
}
type Saved = { version: 1; queue: string[]; id?: string; time: number; volume: number; repeat: RepeatMode; shuffle: boolean };
const INITIAL: MusicState = { ready: false, library: [], queue: [], current: null, playing: false, loading: false,
  time: 0, duration: 0, volume: .45, shuffle: false, repeat: 'all', error: null, focus: null, importing: false, importResult: null, engaged: false };

/** One engine per signed-in account, above the router. Routes never own audio. */
export class MusicEngine {
  private state: MusicState = INITIAL;
  private listeners = new Set<() => void>();
  private audio: HTMLAudioElement | null = null;
  private blob: string | null = null;
  private generation = 0;
  private disposed = false;
  private context: AudioContext | null = null;
  private analysisPending: Promise<boolean> | null = null;
  analyser: AnalyserNode | null = null;
  private persistAt = 0;
  private holds = new Set<string>();
  private routeFocus: string | null = null;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private channel: BroadcastChannel | null = null;
  private readonly instance = typeof crypto !== 'undefined' ? crypto.randomUUID() : '';
  constructor(readonly scope: string | null) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.state;
  private patch(values: Partial<MusicState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...values }; this.listeners.forEach(listener => listener());
  }
  tracks = () => [...MUSIC_CATALOG, ...this.state.library];
  track = (id: string) => this.tracks().find(track => track.id === id);
  async initialize() {
    if (!this.scope) { this.patch({ ready: true }); return; }
    try {
      const [library, saved] = await Promise.all([listTracks(this.scope), readSettings<Saved>(this.scope)]);
      if (this.disposed) return;
      this.patch({ library, ready: true });
      if (saved?.version === 1) {
        const queue = Array.isArray(saved.queue) ? saved.queue.filter(id => typeof id === 'string' && this.track(id)).slice(0, 200) : [];
        const volume = Number.isFinite(saved.volume) ? Math.max(0, Math.min(1, saved.volume)) : .45;
        this.patch({ queue, volume, repeat: ['off', 'all', 'one'].includes(saved.repeat) ? saved.repeat : 'all', shuffle: saved.shuffle === true });
        const current = saved.id && this.track(saved.id);
        if (current) this.patch({ current, time: Number.isFinite(saved.time) ? Math.max(0, saved.time) : 0, duration: current.duration ?? 0 });
      }
      if (this.state.current && this.session('get') === '1') this.patch({ engaged: true });
      if (typeof BroadcastChannel !== 'undefined') {
        this.channel = new BroadcastChannel(`ec-music-u${this.scope}`);
        this.channel.onmessage = event => {
          if (event.data?.instance === this.instance) return;
          if (event.data?.type === 'play') this.pause();
          if (event.data?.type === 'library') void this.reloadLibrary();
        };
      }
    } catch { this.patch({ ready: true, error: 'STORAGE_UNAVAILABLE' }); }
  }
  // Per-tab memory of "music was started here", so a refresh keeps the (paused) header player and a new tab starts clean.
  private session(op: 'get' | 'set' | 'clear') {
    if (!this.scope || typeof sessionStorage === 'undefined') return null;
    const key = `ec-music-engaged-u${this.scope}`;
    try { if (op === 'get') return sessionStorage.getItem(key); if (op === 'set') sessionStorage.setItem(key, '1'); else sessionStorage.removeItem(key); } catch { /* Storage blocked. */ }
    return null;
  }
  private engage() { if (!this.state.engaged) { this.patch({ engaged: true }); this.session('set'); } }
  private persist = () => {
    if (!this.scope || !this.state.ready || this.disposed) return;
    const { queue, current, time, volume, repeat, shuffle } = this.state;
    void writeSettings(this.scope, { version: 1, queue, id: current?.id, time, volume, repeat, shuffle } satisfies Saved).catch(() => {});
  };
  private releaseAudio() {
    this.clearStall();
    if (this.audio) { this.audio.pause(); this.audio.removeAttribute('src'); this.audio.load(); this.audio.remove(); this.audio = null; }
    if (this.blob) { URL.revokeObjectURL(this.blob); this.blob = null; }
    if (this.context) { void this.context.close().catch(() => {}); this.context = null; }
    this.analyser = null;
    this.analysisPending = null;
  }
  private clearStall() { if (this.stallTimer) { clearTimeout(this.stallTimer); this.stallTimer = null; } }
  private armStall(epoch: number) {
    this.clearStall();
    this.stallTimer = setTimeout(() => {
      if (this.disposed || epoch !== this.generation) return;
      ++this.generation; this.releaseAudio(); this.patch({ error: 'PLAYBACK_FAILED', playing: false, loading: false });
    }, 20000);
  }
  select = async (id: string, queue?: string[], autoplay = true) => {
    const track = this.track(id); if (!track || this.disposed) return;
    if (this.state.current?.id === id && this.audio) {
      if (queue) this.patch({ queue: queue.filter(id => this.track(id)) });
      if (autoplay) await this.play(); return;
    }
    const epoch = ++this.generation;
    this.releaseAudio();
    this.patch({ current: track, queue: (queue ?? (this.state.queue.includes(id) ? this.state.queue : [id])).filter(id => this.track(id)).slice(0, 200),
      playing: false, loading: true, time: 0, duration: track.duration ?? 0, error: null });
    try {
      let source = track.url;
      if (track.source === 'local') {
        if (!this.scope) throw new Error('ACCOUNT_REQUIRED');
        const stored = await getTrack(this.scope, id);
        if (this.disposed || epoch !== this.generation) return;
        if (!stored) throw new Error('FILE_MISSING');
        source = this.blob = URL.createObjectURL(stored.file);
      }
      if (!source) throw new Error('FILE_MISSING');
      const audio = this.audio = new Audio();
      audio.dataset.echoMusic = 'true'; audio.preload = 'metadata'; audio.volume = this.state.volume;
      audio.dataset.testid = 'music-audio'; audio.dataset.trackId = track.id; audio.hidden = true; audio.setAttribute('aria-hidden', 'true');
      document.body.appendChild(audio);
      const alive = () => !this.disposed && epoch === this.generation;
      audio.onloadedmetadata = () => { if (alive()) this.patch({ duration: Number.isFinite(audio.duration) ? audio.duration : 0 }); };
      audio.ontimeupdate = () => {
        if (!alive()) return;
        this.patch({ time: audio.currentTime });
        if (Date.now() - this.persistAt > 5000) { this.persistAt = Date.now(); this.persist(); }
      };
      audio.onplaying = () => { if (alive()) { if (this.state.focus) { audio.pause(); return; } this.clearStall(); this.patch({ playing: true, loading: false, error: null }); this.engage(); this.mediaState(); } };
      audio.onpause = () => { if (alive()) { this.patch({ playing: false }); this.mediaState(); } };
      audio.onwaiting = () => { if (alive()) { this.armStall(epoch); this.patch({ loading: true }); } };
      audio.oncanplay = () => { if (alive()) { this.clearStall(); this.patch({ loading: false }); } };
      audio.onerror = () => { if (alive()) { this.clearStall(); this.patch({ error: 'PLAYBACK_FAILED', loading: false, playing: false }); } };
      audio.onended = () => {
        if (!alive()) return;
        if (this.state.repeat === 'one') { audio.currentTime = 0; void this.play(); }
        else if (this.state.repeat === 'off' && this.state.queue.indexOf(id) === this.state.queue.length - 1 && !this.state.shuffle) { this.patch({ playing: false }); this.persist(); }
        else void this.next();
      };
      this.armStall(epoch); audio.src = source;
      this.mediaMetadata(track);
      if (autoplay) await this.play();
      this.persist();
    } catch (error) { if (epoch === this.generation) this.patch({ loading: false, playing: false, error: error instanceof Error ? error.message : 'PLAYBACK_FAILED' }); }
  };
  play = async () => {
    if (this.state.focus) return;
    if (!this.audio) {
      const time = this.state.time;
      await this.select(this.state.current?.id ?? MUSIC_CATALOG[0].id, this.state.queue.length ? this.state.queue : MUSIC_CATALOG.map(t => t.id), false);
      if (this.audio && time > 0) this.seek(time);
    }
    const audio = this.audio; if (!audio || this.disposed || this.state.focus) return;
    try {
      if (audio.error) audio.load();
      if (this.state.current?.source === 'local') await this.enableAnalysis();
      if (this.context?.state === 'suspended') await this.context.resume();
      if (this.disposed || this.audio !== audio || this.state.focus) return;
      await audio.play();
      if (this.disposed || this.audio !== audio || this.state.focus) { audio.pause(); return; }
      this.channel?.postMessage({ type: 'play', instance: this.instance });
      this.patch({ error: null }); this.persist();
    } catch (error) {
      this.clearStall();
      if ((error as DOMException).name === 'AbortError') { if (this.audio === audio) this.patch({ playing: false, loading: false }); return; }
      if (this.audio === audio) this.patch({ playing: false, loading: false, error: (error as DOMException).name === 'NotAllowedError' ? 'TAP_TO_PLAY' : 'PLAYBACK_FAILED' });
    }
  };
  pause = () => { this.clearStall(); this.audio?.pause(); this.patch({ playing: false, loading: false }); this.persist(); };
  toggle = () => this.state.playing ? this.pause() : void this.play();
  /** Stop and put the header player away; the room and the saved position stay. */
  dismiss = () => { this.pause(); this.patch({ engaged: false }); this.session('clear'); };
  next = async (direction = 1) => {
    const { queue, current, shuffle } = this.state;
    if (!queue.length) return;
    if (direction < 0 && this.state.time > 3) { this.seek(0); return; }
    await this.select(queue[nextIndex(Math.max(0, queue.indexOf(current?.id ?? '')), queue.length, direction, shuffle && direction > 0)]);
  };
  seek = (value: number) => {
    const duration = this.state.duration;
    if (!Number.isFinite(value)) return;
    const time = Math.max(0, Math.min(value, duration || value));
    if (this.audio) { try { this.audio.currentTime = time; } catch { return; } }
    this.patch({ time }); this.persist();
  };
  volume = (volume: number) => { if (!Number.isFinite(volume)) return; volume = Math.max(0, Math.min(1, volume)); if (this.audio) this.audio.volume = volume; this.patch({ volume }); this.persist(); };
  shuffle = () => { this.patch({ shuffle: !this.state.shuffle }); this.persist(); };
  repeat = () => { this.patch({ repeat: this.state.repeat === 'off' ? 'all' : this.state.repeat === 'all' ? 'one' : 'off' }); this.persist(); };
  enqueue = (id: string) => { if (this.track(id) && !this.state.queue.includes(id)) { this.patch({ queue: [...this.state.queue, id].slice(0, 200) }); this.persist(); } };
  removeQueue = (id: string) => { if (id !== this.state.current?.id) { this.patch({ queue: this.state.queue.filter(x => x !== id) }); this.persist(); } };
  moveQueue = (id: string, delta: number) => {
    const queue = [...this.state.queue], at = queue.indexOf(id), to = at + delta;
    if (at < 0 || to < 0 || to >= queue.length) return;
    [queue[at], queue[to]] = [queue[to], queue[at]]; this.patch({ queue }); this.persist();
  };
  setFocus = (reason: string | null) => { this.routeFocus = reason; this.updateFocus(); };
  hold = (id: string, active: boolean) => { if (active) this.holds.add(id); else this.holds.delete(id); this.updateFocus(); };
  private updateFocus() { const focus = this.routeFocus ?? (this.holds.size ? 'media' : null); this.patch({ focus }); if (focus) this.pause(); }
  // Optional real spectrum, local audio only. Cross-origin recordings stay on the native output path.
  enableAnalysis = (): Promise<boolean> => {
    if (this.analysisPending) return this.analysisPending;
    const pending = this.configureAnalysis();
    this.analysisPending = pending;
    void pending.finally(() => { if (this.analysisPending === pending) this.analysisPending = null; });
    return pending;
  };
  private async configureAnalysis(): Promise<boolean> {
    const audio = this.audio;
    if (!audio || this.disposed || this.state.current?.source !== 'local') return false;
    if (this.context && this.analyser) {
      try { await this.context.resume(); return this.audio === audio && !this.disposed; } catch { return false; }
    }
    let ctx: AudioContext | null = null;
    try {
      ctx = this.context = new AudioContext();
      // Resume before rerouting the element: unsupported/blocked Web Audio retains native playback.
      // A blocked resume can remain pending indefinitely. Optional analysis must never hold Play.
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([ctx.resume(), new Promise<void>(resolve => { timeout = setTimeout(resolve, 250); })]); }
      finally { clearTimeout(timeout); }
      if (ctx.state !== 'running' || this.audio !== audio || this.disposed || this.context !== ctx) {
        void ctx.close().catch(() => {}); if (this.context === ctx) this.context = null; return false;
      }
      const analyser = ctx.createAnalyser(); analyser.fftSize = 1024; analyser.smoothingTimeConstant = .65;
      const source = ctx.createMediaElementSource(audio);
      source.connect(ctx.destination); // unity gain; analysis cannot change volume or EQ
      source.connect(analyser);
      this.analyser = analyser;
      return true;
    } catch {
      if (ctx) { void ctx.close().catch(() => {}); if (this.context === ctx) this.context = null; }
      return false;
    }
  }
  private mediaMetadata(track: MusicTrack) {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({ title: track.title, artist: track.artist || 'Echo Music', album: track.source === 'curated' ? 'Scott Buckley · CC BY 4.0' : 'My Music', artwork: track.artwork ? [{ src: track.artwork }] : [] });
    for (const [action, handler] of Object.entries({ play: this.play, pause: this.pause, previoustrack: () => this.next(-1), nexttrack: () => this.next() })) {
      try { navigator.mediaSession.setActionHandler(action as MediaSessionAction, () => { void handler(); }); } catch { /* Unsupported action. */ }
    }
  }
  private mediaState() { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = this.state.playing ? 'playing' : 'paused'; }
  reloadLibrary = async () => {
    if (!this.scope) return;
    try {
      const library = await listTracks(this.scope); if (this.disposed) return;
      this.patch({ library });
      if (this.state.current?.source === 'local' && !library.some(track => track.id === this.state.current?.id)) { this.releaseAudio(); this.patch({ current: null, time: 0, playing: false, engaged: false }); this.session('clear'); }
      this.patch({ queue: this.state.queue.filter(id => this.track(id)) });
    } catch { this.patch({ error: 'STORAGE_UNAVAILABLE' }); }
  };
  importFiles = async (files: File[]) => {
    if (!this.scope || this.state.importing) return;
    this.patch({ importing: true, error: null, importResult: null });
    let added = 0, failed = 0;
    for (const file of files.slice(0, 50)) {
      if (this.disposed) return;
      try { const track = await prepareImport(file); if (this.disposed) return; await saveTrack(this.scope, track); added++; }
      catch (error) { failed++; this.patch({ error: (error as Error).message || 'IMPORT_FAILED' }); }
    }
    await this.reloadLibrary(); this.channel?.postMessage({ type: 'library', instance: this.instance });
    this.patch({ importing: false, importResult: { added, failed: failed + Math.max(0, files.length - 50) } });
    void navigator.storage?.persist?.().catch(() => {});
  };
  delete = async (id: string) => {
    if (!this.scope) return;
    try {
      await deleteTrack(this.scope, id);
      if (this.state.current?.id === id) { ++this.generation; this.releaseAudio(); this.patch({ current: null, playing: false, time: 0, duration: 0, engaged: false }); this.session('clear'); }
      await this.reloadLibrary(); this.persist(); this.channel?.postMessage({ type: 'library', instance: this.instance });
    } catch { this.patch({ error: 'STORAGE_UNAVAILABLE' }); }
  };
  edit = async (id: string, title: string, artist: string) => {
    if (!this.scope) return;
    try { await editTrack(this.scope, id, title, artist); await this.reloadLibrary(); if (this.state.current?.id === id) this.patch({ current: this.track(id) }); this.channel?.postMessage({ type: 'library', instance: this.instance }); }
    catch { this.patch({ error: 'STORAGE_UNAVAILABLE' }); }
  };
  dismissError = () => this.patch({ error: null, importResult: null });
  checkpoint = () => this.persist();
  dispose = () => {
    this.persist(); this.disposed = true; ++this.generation; this.releaseAudio(); this.channel?.close(); this.listeners.clear();
    if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) { navigator.mediaSession.metadata = null; for (const action of ['play', 'pause', 'previoustrack', 'nexttrack']) try { navigator.mediaSession.setActionHandler(action as MediaSessionAction, null); } catch {} }
  };
}
