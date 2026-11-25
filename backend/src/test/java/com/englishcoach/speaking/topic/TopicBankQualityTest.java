package com.englishcoach.speaking.topic;

import com.englishcoach.speaking.topic.TopicBank.Band;
import com.englishcoach.speaking.topic.TopicBank.Item;
import com.englishcoach.speaking.topic.TopicBank.Style;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;
import java.util.function.Function;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Release gate of the "Nói theo chủ đề" question bank. Writes the audit to
 * {@code target/speaking-topic-bank-audit.md} and fails on any structural defect, duplicate, unreviewed near-duplicate,
 * unsafe or assistance-like wording, broken IELTS link or thin coverage. Automated checks are not human editorial review.
 */
class TopicBankQualityTest {

    private static TopicBank bank;
    private static final Set<String> STOP = Set.of(("a an the and or but if of to in on at for with by from as is are was were be been "
            + "do does did you your yours i me my we our they them their it its this that these those what which who whom how why when "
            + "where would could should can will may might there here than then so not no any some one all most more very much many "
            + "about into up out over just also only really ever often usually explain describe talk tell think view opinion "
            + "answer reasons give make case argue defend "
            // question frames ("Is X popular in your country?", "... than they used to?") are not shared ideas
            + "people person like find interesting important popular country child young old future today past used less "
            + "way thing something someone good best lot every kind enjoy prefer").split(" "));
    /** Words that must never appear: insults, crude content, or prompts forcing private disclosure. */
    private static final Pattern UNSAFE = Pattern.compile("\\b(stupid|idiot|ugly|fat|kill|suicide|sex|sexual|religion|religious|"
            + "politician|political party|your salary|your weight|your income|diagnos\\w*|disease you|illness you have|drunk|drugs?)\\b",
            Pattern.CASE_INSENSITIVE);
    /** A definition clarifies a term; it must not address the learner or carry answer scaffolding. */
    private static final Pattern ASSIST = Pattern.compile("\\b(you|your|bạn|should mention|for example you|try to|tip|gợi ý|nên nói)\\b",
            Pattern.CASE_INSENSITIVE);

    /**
     * Pairs flagged by the metric and reviewed by hand (2026-10-14) as a shared question FRAME or a shared broad theme with a
     * different question ("Have your mornings changed …" / "Have festivals changed …"); every other flag fails the gate.
     */
    private static final Set<String> REVIEWED = Set.of(
            "Q-ME-08|P2-02", "Q-LE-02|P1-42", "Q-LE-03|P2-26", "Q-LE-03|P2-50", "Q-MI-02|P3-33", "Q-TE-09|P3-23",
            "Q-TR-10|P1-27", "Q-TR-11|P1-01", "Q-TR-11|P2-58", "Q-CI-08|P1-43", "P1-01|P1-42", "P1-01|P2-58", "P1-01|P3-07",
            "P1-02|P1-41", "P1-04|P1-36", "P1-06|P3-04", "P1-25|P1-41", "P1-38|P3-48", "P1-39|P3-42", "P1-40|P2-44",
            "P1-41|P3-31", "P1-42|P2-08", "P1-42|P2-58", "P1-42|P3-07", "P2-26|P2-50", "P2-58|P3-07");

    @BeforeAll
    static void load() {
        bank = new TopicBank();
    }

    @Test
    void everyAuthoredItemPassesTheStructuralGate() {
        assertThat(bank.problems()).as("items excluded by the structural gate").isEmpty();
    }

    @Test
    void noNearDuplicateQuestions() throws Exception {
        List<String[]> texts = new ArrayList<>();
        for (Item i : bank.all()) for (String q : i.questions()) texts.add(new String[]{i.id(), q});
        List<String> flagged = new ArrayList<>();
        for (int a = 0; a < texts.size(); a++) {
            Set<String> wa = content(texts.get(a)[1]);
            if (wa.isEmpty()) continue;
            for (int b = a + 1; b < texts.size(); b++) {
                if (texts.get(a)[0].equals(texts.get(b)[0]) || linked(texts.get(a)[0], texts.get(b)[0])) continue;
                Set<String> wb = content(texts.get(b)[1]);
                if (wb.isEmpty()) continue;
                double j = jaccard(wa, wb);
                if (j >= 0.5 && shared(wa, wb) >= 2 && !REVIEWED.contains(texts.get(a)[0] + "|" + texts.get(b)[0])) flagged.add(String.format("%.2f %s \"%s\" ~ %s \"%s\"", j, texts.get(a)[0], texts.get(a)[1],
                        texts.get(b)[0], texts.get(b)[1]));
            }
        }
        write(flagged);
        assertThat(flagged).as("near-duplicate questions (token Jaccard ≥ 0.5)").isEmpty();
    }

