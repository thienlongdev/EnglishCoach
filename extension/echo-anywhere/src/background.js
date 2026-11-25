// Echo Anywhere service worker: the ONE place that talks to English Coach.
// Content scripts and extension pages ask it through runtime messages; it holds the extension's own session
// (never a website cookie: every request is sent with credentials 'omit' and an Authorization header).
import { SITE, VERSION } from './config.js';
import { validateSource } from './language.js';

const API = `${SITE}/api/v1`;
const SAVED_LIMIT = 500;
const PRIVATE_HOSTS = ['facebook.com', 'messenger.com', 'zalo.me', 'web.whatsapp.com', 'mail.google.com',
  'outlook.live.com', 'outlook.office.com', 'web.telegram.org', 'discord.com', 'teams.microsoft.com', 'slack.com',
  'reddit.com', 'x.com', 'twitter.com', 'threads.net', 'threads.com', 'tiktok.com', 'instagram.com', 'zalo.vn'];
function privatePage(url) {
  try {
    const { hostname } = new URL(url);
    return PRIVATE_HOSTS.some((h) => hostname === h || hostname.endsWith(`.${h}`));
  } catch { return true; }
}
const BLOCKED_HOSTS = [new URL(SITE).hostname, 'www.englishcoach.io.vn'];

// ---------------------------------------------------------------- storage

const local = chrome.storage.local;
const session = chrome.storage.session;
async function consentScope(m, sender) {
  if (!sender.tab?.id || !['mixed','private'].includes(m.kind)) return {data:null};
  const url = new URL(sender.url);
  const key = [sender.tab.id, url.origin, m.kind, m.kind === 'private' ? url.pathname + url.hash : ''].join('|');
  const digest = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key));
  return {data:{id:Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join(''),kind:m.kind,remember:!!m.remember}};
}
async function consentGrant(m, remember) {
  if (!m.scope?.remember || !/^[a-f0-9]{64}$/.test(m.scope.id) || !['lexical','save','ai','cosmos','media'].includes(m.purpose)) return {allowed:false};
  const auth = await getAuth();
  const key = `share:${auth?.account?.id ?? 'guest'}:${m.scope.id}:${m.purpose}`;
  if (remember) await session.set({[key]:Date.now()+8*3600000});
  const expires = (await session.get(key))[key];
  return {allowed:expires > Date.now()};
}
try { local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }); } catch { /* older browsers: content scripts never read it anyway */ }
try { session.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }); } catch { /* idem */ }

async function getAuth() {
  const { auth } = await local.get('auth');
  return auth && auth.refreshToken ? auth : null;
}
async function setAuth(auth) {
  const previous=await getAuth();
  if(!auth || !previous || previous.account?.id!==auth.account?.id) await clearSharing();
  if (auth) await local.set({ auth }); else await local.remove('auth');
  await session.remove(['access', 'me']);
  broadcast({ t: 'state-changed' });
}
async function clearSharing() {
  const keys=Object.keys(await session.get(null)).filter(k=>k.startsWith('share:'));
  if(keys.length)await session.remove(keys);
}
async function getSettings() {
  const { settings } = await local.get('settings');
  return { autoBubble: true, disabledSites: [], readingTheme: 'light', fontScale: 1, onboarded: false, ...(settings || {}) };
}
async function patchSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await local.set({ settings: next });
  broadcast({ t: 'state-changed' });
  return next;
}
const accountKey = (auth) => (auth ? `saved:u${auth.account.id}` : 'saved:guest');

// ---------------------------------------------------------------- tokens

let refreshing = null;

