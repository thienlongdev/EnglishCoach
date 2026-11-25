package com.englishcoach.exams.validation;

import com.englishcoach.exams.model.ExamTypes.ExamFamily;
import com.englishcoach.exams.model.ExamTypes.SkillType;
import com.englishcoach.exams.validation.ExamBlueprints.ToeicFormat;
import com.englishcoach.exams.validation.ExamBlueprints.ToeicPartSpec;
import com.englishcoach.exams.validation.ExamContentTree.*;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.time.Instant;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static com.englishcoach.exams.validation.ExamValidationCode.*;
import static com.englishcoach.exams.validation.ExamValidationSeverity.*;

/**
 * The single authoritative, pure and deterministic exam content validator (Exams Recovery Phase 2).
 * Input: a canonical {@link ExamContentTree}. Output: an {@link ExamFormValidationReport} with structured
 * diagnostics and mode eligibility. No I/O, no clock other than the supplied instant.
 *
 * <p>It absorbs every Phase 0 containment rule (placeholder prompts/options, missing or invalid keys, flattened
 * TOEIC sets, missing passages, missing validated listening audio, empty sections) and adds family blueprints,
 * relationship checks, option/key compatibility and operator restrictions. Speaking prompts of IELTS come from
 * {@code ExamSpeakingTurnGenerator}, so IELTS Speaking sections are not content-checked (same as Phase 0).
 */
public final class ExamFormValidator {

    /** Bump whenever a rule changes: persisted results of another version are never reused. */
    // v2.1 preserves all rules; audit representation adds fingerprint-bound compact catalog summaries.
    public static final String VALIDATOR_VERSION = "exam-content-v2.1";

    private ExamFormValidator() {}

    /** Prompts emitted by placeholder generators (scripts/extract_and_package_real_corpus.py et al.). */
    private static final List<Pattern> PLACEHOLDER_PROMPTS = List.of(
            Pattern.compile("mark your answer on your answer sheet \\(a, b, c,? or d\\)", Pattern.CASE_INSENSITIVE),
            Pattern.compile("choose the one word or phrase that best completes the sentence or passage", Pattern.CASE_INSENSITIVE),
            Pattern.compile("according to the speaker, what is key regarding", Pattern.CASE_INSENSITIVE),
            Pattern.compile("^question \\d+: do the statements agree with the information given in passage \\d+\\??$", Pattern.CASE_INSENSITIVE)
    );
    /** "Mark your answer on (your|the) answer sheet." is the real printed text of TOEIC Parts 1–2 only. */
    private static final Pattern MARK_YOUR_ANSWER = Pattern.compile("mark your answer on (your|the) answer sheet", Pattern.CASE_INSENSITIVE);
    private static final Pattern TOEIC_KEY_A_D = Pattern.compile("^[A-D]$");
    private static final Pattern TOEIC_KEY_A_C = Pattern.compile("^[A-C]$");
    private static final Pattern LETTER_ONLY = Pattern.compile("^\\(?[A-Da-d]\\)?\\.?$");
    private static final Pattern PART_NUMBER = Pattern.compile("(\\d+)\\D*$");
    private static final List<String> KEY_LIST_FIELDS = List.of("accepted", "exact", "alternatives", "choices", "values", "variants", "items");
    private static final List<String> OPTION_ID_FIELDS = List.of("id", "key", "code", "letter");
    private static final List<String> OPTION_TEXT_FIELDS = List.of("text", "label", "content", "value", "body");
    private static final String MATCHING_TOKEN = "matching:";

    /** Interaction types the renderer registry supports (mirrors ExamContentPackageValidator). */
    static final Set<String> SUPPORTED_INTERACTIONS = Set.of(
            "SINGLE_CHOICE", "MULTIPLE_CHOICE", "MULTIPLE_CHOICE_MULTI", "TEXT_GAP", "SHORT_ANSWER", "TRUTH_CLASSIFICATION", "MATCHING",
            "HEADING_MATCHING", "LABEL_ASSIGNMENT", "SENTENCE_INSERTION", "WRITING_RESPONSE", "SPEAKING_RESPONSE");
    /** Objective interactions whose learner choices come from option definitions. */
    static final Set<String> OPTION_INTERACTIONS = Set.of(
            "SINGLE_CHOICE", "MULTIPLE_CHOICE", "MULTIPLE_CHOICE_MULTI", "TRUTH_CLASSIFICATION", "MATCHING", "HEADING_MATCHING");
    static final Set<String> PRODUCTIVE_INTERACTIONS = Set.of("WRITING_RESPONSE", "SPEAKING_RESPONSE");

    // ─── Entry point ─────────────────────────────────────────────────────────────────────────

