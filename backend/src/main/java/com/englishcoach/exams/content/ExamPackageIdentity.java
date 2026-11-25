package com.englishcoach.exams.content;

import com.englishcoach.exams.model.ExamContentRecords.*;
import com.fasterxml.jackson.databind.MapperFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.databind.json.JsonMapper;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.regex.Pattern;

import static com.englishcoach.exams.content.ExamContentPackage.*;

/**
 * Exams Recovery Phase 5C — deterministic identity of one canonical package, independent of row ids, timestamps,
 * extractor metadata and display names.
 *
 * <pre>
 * sourceKey            FAMILY:collection/book/test-n from manifest.metadata.sourceIdentity (immutable source identity)
 * semanticFingerprint  SHA-256 over the learner / scoring content only: form shape, sections, parts, group placements,
 *                      groups, stimuli (payload + media SHA-256), items, answer specs, specification / scoring scheme /
 *                      rubric bodies. NOT included: ids, versions, createdAt, manifest metadata (extraction summary, OCR
 *                      metrics, extractor version), contentHash fields, form / catalog titles, asset validation state.
 * displayDigest        form + catalog titles (a rename is not a content change)
 * mediaStateDigest     asset validation states (an approval is not a content change)
 * definitionsDigest    specification / scoring scheme / rubric bodies (shared rows; a change needs its own version)
 * placements           placement key (PARTCODE#ordinal) → group digest + the row ids / versions that a successor
 *                      version reuses when the digest is unchanged (recorded at import in the QA-run findings)
 * </pre>
 * Two extractions of unchanged source therefore share a semantic fingerprint even when the extractor version, OCR
 * metrics or manifest content hash differ. Local absolute paths anywhere in the manifest metadata are reported as
 * {@code pathViolations} (they must never reach a production import).
 */
