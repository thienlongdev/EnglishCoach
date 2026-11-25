package com.englishcoach.exams.release;

import com.englishcoach.exams.content.ExamContentPackage;
import com.englishcoach.exams.content.ExamPackageSourceProvenance;
import com.englishcoach.exams.content.ExamProjectUsageAuthorization;
import com.englishcoach.exams.model.ExamContentRecords.AssetRecord;
import com.englishcoach.exams.model.ExamContentRecords.StimulusVersionRecord;
import com.englishcoach.exams.validation.ExamFormValidationReport;
import com.englishcoach.exams.validation.ExamContentValidationStatus;

import java.util.*;

/**
 * Exams Recovery Phase 4D.8 — release readiness, kept SEPARATE from the Phase 2 structural status (a form may be
 * structurally VALID_FULL and still not runtime-ready). Every dimension is DERIVED from read-only truth; there is no
 * admin boolean:
 * <pre>
 * STRUCTURAL_VALID    Phase 2 ExamFormValidator: status VALID and fullSimulationEligible
 * QA_APPROVED         no OPEN / REJECTED human-QA entry of release priority P0–P3 (qa_release_review.json, built from the
 *                     QA queue + human decisions ledger), and every REVIEW diagnostic of the compatibility audit has a
 *                     queue entry that covers it
 * RUNNER_COMPATIBLE   ExamRuntimeCompatibility: no RUNNER blocking diagnostic
 * SCORING_COMPATIBLE  ExamRuntimeCompatibility: no SCORING blocking diagnostic
 * MEDIA_READY         ExamMediaImportPlan: every asset VALIDATED and its bytes re-verified by SHA-256
 * PROJECT_AUTHORIZED  ExamProjectUsageAuthorization staging gate cleared (OWNER_AUTHORIZED + raw-corpus provenance) —
 *                     the publisher licence is NOT rewritten
 * PROVENANCE_COMPLETE source provenance valid; source identity bound to the same raw SHA-256; every audio asset traced
 *                     to raw audio (or a derived segment of it); every visual traced to a source page
 * IMPORT_READY        all seven
 * </pre>
 * READY_EXCEPT_HUMAN_QA (Phase 4.1I.1, informational, never an import permission): every ENGINEERING dimension holds
 * (structural, runner, scoring, project authorization, provenance; media bytes / hashes / bindings / technical crop
 * checks) and the only thing missing is owner review — every open QA entry is OPEN awaiting a human decision (none
 * REJECTED, STALE or CORRECTION_PENDING) and every not-ready asset is a technically valid crop awaiting approval.
 */
public final class ExamReleaseReadinessGate {

    private ExamReleaseReadinessGate() {}

    /** QA facts for one package, derived from reports/qa_release_review.json. */
    public record QaStatus(boolean packageKnown, Map<String, Integer> openByReleasePriority, Set<String> openSubtypes,
                           Set<String> allSubtypes, Set<String> openStatuses) {
        public static final List<String> BLOCKING = List.of("P0", "P1", "P2", "P3");

        public QaStatus(boolean packageKnown, Map<String, Integer> openByReleasePriority, Set<String> openSubtypes,
                        Set<String> allSubtypes) {
            this(packageKnown, openByReleasePriority, openSubtypes, allSubtypes, Set.of("OPEN"));
        }

        /** Open blockers exist only because no human decided yet (none rejected / stale / correction pending). */
        public boolean onlyAwaitingHuman() {
            return packageKnown && openStatuses.stream().allMatch("OPEN"::equals);
        }

        public boolean approved() {
            return packageKnown && BLOCKING.stream().noneMatch(p -> openByReleasePriority.getOrDefault(p, 0) > 0);
        }
    }

    /** Compatibility REVIEW code → QA queue subtype that must exist (and be approved) for it. */
    static final Map<String, String> REVIEW_COVERAGE = Map.of(
            "MULTI_DOC_BOUNDARY_NOT_SEGMENTED", "LAYOUT_LINEARIZED",
            "RUNNER_COMPLETION_TEMPLATE_INCOMPLETE", "COMPLETION_TEMPLATE_PER_ITEM");   // Phase 4.1A

