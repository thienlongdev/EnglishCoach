package com.englishcoach.exams.scoring;

import com.englishcoach.exams.model.ExamContentRecords.AnswerSpecRecord;
import com.englishcoach.exams.model.ExamTypes.ExamFamily;
import com.englishcoach.exams.model.ExamTypes.ScoreMetric;
import com.englishcoach.exams.model.ExamTypes.SkillType;
import com.englishcoach.exams.scoring.ExamObjectiveScorer.ItemScoreResult;
import com.englishcoach.exams.scoring.ExamObjectiveScorer.ObjectiveItemInput;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

import java.util.*;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Exams Recovery Phase 4C — scoring contract: choose-TWO set semantics, server-side word limits, empty-key safety,
 * snapshot content parsing and the partial-scale rule. Specs mirror the canonical staged package shape
 * ({@code acceptedAnswers.values}, {@code unorderedSet}, EC-NORM-V1 policy).
 */
class ExamPhase4ScoringTest {

    private final ExamAnswerNormalizer normalizer = new ExamAnswerNormalizer();
    private final ExamObjectiveScorer scorer = new ExamObjectiveScorer(normalizer);

    private static final Map<String, Object> CHOICE_POLICY = Map.of("version", "EC-NORM-V1", "caseInsensitive", true,
            "trimOuterWhitespace", true, "collapseInternalWhitespace", true, "punctuationInsensitive", true);
    private static final Map<String, Object> GAP_POLICY = Map.of("version", "EC-NORM-V1", "caseInsensitive", true,
            "trimOuterWhitespace", true, "collapseInternalWhitespace", true, "punctuationInsensitive", false);

    private static AnswerSpecRecord spec(Map<String, Object> accepted, Map<String, Object> policy, Integer wordLimit) {
        return new AnswerSpecRecord(UUID.randomUUID(), UUID.randomUUID(), accepted, policy, 1, wordLimit, 1.0, null, null, null);
    }

    /** Canonical choose-TWO pair: two items (Q15, Q16) sharing the unordered key set {A, D}. */
    private static AnswerSpecRecord chooseTwo() {
        return spec(Map.of("values", List.of("A", "D"),
                "unorderedSet", Map.of("questions", List.of(15, 16), "values", List.of("A", "D"), "creditPerQuestion", 1)),
                CHOICE_POLICY, null);
    }

    private double total(List<ItemScoreResult> results) {
        return results.stream().mapToDouble(ItemScoreResult::creditAwarded).sum();
    }

    @Nested
    @DisplayName("4C.2 choose-TWO / multi-select")
    class ChooseTwo {
        @Test
        @DisplayName("same option on both questions of the set earns ONE mark, never two")
        void duplicateSelectionCannotScoreTwice() {
            List<ItemScoreResult> r = scorer.scoreItems(List.of(
                    new ObjectiveItemInput(UUID.randomUUID(), 15, Map.of("value", "A"), chooseTwo(), false),
                    new ObjectiveItemInput(UUID.randomUUID(), 16, Map.of("value", "A"), chooseTwo(), false)));
            assertEquals(1.0, total(r));
            assertEquals(ExamObjectiveScorer.OUTCOME_CORRECT, r.get(0).outcome());
            assertEquals(ExamObjectiveScorer.OUTCOME_DUPLICATE_SELECTION, r.get(1).outcome());
        }

        @Test
        @DisplayName("both keys in either order earn two marks; order is irrelevant")
        void orderIrrelevant() {
            assertEquals(2.0, total(scorer.scoreItems(List.of(
                    new ObjectiveItemInput(UUID.randomUUID(), 15, "D", chooseTwo(), false),
                    new ObjectiveItemInput(UUID.randomUUID(), 16, "a", chooseTwo(), false)))));
            assertEquals(2.0, total(scorer.scoreItems(List.of(
                    new ObjectiveItemInput(UUID.randomUUID(), 16, "A", chooseTwo(), false),
                    new ObjectiveItemInput(UUID.randomUUID(), 15, "D", chooseTwo(), false)))));
        }

