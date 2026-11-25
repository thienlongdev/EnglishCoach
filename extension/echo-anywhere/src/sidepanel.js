import { send, h, icon, skeleton, speak, errorView, dictionaryView, aiView, freeExercises, quizView, relTime, enhance, tabIndicator, celebrate, show } from './ui.js';

import { allowShare } from './consent-ui.js';

enhance();

let st = null; // extension state (account, Premium, level)
const $ = (id) => document.getElementById(id);
const isWordish = (t) => t.trim().split(/\s+/).length <= 4 && t.trim().length <= 60;

// ---------------------------------------------------------------- tabs (WAI-ARIA)
const TABS = ['lookup', 'explore', 'practice', 'media', 'saved'];
let moveIndicator = () => {};
let mediaTabId, mediaClose, mediaEpoch=0;
function select(name) {
  const epoch=++mediaEpoch;
  mediaClose?.(); mediaClose=null;
  if (name==='media') import('./media-panel.js').then(({mountMedia})=>{
    if (epoch===mediaEpoch) mediaClose=mountMedia($('p-media'),mediaTabId,()=>st);
  });
  for (const t of TABS) {
    const on = t === name;
    $(`t-${t}`).setAttribute('aria-selected', String(on));
    $(`t-${t}`).tabIndex = on ? 0 : -1;
    $(`p-${t}`).hidden = !on;
  }
  moveIndicator();
  if (name === 'saved') renderSaved();
  if (name === 'explore') renderExplore();
}
moveIndicator = tabIndicator(document.querySelector('.tabs'));
TABS.forEach((t, i) => {
  const b = $(`t-${t}`);
  b.addEventListener('click', () => select(t));
  b.addEventListener('keydown', (e) => {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    const next = TABS[(i + d + TABS.length) % TABS.length];
    select(next);
    $(`t-${next}`).focus();
  });
});

// ---------------------------------------------------------------- account
async function refreshState() {
  const previous=st;st = await send({ t: 'state' });
  if(previous && previous.account?.id!==st.account?.id && !$('p-media').hidden)select('media');
  syncAiLocks();
  const box = $('acct');
  box.replaceChildren();
  if (!st?.connected) {
    box.append(h('span', { class: 'chip', text: 'Chưa kết nối tài khoản' }),
      h('button', { onclick: () => send({ t: 'connect' }) }, 'Kết nối'));
  } else {
    box.append(h('span', { class: 'chip', text: st.account?.displayName || 'Đã kết nối' }));
    box.append(st.premium ? h('span', { class: 'chip gold', text: 'Premium' }) : h('span', { class: 'chip', text: 'Miễn phí' }));
    if (st.premium && st.ai) box.append(h('span', { class: 'chip', text: `AI tháng này: ${st.ai.remaining}/${st.ai.limit}` }));
    if (st.level) box.append(h('span', { class: 'chip', text: `Trình độ ${st.level}` }));
  }
}

/** A Premium AI button: shows its lock to free accounts and explains instead of calling. */
// The account state arrives after the panel is drawn and can change (connect, switch, expiry): a button decides at
// click time and its lock badge follows the state (syncAiLocks).
function aiButton(label, iconName, run) {
  const lock = icon('lock', 'i lock');
  const btn = h('button', { class: 'btn pro', 'data-ai': '', onclick: () => {
    if (!st?.connected) return run({ error: { code: 'NOT_CONNECTED', message: 'Hãy kết nối tài khoản English Coach để dùng Echo AI.' } });
    if (!st?.premium) return run({ error: { code: 'PREMIUM_REQUIRED', message: 'Đây là tính năng AI dành cho Premium.' } });
    return run();
  } }, icon(iconName), label, lock);
  syncAiLock(btn);
  return btn;
}
function syncAiLock(btn) {
  const locked = !st?.premium;
  btn.title = locked ? 'Tính năng Premium AI' : 'Echo AI (Premium)';
  const lock = btn.querySelector('.lock');
  if (lock) lock.style.display = locked ? '' : 'none';
}
const syncAiLocks = () => document.querySelectorAll('[data-ai]').forEach(syncAiLock);

