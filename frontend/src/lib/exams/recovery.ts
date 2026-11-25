// IndexedDB local recovery buffer for English Coach Exams

const DB_NAME = 'english_coach_exams_recovery';
const DB_VERSION = 2;

function openDB(): Promise<IDBDatabase | null> {
  if (typeof window === 'undefined' || !window.indexedDB) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (e) => {
        const db = (e.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains('responses')) {
          const store = db.createObjectStore('responses', { keyPath: ['attemptId', 'placementId'] });
          store.createIndex('attemptId', 'attemptId', { unique: false });
        }
        if (!db.objectStoreNames.contains('receipts')) {
          db.createObjectStore('receipts', { keyPath: 'commandId' });
        }
        if (!db.objectStoreNames.contains('media_recordings')) {
          const store = db.createObjectStore('media_recordings', { keyPath: ['attemptId', 'turnKey'] });
          store.createIndex('attemptId', 'attemptId', { unique: false });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function saveLocalResponse(
  attemptId: string,
  placementId: string,
  payload: any,
  revision: number
): Promise<void> {
  const db = await openDB();
  if (!db) return;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction('responses', 'readwrite');
      const store = tx.objectStore('responses');
      store.put({
        attemptId,
        placementId,
        payload,
        revision,
        updatedAt: Date.now(),
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function getLocalResponses(attemptId: string): Promise<Record<string, any>> {
  const db = await openDB();
  if (!db) return {};

  return new Promise((resolve) => {
    try {
      const tx = db.transaction('responses', 'readonly');
      const store = tx.objectStore('responses');
      const index = store.index('attemptId');
      const request = index.getAll(IDBKeyRange.only(attemptId));

      request.onsuccess = () => {
        const result: Record<string, any> = {};
        for (const row of request.result || []) {
          result[row.placementId] = row.payload;
        }
        resolve(result);
      };
      request.onerror = () => resolve({});
    } catch {
      resolve({});
    }
  });
}

export interface LocalRecordingRecovery {
  attemptId: string;
  turnKey: string;
  recordingId: string;
  responseId: string | null;
  acknowledgedChunks: number[];
  totalBytes: number;
  isSealed: boolean;
  updatedAt: number;
}

export async function saveAcknowledgedRecording(data: LocalRecordingRecovery): Promise<void> {
  const db = await openDB();
  if (!db) return;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction('media_recordings', 'readwrite');
      const store = tx.objectStore('media_recordings');
      store.put({
        ...data,
        updatedAt: Date.now(),
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function getAcknowledgedRecording(
  attemptId: string,
  turnKey: string
): Promise<LocalRecordingRecovery | null> {
  const db = await openDB();
  if (!db) return null;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction('media_recordings', 'readonly');
      const store = tx.objectStore('media_recordings');
      const request = store.get([attemptId, turnKey]);

      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function clearAcknowledgedRecording(
  attemptId: string,
  turnKey: string
): Promise<void> {
  const db = await openDB();
  if (!db) return;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction('media_recordings', 'readwrite');
      const store = tx.objectStore('media_recordings');
      const request = store.delete([attemptId, turnKey]);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function clearLocalAttempt(attemptId: string): Promise<void> {
  const db = await openDB();
  if (!db) return;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction('responses', 'readwrite');
      const store = tx.objectStore('responses');
      const index = store.index('attemptId');
      const request = index.openCursor(IDBKeyRange.only(attemptId));

      request.onsuccess = (e) => {
        const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        } else {
          // Also clear media_recordings if store exists
          try {
            if (db.objectStoreNames.contains('media_recordings')) {
              const mtx = db.transaction('media_recordings', 'readwrite');
              const mstore = mtx.objectStore('media_recordings');
              const mindex = mstore.index('attemptId');
              const mreq = mindex.openCursor(IDBKeyRange.only(attemptId));
              mreq.onsuccess = (me) => {
                const mcursor = (me.target as IDBRequest<IDBCursorWithValue>).result;
                if (mcursor) {
                  mcursor.delete();
                  mcursor.continue();
                } else {
                  resolve();
                }
              };
              mreq.onerror = () => resolve();
            } else {
              resolve();
            }
          } catch {
            resolve();
          }
        }
      };
      request.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}
