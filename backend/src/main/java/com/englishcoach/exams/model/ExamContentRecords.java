package com.englishcoach.exams.model;

import com.englishcoach.exams.model.ExamTypes.*;
import com.englishcoach.exams.content.ExamBankOriginalPractice;
import com.fasterxml.jackson.annotation.JsonInclude;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

public final class ExamContentRecords {

    private ExamContentRecords() {}

    // ─── Database Records ─────────────────────────────────────────────────────

    public record SourceRecord(
            UUID id,
            String code,
            String name,
            String owner,
            String publisher,
            String sourceType,
            Map<String, Object> referenceMeta,
            Instant retiredAt,
            Instant createdAt
    ) {}

    public record LicenseRecord(
            UUID id,
            UUID sourceId,
            String licenseCode,
            ProvenanceCategory provenanceCategory,
            boolean commercialRights,
            boolean redistributionRights,
            boolean derivativeRights,
            Map<String, Object> permittedPurposes,
            Map<String, Object> permittedTerritories,
            Instant validFrom,
            Instant validUntil,
            String attribution,
            String evidenceAssetId,
            String legalStatus,
            Instant createdAt
    ) {}

    public record ProvenanceRecord(
            UUID id,
            UUID sourceId,
            UUID licenseId,
            String creator,
            String acquisitionMethod,
            String originalReference,
            UUID derivativeParentId,
            Map<String, Object> aiGenerationMeta,
            Instant createdAt
    ) {}

    public record CatalogNodeRecord(
            UUID id,
            ExamFamily family,
            String variant,
            UUID sourceId,
            UUID parentId,
            String kind,
            String title,
            Integer year,
            int ordinal,
            Instant retiredAt,
            Instant createdAt
    ) {}

    public record SpecificationVersionRecord(
            UUID id,
            String logicalCode,
            int version,
            ExamFamily family,
            String variant,
            String deliveryMode,
            Map<String, Object> blueprint,
            Map<String, Object> timingPolicy,
            Map<String, Object> navigationPolicy,
            Map<String, Object> playbackPolicy,
            Map<String, Object> sourceReferences,
            String contentHash,
            Instant approvedAt,
            Instant createdAt
    ) {}

    public record RubricVersionRecord(
            UUID id,
            String logicalCode,
            int version,
            ExamFamily family,
            String skill,
            String taskFamily,
            Map<String, Object> criteria,
            Map<String, Object> ordinalScale,
            UUID provenanceId,
            String contentHash,
            Instant approvedAt,
            Instant createdAt
    ) {}

    public record CalibrationVersionRecord(
            UUID id,
            String logicalCode,
            int version,
            String method,
            String maturityStage,
            String populationDesc,
            Map<String, Object> sampleMeta,
            String comparisonGroup,
            String validationReport,
            Map<String, Object> uncertaintyModel,
            Instant approvedAt,
            Instant createdAt
    ) {}

    public record ScoringSchemeVersionRecord(
            UUID id,
            String logicalCode,
            int version,
            ExamFamily family,
            String variant,
            String scope,
            String normalizationVersion,
            Map<String, Object> rubricReferences,
            UUID calibrationId,
            Map<String, Object> mappingTable,
            Map<String, Object> aggregationRules,
            String contentHash,
            Instant approvedAt,
            Instant createdAt
    ) {}

    public record FormVersionRecord(
            UUID id,
            String logicalKey,
            int version,
            String title,
            ExamFamily family,
            String variant,
            String scope,
            UUID catalogNodeId,
            UUID specificationId,
            UUID scoringSchemeId,
            LifecycleState lifecycleState,
            UUID provenanceId,
            Long authorId,
            String contentHash,
            Instant publishedAt,
            Instant retiredAt,
            Instant createdAt,
            String primaryHealthStatus
    ) {
        public FormVersionRecord(
                UUID id, String logicalKey, int version, String title, ExamFamily family,
                String variant, String scope, UUID catalogNodeId, UUID specificationId,
                UUID scoringSchemeId, LifecycleState lifecycleState, UUID provenanceId,
                Long authorId, String contentHash, Instant publishedAt, Instant retiredAt,
                Instant createdAt
        ) {
            this(id, logicalKey, version, title, family, variant, scope, catalogNodeId,
                 specificationId, scoringSchemeId, lifecycleState, provenanceId, authorId,
                 contentHash, publishedAt, retiredAt, createdAt, null);
        }
    }

