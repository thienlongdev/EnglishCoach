import { musicDatabaseName, MAX_LIBRARY_BYTES, MAX_FILE_BYTES, MAX_TRACKS } from './model';
import type { MusicTrack, StoredTrack } from './model';

async function database(scope: string): Promise<IDBDatabase> {
  const name = musicDatabaseName(scope);
  if (typeof indexedDB === 'undefined') throw new Error('STORAGE_UNAVAILABLE');
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('tracks', { keyPath: 'id' });
      db.createObjectStore('settings');
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('STORAGE_BLOCKED'));
    request.onsuccess = () => resolve(request.result);
  });
}
async function transaction<T>(scope: string, store: string, mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database(scope);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    let result: T;
    const req = operation(tx.objectStore(store));
    req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => { db.close(); resolve(result); };
    tx.onabort = tx.onerror = () => { db.close(); reject(tx.error ?? new Error('STORAGE_FAILED')); };
  });
}
export async function listTracks(scope: string): Promise<MusicTrack[]> {
  // A cursor reads one record at a time. Do not retain every audio Blob in React state.
  const db = await database(scope);
  return new Promise((resolve, reject) => {
    const tracks: MusicTrack[] = [];
    const tx = db.transaction('tracks');
    const req = tx.objectStore('tracks').openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      const { file: _file, cover: _cover, importedAt: _at, ...metadata } = cursor.value as StoredTrack;
      tracks.push(metadata); cursor.continue();
    };
    tx.oncomplete = () => { db.close(); resolve(tracks); };
    tx.onabort = tx.onerror = () => { db.close(); reject(tx.error); };
  });
}
export const getTrack = (scope: string, id: string) => transaction<StoredTrack | undefined>(scope, 'tracks', 'readonly', store => store.get(id));
export const deleteTrack = (scope: string, id: string) => transaction(scope, 'tracks', 'readwrite', store => store.delete(id));
export const readSettings = <T>(scope: string) => transaction<T | undefined>(scope, 'settings', 'readonly', store => store.get('playback'));
export const writeSettings = (scope: string, value: unknown) => transaction(scope, 'settings', 'readwrite', store => store.put(value, 'playback'));
export async function saveTrack(scope: string, track: StoredTrack): Promise<void> {
  if (track.source !== 'local' || !track.file.size || track.file.size > MAX_FILE_BYTES) throw new Error('FILE_SIZE');
  // One readwrite transaction makes the count/byte budget atomic, even with two importing tabs.
  const db = await database(scope);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('tracks', 'readwrite');
    const store = tx.objectStore('tracks');
    let count = 0, bytes = 0;
    let reason: Error | null = null;
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) { count++; bytes += (cursor.value as StoredTrack).file.size; cursor.continue(); return; }
      if (count >= MAX_TRACKS || bytes + track.file.size > MAX_LIBRARY_BYTES) { reason = new Error('LIBRARY_FULL'); tx.abort(); return; }
      store.put(track);
    };
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onabort = tx.onerror = () => { db.close(); reject(reason ?? tx.error ?? new Error('STORAGE_FAILED')); };
  });
}
export async function editTrack(scope: string, id: string, title: string, artist: string): Promise<void> {
  const row = await getTrack(scope, id);
  if (!row) throw new Error('FILE_MISSING');
  row.title = title.trim().slice(0, 160) || row.title;
  row.artist = artist.trim().slice(0, 120);
  await transaction(scope, 'tracks', 'readwrite', store => store.put(row));
}
