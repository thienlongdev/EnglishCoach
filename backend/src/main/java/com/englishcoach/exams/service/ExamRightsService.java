package com.englishcoach.exams.service;

import com.englishcoach.exams.content.ExamRightsDecisionPolicy;
import com.englishcoach.exams.content.ExamOwnerProductionAuthorization;
import com.englishcoach.exams.content.ExamRightsDecisionPolicy.Basis;
import com.englishcoach.exams.content.ExamRightsDecisionPolicy.Decision;
import com.englishcoach.exams.content.ExamRightsDecisionPolicy.LicenceFacts;
import com.englishcoach.exams.content.ExamRightsDecisionPolicy.Operation;
import com.englishcoach.exams.content.ExamRightsDecisionPolicy.ProjectAuthorizationFacts;
import com.englishcoach.exams.model.ExamContentRecords.*;
import com.englishcoach.exams.model.ExamTypes.MediaPurpose;
import com.englishcoach.exams.repository.ExamContentRepository;
import com.englishcoach.exams.repository.ExamContentRepository.RightsClosureRow;
import com.englishcoach.exams.repository.ExamMediaRepository;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DataAccessException;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.*;

@Slf4j
@Service
public class ExamRightsService {

    private final ExamContentRepository contentRepository;
    private final ExamMediaRepository mediaRepository;
    private final com.englishcoach.exams.config.ExamsProperties examsProperties;
    /**
     * Rights evaluation basis of THIS instance — fixed at construction by trusted server code, never by a request,
     * header, query parameter or config key. The Spring bean first checks publisher rights, then trusted persisted
     * owner production authorization; the local override exists only for test tooling.
     */
    private final Basis basis;

    @Autowired
    public ExamRightsService(ExamContentRepository contentRepository, ExamMediaRepository mediaRepository,
                             com.englishcoach.exams.config.ExamsProperties examsProperties) {
        this(contentRepository, mediaRepository, examsProperties, Basis.PUBLISHER_LICENCE);
    }

    private ExamRightsService(ExamContentRepository contentRepository, ExamMediaRepository mediaRepository,
                              com.englishcoach.exams.config.ExamsProperties examsProperties, Basis basis) {
        this.contentRepository = contentRepository;
        this.mediaRepository = mediaRepository;
        this.examsProperties = examsProperties;
        this.basis = Objects.requireNonNull(basis);
    }

    /**
     * LOCAL / TEST tooling only (Testcontainers, local dry-run verification) — the runtime counterpart of
     * {@code ExamContentPackageImporter#setOwnerAuthorizedDryRunEnabled}: forms imported under the owner-authorized LOCAL
     * dry-run basis (V72 row) may be used for {@link Operation#LEARNER_RUNTIME}. Never used by application wiring; no
     * bean, config key or HTTP path selects it. This local basis never grants {@link Operation#PUBLICATION}.
     */
    public static ExamRightsService ownerAuthorizedLocalRuntime(ExamContentRepository contentRepository,
                                                                ExamMediaRepository mediaRepository,
                                                                com.englishcoach.exams.config.ExamsProperties examsProperties) {
        return new ExamRightsService(contentRepository, mediaRepository, examsProperties, Basis.OWNER_PROJECT_AUTHORIZATION_LOCAL);
    }

    public Basis getBasis() {
        return basis;
    }

    public boolean isLocalPrivatePolicyActive() {
        return examsProperties.getRuntimePolicy() == com.englishcoach.exams.config.ExamsProperties.ExamRuntimePolicy.LOCAL_PRIVATE
                && !examsProperties.isStrictMode();
    }

    public String getActivePolicyName() {
        return isLocalPrivatePolicyActive() ? "LOCAL_PRIVATE_RUNTIME_POLICY" : "PUBLIC_PRODUCTION_RELEASE_POLICY";
    }

    /** Learner runtime rights (attempt creation, practice readiness) — {@link Operation#LEARNER_RUNTIME}. */
    public boolean verifyFormRights(UUID formId) {
        return verifyFormRights(formId, Operation.LEARNER_RUNTIME);
    }