    public static ExamFormValidationReport validate(ExamContentTree tree, ObjectMapper mapper, Instant now) {
        return validate(tree, mapper, now, tree.fingerprint());
    }

    /** Internal measured path; the caller computes the same canonical fingerprint exactly once. */
    static ExamFormValidationReport validate(ExamContentTree tree, ObjectMapper mapper, Instant now, String fingerprint) {
        ObjectMapper json = mapper != null ? mapper : new ObjectMapper();
        Instant at = now != null ? now : Instant.now();

        Findings formFindings = new Findings();
        Set<SkillType> expected = ExamBlueprints.expectedSkills(tree.family(), tree.variant(), tree.scope());
        Set<SkillType> present = EnumSet.noneOf(SkillType.class);
        tree.sections().forEach(s -> present.add(s.skill()));

        if (tree.sections().isEmpty()) {
            formFindings.add(NO_SECTIONS, null, null, null, null, null, null);
        }
        if (expected.isEmpty()) {
            formFindings.add(FORM_SCOPE_UNKNOWN, null, null, null, null, null,
                    "variant=" + ExamBlueprints.norm(tree.variant()) + " scope=" + ExamBlueprints.norm(tree.scope()));
        } else {
            Set<SkillType> missing = EnumSet.copyOf(expected);
            missing.removeAll(present);
            if (!missing.isEmpty()) {
                formFindings.add(FORM_SKILL_MISSING, null, null, null, null, null, "missing=" + ExamFormValidationReport.skillNames(missing));
            }
        }
        if (!tree.scoringSchemePresent()) {
            formFindings.add(SCORING_SCHEME_MISSING, null, null, null, null, null, null);
        }

        ToeicFormat toeicFormat = tree.family() == ExamFamily.TOEIC ? ExamBlueprints.toeicFormat(tree.declaredBlueprint(), toeicItemsByPart(tree)) : null;
        Set<UUID> seenItemIds = new HashSet<>();
        Set<String> seenItemKeys = new HashSet<>();
        List<ExamFormValidationReport.SectionValidation> sections = new ArrayList<>();
        for (SectionNode s : tree.sections()) {
            sections.add(validateSection(tree, s, toeicFormat, json, seenItemIds, seenItemKeys));
        }

        List<ExamValidationDiagnostic> formDiagnostics = formFindings.list();
        boolean formBlocking = formDiagnostics.stream().anyMatch(d -> d.severity() == BLOCKING);
        boolean formStandard = formDiagnostics.stream().anyMatch(d -> d.severity() == BLOCKING || d.severity() == STANDARD);

        Set<SkillType> practice = EnumSet.noneOf(SkillType.class);
        Set<SkillType> simulation = EnumSet.noneOf(SkillType.class);
        if (!formBlocking) {
            for (SkillType skill : present) {
                List<ExamFormValidationReport.SectionValidation> ofSkill = sections.stream().filter(v -> v.skill() == skill).toList();
                if (ofSkill.stream().allMatch(v -> v.status() != ExamContentValidationStatus.INVALID)) practice.add(skill);
                if (ofSkill.stream().allMatch(v -> v.status() == ExamContentValidationStatus.VALID)) simulation.add(skill);
            }
        }
        boolean full = !sections.isEmpty() && !formStandard && !expected.isEmpty()
                && sections.stream().allMatch(v -> v.status() == ExamContentValidationStatus.VALID)
                && simulation.containsAll(expected);
        ExamContentValidationStatus status = full ? ExamContentValidationStatus.VALID
                : practice.isEmpty() ? ExamContentValidationStatus.INVALID
                : ExamContentValidationStatus.NEEDS_REVIEW;

        return new ExamFormValidationReport(tree.formId(), VALIDATOR_VERSION, fingerprint, at, tree.family(), tree.scope(),
                ExamBlueprints.blueprintId(tree.family(), tree.variant(), tree.scope(), toeicFormat),
                status, full, expected, practice, simulation, sections, formDiagnostics);
    }

    // ─── Section ─────────────────────────────────────────────────────────────────────────────

