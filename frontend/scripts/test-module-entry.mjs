import assert from 'node:assert/strict';
import React from 'react';
import {renderToString} from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
const require = createRequire(import.meta.url);
const babel = require('next/dist/compiled/babel/bundle.js');
const read = p => readFileSync(new URL('../src/'+p, import.meta.url), 'utf8');
function evaluate(path, dependencies={}, globals={}) {
  const {code} = babel.core().transformSync(read(path), {filename:path, configFile:false,babelrc:false,presets:[babel.presetTypescript(),...(path.endsWith('.tsx')?[babel.presetReact()]:[])],plugins:[babel.pluginTransformModulesCommonjs()]});
  const exports={}; runInNewContext(code,{exports,require:p=>dependencies[p]??require(p),AbortController,console,setTimeout,clearTimeout,...globals}); return exports;
}
const core=evaluate('lib/module-entry-core.ts');
const cache=evaluate('lib/listening-system-cache.ts');
const flashcardCache=evaluate('lib/flashcard-system-cache.ts');
const readingCache=evaluate('lib/reading-system-cache.ts');
const store=core.createEntryRequestStore();
let loads=0, resolve;
const load=()=>{loads++;return new Promise(r=>resolve=r);};
const a=store.run('A',load), duplicate=store.run('A',load);
assert.equal(a,duplicate); await Promise.resolve(); assert.equal(loads,1);
resolve('A data'); assert.equal(await a,'A data');
const late=store.run('A',load);await Promise.resolve();store.clear();resolve('late A');await assert.rejects(late,/cancelled/);
assert.notDeepEqual(core.moduleEntryKey('/reading/materials','A'),core.moduleEntryKey('/reading/materials','B'));
let inFlight=0,max=0;
await core.prepareEntryResources(['a','b','c'],async p=>{inFlight++;max=Math.max(max,inFlight);await Promise.resolve();inFlight--;if(p==='b')throw Error('failure');},()=>false);
assert.equal(max,1);let visited=[];let cancelled=false;
await core.prepareEntryResources(['a','b'],async p=>{visited.push(p);cancelled=true;},()=>cancelled);assert.deepEqual(visited,['a']);
const data=[{topic:'Ideas & Talks',count:1,items:[{id:1,title:'Talk',channel:'Studio',topic:'Ideas & Talks',level:'B1',accent:'International',durationSeconds:12,thumbnail:null,youtubeVideoId:null,hasTranscript:true,practiceAvailable:true}]}];
const values=new Map();const storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),clear:()=>values.clear()};
const now=1000000000;
cache.saveSystemListeningSnapshot(data,storage,now);
assert.equal(cache.readSystemListeningSnapshot(storage,now).stale,false);
assert.equal(cache.readSystemListeningSnapshot(storage,now+cache.SYSTEM_FRESH_MS).stale,true);
assert.equal(cache.readSystemListeningSnapshot(storage,now+cache.SYSTEM_MAX_AGE_MS+1),undefined);
assert.equal(cache.readSystemListeningSnapshot(storage,now-1),undefined);
assert.equal(cache.validSystemCategories([{...data[0],privateState:'A'}]),false);
assert.equal(cache.validSystemCategories([{...data[0],items:[{...data[0].items[0],ownerUserId:10}]}]),false);
for(const raw of ['{',JSON.stringify({version:1,cachedAt:now,data}),JSON.stringify({version:2,cachedAt:now,data,token:'private'})]){storage.setItem(cache.LISTENING_SYSTEM_CACHE_KEY,raw);assert.equal(cache.readSystemListeningSnapshot(storage,now),undefined);}
assert.equal(cache.readSystemListeningSnapshot({getItem(){throw Error('denied');}}),undefined);
assert.doesNotThrow(()=>cache.saveSystemListeningSnapshot(data,{setItem(){throw Error('quota');}},now));
// Execute the actual logout function, including storage quota failures and SWR purge.
const globalStorage={...storage};globalStorage.setItem(cache.LISTENING_SYSTEM_CACHE_KEY,JSON.stringify({version:2,cachedAt:Date.now(),data}));
for(const k of ['auth_token','ec_session_grant','private-A','ec_list_v1_uA_categories'])globalStorage.setItem(k,'private');globalStorage.setItem('theme','dark');
let purged=false,sessionCleared=false,requestsCancelled=false,focusDisposed=0;
const browserCache=evaluate('lib/listening-system-cache.ts',{}, {window:{localStorage:globalStorage}});
const cleanup=evaluate('lib/auth-cache-cleanup.ts',{'@/lib/study-space/focus':{disposeFocusEngines(){focusDisposed++;}},'swr':{mutate:()=>{purged=true;}},'@/hooks/useCurrentUserAvatar':{revokeCurrentAvatarObjectUrl(){}},'@/services/stompClient':{disconnectRealtimeClient(){}},'@/services/listeningCache':{clearListeningUserCache(){}},'@/services/communityCache':{clearCommunityUserCache(){}},'@/lib/wallpaper/youtubeLibrary':{clearWallpaperLibrary(){}},'@/services/moduleEntryResources':{clearModuleEntryRequests(){requestsCancelled=true;}},'@/lib/reading-system-cache':readingCache,'@/lib/flashcard-system-cache':flashcardCache,'@/lib/listening-system-cache':browserCache,'@/lib/auth-lifecycle':{cancelAuthenticatedWork(){}},'@/services/profileIdentityResource':{clearProfileIdentityRequests(){}},'@/services/leaderboardSnapshots':{clearBoardSnapshots(){}},'@/services/contentSystemResources':{clearContentRequests(){}},'@/lib/content-system-snapshots':{readContentSnapshots:()=>undefined}},{window:{},localStorage:globalStorage,sessionStorage:{clear(){sessionCleared=true;}}});
cleanup.clearUserScopedCaches();assert.equal(values.size,2);assert.ok(values.has(cache.LISTENING_SYSTEM_CACHE_KEY));assert.equal(values.get('theme'),'dark');assert.ok(purged&&sessionCleared&&requestsCancelled);assert.equal(focusDisposed,1);
globalStorage.setItem('private-A','private');globalStorage.setItem=()=>{throw Error('quota');};purged=false;sessionCleared=false;cleanup.clearUserScopedCaches();assert.equal(values.size,0);assert.ok(purged&&sessionCleared);assert.equal(focusDisposed,2);
// Execute the actual service to prove prefetch/entry dedupe and cancellation before seeding SWR.
let networkCalls=0,seeded=[],finish;
const service=evaluate('services/moduleEntryResources.ts',{'swr':{mutate:async(...args)=>seeded.push(args)},'./api-client':{apiClient:{get:()=>{networkCalls++;return new Promise(r=>finish=r);}}},'../lib/module-entry-core':core,'../lib/reading-system-cache':readingCache,'../lib/flashcard-system-cache':flashcardCache,'../lib/listening-system-cache':cache});
const prepared=service.prepareModuleEntry('/reading/materials','A');const opened=service.fetchModuleEntry('/reading/materials','A');await Promise.resolve();assert.equal(networkCalls,1);finish({data:['A']});await Promise.all([prepared,opened]);assert.equal(seeded.length,1);
const cancelledPrep=service.prepareModuleEntry('/reading/materials','A');await Promise.resolve();service.clearModuleEntryRequests();finish({data:['late A']});await assert.rejects(cancelledPrep);assert.equal(seeded.length,1);
assert.ok(read('hooks/useModuleEntryResource.ts').includes('keepPreviousData: false'));
assert.ok(!read('app/listening/page.tsx').includes('getActiveListeningUser()'));
assert.ok(read('app/listening/page.tsx').includes('fetchModuleEntry<T>(path, String(scope))'));
assert.ok(read('components/dashboard/DashboardBento.tsx').includes('READING_ENTRY_PATH'));
assert.ok(read('components/features/reading/ReadingDashboard.tsx').includes('useReadingCatalog'));
assert.ok(read('hooks/useReadingCatalog.ts').includes('READING_ENTRY_PATH'));
assert.ok(read('components/dashboard/DashboardBento.tsx').includes('LISTENING_MATERIALS_ENTRY_PATH'));
assert.ok(!read('app/speaking/page.tsx').includes('useModuleEntryResource<ListeningMaterialSummary[]>(LISTENING_MATERIALS_ENTRY_PATH)'));
assert.ok(read('app/speaking/page.tsx').includes('ShadowingLibrarySection') && read('app/speaking/page.tsx').includes('useSpeakingHubEntry'));
const writing=read('components/features/writing/WritingModule.tsx');assert.ok(!writing.includes('capsAndProfile'));assert.ok(writing.indexOf('useModuleEntryResource(TRANSLATION_CATALOG_PATH')<writing.indexOf('if (authStatus'));assert.ok(writing.includes('!capabilities || !capabilities.enabled'));
console.log('Module entry behavior: PASS (dedupe, cancellation, bounded preparation, SYSTEM validation/TTL/storage denial, actual logout isolation, late prefetch suppression, shared resources, Writing dependencies).');

