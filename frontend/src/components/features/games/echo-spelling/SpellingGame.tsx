'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import {useSession} from 'next-auth/react';
import {useLanguage} from '@/context/LanguageContext';
import {useAvatarIdentity,identityWire} from '@/lib/avatar/identity';
import {beginAttempt,sentinelHandle,type SentinelAttempt} from '@/lib/sentinel/client';
import {useFocusLockdown} from '@/components/sentinel/useFocusLockdown';
import {StrictModeGate,StrictExitConfirm} from '@/components/sentinel/StrictModeDialogs';
import {spellingApi} from '@/services/spellingApi';
import {useSpellingRoom} from './useSpellingRoom';
import {useSpellingAudio} from './useSpellingAudio';
import {ArrowLeft,ArrowRight,Play,Volume2,Headphones,Users,Trophy,RotateCcw,Settings2,X,Check,Copy,ChevronUp,ChevronDown,ChevronLeft,ChevronRight,Keyboard,BookOpen,ShieldCheck} from 'lucide-react';
import type {SpellingMode,SpellingDifficulty,SpellingConfig,SpellingRecords,SpellingCommand} from '@/types/spelling';
import styles from './spelling.module.css';

const Scene=dynamic(()=>import('./SpellingScene'),{ssr:false});
const modeNames={ENDLESS:['Sinh tồn','Endless'],SPRINT:['Nước rút','Sprint'],PRACTICE:['Luyện tập','Practice'],MULTIPLAYER:['Thi đấu','Multiplayer']} as const;
const difficultyNames={EASY:['Dễ','Easy'],MEDIUM:['Vừa','Medium'],HARD:['Khó','Hard']} as const;
const errors:Record<string,[string,string]>={
  NEED_READY_PLAYERS:['Cần ít nhất hai người sẵn sàng.','At least two ready players are required.'],ROOM_NOT_FOUND:['Không tìm thấy phòng. Kiểm tra lại mã.','Room not found. Check the code.'],ROOM_FULL:['Phòng đã đầy.','This room is full.'],ALREADY_IN_ROOM:['Hãy rời phòng hiện tại trước.','Leave your current room first.'],
  SENTINEL_REQUIRED:['Hãy xác nhận luật thi để tiếp tục.','Acknowledge the contest rules to continue.'],SPELLING_AUDIO_UNAVAILABLE:['Bộ giọng đọc chưa sẵn sàng. Vui lòng quay lại sau.','The voice pack is not ready. Please try later.'],CONNECTION_LOST:['Đang kết nối lại…','Reconnecting…'],SESSION_REPLACED:['Phiên này đã được mở ở cửa sổ khác.','This session was opened in another window.'],REQUEST_TIMEOUT:['Chưa nhận được phản hồi. Đang chờ kết nối.','No response yet. Waiting for the connection.'],REPEAT_LIMIT:['Mỗi lượt có hai lần nghe lại, cách nhau hai giây.','Two repeats per turn, two seconds apart.'],AUDIO_NOT_FINISHED:['Đang xác nhận âm thanh. Hãy nghe hết từ.','Confirming the recording. Listen to the full word.'],
};