    private static ExamFormValidationReport.SectionValidation validateSection(ExamContentTree tree, SectionNode s,
                                                                             ToeicFormat toeicFormat, ObjectMapper json,
                                                                             Set<UUID> seenItemIds, Set<String> seenItemKeys) {
        Findings f = new Findings();
        boolean toeic = tree.family() == ExamFamily.TOEIC;
        List<ItemNode> items = s.items();

        // Operator restrictions: legacy columns can only take content away, never grant it.
        applyOperatorHealth(f, s, tree.operatorHealth());
        applyOperatorHealth(f, s, s.operatorFormHealth());
        if (Boolean.FALSE.equals(s.operatorEnabled())) {
            f.add(OPERATOR_SECTION_DISABLED, s, null, null, null, null, "is_runnable=false");
        }

        if (s.durationSeconds() <= 0) {
            f.add(SECTION_TIMING_MISSING, s, null, null, null, null, "durationSeconds=" + s.durationSeconds());
        } else {
            int[] typical = ExamBlueprints.typicalDurationSeconds(tree.family(), s.skill());
            if (typical != null && (s.durationSeconds() < typical[0] || s.durationSeconds() > typical[1])) {
                f.add(SECTION_DURATION_NONSTANDARD, s, null, null, null, null,
                        "expected=" + typical[0] + ".." + typical[1] + " actual=" + s.durationSeconds());
            }
        }

        switch (s.skill()) {
            case SPEAKING -> validateSpeaking(f, tree, s, items);
            case WRITING -> validateWriting(f, tree, s, items, json);
            case LISTENING, READING -> validateObjective(f, tree, s, toeicFormat, json, seenItemIds, seenItemKeys);
        }
        if (toeic && (s.skill() == SkillType.LISTENING || s.skill() == SkillType.READING) && toeicFormat != null) {
            validateToeicBlueprint(f, s, toeicFormat);
        }
        if (!toeic && tree.family() == ExamFamily.IELTS) {
            if (s.skill() == SkillType.LISTENING) validateIeltsListening(f, s);
            if (s.skill() == SkillType.READING) validateIeltsReading(f, tree, s);
        }

        List<ExamValidationDiagnostic> diagnostics = f.list();
        ExamContentValidationStatus status = diagnostics.stream().anyMatch(d -> d.severity() == BLOCKING) ? ExamContentValidationStatus.INVALID
                : diagnostics.stream().anyMatch(d -> d.severity() == STANDARD) ? ExamContentValidationStatus.PRACTICE_ONLY
                : ExamContentValidationStatus.VALID;
        return new ExamFormValidationReport.SectionValidation(s.id(), s.formId(), s.skill(), items.size(), status, diagnostics);
    }

    private static void applyOperatorHealth(Findings f, SectionNode s, String health) {
        String h = ExamBlueprints.norm(health);
        if ("DISABLED".equals(h)) f.add(OPERATOR_FORM_DISABLED, s, null, null, null, null, "primary_health_status=DISABLED");
        else if ("NEEDS_REVIEW".equals(h)) f.add(OPERATOR_REVIEW_REQUIRED, s, null, null, null, null, "primary_health_status=NEEDS_REVIEW");
    }

    // ─── Speaking / Writing ──────────────────────────────────────────────────────────────────

    private static void validateSpeaking(Findings f, ExamContentTree tree, SectionNode s, List<ItemNode> items) {
        if (tree.family() == ExamFamily.IELTS) {
            // Turn prompts are generated at runtime (ExamSpeakingTurnGenerator), not read from form items.
            f.add(SPEAKING_PROMPTS_RUNTIME_GENERATED, s, null, null, null, null, null);
            return;
        }
        if (items.isEmpty()) {
            f.add(NO_ITEMS, s, null, null, null, null, null);
            return;
        }
        for (PartNode p : s.parts()) for (GroupNode g : p.groups()) for (ItemNode i : g.items()) {
            checkProductiveItem(f, s, p, i);
        }
        if (items.size() != ExamBlueprints.TOEIC_SPEAKING_TASKS) {
            f.add(TOEIC_TASK_COUNT, s, null, null, null, null, "expected=" + ExamBlueprints.TOEIC_SPEAKING_TASKS + " actual=" + items.size());
        }
    }

    private static void validateWriting(Findings f, ExamContentTree tree, SectionNode s, List<ItemNode> items, ObjectMapper json) {
        if (items.isEmpty()) {
            f.add(NO_ITEMS, s, null, null, null, null, null);
            return;
        }
        boolean ielts = tree.family() == ExamFamily.IELTS;
        for (PartNode p : s.parts()) for (GroupNode g : p.groups()) for (ItemNode i : g.items()) {
            checkProductiveItem(f, s, p, i);
            if (ielts && minimumWords(i, json) == null) {
                f.add(WORD_LIMIT_MISSING, s, p, null, null, i.id(), null);
            }
        }
        if (ielts) {
            if (items.size() != ExamBlueprints.IELTS_WRITING_TASKS) {
                f.add(IELTS_WRITING_TASK_COUNT, s, null, null, null, null, "expected=2 actual=" + items.size());
            }
            if ("ACADEMIC".equals(ExamBlueprints.norm(tree.variant()))) {
                boolean visual = false;
                for (PartNode p : s.parts()) for (GroupNode g : p.groups()) for (StimulusNode st : g.stimuli()) {
                    if (ExamBlueprints.VISUAL_KINDS.contains(st.normalizedKind())) visual = true;
                    checkVisualMedia(f, s, p, g, st);
                }
                if (!visual) {
                    // Task 1 cannot be standardized without its graphic; Task 2 remains practicable.
                    f.add(IELTS_WRITING_VISUAL_MISSING, s, null, null, null, null, "task=1");
                }
            }
        } else if (tree.family() == ExamFamily.TOEIC && items.size() != ExamBlueprints.TOEIC_WRITING_TASKS) {
            f.add(TOEIC_TASK_COUNT, s, null, null, null, null, "expected=" + ExamBlueprints.TOEIC_WRITING_TASKS + " actual=" + items.size());
        }
    }

