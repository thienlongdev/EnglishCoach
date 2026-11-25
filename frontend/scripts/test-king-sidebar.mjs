import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import React from 'react';
const require=createRequire(import.meta.url),babel=require('next/dist/compiled/babel/bundle.js');
// SidebarInner has several state slots and effects: only the FIRST useState is the collapse choice; every effect's
// cleanup runs on "unmount", so the media listener is checked whichever position its effect has.
let collapsed=false,slots=[],slot=0,cleanups=[];const listeners=new Set();
const media={matches:false,addEventListener:(type,fn)=>listeners.add(fn),removeEventListener:(type,fn)=>listeners.delete(fn)};
const hooks={...React,
 useState:initial=>{const i=slot++;if(i===0)return [collapsed,value=>{collapsed=value;}];if(!(i in slots))slots[i]=initial;return [slots[i],value=>{slots[i]=value;}];},
 useEffect:fn=>{const c=fn();if(typeof c==='function')cleanups.push(c);}};
const mount=()=>{slot=0;slots=[];cleanups=[];exports.SidebarInner();};
const cleanup=()=>{for(const c of cleanups.splice(0))c();};
const exports={};
const source=readFileSync(new URL('../src/components/layout/Sidebar.tsx',import.meta.url),'utf8')+'\nexport {SidebarInner};';
const code=babel.core().transformSync(source,{filename:'Sidebar.tsx',configFile:false,babelrc:false,presets:[babel.presetTypescript(),babel.presetReact()],plugins:[babel.pluginTransformModulesCommonjs()]}).code;
runInNewContext(code,{exports,React:hooks,window:{matchMedia:query=>{assert.equal(query,'(max-width: 767px)');return media;}},require:name=>{
 if(name==='react')return hooks;
 if(name==='next/navigation')return {useRouter:()=>({}),useSearchParams:()=>new URLSearchParams(),usePathname:()=>'/games'};
 if(name==='next-auth/react')return {useSession:()=>({}),signIn(){}};
 if(name==='@/context/LanguageContext')return {useLanguage:()=>({locale:'en',t:key=>key})};
 if(name==='@/hooks/useCurrentRole')return {useCurrentRole:()=>({isAdmin:false})};
 if(name==='@/hooks/useFeedback')return {useAdminFeedbackUnreadCount:()=>({unreadCount:0})};
 if(name==='@/services/logout')return {logout(){}};
 if(name==='lucide-react')return new Proxy({},{get:()=>()=>null});
 return new Proxy(()=>null,{get:()=>()=>null});
}});
mount();assert.equal(collapsed,false);assert.equal(listeners.size,1);console.log('PASS desktop mount preserves expanded choice');
media.matches=true;for(const fn of listeners)fn();assert.equal(collapsed,true);console.log('PASS desktop-to-mobile event collapses sidebar');
media.matches=false;for(const fn of listeners)fn();assert.equal(collapsed,true);console.log('PASS leaving mobile preserves collapsed choice');
cleanup();assert.equal(listeners.size,0);console.log('PASS unmount removes media listener');
media.matches=true;collapsed=false;mount();assert.equal(collapsed,true);cleanup();console.log('PASS fresh mobile mount collapses without duplicate listeners');

// The live shared Echo launcher must not intercept mobile King board input.
const shellExports={};
const shellSource=readFileSync(new URL('../src/components/features/games/king-of-english/KingShell.tsx',import.meta.url),'utf8');
const shellCode=babel.core().transformSync(shellSource,{filename:'KingShell.tsx',configFile:false,babelrc:false,presets:[babel.presetTypescript(),babel.presetReact()],plugins:[babel.pluginTransformModulesCommonjs()]}).code;
runInNewContext(shellCode,{exports:shellExports,React,require:name=>name==='./kingArt'?{KING_ART:{},KING_MODE_ART:{}}:({})});
const arena=shellExports.KingShell({vi:true,children:null,onQuit:()=>{}});
const lobby=shellExports.KingShell({vi:true,children:null});
assert.equal(arena.props['data-king-arena'],'true');
assert.equal(lobby.props['data-king-arena'],undefined);
const style=React.Children.toArray(arena.props.children).find(child=>child.type==='style').props.children;
assert.match(style,/@media\(max-width:767px\)\{body:has\(\[data-king-arena="true"\]\) \.echo-launcher,body:has\(\[data-king-arena="true"\]\) \.echo-discovery\{display:none\}\}/);
console.log('PASS mobile arena suppresses obstructing Echo controls; lobby restores them');
