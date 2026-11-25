package com.englishcoach.exams.content;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Exams Recovery Phase 3.6H: the owner's PROJECT authorization is separate from the PUBLISHER licence. It clears
 * the rights blocker for local staging only, for raw-corpus content only, and never claims a publisher licence.
 */
class ExamProjectUsageAuthorizationTest {

    private static final List<String> PUBLISHER_CODES = List.of("RIGHTS_CATEGORY_FORBIDDEN", "RIGHTS_NOT_APPROVED",
            "RIGHTS_SCOPE_INCOMPLETE", "RIGHTS_PURPOSE_REQUIRED");

    private static ExamContentPackage.PackageManifest manifest(Map<String, Object> metadata) {
        return new ExamContentPackage.PackageManifest("1.0", "PKG", 1, "a".repeat(64), "extractor", "EC-EXAM-SPEC-X",
                "DRAFT", Instant.parse("2026-10-03T00:00:00Z"), metadata);
    }

    private static Map<String, Object> provenance(String path) {
        Map<String, Object> p = new HashMap<>();
        p.put("collection", "ets");
        p.put("book", "ets-2026");
        p.put("test", "TEST_1");
        p.put("rawSourceFile", Map.of("path", path, "sha256", "b".repeat(64)));
        p.put("pageRange", "2-29");
        p.put("rawManifestRef", "imports/exams/manifests/raw-source/raw_source_manifest.json#toeic/ets-2026/test-1");
        p.put("extractorName", "exam-raw-extractor");
        p.put("extractorVersion", "3.6.0");
        p.put("reviewStatus", "UNREVIEWED");
        return p;
    }

    private static Map<String, Object> authorization() {
        Map<String, Object> a = new HashMap<>();
        a.put("status", "OWNER_AUTHORIZED");
        a.put("scope", "ENGLISHCOACH_PROJECT_USE");
        a.put("authorizedBy", "PROJECT_OWNER");
        a.put("decisionDate", "2026-10-03");
        a.put("appliesTo", "REPOSITORY_SOURCE_CORPUS");
        a.put("permits", List.of("EXTRACTION", "CANONICAL_PACKAGE_PREPARATION", "STAGING_VALIDATION",
                "LOCAL_STAGING_IMPORT_PREPARATION"));
        a.put("productionImport", "NOT_AUTHORIZED_IN_THIS_PHASE");
        a.put("publisherLicence", "NOT_ESTABLISHED");
        a.put("publisherEndorsement", false);
        return a;
    }

    private static Map<String, Object> metadata(Map<String, Object> auth, Map<String, Object> prov) {
        Map<String, Object> m = new HashMap<>();
        if (auth != null) m.put(ExamProjectUsageAuthorization.METADATA_KEY, auth);
        if (prov != null) m.put(ExamPackageSourceProvenance.METADATA_KEY, prov);
        return m;
    }

    @Test
    @DisplayName("OWNER_AUTHORIZED raw-corpus package: staging no longer blocked by UNKNOWN/PENDING publisher state")
    void ownerAuthorizedClearsStagingRightsBlocker() {
        var m = manifest(metadata(authorization(), provenance("imports/source-files/toeic/ets/ETS 2026/READING ETS 2026.pdf")));
        assertTrue(ExamProjectUsageAuthorization.validate(m).isEmpty());
        var gate = ExamProjectUsageAuthorization.stagingRightsGate(m, PUBLISHER_CODES);
        assertTrue(gate.cleared());
        assertTrue(gate.ownerAuthorized());
        assertTrue(gate.sourceBoundToRawCorpus());
        // the publisher-licence codes are still REPORTED (the publisher state is not rewritten), only cleared for staging
        assertEquals(new java.util.TreeSet<>(PUBLISHER_CODES), gate.publisherRightsCodes());
        assertTrue(gate.unclearedRightsCodes().isEmpty());
    }

    @Test
    @DisplayName("Unrelated unknown content stays blocked: no authorization, or provenance outside the raw corpus")
    void unrelatedUnknownContentStaysBlocked() {
        var none = ExamProjectUsageAuthorization.stagingRightsGate(
                manifest(metadata(null, provenance("imports/source-files/x.pdf"))), PUBLISHER_CODES);
        assertFalse(none.cleared());
        assertFalse(none.ownerAuthorized());
        var foreign = ExamProjectUsageAuthorization.stagingRightsGate(
                manifest(metadata(authorization(), provenance("downloads/somewhere/else.pdf"))), PUBLISHER_CODES);
        assertFalse(foreign.cleared());
        assertFalse(foreign.sourceBoundToRawCorpus());
        var noProvenance = ExamProjectUsageAuthorization.stagingRightsGate(manifest(metadata(authorization(), null)), PUBLISHER_CODES);
        assertFalse(noProvenance.cleared());
    }

    @Test
    @DisplayName("Owner authorization never claims a publisher licence or endorsement")
    void noPublisherLicenceClaim() {
        Map<String, Object> licensed = authorization();
        licensed.put("publisherLicence", "LICENSED");
        assertFalse(ExamProjectUsageAuthorization.validate(manifest(metadata(licensed, null))).isEmpty());
        Map<String, Object> endorsed = authorization();
        endorsed.put("publisherEndorsement", true);
        assertFalse(ExamProjectUsageAuthorization.validate(manifest(metadata(endorsed, null))).isEmpty());
        // a malformed authorization never clears the gate
        var gate = ExamProjectUsageAuthorization.stagingRightsGate(
                manifest(metadata(endorsed, provenance("imports/source-files/x.pdf"))), PUBLISHER_CODES);
        assertFalse(gate.cleared());
    }

    @Test
    @DisplayName("Licence validity codes (expired / not yet valid) are never cleared by owner authorization")
    void validityCodesNeverCleared() {
        var m = manifest(metadata(authorization(), provenance("imports/source-files/x.pdf")));
        var gate = ExamProjectUsageAuthorization.stagingRightsGate(m, List.of("RIGHTS_NOT_APPROVED", "RIGHTS_EXPIRED"));
        assertFalse(gate.cleared());
        assertTrue(gate.unclearedRightsCodes().contains("RIGHTS_EXPIRED"));
    }

    @Test
    @DisplayName("Staging permit is required: an authorization without LOCAL_STAGING_IMPORT_PREPARATION does not clear")
    void stagingPermitRequired() {
        Map<String, Object> a = authorization();
        a.put("permits", List.of("EXTRACTION"));
        var gate = ExamProjectUsageAuthorization.stagingRightsGate(
                manifest(metadata(a, provenance("imports/source-files/x.pdf"))), PUBLISHER_CODES);
        assertFalse(gate.cleared());
    }
}
