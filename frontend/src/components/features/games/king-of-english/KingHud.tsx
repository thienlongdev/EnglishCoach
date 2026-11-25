'use client';
import { BookOpenText, Crown, Hexagon, Layers3, Volume2, VolumeX, Zap } from 'lucide-react';
import { BrandWhaleIcon } from '@/components/common/BrandWhaleIcon';
import type { KingState } from './realtimeTypes';
import styles from './king.module.css';

export const MODE_NAMES:Record<string,[string,string]>={REFLEX:['Phản xạ','Reflex'],EXPLAIN:['Giải nghĩa','Meaning'],REORDER:['Xâu chuỗi','Sentence Chain'],CONQUEST:['Soán ngôi','Crown Conquest']};
export const modeName=(mode:string,vi:boolean)=>MODE_NAMES[mode]?.[vi?0:1]??mode;
export const MODE_ICONS:Record<string,typeof Zap>={REFLEX:Zap,EXPLAIN:BookOpenText,REORDER:Layers3,CONQUEST:Hexagon};
export const flowName=(flow:string,vi:boolean)=>flow==='SOLO'?(vi?'Tự luyện':'Solo'):flow==='ECHO'?(vi?'Đấu Echo':'Echo duel'):flow==='QUICK_MATCH'?'1v1':(vi?'Phòng riêng':'Private room');

/** Total seconds of the current mode's clock (the server's own config), for the timer ring. */
export function modeSeconds(state:KingState){
  const c=state.config;
  return Math.ceil((state.status==='INTERMISSION'?15_000:state.mode==='CONQUEST'?(state.conquest?.durationMs??c.conquestMs):state.mode==='EXPLAIN'?c.explainMs:state.mode==='REFLEX'?c.reflexMs:c.reorderMs)/1000);
}

export function KingHud({state,vi,seconds,connected,sound,toggleSound}:{state:KingState;vi:boolean;seconds:number;connected:boolean;sound:boolean;toggleSound:()=>void}){
  const opponent=state.players.find(p=>p.id!==state.youId),you=state.players.find(p=>p.id===state.youId),championship=state.variant==='CHAMPIONSHIP';
  const Icon=MODE_ICONS[state.mode]??Crown,total=modeSeconds(state),live=state.status==='PLAYING'||state.status==='INTERMISSION';
  const r=26,circ=2*Math.PI*r,frac=total>0?Math.max(0,Math.min(1,seconds/total)):0;
  const pips=state.status==='PLAYING'&&state.mode!=='CONQUEST'&&state.count>0&&state.count<=24;
  const current=Math.min(state.completed,state.count);
  return <header className={styles.hud}>
    <div className={styles.hudRow}>
      <div className={styles.hudMode}>
        <span className={styles.hudEmblem} aria-hidden="true">{championship?<Crown/>:<Icon/>}</span>
        <div className="min-w-0">
          <p className={styles.hudTitle}>{modeName(state.mode,vi)}{championship&&<span className="ml-2 text-sm text-amber-200">{vi?'Vòng':'Round'} {(state.championshipRound??0)+1}/4</span>}</p>
          <p className={styles.hudSub}><span className={styles.dot} data-off={!connected} aria-hidden="true"/>{connected?(vi?'Đã kết nối':'Connected'):(vi?'Đang khôi phục kết nối':'Restoring connection')}
            <span aria-hidden="true">·</span>{flowName(state.flow,vi)}{state.status==='PLAYING'&&state.mode!=='CONQUEST'&&<><span aria-hidden="true">·</span>{vi?'Câu':'Question'} {Math.min(state.round+1,state.count)}/{state.count}</>}</p>
        </div>
      </div>
      <div className={styles.hudRight}>
        <button type="button" aria-pressed={sound} aria-label={vi?(sound?'Tắt âm thanh':'Bật âm thanh'):(sound?'Mute sounds':'Enable sounds')} onClick={toggleSound} className={styles.iconBtn}>{sound?<Volume2/>:<VolumeX/>}</button>
        {live&&<div className={styles.timer} data-low={state.status==='PLAYING'&&seconds<=10} aria-label={`${vi?'Thời gian còn lại':'Time remaining'} ${seconds}s`} role="timer">
          <svg viewBox="0 0 60 60" aria-hidden="true"><circle className={styles.timerTrack} cx="30" cy="30" r={r}/><circle className={styles.timerArc} cx="30" cy="30" r={r} strokeDasharray={circ} strokeDashoffset={circ*(1-frac)}/></svg>
          <span className={styles.timerValue}>{seconds}</span>
        </div>}
        <div className={styles.scoreBox}>
          <span className={styles.scoreLabel}>{championship?(vi?'Tổng Đại Chiến':'Championship'):(vi?'Điểm':'Score')}</span>
          <span key={championship?state.championshipTotal:state.score} className={`${styles.scoreValue} ${styles.scoreBump}`}><Crown aria-hidden="true"/>{championship?`${state.championshipTotal??0}`:state.score}</span>
        </div>
      </div>
    </div>
    {pips&&<div className={styles.progress} aria-hidden="true">{Array.from({length:state.count},(_,i)=><span key={i} className={styles.pip} data-state={i<current?'done':i===current&&!state.done?'now':'todo'}/>)}</div>}
    {opponent&&<div className={styles.duel} data-two="true">
      {[you,opponent].map(player=>{if(!player)return null;const mine=player.id===state.youId;return <div key={player.id} className={styles.player} data-rival={!mine}>
        <span className={styles.playerName}>{player.id===0&&<BrandWhaleIcon size="sm" character="tech"/>}{mine?(vi?'Bạn':'You'):player.id===0?'Echo':player.name}{!player.connected&&<span aria-label={vi?'mất kết nối':'disconnected'}> · ↻</span>}{state.status==='WAITING'&&player.ready&&<span className="text-emerald-300"> · {vi?'Sẵn sàng':'Ready'}</span>}</span>
        <strong className={styles.playerScore}>{player.score}</strong></div>;})}
    </div>}
  </header>;
}

