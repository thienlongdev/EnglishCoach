package com.englishcoach.exams.content;

import com.englishcoach.exams.model.ExamContentRecords.*;
import com.englishcoach.exams.repository.ExamContentRepository;
import com.englishcoach.exams.validation.ExamContentValidationService;
import com.englishcoach.exams.validation.ExamFormValidationReport;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.*;

import static com.englishcoach.exams.content.ExamContentPackage.*;

/**
 * Imports a validated DRAFT package through the established content repository.
 * The transaction covers every dependency row, the package ledger, QA result,
 * and audit event.  A package never becomes learner-visible as a side effect of
 * import; publication still requires the existing human review gates.
 */
@Service
@RequiredArgsConstructor
public class ExamContentPackageImporter {

    private final ExamContentRepository contentRepository;
    private final ExamContentPackageValidator validator;
    /** Exams Phase 2: structural (blueprint) validation recorded in the QA run + cache invalidation. */
    private ExamContentValidationService validationService;

    @Autowired(required = false)
    public void setValidationService(ExamContentValidationService validationService) {
        this.validationService = validationService;
    }

    public ValidationResult validate(ExamContentPackage pkg) {
        return validator.validate(pkg);
    }

    public Optional<PackageImportRecord> findImport(String packageId, int packageVersion) {
        return contentRepository.findPackageImport(packageId, packageVersion, false);
    }

    /**
     * Rights basis of an import (Exams Phase 4D.4).
     * <ul>
     *   <li>{@code PUBLISHER_LICENCE} — the production basis, unchanged: every closure error (incl. publisher rights)
     *       rejects the package.</li>
     *   <li>{@code OWNER_PROJECT_AUTHORIZATION_LOCAL_DRY_RUN} — LOCAL dry-run only: the publisher-licence codes may be
     *       cleared by {@link ExamProjectUsageAuthorization#stagingRightsGate} (well-formed OWNER_AUTHORIZED block +
     *       raw-corpus provenance); the publisher licence rows are imported UNCHANGED (UNKNOWN / PENDING) and the owner
     *       authorization is recorded separately in {@code exams.project_usage_authorizations} (V72). Disabled unless
     *       {@link #setOwnerAuthorizedDryRunEnabled} was called — no Spring wiring or HTTP path enables it.</li>
     * </ul>
     */
    public enum ImportRightsBasis { PUBLISHER_LICENCE, OWNER_PROJECT_AUTHORIZATION_LOCAL_DRY_RUN, OWNER_AUTHORIZED_PRODUCTION_USE }

    private boolean ownerAuthorizedDryRunEnabled = false;

    /** Local dry-run tooling / tests only. Never called by application wiring. */
    public void setOwnerAuthorizedDryRunEnabled(boolean enabled) {
        this.ownerAuthorizedDryRunEnabled = enabled;
    }

    @Transactional
    public ImportResult importPackage(ExamContentPackage pkg, Long actorId) {
        return importPackage(pkg, actorId, ExamOwnerProductionAuthorization.covers(pkg)
                ? ImportRightsBasis.OWNER_AUTHORIZED_PRODUCTION_USE : ImportRightsBasis.PUBLISHER_LICENCE);
    }

