/** Shared sky/ocean palette and task-owned painted character assets. */
export function ArtPalette(){return <defs>
  <linearGradient id="hm-sky" x2=".2" y2="1"><stop stopColor="#92d6e4"/><stop offset="1" stopColor="#f8f2d7"/></linearGradient>
  <linearGradient id="hm-sea" x2="0" y2="1"><stop stopColor="#39b6c8"/><stop offset="1" stopColor="#145779"/></linearGradient>
  <radialGradient id="hm-skin" cx=".32" cy=".26" r=".8"><stop stopColor="#ffe6ac"/><stop offset=".7" stopColor="#f6bf7b"/><stop offset="1" stopColor="#dc8b58"/></radialGradient>
  <linearGradient id="hm-orange" x2="1" y2="1"><stop stopColor="#ffd06f"/><stop offset=".45" stopColor="#f8a33c"/><stop offset="1" stopColor="#d46130"/></linearGradient>
  <linearGradient id="hm-cap" x2=".6" y2="1"><stop stopColor="#88deea"/><stop offset=".5" stopColor="#32a5bf"/><stop offset="1" stopColor="#207087"/></linearGradient>
  <radialGradient id="hm-slate" cx=".24" cy=".22" r=".9"><stop stopColor="#89a9b3"/><stop offset=".5" stopColor="#536f83"/><stop offset="1" stopColor="#303f60"/></radialGradient>
  <linearGradient id="hm-jaw" x2=".4" y2="1"><stop stopColor="#fffbe6"/><stop offset="1" stopColor="#b6d4dc"/></linearGradient>
  {['#fff48a|#edab28','#ffb7c4|#d94981','#a8eff0|#30a8ba','#dcc8ff|#9366bb','#ffdc9b|#f58d4e'].map((pair,i)=><radialGradient key={pair} id={`hm-balloon-${i}`} cx=".3" cy=".23" r=".8"><stop stopColor="#fff8dd"/><stop offset=".25" stopColor={pair.split('|')[0]}/><stop offset="1" stopColor={pair.split('|')[1]}/></radialGradient>)}
</defs>;}

export { ExplorerRig } from './HangmanExplorer';

export { SharkRig } from './HangmanShark';
