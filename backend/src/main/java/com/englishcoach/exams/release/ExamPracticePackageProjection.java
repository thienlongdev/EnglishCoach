package com.englishcoach.exams.release;

import com.englishcoach.exams.content.*;
import com.englishcoach.exams.practice.ExamPracticeReadiness;
import com.englishcoach.exams.validation.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.time.Instant;
import java.util.*;

/** Canonical graph projection for independent Practice. No approval, import or activation side effect.
 * Keeps source truth and stable dependency identities; only removes excluded placements and their unreachable content.
 * The canonical planner/successor rules still govern an already-imported form. Full simulation validation is unchanged.
 */
public final class ExamPracticePackageProjection {
    private ExamPracticePackageProjection() {}
    public record Result(ExamContentPackage pkg, Set<String> retainedScopes, Map<String,List<String>> excludedScopes) {}

    public static Result build(ExamContentPackage source, boolean qaPackageKnown, List<Map<String,Object>> qaEntries,
                               Set<String> requestedScopes, ObjectMapper mapper, Instant now) {
        if (!source.formComponents().isEmpty()) throw new IllegalArgumentException("PRACTICE_PROJECTION_COMPONENTS_UNSUPPORTED");
        if (!ExamOwnerProductionAuthorization.covers(source)) throw new IllegalArgumentException("PRACTICE_SOURCE_NOT_OWNER_AUTHORIZED");
        ExamContentTree tree = ExamContentTree.fromPackage(source, mapper);
        var report = ExamFormValidator.validate(tree, mapper, now);
        var scopes = ExamPracticeReadiness.evaluate(tree, report, ExamRunnerCapabilities.CURRENT,
                new ExamPracticeReadiness.FormFacts(true, true), mapper);
        var qa = ExamScopedQaReadiness.evaluate(source, tree, scopes, qaPackageKnown, qaEntries, mapper);
        Set<String> retained = new TreeSet<>();
        Map<String,List<String>> excluded = new TreeMap<>();
        Set<UUID> placements = new HashSet<>();
        for (var candidate : scopes) {
            String code = candidate.scope().scopeCode();
            List<String> reasons = new ArrayList<>(candidate.reasonCodes());
            reasons.addAll(qa.scopes().get(code).reasonCodes());
            if (requestedScopes != null && !requestedScopes.contains(code)) reasons.add("SCOPE_NOT_SELECTED");
            if (reasons.isEmpty()) {
                retained.add(code);
                placements.addAll(candidate.scope().placementIds());
            } else excluded.put(code, List.copyOf(new TreeSet<>(reasons)));
        }
        if (requestedScopes != null && !retained.containsAll(requestedScopes))
            throw new IllegalArgumentException("PRACTICE_REQUESTED_SCOPE_NOT_QUALIFIED");
        if (retained.isEmpty()) throw new IllegalArgumentException("PRACTICE_NO_QUALIFIED_SCOPES");
        var formGroups = source.formGroups().stream().filter(p -> placements.contains(p.id())).toList();
        Set<UUID> parts = new HashSet<>(), groups = new HashSet<>(), sections = new HashSet<>(), stimuli = new HashSet<>(), assets = new HashSet<>(), answers = new HashSet<>();
        formGroups.forEach(p -> { parts.add(p.partId()); groups.add(p.groupId()); });
        source.parts().stream().filter(p -> parts.contains(p.id())).forEach(p -> sections.add(p.sectionId()));
        var groupStimuli = source.groupStimuli().stream().filter(p -> groups.contains(p.groupId())).toList();
        groupStimuli.forEach(p -> stimuli.add(p.stimulusId()));
        var stimulusAssets = source.stimulusAssets().stream().filter(p -> stimuli.contains(p.stimulusId())).toList();
        stimulusAssets.forEach(p -> assets.add(p.assetId()));
        var items = source.items().stream().filter(i -> groups.contains(i.groupId())).toList();
        items.forEach(i -> answers.add(i.id()));
        Map<String,Object> metadata = new LinkedHashMap<>(source.manifest().metadata());
        metadata.put("practiceProjection", Map.of("version", "exam-practice-projection-v1", "sourcePackageId", source.manifest().packageId(),
                "sourceContentHash", source.manifest().contentHash(), "retainedScopes", List.copyOf(retained), "excludedScopes", excluded,
                "humanApprovalCreated", false, "fullSimulationGranted", false));
        var manifest = source.manifest();
        var projected = new ExamContentPackage(new ExamContentPackage.PackageManifest(manifest.schemaVersion(), manifest.packageId(),
                manifest.packageVersion(), null, manifest.creator(), manifest.specificationBaselineId(), manifest.authoringStatus(), manifest.createdAt(), metadata),
                source.sources(), source.licenses(), source.provenances(), source.catalogNodes(), source.specifications(), source.rubrics(),
                source.calibrations(), source.scoringSchemes(), source.form(), List.of(),
                source.sections().stream().filter(s -> sections.contains(s.id())).toList(), source.parts().stream().filter(p -> parts.contains(p.id())).toList(),
                source.groups().stream().filter(g -> groups.contains(g.id())).toList(), formGroups,
                source.stimuli().stream().filter(s -> stimuli.contains(s.id())).toList(), groupStimuli, items,
                source.answerSpecs().stream().filter(a -> answers.contains(a.itemId())).toList(), source.assets().stream().filter(a -> assets.contains(a.id())).toList(), stimulusAssets);
        try {
            String hash = new ExamContentPackageValidator(mapper).computeContentHash(projected);
            ObjectNode root = mapper.valueToTree(projected);
            ((ObjectNode) root.path("manifest")).put("contentHash", hash);
            return new Result(mapper.treeToValue(root, ExamContentPackage.class), Collections.unmodifiableSet(retained), Collections.unmodifiableMap(excluded));
        } catch (Exception error) { throw new IllegalStateException("PRACTICE_PROJECTION_SEAL_FAILED", error); }
    }
}