        @Test
        @DisplayName("one right + one wrong = one mark; blank = no mark; a list on one question is not a selection")
        void partialAndInvalidSelections() {
            assertEquals(1.0, total(scorer.scoreItems(List.of(
                    new ObjectiveItemInput(UUID.randomUUID(), 15, "A", chooseTwo(), false),
                    new ObjectiveItemInput(UUID.randomUUID(), 16, "B", chooseTwo(), false)))));
            List<ItemScoreResult> r = scorer.scoreItems(List.of(
                    new ObjectiveItemInput(UUID.randomUUID(), 15, List.of("A", "D"), chooseTwo(), false),
                    new ObjectiveItemInput(UUID.randomUUID(), 16, "", chooseTwo(), false)));
            assertEquals(0.0, total(r));
            assertEquals(ExamObjectiveScorer.OUTCOME_BLANK, r.get(1).outcome());
        }

        @Test
        @DisplayName("credit never exceeds the key set size and plain items keep single-answer semantics")
        void neverExceedsSetSize() {
            AnswerSpecRecord plain = spec(Map.of("values", List.of("C")), CHOICE_POLICY, null);
            List<ItemScoreResult> r = scorer.scoreItems(List.of(
                    new ObjectiveItemInput(UUID.randomUUID(), 14, "C", plain, false),
                    new ObjectiveItemInput(UUID.randomUUID(), 15, "D", chooseTwo(), false),
                    new ObjectiveItemInput(UUID.randomUUID(), 16, "D", chooseTwo(), false)));
            assertEquals(2.0, total(r));
            assertTrue(r.get(0).isCorrect());
        }

        @Test
        @DisplayName("cardinality > 1 list answers use set equality; duplicates collapse and cannot add credit")
        void multiCardinalityList() {
            AnswerSpecRecord multi = new AnswerSpecRecord(UUID.randomUUID(), UUID.randomUUID(),
                    Map.of("values", List.of("B", "E")), CHOICE_POLICY, 2, null, 1.0, null, null, null);
            assertTrue(scorer.scoreItem(UUID.randomUUID(), List.of("E", "B"), multi).isCorrect());
            assertFalse(scorer.scoreItem(UUID.randomUUID(), List.of("B", "B"), multi).isCorrect());
        }
    }

    @Nested
    @DisplayName("4C.3 word limits (server-side, raw response)")
    class WordLimits {
        @Test
        @DisplayName("within limit is scored normally; over limit is not correct even when normalization would match")
        void overLimitRejected() {
            Map<String, Object> stripArticles = new HashMap<>(GAP_POLICY);
            stripArticles.put("stripArticles", true);
            AnswerSpecRecord oneWord = spec(Map.of("values", List.of("litter")), stripArticles, 1);
            assertTrue(scorer.scoreItem(UUID.randomUUID(), "Litter", oneWord).isCorrect());
            ItemScoreResult over = scorer.scoreItem(UUID.randomUUID(), "the litter", oneWord);
            assertFalse(over.isCorrect(), "'the litter' is two words for ONE WORD ONLY");
            assertEquals(ExamObjectiveScorer.OUTCOME_WORD_LIMIT_EXCEEDED, over.outcome());
        }

        @Test
        @DisplayName("punctuation-only tokens are ignored; a hyphenated word is one word")
        void punctuationAndHyphen() {
            assertEquals(1, normalizer.countWords("litter .", false));
            assertEquals(1, normalizer.countWords("well-known", false));
            assertEquals(2, normalizer.countWords("  water   supply ", false));
            AnswerSpecRecord oneWord = spec(Map.of("values", List.of("well-known")), GAP_POLICY, 1);
            assertTrue(scorer.scoreItem(UUID.randomUUID(), "well-known", oneWord).isCorrect());
        }