    @Transactional
    public ImportResult importPackage(ExamContentPackage pkg, Long actorId, ImportRightsBasis basis) {
        if (actorId == null || actorId <= 0) {
            throw new IllegalArgumentException("CONTENT_IMPORT_ACTOR_REQUIRED: A real authenticated operator is required");
        }
        ValidationResult validation = validator.validate(pkg);
        ExamProjectUsageAuthorization.StagingRightsDecision ownerRights = null;
        if (basis == ImportRightsBasis.OWNER_PROJECT_AUTHORIZATION_LOCAL_DRY_RUN) {
            if (!ownerAuthorizedDryRunEnabled) {
                throw new IllegalStateException("CONTENT_IMPORT_BASIS_DISABLED: owner-authorized import is a local dry-run basis only");
            }
            List<String> codes = validation.errors().stream().map(ValidationError::code).toList();
            ExamProjectUsageAuthorization.StagingRightsDecision decision = ExamProjectUsageAuthorization.stagingRightsGate(pkg, codes);
            ownerRights = decision;
            List<ValidationError> remaining = validation.errors().stream()
                    .filter(e -> !(decision.cleared() && ExamProjectUsageAuthorization.PUBLISHER_RIGHTS_CODES.contains(e.code())))
                    .toList();
            if (!decision.cleared() || !remaining.isEmpty()) {
                throw new ExamContentPackageValidationException(remaining.isEmpty() ? validation.errors() : remaining);
            }
        } else if (basis == ImportRightsBasis.OWNER_AUTHORIZED_PRODUCTION_USE) {
            if (!ExamOwnerProductionAuthorization.covers(pkg))
                throw new IllegalStateException("CONTENT_PRODUCTION_AUTHORIZATION_NOT_COVERED");
            var facts = ExamRightsDecisionPolicy.ProjectAuthorizationFacts.fromMetadata(
                    ExamOwnerProductionAuthorization.productionMetadata(pkg.manifest().metadata()), null);
            var decision = ExamRightsDecisionPolicy.decide(validation.errors().stream().map(ValidationError::code).toList(),
                    facts, ExamRightsDecisionPolicy.Basis.OWNER_AUTHORIZED_PRODUCTION_USE,
                    ExamRightsDecisionPolicy.Operation.PRODUCTION_IMPORT);
            var remaining = validation.errors().stream().filter(e -> !(decision.allowed()
                    && ExamProjectUsageAuthorization.PUBLISHER_RIGHTS_CODES.contains(e.code()))).toList();
            if (!decision.allowed() || !remaining.isEmpty()) throw new ExamContentPackageValidationException(remaining);
            ownerRights = new ExamProjectUsageAuthorization.StagingRightsDecision(true, true, true,
                    decision.publisherRightsCodes(), decision.unclearedRightsCodes(), decision.reason().name());
        } else if (!validation.valid()) {
            throw new ExamContentPackageValidationException(validation.errors());
        }

        PackageManifest manifest = pkg.manifest();
        contentRepository.lockPackageIdentity(manifest.packageId(), manifest.packageVersion());
        Optional<PackageImportRecord> existing = contentRepository.findPackageImport(
                manifest.packageId(), manifest.packageVersion(), true);
        if (existing.isPresent()) {
            PackageImportRecord prior = existing.get();
            if (!manifest.contentHash().equalsIgnoreCase(prior.contentHash())) {
                // Exams Phase 5E: a re-extraction whose only drift is metadata (extractor version, OCR metrics) has
                // the same semantic fingerprint as the recorded import -> nothing to write; anything else conflicts
                boolean sameContent = "IMPORTED".equals(prior.status()) && contentRepository.findPackageImportIdentity(prior.id())
                        .flatMap(ExamPackageIdentity::fromMap)
                        .map(r -> r.semanticFingerprint().equals(ExamPackageIdentity.of(pkg).semanticFingerprint()))
                        .orElse(false);
                if (sameContent) {
                    return new ImportResult(manifest.packageId(), manifest.packageVersion(), prior.contentHash(),
                            prior.formId(), ImportStatus.ALREADY_IMPORTED, true, List.of());
                }
                throw new IllegalStateException("CONTENT_PACKAGE_ID_CONFLICT: package id/version already has a different content hash");
            }
            if (!"IMPORTED".equals(prior.status())) {
                throw new IllegalStateException("CONTENT_PACKAGE_IMPORT_IN_PROGRESS: retry after the existing transaction completes");
            }
            return new ImportResult(manifest.packageId(), manifest.packageVersion(), manifest.contentHash(),
                    prior.formId(), ImportStatus.ALREADY_IMPORTED, true, List.of());
        }

        Optional<FormVersionRecord> existingForm = contentRepository.findFormByLogicalKeyAndVersion(
                pkg.form().logicalKey(), pkg.form().version());
        if (existingForm.isPresent()) {
            throw new IllegalStateException("CONTENT_FORM_IDENTITY_CONFLICT: logical form version already exists; create a successor version");
        }

        contentRepository.assertPackageIdentityAvailable(pkg);
        insertGraph(pkg);

        UUID ledgerId;
        try {
            ledgerId = contentRepository.insertPackageImport(manifest, pkg.form().id(), actorId, "IMPORTING");
        } catch (DuplicateKeyException e) {
            // The advisory lock should make this unreachable in PostgreSQL.  A
            // sanitized conflict is preferable to attempting a second graph.
            throw new IllegalStateException("CONTENT_PACKAGE_ID_CONFLICT: package identity was imported concurrently", e);
        }

        boolean pendingLegalReview = pkg.licenses().stream()
                .anyMatch(license -> !"APPROVED".equalsIgnoreCase(license.legalStatus()));
        Map<String, Object> qaFindings = new LinkedHashMap<>();
        qaFindings.put("contentHash", validation.computedContentHash());
        qaFindings.put("checks", "deterministic-package-validator");
        qaFindings.put("rightsGate", pendingLegalReview ? "PENDING_LEGAL_REVIEW" : "APPROVED");
        qaFindings.put("publicationEligible", !pendingLegalReview);
        qaFindings.put("importBasis", basis.name());
        // Exams Phase 5C: deterministic source / semantic identity of what was imported (the planner's ledger)
        qaFindings.put("packageIdentity", ExamPackageIdentity.of(pkg).asMap());
        if (ownerRights != null) {
            // The publisher licence stays as imported (UNKNOWN / PENDING); the owner decision is a separate fact.
            Map<String, Object> project = new LinkedHashMap<>();
            project.put("status", ExamProjectUsageAuthorization.OWNER_AUTHORIZED);
            project.put("clearedPublisherRightsCodes", ownerRights.publisherRightsCodes());
            project.put("reason", ownerRights.reason());
            qaFindings.put("projectUsageAuthorization", project);
            contentRepository.insertProjectUsageAuthorization(pkg, actorId, basis.name());
        }
        if (validationService != null) {
            // Same rules as live content; a DRAFT may be incomplete, so this is recorded, never a rejection.
            ExamFormValidationReport structural = validationService.validatePackage(pkg);
            Map<String, Object> summary = new LinkedHashMap<>();
            summary.put("validatorVersion", structural.validatorVersion());
            summary.put("status", structural.status().name());
            summary.put("fullSimulationEligible", structural.fullSimulationEligible());
            summary.put("practiceSkills", ExamFormValidationReport.skillNames(structural.practiceSkills()));
            summary.put("codes", structural.blockingCodes());
            qaFindings.put("structuralValidation", summary);
            validationService.invalidate(pkg.form().id());
        }
        contentRepository.insertQARun(ledgerId, pkg.form().id(), ExamContentPackageValidator.QA_CHECKLIST_VERSION,
                "PASS", qaFindings, actorId);
        contentRepository.markPackageImported(ledgerId);
        contentRepository.insertAuditEvent(actorId, "CONTENT_PACKAGE_IMPORTED", "FORM_VERSION",
                pkg.form().id().toString(), null, pkg.form().contentHash(),
                "Imported original DRAFT content package " + manifest.packageId() + ":v" + manifest.packageVersion(), null);

        return new ImportResult(manifest.packageId(), manifest.packageVersion(), manifest.contentHash(),
                pkg.form().id(), ImportStatus.IMPORTED, false, List.of());
    }

