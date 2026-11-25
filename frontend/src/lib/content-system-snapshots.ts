export const CONTENT_SYSTEM_CACHE_KEY = 'ec_system_today_cards_v1';
export const CONTENT_FRESH_MS = 15 * 60 * 1000;
export const CONTENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const todayContentDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const fields: Record<string, string[]> = {
  '/content/feed': ['id','source','title','url','thumbnail','summary','category','level','readMinutes','publishedAt'],
  '/content/listening/today': ['id','kind','source','title','channel','topic','level','accent','durationSeconds','audioUrl','thumbnail','youtubeVideoId','hasTranscript','deepLink'],
  '/content/dictation/today': ['id','segmentId','source','title','level','accent','topic','durationSeconds','audioUrl','transcriptHidden','startSeconds','endSeconds','deepLink','youtubeVideoId'],
  '/content/vocabulary/daily': ['id','word','lemma','phonetic','meaning','exampleSentence','frequency'],
};
export function contentPaths(date = todayContentDate()) { return ['/content/feed', '/content/listening/today', '/content/dictation/today', `/content/vocabulary/daily?date=${date}`]; }
export function validContentCards(path: string, data: unknown): boolean {
  const base = path.split('?')[0], allowed = fields[base];
  if (!allowed) return false;
  if (data === null) return true;
  const array = base === '/content/feed' || base === '/content/vocabulary/daily';
  const rows = array ? data : [data];
  return Array.isArray(rows) && rows.length <= 100 && rows.every(row => row && typeof row === 'object' && typeof row.id === 'number' &&
    typeof (base.includes('vocabulary') ? row.word : row.title) === 'string' &&
    Object.entries(row).every(([key, value]) => allowed.includes(key) && (value === null || ['string','number','boolean'].includes(typeof value))));
}
export function cardMetadata(path: string, data: any) {
  const allowed = fields[path.split('?')[0]];
  const project = (row: any) => Object.fromEntries(Object.entries(row).filter(([key]) => allowed?.includes(key)));
  return data === null ? null : Array.isArray(data) ? data.map(project) : project(data);
}
export function readContentSnapshots(storage?: Pick<Storage, 'getItem'>, now = Date.now()) {
  try {
    const store = storage ?? (typeof window === 'undefined' ? undefined : window.localStorage);
    const raw = store?.getItem(CONTENT_SYSTEM_CACHE_KEY);
    if (!raw || raw.length > 200000) return undefined;
    const parsed = JSON.parse(raw);
    if (parsed.version !== 1 || parsed.date !== todayContentDate() || !Number.isFinite(parsed.cachedAt) || now < parsed.cachedAt || now - parsed.cachedAt > CONTENT_MAX_AGE_MS ||
      Object.keys(parsed).some(k => !['version','date','cachedAt','data'].includes(k)) || !parsed.data ||
      !Object.entries(parsed.data).every(([path, data]) => validContentCards(path, data))) return undefined;
    return parsed as { version: number; date: string; cachedAt: number; data: Record<string, any> };
  } catch { return undefined; }
}
export function saveContentSnapshot(path: string, data: unknown) {
  if (!validContentCards(path, data) || typeof window === 'undefined') return;
  try {
    const old = readContentSnapshots();
    window.localStorage.setItem(CONTENT_SYSTEM_CACHE_KEY, JSON.stringify({ version: 1, date: todayContentDate(), cachedAt: Date.now(), data: { ...old?.data, [path]: data } }));
  } catch { /* storage denial must not affect the cards */ }
}