async function accessToken(force = false) {
  const auth = await getAuth();
  if (!auth) return null;
  if (!force) {
    const { access } = await session.get('access');
    if (access && access.userId === auth.account.id && access.exp - Date.now() > 60_000) return access.token;
  }
  if (!refreshing) {
    refreshing = (async () => {
      const res = await rawFetch(`${API}/extension/token`, {
        method: 'POST',
        body: JSON.stringify({ grantType: 'refresh_token', refreshToken: auth.refreshToken, extensionId: chrome.runtime.id }),
      });
      if (res.status === 401 || res.status === 403 || res.status === 400) {
        await setAuth(null);
        return null;
      }
      if (!res.ok) throw apiError(res.status, await safeJson(res));
      const body = await res.json();
      await local.set({ auth: { ...auth, refreshToken: body.refreshToken, account: body.account } });
      await session.set({ access: { token: body.accessToken, exp: Date.now() + body.expiresIn * 1000, userId: body.account.id } });
      return body.accessToken;
    })().finally(() => { refreshing = null; });
  }
  return refreshing;
}

function rawFetch(url, init = {}) {
  const ctrl = new AbortController();
  const abort=()=>ctrl.abort();
  if(init.signal?.aborted)ctrl.abort();else init.signal?.addEventListener('abort',abort,{once:true});
  const timer = setTimeout(() => ctrl.abort(), init.timeout || 20_000);
  return fetch(url, {
    ...init,
    credentials: 'omit',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(init.headers || {}) },
    signal: ctrl.signal,
  }).finally(() => {clearTimeout(timer);init.signal?.removeEventListener('abort',abort);});
}

async function safeJson(res) {
  try { return await res.json(); } catch { return null; }
}

function apiError(status, body) {
  const code = body?.errorCode || body?.code || (status === 0 ? 'NETWORK' : `HTTP_${status}`);
  const message = body?.message || body?.reason || (status === 401 ? 'Cần kết nối tài khoản English Coach.' : 'Không kết nối được English Coach. Hãy thử lại.');
  return { error: { status, code, message, upgradePath: body?.upgradePath || null } };
}

/** An authenticated API call (one transparent refresh on 401). */
async function api(path, init = {}, retry = true) {
  const token = await accessToken();
  if (!token) return apiError(401, { code: 'NOT_CONNECTED', message: 'Hãy kết nối Echo Anywhere với tài khoản English Coach.' });
  let res;
  try {
    res = await rawFetch(`${API}${path}`, { ...init, headers: { Authorization: `Bearer ${token}` } });
  } catch {
    return apiError(0, { code: 'NETWORK', message: 'Không có kết nối mạng hoặc English Coach đang bận.' });
  }
  if (res.status === 401 && retry) {
    await session.remove('access');
    const again = await accessToken(true);
    if (!again) return apiError(401, { code: 'NOT_CONNECTED', message: 'Phiên đã hết hạn. Hãy kết nối lại.' });
    return api(path, init, false);
  }
  const body = res.status === 204 ? {} : await safeJson(res);
  if (!res.ok) return apiError(res.status, body);
  return { data: body, headers: res.headers };
}

// ---------------------------------------------------------------- pairing (PKCE)

