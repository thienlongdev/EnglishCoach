// Shared helpers of the extension pages (popup, side panel, settings, welcome). Text is only ever set with textContent.

export const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => ({ error: { code: 'EXTENSION', message: 'Echo đang khởi động lại, hãy thử lại.' } }));

const SVGNS = 'http://www.w3.org/2000/svg';
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

const PATHS = {
  book: 'M4 5a2 2 0 0 1 2-2h12v16H6a2 2 0 0 0-2 2V5Zm2 14h12',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm-9 9h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18',
  sound: 'M4 10v4h4l5 4V6L8 10H4Zm12-1a4 4 0 0 1 0 6m2-9a8 8 0 0 1 0 12',
  bulb: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.6.5 1.1 1.3 1.1 2.2h5c0-.9.5-1.7 1.1-2.2A6 6 0 0 0 12 3Z',
  save: 'M6 3h12v18l-6-4-6 4V3Z',
  stars: 'M5 18a2 2 0 1 0 0-.1M18 6a2 2 0 1 0 0-.1M14 17a1.5 1.5 0 1 0 0-.1M7 18l7-1M14 17l4-11',
  chat: 'M4 5h16v11H9l-5 4V5Z',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z',
  read: 'M3 6c3-1.5 6-1.5 9 0v13c-3-1.5-6-1.5-9 0V6Zm9 0c3-1.5 6-1.5 9 0v13c-3-1.5-6-1.5-9 0',
  panel: 'M4 4h16v16H4zM15 4v16',
  gear: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm7.4 3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14.5 2h-5l-.4 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2l.4 2.6h5l.4-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  target: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 5a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z',
  crown: 'M3 8l4 4 5-7 5 7 4-4-2 11H5L3 8Z',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm9 16-4-4',
  check: 'M5 12l5 5 9-10',
};
export function icon(name, cls = 'i') {
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVGNS, 'path');
  p.setAttribute('d', PATHS[name] || PATHS.book);
  svg.append(p);
  return svg;
}

// ---------------------------------------------------------------- Liquid Glass interaction layer (CSS does the drawing)
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Pointer-following specular sheen on glass surfaces, ambient light paused while the page is hidden. One listener, rAF-throttled. */
export function enhance() {
  let frame = 0;
  document.addEventListener('pointermove', (e) => {
    if (frame || reducedMotion()) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const el = e.target.closest?.('.card, .item, .q, .glass, .btn');
      if (!el) return;
      const r = el.getBoundingClientRect();
      el.style.setProperty('--px', `${e.clientX - r.left}px`);
      el.style.setProperty('--py', `${e.clientY - r.top}px`);
    });
  }, { passive: true });
  const pause = () => document.body.classList.toggle('paused', document.hidden);
  document.addEventListener('visibilitychange', pause);
  pause();
}

/** A glass indicator that slides under the selected tab (Echo Morph's surface curve, via CSS transition). */
export function tabIndicator(tablist) {
  const ind = h('span', { class: 'ind', 'aria-hidden': 'true' });
  tablist.prepend(ind);
  const move = () => {
    const on = tablist.querySelector('[aria-selected="true"]');
    if (!on) return;
    ind.style.width = `${on.offsetWidth}px`;
    ind.style.translate = `${on.offsetLeft}px 0`;
  };
  new ResizeObserver(move).observe(tablist);
  return move;
}

/** Saving feedback: a ring spreads from the button and a pearl rises from it. */
export function celebrate(el) {
  if (!el || reducedMotion()) return;
  el.append(h('span', { class: 'ring', 'aria-hidden': 'true' }));
  const r = el.getBoundingClientRect();
  const pearl = h('span', { class: 'pearl', 'aria-hidden': 'true', style: `position:fixed;left:${r.left + r.width / 2}px;top:${r.top + r.height / 2}px` });
  document.body.append(pearl);
  setTimeout(() => { pearl.remove(); el.querySelector('.ring')?.remove(); }, 950);
}

/** Renders `nodes` into `box` with the settle-in entrance. */
export function show(box, ...nodes) {
  box.classList.remove('enter');
  box.replaceChildren(...nodes);
  void box.offsetWidth; // restart the entrance for new content
  box.classList.add('enter');
}

