package com.englishcoach.exams.release;

import com.englishcoach.exams.content.*;
import com.englishcoach.exams.practice.ExamPracticeReadiness;
import com.englishcoach.exams.validation.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.util.*;

/** Independent Practice admission, separate from full simulation admission. Never grants PUBLISHED or human QA. */
public final class ExamPracticeReleaseReadiness {
    private ExamPracticeReleaseReadiness() {}
    public record Decision(String packageHash, boolean importReady, Set<String> scopes,
                           ExamFormValidationReport structural, List<String> blockers) {
        public Map<String,Object> asMap() { return Map.of("releaseKind", "PRACTICE", "IMPORT_READY", importReady,
                "qualifiedScopes", scopes, "packageHash", packageHash, "fullSimulationGranted", false); }
    }
    public static Decision evaluate(ExamPracticePackageProjection.Result projection, ExamMediaImportPlan.Plan media,
                                    ObjectMapper mapper, Instant now) {
        var pkg = projection.pkg();
        Set<String> blockers = new TreeSet<>();
        var validator = new ExamContentPackageValidator(mapper);
        var closure = validator.validate(pkg, now);
        for (var error : closure.errors()) if (!ExamProjectUsageAuthorization.PUBLISHER_RIGHTS_CODES.contains(error.code())) blockers.add(error.code());
        if (!ExamOwnerProductionAuthorization.covers(pkg)) blockers.add("OWNER_PRODUCTION_SOURCE_NOT_COVERED");
        blockers.addAll(ExamReleaseReadinessGate.provenanceGaps(pkg));
        var compat = ExamRuntimeCompatibility.audit(pkg);
        blockers.addAll(compat.blockingCodes(ExamRuntimeCompatibility.Gate.RUNNER));
        blockers.addAll(compat.blockingCodes(ExamRuntimeCompatibility.Gate.SCORING));
        for (String code : compat.reviewCodes()) blockers.add("COMPATIBILITY_REVIEW_REQUIRED:" + code);
        var tree = ExamContentTree.fromPackage(pkg, mapper);
        var structural = ExamFormValidator.validate(tree, mapper, now);
        var scopes = ExamPracticeReadiness.evaluate(tree, structural, ExamRunnerCapabilities.CURRENT,
                new ExamPracticeReadiness.FormFacts(true, true), mapper);
        Set<String> actual = new TreeSet<>();
        for (var scope : scopes) { actual.add(scope.scope().scopeCode()); blockers.addAll(scope.reasonCodes()); }
        if (actual.isEmpty() || !actual.equals(projection.retainedScopes())) blockers.add("PRACTICE_PROJECTED_SCOPE_MISMATCH");
        boolean mediaReady = media != null && (media.mediaReady() || pkg.assets().isEmpty() && media.entries().isEmpty());
        if (!mediaReady || media == null || !pkg.manifest().packageId().equals(media.packageId())) blockers.add("PRACTICE_MEDIA_NOT_READY");
        if (media != null) {
            Set<String> verifiedAssets = new TreeSet<>();
            media.entries().forEach(e -> { if (e.ready()) verifiedAssets.add(e.assetId() + ":" + e.sha256()); });
            Set<String> requiredAssets = new TreeSet<>();
            pkg.assets().forEach(a -> requiredAssets.add(a.id() + ":" + a.sha256Hash()));
            if (!verifiedAssets.equals(requiredAssets)) blockers.add("PRACTICE_MEDIA_PLAN_MISMATCH");
        }
        return new Decision(pkg.manifest().contentHash(), blockers.isEmpty(), Set.copyOf(actual), structural, List.copyOf(blockers));
    }
}
