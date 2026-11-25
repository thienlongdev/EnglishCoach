package com.englishcoach.speaking.service;

import com.englishcoach.listening.entity.TranscriptSegment;
import com.englishcoach.speaking.entity.ShadowingTimingQuality;
import com.englishcoach.speaking.entity.ShadowingTimingStrategy;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.EnumMap;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Converts caption display windows into lexical speech intervals. Synthetic word
 * interpolation is classified for provenance but is never treated as acoustic truth.
 */
@Component
public class ShadowingTimingDeriver {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Pattern NORMALIZED_TOKEN_PATTERN = Pattern.compile("[^\\p{L}\\p{N}']+");

    public enum WordTimingQuality {
        SYNTHETIC_WORD_TIMING,
        REAL_WORD_TIMING,
        MISSING_OR_INVALID_WORD_TIMING
    }

    public record EffectiveLexicalInterval(int startTimeMs, int endTimeMs) {}

    public record TokenTiming(
            int startTimeMs,
            int endTimeMs,
            ShadowingTimingQuality quality,
            ShadowingTimingStrategy strategy
    ) {}

    public record SegmentTiming(
            WordTimingQuality wordTimingQuality,
            EffectiveLexicalInterval effectiveInterval,
            List<TokenTiming> tokenTimings
    ) {
        public SegmentTiming {
            tokenTimings = List.copyOf(tokenTimings);
        }
    }

    public static final class TimingPlan {
        private final IdentityHashMap<TranscriptSegment, SegmentTiming> timings;
        private final Map<WordTimingQuality, Long> qualityCounts;
        private final int mediaEndMs;

        private TimingPlan(
                IdentityHashMap<TranscriptSegment, SegmentTiming> timings,
                Map<WordTimingQuality, Long> qualityCounts,
                int mediaEndMs
        ) {
            this.timings = timings;
            this.qualityCounts = Map.copyOf(qualityCounts);
            this.mediaEndMs = mediaEndMs;
        }

        public SegmentTiming timingFor(TranscriptSegment segment) {
            return timings.get(segment);
        }

        public Map<WordTimingQuality, Long> qualityCounts() {
            return qualityCounts;
        }

        public int mediaEndMs() {
            return mediaEndMs;
        }
    }

    private record ParsedAlignment(WordTimingQuality quality, List<TokenTiming> timings) {}