export const skeleton = (n = 3) => Array.from({ length: n }, (_, i) => h('div', { class: 'skeleton', style: `width:${100 - i * 15}%` }));

export async function speak(text, localOnly = false) {
  const gate = await send({ t: 'language:check', text });
  if (!gate?.data?.english) { window.alert(gate?.error?.message || 'Hãy chọn đoạn tiếng Anh.'); return; }
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(String(text).slice(0, 400));
    u.lang = 'en-US';
    u.rate = 0.92;
    const voices = speechSynthesis.getVoices().filter(x => !localOnly || x.localService);
    const v = voices.find((x) => /^en(-|_)US/i.test(x.lang)) || voices.find((x) => /^en/i.test(x.lang));
    if (localOnly && !v) { window.alert('Hãy bật giọng tiếng Anh cục bộ để nghe đoạn riêng tư.'); return; }
    if (v) u.voice = v;
    speechSynthesis.speak(u);
  } catch { /* no speech engine */ }
}
export function playAudio(url, fallback) {
  if (url && /^https:\/\//.test(url)) new Audio(url).play().catch(() => speak(fallback));
  else speak(fallback);
}

/** A readable error with the right way forward (connect, upgrade, retry). */
export function errorView(err, retry) {
  const box = h('div', { class: 'stack' }, h('p', { class: 'error', text: err?.message || 'Có lỗi xảy ra.' }));
  if (err?.code === 'PREMIUM_REQUIRED') {
    box.append(h('p', { class: 'muted', text: 'Các tính năng AI của Echo Anywhere dành cho tài khoản Premium. Tra nghĩa, dịch nhanh, phát âm, lưu Flashcard, đọc tập trung và bài tập cơ bản luôn miễn phí.' }),
      h('button', { class: 'btn primary', onclick: () => send({ t: 'open', path: '/premium' }) }, icon('crown'), 'Xem gói Premium'));
  } else if (err?.code === 'PREMIUM_LIMIT_REACHED' || err?.code === 'PREMIUM_LIMIT') {
    box.append(h('p', { class: 'muted', text: 'Bạn đã dùng hết lượt AI Echo Anywhere của tháng này. Lượt mới có vào đầu tháng sau.' }));
  } else if (err?.code === 'NOT_CONNECTED' || err?.status === 401) {
    box.append(h('button', { class: 'btn primary', onclick: () => send({ t: 'connect' }) }, 'Kết nối tài khoản English Coach'));
  } else if (retry) {
    box.append(h('button', { class: 'btn', onclick: retry }, 'Thử lại'));
  }
  return box;
}

export function dictionaryView(d, query) {
  const out = h('div', { class: 'stack' });
  out.append(h('p', { class: 'word', text: d.headword || query }));
  const meta = h('div', { class: 'row' });
  for (const p of (d.pronunciations || []).slice(0, 2)) {
    if (p?.ipa) meta.append(h('button', { class: 'btn ghost', title: 'Phát âm', onclick: () => playAudio(p.audioUrl, d.headword || query) },
      icon('sound'), h('span', { class: 'ipa', text: `${p.region && p.region !== 'General' ? `${p.region} ` : ''}${p.ipa}` })));
  }
  if (!meta.childElementCount) meta.append(h('button', { class: 'btn ghost', onclick: () => speak(d.headword || query) }, icon('sound'), 'Nghe'));
  if (d.cefr) meta.append(h('span', { class: 'chip', text: d.cefr }));
  out.append(meta);
  if (d.generalTranslationVi) out.append(h('p', { class: 'general', text: d.generalTranslationVi }));
  if (d.inflectionNote) out.append(h('p', { class: 'muted', text: d.inflectionNote }));
  const vi = (d.vietnameseSenses || []).filter((g) => g?.meanings?.length);
  if (vi.length) {
    out.append(h('h3', { text: 'Nghĩa tiếng Việt' }));
    for (const g of vi.slice(0, 4)) out.append(h('p', { class: 'muted', text: g.partOfSpeech || '' }), h('ol', {}, g.meanings.slice(0, 5).map((m) => h('li', { text: m }))));
  }
  const pos = (d.partsOfSpeech || []).filter((p) => p?.senses?.length);
  if (pos.length) {
    out.append(h('h3', { text: 'Nghĩa tiếng Anh' }));
    for (const p of pos.slice(0, 3)) {
      if (p.partOfSpeech && p.partOfSpeech !== 'general') out.append(h('p', { class: 'muted', text: p.partOfSpeech }));
      out.append(h('ol', {}, p.senses.slice(0, 4).map((s) => h('li', {}, h('div', { text: s.definitionEn || '' }),
        s.translationVi ? h('div', { text: s.translationVi }) : null, ...(s.examples || []).slice(0, 1).map((e) => h('div', { class: 'ex', text: e }))))));
    }
  }
  if (d.synonyms?.length) out.append(h('h3', { text: 'Đồng nghĩa (ở một số nghĩa)' }), h('p', { text: d.synonyms.slice(0, 8).join(', ') }));
  if (d.antonyms?.length) out.append(h('h3', { text: 'Trái nghĩa' }), h('p', { text: d.antonyms.slice(0, 8).join(', ') }));
  const groups = [['Collocations', (d.collocations || []).map((c) => c.phrase)], ['Phrasal verbs', (d.phrasalVerbs || []).map((x) => x.phrase || x.headword)],
    ['Idioms', (d.idioms || []).map((x) => x.phrase || x.headword)], ['Expressions', (d.expressions || []).map((x) => x.phrase || x.headword)]]
    .map(([n, arr]) => [n, arr.filter((x) => typeof x === 'string').slice(0, 10)]).filter(([, arr]) => arr.length);
  if (groups.length) {
    out.append(h('h3', { text: 'Cụm từ liên quan' }));
    for (const [n, arr] of groups) out.append(h('p', {}, h('b', { text: `${n}: ` }), arr.join(' · ')));
  }
  if (d.relatedWords?.length) out.append(h('h3', { text: 'Dạng từ và từ liên quan' }), h('p', { text: d.relatedWords.slice(0, 10).join(', ') }));
  if (d.vietnameseSource) out.append(h('p', { class: 'muted small', text: `Nguồn tiếng Việt: ${d.vietnameseSource}` }));
  return out;
}

export function aiView(data) {
  const out = h('div', { class: 'stack' });
  const sec = (t, v) => { if (v) out.append(h('h3', { text: t }), h('p', { text: v })); };
  const list = (t, arr, f) => { if (arr?.length) out.append(h('h3', { text: t }), h('ul', {}, arr.map((x) => h('li', {}, ...f(x))))); };
  sec('Ý chính', data.mainIdea);
  list('Tóm tắt', data.summary, (x) => [x]);
  sec('Dịch theo ngữ cảnh', data.translation);
  sec('Ý nghĩa', data.meaning);
  sec('Câu trả lời', data.answer);
  sec('Dịch sát nghĩa', data.literal);
  list('Ngữ pháp', data.grammar, (g) => [h('b', { text: g.part }), ' — ', g.explanation || '']);
  sec('Văn phong', data.register);
  list('Thành ngữ', data.idioms, (g) => [h('b', { text: g.expression }), ' — ', g.meaning || '']);
  list('Cách nói tự nhiên hơn', data.alternatives, (x) => [x]);
  list('Lỗi người học hay gặp', data.pitfalls, (x) => [x]);
  sec('Tiếng Anh đơn giản hơn', data.simpler || data.rewritten);
  list('Ghi chú', data.notes || data.changes, (x) => [x]);
  sec('Nghĩa đang dùng', data.sense);
  list('Ví dụ', data.examples, (x) => [h('div', { text: x.en }), x.vi ? h('div', { class: 'ex', text: x.vi }) : '']);
  list('Từ vựng nên học', data.keyVocabulary, (v) => [h('b', { text: v.term }), v.meaningVi ? ` — ${v.meaningVi}` : '', v.why ? h('div', { class: 'muted', text: v.why }) : '']);
  list('Câu khó', data.hardSentences, (s) => [h('div', { class: 'ctx', text: s.sentence }), s.explanation ? h('div', { text: s.explanation }) : '']);
  if (data.difficulty) out.append(h('p', {}, h('span', { class: 'chip', text: `Độ khó ước lượng: ${data.difficulty}` })));
  sec('Gợi ý luyện tập', data.practiceIdea);
  out.append(h('p', { class: 'muted small', text: `Echo AI · trình độ ${data.level || 'B1'} · AI có thể sai, hãy đối chiếu khi cần.` }));
  return out;
}

// ---------------------------------------------------------------- free deterministic exercises

const STOP = new Set('the a an and or but if of to in on at for from by with as is are was were be been being it its this that these those there their they them he she his her you your we our i me my not no do does did have has had will would can could should may might must than then so such into about over under also just very more most other some any each which who whom whose what when where why how all both'.split(' '));

function hash(s) { let x = 2166136261; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); } return x >>> 0; }
function rng(seed) { let s = seed || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 10000) / 10000; }; }
function shuffle(arr, r) { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

export function sentencesOf(text) {
  return String(text || '').replace(/\s+/g, ' ').split(/(?<=[.!?])\s+(?=[A-Z"'(])/).map((s) => s.trim()).filter((s) => /[A-Za-z]/.test(s));
}

/**
 * Exercises whose answers come from the learner's own text or saved cards, so they can be graded exactly:
 * - cloze: the word the author used in that sentence (other choices are words of the same passage);
 * - order: the original order of a short sentence;
 * - meaning: the meaning the learner saved for one of their own cards (needs ≥ 4 saved meanings).
 * Returns fewer questions than asked rather than inventing an ambiguous one.
 */
export function freeExercises(text, count, saved = []) {
  const r = rng(hash(text) + count);
  const sentences = sentencesOf(text).filter((s) => s.length <= 260);
  const words = [...new Set((text.match(/[A-Za-z][A-Za-z'-]{3,}/g) || []).map((w) => w.toLowerCase()).filter((w) => !STOP.has(w)))];
  const out = [];
  const used = new Set();
  const kinds = ['cloze', 'order', 'meaning'];
  for (let k = 0; out.length < count && k < count * 6; k++) {
    const kind = kinds[k % kinds.length];
    if (kind === 'cloze') {
      const cands = shuffle(sentences.filter((s) => s.split(' ').length >= 6 && !used.has(s)), r);
      for (const s of cands) {
        const tokens = (s.match(/[A-Za-z][A-Za-z'-]{3,}/g) || []).filter((w) => !STOP.has(w.toLowerCase()));
        const target = tokens.sort((a, b) => b.length - a.length)[0];
        if (!target || s.split(target).length !== 2) continue;
        const pool = words.filter((w) => w !== target.toLowerCase() && !s.toLowerCase().includes(w) && Math.abs(w.length - target.length) <= 4);
        if (pool.length < 2) continue;
        const options = shuffle([target, ...shuffle(pool, r).slice(0, 3)], r);
        used.add(s);
        out.push({ type: 'cloze', prompt: s.replace(target, '_____'), options, answerIndex: options.indexOf(target),
          evidence: s, explanation: 'Đáp án là từ tác giả đã dùng ở chỗ trống trong câu gốc.' });
        break;
      }
    } else if (kind === 'order') {
      const cands = shuffle(sentences.filter((s) => { const n = s.split(' ').length; return n >= 4 && n <= 10 && !used.has(s); }), r);
      const s = cands[0];
      if (!s) continue;
      const tokens = s.replace(/[.!?]+$/, '').split(' ');
      if (new Set(tokens.map((t) => t.toLowerCase())).size !== tokens.length) { used.add(s); continue; }
      used.add(s);
      out.push({ type: 'order', prompt: 'Sắp xếp các từ thành câu đúng như trong bài:', tokens, shuffled: shuffle(tokens, r), evidence: s });
    } else {
      const withMeaning = saved.filter((x) => x.meaning && x.front && !used.has(`m:${x.front}`));
      const distinct = [...new Map(withMeaning.map((x) => [x.meaning.toLowerCase(), x])).values()];
      if (distinct.length < 4) continue;
      const pick = shuffle(distinct, r).slice(0, 4);
      const target = pick[0];
      used.add(`m:${target.front}`);
      const options = shuffle(pick.map((x) => x.meaning), r);
      out.push({ type: 'meaning', prompt: `“${target.front}” có nghĩa là gì?`, options, answerIndex: options.indexOf(target.meaning),
        evidence: target.example || target.front, explanation: 'Đáp án là nghĩa bạn đã lưu cho thẻ này.' });
    }
  }
  return out;
}

/** Renders a list of questions (free or AI) with exact grading; returns the container. */
export function quizView(questions, { note } = {}) {
  const wrap = h('div', { class: 'stack' });
  let answered = 0, right = 0;
  const score = h('p', { class: 'muted', 'aria-live': 'polite' });
  const bump = (ok) => { answered += 1; if (ok) right += 1; score.textContent = `Đúng ${right}/${answered} câu đã làm · tổng ${questions.length} câu`; };
  questions.forEach((q, i) => {
    const box = h('div', { class: 'q' }, h('p', {}, h('b', { text: `Câu ${i + 1}. ` }), q.prompt));
    if (q.type === 'order') {
      const line = h('div', { class: 'answer-line', 'aria-label': 'Câu bạn đang xếp' });
      const picked = [];
      const tiles = h('div', { class: 'tiles' });
      const verdict = h('p', { class: 'verdict' });
      q.shuffled.forEach((t) => {
        const b = h('button', { type: 'button', text: t, onclick: () => { b.disabled = true; picked.push(t); line.append(h('span', { class: 'chip', text: t })); if (picked.length === q.tokens.length) check(); } });
        tiles.append(b);
      });
      const reset = h('button', { class: 'btn ghost small', type: 'button', onclick: () => { picked.length = 0; line.replaceChildren(); tiles.querySelectorAll('button').forEach((b) => { b.disabled = false; }); verdict.textContent = ''; verdict.className = 'verdict'; } }, 'Xếp lại');
      let done = false;
      function check() {
        const ok = picked.join(' ') === q.tokens.join(' ');
        verdict.textContent = ok ? 'Chính xác!' : `Chưa đúng. Câu gốc: ${q.evidence}`;
        verdict.className = `verdict ${ok ? 'right' : 'wrong'}`;
        if (!done) { done = true; bump(ok); }
      }
      box.append(line, tiles, h('div', { class: 'row' }, reset), verdict);
    } else {
      const name = `q${i}-${Math.random().toString(36).slice(2, 7)}`;
      const fs = h('fieldset', {}, h('legend', { class: 'sr', text: q.prompt }));
      const verdict = h('div', { 'aria-live': 'polite' });
      let done = false;
      q.options.forEach((opt, j) => {
        const input = h('input', { type: 'radio', name, value: String(j) });
        const label = h('label', {}, input, h('span', { text: opt }));
        input.addEventListener('change', () => {
          if (done) return;
          done = true;
          const ok = j === q.answerIndex;
          bump(ok);
          fs.querySelectorAll('input').forEach((x) => { x.disabled = true; });
          label.classList.add(ok ? 'right' : 'wrong');
          fs.querySelectorAll('label')[q.answerIndex].classList.add('right');
          verdict.replaceChildren(h('p', { class: `verdict ${ok ? 'right' : 'wrong'}`, text: ok ? 'Chính xác!' : `Đáp án đúng: ${q.options[q.answerIndex]}` }),
            q.explanation ? h('p', { text: q.explanation }) : '', q.evidence ? h('p', { class: 'ctx small', text: `Bằng chứng trong bài: “${q.evidence}”` }) : '');
        });
        fs.append(label);
      });
      box.append(fs, verdict);
    }
    wrap.append(box);
  });
  wrap.append(score);
  if (note) wrap.append(h('p', { class: 'muted small', text: note }));
  return wrap;
}

export function relTime(ms) {
  const d = Math.round((Date.now() - ms) / 60000);
  if (d < 1) return 'vừa xong';
  if (d < 60) return `${d} phút trước`;
  if (d < 1440) return `${Math.round(d / 60)} giờ trước`;
  return new Date(ms).toLocaleDateString('vi-VN');
}
