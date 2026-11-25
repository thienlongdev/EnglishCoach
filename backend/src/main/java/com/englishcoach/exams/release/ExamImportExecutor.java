package com.englishcoach.exams.release;

import com.englishcoach.exams.content.ExamContentPackage;
import com.englishcoach.exams.content.ExamContentPackageImporter;
import com.englishcoach.exams.content.ExamPackageIdentity;
import com.englishcoach.exams.content.ExamPackageSuccessorBuilder;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.util.Comparator;

/**
 * Exams Recovery Phase 5D/5E — executes ONLY what an {@link ExamImportPlanner.Plan} allows; there is no force / skip
 * option. ALREADY_IMPORTED writes nothing; BLOCKED (release gate not IMPORT_READY, production basis, identity or path
 * problems) is refused; CREATE / REPLACEMENT_CANDIDATE import the package as planned; NEW_VERSION imports the
 * deterministic successor (ExamPackageSuccessorBuilder) so the version a completed attempt used is never rewritten.
 * A REPLACEMENT_CANDIDATE never retires anything: retirement is a separate, later, reviewed publication decision.
 * Local targets use the explicit local dry-run basis. Production targets require the pinned source-covered owner
 * production decision and all release gates; no caller-selected trust override exists.
 */
public final class ExamImportExecutor {

    private final ExamContentPackageImporter importer;
    private final ExamImportPlanner.StateReader state;
    private final ObjectMapper mapper;

    public ExamImportExecutor(ExamContentPackageImporter importer, ExamImportPlanner.StateReader state, ObjectMapper mapper) {
        this.importer = importer;
        this.state = state;
        this.mapper = mapper;
    }

    public record Outcome(ExamImportPlanner.Operation operation, ExamContentPackage.ImportResult result,
                          ExamContentPackage importedPackage) {}

    public Outcome execute(ExamImportPlanner.Plan plan, ExamContentPackage pkg, Long actorId) {
        ExamPackageIdentity id = ExamPackageIdentity.of(pkg);
        if (!id.semanticFingerprint().equals(plan.semanticFingerprint()) || !id.sourceKey().equals(plan.sourceKey())) {
            throw new IllegalStateException("IMPORT_PLAN_PACKAGE_MISMATCH: the plan was made for other content");
        }
        switch (plan.operation()) {
            case ALREADY_IMPORTED:
                return new Outcome(plan.operation(), null, null);
            case BLOCKED:
                throw new IllegalStateException("IMPORT_PLAN_BLOCKED: " + plan.blockers());
            default:
                break;
        }
        if (plan.target() == ExamImportPlanner.Target.PRODUCTION
                && !com.englishcoach.exams.content.ExamOwnerProductionAuthorization.covers(pkg))
            throw new IllegalStateException("CONTENT_PRODUCTION_AUTHORIZATION_NOT_COVERED");
        ExamContentPackage toImport = pkg;
        if (plan.contentOperation() == ExamImportPlanner.Operation.NEW_VERSION) {
            ExamImportPlanner.ImportedVersion latest = state.importsForSource(plan.sourceKey()).stream()
                    .max(Comparator.comparingInt(ExamImportPlanner.ImportedVersion::packageVersion))
                    .orElseThrow(() -> new IllegalStateException("IMPORT_PLAN_STALE: no previous import recorded"));
            if (latest.identity() == null) throw new IllegalStateException("IMPORT_IDENTITY_UNRECORDED");
            toImport = ExamPackageSuccessorBuilder.build(pkg, latest.identity(), plan.plannedFormVersion(),
                    plan.plannedPackageVersion(), mapper).pkg();
        }
        ExamContentPackage.ImportResult r = importer.importPackage(toImport, actorId,
                plan.target() == ExamImportPlanner.Target.PRODUCTION
                        ? ExamContentPackageImporter.ImportRightsBasis.OWNER_AUTHORIZED_PRODUCTION_USE
                        : ExamContentPackageImporter.ImportRightsBasis.OWNER_PROJECT_AUTHORIZATION_LOCAL_DRY_RUN);
        return new Outcome(plan.operation(), r, toImport);
    }
}
