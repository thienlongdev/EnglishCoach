package com.englishcoach.exams.content;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.*;

/** Immutable project-owner decision for the existing, hash-pinned corpus. No request/config switch grants it. */
public final class ExamOwnerProductionAuthorization {
    public static final String BASIS = "OWNER_AUTHORIZED_PRODUCTION_USE";
    public static final String DECISION_REF = "EXAMS_CORPUS_OWNER_PRODUCTION_AUTHORIZATION_20261006";
    private static final Set<String> RAW_HASHES = load();
    private ExamOwnerProductionAuthorization() {}

    private static Set<String> load() {
        try (var input = ExamOwnerProductionAuthorization.class.getResourceAsStream("/exams/corpus-production-authorization.json")) {
            if (input == null) return Set.of();
            Map<?, ?> grant = new ObjectMapper().readValue(input, Map.class);
            if (!BASIS.equals(grant.get("basis")) || !DECISION_REF.equals(grant.get("decisionRef"))
                    || !Boolean.FALSE.equals(grant.get("publisherEndorsement"))) return Set.of();
            Set<String> hashes = new HashSet<>();
            for (Object value : (List<?>) grant.get("rawSourceSha256")) {
                String hash = String.valueOf(value);
                if (!hash.matches("[0-9a-f]{64}")) return Set.of();
                hashes.add(hash);
            }
            return Set.copyOf(hashes);
        } catch (Exception error) { return Set.of(); }
    }

    public static boolean covers(ExamContentPackage pkg) {
        return pkg != null && pkg.manifest() != null && coversSourceMetadata(pkg.manifest().metadata());
    }

    private static boolean coversSourceMetadata(Map<String, Object> metadata) {
        var provenance = ExamPackageSourceProvenance.fromMetadata(metadata);
        return provenance.isPresent() && ExamPackageSourceProvenance.validateMetadata(metadata).isEmpty()
                && RAW_HASHES.contains(provenance.get().rawSourceSha256());
    }

    /** New owner decision is supplemental to historical extraction metadata; never rewrites publisher licences. */
    public static Map<String, Object> productionMetadata(Map<String, Object> metadata) {
        if (!coversSourceMetadata(metadata)) throw new IllegalArgumentException("CONTENT_PRODUCTION_AUTHORIZATION_NOT_COVERED");
        try (var input = ExamOwnerProductionAuthorization.class.getResourceAsStream("/exams/corpus-production-authorization.json")) {
            Map<?, ?> document = new ObjectMapper().readValue(input, Map.class);
            Map<String, Object> auth = new LinkedHashMap<>();
            for (String key : List.of("status", "scope", "authorizedBy", "decisionDate", "decisionRef", "appliesTo",
                    "permits", "productionImport", "publisherLicence", "publisherEndorsement")) auth.put(key, document.get(key));
            Map<String, Object> result = new LinkedHashMap<>(metadata);
            result.put(ExamProjectUsageAuthorization.METADATA_KEY, auth);
            return Collections.unmodifiableMap(result);
        } catch (Exception error) { throw new IllegalStateException("OWNER_PRODUCTION_DECISION_UNAVAILABLE"); }
    }

    public static boolean coversMetadata(Map<String, Object> metadata) {
        if (metadata == null || !(metadata.get(ExamProjectUsageAuthorization.METADATA_KEY) instanceof Map<?, ?> auth)) return false;
        var parsed = ExamProjectUsageAuthorization.fromMetadata(metadata);
        var provenance = ExamPackageSourceProvenance.fromMetadata(metadata);
        if (!DECISION_REF.equals(auth.get("decisionRef")) || !BASIS.equals(auth.get("productionImport"))
                || parsed.isEmpty() || provenance.isEmpty()
                || !ExamProjectUsageAuthorization.validateMetadata(metadata).isEmpty()
                || !ExamPackageSourceProvenance.validateMetadata(metadata).isEmpty()) return false;
        return RAW_HASHES.contains(provenance.get().rawSourceSha256());
    }

    public static Set<String> rawHashes() { return RAW_HASHES; }
}
