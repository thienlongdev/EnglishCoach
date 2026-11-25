package com.englishcoach.exams.validation;

import com.englishcoach.exams.model.ExamTypes.ExamSnapshotState;
import com.englishcoach.exams.model.ExamTypes.SkillType;

import java.time.Instant;
import java.util.*;

/**
 * Exams Recovery Phase 4.1D — the content / validation basis PINNED to an attempt when it is created (stored inside
 * {@code attempts.manifest_snapshot} under {@link #SNAPSHOT_KEY}, next to the content snapshot it describes).
 *
 * <p>Official-evidence eligibility of a SNAPSHOTTED attempt is decided from THIS basis only — never from whatever the
 * form looks like today (a later v2, a retirement, a validator change or an operator flag cannot rewrite historical
 * truth). The basis records exactly what attempt creation decided: the form id + lifecycle at that moment, the
 * validator version and content fingerprint, the validation status, the simulation-grade skills, the attempt's mode
 * and skill scope, and the resulting evidence-eligible skills ({@code EXAM_SIMULATION} ⇒ scope ∩ simulation skills;
 * {@code PRACTICE} ⇒ none).
 *
 * <p>Attempts without a basis are NOT given one retroactively: a LEGACY_UNSNAPSHOTTED attempt, or a SNAPSHOTTED attempt
 * created before Phase 4.1 (snapshot without basis), resolves to {@link Kind#LEGACY_VALIDATION_UNAVAILABLE} — no new
 * authoritative evidence, and callers must not reconstruct historical validation from current content.
 */