    public record SectionRecord(
            UUID id,
            UUID formId,
            SkillType skill,
            int ordinal,
            String specSectionKey,
            UUID scoringSchemeId,
            int durationSeconds,
            Map<String, Object> timingPolicy,
            boolean isRunnable,
            String healthStatus
    ) {
        public SectionRecord(
                UUID id, UUID formId, SkillType skill, int ordinal,
                String specSectionKey, UUID scoringSchemeId, int durationSeconds,
                Map<String, Object> timingPolicy
        ) {
            this(id, formId, skill, ordinal, specSectionKey, scoringSchemeId,
                 durationSeconds, timingPolicy, true, null);
        }
    }

    public record PartRecord(
            UUID id,
            UUID sectionId,
            String partCode,
            int ordinal,
            String instructions,
            Map<String, Object> timingPolicy
    ) {}

    public record GroupVersionRecord(
            UUID id,
            String logicalGroupKey,
            int version,
            String questionType,
            String construct,
            SkillType skill,
            String topic,
            Double difficultyEstimate,
            UUID provenanceId,
            String contentHash,
            Instant createdAt
    ) {}

    public record StimulusVersionRecord(
            UUID id,
            String logicalStimulusKey,
            int version,
            String kind,
            String title,
            Map<String, Object> bodyPayload,
            UUID provenanceId,
            String contentHash,
            Instant createdAt
    ) {}

    public record ItemVersionRecord(
            UUID id,
            UUID groupId,
            String logicalItemKey,
            int version,
            String prompt,
            String interactionType,
            Map<String, Object> optionDefinitions,
            String construct,
            UUID provenanceId,
            String contentHash,
            Instant createdAt,
            Integer ordinal
    ) {
        public ItemVersionRecord(
                UUID id,
                UUID groupId,
                String logicalItemKey,
                int version,
                String prompt,
                String interactionType,
                Map<String, Object> optionDefinitions,
                String construct,
                UUID provenanceId,
                String contentHash,
                Instant createdAt
        ) {
            this(id, groupId, logicalItemKey, version, prompt, interactionType, optionDefinitions, construct, provenanceId, contentHash, createdAt, null);
        }
    }

    public record AnswerSpecRecord(
            UUID id,
            UUID itemId,
            Map<String, Object> acceptedAnswers,
            Map<String, Object> normalizationPolicy,
            int cardinality,
            Integer wordLimit,
            double creditUnits,
            String explanation,
            UUID rubricId,
            Instant createdAt
    ) {}

    public record AssetRecord(
            UUID id,
            UUID provenanceId,
            String objectKey,
            String versionId,
            String sha256Hash,
            String mimeType,
            long byteSize,
            Integer durationMs,
            String dimensions,
            String validationState,
            Instant createdAt
    ) {}

