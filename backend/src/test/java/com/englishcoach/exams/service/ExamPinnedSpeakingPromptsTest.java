package com.englishcoach.exams.service;

import java.util.*;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class ExamPinnedSpeakingPromptsTest {
    @Test void sourceCountsComeFromPinnedItemsAndLegacyCountsStayUnchanged() {
        List<Map<?, ?>> items = new ArrayList<>();
        for (int i = 0; i < 6; i++) items.add(Map.of("prompt", "Synthetic question " + i + "?",
                "optionDefinitions", Map.of("speakingPromptBasis", "PINNED_CORPUS_SOURCE")));
        Map<String, Object> snapshot = Map.of("sections", List.of(Map.of("skill", "SPEAKING", "parts", List.of(
                Map.of("partCode", "SPEAKING_PART_3", "groups", List.of(Map.of("items", items)))))));
        assertTrue(ExamPinnedSpeakingPrompts.corpusItems(items));
        assertEquals(6, ExamPinnedSpeakingPrompts.requiredTurns(snapshot, 3, 4));
        assertEquals(4, ExamPinnedSpeakingPrompts.requiredTurns(snapshot, 1, 4));
        assertEquals(4, ExamPinnedSpeakingPrompts.requiredTurns(Map.of(), 3, 4));
        items.add(Map.of("prompt", "Legacy title"));
        assertFalse(ExamPinnedSpeakingPrompts.corpusItems(items));
    }
}
