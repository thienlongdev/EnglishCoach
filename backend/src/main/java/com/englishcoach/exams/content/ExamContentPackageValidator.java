package com.englishcoach.exams.content;

import com.englishcoach.exams.model.ExamContentRecords.*;
import com.englishcoach.exams.model.ExamTypes.*;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.MapperFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.*;
import java.util.regex.Pattern;

import static com.englishcoach.exams.content.ExamContentPackage.*;

/**
 * Validates a complete content package before any JDBC mutation occurs.
 *
 * <p>This validator is intentionally independent from PostgreSQL.  It checks
 * the package closure, references, rights declaration, answer completeness,
 * rubric family, score topology and the portions of a blueprint that are
 * explicitly declared by the pinned specification.  It does not invent
 * official counts when a specification has not declared them.</p>
 */
@Component
public class ExamContentPackageValidator {

    public static final String SUPPORTED_SCHEMA_VERSION = "1.0";
    public static final String REQUIRED_AUTHORING_STATUS = "DRAFT";
    public static final String QA_CHECKLIST_VERSION = "content-qa-v1";

    private static final Pattern SHA256 = Pattern.compile("[0-9a-fA-F]{64}");
    private static final Set<String> INTERACTION_TYPES = Set.of(
            "SINGLE_CHOICE", "MULTIPLE_CHOICE", "MULTIPLE_CHOICE_MULTI", "TEXT_GAP", "SHORT_ANSWER",
            "TRUTH_CLASSIFICATION", "MATCHING", "HEADING_MATCHING",
            "LABEL_ASSIGNMENT", "SENTENCE_INSERTION", "WRITING_RESPONSE",
            "SPEAKING_RESPONSE"
    );
    private static final Set<String> METRICS = Set.of(
            "LISTENING", "READING", "WRITING", "SPEAKING", "FULL_OVERALL", "LR_TOTAL"
    );

    private final ObjectMapper objectMapper;

    public ExamContentPackageValidator() {
        this(new ObjectMapper().findAndRegisterModules());
    }

    @Autowired
    public ExamContentPackageValidator(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper.copy()
                .configure(MapperFeature.SORT_PROPERTIES_ALPHABETICALLY, true)
                .configure(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS, true)
                // Package identity must not depend on a caller's date setting or indentation.
                // The authoring manifests are generated with ISO-8601 instants;
                // pin the same representation for every injected mapper.
                .configure(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS, false)
                .configure(SerializationFeature.INDENT_OUTPUT, false);
    }

    public ValidationResult validate(ExamContentPackage pkg) {
        return validate(pkg, Instant.now());
    }

    public ValidationResult validate(ExamContentPackage pkg, Instant now) {
        List<ValidationError> errors = new ArrayList<>();
        if (pkg == null) {
            errors.add(error("package", "PACKAGE_REQUIRED", "Content package is required"));
            return ValidationResult.invalid(null, errors);
        }

        String computedHash = computeContentHash(pkg);
        validateManifest(pkg, computedHash, errors);
        validateIdentityAndReferences(pkg, errors);
        validateRights(pkg, now == null ? Instant.now() : now, errors);
        validateBlueprintAndGraph(pkg, errors);
        validateAssets(pkg, errors);
        validateRubricsAndScores(pkg, errors);

        return errors.isEmpty()
                ? ValidationResult.valid(computedHash)
                : ValidationResult.invalid(computedHash, errors);
    }

    /**
     * Computes the package hash from a canonical JSON representation with the
     * declared hash removed.  This makes the hash deterministic and avoids a
     * circular hash field while retaining every other package field.
     */
    public String computeContentHash(ExamContentPackage pkg) {
        try {
            JsonNode root = objectMapper.valueToTree(pkg);
            if (root.isObject() && root.get("manifest") instanceof ObjectNode manifest) {
                manifest.remove("contentHash");
            }
            byte[] canonical = objectMapper.writeValueAsBytes(root);
            return sha256(canonical);
        } catch (Exception e) {
            throw new IllegalArgumentException("CONTENT_HASH_COMPUTATION_FAILED: " + e.getMessage(), e);
        }
    }

    private void validateManifest(ExamContentPackage pkg, String computedHash, List<ValidationError> errors) {
        PackageManifest m = pkg.manifest();
        if (m == null) {
            errors.add(error("manifest", "MANIFEST_REQUIRED", "Package manifest is required"));
            return;
        }
        if (!SUPPORTED_SCHEMA_VERSION.equals(m.schemaVersion())) {
            errors.add(error("manifest.schemaVersion", "UNSUPPORTED_SCHEMA_VERSION",
                    "Only content package schema " + SUPPORTED_SCHEMA_VERSION + " is supported"));
        }
        if (blank(m.packageId())) {
            errors.add(error("manifest.packageId", "PACKAGE_ID_REQUIRED", "packageId is required"));
        }
        if (m.packageVersion() <= 0) {
            errors.add(error("manifest.packageVersion", "PACKAGE_VERSION_INVALID", "packageVersion must be positive"));
        }
        if (blank(m.contentHash()) || !SHA256.matcher(m.contentHash()).matches()) {
            errors.add(error("manifest.contentHash", "CONTENT_HASH_REQUIRED",
                    "contentHash must be a 64-character SHA-256 hex digest"));
        } else if (!m.contentHash().equalsIgnoreCase(computedHash)) {
            errors.add(error("manifest.contentHash", "CONTENT_HASH_MISMATCH",
                    "Declared contentHash does not match the canonical package payload (computed " + computedHash + ")"));
        }
        if (blank(m.creator())) {
            errors.add(error("manifest.creator", "CREATOR_REQUIRED", "creator is required for provenance"));
        }
        if (blank(m.specificationBaselineId()) || !m.specificationBaselineId().startsWith("EC-EXAM-SPEC-")) {
            errors.add(error("manifest.specificationBaselineId", "SPECIFICATION_BASELINE_REQUIRED",
                    "A frozen EC-EXAM-SPEC-* baseline must be pinned"));
        }
        if (!REQUIRED_AUTHORING_STATUS.equalsIgnoreCase(m.authoringStatus())) {
            errors.add(error("manifest.authoringStatus", "DRAFT_ONLY",
                    "Package import accepts original DRAFT packages only"));
        }
        // Exams Phase 2: optional raw-corpus provenance (references only) must be well formed when present.
        errors.addAll(ExamPackageSourceProvenance.validate(m));
    }