        @Test
        @DisplayName("'ONE WORD AND/OR A NUMBER': numbers do not count as words")
        void numbersExempt() {
            assertEquals(1, normalizer.countWords("15 litres", true));
            assertEquals(2, normalizer.countWords("15 litres", false));
            AnswerSpecRecord rule = spec(Map.of("values", List.of("15 litres")), GAP_POLICY, 1);
            assertTrue(scorer.scoreItem(UUID.randomUUID(), "15 litres", rule, true).isCorrect());
        }

        @Test
        @DisplayName("a number written in words is the number (official keys list '35' and 'thirty five')")
        void numberWords() {
            assertEquals(0, normalizer.countWords("thirty five", true));
            assertEquals(0, normalizer.countWords("two hundred and fifty", true));
            assertEquals(0, normalizer.countWords("thirty-five", true));
            assertEquals(1, normalizer.countWords("thirty five pounds", true));
            assertEquals(2, normalizer.countWords("thirty five", false), "without the NUMBER rule words are words");
            assertEquals(3, normalizer.countWords("cats and dogs", true), "'and' is exempt only between number words");
            // Phase 4.1C: a whole calendar date is "a number" (the official keys print '(the) 13(th) (of) January')
            assertEquals(0, normalizer.countWords("13th January", true), "a calendar date is the number");
            assertEquals(0, normalizer.countWords("the 13th of January", true), "printed optional date words are part of the date");
            assertEquals(1, normalizer.countWords("13th floor", true), "an ordinal is the number; other words still count");
            AnswerSpecRecord key = spec(Map.of("values", List.of("35", "thirty five")), GAP_POLICY, 1);
            assertTrue(scorer.isWordLimitEnforceable(key, true));
            assertTrue(scorer.scoreItem(UUID.randomUUID(), "thirty five", key, true).isCorrect());
            assertTrue(scorer.scoreItem(UUID.randomUUID(), "35", key, true).isCorrect());
            assertFalse(scorer.scoreItem(UUID.randomUUID(), "about thirty five people", key, true).isCorrect());
        }

        @Test
        @DisplayName("accepted variants are honoured; a key that breaks its own limit makes the limit unenforceable")
        void variantsAndKeyConflict() {
            AnswerSpecRecord twoWords = spec(Map.of("values", List.of("car park", "parking")), GAP_POLICY, 2);
            assertTrue(scorer.scoreItem(UUID.randomUUID(), "Car  park", twoWords).isCorrect());
            assertTrue(scorer.scoreItem(UUID.randomUUID(), "parking", twoWords).isCorrect());
            assertFalse(scorer.scoreItem(UUID.randomUUID(), "the big car park", twoWords).isCorrect());

            AnswerSpecRecord conflict = spec(Map.of("values", List.of("public car park")), GAP_POLICY, 2);
            assertFalse(scorer.isWordLimitEnforceable(conflict, false));
            assertTrue(scorer.scoreItem(UUID.randomUUID(), "public car park", conflict).isCorrect());
        }
    }

    @Nested
    @DisplayName("4C.4 empty-key safety (EXAM-AUD-026)")
    class EmptyKey {
        @Test
        @DisplayName("a blank / missing key never matches a blank response, and is UNKEYED")
        void blankKeyNeverMatches() {
            for (Map<String, Object> accepted : List.<Map<String, Object>>of(Map.of("values", List.of("")),
                    Map.of("exact", ""), Map.of("values", List.of("  ")), Map.of())) {
                AnswerSpecRecord s = spec(accepted, GAP_POLICY, null);
                for (Object response : Arrays.asList("", "   ", null, Map.of("value", ""))) {
                    ItemScoreResult r = scorer.scoreItem(UUID.randomUUID(), response, s);
                    assertFalse(r.isCorrect(), accepted + " vs " + response);
                    assertEquals(0.0, r.creditAwarded());
                }
            }
            assertEquals(ExamObjectiveScorer.OUTCOME_UNKEYED,
                    scorer.scoreItem(UUID.randomUUID(), "", spec(Map.of("values", List.of("")), GAP_POLICY, null)).outcome());
            assertFalse(scorer.scoreItem(UUID.randomUUID(), "x", null).isCorrect());
        }

