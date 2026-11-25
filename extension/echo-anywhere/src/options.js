import { send, h, enhance, show } from './ui.js';

enhance();

const main = document.getElementById('main');
const ALL = ['https://*/*', 'http://*/*'];

async function render() {
  const st = await send({ t: 'state' });
  const perms = await chrome.permissions.getAll();
  const site = new URL(st?.site || 'https://englishcoach.io.vn').origin;
  const granted = (perms.origins || []).filter((o) => !o.startsWith(site));
  const everywhere = ALL.every((o) => granted.includes(o));
  const s = st?.settings || {};

  const account = h('div', { class: 'card stack' }, h('h2', { text: 'Tài khoản' }));
  if (st?.connected) {
    account.append(h('p', {}, 'Đã kết nối với ', h('b', { text: st.account?.displayName || 'tài khoản English Coach' }), st.premium ? ' · Premium' : ' · Miễn phí'),
      h('p', { class: 'muted', text: 'Echo dùng một phiên đăng nhập riêng (hiện trong “Phiên đăng nhập” ở Hồ sơ cá nhân trên English Coach, tên “Echo Anywhere”). Bạn có thể ngắt ở đây hoặc trên trang web.' }),
      h('button', { class: 'btn', onclick: async () => { await send({ t: 'disconnect' }); render(); } }, 'Ngắt kết nối'));
  } else {
    account.append(h('p', { class: 'muted', text: 'Chưa kết nối. Kết nối để lưu Thẻ từ vựng, đồng bộ và dùng Echo AI (Premium).' }),
      h('button', { class: 'btn primary', onclick: () => send({ t: 'connect' }) }, 'Kết nối tài khoản English Coach'));
  }

  const autoToggle = h('input', { type: 'checkbox', id: 'auto', checked: s.autoBubble !== false });
  autoToggle.addEventListener('change', async () => { await send({ t: 'settings', patch: { autoBubble: autoToggle.checked } }); });
  const allBtn = everywhere
    ? h('button', { class: 'btn', onclick: async () => { await chrome.permissions.remove({ origins: ALL }); await send({ t: 'sync-auto' }); render(); } }, 'Thu hồi quyền trên mọi trang')
    : h('button', { class: 'btn', onclick: async () => { const ok = await chrome.permissions.request({ origins: ALL }).catch(() => false); if (ok) { await send({ t: 'sync-auto' }); render(); } } }, 'Cho phép trên mọi trang web');
  const sites = granted.filter((o) => !ALL.includes(o));
  const access = h('div', { class: 'card stack' }, h('h2', { text: 'Trang web Echo được tự chạy' }),
    h('label', { class: 'switch', for: 'auto' }, h('span', { text: 'Hiện biểu tượng Echo khi bôi đen chữ trên các trang đã cho phép' }), autoToggle),
    h('p', { class: 'muted', text: 'Mặc định Echo chỉ chạy khi bạn bấm biểu tượng Echo, chuột phải → “Echo”, hoặc nhấn Alt+Shift+E. Để Echo tự hiện khi bôi đen chữ, hãy cho phép từng trang (trong cửa sổ Echo) hoặc mọi trang dưới đây. Echo không bao giờ đọc ô nhập liệu, mật khẩu hay thông tin thanh toán, và không chạy trên English Coach.' }),
    allBtn,
    sites.length ? h('div', {}, ...sites.map((o) => h('div', { class: 'site' }, h('span', { class: 'grow', text: o.replace('/*', '') }),
      h('button', { class: 'btn ghost', onclick: async () => { await chrome.permissions.remove({ origins: [o] }); await send({ t: 'sync-auto' }); render(); } }, 'Thu hồi')))) : h('p', { class: 'muted small', text: everywhere ? 'Đang cho phép trên mọi trang.' : 'Chưa cho phép trang nào.' }));

  const disabledInput = h('input', { type: 'text', placeholder: 'ví dụ: facebook.com', 'aria-label': 'Tên miền muốn tắt Echo' });
  const disabled = h('div', { class: 'card stack' }, h('h2', { text: 'Tắt Echo trên một số trang' }),
    ...(s.disabledSites || []).map((d) => h('div', { class: 'site' }, h('span', { class: 'grow', text: d }),
      h('button', { class: 'btn ghost', onclick: async () => { await send({ t: 'settings', patch: { disabledSites: s.disabledSites.filter((x) => x !== d) } }); render(); } }, 'Bật lại'))),
    h('form', { class: 'row', onsubmit: async (e) => { e.preventDefault(); const v = disabledInput.value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''); if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(v)) return; await send({ t: 'settings', patch: { disabledSites: [...new Set([...(s.disabledSites || []), v])] } }); render(); } },
      h('div', { class: 'grow' }, disabledInput), h('button', { class: 'btn', type: 'submit' }, 'Tắt trên trang này')));

  const data = h('div', { class: 'card stack' }, h('h2', { text: 'Quyền riêng tư và dữ liệu' }),
    h('ul', {},
      h('li', { text: 'Echo không theo dõi lịch sử duyệt web, không ghi phím gõ, không đọc ô nhập liệu.' }),
      h('li', { text: 'Chỉ khi bạn bấm một nút, Echo mới gửi đúng đoạn bạn chọn tới English Coach (tra từ, dịch, lưu thẻ, AI).' }),
      h('li', { text: 'Trên trang có tin nhắn riêng (Facebook, Messenger, Zalo…), Echo hỏi lại trước khi gửi đoạn đã chọn.' }),
      h('li', { text: 'Thẻ từ vựng lưu vào tài khoản của bạn; ghi chú và nguồn trang (không kèm tham số) lưu trên trình duyệt này.' }),
      h('li', { text: 'Dịch nhanh miễn phí đi qua máy chủ English Coach tới dịch vụ dịch máy; tính năng AI (Premium) đi qua máy chủ English Coach tới nhà cung cấp mô hình AI.' })),
    h('button', { class: 'btn ghost', onclick: () => send({ t: 'open', path: '/echo-anywhere#quyen-rieng-tu' }) }, 'Đọc chính sách đầy đủ'),
    h('button', { class: 'btn', onclick: async () => { const r = await send({ t: 'saved:list' }); for (const x of r?.data || []) await send({ t: 'saved:remove', id: x.id, deleteCard: false }); render(); } }, 'Xóa danh sách Đã lưu trên trình duyệt này (thẻ trong tài khoản vẫn còn)'));

  const consent = h('div',{class:'card stack'},h('h2',{text:'Chia sẻ trong phiên'}),h('p',{text:'Quyền bảng tin, trò chuyện và AI được ghi nhớ riêng trên trình duyệt này.'}));
  consent.append(h('button',{class:'btn',onclick:async()=>{await send({t:'consent:clear'});consent.append(h('p',{role:'status',text:'Đã thu hồi các quyền chia sẻ trong phiên.'}));}},'Thu hồi quyền chia sẻ'));
  show(main, account, access, disabled, data, consent,
    h('p', { class: 'muted small', text: `Phiên bản ${st?.version || ''} · Phím tắt có thể đổi tại chrome://extensions/shortcuts (Edge: edge://extensions/shortcuts).` }));
}

render();
chrome.runtime.onMessage.addListener((m) => { if (m?.t === 'state-changed') render(); });