    private void validateIdentityAndReferences(ExamContentPackage pkg, List<ValidationError> errors) {
        Set<UUID> allIds = new HashSet<>();
        addIds("sources", pkg.sources(), SourceRecord::id, allIds, errors);
        addIds("licenses", pkg.licenses(), LicenseRecord::id, allIds, errors);
        addIds("provenances", pkg.provenances(), ProvenanceRecord::id, allIds, errors);
        addIds("catalogNodes", pkg.catalogNodes(), CatalogNodeRecord::id, allIds, errors);
        addIds("specifications", pkg.specifications(), SpecificationVersionRecord::id, allIds, errors);
        addIds("rubrics", pkg.rubrics(), RubricVersionRecord::id, allIds, errors);
        addIds("calibrations", pkg.calibrations(), CalibrationVersionRecord::id, allIds, errors);
        addIds("scoringSchemes", pkg.scoringSchemes(), ScoringSchemeVersionRecord::id, allIds, errors);
        if (pkg.form() == null) {
            errors.add(error("form", "FORM_REQUIRED", "A package must contain exactly one form"));
        } else {
            addId("form.id", pkg.form().id(), allIds, errors);
            if (pkg.form().lifecycleState() != LifecycleState.DRAFT) {
                errors.add(error("form.lifecycleState", "DRAFT_ONLY", "Imported forms must be DRAFT"));
            }
            if (pkg.form().publishedAt() != null || pkg.form().retiredAt() != null) {
                errors.add(error("form", "DRAFT_TIMESTAMP_FORBIDDEN", "A DRAFT form cannot have publication or retirement timestamps"));
            }
        }
        addIds("formComponents", pkg.formComponents(), FormComponentPlacement::id, allIds, errors);
        addIds("sections", pkg.sections(), SectionRecord::id, allIds, errors);
        addIds("parts", pkg.parts(), PartRecord::id, allIds, errors);
        addIds("groups", pkg.groups(), GroupVersionRecord::id, allIds, errors);
        addIds("formGroups", pkg.formGroups(), FormGroupPlacement::id, allIds, errors);
        addIds("stimuli", pkg.stimuli(), StimulusVersionRecord::id, allIds, errors);
        addIds("groupStimuli", pkg.groupStimuli(), GroupStimulusPlacement::id, allIds, errors);
        addIds("items", pkg.items(), ItemVersionRecord::id, allIds, errors);
        addIds("answerSpecs", pkg.answerSpecs(), AnswerSpecRecord::id, allIds, errors);
        addIds("assets", pkg.assets(), AssetRecord::id, allIds, errors);
        addIds("stimulusAssets", pkg.stimulusAssets(), StimulusAssetPlacement::id, allIds, errors);

        Map<UUID, SourceRecord> sources = index("sources", pkg.sources(), SourceRecord::id, errors);
        Map<UUID, LicenseRecord> licenses = index("licenses", pkg.licenses(), LicenseRecord::id, errors);
        Map<UUID, ProvenanceRecord> provenances = index("provenances", pkg.provenances(), ProvenanceRecord::id, errors);
        Map<UUID, CatalogNodeRecord> catalogNodes = index("catalogNodes", pkg.catalogNodes(), CatalogNodeRecord::id, errors);
        Map<UUID, SpecificationVersionRecord> specs = index("specifications", pkg.specifications(), SpecificationVersionRecord::id, errors);
        Map<UUID, RubricVersionRecord> rubrics = index("rubrics", pkg.rubrics(), RubricVersionRecord::id, errors);
        Map<UUID, CalibrationVersionRecord> calibrations = index("calibrations", pkg.calibrations(), CalibrationVersionRecord::id, errors);
        Map<UUID, ScoringSchemeVersionRecord> schemes = index("scoringSchemes", pkg.scoringSchemes(), ScoringSchemeVersionRecord::id, errors);
        Map<UUID, SectionRecord> sections = index("sections", pkg.sections(), SectionRecord::id, errors);
        Map<UUID, PartRecord> parts = index("parts", pkg.parts(), PartRecord::id, errors);
        Map<UUID, GroupVersionRecord> groups = index("groups", pkg.groups(), GroupVersionRecord::id, errors);
        Map<UUID, StimulusVersionRecord> stimuli = index("stimuli", pkg.stimuli(), StimulusVersionRecord::id, errors);
        Map<UUID, ItemVersionRecord> items = index("items", pkg.items(), ItemVersionRecord::id, errors);
        Map<UUID, AssetRecord> assets = index("assets", pkg.assets(), AssetRecord::id, errors);

        for (LicenseRecord license : pkg.licenses()) {
            requireRef("licenses." + id(license.id()) + ".sourceId", license.sourceId(), sources, errors);
        }
        for (ProvenanceRecord provenance : pkg.provenances()) {
            requireRef("provenances." + id(provenance.id()) + ".sourceId", provenance.sourceId(), sources, errors);
            requireRef("provenances." + id(provenance.id()) + ".licenseId", provenance.licenseId(), licenses, errors);
            if (provenance.derivativeParentId() != null) {
                requireRef("provenances." + id(provenance.id()) + ".derivativeParentId", provenance.derivativeParentId(), provenances, errors);
            }
        }
        for (CatalogNodeRecord node : pkg.catalogNodes()) {
            if (node.sourceId() != null) requireRef("catalogNodes." + id(node.id()) + ".sourceId", node.sourceId(), sources, errors);
            if (node.parentId() != null) requireRef("catalogNodes." + id(node.id()) + ".parentId", node.parentId(), catalogNodes, errors);
        }
        for (SpecificationVersionRecord spec : pkg.specifications()) {
            if (spec.blueprint() == null || spec.blueprint().isEmpty()) {
                errors.add(error("specifications." + id(spec.id()) + ".blueprint", "BLUEPRINT_REQUIRED", "Specification blueprint cannot be empty"));
            }
            if (blank(spec.contentHash()) || !SHA256.matcher(spec.contentHash()).matches()) {
                errors.add(error("specifications." + id(spec.id()) + ".contentHash", "CONTENT_HASH_REQUIRED", "Specification contentHash must be SHA-256"));
            }
        }
        for (RubricVersionRecord rubric : pkg.rubrics()) {
            if (rubric.criteria() == null || rubric.criteria().isEmpty() || rubric.ordinalScale() == null || rubric.ordinalScale().isEmpty()) {
                errors.add(error("rubrics." + id(rubric.id()), "RUBRIC_DEFINITION_REQUIRED", "Rubric criteria and ordinalScale are required"));
            }
            if (rubric.family() == null || blank(rubric.skill())) {
                errors.add(error("rubrics." + id(rubric.id()), "RUBRIC_FAMILY_SKILL_REQUIRED", "Rubric family and skill are required"));
            }
            if (blank(rubric.contentHash()) || !SHA256.matcher(rubric.contentHash()).matches()) {
                errors.add(error("rubrics." + id(rubric.id()) + ".contentHash", "CONTENT_HASH_REQUIRED", "Rubric contentHash must be SHA-256"));
            }
            validateOrdinalScale(rubric.ordinalScale(), "rubrics." + id(rubric.id()) + ".ordinalScale", errors);
            requireRef("rubrics." + id(rubric.id()) + ".provenanceId", rubric.provenanceId(), provenances, errors);
        }
        for (CalibrationVersionRecord calibration : pkg.calibrations()) {
            if (blank(calibration.maturityStage()) || blank(calibration.method())) {
                errors.add(error("calibrations." + id(calibration.id()), "CALIBRATION_METADATA_REQUIRED", "Calibration method and maturityStage are required"));
            }
        }
        if (pkg.form() != null) {
            FormVersionRecord form = pkg.form();
            requireRef("form.catalogNodeId", form.catalogNodeId(), catalogNodes, errors);
            requireRef("form.specificationId", form.specificationId(), specs, errors);
            requireRef("form.scoringSchemeId", form.scoringSchemeId(), schemes, errors);
            requireRef("form.provenanceId", form.provenanceId(), provenances, errors);
            if (blank(form.logicalKey()) || form.version() <= 0 || blank(form.title())) {
                errors.add(error("form", "FORM_IDENTITY_REQUIRED", "Form logicalKey, positive version and title are required"));
            }
            if (blank(form.contentHash()) || !SHA256.matcher(form.contentHash()).matches()) {
                errors.add(error("form.contentHash", "CONTENT_HASH_REQUIRED", "Form contentHash must be SHA-256"));
            }
        }
        for (FormComponentPlacement placement : pkg.formComponents()) {
            if (pkg.form() != null && !Objects.equals(placement.parentFormId(), pkg.form().id())) {
                errors.add(error("formComponents." + id(placement.id()), "FORM_COMPONENT_PARENT_MISMATCH", "Component parent must be the package form"));
            }
            if (placement.childFormId() == null || Objects.equals(placement.childFormId(), placement.parentFormId())) {
                errors.add(error("formComponents." + id(placement.id()), "FORM_COMPONENT_CHILD_INVALID", "Suite components must reference a distinct child form"));
            }
            if (!Set.of("LR", "SPEAKING", "WRITING", "LISTENING", "READING").contains(normalize(placement.role()))) {
                errors.add(error("formComponents." + id(placement.id()) + ".role", "FORM_COMPONENT_ROLE_INVALID", "Only LR, SPEAKING, WRITING, LISTENING and READING roles are supported"));
            }
        }
        for (SectionRecord section : pkg.sections()) {
            if (pkg.form() != null && !Objects.equals(section.formId(), pkg.form().id())) {
                errors.add(error("sections." + id(section.id()) + ".formId", "FORM_REFERENCE_INVALID", "Section must belong to package form"));
            }
            if (section.durationSeconds() <= 0 || section.ordinal() < 0) {
                errors.add(error("sections." + id(section.id()), "SECTION_TIMING_INVALID", "Section ordinal and positive duration are required"));
            }
            if (section.scoringSchemeId() != null) requireRef("sections." + id(section.id()) + ".scoringSchemeId", section.scoringSchemeId(), schemes, errors);
        }
        for (PartRecord part : pkg.parts()) {
            requireRef("parts." + id(part.id()) + ".sectionId", part.sectionId(), sections, errors);
        }
        for (GroupVersionRecord group : pkg.groups()) {
            requireRef("groups." + id(group.id()) + ".provenanceId", group.provenanceId(), provenances, errors);
            if (blank(group.contentHash()) || !SHA256.matcher(group.contentHash()).matches()) {
                errors.add(error("groups." + id(group.id()) + ".contentHash", "CONTENT_HASH_REQUIRED", "Group contentHash must be SHA-256"));
            }
            if (group.difficultyEstimate() != null && (group.difficultyEstimate() < 0 || group.difficultyEstimate() > 1)) {
                errors.add(error("groups." + id(group.id()) + ".difficultyEstimate", "DIFFICULTY_RANGE_INVALID", "Difficulty estimate must be between 0 and 1"));
            }
        }
        for (FormGroupPlacement placement : pkg.formGroups()) {
            requireRef("formGroups." + id(placement.id()) + ".partId", placement.partId(), parts, errors);
            requireRef("formGroups." + id(placement.id()) + ".groupId", placement.groupId(), groups, errors);
            if (placement.ordinal() < 0) errors.add(error("formGroups." + id(placement.id()) + ".ordinal", "ORDINAL_INVALID", "Ordinal cannot be negative"));
        }
        for (StimulusVersionRecord stimulus : pkg.stimuli()) {
            requireRef("stimuli." + id(stimulus.id()) + ".provenanceId", stimulus.provenanceId(), provenances, errors);
            if (blank(stimulus.contentHash()) || !SHA256.matcher(stimulus.contentHash()).matches()) {
                errors.add(error("stimuli." + id(stimulus.id()) + ".contentHash", "CONTENT_HASH_REQUIRED", "Stimulus contentHash must be SHA-256"));
            }
            if (stimulus.bodyPayload() == null || stimulus.bodyPayload().isEmpty()) {
                errors.add(error("stimuli." + id(stimulus.id()) + ".bodyPayload", "STIMULUS_PAYLOAD_REQUIRED", "Stimulus bodyPayload is required"));
            }
        }
        for (GroupStimulusPlacement placement : pkg.groupStimuli()) {
            requireRef("groupStimuli." + id(placement.id()) + ".groupId", placement.groupId(), groups, errors);
            requireRef("groupStimuli." + id(placement.id()) + ".stimulusId", placement.stimulusId(), stimuli, errors);
        }
        for (ItemVersionRecord item : pkg.items()) {
            requireRef("items." + id(item.id()) + ".groupId", item.groupId(), groups, errors);
            if (blank(item.logicalItemKey()) || item.version() <= 0 || blank(item.prompt())) {
                errors.add(error("items." + id(item.id()), "ITEM_IDENTITY_REQUIRED", "Item key, positive version and prompt are required"));
            }
            if (blank(item.interactionType()) || !INTERACTION_TYPES.contains(normalize(item.interactionType()))) {
                errors.add(error("items." + id(item.id()) + ".interactionType", "INTERACTION_TYPE_UNSUPPORTED", "Interaction type is not supported by the renderer registry"));
            }
            if (blank(item.contentHash()) || !SHA256.matcher(item.contentHash()).matches()) {
                errors.add(error("items." + id(item.id()) + ".contentHash", "CONTENT_HASH_REQUIRED", "Item contentHash must be SHA-256"));
            }
        }
        for (AnswerSpecRecord answer : pkg.answerSpecs()) {
            requireRef("answerSpecs." + id(answer.id()) + ".itemId", answer.itemId(), items, errors);
            if (answer.acceptedAnswers() == null || answer.acceptedAnswers().isEmpty() || !hasAnswerValue(answer.acceptedAnswers())) {
                errors.add(error("answerSpecs." + id(answer.id()) + ".acceptedAnswers", "ANSWER_REQUIRED", "Every item needs at least one accepted answer or rubric-bound response policy"));
            }
            if (answer.cardinality() <= 0 || answer.creditUnits() <= 0) {
                errors.add(error("answerSpecs." + id(answer.id()), "ANSWER_SCORING_INVALID", "Answer cardinality and creditUnits must be positive"));
            }
            if (answer.rubricId() != null) requireRef("answerSpecs." + id(answer.id()) + ".rubricId", answer.rubricId(), rubrics, errors);
        }
        for (AssetRecord asset : pkg.assets()) {
            if (asset.provenanceId() != null) requireRef("assets." + id(asset.id()) + ".provenanceId", asset.provenanceId(), provenances, errors);
        }
        for (StimulusAssetPlacement placement : pkg.stimulusAssets()) {
            requireRef("stimulusAssets." + id(placement.id()) + ".stimulusId", placement.stimulusId(), stimuli, errors);
            requireRef("stimulusAssets." + id(placement.id()) + ".assetId", placement.assetId(), assets, errors);
        }

        // Detect duplicate stable logical identities even when UUIDs differ.
        detectDuplicateLogicalKeys("specifications", pkg.specifications(), s -> s.logicalCode() + ":v" + s.version(), errors);
        detectDuplicateLogicalKeys("rubrics", pkg.rubrics(), r -> r.logicalCode() + ":v" + r.version(), errors);
        detectDuplicateLogicalKeys("calibrations", pkg.calibrations(), c -> c.logicalCode() + ":v" + c.version(), errors);
        detectDuplicateLogicalKeys("scoringSchemes", pkg.scoringSchemes(), s -> s.logicalCode() + ":v" + s.version(), errors);
        detectDuplicateLogicalKeys("groups", pkg.groups(), g -> g.logicalGroupKey() + ":v" + g.version(), errors);
        detectDuplicateLogicalKeys("stimuli", pkg.stimuli(), s -> s.logicalStimulusKey() + ":v" + s.version(), errors);
        detectDuplicateLogicalKeys("items", pkg.items(), i -> i.logicalItemKey() + ":v" + i.version(), errors);
    }

