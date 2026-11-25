/**
 * Mouse-look as three separate facts, so nothing in the world can switch it off by accident:
 * what the player asked for (`desired`), what the browser holds right now (`locked`), and whether something on screen needs a cursor.
 *
 * Doors, drawers, lamps, picking up, gestures, sitting and standing never touch it. A panel that needs the cursor takes the lock
 * and gives it back. The browser allows that return without a click because we released it ourselves; if it refuses (focus went
 * away, a page rule), `needsResume` asks for one click. Esc, or the player's own toggle, is a choice: nothing relocks until they ask.
 */
export interface MouseLookState { desired: boolean; locked: boolean; needsResume: boolean; cursorRequired: boolean }

export class MouseLook {
  desired = false;
  needsResume = false;
  private overlays = new Set<string>();
  /** Claims the player may overrule by asking for mouse-look: a timer left open beside the room. */
  private soft = new Set<string>();
  private selfRelease = false;
  private pending = false;
  private disposed = false;

  constructor(private element: HTMLElement, private changed: (state: MouseLookState) => void) {
    document.addEventListener('pointerlockchange', this.onChange);
    document.addEventListener('pointerlockerror', this.onError);
    window.addEventListener('focus', this.onFocus);
  }

  get locked() { return document.pointerLockElement === this.element; }
  get cursorRequired() { return this.overlays.size > 0; }
  get state(): MouseLookState { return { desired: this.desired, locked: this.locked, needsResume: this.needsResume, cursorRequired: this.cursorRequired }; }

  private tell() { if (!this.disposed) this.changed(this.state); }

  private acquire() {
    if (this.disposed || this.locked || this.pending || this.overlays.size) return;
    this.pending = true;
    try {
      this.element.focus({ preventScroll: true });
      const result = (this.element as HTMLElement & { requestPointerLock(): Promise<void> | void }).requestPointerLock?.();
      if (result && typeof (result as Promise<void>).then === 'function') {
        (result as Promise<void>).then(() => { this.pending = false; }, () => { this.pending = false; this.refused(); });
      } else this.pending = false;
    } catch { this.pending = false; this.refused(); }
  }
  private refusedOnce: (() => void) | null = null;
  private refused() { const once = this.refusedOnce; this.refusedOnce = null; once?.(); if (this.desired) { this.needsResume = true; this.tell(); } }

  /** The player's own wish: the toolbar button, or one click on the resume control. Needs a user gesture. */
  enable(onRefused?: () => void) {
    this.refusedOnce = onRefused ?? null;
    for (const token of this.soft) this.overlays.delete(token);
    this.soft.clear();
    this.desired = true; this.needsResume = false; this.acquire(); this.tell();
  }
  disable() {
    this.desired = false; this.needsResume = false;
    if (this.locked) { this.selfRelease = true; document.exitPointerLock(); }
    this.tell();
  }
  toggle() { if (this.locked || this.desired) this.disable(); else this.enable(); }
  /** A plain click on the world while mouse-look is waiting to come back. */
  resume() { if (this.desired && !this.locked) { this.needsResume = false; this.acquire(); this.tell(); } }

  /** Something on screen needs a pointer (`on`), or no longer does. Named, so two panels cannot release each other's claim. */
  cursorNeeded(token: string, on: boolean, soft = false) {
    const had = this.overlays.has(token);
    if (on === had) return;
    if (on) {
      this.overlays.add(token);
      if (soft) this.soft.add(token);
      if (this.locked) { this.selfRelease = true; document.exitPointerLock(); }
    } else {
      this.overlays.delete(token);
      this.soft.delete(token);
      if (!this.overlays.size && this.desired) this.acquire();
    }
    this.tell();
  }

  /** Leaving this world, or a view with no mouse-look at all: the wish is dropped with it. */
  suspend() { this.disable(); }

  private onChange = () => {
    if (this.locked) { this.refusedOnce = null; this.needsResume = false; this.selfRelease = false; this.tell(); return; }
    if (this.selfRelease) { this.selfRelease = false; this.tell(); return; }
    // The browser took it. With the tab in focus that was Esc: a choice. Otherwise the window went away, and the wish stays.
    if (document.hidden || !document.hasFocus()) this.needsResume = this.desired;
    else { this.desired = false; this.needsResume = false; }
    this.tell();
  };
  private onError = () => { this.pending = false; this.refused(); };
  private onFocus = () => { if (this.desired && !this.locked && !this.overlays.size) { this.needsResume = true; this.tell(); } };

  dispose() {
    this.disposed = true;
    document.removeEventListener('pointerlockchange', this.onChange);
    document.removeEventListener('pointerlockerror', this.onError);
    window.removeEventListener('focus', this.onFocus);
    if (this.locked) document.exitPointerLock();
  }
}

// The same choice follows the player between compatible worlds. Never take pointer lock on mount.
export function prefersFreePointer(){try{return localStorage.getItem('ec_study_pointer:v1')==='1';}catch{return false;}}
export function rememberFreePointer(free:boolean){try{if(free)localStorage.setItem('ec_study_pointer:v1','1');else localStorage.removeItem('ec_study_pointer:v1');}catch{}}