    private static void checkProductiveItem(Findings f, SectionNode s, PartNode p, ItemNode i) {
        String prompt = i.prompt() == null ? "" : i.prompt().trim();
        if (prompt.isEmpty()) f.add(PROMPT_MISSING, s, p, null, null, i.id(), null);
        else if (isPlaceholderPrompt(prompt, false, -1)) f.add(PLACEHOLDER_PROMPT_DETECTED, s, p, null, null, i.id(), null);
        String interaction = normalize(i.interactionType());
        if (!PRODUCTIVE_INTERACTIONS.contains(interaction)) {
            f.add(INTERACTION_TYPE_UNSUPPORTED, s, p, null, null, i.id(), "productive section item=" + interaction);
        }
        if (i.answerSpecCount() > 1) f.add(ANSWER_SPEC_DUPLICATE, s, p, null, null, i.id(), null);
        if (i.answer() == null || i.answer().rubricId() == null) f.add(PRODUCTIVE_RUBRIC_MISSING, s, p, null, null, i.id(), null);
    }

    // ─── Objective sections (Listening / Reading) ────────────────────────────────────────────

    private static void validateObjective(Findings f, ExamContentTree tree, SectionNode s, ToeicFormat toeicFormat,
                                          ObjectMapper json, Set<UUID> seenItemIds, Set<String> seenItemKeys) {
        boolean toeic = tree.family() == ExamFamily.TOEIC;
        if (s.items().isEmpty()) {
            f.add(NO_ITEMS, s, null, null, null, null, null);
        }
        int sectionValidatedAudio = 0;
        Map<PartNode, Integer> partAudio = new LinkedHashMap<>();
        for (PartNode p : s.parts()) {
            int part = partNumber(p.partCode());
            if (toeic) {
                if (part < 1 || part > 7) {
                    f.add(PART_CODE_UNKNOWN, s, p, null, null, null, null);
                } else if ((part <= 4) != (s.skill() == SkillType.LISTENING)) {
                    f.add(PART_SKILL_MISMATCH, s, p, part, null, null, null);
                }
            }
            ToeicPartSpec spec = toeic && toeicFormat != null ? toeicFormat.part(part) : null;
            int validatedAudio = 0;
            for (GroupNode g : p.groups()) {
                for (StimulusNode st : g.stimuli()) {
                    boolean audioStimulus = "AUDIO".equals(st.normalizedKind()) || st.assets().stream().anyMatch(AssetNode::isAudio);
                    if (audioStimulus) {
                        long validated = st.assets().stream().filter(a -> a.isAudio() && a.isValidated()).count();
                        validatedAudio += (int) validated;
                        if (validated == 0 && !st.assets().isEmpty()) {
                            f.add(UNVALIDATED_MEDIA, s, p, toeic ? part : null, null, null, "audio");
                        }
                    } else {
                        checkVisualMedia(f, s, p, g, st);
                    }
                }
                Set<Integer> ordinals = new HashSet<>();
                for (ItemNode i : g.items()) {
                    if (i.ordinal() != null && !ordinals.add(i.ordinal())) {
                        f.add(ITEM_ORDER_INVALID, s, p, toeic ? part : null, null, i.id(), "duplicate-ordinal");
                    } else if (i.ordinal() == null && g.items().size() > 1) {
                        f.addWithSeverity(ITEM_ORDER_INVALID, WARNING, s, p, toeic ? part : null, null, i.id(), "missing-ordinal");
                    }
                    validateObjectiveItem(f, s, p, toeic, part, spec, i, json, seenItemIds, seenItemKeys);
                }
            }
            sectionValidatedAudio += validatedAudio;
            partAudio.put(p, validatedAudio);
        }
        if (s.skill() == SkillType.LISTENING) {
            if (sectionValidatedAudio == 0) {
                f.add(REQUIRED_AUDIO_MISSING, s, null, null, null, null, null);
            } else {
                for (Map.Entry<PartNode, Integer> e : partAudio.entrySet()) {
                    if (e.getValue() > 0 || e.getKey().itemCount() == 0) continue;
                    if (toeic) f.add(TOEIC_PART_AUDIO_MISSING, s, e.getKey(), partNumber(e.getKey().partCode()), null, null, null);
                    else f.add(IELTS_LISTENING_PART_AUDIO_MISSING, s, e.getKey(), null, null, null, null);
                }
            }
        }
    }

