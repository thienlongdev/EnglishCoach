// Player overlay is opt-in. It never replaces native controls or captions.
(() => {
  window.__echoOverlay=(v,pick)=>{
    const host=document.createElement('div'),root=host.attachShadow({mode:'closed'}),box=document.createElement('div'),en=document.createElement('div'),vi=document.createElement('div');
    const css=document.createElement('style');
    css.textContent=':host{all:initial;position:fixed!important;display:block;z-index:2147483646;pointer-events:none;text-align:center}.box{display:inline-block;max-width:96%;box-sizing:border-box;padding:.25em .55em;border-radius:.5em;color:white;background:#071b2bf2;font:600 var(--size,20px)/1.35 system-ui}.box button{border:0;background:none;color:inherit;cursor:pointer;font:inherit;padding:0;pointer-events:auto}.box button:is(:hover,:focus-visible){color:#9eeedd;text-decoration:underline}.vi{color:#a8f0e6;font-size:.84em}';
    box.className='box';vi.className='vi';box.append(en,vi);root.append(css,box);
    let value='',frame=0;
    function place(){
      frame=0;if(!value)return;
      const fs=document.fullscreenElement,target=fs && fs.contains(v) && fs!==v ? fs : document.documentElement;
      if(host.parentNode!==target)target.append(host);
      const r=v.getBoundingClientRect();host.style.left=r.left+'px';host.style.width=r.width+'px';
      host.style.top=Math.max(r.top,r.bottom-host.offsetHeight-Math.max(35,r.height*.18))+'px';
      host.style.visibility=(r.width<60 || r.bottom<0 || r.top>innerHeight || (fs && !fs.contains(v)))?'hidden':'visible';
    }
    const schedule=()=>{if(value && !frame)frame=requestAnimationFrame(place);};
    const ro=new ResizeObserver(schedule),life=new AbortController(),signal=life.signal;
    ro.observe(v);window.addEventListener('scroll',schedule,{passive:true,capture:true,signal});window.addEventListener('resize',schedule,{signal});document.addEventListener('fullscreenchange',schedule,{signal});
    return {show(m){
      const t=String(m.text||'').slice(0,1400);
      if(!t){value='';host.remove();en.replaceChildren();vi.textContent='';return;}
      if(value!==t){value=t;en.replaceChildren();for(const w of t.split(/([\p{L}]+(?:['’-][\p{L}]+)*)/u)){if(!w)continue;if(!/^\p{L}/u.test(w)){en.append(w);continue;}const b=document.createElement('button');b.type='button';b.textContent=w;b.onclick=e=>{e.preventDefault();e.stopPropagation();pick(w,t);};en.append(b);}}
      vi.textContent=String(m.vi||'').slice(0,1400);host.style.setProperty('--size',Math.min(32,Math.max(16,Number(m.size)||22))+'px');schedule();
    },close(){life.abort();ro.disconnect();cancelAnimationFrame(frame);host.remove();value='';}};
  };
})();
