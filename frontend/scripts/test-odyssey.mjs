import assert from 'node:assert/strict';
import fs from 'node:fs';
import { launchHref, returnHref, safeDestination, saveContext, takeGateSnapshot, hasContext, clearContext, contextId, rememberWritingSession, withWritingResume } from '../src/lib/odyssey/navigation.ts';
import { ODYSSEY_GUIDES } from '../src/lib/guide/guides/odyssey.ts';
const id='12345678-1234-1234-1234-123456789abc';
const launch={requestId:id,stationId:'grammar:verb-be',regionId:'harbor',mode:'LEARN',taskId:null,topicSlug:'verb-be',checkId:null,createdAt:new Date().toISOString()};
for(const href of ['https://attacker.test','//attacker.test','javascript:alert(1)','/\\attacker.test','/admin','/api/auth/logout','/reading\n//attacker.test'])assert.equal(safeDestination(href),false,href);
for(const href of ['/reading?materialId=12','/listening/4/practice','/grammar/check/'+id,'/exams/ielts/tests/'+id+'?part=IELTS_READING_PASSAGE_1#practice'])assert.equal(safeDestination(href),true);
assert.equal(launchHref({launch,href:'/reading?materialId=12'}),`/reading?materialId=12&odyssey=${id}`);
assert.equal(launchHref({launch,href:'/exams/ielts/tests/'+id+'?part=IELTS_READING_PASSAGE_1#practice'}),`/exams/ielts/tests/${id}?part=IELTS_READING_PASSAGE_1&odyssey=${id}#practice`);
assert.equal(launchHref({launch:{...launch,requestId:'unsafe'},href:'/reading'}),null);
assert.equal(returnHref('//evil',null),'/learning-path?view=odyssey');
assert.equal(returnHref('harbor','../../private'),'/learning-path?view=odyssey&region=harbor');
assert.equal(new URL(returnHref('harbor',launch.stationId),'https://local.test').searchParams.get('station'),launch.stationId);
const values=new Map();globalThis.sessionStorage={setItem:(k,v)=>values.set(k,v),getItem:k=>values.get(k)||null,removeItem:k=>values.delete(k)};
saveContext('A',{launch,href:'/grammar/topics/verb-be'});
assert.equal(hasContext('A','/grammar/check/'+id),true);assert.equal(hasContext('B','/grammar/check/'+id),false);
assert.equal(hasContext('A','/reading'),false);assert.equal(contextId('A','/grammar'),id);clearContext('A');assert.equal(hasContext('A','/grammar'),false);
saveContext('A',{launch,href:'/grammar/topics/verb-be'},false,['grammar:verb-be']);
saveContext('A',{launch,href:'/grammar/topics/verb-be'}); // destination return bridge refreshes the same receipt
assert.deepEqual(takeGateSnapshot('B'),[],'Another account cannot consume a return comparison');
assert.deepEqual(takeGateSnapshot('A'),['grammar:verb-be'],'Snapshot survives the real module return bridge');
assert.deepEqual(takeGateSnapshot('A'),[],'A repeated refresh must not replay the reveal');
saveContext('A',{launch,href:'/grammar/topics/verb-be'},false,['grammar:verb-be']);
saveContext('A',{launch:{...launch,requestId:'22345678-1234-1234-1234-123456789abc'},href:'/grammar/topics/verb-be'});
assert.deepEqual(takeGateSnapshot('A'),[],'A different receipt cannot inherit old gates');
const writing={launch:{...launch,stationId:'task:12',topicSlug:null,taskId:12},href:'/writing?view=coach&taskId=gen-paragraph-01&start=draft'};
rememberWritingSession('A','task:12',id);assert.equal(withWritingResume('A',writing).href,`/writing?view=coach&sessionId=${id}`);
assert.equal(withWritingResume('B',writing).href,writing.href);rememberWritingSession('A','task:12','//evil');assert.equal(withWritingResume('A',writing).href,`/writing?view=coach&sessionId=${id}`);
const catalog=JSON.parse(fs.readFileSync(new URL('../../backend/src/main/resources/grammar/catalog.json',import.meta.url),'utf8'));
const topics=new Map(catalog.domains.flatMap(d=>d.topics.map(t=>[t.slug,t]))),seen=new Set(),stack=new Set();
function visit(id){assert.ok(topics.has(id),`missing ${id}`);assert.ok(!stack.has(id),`cycle ${id}`);if(seen.has(id))return;stack.add(id);for(const p of topics.get(id).prerequisites)visit(p);stack.delete(id);seen.add(id);}
for(const id of topics.keys())visit(id);assert.equal(seen.size,221);
for(const guide of ODYSSEY_GUIDES)for(const step of guide.steps){assert.ok(step.body.vi.split(/\s+/).length<=24,step.id);assert.ok(step.body.en);assert.ok(!/[&✨]/.test(step.body.vi+step.body.en));}
console.log('Odyssey: safe module/return routes, exact launch context, account isolation, 221-node acyclic source graph PASS');