    // ─── Public Learner DTOs (Secure, no answer keys or explanations) ────────

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record CatalogFormDto(
            UUID id,
            String logicalKey,
            int version,
            String title,
            ExamFamily family,
            String variant,
            String scope,
            String collectionTitle,
            int totalDurationMinutes,
            int totalItems,
            List<String> skills,
            LifecycleState state,
            Instant publishedAt,
            // Legacy operator column; no longer sent to learners (restrict-only input of the validator).
            String primaryHealthStatus,
            // Exams Phase 2: every field below comes from ExamContentValidationService (authoritative).
            /** Skills runnable in PRACTICE. */
            List<String> runnableSkills,
            Boolean fullExamRunnable,
            Boolean contentReviewRequired,
            /** Skills that are simulation-grade (also the content condition of official evidence). */
            List<String> simulationSkills,
            /** PRACTICE and/or EXAM_SIMULATION. */
            List<String> availableModes,
            /** VALID | NEEDS_REVIEW | INVALID | UNKNOWN (concise learner-safe state, no diagnostics). */
            String validationStatus,
            List<String> practiceScopeCodes
    ) {
        /** Fail-closed default: nothing is runnable until the authoritative validation is applied. */
        public CatalogFormDto(
                UUID id, String logicalKey, int version, String title,
                ExamFamily family, String variant, String scope,
                String collectionTitle, int totalDurationMinutes, int totalItems,
                List<String> skills, LifecycleState state, Instant publishedAt
        ) {
            this(id, logicalKey, version, title, family, variant, scope,
                 collectionTitle, totalDurationMinutes, totalItems, skills, state,
                 publishedAt, null, List.of(), false, true, List.of(), List.of(), "UNKNOWN", List.of());
        }

        public CatalogFormDto(UUID id, String logicalKey, int version, String title, ExamFamily family, String variant,
                              String scope, String collectionTitle, int totalDurationMinutes, int totalItems,
                              List<String> skills, LifecycleState state, Instant publishedAt, String primaryHealthStatus,
                              List<String> runnableSkills, Boolean fullExamRunnable, Boolean contentReviewRequired,
                              List<String> simulationSkills, List<String> availableModes, String validationStatus) {
            this(id, logicalKey, version, title, family, variant, scope, collectionTitle, totalDurationMinutes, totalItems,
                    skills, state, publishedAt, primaryHealthStatus, runnableSkills, fullExamRunnable, contentReviewRequired,
                    simulationSkills, availableModes, validationStatus, List.of());
        }

        public CatalogFormDto withPracticeScopes(List<String> codes) {
            List<String> modes = availableModes;
            if (ExamBankOriginalPractice.practiceOnly(id, state, logicalKey, scope)
                    && !ExamBankOriginalPractice.wholePracticeReady(family, scope, codes)) modes = List.of();
            return new CatalogFormDto(id, logicalKey, version, title, family, variant, scope, collectionTitle,
                    totalDurationMinutes, totalItems, skills, state, publishedAt, primaryHealthStatus, runnableSkills,
                    fullExamRunnable, contentReviewRequired, simulationSkills, modes, validationStatus, codes);
        }

        public CatalogFormDto withValidation(List<String> practiceSkills, List<String> simulationReadySkills,
                                             boolean fullSimulation, boolean reviewRequired, List<String> modes,
                                             String status) {
            if (ExamBankOriginalPractice.practiceOnly(id, state, logicalKey, scope)) {
                simulationReadySkills = List.of();
                fullSimulation = false;
                modes = modes.contains("PRACTICE") ? List.of("PRACTICE") : List.of();
            }
            return new CatalogFormDto(id, logicalKey, version, title, family, variant, scope, collectionTitle,
                    totalDurationMinutes, totalItems, skills, state, publishedAt, null,
                    practiceSkills, fullSimulation, reviewRequired, simulationReadySkills, modes, status);
        }
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record FormDetailDto(
            UUID id,
            String logicalKey,
            int version,
            String title,
            ExamFamily family,
            String variant,
            String scope,
            String collectionTitle,
            int totalDurationMinutes,
            List<SectionSummaryDto> sections,
            Map<String, Object> timingPolicy,
            Map<String, Object> rules,
            boolean isLicensed,
            String attribution
    ) {}

    public record SectionSummaryDto(
            UUID id,
            SkillType skill,
            int ordinal,
            String specSectionKey,
            int durationMinutes,
            int itemCount
    ) {}

    // ─── Runtime Public Manifest DTOs (Passed during simulation) ─────────────

    public record PublicStimulusDto(
            UUID id,
            String logicalKey,
            String kind,
            String title,
            Map<String, Object> bodyPayload,
            List<PublicAssetRefDto> assets
    ) {}

    /**
     * Learner asset reference. {@code delivery} tells the runner how to resolve it (Exams Phase 4B.6): every exam asset
     * — audio, Part 1 photo, graphic, map, Task 1 visual — is fetched through {@code POST /attempts/{id}/playback-grants}
     * with its {@code assetId}; no object key / storage path is ever sent to the client. A non-VALIDATED asset is
     * refused by the grant (fail closed).
     */
    public record PublicAssetRefDto(
            UUID assetId,
            String role,
            String mimeType,
            Integer durationMs,
            String delivery
    ) {
        public static final String DELIVERY_PLAYBACK_GRANT = "PLAYBACK_GRANT";

        public PublicAssetRefDto(UUID assetId, String role, String mimeType, Integer durationMs) {
            this(assetId, role, mimeType, durationMs, assetId != null ? DELIVERY_PLAYBACK_GRANT : null);
        }
    }

    public record PublicItemDto(
            UUID id,
            String placementId,
            String logicalItemKey,
            String prompt,
            String interactionType,
            Map<String, Object> options,
            int cardinality,
            Integer wordLimit
    ) {
        @com.fasterxml.jackson.annotation.JsonProperty("optionDefinitions")
        public Map<String, Object> optionDefinitions() {
            return options;
        }
    }

    /**
     * Learner question group. {@code presentation} (Exams Phase 4B.3–4B.5, null when the group is withheld) carries the
     * printed group-level presentation exactly once: {@code kind}, {@code questions} ("15-16"), {@code instructions}
     * (printed lines), {@code stem} (shared completion template with "(n) ______" blanks), {@code layout},
     * {@code wordLimitRule}, {@code wordLimit}, {@code selection} ({count, questions} for "Choose TWO"). It never holds
     * answer keys.
     */
    public record PublicGroupDto(
            UUID id,
            String placementId,
            String logicalGroupKey,
            String questionType,
            String formKind,
            SkillType skill,
            int ordinal,
            String displayNumbering,
            List<PublicStimulusDto> stimuli,
            List<PublicItemDto> items,
            Map<String, Object> presentation
    ) {
        public PublicGroupDto(
                UUID id,
                String placementId,
                String logicalGroupKey,
                String questionType,
                String formKind,
                SkillType skill,
                int ordinal,
                String displayNumbering,
                List<PublicStimulusDto> stimuli,
                List<PublicItemDto> items
        ) {
            this(id, placementId, logicalGroupKey, questionType, formKind, skill, ordinal, displayNumbering, stimuli, items, null);
        }

        public PublicGroupDto(
                UUID id,
                String placementId,
                String logicalGroupKey,
                String questionType,
                SkillType skill,
                int ordinal,
                String displayNumbering,
                List<PublicStimulusDto> stimuli,
                List<PublicItemDto> items
        ) {
            this(id, placementId, logicalGroupKey, questionType, null, skill, ordinal, displayNumbering, stimuli, items, null);
        }
    }

    public record PublicPartDto(
            UUID id,
            String partCode,
            int ordinal,
            String instructions,
            String formKind,
            List<PublicGroupDto> groups
    ) {
        public PublicPartDto(
                UUID id,
                String partCode,
                int ordinal,
                String instructions,
                List<PublicGroupDto> groups
        ) {
            this(id, partCode, ordinal, instructions, null, groups);
        }
    }

    public record PublicSectionDto(
            UUID id,
            SkillType skill,
            int ordinal,
            String specSectionKey,
            int durationSeconds,
            Map<String, Object> timingPolicy,
            List<PublicPartDto> parts
    ) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record PublicAttemptManifestDto(
            UUID attemptId,
            UUID formId,
            ExamFamily family,
            String variant,
            String scope,
            ExamAttemptMode mode,
            String title,
            String manifestHash,
            Integer serverRevision,
            String manifestScope,
            List<PublicSectionDto> sections,
            /** Exams Phase 6: learner summary of the pinned practice scope (codes / counts / modes); null otherwise. */
            Map<String, Object> practiceScope
    ) {
        public PublicAttemptManifestDto(
                UUID attemptId,
                UUID formId,
                ExamFamily family,
                String variant,
                String scope,
                ExamAttemptMode mode,
                String title,
                String manifestHash,
                Integer serverRevision,
                String manifestScope,
                List<PublicSectionDto> sections
        ) {
            this(attemptId, formId, family, variant, scope, mode, title, manifestHash, serverRevision, manifestScope, sections, null);
        }

        public PublicAttemptManifestDto(
                UUID attemptId,
                UUID formId,
                ExamFamily family,
                String variant,
                String scope,
                ExamAttemptMode mode,
                String title,
                String manifestHash,
                List<PublicSectionDto> sections
        ) {
            this(attemptId, formId, family, variant, scope, mode, title, manifestHash, null, null, sections);
        }
    }
}