    private static void validateObjectiveItem(Findings f, SectionNode s, PartNode p, boolean toeic, int part, ToeicPartSpec spec,
                                              ItemNode i, ObjectMapper json, Set<UUID> seenItemIds, Set<String> seenItemKeys) {
        Integer partTag = toeic ? part : null;
        if (i.id() != null && !seenItemIds.add(i.id())) f.add(DUPLICATE_ITEM_ID, s, p, partTag, null, i.id(), null);
        if (i.logicalKey() != null && !i.logicalKey().isBlank() && !seenItemKeys.add(i.logicalKey())) {
            f.add(DUPLICATE_ITEM_KEY, s, p, partTag, null, i.id(), null);
        }

        String interaction = normalize(i.interactionType());
        if (!SUPPORTED_INTERACTIONS.contains(interaction) || PRODUCTIVE_INTERACTIONS.contains(interaction)) {
            f.add(INTERACTION_TYPE_UNSUPPORTED, s, p, partTag, null, i.id(), interaction.isEmpty() ? "blank" : interaction);
        }
        if (i.answerSpecCount() > 1) f.add(ANSWER_SPEC_DUPLICATE, s, p, partTag, null, i.id(), null);

        List<String> keys = i.answer() == null ? List.of() : acceptedKeys(i.answer().acceptedAnswersJson(), json);
        if (i.answer() == null) {
            f.add(ANSWER_KEY_MISSING, s, p, partTag, null, i.id(), null);
        } else if (keys.isEmpty()) {
            f.add(ANSWER_KEY_EMPTY, s, p, partTag, null, i.id(), null);
        } else if (toeic) {
            Pattern allowed = part == 2 ? TOEIC_KEY_A_C : TOEIC_KEY_A_D;
            if (keys.size() != 1 || !allowed.matcher(keys.get(0).trim().toUpperCase(Locale.ROOT)).matches()) {
                f.add(INVALID_TOEIC_ANSWER_KEY, s, p, partTag, null, i.id(), part == 2 ? "allowed=A-C" : "allowed=A-D");
            }
        }

        String prompt = i.prompt() == null ? "" : i.prompt().trim();
        boolean audioOnlyPrompt = toeic && (part == 1 || part == 2);
        if (prompt.isEmpty()) {
            if (!audioOnlyPrompt) f.add(PROMPT_MISSING, s, p, partTag, null, i.id(), null);
        } else if (isPlaceholderPrompt(prompt, toeic, part)) {
            f.add(PLACEHOLDER_PROMPT_DETECTED, s, p, partTag, null, i.id(), null);
        }

        boolean optionsRequired = toeic ? part >= 3 && part <= 7 : OPTION_INTERACTIONS.contains(interaction);
        List<String[]> options = optionEntries(i.optionDefinitionsJson(), json);
        if (options.isEmpty() && !optionsRequired) return;
        if (options.size() < 2) {
            f.add(OPTIONS_MISSING, s, p, partTag, null, i.id(), "count=" + options.size());
            return;
        }
        Set<String> ids = new HashSet<>();
        Set<String> texts = new HashSet<>();
        boolean blankId = false;
        boolean duplicateId = false;
        for (String[] o : options) {
            String id = o[0] == null ? "" : o[0].trim().toUpperCase(Locale.ROOT);
            if (id.isEmpty()) blankId = true;
            else if (!ids.add(id)) duplicateId = true;
            if (o[1] != null && !o[1].isBlank()) texts.add(o[1].trim().toUpperCase(Locale.ROOT));
        }
        if (blankId) f.add(OPTION_ID_MISSING, s, p, partTag, null, i.id(), null);
        if (duplicateId) f.add(DUPLICATE_OPTION_ID, s, p, partTag, null, i.id(), null);
        if (toeic && part >= 3 && part <= 7
                && options.stream().allMatch(o -> o[1] == null || o[1].isBlank() || LETTER_ONLY.matcher(o[1].trim()).matches())) {
            f.add(PLACEHOLDER_OPTIONS, s, p, partTag, null, i.id(), null);
        }
        if (toeic && spec != null && options.size() != spec.options()) {
            f.add(TOEIC_OPTION_COUNT, s, p, partTag, null, i.id(), "expected=" + spec.options() + " actual=" + options.size());
        }
        for (String key : keys) {
            if (key.startsWith(MATCHING_TOKEN)) continue;
            String k = key.trim().toUpperCase(Locale.ROOT);
            if (!ids.contains(k) && !texts.contains(k)) {
                f.add(INVALID_OPTION_KEY, s, p, partTag, null, i.id(), null);
                break;
            }
        }
    }

