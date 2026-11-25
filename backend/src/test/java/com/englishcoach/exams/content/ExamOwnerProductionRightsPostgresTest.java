package com.englishcoach.exams.content;

import com.englishcoach.exams.content.ExamRightsDecisionPolicy.Operation;
import org.junit.jupiter.api.*;
import java.nio.file.Files;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static com.englishcoach.exams.content.ExamRightsPostgresTest.*;

/** Actual owner decision through canonical importer and live rights queries in disposable PostgreSQL only. */
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class ExamOwnerProductionRightsPostgresTest {
    static UUID productionForm;
    static List<String> initialLicenceTruth;

    @BeforeAll static void setup() throws Exception {
        ExamRightsPostgresTest.setUp();
        jdbc.execute(Files.readString(java.nio.file.Path.of("src/main/resources/db/migration/exams/V73__exams_owner_authorized_production_use.sql")));
        var importer = new ExamContentPackageImporter(contentRepository, new ExamContentPackageValidator(MAPPER));
        importer.setValidationService(validation);
        assertTrue(ExamOwnerProductionAuthorization.covers(camPkg));
        productionForm = importer.importPackage(camPkg, 1L).formId();
        initialLicenceTruth = licenceTruth();
    }
    @AfterAll static void close() { ExamRightsPostgresTest.tearDown(); }

    @Test @Order(1) void historicalMetadataGetsSupplementalDecisionWithoutLicenceMutation() {
        var grant = contentRepository.findLatestProjectUsageAuthorization(productionForm).orElseThrow();
        assertEquals(ExamOwnerProductionAuthorization.BASIS, grant.importBasis());
        assertTrue(ExamOwnerProductionAuthorization.coversMetadata(grant.metadata()));
        var facts = ExamRightsDecisionPolicy.ProjectAuthorizationFacts.fromMetadata(grant.metadata(), grant.importBasis());
        assertTrue(facts.authorizesProductionUse());
        assertFalse(facts.publisherEndorsement());
        assertEquals("NOT_ESTABLISHED", facts.publisherLicence());
        assertEquals(initialLicenceTruth, licenceTruth());
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM exams.licenses WHERE provenance_category = 'LICENSED'", Integer.class));
    }

    @Test @Order(2) void runtimePublicationAndBatchAgreeAndOldLocalGrantRemainsLocal() {
        for (Operation operation : List.of(Operation.LEARNER_RUNTIME, Operation.PUBLICATION, Operation.PRODUCTION_IMPORT)) {
            var decision = springRights.evaluateFormRights(productionForm, operation).orElseThrow();
            assertTrue(decision.allowed(), decision.toString());
            assertEquals(ExamRightsDecisionPolicy.Reason.OWNER_AUTHORIZED_PRODUCTION_USE, decision.reason());
            assertFalse(springRights.verifyFormRights(formId, operation));
        }
        var batch = springRights.verifyFormRightsBatch(List.of(productionForm, formId));
        assertTrue(batch.get(productionForm));
        assertFalse(batch.get(formId));
        assertEquals(initialLicenceTruth, licenceTruth());
    }

    @Test @Order(3) void sourceCoverageCannotBeClaimedForUnknownContentOrPublisherEndorsement() {
        Map<String,Object> metadata = new LinkedHashMap<>(camPkg.manifest().metadata());
        Map<String,Object> provenance = new LinkedHashMap<>((Map<String,Object>) metadata.get("sourceProvenance"));
        provenance.put("rawSourceFile", Map.of("path", "imports/source-files/future.pdf", "sha256", "0".repeat(64)));
        metadata.put("sourceProvenance", provenance);
        assertThrows(IllegalArgumentException.class, () -> ExamOwnerProductionAuthorization.productionMetadata(metadata));
        Map<String,Object> trusted = new LinkedHashMap<>(ExamOwnerProductionAuthorization.productionMetadata(camPkg.manifest().metadata()));
        Map<String,Object> auth = new LinkedHashMap<>((Map<String,Object>) trusted.get("projectUsageAuthorization"));
        auth.put("publisherEndorsement", true);
        trusted.put("projectUsageAuthorization", auth);
        assertFalse(ExamOwnerProductionAuthorization.coversMetadata(trusted));
    }

    @Test @Order(4) void expiryStillDeniesBothSingleAndBatchAndMedia() {
        UUID licence = camPkg.licenses().get(0).id();
        jdbc.update("UPDATE exams.licenses SET valid_until = clock_timestamp() - INTERVAL '1 day' WHERE id = ?", licence);
        try {
            assertFalse(springRights.verifyFormRights(productionForm));
            assertFalse(springRights.verifyFormRightsBatch(List.of(productionForm)).get(productionForm));
            for (var asset : camPkg.assets()) if (asset.provenanceId().equals(camPkg.provenances().stream()
                    .filter(p -> p.licenseId().equals(licence)).findFirst().orElseThrow().id())) {
                assertFalse(springRights.isAssetAccessible(asset.id(), com.englishcoach.exams.model.ExamTypes.MediaPurpose.PRACTICE_AUDIO));
            }
        } finally { jdbc.update("UPDATE exams.licenses SET valid_until = NULL WHERE id = ?", licence); }
    }
}
