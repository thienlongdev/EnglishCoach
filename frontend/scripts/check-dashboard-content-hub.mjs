import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const hubPath = path.resolve(__dirname, "../src/components/dashboard/ContentDiscoveryHub.tsx");
const popoverPath = path.resolve(__dirname, "../src/components/dashboard/WordLookupPopover.tsx");

console.log("=== Checking Dashboard Content Hub UI & Daily Vocab Contracts ===");

const hubContent = fs.readFileSync(hubPath, "utf-8");
const popoverContent = fs.readFileSync(popoverPath, "utf-8");

// 1. Reading card CTA
assert(
  !hubContent.includes("Đọc & Tra từ 1-chạm"),
  "FAIL: Old long marketing-style CTA 'Đọc & Tra từ 1-chạm' should be removed"
);
assert(
  hubContent.includes('locale === "vi" ? "Đọc bài" : "Read article"'),
  "FAIL: New short CTA 'Đọc bài' / 'Read article' must be present"
);
console.log("✔ 1. Reading card CTA cleaned up to 'Đọc bài'");

// 2. Reading modal cleanup: word count / reading time removed
assert(
  !hubContent.includes("detail.wordCount"),
  "FAIL: Word count / reading time text should be removed from reading modal"
);
console.log("✔ 2. Word count and reading time removed from reading modal");

// 3. Reading modal cleanup: small duplicate 'Bài gốc' link removed
assert(
  !hubContent.includes('<span>{locale === "vi" ? "Bài gốc" : "Source"}</span>'),
  "FAIL: Redundant small 'Bài gốc' link near save controls must be removed"
);
console.log("✔ 3. Duplicate small 'Bài gốc' link near save controls removed");

// 4. Reading modal cleanup: close button moved to top-right
assert(
  hubContent.includes('id="btn-close-reading-modal"\n          onClick={onClose}\n          className="absolute top-4 right-4 z-20') ||
  hubContent.includes('id="btn-close-reading-modal"') && hubContent.includes('absolute top-4 right-4 z-20'),
  "FAIL: Close X button must be positioned at top-right corner of the modal"
);
console.log("✔ 4. Close 'X' button moved to top-right corner");

// 5. Reading library save button: duplicate iconography removed
assert(
  !hubContent.includes("📥 Lưu vào Thư viện Đọc"),
  "FAIL: Duplicate 📥 emoji must be removed from 'Lưu vào Thư viện Đọc' button"
);
assert(
  hubContent.includes('locale === "vi" ? "Lưu vào Thư viện Đọc" : "Save to Reading Library"'),
  "FAIL: Clean text 'Lưu vào Thư viện Đọc' must be kept"
);
console.log("✔ 5. Duplicate icon removed from 'Lưu vào Thư viện Đọc' button");

// 6. Flashcard save UI: no '+' sign
assert(
  !hubContent.includes("+ Lưu Flashcard"),
  "FAIL: '+' sign must be removed from 'Lưu Flashcard' in ContentDiscoveryHub"
);
assert(
  !popoverContent.includes("+ Lưu Flashcard"),
  "FAIL: '+' sign must be removed from 'Lưu Flashcard' in WordLookupPopover"
);
assert(
  hubContent.includes('locale === "vi" ? "Lưu Flashcard" : "Save Card"') ||
  hubContent.includes('locale === "vi" ? "Lưu Flashcard" : "Save Flashcard"'),
  "FAIL: Clean 'Lưu Flashcard' button must be present in ContentDiscoveryHub"
);
console.log("✔ 6. Unnecessary '+' sign removed from all 'Lưu Flashcard' actions");

// 7. Daily vocab section title cleanup: subtitle removed
assert(
  !hubContent.includes("Các từ ngữ hiện đại thường gặp trên mạng xã hội, công sở và đời sống quốc tế"),
  "FAIL: Subtitle 'Các từ ngữ hiện đại thường gặp trên mạng xã hội...' must be removed"
);
console.log("✔ 7. Daily vocab subtitle removed, header aligned");

// 8. Daily rotation at 00:00 Asia/Ho_Chi_Minh & frontend cache key
assert(
  hubContent.includes("Asia/Ho_Chi_Minh"),
  "FAIL: Vietnam timezone 'Asia/Ho_Chi_Minh' must be used for daily date key"
);
assert(
  hubContent.includes("useSystemContentCards<TrendingVocabularyItem[] | null>(`/content/vocabulary/daily?date=${dailyDateKey}`)"),
  "FAIL: SYSTEM vocabulary partition must include the daily date"
);
assert(
  hubContent.includes("/content/vocabulary/daily?date="),
  "FAIL: Frontend must request daily vocabulary endpoint with date param"
);
console.log("✔ 8. Daily rotation at 00:00 Asia/Ho_Chi_Minh and cache key verified");

// 9. No dashboard reload on flashcard save
assert(
  !hubContent.includes('key.includes("/dashboard")'),
  "FAIL: Saving flashcard must NOT invalidate the whole dashboard"
);
console.log("✔ 9. Isolated flashcard save without full dashboard reload verified");

// 10. Content pictures are the item's own (feed thumbnail, the video's poster) or a typographic fallback — never game art
for (const file of ["ContentDiscoveryHub.tsx", "DashboardBento.tsx", "DashboardHeroScene.tsx"]) {
  const src = fs.readFileSync(path.resolve(__dirname, "../src/components/dashboard", file), "utf-8");
  assert(!/\/games\/|key-art|GameArtworks/.test(src), `FAIL: ${file} must not use Games artwork for content`);
}
assert(hubContent.includes("styles.thumbFallback") && hubContent.includes("styles.mediaFallback"), "FAIL: missing-image fallbacks must stay");
console.log("✔ 10. Content thumbnails: own pictures or typographic fallback, no game artwork");

console.log("\n>>> ALL DASHBOARD CONTENT HUB CONTRACT TESTS PASSED! <<<");
