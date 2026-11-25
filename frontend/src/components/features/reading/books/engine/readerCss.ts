/**
 * Stylesheet of the reader's shadow root. Layers: `base` (book defaults the reader adds), `book` (the publisher's
 * sanitized CSS), `user` (reader choices that must win). Typographic choices are set on `.ec-flow` and inherited,
 * so a publisher rule that targets an element (a centred epigraph, an italic letter) still wins over the defaults.
 */
export const READER_CSS = String.raw`
@layer base, book, user;
:host { all: initial; display: block; position: absolute; inset: 0; contain: strict; }
.ec-stage {
  --ec-paper: #f6efe1; --ec-ink: #2c261d; --ec-faint: rgba(60,48,30,.52); --ec-desk: #e7dcc6; --ec-link: #7a4a12;
  --ec-sel: rgba(214,170,79,.36); --ec-edge: rgba(80,60,30,.20);
  --hl-yellow: rgba(255,210,70,.45); --hl-green: rgba(120,200,120,.38); --hl-blue: rgba(110,170,255,.36);
  --hl-pink: rgba(255,130,170,.36); --hl-orange: rgba(255,160,80,.40); --ec-search: rgba(255,140,0,.5);
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; overflow: hidden;
  background: var(--ec-desk); -webkit-tap-highlight-color: transparent; touch-action: pan-y pinch-zoom;
}
.ec-stage[data-theme="white"] { --ec-paper: #fdfdfb; --ec-ink: #1c1c1a; --ec-faint: rgba(30,30,30,.48); --ec-desk: #ebeae6; --ec-link: #1f4f99; --ec-sel: rgba(80,140,255,.28); --ec-edge: rgba(0,0,0,.14); }
.ec-stage[data-theme="dark"] { --ec-paper: #1e1f22; --ec-ink: #d9d5cc; --ec-faint: rgba(217,213,204,.5); --ec-desk: #131416; --ec-link: #e6b56a; --ec-sel: rgba(230,181,106,.28); --ec-edge: rgba(0,0,0,.6);
  --hl-yellow: rgba(214,170,40,.38); --hl-green: rgba(80,170,90,.36); --hl-blue: rgba(70,130,230,.40); --hl-pink: rgba(220,90,140,.38); --hl-orange: rgba(230,130,50,.40); }
.ec-stage[data-theme="oled"] { --ec-paper: #000; --ec-ink: #bdb9b0; --ec-faint: rgba(189,185,176,.45); --ec-desk: #000; --ec-link: #d9a65a; --ec-sel: rgba(217,166,90,.3); --ec-edge: rgba(0,0,0,0);
  --hl-yellow: rgba(200,160,30,.36); --hl-green: rgba(70,160,80,.34); --hl-blue: rgba(60,120,220,.38); --hl-pink: rgba(210,80,130,.36); --hl-orange: rgba(220,120,40,.38); }
.ec-book { position: relative; flex: none; }
.ec-sheet { position: absolute; top: 0; height: 100%; background: var(--ec-paper); }
.ec-book.ec-raised .ec-sheet { box-shadow: 0 1px 2px var(--ec-edge), 0 18px 40px -26px var(--ec-edge); }
.ec-book.ec-raised .ec-sheet.ec-left { border-radius: 5px 1px 1px 5px; }
.ec-book.ec-raised .ec-sheet.ec-right { border-radius: 1px 5px 5px 1px; }
.ec-book.ec-raised .ec-sheet.ec-solo { border-radius: 3px 6px 6px 3px; }
.ec-spine { position: absolute; top: 0; height: 100%; width: 64px; margin-left: -32px; pointer-events: none; }
.ec-leaf-spine { position: absolute; top: 0; height: 100%; width: 32px; pointer-events: none; background-size: 64px 100% !important; }
.ec-spine, .ec-leaf-spine {
  background: linear-gradient(90deg, rgba(0,0,0,0) 0, rgba(0,0,0,.035) 38%, rgba(0,0,0,.10) 49.5%, rgba(255,255,255,.05) 50.5%, rgba(0,0,0,.035) 62%, rgba(0,0,0,0) 100%); }
.ec-stage[data-theme="oled"] :is(.ec-spine, .ec-leaf-spine) { display: none; }
.ec-running { position: absolute; font: 500 11.5px/1.2 var(--ec-ui-font); letter-spacing: .02em; color: var(--ec-faint);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none; user-select: none; -webkit-user-select: none; }
.ec-viewport { position: absolute; overflow: hidden; }
.ec-viewport.ec-scroll { overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; scrollbar-width: thin; }
.ec-flow {
  font-family: var(--ec-font); font-size: var(--ec-size); line-height: var(--ec-lh); color: var(--ec-ink); text-align: var(--ec-align);
  hyphens: var(--ec-hyph); -webkit-hyphens: var(--ec-hyph); font-kerning: normal; font-variant-ligatures: common-ligatures;
  font-optical-sizing: auto; text-rendering: optimizeLegibility; -webkit-font-smoothing: antialiased; overflow-wrap: break-word;
  -webkit-text-size-adjust: 100%; text-size-adjust: 100%; user-select: text; -webkit-user-select: text; cursor: text;
}
.ec-flow.ec-paged { column-count: var(--ec-cols); column-gap: var(--ec-gap); column-fill: auto; height: var(--ec-h); }
.ec-flow.ec-clone { height: var(--ec-h); position: relative; }
.ec-flow.ec-paged > .ec-pad { break-before: column; height: 1px; }
.ec-flow ::selection, .ec-fxl-box ::selection { background: var(--ec-sel); }
.ec-fxl-box { user-select: text; -webkit-user-select: text; }
.ec-scroll-next { display: flex; justify-content: center; padding: 2.5em 0 3em; }
.ec-scroll-next button { font: 600 14px var(--ec-ui-font); color: var(--ec-ink); background: transparent; border: 1px solid var(--ec-edge);
  border-radius: 999px; padding: .6em 1.3em; cursor: pointer; }
.ec-overlay { position: absolute; inset: 0; overflow: hidden; pointer-events: none; z-index: 3; }
.ec-overlay > .ec-leaf { position: absolute; top: 0; height: 100%; background: var(--ec-paper); overflow: hidden; }
.ec-leaf-content { position: absolute; }
.ec-fxl { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
.ec-fxl-page { position: relative; overflow: hidden; flex: none; background: #fff; }
.ec-fxl-page > .ec-fxl-box { position: absolute; left: 0; top: 0; transform-origin: 0 0; overflow: hidden; }
.ec-fxl-box > .ec-body { position: relative; width: 100%; height: 100%; margin: 0; }

@layer base {
  .ec-body { margin: 0; padding: 0; }
  .ec-body img, .ec-body svg { max-width: 100%; height: auto; break-inside: avoid; }
  /* a box sized for a wide screen (a figure 550px wide) must not run off the page: the overflow would be cut */
  .ec-body :is(div, figure, section, article, aside, header, footer, blockquote, p, ul, ol, dl, pre) { max-width: 100%; }
  .ec-paged .ec-body img, .ec-paged .ec-body svg, .ec-clone .ec-body img, .ec-clone .ec-body svg { max-height: calc(var(--ec-h) - 2px); object-fit: contain; }
  .ec-body figure { margin: 1em 0; break-inside: avoid; }
  .ec-body h1, .ec-body h2, .ec-body h3, .ec-body h4, .ec-body h5, .ec-body h6 { break-after: avoid; line-height: 1.25; hyphens: manual; -webkit-hyphens: manual; }
  .ec-body p, .ec-body li, .ec-body blockquote, .ec-body dd { orphans: 2; widows: 2; }
  .ec-body table { border-collapse: collapse; max-width: 100%; font-size: .92em; }
  .ec-body td, .ec-body th { padding: .2em .45em; vertical-align: top; }
  .ec-body pre { white-space: pre-wrap; font-size: .85em; }
  .ec-body code, .ec-body kbd, .ec-body samp, .ec-body tt, .ec-body pre { font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace; }
  .ec-body blockquote { margin: 1em 1.4em; }
  .ec-body hr { border: 0; border-top: 1px solid currentColor; opacity: .28; margin: 1.3em 22%; }
  .ec-body a[data-ec-href], .ec-body a[data-ec-ext] { color: var(--ec-link); text-decoration: underline; text-decoration-thickness: .06em; text-underline-offset: .16em; cursor: pointer; }
  .ec-body a[data-epub-type~="noteref"] { text-decoration: none; }
  .ec-body aside[data-epub-type~="footnote"], .ec-body aside[data-epub-type~="endnote"], .ec-body aside[data-epub-type~="rearnote"] { display: none; }
  .ec-body .ec-media, .ec-body .ec-missing-img { font-style: italic; opacity: .65; }
  .ec-txt p { margin: 0; text-indent: 1.5em; }
  .ec-txt p:first-child, .ec-txt h2 + p { text-indent: 0; }
  .ec-txt h2 { font-size: 1.3em; font-weight: 600; text-align: center; margin: 2.2em 0 1.4em; text-indent: 0; break-before: column; }
  .ec-txt h2:first-child { margin-top: 1em; break-before: auto; }
}
@layer user {
  :is(.ec-flow, .ec-fxl-box) mark.ec-hl { color: inherit; border-radius: 2px; background: var(--hl-yellow); -webkit-box-decoration-break: clone; box-decoration-break: clone; cursor: pointer; }
  :is(.ec-flow, .ec-fxl-box) mark.ec-hl[data-c="green"] { background: var(--hl-green); }
  :is(.ec-flow, .ec-fxl-box) mark.ec-hl[data-c="blue"] { background: var(--hl-blue); }
  :is(.ec-flow, .ec-fxl-box) mark.ec-hl[data-c="pink"] { background: var(--hl-pink); }
  :is(.ec-flow, .ec-fxl-box) mark.ec-hl[data-c="orange"] { background: var(--hl-orange); }
  :is(.ec-flow, .ec-fxl-box) mark.ec-hl.ec-has-note { text-decoration: underline dotted; text-decoration-thickness: .08em; text-underline-offset: .22em; }
  :is(.ec-flow, .ec-fxl-box) mark.ec-search { color: inherit; background: var(--ec-search); border-radius: 2px; }
}
@media (prefers-reduced-motion: reduce) { .ec-overlay * { transition: none !important; } }
`;
