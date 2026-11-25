package com.englishcoach.exams.release;

import com.englishcoach.exams.content.ExamContentPackage;
import com.englishcoach.exams.model.ExamContentRecords.*;
import com.englishcoach.exams.model.ExamTypes.SkillType;
import com.englishcoach.exams.release.ExamRunnerCapabilities.Capabilities;
import com.englishcoach.exams.release.ExamRunnerCapabilities.Support;
import com.englishcoach.exams.scoring.ExamAnswerNormalizer;
import com.englishcoach.exams.scoring.ExamAttemptSnapshotContent;
import com.englishcoach.exams.scoring.ExamObjectiveScorer;

import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Exams Recovery Phase 4B.9 + 4C.8 — deterministic RUNNER and SCORING compatibility of one canonical package against
 * the DECLARED runtime ({@link ExamRunnerCapabilities}). Pure: no I/O, no DB. It never relaxes or replaces the Phase 2
 * structural gate ({@code ExamFormValidator}); it answers a different question: can the current runtime render, accept,
 * score and review exactly what this package contains?
 *
 * <p>Severity: BLOCKING (gate = NO), REVIEW (renders / scores correctly only after a human QA decision — counted by the
 * QA dimension of the release gate), WARNING / INFO (reported). Diagnostics carry codes, counts and ids — no exam text.
 */
public final class ExamRuntimeCompatibility {

    private ExamRuntimeCompatibility() {}

    public enum Gate { RUNNER, SCORING }

    public enum Severity { BLOCKING, REVIEW, WARNING, INFO }

    public record Diagnostic(Gate gate, String code, Severity severity, int occurrences, String sampleRef) {}

    public record InteractionUse(String interactionType, int items, Support runner, boolean objectiveScorer,
                                 Set<String> featuresUsed) {}

    public record Report(String packageId, boolean runnerCompatible, boolean scoringCompatible,
                         Map<String, InteractionUse> interactions, Set<String> requiredFeatures,
                         List<Diagnostic> diagnostics) {
        public List<String> blockingCodes(Gate gate) {
            return diagnostics.stream().filter(d -> d.gate() == gate && d.severity() == Severity.BLOCKING)
                    .map(Diagnostic::code).distinct().sorted().toList();
        }

        public Set<String> reviewCodes() {
            Set<String> out = new TreeSet<>();
            for (Diagnostic d : diagnostics) if (d.severity() == Severity.REVIEW) out.add(d.code());
            return out;
        }
    }

    private static final Pattern BLANK = Pattern.compile("\\((\\d{1,3})\\)\\s*(?:_{2,}|…+|\\.{3,})");
    private static final Set<String> VISUAL_KINDS = Set.of("IMAGE", "CHART", "MAP", "DIAGRAM", "PHOTO", "TABLE_IMAGE");
    private static final ExamObjectiveScorer SCORER = new ExamObjectiveScorer(new ExamAnswerNormalizer());

    public static Report audit(ExamContentPackage pkg) {
        return audit(pkg, ExamRunnerCapabilities.CURRENT);
    }

