package com.englishcoach.cosmos;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.text.Normalizer;
import java.util.HexFormat;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Echo Neural Cosmos — the deterministic source extractor (no model, no AI, no network).
 *
 * <p>Output = the distinct lower-case word forms of a text and its adjacent two-word forms (never across sentence
 * punctuation), in first-appearance order: {@code "unigram unigram …|first_second …"}. It says only which forms occur. Which
 * known word (and which part of speech) a form belongs to is decided by the client against the verified lexicon, with the
 * part-of-speech-aware inflection rules there. Nothing here is a relation, a sense or a mastery claim.
 *
 * <p>A change to the output for the same text must bump {@link #VERSION}: cached rows of other versions are then ignored.
 */
public final class CosmosTokenizer {
    public static final int VERSION = 1;
    public static final int MAX_TOKENS = 20_000;
    private static final Pattern WORD = Pattern.compile("[a-z]+(?:['\\-][a-z]+)*");
    private static final Pattern BREAK = Pattern.compile("[.!?;:,()\\[\\]{}\"“”—–\\n\\r]+");

    private CosmosTokenizer() {}

    public static String normalize(String text) {
        if (text == null) return "";
        return Normalizer.normalize(text, Normalizer.Form.NFC).replace('’', '\'').replace('‘', '\'').toLowerCase(Locale.ROOT);
    }

    /** {@code unigrams|bigrams}; at most {@link #MAX_TOKENS} entries in total. */
    public static Result tokenize(String text) {
        String norm = normalize(text);
        LinkedHashSet<String> uni = new LinkedHashSet<>();
        LinkedHashSet<String> bi = new LinkedHashSet<>();
        for (String clause : BREAK.split(norm)) {
            Matcher m = WORD.matcher(clause);
            String prev = null;
            while (m.find()) {
                String w = m.group();
                if (w.endsWith("'s")) w = w.substring(0, w.length() - 2); // possessive is the same word form
                if (w.isEmpty() || w.length() > 40) { prev = null; continue; }
                if (uni.size() + bi.size() >= MAX_TOKENS) break;
                uni.add(w);
                if (prev != null) bi.add(prev + "_" + w);
                prev = w;
            }
        }
        StringBuilder out = new StringBuilder(uni.size() * 8 + bi.size() * 14);
        out.append(String.join(" ", uni)).append('|').append(String.join(" ", bi));
        String tokens = out.length() > 200_000 ? out.substring(0, out.lastIndexOf(" ", 200_000)) : out.toString();
        return new Result(tokens, uni.size() + bi.size());
    }

    public static String sha256(String text) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(md.digest((text == null ? "" : text).getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    public record Result(String tokens, int count) {}
}
