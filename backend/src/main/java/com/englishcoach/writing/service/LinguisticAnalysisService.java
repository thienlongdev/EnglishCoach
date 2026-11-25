package com.englishcoach.writing.service;

import lombok.Builder;
import lombok.Getter;
import lombok.extern.slf4j.Slf4j;
import org.languagetool.AnalyzedSentence;
import org.languagetool.AnalyzedToken;
import org.languagetool.AnalyzedTokenReadings;
import org.languagetool.JLanguageTool;
import org.languagetool.synthesis.Synthesizer;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.util.*;

/**
 * Generic Linguistic Analysis & Morphology Service powered by LanguageTool 6.4.
 * Eliminates all handwritten lexical morphology maps in favor of POS/lemma/morphological readings.
 */
@Slf4j
@Service
public class LinguisticAnalysisService {

    private final LanguageToolGrammarService languageToolGrammarService;

    public LinguisticAnalysisService(LanguageToolGrammarService languageToolGrammarService) {
        this.languageToolGrammarService = languageToolGrammarService;
    }

    @Getter
    @Builder
    public static class TokenAnalysis {
        private final String token;
        private final int startPos;
        private final int endPos;
        private final String lemma;
        private final String primaryPos;
        private final Set<String> posTags;

        public boolean isVerb() {
            return posTags.stream().anyMatch(p -> p.startsWith("VB") || p.equals("MD"));
        }

        public boolean isPastTenseVerb() {
            return posTags.contains("VBD");
        }

        public boolean isThirdPersonSingularVerb() {
            return posTags.contains("VBZ");
        }

        public boolean isBaseVerb() {
            return posTags.contains("VB") || posTags.contains("VBP");
        }

        public boolean isPresentParticiple() {
            return posTags.contains("VBG");
        }

        public boolean isPastParticiple() {
            return posTags.contains("VBN");
        }

        public boolean isModal() {
            return posTags.contains("MD");
        }

        public boolean isNoun() {
            return posTags.stream().anyMatch(p -> p.startsWith("NN"));
        }

        public boolean isPluralNoun() {
            return posTags.contains("NNS") || posTags.contains("NNPS");
        }

        public boolean isSingularNoun() {
            return posTags.contains("NN") || posTags.contains("NNP");
        }

        public boolean isDeterminer() {
            return posTags.contains("DT");
        }

        public boolean isPersonalPronoun() {
            return posTags.stream().anyMatch(p -> p.startsWith("PRP"));
        }

        public boolean isCoordinatingConjunction() {
            return posTags.contains("CC");
        }
    }

    /**
     * Analyze sentence text into generic linguistic tokens with lemma and POS readings.
     */
    public List<TokenAnalysis> analyzeSentence(String text) {
        if (text == null || text.isBlank() || languageToolGrammarService == null) {
            return Collections.emptyList();
        }

        try {
            AnalyzedSentence sentence = languageToolGrammarService.getAnalyzedSentence(text);
            if (sentence == null) {
                return Collections.emptyList();
            }

            List<TokenAnalysis> tokens = new ArrayList<>();
            for (AnalyzedTokenReadings tr : sentence.getTokensWithoutWhitespace()) {
                String tokenStr = tr.getToken();
                if (tokenStr == null || tokenStr.isEmpty() || tr.hasPosTag("SENT_START") || tr.hasPosTag("SENT_END")) {
                    continue;
                }

                Set<String> posSet = new HashSet<>();
                String selectedLemma = null;
                String primaryPos = null;

                for (AnalyzedToken reading : tr.getReadings()) {
                    String pos = reading.getPOSTag();
                    if (pos != null) {
                        posSet.add(pos);
                        if (primaryPos == null) {
                            primaryPos = pos;
                        }
                    }
                    if (selectedLemma == null && reading.getLemma() != null) {
                        selectedLemma = reading.getLemma();
                    }
                }

                tokens.add(TokenAnalysis.builder()
                        .token(tokenStr)
                        .startPos(tr.getStartPos())
                        .endPos(tr.getEndPos())
                        .lemma(selectedLemma != null ? selectedLemma : tokenStr)
                        .primaryPos(primaryPos != null ? primaryPos : "")
                        .posTags(posSet)
                        .build());
            }

            return tokens;
        } catch (IOException e) {
            log.error("[LinguisticAnalysis] Error analyzing sentence: {}", e.getMessage(), e);
            return Collections.emptyList();
        }
    }

    /**
     * Resolve base form (lemma / infinitive) of an inflected verb.
     */
    public String toBaseVerb(String word) {
        if (word == null || word.isBlank()) return word;
        String clean = word.trim();

        String lemma = resolveLemmaForPos(clean, "VB");
        if (lemma != null) {
            String synthesized = synthesize(lemma, "VB");
            if (synthesized != null && !synthesized.isBlank()) {
                return synthesized;
            }
            return lemma;
        }

        // Conservative regular fallback
        return fallbackRegularBaseVerb(clean);
    }

