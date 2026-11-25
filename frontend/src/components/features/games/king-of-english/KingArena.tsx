'use client';
import { useEffect,useRef,useState } from 'react';
import type { ReactNode,RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Check,ChevronRight,Copy,Crown,Link as LinkIcon,ListChecks,RotateCcw,Send,SkipForward,Trophy,X } from 'lucide-react';
import { KingShell } from './KingShell';
import { KingExplainRound } from './KingExplainRound';
import { KingConquestBoard } from './KingConquestBoard';
import { KingConquestRanks } from './KingConquestRanks';
import { KingChain } from './KingChain';
import { KingFeedback,FAMILY,STRUCTURES } from './KingFeedback';
import type { Verdict } from './KingFeedback';
import { useKingRealtime } from './useKingRealtime';
import type { KingLaunch,KingPresentation,KingState } from './realtimeTypes';
import { KingAudio } from './kingAudio';
import { KingHud,ChampionshipBreakdown,modeName } from './KingHud';
import { kingError } from './kingErrors';
import { KING_ART } from './kingArt';
import styles from './king.module.css';
import { StrictModeGate,StrictExitConfirm,AttemptVoided } from '@/components/sentinel/StrictModeDialogs';
import { useFocusLockdown } from '@/components/sentinel/useFocusLockdown';
import { beginAttempt,isVoided,sentinelHandle } from '@/lib/sentinel/client';
import type { SentinelAttempt } from '@/lib/sentinel/client';

const KEYS='ABCDEFGH';
const label=(map:Record<string,[string,string]>,key:string|undefined,vi:boolean)=>key?(map[key]?.[vi?0:1]??null):null;

export function ChallengeInput({item,vi,disabled,selected,setSelected,answer,setAnswer,submit}:{
  item:KingPresentation;vi:boolean;disabled:boolean;selected:number[];setSelected:(s:number[])=>void;
  answer:string;setAnswer:(s:string)=>void;submit:(answer?:string)=>void;
}){
  const field=useRef<HTMLInputElement>(null);
  const [picked,setPicked]=useState<{id:string;option:string}|null>(null);
  useEffect(()=>{if(!disabled)field.current?.focus({preventScroll:true});},[item.id,disabled]);
  if(item.tiles?.length)return <KingChain tiles={item.tiles} selected={selected} setSelected={setSelected} disabled={disabled} vi={vi} letters={item.mode==='REFLEX'} onSubmit={()=>submit()}/>;
  if(item.options.length)return <div className={styles.options} role="group" aria-label={vi?'Các lựa chọn':'Choices'}>{item.options.map((option,index)=>
    <button key={option} type="button" disabled={disabled} data-option-index={index} data-picked={!!picked&&picked.id===item.id&&picked.option===option}
      onClick={()=>{setPicked({id:item.id,option});submit(option);}} className={styles.option}>
      <span className={styles.optKey} aria-hidden="true">{KEYS[index]}</span><span lang="en">{option}</span></button>)}</div>;
  return <form className={styles.answerForm} onSubmit={e=>{e.preventDefault();if(!disabled&&answer.trim())submit();}}>
    <label className={styles.answerField}><span className={styles.answerLabel}>{vi?'Đáp án của bạn':'Your answer'}</span>
      <input ref={field} autoComplete="off" spellCheck={false} autoCapitalize="none" lang="en" maxLength={160} value={answer} disabled={disabled} onChange={e=>setAnswer(e.target.value)} className={styles.answerInput}/></label>
    <button type="submit" disabled={disabled||!answer.trim()} className={`${styles.cta} ${styles.ctaSmall}`}><Send aria-hidden="true"/>{vi?'Gửi':'Submit'}</button></form>;
}

/** Reflex: the verdict on the learner's last slot. Large for a few seconds, then a compact line — never holding the shared clock. */
function ReflexFeedback({state,vi,wide}:{state:KingState;vi:boolean;wide:boolean}){
  const last=state.lastResult;
  const key=last?`${state.matchId}:${state.championshipRound}:${last.slot}:${last.revealed}`:'';
  const [expandedKey,setExpandedKey]=useState('');
  useEffect(()=>{if(!key)return;setExpandedKey(key);const t=setTimeout(()=>setExpandedKey(k=>k===key?'':k),3200);return()=>clearTimeout(t);},[key]);
  if(!last)return null;
  const c=last.challenge,verdict:Verdict=last.correct?'correct':last.skipped?'skipped':'wrong';
  return <KingFeedback key={key} vi={vi} compact={!wide&&expandedKey!==key} verdict={verdict} yours={last.submitted} truth={last.revealed?c.answer:null}
    meaning={last.revealed?c.meaning:null} context={last.revealed&&c.family!=='PART_OF_SPEECH'?c.context:null} contextLabel={c.family==='GRAMMAR_TRAP'?(vi?'Ngữ cảnh':'Context'):(vi?'Nghĩa trong câu hỏi':'Sense asked')} points={last.correct?1:null}
    note={<>{vi?'Câu trước':'Previous question'} · {label(FAMILY,c.family,vi)??c.family} · <span lang="en">{c.prompt}</span>{!last.revealed&&<> · {vi?'Đáp án sẽ hiện khi đối thủ cũng trả lời câu này.':'The answer appears once your opponent has answered this question too.'}</>}</>}/>;
}

