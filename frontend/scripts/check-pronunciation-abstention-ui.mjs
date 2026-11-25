import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const panel = readFileSync(
  new URL("../src/components/features/speaking/EcsmFeedbackPanel.tsx", import.meta.url),
  "utf8",
);

assert.match(panel, /observed_phone_trusted\s*===\s*true/);
assert.match(panel, /observedPhoneTrusted\s*===\s*true/);
assert.match(panel, /observedPhone\s*&&\s*observedPhoneTrusted/);
assert.match(panel, /Âm \/\{expectedPhone\}\/ bạn vừa nói cần luyện tập thêm\./);
assert.doesNotMatch(panel, /observedPhone\s*\?\s*`/);

console.log("pronunciation abstention UI contract: 5 passed, 0 failed, 0 skipped");