    public Map<UUID, Boolean> verifyFormRightsBatch(Collection<UUID> formIds) {
        if (basis != Basis.PUBLISHER_LICENCE) {
            Map<UUID, Boolean> result = new HashMap<>();
            for (UUID id : formIds) result.put(id, verifyFormRights(id));
            return result;
        }
        try {
            Instant now = Instant.now();
            Map<UUID, Boolean> result = new HashMap<>(contentRepository.validFormRights(formIds, now, isLocalPrivatePolicyActive()));
            List<UUID> denied = formIds.stream().filter(id -> !Boolean.TRUE.equals(result.get(id))).toList();
            contentRepository.validOwnerProductionFormRights(denied, now, ExamOwnerProductionAuthorization.rawHashes())
                    .forEach((id, allowed) -> { if (allowed) result.put(id, true); });
            return result;
        } catch (DataAccessException | IllegalArgumentException ex) {
            log.warn("Catalog rights batch failed closed");
            return Map.of();
        }
    }

    /**
     * Verifies that the form has valid rights for the operation:
     * - the publisher licence closure under the active runtime policy (LOCAL_PRIVATE_RUNTIME_POLICY allows PILOT forms
     *   with truthful UNKNOWN/PENDING legal status and a declared exam purpose; PUBLIC_PRODUCTION_RELEASE_POLICY requires
     *   APPROVED legal status, commercial, redistribution and derivative rights) — unchanged;
     * - otherwise, trusted persisted owner production coverage and the complete licence/provenance closure;
     * - local test instances may additionally use recorded local authorization for runtime only.
     */
    public boolean verifyFormRights(UUID formId, Operation operation) {
        return evaluateFormRights(formId, operation).map(Decision::allowed).orElse(false);
    }

    /** Full rights decision (operator diagnostics); empty when the form or its provenance is missing or a check failed. */
    public Optional<Decision> evaluateFormRights(UUID formId, Operation operation) {
        Optional<FormVersionRecord> formOpt = contentRepository.findFormById(formId);
        if (formOpt.isEmpty()) {
            return Optional.empty();
        }

        FormVersionRecord form = formOpt.get();
        if (form.provenanceId() == null) {
            // A URL, a missing provenance row, or an internal label is not a
            // rights grant. The package factory always writes explicit
            // source/license/provenance closure rows.
            log.warn("Rights denied for form {}: provenance is missing", formId);
            return Optional.empty();
        }
        try {
            boolean localPrivateMode = isLocalPrivatePolicyActive();
            log.debug("Evaluating rights for form {} under policy {} basis {} operation {}", formId, getActivePolicyName(), basis, operation);
            Instant now = Instant.now();
            if (contentRepository.hasValidRightsForForm(formId, now, localPrivateMode)) {
                return Optional.of(publisherLicenceValid(operation));
            }
            var recorded = contentRepository.findLatestProjectUsageAuthorization(formId);
            if (recorded.isPresent() && ExamOwnerProductionAuthorization.BASIS.equals(recorded.get().importBasis())
                    && ExamOwnerProductionAuthorization.coversMetadata(recorded.get().metadata())) {
                return Optional.of(ExamRightsDecisionPolicy.decide(closureCodes(contentRepository.findRightsClosureForForm(formId), now),
                        ProjectAuthorizationFacts.fromMetadata(recorded.get().metadata(), recorded.get().importBasis()),
                        Basis.OWNER_AUTHORIZED_PRODUCTION_USE, operation));
            }
            if (!ownerAuthorizationApplicable(operation)) {
                // Neither publisher closure nor trusted production authorization grants this operation.
                return Optional.of(ExamRightsDecisionPolicy.publisherClosureRejected(basis, operation));
            }
            Set<String> codes = closureCodes(contentRepository.findRightsClosureForForm(formId), now);
            return Optional.of(ExamRightsDecisionPolicy.decide(codes, recordedAuthorization(formId), basis, operation));
        } catch (DataAccessException | IllegalArgumentException e) {
            // Rights checks fail closed when an installation has not migrated
            // the complete closure or a row is malformed.
            log.warn("Rights verification failed closed for form {}: {}", formId, e.getMessage());
            return Optional.empty();
        }
    }

