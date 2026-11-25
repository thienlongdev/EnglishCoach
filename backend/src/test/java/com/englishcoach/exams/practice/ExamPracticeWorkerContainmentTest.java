package com.englishcoach.exams.practice;

import com.englishcoach.exams.client.ExamAiClient;
import com.englishcoach.exams.config.ExamsProperties;
import com.englishcoach.exams.job.ExamJobWorker;
import com.englishcoach.exams.model.ExamAttemptRecords.*;
import com.englishcoach.exams.model.ExamContentRecords.FormVersionRecord;
import com.englishcoach.exams.model.ExamContentRecords.SectionRecord;
import com.englishcoach.exams.model.ExamScoringRecords.JobRecord;
import com.englishcoach.exams.model.ExamScoringRecords.ScoreArtifactRecord;
import com.englishcoach.exams.model.ExamTypes.*;
import com.englishcoach.exams.repository.ExamAttemptRepository;
import com.englishcoach.exams.repository.ExamContentRepository;
import com.englishcoach.exams.repository.ExamProfileRepository;
import com.englishcoach.exams.repository.ExamScoringRepository;
import com.englishcoach.exams.scoring.ExamAnswerNormalizer;
import com.englishcoach.exams.scoring.ExamObjectiveScorer;
import com.englishcoach.exams.scoring.ExamScoreAggregator;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.time.Instant;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

/**
 * Exams Phase 6 — Docker-free containment of the scoring worker for practice scopes: even when a practice attempt
 * reaches the JOB path (objectiveOnly = false, e.g. after a direct-scoring failure), a writing task is never sent to the
 * AI judge (no band, no fallback score), a full-size objective scope is never standardized, and no profile evidence is
 * written.
 */
class ExamPracticeWorkerContainmentTest {

    final UUID form = UUID.randomUUID(), section = UUID.randomUUID(), part = UUID.randomUUID(), group = UUID.randomUUID();
    final ExamContentRepository content = mock(ExamContentRepository.class);
    final ExamAttemptRepository attempts = mock(ExamAttemptRepository.class);
    final ExamScoringRepository scoring = mock(ExamScoringRepository.class);
    final ExamProfileRepository profile = mock(ExamProfileRepository.class);
    final ExamAiClient ai = mock(ExamAiClient.class);

    ExamJobWorker worker() {
        return new ExamJobWorker(scoring, attempts, content, profile, new ExamObjectiveScorer(new ExamAnswerNormalizer()),
                new ExamScoreAggregator(), ai, null, new ExamsProperties());
    }

    Map<String, Object> snapshot(SkillType skill, String partCode, List<Map<String, Object>> items, String scoringMode,
                                 ExamPracticeScopeType type) {
        Map<String, Object> grp = new LinkedHashMap<>();
        grp.put("id", group.toString());
        grp.put("logicalGroupKey", "g1");
        grp.put("stimuli", List.of());
        grp.put("items", items);
        Map<String, Object> prt = new LinkedHashMap<>(Map.of("id", part.toString(), "partCode", partCode, "ordinal", 1));
        prt.put("groups", List.of(grp));
        Map<String, Object> sec = new LinkedHashMap<>(Map.of("id", section.toString(), "skill", skill.name(), "ordinal", 1));
        sec.put("parts", List.of(prt));
        Map<String, Object> snap = new LinkedHashMap<>();
        snap.put("version", "v4.0");
        snap.put("form", Map.of("id", form.toString(), "title", "synthetic"));
        snap.put("sections", List.of(sec));
        ExamPracticeScope scope = new ExamPracticeScope(type.name() + "_1", type, ExamFamily.IELTS, skill, 1, form, section, part,
                partCode, List.of(UUID.randomUUID()), List.of(group), items.size(),
                ExamPracticeScope.SCORING_OBJECTIVE_RAW.equals(scoringMode) ? items.size() : 0, scoringMode, List.of());
        snap.put(ExamPracticeScope.SNAPSHOT_KEY, scope.toSnapshotMap("SYNTHETIC", 1, null));
        return snap;
    }

    AttemptRecord attempt(Map<String, Object> snapshot, String scope) {
        return new AttemptRecord(UUID.randomUUID(), 101L, form, ExamFamily.IELTS, "ACADEMIC", scope, ExamAttemptMode.PRACTICE,
                null, null, ExamAttemptStatus.SUBMITTED, 3, 1, null, null, "h", Map.of(), Instant.now(), Instant.now(), null,
                Instant.now(), null, List.of(), Instant.now(), Instant.now(), snapshot, "v4.0", ExamSnapshotState.SNAPSHOTTED);
    }

    void stubForm(SkillType skill, AttemptRecord a, List<ResponseRecord> responses) {
        when(content.findFormById(form)).thenReturn(Optional.of(new FormVersionRecord(form, "SYN", 1, "synthetic", ExamFamily.IELTS,
                "ACADEMIC", "FULL", null, null, null, LifecycleState.PILOT, null, null, "h", null, null, Instant.now())));
        when(content.findSectionsByFormId(form)).thenReturn(List.of(new SectionRecord(section, form, skill, 1, "S", null, 3600, Map.of())));
        when(attempts.findSectionsByAttemptId(a.id())).thenReturn(List.of(new AttemptSectionRecord(UUID.randomUUID(), a.id(), section,
                ExamSectionState.COMPLETED, "MAIN", Instant.now(), null, Instant.now(), Map.of(), Instant.now())));
        when(attempts.findResponsesByAttemptId(a.id())).thenReturn(responses);
        when(content.findAnswerSpecsByFormId(form)).thenReturn(Map.of());
        when(content.findItemsByFormId(form)).thenReturn(List.of());
        when(scoring.findLatestArtifactBySubmissionId(any())).thenReturn(Optional.empty());
    }