    @SuppressWarnings("unchecked")
    public static Report audit(ExamContentPackage pkg, Capabilities caps) {
        Collector c = new Collector();
        Map<UUID, AnswerSpecRecord> specs = new HashMap<>();
        for (AnswerSpecRecord s : pkg.answerSpecs()) specs.put(s.itemId(), s);
        Map<UUID, SkillType> sectionSkill = new HashMap<>();
        for (SectionRecord s : pkg.sections()) sectionSkill.put(s.id(), s.skill());
        Map<UUID, PartRecord> parts = new HashMap<>();
        for (PartRecord p : pkg.parts()) parts.put(p.id(), p);
        Map<UUID, UUID> groupPart = new HashMap<>();
        for (ExamContentPackage.FormGroupPlacement fg : pkg.formGroups()) groupPart.put(fg.groupId(), fg.partId());
        Map<UUID, List<ItemVersionRecord>> itemsByGroup = new LinkedHashMap<>();
        for (ItemVersionRecord it : pkg.items()) itemsByGroup.computeIfAbsent(it.groupId(), k -> new ArrayList<>()).add(it);
        Map<UUID, StimulusVersionRecord> stimuli = new HashMap<>();
        for (StimulusVersionRecord s : pkg.stimuli()) stimuli.put(s.id(), s);
        Map<UUID, AssetRecord> assets = new HashMap<>();
        for (AssetRecord a : pkg.assets()) assets.put(a.id(), a);
        Map<UUID, List<AssetRecord>> assetsByStimulus = new HashMap<>();
        for (ExamContentPackage.StimulusAssetPlacement sa : pkg.stimulusAssets()) {
            AssetRecord a = assets.get(sa.assetId());
            if (a != null) assetsByStimulus.computeIfAbsent(sa.stimulusId(), k -> new ArrayList<>()).add(a);
        }
        Set<String> derivedSegmentShas = new HashSet<>();
        if (pkg.manifest().metadata().get("audioSegments") instanceof List<?> segs) {
            for (Object o : segs) if (o instanceof Map<?, ?> m && m.get("segmentSha256") != null) {
                derivedSegmentShas.add(String.valueOf(m.get("segmentSha256")).toLowerCase(Locale.ROOT));
            }
        }

        Map<String, int[]> interactionCounts = new TreeMap<>();
        Map<String, Set<String>> interactionFeatures = new TreeMap<>();
        Set<String> required = new TreeSet<>();

        // ---- items ----------------------------------------------------------------------------------------------
        for (ItemVersionRecord it : pkg.items()) {
            String type = it.interactionType() == null ? "" : it.interactionType().toUpperCase(Locale.ROOT);
            interactionCounts.computeIfAbsent(type, k -> new int[1])[0]++;
            Support support = caps.interactions().getOrDefault(type, Support.UNSUPPORTED);
            if (support == Support.UNSUPPORTED) {
                c.add(Gate.RUNNER, "RUNNER_INTERACTION_UNSUPPORTED", Severity.BLOCKING, it.logicalItemKey());
            } else if (support == Support.PARTIAL && "SPEAKING_RESPONSE".equals(type)) {
                c.add(Gate.RUNNER, "RUNNER_SPEAKING_PROMPTS_RUNTIME_GENERATED", Severity.WARNING, it.logicalItemKey());
            } else if (support == Support.PARTIAL) {
                c.add(Gate.RUNNER, "RUNNER_INTERACTION_PARTIAL", Severity.BLOCKING, it.logicalItemKey());
            }
            AnswerSpecRecord spec = specs.get(it.id());
            if (ExamRunnerCapabilities.PRODUCTIVE_INTERACTIONS.contains(type)) {
                if (spec == null || spec.rubricId() == null) {
                    c.add(Gate.SCORING, "SCORER_RUBRIC_MISSING", Severity.BLOCKING, it.logicalItemKey());
                }
                continue;
            }
            if (!caps.objectiveScorerInteractions().contains(type)) {
                c.add(Gate.SCORING, "SCORER_INTERACTION_UNSUPPORTED", Severity.BLOCKING, it.logicalItemKey());
                continue;
            }
            if (spec == null || ExamObjectiveScorer.nonBlankAccepted(spec.acceptedAnswers()).isEmpty()) {
                c.add(Gate.SCORING, "ANSWER_SPEC_INVALID", Severity.BLOCKING, it.logicalItemKey() + ":KEY_MISSING");
                continue;
            }
            Map<String, Object> defs = it.optionDefinitions() != null ? it.optionDefinitions() : Map.of();
            if (ExamRunnerCapabilities.OPTION_KEYED_INTERACTIONS.contains(type)) {
                Set<String> ids = optionIds(defs);
                for (String key : ExamObjectiveScorer.nonBlankAccepted(spec.acceptedAnswers())) {
                    if (!ids.contains(key)) {
                        c.add(Gate.SCORING, "ANSWER_SPEC_INVALID", Severity.BLOCKING, it.logicalItemKey() + ":KEY_NOT_AN_OPTION");
                        break;
                    }
                }
            }
            Map<String, Object> group = defs.get("group") instanceof Map<?, ?> g ? (Map<String, Object>) g : Map.of();
            if (spec.wordLimit() != null && spec.wordLimit() > 0) {
                interactionFeatures.computeIfAbsent(type, k -> new TreeSet<>()).add("WORD_LIMIT");
                required.add("WORD_LIMIT_DISPLAY");
                boolean numbersExempt = ExamAttemptSnapshotContent.wordLimitAllowsNumber(defs);
                if (!SCORER.isWordLimitEnforceable(spec, numbersExempt)) {
                    c.add(Gate.SCORING, "ANSWER_SPEC_INVALID", Severity.BLOCKING, it.logicalItemKey() + ":KEY_BREAKS_WORD_LIMIT");
                }
                if (!caps.scoringContract().contains("WORD_LIMIT_ENFORCED")) {
                    c.add(Gate.SCORING, "WORD_LIMIT_UNENFORCED", Severity.BLOCKING, it.logicalItemKey());
                }
            } else if (group.get("wordLimitRule") != null) {
                c.add(Gate.SCORING, "WORD_LIMIT_UNENFORCED", Severity.BLOCKING, it.logicalItemKey() + ":RULE_WITHOUT_LIMIT");
            }
        }

        // ---- groups: instructions, completion templates, choose-N ---------------------------------------------
        for (Map.Entry<UUID, List<ItemVersionRecord>> e : itemsByGroup.entrySet()) {
            List<ItemVersionRecord> items = e.getValue();
            Map<String, Object> first = items.get(0).optionDefinitions() != null ? items.get(0).optionDefinitions() : Map.of();
            Map<String, Object> group = first.get("group") instanceof Map<?, ?> g ? (Map<String, Object>) g : Map.of();
            String ref = items.get(0).logicalItemKey();
            if (group.get("instructions") instanceof List<?> l && !l.isEmpty()) {
                required.add("GROUP_INSTRUCTIONS");
                if (!caps.feature("GROUP_INSTRUCTIONS") || !caps.manifestContract().contains("GROUP_PRESENTATION")) {
                    c.add(Gate.RUNNER, "RUNNER_GROUP_INSTRUCTIONS_DROPPED", Severity.BLOCKING, ref);
                }
            }
            boolean allText = items.stream().allMatch(i -> "TEXT_GAP".equalsIgnoreCase(i.interactionType())
                    || "SHORT_ANSWER".equalsIgnoreCase(i.interactionType()));
            if (allText && group.get("stem") instanceof String stem && !stem.isBlank()) {
                required.add("COMPLETION_TEMPLATE");
                if (!caps.feature("COMPLETION_TEMPLATE") || !caps.manifestContract().contains("GROUP_PRESENTATION")) {
                    c.add(Gate.RUNNER, "RUNNER_COMPLETION_TEMPLATE_UNSUPPORTED", Severity.BLOCKING, ref);
                } else if (!templateComplete(stem, items)) {
                    c.add(Gate.RUNNER, "RUNNER_COMPLETION_TEMPLATE_INCOMPLETE", Severity.REVIEW, ref);
                }
            }
            auditSelections(c, caps, items, specs, required, ref);
        }

        // ---- stimuli / media -------------------------------------------------------------------------------------
        Map<SkillType, Set<String>> audioAssetsBySkill = new EnumMap<>(SkillType.class);
        for (ExamContentPackage.GroupStimulusPlacement gs : pkg.groupStimuli()) {
            StimulusVersionRecord st = stimuli.get(gs.stimulusId());
            if (st == null) continue;
            String kind = st.kind() == null ? "" : st.kind().toUpperCase(Locale.ROOT);
            Map<String, Object> body = st.bodyPayload() != null ? st.bodyPayload() : Map.of();
            List<AssetRecord> stAssets = assetsByStimulus.getOrDefault(st.id(), List.of());
            UUID partId = groupPart.get(gs.groupId());
            PartRecord part = partId != null ? parts.get(partId) : null;
            SkillType skill = part != null ? sectionSkill.get(part.sectionId()) : null;
            if ("MULTI_DOC".equals(kind)) {
                if ("SEGMENTED".equals(body.get("documentBoundaries"))) {
                    required.add("MULTI_DOC_SEGMENTED");
                    if (!caps.feature("MULTI_DOC_SEGMENTED")) {
                        c.add(Gate.RUNNER, "RUNNER_MULTI_DOC_UNSUPPORTED", Severity.BLOCKING, st.logicalStimulusKey());
                    }
                } else {
                    c.add(Gate.RUNNER, "MULTI_DOC_BOUNDARY_NOT_SEGMENTED", Severity.REVIEW, st.logicalStimulusKey());
                }
            }
            if (VISUAL_KINDS.contains(kind)) {
                required.add("IMAGE_STIMULUS_GRANT");
                boolean resolvable = stAssets.stream().anyMatch(a -> a.id() != null && a.mimeType() != null
                        && a.mimeType().toLowerCase(Locale.ROOT).startsWith("image/"));
                if (!resolvable) {
                    c.add(Gate.RUNNER, "RUNNER_IMAGE_REFERENCE_UNRESOLVED", Severity.BLOCKING, st.logicalStimulusKey());
                } else if (!caps.feature("IMAGE_STIMULUS_GRANT") || !caps.manifestContract().contains("ASSET_DELIVERY_PLAYBACK_GRANT")) {
                    c.add(Gate.RUNNER, "RUNNER_IMAGE_REFERENCE_UNRESOLVED", Severity.BLOCKING, st.logicalStimulusKey() + ":NO_DELIVERY");
                }
            }
            if ("AUDIO".equals(kind)) {
                if (body.containsKey("startMs") || body.containsKey("endMs") || body.containsKey("rangeStartMs")) {
                    required.add("VIRTUAL_AUDIO_RANGE");
                    if (!caps.feature("VIRTUAL_AUDIO_RANGE")) {
                        c.add(Gate.RUNNER, "RUNNER_AUDIO_SEGMENT_UNSUPPORTED", Severity.BLOCKING, st.logicalStimulusKey() + ":VIRTUAL_RANGE");
                    }
                }
                List<AssetRecord> audio = stAssets.stream().filter(a -> a.mimeType() != null
                        && a.mimeType().toLowerCase(Locale.ROOT).startsWith("audio/")).toList();
                if (audio.isEmpty()) {
                    c.add(Gate.RUNNER, "RUNNER_AUDIO_REFERENCE_UNRESOLVED", Severity.BLOCKING, st.logicalStimulusKey());
                }
                for (AssetRecord a : audio) {
                    if (skill != null) audioAssetsBySkill.computeIfAbsent(skill, k -> new TreeSet<>()).add(a.id().toString());
                    if (a.sha256Hash() != null && derivedSegmentShas.contains(a.sha256Hash().toLowerCase(Locale.ROOT))) {
                        required.add("PER_PART_AUDIO_PLAYLIST");
                        if (!caps.feature("PER_PART_AUDIO_PLAYLIST")) {
                            c.add(Gate.RUNNER, "RUNNER_AUDIO_SEGMENT_UNSUPPORTED", Severity.BLOCKING, st.logicalStimulusKey());
                        }
                    }
                }
            }
        }
        for (Map.Entry<SkillType, Set<String>> e : audioAssetsBySkill.entrySet()) {
            if (e.getValue().size() > 1) {
                required.add("PER_PART_AUDIO_PLAYLIST");
                if (!caps.feature("PER_PART_AUDIO_PLAYLIST")) {
                    c.add(Gate.RUNNER, "RUNNER_AUDIO_MULTI_PART_UNSUPPORTED", Severity.BLOCKING, e.getKey().name());
                }
            }
        }

        // ---- pipeline-level scoring facts ---------------------------------------------------------------------
        if (!caps.scoringContract().contains("ATTEMPT_SNAPSHOT_SCORING")) {
            c.add(Gate.SCORING, "SNAPSHOT_SCORING_UNSAFE", Severity.BLOCKING, "pipeline");
        }
        if (!caps.scoringContract().contains("EMPTY_KEY_NEVER_MATCHES")) {
            c.add(Gate.SCORING, "EMPTY_KEY_SCORING_UNSAFE", Severity.BLOCKING, "pipeline");
        }
        if (!caps.scoringContract().contains("AI_FALLBACK_REVIEW_REQUIRED")
                && pkg.items().stream().anyMatch(i -> ExamRunnerCapabilities.PRODUCTIVE_INTERACTIONS.contains(
                String.valueOf(i.interactionType()).toUpperCase(Locale.ROOT)))) {
            c.add(Gate.SCORING, "AI_FALLBACK_UNSAFE", Severity.BLOCKING, "pipeline");
        }
        Map<SkillType, Integer> objectiveBySkill = new EnumMap<>(SkillType.class);
        for (ItemVersionRecord it : pkg.items()) {
            String type = String.valueOf(it.interactionType()).toUpperCase(Locale.ROOT);
            if (ExamRunnerCapabilities.PRODUCTIVE_INTERACTIONS.contains(type)) continue;
            UUID partId = groupPart.get(it.groupId());
            PartRecord part = partId != null ? parts.get(partId) : null;
            SkillType skill = part != null ? sectionSkill.get(part.sectionId()) : null;
            if (skill != null && specs.containsKey(it.id())) objectiveBySkill.merge(skill, 1, Integer::sum);
        }
        String family = pkg.form() != null ? String.valueOf(pkg.form().family()) : "";
        int standard = "IELTS".equals(family) ? 40 : "TOEIC".equals(family) ? 100 : -1;
        for (Map.Entry<SkillType, Integer> e : objectiveBySkill.entrySet()) {
            if ((e.getKey() == SkillType.LISTENING || e.getKey() == SkillType.READING) && e.getValue() != standard) {
                c.add(Gate.SCORING, caps.scoringContract().contains("PARTIAL_SECTION_UNSCALED")
                        ? "PARTIAL_SECTION_UNSCALED" : "PARTIAL_SCALE_UNSAFE",
                        caps.scoringContract().contains("PARTIAL_SECTION_UNSCALED") ? Severity.INFO : Severity.BLOCKING,
                        e.getKey().name() + ":" + e.getValue());
            }
        }

        Map<String, InteractionUse> inventory = new LinkedHashMap<>();
        for (Map.Entry<String, int[]> e : interactionCounts.entrySet()) {
            inventory.put(e.getKey(), new InteractionUse(e.getKey(), e.getValue()[0],
                    caps.interactions().getOrDefault(e.getKey(), Support.UNSUPPORTED),
                    caps.objectiveScorerInteractions().contains(e.getKey()),
                    interactionFeatures.getOrDefault(e.getKey(), Set.of())));
        }
        List<Diagnostic> diags = c.build();
        boolean runner = diags.stream().noneMatch(d -> d.gate() == Gate.RUNNER && d.severity() == Severity.BLOCKING);
        boolean scoring = diags.stream().noneMatch(d -> d.gate() == Gate.SCORING && d.severity() == Severity.BLOCKING);
        return new Report(pkg.manifest().packageId(), runner, scoring, inventory, required, diags);
    }

