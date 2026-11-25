package com.englishcoach.exams.content;

import java.util.*;

/**
 * Project-owner usage authorization of repository source material (Exams Recovery Phase 3.6H), carried in
 * {@code manifest.metadata.projectUsageAuthorization} next to {@link ExamPackageSourceProvenance}.
 *
 * <p>Two different facts are kept apart on purpose:
 * <ul>
 *   <li>the PUBLISHER licence ({@code licenses[]}: provenanceCategory / legalStatus) states what is known about the
 *       third-party licence — for the raw corpus {@code UNKNOWN / PENDING}. Owner authorization never rewrites it
 *       and never turns it into {@code LICENSED}, which means a verified third-party licence;</li>
 *   <li>the PROJECT authorization records that the EnglishCoach owner authorised use of the repository's own
 *       source corpus for this project. It claims no publisher licence and no publisher endorsement.</li>
 * </ul>
 *
 * <p>{@link #stagingRightsGate} lets LOCAL staging / import preparation treat {@code OWNER_AUTHORIZED} as sufficient
 * project authorization for packages whose source provenance points into the immutable raw corpus. The decision is
 * {@link ExamRightsDecisionPolicy} (shared with the persisted runtime path); the production import basis
 * ({@code PUBLISHER_LICENCE}) still requires APPROVED rights (a future, reviewed decision — see
 * docs/exams-content/EXAMS_PHASE36_TARGETED_REMEDIATION.md §8).
 *
 * <pre>
 * "projectUsageAuthorization": {
 *   "status": "OWNER_AUTHORIZED", "scope": "ENGLISHCOACH_PROJECT_USE", "authorizedBy": "PROJECT_OWNER",
 *   "decisionDate": "2026-10-03", "appliesTo": "REPOSITORY_SOURCE_CORPUS",
 *   "permits": ["EXTRACTION", "CANONICAL_PACKAGE_PREPARATION", "STAGING_VALIDATION", "LOCAL_STAGING_IMPORT_PREPARATION"],
 *   "productionImport": "NOT_AUTHORIZED_IN_THIS_PHASE",
 *   "publisherLicence": "NOT_ESTABLISHED", "publisherEndorsement": false
 * }
 * </pre>
 */
