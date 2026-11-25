package com.englishcoach.exams;

import com.englishcoach.exams.content.ExamContentPackage;
import com.englishcoach.exams.content.ExamContentPackageValidator;
import com.englishcoach.exams.model.ExamContentRecords.*;
import com.englishcoach.exams.model.ExamTypes.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Deterministic content-factory QA cases.  The fixtures are intentionally
 * small closures, so a failure points to one contract violation instead of a
 * large form authoring fixture.
 */
class ExamContentPackageValidatorTest {

    private static final String HASH = "a".repeat(64);
    private final ExamContentPackageValidator validator = new ExamContentPackageValidator();

    @Test
    void acceptsOriginalIeltsDraftClosure() {
        ExamContentPackage.ValidationResult result = validator.validate(fixture(ExamFamily.IELTS, "ACADEMIC", "READING", "ielts"));

        assertTrue(result.valid(), () -> result.errors().toString());
    }

    @Test
    void acceptsOriginalToeicDraftClosure() {
        ExamContentPackage.ValidationResult result = validator.validate(fixture(ExamFamily.TOEIC, "LR", "READING", "toeic"));

        assertTrue(result.valid(), () -> result.errors().toString());
    }

    @Test
    void canonicalHashPinsDateSerializationAcrossObjectMapperSettings() {
        ObjectMapper timestampMapper = new ObjectMapper().findAndRegisterModules()
                .configure(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS, true);
        ObjectMapper isoMapper = new ObjectMapper().findAndRegisterModules()
                .configure(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS, false);
        ExamContentPackage packageFixture = fixture(ExamFamily.IELTS, "ACADEMIC", "READING", "mapper-stability");

        assertEquals(
                new ExamContentPackageValidator(timestampMapper).computeContentHash(packageFixture),
                new ExamContentPackageValidator(isoMapper).computeContentHash(packageFixture));
    }

    @Test
    void quarantinesPendingOriginalRightsForDraftAuthoring() {
        ExamContentPackage base = fixture(ExamFamily.IELTS, "ACADEMIC", "READING", "pending-original");
        LicenseRecord license = base.licenses().get(0);
        ExamContentPackage draft = copy(base,
                List.of(new LicenseRecord(license.id(), license.sourceId(), license.licenseCode(),
                        ProvenanceCategory.ORIGINAL, license.commercialRights(), license.redistributionRights(),
                        license.derivativeRights(), license.permittedPurposes(), license.permittedTerritories(),
                        license.validFrom(), license.validUntil(), license.attribution(), license.evidenceAssetId(),
                        "PENDING", license.createdAt())),
                base.specifications(), base.rubrics(), base.scoringSchemes(), base.answerSpecs(),
                base.stimuli(), base.assets(), base.stimulusAssets());

        ExamContentPackage.ValidationResult result = validator.validate(withHash(draft));

        assertTrue(result.valid(), () -> result.errors().toString());
    }

    @Test
    void rejectsPendingLicensedRightsEvenForDraftAuthoring() {
        ExamContentPackage base = fixture(ExamFamily.TOEIC, "LR", "READING", "pending-licensed");
        LicenseRecord license = base.licenses().get(0);
        ExamContentPackage draft = copy(base,
                List.of(new LicenseRecord(license.id(), license.sourceId(), license.licenseCode(),
                        ProvenanceCategory.LICENSED, license.commercialRights(), license.redistributionRights(),
                        license.derivativeRights(), license.permittedPurposes(), license.permittedTerritories(),
                        license.validFrom(), license.validUntil(), license.attribution(), license.evidenceAssetId(),
                        "PENDING", license.createdAt())),
                base.specifications(), base.rubrics(), base.scoringSchemes(), base.answerSpecs(),
                base.stimuli(), base.assets(), base.stimulusAssets());

        ExamContentPackage.ValidationResult result = validator.validate(withHash(draft));

        assertFalse(result.valid());
        assertHasCode(result, "RIGHTS_NOT_APPROVED");
    }

    @Test
    void rejectsBenchmarkRightsAndMissingProvenanceScope() {
        ExamContentPackage base = fixture(ExamFamily.IELTS, "ACADEMIC", "READING", "rights");
        LicenseRecord license = base.licenses().get(0);
        ExamContentPackage invalid = copy(base,
                List.of(new LicenseRecord(license.id(), license.sourceId(), license.licenseCode(),
                        ProvenanceCategory.BENCHMARK_ONLY, license.commercialRights(), license.redistributionRights(),
                        license.derivativeRights(), license.permittedPurposes(), license.permittedTerritories(),
                        license.validFrom(), license.validUntil(), license.attribution(), license.evidenceAssetId(),
                        "PENDING", license.createdAt())),
                base.specifications(), base.rubrics(), base.scoringSchemes(), base.answerSpecs(),
                base.stimuli(), base.assets(), base.stimulusAssets());

        ExamContentPackage.ValidationResult result = validator.validate(withHash(invalid));

        assertFalse(result.valid());
        assertHasCode(result, "RIGHTS_CATEGORY_FORBIDDEN");
        assertHasCode(result, "RIGHTS_NOT_APPROVED");
    }

