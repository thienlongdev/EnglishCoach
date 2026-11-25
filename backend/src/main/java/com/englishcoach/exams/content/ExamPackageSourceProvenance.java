package com.englishcoach.exams.content;

import java.util.*;
import java.util.regex.Pattern;

/**
 * Typed view of the canonical source provenance a package carries in {@code manifest.metadata.sourceProvenance}
 * (Exams Recovery Phase 2). It lets future extractor output (Phase 3) point back to the immutable raw corpus
 * ({@code imports/source-files/**}) and the Phase 1 manifests by REFERENCE only — paths, hashes, page ranges,
 * audio mapping confidence, extractor identity and review status — never by copying book text.
 *
 * <p>It lives inside the existing metadata map (not a new record field) so the declared content hash of every
 * existing package stays valid. Absent provenance is allowed (original pilot packages); present provenance must
 * be well formed ({@link #validate}).
 *
 * <pre>
 * "sourceProvenance": {
 *   "collection": "ETS TOEIC", "book": "ETS 2024", "test": "TEST_03",
 *   "rawSourceFile": {"path": "imports/source-files/...pdf", "sha256": "…64 hex…"},
 *   "pageRange": "41-62",
 *   "audio": [{"path": "imports/source-files/...mp3", "sha256": "…", "section": "PART_3", "confidence": "CONFIDENT"}],
 *   "rawManifestRef": "imports/exams/manifests/raw-source/raw_source_manifest.json#…",
 *   "extractorName": "toeic-extractor", "extractorVersion": "3.0.0",
 *   "reviewStatus": "UNREVIEWED"
 * }
 * </pre>
 */