function b64url(bytes) {
  let s = '';
  bytes.forEach((b) => { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function startConnect() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  await session.set({ pkce: { verifier, state, at: Date.now() } });
  const browser = (navigator.userAgentData?.brands || []).some((b) => /edge/i.test(b.brand)) || /Edg\//.test(navigator.userAgent) ? 'edge' : 'chrome';
  const url = `${SITE}/echo-anywhere/connect?ext=${chrome.runtime.id}&challenge=${challenge}&state=${state}&browser=${browser}`;
  await chrome.tabs.create({ url });
  return { ok: true };
}

async function finishConnect(code, state) {
  const { pkce } = await session.get('pkce');
  if (!pkce || pkce.state !== state || Date.now() - pkce.at > 10 * 60_000) {
    return { ok: false, message: 'Yêu cầu kết nối đã hết hạn. Hãy bấm "Kết nối" lại trong tiện ích.' };
  }
  await session.remove('pkce');
  let res;
  try {
    res = await rawFetch(`${API}/extension/token`, {
      method: 'POST',
      body: JSON.stringify({ grantType: 'authorization_code', code, codeVerifier: pkce.verifier, extensionId: chrome.runtime.id }),
    });
  } catch {
    return { ok: false, message: 'Không kết nối được English Coach.' };
  }
  const body = await safeJson(res);
  if (!res.ok || !body?.refreshToken) return { ok: false, message: body?.message || 'Kết nối không thành công.' };
  await setAuth({ refreshToken: body.refreshToken, account: body.account, connectedAt: Date.now() });
  await session.set({ access: { token: body.accessToken, exp: Date.now() + body.expiresIn * 1000, userId: body.account.id } });
  const settings = await getSettings();
  if (!settings.onboarded) await patchSettings({ onboarded: true });
  return { ok: true, name: body.account.displayName };
}

async function disconnect() {
  const auth = await getAuth();
  if (auth) {
    try { await api('/extension/session/revoke', { method: 'POST', body: '{}' }, false); } catch { /* local sign-out still happens */ }
  }
  await setAuth(null);
  return { ok: true };
}

// ---------------------------------------------------------------- state

async function state() {
  const auth = await getAuth();
  const settings = await getSettings();
  let me = null;
  if (auth) {
    const cached = (await session.get('me')).me;
    if (cached && Date.now() - cached.at < 5 * 60_000 && cached.userId === auth.account.id) me = cached.data;
    else {
      const r = await api('/extension/me');
      if (r.data) {
        me = r.data;
        await session.set({ me: { data: me, at: Date.now(), userId: auth.account.id } });
      }
    }
  }
  const stillAuth = await getAuth();
  return {
    version: VERSION,
    site: SITE,
    connected: !!stillAuth,
    account: stillAuth ? stillAuth.account : null,
    premium: !!me?.premium,
    premiumUntil: me?.premiumUntil || null,
    ai: me?.ai || null,
    level: me?.level || null,
    settings,
  };
}

// ---------------------------------------------------------------- dictionary / translation (free)

const lookupCache = new Map();
function remember(key, value) {
  lookupCache.set(key, { value, at: Date.now() });
  if (lookupCache.size > 300) lookupCache.delete(lookupCache.keys().next().value);
}
function recall(key) {
  const hit = lookupCache.get(key);
  if (!hit) return null;
  lookupCache.delete(key);
  if (Date.now()-hit.at >= 30*60_000) return null;
  lookupCache.set(key,hit); return hit.value;
}

const pendingLookups = new Map();
async function lookup(word) {
  const key=String(word||'').normalize('NFC').trim().replace(/\s+/g,' ').toLowerCase();
  if(pendingLookups.has(key))return pendingLookups.get(key);
  if(pendingLookups.size>=8)return {error:{message:'Đang tra từ. Hãy thử lại.'}};
  const task=lookupOnce(word).finally(()=>pendingLookups.delete(key));
  pendingLookups.set(key,task);return task;
}
async function lookupOnce(word) {
  const gate = await validateSource(word);
  if (gate.error) return gate;
  const w = String(word || '').normalize('NFC').trim().replace(/\s+/g, ' ').slice(0, 80);
  if (!w || !/[a-z]/i.test(w)) return { error: { code: 'EMPTY', message: 'Hãy chọn một từ hoặc cụm từ tiếng Anh.' } };
  const key = `d:${w.toLowerCase()}`;
  const hit = recall(key);
  if (hit) return { data: hit };
  let res;
  try {
    res = await rawFetch(`${API}/dictionary/v2/lookup?word=${encodeURIComponent(w)}&mode=en-vi`, { method: 'GET', timeout: 12_000 });
  } catch {
    return apiError(0, null);
  }
  if (res.status === 404) return { error: { code: 'NOT_FOUND', status: 404, message: `Chưa có “${w}” trong từ điển English Coach.` } };
  const body = await safeJson(res);
  if (!res.ok || !body) return apiError(res.status, body);
  remember(key, body);
  return { data: body };
}

async function translate(text, signal) {
  const gate = await validateSource(text);
  if (gate.error) return gate;
  const t = String(text || '').normalize('NFC').trim().slice(0, 2000);
  if (!t) return { error: { code: 'EMPTY', message: 'Không có gì để dịch.' } };
  const key = `translate:v1:en:vi:${t}`;
  const hit = recall(key);
  if (hit) return { data: { translation: hit } };
  let res;
  try {
    res = await rawFetch(`${SITE}/api/translate?q=${encodeURIComponent(t)}&tl=vi`, { method: 'GET', signal, timeout: 12_000 });
  } catch {
    return apiError(0, null);
  }
  const body = await safeJson(res);
  if (!res.ok || !Array.isArray(body)) return { error: { code: 'TRANSLATE_UNAVAILABLE', status: res.status, message: 'Dịch nhanh đang bận. Hãy thử lại sau ít giây.' } };
  const out = (Array.isArray(body[0]) ? body[0] : []).map((p) => (Array.isArray(p) ? p[0] : '')).join('').trim();
  if (!out) return { error: { code: 'TRANSLATE_EMPTY', message: 'Không dịch được đoạn này.' } };
  remember(key, out);
  return { data: { translation: out } };
}

// ---------------------------------------------------------------- saving (Thẻ từ vựng)

async function savedList() {
  const auth = await getAuth();
  const key = accountKey(auth);
  const got = await local.get(key);
  return { key, items: Array.isArray(got[key]) ? got[key] : [] };
}

function safeSource(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    return `${u.origin}${u.pathname}`.slice(0, 300); // no query string, no fragment: they may carry private data
  } catch { return null; }
}

async function save(item) {
  const gate = await validateSource(item?.front);
  if (gate.error) return gate;
  if (item.example && (await validateSource(item.example)).error) item = { ...item, example: null };
  const front = String(item?.front || '').normalize('NFC').trim().replace(/\s+/g, ' ').slice(0, 255);
  if (!front || !/[a-z]/i.test(front)) return { error: { code: 'EMPTY', message: 'Hãy chọn từ hoặc cụm từ tiếng Anh để lưu.' } };
  const payload = {
    front,
    back: item.back ? String(item.back).slice(0, 2000) : null,
    example: item.example ? String(item.example).slice(0, 1000) : null,
    ipa: item.ipa ? String(item.ipa).slice(0, 120) : null,
    cefr: /^(A1|A2|B1|B2|C1|C2)$/.test(item.cefr || '') ? item.cefr : null,
  };
  const r = await api('/flashcards', { method: 'POST', body: JSON.stringify(payload) });
  if (r.error) return r;
  const created = r.headers?.get('X-Flashcard-Created') !== 'false';
  const cardId = r.data?.id ?? null;
  const { key, items } = await savedList();
  const now = Date.now();
  const existing = items.find((x) => (cardId != null && x.cardId === cardId) || x.front.toLowerCase() === front.toLowerCase());
  const entry = {
    id: existing?.id || `s${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    cardId,
    front,
    meaning: payload.back,
    example: payload.example,
    kind: item.kind || (front.includes(' ') ? (front.split(' ').length > 4 ? 'sentence' : 'phrase') : 'word'),
    sourceTitle: item.sourceTitle ? String(item.sourceTitle).slice(0, 160) : existing?.sourceTitle || null,
    sourceUrl: safeSource(item.sourceUrl) || existing?.sourceUrl || null,
    note: item.note != null ? String(item.note).slice(0, 1000) : existing?.note || '',
    savedAt: existing?.savedAt || now,
    syncedAt: now,
  };
  const next = [entry, ...items.filter((x) => x.id !== entry.id)].slice(0, SAVED_LIMIT);
  await local.set({ [key]: next });
  broadcast({ t: 'saved-changed' });
  return { data: { status: created ? 'created' : 'exists', cardId, entry } };
}

async function updateSaved(id, patch) {
  const { key, items } = await savedList();
  const next = items.map((x) => (x.id === id ? { ...x, note: String(patch.note ?? x.note).slice(0, 1000) } : x));
  await local.set({ [key]: next });
  broadcast({ t: 'saved-changed' });
  return { data: { ok: true } };
}

async function removeSaved(id, deleteCard) {
  const { key, items } = await savedList();
  const it = items.find((x) => x.id === id);
  if (deleteCard && it?.cardId != null) {
    const r = await api(`/flashcards/${encodeURIComponent(it.cardId)}`, { method: 'DELETE' });
    if (r.error && r.error.status !== 404) return r;
  }
  await local.set({ [key]: items.filter((x) => x.id !== id) });
  broadcast({ t: 'saved-changed' });
  return { data: { ok: true } };
}

// ---------------------------------------------------------------- Premium AI

async function ai(req) {
  const gate = await validateSource(req?.text);
  if (gate.error) return gate;
  if (req.context && (await validateSource(req.context)).error) req = { ...req, context: null };
  const allowed = ['explain', 'translate', 'ask', 'summarize', 'simplify', 'quiz', 'practice', 'examples'];
  if (!allowed.includes(req?.action)) return { error: { code: 'BAD_ACTION', message: 'Hành động không hợp lệ.' } };
  const body = {
    action: req.action,
    text: String(req.text || '').slice(0, req.action === 'summarize' || req.action === 'quiz' ? 12000 : 1500),
    context: req.context ? String(req.context).slice(0, 2000) : null,
    question: req.question ? String(req.question).slice(0, 500) : null,
    level: req.level || null,
    pageTitle: req.pageTitle ? String(req.pageTitle).slice(0, 200) : null,
    count: req.count || null,
  };
  const r = await api('/extension/ai', { method: 'POST', body: JSON.stringify(body), timeout: 60_000 });
  if (!r.error) await session.remove('me'); // the month's count changed
  return r;
}

// ---------------------------------------------------------------- content script activation

function siteAllowed(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return { ok: false, reason: 'restricted' };
    if (BLOCKED_HOSTS.includes(u.hostname)) return { ok: false, reason: 'own-site' };
    if (u.hostname === 'chromewebstore.google.com' || (u.hostname === 'microsoftedge.microsoft.com' && u.pathname.startsWith('/addons'))) return { ok: false, reason: 'restricted' };
    return { ok: true, host: u.hostname };
  } catch { return { ok: false, reason: 'restricted' }; }
}

async function ensureContent(tabId, frameId = 0) {
  const target = { tabId, frameIds: [frameId] };
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({ target, func: () => !!window.__echoAnywhere });
    if (result) return true;
    await chrome.scripting.executeScript({ target, files: ['content.js'] });
    return true;
  } catch {
    return false;
  }
}

async function invokeOnTab(tab, action, frameId) {
  if (!tab?.id) return { ok: false, reason: 'no-tab' };
  const allowed = siteAllowed(tab.url || '');
  if (!allowed.ok) return { ok: false, reason: allowed.reason };
  if (frameId == null) {
    // activeTab still controls frame access. Probe focus only, never frame content.
    const frames = await chrome.scripting.executeScript({target:{tabId:tab.id,allFrames:true},
      func: () => document.hasFocus() && !document.activeElement?.matches('iframe,frame')}).catch(() => []);
    frameId = frames.find(frame => frame.result)?.frameId ?? 0;
  }
  const ok = await ensureContent(tab.id, frameId);
  if (!ok) return { ok: false, reason: 'restricted' };
  try {
    const reply = await chrome.tabs.sendMessage(tab.id, { t: 'invoke', action }, { frameId });
    return { ok: !!reply?.ok };
  } catch {
    return { ok: false, reason: 'restricted' };
  }
}

/** Automatic selection bubble: registered only for the origins the learner granted (optional host permissions). */
let registration = Promise.resolve();
function syncAutoScripts() {
  registration = registration.catch(() => {}).then(updateRegistration);
  return registration;
}
async function updateRegistration() {
  const settings = await getSettings();
  const perms = await chrome.permissions.getAll();
  const siteHost = new URL(SITE).hostname;
  const origins = (perms.origins || []).filter((o) => { try { return !new URL(o.replace('*.', '').replace('/*', '/')).hostname.endsWith(siteHost); } catch { return true; } });
  const existing = await chrome.scripting.getRegisteredContentScripts({ids:['echo-auto']});
  if (!settings.autoBubble || !origins.length) {
    if (existing.length) await chrome.scripting.unregisterContentScripts({ids:['echo-auto']});
    return;
  }
  const script = {
    id: 'echo-auto',
    js: ['content.js'],
    matches: origins,
    excludeMatches: [`${SITE}/*`, 'https://www.englishcoach.io.vn/*'],
    runAt: 'document_idle',
    allFrames: true,
    persistAcrossSessions: true,
  };
  if (existing.length) await chrome.scripting.updateContentScripts([script]);
  else await chrome.scripting.registerContentScripts([script]);
}

async function pageText(tabId) {
  const ok = await ensureContent(tabId);
  if (!ok) return { error: { code: 'NO_ACCESS', message: 'Echo chưa được phép đọc trang này. Hãy bấm biểu tượng Echo trên trang, hoặc dán đoạn văn vào ô bên dưới.' } };
  try {
    const r = await chrome.tabs.sendMessage(tabId, { t: 'extract' }, { frameId: 0 });
    return r?.data || r?.error ? r : { error: { code: 'NO_TEXT', message: 'Không tìm thấy đoạn văn tiếng Anh đủ dài trên trang này.' } };
  } catch {
    return { error: { code: 'NO_ACCESS', message: 'Không đọc được trang này (trang được trình duyệt bảo vệ).' } };
  }
}

// ---------------------------------------------------------------- messaging

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

const mediaRequests = new Map();
const pendingAi = new Map();
let progressUpdate = Promise.resolve();
const handlers = {
  'media:translate': (m,sender) => {
    const key=sender.documentId;
    const text=String(m.text||'').normalize('NFC').trim().replace(/\s+/g,' ');
    const previous=mediaRequests.get(key);
    if(previous?.text===text)return previous.result;
    previous?.controller.abort();
    const controller=new AbortController();
    const result=translate(text,controller.signal).finally(()=>{if(mediaRequests.get(key)?.controller===controller)mediaRequests.delete(key);});
    mediaRequests.set(key,{controller,text,result});return result;
  },
  'media:cancel': (_,sender) => {mediaRequests.get(sender.documentId)?.controller.abort();mediaRequests.delete(sender.documentId);return {ok:true};},
  'media:progress': m => {
    progressUpdate=progressUpdate.catch(()=>{}).then(async()=>{
      const key='media-practice:'+accountKey(await getAuth());
      const stats=(await local.get(key))[key]||{total:0,correct:0};
      stats.total++;if(m.correct===true)stats.correct++;
      await local.set({[key]:stats});return {data:stats};
    });return progressUpdate;
  },
  'consent:scope': consentScope,
  'consent:check': m => consentGrant(m,false),
  'consent:remember': m => consentGrant(m,true),
  'consent:clear': async () => {
    await clearSharing();
    return {ok:true};
  },
  'language:check': m => validateSource(m.text),
  state: () => state(),
  'settings:get': async (m, sender) => {
    const settings = await getSettings();
    const auth = await getAuth();
    let host = '';
    try { host = new URL(sender.url || sender.tab?.url).hostname; } catch { /* none */ }
    return { data: { ...settings, connected: !!auth, siteDisabled: settings.disabledSites.includes(host),
      private: privatePage(sender.url || sender.tab?.url) } };
  },
  connect: () => startConnect(),
  disconnect: () => disconnect(),
  lookup: (m) => lookup(m.word),
  translate: (m) => translate(m.text),
  save: (m, sender) => {
    const omitSource = m.item?.omitSource || privatePage(m.item?.sourceUrl ?? sender.tab?.url);
    return save({ ...m.item, sourceUrl: omitSource ? null : m.item?.sourceUrl ?? sender.tab?.url,
      sourceTitle: omitSource ? null : m.item?.sourceTitle ?? sender.tab?.title });
  },
  'saved:list': async () => ({ data: (await savedList()).items }),
  'saved:practice': async () => {
    const cards = [];
    for (const item of (await savedList()).items) {
      if (item.meaning && (await validateSource(item.front)).data) cards.push(item);
      if (cards.length === 24) break;
    }
    return { data: cards };
  },
  'saved:update': (m) => updateSaved(m.id, m.patch || {}),
  'saved:remove': (m) => removeSaved(m.id, !!m.deleteCard),
  ai: async m => {
    const auth=await getAuth();
    const key=JSON.stringify([auth?.account?.id,m.req]);
    if(pendingAi.has(key))return pendingAi.get(key);
    if(pendingAi.size>=2)return {error:{code:'BUSY',message:'Hãy chờ yêu cầu Echo AI đang chạy.'}};
    const request=ai(m.req).finally(()=>pendingAi.delete(key));pendingAi.set(key,request);return request;
  },
  settings: async (m) => {
    const next = await patchSettings(m.patch || {});
    await syncAutoScripts();
    return { data: next };
  },
  'sync-auto': async () => { await syncAutoScripts(); return { ok: true }; },
  privacy: (m) => ({ private: privatePage(m.url) }),
  cosmos: async (m) => {
    if (m.word) {
      const gate = await validateSource(m.word);
      if (gate.error) return gate;
    }
    const w = String(m.word || '').trim().toLowerCase().slice(0, 80);
    await chrome.tabs.create({ url: `${SITE}/knowledge-universe${w ? `?word=${encodeURIComponent(w)}` : ''}` });
    return { ok: true };
  },
  open: async (m) => {
    const path = String(m.path || '/');
    if (!path.startsWith('/')) return { ok: false };
    await chrome.tabs.create({ url: `${SITE}${path}` });
    return { ok: true };
  },
  // From a click in a page: open in the same task as the message (the browser carries the click's gesture there).
  'panel:open': async (m, sender) => {
    const windowId = sender.tab?.windowId;
    if (windowId == null) return { ok: false };
    const opening = chrome.sidePanel?.open?.({ windowId }).then(() => true, () => false);
    if (m.payload) await handlers['handoff:set']({ windowId, payload: m.payload.tab==='media'?{...m.payload,tabId:sender.tab.id}:m.payload });
    if (!await opening) await chrome.tabs.create({ windowId, url: chrome.runtime.getURL('sidepanel.html') });
    return { ok: true };
  },
  'handoff:set': async (m) => {
    if (!Number.isInteger(m.windowId)) return { ok: false };
    if (m.payload) await session.set({ [`handoff:${m.windowId}`]: { ...m.payload, at: Date.now() } });
    broadcast({ t: 'handoff-ready', windowId: m.windowId });
    return { ok: true };
  },
  'panel:handoff': async (m) => {
    if (!Number.isInteger(m.windowId)) return { data: null };
    const key = `handoff:${m.windowId}`;
    const { [key]: handoff } = await session.get(key);
    if (handoff) await session.remove(key);
    return { data: handoff && Date.now() - handoff.at < 120_000 ? handoff : null };
  },
  'tab:invoke': async (m) => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return invokeOnTab(tab, m.action);
  },
  'media:attach': async m => {
    const tab = Number.isInteger(m.tabId) ? await chrome.tabs.get(m.tabId) : (await chrome.tabs.query({active:true,currentWindow:true}))[0];
    if (!tab?.id || !siteAllowed(tab.url).ok) return {error:{message:'Trên trang này, hãy tự dán phụ đề hoặc trích đoạn được phép sử dụng.'}};
    const candidates = await chrome.scripting.executeScript({target:{tabId:tab.id,allFrames:true},func:()=>{
      if (Array.from(location.ancestorOrigins).some(o=>o!==location.origin)) return false;
      return !!document.querySelector('video,audio');
    }}).catch(()=>[]);
    const frame = candidates.find(f=>f.result);
    if (!frame || !await ensureContent(tab.id,frame.frameId)) return {error:{message:'Không truy cập được trình phát. Bạn có thể dùng tệp hoặc văn bản của mình.'}};
    await chrome.scripting.executeScript({target:{tabId:tab.id,documentIds:[frame.documentId]},files:['media-adapters.js','media-overlay.js','media-bridge.js']});
    return {data:{tabId:tab.id,documentId:frame.documentId}};
  },
  'media:selection': async m => {
    const tab=Number.isInteger(m.tabId)?await chrome.tabs.get(m.tabId):(await chrome.tabs.query({active:true,currentWindow:true}))[0];
    if(!tab?.id || !siteAllowed(tab.url).ok || /(^|\.)(spotify\.com|soundcloud\.com)$/.test(new URL(tab.url).hostname))
      return {error:{message:'Hãy tự dán một trích đoạn bạn có quyền sử dụng.'}};
    if(!await ensureContent(tab.id))return {error:{message:'Chưa có quyền đọc phần đã chọn.'}};
    return chrome.tabs.sendMessage(tab.id,{t:'media:selection'},{frameId:0});
  },
  'tab:text': async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return { error: { code: 'NO_TAB', message: 'Không có tab nào đang mở.' } };
    const allowed = siteAllowed(tab.url || '');
    if (!allowed.ok) {
      return { error: { code: allowed.reason === 'own-site' ? 'OWN_SITE' : 'RESTRICTED',
        message: allowed.reason === 'own-site' ? 'Trên English Coach, hãy dùng các công cụ có sẵn của trang.' : 'Trình duyệt không cho tiện ích đọc trang này.' } };
    }
    return pageText(tab.id);
  },
  'tab:info': async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const allowed = siteAllowed(tab?.url || '');
    const origin = allowed.ok ? new URL(tab.url).origin : null;
    const granted = origin ? await chrome.permissions.contains({ origins: [`${origin}/*`] }) : false;
    const isPrivate = privatePage(tab?.url);
    return { data: { tabId:tab?.id, url: isPrivate ? null : safeSource(tab.url), title: isPrivate ? '' : tab?.title || '', private: isPrivate,
      origin, host: allowed.host || null, allowed: allowed.ok, reason: allowed.reason || null, granted } };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !msg || typeof msg.t !== 'string' || !handlers[msg.t]) return false;
  Promise.resolve(handlers[msg.t](msg, sender))
    .then((r) => sendResponse(r))
    .catch(() => sendResponse({ error: { code: 'INTERNAL', message: 'Echo gặp lỗi không mong muốn. Hãy thử lại.' } }));
  return true;
});

