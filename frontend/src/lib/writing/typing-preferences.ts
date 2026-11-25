export type VisibleTypingLines = 2 | 3 | 4;
export const typingLinesKey = 'ec_typing_visible_lines_v1';
export function readTypingLines(storage?: Pick<Storage, 'getItem'>): VisibleTypingLines {
  try {
    const value = (storage ?? window.localStorage).getItem(typingLinesKey);
    return value === '3' ? 3 : value === '4' ? 4 : 2;
  } catch { return 2; }
}
export function saveTypingLines(value: VisibleTypingLines) {
  try { window.localStorage.setItem(typingLinesKey, String(value)); } catch { /* Practice works without storage. */ }
}
