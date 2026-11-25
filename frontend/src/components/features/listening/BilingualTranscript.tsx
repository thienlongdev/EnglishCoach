'use client';
import { useEffect, useRef, useState } from 'react';
import { getListeningTranslations, saveListeningTranslations } from '@/services/listeningWorkspaceApi';
import { acceptableTranslation, leaveFreeTranslator, subscribeFreeTranslator, translateFree, type FreeEngine, type FreeTranslatorStatus } from '@/lib/listening/freeTranslator';
import { InteractiveTranscript } from './InteractiveTranscript';
import type { TranscriptSegment, SegmentHeatmapDto } from '@/types/listening';
import { useLanguage } from '@/context/LanguageContext';
import { glass as s } from './glass/ListeningGlass';

const FLUSH_SIZE = 8;
const FLUSH_MS = 2500;

/** English first, Vietnamese below. Saved pairs show at once; missing ones are translated on this device in the
 *  background (visible rows, then the playing row and what follows) and stored for next time. No button, no paid call. */
export function BilingualTranscript({ lessonId, segments, currentTime, isPlaying, onSegmentClick, heatmapData }: {
    lessonId: number;segments: TranscriptSegment[];currentTime: number;isPlaying: boolean;
    onSegmentClick: (ms: number) => void;heatmapData?: SegmentHeatmapDto[];
}) {
    const { locale } = useLanguage();const vi=locale==='vi';
    const [translations,setTranslations]=useState<Record<string,string>>({});
    const [selectedId,setSelectedId]=useState<number>();
    const [engineStatus,setEngineStatus]=useState<FreeTranslatorStatus>({phase:'idle'});
    const [working,setWorking]=useState(false);
    const [engineUsed,setEngineUsed]=useState<FreeEngine>();
    const wrapper=useRef<HTMLDivElement>(null);
    const visible=useRef(new Set<string>());
    const timeRef=useRef(currentTime);timeRef.current=currentTime;
    const segmentsRef=useRef(segments);segmentsRef.current=segments;

    useEffect(()=>subscribeFreeTranslator(setEngineStatus),[]);

    // Rows on screen go first.
    useEffect(()=>{
        const root=wrapper.current;if(!root||typeof IntersectionObserver==='undefined')return;
        const observer=new IntersectionObserver(entries=>entries.forEach(e=>{const id=e.target.id.replace('segment-','');if(e.isIntersecting)visible.current.add(id);else visible.current.delete(id);}));
        root.querySelectorAll('[id^="segment-"]').forEach(row=>observer.observe(row));
        return()=>{observer.disconnect();visible.current.clear();};
    },[segments]);

    useEffect(()=>{
        let alive=true;let releaseLock:()=>void=()=>{};
        const channel=typeof BroadcastChannel!=='undefined'?new BroadcastChannel('ec-listening-translations'):null;
        const merge=(pairs:Record<string,string>)=>{if(alive)setTranslations(previous=>({...previous,...pairs}));};
        let version='';const known:Record<string,string>={};const tried=new Set<string>();
        channel&&(channel.onmessage=({data})=>{if(data?.lessonId===lessonId){Object.assign(known,data.pairs);merge(data.pairs);}});
        const buffers=new Map<FreeEngine,Record<string,string>>();let flushTimer:ReturnType<typeof setTimeout>|undefined;
        const flush=async()=>{
            clearTimeout(flushTimer);flushTimer=undefined;
            for(const [engine,pairs] of [...buffers]){
                buffers.delete(engine);if(!Object.keys(pairs).length)continue;
                try{const saved=await saveListeningTranslations(lessonId,version,engine,pairs);Object.assign(known,saved.translations);merge(saved.translations);channel?.postMessage({lessonId,pairs:saved.translations});}
                catch{/* kept on screen; the next visit translates what was not stored */}
            }
        };
        const onHide=()=>{if(document.visibilityState==='hidden')void flush();};
        const nextMissing=()=>{
            const list=segmentsRef.current;const t=timeRef.current*1000;
            let active=list.findIndex(seg=>typeof seg.startTimeMs==='number'&&seg.startTimeMs>t)-1;if(active<0)active=t>0&&list.length?list.length-1:0;
            let best:TranscriptSegment|undefined;let bestKey=Infinity;
            list.forEach((seg,i)=>{
                const id=String(seg.id);if(known[id]||tried.has(id)||!seg.text?.trim())return;
                const key=(visible.current.has(id)?0:1e6)+(i>=active?i-active:list.length+active-i);
                if(key<bestKey){bestKey=key;best=seg;}
            });
            return best;
        };
        const generate=async()=>{
            if(!alive||!nextMissing())return;
            setWorking(true);
            try{
                for(let seg=nextMissing();seg&&alive;seg=nextMissing()){
                    const id=String(seg.id);tried.add(id);
                    let result;
                    try{result=await translateFree(seg.text);}catch(error){if((error as {fatal?:boolean}).fatal)break;continue;}
                    if(!result)break;
                    if(!alive)break;
                    const clean=acceptableTranslation(result.text,seg.text);if(!clean)continue;
                    if(alive)setEngineUsed(result.engine);
                    known[id]=clean;merge({[id]:clean});
                    const buffer=buffers.get(result.engine)??{};buffer[id]=clean;buffers.set(result.engine,buffer);
                    if(Object.keys(buffer).length>=FLUSH_SIZE)await flush();else if(!flushTimer)flushTimer=setTimeout(()=>void flush(),FLUSH_MS);
                }
            } finally {await flush();if(alive)setWorking(false);}
        };
        document.addEventListener('visibilitychange',onHide);
        void getListeningTranslations(lessonId).then(cached=>{
            if(!alive)return;
            version=cached.contentVersion;Object.assign(known,cached.translations);merge(cached.translations);
            if(!nextMissing())return;
            // One tab per lesson translates; another tab waits and receives the pairs over the channel.
            const locks=(navigator as Navigator&{locks?:{request:(name:string,cb:()=>Promise<void>)=>Promise<void>}}).locks;
            if(locks)void locks.request(`ec-listening-translate:${lessonId}`,()=>alive?new Promise<void>(resolve=>{releaseLock=resolve;void generate().finally(resolve);}):Promise.resolve()).catch(()=>{});
            else void generate();
        }).catch(()=>{/* English stays usable; saved pairs load on the next visit */});
        return()=>{alive=false;releaseLock();void flush();document.removeEventListener('visibilitychange',onHide);channel?.close();setWorking(false);leaveFreeTranslator();};
    },[lessonId]);

    const notice=engineStatus.phase==='unavailable'
        ?(engineStatus.reason==='save-data'
            ?(vi?'Đang bật tiết kiệm dữ liệu: bản dịch tiếng Việt mới sẽ tự tạo khi tắt chế độ này.':'Data saver is on: new Vietnamese lines will be made once it is off.')
            :(vi?'Thiết bị này chưa tạo được bản dịch tiếng Việt; các câu đã dịch vẫn hiển thị và phần còn lại sẽ tự dịch ở lần sau.':'This device cannot translate right now; saved lines stay and the rest will be translated on a later visit.'))
        :working&&(engineStatus.phase==='preparing'||engineStatus.phase==='downloading')
            ?(vi?'Đang chuẩn bị bản dịch tiếng Việt trên thiết bị (chỉ lần đầu)…':'Preparing Vietnamese translation on this device (first time only)…')
            :'';
    const pending=working&&engineStatus.phase!=='unavailable';
    // data-* attributes: observable state for QA only (no styling depends on them).
    return <div ref={wrapper} className={s.bilingualFlow} data-translation-phase={engineStatus.phase} data-translation-engine={engineUsed}>
        {notice&&<p role="status" className={s.saveMessage}>{notice}</p>}
        <InteractiveTranscript segments={segments} currentTime={currentTime} isPlaying={isPlaying} onSegmentClick={onSegmentClick} heatmapData={heatmapData} isBilingual translations={translations} translationPending={pending}
            selectedSegmentId={segments.every(seg=>typeof seg.startTimeMs!=='number'||typeof seg.endTimeMs!=='number'||seg.endTimeMs<=seg.startTimeMs)?selectedId:undefined} onSegmentSelect={setSelectedId}/>
    </div>;
}
