package com.englishcoach.exams.service;

import com.englishcoach.exams.model.ExamAttemptRecords.AttemptRecord;
import com.englishcoach.exams.model.ExamAttemptRecords.AttemptSectionRecord;
import com.englishcoach.exams.model.ExamContentRecords.*;
import com.englishcoach.exams.model.ExamTypes.*;
import com.englishcoach.exams.release.ExamRunnerCapabilities;
import com.englishcoach.exams.repository.ExamAttemptRepository;
import com.englishcoach.exams.repository.ExamContentRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

/**
 * Exams Recovery Phase 4B — learner manifest contract. Proves every {@link ExamRunnerCapabilities#MANIFEST_CONTRACT}
 * fact: printed group presentation once per group, form placement numbering, choose-N cardinality, answer-spec word
 * limit, PLAYBACK_GRANT asset delivery — and that a withheld (locked simulation) section carries none of them and no
 * answer key ever reaches the DTO.
 */
class ExamPhase4ManifestContractTest {

    private final ExamContentRepository contentRepository = mock(ExamContentRepository.class);
    private final ExamAttemptRepository attemptRepository = mock(ExamAttemptRepository.class);
    private final ExamManifestService service = new ExamManifestService(contentRepository, attemptRepository);
    private final UUID formId = UUID.randomUUID();
    private final UUID listeningSection = UUID.randomUUID();
    private final UUID readingSection = UUID.randomUUID();

    private Map<String, Object> item(int qn, String type, Map<String, Object> group, Map<String, Object> selection,
                                     Map<String, Object> spec) {
        Map<String, Object> defs = new LinkedHashMap<>();
        defs.put("options", "TEXT_GAP".equals(type) ? List.of()
                : List.of(Map.of("id", "A", "text", "alpha"), Map.of("id", "B", "text", "beta"), Map.of("id", "C", "text", "gamma")));
        defs.put("questionNumber", qn);
        defs.put("group", group);
        if (selection != null) defs.put("selection", selection);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", UUID.randomUUID().toString());
        m.put("logicalItemKey", "K" + qn);
        m.put("version", 1);
        m.put("prompt", "prompt " + qn);
        m.put("interactionType", type);
        m.put("optionDefinitions", defs);
        m.put("ordinal", qn);
        m.put("answerSpec", spec);
        return m;
    }

    private Map<String, Object> snapshot() {
        Map<String, Object> gapGroup = Map.of("kind", "GAP_COMPLETION", "questions", "1-2",
                "instructions", List.of("Complete the notes below.", "Write ONE WORD ONLY for each answer."),
                "wordLimitRule", "ONE WORD ONLY", "stem", "Line (1) ______\nLine (2) ______");
        Map<String, Object> pairGroup = Map.of("kind", "MULTI_SELECT", "questions", "3-4",
                "instructions", List.of("Choose TWO letters, A-C."));
        Map<String, Object> selection = Map.of("count", 2, "questions", List.of(3, 4));
        Map<String, Object> gapSpec = Map.of("id", UUID.randomUUID().toString(), "acceptedAnswers", Map.of("values", List.of("litter")),
                "cardinality", 1, "wordLimit", 1, "creditUnits", 1.0);
        Map<String, Object> pairSpec = Map.of("id", UUID.randomUUID().toString(), "acceptedAnswers",
                Map.of("values", List.of("A", "C"), "unorderedSet", Map.of("questions", List.of(3, 4), "values", List.of("A", "C"))),
                "cardinality", 1, "creditUnits", 1.0);
        String audioAsset = UUID.randomUUID().toString();
        String imageAsset = UUID.randomUUID().toString();
        Map<String, Object> g1 = new LinkedHashMap<>(Map.of("id", UUID.randomUUID().toString(), "logicalGroupKey", "G1",
                "questionType", "GAP_COMPLETION", "skill", "LISTENING", "placementOrdinal", 1, "displayNumbering", "1-2",
                "items", List.of(item(1, "TEXT_GAP", gapGroup, null, gapSpec), item(2, "TEXT_GAP", gapGroup, null, gapSpec))));
        g1.put("stimuli", List.of(Map.of("id", UUID.randomUUID().toString(), "logicalStimulusKey", "S1", "kind", "AUDIO",
                "bodyPayload", Map.of(), "assets", List.of(Map.of("assetId", audioAsset, "role", "AUDIO_PROMPT", "mimeType", "audio/mpeg")))));
        Map<String, Object> g2 = new LinkedHashMap<>(Map.of("id", UUID.randomUUID().toString(), "logicalGroupKey", "G2",
                "questionType", "MULTI_SELECT", "skill", "LISTENING", "placementOrdinal", 2, "displayNumbering", "3-4",
                "items", List.of(item(3, "SINGLE_CHOICE", pairGroup, selection, pairSpec), item(4, "SINGLE_CHOICE", pairGroup, selection, pairSpec))));
        g2.put("stimuli", List.of(Map.of("id", UUID.randomUUID().toString(), "logicalStimulusKey", "S2", "kind", "MAP",
                "bodyPayload", Map.of("sourcePage", 3), "assets", List.of(Map.of("assetId", imageAsset, "role", "VISIBLE_MEDIA", "mimeType", "image/png")))));
        Map<String, Object> g3 = new LinkedHashMap<>(Map.of("id", UUID.randomUUID().toString(), "logicalGroupKey", "G3",
                "questionType", "TFNG", "skill", "READING", "placementOrdinal", 1,
                "items", List.of(item(5, "SINGLE_CHOICE", Map.of("kind", "TFNG", "instructions", List.of("Reading instruction")), null,
                        Map.of("acceptedAnswers", Map.of("values", List.of("A")), "cardinality", 1)))));
        g3.put("stimuli", List.of());
        return Map.of("version", "v4.0",
                "form", Map.of("id", formId.toString(), "title", "T"),
                "sections", List.of(
                        Map.of("id", listeningSection.toString(), "skill", "LISTENING", "ordinal", 1, "durationSeconds", 1800,
                                "parts", List.of(Map.of("id", UUID.randomUUID().toString(), "partCode", "LISTENING_PART_1", "ordinal", 1,
                                        "groups", List.of(g1, g2)))),
                        Map.of("id", readingSection.toString(), "skill", "READING", "ordinal", 2, "durationSeconds", 3600,
                                "parts", List.of(Map.of("id", UUID.randomUUID().toString(), "partCode", "READING_PASSAGE_1", "ordinal", 1,
                                        "groups", List.of(g3))))));
    }

