'use client';
// Free English -> Vietnamese translation on the learner's own device (owner request 2026-10-29).
// Order: Chrome's built-in Translator API when it is really usable, else the OPUS-MT ONNX worker
// (`public/vendor/listening-translator-v1.js`). No server inference and no paid provider: if neither works the
// English stays usable and the missing pairs wait for a later visit.

export type FreeEngine = 'chrome-translator' | 'opus-mt-en-vi';
export type FreeTranslatorStatus =
    | { phase: 'idle' | 'preparing' | 'ready' }
    | { phase: 'downloading'; progress: number }
    | { phase: 'unavailable'; reason: 'unsupported' | 'save-data' | 'memory' | 'failed' };

interface Engine { engine: FreeEngine; translate(text: string): Promise<string>; dispose(): void }
interface NativeTranslator { translate(text: string): Promise<string>; destroy?: () => void }
interface NativeTranslatorApi {
    availability(o: { sourceLanguage: string; targetLanguage: string }): Promise<string>;
    create(o: { sourceLanguage: string; targetLanguage: string; monitor?: (m: EventTarget) => void }): Promise<NativeTranslator>;
}

const PAIR = { sourceLanguage: 'en', targetLanguage: 'vi' };
// Its directory carries its own narrow CSP (WebAssembly only there); model + runtime are pinned same-origin files.
const WORKER_URL = '/vendor/listening-translator/worker-v2.js';
const IDLE_MS = 3 * 60_000;
const listeners = new Set<(s: FreeTranslatorStatus) => void>();
let status: FreeTranslatorStatus = { phase: 'idle' };
let engine: Promise<Engine | null> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let failedUntil = 0;

function setStatus(next: FreeTranslatorStatus) { status = next; listeners.forEach(l => l(next)); }
export function subscribeFreeTranslator(listener: (s: FreeTranslatorStatus) => void): () => void {
    listeners.add(listener); listener(status); return () => { listeners.delete(listener); };
}

function nativeApi(): NativeTranslatorApi | undefined {
    const api = (globalThis as { Translator?: NativeTranslatorApi }).Translator;
    return typeof api?.availability === 'function' && typeof api.create === 'function' ? api : undefined;
}
function nativeEngine(t: NativeTranslator): Engine {
    return { engine: 'chrome-translator', translate: text => t.translate(text), dispose: () => { try { t.destroy?.(); } catch { /* already gone */ } } };
}
/** A language pack that still needs downloading may only be created inside a user gesture: wait for the learner's
 *  own next click / key press (never synthesized), at most `ms`. */
function nativeOnNextGesture(api: NativeTranslatorApi, ms: number): Promise<Engine | null> {
    return new Promise(resolve => {
        const done = (value: Engine | null) => { window.removeEventListener('pointerdown', onGesture, true); window.removeEventListener('keydown', onGesture, true); clearTimeout(timer); resolve(value); };
        const onGesture = () => {
            window.removeEventListener('pointerdown', onGesture, true); window.removeEventListener('keydown', onGesture, true); clearTimeout(timer);
            setStatus({ phase: 'preparing' });
            within(api.create({ ...PAIR, monitor: m => m.addEventListener('downloadprogress', e => setStatus({ phase: 'downloading', progress: Number((e as ProgressEvent).loaded) || 0 })) }), 120_000)
                .then(t => done(nativeEngine(t)), () => done(null));
        };
        const timer = setTimeout(() => done(null), ms);
        window.addEventListener('pointerdown', onGesture, true); window.addEventListener('keydown', onGesture, true);
    });
}