    private void validateRights(ExamContentPackage pkg, Instant now, List<ValidationError> errors) {
        if (pkg.sources().isEmpty() || pkg.licenses().isEmpty() || pkg.provenances().isEmpty()) {
            errors.add(error("rights", "PROVENANCE_REQUIRED", "Source, license and provenance rows are required"));
            return;
        }
        // Authoring quarantine is intentionally narrower than publication:
        // original DRAFT packages may carry explicit PENDING legal status so
        // legal review can happen against an immutable closure.  Every learner
        // and publication path still requires APPROVED rights.
        Map<UUID, SourceRecord> sources = index("sources", pkg.sources(), SourceRecord::id, errors);
        Map<UUID, LicenseRecord> licenses = index("licenses", pkg.licenses(), LicenseRecord::id, errors);
        for (LicenseRecord license : pkg.licenses()) {
            boolean quarantinableOriginalDraft = pkg.manifest() != null
                    && REQUIRED_AUTHORING_STATUS.equalsIgnoreCase(pkg.manifest().authoringStatus())
                    && license.provenanceCategory() == ProvenanceCategory.ORIGINAL
                    && "PENDING".equalsIgnoreCase(license.legalStatus());
            // Publisher-licence gaps come from the one rights policy (the persisted runtime path uses the same rules).
            String l = "licenses." + id(license.id());
            for (String code : ExamRightsDecisionPolicy.publisherLicenceGaps(ExamRightsDecisionPolicy.LicenceFacts.of(license), now, quarantinableOriginalDraft)) {
                switch (code) {
                    case "RIGHTS_CATEGORY_FORBIDDEN" -> errors.add(error(l + ".provenanceCategory", code,
                            "Only ORIGINAL or LICENSED content can enter the authoring factory"));
                    case "RIGHTS_NOT_APPROVED" -> errors.add(error(l + ".legalStatus", code,
                            "Rights must be APPROVED for publication; only explicit PENDING ORIGINAL DRAFT rights may be quarantined for authoring"));
                    case "RIGHTS_SCOPE_INCOMPLETE" -> errors.add(error(l, code,
                            "Commercial, redistribution and derivative rights must all be explicit"));
                    case "RIGHTS_NOT_YET_VALID" -> errors.add(error(l + ".validFrom", code, "License is not active yet"));
                    case "RIGHTS_EXPIRED" -> errors.add(error(l + ".validUntil", code, "License has expired"));
                    case "RIGHTS_PURPOSE_REQUIRED" -> errors.add(error(l + ".permittedPurposes", code,
                            "License must declare an examination or redistribution purpose"));
                    default -> errors.add(error(l, code, "License rights incomplete"));
                }
            }
            if (!sources.containsKey(license.sourceId())) {
                errors.add(error("licenses." + id(license.id()) + ".sourceId", "RIGHTS_SOURCE_MISSING", "License source is missing"));
            }
        }
        for (ProvenanceRecord provenance : pkg.provenances()) {
            if (blank(provenance.creator()) || blank(provenance.acquisitionMethod()) || blank(provenance.originalReference())) {
                errors.add(error("provenances." + id(provenance.id()), "PROVENANCE_METADATA_REQUIRED",
                        "Creator, acquisition method and original reference are required"));
            }
            LicenseRecord license = licenses.get(provenance.licenseId());
            if (license == null) continue;
            if (!Objects.equals(provenance.sourceId(), license.sourceId())) {
                errors.add(error("provenances." + id(provenance.id()), "PROVENANCE_SOURCE_MISMATCH",
                        "Provenance and license must point to the same source"));
            }
        }
    }

