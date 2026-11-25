package com.englishcoach.exams.validation;

import com.englishcoach.exams.content.ExamContentPackage;
import com.englishcoach.exams.model.ExamContentRecords.*;
import com.englishcoach.exams.model.ExamTypes.ExamFamily;
import com.englishcoach.exams.model.ExamTypes.SkillType;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;

/**
 * Canonical, storage-independent view of ONE exam form, used by every validation path (Exams Recovery Phase 2):
 * <pre>
 * FORM
 * └── SECTION (skill, duration, operator flags)
 *     └── PART (part code)
 *         └── GROUP (form placement; set / passage group / standalone)
 *             ├── STIMULUS (passage, audio, image, chart …) └── ASSET (mime, validation state)
 *             └── ITEM (prompt, interaction, options JSON) └── ANSWER SPEC (accepted answers JSON, rubric, word limit)
 * </pre>
 * Built from persisted content ({@link ExamContentValidationRepository#loadTree}) or from an
 * {@link ExamContentPackage} ({@link #fromPackage}), so live forms and import packages are judged by the same rules.
 * Option and answer JSON stay raw text so the validator reads them exactly as the objective scorer does.
 *
 * @param operatorHealth   legacy {@code form_versions.primary_health_status}; restrict-only, null = no restriction
 * @param declaredBlueprint specification blueprint (may declare {@code formatVersion}); never trusted to grant validity
 */