    public TimingPlan derive(List<TranscriptSegment> sortedSegments, Integer durationSeconds) {
        if (sortedSegments == null || sortedSegments.isEmpty()) {
            return new TimingPlan(new IdentityHashMap<>(), Map.of(), 0);
        }

        int mediaEndMs = resolveMediaEnd(sortedSegments, durationSeconds);
        IdentityHashMap<TranscriptSegment, ParsedAlignment> parsed = new IdentityHashMap<>();
        EnumMap<WordTimingQuality, Long> qualityCounts = new EnumMap<>(WordTimingQuality.class);
        for (TranscriptSegment segment : sortedSegments) {
            ParsedAlignment alignment = parseAlignment(segment, mediaEndMs);
            parsed.put(segment, alignment);
            qualityCounts.merge(alignment.quality(), 1L, Long::sum);
        }

        List<List<TranscriptSegment>> regions = partitionRegions(sortedSegments);
        IdentityHashMap<TranscriptSegment, SegmentTiming> result = new IdentityHashMap<>();
        int previousEnd = 0;
        for (List<TranscriptSegment> region : regions) {
            int medianHop = positiveMedianHop(region);
            int medianWindow = positiveMedianWindow(region);
            boolean rolling = isRollingRegion(region, medianHop, medianWindow);

            for (int index = 0; index < region.size(); index++) {
                TranscriptSegment segment = region.get(index);
                List<String> rawTokens = tokenize(segment.getText());
                ParsedAlignment alignment = parsed.get(segment);
                if (alignment.quality() == WordTimingQuality.REAL_WORD_TIMING
                        && alignment.timings().size() == rawTokens.size()) {
                    List<TokenTiming> exact = enforceMonotonic(alignment.timings(), previousEnd, mediaEndMs);
                    EffectiveLexicalInterval interval = exact.isEmpty()
                            ? new EffectiveLexicalInterval(previousEnd, previousEnd)
                            : new EffectiveLexicalInterval(
                                    exact.get(0).startTimeMs(),
                                    exact.get(exact.size() - 1).endTimeMs()
                            );
                    result.put(segment, new SegmentTiming(alignment.quality(), interval, exact));
                    if (!exact.isEmpty()) {
                        previousEnd = exact.get(exact.size() - 1).endTimeMs();
                    }
                    continue;
                }

                ShadowingTimingStrategy strategy;
                EffectiveLexicalInterval interval;
                if (hasValidStart(segment) && rolling) {
                    strategy = ShadowingTimingStrategy.ROLLING_CAPTION_HOPS;
                    interval = rollingInterval(region, index, medianHop, mediaEndMs);
                } else if (hasValidWindow(segment)) {
                    strategy = ShadowingTimingStrategy.DISCRETE_CAPTION_WINDOWS;
                    interval = boundedInterval(segment.getStartTimeMs(), segment.getEndTimeMs(), mediaEndMs);
                } else {
                    strategy = ShadowingTimingStrategy.FALLBACK_INTERPOLATION;
                    interval = fallbackInterval(segment, previousEnd, medianHop, medianWindow, mediaEndMs);
                }

                int start = Math.max(previousEnd, interval.startTimeMs());
                int end = Math.max(start, interval.endTimeMs());
                if (mediaEndMs > 0) {
                    start = Math.min(start, mediaEndMs);
                    end = Math.min(Math.max(start, end), mediaEndMs);
                }
                EffectiveLexicalInterval monotonicInterval = new EffectiveLexicalInterval(start, end);
                List<TokenTiming> tokenTimings = interpolate(rawTokens.size(), monotonicInterval, strategy);
                result.put(segment, new SegmentTiming(alignment.quality(), monotonicInterval, tokenTimings));
                if (!tokenTimings.isEmpty()) {
                    previousEnd = tokenTimings.get(tokenTimings.size() - 1).endTimeMs();
                }
            }
        }

        return new TimingPlan(result, qualityCounts, mediaEndMs);
    }

    public WordTimingQuality classifyTiming(TranscriptSegment segment) {
        return parseAlignment(segment, resolveMediaEnd(List.of(segment), null)).quality();
    }

    private ParsedAlignment parseAlignment(TranscriptSegment segment, int mediaEndMs) {
        List<String> rawTokens = tokenize(segment != null ? segment.getText() : null);
        if (segment == null || segment.getWordsJson() == null || segment.getWordsJson().isBlank()
                || rawTokens.isEmpty()) {
            return new ParsedAlignment(WordTimingQuality.MISSING_OR_INVALID_WORD_TIMING, List.of());
        }

        try {
            List<Map<String, Object>> words = MAPPER.readValue(
                    segment.getWordsJson(),
                    new TypeReference<List<Map<String, Object>>>() {}
            );
            if (words.size() != rawTokens.size() || words.size() < 2) {
                return new ParsedAlignment(WordTimingQuality.MISSING_OR_INVALID_WORD_TIMING, List.of());
            }

            List<Double> starts = new ArrayList<>();
            List<Double> ends = new ArrayList<>();
            for (int index = 0; index < words.size(); index++) {
                Map<String, Object> word = words.get(index);
                if (!normalize(String.valueOf(word.get("word"))).equals(normalize(rawTokens.get(index)))) {
                    return new ParsedAlignment(WordTimingQuality.MISSING_OR_INVALID_WORD_TIMING, List.of());
                }
                Double start = finiteDouble(word.get("start"));
                Double end = finiteDouble(word.get("end"));
                if (start == null || end == null || end <= start) {
                    return new ParsedAlignment(WordTimingQuality.MISSING_OR_INVALID_WORD_TIMING, List.of());
                }
                starts.add(start);
                ends.add(end);
            }

            double scale = timestampScale(segment, starts.get(0), ends.get(ends.size() - 1));
            List<Integer> startMs = starts.stream().map(value -> safeInt(Math.round(value * scale))).toList();
            List<Integer> endMs = ends.stream().map(value -> safeInt(Math.round(value * scale))).toList();
            for (int index = 0; index < startMs.size(); index++) {
                if (index > 0 && startMs.get(index) < endMs.get(index - 1)) {
                    return new ParsedAlignment(WordTimingQuality.MISSING_OR_INVALID_WORD_TIMING, List.of());
                }
                if (endMs.get(index) <= startMs.get(index)) {
                    return new ParsedAlignment(WordTimingQuality.MISSING_OR_INVALID_WORD_TIMING, List.of());
                }
            }

            boolean synthetic = isUniformInterpolation(segment, startMs, endMs);
            if (synthetic) {
                return new ParsedAlignment(WordTimingQuality.SYNTHETIC_WORD_TIMING, List.of());
            }

            List<TokenTiming> timings = new ArrayList<>(startMs.size());
            for (int index = 0; index < startMs.size(); index++) {
                int start = bound(startMs.get(index), mediaEndMs);
                int end = bound(endMs.get(index), mediaEndMs);
                if (end <= start) {
                    return new ParsedAlignment(WordTimingQuality.MISSING_OR_INVALID_WORD_TIMING, List.of());
                }
                timings.add(new TokenTiming(
                        start,
                        end,
                        ShadowingTimingQuality.EXACT,
                        ShadowingTimingStrategy.EXACT_WORD_ALIGNMENT
                ));
            }
            return new ParsedAlignment(WordTimingQuality.REAL_WORD_TIMING, timings);
        } catch (Exception ignored) {
            return new ParsedAlignment(WordTimingQuality.MISSING_OR_INVALID_WORD_TIMING, List.of());
        }
    }