    /**
     * Resolve 3rd person singular present form (e.g. writes, goes, likes, watches).
     */
    public String toThirdPersonSingularVerb(String word) {
        if (word == null || word.isBlank()) return word;
        String clean = word.trim();

        String lemma = resolveLemmaForPos(clean, "VB");
        String base = lemma != null ? lemma : toBaseVerb(clean);

        String synthesized = synthesize(base, "VBZ");
        if (synthesized != null && !synthesized.isBlank()) {
            return synthesized;
        }

        return fallbackRegular3rdPerson(base);
    }

    /**
     * Resolve past tense form (e.g. went, saw, played, worked, wrote).
     */
    public String toPastTenseVerb(String word) {
        if (word == null || word.isBlank()) return word;
        String clean = word.trim();

        String lemma = resolveLemmaForPos(clean, "VB");
        String base = lemma != null ? lemma : toBaseVerb(clean);

        String synthesized = synthesize(base, "VBD");
        if (synthesized != null && !synthesized.isBlank()) {
            return synthesized;
        }

        return fallbackRegularPast(base);
    }

    /**
     * Resolve present participle / gerund (V-ing, e.g. going, eating, studying).
     */
    public String toPresentParticiple(String word) {
        if (word == null || word.isBlank()) return word;
        String clean = word.trim();

        String lemma = resolveLemmaForPos(clean, "VB");
        String base = lemma != null ? lemma : toBaseVerb(clean);

        String synthesized = synthesize(base, "VBG");
        if (synthesized != null && !synthesized.isBlank()) {
            return synthesized;
        }

        return fallbackRegularPresentParticiple(base);
    }

    /**
     * Resolve past participle form (VBN, e.g. gone, seen, written, eaten, played).
     */
    public String toPastParticiple(String word) {
        if (word == null || word.isBlank()) return word;
        String clean = word.trim();

        String lemma = resolveLemmaForPos(clean, "VB");
        String base = lemma != null ? lemma : toBaseVerb(clean);

        String synthesized = synthesize(base, "VBN");
        if (synthesized != null && !synthesized.isBlank()) {
            return synthesized;
        }

        return fallbackRegularPast(base);
    }

    /**
     * Resolve plural noun form (e.g. books, students, children, people, cars).
     */
    public String toPluralNoun(String word) {
        if (word == null || word.isBlank()) return word;
        String clean = word.trim();

        String lemma = resolveLemmaForPos(clean, "NN");
        String base = lemma != null ? lemma : clean;

        String synthesized = synthesize(base, "NNS");
        if (synthesized != null && !synthesized.isBlank()) {
            return synthesized;
        }

        return fallbackRegularPluralNoun(base);
    }

    /**
     * Resolve singular noun form (e.g. book, child, person, friend).
     */
    public String toSingularNoun(String word) {
        if (word == null || word.isBlank()) return word;
        String clean = word.trim();

        String lemma = resolveLemmaForPos(clean, "NN");
        if (lemma != null && !lemma.isBlank()) {
            return lemma;
        }

        String synthesized = synthesize(clean, "NN");
        if (synthesized != null && !synthesized.isBlank()) {
            return synthesized;
        }

        return fallbackRegularSingularNoun(clean);
    }

    // =========================================================================
    // Internal Linguistic Helpers
    // =========================================================================

    private String resolveLemmaForPos(String word, String targetCategory) {
        if (languageToolGrammarService == null) return null;
        try {
            AnalyzedSentence sent = languageToolGrammarService.getAnalyzedSentence(word);
            if (sent == null) return null;

            AnalyzedTokenReadings[] tokens = sent.getTokensWithoutWhitespace();
            if (tokens == null || tokens.length < 2) return null;

            AnalyzedTokenReadings tr = tokens[1];
            // 1. Reading for target category where lemma differs from surface token (inflected form)
            for (AnalyzedToken r : tr.getReadings()) {
                if (r.getPOSTag() != null && r.getPOSTag().startsWith(targetCategory) && r.getLemma() != null
                        && !r.getLemma().equalsIgnoreCase(word)) {
                    return r.getLemma();
                }
            }
            // 2. Any reading where lemma differs from surface token
            for (AnalyzedToken r : tr.getReadings()) {
                if (r.getLemma() != null && !r.getLemma().isBlank() && !r.getLemma().equalsIgnoreCase(word)) {
                    return r.getLemma();
                }
            }
            // 3. Exact target category match
            for (AnalyzedToken r : tr.getReadings()) {
                if (r.getPOSTag() != null && r.getPOSTag().startsWith(targetCategory) && r.getLemma() != null) {
                    return r.getLemma();
                }
            }
            // 4. Any valid lemma
            for (AnalyzedToken r : tr.getReadings()) {
                if (r.getLemma() != null && !r.getLemma().isBlank()) {
                    return r.getLemma();
                }
            }
        } catch (Exception e) {
            log.warn("[LinguisticAnalysis] Failed to resolve lemma for word '{}': {}", word, e.getMessage());
        }
        return null;
    }