function onnxEngine(): Engine | null {
    const nav = navigator as Navigator & { connection?: { saveData?: boolean }; deviceMemory?: number };
    if (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined') { setStatus({ phase: 'unavailable', reason: 'unsupported' }); return null; }
    if (nav.connection?.saveData) { setStatus({ phase: 'unavailable', reason: 'save-data' }); return null; }
    if (typeof nav.deviceMemory === 'number' && nav.deviceMemory < 3) { setStatus({ phase: 'unavailable', reason: 'memory' }); return null; }
    let worker: Worker;
    try { worker = new Worker(WORKER_URL, { type: 'module', name: 'listening-translator' }); } catch { setStatus({ phase: 'unavailable', reason: 'unsupported' }); return null; }
    const pending = new Map<number, { resolve: (t: string) => void; reject: (e: Error) => void }>();
    let next = 1;
    const fail = (message: string) => {
        setStatus({ phase: 'unavailable', reason: 'failed' }); failedUntil = Date.now() + 10 * 60_000;
        pending.forEach(p => p.reject(Object.assign(new Error(message), { fatal: true }))); pending.clear();
        worker.terminate(); engine = null;
    };
    worker.onmessage = ({ data }) => {
        if (data?.type === 'progress') setStatus({ phase: 'downloading', progress: data.total ? data.loaded / data.total : 0 });
        else if (data?.type === 'ready') setStatus({ phase: 'ready' });
        else if (data?.type === 'fatal') fail(String(data.message));
        else if (data?.type === 'result' || data?.type === 'error') {
            const job = pending.get(data.id); pending.delete(data.id);
            if (data.type === 'result') job?.resolve(String(data.text ?? '')); else job?.reject(new Error(String(data.message)));
        }
    };
    worker.onerror = () => fail('worker error');
    setStatus({ phase: 'preparing' });
    worker.postMessage({ type: 'load' });
    return {
        engine: 'opus-mt-en-vi',
        translate: text => new Promise((resolve, reject) => { const id = next++; pending.set(id, { resolve, reject }); worker.postMessage({ type: 'translate', id, text }); }),
        dispose: () => { worker.terminate(); pending.forEach(p => p.reject(new Error('disposed'))); pending.clear(); },
    };
}

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error('timeout')), ms); promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); }); });
}

async function createEngine(): Promise<Engine | null> {
    const api = nativeApi();
    if (api) {
        try {
            // Some embedded / managed browsers expose the API but never answer: never wait on it for long.
            const availability = await within(api.availability(PAIR), 3000);
            if (availability === 'available') { const e = nativeEngine(await within(api.create(PAIR), 10000)); setStatus({ phase: 'ready' }); return e; }
            if (availability === 'downloadable' || availability === 'downloading') {
                const viaGesture = await nativeOnNextGesture(api, 8000);
                if (viaGesture) { setStatus({ phase: 'ready' }); return viaGesture; }
            }
        } catch { /* fall through to the free ONNX worker */ }
    }
    return onnxEngine();
}

/** Releases the model's memory after a quiet spell; the weights stay cached for the next lesson. */
function armIdle(ms = IDLE_MS) {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { const current = engine; engine = null; setStatus({ phase: 'idle' }); void current?.then(e => e?.dispose()); }, ms);
}

/**
 * The transcript that used the translator was left: release the model after a short grace instead of three minutes, so a
 * heavy 3D page opened next does not share the device with it (performance release 2026-11-16, PERF-11). Coming back to a
 * lesson within the grace keeps the loaded model; translation itself is unchanged.
 */
export function leaveFreeTranslator(): void {
    if (engine) armIdle(30_000);
}

export async function translateFree(text: string): Promise<{ engine: FreeEngine; text: string } | null> {
    if (Date.now() < failedUntil) return null;
    clearTimeout(idleTimer);
    if (!engine) engine = createEngine();
    const current = await engine;
    if (!current) { engine = null; return null; }
    try { return { engine: current.engine, text: await current.translate(text) }; }
    finally { armIdle(); }
}

/** Same light checks as the server (`ListeningWorkspaceService#acceptable`); a failed pair simply stays pending. */
export function acceptableTranslation(text: string, source: string): string | null {
    const clean = text.normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
    const src = source.replace(/\s+/g, ' ').trim();
    // Han characters mean the model drifted to its vie_Hani variant: never stored as Vietnamese.
    if (!clean || clean.includes('\ufffd') || /\p{Script=Han}/u.test(clean) || clean.length > Math.min(2000, src.length * 4 + 80)) return null;
    if (clean.toLowerCase() === src.toLowerCase() && src.split(' ').length >= 3) return null;
    // A generation loop repeats one word; a line that repeats itself ("la, la, la…") may be translated the same way.
    if (longestRun(clean) >= 6 && longestRun(src) < 3) return null;
    return clean;
}

function longestRun(text: string): number {
    const words = text.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').split(/ +/); let run = 1, best = 1;
    for (let i = 1; i < words.length; i++) { run = words[i] === words[i - 1] ? run + 1 : 1; best = Math.max(best, run); }
    return best;
}
