package com.englishcoach.exams.content;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/** Exams Phase 2: canonical raw-corpus provenance carried by reference in manifest.metadata.sourceProvenance. */
class ExamPackageSourceProvenanceTest {

    private static ExamContentPackage.PackageManifest manifest(Map<String, Object> metadata) {
        return new ExamContentPackage.PackageManifest("1.0", "PKG", 1, "a".repeat(64), "extractor", "EC-EXAM-SPEC-X", "DRAFT",
                Instant.parse("2026-10-03T00:00:00Z"), metadata);
    }

    private static Map<String, Object> valid() {
        Map<String, Object> p = new HashMap<>();
        p.put("collection", "Synthetic Collection");
        p.put("book", "Synthetic Book");
        p.put("test", "TEST_01");
        p.put("rawSourceFile", Map.of("path", "imports/source-files/TOEIC/synthetic/book.pdf", "sha256", "b".repeat(64)));
        p.put("pageRange", "12-34");
        p.put("audio", List.of(Map.of("path", "imports/source-files/TOEIC/synthetic/part3.mp3", "section", "PART_3",
                "confidence", "CONFIDENT")));
        p.put("rawManifestRef", "imports/exams/manifests/raw-source/raw_source_manifest.json#synthetic");
        p.put("extractorName", "toeic-extractor");
        p.put("extractorVersion", "3.0.0");
        p.put("reviewStatus", "UNREVIEWED");
        return p;
    }

    @Test
    @DisplayName("Absent provenance is allowed (existing pilot packages keep their hash)")
    void absentAllowed() {
        assertTrue(ExamPackageSourceProvenance.validate(manifest(Map.of("description", "pilot"))).isEmpty());
        assertTrue(ExamPackageSourceProvenance.fromManifest(manifest(Map.of())).isEmpty());
    }

    @Test
    @DisplayName("Well-formed provenance parses to a typed view")
    void validParses() {
        ExamContentPackage.PackageManifest m = manifest(Map.of(ExamPackageSourceProvenance.METADATA_KEY, valid()));
        assertTrue(ExamPackageSourceProvenance.validate(m).isEmpty());
        ExamPackageSourceProvenance p = ExamPackageSourceProvenance.fromManifest(m).orElseThrow();
        assertEquals("TEST_01", p.test());
        assertEquals("CONFIDENT", p.audio().get(0).confidence());
    }

    @Test
    @DisplayName("Provenance outside the raw corpus, unknown review status or audio confidence is rejected")
    void invalidRejected() {
        Map<String, Object> bad = valid();
        bad.put("rawSourceFile", Map.of("path", "content/exams/generated.json"));
        bad.put("reviewStatus", "PASS");
        bad.put("audio", List.of(Map.of("path", "imports/source-files/x.mp3", "confidence", "MAYBE")));
        bad.put("pageRange", "page twelve");
        List<ExamContentPackage.ValidationError> errors =
                ExamPackageSourceProvenance.validate(manifest(Map.of(ExamPackageSourceProvenance.METADATA_KEY, bad)));
        assertEquals(4, errors.size(), errors.toString());
        assertTrue(errors.stream().allMatch(e -> "SOURCE_PROVENANCE_INVALID".equals(e.code())));
    }

    @Test
    @DisplayName("Provenance is a reference, not content: long text fields are rejected")
    void noContentDump() {
        Map<String, Object> dump = valid();
        dump.put("book", "x".repeat(ExamPackageSourceProvenance.MAX_FIELD_LENGTH + 1));
        assertFalse(ExamPackageSourceProvenance.validate(manifest(Map.of(ExamPackageSourceProvenance.METADATA_KEY, dump))).isEmpty());
    }
}
