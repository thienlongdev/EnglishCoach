'use client';
import { useEffect, useState } from 'react';
import { Crown, Medal, Trophy } from 'lucide-react';
import { apiClient } from '@/services/api-client';
import styles from './king.module.css';

export type ConquestBoardData = { size:number; category:'SOLO'|'DUEL';
  top:{ rank:number; name:string; score:number; achievedAt:string; you:boolean }[];
  you:{ best:number; rank:number|null; achievedAt:string }|null };

/**
 * Soán ngôi rankings for ONE board size and category: the server's Top 5 (best stored score per learner, completed matches
 * only) and the viewer's own best. Read on mount and again when `refresh` changes (a new result was stored); no cache, no
 * storage, no polling.
 */
export function KingConquestRanks({size,category,refresh,vi}:{size:number;category:'SOLO'|'DUEL';refresh:string;vi:boolean}){
  const [data,setData]=useState<{key:string;value:ConquestBoardData|null;failed:boolean}>({key:'',value:null,failed:false});
  const key=`${size}:${category}:${refresh}`;
  useEffect(()=>{
    const controller=new AbortController();
    apiClient.get('/king-of-english/conquest/leaderboard',{params:{size,category},signal:controller.signal})
      .then(response=>{if(!controller.signal.aborted)setData({key,value:response.data,failed:false});})
      .catch(()=>{if(!controller.signal.aborted)setData(previous=>({key,value:previous.value,failed:true}));});
    return ()=>controller.abort();
  },[key,size,category]);
  const value=data.value&&data.value.size===size&&data.value.category===category?data.value:null;
  const loading=!value&&!data.failed;
  const date=(iso:string)=>new Date(iso).toLocaleDateString(vi?'vi-VN':'en-GB',{day:'2-digit',month:'2-digit',year:'numeric'});
  const label=category==='SOLO'?(vi?'Tự luyện':'Solo'):(vi?'Đối kháng':'Duels');
  return <section className={styles.ranks} aria-label={vi?`Bảng xếp hạng ${size} × ${size}`:`Leaderboard ${size} × ${size}`}>
    <div className={styles.ranksHead}>
      <h3 className={styles.subTitle}><Trophy aria-hidden="true"/>{vi?'Bảng xếp hạng':'Leaderboard'} · Top 5</h3>
      <span className={styles.ranksTag}>{size} × {size} · {label}</span>
    </div>
    <div className={styles.best} data-empty={!value?.you}>
      <span className={styles.bestLabel}><Crown aria-hidden="true"/>{vi?'Kỷ lục của bạn':'Your best'}</span>
      {value?.you?<>
        <strong className={styles.bestScore}>{value.you.best}<small> {vi?'điểm':'pts'}</small></strong>
        <span className={styles.bestMeta}>{value.you.rank!=null?`${vi?'Hạng':'Rank'} #${value.you.rank} · `:''}{date(value.you.achievedAt)}</span>
        {value.you.rank==null&&<span className={styles.bestMeta}>{vi?'Tài khoản này không được xếp hạng công khai.':'This account is not ranked publicly.'}</span>}
      </>:<span className={styles.bestMeta}>{loading?'…':data.failed&&!value?(vi?'Chưa tải được bảng xếp hạng.':'Rankings unavailable right now.'):(vi?`Chưa có kỷ lục ${size} × ${size}. Hoàn thành một ván để ghi điểm.`:`No ${size} × ${size} record yet. Finish a round to set one.`)}</span>}
    </div>
    {value&&(value.top.length?<ol className={styles.rankList}>{value.top.map(row=><li key={row.rank} className={styles.rankRow} data-rank={row.rank} data-you={row.you}>
        <span className={styles.rankNo} aria-label={`${vi?'Hạng':'Rank'} ${row.rank}`}>{row.rank<=3?<Medal aria-hidden="true"/>:null}{row.rank}</span>
        <span className={styles.rankName}>{row.name}{row.you&&<em> · {vi?'Bạn':'You'}</em>}</span>
        <strong className={styles.rankScore}>{row.score}</strong>
      </li>)}</ol>
      :<p className={styles.hint}>{value.you?(vi?'Chưa có học viên nào trên bảng xếp hạng của bàn này.':'No ranked learner on this board yet.'):(vi?'Chưa có ai ghi điểm ở bàn này. Hãy là người đầu tiên.':'No scores on this board yet. Be the first.')}</p>)}
  </section>;
}
