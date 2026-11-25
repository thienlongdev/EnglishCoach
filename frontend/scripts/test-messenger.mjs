// Echo Messenger next generation (2026-11-15): the pure rules of the screens and the contracts of the sources.
// Behaviour against a real database is MessengerPostgresTest + MessengerNextPostgresTest; the browser journey is
// docs/messenger/next-2026-11-15/evidence/journey.cjs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tsLoader } from './lib/ts-load.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = p => readFileSync(join(root, 'src', p), 'utf8');
let passed = 0;
const check = (name, fn) => { fn(); passed += 1; console.log('  ok  ' + name); };
const load = tsLoader();
const kit = load('lib/messenger/chatKit.ts');

check('activity: online, minutes, hours, days, and nothing after seven days or when not allowed', () => {
  const now = Date.parse('2026-11-15T12:00:00Z'), ago = ms => new Date(now - ms).toISOString(), M = 60000, H = 60 * M, D = 24 * H;
  assert.equal(kit.activityLine({ online: true, lastActiveAt: null }, true, now), 'Đang hoạt động');
  assert.equal(kit.activityLine({ online: false, lastActiveAt: ago(20000) }, true, now), 'Vừa mới hoạt động');
  assert.equal(kit.activityLine({ online: false, lastActiveAt: ago(5 * M) }, true, now), 'Hoạt động 5 phút trước');
  assert.equal(kit.activityLine({ online: false, lastActiveAt: ago(2 * H + 10 * M) }, true, now), 'Hoạt động 2 giờ trước');
  assert.equal(kit.activityLine({ online: false, lastActiveAt: ago(3 * D + H) }, true, now), 'Hoạt động 3 ngày trước');
  assert.equal(kit.activityLine({ online: false, lastActiveAt: ago(6 * D + 23 * H) }, false, now), 'Active 6 days ago');
  assert.equal(kit.activityLine({ online: false, lastActiveAt: ago(7 * D) }, true, now), null, 'seven days: nothing');
  assert.equal(kit.activityLine({ online: false, lastActiveAt: null }, true, now), null, 'not allowed / never seen: nothing');
  assert.equal(kit.activityLine(null, true, now), null);
  assert.equal(kit.activityLine({ online: false, lastActiveAt: new Date(now + 30000).toISOString() }, true, now), 'Vừa mới hoạt động', 'a clock slightly ahead never says a negative time');
});

check('files: what one message may carry', () => {
  const img = { kind: 'IMAGE', size: 1000 }, doc = { kind: 'FILE', size: 1000 };
  assert.equal(kit.overLimit([img, img, img, img, doc, doc]), null);
  assert.equal(kit.overLimit([img, img, img, img, img]), 'ATTACHMENT_TOO_MANY');
  assert.equal(kit.overLimit([doc, doc, doc]), 'ATTACHMENT_TOO_MANY');
  assert.equal(kit.overLimit([{ kind: 'FILE', size: 10 * 1024 * 1024 }, { kind: 'FILE', size: 10 * 1024 * 1024 }, { kind: 'IMAGE', size: 5 }]), 'ATTACHMENT_TOO_LARGE');
  assert.equal([...kit.DOCUMENT_TYPES].sort().join(), ['csv', 'doc', 'docx', 'pdf', 'ppt', 'pptx', 'txt', 'xls', 'xlsx'].join());
  assert.ok(!/svg|html|zip|exe|js/.test(kit.ACCEPT), 'the picker never offers active content or archives');
});

check('paste: a screenshot becomes one picture; copied text with a picture of itself stays text', () => {
  const file = (type, size) => ({ type, size, name: 'image.png' });
  const data = (files, text = '', html = '') => ({ files, getData: k => (k === 'text/plain' ? text : k === 'text/html' ? html : '') });
  assert.equal(kit.pastedPictures(data([file('image/png', 100)])).length, 1);
  assert.equal(kit.pastedPictures(data([file('image/png', 100), file('image/png', 100)])).length, 1, 'one picture in two forms is one picture');
  assert.equal(kit.pastedPictures(data([file('image/png', 100)], 'a cell of a sheet')).length, 0, 'spreadsheet cells keep their text');
  assert.equal(kit.pastedPictures(data([file('image/png', 100)], 'caption', '<img src="x">')).length, 1, 'a copied web picture with its alt text is a picture');
  assert.equal(kit.pastedPictures(data([file('application/pdf', 100)])).length, 0);
  assert.equal(kit.pastedPictures(data([1, 2, 3, 4, 5, 6].map(n => file('image/png', n)))).length, 4, 'at most four');
  assert.equal(kit.pastedPictures(null).length, 0);
});

check('emoji: native glyphs, searchable in both languages, groups well formed', () => {
  assert.ok(kit.searchEmoji('cuoi').includes('😂'));
  assert.ok(kit.searchEmoji('cười').includes('😂'), 'Vietnamese marks fold');
  assert.ok(kit.searchEmoji('love').includes('❤️'));
  assert.ok(kit.searchEmoji('ca voi').includes('🐳'));
  assert.equal(kit.searchEmoji('   ').length, 0);
  for (const g of kit.EMOJI_GROUPS) for (const e of g.items.split(' ')) assert.ok(e && !/[a-z0-9<>]/i.test(e), g.id + ': ' + e);
  assert.equal(kit.QUICK_REACTIONS.length, 6);
});

