package com.englishcoach.proficiency.placement;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Structural checks for a placement question before it can be issued (the DB CHECKs cover shape; this also covers
 * content): known skill and level, one blank, exactly four distinct non-blank options made of English letters, an
 * answer index inside the options, nothing that looks like a URL, an e-mail or markup. Malformed rows are skipped
 * by the service and never shown.
 */
public final class PlacementQuestionValidator {

    private PlacementQuestionValidator() {}

    public record Question(long id, String key, String skill, String cefr, String prompt, List<String> options,
                           int answerIndex) {}

    private static final Set<String> SKILLS = Set.of(PlacementScorer.VOCABULARY, PlacementScorer.GRAMMAR);
    private static final Set<String> LEVELS = Set.of("A1", "A2", "B1", "B2", "C1");
    /** Option text: English letters, spaces, apostrophes, hyphens, dots (e.g. "don't", "a.m."), 1–40 chars. */
    private static final Pattern OPTION = Pattern.compile("[A-Za-z][A-Za-z' .\\-]{0,39}");
    private static final Pattern PROMPT = Pattern.compile("[A-Za-z0-9 ,.;:!?'\"()\\-_]{8,240}");

    /** @return list of problems; empty = valid */
    public static List<String> problems(Question q) {
        List<String> out = new ArrayList<>();
        if (q == null) {
            out.add("null question");
            return out;
        }
        if (q.skill() == null || !SKILLS.contains(q.skill())) out.add("unknown skill");
        if (q.cefr() == null || !LEVELS.contains(q.cefr())) out.add("unknown level");
        String prompt = q.prompt() == null ? "" : q.prompt();
        int blanks = prompt.split("___", -1).length - 1;
        if (blanks != 1) out.add("prompt must contain exactly one blank");
        if (!PROMPT.matcher(prompt).matches()) out.add("prompt has unexpected characters");
        List<String> options = q.options() == null ? List.of() : q.options();
        if (options.size() != 4) out.add("exactly 4 options required");
        Set<String> seen = new HashSet<>();
        for (String o : options) {
            if (o == null || o.isBlank() || !OPTION.matcher(o.trim()).matches()) {
                out.add("malformed option: " + o);
            } else if (!seen.add(o.trim().toLowerCase(Locale.ROOT))) {
                out.add("duplicate option: " + o);
            }
        }
        if (q.answerIndex() < 0 || q.answerIndex() >= options.size()) out.add("answer index out of range");
        return out;
    }

    public static boolean isValid(Question q) {
        return problems(q).isEmpty();
    }
}
