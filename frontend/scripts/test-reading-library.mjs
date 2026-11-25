import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
const require = createRequire(import.meta.url);
const babel = require('next/dist/compiled/babel/bundle.js');
const read = p => readFileSync(new URL('../src/'+p, import.meta.url),'utf8');
function evaluate(path, dependencies={}, globals={}) {
  const {code}=babel.core().transformSync(read(path),{filename:path,configFile:false,babelrc:false,presets:[babel.presetTypescript(),...(path.endsWith('.tsx')?[babel.presetReact()]:[])],plugins:[babel.pluginTransformModulesCommonjs()]});
  const exports={}; runInNewContext(code,{React,exports,require:p=>dependencies[p]??require(p),AbortController,console,setTimeout,clearTimeout,URLSearchParams,...globals}); return exports;
}
const cache=evaluate('lib/reading-system-cache.ts');
const core=evaluate('lib/module-entry-core.ts');
const card={id:1,title:'Learning about rocks',sourceUrl:'https://www.nps.gov/subjects/geology/rocks.htm',sourceName:'National Park Service',materialType:'ARTICLE',wordCount:400,difficultyLevel:'B1',isSystem:true,topic:'Earth Science',readMinutes:2,description:'A coherent introduction',licenseCode:'US-GOV-PD',attribution:'National Park Service'};
const catalog={catalogRevision:'a'.repeat(64),totalElements:1,page:0,size:18,totalPages:1,topics:['Earth Science'],content:[card]};
const values=new Map(), storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),clear:()=>values.clear()};
const now=Date.now();
storage.setItem(cache.READING_SYSTEM_CACHE_KEY,JSON.stringify({version:1,cachedAt:now-300001,data:catalog}));
assert.equal(cache.readReadingSnapshot(storage,now).data.content[0].title,card.title);
for (const data of [{...catalog,content:[{...card,ownerUserId:42}]},{...catalog,content:[{...card,contentText:'body'}]},{...catalog,content:[{...card,isSystem:false}]},{...catalog,progress:[42]},{...catalog,totalElements:3},{...catalog,page:1}]) assert.equal(cache.validReadingSnapshot(data),false);
for(const raw of ['{',JSON.stringify({version:2,cachedAt:now,data:catalog}),JSON.stringify({version:1,cachedAt:now+1,data:catalog}),JSON.stringify({version:1,cachedAt:now-8*86400000,data:catalog}),'x'.repeat(100001)]) { storage.setItem(cache.READING_SYSTEM_CACHE_KEY,raw); assert.equal(cache.readReadingSnapshot(storage,now),undefined); }
let calls=0,finish,seeds=[];
const browserCache=evaluate('lib/reading-system-cache.ts',{}, {window:{},localStorage:storage});
const service=evaluate('services/moduleEntryResources.ts',{'swr':{mutate:async(...args)=>seeds.push(args)},'./api-client':{apiClient:{get:()=>{calls++;return new Promise(r=>finish=r);}}},'../lib/module-entry-core':core,'../lib/reading-system-cache':browserCache,'../lib/flashcard-system-cache':{},'../lib/listening-system-cache':{}});
const prep=service.prepareModuleEntry(service.READING_ENTRY_PATH,'A'), route=service.fetchModuleEntry(service.READING_ENTRY_PATH,'A');
await Promise.resolve(); assert.equal(calls,1);finish({data:catalog}); await Promise.all([prep,route]); assert.equal(seeds.length,1); assert.ok(cache.readReadingSnapshot(storage));
assert.equal(service.entryKey(service.READING_ENTRY_PATH,'A'),service.entryKey(service.READING_ENTRY_PATH,'B'));
assert.notDeepEqual(service.entryKey('/reading/catalog?library=USER&page=0','A'),service.entryKey('/reading/catalog?library=USER&page=0','B'));
const late=service.prepareModuleEntry('/reading/catalog?library=USER&page=0','A');await Promise.resolve();service.clearModuleEntryRequests();finish({data:{content:[{title:'A private'}]}});await assert.rejects(late,/cancelled/);assert.equal(seeds.length,1);
const noop=()=>{}; let purged=false,focusDisposed=false;
const cleanup=evaluate('lib/auth-cache-cleanup.ts',{'@/lib/study-space/focus':{disposeFocusEngines(){focusDisposed=true;}},'swr':{mutate:()=>{purged=true;}},'@/hooks/useCurrentUserAvatar':{revokeCurrentAvatarObjectUrl:noop},'@/services/stompClient':{disconnectRealtimeClient:noop},'@/services/listeningCache':{clearListeningUserCache:noop},'@/services/communityCache':{clearCommunityUserCache:noop},'@/lib/wallpaper/youtubeLibrary':{clearWallpaperLibrary:noop},'@/services/moduleEntryResources':{clearModuleEntryRequests:service.clearModuleEntryRequests},'@/lib/reading-system-cache':browserCache,'@/lib/listening-system-cache':{preserveSystemListeningSnapshot:()=>undefined},'@/lib/flashcard-system-cache':{readFlashcardSnapshot:()=>undefined},'@/lib/content-system-snapshots':{readContentSnapshots:()=>undefined},'@/lib/auth-lifecycle':{cancelAuthenticatedWork:noop},'@/services/profileIdentityResource':{clearProfileIdentityRequests:noop},'@/services/leaderboardSnapshots':{clearBoardSnapshots:noop},'@/services/contentSystemResources':{clearContentRequests:noop}},{window:{},localStorage:storage,sessionStorage:{clear:noop}});
storage.setItem('private-A','private');cleanup.clearUserScopedCaches();assert.ok(focusDisposed);assert.equal(values.size,1);assert.ok(cache.readReadingSnapshot(storage));assert.ok(purged);
let response;
const stub=()=>null;
// Echo Glass presentation modules: class names are opaque strings, the hero / cover art are decoration.
const glassStubs={'./glass/readingGlass.module.css':{__esModule:true,default:new Proxy({},{get:(_,k)=>String(k)})},'./glass/ReadingHero':{ReadingHero:stub},'./glass/ReadingCover':{ReadingCover:stub,topicFamily:()=>'plain'}};
const Dashboard=evaluate('components/features/reading/ReadingDashboard.tsx',{react:React,'@/lib/brand/tabTitle':{useContentTitle:noop},'next/navigation':{useRouter:()=>({push:noop}),useSearchParams:()=>new URLSearchParams(),usePathname:()=>'/reading'},'next-auth/react':{useSession:()=>({data:{user:{id:'1'}}})},'@/hooks/useModuleEntryResource':{useModuleEntryScope:()=> '1',useModuleEntryResource:()=>({data:undefined})},'@/hooks/useReadingCatalog':{useReadingCatalog:()=>({data:response,mutate:noop})},'@/lib/auth-lifecycle':{authEpoch:()=>1,authEnding:()=>false},'@/services/moduleEntryResources':service,'@/services/api-client':{apiClient:{}},'./ReadingCard':{__esModule:true,default:({material})=>React.createElement('article',null,material.title)},'./ImportMaterialModal':{ImportMaterialModal:stub},'./InteractiveReader':{InteractiveReader:stub},'./SpeedReader':{SpeedReader:stub},'./ReadingErrorBoundary':{ReadingErrorBoundary:stub},'@/context/LanguageContext':{useLanguage:()=>({locale:'en',t:{}})},'@/hooks/useCurrentRole':{useCurrentRole:()=>({isAdmin:false})},'@/hooks/useBilingualReading':{useBilingualReadingCatalog:()=>({data:undefined,isLoading:false})},'./BilingualReadingPanel':{BilingualReadingPanel:stub},'./BilingualReader':{BilingualReader:stub},'next/dynamic':{__esModule:true,default:()=>stub},'@/components/common/PageJump':{PageJump:stub},'@/lib/echo/contextBridge':{dispatchEchoModuleReady:noop,publishEchoWorkspaceContext:noop,clearEchoWorkspaceContext:noop,setOverBookReader:noop},...glassStubs}).ReadingDashboard;
const cold=renderToString(React.createElement(Dashboard));{const tabs=[...cold.matchAll(/role="tab"[^>]*>[\s\S]*?<\/button>/g)].map(m=>m[0].replace(/<[^>]+>/g,''));assert.equal(tabs.length,4,'four Reading tabs');assert.ok(tabs[1].includes('>My Books')&&tabs[2].includes('>Bilingual'),'My Books is the second tab: '+tabs.join(' | '));}assert.ok(cold.includes('Loading library'));assert.ok(!cold.includes('No matching readings'));assert.ok(!cold.includes('0 readings'));
response=catalog;const warm=renderToString(React.createElement(Dashboard));assert.ok(warm.includes(card.title));assert.ok(warm.includes('SYSTEM Library'));assert.ok(warm.includes('My Readings'));assert.ok(!warm.includes('contentText'));
response={...catalog,totalElements:0,totalPages:0,content:[]};const empty=renderToString(React.createElement(Dashboard));assert.ok(empty.includes('No matching readings'));assert.ok(empty.includes('0 readings'));
const ui=read('components/features/reading/ReadingDashboard.tsx'),speed=read('components/features/reading/SpeedReader.tsx');
assert.ok(ui.includes('/reading/materials/${id}'));assert.ok(ui.includes('epoch === authEpoch()'));assert.ok(speed.includes('/reading/materials/${mat.id}'));
assert.ok(!read('components/common/ModuleEntryPreparation.tsx').includes('/reading/materials'));
// Library card: catalog values only (no invented CEFR / type), one primary control, no nested interactive elements.
const lang=locale=>({'@/context/LanguageContext':{useLanguage:()=>({locale})}});
const CardModule=evaluate('components/features/reading/ReadingCard.tsx',{react:React,...lang('vi'),...glassStubs});
const html=renderToString(React.createElement(CardModule.default,{material:card,onClick:noop,onSpeakingClick:noop}));
assert.ok(html.includes(card.title)&&html.includes('Earth Science')&&html.includes('National Park Service')&&html.includes('2 phút đọc'));
assert.ok(html.includes('B1')&&html.includes('ước tính'),'SYSTEM CEFR is shown as an estimate');
const bare=renderToString(React.createElement(CardModule.default,{material:{...card,difficultyLevel:null,isSystem:false,topic:'Other',sourceName:null,readMinutes:0,description:'',materialType:'PDF'},onClick:noop}));
assert.ok(!/>B2</.test(bare)&&!bare.includes('CEFR')&&!bare.includes('CUSTOM'),'no invented CEFR level or material type');
assert.ok(bare.includes('Tài liệu của bạn')&&bare.includes('PDF'));
assert.ok(!/<button[^>]*>(?:(?!<\/button>).)*<button/.test(html),'no button inside a button');
assert.equal(CardModule.formatCefrLevel(''),null);assert.equal(CardModule.formatCefrLevel('upper_intermediate'),'B2');
assert.ok(!read('components/features/reading/InteractiveReader.tsx').includes('difficultyLevel || "B2"'),'reader never invents a level');
console.log('Reading library: PASS (real unknown/warm/empty renders; bounded SYSTEM metadata, privacy, stale/corrupt/version rejection; prep/route dedupe; late account rejection; real logout; detail-only body contracts).');
