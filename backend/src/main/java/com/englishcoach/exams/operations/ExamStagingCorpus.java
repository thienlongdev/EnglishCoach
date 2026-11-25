package com.englishcoach.exams.operations;

import com.englishcoach.exams.content.*;
import com.englishcoach.exams.model.ExamContentRecords.LicenseRecord;
import com.englishcoach.exams.operations.ExamOperationsRecords.*;
import com.englishcoach.exams.practice.ExamPracticeReadiness;
import com.englishcoach.exams.practice.ExamPracticeReadiness.ScopeReadiness;
import com.englishcoach.exams.release.*;
import com.englishcoach.exams.validation.ExamContentTree;
import com.englishcoach.exams.validation.ExamFormValidationReport;
import com.englishcoach.exams.validation.ExamFormValidator;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.MissingNode;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.*;
import java.util.stream.Stream;

/**
 * Exams Phase 8D — read-only evaluation of the LOCAL staged corpus for the admin operations center.
 *
 * <p>No second status machine: every value is computed by the canonical code the release tooling and tests use —
 * {@link ExamFormValidator} (Phase 2), {@link ExamContentPackageValidator} closure codes, {@link ExamRuntimeCompatibility},
 * {@link ExamMediaImportPlan} (bytes re-hashed), {@link ExamReleaseReadinessGate}, {@link ExamRightsDecisionPolicy},
 * {@link ExamPracticeReadiness}, {@link ExamPackageIdentity} and {@link ExamImportPlanner} — plus the canonical reports
 * the Python tooling writes ({@code qa_release_review.json}, {@code corpus_closure_matrix.json},
 * {@code legacy_replacement_mapping.json}) and the fingerprinted decision ledger {@code qa/approvals.json}. Nothing is
 * written. Raw source files are only read (hashing); {@code imports/source-files/**} is never modified.
 */
public final class ExamStagingCorpus {

    public static final String VIEW_VERSION = "exam-operations-view-v1";

    final Path repoRoot;
    final Path staging;
    private final ObjectMapper mapper;
    private final Instant now;
    private final JsonNode qaReview;
    private final JsonNode matrix;
    private final List<JsonNode> legacy;
    private final ExamQaDecisionLedger.LedgerView ledger;
    private final Map<String, Evaluated> packages = new TreeMap<>();

    /** Everything the operations center shows about one staged package. */
    record Evaluated(String testId, ExamContentPackage pkg, ExamPackageIdentity identity, ExamFormValidationReport structural,
                     List<String> closureCodes, ExamRuntimeCompatibility.Report compat, ExamMediaImportPlan.Plan media,
                     ExamReleaseReadinessGate.Decision gate, List<ScopeReadiness> scopes,
                     ExamImportPlanner.Plan localPlan, ExamImportPlanner.Plan productionPlan, JsonNode qa, JsonNode matrixRow,
                     List<JsonNode> legacyRows) {}

    private ExamStagingCorpus(Path repoRoot, ObjectMapper mapper, Instant now) throws IOException {
        this.repoRoot = repoRoot;
        this.staging = repoRoot.resolve("imports").resolve("exams").resolve("staging");
        this.mapper = mapper;
        this.now = now;
        this.qaReview = readJson(staging.resolve("reports").resolve("qa_release_review.json"));
        this.matrix = readJson(staging.resolve("reports").resolve("corpus_closure_matrix.json"));
        List<JsonNode> l = new ArrayList<>();
        for (JsonNode m : readJson(staging.resolve("reports").resolve("legacy_replacement_mapping.json")).path("mappings")) l.add(m);
        this.legacy = l;
        this.ledger = ExamQaDecisionLedger.read(staging.resolve("qa").resolve("approvals.json"), mapper);
    }

    /** The staged-package directory of a repository root (exists only in a local Exams worktree). */
    public static Path extractedDir(Path repoRoot) {
        return repoRoot.resolve("imports").resolve("exams").resolve("staging").resolve("extracted");
    }

