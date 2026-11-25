'use client';
import React,{useEffect,useRef,useState} from 'react';
import {Mic,MicOff,Users,Headphones,Copy,LogOut} from 'lucide-react';
import type {Room} from 'livekit-client';
import {apiClient} from '@/services/api-client';
import {subscribeAuthLifecycle,authEnding} from '@/lib/auth-lifecycle';
import {holdMusicFocus} from '@/lib/music/focus';
import {Panel} from './panels';
import {useNow} from './useNow';
import s from './studySpace.module.css';

type Person={id:number;name:string;host:boolean;online:boolean;canSpeak:boolean;voiceIdentity:string};
type SharedRoom={id:string;name:string;self:number;host:number;serverNow:number;expiresAt:number;revision:number;voiceAvailable:boolean;worldAvailable?:boolean;timer:{status:string;durationMs:number;remainingMs:number;deadline:number};people:Person[]};
const B='/study-space/shared';
const consentKey=(learner:number)=>'ec_echo_life_city_room:v1:u'+learner;
function forgetCity(room:SharedRoom|null) {
  if(room)try {sessionStorage.removeItem(consentKey(room.self));} catch { /* Storage can be unavailable. */ }
}
const messagesVi:Record<string,string>={ROOM_FULL:'Phòng đã đủ người.',ROOM_NOT_FOUND:'Phòng đã kết thúc hoặc bạn không có quyền vào.',ALREADY_IN_ROOM:'Bạn đang ở một phòng khác. Hãy rời phòng đó trước.',HOST_REQUIRED:'Chỉ chủ phòng được điều khiển.',VOICE_UNAVAILABLE:'Voice hiện chưa khả dụng. Bạn vẫn có thể học yên lặng.',STALE_REVISION:'Phòng vừa thay đổi. Đã lấy trạng thái mới; hãy thử lại.'};
const messagesEn:Record<string,string>={ROOM_FULL:'This room is full.',ROOM_NOT_FOUND:'This room has ended or you do not have access.',ALREADY_IN_ROOM:'You are already in another room. Leave it first.',HOST_REQUIRED:'Only the room host can control this.',VOICE_UNAVAILABLE:'Voice is currently unavailable. You can still study together silently.',STALE_REVISION:'Room state updated. Please try again.'};

