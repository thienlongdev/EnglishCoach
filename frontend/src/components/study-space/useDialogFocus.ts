'use client';
import {useEffect,useRef,type RefObject} from 'react';

/** Only the topmost dialog owns Escape/Tab. Nested Flashcard editors keep the research selection alive. */
export function useDialogFocus(ref:RefObject<HTMLElement|null>,close:()=>void,enabled=true){
  const onClose=useRef(close);onClose.current=close;
  useEffect(()=>{
    if(!enabled)return;const root=ref.current;if(!root)return;
    const before=document.activeElement as HTMLElement|null;
    const controls=()=>Array.from(root.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]')).filter(e=>e.getClientRects().length);
    controls()[0]?.focus({preventScroll:true});
    const key=(e:KeyboardEvent)=>{
      const dialogs=Array.from(document.querySelectorAll('[role="dialog"]')).filter(d=>d.getClientRects().length);
      if(dialogs.at(-1)!==root)return;
      if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();onClose.current();}
      if(e.key==='Tab'){
        const list=controls(),first=list[0],last=list.at(-1);if(!first){e.preventDefault();return;}
        if(e.shiftKey&&(document.activeElement===first||!root.contains(document.activeElement))){e.preventDefault();last?.focus();}
        else if(!e.shiftKey&&(document.activeElement===last||!root.contains(document.activeElement))){e.preventDefault();first.focus();}
      }
    };
    window.addEventListener('keydown',key,true);
    return()=>{window.removeEventListener('keydown',key,true);if(before?.isConnected)before.focus({preventScroll:true});};
  },[enabled,ref]);
}