export function ChampionshipBreakdown({state,vi}:{state:KingState;vi:boolean}){
  const opponent=state.players.find(p=>p.id!==state.youId);
  return <div className={styles.breakdown}>{state.championshipRounds?.map((round,index)=><div key={round.mode+index} className={styles.breakRow}>
      <div><p className={styles.breakName}>{index+1}. {modeName(round.mode,vi)}</p><p className={styles.breakSub}>{vi?'Điểm gốc':'Raw score'} {round.players[String(state.youId)]?.raw??0}{round.mode==='CONQUEST'?'':`/${round.rawMax}`}{opponent?` · ${vi?'Đối thủ':'Opponent'} ${round.players[String(opponent.id)]?.normalized??0}/100`:''}</p></div>
      <strong className={styles.breakScore}>{round.players[String(state.youId)]?.normalized??0}{round.mode==='CONQUEST'?null:<small> /100</small>}</strong></div>)}
    <details className={styles.details}><summary>{vi?'Điểm được tính thế nào?':'How are points calculated?'}</summary><p className="leading-relaxed">{vi?'Mỗi vòng: làm tròn (điểm gốc / điểm chuẩn × 100). Phản xạ: số câu đã giao. Giải nghĩa: tối đa 3 điểm mỗi câu (hai người đổi vai đều nhau). Xâu chuỗi: 10 điểm/câu tự luyện, 1 điểm/câu đấu; Đại Chiến không có hiệp phụ. Soán ngôi: 75 điểm tính là 100 và không có trần; mỗi từ hợp lệ mới đều cộng thêm điểm. Vòng chưa chơi do bỏ cuộc được 0; người bỏ cuộc thua.':'Each round: round(raw / standard × 100). Reflex: assigned questions. Explain: maximum 3 per question (equal alternating human roles). Reorder: 10 per Solo question, 1 per duel question; no championship sudden death. Conquest: 75 points count as 100 with no ceiling; every new valid word keeps adding points. Unplayed rounds after a forfeit score zero; the departing player loses.'}</p></details>
  </div>;
}