// ---------------------------------------------------------------- Tra nghĩa
const lookupPanel = $('p-lookup');
const lookupInput = h('input', { type: 'search', placeholder: 'Nhập từ, cụm từ hoặc câu tiếng Anh…', 'aria-label': 'Từ hoặc câu cần tra', maxlength: '1500' });
const lookupOut = h('div', { class: 'stack', 'aria-live': 'polite' });
let lookupCtx = { text: '', context: '', private: false };
let privatePractice = false;
async function english(text, out) {
  const gate = await send({ t: 'language:check', text });
  if (gate?.data?.english) return true;
  out.replaceChildren(errorView(gate?.error));
  return false;
}
lookupPanel.append(
  h('form', { class: 'row', onsubmit: async (e) => { e.preventDefault();
    if (await allowShare(lookupCtx.private, lookupInput.value,'lexical', 'English Coach để tra hoặc dịch')) doLookup(lookupInput.value, '', lookupCtx.private);
  } },
    h('div', { class: 'grow' }, lookupInput), h('button', { class: 'btn primary', type: 'submit' }, icon('search'), 'Tra')),
  h('p', { class: 'muted small', text: 'Bấm Tra để gửi phần văn bản bạn nhập tới English Coach. Câu hoặc đoạn văn được gửi tới dịch vụ dịch máy.' }), lookupOut);
renderLookupEmpty();

function renderLookupEmpty() {
  show(lookupOut, h('div', { class: 'card stack' },
    h('div', { class: 'empty' }, h('img', { src: 'icons/echo-256.webp', alt: '' })),
    h('h2', { text: 'Bắt đầu' }),
    h('p', { class: 'muted', text: 'Bôi đen chữ tiếng Anh trên bất kỳ trang nào rồi bấm biểu tượng Echo, chuột phải → “Echo: Tra nghĩa”, hoặc nhấn Alt+Shift+E.' }),
    h('div', { class: 'row' }, ...['take off', 'break the ice', 'deprecated', 'nevertheless'].map((w) => h('button', { class: 'btn ghost', onclick: () => { lookupInput.value = w; doLookup(w, ''); } }, w)))));
}

async function doLookup(raw, context, privateSource = false) {
  const text = String(raw || '').trim();
  if (!text) return;
  lookupCtx = { text, context: privateSource ? '' : context || '', private: privateSource };
  const request = lookupCtx;
  lookupOut.replaceChildren(...skeleton(4));
  if (!await english(text, lookupOut) || request !== lookupCtx) return;
  const card = h('div', { class: 'card stack' });
  if (isWordish(text)) {
    const r = await send({ t: 'lookup', word: text });
    if (r?.data) card.append(dictionaryView(r.data, text));
    else if (r?.error?.code === 'NOT_FOUND') card.append(h('p', { class: 'muted', text: r.error.message }), await translationBlock(text));
    else card.append(errorView(r?.error, () => doLookup(text, context, privateSource)));
  } else {
    card.append(h('p', { class: 'general', text }), await translationBlock(text));
  }
  if (context && context.toLowerCase() !== text.toLowerCase()) {
    const ctx = h('div', { class: 'ctx' }, h('div', { class: 'muted small', text: 'Câu chứa từ' }), h('div', { text: context }));
    card.append(ctx);
  }
  const ai = h('div', { class: 'stack' });
  const run = (req) => async (pre) => {
    if (pre?.error) { ai.replaceChildren(errorView(pre.error)); return; }
    if (!await allowShare(privateSource,text,'ai','English Coach và nhà cung cấp Echo AI')) return;
    ai.replaceChildren(h('p', { class: 'muted', text: 'Echo AI đang phân tích…' }), ...skeleton(3));
    const r = await send({ t: 'ai', req });
    show(ai, r?.data ? aiView(r.data) : errorView(r?.error, () => run(req)()));
    if (r?.data) refreshState();
  };
  const base = { text, context: lookupCtx.context || null };
  if (request !== lookupCtx) return;
  show(lookupOut, card,
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: (e) => saveCurrent(e.currentTarget) }, icon('save'), 'Lưu Flashcard'),
      h('button', { class: 'btn', onclick: () => speak(text, privateSource) }, icon('sound'), 'Nghe'),
      h('button', { class: 'btn', onclick: async () => { if (await allowShare(privateSource,text,'cosmos', 'Vũ trụ tri thức trên English Coach')) send({ t: 'cosmos', word: isWordish(text) ? text.split(/\s+/)[0] : '' }); } }, icon('stars'), 'Vũ trụ tri thức'),
      h('button', { class: 'btn', onclick: () => { privatePractice = privateSource; practiceSource.value = context || text; select('practice'); } }, icon('target'), 'Luyện tập')),
    h('div', { class: 'card stack' },
      h('div', { class: 'row' }, h('h2', { class: 'grow', text: 'Echo AI' }), h('span', { class: 'chip gold', text: 'Premium' })),
      h('div', { class: 'ai-row' },
        aiButton('Giải thích sâu', 'bulb', run({ action: 'explain', ...base })),
        aiButton('Dịch theo ngữ cảnh', 'globe', run({ action: 'translate', ...base })),
        aiButton('Ví dụ khác', 'book', run({ action: 'examples', ...base })),
        aiButton('Viết đơn giản hơn', 'read', run({ action: 'simplify', ...base }))),
      askBox(base, ai, privateSource),
      ai));
}

