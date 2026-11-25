package com.englishcoach.exams.content;

import com.englishcoach.exams.model.ExamContentRecords.LicenseRecord;

import java.time.Instant;
import java.util.*;

/**
 * The ONE rights decision of the Exams module (pre-Phase-8 rights checkpoint, 2026-10-04). Pure: it receives
 * persisted or packaged FACTS plus a trusted server-side BASIS and OPERATION and returns a DECISION. Both the LOCAL
 * staging path ({@link ExamProjectUsageAuthorization#stagingRightsGate}, package closure codes) and the persisted
 * runtime path ({@code ExamRightsService}, PostgreSQL licence closure + {@code exams.project_usage_authorizations})
 * call it, so the same facts always yield the same decision.
 *
 * <p>Three facts are never collapsed:
 * <ul>
 *   <li>PUBLISHER licence ({@code licenses[]} / {@code exams.licenses}) — what is known about the third-party licence.
 *       Never rewritten; {@code UNKNOWN} / {@code PENDING} stay as they are.</li>
 *   <li>PROJECT usage authorization ({@code OWNER_AUTHORIZED}) — the EnglishCoach owner's decision about project use of
 *       the repository corpus. It is not a publisher licence, not an endorsement and not a human QA approval.</li>
 *   <li>BASIS + OPERATION — chosen only by trusted server code (never by a request field, header or query parameter).
 *       Owner authorization stands in for the publisher-licence gaps ONLY under {@link Basis#OWNER_PROJECT_AUTHORIZATION_LOCAL}
 *       and never for {@link Operation#PUBLICATION}; licence validity / closure gaps are never cleared.</li>
 * </ul>
 * Rights say only "may this content be used for this operation". Content validity, QA, release (IMPORT_READY) and
 * practice readiness are separate decisions and are not implied by an ALLOWED rights decision.
 */
public final class ExamRightsDecisionPolicy {

    public static final String POLICY_VERSION = "exam-rights-policy-v2";
    /** The only import basis under which an owner authorization is recorded (V72 CHECK). */
    public static final String LOCAL_DRY_RUN_IMPORT_BASIS = "OWNER_PROJECT_AUTHORIZATION_LOCAL_DRY_RUN";
    /** Purpose keys a publisher licence must declare (same set the package validator has always used). */
    public static final Set<String> PURPOSE_KEYS = Set.of("EXAM", "SIMULATION", "PRACTICE", "CONTENT", "REDISTRIBUTION");
    /** Closure codes of a persisted form whose provenance / licence row is missing (never clearable). */
    public static final String PROVENANCE_ROW_MISSING = "RIGHTS_PROVENANCE_MISSING";
    public static final String LICENCE_ROW_MISSING = "RIGHTS_LICENCE_MISSING";

    private ExamRightsDecisionPolicy() {}

    /** Evaluation basis — fixed by trusted server code, never by learner input. */
    public enum Basis {
        /** Production / public basis: the publisher licence closure alone decides; owner authorization is ignored. */
        PUBLISHER_LICENCE,
        /** LOCAL / TEST basis: a well-formed OWNER_AUTHORIZED project authorization bound to the immutable raw corpus
         * may stand in for the publisher-licence gaps (category / legal status / rights scope / purpose). */
        OWNER_PROJECT_AUTHORIZATION_LOCAL,
        /** Owner decision 2026-10-06, chosen only after the trusted hash-pinned decision covers the corpus source. */
        OWNER_AUTHORIZED_PRODUCTION_USE
    }

    /** What the rights are asked for. */
    public enum Operation {
        /** Staging validation, owner-authorized local dry-run import, release-gate PROJECT_AUTHORIZED dimension. */
        LOCAL_STAGING_IMPORT,
        /** Attempt creation, practice scope readiness and media delivery of an IMPORTED form. */
        LEARNER_RUNTIME,
        /** Making a form PUBLISHED — never granted by an owner authorization. */
        PUBLICATION,
        PRODUCTION_IMPORT
    }

