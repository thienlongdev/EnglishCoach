package com.englishcoach.exams.release;

import com.englishcoach.exams.content.ExamContentPackage;
import com.englishcoach.exams.content.ExamPackageIdentity;
import com.englishcoach.exams.model.ExamContentRecords.AssetRecord;
import com.englishcoach.exams.model.ExamContentRecords.PartRecord;
import com.englishcoach.exams.model.ExamContentRecords.StimulusVersionRecord;

import java.util.*;

/**
 * Exams Recovery Phase 5H — corpus-wide media provisioning manifest (LOCAL; nothing is uploaded, synced or published).
 * One entry per content-addressed asset (SHA-256), whatever the number of packages that bind it:
 * canonical asset id {@code sha256:<hash>}, MIME, bytes, role(s), bindings (package / form / stimulus / group
 * placement), the local staging or raw source it is read from, the derivation of an audio segment (parent SHA-256 +
 * interval + method), the target LOGICAL storage key (the content-addressed object key; never a URL — runtime URLs are
 * resolved per request through playback grants), validation state, technical crop status and the human approval an
 * image needs. A canonical field holding a URL or a localhost reference is reported as a violation.
 */
public final class ExamMediaImportManifest {

    private ExamMediaImportManifest() {}

    public static final String MANIFEST_VERSION = "exam-media-import-manifest-v1";

    /** Inputs of one package: the package, its media plan and the crop decision status per image SHA-256. */
    public record PackageMedia(ExamContentPackage pkg, ExamMediaImportPlan.Plan plan, Map<String, String> cropDecision) {}

    @SuppressWarnings("unchecked")
    public static Map<String, Object> build(Collection<PackageMedia> packages) {
        Map<String, Map<String, Object>> bySha = new TreeMap<>();
        List<String> violations = new ArrayList<>();
        int bindings = 0;
        for (PackageMedia pm : packages) {
            ExamContentPackage pkg = pm.pkg();
            String sourceKey = ExamPackageIdentity.of(pkg).sourceKey();
            Map<UUID, AssetRecord> assets = new HashMap<>();
            pkg.assets().forEach(a -> assets.put(a.id(), a));
            Map<UUID, StimulusVersionRecord> stimuli = new HashMap<>();
            pkg.stimuli().forEach(s -> stimuli.put(s.id(), s));
            Map<UUID, PartRecord> parts = new HashMap<>();
            pkg.parts().forEach(p -> parts.put(p.id(), p));
            Map<UUID, List<String>> placementsByGroup = new HashMap<>();
            for (ExamContentPackage.FormGroupPlacement fg : pkg.formGroups()) {
                PartRecord p = parts.get(fg.partId());
                placementsByGroup.computeIfAbsent(fg.groupId(), k -> new ArrayList<>())
                        .add((p == null ? "?" : p.partCode()) + "#" + fg.ordinal()
                                + (fg.displayNumbering() == null ? "" : " (" + fg.displayNumbering() + ")"));
            }
            Map<UUID, Set<String>> placementsByStimulus = new HashMap<>();
            for (ExamContentPackage.GroupStimulusPlacement gs : pkg.groupStimuli()) {
                placementsByStimulus.computeIfAbsent(gs.stimulusId(), k -> new TreeSet<>())
                        .addAll(placementsByGroup.getOrDefault(gs.groupId(), List.of()));
            }
            Map<String, ExamMediaImportPlan.Entry> planBySha = new HashMap<>();
            for (ExamMediaImportPlan.Entry e : pm.plan().entries()) planBySha.put(e.sha256(), e);

            for (ExamContentPackage.StimulusAssetPlacement sa : pkg.stimulusAssets()) {
                AssetRecord a = assets.get(sa.assetId());
                if (a == null) continue;
                String sha = a.sha256Hash() == null ? "" : a.sha256Hash().toLowerCase(Locale.ROOT);
                ExamMediaImportPlan.Entry pe = planBySha.get(sha);
                Map<String, Object> entry = bySha.computeIfAbsent(sha, k -> newEntry(a, pe, pm.cropDecision()));
                StimulusVersionRecord st = stimuli.get(sa.stimulusId());
                Map<String, Object> b = new LinkedHashMap<>();
                b.put("sourceKey", sourceKey);
                b.put("packageId", pkg.manifest().packageId());
                b.put("formLogicalKey", pkg.form().logicalKey());
                b.put("stimulusKey", st == null ? null : st.logicalStimulusKey());
                b.put("stimulusKind", st == null ? null : st.kind());
                b.put("role", sa.role());
                b.put("groupPlacements", placementsByStimulus.getOrDefault(sa.stimulusId(), Set.of()));
                ((List<Object>) entry.get("bindings")).add(b);
                ((Set<String>) entry.get("roles")).add(sa.role());
                bindings++;
            }
            // an asset no stimulus binds is still listed (bindingCount 0): it can never be silently dropped
            for (AssetRecord a : pkg.assets()) {
                String sha = a.sha256Hash() == null ? "" : a.sha256Hash().toLowerCase(Locale.ROOT);
                bySha.computeIfAbsent(sha, k -> newEntry(a, planBySha.get(sha), pm.cropDecision()));
            }
        }
        int audio = 0, images = 0, approved = 0, pending = 0, rejected = 0, ready = 0, missing = 0;
        for (Map<String, Object> e : bySha.values()) {
            String mime = String.valueOf(e.get("mimeType"));
            if (mime.startsWith("audio/")) audio++;
            if (mime.startsWith("image/")) {
                images++;
                String h = String.valueOf(((Map<?, ?>) e.get("humanApproval")).get("status"));
                if ("APPROVED".equals(h)) approved++;
                else if ("REJECTED".equals(h)) rejected++;
                else pending++;
            }
            if (Boolean.TRUE.equals(e.get("ready"))) ready++;
            if (!"VERIFIED".equals(e.get("fileStatus"))) missing++;
            for (String f : List.of("targetObjectKey", "localStagingPath")) {
                String v = String.valueOf(e.get(f)).toLowerCase(Locale.ROOT);
                if (v.startsWith("http:") || v.startsWith("https:") || v.contains("localhost") || v.contains("127.0.0.1")
                        || v.matches("^[a-z]:[\\\\/].*")) {
                    violations.add(e.get("canonicalAssetId") + ":" + f);
                }
            }
            ((List<Map<String, Object>>) e.get("bindings")).sort(Comparator.comparing(m -> String.valueOf(m.get("sourceKey"))
                    + "|" + m.get("stimulusKey") + "|" + m.get("role")));
            e.put("bindingCount", ((List<?>) e.get("bindings")).size());
        }
        Map<String, Object> summary = new LinkedHashMap<>();
        summary.put("assets", bySha.size());
        summary.put("bindings", bindings);
        summary.put("deduplicatedBindings", bindings - bySha.size());
        summary.put("audio", audio);
        summary.put("images", images);
        summary.put("imagesHumanApproved", approved);
        summary.put("imagesHumanPending", pending);
        summary.put("imagesHumanRejected", rejected);
        summary.put("ready", ready);
        summary.put("missingOrUnverifiedSource", missing);
        summary.put("canonicalUrlViolations", violations.size());
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("manifestVersion", MANIFEST_VERSION);
        out.put("note", "LOCAL plan only: nothing uploaded / synced; target keys are storage-relative logical keys, "
                + "runtime URLs come from playback grants");
        out.put("summary", summary);
        out.put("violations", violations);
        out.put("assets", new ArrayList<>(bySha.values()));
        return out;
    }

