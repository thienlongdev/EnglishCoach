package com.englishcoach.exams.practice;

import com.englishcoach.exams.model.ExamTypes.ExamFamily;
import com.englishcoach.exams.model.ExamTypes.SkillType;
import com.englishcoach.exams.validation.ExamContentTree;
import com.englishcoach.exams.validation.ExamContentTree.*;

import java.nio.charset.StandardCharsets;
import java.util.*;

/**
 * Exams Phase 6 — SYNTHETIC canonical trees (no exam text: "synthetic item n", option words alpha/bravo/…) shaped like
 * the public TOEIC L&R 2016 and IELTS Academic formats, so the real, unchanged Phase 2 validator judges them. Flags
 * degrade one property at a time (pending media, missing keys, wrong option count, numbering gap, label assignment).
 */
final class PracticeTreeFixtures {

    private PracticeTreeFixtures() {}

    static UUID id(String name) {
        return UUID.nameUUIDFromBytes(("practice-fixture:" + name).getBytes(StandardCharsets.UTF_8));
    }

    private static final String[] WORDS = {"alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"};

    static String options(int count) {
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < count; i++) {
            if (i > 0) sb.append(',');
            sb.append("{\"id\":\"").append((char) ('A' + i)).append("\",\"text\":\"").append(WORDS[i]).append("\"}");
        }
        return sb.append(']').toString();
    }

    static ItemNode choiceItem(String key, int questionNumber, int optionCount, String keyLetter, boolean keyed, String interaction) {
        String defs = "{\"options\":" + options(optionCount) + ",\"questionNumber\":" + questionNumber
                + ",\"group\":{\"kind\":\"SYNTHETIC\",\"instructions\":[\"synthetic instruction\"]}}";
        AnswerNode answer = new AnswerNode(id(key + ":spec"), keyed ? "{\"values\":[\"" + keyLetter + "\"]}" : "{\"values\":[]}",
                1, null, null);
        return new ItemNode(id(key), key, questionNumber, "synthetic item " + questionNumber, interaction, defs, answer, 1);
    }

    static ItemNode gapItem(String key, int questionNumber, boolean keyed) {
        String defs = "{\"options\":[],\"questionNumber\":" + questionNumber
                + ",\"group\":{\"kind\":\"GAP\",\"instructions\":[\"synthetic instruction\"],\"wordLimitRule\":\"ONE WORD ONLY\"}}";
        AnswerNode answer = new AnswerNode(id(key + ":spec"), keyed ? "{\"values\":[\"word" + questionNumber + "\"]}" : "{\"values\":[]}",
                1, 1, null);
        return new ItemNode(id(key), key, questionNumber, "synthetic gap " + questionNumber, "TEXT_GAP", defs, answer, 1);
    }

    static StimulusNode audio(String key, boolean validated) {
        return new StimulusNode(id(key), "AUDIO", true, List.of(new AssetNode(id(key + ":asset"), "audio/mpeg",
                validated ? "VALIDATED" : "PENDING")));
    }

    static StimulusNode audioWithoutAsset(String key) {
        return new StimulusNode(id(key), "AUDIO", true, List.of());
    }

    static StimulusNode image(String key, String kind, String state) {
        return new StimulusNode(id(key), kind, true, List.of(new AssetNode(id(key + ":asset"), "image/png", state)));
    }

    static StimulusNode passage(String key, String kind) {
        return new StimulusNode(id(key), kind, true, List.of());
    }

    static GroupNode group(String key, int ordinal, List<StimulusNode> stimuli, List<ItemNode> items) {
        return new GroupNode(id(key), id(key + ":placement"), ordinal, stimuli, items);
    }

    // ─── TOEIC L&R 2016 ─────────────────────────────────────────────────────────────────

    static final class Toeic {
        String part1ImageState = "VALIDATED";
        String graphicState = "VALIDATED";
        boolean listeningAudio = true;
        boolean keyed = true;
        int part2Options = 3;
        UUID formId = id("toeic-form");

        ExamContentTree build() {
            int[] q = {1};
            List<PartNode> lParts = new ArrayList<>();
            // Part 1: 6 photos, one question each
            List<GroupNode> p1 = new ArrayList<>();
            for (int g = 1; g <= 6; g++) {
                List<StimulusNode> st = new ArrayList<>();
                st.add(listeningAudio ? audio("t-p1-a" + g, true) : audioWithoutAsset("t-p1-a" + g));
                st.add(image("t-p1-i" + g, "IMAGE", part1ImageState));
                p1.add(group("t-p1-g" + g, g, st, List.of(choiceItem("t-q" + q[0], q[0]++, 4, "B", keyed, "SINGLE_CHOICE"))));
            }
            lParts.add(new PartNode(id("t-part1"), "LISTENING_PART_1", 1, p1));
            // Part 2: 25 questions, THREE options
            List<ItemNode> p2items = new ArrayList<>();
            for (int i = 0; i < 25; i++) p2items.add(choiceItem("t-q" + q[0], q[0]++, part2Options, "A", keyed, "SINGLE_CHOICE"));
            lParts.add(new PartNode(id("t-part2"), "LISTENING_PART_2", 2,
                    List.of(group("t-p2-g1", 1, List.of(listeningAudio ? audio("t-p2-a", true) : audioWithoutAsset("t-p2-a")), p2items))));
            lParts.add(new PartNode(id("t-part3"), "LISTENING_PART_3", 3, sets("t-p3", 13, q, true)));
            lParts.add(new PartNode(id("t-part4"), "LISTENING_PART_4", 4, sets("t-p4", 10, q, false)));

            List<PartNode> rParts = new ArrayList<>();
            List<ItemNode> p5 = new ArrayList<>();
            for (int i = 0; i < 30; i++) p5.add(choiceItem("t-q" + q[0], q[0]++, 4, "C", keyed, "SINGLE_CHOICE"));
            rParts.add(new PartNode(id("t-part5"), "READING_PART_5", 1, List.of(group("t-p5-g1", 1, List.of(), p5))));
            List<GroupNode> p6 = new ArrayList<>();
            for (int g = 1; g <= 4; g++) {
                List<ItemNode> items = new ArrayList<>();
                for (int i = 0; i < 4; i++) items.add(choiceItem("t-q" + q[0], q[0]++, 4, "D", keyed, "SINGLE_CHOICE"));
                p6.add(group("t-p6-g" + g, g, List.of(passage("t-p6-s" + g, "TEXT")), items));
            }
            rParts.add(new PartNode(id("t-part6"), "READING_PART_6", 2, p6));
            List<GroupNode> p7 = new ArrayList<>();
            int[] singleSizes = {2, 2, 2, 2, 3, 3, 3, 4, 4, 4};
            int ord = 1;
            for (int size : singleSizes) {
                List<ItemNode> items = new ArrayList<>();
                for (int i = 0; i < size; i++) items.add(choiceItem("t-q" + q[0], q[0]++, 4, "A", keyed, "SINGLE_CHOICE"));
                p7.add(group("t-p7-g" + ord, ord, List.of(passage("t-p7-s" + ord, "TEXT")), items));
                ord++;
            }
            for (int m = 0; m < 5; m++) {   // 2 double + 3 triple passage sets of 5
                List<ItemNode> items = new ArrayList<>();
                for (int i = 0; i < 5; i++) items.add(choiceItem("t-q" + q[0], q[0]++, 4, "B", keyed, "SINGLE_CHOICE"));
                p7.add(group("t-p7-g" + ord, ord, List.of(passage("t-p7-md" + ord, "MULTI_DOC")), items));
                ord++;
            }
            rParts.add(new PartNode(id("t-part7"), "READING_PART_7", 3, p7));

            return new ExamContentTree(formId, ExamFamily.TOEIC, "STANDARD_FIXED_FORM", "FULL", null, true, Map.of(), List.of(
                    new SectionNode(id("t-listening"), formId, SkillType.LISTENING, 1, 2700, null, null, lParts),
                    new SectionNode(id("t-reading"), formId, SkillType.READING, 2, 4500, null, null, rParts)));
        }

        private List<GroupNode> sets(String prefix, int count, int[] q, boolean oneGraphic) {
            List<GroupNode> out = new ArrayList<>();
            for (int g = 1; g <= count; g++) {
                List<ItemNode> items = new ArrayList<>();
                for (int i = 0; i < 3; i++) items.add(choiceItem("t-q" + q[0], q[0]++, 4, "C", keyed, "SINGLE_CHOICE"));
                List<StimulusNode> st = new ArrayList<>();
                st.add(listeningAudio ? audio(prefix + "-a" + g, true) : audioWithoutAsset(prefix + "-a" + g));
                if (oneGraphic && g == count) st.add(image(prefix + "-graphic", "CHART", graphicState));
                out.add(group(prefix + "-g" + g, g, st, items));
            }
            return out;
        }
    }

    // ─── IELTS Academic ─────────────────────────────────────────────────────────────────

    static final class Ielts {
        String task1VisualState = "VALIDATED";
        boolean task1Visual = true;
        boolean labelAssignmentPart2 = false;
        boolean labelFigure = true;
        boolean numberingGapPart1 = false;
        boolean duplicateReadingPassage1 = false;
        UUID formId = id("ielts-form");

        ExamContentTree build() {
            List<PartNode> lParts = new ArrayList<>();
            int q = 1;
            for (int part = 1; part <= 4; part++) {
                List<GroupNode> groups = new ArrayList<>();
                if (part == 2 && labelAssignmentPart2) {
                    List<ItemNode> labels = new ArrayList<>();
                    for (int i = 0; i < 6; i++) labels.add(choiceItem("i-q" + q, q++, 8, String.valueOf((char) ('A' + i)), true,
                            "LABEL_ASSIGNMENT"));
                    List<StimulusNode> st = new ArrayList<>(List.of(audio("i-l2-a", true)));
                    if (labelFigure) st.add(image("i-l2-map", "MAP", "VALIDATED"));
                    groups.add(group("i-l2-g1", 1, st, labels));
                    List<ItemNode> gaps = new ArrayList<>();
                    for (int i = 0; i < 4; i++) gaps.add(gapItem("i-q" + q, q++, true));
                    groups.add(group("i-l2-g2", 2, List.of(audio("i-l2-a", true)), gaps));
                } else {
                    List<ItemNode> gaps = new ArrayList<>();
                    for (int i = 0; i < 10; i++) {
                        int n = q++;
                        if (part == 1 && numberingGapPart1 && i == 4) n = n + 100;  // printed number lost ⇒ gap
                        gaps.add(gapItem("i-q" + (n), n, true));
                    }
                    groups.add(group("i-l" + part + "-g1", 1, List.of(audio("i-l" + part + "-a", true)), gaps));
                }
                lParts.add(new PartNode(id("i-lpart" + part), "LISTENING_PART_" + part, part, groups));
            }
            List<PartNode> rParts = new ArrayList<>();
            int[] sizes = {13, 13, 14};
            int rq = 1;
            for (int p = 1; p <= 3; p++) {
                List<ItemNode> items = new ArrayList<>();
                for (int i = 0; i < sizes[p - 1]; i++) items.add(choiceItem("i-r" + rq, rq++, 3, "A", true, "TRUTH_CLASSIFICATION"));
                rParts.add(new PartNode(id("i-rpart" + p), "READING_PASSAGE_" + p, p,
                        List.of(group("i-r" + p + "-g1", 1, List.of(passage("i-r" + p + "-s", "TEXT")), items))));
            }
            if (duplicateReadingPassage1) {
                rParts.add(new PartNode(id("i-rpart1-dup"), "PASSAGE_1", 4, List.of()));
            }
            List<StimulusNode> t1 = new ArrayList<>();
            if (task1Visual) t1.add(image("i-w1-chart", "CHART", task1VisualState));
            t1.add(passage("i-w1-prompt", "TEXT"));
            List<PartNode> wParts = List.of(
                    new PartNode(id("i-wpart1"), "WRITING_TASK_1", 1, List.of(group("i-w1-g", 1, t1, List.of(writingItem("i-w1", 150))))),
                    new PartNode(id("i-wpart2"), "WRITING_TASK_2", 2, List.of(group("i-w2-g", 1,
                            List.of(passage("i-w2-prompt", "TEXT")), List.of(writingItem("i-w2", 250))))));
            List<PartNode> sParts = List.of(new PartNode(id("i-spart1"), "SPEAKING_PART_1", 1, List.of(group("i-s1-g", 1,
                    List.of(), List.of(new ItemNode(id("i-s1"), "i-s1", 1, "synthetic speaking", "SPEAKING_RESPONSE", "{}",
                            new AnswerNode(id("i-s1:spec"), "{\"policy\":\"RUBRIC\"}", 1, null, id("rubric-s")), 1))))));
            return new ExamContentTree(formId, ExamFamily.IELTS, "ACADEMIC", "FULL", null, true, Map.of(), List.of(
                    new SectionNode(id("i-listening"), formId, SkillType.LISTENING, 1, 1800, null, null, lParts),
                    new SectionNode(id("i-reading"), formId, SkillType.READING, 2, 3600, null, null, rParts),
                    new SectionNode(id("i-writing"), formId, SkillType.WRITING, 3, 3600, null, null, wParts),
                    new SectionNode(id("i-speaking"), formId, SkillType.SPEAKING, 4, 840, null, null, sParts)));
        }

        private static ItemNode writingItem(String key, int minimumWords) {
            return new ItemNode(id(key), key, 1, "synthetic writing task " + key, "WRITING_RESPONSE",
                    "{\"responseMode\":\"ESSAY\",\"minimumWords\":" + minimumWords + "}",
                    new AnswerNode(id(key + ":spec"), "{\"policy\":\"RUBRIC\",\"minimumWords\":" + minimumWords + "}", 1, null,
                            id("rubric-w")), 1);
        }
    }
}
