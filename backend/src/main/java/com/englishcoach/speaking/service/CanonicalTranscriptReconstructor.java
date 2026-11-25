package com.englishcoach.speaking.service;

import com.englishcoach.listening.entity.TranscriptSegment;
import com.englishcoach.speaking.entity.ShadowingTimingQuality;
import com.englishcoach.speaking.entity.ShadowingTimingStrategy;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.EnumSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Builds canonical text only from raw segment text, then maps it to independently derived timing. */
@Component
public class CanonicalTranscriptReconstructor {

    public static final int MIN_OVERLAP_TOKENS = 2;
    public static final int PLAYBACK_PADDING_MS = 75;
    public static final double WPM_ANOMALY_THRESHOLD = 300.0;
    public static final int WPM_MIN_DIAGNOSTIC_WORDS = 4;

    private static final Pattern TOKEN_PATTERN = Pattern.compile("\\S+");
    private static final Pattern NORMALIZED_TOKEN_PATTERN = Pattern.compile("[^\\p{L}\\p{N}']+");
    private static final Pattern TRAILING_CLOSERS_PATTERN = Pattern.compile("[\\\"'”’\\)\\]\\}]+$");
    private static final Pattern ACRONYM_PATTERN = Pattern.compile("(?i)(?:[a-z]\\.){2,}");
    private static final Pattern SINGLE_INITIAL_PATTERN = Pattern.compile("(?i)[a-z]\\.");
    private static final Pattern NO_SPACE_BEFORE_PATTERN = Pattern.compile("^[,.;:!?%\\)\\]\\}].*");
    private static final Pattern OPENING_PUNCTUATION_PATTERN = Pattern.compile(".*[\\(\\[\\{\\\"“‘]$");
    private static final Set<String> ALWAYS_NON_TERMINAL_ABBREVIATIONS = Set.of(
            "mr.", "mrs.", "ms.", "dr.", "prof.", "sr.", "jr.", "st.", "vs.", "e.g.", "i.e."
    );
    private static final Set<String> CONTEXTUAL_ABBREVIATIONS = Set.of(
            "etc.", "inc.", "ltd.", "co.", "corp.", "fig.", "no.", "a.m.", "p.m."
    );

    private final ShadowingTimingDeriver timingDeriver;

    public CanonicalTranscriptReconstructor() {
        this(new ShadowingTimingDeriver());
    }

    @Autowired
    public CanonicalTranscriptReconstructor(ShadowingTimingDeriver timingDeriver) {
        this.timingDeriver = timingDeriver;
    }

    public record ReconstructedUnit(
            String displayText,
            int startTimeMs,
            int endTimeMs,
            ShadowingTimingQuality timingQuality,
            ShadowingTimingStrategy timingStrategy,
            int lexicalWordCount,
            double referenceWpm,
            boolean wpmAnomaly
    ) {}

    public record ReconstructionResult(
            List<ReconstructedUnit> units,
            int inputTokenCount,
            int removedOverlapTokenCount,
            int canonicalTokenCount,
            Map<ShadowingTimingDeriver.WordTimingQuality, Long> timingQualityCounts
    ) {
        public ReconstructionResult {
            units = List.copyOf(units);
            timingQualityCounts = Map.copyOf(timingQualityCounts);
        }

        public String canonicalText() {
            return units.stream().map(ReconstructedUnit::displayText).reduce((a, b) -> a + " " + b).orElse("");
        }
    }

    private static final class CanonicalToken {
        private String surface;
        private final String normalized;
        private final int estimatedStartMs;
        private final int estimatedEndMs;
        private final ShadowingTimingQuality timingQuality;
        private final ShadowingTimingStrategy timingStrategy;