function askBox(base, out, privateSource) {
  const q = h('input', { type: 'text', placeholder: 'Hỏi Echo về đoạn này… (ví dụ: giải thích cho trình độ A2)', 'aria-label': 'Câu hỏi cho Echo AI', maxlength: '500' });
  return h('form', { class: 'row', onsubmit: async (e) => {
    e.preventDefault();
    const question = q.value.trim();
    if (!question) return;
    if (!await allowShare(privateSource,base.text + '\n' + question,'ai', 'English Coach và nhà cung cấp Echo AI')) return;
    if (!st?.connected) { out.replaceChildren(errorView({ code: 'NOT_CONNECTED', message: 'Hãy kết nối tài khoản để hỏi Echo.' })); return; }
    if (!st?.premium) { out.replaceChildren(errorView({ code: 'PREMIUM_REQUIRED', message: 'Hỏi Echo AI là tính năng Premium.' })); return; }
    out.replaceChildren(h('p', { class: 'muted', text: 'Echo đang trả lời…' }), ...skeleton(2));
    const r = await send({ t: 'ai', req: { action: 'ask', ...base, question } });
    out.replaceChildren(r?.data ? aiView(r.data) : errorView(r?.error));
  } }, h('div', { class: 'grow' }, q), h('button', { class: 'btn', type: 'submit' }, icon('chat'), 'Hỏi'));
}

async function translationBlock(text) {
  const r = await send({ t: 'translate', text });
  if (!r?.data) return h('p', { class: 'error', text: r?.error?.message || 'Không dịch được.' });
  return h('div', {}, h('h3', { text: 'Dịch nhanh (miễn phí)' }), h('p', { class: 'general', text: r.data.translation }),
    h('p', { class: 'muted small', text: 'Dịch máy, có thể chưa đúng sắc thái. “Dịch theo ngữ cảnh” dùng Echo AI.' }));
}

async function saveCurrent(btn) {
  const { text, context, private: privateSource } = lookupCtx;
  if (!text) return;
  if (!await allowShare(privateSource,text,'save','English Coach để tra nghĩa và lưu Flashcard')) return;
  btn.disabled = true;
  let meaning = null, ipa = null, cefr = null, front = text;
  if (isWordish(text)) {
    const r = await send({ t: 'lookup', word: text });
    if (r?.data) { front = r.data.headword || text; meaning = r.data.generalTranslationVi || r.data.vietnameseSenses?.[0]?.meanings?.[0] || null; ipa = r.data.pronunciations?.[0]?.ipa || null; cefr = r.data.cefr || null; }
  }
  if (!meaning) meaning = (await send({ t: 'translate', text }))?.data?.translation || null;
  const tab = (await send({ t: 'tab:info' }))?.data;
  const r = await send({ t: 'save', item: { front, back: meaning, example: context && context.length <= 1000 ? context : null, ipa, cefr, sourceUrl: tab?.url, sourceTitle: tab?.title, omitSource: privateSource } });
  btn.disabled = false;
  const msg = r?.data ? (r.data.status === 'exists' ? 'Đã có trong Thẻ từ vựng — không tạo thẻ trùng.' : 'Đã lưu vào Thẻ từ vựng.') : r?.error?.message;
  if (r?.data && r.data.status !== 'exists') celebrate(btn);
  btn.after(h('p', { class: r?.data ? 'note' : 'error', role: 'status', text: msg }));
  if (r?.error && (r.error.code === 'NOT_CONNECTED' || r.error.status === 401)) btn.after(errorView(r.error));
}

