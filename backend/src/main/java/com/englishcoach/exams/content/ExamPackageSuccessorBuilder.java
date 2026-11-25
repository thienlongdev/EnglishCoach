package com.englishcoach.exams.content;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.nio.charset.StandardCharsets;
import java.util.*;

/**
 * Exams Recovery Phase 5E/5F — turns a corrected re-extraction of an already imported source into an IMMUTABLE successor
 * form version that never touches the rows a completed attempt may reference.
 *
 * <p>The extractor assigns positional ids (the same form / group / item ids on every run) and version 1 everywhere, so a
 * changed re-extraction cannot be imported as is. Against the identity recorded when the latest version was imported:
 * <ul>
 *   <li>form, sections, parts, form-group placements, form components: always NEW rows (new form version);</li>
 *   <li>a group placement whose content digest is unchanged: REUSES the recorded group, item, answer-spec and
 *       group-stimulus rows (same id + version);</li>
 *   <li>a changed or new group placement: NEW group version (version = the new form version) with new item versions,
 *       answer specs and group-stimulus placements;</li>
 *   <li>stimuli: reused when the digest under the same logical key is unchanged, else a new stimulus version;</li>
 *   <li>assets (content-addressed by SHA-256), sources, licences, provenance, specifications, scoring schemes and
 *       rubrics keep their ids (a changed shared definition is refused by the planner, not versioned here).</li>
 * </ul>
 * New ids are name-based (old id + target form version), so building the same successor twice gives the same package.
 */
public final class ExamPackageSuccessorBuilder {

    private ExamPackageSuccessorBuilder() {}

    private static final java.util.regex.Pattern UUID_TEXT =
            java.util.regex.Pattern.compile("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");

    public record Result(ExamContentPackage pkg, Set<String> changedPlacements, Set<String> reusedPlacements,
                         Set<String> newStimuli, Set<String> reusedStimuli) {}

