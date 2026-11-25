// Echo Anywhere — page companion. Injected only where the learner allowed it (a click on Echo, the context menu, the
// keyboard shortcut, or a site they granted for the automatic bubble). Everything it draws lives in ONE closed shadow
// root; page text is only ever written with textContent; nothing is sent anywhere until the learner presses a button.
(() => {
  if ([...location.ancestorOrigins].some(origin => origin !== location.origin)) return;
  if (window.__echoAnywhere) return;
  window.__echoAnywhere = true;

  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => ({ error: { code: 'EXTENSION', message: 'Echo vừa được cập nhật. Hãy tải lại trang.' } }));
  const SHADOW_MODE = 'closed'; // test builds (build.mjs --test) open it so automated journeys can read the UI
  const FONT = (f) => chrome.runtime.getURL(`fonts/${f}`);
  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ------------------------------------------------------------------ tiny DOM helper (no HTML parsing, ever)
  const SVGNS = 'http://www.w3.org/2000/svg';
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
    return el;
  }
  const ICONS = {
    book: 'M4 5a2 2 0 0 1 2-2h12v16H6a2 2 0 0 0-2 2V5Zm2 14h12',
    globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm-9 9h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18',
    sound: 'M4 10v4h4l5 4V6L8 10H4Zm12-1a4 4 0 0 1 0 6m2-9a8 8 0 0 1 0 12',
    bulb: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.6.5 1.1 1.3 1.1 2.2h5c0-.9.5-1.7 1.1-2.2A6 6 0 0 0 12 3Z',
    tree: 'M12 3v18M12 8l-5 4M12 12l5 4M12 15l-4 3',
    save: 'M6 3h12v18l-6-4-6 4V3Z',
    target: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 5a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0 3a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z',
    stars: 'M5 18a2 2 0 1 0 0-.1M18 6a2 2 0 1 0 0-.1M14 17a1.5 1.5 0 1 0 0-.1M7 18l7-1M14 17l4-11',
    chat: 'M4 5h16v11H9l-5 4V5Z',
    more: 'M6 12h.01M12 12h.01M18 12h.01',
    close: 'M6 6l12 12M18 6 6 18',
    panel: 'M4 4h16v16H4zM15 4v16',
    lock: 'M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z',
    read: 'M3 6c3-1.5 6-1.5 9 0v13c-3-1.5-6-1.5-9 0V6Zm9 0c3-1.5 6-1.5 9 0v13c-3-1.5-6-1.5-9 0',
  };
  function icon(name) {
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(SVGNS, 'path');
    p.setAttribute('d', ICONS[name] || ICONS.more);
    svg.append(p);
    return svg;
  }

  // ------------------------------------------------------------------ shadow root + styles
  const host = document.createElement('echo-anywhere-root');
  host.style.cssText = 'all: initial; position: fixed; inset: 0 auto auto 0; width: 0; height: 0; z-index: 2147483646;';
  const root = host.attachShadow({ mode: SHADOW_MODE });
  const style = document.createElement('style');
  style.textContent = `
    @font-face { font-family: EchoQuicksand; src: url(${FONT('quicksand-vietnamese.woff2')}) format('woff2'); font-weight: 400 700;
      unicode-range: U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+1EA0-1EF9, U+20AB; }
    @font-face { font-family: EchoQuicksand; src: url(${FONT('quicksand-latin.woff2')}) format('woff2'); font-weight: 400 700; }
    :host { all: initial; }
    * { box-sizing: border-box; }
    /* Liquid Glass, CSS only (no canvas, no loop): Echo Morph curves current .22,1,.36,1 / exit .4,0,.8,.4 */
    .ea { --ease: cubic-bezier(.22,1,.36,1); --exit: cubic-bezier(.4,0,.8,.4); --spring: cubic-bezier(.34,1.32,.5,1);
      --ink:#0b1b3a; --muted:#4b5c7f; --line:rgba(22,86,184,.14); --sea:#1656b8; --sky:#38bdf8; --gold:#9a6516;
      --glass: rgba(255,255,255,.86); --glass-top: rgba(255,255,255,.97); --edge: rgba(255,255,255,.95); --spec: rgba(255,255,255,.9);
      --chip: rgba(22,86,184,.08); --pearl: rgba(240,246,255,.85); --shade: rgba(7,25,61,.22);
      font: 500 14px/1.5 EchoQuicksand, "Segoe UI", system-ui, sans-serif; color: var(--ink); -webkit-font-smoothing: antialiased; }
    @media (prefers-color-scheme: dark) { .ea { --ink:#e8f0ff; --muted:#a2b6d9; --line:rgba(140,188,255,.18); --sea:#8cbcff; --gold:#fcd38a;
      --glass: rgba(12,26,54,.84); --glass-top: rgba(20,38,76,.95); --edge: rgba(160,200,255,.28); --spec: rgba(150,200,255,.22);
      --chip: rgba(140,188,255,.12); --pearl: rgba(10,22,46,.8); --shade: rgba(0,0,0,.5); } }
    button { font: inherit; color: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent; }
    button:focus-visible, a:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid var(--sky); outline-offset: 2px; }
    svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.9; stroke-linecap: round; stroke-linejoin: round; }

    /* the selection bubble: deep-ocean glass (strong contrast on light and dark pages alike) */
    .bubble { position: fixed; display: flex; flex-wrap: wrap; max-width: calc(100vw - 16px); align-items: center; gap: 1px; padding: 4px; border-radius: 999px; color: #fff; isolation: isolate;
      background: linear-gradient(180deg, rgba(36,96,196,.92), rgba(11,34,82,.94)); backdrop-filter: blur(14px) saturate(1.5); -webkit-backdrop-filter: blur(14px) saturate(1.5);
      box-shadow: inset 0 1px 0 rgba(255,255,255,.38), inset 0 -1px 0 rgba(0,10,40,.35), 0 0 0 1px rgba(10,30,80,.35), 0 12px 30px -6px rgba(7,25,61,.5), 0 2px 6px rgba(7,25,61,.25);
      transform-origin: var(--ox, 50%) 100%; animation: grow .32s var(--spring) both; }
    .bubble::before { content: ''; position: absolute; inset: 1px 10% auto; height: 45%; border-radius: 999px 999px 40% 40%; z-index: -1; pointer-events: none;
      background: linear-gradient(180deg, rgba(255,255,255,.28), transparent); }
    .bubble.leaving, .card.leaving { animation: leave .16s var(--exit) forwards; pointer-events: none; }
    .bubble button { position: relative; display: grid; place-items: center; width: 32px; height: 32px; border: 0; border-radius: 999px; background: transparent; color: #fff;
      transition: background .2s var(--ease), translate .25s var(--ease), scale .2s var(--ease); translate: var(--mx, 0) var(--my, 0); }
    .bubble button:hover { background: radial-gradient(circle at 50% 30%, rgba(255,255,255,.32), rgba(255,255,255,.08)); }
    .bubble button:active { scale: .9; }
    .bubble .whale { width: 34px; height: 32px; padding: 3px; }
    .bubble .whale img { width: 26px; height: 26px; display: block; filter: drop-shadow(0 2px 4px rgba(0,10,40,.45)); transition: rotate .4s var(--spring); }
    .bubble .whale:hover img { rotate: -8deg; }
    .bubble .sep { width: 1px; height: 18px; background: linear-gradient(180deg, transparent, rgba(255,255,255,.4), transparent); margin: 0 3px; }
    .bubble .pro::after { content: ''; position: absolute; top: 5px; right: 5px; width: 6px; height: 6px; border-radius: 50%;
      background: radial-gradient(circle at 35% 30%, #fff6d6, #fbbf24); box-shadow: 0 0 6px rgba(251,191,36,.9); }
    .bubble > button { animation: rise .34s var(--ease) both; animation-delay: calc(var(--i, 0) * 18ms); }
    .tip { position: fixed; z-index: 2; padding: 5px 9px; border-radius: 9px; font-size: 12px; font-weight: 700; white-space: nowrap; pointer-events: none; color: #fff;
      background: rgba(8,22,52,.94); box-shadow: inset 0 1px 0 rgba(255,255,255,.2), 0 8px 18px -6px rgba(0,0,0,.45); animation: fade .16s var(--ease) both; }
    .tip b { color: #fcd38a; font-weight: 700; margin-left: 4px; }

    /* the card: pearl / abyss glass with a specular rim and a pointer sheen */
    .card { position: fixed; width: min(384px, calc(100vw - 24px)); max-height: min(540px, calc(100vh - 24px)); display: flex; flex-direction: column; isolation: isolate;
      background: linear-gradient(180deg, var(--glass-top), var(--glass)); backdrop-filter: blur(22px) saturate(1.45); -webkit-backdrop-filter: blur(22px) saturate(1.45);
      border: 1px solid var(--line); border-radius: 20px; overflow: hidden;
      box-shadow: inset 0 1px 0 var(--edge), 0 0 0 .5px rgba(7,25,61,.08), 0 28px 60px -18px var(--shade), 0 4px 12px -4px var(--shade);
      transform-origin: var(--ox, 50%) var(--oy, 0%); animation: grow .38s var(--spring) both; }
    .card::before { content: ''; position: absolute; inset: 0; z-index: -1; pointer-events: none; border-radius: inherit;
      background: radial-gradient(260px 160px at var(--px, 20%) var(--py, 0%), var(--spec), transparent 70%); opacity: .55; transition: opacity .3s var(--ease); }
    .card:hover::before { opacity: .85; }
    .head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--line);
      background: linear-gradient(180deg, rgba(56,189,248,.14), transparent); }
    .head img { width: 26px; height: 26px; filter: drop-shadow(0 2px 4px rgba(7,25,61,.25)); }
    .head .title { flex: 1; font-weight: 700; font-size: 13px; letter-spacing: .01em; color: var(--sea); }
    .icon-btn { display: grid; place-items: center; width: 30px; height: 30px; border: 0; border-radius: 10px; background: transparent; color: var(--muted); transition: background .2s var(--ease), color .2s; }
    .icon-btn:hover { background: var(--chip); color: var(--ink); }
    .body { padding: 12px 14px 14px; overflow: auto; overscroll-behavior: contain; }
    .body > * { animation: rise .34s var(--ease) both; }
    .body > *:nth-child(2) { animation-delay: 30ms; } .body > *:nth-child(3) { animation-delay: 60ms; } .body > *:nth-child(n+4) { animation-delay: 90ms; }
    .word { font-size: 24px; font-weight: 700; line-height: 1.15; margin: 0 0 4px; word-break: break-word;
      background: linear-gradient(100deg, var(--ink) 45%, var(--sea)); -webkit-background-clip: text; background-clip: text; color: transparent; }
    .row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 6px 0; }
    .chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 9px; border-radius: 999px; background: var(--chip); font-size: 12px; font-weight: 700; color: var(--sea); box-shadow: inset 0 0 0 1px var(--line); }
    .ipa { font-family: "Segoe UI", "Noto Sans", "Lucida Sans Unicode", sans-serif; color: var(--muted); }
    .say { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--line); background: var(--pearl); border-radius: 999px; padding: 3px 10px; font-size: 12.5px;
      box-shadow: inset 0 1px 0 var(--edge); transition: border-color .2s, translate .2s var(--ease); }
    .say:hover { border-color: rgba(56,189,248,.6); translate: 0 -1px; }
    .say svg { width: 14px; height: 14px; }
    .general { font-size: 16.5px; font-weight: 700; margin: 8px 0 2px; }
    h4 { margin: 12px 0 4px; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); font-weight: 700; }
    ol, ul { margin: 0; padding-left: 18px; }
    li { margin: 3px 0; }
    .ex { color: var(--muted); font-style: italic; }
    .ctx { margin-top: 10px; padding: 9px 11px; border-left: 3px solid var(--sky); background: linear-gradient(90deg, rgba(56,189,248,.14), transparent); border-radius: 0 12px 12px 0; font-size: 13px; }
    .muted { color: var(--muted); font-size: 12.5px; }
    .actions { display: flex; flex-wrap: wrap; gap: 6px; padding: 10px 12px; border-top: 1px solid var(--line); background: var(--pearl); }
    .btn { position: relative; display: inline-flex; align-items: center; gap: 6px; padding: 7px 11px; border-radius: 12px; border: 1px solid var(--line); overflow: hidden;
      background: linear-gradient(180deg, var(--glass-top), var(--glass)); font-size: 12.5px; font-weight: 700; box-shadow: inset 0 1px 0 var(--edge), 0 1px 2px rgba(7,25,61,.08);
      transition: translate .18s var(--ease), border-color .25s, box-shadow .25s; }
    .btn:hover { border-color: rgba(56,189,248,.5); box-shadow: inset 0 1px 0 var(--edge), 0 6px 14px -6px rgba(22,86,184,.4); }
    .btn:active { translate: 0 1px; }
    .btn svg { width: 15px; height: 15px; }
    .btn.primary { background: linear-gradient(135deg,#2a8bf2,#1656b8 55%,#0d2a5e); color: #fff; border-color: transparent; box-shadow: inset 0 1px 0 rgba(255,255,255,.35), 0 8px 18px -8px rgba(22,86,184,.75); }
    .btn.pro { border-color: rgba(214,158,46,.45); }
    .btn.pro::after { content: 'AI'; margin-left: 2px; padding: 0 5px; border-radius: 6px; font-size: 10px; color: var(--gold); background: rgba(251,191,36,.18); }
    .btn[disabled] { opacity: .55; cursor: default; }
    .note { margin-top: 10px; padding: 9px 11px; border-radius: 12px; background: var(--chip); font-size: 12.5px; box-shadow: inset 0 0 0 1px var(--line); }
    .note.saved { display: flex; gap: 8px; align-items: center; }
    .note.saved::before { content: ''; flex: none; width: 18px; height: 18px; border-radius: 50%; background: radial-gradient(circle at 35% 30%, #fff, #bfe6ff 45%, #5aa7f2);
      box-shadow: 0 0 12px rgba(56,189,248,.8); animation: pearl .7s var(--spring) both; }
    .error { color: #b42318; }
    @media (prefers-color-scheme: dark) { .error { color: #fda29b; } }
    .skeleton { height: 12px; border-radius: 7px; background: linear-gradient(90deg, var(--chip), rgba(56,189,248,.2), var(--chip)); background-size: 200% 100%; animation: shimmer 1.2s linear infinite; margin: 9px 0; }
    textarea { width: 100%; min-height: 64px; resize: vertical; border: 1px solid var(--line); border-radius: 12px; padding: 8px 10px; font: inherit; background: var(--pearl); color: inherit; }
    .reader { position: fixed; inset: 0; display: flex; justify-content: center; overflow: auto; background: #f4f1ea; color: #1d2433; animation: fade .24s var(--ease) both; }
    .reader[data-theme=dark] { background: #0f1626; color: #dbe4f5; }
    .reader[data-theme=sepia] { background: #f3e7cf; color: #3b2f1e; }
    .reader .bar { position: fixed; top: 12px; right: 16px; display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; z-index: 2; padding: 6px; border-radius: 16px;
      background: rgba(255,255,255,.72); backdrop-filter: blur(16px) saturate(1.4); -webkit-backdrop-filter: blur(16px) saturate(1.4); box-shadow: inset 0 1px 0 #fff, 0 12px 28px -12px rgba(7,25,61,.35); }
    .reader .bar .btn { background: rgba(255,255,255,.92); color: #0b1b3a; }
    .reader .progress { position: fixed; top: 0; left: 0; height: 3px; background: linear-gradient(90deg,#38bdf8,#1656b8); width: 0; z-index: 3; box-shadow: 0 0 10px rgba(56,189,248,.8); }
    .reader article { width: min(720px, 92vw); padding: 80px 0 120px; font-size: calc(19px * var(--scale, 1)); line-height: var(--lh, 1.75); }
    .reader article h1 { font-size: 1.6em; line-height: 1.25; margin: 0 0 .4em; }
    .reader article .meta { font-size: 14px; opacity: .72; margin-bottom: 1.6em; }
    .reader article p, .reader article li, .reader article h2, .reader article h3 { margin: 0 0 1em; border-radius: 8px; transition: opacity .25s var(--ease); }
    .reader[data-spot=on] article .blk { opacity: .36; }
    .reader[data-spot=on] article .blk.on { opacity: 1; }
    .reader .ruler { position: fixed; left: 0; right: 0; height: calc(2.1em * var(--scale, 1)); pointer-events: none; background: linear-gradient(180deg, rgba(56,189,248,.08), rgba(56,189,248,.16), rgba(56,189,248,.08));
      border-top: 1px solid rgba(56,189,248,.35); border-bottom: 1px solid rgba(56,189,248,.35); display: none; transition: top .08s linear; }
    .reader[data-ruler=on] .ruler { display: block; }
    @keyframes grow { from { opacity: 0; scale: .9; translate: 0 6px; } to { opacity: 1; scale: 1; translate: 0 0; } }
    @keyframes leave { to { opacity: 0; scale: .96; translate: 0 4px; } }
    @keyframes rise { from { opacity: 0; translate: 0 8px; } to { opacity: 1; translate: 0 0; } }
    @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
    @keyframes pearl { 0% { scale: .2; opacity: 0; } 60% { scale: 1.2; opacity: 1; } 100% { scale: 1; } }
    @keyframes shimmer { to { background-position: -200% 0; } }
    @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) { .card { background: var(--glass-top); } }
    @media (prefers-reduced-motion: reduce) { .ea *, .ea *::before, .ea *::after { animation: none !important; transition: none !important; } }
  `;
  const shell = h('div', { class: 'ea', lang: 'vi' });
  root.append(style, shell);
  document.documentElement.append(host);
  const echoImg = () => h('img', { src: chrome.runtime.getURL('icons/echo-128.webp'), alt: '' });

  // ------------------------------------------------------------------ settings + selection
  let settings = { autoBubble: false, siteDisabled: true, private: true, connected: false };
  const ready = send({ t: 'settings:get' }).then((r) => { if (r?.data) settings = r.data; });
  const communicationPage = () => settings.private || !!document.querySelector('[role="log"], [aria-roledescription="chat" i], [role="feed"], [contenteditable="true"][role="textbox"], [contenteditable="plaintext-only"][role="textbox"]');
  function scopeKind(node) {
    const domain = location.hostname;
    const path = location.pathname;
    const chat = node?.closest?.('[role="log"], [aria-roledescription="chat" i], [role="dialog"], [aria-modal="true"], [data-pagelet*="chat" i]');
    if (chat || /\/(?:messages?|chats?|inbox|direct|messenger)(?:\/|$)/i.test(path)) return 'private';
    if (/(^|\.)(facebook\.com|instagram\.com|x\.com|twitter\.com|threads\.(net|com)|tiktok\.com)$/.test(domain)) {
      const feed=node?.closest?.('article,[role="article"],[role="feed"]');
      const homeFeed=/(^|\.)facebook\.com$/.test(domain) && node?.closest?.('[data-pagelet^="FeedUnit"],[data-ad-preview="message"],[data-ad-comet-preview="message"]');
      return feed || homeFeed ? 'mixed' : 'private';
    }
    if (/(^|\.)reddit\.com$/.test(domain) && /^\/r\//.test(path) && !chat) return 'public';
    if (settings.private) return 'private';
    if (node?.closest?.('article,[role="article"],[itemprop="articleBody"]')) return 'public';
    if (node?.closest?.('[role="feed"]')) return 'mixed';
    if (communicationPage()) return 'private';
    return 'public';
  }
  const privateSurface = () => (current?.kind ?? scopeKind(null)) !== 'public';
  async function scopeFor(node, kind = scopeKind(node)) {
    if (kind === 'public') return null;
    const remember = kind === 'mixed' || (!node?.closest?.('[role="dialog"]') && /\/(?:t|channels|messages|chats?|im)\/[^/]+|^#.+/.test(location.pathname + location.hash));
    const r = await send({t:'consent:scope',kind,remember});
    return r?.data || {kind,remember:false};
  }
  window.__echoMediaScope = async node => {await ready;return scopeFor(node);};
  let dismissMedia = () => {};
  window.__echoMediaDock = media => {
    dismissMedia();
    const player=media.closest('.html5-video-player');
    if(!player || !/^(?:www\.|m\.|music\.)?youtube\.com$/.test(location.hostname))return;
    // Participate in the player toolbar's flow and visibility. Never float over page content.
    const life=new AbortController(),signal=life.signal;
    const dock=h('button',{type:'button',class:'ytp-button',title:'Mở Echo Video Companion','aria-label':'Mở Echo Video Companion'});
    const picture=echoImg();picture.width=20;picture.height=20;
    picture.style.cssText='width:20px!important;height:20px!important;max-width:100%!important;object-fit:contain;pointer-events:none';
    dock.style.cssText='width:32px!important;min-width:32px!important;max-width:32px!important;flex:0 0 32px!important;padding:0!important;overflow:hidden;vertical-align:middle;align-items:center;justify-content:center';
    dock.append(picture);dock.addEventListener('click',e=>{e.stopPropagation();send({t:'panel:open',payload:{tab:'media'}});},{signal});
    let frame=0;
    function place(){
      frame=0;const controls=player.querySelector('.ytp-chrome-controls'),right=controls?.querySelector('.ytp-right-controls');
      const anchor=right?.querySelector('button.ytp-settings-button,button.ytp-fullscreen-button');
      if(!anchor || !media.isConnected || player.clientWidth<480){dock.remove();return;}
      const group=anchor.parentElement;
      if(dock.parentNode!==group)group.insertBefore(dock,anchor);
      dock.style.display='inline-flex';
      const b=dock.getBoundingClientRect(),l=controls.querySelector('.ytp-left-controls')?.getBoundingClientRect();
      if(l && b.left<l.right-.5 || b.right>controls.getBoundingClientRect().right+1)dock.style.display='none';
    }
    const schedule=()=>{if(!frame)frame=requestAnimationFrame(place);};
    const ro=new ResizeObserver(schedule);ro.observe(player);
    const mo=new MutationObserver(records=>{if(records.some(r=>r.target!==dock && [...r.addedNodes,...r.removedNodes].some(n=>n!==dock && n.nodeType===1 && (n.matches('button,.ytp-chrome-controls,.ytp-right-controls')||n.querySelector('.ytp-chrome-controls')))))schedule();});
    mo.observe(player,{childList:true,subtree:true});document.addEventListener('fullscreenchange',schedule,{signal});place();
    dismissMedia=()=>{life.abort();ro.disconnect();mo.disconnect();cancelAnimationFrame(frame);dock.remove();dismissMedia=()=>{};};
    return dismissMedia;
  };

  const ignoreTargets = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [type=password], [autocomplete^="cc-"]';
  function protectedNode(node) {
    while (node) {
      if (node.closest?.(ignoreTargets) || node === host) return true;
      node = node.getRootNode().host;
    }
    return false;
  }
  let selectionRoot = document;
  function currentSelection(geometryOnly = false) {
    const sel = selectionRoot.getSelection?.() || window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const node = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
    if (!node || protectedNode(node) || document.activeElement?.matches(ignoreTargets)) return null;
    if (range.startContainer !== range.endContainer) {
      // Traverse only intersecting branches. Never read text/values from excluded fields.
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT, {
        acceptNode: el => !range.intersectsNode(el) ? NodeFilter.FILTER_REJECT : el.matches(ignoreTargets) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
      });
      if (walker.nextNode()) return null;
    }
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) return null;
    if (geometryOnly) return { rect };
    const text = sel.toString().replace(/\s+/g, ' ').trim();
    if (!text) return null;
    const kind = scopeKind(node);
    const selectionOnly = kind !== 'public' || !node.closest('article, [role="article"], [itemprop="articleBody"]');
    return { text, rect, range: range.cloneRange(), kind, node, context: selectionOnly ? '' : sentenceAround(range, text) };
  }

  function sentenceAround(range, text) {
    if (range.startContainer !== range.endContainer || range.startContainer.nodeType !== Node.TEXT_NODE) return text;
    const whole = range.startContainer.data.slice(Math.max(0, range.startOffset - 350), range.endOffset + 350).replace(/\s+/g, ' ').trim();
    if (!whole) return text;
    const i = whole.toLowerCase().indexOf(text.toLowerCase().slice(0, 60));
    if (i < 0) return whole.slice(0, 400);
    const starts = [...whole.slice(0, i).matchAll(/[.!?]["')\]]?\s+/g)];
    const from = starts.length ? starts[starts.length - 1].index + starts[starts.length - 1][0].length : 0;
    const endM = /[.!?]["')\]]?(\s|$)/.exec(whole.slice(i + text.length));
    const to = endM ? i + text.length + endM.index + 1 : whole.length;
    return whole.slice(from, Math.min(to, from + 600)).trim();
  }

  const isWordish = (t) => t.split(/\s+/).length <= 4 && t.length <= 60;
  let current = null; // the selection the toolbar / card is about
  let keyboardOpen = false; // the card was asked for from the keyboard: show the focus ring there
  let bubble = null;
  let card = null;

  function leave(el) {
    if (!el) return;
    if (reduced()) { el.remove(); return; }
    el.inert = true;
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 170);
  }
  function clearUi() {
    hideTip();
    leave(bubble); bubble = null;
    leave(card); card = null;
    speechSynthesis?.cancel?.();
  }

  // glass tooltips (title attributes would be the page's grey OS tooltip) and a pointer-following sheen
  let tip = null;
  function showTip(el) {
    hideTip();
    const label = el.getAttribute('aria-label');
    if (!label) return;
    const pro = el.classList.contains('pro');
    tip = h('div', { class: 'tip', role: 'presentation' }, label.replace(/ \((Premium|Premium AI)\)$/, ''), pro ? h('b', { text: 'Premium' }) : null);
    shell.append(tip);
    const r = el.getBoundingClientRect(), t = tip.getBoundingClientRect();
    let top = r.top - t.height - 8;
    if (top < 6) top = r.bottom + 8;
    tip.style.top = `${Math.round(top)}px`;
    tip.style.left = `${Math.round(Math.max(6, Math.min(innerWidth - t.width - 6, r.left + r.width / 2 - t.width / 2)))}px`;
  }
  function hideTip() { tip?.remove(); tip = null; }
  shell.addEventListener('pointerover', (e) => { const b = e.target.closest?.('.bubble button'); if (b) showTip(b); });
  shell.addEventListener('pointerout', (e) => { if (e.target.closest?.('.bubble button')) hideTip(); });
  shell.addEventListener('focusin', (e) => { const b = e.target.closest?.('.bubble button'); if (b) showTip(b); });
  shell.addEventListener('focusout', hideTip);
  let sheenFrame = 0;
  shell.addEventListener('pointermove', (e) => {
    if (sheenFrame || reduced()) return;
    sheenFrame = requestAnimationFrame(() => {
      sheenFrame = 0;
      const c = e.target.closest?.('.card');
      if (c) { const r = c.getBoundingClientRect(); c.style.setProperty('--px', `${e.clientX - r.left}px`); c.style.setProperty('--py', `${e.clientY - r.top}px`); }
      const b = e.target.closest?.('.bubble button');
      if (b && matchMedia('(pointer: fine)').matches) {
        const r = b.getBoundingClientRect();
        b.style.setProperty('--mx', `${((e.clientX - r.left) / r.width - 0.5) * 3}px`);
        b.style.setProperty('--my', `${((e.clientY - r.top) / r.height - 0.5) * 3}px`);
      }
    });
  }, { passive: true });
  shell.addEventListener('pointerleave', () => { shell.querySelectorAll('.bubble button').forEach((b) => { b.style.removeProperty('--mx'); b.style.removeProperty('--my'); }); }, true);

  function place(el, rect, prefer = 'above') {
    const vp = window.visualViewport;
    const x = vp?.offsetLeft || 0, y = vp?.offsetTop || 0;
    const width = vp?.width || innerWidth, height = vp?.height || innerHeight;
    el.style.maxWidth = `${Math.max(1, width - 16)}px`;
    const w = el.offsetWidth, h = el.offsetHeight;
    const left = Math.max(x+8, Math.min(rect.left + (rect.width-w)/2, x+width-w-8));
    const above = rect.top-h-10, below = rect.bottom+10;
    const candidates = prefer === 'above' ? [above, below] : [below, above];
    const fits = candidates.filter(t => t >= y+8 && t+h <= y+height-8);
    const clear = fits.find(t => [0.1,0.5,0.9].every(part =>
      !document.elementFromPoint(left+w*part, t+h/2)?.closest('input,textarea,select,button,[contenteditable="true"]')));
    const top = clear ?? fits[0] ?? Math.max(y+8, Math.min(candidates[0],y+height-h-8));
    el.style.top = `${Math.round(top)}px`;
    el.style.left = `${Math.round(left)}px`;
  }

  const keepSelection = (e) => e.preventDefault(); // pressing our buttons never moves the page's selection or focus

  function showBubble(sel, expanded) {
    clearUi();
    current = sel;
    const tools = [
      ['book', 'Tra nghĩa', () => runAction('lookup')],
      ['globe', 'Dịch', () => runAction('translate')],
      ['sound', 'Phát âm', () => runAction('speak')],
      ['bulb', 'Giải thích (Premium AI)', () => runAction('explain'), true],
      ['tree', 'Ngữ pháp (Premium AI)', () => runAction('grammar'), true],
      ['save', 'Lưu Flashcard', () => runAction('save')],
      ['target', 'Luyện tập', () => runAction('practice')],
      ['stars', 'Mở trong Vũ trụ tri thức', () => runAction('cosmos')],
      ['chat', 'Hỏi Echo AI (Premium)', () => runAction('ask'), true],
    ];
    bubble = h('div', { class: 'bubble', role: 'toolbar', 'aria-label': 'Echo Anywhere' });
    if (!expanded) {
      bubble.append(h('button', { class: 'whale', 'aria-label': 'Echo Anywhere — học với đoạn đã chọn',
        onmousedown: keepSelection, onclick: () => { const selected = currentSelection(); if (selected) showBubble(selected, true); else clearUi(); } }, echoImg()));
    } else {
      bubble.append(h('span', { class: 'whale', 'aria-hidden': 'true' }, echoImg()), h('span', { class: 'sep' }));
      for (const [ic, label, fn, pro] of tools) {
        bubble.append(h('button', { class: pro ? 'pro' : '', 'aria-label': label, style: `--i:${bubble.childElementCount}`, onmousedown: keepSelection, onclick: fn }, icon(ic)));
      }
      bubble.append(h('span', { class: 'sep' }), h('button', { 'aria-label': 'Đóng (Esc)', onmousedown: keepSelection, onclick: clearUi }, icon('close')));
    }
    shell.append(bubble);
    place(bubble, sel.rect, 'above');
    const br = bubble.getBoundingClientRect();
    bubble.style.setProperty('--ox', `${Math.round(sel.rect.left + sel.rect.width / 2 - br.left)}px`);
    if (expanded) bubble.querySelector('button')?.focus({ preventScroll: true });
  }

  // automatic bubble only on granted sites, only after a real mouse / keyboard selection, never in fields
  let pendingTimer = 0;
  function resetPageUi() {
    dismissMedia();
    clearTimeout(pendingTimer);
    cancelAnimationFrame(layoutFrame);
    layoutFrame = 0;
    current = null;
    selectionRoot = document;
    clearUi();
    if (reader) closeReader();
  }
  function onSelectionGesture(e) {
    const path = e.composedPath();
    if (path.includes(host)) return;
    selectionRoot = path[0]?.getRootNode?.() || document;
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      if (!settings.autoBubble || settings.siteDisabled) return;
      if (card) return;
      const sel = currentSelection(true);
      if (sel) showBubble(sel, false);
      else if (bubble) clearUi();
    }, 180);
  }
  document.addEventListener('mouseup', onSelectionGesture, { passive: true, capture: true });
  document.addEventListener('pointerup', e => { if (e.pointerType !== 'mouse') onSelectionGesture(e); }, { passive: true, capture: true });
  document.addEventListener('contextmenu', (e) => { if (!e.composedPath().includes(host)) selectionRoot = e.composedPath()[0]?.getRootNode?.() || document; }, { capture: true, passive: true });
  document.addEventListener('keyup', (e) => { if (e.shiftKey || e.key === 'Shift' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a')) onSelectionGesture(e); }, { passive: true });
  document.addEventListener('mousedown', (e) => { if (!e.composedPath().includes(host) && !card) clearUi(); }, { passive: true, capture: true });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (bubble || card) clearUi();
    else if (reader) closeReader();
  }, { capture: true });
  let layoutFrame = 0;
  function reposition() {
    if (layoutFrame || (!card && !bubble)) return;
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = 0;
      if (card && current) {
        if (current.range && !current.range.startContainer.isConnected) { resetPageUi(); return; }
        if (current.range) current.rect = current.range.getBoundingClientRect();
        place(card, current.rect, 'below');
      }
      if (bubble && current && !card) {
        const sel = currentSelection(true);
        if (sel) { current.rect = sel.rect; place(bubble, sel.rect, 'above'); } else clearUi();
      }
    });
  }
  window.addEventListener('scroll', reposition, { passive: true, capture: true });
  window.addEventListener('resize', reposition, { passive: true });
  window.visualViewport?.addEventListener('resize', reposition, { passive: true });
  window.visualViewport?.addEventListener('scroll', reposition, { passive: true });
  // single-page apps: a navigation drops whatever was about the old page
  const nav = window.navigation;
  if (nav?.addEventListener) nav.addEventListener('navigatesuccess', resetPageUi);
  window.addEventListener('popstate', resetPageUi);
  window.addEventListener('pagehide', resetPageUi);

  // ------------------------------------------------------------------ the card
  function openCard(title) {
    const rect = current?.rect || new DOMRect(innerWidth / 2, 80, 0, 0);
    hideTip();
    bubble?.remove(); bubble = null;
    card?.remove();
    const body = h('div', { class: 'body', 'aria-live': 'polite' });
    const actions = h('div', { class: 'actions' });
    card = h('div', { class: 'card', role: 'dialog', 'aria-label': `Echo Anywhere: ${title}` },
      h('div', { class: 'head' }, echoImg(), h('span', { class: 'title', text: title }),
        h('button', { class: 'icon-btn', title: 'Mở bảng Echo', 'aria-label': 'Mở bảng Echo bên cạnh', onmousedown: keepSelection,
          onclick: () => openPanel('lookup') }, icon('panel')),
        h('button', { class: 'icon-btn', title: 'Đóng (Esc)', 'aria-label': 'Đóng', onmousedown: keepSelection, onclick: clearUi }, icon('close'))),
      body, actions);
    shell.append(card);
    body.append(h('div', { class: 'skeleton' }), h('div', { class: 'skeleton', style: 'width:70%' }), h('div', { class: 'skeleton', style: 'width:85%' }));
    place(card, rect, 'below');
    const cr = card.getBoundingClientRect();
    card.style.setProperty('--ox', `${Math.round(rect.left + rect.width / 2 - cr.left)}px`);
    card.style.setProperty('--oy', cr.top >= rect.bottom ? '0%' : '100%');
    card.querySelector('.head button')?.focus({ preventScroll: true, focusVisible: keyboardOpen });
    keyboardOpen = false;
    return { body, actions, relayout: () => card && place(card, rect, 'below') };
  }

  function errorBox(body, err, retry) {
    body.replaceChildren(h('p', { class: 'error', text: err?.message || 'Có lỗi xảy ra.' }));
    if (err?.code === 'PREMIUM_REQUIRED' || err?.status === 403 && /premium/i.test(err?.code || '')) {
      body.append(h('p', { class: 'muted', text: 'Tính năng AI của Echo Anywhere dành cho Premium. Tra nghĩa, dịch nhanh, phát âm và lưu Flashcard vẫn miễn phí.' }),
        h('button', { class: 'btn primary', onclick: () => send({ t: 'open', path: '/premium' }) }, 'Xem gói Premium'));
    } else if (err?.code === 'NOT_CONNECTED' || err?.status === 401) {
      body.append(h('button', { class: 'btn primary', onclick: () => send({ t: 'connect' }) }, 'Kết nối tài khoản English Coach'));
    } else if (retry) {
      body.append(h('button', { class: 'btn', onclick: retry }, 'Thử lại'));
    }
  }

  async function confirmPrivate(body, what, purpose = 'lexical') {
    if (!privateSurface()) return true;
    const selected = current;
    const scope = await scopeFor(selected?.node,selected?.kind);
    if (selected !== current || !body.isConnected) return false;
    if ((await send({t:'consent:check',scope,purpose}))?.allowed) return true;
    return new Promise((resolve) => {
      const remember = h('input',{type:'checkbox',checked:scope?.kind==='mixed'});
      body.replaceChildren(
        h('p', { text: 'Chỉ chia sẻ phần văn bản bạn chọn.' }),
        h('blockquote', { text: current?.text || '' }),
        h('p', { class: 'muted', text: `Cho phép dùng đoạn đã chọn để ${what}? Tra cứu, dịch và lưu dùng English Coach. Tính năng AI gửi đoạn này tới nhà cung cấp AI.` }),
        ...(scope?.remember ? [h('label',{},remember,scope.kind === 'mixed' ? ' Nhớ cho thao tác này trên bảng tin trong phiên này' : ' Nhớ cho thao tác này trong cuộc trò chuyện và phiên này')] : []),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', onclick: async () => { if (remember.checked) await send({t:'consent:remember',scope,purpose}); resolve(selected === current && body.isConnected); } }, 'Đồng ý gửi đoạn này'),
          h('button', { class: 'btn', onclick: () => { clearUi(); resolve(false); } }, 'Hủy')));
    });
  }

  function speak(text) {
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(String(text).slice(0, 400));
      u.lang = 'en-US';
      u.rate = 0.92;
      const voices = speechSynthesis.getVoices().filter(v => !privateSurface() || v.localService);
      const voice = voices.find((v) => /^en(-|_)US/i.test(v.lang)) || voices.find((v) => /^en/i.test(v.lang));
      if (privateSurface() && !voice) {
        openCard('Phát âm').body.replaceChildren(h('p', { text: 'Chưa có giọng tiếng Anh trên máy. Hãy bật giọng đọc cục bộ để phát âm đoạn riêng tư.' }));
        return;
      }
      if (voice) u.voice = voice;
      speechSynthesis.speak(u);
    } catch { /* no speech engine: nothing to play */ }
  }
  function playAudio(url, fallbackText) {
    if (url && /^https:\/\//.test(url)) {
      const a = new Audio(url);
      a.play().catch(() => speak(fallbackText));
    } else speak(fallbackText);
  }

  function renderDictionary(body, d, sel) {
    const out = [];
    out.push(h('p', { class: 'word', text: d.headword || sel.text }));
    const meta = h('div', { class: 'row' });
    for (const p of (d.pronunciations || []).slice(0, 2)) {
      if (!p?.ipa) continue;
      meta.append(h('button', { class: 'say', title: 'Phát âm', onmousedown: keepSelection, onclick: () => playAudio(p.audioUrl, d.headword || sel.text) },
        icon('sound'), h('span', { class: 'ipa', text: `${p.region && p.region !== 'General' ? `${p.region} ` : ''}${p.ipa}` })));
    }
    if (!meta.childElementCount) meta.append(h('button', { class: 'say', onmousedown: keepSelection, onclick: () => speak(d.headword || sel.text) }, icon('sound'), 'Nghe'));
    if (d.cefr) meta.append(h('span', { class: 'chip', text: d.cefr }));
    if (d.searchedForm && d.searchedForm !== d.headword) meta.append(h('span', { class: 'chip', text: `dạng của “${d.headword}”` }));
    out.push(meta);
    if (d.generalTranslationVi) out.push(h('p', { class: 'general', text: d.generalTranslationVi }));
    if (d.inflectionNote) out.push(h('p', { class: 'muted', text: d.inflectionNote }));
    const vi = (d.vietnameseSenses || []).filter((g) => g?.meanings?.length);
    if (vi.length) {
      out.push(h('h4', { text: 'Nghĩa tiếng Việt' }));
      for (const g of vi.slice(0, 3)) {
        out.push(h('p', { class: 'muted', text: g.partOfSpeech || '' }), h('ol', {}, g.meanings.slice(0, 3).map((m) => h('li', { text: m }))));
      }
    }
    const pos = (d.partsOfSpeech || []).filter((p) => p?.senses?.length);
    if (pos.length) {
      out.push(h('h4', { text: 'Nghĩa tiếng Anh' }));
      for (const p of pos.slice(0, 2)) {
        out.push(h('p', { class: 'muted', text: p.partOfSpeech && p.partOfSpeech !== 'general' ? p.partOfSpeech : '' }));
        out.push(h('ol', {}, p.senses.slice(0, 2).map((s) => h('li', {}, h('span', { text: s.definitionEn || '' }),
          s.translationVi ? h('div', { text: s.translationVi }) : null,
          s.examples?.[0] ? h('div', { class: 'ex', text: s.examples[0] }) : null))));
      }
    }
    if (d.synonyms?.length) out.push(h('h4', { text: 'Đồng nghĩa (ở một số nghĩa)' }), h('p', { text: d.synonyms.slice(0, 6).join(', ') }));
    if (d.antonyms?.length) out.push(h('h4', { text: 'Trái nghĩa' }), h('p', { text: d.antonyms.slice(0, 6).join(', ') }));
    const col = (d.collocations || []).slice(0, 6).map((c) => c.phrase).filter(Boolean);
    const phr = [...(d.phrasalVerbs || []), ...(d.idioms || [])].slice(0, 4).map((x) => x.phrase || x.headword || x).filter((x) => typeof x === 'string');
    if (col.length || phr.length) out.push(h('h4', { text: 'Cụm từ liên quan' }), h('p', { text: [...phr, ...col].join(' · ') }));
    if (sel.context && sel.context.toLowerCase() !== sel.text.toLowerCase()) {
      const ctx = h('div', { class: 'ctx' }, h('div', { class: 'muted', text: 'Trong câu bạn đang đọc' }), h('div', { text: sel.context }));
      const quick = h('div', { class: 'muted' });
      ctx.append(quick);
      out.push(ctx);
      send({ t: 'translate', text: sel.context }).then((r) => { if (r?.data) quick.textContent = `Dịch nhanh câu: ${r.data.translation}`; });
      out.push(h('p', { class: 'muted', text: 'Nghĩa chính xác trong câu này: dùng “Giải thích” (Premium AI).' }));
    }
    if (d.vietnameseSource) out.push(h('p', { class: 'muted', text: `Nguồn: ${d.vietnameseSource}` }));
    body.replaceChildren(...out);
  }

  function aiSections(body, data) {
    const out = [];
    const sec = (title, value) => { if (value) out.push(h('h4', { text: title }), h('p', { text: value })); };
    const list = (title, arr, f) => { if (arr?.length) out.push(h('h4', { text: title }), h('ul', {}, arr.map((x) => h('li', {}, ...f(x))))); };
    sec('Dịch theo ngữ cảnh', data.translation);
    sec('Ý nghĩa', data.meaning);
    sec('Câu trả lời', data.answer);
    sec('Dịch sát nghĩa', data.literal);
    list('Ngữ pháp', data.grammar, (g) => [h('strong', { text: g.part }), ' — ', g.explanation || '']);
    sec('Văn phong', data.register);
    list('Thành ngữ', data.idioms, (g) => [h('strong', { text: g.expression }), ' — ', g.meaning || '']);
    list('Cách nói tự nhiên hơn', data.alternatives, (x) => [x]);
    list('Lỗi người học hay gặp', data.pitfalls, (x) => [x]);
    sec('Tiếng Anh đơn giản hơn', data.simpler || data.rewritten);
    list('Ghi chú', data.notes || data.changes, (x) => [x]);
    sec('Nghĩa đang dùng', data.sense);
    list('Ví dụ', data.examples, (x) => [h('div', { text: x.en }), x.vi ? h('div', { class: 'ex', text: x.vi }) : '']);
    out.push(h('p', { class: 'muted', text: `Echo AI · trình độ ${data.level || 'B1'} · có thể chưa hoàn hảo, hãy đối chiếu với từ điển.` }));
    body.replaceChildren(...out);
  }

  async function runAction(action) {
    const sel = current || currentSelection();
    if (!sel && action !== 'read') return;
    if (action === 'read') { clearUi(); openReader(); return; }
    if (!await englishSelection(sel)) return;
    if (action === 'speak') { speak(sel.text); return; }
    if (action === 'cosmos' || action === 'practice') {
      if (action === 'cosmos' && privateSurface() && !(await confirmPrivate(openCard('Echo Anywhere').body, 'mở Vũ trụ tri thức', 'cosmos'))) return;
      if (action === 'practice') { openPanel('practice', true); return; }
      const r = isWordish(sel.text) ? await send({ t: 'lookup', word: sel.text }) : null;
      send({ t: 'cosmos', word: r?.data?.headword || sel.text.split(/\s+/)[0] });
      clearUi();
      return;
    }
    if (action === 'lookup' && !isWordish(sel.text)) action = 'translate';
    const titles = { lookup: 'Tra nghĩa', translate: 'Dịch', explain: 'Giải thích', grammar: 'Ngữ pháp', save: 'Lưu Flashcard', ask: 'Hỏi Echo AI' };
    const { body, actions, relayout } = openCard(titles[action] || 'Echo');
    const purpose = action === 'save' ? 'save' : ['explain','grammar','ask'].includes(action) ? 'ai' : 'lexical';
    if (!(await confirmPrivate(body, purpose === 'ai' ? 'phân tích bằng Echo AI' : purpose === 'save' ? 'lưu thẻ' : 'tra từ hoặc dịch',purpose))) return;
    body.replaceChildren(h('div', { class: 'skeleton' }), h('div', { class: 'skeleton', style: 'width:70%' }));

    const footer = (extra = []) => {
      actions.replaceChildren(
        h('button', { class: 'btn primary', onclick: () => runAction('save') }, icon('save'), 'Lưu Flashcard'),
        h('button', { class: 'btn', onclick: () => speak(sel.text) }, icon('sound'), 'Nghe'),
        ...extra,
        h('button', { class: 'btn pro', title: 'Premium AI', onclick: () => runAction('explain') }, icon('bulb'), 'Giải thích'),
        h('button', { class: 'btn pro', title: 'Premium AI', onclick: () => runAction('ask') }, icon('chat'), 'Hỏi Echo'));
    };

    if (action === 'lookup') {
      const r = await send({ t: 'lookup', word: sel.text });
      if (r?.error) {
        if (r.error.code === 'NOT_FOUND') { await showTranslation(body, sel, r.error.message); footer(); relayout(); return; }
        errorBox(body, r.error, () => runAction('lookup'));
      } else renderDictionary(body, r.data, sel);
      footer([h('button', { class: 'btn', onclick: () => runAction('cosmos') }, icon('stars'), 'Vũ trụ tri thức')]);
      relayout();
      return;
    }
    if (action === 'translate') {
      await showTranslation(body, sel);
      footer();
      relayout();
      return;
    }
    if (action === 'save') {
      await saveSelection(body, sel);
      actions.replaceChildren(h('button', { class: 'btn', onclick: () => openPanel('saved') }, 'Xem mục Đã lưu'));
      relayout();
      return;
    }
    // Premium AI: explain, grammar, ask
    if (action === 'ask') {
      const ta = h('textarea', { 'aria-label': 'Câu hỏi của bạn về đoạn đã chọn', placeholder: 'Ví dụ: Vì sao câu này dùng thì hiện tại hoàn thành?' });
      body.replaceChildren(h('p', { class: 'muted', text: `Về: “${sel.text.slice(0, 120)}${sel.text.length > 120 ? '…' : ''}”` }), ta,
        h('p', { class: 'muted', text: 'Câu hỏi và đoạn đã chọn sẽ được gửi tới Echo AI (Premium).' }));
      actions.replaceChildren(h('button', { class: 'btn primary', onclick: () => {
        const q = ta.value.trim();
        if (!q) { ta.focus(); return; }
        callAi(body, actions, { action: 'ask', text: sel.text, context: sel.context, question: q }, relayout);
      } }, icon('chat'), 'Hỏi'));
      ta.focus();
      relayout();
      return;
    }
    await callAi(body, actions, { action: 'explain', text: sel.text, context: sel.context }, relayout, action === 'grammar');
  }

  async function callAi(body, actions, req, relayout, grammarFirst) {
    body.replaceChildren(h('p', { class: 'muted', text: 'Echo AI đang đọc đoạn bạn chọn…' }), h('div', { class: 'skeleton' }), h('div', { class: 'skeleton', style: 'width:80%' }));
    actions.replaceChildren();
    const r = await send({ t: 'ai', req: { ...req, pageTitle: privateSurface() ? null : document.title } });
    if (r?.error) { errorBox(body, r.error, () => callAi(body, actions, req, relayout, grammarFirst)); relayout(); return; }
    const data = r.data;
    aiSections(body, data);
    if (grammarFirst) body.querySelector('h4:nth-of-type(2)')?.scrollIntoView({ block: 'start' });
    actions.replaceChildren(h('button', { class: 'btn primary', onclick: () => runAction('save') }, icon('save'), 'Lưu Flashcard'),
      h('button', { class: 'btn', onclick: () => openPanel('lookup') }, icon('panel'), 'Mở bảng Echo'));
    relayout();
  }

  async function showTranslation(body, sel, lead) {
    const r = await send({ t: 'translate', text: sel.text });
    const out = [];
    if (lead) out.push(h('p', { class: 'muted', text: lead }));
    out.push(h('p', { class: 'word', style: 'font-size:16px', text: sel.text.length > 300 ? `${sel.text.slice(0, 300)}…` : sel.text }));
    if (r?.error) out.push(h('p', { class: 'error', text: r.error.message }));
    else out.push(h('h4', { text: 'Dịch nhanh' }), h('p', { class: 'general', text: r.data.translation }),
      h('p', { class: 'muted', text: 'Dịch máy miễn phí, có thể chưa đúng sắc thái. Dịch theo ngữ cảnh: “Giải thích” (Premium AI).' }));
    body.replaceChildren(...out);
  }

  async function saveSelection(body, sel) {
    let meaning = null, ipa = null, cefr = null, front = sel.text;
    if (isWordish(sel.text)) {
      const r = await send({ t: 'lookup', word: sel.text });
      if (r?.data) {
        front = r.data.headword || sel.text;
        meaning = r.data.generalTranslationVi || r.data.vietnameseSenses?.[0]?.meanings?.[0] || null;
        ipa = r.data.pronunciations?.[0]?.ipa || null;
        cefr = r.data.cefr || null;
      }
    }
    if (!meaning) {
      const t = await send({ t: 'translate', text: sel.text });
      meaning = t?.data?.translation || null;
    }
    const example = sel.context && sel.context.length <= 1000 && sel.context.toLowerCase() !== front.toLowerCase() ? sel.context : null;
    const r = await send({ t: 'save', item: { front: front.slice(0, 255), back: meaning, example, ipa, cefr, omitSource: privateSurface() } });
    if (r?.error) { errorBox(body, r.error, () => saveSelection(body, sel)); return; }
    const exists = r.data.status === 'exists';
    body.replaceChildren(
      h('p', { class: 'word', text: front }),
      meaning ? h('p', { class: 'general', text: meaning }) : null,
      h('p', { class: exists ? 'note' : 'note saved', text: exists ? 'Từ này đã có trong Thẻ từ vựng của bạn — không tạo thẻ trùng.' : 'Đã lưu vào Thẻ từ vựng của tài khoản English Coach.' }),
      h('p', { class: 'muted', text: 'Nguồn (tên trang và địa chỉ, không kèm tham số) được giữ trong mục Đã lưu trên trình duyệt này.' }));
  }

  async function openPanel(tab, consent = false) {
    const sel = current;
    if (sel?.text && !await englishSelection(sel)) return;
    if (sel?.text && !consent && privateSurface() && !(await confirmPrivate(openCard('Mở bảng Echo').body, 'mở trong bảng Echo'))) return;
    const scope = sel?.text ? await scopeFor(sel.node,sel.kind) : null;
    send({ t: 'panel:open', payload: { tab, text: sel?.text || '', private: !!scope, scope, context: scope ? '' : sel?.context || '' } }).then((r) => {
      if (!r?.ok && card) {
        const body = card.querySelector('.body');
        body?.append(h('p', { class: 'note', text: 'Bấm biểu tượng Echo trên thanh công cụ của trình duyệt rồi chọn “Mở bảng Echo”.' }));
      }
    });
  }

  // ------------------------------------------------------------------ article extraction (local only)
  async function englishSelection(sel) {
    if(sel.node && !sel.node.isConnected){clearUi();return false;}
    if(sel.node){
      const live=scopeKind(sel.node);
      if(live==='private' || (sel.kind==='public' && live==='mixed')) {sel.kind=live;sel.context='';}
    }
    const gate = await send({ t: 'language:check', text: sel.text });
    if (current !== sel) return false;
    if (gate?.data?.english) return true;
    openCard('Echo Anywhere').body.replaceChildren(h('p', { text: gate?.error?.message || 'Hãy chọn lại đoạn tiếng Anh.' }));
    return false;
  }
  function extract() {
    const best = document.querySelector('[itemprop="articleBody"], article, [role="article"]');
    if (!best || communicationPage()) return { error: { code: 'SELECT_TEXT', message: 'Hãy chọn đoạn cần học hoặc tự dán văn bản vào bảng Echo.' } };
    const blocks = [];
    for (const el of best.querySelectorAll('h1, h2, h3, p, li, blockquote, pre')) {
      if (el.closest('nav, footer, aside, header, form, [aria-hidden=true], script, style, noscript, table')) continue;
      if (el.closest(ignoreTargets) || el.querySelector(ignoreTargets)) continue;
      const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
      if (t.length < (el.tagName === 'P' ? 25 : 3)) continue;
      if (el.tagName === 'LI' && el.querySelector('p')) continue;
      blocks.push({ tag: el.tagName.toLowerCase(), text: t.slice(0, 3000) });
      if (blocks.length >= 400) break;
    }
    const text = blocks.map((b) => b.text).join('\n');
    const latin = (text.match(/[A-Za-z]/g) || []).length / Math.max(1, text.replace(/\s/g, '').length);
    return { data: { title: document.title.slice(0, 200), blocks, text, latinShare: latin, url: location.origin + location.pathname } };
  }

  async function englishArticle() {
    const result = extract();
    if (result.error) return result;
    const gate = await send({ t: 'language:check', text: result.data.text });
    return gate?.data?.english ? result : { error: gate?.error || { message: 'Hãy chọn đoạn tiếng Anh.' } };
  }

  // ------------------------------------------------------------------ reading comfort (an overlay; the page is never edited)
  let reader = null;
  function readingLevel(text) {
    const words = text.match(/[A-Za-z][A-Za-z'-]*/g) || [];
    const sentences = Math.max(1, (text.match(/[.!?](\s|$)/g) || []).length);
    if (words.length < 80) return null;
    const avgSentence = words.length / sentences;
    const long = words.filter((w) => w.length >= 9).length / words.length;
    const score = avgSentence / 25 + long * 3;
    return score < 0.75 ? 'Dễ đọc' : score < 1.15 ? 'Vừa sức' : 'Khá khó';
  }
  async function openReader() {
    if (communicationPage()) {
      openCard('Đọc tập trung').body.replaceChildren(h('p', { text: 'Trang này có thể chứa hội thoại. Hãy chọn đoạn cần học hoặc dán văn bản vào bảng Echo.' }));
      return;
    }
    const result = await englishArticle();
    if (result.error) { openCard('Đọc tập trung').body.replaceChildren(h('p', { text: result.error.message })); return; }
    const data = result.data;
    if (data.blocks.length < 2) {
      const { body } = openCard('Đọc tập trung');
      body.replaceChildren(h('p', { text: 'Không tìm thấy bài đọc đủ dài trên trang này.' }));
      return;
    }
    const prefs = (await send({ t: 'settings:get' }))?.data || {};
    let scale = prefs.fontScale || 1, lh = 1.75;
    const article = h('article', {}, h('h1', { text: data.title }));
    const words = (data.text.match(/[A-Za-z][A-Za-z'-]*/g) || []).length;
    const lvl = readingLevel(data.text);
    article.append(h('div', { class: 'meta', text: `${words.toLocaleString('vi-VN')} từ · khoảng ${Math.max(1, Math.round(words / 200))} phút đọc${lvl ? ` · ${lvl} (ước lượng theo độ dài câu và từ)` : ''}` }));
    for (const b of data.blocks) {
      const tag = ['h1', 'h2', 'h3'].includes(b.tag) ? (b.tag === 'h1' ? 'h2' : b.tag) : b.tag === 'li' ? 'p' : b.tag === 'pre' ? 'pre' : 'p';
      article.append(h(tag, { class: 'blk', text: b.tag === 'li' ? `• ${b.text}` : b.text }));
    }
    const progress = h('div', { class: 'progress' });
    const ruler = h('div', { class: 'ruler' });
    const setScale = (d) => { scale = Math.max(0.8, Math.min(1.6, +(scale + d).toFixed(2))); reader.style.setProperty('--scale', scale); send({ t: 'settings', patch: { fontScale: scale } }); };
    const toggle = (attr) => reader.setAttribute(attr, reader.getAttribute(attr) === 'on' ? 'off' : 'on');
    const themes = ['light', 'sepia', 'dark'];
    const bar = h('div', { class: 'bar', role: 'toolbar', 'aria-label': 'Công cụ đọc' },
      h('button', { class: 'btn', title: 'Chữ nhỏ hơn', onclick: () => setScale(-0.1) }, 'A−'),
      h('button', { class: 'btn', title: 'Chữ lớn hơn', onclick: () => setScale(0.1) }, 'A+'),
      h('button', { class: 'btn', title: 'Giãn dòng', onclick: () => { lh = lh >= 2.1 ? 1.5 : +(lh + 0.15).toFixed(2); reader.style.setProperty('--lh', lh); } }, 'Giãn dòng'),
      h('button', { class: 'btn', title: 'Làm nổi đoạn đang đọc', onclick: () => toggle('data-spot') }, 'Làm nổi đoạn'),
      h('button', { class: 'btn', title: 'Thước đọc', onclick: () => toggle('data-ruler') }, 'Thước đọc'),
      h('button', { class: 'btn', title: 'Đổi nền', onclick: () => { const i = themes.indexOf(reader.dataset.theme); reader.dataset.theme = themes[(i + 1) % themes.length]; send({ t: 'settings', patch: { readingTheme: reader.dataset.theme } }); } }, 'Nền'),
      h('button', { class: 'btn primary', title: 'Trở lại trang gốc (Esc)', onclick: closeReader }, 'Trở về trang gốc'));
    reader = h('div', { class: 'reader', role: 'dialog', 'aria-label': 'Đọc tập trung', 'data-theme': prefs.readingTheme || 'light', 'data-spot': 'off', 'data-ruler': 'off', tabindex: '-1' },
      progress, bar, ruler, article);
    reader.style.setProperty('--scale', scale);
    reader.style.setProperty('--lh', lh);
    reader.addEventListener('scroll', () => {
      const max = reader.scrollHeight - reader.clientHeight;
      progress.style.width = `${max > 0 ? (reader.scrollTop / max) * 100 : 100}%`;
      if (reader.dataset.spot === 'on') spotlight();
    }, { passive: true });
    reader.addEventListener('mousemove', (e) => { if (reader.dataset.ruler === 'on') ruler.style.top = `${e.clientY - ruler.offsetHeight / 2}px`; }, { passive: true });
    reader.addEventListener('mouseup', () => {
      const sel = root.getSelection ? root.getSelection() : null; // closed shadow: our own selection API
      const s = sel && !sel.isCollapsed ? sel : null;
      if (!s) return;
      const text = s.toString().replace(/\s+/g, ' ').trim();
      if (!text) return;
      const range = s.getRangeAt(0);
      current = { text, range: range.cloneRange(), rect: range.getBoundingClientRect(), context: sentenceAround(range, text) };
      showBubble(current, true);
    });
    function spotlight() {
      const mid = innerHeight * 0.4;
      let on = null;
      for (const el of article.querySelectorAll('.blk')) { const r = el.getBoundingClientRect(); if (r.top <= mid && r.bottom >= mid) { on = el; break; } }
      article.querySelectorAll('.blk.on').forEach((el) => el !== on && el.classList.remove('on'));
      on?.classList.add('on');
    }
    shell.append(reader);
    document.documentElement.style.setProperty('overflow', 'hidden', 'important');
    reader.focus({ preventScroll: true });
  }
  function closeReader() {
    reader?.remove();
    reader = null;
    document.documentElement.style.removeProperty('overflow');
  }

  // ------------------------------------------------------------------ messages from the extension
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !msg) return false;
    if (msg.t === 'invoke') {
      ready.then(() => {
        const sel = msg.action === 'read' ? null : currentSelection();
        keyboardOpen = true;
        if (msg.action === 'read') { clearUi(); openReader(); }
        else if (!sel) {
          current = null;
          const { body } = openCard('Echo Anywhere');
          body.replaceChildren(h('p', { text: 'Hãy bôi đen một từ, cụm từ hoặc câu tiếng Anh trên trang rồi thử lại.' }),
            h('p', { class: 'muted', text: 'Nếu phụ đề là hình ảnh hoặc chữ nằm trong khung bị bảo vệ, hãy tự dán văn bản vào bảng Echo.' }));
        } else {
          current = sel;
          if (msg.action === 'toolbar') showBubble(sel, true);
          else runAction(msg.action);
        }
        sendResponse({ ok: true });
      });
      return true;
    }
    if(msg.t==='media:selection'){
      ready.then(async()=>{
        const sel=currentSelection();if(!sel || sel.text.length>800){sendResponse({error:{message:'Chọn tối đa 800 ký tự tiếng Anh bên ngoài ô nhập.'}});return;}
        const gate=await send({t:'language:check',text:sel.text});
        sendResponse(gate?.data?.english?{data:{text:sel.text,scope:await scopeFor(sel.node,sel.kind)}}:gate);
      });return true;
    }
    if (msg.t === 'extract') {
      ready.then(async () => sendResponse(communicationPage()
        ? { error: { code: 'PRIVATE_PAGE', message: 'Hãy chọn hoặc dán đoạn cần học. Echo không đọc toàn bộ hội thoại.' } }
        : await englishArticle()));
      return true;
    }
    return false;
  });
})();
