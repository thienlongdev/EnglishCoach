/**
 * Stored whole-book page indexes of one book (My Books). Counting the pages of a long book takes seconds; storing
 * the result lets the same book under the same layout show its page numbers at once when it is opened again.
 *
 * One record per book in the library's `prefs` store (`pages:<bookId>`, same per-account database): the pages and
 * chapter starts of each chapter file, by layout signature (engine/flow.ts `signature()` lists what it covers), for
 * at most MAX_LAYOUTS recently used layouts. No book text is stored. A record made for another file (fingerprint) is
 * ignored; the reader checks restored counts against the real layout and drops a record that disagrees. Writes are
 * fire-and-forget: a full or unavailable storage only means counting again next time.
 */
import type { FileCount, PageIndexCache } from "../engine/pageIndex";
import type { BookMeta } from "../engine/types";
import { BookStore } from "./bookStore";

const RECORD_VERSION = 1;
const MAX_LAYOUTS = 6;

interface StoredLayout { sig: string; counts: Array<FileCount | null>; at: number }
interface StoredRecord { v: number; fp: string; layouts: StoredLayout[] }

export async function openPageCache(store: BookStore, meta: BookMeta): Promise<PageIndexCache> {
    const key = BookStore.pageCacheKey(meta.id);
    let record: StoredRecord | undefined;
    try { record = await store.getValue<StoredRecord>(key); } catch { record = undefined; }
    if (!record || record.v !== RECORD_VERSION || record.fp !== meta.fingerprint || !Array.isArray(record.layouts)) {
        record = { v: RECORD_VERSION, fp: meta.fingerprint, layouts: [] };
    }
    const current = record;
    let queue: Promise<void> = Promise.resolve();
    const write = () => {
        const value: StoredRecord = { ...current, layouts: current.layouts.slice() };
        queue = queue.then(() => store.setValue(key, value)).catch(() => undefined);
    };
    return {
        get(sig) {
            const layout = current.layouts.find((l) => l.sig === sig);
            if (layout) layout.at = Date.now();
            return layout?.counts;
        },
        put(sig, counts) {
            current.layouts = [{ sig, counts, at: Date.now() }, ...current.layouts.filter((l) => l.sig !== sig)]
                .sort((a, b) => b.at - a.at).slice(0, MAX_LAYOUTS);
            write();
        },
        drop(sig) {
            const before = current.layouts.length;
            current.layouts = current.layouts.filter((l) => l.sig !== sig);
            if (current.layouts.length !== before) write();
        },
    };
}