interface SharedStudyProps {
  open: boolean; onClose: () => void; onInvite: () => void; world3d: boolean;
  cityRoom: {room: string; learner: number} | null;
  onCityRoom: (room: {room: string; learner: number; clockOffset:number} | null) => void;
  cityConnection: import('./world/echoLife/sharedCity').CityConnection;
  vi?: boolean;
}
export default function SharedStudy({open,onClose,onInvite,world3d,cityRoom,cityConnection,onCityRoom,vi=true}:SharedStudyProps){
  const messages = vi ? messagesVi : messagesEn;
  const [room,setRoom]=useState<SharedRoom|null>(null),[title,setTitle]=useState(vi ? 'Cùng nhau tập trung' : 'Focus Together'),[invite,setInvite]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [minutes,setMinutes]=useState(25),[offset,setOffset]=useState(0),[online,setOnline]=useState(true),[voiceStatus,setVoiceStatus]=useState('off'),[mic,setMic]=useState(false),[muted,setMuted]=useState<string[]>([]);
  const roomRef=useRef(room),media=useRef<Room|null>(null),audioHost=useRef<HTMLDivElement>(null),generation=useRef(0),micWork=useRef(false),mounted=useRef(true);
  const releaseMusic=useRef<(()=>void)|null>(null);
  const mutedRef=useRef(muted);mutedRef.current=muted;
  roomRef.current=room;
  const accept=(next:SharedRoom|null)=>{if(!mounted.current)return;setRoom(next);if(next)setOffset(next.serverNow-Date.now());setOnline(true);};
  const stopVoice=()=>{generation.current++;const r=media.current;media.current=null;void r?.disconnect(true);audioHost.current?.replaceChildren();releaseMusic.current?.();releaseMusic.current=null;setMic(false);setVoiceStatus('off');};
  const failure=(e:unknown)=>{const code=(e as {response?:{data?:{code?:string}}}).response?.data?.code;setError(messages[code??'']??(vi?'Chưa thực hiện được. Hãy kiểm tra kết nối rồi thử lại.':'Action failed. Check your connection and try again.'));};
  const action=async(fn:()=>Promise<void>)=>{if(busy)return;setBusy(true);setError('');try{await fn();}catch(e){failure(e);}finally{setBusy(false);}};
  useEffect(()=>{
    mounted.current=true;let cancelled=false;
    void apiClient.get<SharedRoom|null>(`${B}/current`).then(r=>{if(!cancelled)accept(r.data||null);}).catch(()=>{});
    const token=new URLSearchParams(location.hash.slice(1)).get('study-invite');if(token&&/^[a-f0-9]{32}$/.test(token)){setInvite(token);onInvite();history.replaceState(null,'',location.pathname+location.search);}
    const off=subscribeAuthLifecycle(()=>{if(authEnding()){forgetCity(roomRef.current);stopVoice();}});
    return ()=>{cancelled=true;mounted.current=false;off();stopVoice();const current=roomRef.current;if(current&&!authEnding())void apiClient.post(`${B}/${current.id}/leave`).catch(()=>{});};
  },[]); // One membership for the mounted study space; closing its panel does not leave.
  useEffect(()=>{
    if(!room?.id)return;let cancelled=false,running=false;
    const heartbeat=async()=>{if(running)return;running=true;try{const r=await apiClient.post<SharedRoom>(`${B}/${room.id}/heartbeat`);if(!cancelled)accept(r.data);}catch(e){if(!cancelled){setOnline(false);stopVoice();if((e as {response?:{status:number}}).response?.status===404){setRoom(null);setError(vi?'Phòng đã kết thúc hoặc bạn đã rời phòng.':'This room ended or you left it.');}}}finally{running=false;}};
    // Panel open: 5 s for snappy timer/member controls; background exploring: 12 s (safe under 25 s OFFLINE, cuts DB load 60 %).
    const intervalMs = open ? 5000 : 12000;
    const timer=setInterval(()=>void heartbeat(),intervalMs);return()=>{cancelled=true;clearInterval(timer);};
  },[room?.id, open]);
  const me=room?.people.find(p=>p.id===room.self);
  const sharing = !!cityRoom && cityRoom.room === room?.id && cityRoom.learner === room.self;
  useEffect(() => {
    if (!room?.worldAvailable || !world3d) {
      if (cityRoom) onCityRoom(null);
      return;
    }
    if (sharing) return;
    // Reconfirm membership before restoring this tab's opt-in after a reconnect or reload.
    let remembered=false;
    try {remembered=sessionStorage.getItem(consentKey(room.self))===room.id;} catch { /* In-memory opt-in still works. */ }
    if (remembered) onCityRoom({room:room.id,learner:room.self,clockOffset:offset});
    else if (cityRoom) onCityRoom(null);
  }, [cityRoom, sharing, room?.id, room?.self, room?.worldAvailable, world3d, onCityRoom]);
  useEffect(()=>{if(media.current&&(!online||!me||media.current.localParticipant.identity!==me.voiceIdentity))stopVoice();if(!me?.canSpeak&&media.current){void media.current.localParticipant.setMicrophoneEnabled(false);setMic(false);}},[me?.voiceIdentity,me?.canSpeak,online]);
  const toggleCity=()=>{
    if (!room) return;
    if (sharing) forgetCity(room);
    else try {sessionStorage.setItem(consentKey(room.self),room.id);} catch { /* The current mount retains consent. */ }
    onCityRoom(sharing?null:{room:room.id,learner:room.self,clockOffset:offset});
  };
  const connect=()=>void action(async()=>{
    if(!room)return;stopVoice();releaseMusic.current=holdMusicFocus('study-voice');const version=++generation.current;setVoiceStatus('connecting');
    const {Room,RoomEvent,Track}=await import('livekit-client');if(version!==generation.current||!mounted.current)return;
    const r=new Room({audioCaptureDefaults:{echoCancellation:true,noiseSuppression:true,autoGainControl:true,channelCount:1},publishDefaults:{audioPreset:{maxBitrate:32000},dtx:true,stopMicTrackOnMute:true}});media.current=r;
    r.on(RoomEvent.TrackSubscribed,(track,_,participant)=>{if(track.kind!==Track.Kind.Audio||!roomRef.current?.people.some(p=>p.voiceIdentity===participant.identity))return;const el=track.attach();el.dataset.identity=participant.identity;el.autoplay=true;el.muted=mutedRef.current.includes(participant.identity);audioHost.current?.appendChild(el);});
    r.on(RoomEvent.TrackUnsubscribed,track=>track.detach().forEach(el=>el.remove()));
    r.on(RoomEvent.Reconnecting,()=>setVoiceStatus('reconnecting'));r.on(RoomEvent.Reconnected,()=>setVoiceStatus('connected'));r.on(RoomEvent.Disconnected,()=>{if(media.current===r){media.current=null;releaseMusic.current?.();releaseMusic.current=null;audioHost.current?.replaceChildren();setVoiceStatus('off');setMic(false);}});
    try{const ticket=await apiClient.post<{url:string;token:string}>(`${B}/${room.id}/voice`);if(version!==generation.current||authEnding()){await r.disconnect();return;}await r.connect(ticket.data.url,ticket.data.token);if(version!==generation.current||authEnding()){await r.disconnect(true);return;}await r.startAudio();setVoiceStatus('connected');}
    catch(e){stopVoice();throw e;}
  });
  const toggleMic=async()=>{
    const r=media.current;if(!r||!me?.canSpeak||micWork.current)return;micWork.current=true;setError('');const next=!mic,version=generation.current;
    try{await r.localParticipant.setMicrophoneEnabled(next);if(version!==generation.current||!roomRef.current?.people.find(p=>p.id===roomRef.current?.self)?.canSpeak||authEnding()){await r.localParticipant.setMicrophoneEnabled(false);return;}setMic(next);}catch{setError(vi?'Không mở được micro. Kiểm tra quyền micro của trình duyệt.':'Could not open microphone. Check browser permissions.');}finally{micWork.current=false;}
  };
  const now=useNow(500)+offset;
  const left=room?Math.max(0,room.timer.status==='running'?room.timer.deadline-now:room.timer.remainingMs):0;
  const timer=(actionName:string)=>void action(async()=>{if(room)accept((await apiClient.post<SharedRoom>(`${B}/${room.id}/timer`,{action:actionName,minutes,revision:room.revision})).data);});
  const moderate=(participant:number,actionName:string)=>void action(async()=>{if(room)accept((await apiClient.post<SharedRoom>(`${B}/${room.id}/moderate`,{participant,action:actionName})).data);});
  return <><div ref={audioHost} hidden/>{open&&<Panel title={vi ? 'Học cùng nhau' : 'Study Together'} closeLabel={vi ? 'Đóng' : 'Close'} icon={<Users size={20}/>} onClose={onClose}>
    <div className={s.sharedStudy}>
      <p className={s.hint}>{vi ? 'Phòng chia sẻ tên, trạng thái kết nối và đồng hồ. Nội thất, ghi chú, việc cần làm và tài liệu vẫn riêng tư. Không ghi âm.' : 'Rooms share your display name, online status, and focus timer. Furniture, notes, tasks, and documents stay private. No audio is recorded.'}</p>
      {error&&<p role="alert" className={s.scheduleConflict}>{error}</p>}
      {!room?<div className={s.cols}>
        <form className={s.card} onSubmit={e=>{e.preventDefault();void action(async()=>{const r=await apiClient.post<{room:SharedRoom;invite:string}>(B,{name:title,capacity:8});accept(r.data.room);});}}>
          <label className={s.field}>{vi ? 'Tên phòng' : 'Room name'}<input required maxLength={80} className={s.input} value={title} onChange={e=>setTitle(e.target.value)}/></label><button disabled={busy} className={`${s.btn} ${s.primary}`}>{vi ? 'Tạo phòng học' : 'Create study room'}</button>
        </form>
        <form className={s.card} onSubmit={e=>{e.preventDefault();void action(async()=>{accept((await apiClient.post<SharedRoom>(`${B}/join`,{invite})).data);});}}>
          <label className={s.field}>{vi ? 'Mã lời mời' : 'Invite code'}<input required className={s.input} value={invite} maxLength={32} onChange={e=>setInvite(e.target.value.trim())}/></label><button disabled={busy} className={s.btn}>{vi ? 'Tham gia phòng' : 'Join room'}</button>
        </form>
      </div>:<>
        <div className={s.fieldRow}><h2 className={s.panelTitle}>{room.name}</h2><span className={s.chip}>{online?(vi?'Đã kết nối':'Connected'):(vi?'Đang kết nối lại…':'Reconnecting…')}</span>
          {room.host===room.self&&<button type="button" className={s.btn} disabled={busy} onClick={()=>void action(async()=>{const r=await apiClient.get<{invite:string}>(`${B}/${room.id}/invite`);await navigator.clipboard.writeText(`${location.origin}/study-space#study-invite=${r.data.invite}`);setError(vi?'Đã sao chép lời mời. Chỉ gửi cho người bạn muốn học cùng.':'Invite link copied. Share it only with study partners you trust.');})}><Copy size={15}/> {vi ? 'Sao chép lời mời' : 'Copy invite'}</button>}
          <button type="button" className={`${s.btn} ${s.danger}`} disabled={busy} onClick={()=>void action(async()=>{if(room.host===room.self&&!confirm(vi?'Kết thúc phòng cho mọi người?':'End this room for everyone?'))return;stopVoice();await apiClient.post(`${B}/${room.id}/leave`);forgetCity(room);onCityRoom(null);setRoom(null);})}><LogOut size={15}/>{room.host===room.self?(vi?'Kết thúc phòng':'End room'):(vi?'Rời phòng':'Leave room')}</button>
        </div>
        <div className={s.sharedClock} role="timer" aria-live="off">{String(Math.floor(left/60000)).padStart(2,'0')}:{String(Math.floor(left/1000)%60).padStart(2,'0')}</div>
        <p className={s.hint} style={{textAlign:'center'}}>{room.timer.status==='running'?(vi?'Đang tập trung':'Focusing'):room.timer.status==='paused'?(vi?'Đang tạm dừng':'Paused'):room.timer.status==='finished'?(vi?'Đã hết phiên':'Session complete'):(vi?'Sẵn sàng học cùng nhau':'Ready to study together')} · {vi ? 'Thời gian được đồng bộ với chủ phòng' : 'Timer synced with host'}</p>
        {room.host===room.self&&<div className={s.fieldRow} style={{justifyContent:'center'}}><label className={s.field}>{vi ? 'Phút' : 'Minutes'}<input type="number" min={5} max={180} className={s.input} style={{width:96}} value={minutes} onChange={e=>setMinutes(+e.target.value)}/></label><button className={s.btn} disabled={busy||room.timer.status==='running'} onClick={()=>timer('configure')}>{vi ? 'Đặt thời lượng' : 'Set length'}</button><button className={`${s.btn} ${s.primary}`} disabled={busy||!online} onClick={()=>timer(room.timer.status==='running'?'pause':'start')}>{room.timer.status==='running'?(vi?'Tạm dừng':'Pause'):(vi?'Bắt đầu':'Start')}</button><button className={s.btn} disabled={busy} onClick={()=>timer('reset')}>{vi ? 'Đặt lại' : 'Reset'}</button></div>}
        {world3d && room.worldAvailable && <section className={s.card}>
          <h3>{vi ? 'Khám phá thành phố cùng nhau' : 'Explore Riverside Together'}</h3>
          <p className={s.hint}>{vi ? 'Khi bật, những người cùng bật trong phòng có thể thấy nhân vật và cử chỉ của bạn tại cùng địa điểm công cộng.' : 'When enabled, opted-in room members can see your character and emotes in public districts.'}</p>
          <button type="button" className={s.btn} disabled={!online && !sharing} aria-pressed={sharing} onClick={toggleCity}>
            {sharing ? (vi ? 'Dừng chia sẻ vị trí' : 'Stop sharing city location') : (vi ? 'Chia sẻ vị trí trong thành phố' : 'Share location in city')}
          </button>
          {sharing && <span role="status">{cityConnection === 'connected' ? (vi ? 'Đã kết nối' : 'Connected') : cityConnection === 'full' ? (vi ? 'Thành phố chung đang đầy — đang thử lại…' : 'Shared city is full — retrying…') : cityConnection === 'offline' ? (vi ? 'Mất kết nối' : 'Disconnected') : (vi ? 'Đang kết nối…' : 'Connecting…')}</span>}
        </section>}
        <div className={s.participantGrid}>{room.people.map(p=><div key={p.id} className={s.card}>
          <div className={s.fieldRow}><span className={s.participantAvatar} aria-hidden="true">{p.name.slice(0,1).toLocaleUpperCase(vi?'vi':'en')}</span><b>{p.name}</b></div>
          <p className={s.hint}>{p.host?(vi?'Chủ phòng · ':'Host · '):''}{p.online?(vi?'Đang ở đây':'Online'):(vi?'Mất kết nối tạm thời':'Temporarily offline')}{!p.canSpeak?(vi?' · Micro bị khóa':' · Mic muted'):''}</p>
          {p.id!==room.self&&<div className={s.fieldRow}><button className={s.btn} onClick={()=>{const isMuted=!muted.includes(p.voiceIdentity);setMuted(m=>isMuted?[...m,p.voiceIdentity]:m.filter(x=>x!==p.voiceIdentity));audioHost.current?.querySelectorAll<HTMLAudioElement>('audio').forEach(el=>{if(el.dataset.identity===p.voiceIdentity)el.muted=isMuted;});}}>{muted.includes(p.voiceIdentity)?(vi?'Nghe lại':'Unmute locally'):(vi?'Tắt tiếng phía tôi':'Mute locally')}</button>
            {room.host===room.self&&<><button disabled={busy} className={s.btn} onClick={()=>moderate(p.id,p.canSpeak?'mute':'unmute')}>{p.canSpeak?(vi?'Khóa micro':'Mute mic'):(vi?'Cho phép micro':'Allow mic')}</button><button disabled={busy} className={`${s.btn} ${s.danger}`} onClick={()=>moderate(p.id,'remove')}>{vi ? 'Mời rời phòng' : 'Remove'}</button></>}
          </div>}
        </div>)}</div>
        <div className={s.fieldRow} style={{justifyContent:'center'}}>
          {voiceStatus==='off'?<button disabled={busy||!room.voiceAvailable||!online} className={s.btn} onClick={connect}><Headphones size={16}/> {vi ? 'Kết nối voice' : 'Join voice'}</button>:<><span className={s.chip}>{voiceStatus==='connected'?(vi?'Voice đã kết nối':'Voice connected'):voiceStatus==='reconnecting'?(vi?'Voice đang kết nối lại…':'Voice reconnecting…'):(vi?'Đang kết nối voice…':'Connecting voice…')}</span><button className={s.btn} disabled={voiceStatus!=='connected'||!me?.canSpeak} aria-pressed={mic} onClick={()=>void toggleMic()}>{mic?<Mic size={16}/>:<MicOff size={16}/>} {mic?(vi?'Tắt micro':'Mute mic'):(vi?'Bật micro':'Unmute mic')}</button><button className={s.btn} onClick={()=>void action(async()=>{stopVoice();await apiClient.post(`${B}/${room.id}/voice/leave`);})}>{vi ? 'Ngắt voice' : 'Leave voice'}</button></>}
        </div>
        {!room.voiceAvailable&&<p className={s.hint}>{vi ? 'Voice chưa khả dụng. Phòng vẫn hoạt động để học yên lặng cùng nhau.' : 'Voice is unavailable right now. Silent shared study still works.'}</p>}
      </>}
    </div>
  </Panel>}</>;
}