    private static void checkVisualMedia(Findings f, SectionNode s, PartNode p, GroupNode g, StimulusNode st) {
        if (!st.assets().isEmpty() && st.assets().stream().noneMatch(AssetNode::isValidated)) {
            // Visuals may also render from their payload, so an unvalidated image file is reported, not gating.
            f.addWithSeverity(UNVALIDATED_MEDIA, WARNING, s, p, null, null, null, "visual");
        }
    }

    // ─── TOEIC Listening & Reading blueprint ─────────────────────────────────────────────────

    private static void validateToeicBlueprint(Findings f, SectionNode s, ToeicFormat format) {
        Map<Integer, List<PartNode>> partsByNumber = new TreeMap<>();
        for (PartNode p : s.parts()) partsByNumber.computeIfAbsent(partNumber(p.partCode()), k -> new ArrayList<>()).add(p);
        for (ToeicPartSpec spec : format.partsOf(s.skill())) {
            List<PartNode> parts = partsByNumber.getOrDefault(spec.part(), List.of());
            int items = parts.stream().mapToInt(PartNode::itemCount).sum();
            if (parts.isEmpty() || items == 0) {
                f.add(TOEIC_PART_MISSING, s, parts.isEmpty() ? null : parts.get(0), spec.part(), null, null, "expected=" + spec.items());
                continue;
            }
            PartNode first = parts.get(0);
            if (items != spec.items()) {
                f.add(TOEIC_PART_ITEM_COUNT, s, first, spec.part(), null, null, "expected=" + spec.items() + " actual=" + items);
            }
            int nonEmptyGroups = 0;
            int fiveItemSets = 0;
            for (PartNode p : parts) {
                for (GroupNode g : p.groups()) {
                    int size = g.items().size();
                    if (size == 0) continue;
                    nonEmptyGroups++;
                    if (size == 5) fiveItemSets++;
                    if (spec.maxGroupSize() != null && size > spec.maxGroupSize()) {
                        // A Part flattened into one giant group (e.g. 39 Part 3 items) cannot be delivered as sets.
                        f.add(TOEIC_GROUP_SIZE, s, p, spec.part(), g.groupId(), null, "max=" + spec.maxGroupSize() + " actual=" + size);
                    } else if (spec.minGroupSize() != null && size < spec.minGroupSize()) {
                        f.addWithSeverity(TOEIC_GROUP_SIZE, STANDARD, s, p, spec.part(), g.groupId(), null,
                                "min=" + spec.minGroupSize() + " actual=" + size);
                    }
                    long passages = g.stimuli().stream().filter(st -> ExamBlueprints.PASSAGE_KINDS.contains(st.normalizedKind())).count();
                    boolean multiDoc = g.stimuli().stream().anyMatch(st -> "MULTI_DOC".equals(st.normalizedKind()));
                    if (spec.passageRequired() && passages == 0) {
                        f.add(TOEIC_PASSAGE_MISSING, s, p, spec.part(), g.groupId(), null, null);
                    }
                    if (spec.fiveItemSets() != null && size == 5 && passages > 0 && passages < 2 && !multiDoc) {
                        f.add(TOEIC_MULTI_PASSAGE_MISSING, s, p, spec.part(), g.groupId(), null, "documents=" + passages);
                    }
                    if (spec.imageRequired() && g.stimuli().stream().noneMatch(st ->
                            ExamBlueprints.VISUAL_KINDS.contains(st.normalizedKind()))) {
                        f.add(TOEIC_IMAGE_MISSING, s, p, spec.part(), g.groupId(), null, null);
                    }
                }
            }
            if (spec.exactGroups() != null && nonEmptyGroups != spec.exactGroups()) {
                f.add(TOEIC_PART_GROUP_COUNT, s, first, spec.part(), null, null, "expected=" + spec.exactGroups() + " actual=" + nonEmptyGroups);
            }
            if (spec.fiveItemSets() != null && fiveItemSets != spec.fiveItemSets()) {
                f.add(TOEIC_PART_GROUP_COUNT, s, first, spec.part(), null, null,
                        "multiPassageSets expected=" + spec.fiveItemSets() + " actual=" + fiveItemSets);
            }
        }
    }