public record ExamPackageIdentity(
        String identityVersion,
        String sourceKey,
        Map<String, Object> sourceIdentity,
        String rawSourceSha256,
        List<String> rawDocumentSha256,
        String extractorName,
        String extractorVersion,
        String packageId,
        int packageVersion,
        String formLogicalKey,
        int formVersion,
        String manifestContentHash,
        String semanticFingerprint,
        String displayDigest,
        String mediaStateDigest,
        String definitionsDigest,
        List<String> mediaSha256,
        Map<String, Map<String, Object>> placements,
        Map<String, Map<String, Object>> stimuli,
        List<String> pathViolations
) {

    public static final String IDENTITY_VERSION = "exam-package-identity-v1";

    /** A successor may introduce a rubric while preserving every prior shared definition.
     * The prior digest must equal an exact subset; importer identity checks still reject row collisions.
     * Bounded enumeration fails closed for unusually large definition sets.
     */
    public static boolean onlyAddsRubrics(ExamContentPackage pkg, String previousDigest) {
        Map<String, Object> definitions = new Index(pkg).definitions();
        List<String> rubrics = definitions.keySet().stream().filter(k -> k.startsWith("rubric:")).toList();
        if (rubrics.isEmpty() || rubrics.size() > 8 || previousDigest == null) return false;
        for (int mask = 1; mask < (1 << rubrics.size()); mask++) {
            Map<String, Object> prior = new TreeMap<>(definitions);
            for (int i = 0; i < rubrics.size(); i++) if ((mask & (1 << i)) != 0) prior.remove(rubrics.get(i));
            if (previousDigest.equals(sha256(canonical(prior)))) return true;
        }
        return false;
    }

    private static final ObjectMapper CANON = JsonMapper.builder()
            .findAndAddModules()
            .enable(MapperFeature.SORT_PROPERTIES_ALPHABETICALLY)
            .enable(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS)
            .build();

    /** Windows drive paths, UNC paths and user-home / absolute POSIX roots of a developer machine. */
    private static final Pattern LOCAL_PATH = Pattern.compile(
            "(^|[\\s\"'(=])([A-Za-z]:[\\\\/]|\\\\\\\\|/(Users|home|mnt|tmp|var|private)/)");

    public ExamPackageIdentity {
        sourceIdentity = sourceIdentity == null ? Map.of() : Collections.unmodifiableMap(new TreeMap<>(sourceIdentity));
        rawDocumentSha256 = rawDocumentSha256 == null ? List.of() : List.copyOf(rawDocumentSha256);
        mediaSha256 = mediaSha256 == null ? List.of() : List.copyOf(mediaSha256);
        placements = placements == null ? Map.of() : Collections.unmodifiableMap(new TreeMap<>(placements));
        stimuli = stimuli == null ? Map.of() : Collections.unmodifiableMap(new TreeMap<>(stimuli));
        pathViolations = pathViolations == null ? List.of() : List.copyOf(pathViolations);
    }

    @SuppressWarnings("unchecked")
    public static ExamPackageIdentity of(ExamContentPackage pkg) {
        if (pkg == null || pkg.form() == null || pkg.manifest() == null) {
            throw new IllegalArgumentException("PACKAGE_FORM_REQUIRED");
        }
        Map<String, Object> meta = pkg.manifest().metadata();
        Map<String, Object> sourceIdentity = meta.get("sourceIdentity") instanceof Map<?, ?> m
                ? new TreeMap<>((Map<String, Object>) m) : new TreeMap<>();
        Map<String, Object> prov = meta.get("sourceProvenance") instanceof Map<?, ?> p ? (Map<String, Object>) p : Map.of();
        String sourceKey = sourceKey(pkg, sourceIdentity);
        String rawSha = sourceIdentity.get("rawSourceSha256") == null ? null
                : String.valueOf(sourceIdentity.get("rawSourceSha256")).toLowerCase(Locale.ROOT);
        TreeSet<String> docs = new TreeSet<>();
        if (meta.get("sourceDocuments") instanceof List<?> ds) {
            for (Object o : ds) if (o instanceof Map<?, ?> d && d.get("sha256") != null) {
                docs.add(String.valueOf(d.get("sha256")).toLowerCase(Locale.ROOT));
            }
        }

        Index ix = new Index(pkg);
        Map<String, Map<String, Object>> placements = new TreeMap<>();
        Map<String, Map<String, Object>> stimuli = new TreeMap<>();
        List<Object> formShape = new ArrayList<>();
        for (SectionRecord s : sorted(pkg.sections(), Comparator.comparingInt(SectionRecord::ordinal))) {
            List<Object> partShapes = new ArrayList<>();
            for (PartRecord p : sorted(ix.partsBySection.getOrDefault(s.id(), List.of()), Comparator.comparingInt(PartRecord::ordinal))) {
                List<Object> groupShapes = new ArrayList<>();
                for (FormGroupPlacement fg : sorted(ix.placementsByPart.getOrDefault(p.id(), List.of()),
                        Comparator.comparingInt(FormGroupPlacement::ordinal))) {
                    String key = p.partCode() + "#" + fg.ordinal();
                    GroupVersionRecord g = ix.groups.get(fg.groupId());
                    String digest = sha256(canonical(ix.groupContent(fg.groupId())));
                    Map<String, Object> rec = new LinkedHashMap<>();
                    rec.put("digest", digest);
                    rec.put("groupId", String.valueOf(fg.groupId()));
                    rec.put("logicalGroupKey", g == null ? null : g.logicalGroupKey());
                    rec.put("version", g == null ? null : g.version());
                    rec.put("items", ix.itemIds(fg.groupId()));
                    rec.put("groupStimuli", ix.groupStimulusIds(fg.groupId()));
                    placements.put(key, rec);
                    Map<String, Object> shape = new LinkedHashMap<>();
                    shape.put("placement", key);
                    shape.put("displayNumbering", fg.displayNumbering());
                    shape.put("group", digest);
                    groupShapes.add(shape);
                }
                Map<String, Object> part = new LinkedHashMap<>();
                part.put("partCode", p.partCode());
                part.put("ordinal", p.ordinal());
                part.put("instructions", p.instructions());
                part.put("timingPolicy", p.timingPolicy());
                part.put("groups", groupShapes);
                partShapes.add(part);
            }
            Map<String, Object> sec = new LinkedHashMap<>();
            sec.put("skill", s.skill() == null ? null : s.skill().name());
            sec.put("ordinal", s.ordinal());
            sec.put("specSectionKey", s.specSectionKey());
            sec.put("durationSeconds", s.durationSeconds());
            sec.put("timingPolicy", s.timingPolicy());
            sec.put("parts", partShapes);
            formShape.add(sec);
        }
        for (StimulusVersionRecord st : pkg.stimuli()) {
            Map<String, Object> rec = new LinkedHashMap<>();
            rec.put("id", String.valueOf(st.id()));
            rec.put("version", st.version());
            rec.put("digest", sha256(canonical(ix.stimulusContent(st.id()))));
            rec.put("stimulusAssets", ix.stimulusAssetIds(st.id()));
            stimuli.put(st.logicalStimulusKey(), rec);
        }

        Map<String, Object> semantic = new LinkedHashMap<>();
        semantic.put("family", pkg.form().family() == null ? null : pkg.form().family().name());
        semantic.put("variant", pkg.form().variant());
        semantic.put("scope", pkg.form().scope());
        semantic.put("formLogicalKey", pkg.form().logicalKey());
        semantic.put("sections", formShape);
        semantic.put("groups", placements.entrySet().stream()
                .collect(TreeMap::new, (mm, e) -> mm.put(e.getKey(), e.getValue().get("digest")), TreeMap::putAll));
        Map<String, Object> definitions = ix.definitions();
        semantic.put("definitions", definitions);

        Map<String, Object> display = new TreeMap<>();
        display.put("form", pkg.form().title());
        for (CatalogNodeRecord n : pkg.catalogNodes()) display.put("catalog:" + n.id(), n.title());
        Map<String, Object> media = new TreeMap<>();
        TreeSet<String> mediaSha = new TreeSet<>();
        for (AssetRecord a : pkg.assets()) {
            String sha = a.sha256Hash() == null ? "" : a.sha256Hash().toLowerCase(Locale.ROOT);
            mediaSha.add(sha);
            media.put(sha, a.validationState());
        }

        return new ExamPackageIdentity(IDENTITY_VERSION, sourceKey, sourceIdentity, rawSha, new ArrayList<>(docs),
                prov.get("extractorName") == null ? null : String.valueOf(prov.get("extractorName")),
                prov.get("extractorVersion") == null ? null : String.valueOf(prov.get("extractorVersion")),
                pkg.manifest().packageId(), pkg.manifest().packageVersion(), pkg.form().logicalKey(), pkg.form().version(),
                pkg.manifest().contentHash(), sha256(canonical(semantic)), sha256(canonical(display)),
                sha256(canonical(media)), sha256(canonical(definitions)), new ArrayList<>(mediaSha), placements, stimuli,
                pathViolations(meta));
    }

    /** FAMILY:collection/book/test-n; falls back to the form logical key when no source identity exists. */
    static String sourceKey(ExamContentPackage pkg, Map<String, Object> sourceIdentity) {
        String family = pkg.form().family() == null ? "UNKNOWN" : pkg.form().family().name();
        Object collection = sourceIdentity.get("collection");
        Object book = sourceIdentity.get("book");
        Object test = sourceIdentity.get("test");
        if (collection == null || book == null || test == null) {
            return family + ":form/" + pkg.form().logicalKey();
        }
        return family + ":" + (collection + "/" + book + "/test-" + test).toLowerCase(Locale.ROOT);
    }

    /** Placement keys whose group content differs from (or is absent in) the other identity. */
    public Set<String> changedPlacements(ExamPackageIdentity previous) {
        Set<String> out = new TreeSet<>();
        for (Map.Entry<String, Map<String, Object>> e : placements.entrySet()) {
            Map<String, Object> prev = previous == null ? null : previous.placements().get(e.getKey());
            if (prev == null || !Objects.equals(prev.get("digest"), e.getValue().get("digest"))) out.add(e.getKey());
        }
        return out;
    }

    public Map<String, Object> asMap() {
        return CANON.convertValue(this, Map.class);
    }

    @SuppressWarnings("unchecked")
    public static Optional<ExamPackageIdentity> fromMap(Object raw) {
        if (!(raw instanceof Map<?, ?> m) || !IDENTITY_VERSION.equals(m.get("identityVersion"))) return Optional.empty();
        try {
            return Optional.of(CANON.convertValue(m, ExamPackageIdentity.class));
        } catch (IllegalArgumentException e) {
            return Optional.empty();
        }
    }

    // ─── internals ───────────────────────────────────────────────────────────────────────

    private static <T> List<T> sorted(Collection<T> in, Comparator<T> c) {
        List<T> out = new ArrayList<>(in);
        out.sort(c);
        return out;
    }

    static List<String> pathViolations(Map<String, Object> metadata) {
        List<String> out = new ArrayList<>();
        walk(metadata, "metadata", out);
        return out;
    }

    private static void walk(Object node, String path, List<String> out) {
        if (node instanceof Map<?, ?> m) {
            for (Map.Entry<?, ?> e : m.entrySet()) walk(e.getValue(), path + "." + e.getKey(), out);
        } else if (node instanceof List<?> l) {
            for (int i = 0; i < l.size(); i++) walk(l.get(i), path + "[" + i + "]", out);
        } else if (node instanceof String s && LOCAL_PATH.matcher(s).find()) {
            out.add(path);
        }
    }

    static String canonical(Object value) {
        try {
            return CANON.writeValueAsString(CANON.readTree(CANON.writeValueAsString(value)));
        } catch (Exception e) {
            throw new IllegalStateException("IDENTITY_CANONICALIZATION_FAILED: " + e.getMessage(), e);
        }
    }

    static String sha256(String text) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(64);
            for (byte b : d) sb.append(String.format(Locale.ROOT, "%02x", b));
            return sb.toString();
        } catch (Exception e) {
            throw new IllegalStateException("SHA-256 is unavailable", e);
        }
    }

    /** Id-keyed views of one package plus the id-free content projections. */
    private static final class Index {
        final ExamContentPackage pkg;
        final Map<UUID, List<PartRecord>> partsBySection = new HashMap<>();
        final Map<UUID, List<FormGroupPlacement>> placementsByPart = new HashMap<>();
        final Map<UUID, GroupVersionRecord> groups = new HashMap<>();
        final Map<UUID, StimulusVersionRecord> stimuli = new HashMap<>();
        final Map<UUID, AssetRecord> assets = new HashMap<>();
        final Map<UUID, List<GroupStimulusPlacement>> stimuliByGroup = new HashMap<>();
        final Map<UUID, List<StimulusAssetPlacement>> assetsByStimulus = new HashMap<>();
        final Map<UUID, List<ItemVersionRecord>> itemsByGroup = new HashMap<>();
        final Map<UUID, AnswerSpecRecord> specByItem = new HashMap<>();
        final Map<UUID, RubricVersionRecord> rubrics = new HashMap<>();

        Index(ExamContentPackage pkg) {
            this.pkg = pkg;
            pkg.parts().forEach(p -> partsBySection.computeIfAbsent(p.sectionId(), k -> new ArrayList<>()).add(p));
            pkg.formGroups().forEach(f -> placementsByPart.computeIfAbsent(f.partId(), k -> new ArrayList<>()).add(f));
            pkg.groups().forEach(g -> groups.put(g.id(), g));
            pkg.stimuli().forEach(s -> stimuli.put(s.id(), s));
            pkg.assets().forEach(a -> assets.put(a.id(), a));
            pkg.groupStimuli().forEach(gs -> stimuliByGroup.computeIfAbsent(gs.groupId(), k -> new ArrayList<>()).add(gs));
            pkg.stimulusAssets().forEach(sa -> assetsByStimulus.computeIfAbsent(sa.stimulusId(), k -> new ArrayList<>()).add(sa));
            pkg.items().forEach(i -> itemsByGroup.computeIfAbsent(i.groupId(), k -> new ArrayList<>()).add(i));
            pkg.answerSpecs().forEach(a -> specByItem.putIfAbsent(a.itemId(), a));
            pkg.rubrics().forEach(r -> rubrics.put(r.id(), r));
        }

        List<ItemVersionRecord> items(UUID groupId) {
            List<ItemVersionRecord> out = new ArrayList<>(itemsByGroup.getOrDefault(groupId, List.of()));
            out.sort(Comparator.comparing((ItemVersionRecord i) -> i.ordinal() == null ? Integer.MAX_VALUE : i.ordinal())
                    .thenComparing(ItemVersionRecord::logicalItemKey, Comparator.nullsLast(Comparator.naturalOrder())));
            return out;
        }

        List<GroupStimulusPlacement> groupStimuli(UUID groupId) {
            List<GroupStimulusPlacement> out = new ArrayList<>(stimuliByGroup.getOrDefault(groupId, List.of()));
            out.sort(Comparator.comparing(GroupStimulusPlacement::role, Comparator.nullsLast(Comparator.naturalOrder()))
                    .thenComparingInt(GroupStimulusPlacement::ordinal));
            return out;
        }

        Map<String, Object> stimulusContent(UUID stimulusId) {
            StimulusVersionRecord st = stimuli.get(stimulusId);
            Map<String, Object> m = new LinkedHashMap<>();
            if (st == null) return m;
            m.put("kind", st.kind());
            m.put("title", st.title());
            m.put("bodyPayload", st.bodyPayload());
            List<Object> media = new ArrayList<>();
            List<StimulusAssetPlacement> sas = new ArrayList<>(assetsByStimulus.getOrDefault(stimulusId, List.of()));
            sas.sort(Comparator.comparing(StimulusAssetPlacement::role, Comparator.nullsLast(Comparator.naturalOrder()))
                    .thenComparingInt(StimulusAssetPlacement::ordinal));
            for (StimulusAssetPlacement sa : sas) {
                AssetRecord a = assets.get(sa.assetId());
                Map<String, Object> am = new LinkedHashMap<>();
                am.put("role", sa.role());
                am.put("ordinal", sa.ordinal());
                if (a != null) {
                    am.put("sha256", a.sha256Hash() == null ? null : a.sha256Hash().toLowerCase(Locale.ROOT));
                    am.put("mimeType", a.mimeType());
                    am.put("byteSize", a.byteSize());
                    am.put("durationMs", a.durationMs());
                    am.put("dimensions", a.dimensions());
                }
                media.add(am);
            }
            m.put("media", media);
            return m;
        }

        Map<String, Object> groupContent(UUID groupId) {
            GroupVersionRecord g = groups.get(groupId);
            Map<String, Object> m = new LinkedHashMap<>();
            if (g != null) {
                m.put("questionType", g.questionType());
                m.put("construct", g.construct());
                m.put("skill", g.skill() == null ? null : g.skill().name());
                m.put("topic", g.topic());
                m.put("difficultyEstimate", g.difficultyEstimate());
            }
            List<Object> sts = new ArrayList<>();
            for (GroupStimulusPlacement gs : groupStimuli(groupId)) {
                Map<String, Object> sm = new LinkedHashMap<>();
                sm.put("role", gs.role());
                sm.put("ordinal", gs.ordinal());
                sm.put("stimulus", stimulusContent(gs.stimulusId()));
                sts.add(sm);
            }
            m.put("stimuli", sts);
            List<Object> its = new ArrayList<>();
            for (ItemVersionRecord i : items(groupId)) {
                Map<String, Object> im = new LinkedHashMap<>();
                im.put("ordinal", i.ordinal());
                im.put("prompt", i.prompt());
                im.put("interactionType", i.interactionType());
                im.put("optionDefinitions", i.optionDefinitions());
                im.put("construct", i.construct());
                AnswerSpecRecord a = specByItem.get(i.id());
                if (a != null) {
                    Map<String, Object> am = new LinkedHashMap<>();
                    am.put("acceptedAnswers", a.acceptedAnswers());
                    am.put("normalizationPolicy", a.normalizationPolicy());
                    am.put("cardinality", a.cardinality());
                    am.put("wordLimit", a.wordLimit());
                    am.put("creditUnits", a.creditUnits());
                    am.put("explanation", a.explanation());
                    RubricVersionRecord r = a.rubricId() == null ? null : rubrics.get(a.rubricId());
                    am.put("rubric", r == null ? null : r.logicalCode() + "@" + r.contentHash());
                    im.put("answer", am);
                }
                its.add(im);
            }
            m.put("items", its);
            return m;
        }

        Map<String, Object> itemIds(UUID groupId) {
            Map<String, Object> out = new TreeMap<>();
            for (ItemVersionRecord i : items(groupId)) {
                AnswerSpecRecord a = specByItem.get(i.id());
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("id", String.valueOf(i.id()));
                m.put("version", i.version());
                m.put("answerSpecId", a == null ? null : String.valueOf(a.id()));
                out.put(i.logicalItemKey(), m);
            }
            return out;
        }

        Map<String, Object> groupStimulusIds(UUID groupId) {
            Map<String, Object> out = new TreeMap<>();
            for (GroupStimulusPlacement gs : groupStimuli(groupId)) {
                StimulusVersionRecord st = stimuli.get(gs.stimulusId());
                out.put(gs.role() + "#" + gs.ordinal(), Map.of("id", String.valueOf(gs.id()),
                        "stimulusKey", st == null ? "" : String.valueOf(st.logicalStimulusKey())));
            }
            return out;
        }

        Map<String, Object> stimulusAssetIds(UUID stimulusId) {
            Map<String, Object> out = new TreeMap<>();
            for (StimulusAssetPlacement sa : assetsByStimulus.getOrDefault(stimulusId, List.of())) {
                out.put(sa.role() + "#" + sa.ordinal(), String.valueOf(sa.id()));
            }
            return out;
        }

        Map<String, Object> definitions() {
            Map<String, Object> out = new TreeMap<>();
            for (SpecificationVersionRecord s : pkg.specifications()) {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("family", s.family() == null ? null : s.family().name());
                m.put("variant", s.variant());
                m.put("deliveryMode", s.deliveryMode());
                m.put("blueprint", s.blueprint());
                m.put("timingPolicy", s.timingPolicy());
                m.put("navigationPolicy", s.navigationPolicy());
                m.put("playbackPolicy", s.playbackPolicy());
                out.put("spec:" + s.logicalCode() + "@" + s.version(), m);
            }
            for (ScoringSchemeVersionRecord s : pkg.scoringSchemes()) {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("scope", s.scope());
                m.put("normalizationVersion", s.normalizationVersion());
                m.put("mappingTable", s.mappingTable());
                m.put("aggregationRules", s.aggregationRules());
                out.put("scheme:" + s.logicalCode() + "@" + s.version(), m);
            }
            for (RubricVersionRecord r : pkg.rubrics()) {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("criteria", r.criteria());
                m.put("ordinalScale", r.ordinalScale());
                out.put("rubric:" + r.logicalCode() + "@" + r.version(), m);
            }
            return out;
        }
    }
}