    private String synthesize(String lemma, String targetPosTag) {
        if (languageToolGrammarService == null || lemma == null || lemma.isBlank()) return null;
        try {
            JLanguageTool lt = languageToolGrammarService.getLanguageTool();
            if (lt == null || lt.getLanguage() == null) return null;

            Synthesizer synth = lt.getLanguage().getSynthesizer();
            if (synth == null) return null;

            String[] forms = synth.synthesize(new AnalyzedToken(lemma, targetPosTag, lemma), targetPosTag);
            if (forms != null && forms.length > 0) {
                if (forms.length > 1 && "NNS".equals(targetPosTag)) {
                    for (String f : forms) {
                        if ("people".equalsIgnoreCase(f)) return f;
                    }
                }
                return forms[0];
            }
        } catch (Exception e) {
            log.warn("[LinguisticAnalysis] Failed to synthesize lemma '{}' to tag '{}': {}", lemma, targetPosTag, e.getMessage());
        }
        return null;
    }

    // =========================================================================
    // Generic Algorithmic Fallbacks for Regular English Morphology
    // (Zero vocabulary-specific hardcoding; pure rule-based suffix transformations)
    // =========================================================================

    private String fallbackRegularBaseVerb(String word) {
        String lower = word.toLowerCase();
        if (lower.endsWith("ies") && lower.length() > 3) {
            return word.substring(0, word.length() - 3) + "y";
        }
        if (lower.endsWith("es") && (lower.endsWith("sses") || lower.endsWith("shes") || lower.endsWith("ches") || lower.endsWith("xes") || lower.endsWith("zes"))) {
            return word.substring(0, word.length() - 2);
        }
        if (lower.endsWith("s") && !lower.endsWith("ss") && lower.length() > 2) {
            return word.substring(0, word.length() - 1);
        }
        if (lower.endsWith("ied") && lower.length() > 3) {
            return word.substring(0, word.length() - 3) + "y";
        }
        if (lower.endsWith("ed") && lower.length() > 3) {
            if (lower.endsWith("eed")) return word.substring(0, word.length() - 1);
            return word.substring(0, word.length() - 2);
        }
        if (lower.endsWith("ing") && lower.length() > 4) {
            return word.substring(0, word.length() - 3);
        }
        return word;
    }

    private String fallbackRegular3rdPerson(String base) {
        String lower = base.toLowerCase();
        if (lower.endsWith("s") || lower.endsWith("sh") || lower.endsWith("ch") || lower.endsWith("x") || lower.endsWith("z") || lower.endsWith("o")) {
            return base + "es";
        }
        if (lower.endsWith("y") && lower.length() > 1 && !isVowel(lower.charAt(lower.length() - 2))) {
            return base.substring(0, base.length() - 1) + "ies";
        }
        return base + "s";
    }

    private String fallbackRegularPast(String base) {
        String lower = base.toLowerCase();
        if (lower.endsWith("e")) {
            return base + "d";
        }
        if (lower.endsWith("y") && lower.length() > 1 && !isVowel(lower.charAt(lower.length() - 2))) {
            return base.substring(0, base.length() - 1) + "ied";
        }
        return base + "ed";
    }

    private String fallbackRegularPresentParticiple(String base) {
        String lower = base.toLowerCase();
        if (lower.endsWith("ie") && lower.length() > 2) {
            return base.substring(0, base.length() - 2) + "ying";
        }
        if (lower.endsWith("e") && !lower.endsWith("ee") && lower.length() > 2) {
            return base.substring(0, base.length() - 1) + "ing";
        }
        return base + "ing";
    }

    private String fallbackRegularPluralNoun(String base) {
        String lower = base.toLowerCase();
        if (lower.endsWith("s") || lower.endsWith("sh") || lower.endsWith("ch") || lower.endsWith("x") || lower.endsWith("z")) {
            return base + "es";
        }
        if (lower.endsWith("y") && lower.length() > 1 && !isVowel(lower.charAt(lower.length() - 2))) {
            return base.substring(0, base.length() - 1) + "ies";
        }
        return base + "s";
    }

    private String fallbackRegularSingularNoun(String plural) {
        String lower = plural.toLowerCase();
        if (lower.endsWith("ies") && lower.length() > 3) {
            return plural.substring(0, plural.length() - 3) + "y";
        }
        if (lower.endsWith("es") && lower.length() > 3) {
            return plural.substring(0, plural.length() - 2);
        }
        if (lower.endsWith("s") && !lower.endsWith("ss") && lower.length() > 2) {
            return plural.substring(0, plural.length() - 1);
        }
        return plural;
    }

    private boolean isVowel(char c) {
        char l = Character.toLowerCase(c);
        return l == 'a' || l == 'e' || l == 'i' || l == 'o' || l == 'u';
    }
}