    public static ExamStagingCorpus load(Path repoRoot, ObjectMapper mapper, ExamImportPlanner.StateReader localState,
                                         Instant now) throws IOException {
        ExamStagingCorpus c = new ExamStagingCorpus(repoRoot, mapper, now);
        Path extracted = extractedDir(repoRoot);
        if (!Files.isDirectory(extracted)) return c;
        List<Path> files;
        try (Stream<Path> s = Files.walk(extracted, 6)) {
            files = s.filter(f -> f.toString().endsWith(".json")).sorted().toList();
        }
        List<ExamImportPlanner.ReplacementMapping> mappings = new ArrayList<>();
        for (JsonNode m : c.legacy) {
            if (m.path("canonical").isObject()) {
                mappings.add(new ExamImportPlanner.ReplacementMapping(m.path("legacyLogicalKey").asText(),
                        m.path("legacyPackageId").asText(), m.path("canonical").path("sourceKey").asText(), m.path("status").asText()));
            }
        }
        for (Path p : files) {
            String id = testIdOf(p);
            if (id == null) continue;
            ExamContentPackage pkg = mapper.readValue(p.toFile(), ExamContentPackage.class);
            c.packages.put(id, c.evaluate(id, pkg, mappings, localState));
        }
        return c;
    }

    /** {@code toeic/ets-2026/test-1} from {@code .../toeic/ets/ets-2026/ets-2026__test-1.json} (the staging convention). */
    static String testIdOf(Path p) {
        String norm = p.toString().replace('\\', '/');
        String fam = norm.contains("/toeic/") ? "toeic" : norm.contains("/ielts/") ? "ielts" : null;
        String[] bt = p.getFileName().toString().replace(".json", "").split("__");
        if (fam == null || bt.length != 2) return null;
        return fam + "/" + bt[0] + "/" + bt[1];
    }

    private Evaluated evaluate(String testId, ExamContentPackage pkg, List<ExamImportPlanner.ReplacementMapping> mappings,
                               ExamImportPlanner.StateReader localState) {
        ExamFormValidationReport structural = ExamFormValidator.validate(ExamContentTree.fromPackage(pkg, mapper), mapper, now);
        List<String> closure = new ExamContentPackageValidator(mapper).validate(pkg, now).errors().stream()
                .map(ExamContentPackage.ValidationError::code).toList();
        ExamRuntimeCompatibility.Report compat = ExamRuntimeCompatibility.audit(pkg);
        JsonNode qa = qaReview.path("packages").path(testId);
        ExamMediaImportPlan.Plan media = ExamMediaImportPlan.plan(pkg, repoRoot, true, cropQa(qa));
        ExamReleaseReadinessGate.Decision gate = ExamReleaseReadinessGate.evaluate(pkg, structural, closure, compat, qaStatus(qa), media);
        ExamProjectUsageAuthorization.StagingRightsDecision rights = ExamProjectUsageAuthorization.stagingRightsGate(pkg, closure);
        // staging practice readiness = the Phase 6 matrix basis (owner-authorized LOCAL facts, PILOT lifecycle) — diagnostic only
        List<ScopeReadiness> scopes = ExamPracticeReadiness.evaluate(ExamContentTree.fromPackage(pkg, mapper), structural,
                ExamRunnerCapabilities.CURRENT, new ExamPracticeReadiness.FormFacts(true, rights.cleared()), mapper);
        ExamImportPlanner.Plan local = ExamImportPlanner.plan(pkg, structural, gate, media, mappings,
                localState == null ? ExamImportPlanner.StateReader.EMPTY : localState, ExamImportPlanner.Target.LOCAL_DRY_RUN);
        // no production access exists here: the production plan is computed without a target state and is always BLOCKED
        ExamImportPlanner.Plan prod = ExamImportPlanner.plan(pkg, structural, gate, media, mappings,
                ExamImportPlanner.StateReader.EMPTY, ExamImportPlanner.Target.PRODUCTION);
        ExamPackageIdentity identity = ExamPackageIdentity.of(pkg);
        JsonNode matrixRow = MissingNode.getInstance();
        for (JsonNode r : matrix.path("packages")) if (testId.equals(r.path("testId").asText())) matrixRow = r;
        List<JsonNode> legacyRows = legacy.stream()
                .filter(m -> identity.sourceKey().equals(m.path("canonical").path("sourceKey").asText())).toList();
        return new Evaluated(testId, pkg, identity, structural, closure, compat, media, gate, scopes, local, prod, qa, matrixRow,
                legacyRows);
    }

    // ─── QA facts from the canonical review report (same derivation as the release-readiness tests) ─────────────────