    @Test
    void noUnsafeOrAssistiveWording() {
        List<String> bad = new ArrayList<>();
        for (Item i : bank.all()) {
            for (String q : i.questions()) if (UNSAFE.matcher(q).find()) bad.add(i.id() + " unsafe: " + q);
            for (String b : i.bullets()) if (UNSAFE.matcher(b).find()) bad.add(i.id() + " unsafe bullet: " + b);
            if (i.definition() != null) {
                if (ASSIST.matcher(i.definition().en()).find()) bad.add(i.id() + " definition addresses the learner: " + i.definition().en());
                if (ASSIST.matcher(i.definition().vi()).find()) bad.add(i.id() + " definition addresses the learner: " + i.definition().vi());
            }
        }
        assertThat(bad).isEmpty();
    }

    @Test
    void ieltsFormatsAreDistinctAndLinked() {
        for (Item p3 : bank.items(Style.IELTS3)) {
            assertThat(p3.linkedId()).as(p3.id() + " links a Part 2 card").isNotNull();
            assertThat(bank.item(p3.linkedId()).orElseThrow().style()).isEqualTo(Style.IELTS2);
        }
        for (Item p2 : bank.items(Style.IELTS2)) {
            assertThat(p2.questions()).hasSize(1);
            assertThat(p2.bullets()).hasSizeBetween(3, 4);
            assertThat(p2.explain()).startsWith("and explain ");
        }
        for (Item p1 : bank.items(Style.IELTS1)) {
            assertThat(p1.questions()).hasSizeBetween(3, 6);
            assertThat(p1.band()).isNotEqualTo(Band.ADVANCED);
        }
        // the same Part 3 set never serves two cards and no card is continued twice
        Map<String, Long> links = bank.items(Style.IELTS3).stream().collect(Collectors.groupingBy(Item::linkedId, Collectors.counting()));
        assertThat(links.values()).allMatch(n -> n == 1);
    }

    @Test
    void coverageIsBroadEnoughForVariety() {
        assertThat(bank.items(Style.QUICK)).hasSizeGreaterThanOrEqualTo(240);
        assertThat(bank.items(Style.DEEP)).hasSizeGreaterThanOrEqualTo(100);
        assertThat(bank.items(Style.IELTS1)).hasSizeGreaterThanOrEqualTo(40);
        assertThat(bank.items(Style.IELTS2)).hasSizeGreaterThanOrEqualTo(50);
        assertThat(bank.items(Style.IELTS3)).hasSizeGreaterThanOrEqualTo(40);
        for (TopicBank.Category c : bank.categories()) {
            for (Band b : Band.values()) {
                long n = bank.pool(Style.QUICK, c.key(), b).size();
                assertThat(n).as("QUICK " + c.key() + " " + b).isGreaterThanOrEqualTo(2);
            }
            assertThat(bank.pool(Style.DEEP, c.key(), null)).as("DEEP " + c.key()).hasSizeGreaterThanOrEqualTo(5);
        }
        // DEEP is demanding: never a beginner item
        assertThat(bank.items(Style.DEEP)).noneMatch(i -> i.band() == Band.BASIC);
        // variety of thinking: at least 15 distinct cognitive tasks across QUICK + DEEP
        Set<String> tasks = new HashSet<>();
        bank.items(Style.QUICK).forEach(i -> tasks.add(i.task()));
        bank.items(Style.DEEP).forEach(i -> tasks.add(i.task()));
        assertThat(tasks).hasSizeGreaterThanOrEqualTo(15);
    }