    public record Decision(String packageId, boolean structuralValid, boolean qaApproved, boolean runnerCompatible,
                           boolean scoringCompatible, boolean mediaReady, boolean projectAuthorized,
                           boolean provenanceComplete, List<String> reasons, boolean readyExceptHumanQa) {
        public Decision(String packageId, boolean structuralValid, boolean qaApproved, boolean runnerCompatible,
                        boolean scoringCompatible, boolean mediaReady, boolean projectAuthorized,
                        boolean provenanceComplete, List<String> reasons) {
            this(packageId, structuralValid, qaApproved, runnerCompatible, scoringCompatible, mediaReady,
                    projectAuthorized, provenanceComplete, reasons, false);
        }

        public boolean importReady() {
            return structuralValid && qaApproved && runnerCompatible && scoringCompatible && mediaReady
                    && projectAuthorized && provenanceComplete;
        }

        /** Set by {@link #evaluate}; see the class comment. False whenever IMPORT_READY is true. */
        public boolean readyExceptHumanQa() {
            return readyExceptHumanQa;
        }

        public Map<String, Object> asMap() {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("STRUCTURAL_VALID", structuralValid);
            m.put("QA_APPROVED", qaApproved);
            m.put("RUNNER_COMPATIBLE", runnerCompatible);
            m.put("SCORING_COMPATIBLE", scoringCompatible);
            m.put("MEDIA_READY", mediaReady);
            m.put("PROJECT_AUTHORIZED", projectAuthorized);
            m.put("PROVENANCE_COMPLETE", provenanceComplete);
            m.put("IMPORT_READY", importReady());
            m.put("READY_EXCEPT_HUMAN_QA", readyExceptHumanQa);
            m.put("reasons", reasons);
            return m;
        }
    }

    public static Decision evaluate(ExamContentPackage pkg, ExamFormValidationReport structural,
                                    Collection<String> closureErrorCodes, ExamRuntimeCompatibility.Report compat,
                                    QaStatus qa, ExamMediaImportPlan.Plan media) {
        List<String> reasons = new ArrayList<>();

        boolean structuralValid = structural != null && structural.status() == ExamContentValidationStatus.VALID
                && structural.fullSimulationEligible();
        if (!structuralValid) {
            reasons.add("STRUCTURAL: " + (structural == null ? "UNKNOWN" : structural.status() + " " + structural.blockingCodes()));
        }

        boolean qaApproved = qa != null && qa.approved();
        if (qa == null || !qa.packageKnown()) reasons.add("QA: package not in the QA release review");
        else if (!qa.approved()) reasons.add("QA: open release-priority entries " + qa.openByReleasePriority());
        for (String code : compat.reviewCodes()) {
            String subtype = REVIEW_COVERAGE.get(code);
            boolean covered = subtype != null && qa != null && qa.allSubtypes().contains(subtype);
            if (!covered) {
                qaApproved = false;
                reasons.add("QA: compatibility review " + code + " has no QA queue entry to approve");
            }
        }

        if (!compat.runnerCompatible()) reasons.add("RUNNER: " + compat.blockingCodes(ExamRuntimeCompatibility.Gate.RUNNER));
        if (!compat.scoringCompatible()) reasons.add("SCORING: " + compat.blockingCodes(ExamRuntimeCompatibility.Gate.SCORING));

        boolean mediaReady = media != null && media.mediaReady();
        if (!mediaReady) reasons.add("MEDIA: " + (media == null ? "no plan" : media.blockers()));

        ExamProjectUsageAuthorization.StagingRightsDecision rights =
                ExamProjectUsageAuthorization.stagingRightsGate(pkg, closureErrorCodes);
        boolean projectAuthorized = rights.cleared() && rights.ownerAuthorized();
        if (!projectAuthorized) reasons.add("RIGHTS: " + rights.reason() + " uncleared=" + rights.unclearedRightsCodes());

        List<String> provenanceGaps = provenanceGaps(pkg);
        boolean provenanceComplete = provenanceGaps.isEmpty();
        if (!provenanceComplete) reasons.add("PROVENANCE: " + provenanceGaps);

        boolean engineering = structuralValid && compat.runnerCompatible() && compat.scoringCompatible()
                && projectAuthorized && provenanceComplete;
        boolean coverageOk = compat.reviewCodes().stream().allMatch(code -> REVIEW_COVERAGE.get(code) != null
                && qa != null && qa.allSubtypes().contains(REVIEW_COVERAGE.get(code)));
        boolean importReady = structuralValid && qaApproved && compat.runnerCompatible() && compat.scoringCompatible()
                && mediaReady && projectAuthorized && provenanceComplete;
        boolean readyExceptHuman = !importReady && engineering && coverageOk
                && qa != null && qa.onlyAwaitingHuman()
                && media != null && (media.mediaReady() || media.readyExceptHumanCropQa());
        return new Decision(pkg.manifest().packageId(), structuralValid, qaApproved, compat.runnerCompatible(),
                compat.scoringCompatible(), mediaReady, projectAuthorized, provenanceComplete, reasons, readyExceptHuman);
    }

