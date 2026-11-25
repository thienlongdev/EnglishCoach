function seconds(value) {
  const parts = value.trim().replace(',', '.').split(':');
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !p || !Number.isFinite(Number(p))))
    return NaN;
  return parts.reduce((total, p) => total * 60 + Number(p), 0);
}
export function parseCues(source) {
  const input = String(source)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (input.length > 1024 * 1024) throw Error('Tệp quá lớn. Hãy chọn một đoạn ngắn hơn 1 MB.');
  const cues = [];
  for (const block of input.split(/\n[ \t]*\n/)) {
    const lines = block.split('\n');
    if (/^(NOTE(?: |$)|STYLE$|REGION$)/.test(lines[0])) continue;
    const idx = lines.findIndex((l) => l.includes('-->'));
    if (idx < 0) continue;
    const match = /^\s*((?:\d+:)?\d{1,2}:\d{2}[,.]\d{1,3})\s+-->\s+((?:\d+:)?\d{1,2}:\d{2}[,.]\d{1,3})/.exec(
      lines[idx],
    );
    if (!match) continue;
    const start = seconds(match[1]),
      end = seconds(match[2]);
    const text = lines
      .slice(idx + 1)
      .join(' ')
      .replace(/<[^>]*>/g, '')
      .replace(/&(?:amp|lt|gt|nbsp);/g, (k) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&nbsp;': ' ' })[k])
      .trim()
      .slice(0, 1400);
    if (text && end > start && start >= 0) cues.push({ start, end, text });
    if (cues.length >= 2500) break;
  }
  if (!cues.length && !input.includes('-->') && !/^WEBVTT/.test(input))
    return input
      .split(/\n+/)
      .filter(Boolean)
      .slice(0, 250)
      .map((text) => ({ text: text.trim().slice(0, 1400), start: null, end: null }));
  return cues.sort((a, b) => a.start - b.start);
}
export function cueIndex(cues, time) {
  let lo = 0,
    hi = cues.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start === null || cues[mid].start > time) hi = mid - 1;
    else lo = mid + 1;
  }
  return hi >= 0 && time < cues[hi].end ? hi : -1;
}
export const normalizeAnswer = (text) =>
  String(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .match(/[a-z0-9]+(?:'[a-z]+)*/g)
    ?.join(' ') || '';
export function exercise(text, mode) {
  const words = normalizeAnswer(text).split(' ').filter(Boolean);
  if (!words.length) return null;
  if (mode === 'blank') {
    const answer = words.reduce((a, b) => (b.length > a.length ? b : a), words[0]);
    return { prompt: words.map((w) => (w === answer ? '_____' : w)).join(' '), answer };
  }
  if (mode === 'order') return { tiles: words.slice(1).concat(words[0]), answer: words.join(' ') };
  return { prompt: 'Nghe và gõ lại câu vừa nghe.', answer: words.join(' ') };
}