public record ExamAttemptEvidenceBasis(
        String basisVersion,
        UUID formId,
        String formLifecycleState,
        String validatorVersion,
        String contentFingerprint,
        ExamContentValidationStatus validationStatus,
        boolean fullSimulationEligible,
        Set<SkillType> simulationSkills,
        String attemptMode,
        Set<SkillType> scopeSkills,
        Set<SkillType> evidenceSkills,
        String snapshotContentHash,
        Instant evaluatedAt
) {

    public static final String SNAPSHOT_KEY = "evidenceBasis";
    public static final String VERSION = "exam-evidence-basis-v1";

    public ExamAttemptEvidenceBasis {
        simulationSkills = skills(simulationSkills);
        scopeSkills = skills(scopeSkills);
        evidenceSkills = skills(evidenceSkills);
        if (validationStatus == null) validationStatus = ExamContentValidationStatus.UNKNOWN;
    }

    /** Pins the basis at attempt creation from the validation that authorised the attempt. */
    public static ExamAttemptEvidenceBasis pin(ExamFormValidationReport validation, UUID formId, String lifecycleState,
                                               String attemptMode, Set<SkillType> scopeSkills, String snapshotContentHash) {
        Set<SkillType> evidence = EnumSet.noneOf(SkillType.class);
        boolean usable = validation != null && validation.status() != ExamContentValidationStatus.UNKNOWN;
        if (usable && "EXAM_SIMULATION".equals(attemptMode) && scopeSkills != null) {
            for (SkillType s : scopeSkills) if (validation.isSimulationReady(s)) evidence.add(s);
        }
        return new ExamAttemptEvidenceBasis(VERSION, formId, lifecycleState,
                validation == null ? null : validation.validatorVersion(),
                validation == null ? null : validation.contentFingerprint(),
                validation == null ? ExamContentValidationStatus.UNKNOWN : validation.status(),
                usable && validation.fullSimulationEligible(),
                usable ? validation.simulationSkills() : Set.of(), attemptMode, scopeSkills, evidence,
                snapshotContentHash, validation == null ? null : validation.evaluatedAt());
    }

    public Map<String, Object> toMap() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("basisVersion", basisVersion);
        m.put("formId", formId == null ? null : formId.toString());
        m.put("formLifecycleState", formLifecycleState);
        m.put("validatorVersion", validatorVersion);
        m.put("contentFingerprint", contentFingerprint);
        m.put("validationStatus", validationStatus.name());
        m.put("fullSimulationEligible", fullSimulationEligible);
        m.put("simulationSkills", ExamFormValidationReport.skillNames(simulationSkills));
        m.put("attemptMode", attemptMode);
        m.put("scopeSkills", ExamFormValidationReport.skillNames(scopeSkills));
        m.put("evidenceSkills", ExamFormValidationReport.skillNames(evidenceSkills));
        m.put("snapshotContentHash", snapshotContentHash);
        m.put("evaluatedAt", evaluatedAt == null ? null : evaluatedAt.toString());
        return m;
    }

    /** Parses a stored basis map; empty when absent or malformed (malformed is never trusted). */
    public static Optional<ExamAttemptEvidenceBasis> fromMap(Map<String, Object> m) {
        if (m == null || !VERSION.equals(m.get("basisVersion"))) return Optional.empty();
        try {
            ExamContentValidationStatus status = ExamContentValidationStatus.valueOf(String.valueOf(m.get("validationStatus")));
            Object at = m.get("evaluatedAt");
            return Optional.of(new ExamAttemptEvidenceBasis(VERSION,
                    m.get("formId") == null ? null : UUID.fromString(String.valueOf(m.get("formId"))),
                    str(m.get("formLifecycleState")), str(m.get("validatorVersion")), str(m.get("contentFingerprint")),
                    status, Boolean.TRUE.equals(m.get("fullSimulationEligible")), skillSet(m.get("simulationSkills")),
                    str(m.get("attemptMode")), skillSet(m.get("scopeSkills")), skillSet(m.get("evidenceSkills")),
                    str(m.get("snapshotContentHash")), at == null ? null : Instant.parse(String.valueOf(at))));
        } catch (RuntimeException ex) {
            return Optional.empty();
        }
    }

    public enum Kind {
        /** SNAPSHOTTED attempt with a well-formed basis for the attempt's own form. */
        PINNED,
        /** No pinned basis (legacy unsnapshotted attempt, or a snapshot created before Phase 4.1). */
        LEGACY_VALIDATION_UNAVAILABLE,
        /** A basis exists but contradicts the attempt (other form, other mode, malformed, INVALID snapshot state). */
        BASIS_MISMATCH
    }

    public record Resolution(Kind kind, ExamAttemptEvidenceBasis basis) {
        public boolean pinned() {
            return kind == Kind.PINNED && basis != null;
        }
    }

    /**
     * Resolves the basis of an attempt from its persisted snapshot state and stored basis map (the
     * {@link #SNAPSHOT_KEY} object of the snapshot). Never consults current form content.
     */
    public static Resolution resolve(ExamSnapshotState state, Map<String, Object> basisMap, UUID attemptFormId,
                                     String attemptMode) {
        if (state == null || state == ExamSnapshotState.LEGACY_UNSNAPSHOTTED) {
            return new Resolution(Kind.LEGACY_VALIDATION_UNAVAILABLE, null);
        }
        if (state != ExamSnapshotState.SNAPSHOTTED) return new Resolution(Kind.BASIS_MISMATCH, null);
        if (basisMap == null) return new Resolution(Kind.LEGACY_VALIDATION_UNAVAILABLE, null);
        Optional<ExamAttemptEvidenceBasis> basis = fromMap(basisMap);
        if (basis.isEmpty()) return new Resolution(Kind.BASIS_MISMATCH, null);
        ExamAttemptEvidenceBasis b = basis.get();
        boolean sameForm = attemptFormId != null && attemptFormId.equals(b.formId());
        boolean sameMode = attemptMode != null && attemptMode.trim().equalsIgnoreCase(String.valueOf(b.attemptMode()));
        return sameForm && sameMode ? new Resolution(Kind.PINNED, b) : new Resolution(Kind.BASIS_MISMATCH, b);
    }

    /** Convenience for a whole snapshot map ({@code attempts.manifest_snapshot}). */
    @SuppressWarnings("unchecked")
    public static Resolution resolveFromSnapshot(ExamSnapshotState state, Map<String, Object> snapshot, UUID attemptFormId,
                                                 String attemptMode) {
        Object basis = snapshot == null ? null : snapshot.get(SNAPSHOT_KEY);
        return resolve(state, basis instanceof Map<?, ?> m ? (Map<String, Object>) m : null, attemptFormId, attemptMode);
    }

    private static String str(Object o) {
        return o == null ? null : String.valueOf(o);
    }

    private static Set<SkillType> skillSet(Object o) {
        Set<SkillType> out = EnumSet.noneOf(SkillType.class);
        if (o instanceof Collection<?> c) for (Object x : c) out.add(SkillType.valueOf(String.valueOf(x)));
        return out;
    }

    private static Set<SkillType> skills(Set<SkillType> s) {
        if (s == null || s.isEmpty()) return Set.of();
        return Collections.unmodifiableSet(EnumSet.copyOf(s));
    }
}