        private CanonicalToken(
                String surface,
                String normalized,
                int estimatedStartMs,
                int estimatedEndMs,
                ShadowingTimingQuality timingQuality,
                ShadowingTimingStrategy timingStrategy
        ) {
            this.surface = surface;
            this.normalized = normalized;
            this.estimatedStartMs = estimatedStartMs;
            this.estimatedEndMs = estimatedEndMs;
            this.timingQuality = timingQuality;
            this.timingStrategy = timingStrategy;
        }
    }

    private record UnitDraft(
            String displayText,
            int coreStartMs,
            int coreEndMs,
            ShadowingTimingQuality timingQuality,
            ShadowingTimingStrategy timingStrategy,
            int lexicalWordCount
    ) {}

    public ReconstructionResult reconstruct(List<TranscriptSegment> sourceSegments) {
        return reconstruct(sourceSegments, null);
    }

    public ReconstructionResult reconstruct(List<TranscriptSegment> sourceSegments, Integer mediaDurationSeconds) {
        if (sourceSegments == null || sourceSegments.isEmpty()) {
            return new ReconstructionResult(List.of(), 0, 0, 0, Map.of());
        }

        List<TranscriptSegment> sortedSegments = sourceSegments.stream()
                .filter(segment -> segment != null)
                .sorted(Comparator
                        .comparing(TranscriptSegment::getStartTimeMs, Comparator.nullsLast(Integer::compareTo))
                        .thenComparing(TranscriptSegment::getId, Comparator.nullsLast(Long::compareTo)))
                .toList();
        ShadowingTimingDeriver.TimingPlan timingPlan = timingDeriver.derive(sortedSegments, mediaDurationSeconds);

        List<CanonicalToken> canonicalTokens = new ArrayList<>();
        int inputTokenCount = 0;
        int removedOverlapTokenCount = 0;
        for (TranscriptSegment segment : sortedSegments) {
            List<String> rawTokens = tokenize(segment.getText());
            if (rawTokens.isEmpty()) {
                continue;
            }
            inputTokenCount += rawTokens.size();
            ShadowingTimingDeriver.SegmentTiming segmentTiming = timingPlan.timingFor(segment);
            List<ShadowingTimingDeriver.TokenTiming> tokenTimings = segmentTiming != null
                    ? segmentTiming.tokenTimings()
                    : List.of();
            if (tokenTimings.size() != rawTokens.size()) {
                throw new IllegalStateException("Timing/token cardinality mismatch for transcript segment " + segment.getId());
            }

            List<CanonicalToken> incoming = new ArrayList<>(rawTokens.size());
            for (int index = 0; index < rawTokens.size(); index++) {
                String surface = rawTokens.get(index);
                ShadowingTimingDeriver.TokenTiming timing = tokenTimings.get(index);
                incoming.add(new CanonicalToken(
                        surface,
                        normalizeToken(surface),
                        timing.startTimeMs(),
                        timing.endTimeMs(),
                        timing.quality(),
                        timing.strategy()
                ));
            }

            int overlap = findMaximalLexicalOverlap(canonicalTokens, incoming);
            if (overlap >= MIN_OVERLAP_TOKENS) {
                mergeOverlapPunctuation(canonicalTokens, incoming, overlap);
                removedOverlapTokenCount += overlap;
            } else {
                overlap = 0;
            }
            canonicalTokens.addAll(incoming.subList(overlap, incoming.size()));
        }

        List<UnitDraft> drafts = splitIntoSentenceDrafts(canonicalTokens, timingPlan.mediaEndMs());
        return new ReconstructionResult(
                applyPlaybackPadding(drafts, timingPlan.mediaEndMs()),
                inputTokenCount,
                removedOverlapTokenCount,
                canonicalTokens.size(),
                timingPlan.qualityCounts()
        );
    }

    public ShadowingTimingDeriver.WordTimingQuality classifyTiming(TranscriptSegment segment) {
        return timingDeriver.classifyTiming(segment);
    }

