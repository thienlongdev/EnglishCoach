/**
 * Portable focus timer: the same session shown outside the room. Where the browser supports Document
 * Picture-in-Picture (Chromium 116+), a small always-on-top window is opened from the learner's click and the React
 * timer is rendered into it (same JS realm, same FocusEngine, no second timer). Elsewhere a small popup window opens
 * `/study-space/timer`, which reads the same shared state. A page cannot keep a window above every application on
 * every system: the Picture-in-Picture window does that only where the browser offers it.
 */

type Listener = () => void;
let pip: Window | null = null;
const listeners = new Set<Listener>();
const emit = () => listeners.forEach((l) => l());

export const pipWindow = () => pip;
export function subscribePip(l: Listener) { listeners.add(l); return () => { listeners.delete(l); }; }

interface DocumentPiP { requestWindow(opts: { width: number; height: number; disallowReturnToOpener?: boolean }): Promise<Window> }
const docPip = (): DocumentPiP | null => (typeof window !== 'undefined' && 'documentPictureInPicture' in window ? (window as unknown as { documentPictureInPicture: DocumentPiP }).documentPictureInPicture : null);

export const pipSupported = () => !!docPip();

/** Must run inside a click (both APIs need a user gesture). */
export async function openPortableTimer(): Promise<'pip' | 'popup' | 'blocked'> {
  const api = docPip();
  if (api) {
    try {
      if (pip && !pip.closed) { pip.focus(); return 'pip'; }
      const w = await api.requestWindow({ width: 300, height: 340 });
      const doc = w.document;
      doc.title = 'Đồng hồ tập trung';
      const style = doc.createElement('style');
      style.textContent = `html,body{margin:0;height:100%;font-family:Quicksand,ui-sans-serif,system-ui,sans-serif;background:linear-gradient(160deg,#f6f4ff,#e7ecff);color:#23264a}
        @media (prefers-color-scheme: dark){html,body{background:linear-gradient(160deg,#1b1d3f,#121433);color:#eef0ff}}
        body{display:grid;place-items:center} button{font-family:inherit}`;
      doc.head.appendChild(style);
      // the app's own fonts (same-origin stylesheets) so the digits match
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          const href = (sheet as CSSStyleSheet).href;
          if (href && new URL(href).origin === location.origin) { const link = doc.createElement('link'); link.rel = 'stylesheet'; link.href = href; doc.head.appendChild(link); }
        } catch { /* cross-origin sheet: skipped */ }
      }
      const mount = doc.createElement('div');
      mount.id = 'ec-focus-pip';
      doc.body.appendChild(mount);
      pip = w;
      w.addEventListener('pagehide', () => { pip = null; emit(); });
      emit();
      return 'pip';
    } catch {
      // fall through to the popup
    }
  }
  const popup = window.open('/study-space/timer', 'ec-focus-timer', 'popup,width=320,height=400');
  return popup ? 'popup' : 'blocked';
}

export function closePortableTimer() { pip?.close(); pip = null; emit(); }