    @Test
    void beginnerPromptsStayShortAndPlain() {
        for (Item i : bank.items(Style.QUICK)) {
            int words = i.questions().getFirst().split("\\s+").length;
            if (i.band() == Band.BASIC) assertThat(words).as(i.id()).isLessThanOrEqualTo(20);
        }
    }

    private static Set<String> content(String text) {
        Set<String> out = new HashSet<>();
        for (String w : TopicBank.normalize(text).split(" ")) {
            if (w.length() < 3 || STOP.contains(w)) continue;
            out.add(w.endsWith("s") && w.length() > 4 ? w.substring(0, w.length() - 1) : w);
        }
        return out;
    }

    /** A Part 3 set continues the theme of its own Part 2 card by design (exam format). */
    private static boolean linked(String a, String b) {
        String la = bank.item(a).map(Item::linkedId).orElse(null);
        String lb = bank.item(b).map(Item::linkedId).orElse(null);
        return b.equals(la) || a.equals(lb);
    }

    private static int shared(Set<String> a, Set<String> b) {
        Set<String> inter = new HashSet<>(a);
        inter.retainAll(b);
        return inter.size();
    }

    private static double jaccard(Set<String> a, Set<String> b) {
        Set<String> inter = new HashSet<>(a);
        inter.retainAll(b);
        Set<String> union = new HashSet<>(a);
        union.addAll(b);
        return union.isEmpty() ? 0 : (double) inter.size() / union.size();
    }

    private static void write(List<String> flagged) throws Exception {
        StringBuilder md = new StringBuilder("# Speaking topic bank audit\n\nBank version ").append(bank.version())
                .append(" · review status ").append(bank.reviewStatus()).append("\n\n");
        md.append("| Style | Units | Questions |\n|---|---|---|\n");
        int units = 0, questions = 0;
        for (Style s : Style.values()) {
            int u = bank.items(s).size();
            int q = bank.items(s).stream().mapToInt(i -> i.questions().size()).sum();
            units += u;
            questions += q;
            md.append("| ").append(s).append(" | ").append(u).append(" | ").append(q).append(" |\n");
        }
        md.append("| **Total** | ").append(units).append(" | ").append(questions).append(" |\n\n");
        md.append(table("Units by category", bank.all(), Item::category));
        md.append(table("Units by CEFR estimate", bank.all(), Item::level));
        List<Item> qd = new ArrayList<>(bank.items(Style.QUICK));
        qd.addAll(bank.items(Style.DEEP));
        md.append(table("QUICK + DEEP by cognitive task", qd, Item::task));
        Map<String, Long> clusters = bank.all().stream().collect(Collectors.groupingBy(Item::cluster, Collectors.counting()));
        md.append("## Semantic clusters\n\n").append(clusters.size()).append(" clusters; shared by more than one unit: ")
                .append(clusters.values().stream().filter(n -> n > 1).count()).append(" (largest ")
                .append(clusters.values().stream().mapToLong(Long::longValue).max().orElse(0)).append(")\n\n");
        md.append("## Near-duplicate candidates (content-word Jaccard ≥ 0.5 with ≥ 2 shared content words; a Part 3 set vs its own Part 2 card excluded)\n\n").append(flagged.isEmpty() ? "None.\n" : String.join("\n", flagged))
                .append("\n\n## Structural gate exclusions\n\n").append(bank.problems().isEmpty() ? "None.\n" : String.join("\n", bank.problems()));
        Path out = Path.of("target", "speaking-topic-bank-audit.md");
        Files.createDirectories(out.getParent());
        Files.writeString(out, md.toString());
    }

    private static String table(String title, Collection<Item> items, Function<Item, String> key) {
        Map<String, Long> counts = new TreeMap<>(items.stream().collect(Collectors.groupingBy(key, Collectors.counting())));
        StringBuilder sb = new StringBuilder("## ").append(title).append("\n\n| Key | Units |\n|---|---|\n");
        counts.forEach((k, v) -> sb.append("| ").append(k).append(" | ").append(v).append(" |\n"));
        return sb.append('\n').toString();
    }
}
