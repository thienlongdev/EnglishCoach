'use client';
import { useEffect, useRef, useState, useCallback } from 'react';
import { getListeningCheckpoint, saveListeningCheckpoint } from '@/services/listeningWorkspaceApi';
import { mergeListeningCheckpoint } from '@/lib/listeningCheckpoint';
import { authEpoch, assertAuthEpoch, authEnding } from '@/lib/auth-lifecycle';
import type { ListeningCheckpoint, ListeningWorkspaceState } from '@/types/listening';

const empty = (): ListeningWorkspaceState => ({ entries: {} });
type Journal = ListeningCheckpoint & { base: ListeningWorkspaceState; dirty: boolean };
export function useListeningCheckpoint(user: string, lesson: number | null) {
    const [state, setState] = useState<ListeningWorkspaceState>(empty);
    const [ready, setReady] = useState(false);
    const [message, setMessage] = useState('');
    const [saving, setSaving] = useState(false);
    const [hasProgress, setHasProgress] = useState(false);
    const [retry,setRetry]=useState(0);
    const journal = useRef<Journal | null>(null);
    const inFlight = useRef<Promise<void> | null>(null);
    const trailingSave = useRef<ReturnType<typeof setTimeout> | null>(null);
    const saveRef=useRef<()=>Promise<void>>(async()=>{});
    const blocked = useRef(false);
    const epoch = useRef(authEpoch());
    const localKey = `ec_listening_checkpoint:v1:${encodeURIComponent(user)}:${lesson}`;
    const persistLocal = useCallback(() => {
        if (!journal.current || authEnding() || epoch.current !== authEpoch()) return;
        try { localStorage.setItem(localKey, JSON.stringify(journal.current)); } catch { setMessage('Không thể lưu trên thiết bị. Hãy dùng Lưu tiến độ.'); }
    }, [localKey]);
    const save = useCallback(async () => {
        if (inFlight.current) { await inFlight.current; return; }
        const work = async () => {
            if (!lesson || !journal.current?.dirty || blocked.current) return;
            setSaving(true); persistLocal();
            let saved=false;
            try {
                // Drain edits made during a request without permitting out-of-order writes.
                while (journal.current?.dirty && !blocked.current) {
                    const sent: Journal = journal.current;
                    try {
                        const result = await saveListeningCheckpoint(lesson, sent.contentVersion, sent.revision, sent.state);
                        assertAuthEpoch(epoch.current);
                        const latest: Journal = journal.current!;
                        const dirty=latest.state!==sent.state;
                        journal.current = { ...result, state: dirty?latest.state:result.state, base: result.state, dirty };
                        if(!dirty)setState(result.state);
                        persistLocal();setMessage('Đã lưu tiến độ.');
                        saved=true;
                        break; // Edits made during I/O get a fresh debounce, never a request-per-response typing loop.
                    } catch (error: any) {
                        if (error?.response?.status !== 409) throw error;
                        const remote = await getListeningCheckpoint(lesson);assertAuthEpoch(epoch.current);
                        if (remote.contentVersion !== sent.contentVersion) { blocked.current = true;setMessage('Transcript đã đổi. Bản nháp cũ được giữ riêng trên thiết bị; tải lại bài nghe.');break; }
                        const merged = mergeListeningCheckpoint(sent.base, journal.current!.state, remote.state);
                        if (merged.conflicts.length) { blocked.current = true;setMessage('Một phiên khác đã sửa cùng câu. Bản nháp trên thiết bị được giữ an toàn. Tải lại để đồng bộ.');break; }
                        journal.current = { ...remote, state: merged.state, base: remote.state, dirty: true };
                        setState(merged.state);persistLocal();
                    }
                }
            } catch { if (epoch.current === authEpoch()) setMessage('Chưa lưu lên tài khoản. Bản nháp vẫn được giữ trên thiết bị; sẽ thử lại khi có mạng.'); }
            finally {
                if (epoch.current === authEpoch()) {
                    setSaving(false);
                    if(saved&&journal.current?.dirty&&!blocked.current){
                        if(trailingSave.current)clearTimeout(trailingSave.current);
                        trailingSave.current=setTimeout(()=>{trailingSave.current=null;void saveRef.current();},1800);
                    }
                }
            }
        };
        const promise = work();inFlight.current = promise;
        await promise;inFlight.current = null;
    }, [lesson, persistLocal]);
    saveRef.current=save;
    useEffect(() => {
        let live = true;epoch.current = authEpoch();blocked.current = false;setReady(false);
        if (!lesson) return;
        getListeningCheckpoint(lesson).then(remote => {
            if (!live) return;assertAuthEpoch(epoch.current);
            let local: Journal | null = null;
            try { const raw = localStorage.getItem(localKey); if (raw && raw.length < 3100000) local = JSON.parse(raw); } catch { /* Server remains authoritative. */ }
            let selected = remote.state;let dirty = false;
            if (local?.contentVersion === remote.contentVersion && local.dirty && local.state?.entries && local.base) {
                const merged = mergeListeningCheckpoint(local.base, local.state, remote.state);
                if (merged.conflicts.length) {
                    // Archive the conflicting draft before using account progress; never silently overwrite it.
                    try { localStorage.setItem(`${localKey}:recovery:${Date.now()}`, JSON.stringify(local)); } catch { /* Original key is retained until user edits. */ }
                    setMessage('Đã đồng bộ tiến độ tài khoản. Có bản nháp khác trên thiết bị: chọn Khôi phục bản nháp để xem lại.');
                } else { selected = merged.state;dirty = true; }
            } else if (local && local.contentVersion !== remote.contentVersion) {
                try { localStorage.setItem(`${localKey}:version:${local.contentVersion}`, JSON.stringify(local)); } catch { /* Do not map old drafts to new text. */ }
                setMessage('Transcript đã cập nhật. Bản nháp phiên bản cũ được giữ riêng để tránh gắn nhầm câu.');
            }
            journal.current = { ...remote, state: selected, base: remote.state, dirty };
            setState(selected);setHasProgress(!!selected.selectedSegmentId || Object.keys(selected.entries).length > 0);setReady(true);
        }).catch(() => { if (live) setMessage('Chưa thể tải tiến độ tài khoản. Thử lại khi có mạng; bản nháp cũ vẫn được giữ.'); });
        return () => { live = false; persistLocal(); };
    }, [lesson, localKey, persistLocal,retry]);
    useEffect(()=>{const reconnect=()=>{if(!journal.current)setRetry(value=>value+1);};window.addEventListener('online',reconnect);return()=>window.removeEventListener('online',reconnect);},[]);
    const update = useCallback((change: (previous: ListeningWorkspaceState) => ListeningWorkspaceState) => {
        if (!journal.current || epoch.current !== authEpoch()) return;
        const next = change(journal.current.state);
        if(trailingSave.current){clearTimeout(trailingSave.current);trailingSave.current=null;}
        journal.current = { ...journal.current, state: next, dirty: true };
        setState(next);persistLocal();
    }, [persistLocal]);
    useEffect(() => {
        if (!ready) return;
        const timer = setTimeout(() => { void save(); }, 1800);
        return () => clearTimeout(timer);
    }, [state, ready, save]);
    useEffect(() => {
        const flush = () => { persistLocal();void save(); };
        const visibility = () => { if (document.hidden) flush(); };
        window.addEventListener('pagehide', flush);window.addEventListener('online', flush);document.addEventListener('visibilitychange', visibility);
        // Unmount starts a best-effort flush; synchronous local journalling already protects the draft.
        return () => { window.removeEventListener('pagehide', flush);window.removeEventListener('online', flush);document.removeEventListener('visibilitychange', visibility);if(trailingSave.current)clearTimeout(trailingSave.current);flush(); };
    }, [save, persistLocal]);
    const recoverLocal = () => {
        const keys = Object.keys(localStorage).filter(k => k.startsWith(`${localKey}:recovery:`)).sort();
        const key = keys.at(-1);if (!key || !journal.current) return;
        try {
            const recovery: Journal = JSON.parse(localStorage.getItem(key)!);
            if (recovery.contentVersion !== journal.current.contentVersion) return;
            // An explicit recovery is a learner decision; completed status remains monotonic.
            const entries = { ...journal.current.state.entries };
            for (const [id, value] of Object.entries(recovery.state.entries)) entries[id] = { ...value, status: entries[id]?.status === 'completed' ? 'completed' : value.status };
            blocked.current = false;update(prev => ({ ...prev, entries }));setMessage('Bản nháp đã khôi phục. Lưu tiến độ để đồng bộ.');
        } catch { setMessage('Chưa thể khôi phục bản nháp.'); }
    };
    return { state, ready, hasProgress, update, save, saving, message, recoverLocal, retry:()=>setRetry(value=>value+1) };
}