    private void validateBlueprintAndGraph(ExamContentPackage pkg, List<ValidationError> errors) {
        if (pkg.form() == null) return;
        FormVersionRecord form = pkg.form();
        SpecificationVersionRecord spec = findById(pkg.specifications(), form.specificationId(), SpecificationVersionRecord::id);
        ScoringSchemeVersionRecord scheme = findById(pkg.scoringSchemes(), form.scoringSchemeId(), ScoringSchemeVersionRecord::id);
        if (spec == null || scheme == null) return;
        if (spec.family() != form.family() || !sameCode(spec.variant(), form.variant())) {
            errors.add(error("specifications." + id(spec.id()), "SPECIFICATION_FAMILY_MISMATCH", "Specification family and variant must match the form"));
        }
        if (scheme.family() != form.family() || !sameCode(scheme.variant(), form.variant()) || !sameCode(scheme.scope(), form.scope())) {
            errors.add(error("scoringSchemes." + id(scheme.id()), "SCORING_SCHEME_MISMATCH", "Scoring scheme family, variant and scope must match the form"));
        }
        validateDeclaredBlueprint(spec, pkg, errors);

        Map<UUID, SectionRecord> sections = index("sections", pkg.sections(), SectionRecord::id, errors);
        Map<UUID, PartRecord> parts = index("parts", pkg.parts(), PartRecord::id, errors);
        Map<UUID, GroupVersionRecord> groups = index("groups", pkg.groups(), GroupVersionRecord::id, errors);
        Map<UUID, ItemVersionRecord> items = index("items", pkg.items(), ItemVersionRecord::id, errors);
        Set<UUID> placedGroups = new HashSet<>();
        Map<UUID, UUID> groupToSection = new HashMap<>();
        for (FormGroupPlacement placement : pkg.formGroups()) {
            PartRecord part = parts.get(placement.partId());
            GroupVersionRecord group = groups.get(placement.groupId());
            if (part == null || group == null) continue;
            SectionRecord section = sections.get(part.sectionId());
            if (section == null) continue;
            placedGroups.add(group.id());
            groupToSection.put(group.id(), section.id());
            if (group.skill() != section.skill()) {
                errors.add(error("groups." + id(group.id()) + ".skill", "GROUP_SKILL_MISMATCH",
                        "Group skill must match the section skill in its form placement"));
            }
        }
        for (GroupVersionRecord group : pkg.groups()) {
            if (!placedGroups.contains(group.id())) {
                errors.add(error("groups." + id(group.id()), "UNPLACED_GROUP", "Every group in a form package must be placed by formGroups"));
            }
        }
        Map<UUID, List<ItemVersionRecord>> itemsByGroup = new HashMap<>();
        for (ItemVersionRecord item : pkg.items()) itemsByGroup.computeIfAbsent(item.groupId(), ignored -> new ArrayList<>()).add(item);
        Map<UUID, AnswerSpecRecord> answersByItem = new HashMap<>();
        for (AnswerSpecRecord answer : pkg.answerSpecs()) {
            if (answersByItem.put(answer.itemId(), answer) != null) {
                errors.add(error("answerSpecs." + id(answer.id()), "DUPLICATE_ANSWER_SPEC", "An item may have exactly one answer specification"));
            }
        }
        for (ItemVersionRecord item : pkg.items()) {
            if (!placedGroups.contains(item.groupId())) continue;
            if (!answersByItem.containsKey(item.id())) {
                errors.add(error("items." + id(item.id()), "MISSING_ANSWER", "Placed item has no answer specification"));
            }
        }
        for (UUID groupId : placedGroups) {
            for (ItemVersionRecord item : itemsByGroup.getOrDefault(groupId, List.of())) {
                AnswerSpecRecord answer = answersByItem.get(item.id());
                if (answer == null) continue;
                String interaction = normalize(item.interactionType());
                if (("writing_response".equals(interaction) || "speaking_response".equals(interaction)) && answer.rubricId() == null) {
                    errors.add(error("answerSpecs." + id(answer.id()) + ".rubricId", "PRODUCTIVE_RUBRIC_REQUIRED",
                            "Writing and speaking responses require a compatible rubric"));
                }
            }
        }
        if ("SUITE".equals(normalize(form.variant()))) {
            Set<String> roles = new HashSet<>();
            for (ExamContentPackage.FormComponentPlacement component : pkg.formComponents()) roles.add(normalize(component.role()));
            if (!roles.equals(Set.of("LR", "SPEAKING", "WRITING"))) {
                errors.add(error("formComponents", "SUITE_COMPONENTS_INCOMPLETE", "A TOEIC Suite must pin exactly LR, SPEAKING and WRITING child roles"));
            }
        }
    }