    @Test
    void rejectsPlacedItemWithoutAnswer() {
        ExamContentPackage base = fixture(ExamFamily.IELTS, "ACADEMIC", "READING", "missing-answer");
        ExamContentPackage invalid = copy(base, base.licenses(), base.specifications(), base.rubrics(),
                base.scoringSchemes(), List.of(), base.stimuli(), base.assets(), base.stimulusAssets());

        ExamContentPackage.ValidationResult result = validator.validate(withHash(invalid));

        assertFalse(result.valid());
        assertHasCode(result, "MISSING_ANSWER");
    }

    @Test
    void rejectsBrokenAssetReferenceAndUnlinkedMedia() {
        ExamContentPackage base = fixture(ExamFamily.IELTS, "ACADEMIC", "READING", "asset");
        UUID stimulusId = id("asset-stimulus");
        StimulusVersionRecord stimulus = new StimulusVersionRecord(
                stimulusId, "asset-stimulus", 1, "AUDIO", "Prompt audio",
                Map.of("transcript", "Original prompt"), base.provenances().get(0).id(), HASH, Instant.now());
        ExamContentPackage invalid = copy(base, base.licenses(), base.specifications(), base.rubrics(),
                base.scoringSchemes(), base.answerSpecs(), List.of(stimulus), base.assets(),
                List.of(new ExamContentPackage.StimulusAssetPlacement(
                        id("broken-asset-link"), stimulusId, id("missing-asset"), "AUDIO_PROMPT", 0)));

        ExamContentPackage.ValidationResult result = validator.validate(withHash(invalid));

        assertFalse(result.valid());
        assertHasCode(result, "BROKEN_ASSET_REFERENCE");
        assertHasCode(result, "REQUIRED_ASSET_MISSING");
    }

    @Test
    void rejectsCrossFamilyRubric() {
        ExamContentPackage base = fixture(ExamFamily.IELTS, "ACADEMIC", "READING", "rubric");
        RubricVersionRecord rubric = new RubricVersionRecord(
                id("toeic-rubric"), "toeic-writing", 1, ExamFamily.TOEIC, "READING", "objective",
                Map.of("criteria", List.of("accuracy")), Map.of("min", 0, "max", 4),
                base.provenances().get(0).id(), HASH, null, Instant.now());
        AnswerSpecRecord answer = base.answerSpecs().get(0);
        ExamContentPackage invalid = copy(base, base.licenses(), base.specifications(), List.of(rubric),
                base.scoringSchemes(), List.of(new AnswerSpecRecord(answer.id(), answer.itemId(),
                        answer.acceptedAnswers(), answer.normalizationPolicy(), answer.cardinality(), answer.wordLimit(),
                        answer.creditUnits(), answer.explanation(), rubric.id(), answer.createdAt())),
                base.stimuli(), base.assets(), base.stimulusAssets());

        ExamContentPackage.ValidationResult result = validator.validate(withHash(invalid));

        assertFalse(result.valid());
        assertHasCode(result, "RUBRIC_FAMILY_MISMATCH");
    }

    @Test
    void rejectsToeicOverallMetric() {
        ExamContentPackage base = fixture(ExamFamily.TOEIC, "LR", "READING", "score");
        ScoringSchemeVersionRecord scheme = base.scoringSchemes().get(0);
        ScoringSchemeVersionRecord invalidScheme = new ScoringSchemeVersionRecord(
                scheme.id(), scheme.logicalCode(), scheme.version(), scheme.family(), scheme.variant(), scheme.scope(),
                scheme.normalizationVersion(), scheme.rubricReferences(), scheme.calibrationId(),
                Map.of("metrics", List.of("FULL_OVERALL")), scheme.aggregationRules(), scheme.contentHash(),
                scheme.approvedAt(), scheme.createdAt());
        ExamContentPackage invalid = copy(base, base.licenses(), base.specifications(), base.rubrics(),
                List.of(invalidScheme), base.answerSpecs(), base.stimuli(), base.assets(), base.stimulusAssets());

        ExamContentPackage.ValidationResult result = validator.validate(withHash(invalid));

        assertFalse(result.valid());
        assertHasCode(result, "TOEIC_OVERALL_FORBIDDEN");
    }