    private static Map<Integer, Integer> toeicItemsByPart(ExamContentTree tree) {
        Map<Integer, Integer> out = new HashMap<>();
        for (SectionNode s : tree.sections()) {
            if (s.skill() != SkillType.LISTENING && s.skill() != SkillType.READING) continue;
            for (PartNode p : s.parts()) out.merge(partNumber(p.partCode()), p.itemCount(), Integer::sum);
        }
        return out;
    }

    // ─── IELTS blueprint ─────────────────────────────────────────────────────────────────────

    private static void validateIeltsListening(Findings f, SectionNode s) {
        long parts = s.parts().stream().filter(p -> p.itemCount() > 0).count();
        if (parts != ExamBlueprints.IELTS_LISTENING_PARTS) {
            f.add(IELTS_LISTENING_PART_COUNT, s, null, null, null, null, "expected=4 actual=" + parts);
        }
        int items = s.items().size();
        if (items != ExamBlueprints.IELTS_LISTENING_ITEMS) {
            f.add(IELTS_ITEM_COUNT, s, null, null, null, null, "expected=40 actual=" + items);
        }
    }

    private static void validateIeltsReading(Findings f, ExamContentTree tree, SectionNode s) {
        Set<UUID> passages = new HashSet<>();
        for (PartNode p : s.parts()) {
            boolean partHasPassage = p.groups().stream().anyMatch(ExamFormValidator::hasPassage);
            for (GroupNode g : p.groups()) {
                g.stimuli().stream().filter(st -> ExamBlueprints.PASSAGE_KINDS.contains(st.normalizedKind()))
                        .forEach(st -> passages.add(st.id()));
                if (g.items().isEmpty() || hasPassage(g)) continue;
                if (partHasPassage) {
                    // Question group relies on a passage bound to another group of the same part.
                    f.addWithSeverity(IELTS_READING_PASSAGE_MISSING, WARNING, s, p, null, g.groupId(), null, "shared-in-part");
                } else {
                    f.add(IELTS_READING_PASSAGE_MISSING, s, p, null, g.groupId(), null, null);
                }
            }
        }
        boolean academic = "ACADEMIC".equals(ExamBlueprints.norm(tree.variant()));
        if (academic ? passages.size() != ExamBlueprints.IELTS_ACADEMIC_READING_PASSAGES
                : passages.size() < ExamBlueprints.IELTS_ACADEMIC_READING_PASSAGES) {
            f.add(IELTS_READING_PASSAGE_COUNT, s, null, null, null, null,
                    (academic ? "expected=3" : "expectedAtLeast=3") + " actual=" + passages.size());
        }
        int items = s.items().size();
        if (items != ExamBlueprints.IELTS_READING_ITEMS) {
            f.add(IELTS_ITEM_COUNT, s, null, null, null, null, "expected=40 actual=" + items);
        }
    }

    private static boolean hasPassage(GroupNode g) {
        return g.stimuli().stream().anyMatch(st -> ExamBlueprints.PASSAGE_KINDS.contains(st.normalizedKind()));
    }

    // ─── Pure helpers (shared with tests) ────────────────────────────────────────────────────

    static boolean isPlaceholderPrompt(String prompt, boolean toeic, int part) {
        for (Pattern p : PLACEHOLDER_PROMPTS) {
            if (p.matcher(prompt).find()) return true;
        }
        // Outside TOEIC Parts 1–2 a "Mark your answer…" prompt means the real question text was lost.
        return MARK_YOUR_ANSWER.matcher(prompt).find() && !(toeic && (part == 1 || part == 2));
    }

    static int partNumber(String partCode) {
        if (partCode == null) return -1;
        Matcher m = PART_NUMBER.matcher(partCode.trim());
        return m.find() ? Integer.parseInt(m.group(1)) : -1;
    }

    static String normalize(String value) {
        return ExamBlueprints.norm(value);
    }

