// Isolated content-script world. Read only user-facing player UI, never player internals.
(() => {
  if (window.__echoAdapters) return;
  const yt = () => /^(www\.|m\.|music\.)?youtube\.com$/.test(location.hostname);
  const identity = () => yt() && (location.pathname === '/watch' ? new URL(location.href).searchParams.get('v') : location.pathname.match(/^\/shorts\/([^/]+)/)?.[1]);
  const visible = n => !!n?.getClientRects().length && getComputedStyle(n).visibility !== 'hidden';
  const tidy = n => (n?.innerText || '').trim().replace(/\s+/g,' ').slice(0,1400);
  const stamp = t => /^\d{1,3}(?::[0-5]\d){1,2}$/.test(t) ? t.split(':').reduce((a,v)=>a*60+Number(v),0) : NaN;
  function choose() {
    const vs = [...document.querySelectorAll('video,audio')];
    const active = identity() && document.querySelector('ytd-reel-video-renderer[is-active] video, ytd-reel-video-renderer[active] video');
    return active || vs.find(v=>!v.paused && !v.ended && visible(v)) || vs.find(visible) || vs[0];
  }
  function chapters(v) {
    const result=[];
    for (const t of Array.from(v.textTracks).filter(t=>t.kind==='chapters'))
      for (const c of Array.from(t.cues||[]).slice(0,100)) result.push({start:c.startTime,title:String(c.text).slice(0,140)});
    if (!result.length && identity()) {
      const watch=v.closest('ytd-watch-flexy');
      if (watch && watch.getAttribute('video-id')===identity())
        for (const a of watch.querySelectorAll('#description-inline-expander a[href*="t="],ytd-macro-markers-list-item-renderer a[href*="t="]')) {
          if (!visible(a)) continue;
          const u=new URL(a.href), start=stamp(a.innerText.trim());
          if(u.searchParams.get('v')!==identity() || !Number.isFinite(start))continue;
          const title=(a.nextSibling?.textContent||'').split('\n').find(s=>s.trim())?.trim().replace(/^[-–:]\s*/,'').slice(0,140);
          if(title && !result.some(x=>x.start===start))result.push({start,title});
          if(result.length>=100)break;
        }
    }
    return result.sort((a,b)=>a.start-b.start);
  }
  function transcript(v) {
    if(!identity())return [];
    const watch=v.closest('ytd-watch-flexy');
    if(!watch || (watch.getAttribute('video-id') && watch.getAttribute('video-id')!==identity()))return [];
    const pane=Array.from(watch.querySelectorAll('ytd-engagement-panel-section-list-renderer[target-id*="transcript"],ytd-engagement-panel-section-list-renderer:has(transcript-segment-view-model),[role="tabpanel"]:has(transcript-segment-view-model)')).find(n=>visible(n)&&n.querySelector('transcript-segment-view-model,ytd-transcript-segment-renderer')) || (Array.from(document.querySelectorAll('button[role="tab"][aria-selected="true"]')).some(n=>visible(n)&&/^(transcript|bản chép lời)$/i.test(n.innerText.trim())) ? document.querySelector('ytd-app'):null);
    if(!visible(pane))return [];
    const lines=[];
    for(const row of pane.querySelectorAll('ytd-transcript-segment-renderer, transcript-segment-view-model')) {
      if(!visible(row))continue;
      const raw=tidy(row), parts=raw.match(/^(\d{1,3}(?::[0-5]\d){1,2})\s+(.+)$/);
      const start=stamp(tidy(row.querySelector('.segment-timestamp,.ytwTranscriptSegmentViewModelTimestamp'))||parts?.[1]||''),text=tidy(row.querySelector('.segment-text,.ytwTranscriptSegmentViewModelText,.ytAttributedStringHost:not(.ytwTranscriptSegmentViewModelTimestampA11yLabel)'))||parts?.[2];
      if(!text || !Number.isFinite(start) || start<0 || (lines.length && start<=lines.at(-1).start))continue;
      if(lines.length)lines.at(-1).end=start;
      lines.push({start,end:Math.min(start+5,v.duration||Infinity),text});
      if(lines.length>=500)break;
    }
    return lines;
  }
  function displayed(v,onLine) {
    const player=v.closest('.html5-video-player');
    if(!identity() || !player)return ()=>{};
    // A rolling window of what was actually displayed. Starts/ends are observations,
    // never claimed to be the publisher's authored cue boundaries.
    let previous='', start=0, last=0, language='', pane=null;
    function sample() {
      if(document.hidden || v.seeking || !v.isConnected)return;
      if(!pane?.isConnected)pane=player.querySelector('.ytp-caption-window-container');
      const nodes=pane && !player.classList.contains('ad-showing') ? Array.from(pane.querySelectorAll('.ytp-caption-segment')).filter(visible) : [];
      const text=nodes.map(n=>n.textContent).join(' ').replace(/\s+/g,' ').trim().slice(0,1000);
      const owner=nodes[0]?.closest('[lang]'), lang=owner && pane.contains(owner)?owner.lang:'';
      const now=v.currentTime;
      if(text!==previous || lang!==language || now<last-.1 || now-last>2.5) {
        if(previous)onLine({text:previous,start,end:Math.max(start+.04,Math.abs(now-last)>2.5?last:now),lang:language,closed:true});
        previous=text;start=now;language=lang;
      }
      if(text)onLine({text,start,end:Math.max(start+.25,now+.45),lang:language});
      last=now;
    }
    function reset(){if(previous)onLine({text:previous,start,end:Math.max(start+.04,last),lang:language,closed:true});previous='';}
    const events=['timeupdate','pause','playing','seeked'];
    events.forEach(e=>v.addEventListener(e,sample));v.addEventListener('seeking',reset);
    document.addEventListener('visibilitychange',reset);
    sample();
    return ()=>{events.forEach(e=>v.removeEventListener(e,sample));v.removeEventListener('seeking',reset);document.removeEventListener('visibilitychange',reset);};
  }
  window.__echoAdapters={identity,choose,chapters,transcript,displayed};
})();
