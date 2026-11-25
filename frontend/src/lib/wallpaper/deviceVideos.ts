/**
 * Hình nền — background videos the learner attached FROM THIS DEVICE to a saved YouTube entry ("Tệp trên thiết bị").
 *
 * The file never leaves the browser: it is kept in IndexedDB, one database per signed-in account
 * (`ec-wallpaper-v1-u<id>`, the My Books ownership policy), keyed by the saved entry's server id, and played by the
 * background engine through a `blob:` URL (CSP `media-src blob:`). The server only learns the file's NAME (so another
 * device can say where the video is). Another account on the same browser has its own database; signing out leaves
 * the files for when the same account returns. No upload, no request, no analytics.
 */
const VERSION = 1;
const STORE = 'videos';

/** Largest file accepted (a background loop; the browser's storage quota still applies). */
export const MAX_DEVICE_VIDEO_BYTES = 500 * 1024 * 1024;
/** Files kept per account on one device. */
export const MAX_DEVICE_VIDEOS = 10;

const VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime', 'video/x-m4v']);
const VIDEO_NAME = /\.(mp4|m4v|webm|mov)$/i;

export interface StoredDeviceVideo {
  blob: Blob;
  name: string;
  type: string;
  size: number;
  savedAt: number;
}

export type DeviceVideoCheck = { ok: true } | { ok: false; reason: 'type' | 'size' | 'empty' };

export function checkDeviceVideo(file: { name: string; type: string; size: number }): DeviceVideoCheck {
  if (!file.size) return { ok: false, reason: 'empty' };
  if (file.size > MAX_DEVICE_VIDEO_BYTES) return { ok: false, reason: 'size' };
  if (!VIDEO_TYPES.has(file.type) && !VIDEO_NAME.test(file.name)) return { ok: false, reason: 'type' };
  return { ok: true };
}

export function deviceVideoDbName(userId: string | number): string {
  return `ec-wallpaper-v1-u${String(userId).replace(/[^\w-]/g, '')}`;
}

export class DeviceVideoQuotaError extends Error {
  constructor() {
    super('quota');
    this.name = 'DeviceVideoQuotaError';
  }
}

function req<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new DOMException('Transaction aborted', 'AbortError'));
    tx.onerror = () => reject(tx.error);
  });
}

async function open(userId: string | number): Promise<IDBDatabase> {
  const id = String(userId).replace(/[^\w-]/g, '');
  if (!id) throw new Error('signed-in account required');
  if (typeof indexedDB === 'undefined') throw new Error('IndexedDB unavailable');
  const request = indexedDB.open(deviceVideoDbName(id), VERSION);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
  };
  const db = await req(request);
  db.onversionchange = () => db.close();
  return db;
}

async function withStore<T>(userId: string | number, mode: IDBTransactionMode, work: (store: IDBObjectStore) => Promise<T> | T): Promise<T> {
  const db = await open(userId);
  try {
    const tx = db.transaction(STORE, mode);
    const result = await work(tx.objectStore(STORE));
    await done(tx);
    return result;
  } finally {
    db.close();
  }
}

export async function listDeviceVideoEntryIds(userId: string | number): Promise<string[]> {
  return withStore(userId, 'readonly', (store) => req(store.getAllKeys()).then((keys) => keys.map(String)));
}

export async function getDeviceVideo(userId: string | number, entryId: string): Promise<StoredDeviceVideo | null> {
  const value = await withStore(userId, 'readonly', (store) => req(store.get(entryId) as IDBRequest<StoredDeviceVideo | undefined>));
  return value && value.blob instanceof Blob ? value : null;
}

/**
 * Keeps `file` for the entry (replacing an earlier one) and returns when it was kept. Throws DeviceVideoQuotaError when
 * the browser is out of space.
 */
export async function putDeviceVideo(userId: string | number, entryId: string, file: File): Promise<number> {
  const check = checkDeviceVideo(file);
  if (!check.ok) throw new Error(check.reason);
  const existing = await listDeviceVideoEntryIds(userId);
  if (!existing.includes(entryId) && existing.length >= MAX_DEVICE_VIDEOS) throw new Error('count');
  const record: StoredDeviceVideo = { blob: file, name: file.name, type: file.type || 'video/mp4', size: file.size, savedAt: Date.now() };
  try {
    await withStore(userId, 'readwrite', (store) => req(store.put(record, entryId)).then(() => undefined));
    return record.savedAt;
  } catch (error) {
    const name = (error as { name?: string })?.name;
    if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') throw new DeviceVideoQuotaError();
    throw error;
  }
}

export async function deleteDeviceVideo(userId: string | number, entryId: string): Promise<void> {
  await withStore(userId, 'readwrite', (store) => req(store.delete(entryId)).then(() => undefined));
}
