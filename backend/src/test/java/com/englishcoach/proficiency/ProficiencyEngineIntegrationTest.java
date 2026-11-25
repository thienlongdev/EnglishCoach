package com.englishcoach.proficiency;

import com.englishcoach.leaderboard.activity.Cefr;
import com.englishcoach.leaderboard.activity.ProficiencyUserLevelProvider;
import com.englishcoach.common.event.DictationAttemptSubmittedEvent;
import com.englishcoach.common.event.ExamScoredEvent;
import com.englishcoach.common.event.RoleplayTurnRecordedEvent;
import com.englishcoach.leaderboard.activity.event.CardBlastRunFinishedEvent;
import com.englishcoach.leaderboard.activity.event.FlashcardReviewedEvent;
import com.englishcoach.leaderboard.activity.event.PvpMatchFinishedEvent;
import com.englishcoach.leaderboard.activity.event.ShadowingAttemptRecordedEvent;
import com.englishcoach.leaderboard.activity.event.WritingAssessmentCompletedEvent;
import com.englishcoach.proficiency.api.ProficiencyDtos;
import com.englishcoach.proficiency.api.ProficiencyQueryService;
import com.englishcoach.proficiency.model.EvidenceKind;
import com.englishcoach.proficiency.model.EvidenceRow;
import com.englishcoach.proficiency.model.EvidenceSource;
import com.englishcoach.proficiency.model.EvidenceTier;
import com.englishcoach.proficiency.model.OverallStatus;
import com.englishcoach.proficiency.model.ProficiencyCefr;
import com.englishcoach.proficiency.model.ProficiencySkill;
import com.englishcoach.proficiency.model.SkillStatus;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.test.context.junit.jupiter.SpringJUnitConfig;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.EnableTransactionManagement;
import org.testcontainers.junit.jupiter.Testcontainers;

import javax.sql.DataSource;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Proficiency Engine against a real PostgreSQL 17 (V53 applied). The listener runs synchronously
 * here (no @EnableAsync / @EnableScheduling in the test context).
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringJUnitConfig(ProficiencyEngineIntegrationTest.Config.class)
class ProficiencyEngineIntegrationTest {

    @Configuration
    @EnableTransactionManagement(proxyTargetClass = true)
    @Import({ScoreMappingRepository.class, RatingConverter.class, ProficiencyEvidenceRepository.class,
            ProficiencyStateRepository.class, ProficiencySourceReadRepository.class, EvidenceMapper.class,
            SkillRatingCalculator.class, OverallCalculator.class, ProficiencyService.class,
            ProficiencyIngestService.class, ProficiencyEventListener.class, ProficiencyNightlyJob.class,
            ProficiencyQueryService.class, ProficiencyLevelQueryService.class, ProficiencyUserLevelProvider.class})
    static class Config {
        @Bean DataSource dataSource() { return ProficiencyTestPostgres.dataSource(); }
        @Bean NamedParameterJdbcTemplate namedParameterJdbcTemplate(DataSource ds) { return new NamedParameterJdbcTemplate(ds); }
        @Bean JdbcTemplate jdbcTemplate(DataSource ds) { return new JdbcTemplate(ds); }
        @Bean PlatformTransactionManager transactionManager(DataSource ds) { return new DataSourceTransactionManager(ds); }
        @Bean ProficiencyProperties proficiencyProperties() { return new ProficiencyProperties(); }
    }

    /** Exams Phase 0/4.1D: forms registered as broken get a pinned evidence basis without any eligible skill. */
    static final Set<UUID> BROKEN_FORMS = java.util.concurrent.ConcurrentHashMap.newKeySet();
    static final Map<UUID, String> FORM_LIFECYCLE = new java.util.concurrent.ConcurrentHashMap<>();

    @Autowired ApplicationEventPublisher publisher;
    @Autowired JdbcTemplate jdbc;
    @Autowired RatingConverter converter;
    @Autowired ProficiencyEvidenceRepository evidenceRepository;
    @Autowired ProficiencyStateRepository stateRepository;
    @Autowired ProficiencyService service;
    @Autowired ProficiencyIngestService ingest;
    @Autowired ProficiencyNightlyJob nightly;
    @Autowired ProficiencyQueryService queryService;
    @Autowired ProficiencyUserLevelProvider levelProvider;

    // ---- helpers --------------------------------------------------------------------------------

    private UUID form(String lifecycle) {
        UUID id = UUID.randomUUID();
        jdbc.update("INSERT INTO exams.form_versions (id, lifecycle_state) VALUES (?, ?)", id, lifecycle);
        FORM_LIFECYCLE.put(id, lifecycle);
        return id;
    }