    @Test
    void rejectsDuplicateStableIds() {
        ExamContentPackage base = fixture(ExamFamily.IELTS, "ACADEMIC", "READING", "duplicate");
        SourceRecord source = base.sources().get(0);
        ExamContentPackage invalid = new ExamContentPackage(base.manifest(),
                List.of(new SourceRecord(base.form().id(), source.code(), source.name(), source.owner(), source.publisher(),
                        source.sourceType(), source.referenceMeta(), source.retiredAt(), source.createdAt())),
                base.licenses(), base.provenances(), base.catalogNodes(), base.specifications(), base.rubrics(),
                base.calibrations(), base.scoringSchemes(), base.form(), base.formComponents(), base.sections(),
                base.parts(), base.groups(), base.formGroups(), base.stimuli(), base.groupStimuli(), base.items(),
                base.answerSpecs(), base.assets(), base.stimulusAssets());

        ExamContentPackage.ValidationResult result = validator.validate(withHash(invalid));

        assertFalse(result.valid());
        assertHasCode(result, "DUPLICATE_ID");
    }

    @Test
    void rejectsBlueprintCountViolation() {
        ExamContentPackage base = fixture(ExamFamily.IELTS, "ACADEMIC", "READING", "blueprint");
        SpecificationVersionRecord spec = base.specifications().get(0);
        SpecificationVersionRecord invalidSpec = new SpecificationVersionRecord(
                spec.id(), spec.logicalCode(), spec.version(), spec.family(), spec.variant(), spec.deliveryMode(),
                Map.of("sectionCount", 2, "itemCount", 1, "deliveryMode", "COMPUTER"), spec.timingPolicy(),
                spec.navigationPolicy(), spec.playbackPolicy(), spec.sourceReferences(), spec.contentHash(),
                spec.approvedAt(), spec.createdAt());
        ExamContentPackage invalid = copy(base, base.licenses(), List.of(invalidSpec), base.rubrics(),
                base.scoringSchemes(), base.answerSpecs(), base.stimuli(), base.assets(), base.stimulusAssets());

        ExamContentPackage.ValidationResult result = validator.validate(withHash(invalid));

        assertFalse(result.valid());
        assertHasCode(result, "BLUEPRINT_SECTION_COUNT_MISMATCH");
    }

    private void assertHasCode(ExamContentPackage.ValidationResult result, String code) {
        assertTrue(result.errors().stream().anyMatch(error -> code.equals(error.code())),
                () -> "Expected " + code + " in " + result.errors());
    }