    @SuppressWarnings("unchecked")
    public static List<String> provenanceGaps(ExamContentPackage pkg) {
        List<String> gaps = new ArrayList<>();
        Optional<ExamPackageSourceProvenance> prov = ExamPackageSourceProvenance.fromManifest(pkg.manifest());
        if (prov.isEmpty() || !ExamPackageSourceProvenance.validate(pkg.manifest()).isEmpty()) {
            gaps.add("SOURCE_PROVENANCE_MISSING_OR_INVALID");
            return gaps;
        }
        Map<String, Object> meta = pkg.manifest().metadata();
        if (!(meta.get("sourceIdentity") instanceof Map<?, ?> identity)
                || identity.get("rawSourceSha256") == null
                || !String.valueOf(identity.get("rawSourceSha256")).equalsIgnoreCase(prov.get().rawSourceSha256())) {
            gaps.add("SOURCE_IDENTITY_NOT_BOUND_TO_RAW_SHA");
        }
        Set<String> rawAudio = new HashSet<>();
        for (ExamPackageSourceProvenance.AudioReference a : prov.get().audio()) {
            if (a.sha256() != null) rawAudio.add(a.sha256().toLowerCase(Locale.ROOT));
        }
        Map<String, String> segmentParent = new HashMap<>();
        if (meta.get("audioSegments") instanceof List<?> segs) {
            for (Object o : segs) if (o instanceof Map<?, ?> m && m.get("segmentSha256") != null) {
                segmentParent.put(String.valueOf(m.get("segmentSha256")).toLowerCase(Locale.ROOT),
                        m.get("parentSha256") == null ? "" : String.valueOf(m.get("parentSha256")).toLowerCase(Locale.ROOT));
            }
        }
        for (AssetRecord a : pkg.assets()) {
            String mime = a.mimeType() == null ? "" : a.mimeType().toLowerCase(Locale.ROOT);
            String sha = a.sha256Hash() == null ? "" : a.sha256Hash().toLowerCase(Locale.ROOT);
            if (mime.startsWith("audio/")) {
                boolean raw = rawAudio.contains(sha);
                String parent = segmentParent.get(sha);
                boolean derived = parent != null && !parent.isEmpty();
                if (!raw && !derived) gaps.add("AUDIO_ASSET_UNTRACED:" + a.id());
            }
        }
        for (StimulusVersionRecord st : pkg.stimuli()) {
            String kind = st.kind() == null ? "" : st.kind().toUpperCase(Locale.ROOT);
            if (Set.of("IMAGE", "CHART", "MAP", "DIAGRAM").contains(kind)
                    && (st.bodyPayload() == null || st.bodyPayload().get("sourcePage") == null)) {
                gaps.add("VISUAL_SOURCE_PAGE_MISSING:" + st.logicalStimulusKey());
            }
        }
        return gaps;
    }
}
