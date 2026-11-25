package com.englishcoach.exams.release;

import com.englishcoach.exams.content.ExamContentPackage;
import com.englishcoach.exams.content.ExamPackageIdentity;
import com.englishcoach.exams.content.ExamProjectUsageAuthorization;
import com.englishcoach.exams.model.ExamContentRecords.LicenseRecord;
import com.englishcoach.exams.model.ExamContentRecords.SourceRecord;
import com.englishcoach.exams.validation.ExamFormValidationReport;
import com.fasterxml.jackson.databind.MapperFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.databind.json.JsonMapper;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;

/**
 * Exams Recovery Phase 5D — deterministic, READ-ONLY import plan for one canonical package. It answers what an import
 * would do without mutating anything; the importer still re-validates on execution.
 *
 * <pre>
 * contentOperation   ALREADY_IMPORTED  an imported version of the same source has the same semantic fingerprint
 *                                       (exact re-import, or a re-extraction whose only drift is metadata)
 *                    NEW_VERSION       the source was imported before and its content changed → immutable successor
 *                                       (ExamPackageSuccessorBuilder), never an in-place edit
 *                    CREATE            first import of this source
 *                    BLOCKED           identity cannot be decided (form exists without a recorded identity, ...)
 * operation          = ALREADY_IMPORTED whatever the gate (nothing would be written);
 *                    = BLOCKED when any blocker exists (release gate not IMPORT_READY, production basis, paths, ...);
 *                    = REPLACEMENT_CANDIDATE when the content operation would create a form and a REVIEWED exact
 *                      source match names a live legacy form (retirement is only CONSIDERED, never executed);
 *                    = the content operation otherwise.
 * </pre>
 * The release gate is never bypassed: no force / skip flag exists; READY_EXCEPT_HUMAN_QA is still BLOCKED. A
 * PRODUCTION target is always BLOCKED in this phase (publisher licence not established; the owner authorization
 * permits LOCAL staging import preparation only).
 */
public final class ExamImportPlanner {

    private ExamImportPlanner() {}

    public static final String PLAN_VERSION = "exam-import-plan-v1";

    public enum Target { LOCAL_DRY_RUN, PRODUCTION }

    public enum Operation { CREATE, ALREADY_IMPORTED, NEW_VERSION, REPLACEMENT_CANDIDATE, BLOCKED }

    /** One imported package version of a source, as recorded in the import ledger + QA-run findings. */
    public record ImportedVersion(String packageId, int packageVersion, String manifestContentHash, UUID formId,
                                  int formVersion, String lifecycleState, ExamPackageIdentity identity) {}

    public record FormRef(UUID formId, String logicalKey, int version, String lifecycleState) {}

    /** A reviewed legacy → canonical source mapping row (Phase 5G report); only EXACT_SOURCE_MATCH can drive a plan. */
    public record ReplacementMapping(String legacyLogicalKey, String legacyPackageId, String sourceKey, String status) {}

    /** Read-only view of the target database. */
    public interface StateReader {
        List<ImportedVersion> importsForSource(String sourceKey);

        List<FormRef> formsByLogicalKey(String logicalKey);

        List<FormRef> formsByLogicalKeys(Collection<String> logicalKeys);

        /** No database (report generation): every list is empty. */
        StateReader EMPTY = new StateReader() {
            public List<ImportedVersion> importsForSource(String sourceKey) { return List.of(); }
            public List<FormRef> formsByLogicalKey(String logicalKey) { return List.of(); }
            public List<FormRef> formsByLogicalKeys(Collection<String> logicalKeys) { return List.of(); }
        };
    }

    public record Plan(String planVersion, String planId, Target target, Operation operation, Operation contentOperation,
                       List<String> blockers, List<String> notes, String sourceKey, String packageId,
                       int plannedPackageVersion, String formLogicalKey, int plannedFormVersion,
                       String manifestContentHash, String semanticFingerprint, Map<String, Object> matchedImport,
                       Set<String> changedPlacements, Set<String> reusedPlacements, Map<String, Object> expectedValidation,
                       Map<String, Object> releaseGate, List<Map<String, Object>> requiredMedia,
                       Map<String, Object> provenance, List<Map<String, Object>> retireConsiderations) {
        public Map<String, Object> asMap() {
            return CANON.convertValue(this, Map.class);
        }
    }