    private void insertGraph(ExamContentPackage pkg) {
        for (SourceRecord source : pkg.sources()) contentRepository.insertSource(source);
        for (LicenseRecord license : pkg.licenses()) contentRepository.insertLicense(license);
        for (ProvenanceRecord provenance : pkg.provenances()) contentRepository.insertProvenance(provenance);

        // Parent catalog nodes must exist before their children.  The package
        // validator checks references; this stable order makes a package's row
        // order irrelevant to the importer.
        insertCatalogNodes(pkg.catalogNodes());
        for (SpecificationVersionRecord spec : pkg.specifications()) contentRepository.insertSpecification(spec);
        for (RubricVersionRecord rubric : pkg.rubrics()) contentRepository.insertRubric(rubric);
        for (CalibrationVersionRecord calibration : pkg.calibrations()) contentRepository.insertCalibration(calibration);
        for (ScoringSchemeVersionRecord scheme : pkg.scoringSchemes()) contentRepository.insertScoringScheme(scheme);

        contentRepository.insertFormVersion(pkg.form());
        for (FormComponentPlacement component : pkg.formComponents()) contentRepository.insertFormComponent(component);
        for (SectionRecord section : pkg.sections()) contentRepository.insertSection(section);
        for (PartRecord part : pkg.parts()) contentRepository.insertPart(part);
        for (GroupVersionRecord group : pkg.groups()) contentRepository.insertGroup(group);
        for (FormGroupPlacement placement : pkg.formGroups()) contentRepository.insertPackageFormGroup(placement);
        for (StimulusVersionRecord stimulus : pkg.stimuli()) contentRepository.insertStimulus(stimulus);
        for (GroupStimulusPlacement placement : pkg.groupStimuli()) contentRepository.insertPackageGroupStimulus(placement);
        for (ItemVersionRecord item : pkg.items()) contentRepository.insertItem(item);
        for (AssetRecord asset : pkg.assets()) contentRepository.insertAsset(asset);
        for (StimulusAssetPlacement placement : pkg.stimulusAssets()) contentRepository.insertStimulusAsset(placement);
        for (AnswerSpecRecord answer : pkg.answerSpecs()) contentRepository.insertAnswerSpec(answer);
    }

    private void insertCatalogNodes(List<CatalogNodeRecord> nodes) {
        Set<UUID> inserted = new HashSet<>();
        int remaining = nodes.size();
        while (remaining > 0) {
            boolean progressed = false;
            for (CatalogNodeRecord node : nodes) {
                if (inserted.contains(node.id())) continue;
                if (node.parentId() == null || inserted.contains(node.parentId())) {
                    contentRepository.insertCatalogNode(node);
                    inserted.add(node.id());
                    remaining--;
                    progressed = true;
                }
            }
            if (!progressed) {
                throw new IllegalStateException("CONTENT_CATALOG_CYCLE: catalog parent closure cannot be ordered");
            }
        }
    }
}