export default function SpellingGame(){
  const {data:session}=useSession();const account=(session?.user as {id?:string}|undefined)?.id;
  return <SpellingExperience key={account??'waiting'} account={account}/>;
}
function SpellingExperience({account}:{account?:string}){
  const {locale}=useLanguage(),vi=locale==='vi',language=vi?0:1;
  const identity=useAvatarIdentity(account),[hero,setHero]=useState<'LYRA'|'KAI'|null>(null);
  const [mode,setMode]=useState<SpellingMode>('ENDLESS'),[difficulty,setDifficulty]=useState<SpellingDifficulty>('EASY');
  const [tab,setTab]=useState<'solo'|'multi'>('solo'),[code,setCode]=useState(''),[capacity,setCapacity]=useState(10);
  const [sceneReady,setSceneReady]=useState(false);
  const [config,setConfig]=useState<SpellingConfig|null>(null),[records,setRecords]=useState<SpellingRecords|null>(null),[recordOpen,setRecordOpen]=useState(false);
  const [leaderboard,setLeaderboard]=useState<Awaited<ReturnType<typeof spellingApi.leaderboard>>>([]),[boardOpen,setBoardOpen]=useState(false);
  const [attempt,setAttempt]=useState<SentinelAttempt|null>(null),[gate,setGate]=useState<{action:string;payload:SpellingCommand}|null>(null),[gateBusy,setGateBusy]=useState(false),[gateError,setGateError]=useState('');
  const [hudOpen,setHudOpen]=useState(false),[intro,setIntro]=useState(true);
  useEffect(()=>{const timer=setTimeout(()=>setIntro(false),2400);return()=>clearTimeout(timer);},[]);
  const [settings,setSettings]=useState(false),[help,setHelp]=useState(false),[exit,setExit]=useState(false),[volume,setVolume]=useState(.85),[low,setLow]=useState(false),[stats,setStats]=useState({fps:0,draws:0,triangles:0});
  const room=useSpellingRoom(attempt?sentinelHandle(attempt):null),s=room.state,terminal=!!s&&['FINISHED','ABORTED'].includes(s.phase);
  const own=s?.players.find(p=>p.id===s.self),active=s?.players.find(p=>p.id===s.turn?.player),isTurn=!!s&&s.turn?.player===s.self;
  const contestActive=!!s&&!terminal&&!['LOBBY'].includes(s.phase)&&!own?.spectator&&!own?.eliminated;
  const lockdown=useFocusLockdown({attempt,active:contestActive});
  const narration=useSpellingAudio(sceneReady?s:null,room.send,volume);
  const [typed,setTyped]=useState(''),typedRef=useRef(''),composition=useRef(false),draftTimer=useRef<ReturnType<typeof setTimeout>|null>(null),input=useRef<HTMLInputElement>(null),sequence=useRef(0),moveSequence=useRef(0);
  const touch=useRef({x:0,z:0,jump:false}),[now,setNow]=useState(Date.now());
  useEffect(()=>{let live=true;void spellingApi.config().then(x=>{if(live)setConfig(x);}).catch(()=>{if(live)setGateError(vi?'Chưa tải được trò chơi.':'Could not load the game.');});void spellingApi.records().then(x=>{if(live)setRecords(x);}).catch(()=>{});return()=>{live=false;};},[account,vi]);
  useEffect(()=>{const timer=setInterval(()=>setNow(room.clock.current.server+performance.now()-room.clock.current.local),100);return()=>clearInterval(timer);},[room.clock]);
  useEffect(()=>{if(draftTimer.current)clearTimeout(draftTimer.current);typedRef.current='';setTyped('');sequence.current=0;},[s?.turn?.id]);
  useEffect(()=>{if(isTurn&&s?.phase==='SPELL')input.current?.focus({preventScroll:true});},[isTurn,s?.phase,s?.turn?.id]);
  useEffect(()=>{if(terminal&&s?.saved)void spellingApi.records().then(setRecords).catch(()=>{});},[terminal,s?.saved]);
  useEffect(()=>()=>{if(draftTimer.current)clearTimeout(draftTimer.current);},[]);
  const selectedMode=tab==='multi'?'MULTIPLAYER':mode;
  const best=records?.best.find(b=>b.mode===(s?.mode??selectedMode)&&b.difficulty===(s?.difficulty??difficulty));
  const sendDraft=()=>{if(!composition.current&&s?.turn&&s.phase==='SPELL'&&isTurn)room.send('draft',{turnId:s.turn.id,text:typedRef.current,sequence:++sequence.current});};
  const change=(value:string)=>{
    const next=value.slice(0,32);typedRef.current=next;setTyped(next);
    if(draftTimer.current)clearTimeout(draftTimer.current);draftTimer.current=setTimeout(sendDraft,80);
  };
  const answer=()=>{if(composition.current||!s?.turn||s.phase!=='SPELL')return;if(draftTimer.current)clearTimeout(draftTimer.current);room.send('answer',{turnId:s.turn.id,text:typedRef.current,sequence:++sequence.current});};
  const launch=(action:string,payload:SpellingCommand={})=>{
    const data={mode:selectedMode,difficulty,capacity,hero:hero??identity.hero,look:identityWire(identity),...payload};
    if(action==='create'&&selectedMode!=='MULTIPLAYER'&&selectedMode!=='PRACTICE'||action==='ready')setGate({action,payload:data});
    else room.send(action,data);
  };
  const accept=async()=>{if(!gate)return;setGateBusy(true);setGateError('');
    try{const a=await beginAttempt('ECHO_SPELLING');setAttempt(a);room.send(gate.action,{...gate.payload,sentinel:sentinelHandle(a)});setGate(null);}
    catch{setGateError(vi?'Chưa mở được lượt thi. Vui lòng thử lại.':'Could not open the contest. Please retry.');}finally{setGateBusy(false);}
  };
  const leave=()=>{if(contestActive){setExit(true);return;}room.send('leave');setAttempt(null);narration.stop();};
  const move=useCallback((x:number,z:number,yaw:number,jump:boolean)=>{room.send('move',{x,z,yaw,value:jump,sequence:++moveSequence.current});},[room.send]);
  const seconds=s?.turn?.deadline?Math.max(0,(s.turn.deadline-now)/1000):null;
  const sprint=s?.sprintDeadline?Math.max(0,Math.ceil((s.sprintDeadline-now)/1000)):0;
  const friendlyError=room.error?(errors[room.error]?.[language]??(vi?'Thao tác chưa thực hiện được. Hãy thử lại.':'This action could not be completed. Please retry.')):gateError;
  const showRecords=()=>{setRecordOpen(true);void spellingApi.records().then(setRecords).catch(()=>{});};
  const showBoard=()=>{setBoardOpen(true);void spellingApi.leaderboard(difficulty).then(setLeaderboard).catch(()=>{});};
  return <div className={styles.root} data-testid="echo-spelling" data-phase={s?.phase??'ENTRY'} data-intro={intro||hudOpen}>
    <Scene state={s} typed={typedRef} hero={hero??identity.hero} look={identityWire(identity)} vi={vi} low={low} blocked={!!gate||settings||recordOpen||help||boardOpen||exit} connected={room.connected} touch={touch} move={move} onStats={setStats} onReady={setSceneReady}/>
    <div className={styles.vignette}/>
    <header className={`${styles.header} ${styles.revealPanel}`}>
      {s?<button className={styles.circleButton} aria-label={vi?'Về sảnh':'Return to lobby'} onClick={leave}><ArrowLeft size={19}/></button>:<Link className={styles.circleButton} href="/games" aria-label={vi?'Thư viện trò chơi':'Games library'}><ArrowLeft size={19}/></Link>}
      <div className={styles.brand}><strong>Echo Spelling</strong></div>
      <div className={styles.headerActions}><button className={styles.circleButton} onClick={()=>setHelp(true)} aria-label={vi?'Cách chơi':'How to play'}><BookOpen size={19}/></button><button className={styles.circleButton} onClick={()=>setSettings(true)} aria-label={vi?'Âm thanh và đồ họa':'Audio and graphics'}><Settings2 size={19}/></button></div>
    </header>
    {!s&&<section className={`${styles.entry} ${styles.revealPanel}`} aria-label="Echo Spelling">
      <div className={styles.tabs} role="tablist" aria-label={vi?'Chế độ chơi':'Play mode'}><button role="tab" aria-selected={tab==='solo'} onClick={()=>setTab('solo')}><Trophy size={17}/>{vi?'Chơi đơn':'Solo'}</button><button role="tab" aria-selected={tab==='multi'} onClick={()=>setTab('multi')}><Users size={17}/>{vi?'Nhiều người':'Multiplayer'}</button></div>
      {tab==='solo'?<div className={styles.modeGrid}>{(['ENDLESS','SPRINT','PRACTICE'] as const).map((m,i)=><button key={m} className={styles.modeCard} aria-pressed={mode===m} onClick={()=>setMode(m)}><span className={styles.modeNumber}>0{i+1}</span><strong>{modeNames[m][language]}</strong><small>{m==='ENDLESS'?(vi?'Một mạng · Phá kỷ lục':'One life · Beat your best'):m==='SPRINT'?(vi?'120 giây · Tốc độ':'120 seconds · Speed'):(vi?'Thảnh thơi · Học từ sai':'No timer · Learn')}</small></button>)}</div>:<div className={styles.multiplayerChoice}><p>{vi?'2–10 người thật · Lần lượt tại micro · Người cuối cùng chiến thắng':'2–10 real players · Take turns at the microphone · Last survivor wins'}</p><label>{vi?'Số chỗ':'Room capacity'}<select value={capacity} onChange={e=>setCapacity(Number(e.target.value))}>{[2,4,6,8,10].map(n=><option key={n}>{n}</option>)}</select></label></div>}
      <div className={styles.difficulty} aria-label={vi?'Độ khó khởi đầu':'Starting difficulty'}>{(['EASY','MEDIUM','HARD'] as const).map(d=><button key={d} aria-pressed={difficulty===d} onClick={()=>setDifficulty(d)}>{difficultyNames[d][language]}</button>)}</div>
      <div className={styles.chooseHero}><span>{vi?'Nhân vật':'Character'}</span>{(['LYRA','KAI'] as const).map(h=><button key={h} aria-pressed={(hero??identity.hero)===h} onClick={()=>setHero(h)}>{h==='LYRA'?'Lyra':'Kai'}</button>)}<button onClick={narration.preview}><Headphones size={15}/>{vi?'Nghe thử':'Sound check'}</button></div>
      <div className={styles.launchRow}><button className={styles.primary} disabled={!room.connected||room.pending||!sceneReady||!config?.available} onClick={()=>launch('create')}><Play size={18}/>{tab==='multi'?(vi?'Tạo phòng':'Create room'):(vi?'Chơi':'Play')}<ArrowRight size={18}/></button>{tab==='multi'&&<button className={styles.secondary} disabled={!room.connected||room.pending||!sceneReady||!config?.available} onClick={()=>launch('quick')}>{vi?'Tìm trận':'Quick match'}</button>}</div>
      {tab==='multi'&&<form className={styles.joinRow} onSubmit={e=>{e.preventDefault();launch('join',{code});}}><input aria-label={vi?'Mã phòng':'Room code'} value={code} onChange={e=>setCode(e.target.value.toUpperCase())} maxLength={8} placeholder={vi?'Nhập mã phòng':'Enter room code'}/><button disabled={!room.connected||code.length!==8}>{vi?'Tham gia':'Join'}<ArrowRight size={16}/></button></form>}
      <footer className={styles.entryFooter}><button onClick={showRecords}><Trophy size={16}/>{vi?'Kỷ lục của tôi':'My records'}</button><button onClick={showBoard}><Users size={16}/>{vi?'Bảng thi đấu':'Competition board'}</button></footer>
    </section>}
    {s&&<>
      <aside className={`${styles.runSummary} ${styles.revealPanel}`}><div><span>{modeNames[s.mode][language]} · {difficultyNames[s.difficulty][language]}</span><strong>{own?.score??0}<small>{vi?'điểm':'points'}</small></strong></div><div><span>{vi?'Kỷ lục của bạn':'Personal best'}</span><strong>{best?.highestScore??0}</strong></div>{s.mode==='SPRINT'&&<div><span>{vi?'Còn lại':'Remaining'}</span><strong>{sprint}s</strong></div>}<div><span>{vi?'Chuỗi đúng':'Streak'}</span><strong>{own?.streak??0}</strong></div></aside>
      {s.phase==='LOBBY'&&<section className={`${styles.roomPanel} ${styles.revealPanel}`}><div className={styles.roomHeading}><span>{s.publicMatch?(vi?'ĐANG TÌM ĐỐI THỦ':'FINDING PLAYERS'):(vi?'PHÒNG RIÊNG':'PRIVATE ROOM')}</span><button aria-label={vi?'Sao chép mã phòng':'Copy room code'} onClick={()=>void navigator.clipboard.writeText(s.code)}><b>{s.code}</b><Copy size={16}/></button></div><div className={styles.roster}>{s.players.map(p=><div key={p.id}><i data-hero={p.hero}>{p.name.slice(0,1)}</i><span>{p.name}{p.id===s.self&&<small>{vi?'Bạn':'You'}</small>}</span><span>{p.ready?<Check size={18}/>:p.online?(vi?'Đang chuẩn bị':'Preparing'):(vi?'Mất kết nối':'Offline')}</span></div>)}</div><div className={styles.launchRow}><button className={styles.primary} disabled={room.pending||!sceneReady} onClick={()=>own?.ready?room.send('ready',{value:false}):launch('ready',{value:true})}>{own?.ready?(vi?'Hủy sẵn sàng':'Unready'):(vi?'Tôi đã sẵn sàng':'I am ready')}</button>{s.host===s.self&&!s.publicMatch&&<button className={styles.secondary} disabled={room.pending||s.players.filter(p=>p.ready).length<2} onClick={()=>room.send('start')}>{vi?'Bắt đầu trận':'Start match'}</button>}</div></section>}
      {s.phase!=='LOBBY'&&!terminal&&<aside className={`${styles.turnLabel} ${styles.revealPanel}`}><span>{isTurn?(vi?'LƯỢT CỦA BẠN':'YOUR TURN'):(vi?'ĐANG THI ĐẤU':'ON STAGE')}</span><strong>{active?.name??'Echo'}</strong></aside>}
      {isTurn&&s.phase==='SPELL'&&!terminal&&<form className={`${styles.typing} ${styles.revealPanel}`} onSubmit={e=>{e.preventDefault();answer();}}>
        <div className={styles.typingHead}><span><Keyboard size={16}/>{vi?'Đánh vần':'Spell'}</span><span>{seconds===null?'∞':`${seconds.toFixed(1)}s`}</span></div>
        <div className={styles.inputRow}><input ref={input} value={typed} onChange={e=>change(e.target.value)} onCompositionStart={()=>{composition.current=true;}} onCompositionEnd={e=>{composition.current=false;change(e.currentTarget.value);}} onKeyDown={e=>{if(e.key==='Enter'&&(e.nativeEvent.isComposing||composition.current))e.preventDefault();}} autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false} maxLength={32} aria-label={vi?'Đánh vần từ tiếng Anh':'Spell the English word'} placeholder={vi?'Từng con chữ…':'Every letter…'}/><button type="submit" className={styles.submit} disabled={!room.connected}><ArrowRight size={24}/><span className={styles.srOnly}>{vi?'Nộp đáp án':'Submit answer'}</span></button></div>
        <div className={styles.typingFoot}><button type="button" onClick={()=>room.send('repeat',{turnId:s.turn!.id})} disabled={s.turn!.repeats>=2}><Volume2 size={16}/>{vi?'Nghe lại':'Repeat'} {2-s.turn!.repeats}/2</button><span>{vi?'Đúng: tự nộp · Enter: chốt':'Correct: auto · Enter: submit'}</span></div>
      </form>}
      {s.phase==='RESULT'&&s.result&&<div className={styles.verdict} data-correct={s.result.correct} role="status"><span>{s.result.correct?<Check size={24}/>:<X size={24}/>}</span><strong>{s.result.correct?(vi?'Chính xác!':'Correct!'):(vi?'Cùng ghi nhớ từ này':'Remember this spelling')}</strong><b>{s.result.answer}</b><small>{s.result.correct?`+${s.result.earned}`:`${vi?'Bạn đã gõ':'You typed'}: ${s.result.typed||'—'}`}</small></div>}
      {terminal&&<section className={`${styles.results} ${styles.revealPanel}`} aria-label={vi?'Kết quả':'Results'}>
        <p className={styles.eyebrow}>{s.newRecords.length>0?'NEW PERSONAL BEST!':s.phase==='ABORTED'?(vi?'LƯỢT CHƠI KẾT THÚC':'RUN ENDED'):(vi?'KẾT QUẢ':'RESULTS')}</p>
        <h2>{s.mode==='MULTIPLAYER'&&s.winner?`${s.players.find(p=>p.id===s.winner)?.name} ${vi?'chiến thắng!':'wins!'}`:s.phase==='ABORTED'?(vi?'Lượt đã dừng':'Run ended'):(vi?'Hoàn thành':'Complete')}</h2>
        {s.phase==='ABORTED'&&<p>{s.reason?.startsWith('AUDIO')?(vi?'Âm thanh chưa được xác nhận. Lượt này không tính thua hoặc kỷ lục.':'Audio was not confirmed. This run awards no loss or record.'):(vi?'Lượt thi không còn đáp ứng tính liên tục. Bạn có thể bắt đầu lại.':'Contest continuity could not be confirmed. You can start again.')}</p>}
        <div className={styles.resultStats}>{[[vi?'Điểm':'Score',own?.score??0],[vi?'Từ đúng':'Correct',own?.correct??0],[vi?'Chuỗi dài nhất':'Best streak',own?.maxStreak??0],['WPM',own?.highestWpm??0],[vi?'Chính xác':'Accuracy',`${own&&own.correct+own.wrong?Math.round(own.correct/(own.correct+own.wrong)*100):0}%`]].map(([label,value])=><div key={label}><strong>{value}</strong><span>{label}</span></div>)}</div>
        <p className={styles.saveStatus}><ShieldCheck size={16}/>{!s.saved?(vi?'Đang lưu kết quả…':'Saving your result…'):own?.integrity==='COMPLETED_VERIFIED'?(vi?'Đã lưu vào tài khoản · Lượt thi đã xác minh':'Saved to your account · Verified contest'):own?.integrity==='PRACTICE'?(vi?'Đã lưu lịch sử luyện tập':'Practice history saved'):(vi?'Đã lưu lịch sử · Không tính kỷ lục':'History saved · Not eligible for records')}</p>
        <div className={styles.mistakes}>{s.review.filter(r=>r.player===s.self&&!r.correct).map((r,i)=><div key={i}><span>{r.typed||'—'}</span><ArrowRight size={14}/><strong>{r.answer}</strong></div>)}</div>
        <div className={styles.launchRow}><button className={styles.primary} disabled={!s.saved||room.pending||s.mode==='MULTIPLAYER'&&s.host!==s.self} onClick={()=>s.mode==='MULTIPLAYER'?room.send('rematch'):launch('create',{mode:s.mode,difficulty:s.difficulty})}><RotateCcw size={18}/>{vi?'Chơi lại':'Play again'}</button><button className={styles.secondary} onClick={leave}>{vi?'Về sảnh':'Lobby'}</button><button className={styles.secondary} onClick={showRecords}>{vi?'Kỷ lục':'Records'}</button></div>
      </section>}
      {s.phase!=='LOBBY'&&!terminal&&s.mode!=='MULTIPLAYER'&&<button className={`${styles.finishRun} ${styles.revealPanel}`} onClick={()=>room.send('finish')}>{vi?'Kết thúc lượt':'Finish run'}</button>}
    </>}
    {(narration.status==='blocked'||narration.status==='failed')&&<div className={styles.audioNotice} role="alert"><Headphones size={20}/><span>{narration.status==='blocked'?(vi?'Chạm để bật giọng đọc':'Tap to enable narration'):(vi?'Chưa phát được âm thanh':'Audio could not play')}</span><button onClick={narration.resume}>{vi?'Phát lại':'Play audio'}</button>{isTurn&&s?.turn&&<button onClick={()=>room.send('audio-failed',{turnId:s.turn!.id})}>{vi?'Hủy lượt do lỗi âm thanh':'End due to audio failure'}</button>}</div>}
    {friendlyError&&<div className={styles.error} role="alert"><span>{friendlyError}</span><button aria-label={vi?'Đóng':'Dismiss'} onClick={()=>{room.clearError();setGateError('');}}><X size={15}/></button></div>}
    {s&&!isTurn&&!terminal&&<div className={`${styles.touchControls} ${styles.revealPanel}`} aria-label={vi?'Di chuyển':'Movement'}>{[[0,-1,ChevronUp],[-1,0,ChevronLeft],[0,1,ChevronDown],[1,0,ChevronRight]].map(([x,z,Icon],i)=>{const Direction=Icon as typeof ChevronUp;return <button key={i} aria-label={['Forward','Left','Back','Right'][i]} onPointerDown={e=>{e.currentTarget.setPointerCapture(e.pointerId);touch.current.x=x as number;touch.current.z=z as number;}} onPointerUp={()=>{touch.current.x=0;touch.current.z=0;}} onPointerCancel={()=>{touch.current.x=0;touch.current.z=0;}}><Direction size={20}/></button>;})}<button onClick={()=>{touch.current.jump=true;}}>{vi?'Nhảy':'Jump'}</button></div>}
    <button className={styles.hudHandle} aria-label={vi?'Hiện điều khiển':'Show controls'} aria-expanded={hudOpen} onClick={()=>setHudOpen(v=>!v)}><Settings2 size={18}/></button>
    {(settings||help||recordOpen||boardOpen)&&<div className={styles.overlay}><section className={styles.modal} role="dialog" aria-modal="true" aria-label={settings?(vi?'Cài đặt':'Settings'):help?(vi?'Cách chơi':'How to play'):recordOpen?(vi?'Kỷ lục cá nhân':'Personal records'):(vi?'Bảng thi đấu':'Competition board')}><button className={styles.close} onClick={()=>{setSettings(false);setHelp(false);setRecordOpen(false);setBoardOpen(false);}} aria-label={vi?'Đóng':'Close'}><X/></button>
      {settings&&<><p className={styles.eyebrow}>ECHO SPELLING</p><h2>{vi?'Âm thanh và hình ảnh':'Sound and picture'}</h2><label className={styles.setting}>{vi?'Giọng đọc OmniVoice':'OmniVoice narrator'}<input type="range" min=".1" max="1" step=".05" value={volume} onChange={e=>setVolume(Number(e.target.value))}/></label><label className={styles.setting}><span>{vi?'Đồ họa tiết kiệm':'Efficient graphics'}</span><input type="checkbox" checked={low} onChange={e=>setLow(e.target.checked)}/></label><p className={styles.fine}>{stats.fps} FPS · {stats.draws} {vi?'lượt vẽ':'draw calls'} · {Math.round(stats.triangles/1000)}k {vi?'tam giác':'triangles'}</p><button className={styles.secondary} onClick={narration.preview}>{vi?'Nghe thử giọng đọc':'Test narration'}</button></>}
      {help&&<><p className={styles.eyebrow}>LISTEN. SPELL. SHINE.</p><h2>{vi?'Chơi':'Play'}</h2><ol className={styles.instructions}><li>{vi?'Nghe hết từ được đọc. Đồng hồ 15 giây chỉ bắt đầu sau khi giọng đọc kết thúc.':'Listen to the full word. Your 15-second clock begins after the recording finishes.'}</li><li>{vi?'Gõ bằng bàn phím. Từ đúng tự nộp. Enter chốt đáp án đang gõ; Backspace để sửa.':'Type with your keyboard. Correct spelling submits automatically. Enter commits; Backspace corrects.'}</li><li>{vi?'Mỗi lượt nghe lại tối đa hai lần. Nghe lại không cộng thời gian.':'Repeat the word up to twice. Replays do not add time.'}</li><li>{vi?'Sinh tồn: sai một từ sẽ kết thúc. Nước rút: ghi nhiều điểm trong 120 giây. Luyện tập: không đồng hồ, xem lại lỗi.':'Endless: one mistake ends the run. Sprint: score within 120 seconds. Practice: no timer, learn from mistakes.'}</li><li>{vi?'Thi đấu: lần lượt tại micro, sai hoặc hết giờ bị loại. Người còn lại chiến thắng.':'Multiplayer: take turns at the microphone. Wrong answers and timeouts eliminate. Last survivor wins.'}</li><li>{vi?'WASD hoặc mũi tên di chuyển trong khu chờ, Shift chạy, Space nhảy. Kéo cảnh để đổi góc nhìn.':'WASD or arrows move in the waiting area, Shift runs, Space jumps. Drag the scene to adjust the camera.'}</li></ol><p className={styles.fine}>{vi?'Không cần quyền micro. Từ vựng lấy từ kho English Coach; đồ họa và nhân vật thuộc thế giới Echo Ocean.':'No microphone permission is needed. Vocabulary comes from English Coach; the world and characters belong to Echo Ocean.'}</p></>}
      {recordOpen&&<><p className={styles.eyebrow}>{vi?'HÀNH TRÌNH CỦA BẠN':'YOUR JOURNEY'}</p><h2>{vi?'Kỷ lục cá nhân':'Personal records'}</h2>{!records?.best.length?<p>{vi?'Hoàn thành lượt đầu tiên để ghi dấu tại đây.':'Complete your first run to leave your mark here.'}</p>:records.best.map(b=><div className={styles.recordRow} key={`${b.mode}:${b.difficulty}`}><strong>{modeNames[b.mode][language]} · {difficultyNames[b.difficulty][language]}</strong><span>{b.highestScore} {vi?'điểm':'points'} · {b.longestStreak} {vi?'chuỗi':'streak'} · {b.mostCorrect} {vi?'từ':'words'}</span><small>{b.highestWpm} WPM · {b.bestAccuracy}% · {Math.round(b.bestSurvivalMs/1000)}s · {b.attempts} {vi?'lượt':'runs'}</small></div>)}<h3>{vi?'Lượt chơi gần đây':'Recent runs'}</h3>{records?.recent.map((r,i)=><div className={styles.recent} key={i}><span>{modeNames[r.mode][language]} · {new Date(r.finishedAt).toLocaleDateString(vi?'vi-VN':'en-US')}</span><strong>{r.score}</strong><small>{r.correct} {vi?'đúng':'correct'} / {r.wrong} {vi?'sai':'wrong'}</small></div>)}</>}
      {boardOpen&&<><p className={styles.eyebrow}>ECHO CHAMPIONS</p><h2>{vi?'Bảng thi đấu':'Competition board'} · {difficultyNames[difficulty][language]}</h2><p className={styles.fine}>{vi?'Chỉ các trận Multiplayer được Sentinel xác minh. Solo có kỷ lục riêng.':'Only Sentinel-verified multiplayer matches. Solo records remain separate.'}</p>{!leaderboard.length?<p>{vi?'Chưa có trận hoàn thành ở độ khó này.':'No completed matches at this difficulty yet.'}</p>:leaderboard.map((p,i)=><div className={styles.recent} key={p.user_id}><b>{i+1}</b><strong>{p.name}</strong><span>{p.wins} {vi?'thắng':'wins'} · {p.correct} {vi?'từ':'words'}</span></div>)}</>}
    </section></div>}
    {gate&&<StrictModeGate vi={vi} busy={gateBusy} error={gateError} graceSeconds={20} onAccept={()=>void accept()} onBack={()=>setGate(null)}/>}
    {exit&&<StrictExitConfirm vi={vi} onStay={()=>setExit(false)} onLeave={()=>{void lockdown.report('EXIT');room.send('leave');setExit(false);setAttempt(null);narration.stop();}}/>}
  </div>;
}
