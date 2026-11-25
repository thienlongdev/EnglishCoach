package com.englishcoach.flashcard.memory;

import java.text.Normalizer;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Plain, deterministic English word-form helpers for Echo Memory Tides: does a sentence really use a word (or a simple
 * inflection of it), and which tokens does a sentence contain. No dictionary, no network, no AI: a form either appears in
 * the text or it does not. Irregular forms are not guessed (a missing match is reported, never invented).
 */
public final class WordForms {

    private WordForms() {}

    private static final Pattern TOKEN = Pattern.compile("[a-z]+(?:'[a-z]+)?");

    /** Function words never used as Fusion partners (a pair must carry meaning). */
    static final Set<String> STOPWORDS = Set.of(
            "the", "and", "for", "are", "but", "not", "you", "all", "any", "can", "had", "her", "was", "one", "our", "out",
            "day", "get", "has", "him", "his", "how", "man", "new", "now", "old", "see", "two", "way", "who", "boy", "did",
            "its", "let", "put", "say", "she", "too", "use", "that", "with", "have", "this", "will", "your", "from", "they",
            "know", "want", "been", "good", "much", "some", "time", "very", "when", "come", "here", "just", "like", "long",
            "make", "many", "more", "only", "over", "such", "take", "than", "them", "well", "were", "what", "into", "also",
            "then", "there", "these", "their", "would", "about", "which", "could", "other", "where", "while", "being",
            "should", "because", "does", "doing", "done", "went", "gone", "said", "each", "even", "ever", "most", "must",
            "same", "both", "few", "own", "may", "might", "shall", "yes", "yet", "off", "upon", "onto", "per", "via");

    public static String normalize(String s) {
        if (s == null) return "";
        String t = Normalizer.normalize(s, Normalizer.Form.NFC)
                .replace('’', '\'').replace('‘', '\'')
                .replace('“', '"').replace('”', '"')
                .replace(' ', ' ');
        return t.replaceAll("\\s+", " ").trim();
    }

    /** Lower-case word tokens of a text (apostrophes kept inside words). */
    public static List<String> tokens(String text) {
        List<String> out = new ArrayList<>();
        Matcher m = TOKEN.matcher(normalize(text).toLowerCase(Locale.ROOT));
        while (m.find()) out.add(m.group());
        return out;
    }

    /** The simple regular forms of a single word: itself, -s/-es, -ed/-d, -ing, y → ies/ied, final e dropped before -ing. */
    public static Set<String> forms(String word) {
        String w = normalize(word).toLowerCase(Locale.ROOT);
        Set<String> out = new LinkedHashSet<>();
        if (w.isEmpty()) return out;
        out.add(w);
        out.add(w + "s");
        out.add(w + "es");
        out.add(w + "ed");
        out.add(w + "d");
        out.add(w + "ing");
        out.add(w + "er");
        out.add(w + "est");
        out.add(w + "ly");
        if (w.endsWith("e") && w.length() > 2) {
            out.add(w.substring(0, w.length() - 1) + "ing");
        }
        if (w.endsWith("y") && w.length() > 2) {
            String stem = w.substring(0, w.length() - 1);
            out.add(stem + "ies");
            out.add(stem + "ied");
            out.add(stem + "ier");
            out.add(stem + "iest");
            out.add(stem + "ily");
        }
        if (w.length() >= 3 && isCvc(w)) {
            char last = w.charAt(w.length() - 1);
            out.add(w + last + "ed");
            out.add(w + last + "ing");
        }
        return out;
    }

    private static boolean isCvc(String w) {
        String v = "aeiou";
        char a = w.charAt(w.length() - 3), b = w.charAt(w.length() - 2), c = w.charAt(w.length() - 1);
        return v.indexOf(a) < 0 && v.indexOf(b) >= 0 && v.indexOf(c) < 0 && "wxy".indexOf(c) < 0;
    }

    /** True when the text uses the term: a single word (or a regular form) as a whole token, or every word of a phrase in order. */
    public static boolean uses(String text, String term) {
        List<String> words = tokens(term);
        if (words.isEmpty()) return false;
        List<String> toks = tokens(text);
        if (words.size() == 1) {
            Set<String> f = forms(words.get(0));
            for (String t : toks) if (f.contains(t)) return true;
            return false;
        }
        // a phrase: its words in order, each a regular form; small gaps allowed for separable phrasal verbs ("pick it up")
        int from = 0;
        for (int i = 0; i < words.size(); i++) {
            Set<String> f = forms(words.get(i));
            int found = -1;
            int limit = i == 0 ? toks.size() : Math.min(toks.size(), from + 4);
            for (int j = from; j < limit; j++) {
                if (f.contains(toks.get(j))) { found = j; break; }
            }
            if (found < 0) return false;
            from = found + 1;
        }
        return true;
    }

    /** The exact span of the text that uses a single word or its regular form (for cloze / highlighting), or null. */
    public static String matchedForm(String text, String word) {
        Set<String> f = forms(word);
        Matcher m = Pattern.compile("[A-Za-z]+(?:['’][A-Za-z]+)?").matcher(text == null ? "" : text);
        while (m.find()) {
            if (f.contains(m.group().toLowerCase(Locale.ROOT).replace('’', '\''))) return m.group();
        }
        return null;
    }

    /** A content word worth pairing: letters only, at least 3 long, not a function word. */
    public static boolean contentWord(String word) {
        String w = normalize(word).toLowerCase(Locale.ROOT);
        return w.length() >= 3 && w.matches("[a-z]+") && !STOPWORDS.contains(w);
    }

    /** Sentences of a passage (simple punctuation split; each trimmed and non-empty). */
    public static List<String> sentences(String text) {
        List<String> out = new ArrayList<>();
        for (String part : normalize(text).split("(?<=[.!?])\\s+(?=[\"'(\\[]?[A-Z0-9])")) {
            String p = part.trim();
            if (!p.isEmpty()) out.add(p);
        }
        return out;
    }
}
