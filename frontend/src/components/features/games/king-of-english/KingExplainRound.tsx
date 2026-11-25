'use client';
import { useRef, useEffect } from 'react';
import { Send, EyeOff, Feather, Search } from 'lucide-react';
import type { KingState } from './realtimeTypes';
import { KingFeedback } from './KingFeedback';
import type { Verdict } from './KingFeedback';
import styles from './king.module.css';

/**
 * Giải nghĩa — the Meaning lantern. The describer alone sees the hidden word; clues glow in one by one; the guesser hunts the
 * word behind them. At the server's resolution the word and its source meaning are revealed to everyone for the hold.
 */
export function KingExplainRound({state,vi,disabled,answer,setAnswer,send,verdict='pending',resolutionMs}:{
  state:KingState;vi:boolean;disabled:boolean;answer:string;setAnswer:(value:string)=>void;
  send:(action:string,payload?:Record<string,unknown>)=>boolean;verdict?:Verdict;resolutionMs?:number;
}){
  const input=useRef<HTMLTextAreaElement>(null),e=state.explain;
  useEffect(()=>{if(!disabled)input.current?.focus({preventScroll:true});},[state.round,disabled]);
  if(!e)return null;
  const describing=e.role==='DESCRIBER',human=state.flow==='QUICK_MATCH'||state.flow==='PRIVATE_ROOM';
  const submit=()=>{if(!disabled&&answer.trim())send(describing?'clue':'answer',{answer});};
  return <div className={styles.panel}>
    <p className={styles.role}>{describing?<Feather aria-hidden="true"/>:<Search aria-hidden="true"/>}{describing?(vi?'Bạn dẫn đường':'You describe'):(vi?'Bạn khám phá':'You guess')}</p>
    <h2 className={styles.promptSmall}>{describing?(vi?'Giúp đối thủ hiểu từ bí mật bằng những gợi ý tiếng Anh.':'Help your partner find the hidden word with English clues.'):(vi?'Tìm từ tiếng Anh ẩn sau những gợi ý.':'Find the English word behind the clues.')}</h2>
    {describing&&e.target&&!state.resolved&&<div className={styles.secret}><p className={styles.secretLabel}>{vi?'Chỉ bạn thấy':'Only you can see'}</p><p className={styles.secretWord} lang="en">{e.target}</p>
      <p className={styles.rule}>{vi?'Mô tả bằng tiếng Anh. Không dùng đáp án, từ thay thế, số chữ, vị trí chữ cái hoặc đánh vần trực tiếp.':'Describe in English only. Avoid the answer, aliases, spelling, letter counts and letter positions.'}</p>
      {!!e.forbiddenForms?.length&&<div className={styles.forbidden} aria-label={vi?'Không dùng':'Avoid'}><span className="sr-only">{vi?'Không dùng':'Avoid'}: </span>{e.forbiddenForms.map(form=><span key={form} lang="en">{form}</span>)}</div>}</div>}
    <ol aria-label={vi?'Gợi ý':'Clues'} aria-live="polite" className={styles.clues}>
      {e.clues.map((clue,index)=><li key={index} className={styles.clue}><span className={styles.clueNo}>{index+1}</span><p className={styles.clueText} lang="en">{clue}</p></li>)}
    </ol>
    {!state.resolved&&<p className={styles.ladder} aria-label={vi?'Điểm theo thời điểm đoán':'Points by guess time'}>{human
      ?[[15,4],[30,3],[45,2],[60,1]].map(([s,p])=><span key={s} className={styles.ladderStep}>≤{s}s · +{p}</span>)
      :[0,1,2].map(i=><span key={i} className={styles.ladderStep} data-now={e.clueIndex===i}>{vi?`Gợi ý ${i+1}`:`Clue ${i+1}`} · +{3-i}</span>)}
      {describing&&<span>{vi?'Bạn dẫn đường: +2 nếu được đoán trong 30 giây, sau đó +1.':'Describer: +2 if found within 30 s, then +1.'}</span>}</p>}
    {!e.clues.length&&<p role="status" className={styles.waiting}><EyeOff aria-hidden="true"/>{vi?'Đang chờ gợi ý đầu tiên.':'Waiting for the first clue.'}</p>}
    {state.resolved?<div className="mt-4"><KingFeedback vi={vi} verdict={verdict} truth={e.target} meaning={e.meaning} countdownMs={resolutionMs}
        note={verdict==='correct'?(describing?(vi?'Đối thủ đã đoán ra từ của bạn.':'Your partner found your word.'):(vi?'Bạn đã tìm ra từ bí mật.':'You found the hidden word.'))
          :verdict==='timeout'?(vi?'Chưa ai tìm ra từ trong thời gian của lượt.':'Nobody found the word in time.'):(verdict==='wrong'||verdict==='pending')&&state.flow!=='SOLO'?(vi?'Đối thủ đã đoán ra trước.':'Your opponent found it first.'):(vi?'Sắp sang lượt mới…':'Next round starts shortly…')}/></div>
      :<form className={styles.answerForm} onSubmit={event=>{event.preventDefault();submit();}}>
      <label className={styles.answerField} htmlFor="king-explain-input"><span className={styles.answerLabel}>{describing?(vi?'Gợi ý tiếng Anh của bạn':'Your English clue'):(vi?'Từ hoặc cụm từ bạn đoán':'Your guess')}</span>
      <textarea ref={input} id="king-explain-input" rows={describing?3:1} value={answer} maxLength={describing?state.config.explainClueMax:160} disabled={disabled} onChange={event=>setAnswer(event.target.value)}
        onKeyDown={event=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();submit();}}}
        autoComplete="off" spellCheck={false} lang="en" className={styles.answerInput}/></label>
      <button type="submit" disabled={disabled||!answer.trim()} className={`${styles.cta} ${styles.ctaSmall}`}><Send aria-hidden="true"/>{describing?(vi?'Gửi gợi ý':'Send clue'):(vi?'Đoán':'Guess')}</button>
      <p className={`${styles.hint} w-full`}>{describing?`${answer.length}/${state.config.explainClueMax}`:(vi?`${e.guessAttempts}/${state.config.explainGuessCap} lượt đoán`:`${e.guessAttempts}/${state.config.explainGuessCap} guesses`)}</p>
    </form>}
  </div>;
}
