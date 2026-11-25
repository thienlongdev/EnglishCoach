'use client';
import {useEffect,useRef,useState} from 'react';
import {Copy,Link as LinkIcon,Send,Users,X} from 'lucide-react';
import {messengerApi} from '@/services/messengerApi';
import {onMessenger} from '@/lib/messenger/bus';
import type {ArenaInvite,MessengerPerson} from '@/types/messenger';
import type {ArenaState} from '@/types/speakingArena';
import s from './arena.module.css';

export default function ArenaInvitations({room,vi,open,setOpen}:{room:ArenaState;vi:boolean;open:boolean;setOpen:(v:boolean)=>void}){
  const tr=(vn:string,en:string)=>vi?vn:en;
  const url=new URL('/speaking/arena',location.origin);url.searchParams.set('join',room.code);
  const [notice,setNotice]=useState(''),[fallback,setFallback]=useState(''),[friends,setFriends]=useState<MessengerPerson[]>([]),[more,setMore]=useState(false);
  const [invites,setInvites]=useState<ArenaInvite[]>([]),[selected,setSelected]=useState<number[]>([]),[busy,setBusy]=useState(false),[retry,setRetry]=useState(0),[loading,setLoading]=useState(false);
  const gate=useRef(false),dialog=useRef<HTMLDialogElement>(null);
  const host=room.self===room.host,slots=room.capacity-room.players.length;
  const waiting=(i:ArenaInvite)=>i.status==='PENDING'&&Date.parse(i.expiresAt)>Date.now();
  const merge=(v:ArenaInvite)=>setInvites(all=>[v,...all.filter(x=>x.id!==v.id)]);
  useEffect(()=>{
    if(!open)return;
    let alive=true,revision=0;dialog.current?.showModal();setLoading(true);setNotice('');
    const refresh=()=>{const seq=++revision;void messengerApi.roomInvites(room.roomId).then(list=>{if(alive&&seq===revision)setInvites(list)}).catch(()=>{if(alive)setNotice(tr('Không tải được lời mời.','Could not load invitations.'))});};
    const off=onMessenger(e=>{if(e.type==='CONNECTED'||e.type==='INVITE'||(e.type==='MESSAGE'&&e.message.invite))refresh()});
    refresh();void messengerApi.people().then(p=>{if(alive){setFriends(p.friends);setMore(!!p.moreFriends)}}).catch(()=>{if(alive)setNotice(tr('Không tải được bạn bè. Bạn vẫn có thể gửi liên kết.','Could not load friends. You can still share the link.'))}).finally(()=>{if(alive)setLoading(false)});
    return()=>{alive=false;off()};
  },[open,room.roomId,retry]);
  async function copy(value:string){try{await navigator.clipboard.writeText(value);setFallback('');setNotice(tr('Đã sao chép.','Copied.'))}catch{setFallback(value);setNotice(tr('Chọn và sao chép bên dưới.','Select and copy below.'))}}
  const eligible=(id:number)=>!room.players.some(p=>p.userId===id)&&!invites.some(i=>i.inviteeId===id&&waiting(i));
  async function send(){
    if(gate.current||!host)return;gate.current=true;setBusy(true);let failed=0;
    for(const id of selected.filter(eligible).slice(0,slots)){try{const c=await messengerApi.open(id);const m=await messengerApi.invite(c.id,crypto.randomUUID(),room.mode,room.roomId);if(m.invite)merge(m.invite);setSelected(ids=>ids.filter(x=>x!==id));}catch{failed++;}}
    setNotice(failed?tr('Một số lời mời chưa gửi được.','Some invitations could not be sent.'):tr('Đã gửi lời mời.','Invitations sent.'));gate.current=false;setBusy(false);
  }
  const status:Record<string,string>={PENDING:tr('Đang chờ','Pending'),ACCEPTED:tr('Đã nhận','Accepted'),CANCELLED:tr('Đã hủy','Cancelled'),DECLINED:tr('Đã từ chối','Declined'),EXPIRED:tr('Hết hạn','Expired'),CLOSED:tr('Đã đóng','Closed')};
  return <div className={s.invites}>
    <small>{room.inviteOnly?tr('Chỉ người được mời','Invite only'):room.publicMatch?tr('Ghép công khai','Public matching'):tr('Phòng riêng · vào bằng mã','Private · join by code')}</small>
    <div>{tr('Mã phòng','Room code')} <strong data-testid="arena-room-code">{room.code}</strong></div>
    <div className={s.shareActions}><button onClick={()=>void copy(room.code)}><Copy/>{tr('Sao chép mã','Copy code')}</button>
    {!room.inviteOnly&&<><button onClick={()=>void copy(url.href)}><LinkIcon/>{tr('Sao chép liên kết','Copy invite link')}</button>
    {typeof navigator.share==='function'&&<button onClick={()=>void navigator.share({title:room.title||'Speaking Arena',url:url.href}).catch(e=>{if(e.name!=='AbortError')void copy(url.href)})}><Send/>{tr('Chia sẻ','Share')}</button>}</>}
    {host&&<button onClick={()=>setOpen(true)}><Users/>{tr('Mời bạn bè','Invite friends')}</button>}</div>
    {!open&&<span role="status">{notice}</span>}{fallback&&<input aria-label={tr('Sao chép thủ công','Copy manually')} readOnly value={fallback} onFocus={e=>e.target.select()}/>}
    {open&&<dialog ref={dialog} className={s.dialog} onClose={()=>setOpen(false)} aria-labelledby="arena-invite-title">
      <div className={s.row}><h2 id="arena-invite-title">{tr('Mời bạn vào phòng','Invite friends')}</h2><button autoFocus aria-label={tr('Đóng','Close')} onClick={()=>dialog.current?.close()}><X/></button></div>
      <p>{room.title||room.code} · {slots} {tr('chỗ trống','open seats')}</p>
      {loading?<p role="status">{tr('Đang tải bạn bè…','Loading friends…')}</p>:friends.length===0?<p>{tr('Chưa có bạn bè để mời.','No friends available to invite.')}</p>:null}
      <div className={s.friendList}>{friends.map(f=><label key={f.id}><input type="checkbox" checked={selected.includes(f.id)&&eligible(f.id)} disabled={busy||!eligible(f.id)||(!selected.includes(f.id)&&selected.length>=slots)} onChange={e=>setSelected(ids=>e.target.checked?[...ids,f.id]:ids.filter(x=>x!==f.id))}/>{f.name}{room.players.some(p=>p.userId===f.id)&&' · '+tr('Trong phòng','Joined')}</label>)}</div>
      {more&&<button onClick={()=>void messengerApi.people(friends.length).then(p=>{setFriends(old=>[...new Map([...old,...p.friends].map(f=>[f.id,f])).values()]);setMore(!!p.moreFriends)}).catch(()=>setNotice(tr('Không tải được danh sách.','Could not load the list.')))}>{tr('Xem thêm','Load more')}</button>}
      <button className={s.primary} disabled={busy||!slots||!selected.some(eligible)} onClick={()=>void send()}>{tr('Gửi lời mời','Send invitations')} · {selected.filter(eligible).length}</button>
      {invites.map(i=><div className={s.inviteRow} key={i.id}><b>{friends.find(f=>f.id===i.inviteeId)?.name??tr('Bạn bè','Friend')}</b><span>{status[i.status==='PENDING'&&!waiting(i)?'EXPIRED':i.status]}</span>
      {waiting(i)&&<button onClick={()=>void messengerApi.cancel(i.id).then(merge).catch(()=>setNotice(tr('Không hủy được lời mời.','Could not cancel invitation.')))}>{tr('Hủy','Cancel')}</button>}</div>)}
      <span role="status">{notice}</span>{notice&&<button onClick={()=>setRetry(n=>n+1)}>{tr('Làm mới','Refresh')}</button>}
    </dialog>}
  </div>;
}
