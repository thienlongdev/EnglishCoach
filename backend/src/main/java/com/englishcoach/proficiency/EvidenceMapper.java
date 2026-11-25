package com.englishcoach.proficiency;

import com.englishcoach.exams.model.ExamTypes.ScoreMetric;
import com.englishcoach.exams.model.ExamTypes.ExamSnapshotState;
import com.englishcoach.exams.validation.ExamAttemptEvidenceBasis;
import com.englishcoach.exams.validation.ExamEvidenceEligibilityPolicy;
import com.englishcoach.common.event.DictationAttemptSubmittedEvent;
import com.englishcoach.common.event.RoleplayTurnRecordedEvent;
import com.englishcoach.proficiency.model.EvidenceKind;
import com.englishcoach.proficiency.model.EvidenceRow;
import com.englishcoach.proficiency.model.EvidenceSource;
import com.englishcoach.proficiency.model.EvidenceTier;
import com.englishcoach.proficiency.model.ProficiencyCefr;
import com.englishcoach.proficiency.model.ProficiencySkill;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

/**
 * Phase 1 domain events â†’ 0..n evidence rows (Proficiency Spec Â§3â€“4). Listens only; never
 * publishes. Sources NOT mapped on purpose: shadowing and Card Blast solo/PvP (client-reported),
 * flashcards (self-rated), Writing Studio (0â€“100 rubric, no official mapping) â€” Hardening #11.
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class EvidenceMapper {

    private final ProficiencyProperties props;
    private final ProficiencySourceReadRepository sources;
    private final RatingConverter converter;

    private static final ObjectMapper JSON = new ObjectMapper();

    /** T3 LISTENING: server-computed dictation accuracy on SYSTEM material with a real CEFR label. */
    public Optional<EvidenceRow> fromDictation(DictationAttemptSubmittedEvent e) {
        if (e.userId() == null || e.attemptId() == null || e.exerciseId() == null || e.materialId() == null
                || e.accuracyPct() == null) {
            return Optional.empty();
        }
        Optional<ProficiencySourceReadRepository.ContentInfo> material = sources.listeningMaterial(e.materialId());
        if (material.isEmpty() || !material.get().system()) {
            log.debug("[Proficiency] dictation {} skipped: material {} is not SYSTEM content", e.attemptId(), e.materialId());
            return Optional.empty();
        }
        Optional<ProficiencyCefr> cefr = ProficiencyCefr.parseStrict(material.get().cefrLevel());
        if (cefr.isEmpty()) {
            log.debug("[Proficiency] dictation {} skipped: material {} has no CEFR label", e.attemptId(), e.materialId());
            return Optional.empty();
        }
        double quality = clamp01(e.accuracyPct() / 100.0);
        return Optional.of(t3(e.userId(), ProficiencySkill.LISTENING, EvidenceSource.DICTATION,
                "dictation:" + e.attemptId(), String.valueOf(e.exerciseId()), e.accuracyPct(), cefr.get(), quality,
                occurred(e.occurredAt())));
    }

    /**
     * T3 SPEAKING: one row per roleplay session once it has â‰¥ 6 non-mocked learner turns; quality =
     * mean AI fluency / 100 on a SYSTEM scenario with a real CEFR label. No fluency â‡’ no evidence.
     */
    public Optional<EvidenceRow> fromRoleplay(RoleplayTurnRecordedEvent e) {
        if (e.userId() == null || e.sessionId() == null || e.scenarioId() == null) {
            return Optional.empty();
        }
        Optional<ProficiencySourceReadRepository.ContentInfo> scenario = sources.speakingScenario(e.scenarioId());
        if (scenario.isEmpty() || !scenario.get().system()) {
            log.debug("[Proficiency] roleplay session {} skipped: scenario {} is not SYSTEM content", e.sessionId(), e.scenarioId());
            return Optional.empty();
        }
        Optional<ProficiencyCefr> cefr = ProficiencyCefr.parseStrict(scenario.get().cefrLevel());
        if (cefr.isEmpty()) {
            return Optional.empty();
        }
        ProficiencySourceReadRepository.RoleplayStats stats = sources.roleplayStats(e.sessionId());
        if (stats.learnerTurns() < 6 || stats.meanFluency() == null) {
            return Optional.empty();
        }
        double quality = clamp01(stats.meanFluency() / 100.0);
        return Optional.of(t3(e.userId(), ProficiencySkill.SPEAKING, EvidenceSource.ROLEPLAY,
                "roleplay:" + e.sessionId(), String.valueOf(e.scenarioId()), stats.meanFluency(), cefr.get(), quality,
                occurred(e.occurredAt())));
    }

    /**
     * T1 (PUBLISHED form) / T2 (PILOT form, Phase 2.1): per-skill components of a COMPLETED exam
     * artifact on an eligible form (P1), using the persisted component scale_name (P3). First
     * COMPLETED per (formId, skill) wins via the unique source_ref; REVIEW_REQUIRED and non-skill
     * metrics produce nothing.
     * <p>Exams Recovery Phase 2 + 4.1D: eligibility of every component is decided by the shared
     * {@link ExamEvidenceEligibilityPolicy} (EXAM_SIMULATION only — PRACTICE never creates official evidence —,
     * COMPLETED, no AI fallback rubric, and a skill the attempt's PINNED evidence basis marks eligible). The tier
     * comes from the lifecycle pinned in that basis (PUBLISHED → T1, PILOT → T2), never from the form as it is today,
     * so the live listener, nightly reconciliation and backfill give the same answer before and after a form is
     * replaced or retired. Legacy attempts without a basis produce nothing (LEGACY_VALIDATION_UNAVAILABLE).
     */
    private com.englishcoach.sentinel.SentinelExamIntegrity sentinelIntegrity;
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    void setSentinelIntegrity(com.englishcoach.sentinel.SentinelExamIntegrity sentinelIntegrity) { this.sentinelIntegrity = sentinelIntegrity; }

    public List<EvidenceRow> fromExamArtifact(UUID artifactId) {
        List<EvidenceRow> out = new ArrayList<>();
        Optional<ProficiencySourceReadRepository.ExamArtifact> found = sources.examArtifact(artifactId);
        if (found.isEmpty()) {
            return out;
        }
        ProficiencySourceReadRepository.ExamArtifact a = found.get();
        if (a.userId() == null) {
            return out;
        }
        // Echo Sentinel (10 §BX): a simulation created after activation needs a COMPLETED_VERIFIED strict attempt.
        if ("EXAM_SIMULATION".equals(a.attemptMode()) && sentinelIntegrity != null && !sentinelIntegrity.allowsArtifact(artifactId)) {
            log.debug("[Proficiency] artifact {} skipped: no verified Echo Sentinel attempt", artifactId);
            return out;
        }
        ExamAttemptEvidenceBasis.Resolution basis = ExamAttemptEvidenceBasis.resolve(
                ExamSnapshotState.fromString(a.snapshotState()), basisMap(a.evidenceBasisJson()), a.formId(), a.attemptMode());
        String pinnedLifecycle = basis.pinned() ? basis.basis().formLifecycleState() : null;
        EvidenceTier tier = pinnedLifecycle == null ? null : props.getExamFormTiers().get(pinnedLifecycle);
        if (tier == null && basis.pinned()) {
            log.debug("[Proficiency] artifact {} skipped: pinned form lifecycle {} not eligible for exam evidence", artifactId, pinnedLifecycle);
            return out;
        }
        for (ProficiencySourceReadRepository.ExamComponent c : sources.examComponents(artifactId)) {
            ScoreMetric metric;
            try {
                metric = ScoreMetric.fromString(c.metric());
            } catch (IllegalArgumentException ex) {
                continue;
            }
            if (metric == null) {
                continue;
            }
            ProficiencySkill skill = switch (metric) {
                case LISTENING -> ProficiencySkill.LISTENING;
                case READING -> ProficiencySkill.READING;
                case WRITING -> ProficiencySkill.WRITING;
                case SPEAKING -> ProficiencySkill.SPEAKING;
                default -> null; // FULL_OVERALL, LR_TOTAL: no evidence
            };
            if (skill == null || !props.isActive(skill)) {
                continue;
            }
            ExamEvidenceEligibilityPolicy.Decision decision = ExamEvidenceEligibilityPolicy.decide(a.attemptMode(),
                    a.resultStatus(), metric.name(), c.scaledScore(), c.aiFallback(), basis);
            if (!decision.eligible() || tier == null) {
                log.debug("[Proficiency] artifact {} {} skipped: {} (form {})", artifactId, metric, decision.reason(), a.formId());
                continue;
            }
            Optional<String> scale = RatingConverter.resolveExamScale(a.family(), metric, c.scaleName());
            if (scale.isEmpty()) {
                log.info("[Proficiency] artifact {} {} skipped: scale {} inconsistent with family {}",
                        artifactId, metric, c.scaleName(), a.family());
                continue;
            }
            Optional<Integer> observed = converter.interpolate(scale.get(), c.scaledScore());
            if (observed.isEmpty()) {
                log.info("[Proficiency] artifact {} {} skipped: score {} outside {} anchors",
                        artifactId, metric, c.scaledScore(), scale.get());
                continue;
            }
            out.add(new EvidenceRow(null, a.userId(), skill, tier, EvidenceKind.POINT, EvidenceSource.EXAM,
                    "exam:" + a.formId() + ":" + skill.name(), String.valueOf(a.formId()),
                    BigDecimal.valueOf(c.scaledScore()), null, null, observed.get(),
                    props.tierWeight(tier), a.createdAt()));
        }
        return out;
    }

    private EvidenceRow t3(long userId, ProficiencySkill skill, EvidenceSource source, String sourceRef,
                           String materialKey, double raw, ProficiencyCefr cefr, double quality, Instant at) {
        RatingConverter.T3Observation obs = RatingConverter.t3Observation(cefr, quality);
        return new EvidenceRow(null, userId, skill, EvidenceTier.T3, obs.kind(), source, sourceRef, materialKey,
                BigDecimal.valueOf(raw).setScale(3, RoundingMode.HALF_UP), cefr,
                BigDecimal.valueOf(quality).setScale(4, RoundingMode.HALF_UP), obs.rating(),
                props.tierWeight(EvidenceTier.T3), at);
    }

    private static Map<String, Object> basisMap(String json) {
        if (json == null || json.isBlank() || "null".equals(json.trim())) return null;
        try {
            return JSON.readValue(json, new TypeReference<Map<String, Object>>() {});
        } catch (Exception ex) {
            return Map.of("basisVersion", "MALFORMED");      // never trusted: resolves to SNAPSHOT_BASIS_MISMATCH
        }
    }

    private static double clamp01(double v) {
        return Double.isNaN(v) ? 0.0 : Math.max(0.0, Math.min(1.0, v));
    }

    private static Instant occurred(Instant at) {
        return at != null ? at : Instant.now();
    }
}