    private void validateDeclaredBlueprint(SpecificationVersionRecord spec, ExamContentPackage pkg, List<ValidationError> errors) {
        Map<String, Object> blueprint = spec.blueprint();
        if (blueprint == null || blueprint.isEmpty()) return;
        Object expectedSections = first(blueprint, "sectionCount", "expectedSectionCount");
        if (expectedSections instanceof Number n && n.intValue() != pkg.sections().size()) {
            errors.add(error("specification.blueprint.sectionCount", "BLUEPRINT_SECTION_COUNT_MISMATCH",
                    "Blueprint requires " + n.intValue() + " sections but package contains " + pkg.sections().size()));
        }
        Object expectedItems = first(blueprint, "itemCount", "expectedItemCount", "totalItems");
        if (expectedItems instanceof Number n && n.intValue() != pkg.items().size()) {
            errors.add(error("specification.blueprint.itemCount", "BLUEPRINT_ITEM_COUNT_MISMATCH",
                    "Blueprint requires " + n.intValue() + " items but package contains " + pkg.items().size()));
        }
        Object declaredDelivery = first(blueprint, "deliveryMode", "delivery_mode");
        if (declaredDelivery != null && spec.deliveryMode() != null
                && !sameCode(String.valueOf(declaredDelivery), spec.deliveryMode())) {
            errors.add(error("specification.blueprint.deliveryMode", "BLUEPRINT_DELIVERY_MODE_MISMATCH", "Blueprint delivery mode must match specification"));
        }
    }

