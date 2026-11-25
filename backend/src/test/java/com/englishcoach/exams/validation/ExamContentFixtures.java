package com.englishcoach.exams.validation;

import com.englishcoach.exams.model.ExamTypes.ExamFamily;
import com.englishcoach.exams.model.ExamTypes.SkillType;
import com.englishcoach.exams.validation.ExamContentTree.*;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.time.Instant;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;

/**
 * Deterministic canonical-tree fixtures shaped like the PUBLIC formats of TOEIC L&R (2016+ and pre-2016) and IELTS.
 * Item text is synthetic ("Synthetic question n") — no real exam content.
 */
public final class ExamContentFixtures {

    public static final ObjectMapper MAPPER = new ObjectMapper();
    public static final Instant NOW = Instant.parse("2026-10-03T00:00:00Z");

    static final String REAL_OPTIONS_4 = "{\"options\":[{\"id\":\"A\",\"label\":\"Synthetic option one.\"},"
            + "{\"id\":\"B\",\"label\":\"Synthetic option two.\"},{\"id\":\"C\",\"label\":\"Synthetic option three.\"},"
            + "{\"id\":\"D\",\"label\":\"Synthetic option four.\"}]}";
    static final String LETTER_OPTIONS_4 = "{\"options\":[{\"id\":\"A\",\"text\":\"A\"},{\"id\":\"B\",\"text\":\"B\"},"
            + "{\"id\":\"C\",\"text\":\"C\"},{\"id\":\"D\",\"text\":\"D\"}]}";
    static final String LETTER_OPTIONS_3 = "{\"options\":[\"A\",\"B\",\"C\"]}";

    private ExamContentFixtures() {}

    // ─── primitives ─────────────────────────────────────────────────────────────────────────

    private static final AtomicInteger SEQ = new AtomicInteger();

    static UUID id() {
        return UUID.randomUUID();
    }

    public static String key(String value) {
        return "{\"values\":[\"" + value + "\"]}";
    }

    static ItemNode item(int ordinal, String prompt, String interaction, String options, String keyJson) {
        int n = SEQ.incrementAndGet();
        AnswerNode answer = keyJson == null ? null : new AnswerNode(id(), keyJson, 1, null, null);
        return new ItemNode(id(), "FX_ITEM_" + n, ordinal, prompt, interaction, options, answer, answer == null ? 0 : 1);
    }

    static StimulusNode audio(boolean validated) {
        return new StimulusNode(id(), "AUDIO", true, List.of(new AssetNode(id(), "audio/mpeg", validated ? "VALIDATED" : "PENDING")));
    }

    static StimulusNode text() {
        return new StimulusNode(id(), "TEXT", true, List.of());
    }

    static StimulusNode image() {
        return new StimulusNode(id(), "IMAGE", true, List.of(new AssetNode(id(), "image/png", "VALIDATED")));
    }

    static StimulusNode chart() {
        return new StimulusNode(id(), "CHART", true, List.of());
    }

    static GroupNode group(int ordinal, List<StimulusNode> stimuli, List<ItemNode> items) {
        return new GroupNode(id(), id(), ordinal, stimuli, items);
    }

    static PartNode part(String code, int ordinal, List<GroupNode> groups) {
        return new PartNode(id(), code, ordinal, groups);
    }

    static SectionNode section(UUID formId, SkillType skill, int ordinal, int duration, List<PartNode> parts) {
        return new SectionNode(id(), formId, skill, ordinal, duration, true, null, parts);
    }

    public static ExamContentTree tree(UUID formId, ExamFamily family, String variant, String scope, List<SectionNode> sections) {
        return new ExamContentTree(formId, family, variant, scope, null, true, Map.of(), sections);
    }

    public static ExamFormValidationReport validate(ExamContentTree tree) {
        return ExamFormValidator.validate(tree, MAPPER, NOW);
    }

    // ─── TOEIC L&R ──────────────────────────────────────────────────────────────────────────

    /** Knobs to break one aspect of an otherwise valid TOEIC L&R 2016 form. */
    public static final class ToeicKnobs {
        public boolean listeningAudio = true;
        public boolean audioValidated = true;
        public boolean part4Audio = true;
        public boolean part1Images = true;
        public boolean flattenPart3 = false;
        public boolean part6Passages = true;
        public boolean part7Passages = true;
        public boolean includeReading = true;
        public boolean placeholderPrompts = false;
        public boolean letterOnlyOptions = false;
        /** Key for every Part 3–7 item: e.g. "C", "" (empty) or "minutes" (debris). */
        public String readingKey = "D";
        public String listeningKey = "C";
        public boolean legacyFormat = false;
    }

    public static ExamContentTree toeicLr(Consumer<ToeicKnobs> configure) {
        ToeicKnobs k = new ToeicKnobs();
        if (configure != null) configure.accept(k);
        UUID formId = id();
        List<SectionNode> sections = new ArrayList<>();
        sections.add(section(formId, SkillType.LISTENING, 1, 2700, toeicListeningParts(k)));
        if (k.includeReading) sections.add(section(formId, SkillType.READING, 2, 4500, toeicReadingParts(k)));
        return tree(formId, ExamFamily.TOEIC, "LR", "FULL", sections);
    }

