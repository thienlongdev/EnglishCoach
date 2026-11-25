// Study room physics (2026-11-06). The page's script policy never allows WebAssembly compilation, so the room's physics engine
// (Rapier 0.12.0) is compiled here: a dedicated worker is governed by the policy of its OWN response, and only responses under
// /vendor/study-physics/ carry 'wasm-unsafe-eval' (deploy/nginx/default.conf). The compiled module goes back to the page, which
// instantiates it without compiling anything. Only the exact pinned bytes are compiled: this is not a general compiler.
'use strict';
const PINNED = 'db0b0ac357ae581d89134fd4ac0ff9a4c344d746fb1e6a14f2f98a3eb2714739';
self.onmessage = async (event) => {
  const { id, bytes } = event.data || {};
  try {
    if (!(bytes instanceof ArrayBuffer)) throw new Error('no bytes');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    let hex = '';
    for (const b of digest) hex += b.toString(16).padStart(2, '0');
    if (hex !== PINNED) throw new Error('not the pinned physics engine');
    const module = await WebAssembly.compile(bytes);
    self.postMessage({ id, module });
  } catch (error) {
    self.postMessage({ id, error: String((error && error.message) || error) });
  }
};
