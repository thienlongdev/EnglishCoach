package com.englishcoach.exams.content;

import com.englishcoach.exams.model.ExamContentRecords.*;
import com.englishcoach.exams.model.ExamTypes.ExamFamily;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * The transport envelope for one original, versioned form closure.
 *
 * <p>The envelope deliberately reuses the records used by the JDBC content
 * repository.  A package is therefore an authoring/import representation of
 * the existing Exams content graph, rather than a second content model.  The
 * package contains one form and all of its immutable dependencies.  Reusable
 * dependencies can be represented by the same stable ids when a package is
 * assembled by an internal tool.</p>
 */
public record ExamContentPackage(
        PackageManifest manifest,
        List<SourceRecord> sources,
        List<LicenseRecord> licenses,
        List<ProvenanceRecord> provenances,
        List<CatalogNodeRecord> catalogNodes,
        List<SpecificationVersionRecord> specifications,
        List<RubricVersionRecord> rubrics,
        List<CalibrationVersionRecord> calibrations,
        List<ScoringSchemeVersionRecord> scoringSchemes,
        FormVersionRecord form,
        List<FormComponentPlacement> formComponents,
        List<SectionRecord> sections,
        List<PartRecord> parts,
        List<GroupVersionRecord> groups,
        List<FormGroupPlacement> formGroups,
        List<StimulusVersionRecord> stimuli,
        List<GroupStimulusPlacement> groupStimuli,
        List<ItemVersionRecord> items,
        List<AnswerSpecRecord> answerSpecs,
        List<AssetRecord> assets,
        List<StimulusAssetPlacement> stimulusAssets
) {

    public ExamContentPackage {
        sources = sources == null ? List.of() : List.copyOf(sources);
        licenses = licenses == null ? List.of() : List.copyOf(licenses);
        provenances = provenances == null ? List.of() : List.copyOf(provenances);
        catalogNodes = catalogNodes == null ? List.of() : List.copyOf(catalogNodes);
        specifications = specifications == null ? List.of() : List.copyOf(specifications);
        rubrics = rubrics == null ? List.of() : List.copyOf(rubrics);
        calibrations = calibrations == null ? List.of() : List.copyOf(calibrations);
        scoringSchemes = scoringSchemes == null ? List.of() : List.copyOf(scoringSchemes);
        formComponents = formComponents == null ? List.of() : List.copyOf(formComponents);
        sections = sections == null ? List.of() : List.copyOf(sections);
        parts = parts == null ? List.of() : List.copyOf(parts);
        groups = groups == null ? List.of() : List.copyOf(groups);
        formGroups = formGroups == null ? List.of() : List.copyOf(formGroups);
        stimuli = stimuli == null ? List.of() : List.copyOf(stimuli);
        groupStimuli = groupStimuli == null ? List.of() : List.copyOf(groupStimuli);
        items = items == null ? List.of() : List.copyOf(items);
        answerSpecs = answerSpecs == null ? List.of() : List.copyOf(answerSpecs);
        assets = assets == null ? List.of() : List.copyOf(assets);
        stimulusAssets = stimulusAssets == null ? List.of() : List.copyOf(stimulusAssets);
    }

    /** Package identity and audit metadata. */
    public record PackageManifest(
            String schemaVersion,
            String packageId,
            int packageVersion,
            String contentHash,
            String creator,
            String specificationBaselineId,
            String authoringStatus,
            Instant createdAt,
            Map<String, Object> metadata
    ) {
        public PackageManifest {
            metadata = metadata == null ? Map.of() : Map.copyOf(metadata);
        }
    }

    /** A row in exams.form_components. */
    public record FormComponentPlacement(
            UUID id,
            UUID parentFormId,
            UUID childFormId,
            String role,
            int ordinal
    ) {}

    /** A row in exams.form_groups. */
    public record FormGroupPlacement(
            UUID id,
            UUID partId,
            UUID groupId,
            int ordinal,
            String displayNumbering
    ) {}

    /** A row in exams.group_stimuli. */
    public record GroupStimulusPlacement(
            UUID id,
            UUID groupId,
            UUID stimulusId,
            String role,
            int ordinal
    ) {}

    /** A row in exams.stimulus_assets. */
    public record StimulusAssetPlacement(
            UUID id,
            UUID stimulusId,
            UUID assetId,
            String role,
            int ordinal
    ) {}

    /** A persisted package import outcome. */
    public record ImportResult(
            String packageId,
            int packageVersion,
            String contentHash,
            UUID formId,
            ImportStatus status,
            boolean idempotentReplay,
            List<ValidationError> errors
    ) {
        public ImportResult {
            errors = errors == null ? List.of() : List.copyOf(errors);
        }
    }

    public enum ImportStatus {
        IMPORTED,
        ALREADY_IMPORTED,
        REJECTED
    }

    public record ValidationError(
            String path,
            String code,
            String message
    ) {}

    public record ValidationResult(
            boolean valid,
            String computedContentHash,
            List<ValidationError> errors
    ) {
        public ValidationResult {
            errors = errors == null ? List.of() : List.copyOf(errors);
        }

        public static ValidationResult valid(String hash) {
            return new ValidationResult(true, hash, List.of());
        }

        public static ValidationResult invalid(String hash, List<ValidationError> errors) {
            return new ValidationResult(false, hash, errors);
        }
    }

    /**
     * Human review evidence for the three publication gates.  This projection
     * is intentionally separate from the package envelope because reviews are
     * append-only records owned by the existing content_reviews table.
     */
    public record ReviewGateApproval(
            String gate,
            Long reviewerUserId,
            String decision,
            String reviewedClosureHash,
            Instant createdAt
    ) {}

    public record ReviewSummary(
            List<ReviewGateApproval> approvals,
            int distinctApprovedReviewers
    ) {
        public ReviewSummary {
            approvals = approvals == null ? List.of() : List.copyOf(approvals);
        }

        public boolean hasApprovedGate(String gate, String closureHash) {
            return approvals.stream().anyMatch(a -> gate.equals(a.gate())
                    && "APPROVED".equals(a.decision())
                    && closureHash != null
                    && closureHash.equals(a.reviewedClosureHash()));
        }
    }

    /** Stored import ledger row used for idempotency and concurrency fencing. */
    public record PackageImportRecord(
            UUID id,
            String packageId,
            int packageVersion,
            String schemaVersion,
            String contentHash,
            UUID formId,
            String status,
            Long importedBy,
            String creator,
            Instant createdAt,
            Instant completedAt
    ) {}

    public record QARunRecord(
            UUID id,
            UUID packageImportId,
            UUID formId,
            String checklistVersion,
            String result,
            Map<String, Object> findings,
            Long actorId,
            Instant createdAt
    ) {}

    /** Safe admin list projection; it contains no answer keys or privileged media. */
    public record AdminFormSummary(
            UUID id,
            String logicalKey,
            int version,
            String title,
            ExamFamily family,
            String variant,
            String scope,
            String lifecycleState,
            String contentHash,
            Long authorId,
            Instant createdAt,
            String packageId,
            Integer packageVersion,
            String packageStatus
    ) {}

    /** Safe source projection used by content and legal review work queues. */
    public record AdminSourceSummary(
            UUID id,
            String code,
            String name,
            String owner,
            String publisher,
            String sourceType,
            Instant retiredAt,
            Instant createdAt
    ) {}

    /** Small helper used by the score-topology validator. */
    public static boolean isFamily(ExamContentPackage pkg, ExamFamily family) {
        return pkg != null && pkg.form() != null && pkg.form().family() == family;
    }
}