    private static final ObjectMapper CANON = JsonMapper.builder().findAndAddModules()
            .enable(MapperFeature.SORT_PROPERTIES_ALPHABETICALLY)
            .enable(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS).build();

    public static Plan plan(ExamContentPackage pkg, ExamFormValidationReport structural,
                            ExamReleaseReadinessGate.Decision gate, ExamMediaImportPlan.Plan media,
                            List<ReplacementMapping> mappings, StateReader state, Target target) {
        return planInternal(pkg, structural, gate, media, mappings, state, target, null);
    }

    public static Plan planPractice(ExamContentPackage pkg, ExamPracticeReleaseReadiness.Decision practice,
                                    ExamMediaImportPlan.Plan media, List<ReplacementMapping> mappings, StateReader state, Target target) {
        Objects.requireNonNull(practice, "PRACTICE_QUALIFICATION_REQUIRED");
        return planInternal(pkg, practice.structural(), null, media, mappings, state, target, practice);
    }

    private static Plan planInternal(ExamContentPackage pkg, ExamFormValidationReport structural,
                            ExamReleaseReadinessGate.Decision gate, ExamMediaImportPlan.Plan media,
                            List<ReplacementMapping> mappings, StateReader state, Target target,
                            ExamPracticeReleaseReadiness.Decision practice) {
        ExamPackageIdentity id = ExamPackageIdentity.of(pkg);
        StateReader db = state == null ? StateReader.EMPTY : state;
        List<String> blockers = new ArrayList<>();
        List<String> notes = new ArrayList<>();

        // ── content operation (what the data says, independent of the gate) ──────────────────────
        List<ImportedVersion> imports = new ArrayList<>(db.importsForSource(id.sourceKey()));
        imports.sort(Comparator.comparingInt(ImportedVersion::packageVersion));
        Operation content;
        Map<String, Object> matched = null;
        Set<String> changed = new TreeSet<>(), reused = new TreeSet<>();
        int plannedPackageVersion = id.packageVersion();
        int plannedFormVersion = id.formVersion();
        ImportedVersion same = imports.stream()
                .filter(v -> v.identity() != null && id.semanticFingerprint().equals(v.identity().semanticFingerprint()))
                .reduce((a, b) -> b).orElse(null);
        if (same != null) {
            content = Operation.ALREADY_IMPORTED;
            matched = imported(same);
            plannedPackageVersion = same.packageVersion();
            plannedFormVersion = same.formVersion();
            if (!Objects.equals(same.manifestContentHash(), id.manifestContentHash())) notes.add("METADATA_ONLY_DRIFT");
            if (same != imports.get(imports.size() - 1)) notes.add("MATCHES_SUPERSEDED_VERSION");
        } else if (!imports.isEmpty()) {
            ImportedVersion latest = imports.get(imports.size() - 1);
            content = Operation.NEW_VERSION;
            matched = imported(latest);
            plannedPackageVersion = imports.stream().mapToInt(ImportedVersion::packageVersion).max().orElse(0) + 1;
            int maxForm = Math.max(latest.formVersion(),
                    db.formsByLogicalKey(id.formLogicalKey()).stream().mapToInt(FormRef::version).max().orElse(0));
            plannedFormVersion = maxForm + 1;
            if (latest.identity() == null) {
                blockers.add("IMPORT_IDENTITY_UNRECORDED");
            } else {
                changed.addAll(id.changedPlacements(latest.identity()));
                for (String k : id.placements().keySet()) if (!changed.contains(k)) reused.add(k);
                if (!id.definitionsDigest().equals(latest.identity().definitionsDigest())
                        && !ExamPackageIdentity.onlyAddsRubrics(pkg, latest.identity().definitionsDigest())) {
                    blockers.add("SHARED_DEFINITION_CHANGED");
                }
                if (!id.displayDigest().equals(latest.identity().displayDigest())) notes.add("DISPLAY_NAME_CHANGED");
            }
        } else if (!db.formsByLogicalKey(id.formLogicalKey()).isEmpty()) {
            content = Operation.BLOCKED;
            blockers.add("FORM_EXISTS_WITHOUT_RECORDED_IDENTITY");
        } else {
            content = Operation.CREATE;
        }

        // ── gate + basis + safety blockers (never bypassed) ───────────────────────────────────────
        if (practice != null) {
            if (!practice.packageHash().equals(pkg.manifest().contentHash())) blockers.add("PRACTICE_QUALIFICATION_PACKAGE_MISMATCH");
            if (!practice.importReady()) { blockers.add("PRACTICE_RELEASE_NOT_READY"); blockers.addAll(practice.blockers()); }
        } else if (gate == null || !gate.importReady()) {
            blockers.add("RELEASE_GATE_NOT_IMPORT_READY");
            if (gate != null) {
                if (!gate.structuralValid()) blockers.add("GATE_STRUCTURAL_VALID_NO");
                if (!gate.qaApproved()) blockers.add("GATE_QA_APPROVED_NO");
                if (!gate.runnerCompatible()) blockers.add("GATE_RUNNER_COMPATIBLE_NO");
                if (!gate.scoringCompatible()) blockers.add("GATE_SCORING_COMPATIBLE_NO");
                if (!gate.mediaReady()) blockers.add("GATE_MEDIA_READY_NO");
                if (!gate.projectAuthorized()) blockers.add("GATE_PROJECT_AUTHORIZED_NO");
                if (!gate.provenanceComplete()) blockers.add("GATE_PROVENANCE_COMPLETE_NO");
                if (gate.readyExceptHumanQa()) notes.add("READY_EXCEPT_HUMAN_QA");
            }
        }
        if (target == Target.PRODUCTION && !com.englishcoach.exams.content.ExamOwnerProductionAuthorization.covers(pkg))
            blockers.add("PRODUCTION_IMPORT_BASIS_NOT_ESTABLISHED");
        if (!id.pathViolations().isEmpty()) blockers.add("LOCAL_PATH_IN_PACKAGE_METADATA");

        // ── replacement (reviewed exact source matches only; retirement is a consideration) ──────────
        List<Map<String, Object>> retire = new ArrayList<>();
        List<ReplacementMapping> exact = (mappings == null ? List.<ReplacementMapping>of() : mappings).stream()
                .filter(m -> id.sourceKey().equals(m.sourceKey()) && "EXACT_SOURCE_MATCH".equals(m.status()))
                .sorted(Comparator.comparing(ReplacementMapping::legacyLogicalKey)).toList();
        if (!exact.isEmpty()) {
            Map<String, List<FormRef>> legacy = new TreeMap<>();
            for (FormRef f : db.formsByLogicalKeys(exact.stream().map(ReplacementMapping::legacyLogicalKey).toList())) {
                legacy.computeIfAbsent(f.logicalKey(), k -> new ArrayList<>()).add(f);
            }
            for (ReplacementMapping m : exact) {
                for (FormRef f : legacy.getOrDefault(m.legacyLogicalKey(), List.of())) {
                    if ("RETIRED".equals(f.lifecycleState())) continue;
                    Map<String, Object> r = new LinkedHashMap<>();
                    r.put("legacyLogicalKey", f.logicalKey());
                    r.put("legacyFormId", String.valueOf(f.formId()));
                    r.put("legacyVersion", f.version());
                    r.put("legacyLifecycleState", f.lifecycleState());
                    r.put("mappingStatus", m.status());
                    r.put("action", "CONSIDER_RETIRE_AFTER_REPLACEMENT_PUBLISHED");
                    r.put("executedByPlan", false);
                    r.put("historyPreserved", "attempts / responses / scores / evidence keep their FKs to the legacy version");
                    retire.add(r);
                }
            }
        }

        Operation op;
        if (content == Operation.ALREADY_IMPORTED) op = Operation.ALREADY_IMPORTED;
        else if (!blockers.isEmpty()) op = Operation.BLOCKED;
        else if (!retire.isEmpty() && (content == Operation.CREATE || content == Operation.NEW_VERSION)) {
            op = Operation.REPLACEMENT_CANDIDATE;
        } else op = content;

        Map<String, Object> expected = new LinkedHashMap<>();
        if (structural != null) {
            expected.put("validatorVersion", structural.validatorVersion());
            expected.put("status", structural.status().name());
            expected.put("fullSimulationEligible", structural.fullSimulationEligible());
            expected.put("blockingCodes", structural.blockingCodes());
            expected.put("practiceSkills", ExamFormValidationReport.skillNames(structural.practiceSkills()));
        }
        Map<String, Object> gateMap = new TreeMap<>(practice != null ? practice.asMap() : gate == null ? Map.of("evaluated", false) : gate.asMap());
        gateMap.remove("reasons");

        Plan unsigned = new Plan(PLAN_VERSION, null, target, op, content, sortedUnique(blockers), sortedUnique(notes),
                id.sourceKey(), id.packageId(), plannedPackageVersion, id.formLogicalKey(), plannedFormVersion,
                id.manifestContentHash(), id.semanticFingerprint(), matched, changed, reused, expected, gateMap,
                requiredMedia(media), provenance(pkg, id), retire);
        String planId = sha256(canonical(unsigned.asMap()));
        return new Plan(PLAN_VERSION, planId, target, op, content, unsigned.blockers(), unsigned.notes(), id.sourceKey(),
                id.packageId(), plannedPackageVersion, id.formLogicalKey(), plannedFormVersion, id.manifestContentHash(),
                id.semanticFingerprint(), matched, changed, reused, expected, gateMap, unsigned.requiredMedia(),
                unsigned.provenance(), retire);
    }

