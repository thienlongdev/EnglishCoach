/** A temporary view of the existing appearance stores. It never writes global preferences. */
export type AppearanceTheme = 'system' | 'light' | 'dark';
type Scope = { id: string; values: Record<string, unknown>; onChange: (values: Record<string, unknown>) => void };
let active: Scope | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());
export const scopedPreference = <T>(key: string): T | undefined => active?.values[key] as T | undefined;
export function writeScopedPreference(key: string, value: unknown): boolean {
  if (!active || !(key in active.values)) return false;
  active.values = { ...active.values, [key]: value };
  active.onChange(active.values);
  emit();
  return true;
}
export function subscribeAppearanceScope(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }
export function beginAppearanceScope(id: string, values: Record<string, unknown>, onChange: Scope['onChange']) {
  active = { id, values, onChange };
  paintTheme(readAppearanceTheme());
  emit();
  return () => {
    if (active?.id !== id) return;
    active = null;
    paintTheme(readAppearanceTheme());
    emit();
  };
}
export function syncAppearanceScope(id: string, values: Record<string, unknown>) {
  if (active?.id !== id || JSON.stringify(active.values) === JSON.stringify(values)) return;
  active.values = values;
  paintTheme(readAppearanceTheme());
  emit();
}
export function readAppearanceTheme(): AppearanceTheme {
  const scoped = scopedPreference<AppearanceTheme>('theme');
  if (scoped) return scoped;
  try { const v = localStorage.getItem('theme'); return v === 'light' || v === 'dark' ? v : 'system'; } catch { return 'system'; }
}
function paintTheme(theme: AppearanceTheme) {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('dark', theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches));
}
export function applyAppearanceTheme(theme: AppearanceTheme) {
  if (!writeScopedPreference('theme', theme)) {
    try { if (theme === 'system') localStorage.removeItem('theme'); else localStorage.setItem('theme', theme); } catch { /* page-local choice */ }
  }
  paintTheme(theme);
}
