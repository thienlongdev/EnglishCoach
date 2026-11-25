package com.englishcoach.exams.scoring;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.text.Normalizer;
import java.util.*;
import java.util.regex.Pattern;

@Slf4j
@Component
public class ExamAnswerNormalizer {

    private static final Pattern MULTI_SPACE_PATTERN = Pattern.compile("\\s+");
    private static final Pattern LEADING_TRAILING_PUNCT_PATTERN = Pattern.compile("^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$");

    public record NormalizationResult(
            String normalizedText,
            boolean isMatched,
            double awardedCredit,
            String matchedVariant
    ) {}

    /**
     * Normalizes a raw student answer string based on the item's policy.
     */
    public String normalize(String input, Map<String, Object> policy) {
        if (input == null) return "";

        // 1. Unicode NFC normalization
        String text = Normalizer.normalize(input, Normalizer.Form.NFC).trim();

        // 2. Case normalization (default case-insensitive unless explicitly requested)
        boolean caseSensitive = Boolean.TRUE.equals(policy.get("caseSensitive"));
        if (!caseSensitive) {
            text = text.toLowerCase(Locale.ROOT);
        }

        // 3. Multi-space collapse
        text = MULTI_SPACE_PATTERN.matcher(text).replaceAll(" ").trim();

        // 4. Punctuation treatment ("punctuationInsensitive" = canonical EC-NORM-V1 name of the same rule)
        boolean stripPunctuation = Boolean.TRUE.equals(policy.get("stripPunctuation"))
                || Boolean.TRUE.equals(policy.get("punctuationInsensitive"));
        if (stripPunctuation) {
            text = text.replaceAll("[.,/#!$%^&*;:{}=\\-_`~()?'\"]", "").trim();
        } else {
            // Trim leading and trailing punctuation that is not part of an answer
            boolean trimEdgePunct = !Boolean.FALSE.equals(policy.get("trimEdgePunct"));
            if (trimEdgePunct) {
                text = LEADING_TRAILING_PUNCT_PATTERN.matcher(text).replaceAll("").trim();
            }
        }

        // 5. Article stripping if specified
        boolean stripArticles = Boolean.TRUE.equals(policy.get("stripArticles"));
        if (stripArticles) {
            if (text.startsWith("the ")) text = text.substring(4).trim();
            else if (text.startsWith("a ")) text = text.substring(2).trim();
            else if (text.startsWith("an ")) text = text.substring(3).trim();
        }

        return text;
    }

    private static final Pattern HAS_LETTER = Pattern.compile(".*\\p{L}.*");
    private static final Pattern HAS_ALNUM = Pattern.compile(".*[\\p{L}\\p{N}].*");

    /**
     * Deterministic IELTS-style word count of a RAW learner response (Exams Phase 4, server-side word limits).
     * Counted before any article / punctuation stripping, so "the litter" is two words even when the policy
     * strips articles for matching. Tokens are whitespace-separated; a hyphenated token ("well-known") is one
     * word; tokens without any letter or digit (stray punctuation) are ignored. When {@code numbersExempt}
     * (rule "... AND/OR A NUMBER") tokens without a letter ("15", "3.30", "£20") are not counted as words.
     */
    public int countWords(String rawResponse, boolean numbersExempt) {
        if (rawResponse == null) return 0;
        String text = Normalizer.normalize(rawResponse, Normalizer.Form.NFC).trim();
        if (text.isEmpty()) return 0;
        List<String> tokens = new ArrayList<>();
        for (String token : MULTI_SPACE_PATTERN.split(text)) {
            if (HAS_ALNUM.matcher(token).matches()) tokens.add(token);
        }
        Set<Integer> dateTokens = numbersExempt ? dateTokenIndexes(tokens) : Set.of();
        int words = 0;
        for (int i = 0; i < tokens.size(); i++) {
            String token = tokens.get(i);
            if (numbersExempt) {
                // "A NUMBER" may be written in figures ("35") or in words ("thirty five", "two hundred and fifty"):
                // the official keys accept both, so number words (and an "and" inside a number) are the number.
                // A whole calendar date ("(the) 13(th) (of) January") is the number too (Phase 4.1C): the official
                // keys print "(the)" / "(of)" as accepted parts of a date answer.
                if (dateTokens.contains(i) || !HAS_LETTER.matcher(token).matches() || isNumberWord(token)) continue;
                if ("and".equalsIgnoreCase(stripEdges(token)) && i > 0 && i < tokens.size() - 1
                        && isNumberWord(tokens.get(i - 1)) && isNumberWord(tokens.get(i + 1))) continue;
            }
            words++;
        }
        return words;
    }