    /**
     * Verifies if an asset can be streamed for the given purpose (media delivery = {@link Operation#LEARNER_RUNTIME}).
     */
    public boolean isAssetAccessible(UUID assetId, MediaPurpose purpose) {
        Optional<AssetRecord> assetOpt = mediaRepository.findAssetById(assetId);
        if (assetOpt.isEmpty()) {
            return false;
        }

        AssetRecord asset = assetOpt.get();
        if (!"VALIDATED".equalsIgnoreCase(asset.validationState())) {
            log.warn("Asset {} is not in VALIDATED state: {}", assetId, asset.validationState());
            return false;
        }
        try {
            boolean localPrivateMode = isLocalPrivatePolicyActive();
            Instant now = Instant.now();
            if (contentRepository.hasValidRightsForAsset(assetId, now, localPrivateMode)) {
                return true;
            }
            // owner basis: the asset's own licence gaps may be cleared by the authorization of a form placing it
            Set<String> codes = closureCodes(contentRepository.findRightsClosureForAsset(assetId), now);
            for (UUID formId : contentRepository.findFormIdsPlacingAsset(assetId)) {
                var recorded = contentRepository.findLatestProjectUsageAuthorization(formId);
                if (recorded.isPresent() && ExamOwnerProductionAuthorization.BASIS.equals(recorded.get().importBasis())
                        && ExamOwnerProductionAuthorization.coversMetadata(recorded.get().metadata())
                        && ExamRightsDecisionPolicy.decide(codes,
                            ProjectAuthorizationFacts.fromMetadata(recorded.get().metadata(), recorded.get().importBasis()),
                            Basis.OWNER_AUTHORIZED_PRODUCTION_USE, Operation.LEARNER_RUNTIME).allowed()) return true;
                if (!ownerAuthorizationApplicable(Operation.LEARNER_RUNTIME)) continue;
                if (ExamRightsDecisionPolicy.decide(codes, recordedAuthorization(formId), basis, Operation.LEARNER_RUNTIME).allowed()) {
                    return true;
                }
            }
            return false;
        } catch (DataAccessException | IllegalArgumentException e) {
            log.warn("Asset rights verification failed closed for {}: {}", assetId, e.getMessage());
            return false;
        }
    }

    private boolean ownerAuthorizationApplicable(Operation operation) {
        return basis == Basis.OWNER_PROJECT_AUTHORIZATION_LOCAL && operation != Operation.PUBLICATION;
    }

    private Decision publisherLicenceValid(Operation operation) {
        return ExamRightsDecisionPolicy.decide(List.of(), ProjectAuthorizationFacts.ABSENT, basis, operation);
    }

    private ProjectAuthorizationFacts recordedAuthorization(UUID formId) {
        return contentRepository.findLatestProjectUsageAuthorization(formId)
                .map(r -> ProjectAuthorizationFacts.fromMetadata(r.metadata(), r.importBasis()))
                .orElse(ProjectAuthorizationFacts.ABSENT);
    }

    /** Persisted closure → rights codes with the same licence rules as the package validator. */
    static Set<String> closureCodes(List<RightsClosureRow> rows, Instant now) {
        Set<String> codes = new TreeSet<>();
        if (rows.isEmpty()) codes.add(ExamRightsDecisionPolicy.PROVENANCE_ROW_MISSING);
        for (RightsClosureRow r : rows) {
            if (r.provenanceId() == null || !r.provenanceRowPresent()) {
                codes.add(ExamRightsDecisionPolicy.PROVENANCE_ROW_MISSING);
            } else if (!r.licenceRowPresent()) {
                codes.add(ExamRightsDecisionPolicy.LICENCE_ROW_MISSING);
            } else {
                codes.addAll(ExamRightsDecisionPolicy.publisherLicenceGaps(new LicenceFacts(r.provenanceCategory(),
                        r.legalStatus(), r.commercialRights(), r.redistributionRights(), r.derivativeRights(),
                        r.validFrom(), r.validUntil(), r.permittedPurposeKeys()), now, false));
            }
        }
        return codes;
    }
}