    /** Machine-readable decision reasons. */
    public enum Reason {
        PUBLISHER_LICENCE_VALID,
        RIGHTS_CLOSURE_INVALID,
        PUBLISHER_LICENCE_NOT_ESTABLISHED,
        OWNER_AUTHORIZATION_NOT_A_PUBLICATION_BASIS,
        NO_PROJECT_AUTHORIZATION,
        PROJECT_AUTHORIZATION_INVALID,
        SOURCE_NOT_BOUND_TO_RAW_CORPUS,
        AUTHORIZATION_NOT_RECORDED_FOR_LOCAL_IMPORT,
        OWNER_AUTHORIZED_LOCAL_USE,
        OWNER_AUTHORIZED_PRODUCTION_USE
    }

    /** One publisher licence row as stored (package record or {@code exams.licenses}). */
    public record LicenceFacts(String provenanceCategory, String legalStatus, boolean commercialRights,
                               boolean redistributionRights, boolean derivativeRights, Instant validFrom,
                               Instant validUntil, Set<String> permittedPurposeKeys) {
        public LicenceFacts {
            permittedPurposeKeys = permittedPurposeKeys == null ? Set.of() : Set.copyOf(permittedPurposeKeys);
        }

        public static LicenceFacts of(LicenseRecord l) {
            return new LicenceFacts(l.provenanceCategory() == null ? null : l.provenanceCategory().name(), l.legalStatus(),
                    l.commercialRights(), l.redistributionRights(), l.derivativeRights(), l.validFrom(), l.validUntil(),
                    l.permittedPurposes() == null ? Set.of() : l.permittedPurposes().keySet());
        }
    }

    /**
     * Facts of a project usage authorization, built ONLY by {@link #fromMetadata} so the package path and the persisted
     * path judge the same thing the same way. {@code recordedImportBasis} is the persisted {@code import_basis}
     * ({@code null} for a package that has not been imported).
     */
    public record ProjectAuthorizationFacts(boolean present, boolean wellFormed, String status, List<String> permits,
                                            String publisherLicence, boolean publisherEndorsement,
                                            boolean sourceBoundToRawCorpus, String recordedImportBasis, String productionImport) {
        public ProjectAuthorizationFacts(boolean present, boolean wellFormed, String status, List<String> permits,
                                         String publisherLicence, boolean publisherEndorsement,
                                         boolean sourceBoundToRawCorpus, String recordedImportBasis) {
            this(present, wellFormed, status, permits, publisherLicence, publisherEndorsement,
                    sourceBoundToRawCorpus, recordedImportBasis, null);
        }
        public ProjectAuthorizationFacts {
            permits = permits == null ? List.of() : List.copyOf(permits);
        }

        public static final ProjectAuthorizationFacts ABSENT =
                new ProjectAuthorizationFacts(false, false, null, List.of(), null, false, false, null);

        /** From a metadata map holding {@code projectUsageAuthorization} (+ {@code sourceProvenance}). */
        public static ProjectAuthorizationFacts fromMetadata(Map<String, Object> metadata, String recordedImportBasis) {
            Optional<ExamProjectUsageAuthorization> auth = ExamProjectUsageAuthorization.fromMetadata(metadata);
            if (auth.isEmpty()) return ABSENT;
            boolean wellFormed = ExamProjectUsageAuthorization.validateMetadata(metadata).isEmpty();
            Optional<ExamPackageSourceProvenance> prov = ExamPackageSourceProvenance.fromMetadata(metadata);
            boolean bound = prov.isPresent() && ExamPackageSourceProvenance.validateMetadata(metadata).isEmpty()
                    && prov.get().rawSourcePath() != null
                    && prov.get().rawSourcePath().replace('\\', '/').startsWith(ExamPackageSourceProvenance.RAW_SOURCE_ROOT)
                    && prov.get().rawSourceSha256() != null;
            ExamProjectUsageAuthorization a = auth.get();
            return new ProjectAuthorizationFacts(true, wellFormed, a.status(), a.permits(), a.publisherLicence(),
                    a.publisherEndorsement(), bound, recordedImportBasis, a.productionImport());
        }

        /** Well formed, OWNER_AUTHORIZED and permitting local staging import preparation. */
        public boolean authorizesLocalUse() {
            return present && wellFormed && ExamProjectUsageAuthorization.OWNER_AUTHORIZED.equals(status)
                    && !publisherEndorsement && permits.contains(ExamProjectUsageAuthorization.STAGING_PERMIT);
        }

        public boolean authorizesProductionUse() {
            return present && wellFormed && ExamProjectUsageAuthorization.OWNER_AUTHORIZED.equals(status)
                    && !publisherEndorsement && ExamOwnerProductionAuthorization.BASIS.equals(productionImport)
                    && permits.containsAll(List.of("PRODUCTION_IMPORT", "PUBLICATION", "LEARNER_RUNTIME",
                            "MEDIA", "SCORING", "RESULTS", "REVIEW"));
        }
    }