// The English Coach website (and only it) may: learn that Echo Anywhere is installed, and hand over a pairing code.
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  let origin = null;
  try { origin = new URL(sender.url || sender.origin || '').origin; } catch { /* refused below */ }
  if (origin !== SITE || !msg || typeof msg.t !== 'string') return false;
  if (msg.t === 'echo-anywhere:ping') {
    getAuth().then((a) => sendResponse({ installed: true, version: VERSION, connected: !!a }));
    return true;
  }
  if (msg.t === 'echo-anywhere:pair' && typeof msg.code === 'string' && typeof msg.state === 'string') {
    finishConnect(msg.code.slice(0, 200), msg.state.slice(0, 100)).then(sendResponse);
    return true;
  }
  return false;
});

// ---------------------------------------------------------------- browser entry points

chrome.runtime.onInstalled.addListener(async (details) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'echo-lookup', title: 'Echo: Tra nghĩa “%s”', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'echo-translate', title: 'Echo: Dịch đoạn đã chọn', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'echo-save', title: 'Echo: Lưu vào Thẻ từ vựng', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'echo-read', title: 'Echo: Đọc tập trung trang này', contexts: ['page'] });
  });
  try { await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }); } catch { /* popup stays the action */ }
  if (details.reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
  await syncAutoScripts();
});

chrome.runtime.onStartup.addListener(() => { syncAutoScripts().catch(() => {}); });
chrome.permissions.onAdded.addListener(() => { syncAutoScripts().catch(() => {}); });
chrome.permissions.onRemoved.addListener(() => { syncAutoScripts().catch(() => {}); });

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const action = { 'echo-lookup': 'lookup', 'echo-translate': 'translate', 'echo-save': 'save', 'echo-read': 'read' }[info.menuItemId];
  if (action && !info.editable) invokeOnTab(tab, action, info.frameId ?? 0);
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'echo-lookup') return;
  const target = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  invokeOnTab(target, 'toolbar');
});
