// Listening: free on-device English -> Vietnamese translation (module worker, owner request 2026-10-29).
// Model: Helsinki-NLP/opus-mt-en-vi (Apache-2.0), ONNX int8 files of Xenova/opus-mt-en-vi rev 30bcd461 (~101 MB), run by
// Transformers.js 3.8.1 / ONNX Runtime Web (Apache-2.0 / MIT) on WebAssembly. Every file is same-origin, pinned and listed in
// MANIFEST.sha256; this directory is served with its own narrow CSP (deploy/nginx/default.conf) that alone allows WebAssembly
// compilation. No English Coach API and no paid provider is called from here. A changed worker ships under a new file name.
const BASE = new URL('./', import.meta.url);
const MODEL = 'opus-mt-en-vi-30bcd461';
const RUNTIME = new URL('runtime-3.8.1/', BASE);
const MODEL_PATH = BASE.pathname + MODEL + '/';
// The model's own target-language token: keeps the output in Latin-script Vietnamese.
const TARGET = '>>vie<< ';

// Only files of this directory. Model files and the WebAssembly binary are stored with a ".bin" suffix (the CDN caches
// that extension); the binary keeps its real media type for streaming compilation.
const nativeFetch = self.fetch.bind(self);
self.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), self.location.href);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(BASE.pathname)) {
    throw new TypeError('listening translator: blocked request outside its directory');
  }
  const wasm = url.pathname.endsWith('.wasm');
  if (!wasm && !url.pathname.startsWith(MODEL_PATH)) return nativeFetch(url.href, init);
  const res = await nativeFetch(url.href + '.bin', init);
  if (!wasm || !res.ok) return res;
  const headers = new Headers(res.headers);
  headers.set('content-type', 'application/wasm');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
};

let loading = null;

async function create() {
  const { pipeline, env } = await import(new URL('transformers.min.js', RUNTIME).href);
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.remoteHost = BASE.href;
  env.remotePathTemplate = '{model}/';
  env.useBrowserCache = true;
  env.backends.onnx.wasm.wasmPaths = RUNTIME.href;
  // The site is not cross-origin isolated: one WebAssembly thread, no proxy worker.
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.proxy = false;
  const files = new Map();
  const translator = await pipeline('translation', MODEL, {
    dtype: 'q8',
    device: 'wasm',
    progress_callback: (p) => {
      if (p.status !== 'progress' || !p.total) return;
      files.set(p.file, [p.loaded, p.total]);
      let loaded = 0, total = 0;
      for (const [l, t] of files.values()) { loaded += l; total += t; }
      self.postMessage({ type: 'progress', loaded, total });
    },
  });
  self.postMessage({ type: 'ready', engine: 'opus-mt-en-vi', model: MODEL });
  void dropStaleCopies();
  return translator;
}

/** Earlier model copies (other versions / the Hugging Face URLs of the first release) are deleted from Cache Storage. */
async function dropStaleCopies() {
  try {
    const cache = await caches.open('transformers-cache');
    for (const request of await cache.keys()) {
      if (/opus-mt-en-vi/.test(request.url) && !request.url.includes('/' + MODEL + '/')) await cache.delete(request);
    }
  } catch { /* storage may be unavailable; nothing to clean */ }
}

function load() {
  if (!loading) {
    loading = create();
    loading.catch(() => { loading = null; });
  }
  return loading;
}

self.onmessage = async ({ data }) => {
  if (data?.type === 'load') {
    try { await load(); } catch (e) { self.postMessage({ type: 'fatal', message: String(e?.message || e) }); }
    return;
  }
  if (data?.type !== 'translate') return;
  let translator;
  try { translator = await load(); } catch (e) {
    self.postMessage({ type: 'fatal', id: data.id, message: String(e?.message || e) });
    return;
  }
  try {
    const text = String(data.text);
    const out = await translator(TARGET + text, { max_new_tokens: Math.min(400, Math.ceil(text.length / 2) + 24) });
    self.postMessage({ type: 'result', id: data.id, text: out?.[0]?.translation_text ?? '' });
  } catch (e) {
    self.postMessage({ type: 'error', id: data.id, message: String(e?.message || e) });
  }
};