    /** Mirrors ExamObjectiveScorer: only non-blank values in the list fields or a complete matching map count. */
    static List<String> acceptedKeys(String json, ObjectMapper mapper) {
        List<String> out = new ArrayList<>();
        JsonNode root = parse(json, mapper);
        if (root == null || root.isNull()) return out;
        if (root.isArray()) {
            addTexts(root, out);
            return out;
        }
        if (root.isTextual()) {
            if (!root.asText().isBlank()) out.add(root.asText());
            return out;
        }
        if (!root.isObject()) return out;
        for (String field : KEY_LIST_FIELDS) {
            JsonNode n = root.get(field);
            if (n == null || n.isNull()) continue;
            if (n.isArray()) addTexts(n, out);
            else if (n.isValueNode() && !n.asText().isBlank()) out.add(n.asText());
        }
        JsonNode matching = root.get("matching");
        if (matching != null && matching.isObject() && matching.size() > 0) {
            boolean complete = true;
            for (Iterator<JsonNode> it = matching.elements(); it.hasNext(); ) {
                JsonNode v = it.next();
                if (v == null || v.isNull() || v.asText().isBlank()) complete = false;
            }
            if (complete) out.add(MATCHING_TOKEN + matching.size());
        }
        return out;
    }

    /** Option entries as {id, text}; string options use the string as both. */
    static List<String[]> optionEntries(String json, ObjectMapper mapper) {
        List<String[]> out = new ArrayList<>();
        JsonNode root = parse(json, mapper);
        JsonNode options = root;
        if (root != null && root.isObject()) {
            options = root.has("options") ? root.get("options") : root.get("choices");
        }
        if (options == null || !options.isArray()) return out;
        for (JsonNode o : options) {
            if (o == null || o.isNull()) continue;
            if (o.isValueNode()) {
                out.add(new String[]{o.asText(), o.asText()});
                continue;
            }
            out.add(new String[]{firstText(o, OPTION_ID_FIELDS), firstText(o, OPTION_TEXT_FIELDS)});
        }
        return out;
    }

    /** Minimum words from the answer spec word limit, option definitions or answer policy (IELTS Writing). */
    static Integer minimumWords(ItemNode i, ObjectMapper mapper) {
        if (i.answer() != null && i.answer().wordLimit() != null && i.answer().wordLimit() > 0) return i.answer().wordLimit();
        for (String json : new String[]{i.optionDefinitionsJson(), i.answer() == null ? null : i.answer().acceptedAnswersJson()}) {
            JsonNode root = parse(json, mapper);
            if (root != null && root.isObject()) {
                for (String field : List.of("minimumWords", "minWords", "wordLimit")) {
                    JsonNode n = root.get(field);
                    if (n != null && n.canConvertToInt() && n.asInt() > 0) return n.asInt();
                }
            }
        }
        return null;
    }

    private static String firstText(JsonNode o, List<String> fields) {
        for (String f : fields) {
            JsonNode t = o.get(f);
            if (t != null && t.isValueNode() && !t.asText().isBlank()) return t.asText();
        }
        return "";
    }

    private static JsonNode parse(String json, ObjectMapper mapper) {
        if (json == null || json.isBlank()) return null;
        try {
            return mapper.readTree(json);
        } catch (Exception e) {
            return null;
        }
    }

    private static void addTexts(JsonNode array, List<String> out) {
        for (JsonNode n : array) {
            if (n != null && n.isValueNode() && !n.asText().isBlank()) out.add(n.asText());
        }
    }

    // ─── Aggregating collector ───────────────────────────────────────────────────────────────

    /** Merges identical findings (same code, severity, section, part, group, detail) into one diagnostic. */
    private static final class Findings {
        private final Map<String, ExamValidationDiagnostic> byKey = new LinkedHashMap<>();

        void add(ExamValidationCode code, SectionNode s, PartNode p, Integer partNumber, UUID groupId, UUID itemId, String detail) {
            addWithSeverity(code, code.defaultSeverity(), s, p, partNumber, groupId, itemId, detail);
        }

        void addWithSeverity(ExamValidationCode code, ExamValidationSeverity severity, SectionNode s, PartNode p,
                             Integer partNumber, UUID groupId, UUID itemId, String detail) {
            String key = code + "|" + severity + "|" + (s == null ? "" : s.id()) + "|" + (p == null ? "" : p.id())
                    + "|" + (groupId == null ? "" : groupId) + "|" + (detail == null ? "" : detail);
            ExamValidationDiagnostic prior = byKey.get(key);
            if (prior == null) {
                byKey.put(key, new ExamValidationDiagnostic(code, severity, s == null ? null : s.id(), s == null ? null : s.skill(),
                        p == null ? null : p.partCode(), partNumber, groupId, itemId, 1, detail));
            } else {
                byKey.put(key, new ExamValidationDiagnostic(prior.code(), prior.severity(), prior.sectionId(), prior.skill(),
                        prior.partCode(), prior.partNumber(), prior.groupId(),
                        prior.sampleItemId() != null ? prior.sampleItemId() : itemId, prior.occurrences() + 1, prior.detail()));
            }
        }

        List<ExamValidationDiagnostic> list() {
            return List.copyOf(byKey.values());
        }
    }
}
