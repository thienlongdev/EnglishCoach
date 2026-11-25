import { send, h, icon, enhance, show } from './ui.js';

enhance();

const main = document.getElementById('main');
const acct = document.getElementById('acct');

async function openPanel(payload) {
  try {
    if (payload?.tab === 'lookup') {
      const gate = await send({ t: 'language:check', text: payload.text });
      if (!gate?.data?.english) {
        main.querySelector('[data-language-note]')?.remove();
        main.prepend(h('p', { class: 'note', role: 'status', 'data-language-note': '', text: gate?.error?.message || 'Hãy chọn đoạn tiếng Anh.' }));
        return;
      }
    }
    // open first, while the click's gesture is fresh; the panel asks for the hand-off once it has loaded
    const win = await chrome.windows.getCurrent();
    const opening = chrome.sidePanel?.open?.({ windowId: win.id }).then(() => true, () => false);
    if (payload) await send({ t: 'handoff:set', windowId: win.id, payload });
    if (!await opening) await chrome.tabs.create({ windowId: win.id, url: chrome.runtime.getURL('sidepanel.html') });
    window.close();
  } catch {
    main.prepend(h('p', { class: 'note', role: 'status', text: 'Trình duyệt này chưa mở được bảng bên. Hãy cập nhật Chrome / Edge lên bản mới.' }));
  }
}

async function render() {
  const st = await send({ t: 'state' });
  const tab = (await send({ t: 'tab:info' }))?.data;
  acct.replaceChildren();
  if (st?.connected) {
    acct.append(h('span', { class: 'chip', text: st.account?.displayName || 'Đã kết nối' }),
      st.premium ? h('span', { class: 'chip gold', text: 'Premium' }) : h('span', { class: 'chip', text: 'Miễn phí' }));
    if (st.premium && st.ai) acct.append(h('span', { class: 'chip', text: `AI: còn ${st.ai.remaining}/${st.ai.limit} tháng này` }));
  } else {
    acct.append(h('span', { class: 'chip', text: 'Chưa kết nối tài khoản' }));
  }

  const quick = h('input', { type: 'search', placeholder: 'Tra nhanh một từ…', 'aria-label': 'Tra nhanh một từ', maxlength: '80' });
  const blocks = [];
  if (!st?.connected) {
    blocks.push(h('div', { class: 'card stack' },
      h('p', { text: 'Kết nối với tài khoản English Coach để lưu Thẻ từ vựng, đồng bộ và dùng Echo AI.' }),
      h('button', { class: 'btn primary block', onclick: () => send({ t: 'connect' }).then(() => window.close()) }, 'Kết nối tài khoản'),
      h('p', { class: 'muted small', text: 'Tra nghĩa, dịch nhanh, phát âm và đọc tập trung dùng được ngay, không cần tài khoản.' })));
  }
  blocks.push(h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); const w = quick.value.trim(); if (w) openPanel({ tab: 'lookup', text: w, context: '' }); } },
    h('div', { class: 'grow' }, quick), h('button', { class: 'btn primary', type: 'submit' }, 'Tra')));

  const pageCard = h('div', { class: 'card stack' }, h('h2', { text: 'Trang này' }));
  if (!tab?.allowed) {
    pageCard.append(h('p', { class: 'muted', text: tab?.reason === 'own-site' ? 'Bạn đang ở English Coach: dùng Từ điển có sẵn (Ctrl K). Echo Anywhere không chạy trên các trang thi và trò chơi của English Coach.' : 'Trình duyệt không cho tiện ích chạy trên trang này (trang hệ thống, cửa hàng tiện ích, PDF).' }));
  } else {
    const result = h('div', { role: 'status' });
    pageCard.append(h('div', { class: 'grid' },
      h('button', { class: 'btn', onclick: async () => { const r = await send({ t: 'tab:invoke', action: 'toolbar' }); if (r?.ok) window.close(); else result.replaceChildren(h('p', { class: 'error small', text: 'Không chạy được trên trang này.' })); } }, icon('book'), 'Học đoạn đã chọn'),
      h('button', { class: 'btn', onclick: async () => { const r = await send({ t: 'tab:invoke', action: 'read' }); if (r?.ok) window.close(); } }, icon('read'), 'Đọc tập trung')), result);
    const settings = st?.settings || {};
    const auto = h('input', { type: 'checkbox', id: 'auto', checked: tab.granted && settings.autoBubble !== false && !(settings.disabledSites || []).includes(tab.host) });
    auto.addEventListener('change', async () => {
      if (auto.checked) {
        const ok = await chrome.permissions.request({ origins: [`${tab.origin}/*`] }).catch(() => false);
        if (!ok) { auto.checked = false; return; }
        const disabled = (settings.disabledSites || []).filter((x) => x !== tab.host);
        await send({ t: 'settings', patch: { autoBubble: true, disabledSites: disabled } });
        result.replaceChildren(h('p', { class: 'note small', text: 'Đã bật. Tải lại trang rồi bôi đen chữ để thấy biểu tượng Echo.' }));
      } else {
        await chrome.permissions.remove({ origins: [`${tab.origin}/*`] }).catch(() => false);
        await send({ t: 'sync-auto' });
        result.replaceChildren(h('p', { class: 'note small', text: 'Đã tắt Echo tự động trên trang này.' }));
      }
    });
    pageCard.append(h('label', { class: 'switch', for: 'auto' },
      h('span', {}, h('b', { text: 'Tự hiện Echo khi bôi đen chữ' }), h('span', { class: 'muted small', style: 'display:block', text: `Chỉ trên ${tab.host}. Trình duyệt sẽ hỏi quyền.` })), auto));
  }
  blocks.push(pageCard);
  blocks.push(h('button',{class:'btn block',onclick:()=>openPanel({tab:'media',tabId:tab?.tabId})},icon('sound'),'Video, lời nhạc và Karaoke'));

  blocks.push(h('div', { class: 'grid' },
    h('button', { class: 'btn primary', onclick: () => openPanel(null) }, icon('panel'), 'Mở bảng Echo'),
    h('button', { class: 'btn', onclick: () => openPanel({ tab: 'saved', text: ' ' }) }, icon('save'), 'Đã lưu')));
  blocks.push(h('div', { class: 'row' },
    !st?.premium ? h('button', { class: 'link', onclick: () => send({ t: 'open', path: '/premium' }) }, 'Premium mở khóa Echo AI') : h('span', { class: 'muted small', text: st.premiumUntil ? `Premium đến ${new Date(st.premiumUntil).toLocaleDateString('vi-VN')}` : 'Premium' }),
    h('span', { class: 'grow' }),
    h('button', { class: 'link', onclick: () => chrome.runtime.openOptionsPage() }, 'Cài đặt')));
  show(main, ...blocks);
  quick.focus();
}

render();