check('themes: ten original themes, each with CSS, the same names as the server', () => {
  const css = src('components/messenger/messenger.module.css');
  const server = readFileSync(join(root, '../backend/src/main/java/com/englishcoach/messenger/MessengerRoomService.java'), 'utf8');
  const ids = kit.THEMES.map(t => t.id);
  assert.equal(new Set(ids).size, 10);
  for (const id of ids) {
    assert.ok(id === 'pearl' || css.includes(`[data-theme="${id}"]`), 'CSS for ' + id);
    assert.ok(server.includes(`"${id}"`), 'server accepts ' + id);
  }
  const thread = src('components/messenger/Thread.tsx');
  assert.ok(!/<canvas|WebGL|getContext/.test(thread), 'a theme is CSS: no renderer');
  assert.deepEqual(thread.match(/setInterval\([^;]*?, (\d+)\)/g)?.map(x => x.match(/(\d+)\)$/)[1]), ['60000'], 'the only timer: activity words once a minute, no request');
});

check('layout: by its own width, full height, panes that scroll by themselves', () => {
  const css = src('components/messenger/messenger.module.css'), page = src('app/community/messages/page.tsx');
  assert.match(css, /container: msgr \/ inline-size/);
  assert.match(css, /@container msgr \(max-width: 760px\)/, 'one pane at a time when narrow');
  assert.match(css, /@container msgr \(min-width: 1180px\) \{\s*\.world\[data-details\] \.frame \{ grid-template-columns/, 'details beside the conversation when wide (on the inner grid: a container query never styles the container itself)');
  assert.match(css, /@container msgr \(max-width: 760px\) \{\s*\.frame \{ grid-template-columns: minmax\(0, 1fr\)/, 'one column when narrow, on the inner grid');
  assert.ok(!/^\.world \{[^}]*display: grid/m.test(css), 'the container itself is not the grid');
  assert.match(css, /\.bubbleLine \{[^}]*width: fit-content/, 'the action bar sits next to the bubble, not at the end of a stretched row');
  assert.ok(!/max-w-\[/.test(page), 'no fixed column width on the page');
  for (const pane of ['.list, .people', '.messages {', '.detailsScroll', '.emojiScroll']) assert.ok(new RegExp(pane.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^}]*overflow-y: auto').test(css), pane + ' scrolls by itself');
  assert.ok(!/backdrop-filter/.test(css), 'no backdrop blur (10 §AF)');
  assert.ok(!/!important/.test(css), 'no !important');
  assert.ok(!/font-family:(?![^;]*Emoji)/.test(css), 'no typeface of its own except the emoji glyphs (10 §AA)');
});

check('message actions: on hover / focus / long press only, and reachable without a mouse', () => {
  const css = src('components/messenger/messenger.module.css'), parts = src('components/messenger/MessageParts.tsx');
  assert.match(css, /\.actions \{[^}]*position: absolute[^}]*opacity: 0; visibility: hidden/, 'no room taken, invisible and unreachable at rest (visibility, so a short pause can keep it reachable)');
  assert.match(css, /\.row:hover \.actions, \.row:focus-within \.actions, \.row:focus \.actions, \.row\[data-open\] \.actions/);
  assert.match(css, /@media \(hover: none\)/, 'a touch screen does not keep hover');
  assert.match(parts, /onTouchStart/, 'long press');
  assert.match(parts, /onContextMenu/, 'right click / context menu');
  assert.match(parts, /tabIndex=\{real \? 0 : undefined\}/, 'a message takes the keyboard');
  assert.match(parts, /role="toolbar"/);
});

check('the store: no polling, account boundary, quiet messages never ring', () => {
  const store = src('lib/messenger/store.ts');
  assert.ok(!/setInterval/.test(store), 'nothing polls');
  assert.match(store, /bind\(me\)[\s\S]*outbox\.clear\(\)/, 'files of another account are dropped at the boundary');
  assert.match(store, /const counts = !mine && !showing && !already && !quiet/);
  assert.match(store, /m\.kind !== 'SYSTEM'/, 'a line the conversation says about itself is not a card');
  assert.ok(!/localStorage/.test(store), 'no message content in browser storage');
});

check('attachments: private URLs, picture prepared on the device, nothing AI', () => {
  const api = src('services/messengerApi.ts'), kitSrc = src('lib/messenger/chatKit.ts');
  assert.match(api, /attachmentUrl = \(id: string, thumb = false\) => `\/api\/v1\$\{B\}\/attachments\/\$\{id\}/);
  assert.match(kitSrc, /imageOrientation: 'from-image'/, 'turned the way the camera held it');
  assert.match(kitSrc, /2560/, 'pixels bounded before upload');
  for (const f of ['components/messenger/EchoMessenger.tsx', 'components/messenger/Thread.tsx', 'components/messenger/MessageParts.tsx', 'components/messenger/Details.tsx', 'lib/messenger/store.ts', 'lib/messenger/chatKit.ts'])
    assert.ok(!/Sparkles|✨|openrouter|\/ai\//i.test(src(f)), f + ': no sparkle, no AI');
});

check('immersive worlds: one display preference, default immersive, never the browser Fullscreen API', () => {
  const display = src('lib/ui/worldDisplay.ts'), frame = src('components/layout/ApplicationFrame.tsx');
  assert.match(display, /const serverMode = \(\): WorldDisplay => 'immersive'/);
  assert.ok(!/requestFullscreen/.test(display + src('components/features/cosmos/CosmosPage.tsx') + src('components/features/learning-path/odyssey/OdysseyPage.tsx')));
  assert.match(frame, /<main[\s\S]{0,240}world\s*\?\s*'flex-1 min-h-0 overflow-hidden'[\s\S]{0,200}'flex-1 overflow-y-auto'/, 'the same <main> in both modes: the canvas is never remounted');
  assert.match(src('components/features/cosmos/CosmosPage.tsx'), /data-testid="world-display-toggle"/);
  assert.match(src('components/features/learning-path/odyssey/OdysseyPage.tsx'), /data-testid="world-display-toggle"/);
});

check('@mentions: the name typed, members found without marks, spans where the name stands, segments never trusted blindly', () => {
  const same = (a, b, m) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);
  same(kit.mentionQuery('hi @Min', 7), { start: 3, query: 'Min' });
  assert.equal(kit.mentionQuery('mail@host', 9), null, 'an "@" inside a word is not a mention');
  assert.equal(kit.mentionQuery('hi @a\nb', 7), null, 'never across lines');
  const people = [{ id: 1, name: 'Bạn' }, { id: 2, name: 'Nguyễn Minh Ánh', username: 'anh.ng' }, { id: 3, name: 'Đức' }];
  same(kit.mentionMatches(people, 'anh', 1).map(p => p.id), [2], 'any word, without marks; the writer left out');
  same(kit.mentionMatches(people, 'duc', 1).map(p => p.id), [3], 'đ folds to d');
  same(kit.mentionMatches(people, 'anh.n', 1).map(p => p.id), [2], 'by @username');
  const body = 'hey @Nguyễn Minh Ánh and @Đức, @Đức again';
  same(kit.mentionSpans(body, [{ id: 3, name: 'Đức' }, { id: 2, name: 'Nguyễn Minh Ánh' }]), [{ id: 2, at: 4, len: 16 }, { id: 3, at: 25, len: 4 }]);
  same(kit.mentionSpans('mail@Đức', [{ id: 3, name: 'Đức' }]), [], 'inside a word: no mention');
  same(kit.mentionSpans('@Đứcx', [{ id: 3, name: 'Đức' }]), [], 'a longer word is not the name');
  same(kit.mentionSegments('a @B c', [{ id: 9, at: 2, len: 2 }]), [{ text: 'a ' }, { text: '@B', id: 9 }, { text: ' c' }]);
  same(kit.mentionSegments('a xB c', [{ id: 9, at: 2, len: 2 }]), [{ text: 'a xB c' }], 'a span that does not start with "@" is plain text');
  same(kit.mentionSegments('ab', [{ id: 9, at: 1, len: 5 }]), [{ text: 'ab' }], 'out of range: plain text');
  const store = src('lib/messenger/store.ts'), thread = src('components/messenger/Thread.tsx'), parts = src('components/messenger/MessageParts.tsx');
  assert.match(store, /calledMe = !!m\.payload\?\.mentions\?\.some\(x => x\.id === s\.me\)/, 'a mention shows its card even in a muted group');
  assert.match(store, /\(!known\?\.muted \|\| calledMe\)/);
  assert.match(thread, /role=\{group \? 'combobox' : undefined\}/, 'the field announces its member list');
  assert.match(parts, /data-testid="msgr-mention"/);
});

check('message toolbar: a bridge over the gap, a pause before it fades, level with the rendered bubble; filter chips scroll with a slim bar', () => {
  const css = src('components/messenger/messenger.module.css'), parts = src('components/messenger/MessageParts.tsx');
  assert.match(css, /\.actions::before \{ content: ''; position: absolute; top: -10px; bottom: -10px; right: 100%; width: 14px; \}/);
  assert.match(css, /\.row\[data-mine\] \.actions::before \{ right: auto; left: 100%; \}/);
  assert.match(css, /transition: opacity \.14s ease \.22s, visibility 0s linear \.36s;/, 'hidden only after a short pause');
  assert.match(css, /top: var\(--act-y, 50%\)/);
  assert.match(parts, /--act-y/, 'measured from the rendered bubble');
  assert.ok(!/\.chips[^{]*\{[^}]*scrollbar-width: none/.test(css), 'the chips row never hides its scrollbar');
  assert.ok(!/\.chips \{[^}]*mask-image/.test(css), 'no mask fading the last chip');
  assert.match(css, /\.chips \{[^}]*overflow-x: auto;[^}]*scrollbar-width: thin;/);
});

console.log(`Echo Messenger + worlds: ${passed} contract groups passed`);
