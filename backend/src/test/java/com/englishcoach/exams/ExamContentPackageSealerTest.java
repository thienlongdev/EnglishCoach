package com.englishcoach.exams;

import com.englishcoach.exams.content.ExamContentPackage;
import com.englishcoach.exams.content.ExamContentPackage.*;
import com.englishcoach.exams.content.ExamContentPackageValidator;
import com.englishcoach.exams.model.ExamContentRecords.*;
import com.englishcoach.exams.model.ExamTypes.ExamFamily;
import com.englishcoach.exams.model.ExamTypes.LifecycleState;
import com.englishcoach.exams.model.ExamTypes.ProvenanceCategory;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.api.io.TempDir;

import java.io.File;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.*;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Builds and seals the derived pilot packages (shared listening V2, Academic / GT mocks) from the V1 sources and
 * validates them. Exams Recovery Phase 4.1E: the sealed output goes to a JUnit temp directory — the test never
 * rewrites the repository pilot corpus (guarded by {@link CorpusFixturesUnchangedExtension}).
 */
@ExtendWith(CorpusFixturesUnchangedExtension.class)
public class ExamContentPackageSealerTest {

    @Test
    void sealAllNewPackages(@TempDir Path outDir) throws Exception {
        ObjectMapper mapper = new ObjectMapper().findAndRegisterModules()
                .configure(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS, false)
                .configure(SerializationFeature.INDENT_OUTPUT, true);
        ExamContentPackageValidator validator = new ExamContentPackageValidator(mapper);

        Path root = Paths.get("..", "content", "exams", "original-pilot").toRealPath();
        File ieltsDir = root.resolve("IELTS").toFile();          // read-only inputs
        File out = outDir.toFile();                              // sealed outputs (temp, never the corpus)

        // ─── 1. Build and seal IELTS_SHARED_LISTENING_PILOT_001_V2.json ─────────────
        File v1File = new File(ieltsDir, "IELTS_SHARED_LISTENING_PILOT_001_V1.json");
        ExamContentPackage v1Pkg = mapper.readValue(v1File, ExamContentPackage.class);

        // Assets
        List<AssetRecord> assets = List.of(
                new AssetRecord(
                        UUID.fromString("30000000-0000-4000-8000-0000000000a1"),
                        UUID.fromString("30000000-0000-4000-8000-000000000003"),
                        "assets/ielts_shared_listening_part1.wav",
                        "1",
                        "1a6c9f8977a210d348ae963a2cf90003f5756557638707bac701cb43897d5472",
                        "audio/wav",
                        2270330L,
                        51480,
                        null,
                        "VALIDATED",
                        null
                ),
                new AssetRecord(
                        UUID.fromString("30000000-0000-4000-8000-0000000000a2"),
                        UUID.fromString("30000000-0000-4000-8000-000000000003"),
                        "assets/ielts_shared_listening_part2.wav",
                        "1",
                        "df19121bffdd59e857812b2542bc49e50bcd1a1a5f0a1fb1ad7a87da83507ef4",
                        "audio/wav",
                        2842806L,
                        64460,
                        null,
                        "VALIDATED",
                        null
                ),
                new AssetRecord(
                        UUID.fromString("30000000-0000-4000-8000-0000000000a3"),
                        UUID.fromString("30000000-0000-4000-8000-000000000003"),
                        "assets/ielts_shared_listening_part3.wav",
                        "1",
                        "1efd1914d7a1db8ecf603e6bac2ca41d7499d967a361a54486f5f6c5c347a0ea",
                        "audio/wav",
                        3076260L,
                        69750,
                        null,
                        "VALIDATED",
                        null
                ),
                new AssetRecord(
                        UUID.fromString("30000000-0000-4000-8000-0000000000a4"),
                        UUID.fromString("30000000-0000-4000-8000-000000000003"),
                        "assets/ielts_shared_listening_part4.wav",
                        "1",
                        "b90f6720e89b0b30fa6864324ac3d17fd2f9853d0df7af0717c0a28754f6afcc",
                        "audio/wav",
                        3427174L,
                        77710,
                        null,
                        "VALIDATED",
                        null
                )
        );

        // StimulusAssetPlacements
        List<StimulusAssetPlacement> stimulusAssets = List.of(
                new StimulusAssetPlacement(
                        UUID.fromString("30000000-0000-4000-8000-0000000000b1"),
                        UUID.fromString("30000000-0000-4000-8000-000000000028"),
                        UUID.fromString("30000000-0000-4000-8000-0000000000a1"),
                        "PRIMARY_AUDIO",
                        0
                ),
                new StimulusAssetPlacement(
                        UUID.fromString("30000000-0000-4000-8000-0000000000b2"),
                        UUID.fromString("30000000-0000-4000-8000-000000000029"),
                        UUID.fromString("30000000-0000-4000-8000-0000000000a2"),
                        "PRIMARY_AUDIO",
                        0
                ),
                new StimulusAssetPlacement(
                        UUID.fromString("30000000-0000-4000-8000-0000000000b3"),
                        UUID.fromString("30000000-0000-4000-8000-00000000002a"),
                        UUID.fromString("30000000-0000-4000-8000-0000000000a3"),
                        "PRIMARY_AUDIO",
                        0
                ),
                new StimulusAssetPlacement(
                        UUID.fromString("30000000-0000-4000-8000-0000000000b4"),
                        UUID.fromString("30000000-0000-4000-8000-00000000002b"),
                        UUID.fromString("30000000-0000-4000-8000-0000000000a4"),
                        "PRIMARY_AUDIO",
                        0
                )
        );

        FormVersionRecord v2Form = new FormVersionRecord(
                v1Pkg.form().id(),
                v1Pkg.form().logicalKey(),
                2,
                "IELTS Listening - Shared Original Pilot Form (Audio Verified)",
                v1Pkg.form().family(),
                v1Pkg.form().variant(),
                v1Pkg.form().scope(),
                v1Pkg.form().catalogNodeId(),
                v1Pkg.form().specificationId(),
                v1Pkg.form().scoringSchemeId(),
                LifecycleState.DRAFT,
                v1Pkg.form().provenanceId(),
                null,
                "0000000000000000000000000000000000000000000000000000000000000000",
                null,
                null,
                null
        );

        Map<String, Object> metaV2 = new LinkedHashMap<>(v1Pkg.manifest().metadata());
        metaV2.put("audioTechnicalQA", "PASSED_22050HZ_PCM16");
        metaV2.put("audioProvenance", "SYNTHETIC_ORIGINAL_NOT_PRODUCTION_APPROVED");
        metaV2.put("audioQAStatus", "HUMAN_AUDIO_QA_REQUIRED");
        metaV2.put("assetCount", 4);

        PackageManifest v2Manifest = new PackageManifest(
                v1Pkg.manifest().schemaVersion(),
                v1Pkg.manifest().packageId(),
                2,
                "0000000000000000000000000000000000000000000000000000000000000000",
                v1Pkg.manifest().creator(),
                v1Pkg.manifest().specificationBaselineId(),
                v1Pkg.manifest().authoringStatus(),
                null,
                metaV2
        );

        ExamContentPackage v2PkgDraft = new ExamContentPackage(
                v2Manifest,
                v1Pkg.sources(),
                v1Pkg.licenses(),
                v1Pkg.provenances(),
                v1Pkg.catalogNodes(),
                v1Pkg.specifications(),
                v1Pkg.rubrics(),
                v1Pkg.calibrations(),
                v1Pkg.scoringSchemes(),
                v2Form,
                v1Pkg.formComponents(),
                v1Pkg.sections(),
                v1Pkg.parts(),
                v1Pkg.groups(),
                v1Pkg.formGroups(),
                v1Pkg.stimuli(),
                v1Pkg.groupStimuli(),
                v1Pkg.items(),
                v1Pkg.answerSpecs(),
                assets,
                stimulusAssets
        );

        String v2ComputedHash = validator.computeContentHash(v2PkgDraft);
        PackageManifest v2SealedManifest = new PackageManifest(
                v2Manifest.schemaVersion(),
                v2Manifest.packageId(),
                v2Manifest.packageVersion(),
                v2ComputedHash,
                v2Manifest.creator(),
                v2Manifest.specificationBaselineId(),
                v2Manifest.authoringStatus(),
                null,
                v2Manifest.metadata()
        );

        ExamContentPackage v2PkgSealed = new ExamContentPackage(
                v2SealedManifest,
                v2PkgDraft.sources(),
                v2PkgDraft.licenses(),
                v2PkgDraft.provenances(),
                v2PkgDraft.catalogNodes(),
                v2PkgDraft.specifications(),
                v2PkgDraft.rubrics(),
                v2PkgDraft.calibrations(),
                v2PkgDraft.scoringSchemes(),
                v2Form,
                v2PkgDraft.formComponents(),
                v2PkgDraft.sections(),
                v2PkgDraft.parts(),
                v2PkgDraft.groups(),
                v2PkgDraft.formGroups(),
                v2PkgDraft.stimuli(),
                v2PkgDraft.groupStimuli(),
                v2PkgDraft.items(),
                v2PkgDraft.answerSpecs(),
                v2PkgDraft.assets(),
                v2PkgDraft.stimulusAssets()
        );

        ValidationResult v2Val = validator.validate(v2PkgSealed);
        System.out.println("IELTS_SHARED_LISTENING_PILOT_001_V2 validation: " + v2Val.valid() + " (errors: " + v2Val.errors() + ")");
        assertTrue(v2Val.valid(), "V2 package must be valid: " + v2Val.errors());

        File v2File = new File(out, "IELTS_SHARED_LISTENING_PILOT_001_V2.json");
        mapper.writeValue(v2File, v2PkgSealed);
        System.out.println("Wrote sealed V2 package: " + v2File.getAbsolutePath() + " hash: " + v2ComputedHash);

        // ─── 2. Build IELTS_ACAD_MOCK_PILOT_001_V1.json ─────────────────────────────
        buildIeltsMock(mapper, validator, out, "ACADEMIC",
                "000000aa-0000-4000-8000-000000000007",
                "IELTS_ACAD_MOCK_PILOT_001_V1",
                "IELTS Academic Full Mock 001",
                "00000000-0000-4000-8000-000000000004", // Academic collection node
                "00000000-0000-4000-8000-000000000007", // Academic Reading formId
                "00000011-0000-4000-8000-000000000008", // Academic Writing formId
                "IELTS_ACAD_MOCK_PILOT_001_V1.json"
        );

        // ─── 3. Build IELTS_GT_MOCK_PILOT_001_V1.json ───────────────────────────────
        buildIeltsMock(mapper, validator, out, "GENERAL_TRAINING",
                "000000bb-0000-4000-8000-000000000007",
                "IELTS_GT_MOCK_PILOT_001_V1",
                "IELTS General Training Full Mock 001",
                "00000012-0000-4000-8000-000000000004", // GT collection node
                "00000012-0000-4000-8000-000000000007", // GT Reading formId
                "10000000-0000-4000-8000-000000000008", // GT Writing formId
                "IELTS_GT_MOCK_PILOT_001_V1.json"
        );

        System.out.println("ALL PACKAGES SEALED AND VALIDATED SUCCESSFULLY!");
    }