public record ExamPackageSourceProvenance(
        String collection,
        String book,
        String test,
        String rawSourcePath,
        String rawSourceSha256,
        String pageRange,
        List<AudioReference> audio,
        String rawManifestRef,
        String extractorName,
        String extractorVersion,
        String reviewStatus
) {

    public static final String METADATA_KEY = "sourceProvenance";
    public static final String RAW_SOURCE_ROOT = "imports/source-files/";
    public static final Set<String> REVIEW_STATUSES = Set.of("UNREVIEWED", "IN_REVIEW", "APPROVED", "REJECTED");
    /** Phase 1 audio mapping confidence labels. */
    public static final Set<String> AUDIO_CONFIDENCE = Set.of("CONFIDENT", "PROBABLE", "AMBIGUOUS", "UNMAPPED");
    private static final Pattern SHA256 = Pattern.compile("[0-9a-fA-F]{64}");
    private static final Pattern PAGE_RANGE = Pattern.compile("\\d{1,4}(-\\d{1,4})?");
    /** References only: any free-text field longer than this is rejected (no book text in provenance). */
    static final int MAX_FIELD_LENGTH = 300;

    public ExamPackageSourceProvenance {
        audio = audio == null ? List.of() : List.copyOf(audio);
    }

    public record AudioReference(String path, String sha256, String section, String confidence) {}

    /** Empty when the manifest carries no provenance block; malformed blocks are reported by {@link #validate}. */
    public static Optional<ExamPackageSourceProvenance> fromManifest(ExamContentPackage.PackageManifest manifest) {
        return fromMetadata(manifest == null ? null : manifest.metadata());
    }

    /** Same view over a metadata map (a package manifest's, or one rebuilt from a persisted V72 row). */
    public static Optional<ExamPackageSourceProvenance> fromMetadata(Map<String, Object> metadata) {
        if (metadata == null || !(metadata.get(METADATA_KEY) instanceof Map<?, ?> m)) return Optional.empty();
        Map<?, ?> raw = m.get("rawSourceFile") instanceof Map<?, ?> r ? r : Map.of();
        List<AudioReference> audio = new ArrayList<>();
        if (m.get("audio") instanceof List<?> list) {
            for (Object o : list) {
                if (o instanceof Map<?, ?> a) {
                    audio.add(new AudioReference(str(a.get("path")), str(a.get("sha256")), str(a.get("section")), str(a.get("confidence"))));
                }
            }
        }
        return Optional.of(new ExamPackageSourceProvenance(str(m.get("collection")), str(m.get("book")), str(m.get("test")),
                str(raw.get("path")), str(raw.get("sha256")), str(m.get("pageRange")), audio, str(m.get("rawManifestRef")),
                str(m.get("extractorName")), str(m.get("extractorVersion")), str(m.get("reviewStatus"))));
    }

    /** Structural errors as {@code path → code}; empty when valid or absent. */
    public static List<ExamContentPackage.ValidationError> validate(ExamContentPackage.PackageManifest manifest) {
        return validateMetadata(manifest == null ? null : manifest.metadata());
    }

    public static List<ExamContentPackage.ValidationError> validateMetadata(Map<String, Object> metadata) {
        List<ExamContentPackage.ValidationError> errors = new ArrayList<>();
        if (metadata == null || !metadata.containsKey(METADATA_KEY)) return errors;
        String base = "manifest.metadata." + METADATA_KEY;
        if (!(metadata.get(METADATA_KEY) instanceof Map<?, ?>)) {
            errors.add(err(base, "must be an object"));
            return errors;
        }
        ExamPackageSourceProvenance p = fromMetadata(metadata).orElseThrow();
        if (blank(p.collection()) || blank(p.book()) || blank(p.test())) {
            errors.add(err(base, "collection, book and test are required"));
        }
        if (blank(p.rawSourcePath()) || !p.rawSourcePath().replace('\\', '/').startsWith(RAW_SOURCE_ROOT)) {
            errors.add(err(base + ".rawSourceFile.path", "must reference the immutable raw corpus under " + RAW_SOURCE_ROOT));
        }
        if (p.rawSourceSha256() != null && !SHA256.matcher(p.rawSourceSha256()).matches()) {
            errors.add(err(base + ".rawSourceFile.sha256", "must be a SHA-256 hex digest"));
        }
        if (p.pageRange() != null && !PAGE_RANGE.matcher(p.pageRange()).matches()) {
            errors.add(err(base + ".pageRange", "must be N or N-M"));
        }
        for (int i = 0; i < p.audio().size(); i++) {
            AudioReference a = p.audio().get(i);
            if (blank(a.path()) || !a.path().replace('\\', '/').startsWith(RAW_SOURCE_ROOT)
                    || a.confidence() == null || !AUDIO_CONFIDENCE.contains(a.confidence())
                    || (a.sha256() != null && !SHA256.matcher(a.sha256()).matches())) {
                errors.add(err(base + ".audio[" + i + "]", "needs a raw-corpus path, optional SHA-256 and a Phase 1 confidence label"));
            }
        }
        if (blank(p.extractorName()) || blank(p.extractorVersion())) {
            errors.add(err(base, "extractorName and extractorVersion are required"));
        }
        if (p.reviewStatus() == null || !REVIEW_STATUSES.contains(p.reviewStatus())) {
            errors.add(err(base + ".reviewStatus", "must be one of " + new TreeSet<>(REVIEW_STATUSES)));
        }
        for (String v : Arrays.asList(p.collection(), p.book(), p.test(), p.rawSourcePath(), p.rawManifestRef(),
                p.extractorName(), p.extractorVersion())) {
            if (v != null && v.length() > MAX_FIELD_LENGTH) {
                errors.add(err(base, "provenance fields are references, not content (max " + MAX_FIELD_LENGTH + " chars)"));
                break;
            }
        }
        return errors;
    }

    private static ExamContentPackage.ValidationError err(String path, String message) {
        return new ExamContentPackage.ValidationError(path, "SOURCE_PROVENANCE_INVALID", message);
    }

    private static String str(Object o) {
        return o == null ? null : String.valueOf(o);
    }

    private static boolean blank(String s) {
        return s == null || s.isBlank();
    }
}
