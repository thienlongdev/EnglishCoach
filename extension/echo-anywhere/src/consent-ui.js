import { send, h } from './ui.js';
export async function allowShare(scope, text, purpose, destination) {
  if (!scope) return true;
  if ((await send({ t: 'consent:check', scope, purpose }))?.allowed) return true;
  const remember = h('input', { type: 'checkbox', checked: scope.kind === 'mixed' });
  const dlg = h(
    'dialog',
    { class: 'card stack', 'aria-label': 'Cho phép chia sẻ văn bản' },
    h('h2', { text: 'Chia sẻ đoạn đã chọn' }),
    h('p', { text: 'Gửi đến ' + destination + '?' }),
    h('blockquote', { text }),
    scope.remember ? h('label', {}, remember, ' Nhớ quyền này trong phiên và ngữ cảnh hiện tại') : null,
  );
  document.body.append(dlg);
  return new Promise((resolve) => {
    dlg.addEventListener(
      'close',
      async () => {
        const ok = dlg.returnValue === 'yes';
        if (ok && remember.checked && scope.remember) await send({ t: 'consent:remember', scope, purpose });
        dlg.remove();
        resolve(ok);
      },
      { once: true },
    );
    dlg.append(
      h('button', { class: 'btn primary', onclick: () => dlg.close('yes') }, 'Đồng ý'),
      h('button', { class: 'btn', onclick: () => dlg.close('no') }, 'Hủy'),
    );
    dlg.showModal();
  });
}