    private static Map<String, Object> imported(ImportedVersion v) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("packageId", v.packageId());
        m.put("packageVersion", v.packageVersion());
        m.put("formId", String.valueOf(v.formId()));
        m.put("formVersion", v.formVersion());
        m.put("lifecycleState", v.lifecycleState());
        return m;
    }

    private static List<Map<String, Object>> requiredMedia(ExamMediaImportPlan.Plan media) {
        List<Map<String, Object>> out = new ArrayList<>();
        if (media == null) return out;
        for (ExamMediaImportPlan.Entry e : media.entries()) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("sha256", e.sha256());
            m.put("mimeType", e.mimeType());
            m.put("storageObjectKey", e.storageObjectKey());
            m.put("roles", e.roles());
            m.put("validationState", e.validationState());
            m.put("humanApprovalRequired", e.mimeType() != null && e.mimeType().startsWith("image/"));
            m.put("ready", e.ready());
            out.add(m);
        }
        out.sort(Comparator.comparing(m -> String.valueOf(m.get("sha256"))));
        return out;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> provenance(ExamContentPackage pkg, ExamPackageIdentity id) {
        Map<String, Object> meta = pkg.manifest().metadata();
        Map<String, Object> prov = meta.get("sourceProvenance") instanceof Map<?, ?> p ? (Map<String, Object>) p : Map.of();
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("sourceIdentity", id.sourceIdentity());
        m.put("rawSourceSha256", id.rawSourceSha256());
        m.put("rawDocumentSha256", id.rawDocumentSha256());
        m.put("rawManifestRef", prov.get("rawManifestRef"));
        m.put("extractorName", id.extractorName());
        m.put("extractorVersion", id.extractorVersion());
        Optional<ExamProjectUsageAuthorization> auth = ExamProjectUsageAuthorization.fromManifest(pkg.manifest());
        m.put("projectUsageAuthorization", auth.map(ExamProjectUsageAuthorization::status).orElse("ABSENT"));
        m.put("projectProductionImport", auth.map(ExamProjectUsageAuthorization::productionImport).orElse(null));
        Set<String> pub = new TreeSet<>();
        for (SourceRecord s : pkg.sources()) {
            if (!"THIRD_PARTY_PUBLICATION".equals(s.sourceType())) continue;
            for (LicenseRecord l : pkg.licenses()) {
                if (s.id().equals(l.sourceId())) pub.add(l.provenanceCategory() + "/" + l.legalStatus());
            }
        }
        m.put("publisherLicence", pub);
        m.put("publisherEndorsement", false);
        return m;
    }

    private static List<String> sortedUnique(List<String> in) {
        return new ArrayList<>(new TreeSet<>(in));
    }

    private static String canonical(Object v) {
        try {
            return CANON.writeValueAsString(CANON.readTree(CANON.writeValueAsString(v)));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static String sha256(String s) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (byte b : d) sb.append(String.format(Locale.ROOT, "%02x", b));
            return sb.toString();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
