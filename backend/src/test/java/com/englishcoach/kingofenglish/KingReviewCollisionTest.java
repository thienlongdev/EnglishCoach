package com.englishcoach.kingofenglish;

import org.junit.jupiter.api.Test;
import java.util.List;
import static org.junit.jupiter.api.Assertions.*;

/** Reproduce the production-review blocker against the actual runtime answer checker. */
class KingReviewCollisionTest {
    @Test void identicalAdvertiseQuestionRejectsAnotherSourceBackedAnswer() {
        try (var corpus = new KingCorpus("REVIEW_PREVIEW")) {
            var bank = new KingBank(corpus);
            var a = bank.get("kc-reflex-4f6afae2bb26b2337613e9a6");
            var b = bank.get("kc-reflex-874e8df1a7d1f60615d2fc3e");
            assertEquals(a.prompt(), b.prompt());
            assertEquals(a.context(), b.context());
            assertEquals(a.options(), b.options());
            assertEquals(a.tokens(), b.tokens());
            assertEquals("advertisement", a.canonical());
            assertEquals("advertising", b.canonical());
            assertTrue(KingBank.correct(a, a.canonical(), List.of()));
            assertTrue(KingBank.correct(b, b.canonical(), List.of()));
            assertFalse(KingBank.correct(a, b.canonical(), List.of()));
            assertFalse(KingBank.correct(b, a.canonical(), List.of()));
        }
    }
    @Test void identicalAuthoredExplainCluesRejectEquivalentRoomName() {
        try (var corpus = new KingCorpus("REVIEW_PREVIEW")) {
            var a = corpus.explain("kc-explain-c5f765682d44986159702abe");
            var b = corpus.explain("kc-explain-dd470831af7e386435f6b8d0");
            assertEquals(a.progressiveClues(), b.progressiveClues());
            assertEquals("living room", a.target());
            assertEquals("sitting room", b.target());
            assertFalse(KingExplainBank.correct(a, b.target()));
            assertFalse(KingExplainBank.correct(b, a.target()));
        }
    }
}