    private int findMaximalLexicalOverlap(List<CanonicalToken> canonical, List<CanonicalToken> incoming) {
        int maximum = Math.min(canonical.size(), incoming.size());
        for (int length = maximum; length >= MIN_OVERLAP_TOKENS; length--) {
            boolean matches = true;
            for (int offset = 0; offset < length; offset++) {
                String left = canonical.get(canonical.size() - length + offset).normalized;
                String right = incoming.get(offset).normalized;
                if (left.isBlank() || right.isBlank() || !left.equals(right)) {
                    matches = false;
                    break;
                }
            }
            if (matches) {
                return length;
            }
        }
        return 0;
    }

    private void mergeOverlapPunctuation(List<CanonicalToken> canonical, List<CanonicalToken> incoming, int overlap) {
        int canonicalStart = canonical.size() - overlap;
        for (int offset = 0; offset < overlap; offset++) {
            CanonicalToken existing = canonical.get(canonicalStart + offset);
            CanonicalToken duplicate = incoming.get(offset);
            if (punctuationWeight(duplicate.surface) > punctuationWeight(existing.surface)) {
                existing.surface = duplicate.surface;
            }
        }
    }

    private List<UnitDraft> splitIntoSentenceDrafts(List<CanonicalToken> tokens, int mediaEndMs) {
        if (tokens.isEmpty()) {
            return List.of();
        }
        List<UnitDraft> units = new ArrayList<>();
        int sentenceStartIndex = 0;
        int previousCoreEnd = 0;
        for (int index = 0; index < tokens.size(); index++) {
            boolean finalToken = index == tokens.size() - 1;
            if (!finalToken && !isSentenceBoundary(tokens, index)) {
                continue;
            }
            List<CanonicalToken> sentenceTokens = tokens.subList(sentenceStartIndex, index + 1);
            String displayText = detokenize(sentenceTokens);
            if (!displayText.isBlank()) {
                int start = Math.max(previousCoreEnd, sentenceTokens.get(0).estimatedStartMs);
                int end = Math.max(start + 1, sentenceTokens.get(sentenceTokens.size() - 1).estimatedEndMs);
                if (mediaEndMs > 0) {
                    start = Math.min(start, Math.max(0, mediaEndMs - 1));
                    end = Math.min(Math.max(start + 1, end), mediaEndMs);
                }
                ShadowingTimingQuality quality = sentenceTokens.stream()
                        .allMatch(token -> token.timingQuality == ShadowingTimingQuality.EXACT)
                        ? ShadowingTimingQuality.EXACT
                        : ShadowingTimingQuality.APPROXIMATE;
                EnumSet<ShadowingTimingStrategy> strategies = EnumSet.noneOf(ShadowingTimingStrategy.class);
                sentenceTokens.forEach(token -> strategies.add(token.timingStrategy));
                ShadowingTimingStrategy strategy = strategies.size() == 1
                        ? strategies.iterator().next()
                        : ShadowingTimingStrategy.MIXED_SOURCE_TIMING;
                int wordCount = (int) sentenceTokens.stream().filter(token -> !token.normalized.isBlank()).count();
                units.add(new UnitDraft(displayText, start, end, quality, strategy, wordCount));
                previousCoreEnd = end;
            }
            sentenceStartIndex = index + 1;
        }
        return units;
    }

