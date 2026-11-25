package com.englishcoach.exams.content;

import com.englishcoach.exams.config.ExamsProperties;
import com.englishcoach.exams.content.ExamRightsDecisionPolicy.*;
import com.englishcoach.exams.model.ExamAttemptRecords.CreateAttemptRequest;
import com.englishcoach.exams.model.ExamContentRecords.AssetRecord;
import com.englishcoach.exams.model.ExamContentRecords.FormVersionRecord;
import com.englishcoach.exams.model.ExamTypes.*;
import com.englishcoach.exams.practice.ExamPracticeRecords.CreatePracticeAttemptRequest;
import com.englishcoach.exams.practice.ExamPracticeRecords.PracticeAgainRequest;
import com.englishcoach.exams.repository.ExamContentRepository;
import com.englishcoach.exams.repository.ExamContentRepository.RecordedProjectAuthorization;
import com.englishcoach.exams.repository.ExamContentRepository.RightsClosureRow;
import com.englishcoach.exams.repository.ExamMediaRepository;
import com.englishcoach.exams.service.ExamRightsService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.lang.reflect.RecordComponent;
import java.time.Instant;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/**
 * Pre-Phase-8 rights checkpoint (2026-10-04): the ONE rights policy ({@link ExamRightsDecisionPolicy}) — owner project
 * authorization vs publisher licence vs trusted basis / operation — and its runtime integration in
 * {@link ExamRightsService}. Numbers refer to the checkpoint's rights test matrix.
 */
class ExamRightsDecisionPolicyTest {

    static final Instant NOW = Instant.parse("2026-10-04T00:00:00Z");
    static final Set<String> PUBLISHER = new TreeSet<>(ExamProjectUsageAuthorization.PUBLISHER_RIGHTS_CODES);

    // ─── fixtures ──────────────────────────────────────────────────────────────────────────

