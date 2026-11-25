package com.englishcoach.wordchain;

import java.text.Normalizer;
import java.util.*;
import java.util.regex.Pattern;

public final class WordChainRules {
    private WordChainRules() {}
    private static final Pattern FORM = Pattern.compile("[a-z]+(?:['-][a-z]+)*");
    public static String normalize(String input) {
        if (input == null || input.length() > 80) throw new Rejection("INVALID_FORM");
        String word = Normalizer.normalize(input.strip(), Normalizer.Form.NFC)
                .replace('’', '\'').replace('‘', '\'').toLowerCase(Locale.ROOT);
        if (word.length() < 2 || word.length() > 40 || !FORM.matcher(word).matches()) throw new Rejection("INVALID_FORM");
        return word;
    }
    /** Same verdict for every participant: form, letter, own duplicates, then the one dictionary word policy. */
    public static WordChainLexicon.Word validate(String input, String required, Set<String> used,
            Map<String, WordChainLexicon.Word> metadata, WordChainLexicon dictionary) {
        String word = normalize(input);
        if (required != null && !word.startsWith(required)) throw new Rejection("WRONG_LETTER");
        if (used.contains(word)) throw new Rejection("SELF_DUPLICATE");
        var known = metadata.get(word);
        if (known == null) {
            var verdict = dictionary.check(word);
            if (verdict.word() == null) throw new Rejection(verdict.rejection());
            known = verdict.word();
        }
        return known;
    }
    public static String last(String word) { return word.substring(word.length() - 1); }
    public static final class Rejection extends RuntimeException {
        public final String code;
        public Rejection(String code) { super(code); this.code = code; }
    }
}
