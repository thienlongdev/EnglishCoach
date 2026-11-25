package com.englishcoach.exams.release;

import com.englishcoach.exams.content.ExamContentPackage;
import com.englishcoach.exams.content.ExamPackageSourceProvenance;
import com.englishcoach.exams.model.ExamContentRecords.AssetRecord;
import com.englishcoach.exams.model.ExamContentRecords.StimulusVersionRecord;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.*;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * Exams Recovery Phase 4D.6 — deterministic media provisioning PLAN for one canonical package (LOCAL dry run; nothing is
 * copied, uploaded or synced). For every asset: where the bytes come from (raw corpus file / zip member, or a derived
 * staging copy with its parent + interval), the SHA-256 re-verified now, the intended storage object (content-addressed
 * {@code objectKey}), MIME, role(s), validation state and the dedupe key. Raw sources are opened READ-ONLY and only under
 * {@code imports/source-files/}; staging copies only under {@code imports/exams/staging/}.
 *
 * <p>MEDIA_READY = every asset VALIDATED, its bytes verified against its hash and bound to a stimulus; for an image
 * additionally (Phase 4.1B) a TECHNICALLY_VALID crop check AND a completed human crop decision (fingerprint-current
 * APPROVE recorded in the QA ledger). A PENDING crop, a missing / mismatching file, a missing binding or a technical
 * failure keeps it NO. A technical check alone never counts as approval.
 */
public final class ExamMediaImportPlan {

    private ExamMediaImportPlan() {}

    public enum SourceKind { RAW_FILE, RAW_ZIP_MEMBER, DERIVED_AUDIO_SEGMENT, RENDERED_PAGE_REGION, BANK_ASSET, UNKNOWN }

    public enum FileStatus { VERIFIED, MISSING, HASH_MISMATCH, NOT_LOCATED }

    public record Entry(String assetId, String sha256, String mimeType, Set<String> roles, Set<String> stimulusKinds,
                        String validationState, SourceKind sourceKind, String sourcePath, Map<String, Object> derivation,
                        String storageObjectKey, String dedupeKey, FileStatus fileStatus, boolean ready,
                        boolean bound, String cropTechnical, boolean cropHumanApproved, boolean waitingOnlyForHuman) {}

    /**
     * Crop QA facts of one image (Phase 4.1B, from reports/qa_release_review.json → cropUnits): the deterministic
     * technical status and whether a fingerprint-current human APPROVE exists.
     */
    public record CropQa(String technicalStatus, boolean humanApproved, boolean ownerTechnicalApproved) {
        public CropQa(String technicalStatus, boolean humanApproved) { this(technicalStatus, humanApproved, false); }
        public boolean technicallyValid() {
            return "TECHNICALLY_VALID".equals(technicalStatus);
        }
    }

    public record Plan(String packageId, List<Entry> entries, int duplicateAssets, boolean mediaReady,
                       Map<String, Integer> blockers) {
        /** Every asset is ready, or is an image whose only missing piece is the human crop decision. */
        public boolean readyExceptHumanCropQa() {
            return !entries.isEmpty() && entries.stream().allMatch(e -> e.ready() || e.waitingOnlyForHuman());
        }
    }

    private static final String RAW_ROOT = "imports/source-files/";
    private static final String STAGING_ROOT = "imports/exams/staging/";

    /** @param repoRoot repository root (raw corpus and staging are resolved under it; nothing outside is read) */
    @SuppressWarnings("unchecked")
    public static Plan plan(ExamContentPackage pkg, Path repoRoot, boolean verifyHashes) {
        return plan(pkg, repoRoot, verifyHashes, Map.of());
    }

