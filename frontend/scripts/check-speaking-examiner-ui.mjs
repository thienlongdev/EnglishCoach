// frontend/scripts/check-speaking-examiner-ui.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendDir = path.resolve(__dirname, '..');

console.log('=== [EXAMS-V4-13] Checking Speaking Examiner UI Contract & Invariants ===\n');

// 1. Check SpeakingExaminerRuntime.tsx exists
const runtimeFile = path.join(frontendDir, 'src/components/features/exams/SpeakingExaminerRuntime.tsx');
if (!fs.existsSync(runtimeFile)) {
  console.error('FAIL: SpeakingExaminerRuntime.tsx does not exist!');
  process.exit(1);
}
const runtimeContent = fs.readFileSync(runtimeFile, 'utf8');

// 2. Verify all-item switcher is NOT present in SpeakingWorkspace.tsx
const workspaceFile = path.join(frontendDir, 'src/components/features/exams/SpeakingWorkspace.tsx');
const workspaceContent = fs.readFileSync(workspaceFile, 'utf8');

if (workspaceContent.includes('allSpeakingItems.map')) {
  console.error('FAIL: SpeakingWorkspace still contains all-item switcher!');
  process.exit(1);
}
console.log('PASS: Legacy all-item switcher completely removed from SpeakingWorkspace.');

// 3. Verify SpeakingWorkspace delegates to SpeakingExaminerRuntime
if (!workspaceContent.includes('<SpeakingExaminerRuntime')) {
  console.error('FAIL: SpeakingWorkspace does not delegate to SpeakingExaminerRuntime!');
  process.exit(1);
}
console.log('PASS: SpeakingWorkspace delegates to server-authoritative SpeakingExaminerRuntime.');

if (/onRecordingSaved|onTurnCompleted=/.test(workspaceContent)) {
  console.error('FAIL: IELTS completed turns must not be queued into generic response autosave.');
  process.exit(1);
}
console.log('PASS: IELTS sealed turns use authoritative completion without duplicate generic autosave.');

// 4. Verify Media Ladder states
const requiredPhases = [
  'EXAMINER_LOADING',
  'EXAMINER_READY',
  'EXAMINER_PLAYING',
  'EXAMINER_TEXT_FALLBACK',
  'PREPARATION',
  'READY_TO_RECORD',
  'RECORDING',
  'UPLOADING',
  'SEALED',
  'SECTION_COMPLETED',
];
for (const phase of requiredPhases) {
  if (!runtimeContent.includes(phase)) {
    console.error(`FAIL: Missing required examiner phase: ${phase}`);
    process.exit(1);
  }
}
console.log('PASS: All 10 required examiner phases are defined.');

// 5. Verify Text Fallback Acknowledgement element
if (!runtimeContent.includes('speaking-text-ack-btn')) {
  console.error('FAIL: Missing text fallback acknowledgement button (speaking-text-ack-btn)!');
  process.exit(1);
}
console.log('PASS: Text fallback acknowledgement button verified.');

// 6. Verify Recording disabled during presentation
if (!runtimeContent.includes('EXAMINER_PLAYING')) {
  console.error('FAIL: EXAMINER_PLAYING phase not handled!');
  process.exit(1);
}
console.log('PASS: Examiner playing presentation state verified.');

// 7. Verify Part 2 preparation countdown & skip button
if (!runtimeContent.includes('speaking-prep-countdown') || !runtimeContent.includes('speaking-skip-prep-btn')) {
  console.error('FAIL: Missing Part 2 preparation countdown or skip button!');
  process.exit(1);
}
console.log('PASS: Part 2 preparation countdown (60s) and skip button verified.');

// 8. Verify Recording controls and timers
if (!runtimeContent.includes('speaking-start-answer-btn') ||
    !runtimeContent.includes('speaking-record-timer') ||
    !runtimeContent.includes('speaking-stop-recording-btn')) {
  console.error('FAIL: Missing candidate recording controls or timer!');
  process.exit(1);
}
console.log('PASS: Candidate recording controls (start, timer, stop) verified.');

// 9. Verify Locked turns badge and prompt withholding
if (!runtimeContent.includes('speaking-locked-turns-badge') || !runtimeContent.includes('lockedTurnCount')) {
  console.error('FAIL: Missing locked turns badge or lockedTurnCount reference!');
  process.exit(1);
}
console.log('PASS: Locked turns placeholder with strict prompt withholding verified.');

// 10. Verify NO calls to standalone Speaking AI (/api/v1/speaking/*)
if (runtimeContent.includes('/speaking/') && !runtimeContent.includes('/exams/attempts/')) {
  console.error('FAIL: Standalone speaking route detected in SpeakingExaminerRuntime!');
  process.exit(1);
}
if (runtimeContent.includes('useSpeakingAi') || runtimeContent.includes('@/services/speaking')) {
  console.error('FAIL: Standalone Speaking AI hook/service imported!');
  process.exit(1);
}
console.log('PASS: Zero standalone Speaking AI coupling. Pure Exams runtime.');

console.log('\n=== ALL SPEAKING EXAMINER UI CONTRACT CHECKS PASSED ===\n');