    private void validateAssets(ExamContentPackage pkg, List<ValidationError> errors) {
        Map<UUID, AssetRecord> assets = index("assets", pkg.assets(), AssetRecord::id, errors);
        for (AssetRecord asset : pkg.assets()) {
            if (blank(asset.objectKey()) || blank(asset.sha256Hash()) || !SHA256.matcher(asset.sha256Hash()).matches()) {
                errors.add(error("assets." + id(asset.id()), "ASSET_IDENTITY_INVALID", "Asset objectKey and SHA-256 are required"));
            }
            if (asset.byteSize() <= 0) errors.add(error("assets." + id(asset.id()) + ".byteSize", "ASSET_SIZE_INVALID", "Asset byteSize must be positive"));
            if (blank(asset.mimeType()) || !supportedMime(asset.mimeType())) {
                errors.add(error("assets." + id(asset.id()) + ".mimeType", "ASSET_MIME_UNSUPPORTED", "Asset MIME type is unsupported"));
            }
            if (!Set.of("PENDING", "VALIDATED").contains(normalize(asset.validationState()))) {
                errors.add(error("assets." + id(asset.id()) + ".validationState", "ASSET_VALIDATION_STATE_INVALID", "Asset must be PENDING or VALIDATED during DRAFT import"));
            }
            if (asset.durationMs() != null && asset.durationMs() <= 0) {
                errors.add(error("assets." + id(asset.id()) + ".durationMs", "ASSET_DURATION_INVALID", "Asset duration must be positive when supplied"));
            }
            if (asset.mimeType() != null && asset.mimeType().toLowerCase(Locale.ROOT).startsWith("audio/")
                    && (asset.durationMs() == null || asset.durationMs() <= 0)) {
                errors.add(error("assets." + id(asset.id()) + ".durationMs", "ASSET_DURATION_REQUIRED", "Audio assets must declare a positive duration"));
            }
        }
        Map<UUID, StimulusVersionRecord> stimuli = index("stimuli", pkg.stimuli(), StimulusVersionRecord::id, errors);
        Map<UUID, List<StimulusAssetPlacement>> linked = new HashMap<>();
        for (StimulusAssetPlacement link : pkg.stimulusAssets()) {
            if (!stimuli.containsKey(link.stimulusId()) || !assets.containsKey(link.assetId())) {
                errors.add(error("stimulusAssets." + id(link.id()), "BROKEN_ASSET_REFERENCE", "Stimulus asset link references a missing stimulus or asset"));
                continue;
            }
            linked.computeIfAbsent(link.stimulusId(), ignored -> new ArrayList<>()).add(link);
        }
        for (StimulusVersionRecord stimulus : pkg.stimuli()) {
            if (("AUDIO".equals(normalize(stimulus.kind())) || "IMAGE".equals(normalize(stimulus.kind()))
                    || "CHART".equals(normalize(stimulus.kind())) || "MAP".equals(normalize(stimulus.kind())))
                    && linked.getOrDefault(stimulus.id(), List.of()).isEmpty()) {
                    errors.add(error("stimuli." + id(stimulus.id()), "REQUIRED_ASSET_MISSING", "Media stimulus requires at least one asset link"));
            }
        }
        for (StimulusAssetPlacement link : pkg.stimulusAssets()) {
            StimulusVersionRecord stimulus = stimuli.get(link.stimulusId());
            AssetRecord asset = assets.get(link.assetId());
            if (stimulus == null || asset == null || asset.mimeType() == null) continue;
            String kind = normalize(stimulus.kind());
            String mime = asset.mimeType().toLowerCase(Locale.ROOT);
            if ("AUDIO".equals(kind) && !mime.startsWith("audio/")) {
                errors.add(error("stimulusAssets." + id(link.id()) + ".assetId", "ASSET_MIME_MISMATCH", "Audio stimulus must link an audio asset"));
            }
            if (("IMAGE".equals(kind) || "CHART".equals(kind) || "MAP".equals(kind))
                    && !(mime.startsWith("image/") || "application/pdf".equals(mime))) {
                errors.add(error("stimulusAssets." + id(link.id()) + ".assetId", "ASSET_MIME_MISMATCH", "Visual stimulus must link an image or PDF asset"));
            }
        }
    }