    static ExamReleaseReadinessGate.QaStatus qaStatus(JsonNode p) {
        if (p.isMissingNode()) return new ExamReleaseReadinessGate.QaStatus(false, Map.of(), Set.of(), Set.of());
        Map<String, Integer> open = new TreeMap<>();
        p.path("openByReleasePriority").fields().forEachRemaining(e -> open.put(e.getKey(), e.getValue().asInt()));
        Set<String> openSubtypes = new TreeSet<>(), openStatuses = new TreeSet<>(), all = new TreeSet<>();
        Set<String> blocking = Set.of("OPEN", "REJECTED", "STALE_DECISION", "CORRECTION_PENDING");
        for (JsonNode e : p.path("entries")) {
            all.add(e.path("subtype").asText());
            if (blocking.contains(e.path("status").asText())
                    && ExamReleaseReadinessGate.QaStatus.BLOCKING.contains(e.path("releasePriority").asText())) {
                openSubtypes.add(e.path("subtype").asText());
                openStatuses.add(e.path("status").asText());
            }
        }
        return new ExamReleaseReadinessGate.QaStatus(!p.path("package").isNull(), open, openSubtypes, all, openStatuses);
    }

    static Map<String, ExamMediaImportPlan.CropQa> cropQa(JsonNode p) {
        Map<String, ExamMediaImportPlan.CropQa> out = new HashMap<>();
        p.path("cropUnits").fields().forEachRemaining(e -> out.put(
                e.getValue().path("cropSha256").asText().toLowerCase(Locale.ROOT),
                new ExamMediaImportPlan.CropQa(e.getValue().path("technical").asText(), e.getValue().path("humanApproved").asBoolean(),
                        e.getValue().path("ownerTechnicalApproved").asBoolean())));
        return out;
    }

    // ─── views ─────────────────────────────────────────────────────────────────────────────────

    public Set<String> testIds() {
        return packages.keySet();
    }

    Optional<Evaluated> evaluated(String testId) {
        return Optional.ofNullable(packages.get(testId));
    }

    ExamQaDecisionLedger.LedgerView ledger() {
        return ledger;
    }

    public List<PackageRowDto> rows() {
        return packages.values().stream().map(this::row).toList();
    }

    PackageRowDto row(Evaluated e) {
        ExamContentPackage pkg = e.pkg();
        Map<String, Object> ident = sourceIdentity(pkg);
        Map<String, Integer> practice = new TreeMap<>();
        for (ScopeReadiness s : e.scopes()) practice.merge(s.learnerState().name(), 1, Integer::sum);
        Map<String, Integer> openQa = new TreeMap<>();
        e.qa().path("openByReleasePriority").fields().forEachRemaining(x -> openQa.put(x.getKey(), x.getValue().asInt()));
        Map<String, Boolean> gate = new LinkedHashMap<>();
        e.gate().asMap().forEach((k, v) -> { if (v instanceof Boolean b) gate.put(k, b); });
        int ready = (int) e.media().entries().stream().filter(ExamMediaImportPlan.Entry::ready).count();
        int awaiting = (int) e.media().entries().stream().filter(ExamMediaImportPlan.Entry::waitingOnlyForHuman).count();
        String matrixHash = e.matrixRow().path("manifestContentHash").asText(null);
        return new PackageRowDto(e.testId(), pkg.manifest().packageId(), pkg.manifest().packageVersion(), e.identity().sourceKey(),
                str(ident.get("family"), pkg.form() == null ? null : String.valueOf(pkg.form().family())),
                str(ident.get("collection"), null), str(ident.get("book"), null), str(ident.get("test"), null),
                e.identity().semanticFingerprint(), pkg.manifest().contentHash(), e.structural().status().name(), gate,
                e.gate().importReady(), e.gate().readyExceptHumanQa(),
                e.matrixRow().isMissingNode() ? "UNCLASSIFIED" : e.matrixRow().path("disposition").asText("UNCLASSIFIED"),
                matrixHash != null && !matrixHash.equals(pkg.manifest().contentHash()), openQa, e.media().entries().size(), ready,
                awaiting, practice, projectAuthorizationStatus(pkg), publisherLicenceSummary(pkg),
                ExamReleaseReadinessGate.provenanceGaps(pkg).isEmpty(), e.localPlan().operation().name(),
                e.productionPlan().operation().name());
    }