    /** @param cropQa image SHA-256 (lower case) → crop QA facts; an image without an entry is never ready */
    public static Plan plan(ExamContentPackage pkg, Path repoRoot, boolean verifyHashes, Map<String, CropQa> cropQa) {
        Map<String, Map<String, Object>> segmentsBySha = new HashMap<>();
        if (pkg.manifest().metadata().get("audioSegments") instanceof List<?> segs) {
            for (Object o : segs) if (o instanceof Map<?, ?> m && m.get("segmentSha256") != null) {
                segmentsBySha.put(String.valueOf(m.get("segmentSha256")).toLowerCase(Locale.ROOT), (Map<String, Object>) m);
            }
        }
        Map<String, String> rawAudioBySha = new HashMap<>();
        ExamPackageSourceProvenance.fromManifest(pkg.manifest()).ifPresent(p -> {
            for (ExamPackageSourceProvenance.AudioReference a : p.audio()) {
                if (a.sha256() != null && a.path() != null) rawAudioBySha.put(a.sha256().toLowerCase(Locale.ROOT), a.path());
            }
        });
        Map<UUID, StimulusVersionRecord> stimuli = new HashMap<>();
        for (StimulusVersionRecord s : pkg.stimuli()) stimuli.put(s.id(), s);
        Map<UUID, Set<String>> roles = new HashMap<>();
        Map<UUID, Set<String>> kinds = new HashMap<>();
        for (ExamContentPackage.StimulusAssetPlacement sa : pkg.stimulusAssets()) {
            roles.computeIfAbsent(sa.assetId(), k -> new TreeSet<>()).add(sa.role());
            StimulusVersionRecord st = stimuli.get(sa.stimulusId());
            if (st != null) kinds.computeIfAbsent(sa.assetId(), k -> new TreeSet<>()).add(st.kind());
        }

        List<Entry> entries = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        int duplicates = 0;
        Map<String, Integer> blockers = new TreeMap<>();
        for (AssetRecord a : pkg.assets()) {
            String sha = a.sha256Hash() == null ? "" : a.sha256Hash().toLowerCase(Locale.ROOT);
            if (!seen.add(sha)) duplicates++;
            String mime = a.mimeType() == null ? "" : a.mimeType().toLowerCase(Locale.ROOT);
            SourceKind kind;
            String sourcePath;
            Map<String, Object> derivation = null;
            Map<String, Object> seg = segmentsBySha.get(sha);
            String bankKey = a.objectKey();
            boolean bankMedia = sha.matches("[0-9a-f]{64}") && bankKey != null
                    && bankKey.matches("assets/by-sha256/" + sha.substring(0, 2) + "/" + sha + "\\.(mp3|png|jpg|jpeg|webp)");
            if (bankMedia) {
                kind = SourceKind.BANK_ASSET;
                sourcePath = "data/exam-bank/" + bankKey;
            } else if (seg != null) {
                kind = SourceKind.DERIVED_AUDIO_SEGMENT;
                sourcePath = String.valueOf(seg.get("stagedPath"));
                derivation = new LinkedHashMap<>();
                for (String k : List.of("parentPath", "parentSha256", "startMs", "endMs", "method", "part")) {
                    if (seg.get(k) != null) derivation.put(k, seg.get(k));
                }
            } else if (mime.startsWith("audio/") && rawAudioBySha.containsKey(sha)) {
                sourcePath = rawAudioBySha.get(sha);
                kind = sourcePath.contains("::") ? SourceKind.RAW_ZIP_MEMBER : SourceKind.RAW_FILE;
            } else if (mime.startsWith("image/")) {
                kind = SourceKind.RENDERED_PAGE_REGION;
                sourcePath = STAGING_ROOT + "assets/images/" + sha + ".png";
            } else {
                kind = SourceKind.UNKNOWN;
                sourcePath = null;
            }
            FileStatus fs = verifyHashes ? verify(repoRoot, kind, sourcePath, sha) : FileStatus.NOT_LOCATED;
            boolean validated = "VALIDATED".equalsIgnoreCase(a.validationState());
            boolean bound = !roles.getOrDefault(a.id(), Set.of()).isEmpty();
            boolean image = mime.startsWith("image/");
            CropQa crop = image && cropQa != null ? cropQa.get(sha) : null;
            boolean ownerTechnicalAllowed = ExamPackageSourceProvenance.fromManifest(pkg.manifest())
                    .map(p -> Set.of("ybm", "economy").contains(p.collection())).orElse(false)
                    && "TOEIC".equals(pkg.form().family().name());
            boolean cropApproved = crop != null && (crop.humanApproved()
                    || (ownerTechnicalAllowed && crop.ownerTechnicalApproved()));
            boolean cropOk = !image || (crop != null && crop.technicallyValid() && cropApproved);
            boolean ready = validated && fs == FileStatus.VERIFIED && bound && cropOk;
            boolean waitingOnlyForHuman = image && !ready && fs == FileStatus.VERIFIED && bound && crop != null
                    && crop.technicallyValid() && !cropApproved
                    && ("PENDING".equalsIgnoreCase(a.validationState()) || validated);
            if (!validated) blockers.merge("ASSET_NOT_VALIDATED_" + String.valueOf(a.validationState()).toUpperCase(Locale.ROOT), 1, Integer::sum);
            if (fs != FileStatus.VERIFIED) blockers.merge("SOURCE_" + fs.name(), 1, Integer::sum);
            if (!bound) blockers.merge("ASSET_BINDING_MISSING", 1, Integer::sum);
            if (image && (crop == null || !crop.technicallyValid())) blockers.merge("CROP_TECHNICAL_NOT_VALID", 1, Integer::sum);
            if (image && crop != null && crop.technicallyValid() && !cropApproved) {
                blockers.merge("CROP_QA_DECISION_PENDING", 1, Integer::sum);
            }
            entries.add(new Entry(String.valueOf(a.id()), sha, a.mimeType(), roles.getOrDefault(a.id(), Set.of()),
                    kinds.getOrDefault(a.id(), Set.of()), a.validationState(), kind, sourcePath, derivation,
                    a.objectKey(), "sha256:" + sha, fs, ready, bound, crop == null ? null : crop.technicalStatus(),
                    crop != null && crop.humanApproved(), waitingOnlyForHuman));
        }
        boolean mediaReady = !entries.isEmpty() && entries.stream().allMatch(Entry::ready);
        return new Plan(pkg.manifest().packageId(), entries, duplicates, mediaReady, blockers);
    }