    private static List<StimulusNode> listeningStimuli(ToeicKnobs k, boolean audioForPart, StimulusNode... extra) {
        List<StimulusNode> out = new ArrayList<>(Arrays.asList(extra));
        if (k.listeningAudio && audioForPart) out.add(audio(k.audioValidated));
        return out;
    }

    private static String prompt(ToeicKnobs k, int n) {
        return k.placeholderPrompts
                ? "Question " + n + ": Mark your answer on your answer sheet (A, B, C, or D)."
                : "Synthetic question " + n + "?";
    }

    private static List<PartNode> toeicListeningParts(ToeicKnobs k) {
        int p1 = k.legacyFormat ? 10 : 6;
        int p2 = k.legacyFormat ? 30 : 25;
        int p3Sets = k.legacyFormat ? 10 : 13;
        List<PartNode> parts = new ArrayList<>();
        List<GroupNode> g1 = new ArrayList<>();
        for (int i = 0; i < p1; i++) {
            g1.add(group(i, k.part1Images ? listeningStimuli(k, true, image()) : listeningStimuli(k, true),
                    List.of(item(1, "Look at the picture.", "single_choice", LETTER_OPTIONS_4, key("A")))));
        }
        parts.add(part("PART_1", 1, g1));
        List<GroupNode> g2 = new ArrayList<>();
        for (int i = 0; i < p2; i++) {
            g2.add(group(i, listeningStimuli(k, true),
                    List.of(item(1, "Mark your answer on your answer sheet.", "single_choice", LETTER_OPTIONS_3, key("B")))));
        }
        parts.add(part("PART_2", 2, g2));
        String options = k.letterOnlyOptions ? LETTER_OPTIONS_4 : REAL_OPTIONS_4;
        if (k.flattenPart3) {
            List<ItemNode> flat = new ArrayList<>();
            for (int i = 0; i < p3Sets * 3; i++) flat.add(item(i + 1, prompt(k, 32 + i), "single_choice", options, key(k.listeningKey)));
            parts.add(part("PART_3", 3, List.of(group(0, listeningStimuli(k, true), flat))));
        } else {
            parts.add(part("PART_3", 3, sets(p3Sets, 3, () -> listeningStimuli(k, true), k, options, k.listeningKey)));
        }
        parts.add(part("PART_4", 4, sets(10, 3, () -> listeningStimuli(k, k.part4Audio), k, options, k.listeningKey)));
        return parts;
    }

    private static List<PartNode> toeicReadingParts(ToeicKnobs k) {
        String options = k.letterOnlyOptions ? LETTER_OPTIONS_4 : REAL_OPTIONS_4;
        List<PartNode> parts = new ArrayList<>();
        int p5 = k.legacyFormat ? 40 : 30;
        List<ItemNode> p5Items = new ArrayList<>();
        for (int i = 0; i < p5; i++) p5Items.add(item(i + 1, prompt(k, 101 + i), "single_choice", options, key(k.readingKey)));
        // Part 5 standalone sentences may share one placement: no passage, no set relationship.
        parts.add(part("PART_5", 5, List.of(group(0, List.of(), p5Items))));
        int p6Size = k.legacyFormat ? 3 : 4;
        parts.add(part("PART_6", 6, sets(4, p6Size, () -> k.part6Passages ? List.of(text()) : List.of(), k, options, k.readingKey)));
        List<GroupNode> p7 = new ArrayList<>();
        int[] singles = k.legacyFormat ? new int[]{2, 2, 2, 3, 3, 3, 3, 4, 3, 3} : new int[]{3, 3, 2, 3, 3, 3, 4, 4, 4};
        int multi = k.legacyFormat ? 4 : 5;
        int ord = 0;
        for (int size : singles) {
            p7.add(group(ord++, k.part7Passages ? List.of(text()) : List.of(), items(size, k, options, k.readingKey)));
        }
        for (int m = 0; m < multi; m++) {
            List<StimulusNode> docs = !k.part7Passages ? List.of() : m < 2 ? List.of(text(), text()) : List.of(text(), text(), text());
            p7.add(group(ord++, docs, items(5, k, options, k.readingKey)));
        }
        parts.add(part("PART_7", 7, p7));
        return parts;
    }

    private static List<GroupNode> sets(int count, int size, java.util.function.Supplier<List<StimulusNode>> stimuli, ToeicKnobs k,
                                        String options, String keyValue) {
        List<GroupNode> out = new ArrayList<>();
        for (int i = 0; i < count; i++) out.add(group(i, stimuli.get(), items(size, k, options, keyValue)));
        return out;
    }

    private static List<ItemNode> items(int size, ToeicKnobs k, String options, String keyValue) {
        List<ItemNode> out = new ArrayList<>();
        for (int i = 0; i < size; i++) out.add(item(i + 1, prompt(k, SEQ.get()), "single_choice", options, key(keyValue)));
        return out;
    }

