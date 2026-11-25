// Created only from the extension page. Never downloads a language pack without an explicit click.
export function deviceTranslator(){
  const pair={sourceLanguage:'en',targetLanguage:'vi'};
  let instance,creating,life=new AbortController();
  async function ready(download=false,notify=()=>{}){
    if(!globalThis.Translator?.availability)return null;
    if(instance)return instance;
    if(creating)return creating;
    const signal=life.signal;
    creating=(async()=>{
      const state=await Translator.availability(pair);
      if(signal.aborted || state==='unavailable' || (!download && state!=='available'))return null;
      const t=await Translator.create({...pair,signal,monitor(m){m.addEventListener('downloadprogress',e=>notify('Gói ngôn ngữ: '+Math.round(e.loaded*100)+'%'));}});
      if(signal.aborted){t.destroy();return null;}
      return instance=t;
    })().catch(()=>null);
    const task=creating;try{return await task;}finally{if(task===creating)creating=null;}
  }
  return {ready,async translate(text){
    const signal=life.signal,t=await ready();if(!t || signal.aborted)return null;
    try{return await t.translate(text,{signal});}catch{return null;}
  },clear(){life.abort();instance?.destroy();instance=null;creating=null;life=new AbortController();}};
}