    public Optional<PackageDetailDto> detail(String testId) {
        Evaluated e = packages.get(testId);
        if (e == null) return Optional.empty();
        ExamContentPackage pkg = e.pkg();
        Set<String> currentShas = new HashSet<>();
        for (ExamMediaImportPlan.Entry m : e.media().entries()) if (m.sha256() != null) currentShas.add(m.sha256().toLowerCase(Locale.ROOT));

        List<QaEntryDto> entries = new ArrayList<>();
        for (JsonNode q : e.qa().path("entries")) {
            boolean current = Objects.equals(q.path("packageContentHash").asText(null), pkg.manifest().contentHash());
            entries.add(qaDto(q.path("id").asText(), "QUEUE_ENTRY", q, current, null, null, List.of()));
        }
        List<QaEntryDto> crops = new ArrayList<>();
        e.qa().path("cropUnits").fields().forEachRemaining(x -> {
            JsonNode u = x.getValue();
            String sha = u.path("cropSha256").asText("").toLowerCase(Locale.ROOT);
            List<String> codes = new ArrayList<>();
            u.path("technicalCodes").forEach(c -> codes.add(c.asText()));
            crops.add(qaDto(x.getKey(), "CROP_UNIT", u, currentShas.contains(sha), sha, u.path("technical").asText(null), codes));
        });

        Map<String, Integer> bindings = new HashMap<>();
        for (ExamContentPackage.StimulusAssetPlacement sa : pkg.stimulusAssets()) {
            if (sa.assetId() != null) bindings.merge(sa.assetId().toString(), 1, Integer::sum);
        }
        List<MediaAssetDto> media = e.media().entries().stream().map(m -> new MediaAssetDto(m.assetId(), m.sha256(), m.mimeType(),
                m.roles(), m.stimulusKinds(), m.validationState(), m.sourceKind().name(), m.fileStatus().name(), m.ready(), m.bound(),
                bindings.getOrDefault(m.assetId(), 0), m.cropTechnical(), m.cropHumanApproved(), m.waitingOnlyForHuman(),
                previewable(m))).toList();

        List<PracticeScopeOpsDto> scopes = e.scopes().stream().map(s -> new PracticeScopeOpsDto(s.scope().scopeCode(),
                s.scope().scopeType().name(), s.scope().number(), s.learnerState().name(), s.ready(), s.reasonCodes(),
                s.scope().itemCount())).toList();

        List<Map<String, Object>> diags = e.compat().diagnostics().stream().map(d -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("gate", d.gate().name());
            m.put("code", d.code());
            m.put("severity", d.severity().name());
            m.put("occurrences", d.occurrences());
            return m;
        }).toList();

        List<LegacyMappingDto> legacy = e.legacyRows().stream().map(m -> new LegacyMappingDto(m.path("legacyLogicalKey").asText(null),
                m.path("legacyPackageId").asText(null), m.path("status").asText(null), m.path("proposedAction").asText(null),
                m.path("executed").asBoolean(false), m.path("replacementReady").asBoolean(false))).toList();

        List<String> reasonCodes = new ArrayList<>();
        e.matrixRow().path("blockingReasonCodes").forEach(r -> reasonCodes.add(r.asText()));