    private void validateRubricsAndScores(ExamContentPackage pkg, List<ValidationError> errors) {
        if (pkg.form() == null) return;
        FormVersionRecord form = pkg.form();
        Map<UUID, RubricVersionRecord> rubrics = index("rubrics", pkg.rubrics(), RubricVersionRecord::id, errors);
        Map<UUID, GroupVersionRecord> groups = index("groups", pkg.groups(), GroupVersionRecord::id, errors);
        Map<UUID, ItemVersionRecord> items = index("items", pkg.items(), ItemVersionRecord::id, errors);
        Map<UUID, AnswerSpecRecord> answers = new HashMap<>();
        for (AnswerSpecRecord answer : pkg.answerSpecs()) answers.put(answer.itemId(), answer);
        for (ItemVersionRecord item : pkg.items()) {
            AnswerSpecRecord answer = answers.get(item.id());
            if (answer == null || answer.rubricId() == null) continue;
            RubricVersionRecord rubric = rubrics.get(answer.rubricId());
            GroupVersionRecord group = groups.get(item.groupId());
            if (rubric == null || group == null) continue;
            if (rubric.family() != form.family()) {
                errors.add(error("answerSpecs." + id(answer.id()) + ".rubricId", "RUBRIC_FAMILY_MISMATCH", "Rubric family must match form family"));
            }
            if (!sameCode(rubric.skill(), group.skill() == null ? null : group.skill().name())) {
                errors.add(error("answerSpecs." + id(answer.id()) + ".rubricId", "RUBRIC_SKILL_MISMATCH", "Rubric skill must match the item group skill"));
            }
        }
        ScoringSchemeVersionRecord scheme = findById(pkg.scoringSchemes(), form.scoringSchemeId(), ScoringSchemeVersionRecord::id);
        if (scheme == null || scheme.mappingTable() == null || scheme.mappingTable().isEmpty()) {
            errors.add(error("scoringScheme.mappingTable", "SCORE_MAPPING_REQUIRED", "Scoring scheme mappingTable is required"));
            return;
        }
        Set<String> metrics = new TreeSet<>();
        collectMetricTokens(scheme.mappingTable(), metrics);
        if (metrics.isEmpty()) {
            errors.add(error("scoringScheme.mappingTable", "SCORE_METRICS_REQUIRED", "Scoring mapping must declare at least one score metric"));
        }
        for (String metric : metrics) {
            if (form.family() == ExamFamily.TOEIC && "FULL_OVERALL".equals(metric)) {
                errors.add(error("scoringScheme.mappingTable", "TOEIC_OVERALL_FORBIDDEN", "TOEIC suites and forms cannot define a four-skill Overall"));
            }
            if (form.family() == ExamFamily.IELTS && "LR_TOTAL".equals(metric)) {
                errors.add(error("scoringScheme.mappingTable", "IELTS_LR_TOTAL_FORBIDDEN", "IELTS does not use LR_TOTAL"));
            }
            if (!"FULL".equals(normalize(form.scope())) && "FULL_OVERALL".equals(metric)) {
                errors.add(error("scoringScheme.mappingTable", "INDEPENDENT_OVERALL_FORBIDDEN", "Independent skill forms cannot define an Overall"));
            }
        }
        if (scheme.aggregationRules() == null || scheme.aggregationRules().isEmpty()) {
            errors.add(error("scoringScheme.aggregationRules", "AGGREGATION_RULES_REQUIRED", "Aggregation and rounding rules must be versioned"));
        }
    }