// ---------------------------------------------------------------- Khám phá
const explore = $('p-explore');
let lastPage = null;
async function renderExplore() {
  explore.replaceChildren(...skeleton(3));
  const info = (await send({ t: 'tab:info' }))?.data;
  const head = h('div', { class: 'card stack' }, h('h2', { text: 'Trang hiện tại' }), h('p', { class: 'muted', text: info?.title || '—' }));
  explore.replaceChildren(head);
  if (info?.private && info.allowed) {
    head.append(h('p', { class: 'note', text: 'Trên trang có hội thoại, hãy chọn đoạn cần học hoặc tự dán văn bản.' }));
    explore.append(pasteBox());
    return;
  }
  if (!info?.allowed) {
    head.append(h('p', { class: 'note', text: info?.reason === 'own-site' ? 'Đây là English Coach: hãy dùng công cụ có sẵn của trang (Ctrl K để tra từ).' : 'Trình duyệt không cho tiện ích đọc trang này (trang hệ thống, cửa hàng tiện ích hoặc PDF). Bạn có thể dán đoạn văn bên dưới.' }));
    explore.append(pasteBox());
    return;
  }
  head.append(h('div', { class: 'row' },
    h('button', { class: 'btn primary', onclick: analyse }, icon('read'), 'Phân tích trang này'),
    h('button', { class: 'btn', onclick: () => send({ t: 'tab:invoke', action: 'read' }) }, 'Đọc tập trung')),
  h('p', { class: 'muted small', text: 'Echo đọc bài trên máy của bạn khi bạn bấm. Chỉ khi bạn chọn tính năng AI, phần văn bản mới được gửi tới English Coach.' }));
  if (lastPage) showPage(lastPage);
  explore.append(pasteBox());
}

function pasteBox() {
  const ta = h('textarea', { placeholder: 'Hoặc dán một đoạn tiếng Anh (tối đa 12.000 ký tự)…', 'aria-label': 'Đoạn văn tiếng Anh', maxlength: '12000' });
  return h('div', { class: 'card stack' }, h('h2', { text: 'Dán văn bản' }), h('p', { class: 'muted small', text: 'Nếu phụ đề chỉ là hình ảnh hoặc trang chặn chọn chữ, hãy nhập hoặc dán văn bản. Echo không đọc chữ từ video.' }), ta,
    h('button', { class: 'btn', onclick: () => { const t = ta.value.trim(); if (t) { lastPage = { title: 'Đoạn văn đã dán', text: t, blocks: [] }; showPage(lastPage); } } }, 'Phân tích đoạn này'));
}

async function analyse() {
  const r = await send({ t: 'tab:text' });
  if (!r?.data) { explore.append(h('div', { class: 'card' }, errorView(r?.error))); return; }
  lastPage = r.data;
  showPage(lastPage);
}