    private boolean isUniformInterpolation(TranscriptSegment segment, List<Integer> starts, List<Integer> ends) {
        List<Integer> durations = new ArrayList<>();
        List<Integer> steps = new ArrayList<>();
        int maxGap = 0;
        for (int index = 0; index < starts.size(); index++) {
            durations.add(ends.get(index) - starts.get(index));
            if (index > 0) {
                steps.add(starts.get(index) - starts.get(index - 1));
                maxGap = Math.max(maxGap, Math.abs(starts.get(index) - ends.get(index - 1)));
            }
        }
        int medianDuration = median(durations);
        int durationTolerance = Math.max(20, (int) Math.round(Math.abs(medianDuration) * 0.08));
        int stepTolerance = Math.max(20, (int) Math.round(Math.abs(medianDuration) * 0.10));
        boolean uniformDurations = spread(durations) <= durationTolerance;
        boolean uniformSteps = spread(steps) <= stepTolerance;
        boolean contiguous = maxGap <= durationTolerance;
        boolean coversWindow = hasValidWindow(segment)
                && Math.abs(starts.get(0) - segment.getStartTimeMs())
                + Math.abs(ends.get(ends.size() - 1) - segment.getEndTimeMs())
                <= Math.max(100, (segment.getEndTimeMs() - segment.getStartTimeMs()) / 20);
        return uniformDurations && uniformSteps && contiguous && coversWindow;
    }

    private List<List<TranscriptSegment>> partitionRegions(List<TranscriptSegment> segments) {
        int globalMedianHop = positiveMedianHop(segments);
        List<List<TranscriptSegment>> regions = new ArrayList<>();
        List<TranscriptSegment> current = new ArrayList<>();
        for (TranscriptSegment segment : segments) {
            if (!current.isEmpty() && globalMedianHop > 0) {
                TranscriptSegment previous = current.get(current.size() - 1);
                if (hasValidStart(previous) && hasValidStart(segment)
                        && (long) segment.getStartTimeMs() - previous.getStartTimeMs() > 3L * globalMedianHop) {
                    regions.add(List.copyOf(current));
                    current.clear();
                }
            }
            current.add(segment);
        }
        if (!current.isEmpty()) {
            regions.add(List.copyOf(current));
        }
        return regions;
    }

    private boolean isRollingRegion(List<TranscriptSegment> region, int medianHop, int medianWindow) {
        int pairs = 0;
        int overlaps = 0;
        for (int index = 0; index + 1 < region.size(); index++) {
            TranscriptSegment current = region.get(index);
            TranscriptSegment next = region.get(index + 1);
            if (!hasValidWindow(current) || !hasValidStart(next)) {
                continue;
            }
            pairs++;
            if (next.getStartTimeMs() < current.getEndTimeMs()) {
                overlaps++;
            }
        }
        return pairs > 0 && overlaps * 2 >= pairs && medianHop > 0 && medianHop < medianWindow;
    }