    private void collectMetricTokens(Object value, Set<String> metrics) {
        if (value instanceof Map<?, ?> map) {
            map.forEach((key, val) -> {
                if (key != null) addMetric(String.valueOf(key), metrics);
                collectMetricTokens(val, metrics);
            });
        } else if (value instanceof Iterable<?> iterable) {
            for (Object item : iterable) collectMetricTokens(item, metrics);
        } else if (value != null) {
            addMetric(String.valueOf(value), metrics);
        }
    }

    private void validateOrdinalScale(Map<String, Object> scale, String path, List<ValidationError> errors) {
        Object min = first(scale, "min", "minimum");
        Object max = first(scale, "max", "maximum");
        if (min == null && max == null) return;
        if (!(min instanceof Number minNumber) || !(max instanceof Number maxNumber)
                || maxNumber.doubleValue() <= minNumber.doubleValue()) {
            errors.add(error(path, "RUBRIC_SCALE_INVALID", "Rubric ordinal scale must have numeric min/max with max greater than min"));
        }
    }

    private void addMetric(String token, Set<String> metrics) {
        String normalized = normalize(token);
        if (METRICS.contains(normalized)) metrics.add(normalized);
    }

    private boolean supportedMime(String mime) {
        String value = mime.toLowerCase(Locale.ROOT);
        return value.startsWith("audio/") || value.startsWith("image/") || value.equals("application/pdf")
                || value.equals("text/plain") || value.equals("application/json");
    }

    private boolean hasAnswerValue(Object value) {
        if (value == null) return false;
        if (value instanceof CharSequence sequence) return !sequence.toString().isBlank();
        if (value instanceof Map<?, ?> map) return map.entrySet().stream().anyMatch(e -> hasAnswerValue(e.getValue()));
        if (value instanceof Iterable<?> iterable) {
            for (Object item : iterable) if (hasAnswerValue(item)) return true;
            return false;
        }
        return true;
    }

    private <T> void addIds(String path, List<T> values, IdAccessor<T> accessor, Set<UUID> allIds, List<ValidationError> errors) {
        for (int i = 0; i < values.size(); i++) addId(path + "[" + i + "].id", accessor.id(values.get(i)), allIds, errors);
    }

    private void addId(String path, UUID id, Set<UUID> allIds, List<ValidationError> errors) {
        if (id == null) {
            errors.add(error(path, "ID_REQUIRED", "Stable UUID identity is required"));
        } else if (!allIds.add(id)) {
            errors.add(error(path, "DUPLICATE_ID", "Stable UUID is used more than once in the package"));
        }
    }

    private <T> Map<UUID, T> index(String path, List<T> values, IdAccessor<T> accessor, List<ValidationError> errors) {
        Map<UUID, T> result = new LinkedHashMap<>();
        for (T value : values) {
            UUID id = accessor.id(value);
            if (id == null) continue;
            if (result.put(id, value) != null) errors.add(error(path + "." + id, "DUPLICATE_ID", "Stable UUID is duplicated"));
        }
        return result;
    }

    private <T> void detectDuplicateLogicalKeys(String path, List<T> values, KeyAccessor<T> accessor, List<ValidationError> errors) {
        Set<String> seen = new HashSet<>();
        for (T value : values) {
            String key = accessor.key(value);
            if (blank(key)) continue;
            if (!seen.add(key)) errors.add(error(path, "DUPLICATE_LOGICAL_ID", "Logical version identity is duplicated: " + key));
        }
    }

    private <T> void requireRef(String path, UUID id, Map<UUID, T> index, List<ValidationError> errors) {
        if (id == null || !index.containsKey(id)) errors.add(error(path, "BROKEN_REFERENCE", "Referenced row is missing from this package"));
    }

    private <T> T findById(List<T> values, UUID id, IdAccessor<T> accessor) {
        if (id == null) return null;
        return values.stream().filter(v -> id.equals(accessor.id(v))).findFirst().orElse(null);
    }

    private Object first(Map<String, Object> map, String... keys) {
        for (String key : keys) if (map.containsKey(key)) return map.get(key);
        return null;
    }

    private ValidationError error(String path, String code, String message) {
        return new ValidationError(path, code, message);
    }

    private String id(UUID id) { return id == null ? "null" : id.toString(); }

    private boolean blank(String value) { return value == null || value.isBlank(); }

    private String normalize(String value) {
        return value == null ? "" : value.trim().toUpperCase(Locale.ROOT).replace('-', '_').replace(' ', '_');
    }

    private boolean sameCode(String left, String right) { return normalize(left).equals(normalize(right)); }

    private String sha256(byte[] bytes) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
            StringBuilder out = new StringBuilder(64);
            for (byte b : digest) out.append(String.format(Locale.ROOT, "%02x", b));
            return out.toString();
        } catch (Exception e) {
            throw new IllegalStateException("SHA-256 is unavailable", e);
        }
    }

    @FunctionalInterface
    private interface IdAccessor<T> { UUID id(T value); }

    @FunctionalInterface
    private interface KeyAccessor<T> { String key(T value); }
}