    /** Outcome. {@code grantedBy} is {@code PUBLISHER_LICENCE}, {@code OWNER_PROJECT_AUTHORIZATION} or {@code null}. */
    public record Decision(boolean allowed, Basis basis, Operation operation, Reason reason, String grantedBy,
                           Set<String> publisherRightsCodes, Set<String> unclearedRightsCodes,
                           boolean ownerAuthorized, boolean sourceBoundToRawCorpus) {
        public Decision {
            publisherRightsCodes = Collections.unmodifiableSet(new TreeSet<>(publisherRightsCodes));
            unclearedRightsCodes = Collections.unmodifiableSet(new TreeSet<>(unclearedRightsCodes));
        }
    }

    /**
     * Publisher-licence gap codes of one licence row, in the package validator's order. {@code quarantinableOriginalDraft}
     * is the authoring-only exemption (an ORIGINAL DRAFT package may carry PENDING legal status); runtime callers pass
     * {@code false}.
     */
    public static Set<String> publisherLicenceGaps(LicenceFacts l, Instant now, boolean quarantinableOriginalDraft) {
        Set<String> codes = new LinkedHashSet<>();
        String category = l.provenanceCategory() == null ? "" : l.provenanceCategory();
        if (!"ORIGINAL".equals(category) && !"LICENSED".equals(category)) codes.add("RIGHTS_CATEGORY_FORBIDDEN");
        if (!"APPROVED".equalsIgnoreCase(l.legalStatus()) && !quarantinableOriginalDraft) codes.add("RIGHTS_NOT_APPROVED");
        if (!l.commercialRights() || !l.redistributionRights() || !l.derivativeRights()) codes.add("RIGHTS_SCOPE_INCOMPLETE");
        if (l.validFrom() != null && now != null && l.validFrom().isAfter(now)) codes.add("RIGHTS_NOT_YET_VALID");
        if (l.validUntil() != null && now != null && !l.validUntil().isAfter(now)) codes.add("RIGHTS_EXPIRED");
        if (l.permittedPurposeKeys().stream().map(ExamRightsDecisionPolicy::normalizePurpose).noneMatch(PURPOSE_KEYS::contains)) {
            codes.add("RIGHTS_PURPOSE_REQUIRED");
        }
        return codes;
    }

    /**
     * Denial when the runtime-policy publisher-licence check failed and no owner authorization can apply (publisher
     * basis, or PUBLICATION) — the decision {@link #decide} would reach without loading any further facts.
     */
    public static Decision publisherClosureRejected(Basis basis, Operation operation) {
        Reason reason = basis == Basis.OWNER_PROJECT_AUTHORIZATION_LOCAL && operation == Operation.PUBLICATION
                ? Reason.OWNER_AUTHORIZATION_NOT_A_PUBLICATION_BASIS : Reason.PUBLISHER_LICENCE_NOT_ESTABLISHED;
        return new Decision(false, basis, operation, reason, null, Set.of(), Set.of(), false, false);
    }

    public static String normalizePurpose(String value) {
        return value == null ? "" : value.trim().toUpperCase(Locale.ROOT).replace('-', '_').replace(' ', '_');
    }

