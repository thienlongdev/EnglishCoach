package com.englishcoach.exams.practice;

import com.englishcoach.exams.model.ExamTypes.ExamFamily;
import com.englishcoach.exams.model.ExamTypes.SkillType;

import java.util.*;

/**
 * Exams Phase 6 — one canonical practice scope of a form, resolved by the server from the stored content (never from
 * client-supplied item ids). Pinned into {@code attempts.manifest_snapshot} under {@link #SNAPSHOT_KEY} next to the
 * scope-filtered content snapshot, so resume, scoring, review and Practice Again all read the attempt's own scope.
 *
 * @param placementIds form placement ids ({@code form_groups.id}) of the scope, in printed order
 * @param groupIds     group version ids of the scope, in printed order
 * @param mediaAssetIds every asset the scope's stimuli reference (the only assets a grant may serve for the attempt)
 * @param scoringMode  {@link #SCORING_OBJECTIVE_RAW} (raw practice metrics, never a standardized scale) or
 *                     {@link #SCORING_RESPONSE_ONLY} (writing task: the response is kept, no score of any kind)
 */
public record ExamPracticeScope(
        String scopeCode,
        ExamPracticeScopeType scopeType,
        ExamFamily family,
        SkillType skill,
        int number,
        UUID formId,
        UUID sectionId,
        UUID partId,
        String partCode,
        List<UUID> placementIds,
        List<UUID> groupIds,
        int itemCount,
        int objectiveItemCount,
        String scoringMode,
        List<UUID> mediaAssetIds
) {
    public static final String SNAPSHOT_KEY = "practiceScope";
    public static final String VERSION = "exam-practice-scope-v1";
    public static final String SCORING_OBJECTIVE_RAW = "OBJECTIVE_RAW";
    public static final String SCORING_RESPONSE_ONLY = "RESPONSE_ONLY";
    /** Phase 6 practice is untimed: no official section time is invented for a part. */
    public static final String TIMING_UNTIMED = "UNTIMED";
    /** Correct answers are disclosed only after submission, from the attempt snapshot. */
    public static final String REVIEW_AFTER_SUBMISSION = "AFTER_SUBMISSION";

    public ExamPracticeScope {
        placementIds = placementIds == null ? List.of() : List.copyOf(placementIds);
        groupIds = groupIds == null ? List.of() : List.copyOf(groupIds);
        mediaAssetIds = mediaAssetIds == null ? List.of() : List.copyOf(mediaAssetIds);
    }

    public boolean objectiveScoring() {
        return SCORING_OBJECTIVE_RAW.equals(scoringMode);
    }

    /** The pinned snapshot block (ids, counts and modes only — no exam text). */
    public Map<String, Object> toSnapshotMap(String sourceLogicalKey, int sourceFormVersion, UUID practiceAgainOf) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("scopeVersion", VERSION);
        m.put("scopeCode", scopeCode);
        m.put("scopeType", scopeType.name());
        m.put("family", family.name());
        m.put("skill", skill.name());
        m.put("number", number);
        m.put("sourceFormId", formId.toString());
        m.put("sourceLogicalKey", sourceLogicalKey);
        m.put("sourceFormVersion", sourceFormVersion);
        m.put("sectionId", sectionId.toString());
        m.put("partId", partId.toString());
        m.put("partCode", partCode);
        m.put("placementIds", placementIds.stream().map(UUID::toString).toList());
        m.put("groupIds", groupIds.stream().map(UUID::toString).toList());
        m.put("itemCount", itemCount);
        m.put("objectiveItemCount", objectiveItemCount);
        m.put("scoringMode", scoringMode);
        m.put("timingMode", TIMING_UNTIMED);
        m.put("reviewPolicy", REVIEW_AFTER_SUBMISSION);
        m.put("resumable", true);
        m.put("mediaAssetIds", mediaAssetIds.stream().map(UUID::toString).toList());
        if (practiceAgainOf != null) m.put("practiceAgainOf", practiceAgainOf.toString());
        return m;
    }

    /** The scope block pinned in an attempt snapshot, or empty for every non-scoped attempt. */
    @SuppressWarnings("unchecked")
    public static Optional<Map<String, Object>> pinned(Map<String, Object> snapshot) {
        if (snapshot == null || !(snapshot.get(SNAPSHOT_KEY) instanceof Map<?, ?> m)) return Optional.empty();
        Map<String, Object> scope = (Map<String, Object>) m;
        return VERSION.equals(scope.get("scopeVersion")) ? Optional.of(scope) : Optional.empty();
    }

    public static boolean isScoped(Map<String, Object> snapshot) {
        return pinned(snapshot).isPresent();
    }

    /**
     * Learner response placement ids of a snapshot, built exactly as the manifest builds them
     * ({@code p_<partCode>_g_<logicalGroupKey>_i_<ordinal | position>}). For a scoped attempt this is the only set of
     * placements autosave and submit accept.
     */
    @SuppressWarnings("unchecked")
    public static Set<String> placementIdsOf(Map<String, Object> snapshot) {
        Set<String> out = new LinkedHashSet<>();
        if (snapshot == null || !(snapshot.get("sections") instanceof List<?> sections)) return out;
        for (Object so : sections) {
            if (!(so instanceof Map<?, ?> sec) || !(sec.get("parts") instanceof List<?> parts)) continue;
            for (Object po : parts) {
                if (!(po instanceof Map<?, ?> part) || !(part.get("groups") instanceof List<?> groups)) continue;
                String partCode = String.valueOf(part.get("partCode"));
                for (Object go : groups) {
                    if (!(go instanceof Map<?, ?> grp) || !(grp.get("items") instanceof List<?> items)) continue;
                    String base = "p_" + partCode + "_g_" + grp.get("logicalGroupKey");
                    int position = 0;
                    for (Object io : items) {
                        position++;
                        if (!(io instanceof Map<?, ?> item)) continue;
                        Object ordinal = item.get("ordinal");
                        out.add(base + "_i_" + (ordinal instanceof Number n ? n.intValue() : position));
                    }
                }
            }
        }
        return out;
    }

    /** Asset ids a scoped attempt may receive grants for (empty set when not scoped). */
    @SuppressWarnings("unchecked")
    public static Set<UUID> pinnedAssetIds(Map<String, Object> snapshot) {
        Set<UUID> out = new HashSet<>();
        pinned(snapshot).ifPresent(scope -> {
            if (scope.get("mediaAssetIds") instanceof List<?> l) {
                for (Object o : l) {
                    try {
                        out.add(UUID.fromString(String.valueOf(o)));
                    } catch (IllegalArgumentException ignored) {
                        // malformed ids grant nothing
                    }
                }
            }
        });
        return out;
    }

    /** Every asset id referenced by the content snapshot (stimuli of every pinned group). */
    @SuppressWarnings("unchecked")
    public static Set<UUID> snapshotAssetIds(Map<String, Object> snapshot) {
        Set<UUID> out = new HashSet<>();
        if (snapshot == null || !(snapshot.get("sections") instanceof List<?> sections)) return out;
        for (Object so : sections) {
            if (!(so instanceof Map<?, ?> sec) || !(sec.get("parts") instanceof List<?> parts)) continue;
            for (Object po : parts) {
                if (!(po instanceof Map<?, ?> part) || !(part.get("groups") instanceof List<?> groups)) continue;
                for (Object go : groups) {
                    if (!(go instanceof Map<?, ?> grp) || !(grp.get("stimuli") instanceof List<?> stimuli)) continue;
                    for (Object sto : stimuli) {
                        if (!(sto instanceof Map<?, ?> st) || !(st.get("assets") instanceof List<?> assets)) continue;
                        for (Object ao : assets) {
                            if (ao instanceof Map<?, ?> a && a.get("assetId") != null) {
                                try {
                                    out.add(UUID.fromString(String.valueOf(a.get("assetId"))));
                                } catch (IllegalArgumentException ignored) {
                                    // malformed ids grant nothing
                                }
                            }
                        }
                    }
                }
            }
        }
        return out;
    }

    /**
     * The form snapshot reduced to this scope: the scope's section with ONLY the scope's part (every group, stimulus,
     * item and answer spec of that part, untouched). Form meta and the snapshot version are kept. Returns empty when the
     * snapshot does not contain exactly the scope's part with exactly the scope's groups (never a partial scope).
     */
    @SuppressWarnings("unchecked")
    public Optional<Map<String, Object>> filterSnapshot(Map<String, Object> formSnapshot) {
        if (formSnapshot == null || !(formSnapshot.get("sections") instanceof List<?> sections)) return Optional.empty();
        Map<String, Object> keptSection = null;
        for (Object so : sections) {
            if (!(so instanceof Map<?, ?> sec) || !sectionId.toString().equals(String.valueOf(sec.get("id")))) continue;
            List<Object> keptParts = new ArrayList<>();
            if (sec.get("parts") instanceof List<?> parts) {
                for (Object po : parts) {
                    if (po instanceof Map<?, ?> part && partId.toString().equals(String.valueOf(part.get("id")))) keptParts.add(part);
                }
            }
            if (keptParts.size() != 1) return Optional.empty();
            List<String> snapshotGroups = new ArrayList<>();
            Map<String, Object> part = (Map<String, Object>) keptParts.get(0);
            if (scopeType == ExamPracticeScopeType.IELTS_WRITING_TASK && part.get("groups") instanceof List<?> groups) {
                Set<String> selected = new HashSet<>(groupIds.stream().map(UUID::toString).toList());
                Map<String, Object> narrowed = new LinkedHashMap<>(part);
                narrowed.put("groups", groups.stream().filter(g -> g instanceof Map<?, ?> m && selected.contains(String.valueOf(m.get("id")))).toList());
                narrowed.put("instructions", "Complete Writing Task " + number + ".");
                keptParts = List.of(narrowed);
                part = narrowed;
            }
            if (part.get("groups") instanceof List<?> groups) {
                for (Object go : groups) if (go instanceof Map<?, ?> g) snapshotGroups.add(String.valueOf(g.get("id")));
            }
            Set<String> expected = new HashSet<>(groupIds.stream().map(UUID::toString).toList());
            if (snapshotGroups.size() != groupIds.size() || !expected.equals(new HashSet<>(snapshotGroups))) return Optional.empty();
            keptSection = new LinkedHashMap<>((Map<String, Object>) sec);
            keptSection.put("parts", keptParts);
        }
        if (keptSection == null) return Optional.empty();
        Map<String, Object> out = new LinkedHashMap<>();
        for (Map.Entry<String, Object> e : formSnapshot.entrySet()) {
            if (!"sections".equals(e.getKey())) out.put(e.getKey(), e.getValue());
        }
        out.put("sections", List.of(keptSection));
        return Optional.of(out);
    }
}