    private static void buildIeltsMock(
            ObjectMapper mapper,
            ExamContentPackageValidator validator,
            File outDir,
            String variant,
            String formIdStr,
            String logicalKey,
            String title,
            String catalogNodeIdStr,
            String readingFormIdStr,
            String writingFormIdStr,
            String outputFileName
    ) throws Exception {
        UUID sourceId = UUID.fromString("00000000-0000-4000-8000-000000000001");
        UUID licenseId = UUID.fromString("00000000-0000-4000-8000-000000000002");
        UUID provenanceId = UUID.fromString("00000000-0000-4000-8000-000000000003");
        UUID catalogNodeId = UUID.fromString(catalogNodeIdStr);
        UUID formId = UUID.fromString(formIdStr);

        UUID specId = UUID.nameUUIDFromBytes((logicalKey + "_SPEC").getBytes());
        UUID schemeId = UUID.nameUUIDFromBytes((logicalKey + "_SCHEME").getBytes());

        SourceRecord source = new SourceRecord(
                sourceId,
                "EC_INTERNAL_ORIGINAL",
                "English Coach original content",
                "English Coach",
                "English Coach",
                "INTERNAL_ORIGINAL",
                Map.of("declaration", "No external source used; format constraints only from EC-EXAM-SPEC-2026-09-10"),
                null,
                null
        );

        LicenseRecord license = new LicenseRecord(
                licenseId,
                sourceId,
                "EC-ORIGINAL-DRAFT-PENDING-LEGAL",
                ProvenanceCategory.ORIGINAL,
                true,
                true,
                true,
                Map.of("EXAM", true, "SIMULATION", true, "PRACTICE", true, "CONTENT", true, "REDISTRIBUTION", true),
                Map.of("GLOBAL", true),
                null,
                null,
                "English Coach original draft; legal review pending",
                null,
                "PENDING",
                null
        );

        ProvenanceRecord provenance = new ProvenanceRecord(
                provenanceId,
                sourceId,
                licenseId,
                "CODEX_AI_DRAFT",
                "ORIGINAL_GENERATION",
                "EC-ORIGINAL-DRAFT-NO-EXTERNAL-SOURCE",
                null,
                Map.of("generator", "GPT-6", "generatedAt", "2026-09-10", "humanReviewComplete", false),
                null
        );

        CatalogNodeRecord catalogNode = new CatalogNodeRecord(
                catalogNodeId,
                ExamFamily.IELTS,
                variant,
                sourceId,
                null,
                "COLLECTION",
                "IELTS " + variant + " original pilot drafts",
                2026,
                1,
                null,
                null
        );

        SpecificationVersionRecord spec = new SpecificationVersionRecord(
                specId,
                logicalKey + "_SPEC",
                1,
                ExamFamily.IELTS,
                variant,
                "SUITE_COORDINATION",
                Map.of("componentCount", 4, "roles", List.of("LISTENING", "READING", "WRITING", "SPEAKING")),
                Map.of("listeningMinutes", 30, "readingMinutes", 60, "writingMinutes", 60, "speakingMinutes", 15),
                Map.of("suiteNavigation", "sequential_component_forms"),
                Map.of("mode", "COMPONENT_MANAGED"),
                Map.of("baseline", "EC-EXAM-SPEC-2026-09-10"),
                "0000000000000000000000000000000000000000000000000000000000000000",
                null,
                null
        );

        ScoringSchemeVersionRecord scheme = new ScoringSchemeVersionRecord(
                schemeId,
                logicalKey + "_SCORING",
                1,
                ExamFamily.IELTS,
                variant,
                "FULL",
                "EC-NORM-V1",
                Map.of(),
                null,
                Map.of(
                        "metrics", List.of("LISTENING", "READING", "WRITING", "SPEAKING", "FULL_OVERALL"),
                        "status", "DRAFT_COORDINATION",
                        "note", "IELTS standard 4-skill band averaging; Task 2 weighted twice Task 1"
                ),
                Map.of(
                        "overallEquating", false,
                        "hasUniversalOverall", true,
                        "version", "EC-AGGREGATION-DRAFT-V1"
                ),
                "0000000000000000000000000000000000000000000000000000000000000000",
                null,
                null
        );

        FormVersionRecord form = new FormVersionRecord(
                formId,
                logicalKey,
                1,
                title,
                ExamFamily.IELTS,
                variant,
                "FULL",
                catalogNodeId,
                specId,
                schemeId,
                LifecycleState.DRAFT,
                provenanceId,
                null,
                "0000000000000000000000000000000000000000000000000000000000000000",
                null,
                null,
                null
        );

        // Component forms: Listening (shared), Reading, Writing, Speaking (shared)
        UUID listeningFormId = UUID.fromString("30000000-0000-4000-8000-000000000007");
        UUID readingFormId = UUID.fromString(readingFormIdStr);
        UUID writingFormId = UUID.fromString(writingFormIdStr);
        UUID speakingFormId = UUID.fromString("20000000-0000-4000-8000-000000000008");

        List<FormComponentPlacement> components = List.of(
                new FormComponentPlacement(UUID.nameUUIDFromBytes((formIdStr + "_comp_0").getBytes()), formId, listeningFormId, "LISTENING", 0),
                new FormComponentPlacement(UUID.nameUUIDFromBytes((formIdStr + "_comp_1").getBytes()), formId, readingFormId, "READING", 1),
                new FormComponentPlacement(UUID.nameUUIDFromBytes((formIdStr + "_comp_2").getBytes()), formId, writingFormId, "WRITING", 2),
                new FormComponentPlacement(UUID.nameUUIDFromBytes((formIdStr + "_comp_3").getBytes()), formId, speakingFormId, "SPEAKING", 3)
        );

        PackageManifest manifestDraft = new PackageManifest(
                "1.0",
                logicalKey,
                1,
                "0000000000000000000000000000000000000000000000000000000000000000",
                "English Coach Content Factory",
                "EC-EXAM-SPEC-2026-09-10",
                "DRAFT",
                null,
                Map.of("description", title, "contentScope", "IELTS_FULL_MOCK_COORDINATION")
        );

        ExamContentPackage mockPkgDraft = new ExamContentPackage(
                manifestDraft,
                List.of(source),
                List.of(license),
                List.of(provenance),
                List.of(catalogNode),
                List.of(spec),
                List.of(),
                List.of(),
                List.of(scheme),
                form,
                components,
                List.of(),
                List.of(),
                List.of(),
                List.of(),
                List.of(),
                List.of(),
                List.of(),
                List.of(),
                List.of(),
                List.of()
        );

        String computedHash = validator.computeContentHash(mockPkgDraft);
        PackageManifest sealedManifest = new PackageManifest(
                manifestDraft.schemaVersion(),
                manifestDraft.packageId(),
                manifestDraft.packageVersion(),
                computedHash,
                manifestDraft.creator(),
                manifestDraft.specificationBaselineId(),
                manifestDraft.authoringStatus(),
                null,
                manifestDraft.metadata()
        );

        ExamContentPackage sealedPkg = new ExamContentPackage(
                sealedManifest,
                mockPkgDraft.sources(),
                mockPkgDraft.licenses(),
                mockPkgDraft.provenances(),
                mockPkgDraft.catalogNodes(),
                mockPkgDraft.specifications(),
                mockPkgDraft.rubrics(),
                mockPkgDraft.calibrations(),
                mockPkgDraft.scoringSchemes(),
                form,
                mockPkgDraft.formComponents(),
                mockPkgDraft.sections(),
                mockPkgDraft.parts(),
                mockPkgDraft.groups(),
                mockPkgDraft.formGroups(),
                mockPkgDraft.stimuli(),
                mockPkgDraft.groupStimuli(),
                mockPkgDraft.items(),
                mockPkgDraft.answerSpecs(),
                mockPkgDraft.assets(),
                mockPkgDraft.stimulusAssets()
        );

        ValidationResult val = validator.validate(sealedPkg);
        System.out.println(logicalKey + " validation: " + val.valid() + " (errors: " + val.errors() + ")");
        assertTrue(val.valid(), "Package must be valid: " + val.errors());

        File outFile = new File(outDir, outputFileName);
        mapper.writeValue(outFile, sealedPkg);
        System.out.println("Wrote sealed package: " + outFile.getAbsolutePath() + " hash: " + computedHash);
    }
}