    /**
     * The decision. Only {@code RIGHTS_*} closure codes are considered: the four publisher-licence codes
     * ({@link ExamProjectUsageAuthorization#PUBLISHER_RIGHTS_CODES}) may be cleared by a project authorization; every
     * other rights code (expired / not yet valid / missing licence, provenance or source) is never cleared.
     */
    public static Decision decide(Collection<String> closureCodes, ProjectAuthorizationFacts auth, Basis basis,
                                  Operation operation) {
        Objects.requireNonNull(basis, "basis");
        Objects.requireNonNull(operation, "operation");
        ProjectAuthorizationFacts a = auth == null ? ProjectAuthorizationFacts.ABSENT : auth;
        Set<String> publisher = new TreeSet<>();
        Set<String> other = new TreeSet<>();
        for (String c : closureCodes == null ? List.<String>of() : closureCodes) {
            if (c == null) continue;
            if (ExamProjectUsageAuthorization.PUBLISHER_RIGHTS_CODES.contains(c)) publisher.add(c);
            else if (c.startsWith("RIGHTS_")) other.add(c);
        }
        boolean productionOwner = basis == Basis.OWNER_AUTHORIZED_PRODUCTION_USE;
        boolean ownerOk = productionOwner ? a.authorizesProductionUse() : a.authorizesLocalUse();
        boolean bound = a.sourceBoundToRawCorpus();

        Reason ownerDenial = null;
        if (basis != Basis.OWNER_PROJECT_AUTHORIZATION_LOCAL && !productionOwner) ownerDenial = Reason.PUBLISHER_LICENCE_NOT_ESTABLISHED;
        else if (!productionOwner && (operation == Operation.PUBLICATION || operation == Operation.PRODUCTION_IMPORT)) ownerDenial = Reason.OWNER_AUTHORIZATION_NOT_A_PUBLICATION_BASIS;
        else if (!a.present()) ownerDenial = Reason.NO_PROJECT_AUTHORIZATION;
        else if (!ownerOk) ownerDenial = Reason.PROJECT_AUTHORIZATION_INVALID;
        else if (!bound) ownerDenial = Reason.SOURCE_NOT_BOUND_TO_RAW_CORPUS;
        else if (productionOwner && (operation == Operation.LEARNER_RUNTIME || operation == Operation.PUBLICATION)
                && !ExamOwnerProductionAuthorization.BASIS.equals(a.recordedImportBasis())) {
            ownerDenial = Reason.PROJECT_AUTHORIZATION_INVALID;
        } else if (!productionOwner && operation == Operation.LEARNER_RUNTIME && !LOCAL_DRY_RUN_IMPORT_BASIS.equals(a.recordedImportBasis())) {
            ownerDenial = Reason.AUTHORIZATION_NOT_RECORDED_FOR_LOCAL_IMPORT;
        }
        boolean ownerClears = ownerDenial == null;
        // only the publisher-licence codes can be cleared, and only by an applicable owner authorization
        Set<String> uncleared = new TreeSet<>(other);
        if (!ownerClears) uncleared.addAll(publisher);
        boolean allowed = uncleared.isEmpty();

        Reason reason;
        String grantedBy = null;
        if (!other.isEmpty()) reason = Reason.RIGHTS_CLOSURE_INVALID;
        else if (publisher.isEmpty()) {
            reason = Reason.PUBLISHER_LICENCE_VALID;
            grantedBy = "PUBLISHER_LICENCE";
        } else if (ownerClears) {
            reason = productionOwner ? Reason.OWNER_AUTHORIZED_PRODUCTION_USE : Reason.OWNER_AUTHORIZED_LOCAL_USE;
            grantedBy = productionOwner ? ExamOwnerProductionAuthorization.BASIS : "OWNER_PROJECT_AUTHORIZATION";
        } else reason = ownerDenial;
        return new Decision(allowed, basis, operation, reason, grantedBy, publisher, uncleared, ownerOk, bound);
    }
}