    /** Creates attempt + submission + artifact + components; returns the artifact id. */
    private UUID artifact(long userId, UUID formId, String family, String status, int runOrdinal, Instant createdAt,
                          Object[]... components) {
        return artifact("EXAM_SIMULATION", userId, formId, family, status, runOrdinal, createdAt, components);
    }

    private UUID artifact(String mode, long userId, UUID formId, String family, String status, int runOrdinal,
                          Instant createdAt, Object[]... components) {
        UUID attempt = UUID.randomUUID();
        UUID submission = UUID.randomUUID();
        UUID art = UUID.randomUUID();
        // Exams Phase 4.1D: every attempt created by the current runtime carries the evidence basis pinned at creation
        jdbc.update("INSERT INTO exams.attempts (id, user_id, form_id, family, attempt_mode, snapshot_state, manifest_snapshot) "
                        + "VALUES (?, ?, ?, ?, ?, 'SNAPSHOTTED', ?::jsonb)",
                attempt, userId, formId, family, mode, pinnedSnapshot(formId, mode));
        jdbc.update("INSERT INTO exams.submissions (id, attempt_id) VALUES (?, ?)", submission, attempt);
        jdbc.update("INSERT INTO exams.score_artifacts (id, submission_id, run_ordinal, result_status, created_at) VALUES (?, ?, ?, ?, ?)",
                art, submission, runOrdinal, status, Timestamp.from(createdAt));
        for (Object[] c : components) {
            jdbc.update("INSERT INTO exams.score_components (artifact_id, metric, scale_name, scaled_score) VALUES (?, ?, ?, ?)",
                    art, c[0], c[1], c[2]);
        }
        return art;
    }

