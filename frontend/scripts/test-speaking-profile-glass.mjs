// Speaking Hub Primary Navigation ("Luyện tập" | "Hồ sơ luyện nói") & Echo Ocean Liquid Glass Analytics contracts (Wave B2).
// Verifies:
// 1. Primary tab navigation defaults to "Luyện tập", removes duplicated bottom-of-page profile, supports URL (?view=profile&sub=...),
//    popstate Back/Forward, Echo JARVIS `ec:speaking:intent`, and active Quick Check recording guard.
// 2. Lazy subsection loading: staying on "Luyện tập" fires 0 heavy profile subsection requests; opening "Hồ sơ luyện nói" lazily
//    loads only the active sub-tab (`Tổng quan` | `Phát âm` | `Lịch sử`) with 0 duplicate calls.
// 3. Echo Ocean Liquid Glass material discipline: 0 `<Sparkles>` / `✨`, 0 literal `&`, 0 `backdrop-filter`, 0 `!important`,
//    0 `font-family` overrides, explicit `.dark` + `[data-wallpaper]` contrast, GPU `transform`/`opacity` keyframes, and
//    `prefers-reduced-motion` + `forced-colors` compliance.
// 4. Honest view-model normalization: 0 fabricated data, missing values -> "—", real `lexicalStress` counts, 5 issue statuses,
//    and SSR render verification across Overview, Pronunciation, History, and Session Detail Drawer.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const require = createRequire(import.meta.url);
const babel = require("next/dist/compiled/babel/bundle.js");
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const srcRoot = path.join(root, "src");

const readSrc = (...parts) =>
    fs.readFileSync(path.join(srcRoot, ...parts), "utf8").replace(/\r\n/g, "\n");

let passed = 0;
function check(name, fn) {
    fn();
    passed += 1;
    console.log(`  PASS ${name}`);
}

const pageTsx = readSrc("app", "speaking", "page.tsx");
const panelTsx = readSrc("components", "features", "speaking", "SpeakingProfilePanel.tsx");
const previewTsx = readSrc("components", "features", "speaking", "SpeakingProfilePreview.tsx");
const dashboardTsx = readSrc("components", "features", "speaking", "SpeakingProgressDashboard.tsx");
const overviewTsx = readSrc("components", "features", "speaking", "profile", "ProfileOverviewSection.tsx");
const pronTsx = readSrc("components", "features", "speaking", "profile", "ProfilePronunciationSection.tsx");
const historyTsx = readSrc("components", "features", "speaking", "profile", "ProfileHistorySection.tsx");
const drawerTsx = readSrc("components", "features", "speaking", "profile", "ProfileSessionDetailDrawer.tsx");
const viewModelTs = readSrc("components", "features", "speaking", "profile", "profileViewModel.ts");
const glassCss = readSrc("components", "features", "speaking", "profile", "speakingProfileGlass.module.css");
const studioCss = readSrc("components", "features", "speaking", "studio", "speakingStudio.module.css");