function level(text) {
  const words = text.match(/[A-Za-z][A-Za-z'-]*/g) || [];
  const sentences = Math.max(1, (text.match(/[.!?](\s|$)/g) || []).length);
  if (words.length < 80) return null;
  const score = words.length / sentences / 25 + (words.filter((w) => w.length >= 9).length / words.length) * 3;
  return score < 0.75 ? 'Dễ đọc' : score < 1.15 ? 'Vừa sức' : 'Khá khó';
}

async function showPage(page) {
  explore.querySelector('[data-page]')?.remove();
  const text = page.text || '';
  const status = h('div', { role: 'status', 'data-page': '' });
  explore.append(status);
  if (!await english(text, status)) return;
  status.remove();
  const words = (text.match(/[A-Za-z][A-Za-z'-]*/g) || []).length;
  const lvl = level(text);
  const box = h('div', { class: 'card stack', 'data-page': '' },
    h('h2', { text: page.title || 'Bài đọc' }),
    h('div', { class: 'row' }, h('span', { class: 'chip', text: `${words.toLocaleString('vi-VN')} từ` }),
      h('span', { class: 'chip', text: `~${Math.max(1, Math.round(words / 200))} phút đọc` }), lvl ? h('span', { class: 'chip', text: `${lvl} (ước lượng)` }) : null));
  if (page.latinShare != null && page.latinShare < 0.6) box.append(h('p', { class: 'note', text: 'Trang này có vẻ không phải tiếng Anh; kết quả có thể không hữu ích.' }));
  const sendable = text.slice(0, 12000);
  const out = h('div', { class: 'stack' });
  const disclosure = h('p', { class: 'muted small', text: `Khi bấm một nút AI, ${sendable.length.toLocaleString('vi-VN')} ký tự đầu của bài${text.length > 12000 ? ' (bài dài hơn được cắt bớt)' : ''} sẽ được gửi tới Echo AI. Không gửi gì khác.` });
  const count = { v: 3 };
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Số câu hỏi' }, ...[3, 5].map((n) => h('button', { type: 'button', 'aria-pressed': String(n === 3), onclick: (e) => { count.v = n; seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget))); } }, `${n} câu`)));
  const run = (action) => async (pre) => {
    if (pre?.error) { out.replaceChildren(errorView(pre.error)); return; }
    if (sendable.length < 200) { out.replaceChildren(h('p', { class: 'error', text: 'Bài quá ngắn để phân tích bằng AI.' })); return; }
    out.replaceChildren(h('p', { class: 'muted', text: 'Echo AI đang đọc bài…' }), ...skeleton(4));
    const r = await send({ t: 'ai', req: { action, text: sendable, pageTitle: page.title, count: count.v } });
    if (!r?.data) { out.replaceChildren(errorView(r?.error, () => run(action)())); return; }
    show(out, action === 'quiz' ? quizView(r.data.questions, { note: 'Câu hỏi do Echo AI tạo; mỗi đáp án kèm trích dẫn từ bài. Không tính vào bài thi hay bảng xếp hạng.' }) : aiView(r.data));
    refreshState();
  };
  box.append(h('div', { class: 'row' }, h('h3', { class: 'grow', text: 'Echo AI' }), h('span', { class: 'chip gold', text: 'Premium' })),
    h('div', { class: 'row' }, aiButton('Tóm tắt và từ vựng chính', 'bulb', run('summarize')), aiButton('Quiz từ bài', 'target', run('quiz')), seg),
    disclosure, out,
    h('button', { class: 'btn ghost', onclick: () => { practiceSource.value = text.slice(0, 4000); select('practice'); } }, icon('target'), 'Luyện tập miễn phí với bài này'));
  explore.insertBefore(box, explore.children[1] || null);
}

// ---------------------------------------------------------------- Luyện tập
const practice = $('p-practice');
const practiceSource = h('textarea', { 'aria-label': 'Đoạn văn để luyện tập', placeholder: 'Chọn chữ trên trang và bấm “Luyện tập”, hoặc dán đoạn tiếng Anh ở đây…', maxlength: '4000' });
const practiceOut = h('div', { class: 'stack', 'aria-live': 'polite' });
let practiceCount = 3;
const countSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Số câu' }, ...[1, 3, 5].map((n) => h('button', { type: 'button', 'aria-pressed': String(n === 3), onclick: (e) => { practiceCount = n; countSeg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget))); } }, `${n}`)));
practice.append(h('div', { class: 'card stack' },
  h('h2', { text: 'Luyện tập với chữ bạn gặp' }), practiceSource,
  h('div', { class: 'row' }, h('span', { class: 'muted', text: 'Số câu' }), countSeg),
  h('div', { class: 'row' },
    h('button', { class: 'btn primary', onclick: freePractice }, icon('target'), 'Bài tập cơ bản (miễn phí)'),
    aiButton('Bài tập AI', 'bulb', aiPractice)),
  h('p', { class: 'muted small', text: 'Bài tập cơ bản lấy đáp án trực tiếp từ đoạn văn và thẻ bạn đã lưu, nên chấm chính xác. Kết quả chỉ để luyện tập, không vào điểm thi hay bảng xếp hạng.' })),
practiceOut);

async function freePractice() {
  const text = practiceSource.value.trim();
  if (text && !await english(text, practiceOut)) return;
  const saved = (await send({ t: 'saved:practice' }))?.data || [];
  if (text.length < 30 && saved.length < 4) { practiceOut.replaceChildren(h('p', { class: 'error', text: 'Hãy đưa vào ít nhất một câu tiếng Anh hoàn chỉnh.' })); return; }
  const qs = freeExercises(text, practiceCount, saved);
  if (!qs.length) { practiceOut.replaceChildren(h('p', { class: 'note', text: 'Đoạn này chưa đủ để tạo câu hỏi chắc chắn đúng. Hãy thêm vài câu nữa, hoặc dùng Bài tập AI.' })); return; }
  show(practiceOut, quizView(qs, { note: qs.length < practiceCount ? `Echo chỉ tạo được ${qs.length} câu chắc chắn đúng từ đoạn này.` : '' }));
}

async function aiPractice(pre) {
  const text = practiceSource.value.trim();
  if (!await english(text, practiceOut)) return;
  if (pre?.error) { practiceOut.replaceChildren(errorView(pre.error)); return; }
  if (!await allowShare(privatePractice,text,'ai', 'English Coach và nhà cung cấp Echo AI')) return;
  if (text.length < 2) { practiceOut.replaceChildren(h('p', { class: 'error', text: 'Hãy đưa vào đoạn tiếng Anh trước.' })); return; }
  practiceOut.replaceChildren(h('p', { class: 'muted', text: 'Echo AI đang soạn bài tập…' }), ...skeleton(3));
  const r = await send({ t: 'ai', req: { action: 'practice', text: text.slice(0, 1500), count: practiceCount } });
  if (!r?.data) { practiceOut.replaceChildren(errorView(r?.error, () => aiPractice())); return; }
  show(practiceOut, quizView(r.data.questions, { note: `Câu hỏi do Echo AI tạo, đã kiểm tra trích dẫn trong đoạn văn${r.data.dropped ? `; ${r.data.dropped} câu không chắc chắn đã bị loại` : ''}.` }));
  refreshState();
}

// ---------------------------------------------------------------- Đã lưu
const savedPanel = $('p-saved');
const savedSearch = h('input', { type: 'search', placeholder: 'Tìm trong mục đã lưu…', 'aria-label': 'Tìm trong mục đã lưu' });
let savedKind = 'all';
const kindSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Lọc theo loại' }, ...[['all', 'Tất cả'], ['word', 'Từ'], ['phrase', 'Cụm từ'], ['sentence', 'Câu']].map(([k, l]) =>
  h('button', { type: 'button', 'aria-pressed': String(k === 'all'), onclick: (e) => { savedKind = k; kindSeg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget))); renderSaved(); } }, l)));
