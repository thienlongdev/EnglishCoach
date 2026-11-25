package com.englishcoach.kingofenglish;

import java.text.Normalizer;
import java.util.Locale;
import java.util.regex.Pattern;

/** Conservative obvious-hint checks, not semantic moderation or language detection. */
final class KingCluePolicy {
    private KingCluePolicy() {}
    private static final Pattern SPELLING = Pattern.compile(
        "\\b(?:starts?|begins?|ends?)\\s+with\\b|" +
        "\\b(?:first|last|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\\d+(?:st|nd|rd|th)?)\\s+(?:letter|character)\\b|" +
        "\\b(?:letter|character)\\s+(?:number\\s+)?\\d+\\s+(?:is|equals?)\\b|" +
        "\\b(?:has|contains?|with|of)\\s+(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen)\\s+(?:letters?|characters?)\\b|" +
        "\\b(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\\s*[- ]\\s*letter\\s+word\\b|" +
        "\\b(?:spell(?:ed|ing)?|rhymes?\\s+with)\\b", Pattern.CASE_INSENSITIVE);
    private static final Pattern VI_ACCENT = Pattern.compile("[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệịỉĩọỏốồổỗộớờởỡợụủũứừửữựỳỵỷỹ]");
    private static final Pattern VI_WORD = Pattern.compile("\\b(?:là|của|những|một|và|không|được|trong|người|này|với)\\b");
    static String violation(String clue) {
        String text = Normalizer.normalize(clue, Normalizer.Form.NFKC).toLowerCase(Locale.ROOT);
        if (SPELLING.matcher(text).find()) return "SPELLING_HINT";
        // Two Vietnamese function words plus Vietnamese-specific letters. Uncertain
        // unaccented text/names/borrowed words are allowed; English-only stays policy.
        var matcher = VI_WORD.matcher(text); int signals = 0;
        while (matcher.find()) signals++;
        if (signals >= 2 && VI_ACCENT.matcher(text).find()) return "ENGLISH_ONLY";
        return null;
    }
}