    @SuppressWarnings("unchecked")
    private static void auditSelections(Collector c, Capabilities caps, List<ItemVersionRecord> items,
                                        Map<UUID, AnswerSpecRecord> specs, Set<String> required, String ref) {
        Map<String, List<ItemVersionRecord>> sets = new LinkedHashMap<>();
        Map<String, Integer> counts = new HashMap<>();
        for (ItemVersionRecord it : items) {
            Map<String, Object> defs = it.optionDefinitions() != null ? it.optionDefinitions() : Map.of();
            if (!(defs.get("selection") instanceof Map<?, ?> sel)) continue;
            Object count = sel.get("count");
            if (!(count instanceof Number n) || n.intValue() < 2) continue;
            List<Integer> qs = new ArrayList<>();
            if (sel.get("questions") instanceof List<?> l) for (Object o : l) if (o instanceof Number q) qs.add(q.intValue());
            Collections.sort(qs);
            String key = qs.toString();
            sets.computeIfAbsent(key, k -> new ArrayList<>()).add(it);
            counts.put(key, n.intValue());
        }
        for (Map.Entry<String, List<ItemVersionRecord>> s : sets.entrySet()) {
            required.add("CHOOSE_N_SELECTION");
            if (!caps.feature("CHOOSE_N_SELECTION") || !caps.manifestContract().contains("ITEM_SELECTION_CARDINALITY")) {
                c.add(Gate.RUNNER, "RUNNER_MULTI_SELECT_UNSUPPORTED", Severity.BLOCKING, ref);
            }
            if (!caps.scoringContract().contains("UNORDERED_SET_DEDUP")) {
                c.add(Gate.SCORING, "MULTI_SELECT_CONTRACT_MISMATCH", Severity.BLOCKING, ref + ":NO_SET_SEMANTICS");
            }
            int count = counts.get(s.getKey());
            List<ItemVersionRecord> members = s.getValue();
            Set<Integer> memberNumbers = new TreeSet<>();
            for (ItemVersionRecord m : members) {
                Object qn = m.optionDefinitions().get("questionNumber");
                if (qn instanceof Number q) memberNumbers.add(q.intValue());
            }
            if (members.size() != count || !s.getKey().equals(new ArrayList<>(memberNumbers).toString())) {
                c.add(Gate.RUNNER, "RUNNER_MULTI_SELECT_CONTRACT_INVALID", Severity.BLOCKING, ref);
            }
            Set<String> optionIds = optionIds(members.get(0).optionDefinitions());
            String setSignature = null;
            for (ItemVersionRecord m : members) {
                AnswerSpecRecord spec = specs.get(m.id());
                Map<String, Object> acc = spec != null && spec.acceptedAnswers() != null ? spec.acceptedAnswers() : Map.of();
                if (!(acc.get("unorderedSet") instanceof Map<?, ?> set)) {
                    c.add(Gate.SCORING, "MULTI_SELECT_CONTRACT_MISMATCH", Severity.BLOCKING, m.logicalItemKey() + ":NO_UNORDERED_SET");
                    continue;
                }
                List<String> values = new ArrayList<>();
                if (set.get("values") instanceof List<?> l) for (Object o : l) if (o != null) values.add(String.valueOf(o));
                List<Integer> qs = new ArrayList<>();
                if (set.get("questions") instanceof List<?> l) for (Object o : l) if (o instanceof Number q) qs.add(q.intValue());
                Collections.sort(qs);
                if (values.size() != count || new HashSet<>(values).size() != count || !optionIds.containsAll(values)
                        || !qs.toString().equals(s.getKey())) {
                    c.add(Gate.SCORING, "MULTI_SELECT_CONTRACT_MISMATCH", Severity.BLOCKING, m.logicalItemKey());
                }
                String signature = new TreeSet<>(values) + "@" + qs;
                if (setSignature == null) setSignature = signature;
                else if (!setSignature.equals(signature)) {
                    c.add(Gate.SCORING, "MULTI_SELECT_CONTRACT_MISMATCH", Severity.BLOCKING, m.logicalItemKey() + ":SET_DIFFERS");
                }
            }
        }
    }