    private AttemptRecord attempt(ExamAttemptMode mode) {
        return new AttemptRecord(UUID.randomUUID(), 7L, formId, ExamFamily.IELTS, "ACADEMIC", "FULL", mode, null, null,
                ExamAttemptStatus.IN_PROGRESS, 1, 1, null, null, "hash", Map.of(), null, Instant.now(), null, null, null,
                List.of(), Instant.now(), Instant.now(), snapshot(), "v4.0", ExamSnapshotState.SNAPSHOTTED);
    }

    @Test
    @DisplayName("group presentation, numbering, choose-N cardinality, word limit and grant delivery reach the DTO; no keys")
    void manifestCarriesPhase4Contract() throws Exception {
        AttemptRecord attempt = attempt(ExamAttemptMode.PRACTICE);
        when(attemptRepository.findSectionsByAttemptId(any())).thenReturn(List.of());
        PublicAttemptManifestDto m = service.compileAttemptManifest(attempt);

        PublicGroupDto gap = m.sections().get(0).parts().get(0).groups().get(0);
        PublicGroupDto pair = m.sections().get(0).parts().get(0).groups().get(1);
        assertEquals("1-2", gap.displayNumbering());
        assertEquals(2, pair.ordinal());
        assertEquals(List.of("Complete the notes below.", "Write ONE WORD ONLY for each answer."), gap.presentation().get("instructions"));
        assertEquals("Line (1) ______\nLine (2) ______", gap.presentation().get("stem"));
        assertEquals(1, gap.presentation().get("wordLimit"));
        assertEquals(1, gap.items().get(0).wordLimit());
        assertEquals(2, pair.items().get(0).cardinality(), "choose-TWO reaches the runner as cardinality 2");
        assertEquals(Map.of("count", 2, "questions", List.of(3, 4)), pair.presentation().get("selection"));
        assertEquals("PLAYBACK_GRANT", gap.stimuli().get(0).assets().get(0).delivery());
        assertEquals("PLAYBACK_GRANT", pair.stimuli().get(0).assets().get(0).delivery());

        String json = new ObjectMapper().findAndRegisterModules().writeValueAsString(m);
        assertFalse(json.contains("litter"), "answer keys never reach the learner manifest");
        assertFalse(json.contains("unorderedSet") || json.contains("acceptedAnswers"), "no answer spec in the manifest");
        assertTrue(json.contains("\"presentation\""));
    }

    @Test
    @DisplayName("a locked future simulation section carries no prompts, options or presentation")
    void lockedSectionWithheld() {
        AttemptRecord attempt = attempt(ExamAttemptMode.EXAM_SIMULATION);
        when(attemptRepository.findSectionsByAttemptId(any())).thenReturn(List.of(
                new AttemptSectionRecord(UUID.randomUUID(), attempt.id(), listeningSection, ExamSectionState.ACTIVE, "MAIN",
                        Instant.now(), null, null, Map.of(), Instant.now()),
                new AttemptSectionRecord(UUID.randomUUID(), attempt.id(), readingSection, ExamSectionState.PENDING, "MAIN",
                        null, null, null, Map.of(), Instant.now())));
        PublicAttemptManifestDto m = service.compileAttemptManifest(attempt);
        PublicGroupDto locked = m.sections().get(1).parts().get(0).groups().get(0);
        assertNull(locked.presentation());
        assertNull(locked.items().get(0).prompt());
        assertNull(locked.items().get(0).optionDefinitions());
        assertNotNull(m.sections().get(0).parts().get(0).groups().get(0).presentation());
    }

    @Test
    @DisplayName("the declared manifest contract is exactly what this test proves")
    void declaredContract() {
        assertEquals(Set.of("GROUP_PRESENTATION", "GROUP_PLACEMENT_NUMBERING", "ITEM_SELECTION_CARDINALITY",
                "ITEM_WORD_LIMIT", "ASSET_DELIVERY_PLAYBACK_GRANT"), ExamRunnerCapabilities.MANIFEST_CONTRACT);
    }
}
