import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const require=createRequire(import.meta.url),babel=require('next/dist/compiled/babel/bundle.js');
const css=new Proxy({},{get:(t,k)=>k==='__esModule'?false:String(k)});
const cache={};
function load(name){
  if(cache[name])return cache[name];
  const exports={};cache[name]=exports;
  const code=babel.core().transformSync(readFileSync(new URL(`../src/components/features/games/king-of-english/${name}.tsx`,import.meta.url),'utf8'),{
    filename:`${name}.tsx`,configFile:false,babelrc:false,presets:[babel.presetTypescript(),babel.presetReact()],plugins:[babel.pluginTransformModulesCommonjs()]}).code;
  runInNewContext(code,{exports,React,console,require:name=>{
    if(name==='react')return React;
    if(name==='lucide-react')return new Proxy({},{get:()=>()=>null});
    if(name==='@/components/ui/button')return {Button:({variant,...props})=>React.createElement('button',props)};
    if(name==='./king.module.css')return css;
    if(name==='./KingFeedback')return load('KingFeedback');
    throw Error(name);
  }});return exports;
}
const conquest=load('KingConquestBoard'),explain=load('KingExplainRound');
let count=0;const check=(name,fn)=>{fn();count++;console.log(`PASS ${name}`);};
const array=value=>Array.from(value);
check('actual path reducer supports horizontal vertical diagonal and rejects jump/reuse/out-of-bounds',()=>{
  for(const path of [[0,1,2],[0,5,10],[0,6,12]]){
    let result=[];for(const cell of path)result=conquest.extendPath(result,cell);assert.deepEqual(array(result),path);
  }
  assert.deepEqual(array(conquest.extendPath([0],2)),[0]);assert.deepEqual(array(conquest.extendPath([0,1,6],0)),[0,1,6]);
  assert.deepEqual(array(conquest.extendPath([0],25)),[0]);assert.deepEqual(array(conquest.extendPath([0],-1)),[0]);
});
check('actual path reducer permits backtrack undo and caps eight cells',()=>{
  assert.deepEqual(array(conquest.extendPath([0,1,6],1)),[0,1]);
  assert.deepEqual(array(conquest.extendPath([0,1,2,3,4,9,8,7],6)),[0,1,2,3,4,9,8,7]);
});
const base={matchId:'fixture',round:0,inputRevision:0,completed:0,youId:1,config:{explainClueMax:400,explainGuessCap:12,conquestWordCap:180}};
const props={vi:true,disabled:false,answer:'',setAnswer:()=>{},send:()=>true};
check('guesser renderer has escaped clues and no target/alias/forbidden node',()=>{
  const html=renderToStaticMarkup(React.createElement(explain.KingExplainRound,{...props,state:{...base,explain:{role:'GUESSER',clues:['<script>alert(1)</script>'],guessAttempts:0}}}));
  assert(html.includes('&lt;script&gt;'));assert(!html.includes('<script>'));assert(!html.includes('acceptedAliases'));assert(html.includes('maxLength="160"'));
});
check('describer renderer displays privately delivered target and bounded English composer',()=>{
  const html=renderToStaticMarkup(React.createElement(explain.KingExplainRound,{...props,state:{...base,explain:{role:'DESCRIBER',target:'umbrella',clues:[],forbiddenForms:['umbrellas'],guessAttempts:0}}}));
  assert(html.includes('umbrella'));assert(html.includes('umbrellas'));assert(html.includes('maxLength="400"'));assert(html.includes('king-explain-input'));
});
check('resolution renders meaning; disconnected/pending inputs honor disabled',()=>{
  const state={...base,resolved:true,explain:{role:'GUESSER',target:'umbrella',meaning:'cái ô',clues:['rain'],guessAttempts:1}};
  let html=renderToStaticMarkup(React.createElement(explain.KingExplainRound,{...props,state}));assert(html.includes('cái ô'));assert(!html.includes('<textarea'));
  html=renderToStaticMarkup(React.createElement(explain.KingExplainRound,{...props,disabled:true,state:{...state,resolved:false}}));assert(html.includes('disabled=""'));
});
check('board has 25 native controls, non-color ownership markers, throne and result statistics',()=>{
  const state={...base,conquest:{letters:Array(25).fill('A'),owners:Array.from({length:25},(_,n)=>n%3===0?-1:n%3===1?1:2),territory:8,longestWord:6,usedWords:['garden'],lastWord:'garden',lastPlayer:1}};
  const html=renderToStaticMarkup(React.createElement(conquest.KingConquestBoard,{...props,disabled:true,state}));
  assert.equal((html.match(/data-king-cell=/g)||[]).length,25);assert(html.includes('●'));assert(html.includes('▲'));assert(html.includes('ngai vàng'));
  assert(html.includes('32%'));assert(html.includes('garden'));assert(html.includes('touch-action:none'));assert(html.includes('disabled=""'));
});
console.log(`King Phase 3: ${count} behavioral path/React SSR groups passed; browser mounting and pointer verification are separate.`);