// Render the real Writing entry component under enabled/disabled/error/unknown gates.
let caps, capsError, calls=[];
const child=()=>React.createElement('span',null,'translation-feature');
const boundary=({children})=>children;
const resources={WRITING_CAPABILITIES_PATH:'/writing/capabilities',WRITING_PROFILE_PATH:'/writing/profile',TRANSLATION_CATALOG_PATH:'/writing/translation/catalog'};
const writingComponent=evaluate('components/features/writing/WritingModule.tsx',{
 'react':React,'next/navigation':{useSearchParams:()=>new URLSearchParams(),useRouter:()=>({push(){}})},
 'next-auth/react':{useSession:()=>({status:'authenticated',data:{user:{id:'1'}}})},
 '@/hooks/useModuleEntryResource':{useModuleEntryResource:path=>{calls.push(path);return path===resources.WRITING_CAPABILITIES_PATH?{data:caps,error:capsError}:{isLoading:true};}},
 '@/services/moduleEntryResources':resources,'@/lib/writing/route-state':{parseWritingRouteState:()=>({view:'translation'}),buildWritingUrl:()=>''},
 './WritingStudioHeader':{WritingStudioHeader:()=>React.createElement('header',null,'Writing shell')},
 './translation/TranslationPractice':{TranslationPractice:child}, './sentence-lab/SentenceLab':{SentenceLab:child},'./coach/WritingCoach':{WritingCoach:child},'./portfolio/Portfolio':{Portfolio:child},
 './shared/WritingErrorBoundary':{WritingErrorBoundary:boundary},'./sentence-lab/SentenceLabErrorBoundary':{SentenceLabErrorBoundary:boundary},
 './glass/WritingGlass':{WritingStudio:boundary,StudioLoading:()=>null,StatePanel:()=>null,glass:{}},
 'lucide-react':{ShieldAlert:()=>null,Loader2:()=>null},'@/context/LanguageContext':{useLanguage:()=>({locale:'en',t:{loadingWritingStudio:'Loading capabilities',writingMaintenanceDesc:'Maintenance'}})},
});
for(const gate of [undefined,{enabled:false},{enabled:true}]){
 caps=gate;capsError=undefined;calls=[];const html=renderToString(React.createElement(writingComponent.WritingModule));
 assert.ok(html.includes('Writing shell'));assert.equal(html.includes('translation-feature'),gate?.enabled===true);
 assert.deepEqual(calls,[resources.WRITING_CAPABILITIES_PATH,resources.WRITING_PROFILE_PATH,resources.TRANSLATION_CATALOG_PATH]);
}
caps=undefined;capsError=Error('unavailable');assert.ok(!renderToString(React.createElement(writingComponent.WritingModule)).includes('translation-feature'));
console.log('Writing actual component render: PASS (immediate shell; independent reads; disabled, unknown and error gates fail closed; slow profile does not block enabled catalog).');