    // ─── IELTS ──────────────────────────────────────────────────────────────────────────────

    public static SectionNode ieltsListening(UUID formId, boolean audio) {
        List<PartNode> parts = new ArrayList<>();
        for (int p = 1; p <= 4; p++) {
            List<ItemNode> items = new ArrayList<>();
            for (int i = 1; i <= 10; i++) items.add(item(i, "Synthetic note completion " + i, "short_answer", "{\"options\":[]}", key("word" + i)));
            parts.add(part("LISTENING_PART_" + p, p, List.of(group(0, audio ? List.of(audio(true)) : List.of(), items))));
        }
        return section(formId, SkillType.LISTENING, 1, 1800, parts);
    }

    public static SectionNode ieltsReading(UUID formId, boolean passages) {
        String choice = "{\"options\":[{\"id\":\"A\",\"text\":\"Synthetic A\"},{\"id\":\"B\",\"text\":\"Synthetic B\"},"
                + "{\"id\":\"C\",\"text\":\"Synthetic C\"}]}";
        String tfng = "{\"options\":[{\"id\":\"TRUE\",\"text\":\"TRUE\"},{\"id\":\"FALSE\",\"text\":\"FALSE\"},{\"id\":\"NG\",\"text\":\"NOT GIVEN\"}]}";
        List<GroupNode> groups = new ArrayList<>();
        int[] sizes = {13, 13, 14};
        for (int g = 0; g < 3; g++) {
            List<ItemNode> items = new ArrayList<>();
            for (int i = 1; i <= sizes[g]; i++) {
                items.add(i % 2 == 0
                        ? item(i, "Synthetic statement " + i, "truth_classification", tfng, key("NOT GIVEN"))
                        : item(i, "Synthetic question " + i, "single_choice", choice, key("A")));
            }
            groups.add(group(g, passages ? List.of(text()) : List.of(), items));
        }
        return section(formId, SkillType.READING, 2, 3600, List.of(part("ACADEMIC_READING", 1, groups)));
    }

    public static SectionNode ieltsWriting(UUID formId, boolean chart, boolean prompts) {
        UUID rubric = id();
        ItemNode t1 = new ItemNode(id(), "FX_W1_" + SEQ.incrementAndGet(), 1, prompts ? "Summarise the synthetic chart." : " ",
                "writing_response", "{\"minimumWords\":150}", new AnswerNode(id(), "{\"policy\":\"productive_response\"}", 1, null, rubric), 1);
        ItemNode t2 = new ItemNode(id(), "FX_W2_" + SEQ.incrementAndGet(), 1, "Discuss a synthetic opinion.",
                "writing_response", "{\"minimumWords\":250}", new AnswerNode(id(), "{\"policy\":\"productive_response\"}", 1, null, rubric), 1);
        return section(formId, SkillType.WRITING, 3, 3600, List.of(part("ACADEMIC_WRITING", 1, List.of(
                group(0, chart ? List.of(chart()) : List.of(), List.of(t1)),
                group(1, List.of(text()), List.of(t2))))));
    }

    public static SectionNode ieltsSpeaking(UUID formId) {
        return section(formId, SkillType.SPEAKING, 4, 840, List.of());
    }

    public static ExamContentTree ieltsFull(boolean listeningAudio, boolean readingPassages) {
        UUID formId = id();
        return tree(formId, ExamFamily.IELTS, "ACADEMIC", "FULL", List.of(
                ieltsListening(formId, listeningAudio), ieltsReading(formId, readingPassages),
                ieltsWriting(formId, true, true), ieltsSpeaking(formId)));
    }

    // ─── reports for mocked services ────────────────────────────────────────────────────────

    /** A VALID, full-simulation report with every listed skill simulation-ready. */
    public static ExamFormValidationReport validReport(UUID formId, SkillType... skills) {
        Set<SkillType> all = skills.length == 0 ? EnumSet.allOf(SkillType.class) : EnumSet.copyOf(Arrays.asList(skills));
        return new ExamFormValidationReport(formId, ExamFormValidator.VALIDATOR_VERSION, "f".repeat(64), NOW, null, "FULL", "TEST",
                ExamContentValidationStatus.VALID, true, all, all, all, List.of(), List.of());
    }

    /** NEEDS_REVIEW report: practice skills and simulation-grade skills as given; never full. */
    public static ExamFormValidationReport partialReport(UUID formId, Set<SkillType> practice, Set<SkillType> simulation) {
        return new ExamFormValidationReport(formId, ExamFormValidator.VALIDATOR_VERSION, "e".repeat(64), NOW, null, "FULL", "TEST",
                practice.isEmpty() ? ExamContentValidationStatus.INVALID : ExamContentValidationStatus.NEEDS_REVIEW, false,
                EnumSet.allOf(SkillType.class), practice, simulation, List.of(), List.of());
    }
}