const savedList = h('div', { class: 'stack', 'aria-live': 'polite' });
savedSearch.addEventListener('input', () => renderSaved());
savedPanel.append(savedSearch, kindSeg, savedList,
  h('p', { class: 'muted small', text: 'Thẻ được lưu vào tài khoản English Coach (Thẻ từ vựng). Ghi chú và nguồn trang được giữ trên trình duyệt này.' }),
  h('button', { class: 'btn ghost', onclick: () => send({ t: 'open', path: '/?tab=flashcards' }) }, 'Mở Thẻ từ vựng trên English Coach'));

async function renderSaved() {
  const items = (await send({ t: 'saved:list' }))?.data || [];
  const q = savedSearch.value.trim().toLowerCase();
  const shown = items.filter((x) => (savedKind === 'all' || x.kind === savedKind) && (!q || `${x.front} ${x.meaning || ''} ${x.note || ''}`.toLowerCase().includes(q)));
  if (!st?.connected && !items.length) { savedList.replaceChildren(errorView({ code: 'NOT_CONNECTED', message: 'Kết nối tài khoản để lưu từ vào Thẻ từ vựng.' })); return; }
  if (!shown.length) { show(savedList, h('div', { class: 'card empty' }, h('img', { src: 'icons/echo-256.webp', alt: '' }), h('p', { class: 'muted', text: items.length ? 'Không có mục nào khớp.' : 'Chưa có gì. Bôi đen chữ trên trang và bấm “Lưu Flashcard”.' }))); return; }
  show(savedList, ...shown.slice(0, 200).map(itemView));
}

