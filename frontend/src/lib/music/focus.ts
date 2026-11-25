// Other audio surfaces can hold focus explicitly, including detached Audio() / microphone sessions.
export function holdMusicFocus(label = 'media'): () => void {
  if (typeof window === 'undefined') return () => {};
  const id = crypto.randomUUID();
  window.dispatchEvent(new CustomEvent('ec:music-focus', { detail: { id, label, active: true } }));
  return () => window.dispatchEvent(new CustomEvent('ec:music-focus', { detail: { id, active: false } }));
}
export function pauseMusicForLearning(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('ec:music-pause'));
}