    static String pinnedSnapshot(UUID formId, String mode) {
        java.util.EnumSet<com.englishcoach.exams.model.ExamTypes.SkillType> skills = BROKEN_FORMS.contains(formId)
                ? java.util.EnumSet.noneOf(com.englishcoach.exams.model.ExamTypes.SkillType.class)
                : java.util.EnumSet.allOf(com.englishcoach.exams.model.ExamTypes.SkillType.class);
        com.englishcoach.exams.validation.ExamFormValidationReport v = new com.englishcoach.exams.validation.ExamFormValidationReport(
                formId, com.englishcoach.exams.validation.ExamFormValidator.VALIDATOR_VERSION, "fp", Instant.now(), null, "FULL", null,
                skills.isEmpty() ? com.englishcoach.exams.validation.ExamContentValidationStatus.INVALID
                        : com.englishcoach.exams.validation.ExamContentValidationStatus.VALID,
                !skills.isEmpty(), skills, skills, skills, List.of(), List.of());
        Map<String, Object> basis = com.englishcoach.exams.validation.ExamAttemptEvidenceBasis.pin(v, formId,
                FORM_LIFECYCLE.get(formId), mode == null ? "EXAM_SIMULATION" : mode,
                java.util.EnumSet.allOf(com.englishcoach.exams.model.ExamTypes.SkillType.class), "hash").toMap();
        try {
            return new com.fasterxml.jackson.databind.ObjectMapper().writeValueAsString(Map.of("evidenceBasis", basis));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private void examEvent(long userId, UUID art, UUID formId, String family, String status, int runOrdinal) {
        publisher.publishEvent(new ExamScoredEvent(userId, UUID.randomUUID(), UUID.randomUUID(), art, runOrdinal, formId,
                family, "ACADEMIC", "FULL", "EXAM_SIMULATION", status, new HashMap<>(), Instant.now()));
    }

    private static Object[] c(String metric, String scale, double score) {
        return new Object[]{metric, scale, score};
    }

    private List<EvidenceRow> evidence(long userId) {
        return evidenceRepository.findByUser(userId);
    }

    /** Two PUBLISHED IELTS forms with L/R at 7.0 and W/S at 6.5 → every core skill VERIFIED. */
    private void verifiedUser(long userId, Instant at) {
        for (int i = 0; i < 2; i++) {
            UUID f = form("PUBLISHED");
            UUID a = artifact(userId, f, "IELTS", "COMPLETED", 1, at,
                    c("LISTENING", "IELTS_BAND", 7.0), c("READING", "IELTS_BAND", 7.0),
                    c("WRITING", "IELTS_BAND", 6.5), c("SPEAKING", "IELTS_BAND", 6.5), c("FULL_OVERALL", "IELTS_BAND", 7.0));
            examEvent(userId, a, f, "IELTS", "COMPLETED", 1);
        }
    }

    // ---- mapping ----------------------------------------------------------------------------------

    @Test
    @DisplayName("DB-seeded anchors: IELTS 6.0 → 556, TOEIC L 400 → 500, IELTS 9.5 / TOEIC L 500 → none")
    void seededMapping() {
        assertEquals(Optional.of(556), converter.interpolate(RatingConverter.IELTS_BAND, 6.0));
        assertEquals(Optional.of(500), converter.interpolate(RatingConverter.TOEIC_LISTENING, 400));
        assertEquals(Optional.empty(), converter.interpolate(RatingConverter.IELTS_BAND, 9.5));
        assertEquals(Optional.empty(), converter.interpolate(RatingConverter.TOEIC_LISTENING, 500));
        assertEquals(Optional.of(750), converter.interpolate(RatingConverter.TOEIC_WRITING, 200));
    }

    @Test
    @DisplayName("Dictation: SYSTEM B1 at 0.95 → T3 499 LOWER_BOUND; USER material or no CEFR → no evidence")
    void dictation() {
        long u = 201;
        publisher.publishEvent(new DictationAttemptSubmittedEvent(u, 1L, 11L, 1L, 1L, "B1", 95.0, false, Instant.now()));
        publisher.publishEvent(new DictationAttemptSubmittedEvent(u, 2L, 12L, 2L, 1L, "C2", 100.0, true, Instant.now()));
        publisher.publishEvent(new DictationAttemptSubmittedEvent(u, 3L, 13L, 3L, 1L, null, 100.0, true, Instant.now()));
        List<EvidenceRow> rows = evidence(u);
        assertEquals(1, rows.size());
        EvidenceRow r = rows.get(0);
        assertEquals(ProficiencySkill.LISTENING, r.skill());
        assertEquals(EvidenceTier.T3, r.tier());
        assertEquals(EvidenceKind.LOWER_BOUND, r.kind());
        assertEquals(499, r.observedRating());
        assertEquals("11", r.materialKey());
        assertEquals(ProficiencyCefr.B1, r.contentCefr());
        assertEquals(0.35, r.tierWeight(), 1e-9);
        assertEquals(SkillStatus.UNDETERMINED, stateRepository.findSkills(u).get(ProficiencySkill.LISTENING).status());
    }

    @Test
    @DisplayName("Roleplay: scored once at ≥ 6 non-mocked learner turns on a SYSTEM scenario; custom scenario → none")
    void roleplay() {
        long u = 202;
        long session = 9001;
        for (int i = 0; i < 5; i++) {
            jdbc.update("INSERT INTO public.speaking_turns (session_id, speaker, is_mocked, fluency_score) VALUES (?, 'LEARNER', FALSE, 80)", session);
        }
        jdbc.update("INSERT INTO public.speaking_turns (session_id, speaker, is_mocked, fluency_score) VALUES (?, 'LEARNER', TRUE, 99)", session);
        publisher.publishEvent(new RoleplayTurnRecordedEvent(u, session, 1L, 10L, "A2", 70, 80, false, Instant.now()));
        assertTrue(evidence(u).isEmpty(), "5 real learner turns (mocked turn excluded) ⇒ nothing yet");

        jdbc.update("INSERT INTO public.speaking_turns (session_id, speaker, is_mocked, fluency_score) VALUES (?, 'LEARNER', FALSE, 80)", session);
        publisher.publishEvent(new RoleplayTurnRecordedEvent(u, session, 2L, 10L, "A2", 70, 80, false, Instant.now()));
        publisher.publishEvent(new RoleplayTurnRecordedEvent(u, session, 3L, 10L, "A2", 70, 80, false, Instant.now()));
        List<EvidenceRow> rows = evidence(u);
        assertEquals(1, rows.size());
        assertEquals(ProficiencySkill.SPEAKING, rows.get(0).skill());
        assertEquals(250, rows.get(0).observedRating()); // A2 [167,333], quality 0.80 → floor((167+333)/2)
        assertEquals(EvidenceKind.LOWER_BOUND, rows.get(0).kind());
        assertEquals("10", rows.get(0).materialKey());

        long custom = 9002;
        for (int i = 0; i < 6; i++) {
            jdbc.update("INSERT INTO public.speaking_turns (session_id, speaker, is_mocked, fluency_score) VALUES (?, 'LEARNER', FALSE, 95)", custom);
        }
        publisher.publishEvent(new RoleplayTurnRecordedEvent(u, custom, 4L, 11L, "C1", 90, 95, false, Instant.now()));
        assertEquals(1, evidence(u).size(), "user-created scenario CEFR is client-supplied ⇒ no evidence (P2)");
    }

    // ---- exams ------------------------------------------------------------------------------------

    @Test
    @DisplayName("Exam: REVIEW_REQUIRED then COMPLETED ⇒ exactly one evidence per skill; RESCORE ⇒ none")
    void examFirstCompletedWins() {
        long u = 203;
        UUID f = form("PUBLISHED");
        UUID review = artifact(u, f, "IELTS", "REVIEW_REQUIRED", 1, Instant.now(), c("LISTENING", "IELTS_BAND", 6.0));
        examEvent(u, review, f, "IELTS", "REVIEW_REQUIRED", 1);
        assertTrue(evidence(u).isEmpty());

        UUID done = artifact(u, f, "IELTS", "COMPLETED", 2, Instant.now(),
                c("LISTENING", "IELTS_BAND", 6.0), c("READING", "IELTS_BAND", 7.0), c("FULL_OVERALL", "IELTS_BAND", 6.5));
        examEvent(u, done, f, "IELTS", "COMPLETED", 2);
        UUID rescore = artifact(u, f, "IELTS", "COMPLETED", 3, Instant.now(), c("LISTENING", "IELTS_BAND", 8.5), c("READING", "IELTS_BAND", 8.5));
        examEvent(u, rescore, f, "IELTS", "COMPLETED", 3);

        List<EvidenceRow> rows = evidence(u);
        assertEquals(2, rows.size(), "FULL_OVERALL creates no evidence; rescore collides on the unique key");
        Map<ProficiencySkill, Integer> bySkill = new HashMap<>();
        rows.forEach(r -> bySkill.put(r.skill(), r.observedRating()));
        assertEquals(556, bySkill.get(ProficiencySkill.LISTENING));
        assertEquals(667, bySkill.get(ProficiencySkill.READING));
        assertTrue(rows.stream().allMatch(r -> r.tier() == EvidenceTier.T1 && r.kind() == EvidenceKind.POINT
                && r.sourceModule() == EvidenceSource.EXAM && r.materialKey().equals(f.toString())));
    }

    @Test
    @DisplayName("Exams Phase 0: PRACTICE (completed, retried, partial) ⇒ 0 evidence, live and via reconciliation")
    void practiceNeverCreatesEvidence() {
        long u = 231;
        UUID pub = form("PUBLISHED");
        UUID pilot = form("PILOT");
        UUID done = artifact("PRACTICE", u, pub, "IELTS", "COMPLETED", 1, Instant.now().minus(Duration.ofHours(2)),
                c("LISTENING", "IELTS_BAND", 7.0), c("READING", "IELTS_BAND", 7.0));
        examEvent(u, done, pub, "IELTS", "COMPLETED", 1);
        UUID retry = artifact("PRACTICE", u, pub, "IELTS", "COMPLETED", 2, Instant.now().minus(Duration.ofHours(1)),
                c("LISTENING", "IELTS_BAND", 8.0));
        examEvent(u, retry, pub, "IELTS", "COMPLETED", 2);
        examEvent(u, retry, pub, "IELTS", "COMPLETED", 2); // duplicate submit / redelivered event
        UUID partial = artifact("PRACTICE", u, pilot, "TOEIC", "COMPLETED", 1, Instant.now(),
                c("READING", "TOEIC_SCALE_5_495", 5.0));
        examEvent(u, partial, pilot, "TOEIC", "COMPLETED", 1);
        nightly.run(Instant.now());
        assertEquals(0, ingest.reconcileT1(null));
        assertTrue(evidence(u).isEmpty(), "PRACTICE never creates official proficiency evidence");
        assertTrue(stateRepository.findSkills(u).isEmpty(), "no verified / provisional skill level from PRACTICE");
    }

    @Test
    @DisplayName("Exams Phase 0: broken form content or AI fallback component ⇒ 0 evidence; valid sibling still counts")
    void brokenFormAndAiFallbackCreateNoEvidence() {
        long u = 232;
        UUID broken = form("PUBLISHED");
        BROKEN_FORMS.add(broken);
        UUID a1 = artifact(u, broken, "TOEIC", "COMPLETED", 1, Instant.now(),
                c("LISTENING", "TOEIC_SCALE_5_495", 5.0), c("READING", "TOEIC_SCALE_5_495", 5.0));
        examEvent(u, a1, broken, "TOEIC", "COMPLETED", 1);
        assertTrue(evidence(u).isEmpty(), "quarantined form never yields evidence");

        UUID ok = form("PUBLISHED");
        UUID a2 = artifact(u, ok, "IELTS", "COMPLETED", 1, Instant.now(),
                c("LISTENING", "IELTS_BAND", 6.0), c("WRITING", "IELTS_BAND", 6.5));
        jdbc.update("UPDATE exams.score_components SET uncertainty_range = '{\"fallback\":\"DETERMINISTIC_RUBRIC\"}'::jsonb "
                + "WHERE artifact_id = ? AND metric = 'WRITING'", a2);
        examEvent(u, a2, ok, "IELTS", "COMPLETED", 1);
        List<EvidenceRow> rows = evidence(u);
        assertEquals(1, rows.size(), "fallback-scored WRITING is dropped, LISTENING kept");
        assertEquals(ProficiencySkill.LISTENING, rows.get(0).skill());
    }

    @Test
    @DisplayName("Phase 2.1: PILOT-only skill ⇒ T2 (weight 0.7), rating counted but at most PROVISIONAL")
    void pilotOnlyIsProvisional() {
        long u = 211;
        for (int i = 0; i < 3; i++) {
            UUID f = form("PILOT");
            UUID a = artifact(u, f, "IELTS", "COMPLETED", 1, Instant.now().minus(Duration.ofHours(2)),
                    c("LISTENING", "IELTS_BAND", 7.0));
            examEvent(u, a, f, "IELTS", "COMPLETED", 1);
        }
        List<EvidenceRow> rows = evidence(u);
        assertEquals(3, rows.size());
        assertTrue(rows.stream().allMatch(r -> r.tier() == EvidenceTier.T2 && r.kind() == EvidenceKind.POINT));
        rows.forEach(r -> assertEquals(0.7, r.tierWeight(), 1e-9));
        ProficiencyStateRepository.StoredSkill l = stateRepository.findSkills(u).get(ProficiencySkill.LISTENING);
        assertEquals(667, l.rating(), "T2 evidence contributes to the rating");
        assertEquals(SkillStatus.PROVISIONAL, l.status(), "T2 is not a verification tier");
        assertFalse(l.everVerified());
        assertEquals("/exams", queryService.me(u).placementCta(), "PILOT results are not T1 ⇒ placement CTA stays");
    }

    @Test
    @DisplayName("Phase 2.1: PUBLISHED + PILOT ⇒ VERIFIED via the PUBLISHED result; weights 1.0 vs 0.7")
    void publishedPlusPilotVerified() {
        long u = 212;
        UUID pilot = form("PILOT");
        UUID a1 = artifact(u, pilot, "IELTS", "COMPLETED", 1, Instant.now().minus(Duration.ofHours(3)),
                c("READING", "IELTS_BAND", 7.0));
        examEvent(u, a1, pilot, "IELTS", "COMPLETED", 1);
        assertNotEquals(SkillStatus.VERIFIED, stateRepository.findSkills(u).get(ProficiencySkill.READING).status());

        UUID pub = form("PUBLISHED");
        UUID a2 = artifact(u, pub, "IELTS", "COMPLETED", 1, Instant.now().minus(Duration.ofHours(1)),
                c("READING", "IELTS_BAND", 7.0));
        examEvent(u, a2, pub, "IELTS", "COMPLETED", 1);

        Map<EvidenceTier, Double> weightByTier = new HashMap<>();
        evidence(u).forEach(r -> weightByTier.put(r.tier(), r.tierWeight()));
        assertEquals(Map.of(EvidenceTier.T1, 1.0, EvidenceTier.T2, 0.7), weightByTier);
        ProficiencyStateRepository.StoredSkill r = stateRepository.findSkills(u).get(ProficiencySkill.READING);
        assertEquals(SkillStatus.VERIFIED, r.status());
        assertEquals(667, r.rating());
        assertTrue(r.confidence() >= 0.60);
    }

    @Test
    @DisplayName("Exam: DRAFT form, LR_TOTAL, TOEIC Speaking stored as IELTS_BAND ⇒ no evidence; TOEIC L 400 ⇒ 500")
    void examEligibility() {
        long u = 209;
        UUID draft = form("DRAFT");
        UUID a1 = artifact(u, draft, "IELTS", "COMPLETED", 1, Instant.now(), c("LISTENING", "IELTS_BAND", 7.0));
        examEvent(u, a1, draft, "IELTS", "COMPLETED", 1);
        UUID pub = form("PUBLISHED");
        UUID a2 = artifact(u, pub, "TOEIC", "COMPLETED", 1, Instant.now(),
                c("LISTENING", "TOEIC_SCALE_5_495", 400), c("LR_TOTAL", "TOEIC_SCALE_10_990", 800),
                c("SPEAKING", "IELTS_BAND", 7.0), c("READING", "TOEIC_SCALE_5_495", 500));
        examEvent(u, a2, pub, "TOEIC", "COMPLETED", 1);
        List<EvidenceRow> rows = evidence(u);
        assertEquals(1, rows.size(), "READING 500 is outside 5–495 ⇒ no evidence");
        assertEquals(ProficiencySkill.LISTENING, rows.get(0).skill());
        assertEquals(500, rows.get(0).observedRating());
    }

    @Test
    @DisplayName("Exams Phase 4.1D: retiring / replacing the form after the attempt does not change its evidence; legacy ⇒ none")
    void snapshotEvidenceStableAfterFormChange() {
        long u = 233;
        UUID v1 = form("PUBLISHED");
        UUID a = artifact(u, v1, "IELTS", "COMPLETED", 1, Instant.now().minus(Duration.ofDays(3)),
                c("LISTENING", "IELTS_BAND", 6.5), c("READING", "IELTS_BAND", 6.5));
        // day 30: v1 retired, v1 re-flagged broken — the CURRENT form state must not matter
        jdbc.update("UPDATE exams.form_versions SET lifecycle_state = 'RETIRED' WHERE id = ?", v1);
        BROKEN_FORMS.add(v1);
        nightly.run(Instant.now());
        List<EvidenceRow> rows = evidence(u);
        assertEquals(2, rows.size(), "reconciliation decides from the pinned basis (PUBLISHED, L+R eligible)");
        assertTrue(rows.stream().allMatch(r -> r.tier() == EvidenceTier.T1));
        nightly.run(Instant.now());
        assertEquals(2, evidence(u).size(), "idempotent");
        assertEquals(rows.size(), new EvidenceMapperProbe(jdbc).count(a), "mapper answer unchanged");

        long legacyUser = 234;
        UUID f = form("PUBLISHED");
        UUID legacy = artifact(legacyUser, f, "IELTS", "COMPLETED", 1, Instant.now(), c("LISTENING", "IELTS_BAND", 7.0));
        jdbc.update("UPDATE exams.attempts SET snapshot_state = NULL, manifest_snapshot = NULL "
                + "WHERE id = (SELECT sub.attempt_id FROM exams.submissions sub JOIN exams.score_artifacts art "
                + "ON art.submission_id = sub.id WHERE art.id = ?)", legacy);
        examEvent(legacyUser, legacy, f, "IELTS", "COMPLETED", 1);
        nightly.run(Instant.now());
        assertTrue(evidence(legacyUser).isEmpty(), "legacy attempt without a pinned basis ⇒ LEGACY_VALIDATION_UNAVAILABLE, no evidence");
    }

    /** Counts the snapshot basis rows of an artifact's attempt (sanity: the basis is persisted and read back). */
    record EvidenceMapperProbe(JdbcTemplate jdbc) {
        int count(UUID artifactId) {
            Integer n = jdbc.queryForObject("SELECT COUNT(*) FROM exams.score_components c JOIN exams.score_artifacts art "
                    + "ON art.id = c.artifact_id JOIN exams.submissions sub ON sub.id = art.submission_id JOIN exams.attempts a "
                    + "ON a.id = sub.attempt_id WHERE art.id = ? AND a.manifest_snapshot -> 'evidenceBasis' IS NOT NULL", Integer.class, artifactId);
            return n == null ? 0 : n;
        }
    }

    @Test
    @DisplayName("Reconciliation inserts missing T1 evidence (event lost) and is idempotent")
    void reconciliation() {
        long u = 204;
        UUID f = form("PUBLISHED");
        artifact(u, f, "IELTS", "COMPLETED", 1, Instant.now().minus(Duration.ofDays(2)),
                c("LISTENING", "IELTS_BAND", 5.5), c("READING", "IELTS_BAND", 5.5)); // no event published
        assertTrue(evidence(u).isEmpty());
        nightly.run(Instant.now());
        assertEquals(2, evidence(u).size());
        nightly.run(Instant.now());
        assertEquals(2, evidence(u).size());
        assertNotNull(stateRepository.findSkills(u).get(ProficiencySkill.READING));
    }

    // ---- exclusions ---------------------------------------------------------------------------------

    @Test
    @DisplayName("Client-reported / excluded sources produce no evidence even when their events fire")
    void excludedSources() {
        long u = 205;
        Instant now = Instant.now();
        publisher.publishEvent(new ShadowingAttemptRecordedEvent(u, 1L, 1L, 1L, 1L, "C1", 100.0, 100.0, 100.0, false, 0, now));
        publisher.publishEvent(new CardBlastRunFinishedEvent(u, 1L, 1L, 5000, 100.0, 0, now));
        publisher.publishEvent(new PvpMatchFinishedEvent(1L, "HUMAN", u, 206L, String.valueOf(u), "KO", 90_000L, true, 30, 2, 1L, now));
        publisher.publishEvent(new FlashcardReviewedEvent(u, 1L, 3, "easy", "LEARNED", "MASTERED", 1L, "C2", 1L, now));
        publisher.publishEvent(new WritingAssessmentCompletedEvent(u, "s1", "sub", "as", "ielts-t2-x", 100, 1, now));
        assertTrue(evidence(u).isEmpty());
        assertTrue(stateRepository.findSkills(u).isEmpty());
    }

    @Test
    @DisplayName("VOCABULARY: never evidence nor a computed row; API returns UNSUPPORTED; placement CTA shown")
    void vocabularyUnsupported() {
        long u = 206;
        List<EvidenceRow> inserted = service.storeEvidence(List.of(new EvidenceRow(null, u, ProficiencySkill.VOCABULARY,
                EvidenceTier.T1, EvidenceKind.POINT, EvidenceSource.EXAM, "exam:x:VOCABULARY", "x", BigDecimal.ONE,
                null, null, 700, 1.0, Instant.now())));
        assertTrue(inserted.isEmpty());
        assertTrue(evidence(u).isEmpty());
        Integer vocabRows = jdbc.queryForObject("SELECT COUNT(*) FROM public.skill_proficiency WHERE skill = 'VOCABULARY'", Integer.class);
        assertEquals(0, vocabRows);

        ProficiencyDtos.ProficiencyMeResponse me = queryService.me(u);
        assertEquals(5, me.skills().size());
        assertEquals("UNSUPPORTED", me.skills().stream().filter(s -> s.skill().equals("VOCABULARY")).findFirst().orElseThrow().status());
        assertEquals("UNDETERMINED", me.overall().status());
        assertEquals("Chưa xác định", me.overall().confidenceLabel());
        assertEquals("/exams", me.placementCta());
    }

    // ---- lifecycle --------------------------------------------------------------------------------

    @Test
    @DisplayName("Full flow → VERIFIED; nightly +200 days: rating/CEFR/peak unchanged, skills STALE (never UNDETERMINED)")
    void nightlyStale() {
        long u = 207;
        verifiedUser(u, Instant.now().minus(Duration.ofDays(1)));
        Map<ProficiencySkill, ProficiencyStateRepository.StoredSkill> before = stateRepository.findSkills(u);
        ProficiencyStateRepository.StoredUser userBefore = stateRepository.findUser(u).orElseThrow();
        assertEquals(4, before.size());
        before.values().forEach(s -> assertEquals(SkillStatus.VERIFIED, s.status()));
        assertEquals(OverallStatus.VERIFIED, userBefore.overallStatus());
        assertEquals(639, userBefore.overallRating()); // (667×2 + 611×2) / 4
        assertEquals(ProficiencyCefr.B2, userBefore.currentCefr());
        assertEquals(639, userBefore.peakRating());

        ProficiencyDtos.ProficiencyMeResponse me = queryService.me(u);
        assertEquals("VERIFIED", me.overall().status());
        assertEquals("Đã xác thực", me.overall().confidenceLabel());
        assertNull(me.placementCta(), "every active skill already has T1 evidence");

        Instant later = Instant.now().plus(Duration.ofDays(200));
        nightly.run(later);
        Map<ProficiencySkill, ProficiencyStateRepository.StoredSkill> after = stateRepository.findSkills(u);
        ProficiencyStateRepository.StoredUser userAfter = stateRepository.findUser(u).orElseThrow();
        for (ProficiencySkill s : before.keySet()) {
            assertEquals(before.get(s).rating(), after.get(s).rating(), "rating unchanged: " + s);
            assertEquals(SkillStatus.STALE, after.get(s).status(), "STALE, never UNDETERMINED: " + s);
            assertTrue(after.get(s).weightSum() < before.get(s).weightSum());
        }
        assertEquals(userBefore.overallRating(), userAfter.overallRating());
        assertEquals(userBefore.currentCefr(), userAfter.currentCefr());
        assertEquals(userBefore.peakRating(), userAfter.peakRating());
        assertEquals(userBefore.peakCefr(), userAfter.peakCefr());
        assertEquals(OverallStatus.STALE, userAfter.overallStatus());
        LocalDate day = later.atZone(ZoneId.of("Asia/Ho_Chi_Minh")).toLocalDate();
        Integer snaps = jdbc.queryForObject("SELECT COUNT(*) FROM public.proficiency_snapshot WHERE user_id = ? AND snapshot_date = ?",
                Integer.class, u, day);
        assertEquals(1, snaps);
        assertEquals("Cần xác thực lại", queryService.me(u).overall().confidenceLabel());
    }

    @Test
    @DisplayName("Peak never decreases (peak_rating stored); activityDivisionLevel = max(Current, peak − 1) via UserLevelProvider")
    void peakNeverDecreases() {
        long u = 208;
        for (int i = 0; i < 2; i++) {
            UUID f = form("PUBLISHED");
            UUID a = artifact(u, f, "IELTS", "COMPLETED", 1, Instant.now().minus(Duration.ofHours(3)),
                    c("LISTENING", "IELTS_BAND", 8.0), c("READING", "IELTS_BAND", 8.0),
                    c("WRITING", "IELTS_BAND", 8.0), c("SPEAKING", "IELTS_BAND", 8.0));
            examEvent(u, a, f, "IELTS", "COMPLETED", 1);
        }
        ProficiencyStateRepository.StoredUser high = stateRepository.findUser(u).orElseThrow();
        assertEquals(OverallStatus.VERIFIED, high.overallStatus());
        assertEquals(778, high.peakRating());
        assertEquals(ProficiencyCefr.C1, high.peakCefr());

        for (int i = 0; i < 2; i++) {
            UUID f = form("PUBLISHED");
            UUID a = artifact(u, f, "IELTS", "COMPLETED", 1, Instant.now().minus(Duration.ofHours(1)),
                    c("LISTENING", "IELTS_BAND", 5.0), c("READING", "IELTS_BAND", 5.0),
                    c("WRITING", "IELTS_BAND", 5.0), c("SPEAKING", "IELTS_BAND", 5.0));
            examEvent(u, a, f, "IELTS", "COMPLETED", 1);
        }
        ProficiencyStateRepository.StoredUser low = stateRepository.findUser(u).orElseThrow();
        assertTrue(low.overallRating() < high.overallRating(), "new evidence pulled the level down");
        assertEquals(778, low.peakRating());
        assertEquals(ProficiencyCefr.C1, low.peakCefr());
        assertEquals(high.peakReachedAt(), low.peakReachedAt());

        ProficiencyCefr current = low.currentCefr();
        ProficiencyCefr expected = ProficiencyCefr.B2.compareTo(current) > 0 ? ProficiencyCefr.B2 : current; // C1 − 1 step
        assertEquals(Optional.of(Cefr.valueOf(expected.name())), levelProvider.activityDivisionLevel(u));
        assertEquals(Optional.of(Cefr.valueOf(current.name())), levelProvider.currentLevel(u));
        assertEquals(Optional.empty(), levelProvider.currentLevel(206L), "undetermined user ⇒ empty");
    }

    @Test
    @DisplayName("Visibility toggle persists; proficiency_evidence is append-only")
    void visibilityAndAppendOnly() {
        long u = 210;
        assertFalse(queryService.setVisibility(u, false).showOnProficiencyBoard());
        assertFalse(queryService.me(u).showOnProficiencyBoard());
        UUID f = form("PILOT");
        UUID a = artifact(u, f, "IELTS", "COMPLETED", 1, Instant.now(), c("LISTENING", "IELTS_BAND", 6.0));
        examEvent(u, a, f, "IELTS", "COMPLETED", 1);
        assertEquals(1, evidence(u).size());
        assertThrows(DataAccessException.class, () -> jdbc.update("UPDATE public.proficiency_evidence SET observed_rating = 1 WHERE user_id = ?", u));
        assertThrows(DataAccessException.class, () -> jdbc.update("DELETE FROM public.proficiency_evidence WHERE user_id = ?", u));
        assertFalse(stateRepository.findUser(u).orElseThrow().showOnProficiencyBoard(), "recompute preserves the visibility flag");
        assertEquals(Set.of(ProficiencySkill.LISTENING), stateRepository.findSkills(u).keySet());
    }
}
