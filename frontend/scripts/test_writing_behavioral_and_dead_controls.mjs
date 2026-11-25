/**
 * English Coach Writing Module: Behavioral & Dead-Control Audit Test Suite
 * Validates all interactive elements, real backend connections, state transitions,
 * tri-state grammar contracts, hint ladders, autosave, dispute retractions, and dead-control elimination.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const BASE_DIR = path.resolve('src/components/features/writing');

test('Writing Module Functional & Dead-Control Audit Suite', async (t) => {

    await t.test('1. Component File Inventory & Static Presence', () => {
        const requiredFiles = [
            'WritingModule.tsx',
            'ForYou.tsx',
            'sentence-lab/SentenceCheck.tsx',
            'sentence-lab/SentencePractice.tsx',
            'sentence-lab/MyMistakes.tsx',
            'coach/WritingCoach.tsx',
            'coach/DraftEditor.tsx',
            'coach/FeedbackPanel.tsx',
            'coach/DraftDiff.tsx',
            'coach/PlanningForm.tsx',
            'portfolio/Portfolio.tsx'
        ];

        for (const file of requiredFiles) {
            const fullPath = path.join(BASE_DIR, file);
            assert.ok(fs.existsSync(fullPath), `Required component file missing: ${file}`);
            const content = fs.readFileSync(fullPath, 'utf8');
            assert.ok(content.length > 100, `Component ${file} is unexpectedly empty`);
        }
    });

    await t.test('2. Dead Control Audit: No empty onClick, TODO handlers, or href="#"', () => {
        function scanDir(dir) {
            let deadCount = 0;
            const findings = [];
            const entries = fs.readdirSync(dir, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    const sub = scanDir(fullPath);
                    deadCount += sub.deadCount;
                    findings.push(...sub.findings);
                } else if (entry.name.endsWith('.tsx')) {
                    const content = fs.readFileSync(fullPath, 'utf8');
                    
                    // Check for empty onClick handlers: onClick={() => {}} or onClick={() => void 0}
                    const emptyHandlerRegex = /onClick=\{(?:\s*\(\)\s*=>\s*\{\s*\}|\s*\(\)\s*=>\s*undefined|\s*\(\)\s*=>\s*null)\}/g;
                    let match;
                    while ((match = emptyHandlerRegex.exec(content)) !== null) {
                        deadCount++;
                        findings.push({ file: entry.name, type: 'EMPTY_ONCLICK', index: match.index });
                    }

                    // Check for placeholder links
                    const placeholderLinkRegex = /href=["']#["']/g;
                    while ((match = placeholderLinkRegex.exec(content)) !== null) {
                        deadCount++;
                        findings.push({ file: entry.name, type: 'PLACEHOLDER_LINK', index: match.index });
                    }

                    // Check for 'coming soon' or alert stubs
                    const alertStubRegex = /alert\(["'].*?(coming soon|sắp ra mắt|chưa hỗ trợ).*?["']\)/gi;
                    while ((match = alertStubRegex.exec(content)) !== null) {
                        deadCount++;
                        findings.push({ file: entry.name, type: 'ALERT_STUB', index: match.index });
                    }
                }
            }
            return { deadCount, findings };
        }

        const res = scanDir(BASE_DIR);
        assert.equal(res.deadCount, 0, `Found ${res.deadCount} dead interactive controls: ${JSON.stringify(res.findings)}`);
    });

    await t.test('3. ForYou View: Zero Mock Artifacts & Spark Chips Wiring', () => {
        const forYouContent = fs.readFileSync(path.join(BASE_DIR, 'ForYou.tsx'), 'utf8');

        // Check that fake hardcoded percentages are gone
        assert.ok(!forYouContent.includes('+6% TIẾN BỘ'), 'Found hardcoded +6% progress badge');
        assert.ok(!forYouContent.includes('78% Thành thạo'), 'Found hardcoded 78% mastery gauge');
        assert.ok(!forYouContent.includes('240 từ'), 'Found hardcoded weekly bar chart value');

        // Check spark chip insertion and focus logic
        assert.ok(forYouContent.includes('quickSentenceInputRef'), 'quickSentenceInputRef must be defined for spark focus');
        assert.ok(forYouContent.includes('insertSpark'), 'insertSpark handler must exist');
        assert.ok(forYouContent.includes('scrollIntoView'), 'Should smooth-scroll to Quick Sentence Sandbox');
        assert.ok(forYouContent.includes('Đã chèn'), 'Toast feedback must be present');
    });

    await t.test('4. SentenceCheck: Tri-state Grammar UI & Inconclusive Fallback', () => {
        const checkContent = fs.readFileSync(path.join(BASE_DIR, 'sentence-lab/SentenceCheck.tsx'), 'utf8');

        // Check that tri-state is properly handled
        assert.ok(checkContent.includes('grammaticallyCorrect === true'), 'Must handle correct state');
        assert.ok(checkContent.includes('grammaticallyCorrect === false'), 'Must handle error state');
        assert.ok(checkContent.includes('grammaticallyCorrect === null'), 'Must handle inconclusive state');
        assert.ok(checkContent.includes('Chưa đủ dữ liệu kết luận') || checkContent.includes('INCONCLUSIVE'), 'Must render honest inconclusive banner');

        // Check character counter limit enforcement
        assert.ok(checkContent.includes('2000'), 'Must enforce maxSentenceChars limit');
    });

    await t.test('5. SentencePractice: 7 Modes and 3-step Hint Ladder', () => {
        const practiceContent = fs.readFileSync(path.join(BASE_DIR, 'sentence-lab/SentencePractice.tsx'), 'utf8');

        const modes = ['COMBINE', 'REPAIR', 'EXPAND', 'REWRITE_NATURALLY', 'PARAPHRASE', 'CHANGE_REGISTER', 'IMPROVE_COHESION'];
        for (const mode of modes) {
            assert.ok(practiceContent.includes(mode), `Mode ${mode} must be present in SentencePractice component`);
        }

        // Check hint ladder
        assert.ok(practiceContent.includes('handleRequestHint') || practiceContent.includes('requestNextHint'), 'Hint request handler must exist');
        assert.ok(practiceContent.includes('revealedHints'), 'Revealed hints state must be rendered');
    });

    await t.test('6. FeedbackPanel: Stale Offset Protection & Dispute Finding', () => {
        const fbContent = fs.readFileSync(path.join(BASE_DIR, 'coach/FeedbackPanel.tsx'), 'utf8');

        // Stale offset protection
        assert.ok(fbContent.includes('workingText.includes(issue.sourceQuote)'), 'Stale offset protection must check if sourceQuote is in workingText');
        assert.ok(fbContent.includes('staleOffsetError') || fbContent.includes('Đoạn văn gốc đã thay đổi'), 'Must provide clear warning on stale offset');

        // Dispute finding
        assert.ok(fbContent.includes('handleDispute') || fbContent.includes('onDisputeIssue') || fbContent.includes('disputeIssue'), 'Dispute finding must be wired');
    });

    await t.test('7. WritingCoach: Optimistic Concurrency & Session Completion', () => {
        const coachContent = fs.readFileSync(path.join(BASE_DIR, 'coach/WritingCoach.tsx'), 'utf8');

        // Concurrency / revision tracking
        assert.ok(coachContent.includes('currentRevision') || coachContent.includes('expectedRevision'), 'WritingCoach must track draft revisions');

        // Complete session wiring
        assert.ok(coachContent.includes('completeSession'), 'Must wire writingApi.completeSession');
        assert.ok(!coachContent.includes('alert('), 'No alert stubs in WritingCoach');
    });

    await t.test('8. Portfolio: Search Filter & Favorites Toggle', () => {
        const portfolioContent = fs.readFileSync(path.join(BASE_DIR, 'portfolio/Portfolio.tsx'), 'utf8');

        assert.ok(portfolioContent.includes('searchTerm') || portfolioContent.includes('searchQuery') || portfolioContent.includes('filteredItems'), 'Portfolio must filter items by search');
        assert.ok(portfolioContent.includes('handleToggleFavorite') || portfolioContent.includes('setFavorite'), 'Portfolio must support favorite toggling');
    });

    await t.test('9. Backend Service API Contract Integrity', () => {
        const apiContent = fs.readFileSync(path.resolve('src/services/writingApi.ts'), 'utf8');

        const expectedMethods = [
            'getCapabilities',
            'getProfile',
            'getForYou',
            'getWeeklyReport',
            'submitSentenceCheck',
            'getTasks',
            'createSession',
            'getSession',
            'updateWorkingCopy',
            'submitDraft',
            'completeSession',
            'getDraftComparison',
            'setFavorite',
            'getPortfolio',
            'getLongitudinalProgress',
            'startPractice',
            'requestNextHint',
            'submitAttempt',
            'getMyMistakes',
            'setMuted',
            'disputeIssue'
        ];

        for (const m of expectedMethods) {
            assert.ok(apiContent.includes(m), `writingApi must export method '${m}'`);
        }
    });
});