function Results({state,vi,competitive,pending,connected,send,quit,heading,replay,fresh}:{state:KingState;vi:boolean;competitive:boolean;pending:boolean;connected:boolean;send:(a:string,p?:Record<string,unknown>)=>boolean;quit:()=>void;heading:RefObject<HTMLHeadingElement|null>;replay:()=>void;fresh:()=>void}){
  const you=state.players.find(p=>p.id===state.youId);
  // A human opponent who left (or lost the connection) can no longer answer a rematch: say so and offer a new match instead.
  const rival=state.players.find(p=>p.id!==state.youId&&p.id!==0),rivalGone=!!rival&&!rival.connected,rivalWants=!!rival?.rematch&&!you?.rematch;
  const ranked=state.mode==='CONQUEST'&&state.variant!=='CHAMPIONSHIP';
  const championship=state.variant==='CHAMPIONSHIP';
  const won=state.winnerId!==null&&state.winnerId===state.youId,draw=state.winnerId===null;
  const tone=!competitive&&!championship?'win':won?'win':draw?'win':'loss';
  const title=championship?(draw?(vi?'Hòa chung cuộc':'Championship draw'):won?(vi?'Bạn vô địch':'You are champion'):(vi?'Đối thủ vô địch':'Opponent wins'))
    :competitive?(draw?(vi?'Hòa':'Draw'):won?(vi?'Bạn thắng':'You win'):(vi?'Đối thủ thắng':'Opponent wins')):(vi?'Hoàn thành phiên luyện':'Session complete');
  const note=tone==='loss'?(vi?'Mỗi câu sai là một điều mới học được. Xem lại bên dưới rồi thử thêm một trận nhé.':'Every miss is something learned. Review below and try another match.')
    :(vi?'Xem lại từng câu bên dưới để ghi nhớ lâu hơn.':'Review each question below to remember it longer.');
  const review=state.review??[];
  const correctCount=state.mode==='REORDER'||state.mode==='REFLEX'?state.score/(state.mode==='REORDER'&&!competitive?10:1):review.filter(r=>r.correct).length;
  return <div className={styles.result}>
    <section className={styles.resultHero} data-tone={tone}>
      <span className={styles.rays} aria-hidden="true"/>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className={styles.resultCrown} src={KING_ART.crown} alt="" aria-hidden="true" width={320} height={256}/>
      <h2 ref={heading} tabIndex={-1} className={styles.resultTitle}>{title}</h2>
      <p className={styles.resultScore}>{championship?<>{state.championshipTotal??state.score}{(state.championshipTotal??state.score)>400?null:<small>/400</small>}</>:<>{state.score}<small> {vi?'điểm':'pts'}</small></>}</p>
      <p className={styles.resultNote}>{note}</p>
      <div className={styles.row}>
        {rivalGone?<button type="button" disabled={pending||!connected} onClick={fresh} className={`${styles.cta} ${styles.ctaSmall}`}><RotateCcw aria-hidden="true"/>{state.flow==='PRIVATE_ROOM'?(vi?'Tạo phòng mới':'New room'):(vi?'Tìm trận mới':'Find a new match')}</button>
          :<button type="button" disabled={pending||!connected||you?.rematch} onClick={replay} className={`${styles.cta} ${styles.ctaSmall}`} data-attention={rivalWants}><RotateCcw aria-hidden="true"/>{you?.rematch?(vi?'Chờ đối thủ':'Waiting for opponent'):(competitive?(vi?'Tái đấu':'Rematch'):(vi?'Luyện lại':'Restart'))}</button>}
        <button type="button" disabled={pending} onClick={quit} className={styles.ghost}>{vi?'Về sảnh':'Lobby'}</button>
      </div>
      {rival&&<p role="status" aria-live="polite" className={styles.rematchNote}>{rivalGone?(vi?'Đối thủ đã rời phòng — không thể tái đấu trận này.':'Your opponent has left — this match cannot be replayed.')
        :rivalWants?(vi?'Đối thủ muốn tái đấu. Bấm Tái đấu để bắt đầu ngay.':'Your opponent wants a rematch. Press Rematch to start.')
        :you?.rematch?(vi?'Đã gửi lời mời tái đấu. Trận mới bắt đầu khi đối thủ đồng ý.':'Rematch requested. The new match starts when your opponent accepts.'):null}</p>}
    </section>
    {championship&&<ChampionshipBreakdown state={state} vi={vi}/>}
    {!championship&&state.mode!=='CONQUEST'&&<div className={styles.stats}>
      <div className={styles.stat}><span className={styles.statLabel}>{vi?'Đúng':'Correct'}</span><span className={styles.statValue} data-tone="good">{correctCount}</span></div>
      {(state.mode==='REORDER'||state.mode==='REFLEX')&&<><div className={styles.stat}><span className={styles.statLabel}>{vi?'Sai':'Wrong'}</span><span className={styles.statValue} data-tone="bad">{state.wrong}</span></div>
      <div className={styles.stat}><span className={styles.statLabel}>{vi?'Bỏ qua':'Skipped'}</span><span className={styles.statValue}>{state.skipped}</span></div></>}
      <div className={styles.stat}><span className={styles.statLabel}>{vi?'Độ chính xác':'Accuracy'}</span><span className={styles.statValue} data-tone="gold">{Math.round((state.accuracy??0)*100)}%</span></div>
      <div className={styles.stat}><span className={styles.statLabel}>{vi?'Đã hoàn thành':'Completed'}</span><span className={styles.statValue}>{state.completed}/{state.mode==='REORDER'?Math.max(state.count,state.completed):state.count}</span></div>
      <div className={styles.stat}><span className={styles.statLabel}>{vi?'Thời gian':'Time'}</span><span className={styles.statValue}>{Math.round((state.durationMs??0)/1000)}s</span></div>
    </div>}
    {state.conquest&&<>
      <p className="text-center text-lg font-bold text-amber-100">{state.conquest.wordPoints} + {state.conquest.territory} × {state.config.conquestTerritoryPoint} + {state.conquest.owners[state.conquest.throne]===state.youId?state.config.conquestThroneBonus:0} = {state.conquest.playerBreakdown?.[String(state.youId)]?.score??state.score}<br/><span className="text-sm font-semibold text-slate-300">{vi?'Từ + lãnh thổ + ngai vàng':'Words + territory + throne'}</span></p>
      <KingConquestBoard state={state} vi={vi} disabled={true} send={send}
        extra={ranked?<KingConquestRanks size={state.conquest.size??5} category={state.flow==='SOLO'?'SOLO':'DUEL'} refresh={`${state.matchId}:${!!state.resultSaved}`} vi={vi}/>:null}/>
    </>}
    {review.length>0&&<section aria-labelledby="king-review-heading" className="grid gap-3">
      <h3 id="king-review-heading" className={styles.subTitle}><ListChecks aria-hidden="true"/>{vi?'Ôn lại từng câu':'Review every question'}</h3>
      <ol className={styles.reviewList}>{review.map((r,index)=>{const c=r.challenge,showMeaning=c.meaning&&norm(c.meaning)!==norm(c.answer??'');const wrongMine=!r.correct&&r.submitted;
        return <li key={index} className={styles.reviewItem} data-correct={r.correct}>
          <span className={styles.reviewMark} aria-label={r.correct?(vi?'Đúng':'Correct'):(vi?'Ôn lại':'Review')}>{r.correct?<Check/>:<X/>}</span>
          {c.prompt&&<p className={styles.reviewPrompt} lang="en">{label(FAMILY,c.family,vi)??label(STRUCTURES,c.family,vi)??''}{(label(FAMILY,c.family,vi)??label(STRUCTURES,c.family,vi))?' · ':''}{c.prompt}</p>}
          <p className={styles.reviewAnswer} lang="en">{wrongMine&&<span>{r.submitted}</span>}{c.answer}{!r.correct&&!r.submitted&&state.mode!=='EXPLAIN'&&<em className="ml-2 text-xs font-semibold not-italic text-slate-400">{vi?'(chưa trả lời)':'(not answered)'}</em>}</p>
          {showMeaning&&<p className={styles.reviewMeaning} lang="en">{c.meaning}</p>}
        </li>;})}</ol>
    </section>}
    <p className={styles.footNote}>{ranked?(state.reason==='TIMEOUT'||state.reason==='WORD_LIMIT'?(state.resultSaved?(vi?'Điểm ván này đã được lưu vào bảng xếp hạng.':'This round’s score is saved to the leaderboard.'):(vi?'Đang lưu điểm ván này…':'Saving this round’s score…')):(vi?'Ván bỏ dở không được tính vào bảng xếp hạng.':'Unfinished rounds are not ranked.')):(vi?'Phiên chơi không ghi vào tiến độ hay bảng xếp hạng.':'Sessions do not write learning progress or leaderboards.')}</p>
  </div>;
}
const norm=(s:string)=>s.trim().toLowerCase().replace(/[.,!?]/g,'').replace(/\s+/g,' ');

