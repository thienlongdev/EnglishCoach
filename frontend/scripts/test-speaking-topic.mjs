// "Nói theo chủ đề" contracts: drift-free timing model, IELTS formats, and the NO-AI / no-upload guarantees.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  buildPlan, canPause, elapsedMs, formatCountdown, formatElapsed, isDone, pauseClock, remainingMs, resumeClock,
  startClock, targetSeconds,
} from '../src/lib/speaking/topicClock.mjs';

const source = p => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');
const backend = p => readFileSync(new URL(`../../backend/src/main/java/com/englishcoach/speaking/topic/${p}`, import.meta.url), 'utf8');

// ── timing model ──────────────────────────────────────────────
{
  const c = startClock(60000, 1000);
  assert.equal(remainingMs(c, 1000), 60000);
  // a throttled tab that wakes up 45 s later sees exactly 45 s elapsed — no tick counting, no drift
  assert.equal(elapsedMs(c, 46000), 45000);
  const paused = pauseClock(c, 11000);           // 10 s spoken, then paused
  assert.equal(elapsedMs(paused, 500000), 10000); // time away never counts
  const resumed = resumeClock(paused, 41000);     // 30 s paused
  assert.equal(elapsedMs(resumed, 51000), 20000);
  assert.equal(isDone(resumed, 91000), true);
  assert.equal(remainingMs(resumed, 999999), 0);
  assert.equal(elapsedMs(resumed, 999999), 60000); // never more than the step
  assert.equal(formatCountdown(59001), '1:00');
  assert.equal(formatCountdown(1), '0:01');
  assert.equal(formatCountdown(0), '0:00');
  assert.equal(formatElapsed(59999), '0:59');
}
{
  const quick = buildPlan('QUICK', { quickSeconds: 30, readyCountdown: true }, 1);
  assert.deepEqual(quick.map(s => [s.kind, s.ms]), [['ready', 3000], ['speak', 30000]]);
  assert.equal(targetSeconds('QUICK', quick), 30);
  assert.deepEqual(buildPlan('QUICK', { quickSeconds: 60, readyCountdown: false }, 1).map(s => s.kind), ['speak']);

  const deep = buildPlan('DEEP', { deepPrepSeconds: 180, deepSpeakSeconds: 120 }, 1);
  assert.deepEqual(deep.map(s => [s.kind, s.ms]), [['prep', 180000], ['speak', 120000]]);
  assert.deepEqual(buildPlan('DEEP', { deepPrepSeconds: 0, deepSpeakSeconds: 60 }, 1).map(s => s.kind), ['speak']);

  // IELTS Part 2: exactly one minute of preparation, then one to two minutes of speaking
  const p2 = buildPlan('IELTS2', {}, 1);
  assert.deepEqual(p2.map(s => [s.kind, s.ms]), [['prep', 60000], ['speak', 120000]]);
  assert.equal(p2[1].minMs, 60000);
  assert.equal(targetSeconds('IELTS2', p2), 60);

  // Part 1 / Part 3 step through their linked questions, one timed answer each
  const p1 = buildPlan('IELTS1', { part1Seconds: 30 }, 4);
  assert.deepEqual(p1.map(s => s.question), [0, 1, 2, 3]);
  assert.equal(targetSeconds('IELTS1', p1), 120);
  assert.equal(buildPlan('IELTS3', { part3Seconds: 60 }, 5).length, 5);

  assert.equal(canPause('QUICK'), true);
  assert.equal(canPause('DEEP'), true);
  assert.equal(canPause('IELTS2'), false);
}

// ── no AI, no upload, no fake signal ─────────────────────────
const topicDir = 'components/features/speaking/topic';
const topicFiles = readdirSync(new URL(`../src/${topicDir}`, import.meta.url)).map(f => `${topicDir}/${f}`);
const frontendSources = [...topicFiles, 'services/speakingTopicApi.ts', 'lib/speaking/topicClock.mjs', 'types/speakingTopic.ts']
  .map(p => [p, source(p)]);
const FORBIDDEN = /speakingApi|\/speaking\/(analyze|quick-check|roleplay|tts|shadowing|v2|sessions)|ai-service|openrouter|echoCoach|coachApi|premium|Premium|voucher|SpeechRecognition|transcri|whisper|FormData|Sparkles|dangerouslySetInnerHTML|BrandWhaleIcon|Whale\.svg/;
// comments may explain what is absent ("no transcription"); only code is checked
const code = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
for (const [p, text] of frontendSources) {
  const hit = code(text).match(FORBIDDEN);
  assert.equal(hit, null, `${p} must not reach AI, Premium, transcription or upload paths (found "${hit?.[0]}")`);
}
const api = source('services/speakingTopicApi.ts');
for (const call of api.matchAll(/apiClient\.(get|post|put|delete)<?[^(]*\(\s*[`'"]([^`'"]+)/g)) {
  assert.match(call[2], /^\/speaking\/topics\//, `unexpected endpoint ${call[2]}`);
}
const recorder = source(`${topicDir}/useTopicRecorder.ts`);
assert.match(recorder, /getFloatTimeDomainData/, 'level meter must read the real signal');
assert.doesNotMatch(recorder, /Math\.random/, 'no fabricated waveform');
assert.match(recorder, /blob && blob\.size > 0 \? blob : null/, 'an empty recording is never reported as captured');
const studio = source(`${topicDir}/TopicSpeakingStudio.tsx`);
assert.match(studio, /visibilitychange/, 'leaving the tab interrupts the round');
assert.match(studio, /performance\.now\(\)/);
assert.doesNotMatch(studio, /setInterval\([^)]*remaining|seconds\s*-\s*1/, 'the countdown is never decremented by ticks');
assert.match(studio, /recordingRoundRef\.current = withRecording/, 'microphone opens only for a round the learner starts');

// ── integration inside Speaking ───────────────────────────────
const modes = source('components/features/speaking/SpeakingPracticeModes.tsx');
assert.match(modes, /"shadowing" \| "roleplay" \| "assessment" \| "topic"/);
assert.ok(modes.includes('className={styles.modeGrid} role="tablist"'), 'the four modes share one grid');
const studioCss = source('components/features/speaking/studio/speakingStudio.module.css');
assert.ok(studioCss.includes('@container spmodes (min-width: 520px) { .modeGrid { grid-template-columns: repeat(2,'), '2 × 2 while the column is narrow');
assert.ok(studioCss.includes('@container spmodes (min-width: 960px) { .modeGrid { grid-template-columns: repeat(4,'), 'one row of four when each card has room');
const page = source('app/speaking/page.tsx');
assert.match(page, /selectedPracticeMode === "topic" && <TopicSpeakingStudio \/>/);
assert.match(page, /dynamic\(\(\) => import\("@\/components\/features\/speaking\/topic\/TopicSpeakingStudio"\)/);
const labels = source('lib/exams/labels.ts');
assert.equal((labels.match(/topicSpeakingTitle:/g) ?? []).length, 2, 'vi + en labels');

// ── backend has no AI / Premium dependency ────────────────────
for (const f of ['TopicController.java', 'TopicService.java', 'TopicRepository.java', 'TopicBank.java', 'TopicSelector.java']) {
  const hit = code(backend(f)).match(/RequirePremiumAi|premium|AiService|RestTemplate|WebClient|RestClient|openrouter|aiServiceUrl/i);
  assert.equal(hit, null, `${f} must not call AI (found "${hit?.[0]}")`);
}

console.log('Speaking topic contracts: PASS');