    @SuppressWarnings("unchecked")
    public static Result build(ExamContentPackage fresh, ExamPackageIdentity previous, int formVersion, int packageVersion,
                               ObjectMapper mapper) {
        if (previous == null) throw new IllegalArgumentException("SUCCESSOR_PREVIOUS_IDENTITY_REQUIRED");
        if (formVersion <= previous.formVersion() || packageVersion <= previous.packageVersion()) {
            throw new IllegalArgumentException("SUCCESSOR_VERSION_NOT_INCREASING");
        }
        if (!Objects.equals(fresh.form().logicalKey(), previous.formLogicalKey())) {
            throw new IllegalArgumentException("SUCCESSOR_FORM_IDENTITY_MISMATCH");
        }
        ExamPackageIdentity now = ExamPackageIdentity.of(fresh);
        if (!Objects.equals(now.sourceKey(), previous.sourceKey())) {
            throw new IllegalArgumentException("SUCCESSOR_SOURCE_IDENTITY_MISMATCH");
        }
        Map<String, String> ids = new LinkedHashMap<>();
        Map<String, Integer> versions = new HashMap<>();      // NEW id → row version
        String fv = ":v" + formVersion;

        ids.put(str(fresh.form().id()), derived(fresh.form().id(), fv));
        fresh.sections().forEach(s -> ids.put(str(s.id()), derived(s.id(), fv)));
        fresh.parts().forEach(p -> ids.put(str(p.id()), derived(p.id(), fv)));
        fresh.formGroups().forEach(f -> ids.put(str(f.id()), derived(f.id(), fv)));
        fresh.formComponents().forEach(c -> ids.put(str(c.id()), derived(c.id(), fv)));

        Set<String> changed = new TreeSet<>(), reused = new TreeSet<>();
        for (Map.Entry<String, Map<String, Object>> e : now.placements().entrySet()) {
            Map<String, Object> cur = e.getValue();
            Map<String, Object> prev = previous.placements().get(e.getKey());
            Map<String, Object> curItems = (Map<String, Object>) cur.getOrDefault("items", Map.of());
            Map<String, Object> curGs = (Map<String, Object>) cur.getOrDefault("groupStimuli", Map.of());
            boolean same = prev != null && Objects.equals(prev.get("digest"), cur.get("digest"))
                    && ((Map<String, Object>) prev.getOrDefault("items", Map.of())).keySet().equals(curItems.keySet())
                    && ((Map<String, Object>) prev.getOrDefault("groupStimuli", Map.of())).keySet().equals(curGs.keySet());
            String gid = String.valueOf(cur.get("groupId"));
            if (same) {
                reused.add(e.getKey());
                ids.put(gid, String.valueOf(prev.get("groupId")));
                versions.put(String.valueOf(prev.get("groupId")), ((Number) prev.get("version")).intValue());
                Map<String, Object> prevItems = (Map<String, Object>) prev.get("items");
                for (Map.Entry<String, Object> it : curItems.entrySet()) {
                    Map<String, Object> c = (Map<String, Object>) it.getValue();
                    Map<String, Object> p = (Map<String, Object>) prevItems.get(it.getKey());
                    ids.put(String.valueOf(c.get("id")), String.valueOf(p.get("id")));
                    versions.put(String.valueOf(p.get("id")), ((Number) p.get("version")).intValue());
                    if (c.get("answerSpecId") != null && p.get("answerSpecId") != null) {
                        ids.put(String.valueOf(c.get("answerSpecId")), String.valueOf(p.get("answerSpecId")));
                    }
                }
                Map<String, Object> prevGs = (Map<String, Object>) prev.get("groupStimuli");
                for (Map.Entry<String, Object> g : curGs.entrySet()) {
                    ids.put(String.valueOf(((Map<String, Object>) g.getValue()).get("id")),
                            String.valueOf(((Map<String, Object>) prevGs.get(g.getKey())).get("id")));
                }
            } else {
                changed.add(e.getKey());
                String ng = derived(gid, fv);
                ids.put(gid, ng);
                versions.put(ng, formVersion);
                for (Object o : curItems.values()) {
                    Map<String, Object> c = (Map<String, Object>) o;
                    String ni = derived(String.valueOf(c.get("id")), fv);
                    ids.put(String.valueOf(c.get("id")), ni);
                    versions.put(ni, formVersion);
                    if (c.get("answerSpecId") != null) {
                        ids.put(String.valueOf(c.get("answerSpecId")), derived(String.valueOf(c.get("answerSpecId")), fv));
                    }
                }
                for (Object o : curGs.values()) {
                    String old = String.valueOf(((Map<String, Object>) o).get("id"));
                    ids.put(old, derived(old, fv));
                }
            }
        }
        Set<String> newStimuli = new TreeSet<>(), reusedStimuli = new TreeSet<>();
        for (Map.Entry<String, Map<String, Object>> e : now.stimuli().entrySet()) {
            Map<String, Object> cur = e.getValue();
            Map<String, Object> prev = previous.stimuli().get(e.getKey());
            String sid = String.valueOf(cur.get("id"));
            Map<String, Object> curSa = (Map<String, Object>) cur.getOrDefault("stimulusAssets", Map.of());
            boolean same = prev != null && Objects.equals(prev.get("digest"), cur.get("digest"))
                    && ((Map<String, Object>) prev.getOrDefault("stimulusAssets", Map.of())).keySet().equals(curSa.keySet());
            if (same) {
                reusedStimuli.add(e.getKey());
                ids.put(sid, String.valueOf(prev.get("id")));
                versions.put(String.valueOf(prev.get("id")), ((Number) prev.get("version")).intValue());
                Map<String, Object> prevSa = (Map<String, Object>) prev.get("stimulusAssets");
                for (Map.Entry<String, Object> sa : curSa.entrySet()) {
                    ids.put(String.valueOf(sa.getValue()), String.valueOf(prevSa.get(sa.getKey())));
                }
            } else {
                newStimuli.add(e.getKey());
                String ns = derived(sid, fv);
                ids.put(sid, ns);
                versions.put(ns, formVersion);
                for (Object o : curSa.values()) ids.put(String.valueOf(o), derived(String.valueOf(o), fv));
            }
        }

        try {
            // one pass: every id is mapped exactly once (a sequential replace could chain A→B→C when positional ids
            // of a re-extraction collide with ids recorded for other placements)
            String text = UUID_TEXT.matcher(mapper.writeValueAsString(fresh))
                    .replaceAll(m -> java.util.regex.Matcher.quoteReplacement(ids.getOrDefault(m.group(), m.group())));
            ObjectNode root = (ObjectNode) mapper.readTree(text);
            ((ObjectNode) root.path("form")).put("version", formVersion);
            ((ObjectNode) root.path("manifest")).put("packageVersion", packageVersion);
            for (String arr : List.of("groups", "items", "stimuli")) {
                for (JsonNode n : root.path(arr)) {
                    Integer v = versions.get(n.path("id").asText());
                    if (v != null) ((ObjectNode) n).put("version", v);
                }
            }
            ExamContentPackage out = mapper.treeToValue(root, ExamContentPackage.class);
            String hash = new ExamContentPackageValidator(mapper).computeContentHash(out);
            ((ObjectNode) root.path("manifest")).put("contentHash", hash);
            return new Result(mapper.treeToValue(root, ExamContentPackage.class), changed, reused, newStimuli, reusedStimuli);
        } catch (Exception e) {
            throw new IllegalStateException("SUCCESSOR_BUILD_FAILED: " + e.getMessage(), e);
        }
    }

    private static String str(UUID id) {
        return String.valueOf(id);
    }

    private static String derived(Object oldId, String suffix) {
        return UUID.nameUUIDFromBytes(("exam-successor:" + oldId + suffix).getBytes(StandardCharsets.UTF_8)).toString();
    }
}