    private EffectiveLexicalInterval rollingInterval(
            List<TranscriptSegment> region,
            int index,
            int medianHop,
            int mediaEndMs
    ) {
        TranscriptSegment segment = region.get(index);
        int start = Math.max(0, segment.getStartTimeMs());
        int end;
        if (index + 1 < region.size() && hasValidStart(region.get(index + 1))
                && region.get(index + 1).getStartTimeMs() > start) {
            end = region.get(index + 1).getStartTimeMs();
        } else {
            int fallbackHop = medianHop > 0 ? medianHop : positiveWindow(segment);
            end = safeInt((long) start + Math.max(1, fallbackHop));
            if (segment.getEndTimeMs() != null && segment.getEndTimeMs() > start) {
                end = Math.min(end, segment.getEndTimeMs());
            }
        }
        return boundedInterval(start, end, mediaEndMs);
    }

    private EffectiveLexicalInterval fallbackInterval(
            TranscriptSegment segment,
            int previousEnd,
            int medianHop,
            int medianWindow,
            int mediaEndMs
    ) {
        int start = hasValidStart(segment) ? segment.getStartTimeMs() : previousEnd;
        int derivedSpan = medianHop > 0 ? medianHop : medianWindow;
        if (derivedSpan <= 0) {
            derivedSpan = positiveWindow(segment);
        }
        int end = safeInt((long) Math.max(0, start) + Math.max(1, derivedSpan));
        if (segment != null && segment.getEndTimeMs() != null && segment.getEndTimeMs() > start) {
            end = Math.min(end, segment.getEndTimeMs());
        }
        return boundedInterval(start, end, mediaEndMs);
    }

    private List<TokenTiming> interpolate(
            int tokenCount,
            EffectiveLexicalInterval interval,
            ShadowingTimingStrategy strategy
    ) {
        if (tokenCount == 0) {
            return List.of();
        }
        long duration = Math.max(0, (long) interval.endTimeMs() - interval.startTimeMs());
        List<TokenTiming> timings = new ArrayList<>(tokenCount);
        int previousEnd = interval.startTimeMs();
        for (int index = 0; index < tokenCount; index++) {
            int start = Math.max(previousEnd, safeInt(interval.startTimeMs() + Math.round(duration * index / (double) tokenCount)));
            int end = safeInt(interval.startTimeMs() + Math.round(duration * (index + 1) / (double) tokenCount));
            if (end <= start) {
                end = start + 1;
            }
            timings.add(new TokenTiming(start, end, ShadowingTimingQuality.APPROXIMATE, strategy));
            previousEnd = end;
        }
        return timings;
    }

    private List<TokenTiming> enforceMonotonic(List<TokenTiming> source, int previousEnd, int mediaEndMs) {
        List<TokenTiming> result = new ArrayList<>(source.size());
        int cursor = previousEnd;
        for (TokenTiming timing : source) {
            int start = Math.max(cursor, timing.startTimeMs());
            int end = Math.max(start + 1, timing.endTimeMs());
            if (mediaEndMs > 0) {
                start = Math.min(start, Math.max(0, mediaEndMs - 1));
                end = Math.min(Math.max(start + 1, end), mediaEndMs);
            }
            boolean adjusted = start != timing.startTimeMs() || end != timing.endTimeMs();
            result.add(new TokenTiming(
                    start,
                    end,
                    adjusted ? ShadowingTimingQuality.APPROXIMATE : timing.quality(),
                    adjusted ? ShadowingTimingStrategy.MIXED_SOURCE_TIMING : timing.strategy()
            ));
            cursor = end;
        }
        return result;
    }

    private int resolveMediaEnd(List<TranscriptSegment> segments, Integer durationSeconds) {
        if (durationSeconds != null && durationSeconds > 0) {
            return safeInt(durationSeconds.longValue() * 1000L);
        }
        return segments.stream()
                .filter(segment -> segment != null && segment.getEndTimeMs() != null)
                .mapToInt(TranscriptSegment::getEndTimeMs)
                .max()
                .orElse(0);
    }

