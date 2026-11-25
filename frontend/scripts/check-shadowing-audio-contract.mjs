import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(path.join(root, relative), 'utf8').replace(/\r\n/g, '\n');
const recorder = read('src/hooks/useAudioRecorder.ts');
const api = read('src/services/speakingApi.ts');
const page = read('src/app/speaking/shadowing/[id]/page.tsx');
const panel = read('src/components/features/speaking/EcsmFeedbackPanel.tsx');
const navigator = read('src/components/features/speaking/SentenceNavigator.tsx');

const checks = {
  capabilityBasedMimeSelection: recorder.includes('MediaRecorder.isTypeSupported(candidate)'),
  blobUsesRecorderMime: recorder.includes('recorder.mimeType || selectedMime'),
  webmNeverNamedWav: api.includes("if (normalized.includes('webm')) return `${stem}.webm`"),
  rawCodecCodeHidden: !panel.includes("(errorMessage || 'Không thể hoàn tất"),
  retryClearsError: page.includes('const handleRetry = () => {\n        clearCurrentAttemptState();'),
  nextSentenceClearsError: page.includes('handleSelectUnit(currentIndex + 1)'),
  freshRecordingClearsError: page.includes('setEcsmResult(null);'),
  sidebarLabelsTextMatch: navigator.includes('Khớp {acc}%')
    && navigator.includes('const acc = Math.round(bestAccuracy)')
    && !navigator.includes('bandLabel'),
};

for (const [name, passed] of Object.entries(checks)) {
  console.log(`${name}: ${passed ? 'PASS' : 'FAIL'}`);
}
if (Object.values(checks).some((passed) => !passed)) process.exit(1);
