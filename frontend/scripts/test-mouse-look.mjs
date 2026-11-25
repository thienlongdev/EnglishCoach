// Mouse-look as three separate facts: what the player asked for, what the browser holds, whether something on screen needs a cursor.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url), babel = require('next/dist/compiled/babel/bundle.js');
const read = rel => readFileSync(new URL('../src/' + rel, import.meta.url), 'utf8');

function world() {
  const listeners = { doc: {}, win: {} };
  const on = bag => (name, fn) => { (bag[name] ??= []).push(fn); };
  const off = bag => (name, fn) => { bag[name] = (bag[name] ?? []).filter(f => f !== fn); };
  const fire = (bag, name) => { for (const fn of bag[name] ?? []) fn(); };
  const refuse = { now: false };
  const document = {
    pointerLockElement: null, hidden: false, focused: true,
    hasFocus() { return this.focused; },
    addEventListener: on(listeners.doc), removeEventListener: off(listeners.doc),
    exitPointerLock() { this.pointerLockElement = null; fire(listeners.doc, 'pointerlockchange'); },
  };
  const window = { addEventListener: on(listeners.win), removeEventListener: off(listeners.win) };
  const element = {
    focus() {},
    requestPointerLock() {
      if (refuse.now) { fire(listeners.doc, 'pointerlockerror'); return; }
      document.pointerLockElement = element; fire(listeners.doc, 'pointerlockchange');
    },
  };
  const { code } = babel.core().transformSync(read('lib/embodiment/mouseLook.ts'), { filename: 'mouseLook.ts', configFile: false, babelrc: false, presets: [babel.presetTypescript()], plugins: [babel.pluginTransformModulesCommonjs()] });
  const module = { exports: {} };
  runInNewContext(code, { module, exports: module.exports, document, window, console });
  const look = new module.exports.MouseLook(element, () => {});
  /** The browser takes the lock away by itself: Esc, or the window losing focus. */
  const browserTook = () => { document.pointerLockElement = null; fire(listeners.doc, 'pointerlockchange'); };
  const refocus = () => fire(listeners.win, 'focus');
  return { look, document, refuse, browserTook, refocus };
}

// A panel that needs the cursor takes the lock and gives it back, without a click.
{
  const { look } = world();
  look.enable();
  assert.equal(look.locked, true); assert.equal(look.desired, true);
  look.cursorNeeded('panel', true);
  assert.equal(look.locked, false, 'a panel frees the cursor');
  assert.equal(look.desired, true, 'the wish survives the panel');
  look.cursorNeeded('panel', false);
  assert.equal(look.locked, true, 'closing it brings mouse-look back by itself');
}
// Two panels cannot release each other's claim.
{
  const { look } = world();
  look.enable();
  look.cursorNeeded('a', true); look.cursorNeeded('b', true);
  look.cursorNeeded('a', false);
  assert.equal(look.locked, false, 'one still open');
  look.cursorNeeded('b', false);
  assert.equal(look.locked, true);
}
// Esc is a choice: nothing relocks until the player asks.
{
  const { look, browserTook } = world();
  look.enable();
  browserTook();
  assert.equal(look.desired, false); assert.equal(look.needsResume, false);
  look.cursorNeeded('panel', true); look.cursorNeeded('panel', false);
  assert.equal(look.locked, false, 'a panel closing after Esc does not grab the mouse');
  look.resume();
  assert.equal(look.locked, false, 'a click on the world after Esc does not either');
  look.enable();
  assert.equal(look.locked, true, 'the toolbar button does');
}
// The player's own toggle is a choice too.
{
  const { look } = world();
  look.toggle(); assert.equal(look.locked, true);
  look.toggle(); assert.equal(look.locked, false); assert.equal(look.desired, false);
  look.cursorNeeded('panel', true); look.cursorNeeded('panel', false);
  assert.equal(look.locked, false);
}
// The window going away is not a choice: one click brings it back.
{
  const { look, document, browserTook, refocus } = world();
  look.enable();
  document.focused = false;
  browserTook();
  assert.equal(look.desired, true); assert.equal(look.needsResume, true);
  document.focused = true; refocus();
  look.resume();
  assert.equal(look.locked, true); assert.equal(look.needsResume, false);
}
// A browser that refuses to give it back asks for one click, and the wish stays.
{
  const { look, refuse } = world();
  look.enable();
  look.cursorNeeded('panel', true);
  refuse.now = true;
  look.cursorNeeded('panel', false);
  assert.equal(look.locked, false); assert.equal(look.desired, true); assert.equal(look.needsResume, true);
  refuse.now = false;
  look.resume();
  assert.equal(look.locked, true);
}
// A soft claim (the timer open beside the room) gives way when the player asks for mouse-look.
{
  const { look } = world();
  look.cursorNeeded('focus', true, true);
  look.enable();
  assert.equal(look.locked, true); assert.equal(look.cursorRequired, false);
}
// Nothing in either world lets go of the lock on its own: only MouseLook touches the browser's pointer lock.
for (const file of ['components/study-space/world/exploration.ts', 'components/study-space/StudySpace.tsx', 'components/features/speaking/arena/ArenaScene.tsx', 'components/features/speaking/arena/ArenaExperience.tsx']) {
  const source = read(file);
  assert.equal(/exitPointerLock|requestPointerLock/.test(source), false, file + ' must go through MouseLook');
}
const exploration = read('components/study-space/world/exploration.ts');
const interact = exploration.slice(exploration.indexOf('interact('), exploration.indexOf('interact(') + 600);
assert.equal(/mouseLook\.(disable|suspend|toggle)|unlock\(/.test(interact), false, 'a world interaction keeps mouse-look');
assert.match(read('components/features/speaking/arena/ArenaScene.tsx'), /cursorNeeded\('menu'/, 'an Arena menu frees the cursor while it is open');
console.log('mouse look: all checks pass');