    private static Map<String, Object> newEntry(AssetRecord a, ExamMediaImportPlan.Entry pe, Map<String, String> crop) {
        String sha = a.sha256Hash() == null ? "" : a.sha256Hash().toLowerCase(Locale.ROOT);
        boolean image = a.mimeType() != null && a.mimeType().startsWith("image/");
        Map<String, Object> e = new LinkedHashMap<>();
        e.put("canonicalAssetId", "sha256:" + sha);
        e.put("sha256", sha);
        e.put("mimeType", a.mimeType());
        e.put("byteSize", a.byteSize());
        e.put("durationMs", a.durationMs());
        e.put("dimensions", a.dimensions());
        e.put("roles", new TreeSet<String>());
        e.put("validationState", a.validationState());
        e.put("targetObjectKey", a.objectKey());
        e.put("sourceKind", pe == null ? "UNKNOWN" : pe.sourceKind().name());
        e.put("localStagingPath", pe == null ? null : pe.sourcePath());
        e.put("derivation", pe == null ? null : pe.derivation());
        e.put("fileStatus", pe == null ? "NOT_LOCATED" : pe.fileStatus().name());
        e.put("cropTechnical", image ? (pe == null ? null : pe.cropTechnical()) : null);
        Map<String, Object> human = new LinkedHashMap<>();
        human.put("required", image);
        human.put("status", !image ? "NOT_REQUIRED"
                : pe != null && pe.cropHumanApproved() ? "APPROVED"
                : crop != null && crop.get(sha) != null ? crop.get(sha) : "PENDING");
        e.put("humanApproval", human);
        e.put("ready", pe != null && pe.ready());
        e.put("bindings", new ArrayList<Map<String, Object>>());
        return e;
    }
}