function itemView(x) {
  const note = h('textarea', { 'aria-label': `Ghi chú cho ${x.front}`, maxlength: '1000', style: 'min-height:54px' });
  note.value = x.note || '';
  let t = 0;
  note.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => send({ t: 'saved:update', id: x.id, patch: { note: note.value } }), 500); });
  const confirmRow = h('div', { class: 'row', hidden: true },
    h('span', { class: 'muted grow', text: 'Xóa thẻ này khỏi Thẻ từ vựng của tài khoản? (không hoàn tác được)' }),
    h('button', { class: 'btn', onclick: async () => { const r = await send({ t: 'saved:remove', id: x.id, deleteCard: true }); if (r?.error) confirmRow.after(errorView(r.error)); else renderSaved(); } }, 'Xóa thẻ'),
    h('button', { class: 'btn ghost', onclick: () => { confirmRow.hidden = true; } }, 'Không'));
  return h('div', { class: 'item stack' },
    h('div', { class: 'row' }, h('span', { class: 'front grow', text: x.front }), x.cardId != null ? h('span', { class: 'chip ok', title: 'Đã đồng bộ với tài khoản' }, icon('check'), 'Đã đồng bộ') : h('span', { class: 'chip', text: 'Chưa đồng bộ' })),
    x.meaning ? h('p', { text: x.meaning }) : null,
    x.example ? h('p', { class: 'ex', text: x.example }) : null,
    h('p', { class: 'muted small' }, x.sourceTitle || 'Không rõ nguồn', ' · ', relTime(x.savedAt)),
    note,
    h('div', { class: 'row' },
      h('button', { class: 'btn ghost', onclick: () => speak(x.front) }, icon('sound'), 'Nghe'),
      h('button', { class: 'btn ghost', onclick: () => send({ t: 'cosmos', word: x.front.split(/\s+/)[0] }) }, icon('stars'), 'Cosmos'),
      x.sourceUrl ? h('a', { class: 'btn ghost', href: x.sourceUrl, target: '_blank', rel: 'noopener noreferrer' }, icon('link'), 'Nguồn') : null,
      h('button', { class: 'btn ghost', title: 'Bỏ khỏi danh sách này (thẻ vẫn còn)', onclick: async () => { await send({ t: 'saved:remove', id: x.id, deleteCard: false }); renderSaved(); } }, 'Bỏ khỏi danh sách'),
      x.cardId != null ? h('button', { class: 'btn ghost', title: 'Xóa thẻ khỏi tài khoản', onclick: () => { confirmRow.hidden = false; } }, icon('trash'), 'Xóa thẻ') : null),
    confirmRow);
}

// ---------------------------------------------------------------- start + handoff from a page
chrome.runtime.onMessage.addListener((m) => {
  if (m?.t === 'state-changed') refreshState().then(() => { if (!$('p-saved').hidden) renderSaved(); });
  if (m?.t === 'saved-changed' && !$('p-saved').hidden) renderSaved();
});

async function takeHandoff() {
  const { id: windowId } = await chrome.windows.getCurrent();
  const handoff = (await send({ t: 'panel:handoff', windowId }))?.data;
  if(handoff?.tab==='media'){mediaTabId=handoff.tabId; select('media');return true;}
  if (handoff?.text) {
    if (handoff.tab === 'practice') { privatePractice = handoff.scope || handoff.private; practiceSource.value = handoff.context && handoff.context.length > handoff.text.length ? handoff.context : handoff.text; select('practice'); }
    else if (handoff.tab === 'saved') select('saved');
    else { lookupInput.value = handoff.text; doLookup(handoff.text, handoff.context, handoff.scope || handoff.private); }
  }
  return !!handoff;
}
chrome.runtime.onMessage.addListener((m) => { if (m?.t === 'handoff-ready') takeHandoff(); });

(async () => {
  await refreshState();
  const took = await takeHandoff();
  if (!took && location.hash === '#saved') select('saved');
})();