        @Test
        @DisplayName("a blank response never matches a real key")
        void blankResponse() {
            ItemScoreResult r = scorer.scoreItem(UUID.randomUUID(), " ", spec(Map.of("values", List.of("B")), CHOICE_POLICY, null));
            assertFalse(r.isCorrect());
            assertEquals(ExamObjectiveScorer.OUTCOME_BLANK, r.outcome());
        }
    }

    @Nested
    @DisplayName("4C.5 / 4C.6 snapshot content and partial scale")
    class SnapshotAndScale {
        @Test
        @DisplayName("snapshot parsing exposes pinned specs, question numbers and the number-exempt rule")
        void snapshotParse() {
            UUID sec = UUID.randomUUID(), grp = UUID.randomUUID(), item = UUID.randomUUID();
            Map<String, Object> itemMap = new LinkedHashMap<>();
            itemMap.put("id", item.toString());
            itemMap.put("logicalItemKey", "K1");
            itemMap.put("interactionType", "TEXT_GAP");
            itemMap.put("ordinal", 3);
            itemMap.put("optionDefinitions", Map.of("questionNumber", 7,
                    "group", Map.of("wordLimitRule", "ONE WORD AND/OR", "instructions", List.of("Write ONE WORD AND/OR A NUMBER"))));
            itemMap.put("answerSpec", Map.of("acceptedAnswers", Map.of("values", List.of("x")), "cardinality", 1, "wordLimit", 1));
            Map<String, Object> snapshot = Map.of("sections", List.of(Map.of("id", sec.toString(), "skill", "LISTENING",
                    "parts", List.of(Map.of("groups", List.of(Map.of("id", grp.toString(), "items", List.of(itemMap))))))));
            ExamAttemptSnapshotContent c = ExamAttemptSnapshotContent.parse(snapshot).orElseThrow();
            ExamAttemptSnapshotContent.SnapshotItem it = c.section(sec).orElseThrow().items().get(0);
            assertEquals(SkillType.LISTENING, c.section(sec).get().skill());
            assertEquals(7, it.questionNumber());
            assertEquals(1, it.answerSpec().wordLimit());
            assertTrue(it.numbersExempt());
            assertTrue(ExamAttemptSnapshotContent.parse(Map.of("sections", List.of(Map.of("id", "not-a-uuid")))).isEmpty());
            assertTrue(ExamAttemptSnapshotContent.parse(null).isEmpty());
        }

        @Test
        @DisplayName("standardized scale only for complete standard sections (IELTS 40 / TOEIC 100)")
        void scaleApplicability() {
            assertEquals(ExamObjectiveScorer.ScaleApplicability.STANDARD_FULL_SECTION,
                    ExamObjectiveScorer.scaleApplicability(ExamFamily.IELTS, ScoreMetric.LISTENING, 40));
            assertEquals(ExamObjectiveScorer.ScaleApplicability.STANDARD_FULL_SECTION,
                    ExamObjectiveScorer.scaleApplicability(ExamFamily.TOEIC, ScoreMetric.READING, 100));
            assertEquals(ExamObjectiveScorer.ScaleApplicability.PARTIAL_UNSCALED,
                    ExamObjectiveScorer.scaleApplicability(ExamFamily.TOEIC, ScoreMetric.READING, 30));
            assertEquals(ExamObjectiveScorer.ScaleApplicability.PARTIAL_UNSCALED,
                    ExamObjectiveScorer.scaleApplicability(ExamFamily.IELTS, ScoreMetric.READING, 42));
        }
    }
}