    private List<ReconstructedUnit> applyPlaybackPadding(List<UnitDraft> drafts, int mediaEndMs) {
        if (drafts.isEmpty()) {
            return List.of();
        }
        int[] starts = drafts.stream().mapToInt(UnitDraft::coreStartMs).toArray();
        int[] ends = drafts.stream().mapToInt(UnitDraft::coreEndMs).toArray();
        starts[0] = Math.max(0, starts[0] - PLAYBACK_PADDING_MS);
        for (int index = 0; index + 1 < drafts.size(); index++) {
            int leftCoreEnd = drafts.get(index).coreEndMs();
            int rightCoreStart = drafts.get(index + 1).coreStartMs();
            int gap = Math.max(0, rightCoreStart - leftCoreEnd);
            int midpoint = leftCoreEnd + gap / 2;
            ends[index] = Math.min(leftCoreEnd + PLAYBACK_PADDING_MS, midpoint);
            starts[index + 1] = Math.max(rightCoreStart - PLAYBACK_PADDING_MS, midpoint);
        }
        int last = drafts.size() - 1;
        int paddedLastEnd = ends[last] + PLAYBACK_PADDING_MS;
        ends[last] = mediaEndMs > 0 ? Math.min(mediaEndMs, paddedLastEnd) : paddedLastEnd;

        List<ReconstructedUnit> result = new ArrayList<>(drafts.size());
        for (int index = 0; index < drafts.size(); index++) {
            UnitDraft draft = drafts.get(index);
            int start = starts[index];
            int end = Math.max(start + 1, ends[index]);
            double wpm = draft.lexicalWordCount() * 60_000.0 / Math.max(1, end - start);
            boolean anomaly = draft.lexicalWordCount() >= WPM_MIN_DIAGNOSTIC_WORDS
                    && wpm > WPM_ANOMALY_THRESHOLD;
            result.add(new ReconstructedUnit(
                    draft.displayText(), start, end, draft.timingQuality(), draft.timingStrategy(),
                    draft.lexicalWordCount(), wpm, anomaly
            ));
        }
        return result;
    }

    private boolean isSentenceBoundary(List<CanonicalToken> tokens, int index) {
        String surface = tokens.get(index).surface;
        String withoutClosers = TRAILING_CLOSERS_PATTERN.matcher(surface).replaceFirst("");
        if (withoutClosers.endsWith("?") || withoutClosers.endsWith("!")) {
            return true;
        }
        if (!withoutClosers.endsWith(".")) {
            return false;
        }
        String lower = withoutClosers.toLowerCase(Locale.ROOT);
        if (ALWAYS_NON_TERMINAL_ABBREVIATIONS.contains(lower)
                || ACRONYM_PATTERN.matcher(withoutClosers).matches()
                || SINGLE_INITIAL_PATTERN.matcher(withoutClosers).matches()) {
            return false;
        }
        return !CONTEXTUAL_ABBREVIATIONS.contains(lower)
                || index + 1 >= tokens.size()
                || !startsWithLowercaseLetter(tokens.get(index + 1).surface);
    }

    private boolean startsWithLowercaseLetter(String token) {
        if (token == null) {
            return false;
        }
        for (int index = 0; index < token.length(); index++) {
            char character = token.charAt(index);
            if (Character.isLetter(character)) {
                return Character.isLowerCase(character);
            }
        }
        return false;
    }

    private String detokenize(List<CanonicalToken> tokens) {
        StringBuilder result = new StringBuilder();
        String previous = "";
        for (CanonicalToken token : tokens) {
            String current = token.surface.trim();
            if (current.isBlank()) {
                continue;
            }
            if (!result.isEmpty()
                    && !NO_SPACE_BEFORE_PATTERN.matcher(current).matches()
                    && !OPENING_PUNCTUATION_PATTERN.matcher(previous).matches()) {
                result.append(' ');
            }
            result.append(current);
            previous = current;
        }
        return result.toString().trim();
    }

    private List<String> tokenize(String text) {
        if (text == null || text.isBlank()) {
            return List.of();
        }
        List<String> tokens = new ArrayList<>();
        Matcher matcher = TOKEN_PATTERN.matcher(text.trim());
        while (matcher.find()) {
            tokens.add(matcher.group());
        }
        return tokens;
    }

    private String normalizeToken(String token) {
        return token == null
                ? ""
                : NORMALIZED_TOKEN_PATTERN.matcher(token.toLowerCase(Locale.ROOT)).replaceAll("");
    }

    private int punctuationWeight(String token) {
        return token == null ? 0 : token.replaceAll("[\\p{L}\\p{N}']", "").length();
    }
}