public record ExamContentTree(
        UUID formId,
        ExamFamily family,
        String variant,
        String scope,
        String operatorHealth,
        boolean scoringSchemePresent,
        Map<String, Object> declaredBlueprint,
        List<SectionNode> sections
) {

    public ExamContentTree {
        declaredBlueprint = declaredBlueprint == null ? Map.of() : declaredBlueprint;
        sections = sections == null ? List.of() : List.copyOf(sections);
    }

    /** @param operatorEnabled legacy {@code sections.is_runnable}: FALSE disables, NULL/TRUE never grant anything */
    public record SectionNode(UUID id, UUID formId, SkillType skill, int ordinal, int durationSeconds,
                              Boolean operatorEnabled, String operatorFormHealth, List<PartNode> parts) {
        public SectionNode {
            parts = parts == null ? List.of() : List.copyOf(parts);
        }

        public List<ItemNode> items() {
            List<ItemNode> out = new ArrayList<>();
            for (PartNode p : parts) for (GroupNode g : p.groups()) out.addAll(g.items());
            return out;
        }
    }

    public record PartNode(UUID id, String partCode, int ordinal, List<GroupNode> groups) {
        public PartNode {
            groups = groups == null ? List.of() : List.copyOf(groups);
        }

        public int itemCount() {
            return groups.stream().mapToInt(g -> g.items().size()).sum();
        }
    }

    public record GroupNode(UUID groupId, UUID placementId, int ordinal, List<StimulusNode> stimuli, List<ItemNode> items,
                            String displayNumbering) {
        public GroupNode(UUID groupId, UUID placementId, int ordinal, List<StimulusNode> stimuli, List<ItemNode> items) {
            this(groupId, placementId, ordinal, stimuli, items, null);
        }
        public GroupNode {
            stimuli = stimuli == null ? List.of() : List.copyOf(stimuli);
            items = items == null ? List.of() : List.copyOf(items);
        }
    }

    public record StimulusNode(UUID id, String kind, boolean hasPayload, List<AssetNode> assets) {
        public StimulusNode {
            assets = assets == null ? List.of() : List.copyOf(assets);
        }

        public String normalizedKind() {
            return kind == null ? "" : kind.trim().toUpperCase(Locale.ROOT);
        }
    }

    public record AssetNode(UUID id, String mimeType, String validationState) {
        public boolean isAudio() {
            return mimeType != null && mimeType.toLowerCase(Locale.ROOT).startsWith("audio/");
        }

        public boolean isValidated() {
            return "VALIDATED".equalsIgnoreCase(validationState);
        }
    }

    /** @param answerSpecCount number of answer_specs rows bound to the item (exactly one is valid) */
    public record ItemNode(UUID id, String logicalKey, Integer ordinal, String prompt, String interactionType,
                           String optionDefinitionsJson, AnswerNode answer, int answerSpecCount) {}

    public record AnswerNode(UUID id, String acceptedAnswersJson, int cardinality, Integer wordLimit, UUID rubricId) {}

    // ─── Deterministic content fingerprint ─────────────────────────────────────────────────

    /**
     * SHA-256 over every field the validator reads, walked in a canonical order. Any content, binding, media
     * validation-state or operator-flag change yields a new fingerprint, which invalidates stale validation.
     */
    public String fingerprint() {
        StringBuilder sb = new StringBuilder(4096);
        line(sb, "FORM", formId, family, variant, scope, operatorHealth, scoringSchemePresent, new TreeMap<>(declaredBlueprint));
        List<SectionNode> secs = new ArrayList<>(sections);
        secs.sort(Comparator.comparing((SectionNode s) -> String.valueOf(s.formId())).thenComparingInt(SectionNode::ordinal)
                .thenComparing(s -> String.valueOf(s.id())));
        for (SectionNode s : secs) {
            line(sb, "S", s.id(), s.formId(), s.skill(), s.ordinal(), s.durationSeconds(), s.operatorEnabled(), s.operatorFormHealth());
            List<PartNode> parts = new ArrayList<>(s.parts());
            parts.sort(Comparator.comparingInt(PartNode::ordinal).thenComparing(p -> String.valueOf(p.id())));
            for (PartNode p : parts) {
                line(sb, "P", p.id(), p.partCode(), p.ordinal());
                List<GroupNode> groups = new ArrayList<>(p.groups());
                groups.sort(Comparator.comparingInt(GroupNode::ordinal).thenComparing(g -> String.valueOf(g.placementId())));
                for (GroupNode g : groups) {
                    line(sb, "G", g.groupId(), g.placementId(), g.ordinal(), g.displayNumbering());
                    List<StimulusNode> stimuli = new ArrayList<>(g.stimuli());
                    stimuli.sort(Comparator.comparing(st -> String.valueOf(st.id())));
                    for (StimulusNode st : stimuli) {
                        line(sb, "ST", st.id(), st.kind(), st.hasPayload());
                        List<AssetNode> assets = new ArrayList<>(st.assets());
                        assets.sort(Comparator.comparing(a -> String.valueOf(a.id())));
                        for (AssetNode a : assets) line(sb, "A", a.id(), a.mimeType(), a.validationState());
                    }
                    List<ItemNode> items = new ArrayList<>(g.items());
                    items.sort(Comparator.comparing((ItemNode i) -> i.ordinal() == null ? Integer.MAX_VALUE : i.ordinal())
                            .thenComparing(i -> String.valueOf(i.id())));
                    for (ItemNode i : items) {
                        AnswerNode a = i.answer();
                        line(sb, "I", i.id(), i.logicalKey(), i.ordinal(), i.prompt(), i.interactionType(), i.optionDefinitionsJson(),
                                i.answerSpecCount(), a == null ? null : a.id(), a == null ? null : a.acceptedAnswersJson(),
                                a == null ? null : a.cardinality(), a == null ? null : a.wordLimit(), a == null ? null : a.rubricId());
                    }
                }
            }
        }
        return sha256(sb.toString());
    }

    private static void line(StringBuilder sb, Object... values) {
        for (Object v : values) {
            sb.append(v == null ? "␀" : v.toString()).append('\u001f');
        }
        sb.append('\u001e');
    }

    static String sha256(String text) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));
            StringBuilder out = new StringBuilder(64);
            for (byte b : digest) out.append(String.format(Locale.ROOT, "%02x", b));
            return out.toString();
        } catch (Exception e) {
            throw new IllegalStateException("SHA-256 is unavailable", e);
        }
    }

    // ─── Canonical package → tree ─────────────────────────────────────────────────────────

    /**
     * Projects an import package onto the canonical tree. Operator flags are runtime database state and are
     * therefore absent here (no restriction). Suite packages carry only component placements (no sections).
     */
    public static ExamContentTree fromPackage(ExamContentPackage pkg, ObjectMapper mapper) {
        if (pkg == null || pkg.form() == null) {
            throw new IllegalArgumentException("PACKAGE_FORM_REQUIRED");
        }
        ObjectMapper json = mapper != null ? mapper : new ObjectMapper().findAndRegisterModules();
        FormVersionRecord form = pkg.form();

        Map<UUID, List<PartRecord>> partsBySection = new HashMap<>();
        for (PartRecord p : pkg.parts()) partsBySection.computeIfAbsent(p.sectionId(), k -> new ArrayList<>()).add(p);
        Map<UUID, List<ExamContentPackage.FormGroupPlacement>> placementsByPart = new HashMap<>();
        for (ExamContentPackage.FormGroupPlacement fg : pkg.formGroups()) {
            placementsByPart.computeIfAbsent(fg.partId(), k -> new ArrayList<>()).add(fg);
        }
        Map<UUID, StimulusVersionRecord> stimuli = new HashMap<>();
        for (StimulusVersionRecord s : pkg.stimuli()) stimuli.put(s.id(), s);
        Map<UUID, AssetRecord> assets = new HashMap<>();
        for (AssetRecord a : pkg.assets()) assets.put(a.id(), a);
        Map<UUID, List<UUID>> assetsByStimulus = new HashMap<>();
        for (ExamContentPackage.StimulusAssetPlacement sa : pkg.stimulusAssets()) {
            assetsByStimulus.computeIfAbsent(sa.stimulusId(), k -> new ArrayList<>()).add(sa.assetId());
        }
        Map<UUID, List<UUID>> stimuliByGroup = new HashMap<>();
        for (ExamContentPackage.GroupStimulusPlacement gs : pkg.groupStimuli()) {
            stimuliByGroup.computeIfAbsent(gs.groupId(), k -> new ArrayList<>()).add(gs.stimulusId());
        }
        Map<UUID, List<ItemVersionRecord>> itemsByGroup = new HashMap<>();
        for (ItemVersionRecord i : pkg.items()) itemsByGroup.computeIfAbsent(i.groupId(), k -> new ArrayList<>()).add(i);
        Map<UUID, List<AnswerSpecRecord>> answersByItem = new HashMap<>();
        for (AnswerSpecRecord a : pkg.answerSpecs()) answersByItem.computeIfAbsent(a.itemId(), k -> new ArrayList<>()).add(a);

        List<SectionNode> sections = new ArrayList<>();
        for (SectionRecord s : pkg.sections()) {
            List<PartNode> parts = new ArrayList<>();
            for (PartRecord p : partsBySection.getOrDefault(s.id(), List.of())) {
                List<GroupNode> groups = new ArrayList<>();
                for (ExamContentPackage.FormGroupPlacement fg : placementsByPart.getOrDefault(p.id(), List.of())) {
                    List<StimulusNode> stimulusNodes = new ArrayList<>();
                    for (UUID sid : stimuliByGroup.getOrDefault(fg.groupId(), List.of())) {
                        StimulusVersionRecord st = stimuli.get(sid);
                        if (st == null) continue;
                        List<AssetNode> assetNodes = new ArrayList<>();
                        for (UUID aid : assetsByStimulus.getOrDefault(sid, List.of())) {
                            AssetRecord a = assets.get(aid);
                            if (a != null) assetNodes.add(new AssetNode(a.id(), a.mimeType(), a.validationState()));
                        }
                        boolean payload = st.bodyPayload() != null && !st.bodyPayload().isEmpty();
                        stimulusNodes.add(new StimulusNode(st.id(), st.kind(), payload, assetNodes));
                    }
                    List<ItemNode> itemNodes = new ArrayList<>();
                    for (ItemVersionRecord i : itemsByGroup.getOrDefault(fg.groupId(), List.of())) {
                        List<AnswerSpecRecord> specs = answersByItem.getOrDefault(i.id(), List.of());
                        AnswerSpecRecord a = specs.isEmpty() ? null : specs.get(0);
                        AnswerNode answer = a == null ? null : new AnswerNode(a.id(), toJson(json, a.acceptedAnswers()),
                                a.cardinality(), a.wordLimit(), a.rubricId());
                        itemNodes.add(new ItemNode(i.id(), i.logicalItemKey(), i.ordinal(), i.prompt(), i.interactionType(),
                                toJson(json, i.optionDefinitions()), answer, specs.size()));
                    }
                    groups.add(new GroupNode(fg.groupId(), fg.id(), fg.ordinal(), stimulusNodes, itemNodes, fg.displayNumbering()));
                }
                parts.add(new PartNode(p.id(), p.partCode(), p.ordinal(), groups));
            }
            sections.add(new SectionNode(s.id(), s.formId(), s.skill(), s.ordinal(), s.durationSeconds(), null, null, parts));
        }

        boolean schemePresent = form.scoringSchemeId() != null
                && pkg.scoringSchemes().stream().anyMatch(sc -> form.scoringSchemeId().equals(sc.id()));
        Map<String, Object> blueprint = pkg.specifications().stream()
                .filter(sp -> sp.id() != null && sp.id().equals(form.specificationId()))
                .map(SpecificationVersionRecord::blueprint).filter(Objects::nonNull).findFirst().orElse(Map.of());
        return new ExamContentTree(form.id(), form.family(), form.variant(), form.scope(), null, schemePresent, blueprint, sections);
    }

    private static String toJson(ObjectMapper mapper, Object value) {
        if (value == null) return null;
        try {
            return mapper.writeValueAsString(value);
        } catch (Exception e) {
            return null;
        }
    }
}
