/**
 * FLIP for the diagrams that move words or boxes (transform, agent, lab). Each moving element carries `data-flip="<identity>"`
 * and sits inside a `position: relative` container, so `offsetLeft / offsetTop` are the element's layout place inside it and are
 * not affected by the `translate` that animates it. The animation is a Web Animation on the individual `translate` / `scale` /
 * `opacity` properties with no fill mode: nothing is left behind when it ends or is cancelled.
 */
export interface Box { x: number; y: number; w: number; h: number; text: string }

export function measureFlip(container: HTMLElement): Map<string, Box> {
  const found = new Map<string, Box>();
  container.querySelectorAll<HTMLElement>('[data-flip]').forEach((el) => {
    const key = el.dataset.flip;
    if (key) found.set(key, { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight, text: el.textContent ?? '' });
  });
  return found;
}

export interface FlipResult { entered: string[]; left: Box[] }

/**
 * Move every element that was there before from its old place to its new one; fade in the ones that are new. Returns the keys
 * that entered and the boxes of those that left (the caller may draw a fading ghost for them).
 */
export function playFlip(container: HTMLElement, before: Map<string, Box>, after: Map<string, Box>, duration = 520): FlipResult {
  const entered: string[] = [];
  const left: Box[] = [];
  before.forEach((box, key) => { if (!after.has(key)) left.push(box); });
  container.querySelectorAll<HTMLElement>('[data-flip]').forEach((el) => {
    const key = el.dataset.flip;
    if (!key) return;
    const now = after.get(key);
    const was = before.get(key);
    if (!now) return;
    if (!was) {
      entered.push(key);
      el.animate([{ opacity: 0, scale: '0.82' }, { opacity: 1, scale: '1' }], { duration: Math.round(duration * 0.7), delay: Math.round(duration * 0.35), easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' });
      return;
    }
    const dx = was.x - now.x;
    const dy = was.y - now.y;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
    el.animate([{ translate: `${dx}px ${dy}px` }, { translate: '0 0' }], { duration, easing: 'cubic-bezier(.22,.9,.24,1)' });
  });
  return { entered, left };
}