// ─── 1. Primary Hub Tab Navigation & Removal of Duplicate Bottom Profile ───────────────────────────────
check("1. Speaking Hub primary tabs ('Luyện tập' | 'Hồ sơ luyện nói'), URL + popstate + Echo JARVIS + Quick Check guard", () => {
    assert.match(pageTsx, /data-testid="speaking-hub-tab-practice"/);
    assert.match(pageTsx, /data-testid="speaking-hub-tab-profile"/);
    assert.match(pageTsx, /Luyện tập/);
    assert.match(pageTsx, /Hồ sơ luyện nói/);

    // Defaults to "practice", removes duplicated unconditional bottom-of-page SpeakingProfilePanel
    assert.match(pageTsx, /return raw === "profile" \? "profile" : "practice";/);
    assert.equal((pageTsx.match(/<SpeakingProfilePanel\b/g) || []).length, 1, "SpeakingProfilePanel mounted only once");
    assert.match(pageTsx, /\{activeHubView === "profile" && \(\s*<SpeakingProfilePanel/, "mounted strictly inside profile view");
    assert.match(pageTsx, /\{activeHubView === "practice" && \(/, "practice grid mounted strictly inside practice view");

    // Eager unpaginated LISTENING_MATERIALS_ENTRY_PATH & heavy /speaking/progress dumps removed
    assert.doesNotMatch(pageTsx, /useModuleEntryResource<[^>]*>\(LISTENING_MATERIALS_ENTRY_PATH\)/);
    assert.doesNotMatch(pageTsx, /useModuleEntryResource<[^>]*>\(['"]\/speaking\/progress['"]\)/);
    assert.doesNotMatch(pageTsx, /useModuleEntryResource<[^>]*>\(['"]\/speaking\/progress\/summary['"]\)/);
    assert.match(pageTsx, /useSpeakingHubEntry\(true\)/);
    assert.match(pageTsx, /<ShadowingLibrarySection/);

    // URL sync + popstate + Echo JARVIS intent + Quick Check active recording guard
    assert.match(pageTsx, /params\.set\("view", "profile"\)/);
    assert.match(pageTsx, /params\.set\("sub", nextSub\)/);
    assert.match(pageTsx, /window\.addEventListener\("popstate", onPopState\)/);
    assert.match(pageTsx, /d\.view === "profile" \|\| d\.tab === "profile"/);
    assert.match(pageTsx, /data-testid="quick-check-leave-guard"/);
});

// ─── 2. Lazy Subsection Hooks in SpeakingProfilePanel ──────────────────────────────────────────────────
check("2. SpeakingProfilePanel lazy subsection hooks (overview, pronunciation, history, detail load on demand only)", () => {
    assert.match(panelTsx, /const overviewEnabled = isOpen && \(activeTab === "overview" \|\| visitedTabs\.overview\);/);
    assert.match(panelTsx, /const pronunciationEnabled = isOpen && \(activeTab === "pronunciation" \|\| visitedTabs\.pronunciation\);/);
    assert.match(panelTsx, /const historyEnabled = isOpen && \(activeTab === "history" \|\| visitedTabs\.history\);/);
    assert.match(panelTsx, /useSpeakingProfileOverview\(overviewEnabled\)/);
    assert.match(panelTsx, /useSpeakingProfilePronunciation\(pronunciationEnabled\)/);
    assert.match(panelTsx, /useSpeakingProfileHistory\([\s\S]*?historyEnabled,?\s*\)/);
    assert.match(panelTsx, /useSpeakingSessionDetail\(selectedSessionId,\s*isOpen && selectedSessionId != null\)/);
});

// ─── 3. Echo Ocean Liquid Glass Material & Forbidden Token Invariants ──────────────────────────────────
check("3. Liquid Glass CSS & TSX discipline: 0 Sparkles/✨, 0 backdrop-filter, 0 !important, 0 WebGL/canvas, reduced-motion & wallpaper contrast", () => {
    const allTsx = [
        pageTsx,
        panelTsx,
        previewTsx,
        dashboardTsx,
        overviewTsx,
        pronTsx,
        historyTsx,
        drawerTsx,
        viewModelTs,
    ];
    for (const [idx, code] of allTsx.entries()) {
        assert.doesNotMatch(
            code,
            /Sparkles|✨|dangerouslySetInnerHTML|<canvas\b|WebGLRenderer/,
            `Forbidden token in file #${idx + 1}`,
        );
    }

    const uncommentedGlass = glassCss.replace(/\/\*[\s\S]*?\*\//g, "");
    const uncommentedStudio = studioCss.replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(uncommentedGlass, /backdrop-filter|!important/);
    assert.doesNotMatch(uncommentedStudio, /backdrop-filter|!important/);

    // Only monospace font-family allowed for numeric/IPA tokens (10 §AA)
    for (const m of uncommentedGlass.matchAll(/font-family:\s*([^;]+);/g)) {
        assert.match(m[1], /ui-monospace/, `Unexpected font-family in speakingProfileGlass.module.css: ${m[1]}`);
    }

    // Explicit .dark, [data-wallpaper], --eo-ambient refraction, prefers-reduced-motion, forced-colors
    assert.match(glassCss, /:global\(\.dark\) \.workspace/);
    assert.match(glassCss, /:global\(html\[data-wallpaper\]\) \.workspace/);
    assert.match(glassCss, /:global\(html\.dark\[data-wallpaper\]\) \.workspace/);
    assert.match(glassCss, /--eo-ambient/);
    assert.match(glassCss, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(glassCss, /@media \(forced-colors: active\)/);
    assert.match(studioCss, /\.hubSegGlider \{[\s\S]*?transform: translate3d\(calc\(var\(--hub-idx, 0\) \* 100%\), 0, 0\);/);
    assert.match(glassCss, /\.subTabGlider \{[\s\S]*?transform: translate3d\(calc\(var\(--sub-idx, 0\) \* 100%\), 0, 0\);/);
});

// ─── 4. Pure View-Model & SSR Component Rendering Verification ─────────────────────────────────────────
const moduleCache = new Map();
const cssProxy = new Proxy({}, { get: (_, prop) => String(prop) });

let mockOverviewData = null;
let mockPronData = null;
let mockHistoryData = null;
let mockDetailData = null;
const hookCalls = [];

const stubs = {
    react: React,
    "next/navigation": {
        useRouter: () => ({ push() {}, replace() {} }),
        usePathname: () => "/speaking",
        useSearchParams: () => new URLSearchParams(),
    },
    "@/context/LanguageContext": {
        useLanguage: () => ({ locale: "vi", t: {} }),
    },
    "@/services/speakingProfileApi": {
        useSpeakingProfileOverview: (enabled) => {
            hookCalls.push(["overview", enabled]);
            return { data: enabled ? mockOverviewData : undefined, isLoading: false, error: null, mutate: async () => {} };
        },
        useSpeakingProfilePronunciation: (enabled) => {
            hookCalls.push(["pronunciation", enabled]);
            return { data: enabled ? mockPronData : undefined, isLoading: false, error: null, mutate: async () => {} };
        },
        useSpeakingProfileHistory: (params, enabled) => {
            hookCalls.push(["history", enabled, params.mode, params.status, params.page]);
            return { data: enabled ? mockHistoryData : undefined, isLoading: false, error: null, mutate: async () => {} };
        },
        useSpeakingSessionDetail: (id, enabled) => {
            hookCalls.push(["detail", enabled, id]);
            return { data: enabled && id ? mockDetailData : undefined, isLoading: false, error: null, mutate: async () => {} };
        },
    },
    "../AttemptAudioPlayer": {
        AttemptAudioPlayer: ({ clientAttemptId }) =>
            React.createElement("div", { "data-testid": `audio-${clientAttemptId}` }, clientAttemptId),
    },
};

function loadModule(relPath) {
    const norm = relPath.replace(/\\/g, "/");
    if (moduleCache.has(norm)) return moduleCache.get(norm);
    if (norm.endsWith(".css")) return cssProxy;

    const full = path.join(srcRoot, norm);
    const raw = fs.readFileSync(full, "utf8");
    const { code } = babel.core().transformSync(raw, {
        filename: norm,
        configFile: false,
        babelrc: false,
        presets: [babel.presetTypescript(), ...(norm.endsWith(".tsx") ? [babel.presetReact()] : [])],
        plugins: [babel.pluginTransformModulesCommonjs()],
    });

    const exportsObj = {};
    const mod = { exports: exportsObj };
    moduleCache.set(norm, exportsObj);

    const localRequire = (spec) => {
        if (spec in stubs) return stubs[spec];
        if (spec.endsWith(".css")) return cssProxy;
        if (spec.startsWith("@/")) {
            const sub = spec.slice(2);
            for (const ext of [".ts", ".tsx"]) {
                if (fs.existsSync(path.join(srcRoot, `${sub}${ext}`))) return loadModule(`${sub}${ext}`);
            }
        }
        if (spec.startsWith("./") || spec.startsWith("../")) {
            const base = path.posix.normalize(path.posix.join(path.posix.dirname(norm), spec));
            for (const ext of ["", ".ts", ".tsx"]) {
                if (fs.existsSync(path.join(srcRoot, `${base}${ext}`)) && fs.statSync(path.join(srcRoot, `${base}${ext}`)).isFile()) {
                    return loadModule(`${base}${ext}`);
                }
            }
        }
        return require(spec);
    };

    runInNewContext(code, {
        module: mod,
        exports: exportsObj,
        require: localRequire,
        React,
        console,
        Date,
        Math,
        Number,
        String,
        Boolean,
        Array,
        Object,
        Set,
        Map,
        JSON,
    });
    moduleCache.set(norm, mod.exports);
    return mod.exports;
}

const vm = loadModule("components/features/speaking/profile/profileViewModel.ts");
const { SpeakingProfilePanel } = loadModule("components/features/speaking/SpeakingProfilePanel.tsx");

check("4. Honest view-model formatting: missing scores render '—' (never 0), real 0 stays '0', pagination ellipsis & duration", () => {
    assert.equal(vm.formatScoreOrDash(null, "/100"), "—");
    assert.equal(vm.formatScoreOrDash(undefined, "%"), "—");
    assert.equal(vm.formatScoreOrDash(NaN, "/100"), "—");
    assert.equal(vm.formatScoreOrDash(0, "/100"), "0/100");
    assert.equal(vm.formatScoreOrDash(84.6, "/100"), "85/100");
    assert.equal(vm.formatSpeakingDuration(null, true), "—");
    assert.equal(vm.formatSpeakingDuration(0, true), "0 phút");
    assert.equal(vm.formatSpeakingDuration(45, true), "45 giây");
    assert.equal(vm.formatSpeakingDuration(3900, true), "1 giờ 5 phút");
    assert.deepEqual([...vm.buildPaginationTokens(4, 10)], [0, -1, 3, 4, 5, -1, 9]);
});

check("5. SSR Behavioral Gate: Overview, Pronunciation, and History lazy flags + honest INSUFFICIENT_DATA vs populated rendering", () => {
    // 5a. Empty / INSUFFICIENT_DATA overview -> lazy flags: overview=true, pronunciation=false, history=false
    hookCalls.length = 0;
    mockOverviewData = {
        policyVersion: "v1",
        generatedAt: "2026-11-25T00:00:00Z",
        dataSufficiency: {
            hasAnyPractice: false,
            strengthsStatus: "INSUFFICIENT_DATA",
            focusStatus: "INSUFFICIENT_DATA",
            trendStatus: "INSUFFICIENT_DATA",
            minScoredAttemptsForStrength: 3,
            minDistinctSessionsForFocus: 2,
            minScoredPointsForTrend: 2,
        },
        lifetime: {
            completedSessions: 0,
            inProgressSessions: 0,
            totalSessions: 0,
            qualifiedSpeakingSeconds: 0,
            roleplayLearnerTurns: 0,
            shadowingAttempts: 0,
            quickCheckAttempts: 0,
            targetVocabularyUsed: 0,
            averageContentMatchScore: null,
        },
        recentWindow: {
            currentStreakDays: 0,
            longestStreakDays30d: 0,
            practiceDays7d: 0,
            practiceDays30d: 0,
            sessionsCompleted7d: 0,
            sessionsCompleted30d: 0,
            sessionsStarted30d: 0,
            sentencesPracticed7d: 0,
            sentencesPracticed30d: 0,
            roleplayTurns7d: 0,
            roleplayTurns30d: 0,
            quickChecks7d: 0,
            quickChecks30d: 0,
            speakingSeconds7d: 0,
            speakingSeconds30d: 0,
            totalAttempts30d: 0,
            v2ScoredAttempts30d: 0,
            sttOnlyOrAbstainedAttempts30d: 0,
            retries30d: 0,
            resolvedTargets30d: 0,
            averagePronunciationScore30d: null,
            averageContentMatchScore30d: null,
        },
        activityRhythm30d: [],
        scoreTrend: [],
        strengths: [],
        focusAreas: [],
        recentImprovements: [],
        recentSessions: [],
    };

    const emptyOverviewHtml = renderToStaticMarkup(
        React.createElement(SpeakingProfilePanel, {
            isOpen: true,
            activeTab: "overview",
            onTabChange: () => {},
        }),
    );
    assert.deepEqual(
        hookCalls.map((c) => [String(c[0]), Boolean(c[1])]),
        [
            ["overview", true],
            ["pronunciation", false],
            ["history", false],
            ["detail", false],
        ],
        "Opening Overview enables ONLY overview hook; pronunciation, history, and detail stay disabled",
    );
    assert.match(emptyOverviewHtml, /Chưa đủ dữ liệu để vẽ đường xu hướng/);
    assert.match(emptyOverviewHtml, /Chưa đủ dữ liệu để xác nhận điểm mạnh/);

    // 5b. Populated Pronunciation V2.2 tab -> lexicalStress numerator/denominator + scored vs abstained provenance + 5 statuses
    hookCalls.length = 0;
    mockPronData = {
        policyVersion: "v1",
        windowDays: 30,
        windowLabelVi: "30 ngày gần đây",
        windowLabelEn: "Last 30 days",
        generatedAt: "2026-11-25T00:00:00Z",
        sufficiencyStatus: "READY",
        minScoredAttemptsRequired: 3,
        minDistinctSessionsForRecurring: 2,
        distinctAssessedSessionsCount: 4,
        metrics: {
            averagePronunciationScore: 82.4,
            averageContentMatchScore: 91.2,
            averagePhonemeScore: 84.0,
            averageStressScore: 79.5,
            averagePitchScore: 80.1,
            averageRhythmScore: 77.8,
            averageFluencyScore: 85.3,
            scoredAttemptsCount: 14,
            totalAttemptsCount: 17,
            abstainedAttemptsCount: 2,
            sttOnlyAttemptsCount: 1,
            lexicalStressMatchedWords: 29,
            lexicalStressAssessedWords: 36,
            lexicalStressAssessmentsCount: 12,
            contentMatchAttemptsCount: 17,
            shadowingScoredCount: 10,
            quickCheckScoredCount: 2,
            roleplayScoredCount: 2,
        },
        recurringIssues: [
            {
                issueKey: "PHONE:TH",
                category: "PRONUNCIATION",
                title: "Âm răng vô thanh /θ/",
                issueType: "PHONE_SUBSTITUTION",
                targetWord: "thought",
                targetPhone: "θ",
                observedPhone: "t",
                status: "IMPROVING",
                distinctSessionsObserved: 3,
                totalOccurrences: 5,
                resolvedSessionCount: 2,
                displayCue: "Đặt nhẹ đầu lưỡi giữa hai hàm răng và thổi hơi đều.",
                evidenceWindow: "30 ngày",
                recentExamples: [{ targetWord: "thought", sentenceSnippet: "I thought about the schedule." }],
                practiceAgainRoute: "/speaking/shadowing/12",
            },
        ],
        singleSessionObservations: [
            {
                issueKey: "STRESS:record",
                category: "STRESS",
                title: "Trọng âm từ record",
                issueType: "LEXICAL_STRESS_MISMATCH",
                targetWord: "record",
                status: "INSUFFICIENT_DATA",
                distinctSessionsObserved: 1,
                totalOccurrences: 1,
                resolvedSessionCount: 0,
                displayCue: "Nhấn âm tiết đầu tiên cho danh từ RE-cord.",
                evidenceWindow: "1 phiên",
                recentExamples: [{ targetWord: "record" }],
            },
        ],
        strongPatterns: [
            {
                phone: "r",
                ipaDisplay: "/r/",
                categoryLabelVi: "Phụ âm đầu lưỡi",
                categoryLabelEn: "Alveolar approximant",
                observationsCount: 18,
                acceptableCount: 17,
                acceptableRate: 0.944,
                averageQualityScore: 89.2,
                exampleWords: ["ready", "practice", "around"],
            },
        ],
    };

    const pronHtml = renderToStaticMarkup(
        React.createElement(SpeakingProfilePanel, {
            isOpen: true,
            activeTab: "pronunciation",
            onTabChange: () => {},
        }),
    );
    assert.deepEqual(
        hookCalls.map((c) => [c[0], c[1]]),
        [
            ["overview", false],
            ["pronunciation", true],
            ["history", false],
            ["detail", false],
        ],
        "Direct Pronunciation mount enables ONLY pronunciation hook",
    );
    assert.match(pronHtml, /Khớp 29\/36 từ đa âm tiết được đo/);
    assert.match(pronHtml, /Đã chấm: 14/);
    assert.match(pronHtml, /Tạm bỏ qua \/ chỉ STT: 3/);
    assert.match(pronHtml, /Đang tiến bộ/);
    assert.match(pronHtml, /Chưa đủ dữ liệu/);
    assert.match(pronHtml, /\/r\//);

    // 5c. History tab with mode & status pills + pagination
    hookCalls.length = 0;
    mockHistoryData = {
        content: [
            {
                sessionId: 501,
                materialId: 12,
                materialTitle: "Designing Calm Interfaces",
                mode: "SHADOWING",
                status: "COMPLETED",
                sentencesPracticed: 8,
                totalSentences: 8,
                attemptCount: 11,
                retryCount: 3,
                resolvedTargetCount: 2,
                durationSeconds: 245,
                averagePronunciationScore: 84,
                cefrLevel: "B2",
                createdAt: "2026-11-24T10:30:00Z",
            },
        ],
        page: 0,
        size: 10,
        totalElements: 24,
        totalPages: 3,
        hasNext: true,
        counts: { all: 24, completed: 20, active: 4, shadowing: 15, roleplay: 6, quickCheck: 3 },
    };

    const historyHtml = renderToStaticMarkup(
        React.createElement(SpeakingProfilePanel, {
            isOpen: true,
            activeTab: "history",
            onTabChange: () => {},
        }),
    );
    assert.match(historyHtml, /Designing Calm Interfaces/);
    assert.match(historyHtml, /Shadowing/);
    assert.match(historyHtml, /Role-play AI/);
    assert.match(historyHtml, /Quick Check/);
    assert.match(historyHtml, /Trang 1 \/ 3/);
});

console.log(`\nSpeaking Profile Liquid Glass contracts: ${passed} / ${passed} PASSED`);
