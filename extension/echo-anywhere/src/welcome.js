import { send, h, dictionaryView, errorView, skeleton, enhance, show } from './ui.js';

enhance();

const main = document.getElementById('main');

async function render() {
  const st = await send({ t: 'state' });
  const demoOut = h('div', { class: 'stack', 'aria-live': 'polite' });
  const word = (w) => h('button', { type: 'button', title: `Tra “${w}”`, onclick: async () => {
    demoOut.replaceChildren(...skeleton(3));
    const r = await send({ t: 'lookup', word: w });
    show(demoOut, h('div', { class: 'card' }, r?.data ? dictionaryView(r.data, w) : errorView(r?.error)));
  } }, w);

  main.replaceChildren(
    h('div', { class: 'steps' },
      h('div', { class: 'card step stack' }, h('h2', { text: 'Ghim biểu tượng Echo' }),
        h('p', { class: 'muted', text: 'Bấm biểu tượng mảnh ghép ở góc trên bên phải trình duyệt, tìm “Echo Anywhere” và bấm ghim, để Echo luôn trong tầm tay.' })),
      h('div', { class: 'card step stack' }, h('h2', { text: 'Kết nối tài khoản English Coach' }),
        st?.connected
          ? h('p', { class: 'note', text: `Đã kết nối: ${st.account?.displayName || ''}. Từ bạn lưu sẽ vào Thẻ từ vựng của tài khoản.` })
          : h('div', { class: 'stack' }, h('p', { class: 'muted', text: 'Trang English Coach sẽ mở ra; bạn đăng nhập như bình thường rồi bấm “Kết nối”. Echo không bao giờ thấy mật khẩu của bạn.' }),
            h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => send({ t: 'connect' }) }, 'Kết nối ngay'), h('span', { class: 'muted small', text: 'Có thể để sau.' })))),
      h('div', { class: 'card step stack' }, h('h2', { text: 'Thử tra từ đầu tiên' }),
        h('p', { class: 'demo' }, 'The team decided to ', word('postpone'), ' the release because the new feature was not ', word('reliable'), ' enough, but they promised to ', word('break the ice'), ' with users next week.'),
        h('p', { class: 'muted small', text: 'Trên trang web thật: bôi đen chữ rồi bấm biểu tượng Echo, chuột phải → “Echo: Tra nghĩa”, hoặc nhấn Alt+Shift+E.' }),
        demoOut),
      h('div', { class: 'card step stack' }, h('h2', { text: 'Quyền truy cập trang web' }),
        h('p', { class: 'muted', text: 'Mặc định Echo chỉ chạy trên một trang khi bạn gọi nó. Nếu muốn Echo tự hiện khi bôi đen chữ, hãy bật “Tự hiện Echo” cho từng trang trong cửa sổ Echo, hoặc cho mọi trang trong Cài đặt. Echo không chạy trên trang thi và trò chơi của English Coach, không đọc ô nhập liệu hay mật khẩu.' }),
        h('button', { class: 'btn', onclick: () => chrome.runtime.openOptionsPage() }, 'Mở Cài đặt'))),
    h('div', { class: 'cols' },
      h('div', { class: 'card stack' }, h('h2', { text: 'Miễn phí' }), h('ul', {},
        ...['Tra nghĩa Anh–Việt, IPA, phát âm', 'Dịch nhanh đoạn đã chọn', 'Lưu vào Thẻ từ vựng, chống trùng', 'Mở từ trong Vũ trụ tri thức', 'Đọc tập trung, thước đọc, cỡ chữ', 'Bài tập cơ bản chấm chính xác', 'Mục Đã lưu có ghi chú'].map((x) => h('li', { text: x })))),
      h('div', { class: 'card stack' }, h('h2', {}, 'Premium ', h('span', { class: 'chip gold', text: 'Echo AI' })), h('ul', {},
        ...['Giải thích sâu: ngữ pháp, văn phong, thành ngữ', 'Dịch theo ngữ cảnh, viết lại đơn giản hơn', 'Hỏi Echo về câu bạn đang đọc', 'Tóm tắt bài, từ vựng chính, câu khó', 'Quiz và bài tập AI có trích dẫn bằng chứng'].map((x) => h('li', { text: x }))),
        h('p', { class: 'muted small', text: 'Dùng chung gói Premium của English Coach, có giới hạn sử dụng hằng tháng.' }),
        h('button', { class: 'btn', onclick: () => send({ t: 'open', path: '/premium' }) }, 'Xem gói Premium'))),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async () => { await send({ t: 'settings', patch: { onboarded: true } }); window.close(); } }, 'Bắt đầu dùng'),
      h('button', { class: 'btn ghost', onclick: async () => { await send({ t: 'settings', patch: { onboarded: true } }); window.close(); } }, 'Bỏ qua')));
}

render();
chrome.runtime.onMessage.addListener((m) => { if (m?.t === 'state-changed') render(); });
