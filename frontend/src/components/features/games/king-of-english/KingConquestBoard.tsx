'use client';
import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Crown, Send, Undo2, RotateCcw, History } from 'lucide-react';
import type { KingState } from './realtimeTypes';
import type { KingMove } from './useKingRealtime';
import styles from './king.module.css';

export function adjacent(a:number,b:number,size=5){return a!==b&&Math.max(Math.abs(Math.floor(a/size)-Math.floor(b/size)),Math.abs(a%size-b%size))===1;}
export function extendPath(path:number[],cell:number,size=5){
  if(!Number.isInteger(cell)||cell<0||cell>=size*size)return path;
  if(path.at(-1)===cell)return path;
  if(path.length>1&&path.at(-2)===cell)return path.slice(0,-1);
  if(path.includes(cell)||path.length>=8||path.length&& !adjacent(path.at(-1)!,cell,size))return path;
  return [...path,cell];
}
/** Centre of a cell in the board's 0–100 box (size equal columns): the path line is drawn through these points. */
const centre=(cell:number,size:number)=>`${(cell%size+0.5)*100/size},${(Math.floor(cell/size)+0.5)*100/size}`;

/**
 * Soán ngôi — the throne board, 4×4 to 7×7. Every ownership colour, count and score is the server's (owners, history,
 * breakdown); the client only draws the learner's own path before they claim it. Ownership is never colour-only (● ▲ —).
 * Feedback lives in ONE reserved line under the controls (`notice` = the server's refusal, else the last capture), so a
 * message never moves the board.
 */