    private int positiveMedianHop(List<TranscriptSegment> segments) {
        List<Integer> hops = new ArrayList<>();
        for (int index = 0; index + 1 < segments.size(); index++) {
            if (hasValidStart(segments.get(index)) && hasValidStart(segments.get(index + 1))) {
                int hop = segments.get(index + 1).getStartTimeMs() - segments.get(index).getStartTimeMs();
                if (hop > 0) {
                    hops.add(hop);
                }
            }
        }
        return median(hops);
    }

    private int positiveMedianWindow(List<TranscriptSegment> segments) {
        return median(segments.stream().map(this::positiveWindow).filter(value -> value > 0).toList());
    }

    private int positiveWindow(TranscriptSegment segment) {
        return hasValidWindow(segment) ? segment.getEndTimeMs() - segment.getStartTimeMs() : 0;
    }

    private EffectiveLexicalInterval boundedInterval(int start, int end, int mediaEndMs) {
        int boundedStart = Math.max(0, start);
        int boundedEnd = Math.max(boundedStart, end);
        if (mediaEndMs > 0) {
            boundedStart = Math.min(boundedStart, mediaEndMs);
            boundedEnd = Math.min(boundedEnd, mediaEndMs);
        }
        return new EffectiveLexicalInterval(boundedStart, Math.max(boundedStart, boundedEnd));
    }

    private boolean hasValidStart(TranscriptSegment segment) {
        return segment != null && segment.getStartTimeMs() != null && segment.getStartTimeMs() >= 0;
    }

    private boolean hasValidWindow(TranscriptSegment segment) {
        return hasValidStart(segment) && segment.getEndTimeMs() != null
                && segment.getEndTimeMs() > segment.getStartTimeMs();
    }

    private double timestampScale(TranscriptSegment segment, double firstStart, double lastEnd) {
        if (!hasValidWindow(segment)) {
            return 1000.0;
        }
        double secondsError = Math.abs(firstStart * 1000.0 - segment.getStartTimeMs())
                + Math.abs(lastEnd * 1000.0 - segment.getEndTimeMs());
        double millisecondsError = Math.abs(firstStart - segment.getStartTimeMs())
                + Math.abs(lastEnd - segment.getEndTimeMs());
        return secondsError <= millisecondsError ? 1000.0 : 1.0;
    }

    private Double finiteDouble(Object value) {
        if (value == null) {
            return null;
        }
        try {
            double parsed = value instanceof Number number
                    ? number.doubleValue()
                    : Double.parseDouble(String.valueOf(value));
            return Double.isFinite(parsed) ? parsed : null;
        } catch (RuntimeException ignored) {
            return null;
        }
    }

    private List<String> tokenize(String text) {
        return text == null || text.isBlank() ? List.of() : List.of(text.trim().split("\\s+"));
    }

    private String normalize(String token) {
        if (token == null || "null".equals(token)) {
            return "";
        }
        return NORMALIZED_TOKEN_PATTERN.matcher(token.toLowerCase(Locale.ROOT)).replaceAll("");
    }

    private int median(List<Integer> values) {
        if (values.isEmpty()) {
            return 0;
        }
        List<Integer> sorted = values.stream().sorted().toList();
        int middle = sorted.size() / 2;
        return sorted.size() % 2 == 0
                ? safeInt(((long) sorted.get(middle - 1) + sorted.get(middle)) / 2L)
                : sorted.get(middle);
    }

    private int spread(List<Integer> values) {
        if (values.isEmpty()) {
            return 0;
        }
        int min = values.stream().mapToInt(Integer::intValue).min().orElse(0);
        int max = values.stream().mapToInt(Integer::intValue).max().orElse(0);
        return max - min;
    }

    private int bound(int value, int mediaEndMs) {
        return mediaEndMs > 0 ? Math.max(0, Math.min(value, mediaEndMs)) : Math.max(0, value);
    }

    private int safeInt(long value) {
        return (int) Math.max(0, Math.min(Integer.MAX_VALUE, value));
    }
}