    static SubmissionRecord submission(AttemptRecord a) {
        return new SubmissionRecord(UUID.randomUUID(), a.id(), SubmissionReason.MANUAL, Instant.now(), Map.of(), "h", Map.of(), "s", Instant.now());
    }

    static JobRecord job(SubmissionRecord s) {
        return new JobRecord(UUID.randomUUID(), s.id(), "SUBMISSION_SCORING", "v1", 1, JobStatus.RUNNING, Instant.now(), null, null, 0, 3,
                null, Instant.now(), Instant.now());
    }

    @Test
    @DisplayName("11/28: writing task practice on the JOB path ⇒ no AI call, no band component, raw NOT_SCORED marker, no evidence")
    void writingPracticeNeverAiScored() {
        Map<String, Object> item = new LinkedHashMap<>(Map.of("id", UUID.randomUUID().toString(), "logicalItemKey", "w2", "version", 1,
                "prompt", "synthetic task", "interactionType", "WRITING_RESPONSE", "ordinal", 1));
        item.put("optionDefinitions", Map.of("minimumWords", 250));
        AttemptRecord a = attempt(snapshot(SkillType.WRITING, "WRITING_TASK_2", List.of(item), ExamPracticeScope.SCORING_RESPONSE_ONLY,
                ExamPracticeScopeType.IELTS_WRITING_TASK), "IELTS_WRITING_TASK");
        UUID itemId = UUID.fromString((String) item.get("id"));
        stubForm(SkillType.WRITING, a, List.of(new ResponseRecord(UUID.randomUUID(), a.id(), section, "p_WRITING_TASK_2_g_g1_i_1", itemId,
                null, "synthetic essay text", null, false, 1, null, Instant.now())));
        SubmissionRecord sub = submission(a);

        ScoreArtifactRecord art = worker().executeSubmissionScoring(sub, a, job(sub), false);

        verifyNoInteractions(ai);
        verify(scoring, never()).insertScoreComponent(any());
        verify(profile, never()).insertProfileEvidence(any());
        assertEquals(ResultStatus.COMPLETED, art.resultStatus());
        Map<?, ?> raw = (Map<?, ?>) art.versionBundle().get("practiceRawScores");
        assertEquals("NOT_SCORED", ((Map<?, ?>) raw.get("WRITING")).get("scale"));
        // the AI fallback containment of simulations is unchanged (28)
        assertFalse(ExamJobWorker.isAuthoritativeAiScore(new ExamAiClient.AiScoringResponse("STAGE_WRITING", true, 6.0, List.of(),
                null, null, null, Map.of("fallback", "DETERMINISTIC_RUBRIC"), null, false, null, null)));
    }

    @Test
    @DisplayName("23/24: a practice scope is never standardized, even with 40 correct items (no IELTS band, no TOEIC scale)")
    void fullSizeObjectiveScopeStaysRaw() {
        List<Map<String, Object>> items = new ArrayList<>();
        List<ResponseRecord> responses = new ArrayList<>();
        for (int q = 1; q <= 40; q++) {
            Map<String, Object> it = new LinkedHashMap<>(Map.of("id", UUID.randomUUID().toString(), "logicalItemKey", "q" + q,
                    "version", 1, "prompt", "synthetic gap " + q, "interactionType", "TEXT_GAP", "ordinal", q));
            it.put("optionDefinitions", Map.of("questionNumber", q));
            it.put("answerSpec", Map.of("id", UUID.randomUUID().toString(), "acceptedAnswers", Map.of("values", List.of("word" + q)),
                    "normalizationPolicy", Map.of(), "cardinality", 1, "creditUnits", 1.0));
            items.add(it);
        }
        AttemptRecord a = attempt(snapshot(SkillType.LISTENING, "LISTENING_PART_1", items, ExamPracticeScope.SCORING_OBJECTIVE_RAW,
                ExamPracticeScopeType.IELTS_LISTENING_SECTION), "IELTS_LISTENING_SECTION");
        for (Map<String, Object> it : items) {
            String v = (String) ((List<?>) ((Map<?, ?>) ((Map<?, ?>) it.get("answerSpec")).get("acceptedAnswers")).get("values")).get(0);
            responses.add(new ResponseRecord(UUID.randomUUID(), a.id(), section, "p", UUID.fromString((String) it.get("id")),
                    Map.of("value", v), v, null, false, 1, null, Instant.now()));
        }
        stubForm(SkillType.LISTENING, a, responses);
        SubmissionRecord sub = submission(a);

        ScoreArtifactRecord art = worker().executeSubmissionScoring(sub, a, job(sub), false);

        verify(scoring, never()).insertScoreComponent(any());
        ArgumentCaptor<ScoreArtifactRecord> stored = ArgumentCaptor.forClass(ScoreArtifactRecord.class);
        verify(scoring).insertScoreArtifact(stored.capture());
        Map<?, ?> raw = (Map<?, ?>) ((Map<?, ?>) stored.getValue().versionBundle().get("practiceRawScores")).get("LISTENING");
        assertEquals(40.0, ((Number) raw.get("correct")).doubleValue());
        assertEquals("UNSCALED_PARTIAL", raw.get("scale"), "practice scope ⇒ raw only, whatever its size");
        assertEquals("ATTEMPT_SNAPSHOT", art.versionBundle().get("objectiveContentSource"));
        verify(profile, never()).insertProfileEvidence(any());
        verifyNoInteractions(ai);
    }
}