    static boolean templateComplete(String stem, List<ItemVersionRecord> items) {
        Map<Integer, Integer> seen = new HashMap<>();
        Matcher m = BLANK.matcher(stem);
        while (m.find()) seen.merge(Integer.parseInt(m.group(1)), 1, Integer::sum);
        Set<Integer> numbers = new HashSet<>();
        for (ItemVersionRecord it : items) {
            Object qn = it.optionDefinitions() != null ? it.optionDefinitions().get("questionNumber") : null;
            if (!(qn instanceof Number n)) return false;
            numbers.add(n.intValue());
        }
        if (numbers.size() != items.size()) return false;
        for (int n : numbers) if (seen.getOrDefault(n, 0) != 1) return false;
        return numbers.containsAll(seen.keySet());
    }

    private static Set<String> optionIds(Map<String, Object> defs) {
        Set<String> ids = new LinkedHashSet<>();
        if (defs != null && defs.get("options") instanceof List<?> l) {
            for (Object o : l) {
                if (o instanceof Map<?, ?> m && m.get("id") != null) ids.add(String.valueOf(m.get("id")));
                else if (o instanceof String s) ids.add(s);
            }
        }
        return ids;
    }

    private static final class Collector {
        private final Map<String, Object[]> byKey = new LinkedHashMap<>();

        void add(Gate gate, String code, Severity severity, String ref) {
            String key = gate + "|" + code + "|" + severity;
            Object[] v = byKey.computeIfAbsent(key, k -> new Object[]{gate, code, severity, 0, ref});
            v[3] = (Integer) v[3] + 1;
        }

        List<Diagnostic> build() {
            List<Diagnostic> out = new ArrayList<>();
            for (Object[] v : byKey.values()) {
                out.add(new Diagnostic((Gate) v[0], (String) v[1], (Severity) v[2], (Integer) v[3], (String) v[4]));
            }
            return out;
        }
    }
}