    private ExamContentPackage fixture(ExamFamily family, String variant, String scope, String key) {
        Instant now = Instant.parse("2026-01-01T00:00:00Z");
        UUID sourceId = id(key + "-source");
        UUID licenseId = id(key + "-license");
        UUID provenanceId = id(key + "-provenance");
        UUID catalogId = id(key + "-catalog");
        UUID specificationId = id(key + "-specification");
        UUID schemeId = id(key + "-scheme");
        UUID formId = id(key + "-form");
        UUID sectionId = id(key + "-section");
        UUID partId = id(key + "-part");
        UUID groupId = id(key + "-group");
        UUID formGroupId = id(key + "-form-group");
        UUID itemId = id(key + "-item");
        UUID answerId = id(key + "-answer");

        SourceRecord source = new SourceRecord(sourceId, "source-" + key, "Original authoring source",
                "English Coach", "English Coach", "ORIGINAL", Map.of("reference", "internal:" + key), null, now);
        LicenseRecord license = new LicenseRecord(licenseId, sourceId, "EC-ORIGINAL-" + key,
                ProvenanceCategory.ORIGINAL, true, true, true,
                Map.of("EXAM", true, "SIMULATION", true, "PRACTICE", true), Map.of("GLOBAL", true),
                now.minusSeconds(60), null, "English Coach original", null, "APPROVED", now);
        ProvenanceRecord provenance = new ProvenanceRecord(provenanceId, sourceId, licenseId,
                "English Coach author", "ORIGINAL_AUTHORING", "urn:english-coach:" + key,
                null, Map.of("generated", false), now);
        CatalogNodeRecord catalog = new CatalogNodeRecord(catalogId, family, variant, sourceId, null,
                "COLLECTION", family.name() + " " + variant + " collection", 2026, 0, null, now);
        SpecificationVersionRecord specification = new SpecificationVersionRecord(specificationId,
                family.name().toLowerCase(Locale.ROOT) + "-" + variant.toLowerCase(Locale.ROOT), 1, family, variant,
                "COMPUTER", Map.of("sectionCount", 1, "itemCount", 1, "deliveryMode", "COMPUTER"),
                Map.of("timed", true), Map.of("backNavigation", false), Map.of("audio", "NONE"),
                Map.of("baseline", "EC-EXAM-SPEC-2026-09-10"), HASH, null, now);
        ScoringSchemeVersionRecord scheme = new ScoringSchemeVersionRecord(schemeId,
                family.name().toLowerCase(Locale.ROOT) + "-" + scope.toLowerCase(Locale.ROOT), 1, family, variant,
                scope, "raw-v1", Map.of(), null, Map.of("metrics", List.of(scope)),
                Map.of("rounding", "FORM_SPECIFIC"), HASH, null, now);
        FormVersionRecord form = new FormVersionRecord(formId, family.name().toLowerCase(Locale.ROOT) + "-" + key,
                1, family.name() + " original draft " + key, family, variant, scope, catalogId, specificationId,
                schemeId, LifecycleState.DRAFT, provenanceId, 101L, HASH, null, null, now);
        SectionRecord section = new SectionRecord(sectionId, formId, SkillType.READING, 0, "READING", schemeId,
                60 * 60, Map.of("timed", true));
        PartRecord part = new PartRecord(partId, sectionId, "PART_1", 0, "Choose one answer.", Map.of());
        GroupVersionRecord group = new GroupVersionRecord(groupId, key + "-group", 1, "MULTIPLE_CHOICE",
                "reading_accuracy", SkillType.READING, "general", 0.5, provenanceId, HASH, now);
        ExamContentPackage.FormGroupPlacement formGroup = new ExamContentPackage.FormGroupPlacement(
                formGroupId, partId, groupId, 0, "1");
        ItemVersionRecord item = new ItemVersionRecord(itemId, groupId, key + "-item", 1,
                "Which answer is correct?", "single_choice",
                Map.of("options", List.of(Map.of("id", "A", "label", "Alpha"), Map.of("id", "B", "label", "Beta"))),
                "reading_accuracy", provenanceId, HASH, now);
        AnswerSpecRecord answer = new AnswerSpecRecord(answerId, itemId, Map.of("values", List.of("A")),
                Map.of("caseSensitive", false), 1, null, 1.0, "The answer is A.", null, now);

        return withHash(new ExamContentPackage(
                new ExamContentPackage.PackageManifest("1.0", "pkg-" + key, 1, "", "author-" + key,
                        "EC-EXAM-SPEC-2026-09-10", "DRAFT", now, Map.of("tier", "original")),
                List.of(source), List.of(license), List.of(provenance), List.of(catalog), List.of(specification),
                List.of(), List.of(), List.of(scheme), form, List.of(), List.of(section), List.of(part), List.of(group),
                List.of(formGroup), List.of(), List.of(), List.of(item), List.of(answer), List.of(), List.of()));
    }

    private ExamContentPackage copy(ExamContentPackage base,
                                    List<LicenseRecord> licenses,
                                    List<SpecificationVersionRecord> specifications,
                                    List<RubricVersionRecord> rubrics,
                                    List<ScoringSchemeVersionRecord> scoringSchemes,
                                    List<AnswerSpecRecord> answerSpecs,
                                    List<StimulusVersionRecord> stimuli,
                                    List<AssetRecord> assets,
                                    List<ExamContentPackage.StimulusAssetPlacement> stimulusAssets) {
        return new ExamContentPackage(base.manifest(), base.sources(), licenses, base.provenances(), base.catalogNodes(),
                specifications, rubrics, base.calibrations(), scoringSchemes, base.form(), base.formComponents(),
                base.sections(), base.parts(), base.groups(), base.formGroups(), stimuli, base.groupStimuli(),
                base.items(), answerSpecs, assets, stimulusAssets);
    }

    private ExamContentPackage withHash(ExamContentPackage raw) {
        String hash = validator.computeContentHash(raw);
        ExamContentPackage.PackageManifest manifest = raw.manifest();
        ExamContentPackage.PackageManifest hashed = new ExamContentPackage.PackageManifest(
                manifest.schemaVersion(), manifest.packageId(), manifest.packageVersion(), hash, manifest.creator(),
                manifest.specificationBaselineId(), manifest.authoringStatus(), manifest.createdAt(), manifest.metadata());
        return new ExamContentPackage(hashed, raw.sources(), raw.licenses(), raw.provenances(), raw.catalogNodes(),
                raw.specifications(), raw.rubrics(), raw.calibrations(), raw.scoringSchemes(), raw.form(),
                raw.formComponents(), raw.sections(), raw.parts(), raw.groups(), raw.formGroups(), raw.stimuli(),
                raw.groupStimuli(), raw.items(), raw.answerSpecs(), raw.assets(), raw.stimulusAssets());
    }

    private static UUID id(String value) {
        return UUID.nameUUIDFromBytes(value.getBytes(StandardCharsets.UTF_8));
    }
}