public record ExamProjectUsageAuthorization(
        String status,
        String scope,
        String authorizedBy,
        String decisionDate,
        String appliesTo,
        List<String> permits,
        String productionImport,
        String publisherLicence,
        boolean publisherEndorsement
) {

    public static final String METADATA_KEY = "projectUsageAuthorization";
    public static final String OWNER_AUTHORIZED = "OWNER_AUTHORIZED";
    public static final String STAGING_PERMIT = "LOCAL_STAGING_IMPORT_PREPARATION";
    /** What an owner authorization may say about the publisher licence: it can never assert one. */
    public static final Set<String> PUBLISHER_LICENCE_STATES = Set.of("NOT_ESTABLISHED", "UNKNOWN");
    /** Publisher-licence closure codes an owner authorization clears for staging (never structural codes). */
    public static final Set<String> PUBLISHER_RIGHTS_CODES = Set.of("RIGHTS_CATEGORY_FORBIDDEN", "RIGHTS_NOT_APPROVED",
            "RIGHTS_SCOPE_INCOMPLETE", "RIGHTS_PURPOSE_REQUIRED");

    public ExamProjectUsageAuthorization {
        permits = permits == null ? List.of() : List.copyOf(permits);
    }

    public static Optional<ExamProjectUsageAuthorization> fromManifest(ExamContentPackage.PackageManifest manifest) {
        return fromMetadata(manifest == null ? null : manifest.metadata());
    }

    /** Same view over a metadata map (a package manifest's, or one rebuilt from a persisted V72 row). */
    public static Optional<ExamProjectUsageAuthorization> fromMetadata(Map<String, Object> metadata) {
        if (metadata == null || !(metadata.get(METADATA_KEY) instanceof Map<?, ?> m)) return Optional.empty();
        List<String> permits = new ArrayList<>();
        if (m.get("permits") instanceof List<?> l) {
            for (Object o : l) if (o != null) permits.add(String.valueOf(o));
        }
        return Optional.of(new ExamProjectUsageAuthorization(str(m.get("status")), str(m.get("scope")),
                str(m.get("authorizedBy")), str(m.get("decisionDate")), str(m.get("appliesTo")), permits,
                str(m.get("productionImport")), str(m.get("publisherLicence")),
                Boolean.TRUE.equals(m.get("publisherEndorsement"))));
    }

    /** Structural errors (empty when absent or well formed). An authorization that claims a publisher licence or
     * endorsement is malformed: owner authorization is not publisher evidence. */
    public static List<ExamContentPackage.ValidationError> validate(ExamContentPackage.PackageManifest manifest) {
        return validateMetadata(manifest == null ? null : manifest.metadata());
    }

    public static List<ExamContentPackage.ValidationError> validateMetadata(Map<String, Object> metadata) {
        List<ExamContentPackage.ValidationError> errors = new ArrayList<>();
        if (metadata == null || !metadata.containsKey(METADATA_KEY)) return errors;
        String base = "manifest.metadata." + METADATA_KEY;
        Optional<ExamProjectUsageAuthorization> parsed = fromMetadata(metadata);
        if (parsed.isEmpty()) {
            errors.add(err(base, "must be an object"));
            return errors;
        }
        ExamProjectUsageAuthorization a = parsed.get();
        if (!OWNER_AUTHORIZED.equals(a.status())) errors.add(err(base + ".status", "must be " + OWNER_AUTHORIZED));
        if (blank(a.authorizedBy()) || blank(a.decisionDate()) || blank(a.scope())) {
            errors.add(err(base, "scope, authorizedBy and decisionDate are required"));
        }
        if (a.publisherEndorsement()) {
            errors.add(err(base + ".publisherEndorsement", "owner authorization never implies publisher endorsement"));
        }
        if (a.publisherLicence() == null || !PUBLISHER_LICENCE_STATES.contains(a.publisherLicence())) {
            errors.add(err(base + ".publisherLicence", "owner authorization cannot assert a publisher licence (use "
                    + new TreeSet<>(PUBLISHER_LICENCE_STATES) + "; a real licence belongs in licenses[])"));
        }
        return errors;
    }

    /** Outcome of the LOCAL staging rights gate. */
    public record StagingRightsDecision(boolean cleared, boolean ownerAuthorized, boolean sourceBoundToRawCorpus,
                                        Set<String> publisherRightsCodes, Set<String> unclearedRightsCodes,
                                        String reason) {}

    /**
     * Rights decision for local staging / import preparation: the publisher-licence codes reported by the closure
     * validator are cleared ONLY when (1) a well-formed OWNER_AUTHORIZED block permits staging import preparation and
     * (2) the package's source provenance is valid and points into the immutable raw corpus. Unrelated content (no
     * authorization, foreign provenance, malformed blocks) stays blocked; non-licence rights codes (expired /
     * not-yet-valid licences) are never cleared. The decision itself is {@link ExamRightsDecisionPolicy#decide}
     * (basis OWNER_PROJECT_AUTHORIZATION_LOCAL, operation LOCAL_STAGING_IMPORT) — the same policy the persisted runtime
     * path uses; this method only adapts the package facts and keeps the historical report wording.
     */
    public static StagingRightsDecision stagingRightsGate(ExamContentPackage pkg, Collection<String> closureErrorCodes) {
        return stagingRightsGate(pkg == null ? null : pkg.manifest(), closureErrorCodes);
    }

    public static StagingRightsDecision stagingRightsGate(ExamContentPackage.PackageManifest m,
                                                          Collection<String> closureErrorCodes) {
        ExamRightsDecisionPolicy.ProjectAuthorizationFacts facts =
                ExamRightsDecisionPolicy.ProjectAuthorizationFacts.fromMetadata(m == null ? null : m.metadata(), null);
        ExamRightsDecisionPolicy.Decision d = ExamRightsDecisionPolicy.decide(closureErrorCodes, facts,
                ExamRightsDecisionPolicy.Basis.OWNER_PROJECT_AUTHORIZATION_LOCAL,
                ExamRightsDecisionPolicy.Operation.LOCAL_STAGING_IMPORT);
        String reason;
        if (!facts.authorizesLocalUse()) {
            reason = !facts.present() ? "no project usage authorization" : "authorization malformed or does not permit staging";
        } else if (!facts.sourceBoundToRawCorpus()) {
            reason = "source provenance does not point into the immutable raw corpus";
        } else {
            reason = d.publisherRightsCodes().isEmpty() ? "no publisher-licence blocker"
                    : "publisher licence not established; project use OWNER_AUTHORIZED";
        }
        return new StagingRightsDecision(d.allowed(), facts.authorizesLocalUse(), facts.sourceBoundToRawCorpus(),
                new TreeSet<>(d.publisherRightsCodes()), new TreeSet<>(d.unclearedRightsCodes()), reason);
    }

    private static ExamContentPackage.ValidationError err(String path, String message) {
        return new ExamContentPackage.ValidationError(path, "PROJECT_AUTHORIZATION_INVALID", message);
    }

    private static String str(Object o) {
        return o == null ? null : String.valueOf(o);
    }

    private static boolean blank(String s) {
        return s == null || s.isBlank();
    }
}