        return Optional.of(new PackageDetailDto(row(e), e.structural().validatorVersion(), e.structural().blockingCodes().stream()
                .map(Object::toString).toList(), e.gate().reasons(), e.compat().blockingCodes(ExamRuntimeCompatibility.Gate.RUNNER),
                e.compat().blockingCodes(ExamRuntimeCompatibility.Gate.SCORING), new ArrayList<>(e.compat().reviewCodes()), diags,
                entries, crops, media, scopes,
                "Staging readiness on the owner-authorized LOCAL basis (PILOT lifecycle) — the Phase 6 matrix view; never production.",
                rights(pkg, e.closureCodes()), provenance(pkg), List.of(plan(e.localPlan()), plan(e.productionPlan())), legacy,
                lifecycle(e, legacy), reasonCodes, e.matrixRow().path("nextAction").asText(null)));
    }

    private QaEntryDto qaDto(String entryId, String kind, JsonNode q, boolean reportCurrent, String cropSha, String technical,
                             List<String> technicalCodes) {
        String fingerprint = q.path("fingerprint").asText(null);
        String status = q.has("status") ? q.path("status").asText() : q.path("decisionStatus").asText(null);
        Optional<ExamQaDecisionLedger.Decision> latest = ledger.latest(entryId);
        LedgerDecisionDto dec = latest.map(d -> new LedgerDecisionDto(d.decision(), d.reviewer(), d.reviewedAt(),
                Objects.equals(d.fingerprint(), fingerprint), d.recordedVia())).orElse(null);
        boolean pending = dec != null && dec.fingerprintCurrent() && "OPEN".equals(status);
        boolean decidable = reportCurrent && fingerprint != null && !"RESOLVED_BY_PROOF".equals(status)
                && !(dec != null && dec.fingerprintCurrent());
        Integer page = q.path("page").isNumber() ? q.path("page").asInt() : null;
        Object questions = q.has("questions") ? mapper.convertValue(q.path("questions"), Object.class) : null;
        return new QaEntryDto(entryId, kind, q.path("type").asText(null), q.path("subtype").asText(null),
                q.path("severity").asText(null), q.path("releasePriority").asText(null), status, fingerprint, page, questions,
                cropSha, technical, technicalCodes, reportCurrent, dec, pending, decidable);
    }

    static boolean previewable(ExamMediaImportPlan.Entry m) {
        return m.mimeType() != null && m.mimeType().startsWith("image/") && m.fileStatus() == ExamMediaImportPlan.FileStatus.VERIFIED
                && m.sourcePath() != null && m.sourceKind() != ExamMediaImportPlan.SourceKind.RAW_ZIP_MEMBER;
    }

    /** Verified image bytes of a staged asset (admin crop review). Only a planned, hash-verified image under the root. */
    public Optional<byte[]> imageBytes(String testId, String sha256) throws IOException {
        Evaluated e = packages.get(testId);
        if (e == null || sha256 == null) return Optional.empty();
        for (ExamMediaImportPlan.Entry m : e.media().entries()) {
            if (!sha256.equalsIgnoreCase(m.sha256()) || !previewable(m)) continue;
            Path file = repoRoot.resolve(m.sourcePath()).normalize();
            if (!file.startsWith(repoRoot.normalize()) || !Files.isRegularFile(file)) return Optional.empty();
            byte[] bytes = Files.readAllBytes(file);
            if (!sha256(bytes).equalsIgnoreCase(sha256)) return Optional.empty();
            return Optional.of(bytes);
        }
        return Optional.empty();
    }

    Optional<String> imageMime(String testId, String sha256) {
        Evaluated e = packages.get(testId);
        if (e == null) return Optional.empty();
        return e.media().entries().stream().filter(m -> m.sha256() != null && m.sha256().equalsIgnoreCase(sha256))
                .map(ExamMediaImportPlan.Entry::mimeType).findFirst();
    }

    // ─── rights / provenance / plans / lifecycle ──────────────────────────────────────────────

    static String projectAuthorizationStatus(ExamContentPackage pkg) {
        return ExamProjectUsageAuthorization.fromManifest(pkg.manifest()).map(ExamProjectUsageAuthorization::status).orElse("ABSENT");
    }

    static String publisherLicenceSummary(ExamContentPackage pkg) {
        if (pkg.licenses().isEmpty()) return "MISSING";
        Set<String> states = new TreeSet<>();
        for (LicenseRecord l : pkg.licenses()) states.add(l.legalStatus() == null ? "UNKNOWN" : l.legalStatus());
        return String.join(",", states);
    }

    static RightsDto rights(ExamContentPackage pkg, List<String> closureCodes) {
        Map<String, Object> auth = new LinkedHashMap<>();
        ExamProjectUsageAuthorization.fromManifest(pkg.manifest()).ifPresentOrElse(a -> {
            auth.put("status", a.status());
            auth.put("scope", a.scope());
            auth.put("appliesTo", a.appliesTo());
            auth.put("decisionDate", a.decisionDate());
            auth.put("permits", a.permits());
            auth.put("productionImport", a.productionImport());
            auth.put("publisherLicenceStatement", a.publisherLicence());
            auth.put("publisherEndorsement", a.publisherEndorsement());
        }, () -> auth.put("status", "ABSENT"));
        List<Map<String, Object>> licences = new ArrayList<>();
        for (LicenseRecord l : pkg.licenses()) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("licenseCode", l.licenseCode());
            m.put("provenanceCategory", l.provenanceCategory() == null ? null : l.provenanceCategory().name());
            m.put("legalStatus", l.legalStatus());
            m.put("commercialRights", l.commercialRights());
            m.put("redistributionRights", l.redistributionRights());
            m.put("derivativeRights", l.derivativeRights());
            m.put("validFrom", l.validFrom());
            m.put("validUntil", l.validUntil());
            licences.add(m);
        }
        List<String> gaps = closureCodes.stream().filter(c -> c.startsWith("RIGHTS_")).distinct().sorted().toList();
        ExamRightsDecisionPolicy.ProjectAuthorizationFacts facts =
                ExamRightsDecisionPolicy.ProjectAuthorizationFacts.fromMetadata(pkg.manifest().metadata(), null);
        List<RightsDecisionDto> decisions = new ArrayList<>();
        for (Object[] bo : new Object[][]{
                {ExamRightsDecisionPolicy.Basis.OWNER_PROJECT_AUTHORIZATION_LOCAL, ExamRightsDecisionPolicy.Operation.LOCAL_STAGING_IMPORT},
                {ExamRightsDecisionPolicy.Basis.PUBLISHER_LICENCE, ExamRightsDecisionPolicy.Operation.LEARNER_RUNTIME},
                {ExamRightsDecisionPolicy.Basis.PUBLISHER_LICENCE, ExamRightsDecisionPolicy.Operation.PUBLICATION},
                {ExamRightsDecisionPolicy.Basis.OWNER_PROJECT_AUTHORIZATION_LOCAL, ExamRightsDecisionPolicy.Operation.PUBLICATION}}) {
            ExamRightsDecisionPolicy.Decision d = ExamRightsDecisionPolicy.decide(closureCodes, facts,
                    (ExamRightsDecisionPolicy.Basis) bo[0], (ExamRightsDecisionPolicy.Operation) bo[1]);
            decisions.add(new RightsDecisionDto(d.basis().name(), d.operation().name(), d.allowed(), d.reason().name(),
                    d.grantedBy(), d.unclearedRightsCodes()));
        }
        return new RightsDto(auth, licences, gaps, decisions, ExamRightsDecisionPolicy.POLICY_VERSION);
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> sourceIdentity(ExamContentPackage pkg) {
        Map<String, Object> meta = pkg.manifest().metadata();
        return meta != null && meta.get("sourceIdentity") instanceof Map<?, ?> m ? (Map<String, Object>) m : Map.of();
    }

    static ProvenanceDto provenance(ExamContentPackage pkg) {
        List<String> gaps = ExamReleaseReadinessGate.provenanceGaps(pkg);
        Optional<ExamPackageSourceProvenance> p = ExamPackageSourceProvenance.fromManifest(pkg.manifest());
        Map<String, Object> identity = new LinkedHashMap<>(sourceIdentity(pkg));
        return new ProvenanceDto(gaps.isEmpty(), gaps, p.map(ExamPackageSourceProvenance::rawSourcePath).orElse(null),
                p.map(ExamPackageSourceProvenance::rawSourceSha256).orElse(null), p.map(ExamPackageSourceProvenance::pageRange).orElse(null),
                p.map(x -> x.audio().size()).orElse(0), p.map(ExamPackageSourceProvenance::extractorName).orElse(null),
                p.map(ExamPackageSourceProvenance::extractorVersion).orElse(null), p.map(ExamPackageSourceProvenance::reviewStatus).orElse(null),
                identity);
    }

    static ImportPlanDto plan(ExamImportPlanner.Plan p) {
        return new ImportPlanDto(p.target().name(), p.operation().name(), p.contentOperation().name(), p.blockers(), p.notes(),
                p.planId(), p.planVersion(), p.plannedPackageVersion(), p.plannedFormVersion(), p.changedPlacements().size(),
                p.reusedPlacements().size(), p.retireConsiderations(), p.operation() != ExamImportPlanner.Operation.BLOCKED);
    }

    static LifecyclePlanDto lifecycle(Evaluated e, List<LegacyMappingDto> legacy) {
        List<String> blockers = new ArrayList<>();
        if (e.localPlan().contentOperation() != ExamImportPlanner.Operation.ALREADY_IMPORTED) blockers.add("NOT_IMPORTED");
        if (!e.gate().importReady()) blockers.add("RELEASE_GATE_NOT_IMPORT_READY");
        ExamRightsDecisionPolicy.Decision pub = ExamRightsDecisionPolicy.decide(e.closureCodes(),
                ExamRightsDecisionPolicy.ProjectAuthorizationFacts.fromMetadata(e.pkg().manifest().metadata(), null),
                ExamRightsDecisionPolicy.Basis.PUBLISHER_LICENCE, ExamRightsDecisionPolicy.Operation.PUBLICATION);
        if (!pub.allowed()) blockers.add("PUBLICATION_RIGHTS:" + pub.reason().name());
        blockers.add("PRODUCTION_PUBLICATION_DEFERRED_TO_PHASE_10");
        List<String> retire = new ArrayList<>();
        for (LegacyMappingDto m : legacy) {
            if ("EXACT_SOURCE_MATCH".equals(m.status())) {
                retire.add("CONSIDER_RETIRE_AFTER_REPLACEMENT_PUBLISHED:" + m.legacyLogicalKey() + " (executed=false)");
            }
        }
        return new LifecyclePlanDto("PLAN_ONLY", false, blockers, !retire.isEmpty(), retire);
    }

    // ─── totals ────────────────────────────────────────────────────────────────────────────────

    public Map<String, Integer> gateTotals() {
        Map<String, Integer> t = new LinkedHashMap<>();
        for (String k : List.of("STRUCTURAL_VALID", "RUNNER_COMPATIBLE", "SCORING_COMPATIBLE", "MEDIA_READY", "QA_APPROVED",
                "PROJECT_AUTHORIZED", "PROVENANCE_COMPLETE", "IMPORT_READY", "READY_EXCEPT_HUMAN_QA")) t.put(k, 0);
        for (Evaluated e : packages.values()) {
            e.gate().asMap().forEach((k, v) -> { if (Boolean.TRUE.equals(v)) t.merge(k, 1, Integer::sum); });
        }
        t.put("PACKAGES", packages.size());
        return t;
    }

    public Map<String, Integer> dispositionTotals() {
        Map<String, Integer> t = new TreeMap<>();
        for (Evaluated e : packages.values()) {
            t.merge(e.matrixRow().isMissingNode() ? "UNCLASSIFIED" : e.matrixRow().path("disposition").asText("UNCLASSIFIED"), 1, Integer::sum);
        }
        return t;
    }

    public Map<String, Integer> practiceTotals() {
        Map<String, Integer> t = new TreeMap<>();
        for (Evaluated e : packages.values()) for (ScopeReadiness s : e.scopes()) t.merge(s.learnerState().name(), 1, Integer::sum);
        return t;
    }

    public LedgerSummaryDto ledgerSummary() {
        int pending = 0;
        for (Evaluated e : packages.values()) {
            for (JsonNode q : e.qa().path("entries")) {
                String fp = q.path("fingerprint").asText(null);
                if ("OPEN".equals(q.path("status").asText()) && ledger.latest(q.path("id").asText())
                        .filter(d -> Objects.equals(d.fingerprint(), fp)).isPresent()) pending++;
            }
            Iterator<Map.Entry<String, JsonNode>> it = e.qa().path("cropUnits").fields();
            while (it.hasNext()) {
                Map.Entry<String, JsonNode> u = it.next();
                String fp = u.getValue().path("fingerprint").asText(null);
                if ("OPEN".equals(u.getValue().path("decisionStatus").asText()) && ledger.latest(u.getKey())
                        .filter(d -> Objects.equals(d.fingerprint(), fp)).isPresent()) pending++;
            }
        }
        return new LedgerSummaryDto(ledger.present(), ledger.valid().size(), ledger.invalidCount(), ledger.recordedViaAdmin(), pending);
    }

    // ─── helpers ───────────────────────────────────────────────────────────────────────────────

    private JsonNode readJson(Path p) throws IOException {
        return Files.isRegularFile(p) ? mapper.readTree(p.toFile()) : MissingNode.getInstance();
    }

    private static String str(Object o, String fallback) {
        return o == null ? fallback : String.valueOf(o);
    }

    static String sha256(byte[] bytes) {
        try {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
            return java.util.HexFormat.of().formatHex(md.digest(bytes));
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