    static Map<String, Object> authorization() {
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

    static Map<String, Object> provenance() {
        Map<String, Object> p = new HashMap<>();
        p.put("collection", "ets");
        p.put("book", "ets-2026");
        p.put("test", "TEST_1");
        p.put("rawSourceFile", Map.of("path", "imports/source-files/toeic/ets/x.pdf", "sha256", "b".repeat(64)));
        p.put("pageRange", "2-29");
        p.put("rawManifestRef", "imports/exams/manifests/raw-source/raw_source_manifest.json#toeic/ets-2026/test-1");
        p.put("extractorName", "exam-raw-extractor");
        p.put("extractorVersion", "3.7.0");
        p.put("reviewStatus", "UNREVIEWED");
        return p;
    }

    static Map<String, Object> metadata(Map<String, Object> auth) {
        Map<String, Object> m = new HashMap<>();
        if (auth != null) m.put(ExamProjectUsageAuthorization.METADATA_KEY, auth);
        m.put(ExamPackageSourceProvenance.METADATA_KEY, provenance());
        return m;
    }

    static ProjectAuthorizationFacts owner(String recordedBasis) {
        return ProjectAuthorizationFacts.fromMetadata(metadata(authorization()), recordedBasis);
    }

    static final ProjectAuthorizationFacts RECORDED = owner(ExamRightsDecisionPolicy.LOCAL_DRY_RUN_IMPORT_BASIS);

    /** The staged corpus licence row: provenance UNKNOWN, legal PENDING, LOCAL_PRIVATE_REVIEW only. */
    static LicenceFacts stagedLicence() {
        return new LicenceFacts("UNKNOWN", "PENDING", false, false, false, null, null, Set.of("LOCAL_PRIVATE_REVIEW"));
    }

    static Decision decide(Collection<String> codes, ProjectAuthorizationFacts auth, Basis basis, Operation op) {
        return ExamRightsDecisionPolicy.decide(codes, auth, basis, op);
    }

    // ─── pure policy ───────────────────────────────────────────────────────────────────────

    @Test
    @DisplayName("01: OWNER_AUTHORIZED + explicit LOCAL owner basis → allowed for learner runtime and staging")
    void ownerLocalBasisAllows() {
        Decision runtime = decide(PUBLISHER, RECORDED, Basis.OWNER_PROJECT_AUTHORIZATION_LOCAL, Operation.LEARNER_RUNTIME);
        assertTrue(runtime.allowed());
        assertEquals(Reason.OWNER_AUTHORIZED_LOCAL_USE, runtime.reason());
        assertEquals("OWNER_PROJECT_AUTHORIZATION", runtime.grantedBy(), "granted by the owner, never by a publisher licence");
        assertEquals(PUBLISHER, runtime.publisherRightsCodes(), "publisher gaps still reported, not rewritten");
        assertTrue(decide(PUBLISHER, owner(null), Basis.OWNER_PROJECT_AUTHORIZATION_LOCAL, Operation.LOCAL_STAGING_IMPORT).allowed());
    }

    @Test
    @DisplayName("02/19: the TEST basis is the same explicit local basis; a runtime use needs the LOCAL dry-run import record")
    void testBasisNeedsLocalImportRecord() {
        Decision unrecorded = decide(PUBLISHER, owner(null), Basis.OWNER_PROJECT_AUTHORIZATION_LOCAL, Operation.LEARNER_RUNTIME);
        assertFalse(unrecorded.allowed());
        assertEquals(Reason.AUTHORIZATION_NOT_RECORDED_FOR_LOCAL_IMPORT, unrecorded.reason());
        Decision foreignBasis = decide(PUBLISHER, owner("PRODUCTION_REVIEWED_BASIS"), Basis.OWNER_PROJECT_AUTHORIZATION_LOCAL,
                Operation.LEARNER_RUNTIME);
        assertFalse(foreignBasis.allowed(), "only the local dry-run import basis counts");
    }

    @Test
    @DisplayName("03: OWNER_AUTHORIZED alone (publisher-licence basis) is not globally allowed")
    void ownerAuthorizedAloneIsNotEnough() {
        for (Operation op : Operation.values()) {
            Decision d = decide(PUBLISHER, RECORDED, Basis.PUBLISHER_LICENCE, op);
            assertFalse(d.allowed(), op.name());
            assertEquals(Reason.PUBLISHER_LICENCE_NOT_ESTABLISHED, d.reason());
            assertEquals(PUBLISHER, d.unclearedRightsCodes());
        }
    }

    @Test
    @DisplayName("04/05: production import / publication basis without a production authorization → blocked")
    void productionBlocked() {
        Decision publication = decide(PUBLISHER, RECORDED, Basis.OWNER_PROJECT_AUTHORIZATION_LOCAL, Operation.PUBLICATION);
        assertFalse(publication.allowed());
        assertEquals(Reason.OWNER_AUTHORIZATION_NOT_A_PUBLICATION_BASIS, publication.reason());
        assertFalse(ExamRightsDecisionPolicy.publisherClosureRejected(Basis.OWNER_PROJECT_AUTHORIZATION_LOCAL, Operation.PUBLICATION).allowed());
        // the production import basis is the publisher licence: owner authorization never clears it
        assertFalse(decide(PUBLISHER, RECORDED, Basis.PUBLISHER_LICENCE, Operation.LOCAL_STAGING_IMPORT).allowed());
    }

    @Test
    @DisplayName("06/07/08: publisher licence UNKNOWN / PENDING / LOCAL_PRIVATE_REVIEW stays what it is (gaps reported, never LICENSED)")
    void publisherLicenceTruthUnchanged() {
        LicenceFacts staged = stagedLicence();
        Set<String> gaps = ExamRightsDecisionPolicy.publisherLicenceGaps(staged, NOW, false);
        assertEquals(PUBLISHER, new TreeSet<>(gaps), "UNKNOWN / PENDING / no exam purpose are all publisher gaps");
        Decision d = decide(gaps, RECORDED, Basis.OWNER_PROJECT_AUTHORIZATION_LOCAL, Operation.LEARNER_RUNTIME);
        assertTrue(d.allowed());
        assertEquals("UNKNOWN", staged.provenanceCategory(), "facts are inputs only — nothing is rewritten");
        assertEquals("PENDING", staged.legalStatus());
        assertEquals(Set.of("LOCAL_PRIVATE_REVIEW"), staged.permittedPurposeKeys(), "no public distribution purpose appears");
        assertNotEquals("PUBLISHER_LICENCE", d.grantedBy());
        // an authorization claiming a publisher licence is malformed and never clears anything
        Map<String, Object> licensed = authorization();
        licensed.put("publisherLicence", "LICENSED");
        assertFalse(decide(gaps, ProjectAuthorizationFacts.fromMetadata(metadata(licensed), ExamRightsDecisionPolicy.LOCAL_DRY_RUN_IMPORT_BASIS),
                Basis.OWNER_PROJECT_AUTHORIZATION_LOCAL, Operation.LEARNER_RUNTIME).allowed());
    }

    @Test
    @DisplayName("09/10: missing, malformed or unknown authorization fails closed")
    void missingOrMalformedFailsClosed() {
        Decision none = decide(PUBLISHER, ProjectAuthorizationFacts.ABSENT, Basis.OWNER_PROJECT_AUTHORIZATION_LOCAL, Operation.LEARNER_RUNTIME);
        assertFalse(none.allowed());
        assertEquals(Reason.NO_PROJECT_AUTHORIZATION, none.reason());
        assertFalse(decide(PUBLISHER, null, Basis.OWNER_PROJECT_AUTHORIZATION_LOCAL, Operation.LEARNER_RUNTIME).allowed());
        for (Map.Entry<String, Object> broken : List.of(Map.entry("status", (Object) "SOMETHING_ELSE"),
                Map.entry("publisherEndorsement", (Object) true), Map.entry("permits", (Object) List.of("EXTRACTION")),
                Map.entry("authorizedBy", (Object) " "))) {
            Map<String, Object> a = authorization();
            a.put(broken.getKey(), broken.getValue());
            Decision d = decide(PUBLISHER, ProjectAuthorizationFacts.fromMetadata(metadata(a), ExamRightsDecisionPolicy.LOCAL_DRY_RUN_IMPORT_BASIS),
                    Basis.OWNER_PROJECT_AUTHORIZATION_LOCAL, Operation.LEARNER_RUNTIME);
            assertFalse(d.allowed(), broken.getKey());
            assertEquals(Reason.PROJECT_AUTHORIZATION_INVALID, d.reason(), broken.getKey());
        }
        Map<String, Object> notAnObject = new HashMap<>(metadata(null));
        notAnObject.put(ExamProjectUsageAuthorization.METADATA_KEY, "OWNER_AUTHORIZED");
        assertFalse(decide(PUBLISHER, ProjectAuthorizationFacts.fromMetadata(notAnObject, ExamRightsDecisionPolicy.LOCAL_DRY_RUN_IMPORT_BASIS),
                Basis.OWNER_PROJECT_AUTHORIZATION_LOCAL, Operation.LEARNER_RUNTIME).allowed());
        Map<String, Object> foreignSource = metadata(authorization());
        Map<String, Object> prov = provenance();
        prov.put("rawSourceFile", Map.of("path", "downloads/elsewhere.pdf", "sha256", "b".repeat(64)));
        foreignSource.put(ExamPackageSourceProvenance.METADATA_KEY, prov);
        Decision unbound = decide(PUBLISHER, ProjectAuthorizationFacts.fromMetadata(foreignSource, ExamRightsDecisionPolicy.LOCAL_DRY_RUN_IMPORT_BASIS),
                Basis.OWNER_PROJECT_AUTHORIZATION_LOCAL, Operation.LEARNER_RUNTIME);
        assertEquals(Reason.SOURCE_NOT_BOUND_TO_RAW_CORPUS, unbound.reason());
    }

    @Test
    @DisplayName("validity / closure gaps are never cleared (expired, not yet valid, missing licence / provenance)")
    void closureGapsNeverCleared() {
        LicenceFacts expired = new LicenceFacts("UNKNOWN", "PENDING", false, false, false, null, NOW.minusSeconds(1), Set.of());
        Set<String> codes = ExamRightsDecisionPolicy.publisherLicenceGaps(expired, NOW, false);
        assertTrue(codes.contains("RIGHTS_EXPIRED"));
        for (Collection<String> c : List.of(codes, List.of("RIGHTS_NOT_APPROVED", ExamRightsDecisionPolicy.LICENCE_ROW_MISSING),
                List.of(ExamRightsDecisionPolicy.PROVENANCE_ROW_MISSING))) {
            Decision d = decide(c, RECORDED, Basis.OWNER_PROJECT_AUTHORIZATION_LOCAL, Operation.LEARNER_RUNTIME);
            assertFalse(d.allowed(), c.toString());
            assertEquals(Reason.RIGHTS_CLOSURE_INVALID, d.reason());
        }
    }

    @Test
    @DisplayName("14: staging gate and the runtime policy agree for the same facts (one canonical decision)")
    void stagingAndRuntimeAgree() {
        ExamContentPackage.PackageManifest manifest = new ExamContentPackage.PackageManifest("1.0", "PKG", 1, "a".repeat(64),
                "extractor", "EC-EXAM-SPEC-X", "DRAFT", NOW, metadata(authorization()));
        List<Collection<String>> cases = List.of(PUBLISHER, List.of(), List.of("RIGHTS_EXPIRED"),
                List.of("RIGHTS_NOT_APPROVED", "RIGHTS_NOT_YET_VALID"), List.of("RIGHTS_PURPOSE_REQUIRED"));
        for (Collection<String> codes : cases) {
            var staging = ExamProjectUsageAuthorization.stagingRightsGate(manifest, codes);
            Decision runtime = decide(codes, owner(ExamRightsDecisionPolicy.LOCAL_DRY_RUN_IMPORT_BASIS),
                    Basis.OWNER_PROJECT_AUTHORIZATION_LOCAL, Operation.LEARNER_RUNTIME);
            assertEquals(staging.cleared(), runtime.allowed(), codes.toString());
            assertEquals(staging.publisherRightsCodes(), runtime.publisherRightsCodes(), codes.toString());
            assertEquals(staging.unclearedRightsCodes(), runtime.unclearedRightsCodes(), codes.toString());
            assertEquals(staging.ownerAuthorized(), runtime.ownerAuthorized());
        }
        // same facts without an authorization: both deny
        ExamContentPackage.PackageManifest bare = new ExamContentPackage.PackageManifest("1.0", "PKG", 1, "a".repeat(64),
                "extractor", "EC-EXAM-SPEC-X", "DRAFT", NOW, metadata(null));
        assertFalse(ExamProjectUsageAuthorization.stagingRightsGate(bare, PUBLISHER).cleared());
        assertFalse(decide(PUBLISHER, ProjectAuthorizationFacts.fromMetadata(metadata(null), ExamRightsDecisionPolicy.LOCAL_DRY_RUN_IMPORT_BASIS),
                Basis.OWNER_PROJECT_AUTHORIZATION_LOCAL, Operation.LEARNER_RUNTIME).allowed());
    }

    @Test
    @DisplayName("15: properly licensed content is allowed by its publisher licence under every basis and operation")
    void licensedContentUnchanged() {
        LicenceFacts licensed = new LicenceFacts("LICENSED", "APPROVED", true, true, true, null, null, Set.of("EXAM"));
        Set<String> gaps = ExamRightsDecisionPolicy.publisherLicenceGaps(licensed, NOW, false);
        assertTrue(gaps.isEmpty());
        for (Basis b : Basis.values()) for (Operation op : Operation.values()) {
            Decision d = decide(gaps, ProjectAuthorizationFacts.ABSENT, b, op);
            assertTrue(d.allowed());
            assertEquals("PUBLISHER_LICENCE", d.grantedBy());
        }
    }

    // ─── runtime integration (ExamRightsService) ───────────────────────────────────────────

    final ExamContentRepository repo = mock(ExamContentRepository.class);
    final ExamMediaRepository media = mock(ExamMediaRepository.class);
    final UUID formId = UUID.randomUUID();

    void persistedStagedForm(Optional<RecordedProjectAuthorization> auth) {
        when(repo.findFormById(formId)).thenReturn(Optional.of(new FormVersionRecord(formId, "f", 1, "F", ExamFamily.TOEIC,
                "LR", "FULL", UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(), LifecycleState.PILOT, UUID.randomUUID(),
                1L, "a".repeat(64), null, null, Instant.now())));
        when(repo.hasValidRightsForForm(eq(formId), any(), anyBoolean())).thenReturn(false);
        when(repo.findRightsClosureForForm(formId)).thenReturn(List.of(new RightsClosureRow(UUID.randomUUID(), true, true,
                "UNKNOWN", "PENDING", false, false, false, null, null, Set.of("LOCAL_PRIVATE_REVIEW"))));
        when(repo.findLatestProjectUsageAuthorization(formId)).thenReturn(auth);
    }

    static Optional<RecordedProjectAuthorization> recorded(String basis) {
        return Optional.of(new RecordedProjectAuthorization(metadata(authorization()), basis));
    }

    @Test
    @DisplayName("13: owner-basis runtime evaluates the persisted closure + V72 facts with the canonical policy")
    void runtimeUsesCanonicalPolicy() {
        persistedStagedForm(recorded(ExamRightsDecisionPolicy.LOCAL_DRY_RUN_IMPORT_BASIS));
        ExamRightsService owner = ExamRightsService.ownerAuthorizedLocalRuntime(repo, media, new ExamsProperties());
        Decision d = owner.evaluateFormRights(formId, Operation.LEARNER_RUNTIME).orElseThrow();
        assertTrue(d.allowed());
        assertEquals(Reason.OWNER_AUTHORIZED_LOCAL_USE, d.reason());
        assertTrue(owner.verifyFormRights(formId), "single-argument check = learner runtime");
        assertFalse(owner.verifyFormRights(formId, Operation.PUBLICATION), "05: publication never on owner authorization");
    }

    @Test
    @DisplayName("09 (persisted): no recorded authorization / foreign import basis ⇒ denied on the owner basis")
    void runtimeMissingAuthorizationDenied() {
        persistedStagedForm(Optional.empty());
        ExamRightsService owner = ExamRightsService.ownerAuthorizedLocalRuntime(repo, media, new ExamsProperties());
        assertEquals(Reason.NO_PROJECT_AUTHORIZATION, owner.evaluateFormRights(formId, Operation.LEARNER_RUNTIME).orElseThrow().reason());
        when(repo.findLatestProjectUsageAuthorization(formId)).thenReturn(recorded("SOMETHING_ELSE"));
        assertFalse(owner.verifyFormRights(formId));
    }

    @Test
    @DisplayName("Spring bean retains publisher default and refuses a recorded LOCAL owner grant")
    void springBeanIsPublisherBasis() {
        persistedStagedForm(recorded(ExamRightsDecisionPolicy.LOCAL_DRY_RUN_IMPORT_BASIS));
        ExamRightsService spring = new ExamRightsService(repo, media, new ExamsProperties());
        assertEquals(Basis.PUBLISHER_LICENCE, spring.getBasis());
        for (Operation op : Operation.values()) assertFalse(spring.verifyFormRights(formId, op), op.name());
        verify(repo, never()).findRightsClosureForForm(any());
        verify(repo, times(Operation.values().length)).findLatestProjectUsageAuthorization(formId);
    }

    @Test
    @DisplayName("media delivery: owner basis clears a staged asset only through an authorized form placing it")
    void assetRights() {
        UUID assetId = UUID.randomUUID();
        when(media.findAssetById(assetId)).thenReturn(Optional.of(new AssetRecord(assetId, UUID.randomUUID(), "k", "v1",
                "a".repeat(64), "audio/mpeg", 10L, 1000, null, "VALIDATED", Instant.now())));
        when(repo.hasValidRightsForAsset(eq(assetId), any(), anyBoolean())).thenReturn(false);
        when(repo.findRightsClosureForAsset(assetId)).thenReturn(List.of(new RightsClosureRow(UUID.randomUUID(), true, true,
                "UNKNOWN", "PENDING", false, false, false, null, null, Set.of("LOCAL_PRIVATE_REVIEW"))));
        when(repo.findFormIdsPlacingAsset(assetId)).thenReturn(List.of(formId));
        when(repo.findLatestProjectUsageAuthorization(formId)).thenReturn(recorded(ExamRightsDecisionPolicy.LOCAL_DRY_RUN_IMPORT_BASIS));
        assertFalse(new ExamRightsService(repo, media, new ExamsProperties()).isAssetAccessible(assetId, MediaPurpose.PRACTICE_AUDIO));
        assertTrue(ExamRightsService.ownerAuthorizedLocalRuntime(repo, media, new ExamsProperties())
                .isAssetAccessible(assetId, MediaPurpose.PRACTICE_AUDIO));
        when(repo.findFormIdsPlacingAsset(assetId)).thenReturn(List.of());
        assertFalse(ExamRightsService.ownerAuthorizedLocalRuntime(repo, media, new ExamsProperties())
                .isAssetAccessible(assetId, MediaPurpose.PRACTICE_AUDIO), "no authorized form places it ⇒ denied");
    }

    // ─── no bypass, no client-controlled basis ─────────────────────────────────────────────

    @Test
    @DisplayName("20/22: no generic bypass and no learner-selectable basis (server-side selection only)")
    void noBypassNoClientBasis() {
        for (Method m : ExamRightsService.class.getMethods()) {
            assertFalse(m.getName().startsWith("set"), "no mutable basis / flag: " + m.getName());
            for (Class<?> p : m.getParameterTypes()) {
                assertNotEquals(Basis.class, p, "no public method takes a basis: " + m.getName());
                assertNotEquals(boolean.class, p, "no boolean override parameter: " + m.getName());
            }
            String n = m.getName().toLowerCase(Locale.ROOT);
            for (String bad : List.of("force", "skip", "bypass", "ignore", "trust", "override")) {
                assertFalse(n.contains(bad), m.getName());
            }
        }
        for (Constructor<?> c : ExamRightsService.class.getConstructors()) {
            assertEquals(3, c.getParameterCount(), "the only public constructor is the Spring one (publisher basis)");
        }
        assertTrue(Modifier.isStatic(assertDoesNotThrow(() -> ExamRightsService.class.getMethod("ownerAuthorizedLocalRuntime",
                ExamContentRepository.class, ExamMediaRepository.class, ExamsProperties.class)).getModifiers()));
        for (Class<?> dto : List.of(CreateAttemptRequest.class, CreatePracticeAttemptRequest.class, PracticeAgainRequest.class)) {
            for (RecordComponent rc : dto.getRecordComponents()) {
                String n = rc.getName().toLowerCase(Locale.ROOT);
                for (String bad : List.of("basis", "rights", "owner", "authoriz", "skip", "bypass", "trust", "licen")) {
                    assertFalse(n.contains(bad), dto.getSimpleName() + "." + rc.getName());
                }
            }
        }
    }
}