    private static FileStatus verify(Path repoRoot, SourceKind kind, String sourcePath, String sha) {
        if (sourcePath == null || kind == SourceKind.UNKNOWN) return FileStatus.NOT_LOCATED;
        String norm = sourcePath.replace('\\', '/');
        try {
            if (kind == SourceKind.RAW_ZIP_MEMBER) {
                String[] parts = norm.split("::", 2);
                Path zip = guarded(repoRoot, parts[0], RAW_ROOT);
                if (zip == null || !Files.isRegularFile(zip)) return FileStatus.MISSING;
                try (ZipFile zf = new ZipFile(zip.toFile())) {
                    ZipEntry ze = zf.getEntry(parts[1]);
                    if (ze == null) return FileStatus.MISSING;
                    try (InputStream in = zf.getInputStream(ze)) {
                        return sha.equalsIgnoreCase(sha256(in)) ? FileStatus.VERIFIED : FileStatus.HASH_MISMATCH;
                    }
                }
            }
            String root = kind == SourceKind.BANK_ASSET ? "data/exam-bank/assets/by-sha256/"
                    : kind == SourceKind.RAW_FILE ? RAW_ROOT : STAGING_ROOT;
            Path file = guarded(repoRoot, norm, root);
            if (file == null || !Files.isRegularFile(file)) return FileStatus.MISSING;
            if (!file.toRealPath().startsWith(repoRoot.resolve(root).toRealPath())) return FileStatus.NOT_LOCATED;
            try (InputStream in = Files.newInputStream(file)) {
                return sha.equalsIgnoreCase(sha256(in)) ? FileStatus.VERIFIED : FileStatus.HASH_MISMATCH;
            }
        } catch (IOException e) {
            return FileStatus.MISSING;
        }
    }

    /** Resolves a repo-relative path only when it stays inside the allowed root (read-only access). */
    private static Path guarded(Path repoRoot, String rel, String allowedRoot) {
        if (!rel.startsWith(allowedRoot)) return null;
        Path root = repoRoot.resolve(allowedRoot).normalize().toAbsolutePath();
        Path p = repoRoot.resolve(rel).normalize().toAbsolutePath();
        return p.startsWith(root) ? p : null;
    }

    private static String sha256(InputStream in) throws IOException {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
            StringBuilder sb = new StringBuilder();
            for (byte b : md.digest()) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