    private static final Set<String> NUMBER_WORDS = Set.of("zero", "one", "two", "three", "four", "five", "six", "seven",
            "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen",
            "nineteen", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety", "hundred", "thousand",
            "million", "billion", "half", "quarter");

    private static final Set<String> MONTHS = Set.of("january", "february", "march", "april", "may", "june", "july",
            "august", "september", "october", "november", "december", "jan", "feb", "mar", "apr", "jun", "jul", "aug",
            "sep", "sept", "oct", "nov", "dec");

    private static final Pattern DAY = Pattern.compile("(\\d{1,2})(st|nd|rd|th)?");

    private static boolean isDay(String token) {
        java.util.regex.Matcher m = DAY.matcher(stripEdges(token).toLowerCase(Locale.ROOT));
        if (!m.matches()) return false;
        int d = Integer.parseInt(m.group(1));
        return d >= 1 && d <= 31;
    }

    /**
     * Token indexes forming a calendar date: "[the] DAY[th] [of] MONTH" or "MONTH [the] DAY[th]" (mirrored by
     * {@code scripts/exam_extractor/answer_keys.py#date_token_indexes}).
     */
    static Set<Integer> dateTokenIndexes(List<String> tokens) {
        Set<Integer> out = new java.util.HashSet<>();
        List<String> low = new ArrayList<>(tokens.size());
        for (String t : tokens) low.add(stripEdges(t).toLowerCase(Locale.ROOT));
        for (int i = 0; i < low.size(); i++) {
            if (!MONTHS.contains(low.get(i))) continue;
            int j = i - 1;
            if (j >= 0 && "of".equals(low.get(j))) j--;
            if (j >= 0 && isDay(tokens.get(j))) {
                int k = j - 1 >= 0 && "the".equals(low.get(j - 1)) ? j - 1 : j;
                for (int x = k; x <= i; x++) out.add(x);
                continue;
            }
            j = i + 1;
            if (j < low.size() && "the".equals(low.get(j))) j++;
            if (j < low.size() && isDay(tokens.get(j))) {
                for (int x = i; x <= j; x++) out.add(x);
            }
        }
        return out;
    }

    private static String stripEdges(String token) {
        return LEADING_TRAILING_PUNCT_PATTERN.matcher(token).replaceAll("");
    }

    private static final Pattern ORDINAL_NUMERAL = Pattern.compile("\\d+(st|nd|rd|th)");

    /** "thirty", "thirty-five", "Hundred,", "13th" — a cardinal number word or an ordinal numeral. */
    private static boolean isNumberWord(String token) {
        String t = stripEdges(token).toLowerCase(Locale.ROOT);
        if (t.isEmpty()) return false;
        if (ORDINAL_NUMERAL.matcher(t).matches()) return true;
        for (String part : t.split("-")) {
            if (!NUMBER_WORDS.contains(part)) return false;
        }
        return true;
    }

    /**
     * Evaluates candidate response against accepted variants in answer spec.
     */
    public NormalizationResult evaluate(Object candidateAnswer, Map<String, Object> acceptedAnswers,
                                        Map<String, Object> policy, double maxCredit) {
        if (candidateAnswer == null) {
            return new NormalizationResult("", false, 0.0, null);
        }

        String raw = candidateAnswer.toString();
        String normalizedStudent = normalize(raw, policy);

        if (normalizedStudent.isBlank()) {
            return new NormalizationResult("", false, 0.0, null);
        }

        // Accepted answers can be a list of strings or single value
        List<?> variants = null;
        if (acceptedAnswers != null) {
            Object varObj = acceptedAnswers.get("variants");
            if (varObj instanceof List<?>) {
                variants = (List<?>) varObj;
            } else if (acceptedAnswers.get("exact") != null) {
                variants = List.of(acceptedAnswers.get("exact"));
            }
        }

        if (variants == null || variants.isEmpty()) {
            // If no variants defined, strict fallback
            return new NormalizationResult(normalizedStudent, false, 0.0, null);
        }

        for (Object v : variants) {
            if (v == null) continue;
            String acceptedStr = normalize(v.toString(), policy);
            if (normalizedStudent.equals(acceptedStr)) {
                return new NormalizationResult(normalizedStudent, true, maxCredit, v.toString());
            }
        }

        return new NormalizationResult(normalizedStudent, false, 0.0, null);
    }
}