export default function KingArena({vi,launch,onQuit}:{vi:boolean;launch:KingLaunch;onQuit:()=>void}){
  const {state,connected,pending,error,offset,send,retry,submitMove,moves,refused,setSentinel}=useKingRealtime();
  // Echo Sentinel (10 §BX): ranked Soán ngôi runs as an acknowledged strict-focus attempt. A recovered room (?room= after a
  // reload) has no attempt secret in this page: the server ends its ranked attempt and shows why.
  const strictLaunch=launch.mode==='CONQUEST'&&!launch.recover;
  const [attempt,setAttempt]=useState<SentinelAttempt|null>(null);
  const [gate,setGate]=useState<null|'start'|'rematch'|'fresh'>(strictLaunch?'start':null);
  const [gateBusy,setGateBusy]=useState(false),[gateError,setGateError]=useState<string|null>(null),[exitAsk,setExitAsk]=useState(false);
  const audio=useRef<KingAudio|null>(null),previous=useRef<{score:number;wrong:number;status:string;connected:boolean;moves:number;lastSlot:string}|null>(null);
  const [sound,setSound]=useState(false),[copyStatus,setCopyStatus]=useState(''),[flash,setFlash]=useState<{tone:'good'|'bad';at:number}|null>(null);
  useEffect(()=>{audio.current=new KingAudio();return()=>{audio.current?.close();audio.current=null;};},[]);
  useEffect(()=>{if(!flash)return;const t=setTimeout(()=>setFlash(null),650);return()=>clearTimeout(t);},[flash]);
  // Authoritative changes only: score / wrong / status / accepted moves from the server drive sound and the stage flash.
  useEffect(()=>{
    if(!state)return;
    const before=previous.current,moves=state.conquest?.wordHistory?.length??0,lastSlot=state.lastResult?`${state.lastResult.slot}:${state.lastResult.correct}`:'';
    if(before){
      const gained=state.score>before.score,missed=state.wrong>before.wrong;
      if(gained&&state.status==='PLAYING')setFlash({tone:'good',at:Date.now()});else if(missed)setFlash({tone:'bad',at:Date.now()});
      if(sound){
        if(state.status==='FINISHED'&&before.status!=='FINISHED')audio.current?.play(state.winnerId===state.youId||state.flow==='SOLO'||state.winnerId===null?'win':'lose');
        else if(moves>before.moves)audio.current?.play('capture');
        else if(gained)audio.current?.play('correct');
        else if(missed)audio.current?.play('wrong');
        else if(lastSlot&&lastSlot!==before.lastSlot)audio.current?.play('place');
        else if(connected&&!before.connected)audio.current?.play('place');
      }
    }
    previous.current={score:state.score,wrong:state.wrong,status:state.status,connected,moves,lastSlot};
  },[state,connected,sound]);
  const [input,setInput]=useState<{key:string;selected:number[];answer:string}>({key:'',selected:[],answer:''}),
    [now,setNow]=useState(Date.now()),[leaving,setLeaving]=useState(false);
  const inputKey=`${state?.matchId}:${state?.championshipRound}:${state?.round}:${state?.inputRevision}`;
  const selected=input.key===inputKey?input.selected:[],answer=input.key===inputKey?input.answer:'';
  const setSelected=(value:number[])=>{setInput({key:inputKey,selected:value,answer});if(sound)audio.current?.play('select');};
  const setAnswer=(value:string)=>setInput({key:inputKey,selected,answer:value});
  // The learner's own last order survives the round's resolution (Reorder) so the feedback can show it beside the answer.
  const roundKey=`${state?.matchId}:${state?.championshipRound}:${state?.round}`;
  const [lastOrder,setLastOrder]=useState<{key:string;text:string}>({key:'',text:''});
  const orderText=state?.challenge?.tiles&&!state.resolved?selected.map(id=>state.challenge!.tiles!.find(t=>t.id===id)?.text??'').join(' '):'';
  useEffect(()=>{if(orderText)setLastOrder({key:roundKey,text:orderText});},[orderText,roundKey]);
  // Score / skipped at the start of each round decide the learner's own verdict when the server resolves it.
  const [roundStart,setRoundStart]=useState<{key:string;score:number;skipped:number;wrong:number}>({key:'',score:0,skipped:0,wrong:0});
  const unresolved=!!state&&!state.resolved,startScore=state?.score??0,startSkipped=state?.skipped??0,startWrong=state?.wrong??0;
  useEffect(()=>{if(unresolved)setRoundStart(prev=>prev.key===roundKey?prev:{key:roundKey,score:startScore,skipped:startSkipped,wrong:startWrong});},[unresolved,roundKey,startScore,startSkipped,startWrong]);
  const started=useRef(!!launch.recover),heading=useRef<HTMLHeadingElement>(null);
  // The arena draws again when what it shows changes (the clock's second, a lock opening), not four times a second.
  const clock=useRef({deadline:0,lock:0,offset:0,mark:''});
  clock.current.deadline=state?.deadline??0;clock.current.lock=state?.lockUntil??0;clock.current.offset=offset;
  useEffect(()=>{const id=setInterval(()=>{const t=Date.now(),c=clock.current,server=t+c.offset,mark=`${Math.ceil((c.deadline-server)/1000)}|${server<c.lock}`;if(mark!==c.mark){c.mark=mark;setNow(t);}},200);return()=>clearInterval(id);},[]);
  useEffect(()=>{
    if(connected&&!state&&!started.current&&(!strictLaunch||attempt)){
      started.current=true;
      const action=launch.joinCode?'join':launch.flow==='PRIVATE_ROOM'?'create':launch.flow==='QUICK_MATCH'?'quick':'start';
      send(action,{...launch,roomCode:launch.joinCode});
    }
  },[connected,state,send,launch,strictLaunch,attempt]);
  const textQuestion=!!state?.challenge&&!state.challenge.options.length&&!state.challenge.tiles?.length;
  useEffect(()=>{if(!textQuestion||state?.status!=='PLAYING')heading.current?.focus({preventScroll:true});},[state?.matchId,state?.round,state?.status,textQuestion]);
  useEffect(()=>{if(leaving&&!pending&&!state)onQuit();},[leaving,pending,state,onQuit]);
  const leaveRoom=()=>{if(connected&&state&&!pending){setLeaving(true);send('leave');}else if(!pending)onQuit();};
  const rankedState=state?.mode==='CONQUEST'&&state?.variant==='STANDARD';
  const integrity=state?.integrity??null;
  const lockActive=!!attempt&&rankedState&&state?.status==='PLAYING'&&integrity?.attemptId===attempt.id&&integrity?.state==='ACTIVE';
  const lockdown=useFocusLockdown({attempt,active:lockActive});
  // An in-app exit during a ranked attempt asks first (staying changes nothing).
  const quit=()=>{if(lockActive)setExitAsk(true);else leaveRoom();};
  const confirmExit=()=>{setExitAsk(false);void lockdown.report('EXIT');leaveRoom();};
  // Browser Back during a ranked attempt: keep the page and ask, like the in-app exit.
  useEffect(()=>{
    if(!lockActive)return;
    window.history.pushState(window.history.state,'',window.location.href);
    const onPop=()=>{window.history.pushState(window.history.state,'',window.location.href);setExitAsk(true);};
    window.addEventListener('popstate',onPop);return()=>window.removeEventListener('popstate',onPop);
  },[lockActive]);
  const serverNow=now+offset;
  const seconds=state?Math.max(0,Math.min(Math.ceil((state.mode==='CONQUEST'?(state.conquest?.durationMs??state.config.conquestMs):state.mode==='EXPLAIN'?state.config.explainMs:state.mode==='REFLEX'?state.config.reflexMs:state.config.reorderMs)/1000)+(state.status==='INTERMISSION'?15:0),Math.ceil((state.deadline-serverNow)/1000))):0;
  // A soft tick for the last five seconds of a live clock (sound on only).
  const lastTick=useRef(-1);
  useEffect(()=>{if(sound&&state?.status==='PLAYING'&&!state.resolved&&seconds>0&&seconds<=5&&lastTick.current!==seconds){lastTick.current=seconds;audio.current?.play('tick');}},[seconds,sound,state?.status,state?.resolved]);
  const competitive=state?.flow!=='SOLO';
  const locked=!!state&&serverNow<state.lockUntil;
  const disabled=!state||pending||!connected||locked||state.resolved||state.done||serverNow>=state.deadline;
  // Soán ngôi: only the clock closes the board. Words are queued while one is on its way or while the connection comes back.
  const boardClosed=!state||state.resolved||state.done||serverNow>=state.deadline;
  const submit=(value?:string)=>send('answer',{answer:value??answer,order:selected});
  const solveNext=!!state&&state.resolved&&state.flow==='SOLO'&&state.mode==='REORDER';
  // Keyboard: 1–8 / A–H pick an option, Enter moves on after a solved Solo chain.
  useEffect(()=>{
    const onKey=(event:KeyboardEvent)=>{
      const target=event.target as HTMLElement|null;
      if(target&&(target.tagName==='INPUT'||target.tagName==='TEXTAREA'||target.isContentEditable)||event.altKey||event.ctrlKey||event.metaKey)return;
      if(solveNext&&event.key==='Enter'&&!pending&&connected){event.preventDefault();send('next');return;}
      const options=state?.challenge?.options;if(!options?.length||disabled||state?.mode!=='REFLEX')return;
      const k=event.key.toUpperCase(),index=/^[1-8]$/.test(k)?Number(k)-1:KEYS.indexOf(k);
      if(index>=0&&index<options.length){event.preventDefault();(document.querySelector(`[data-option-index="${index}"]`) as HTMLButtonElement|null)?.click();}
    };
    window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey);
  },[solveNext,pending,connected,disabled,state,send]);
  const [wide,setWide]=useState(false);
  useEffect(()=>{const q=window.matchMedia('(min-width: 1100px)');const on=()=>setWide(q.matches);on();q.addEventListener('change',on);return()=>q.removeEventListener('change',on);},[]);
  const toggleSound=()=>{const enabled=!sound;audio.current?.enable(enabled);setSound(enabled);if(enabled)audio.current?.play('place');};
  // Replay: the same room again (Luyện lại / Tái đấu). If the finished room is no longer on the server, a Solo / Echo replay
  // opens a fresh room with the same settings instead of leaving the learner on the result screen.
  const replayAsked=useRef(false);
  const settings=(over:Record<string,unknown>={})=>state?{mode:state.variant==='CHAMPIONSHIP'?'CHAMPIONSHIP':state.mode,flow:state.flow,
    length:state.length??launch.length,difficulty:state.difficulty??launch.difficulty,bot:state.bot??launch.bot,size:state.size??launch.size,...over}:{};
  const replay=()=>{if(rankedState){setGateError(null);setGate('rematch');return;}replayAsked.current=send('rematch');};
  const fresh=()=>{if(!state)return;if(rankedState){setGateError(null);setGate('fresh');return;}send(state.flow==='PRIVATE_ROOM'?'create':state.flow==='QUICK_MATCH'?'quick':'start',settings());};
  /** "Tôi đã hiểu — Bắt đầu": the server records the acknowledgement and opens the attempt; only then does the match start. */
  const acceptGate=async()=>{
    const purpose=gate;setGateBusy(true);setGateError(null);
    try{
      const a=await beginAttempt('KING_CONQUEST');
      setAttempt(a);setSentinel(sentinelHandle(a));setGate(null);
      if(purpose==='rematch')replayAsked.current=send('rematch');
      else if(purpose==='fresh'&&state)send(state.flow==='PRIVATE_ROOM'?'create':state.flow==='QUICK_MATCH'?'quick':'start',settings());
    }catch(failure){
      const code=(failure as {response?:{data?:{code?:string}}})?.response?.data?.code;
      setGateError(kingError(code==='RATE_LIMITED'?'RATE_LIMITED':'SENTINEL_UNAVAILABLE',vi));
    }finally{setGateBusy(false);}
  };
  const backGate=()=>{if(gate==='start')onQuit();setGate(null);};
  const voidState=integrity&&(isVoided(integrity.state)||integrity.state==='PENDING_REVIEW')?integrity.state:null;
  const duelContinues=!!voidState&&state?.status==='PLAYING'&&state.flow!=='SOLO'&&state.flow!=='ECHO';
  const overlays=<>
    {gate&&<StrictModeGate vi={vi} busy={gateBusy} error={gateError} onAccept={()=>void acceptGate()} onBack={backGate} graceSeconds={Math.round((attempt?.continuityGraceMs??20000)/1000)}/>}
    {!gate&&exitAsk&&lockActive&&<StrictExitConfirm vi={vi} onStay={()=>setExitAsk(false)} onLeave={confirmExit}/>}
    {!gate&&voidState&&<AttemptVoided vi={vi} state={voidState} duelContinues={duelContinues}
      onRestart={state?.status==='FINISHED'?fresh:undefined} onLobby={leaveRoom}/>}
  </>;
  useEffect(()=>{
    if(state?.status!=='FINISHED'){replayAsked.current=false;return;}
    if(!replayAsked.current||pending||!error)return;
    replayAsked.current=false;
    if(state?.status==='FINISHED'&&(state.flow==='SOLO'||state.flow==='ECHO')&&['ROOM_NOT_FOUND','NOT_A_MEMBER','STALE_MATCH','STALE_SESSION'].includes(error))
      send('start',settings());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[error,pending,state?.status]);

  const shell=(children:ReactNode)=>{
    const node=<KingShell vi={vi} onQuit={quit} mode={state?.mode??(launch.mode==='CHAMPIONSHIP'?'REFLEX':launch.mode)}>
      <div className={styles.stageGlow} data-flash={flash?.tone} aria-hidden="true"/>{children}{overlays}</KingShell>;
    return typeof document==='undefined'?node:createPortal(node,document.body);
  };
  if(!state)return shell(<section className={styles.centerStack}>
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img className={styles.loader} src={KING_ART.crown} alt="" aria-hidden="true" width={320} height={256}/>
    <h2 className={styles.bigTitle}>{error?(vi?'Chưa thể vào đấu trường':'Unable to enter the arena'):(vi?'Đang mở đấu trường…':'Opening the arena…')}</h2>
    <p role="status" className={styles.lead}>{error?kingError(error,vi):(vi?'Đang xác thực kết nối và đồng bộ trạng thái phòng.':'Validating the connection and synchronizing room state.')}</p>
    <div className={styles.row}>{error&&!(launch.recover&&['ROOM_NOT_FOUND','ROOM_FULL','NOT_A_MEMBER'].includes(error))&&<button type="button" onClick={()=>{if(!state)started.current=!!launch.recover;retry();}} className={`${styles.cta} ${styles.ctaSmall}`}>{vi?'Thử kết nối lại':'Retry connection'}</button>}<button type="button" onClick={onQuit} className={styles.ghost}>{vi?'Về sảnh':'Return to lobby'}</button></div>
  </section>);

  const you=state.players.find(p=>p.id===state.youId),opponent=state.players.find(p=>p.id!==state.youId);
  const resolutionMs=state.config.resolutionMs??2500;
  const gained=state.score>roundStart.score&&roundStart.key===roundKey;
  const roundVerdict:Verdict=gained?'correct':state.skipped>roundStart.skipped&&roundStart.key===roundKey?'skipped':serverNow>=state.deadline?'timeout':competitive?(state.wrong>roundStart.wrong&&roundStart.key===roundKey?'wrong':'pending'):'timeout';
  const ch=state.challenge;
  // Soán ngôi keeps the board still: refusals and the connection notice go to the board's own reserved line, never above it.
  const conquestLive=state.mode==='CONQUEST'&&state.status==='PLAYING';
  const conquestNotice=!connected?(moves.length?(vi?`Đang kết nối lại. ${moves.length} từ sẽ được gửi ngay khi có mạng.`:`Reconnecting. ${moves.length} word(s) will go as soon as you are back.`):(vi?'Đang kết nối lại. Điểm và bàn chơi được giữ trên máy chủ.':'Reconnecting. The server keeps your score and board.'))
    :refused?`${refused.word.toUpperCase()}: ${kingError(refused.code,vi)}`:error?kingError(error,vi):null;
  const ranksFor=(s:KingState)=>s.variant!=='CHAMPIONSHIP'?<KingConquestRanks size={s.conquest?.size??s.size??5} category={s.flow==='SOLO'?'SOLO':'DUEL'} refresh={s.matchId} vi={vi}/>:null;
  return shell(<>
    <KingHud state={state} vi={vi} seconds={seconds} connected={connected} sound={sound} toggleSound={toggleSound}/>
    {!connected&&!conquestLive&&<p role="status" className={styles.alert}>{vi?'Đang kết nối lại. Điểm và câu hiện tại được giữ trên máy chủ.':'Reconnecting. The server retains your score and challenge.'}</p>}
    {error&&!conquestLive&&<p role="alert" className={styles.alert}>{kingError(error,vi)}{!connected&&<button type="button" onClick={()=>{if(!state)started.current=false;retry();}}>{vi?'Thử lại':'Retry'}</button>}</p>}
    <div className={styles.play} role="region" aria-label={modeName(state.mode,vi)}>
    {state.status==='WAITING'?<section className={`${styles.panel} ${styles.centerStack}`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {state.flow==='QUICK_MATCH'&&<img className={styles.loader} src={KING_ART.crown} alt="" aria-hidden="true" width={320} height={256}/>}
        <h2 ref={heading} tabIndex={-1} className={styles.bigTitle}>{state.flow==='QUICK_MATCH'?(vi?'Đang tìm đối thủ':'Searching for an opponent'):(vi?'Phòng chờ':'Waiting room')}</h2>
        <p className={styles.lead}>{state.flow==='QUICK_MATCH'?(vi?`Ghép với người đang chờ ${modeName(state.mode,vi)} cùng độ khó. Trận bắt đầu ngay khi đủ hai người.`:`Pairing with a player waiting for ${modeName(state.mode,vi)} at the same difficulty. The match starts as soon as two players are in.`):(vi?'Gửi mã phòng cho bạn bè. Khi cả hai bấm Sẵn sàng, trận đấu bắt đầu.':'Share the room code. The match begins when both players press Ready.')}</p>
        <p className="text-xs font-bold uppercase tracking-[.2em] text-slate-400">{vi?'Mã phòng':'Room code'}</p>
        <p className={styles.roomCode} aria-label={`${vi?'Mã phòng':'Room code'} ${state.roomCode}`}>{state.roomCode.split('').map((char,i)=><span key={i} className={styles.roomChar} aria-hidden="true">{char}</span>)}</p>
        {state.flow==='PRIVATE_ROOM'&&<div className={styles.row}>
          <button type="button" className={styles.ghost} onClick={()=>{void navigator.clipboard.writeText(state.roomCode).then(()=>setCopyStatus(vi?'Đã sao chép mã':'Code copied')).catch(()=>setCopyStatus(vi?'Không thể sao chép. Hãy chọn mã phía trên.':'Copy unavailable. Select the code above.'));}}><Copy aria-hidden="true"/>{vi?'Sao chép mã':'Copy code'}</button>
          <button type="button" className={styles.ghost} onClick={()=>{const link=new URL('/games/king-of-english',window.location.origin);link.searchParams.set('room',state.roomCode);void navigator.clipboard.writeText(link.href).then(()=>setCopyStatus(vi?'Đã sao chép liên kết':'Invite link copied')).catch(()=>setCopyStatus(vi?'Không thể sao chép. Chia sẻ mã phòng phía trên.':'Copy unavailable. Share the room code above.'));}}><LinkIcon aria-hidden="true"/>{vi?'Sao chép lời mời':'Copy invite'}</button>
        </div>}
        <p role="status" className={styles.copyNote}>{copyStatus}</p>
        <div className={styles.slots}>
          {[you,opponent].map((player,i)=><div key={i} className={styles.slot} data-filled={!!player}>
            <span className={styles.slotAvatar} aria-hidden="true">{player?(player.id===state.youId?(vi?'B':'Y'):'2'):'?'}</span>
            <span className={styles.slotName}>{player?(player.id===state.youId?(vi?'Bạn':'You'):player.name):(vi?'Đang chờ…':'Waiting…')}</span>
            <span className={styles.slotState} data-ready={!!player?.ready}>{player?(player.ready?(vi?'Sẵn sàng':'Ready'):(vi?'Chưa sẵn sàng':'Not ready')):(vi?'Chỗ trống':'Open seat')}{player&&!player.connected?` · ${vi?'mất kết nối':'disconnected'}`:''}</span>
          </div>)}
        </div>
        <p className="text-sm text-slate-300">{opponent?(vi?'Hai người đã vào phòng.':'Both players are in the room.'):(vi?'Đang chờ người chơi thứ hai.':'Waiting for a second player.')}</p>
        <button type="button" className={`${styles.cta} ${styles.ctaSmall}`} disabled={pending||!connected||you?.ready} onClick={()=>send('ready')}><Check aria-hidden="true"/>{you?.ready?(vi?'Đã sẵn sàng':'Ready'):(vi?'Sẵn sàng':'Ready up')}</button>
      </section>
    :state.status==='INTERMISSION'?<section className={`${styles.panel} ${styles.centerStack}`}>
        <h2 ref={heading} tabIndex={-1} className={styles.bigTitle}>{vi?'Vòng đã khép lại':'Round complete'}</h2>
        <div className={styles.journey} aria-label={vi?'Hành trình Đại Chiến':'Championship journey'}>{['REFLEX','EXPLAIN','REORDER','CONQUEST'].map((m,i)=>{const r=state.championshipRound??0;return <span key={m} className="contents">
          <span className={styles.journeyNode} data-state={i<=r?'done':i===r+1?'next':'todo'} title={modeName(m,vi)}>{i+1}</span>{i<3&&<span className={styles.journeyLine} aria-hidden="true"/>}</span>;})}</div>
        <p className={styles.lead}>{vi?`Vòng ${((state.championshipRound??0)+1)}/4 · Tổng hiện tại ${state.championshipTotal??0}/400`:`Round ${(state.championshipRound??0)+1}/4 · Current total ${state.championshipTotal??0}/400`}</p>
        <ChampionshipBreakdown state={state} vi={vi}/>
        <p className="text-sm font-bold text-sky-200">{vi?'Tiếp theo':'Next'}: {modeName(['REFLEX','EXPLAIN','REORDER','CONQUEST'][(state.championshipRound??0)+1]??'',vi)} · {seconds}s</p>
        <button type="button" disabled={pending||!connected||you?.ready} onClick={()=>send('continue')} className={`${styles.cta} ${styles.ctaSmall}`}><ChevronRight aria-hidden="true"/>{you?.ready?(vi?'Đang chờ đối thủ':'Waiting for opponent'):vi?'Tiếp tục vòng sau':'Continue to next round'}</button>
      </section>
    :state.status==='FINISHED'?<Results state={state} vi={vi} competitive={competitive} pending={pending} connected={connected} send={send} quit={quit} heading={heading} replay={replay} fresh={fresh}/>
    :state.mode==='EXPLAIN'?<KingExplainRound state={state} vi={vi} disabled={disabled} answer={answer} setAnswer={setAnswer} send={send} verdict={roundVerdict} resolutionMs={resolutionMs}/>
    :state.mode==='CONQUEST'?<div className={styles.panel}><KingConquestBoard state={state} vi={vi} disabled={boardClosed} send={send} submitMove={submitMove} moves={moves} notice={conquestNotice} offline={!connected} retry={retry} extra={ranksFor(state)}/></div>
    :state.done?<section className={`${styles.panel} ${styles.centerStack}`}>
        <Trophy className="h-12 w-12 text-amber-300" aria-hidden="true"/>
        <h2 ref={heading} tabIndex={-1} className={styles.bigTitle}>{vi?'Đã hoàn thành. Đang chờ đối thủ.':'Complete. Waiting for your opponent.'}</h2>
        {state.mode==='REFLEX'&&<div className="w-full max-w-2xl text-left"><ReflexFeedback state={state} vi={vi} wide={wide}/></div>}
      </section>
    :ch&&<div className={state.mode==='REFLEX'?styles.split:'grid'}>
      <section className={`${styles.panel} ${styles.enter}`} key={`${state.matchId}:${state.championshipRound}:${state.round}`}>
        <div className={styles.qMeta}>
          <span className={styles.chip}>{state.mode==='REFLEX'?(label(FAMILY,ch.family,vi)??ch.family):(label(STRUCTURES,ch.family,vi)??(vi?'Ghép câu':'Sentence'))}</span>
          <span className={`${styles.chip} ${styles.chipMuted}`}>{vi?'Độ khó':'Difficulty'} {ch.difficulty}</span>
          {state.revisiting&&<span className={`${styles.chip} ${styles.chipMuted}`}>{vi?'Câu đã bỏ qua':'Skipped revisit'}</span>}
        </div>
        <h2 ref={heading} tabIndex={-1} className={state.mode==='REORDER'?styles.promptSmall:styles.prompt} lang="en">{ch.prompt}</h2>
        {ch.context&&<p className={styles.context} lang="en">{ch.occurrenceStart !== undefined && ch.occurrenceEnd !== undefined ? <>{ch.context.slice(0,ch.occurrenceStart)}<mark>{ch.context.slice(ch.occurrenceStart,ch.occurrenceEnd)}</mark>{ch.context.slice(ch.occurrenceEnd)}</> : ch.context}</p>}
        {state.resolved&&state.mode==='REORDER'?<div className="mt-5">
            <KingFeedback vi={vi} verdict={roundVerdict} yours={lastOrder.key===roundKey?lastOrder.text:null} truth={ch.answer}
              meaning={ch.meaning&&norm(ch.meaning)!==norm(ch.answer??'')?ch.meaning:null} points={gained?state.score-roundStart.score:null}
              structure={label(STRUCTURES,ch.family,vi)} countdownMs={competitive?resolutionMs:undefined}
              note={roundVerdict==='wrong'||roundVerdict==='pending'?(vi?'Đối thủ đã ghép đúng trước.':'Your opponent completed it first.'):roundVerdict==='timeout'?(vi?'Hết thời gian của câu này.':'Time ran out for this sentence.'):competitive?(vi?'Câu tiếp theo sắp bắt đầu…':'The next sentence starts shortly…'):null}/>
          </div>
          :<ChallengeInput item={ch} vi={vi} disabled={disabled} selected={selected} setSelected={setSelected} answer={answer} setAnswer={setAnswer} submit={submit}/>}
        <p role="status" aria-live="polite" className={`${styles.status} mt-3`}>{locked&&(vi?'Thứ tự chưa đúng. Chờ một nhịp rồi thử lại.':'Not accepted. Wait briefly and try again.')}</p>
        <div className={`${styles.actions} ${styles.actionsEnd}`}>
          {state.mode==='REFLEX'&&ch.options.length>0&&<p className={`${styles.hint} mr-auto`}>{vi?'Phím tắt':'Shortcuts'}: <kbd>1</kbd>–<kbd>{ch.options.length}</kbd> {vi?'hoặc':'or'} <kbd>A</kbd>–<kbd>{KEYS[ch.options.length-1]}</kbd></p>}
          {solveNext?<button type="button" disabled={pending||!connected} onClick={()=>send('next')} className={`${styles.cta} ${styles.ctaSmall}`}>{vi?'Câu tiếp theo':'Next challenge'}<ChevronRight aria-hidden="true"/></button>
            :(state.mode==='REFLEX'||state.flow==='SOLO')&&!state.resolved&&<button type="button" disabled={disabled} onClick={()=>send('skip')} className={styles.ghost}><SkipForward aria-hidden="true"/>{vi?'Bỏ qua':'Skip'}</button>}
        </div>
        {solveNext&&<p className={`${styles.hint} text-right`}>{vi?'Đọc kỹ lời giải, rồi nhấn':'Take your time, then press'} <kbd>Enter</kbd></p>}
      </section>
      {state.mode==='REFLEX'&&<aside className={styles.rail2} aria-label={vi?'Lời giải câu trước':'Previous answer'}>
        {state.lastResult?<ReflexFeedback state={state} vi={vi} wide={wide}/>:<div className={styles.railNote}><strong>{vi?'Mỗi câu trả lời đều có lời giải':'Every answer comes with its solution'}</strong>{vi?'Sau khi bạn trả lời, đáp án đúng và giải nghĩa của câu đó hiện ở đây — câu tiếp theo vẫn bắt đầu ngay, không mất giờ của bạn.':'After you answer, the correct answer and its meaning appear here — the next question still starts at once, on your own clock.'}</div>}
      </aside>}
    </div>}
    </div>
    {state.status!=='FINISHED'&&<p className={styles.footNote}><Crown className="mr-1 inline h-3 w-3" aria-hidden="true"/>{state.mode==='CONQUEST'&&state.variant!=='CHAMPIONSHIP'?(vi?'Ván hoàn thành được tính vào bảng xếp hạng của kích thước bàn này.':'Completed rounds count on this board size’s leaderboard.'):(vi?'Phiên chơi không ghi vào tiến độ hay bảng xếp hạng.':'Sessions do not write learning progress or leaderboards.')}</p>}
  </>);
}