export function KingConquestBoard({state,vi,disabled,send,submitMove,moves=[],notice,offline,retry,extra}:{state:KingState;vi:boolean;disabled:boolean;
  send:(action:string,payload?:Record<string,unknown>)=>boolean;submitMove?:(word:string,path:number[])=>boolean;moves?:KingMove[];notice?:string|null;offline?:boolean;retry?:()=>void;extra?:ReactNode}){
  const [selection,setSelection]=useState<{match:string;path:number[]}>({match:'',path:[]});
  const [filter,setFilter]=useState<'ALL'|'YOU'|'OPPONENT'>('ALL');
  const dragging=useRef(false),grid=useRef<HTMLDivElement>(null),buttons=useRef<(HTMLButtonElement|null)[]>([]);
  const board=state.conquest;if(!board)return null;
  const size=board.size??(Math.round(Math.sqrt(board.letters.length))||5),cells=size*size,throne=board.throne??Math.floor(cells/2);
  const wordHistory=board.wordHistory??[],yourUsedWordCount=board.yourUsedWordCount??'—',opponentUsedWordCount=board.opponentUsedWordCount??'—';
  // The word being built belongs to the learner: a word accepted meanwhile (theirs or the opponent's) never clears it.
  const path=selection.match===state.matchId?selection.path:[];
  const change=(value:number[])=>setSelection({match:state.matchId,path:value});
  const append=(cell:number)=>setSelection(previous=>({match:state.matchId,path:extendPath(previous.match===state.matchId?previous.path:[],cell,size)}));
  const word=path.map(i=>board.letters[i]).join('');
  const history=wordHistory.filter(move=>filter==='ALL'||(filter==='YOU'?move.playerId===state.youId:move.playerId!==state.youId));
  const mine=board.owners.filter(o=>o===state.youId).length,neutral=board.owners.filter(o=>o===-1).length,theirs=cells-mine-neutral;
  const last=wordHistory.at(-1),captured=new Set(last?.path??board.lastPath??[]);
  const claim=()=>{if(disabled||path.length<3)return;if(submitMove?submitMove(word,path):send('move',{answer:word,order:path}))change([]);};
  const sending=new Set(moves.flatMap(move=>move.path));
  const capture=board.lastWord?`${board.lastPlayer===state.youId?(vi?'Bạn':'You'):(vi?'Đối thủ':'Opponent')}: ${board.lastWord.toUpperCase()}${last&&last.word===board.lastWord?` · +${last.wordPoints} ${vi?'điểm từ':'word pts'} · ${last.territoryAfter} ${vi?'ô':'tiles'}${last.throneAfter?' · ♛':''}`:''}`:'';
  return <div className={styles.conquest}>
    <div className={styles.boardWrap} data-size={size}>
      <div className={styles.territory}>
        <div className={styles.territoryLegend}><span>● {vi?'Bạn':'You'} {mine}</span><span>{vi?'Lãnh thổ':'Territory'} <strong>{Math.round(board.territory/cells*100)}%</strong></span><span>▲ {vi?'Đối thủ':'Opponent'} {theirs}</span></div>
        <div className={styles.territoryBar} aria-hidden="true"><span className={styles.tBlue} style={{flexGrow:mine}}/><span className={styles.tNeutral} style={{flexGrow:neutral}}/><span className={styles.tRed} style={{flexGrow:theirs}}/></div>
        <p className="flex flex-wrap items-center gap-2 text-xs font-semibold text-slate-300"><Crown className="h-4 w-4 text-amber-300" aria-hidden="true"/>{board.owners[throne]===state.youId?(vi?'Bạn giữ ngai':'Your throne'):board.owners[throne]===-1?(vi?'Ngai trống':'Neutral throne'):(vi?'Ngai đối thủ':'Opponent throne')}<span aria-hidden="true">·</span>{vi?'Từ dài nhất':'Longest word'} {board.longestWord}<span aria-hidden="true">·</span>{size} × {size}</p>
      </div>
      <div className={styles.board}>
        <div ref={grid} role="group" aria-label={vi?`Bàn chữ Soán ngôi ${size} × ${size}`:`Conquest letter board ${size} × ${size}`} className={styles.boardGrid} style={{['--n' as string]:size}}
          onPointerMove={event=>{if(!dragging.current||disabled)return;const element=document.elementFromPoint(event.clientX,event.clientY)?.closest<HTMLElement>('[data-king-cell]');if(element&&grid.current?.contains(element))append(Number(element.dataset.kingCell));}}
          onPointerUp={event=>{dragging.current=false;if(grid.current?.hasPointerCapture(event.pointerId))grid.current.releasePointerCapture(event.pointerId);}}
          onPointerCancel={()=>{dragging.current=false;}}
          onKeyDown={event=>{if(event.key==='Escape'){change([]);event.preventDefault();}if(event.key==='Backspace'){change(path.slice(0,-1));event.preventDefault();}}}>
          {board.letters.map((letter,cell)=>{
            const position=path.indexOf(cell),owner=board.owners[cell],owned=owner===state.youId,neutralCell=owner===-1;
            return <button type="button" key={cell} ref={element=>{buttons.current[cell]=element;}} data-king-cell={cell} disabled={disabled}
              data-owner={neutralCell?'none':owned?'you':'rival'} data-throne={cell===throne} data-path={position>=0} data-captured={!!last&&captured.has(cell)&&position<0} data-sending={sending.has(cell)&&position<0}
              aria-pressed={position>=0} aria-label={`${letter}, ${vi?'ô':'tile'} ${cell+1}, ${cell===throne?(vi?'ngai vàng, ':'throne, '):''}${neutralCell?(vi?'chưa thuộc ai':'neutral'):owned?(vi?'của bạn':'yours'):(vi?'của đối thủ':'opponent')}${position>=0?`, ${vi?'vị trí':'path position'} ${position+1}`:''}`}
              onPointerDown={event=>{if(event.button!==0||disabled)return;dragging.current=true;grid.current?.setPointerCapture(event.pointerId);append(cell);}}
              onClick={event=>{if(event.detail===0&&!disabled)append(cell);}}
              onKeyDown={event=>{const delta=({ArrowLeft:-1,ArrowRight:1,ArrowUp:-size,ArrowDown:size} as Record<string,number>)[event.key];if(delta){event.preventDefault();const next=cell+delta;if(next>=0&&next<cells&&(Math.abs(delta)===size||Math.floor(next/size)===Math.floor(cell/size)))buttons.current[next]?.focus();}}}
              className={styles.tile} style={{touchAction:'none'}}>
              {cell===throne&&<Crown className={styles.tileCrown} aria-hidden="true"/>}
              <span className={styles.tileLetter}>{letter}</span><span className={styles.tileMark} aria-hidden="true">{position>=0?position+1:neutralCell?'—':owned?'●':'▲'}</span>
            </button>;
          })}
          {path.length>1&&<svg className={styles.pathLine} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><polyline className={styles.pathGlow} points={path.map(cell=>centre(cell,size)).join(' ')} vectorEffect="non-scaling-stroke"/><polyline points={path.map(cell=>centre(cell,size)).join(' ')} vectorEffect="non-scaling-stroke"/></svg>}
        </div>
      </div>
      <div className={styles.wordBar}><p aria-live="polite" className={styles.wordValue}>{word||'—'}</p><span className={styles.wordCount}>{path.length}/8</span></div>
      <div className={styles.actions}>
        <div className={styles.chainTools}>
          <button type="button" className={styles.ghost} disabled={disabled||!path.length} onClick={()=>change(path.slice(0,-1))} aria-label={vi?'Lùi một ô':'Undo tile'}><Undo2 aria-hidden="true"/></button>
          <button type="button" className={styles.ghost} disabled={disabled||!path.length} onClick={()=>change([])} aria-label={vi?'Xóa đường':'Clear path'}><RotateCcw aria-hidden="true"/></button>
        </div>
        <button type="button" disabled={disabled||path.length<3} onClick={claim} className={`${styles.cta} ${styles.ctaSmall}`}><Send aria-hidden="true"/>{vi?'Chiếm ô':'Claim tiles'}</button>
      </div>
      <div className={styles.feedSlot} aria-live="polite" role="status">
        {notice?<p key={notice} className={styles.feedLine} data-tone="bad">{notice}{offline&&retry&&<button type="button" className={styles.feedRetry} onClick={retry}>{vi?'Thử lại ngay':'Retry now'}</button>}</p>
          :moves.length?<p className={styles.feedLine} data-sending="true"><span lang="en">{moves.map(move=>move.word.toUpperCase()).join(' · ')}</span> · {vi?'đang gửi…':'sending…'}</p>
          :capture?<p key={(last?.sequence??0)+board.lastWord} className={styles.feedLine} data-rival={board.lastPlayer!==state.youId}><span lang="en">{capture}</span></p>:null}
      </div>
      <p className={styles.hint}>● {vi?'Bạn':'You'} · ▲ {vi?'Đối thủ':'Opponent'} · — {vi?'Trung lập':'Neutral'} · {vi?'Nối các ô liền nhau, kể cả đường chéo; mỗi từ chỉ dùng một lần. Kéo hoặc chạm lần lượt; bàn phím: phím mũi tên, Enter, Backspace lùi, Escape xóa.':'Connect adjacent tiles, diagonals included; each word once. Drag or tap in sequence; keyboard: arrows, Enter, Backspace undo, Escape clear.'}</p>
    </div>
    <aside className={styles.side} aria-label={vi?'Cuộc đua lãnh thổ':'Territory race'}>
      <h3 className={styles.subTitle}><Crown aria-hidden="true"/>{vi?'Cuộc đua lãnh thổ':'Territory race'}</h3>
      {board.playerBreakdown&&<div className={styles.sideStats}>{Object.entries(board.playerBreakdown).map(([id,stats])=><div key={id} className={styles.sideCard} data-rival={Number(id)!==state.youId}>
        <span className="font-bold">{Number(id)===state.youId?(vi?'Bạn':'You'):(vi?'Đối thủ':'Opponent')}</span><strong>{stats.score}</strong>
        <span>{stats.wordCount} {vi?'từ hợp lệ':'accepted words'} · {vi?'điểm từ':'word pts'} {stats.wordPoints}</span>
        <span>{vi?'Lãnh thổ':'Territory'} {stats.territory} × {state.config.conquestTerritoryPoint}{stats.throne?` · ${vi?'ngai':'throne'} +${state.config.conquestThroneBonus}`:''}</span></div>)}</div>}
      {extra}
      <details open className="grid gap-2"><summary className="flex cursor-pointer items-center gap-2 py-2 text-sm font-bold text-slate-200"><History className="h-4 w-4" aria-hidden="true"/>{vi?'Lịch sử từ':'Word history'} · {vi?'Bạn':'You'} {yourUsedWordCount} · {vi?'Đối thủ':'Opponent'} {opponentUsedWordCount}</summary>
        <div className={styles.filters} aria-label={vi?'Lọc lịch sử từ':'Filter word history'}>{(['ALL','YOU','OPPONENT'] as const).map(key=><button type="button" key={key} aria-pressed={filter===key} onClick={()=>setFilter(key)} className={styles.filter}>{key==='ALL'?(vi?'Tất cả':'All'):key==='YOU'?(vi?'Của bạn':'Yours'):(vi?'Đối thủ':'Opponent')}</button>)}</div>
        <div className={styles.history}>{history.length?[...history].reverse().map(move=><div key={move.sequence} className={styles.move} data-rival={move.playerId!==state.youId}><span>#{move.sequence} {move.playerId===state.youId?(vi?'Bạn':'You'):(vi?'Đối thủ':'Opponent')} · <b lang="en">{move.word.toUpperCase()}</b>{move.meaningVi&&<small lang="vi" className={styles.gloss}>{move.meaningVi}</small>}</span><span className={styles.moveMeta}>+{move.wordPoints} · {move.territoryAfter} {vi?'ô':'tiles'}{move.throneAfter?' · ♛':''}</span></div>):<p className={styles.hint}>—</p>}</div>
        <p className="break-words text-xs leading-relaxed text-slate-400">{board.usedWords.length?`${vi?'Toàn trận':'Match'}: ${board.usedWords.join(' · ')}`:'—'}</p>
      </details>
    </aside>
  </div>;
}
