package com.englishcoach.listening.service;

import com.englishcoach.listening.dto.WordTimestampDto;

import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Backend publication gate for YouTube Listening transcripts (rules 10 §BE, SUPREME LISTENING YOUTUBE IMPORT LAW).
 *
 * The AI service on the owner's PC already refuses bad timing; this second check runs at the import boundary so
 * that nothing else (an older AI build, a changed provider, a tool) can publish a lesson whose timing is not the
 * WhisperX acoustic alignment: provenance first, then plausibility. Completeness of numbers is not accuracy.
 */
final class ListeningTranscriptTimingGate {

    /** The only accepted origin of stored word timing. */
    static final String REQUIRED_ALIGNMENT = "whisperx-wav2vec2";

    static final double END_TOLERANCE_SEC = 1.5;
    static final double MIN_ALIGNED_WORD_RATIO = 0.90;
    static final double MAX_UNALIGNED_SEGMENT_RATIO = 0.10;
    static final double MAX_WORD_GAP_SEC = 8.0;
    static final double MAX_WORD_SEC = 5.0;

    record Segment(int startTimeMs, int endTimeMs, List<WordTimestampDto> words) {}

    static final class Rejected extends RuntimeException {
        final String code;

        Rejected(String code, String message) {
            super(message);
            this.code = code;
        }
    }

    private ListeningTranscriptTimingGate() {
    }

    static void validate(String alignmentProvenance, int durationSeconds, List<Segment> segments) {
        if (!REQUIRED_ALIGNMENT.equals(alignmentProvenance)) {
            throw new Rejected("ALIGNMENT_PROVENANCE",
                    "Bản ghi lời thoại không đến từ bộ căn chỉnh WhisperX cục bộ, bài nghe không được tạo.");
        }
        if (durationSeconds <= 0) {
            throw new Rejected("DURATION_UNKNOWN", "Không xác định được độ dài thật của video, bài nghe không được tạo.");
        }
        if (segments == null || segments.isEmpty()) {
            throw new Rejected("NO_SEGMENTS", "Không phát hiện đủ lời thoại trong video để tạo bài luyện nghe.");
        }

        double limit = durationSeconds + END_TOLERANCE_SEC;
        int totalWords = 0;
        int alignedWords = 0;
        int unalignedSegments = 0;
        int uniformSegments = 0;
        int prevStart = -1;
        Set<Integer> steps = new HashSet<>();

        for (int i = 0; i < segments.size(); i++) {
            Segment seg = segments.get(i);
            if (seg.startTimeMs() < 0 || seg.endTimeMs() <= seg.startTimeMs()) {
                throw new Rejected("SEGMENT_REVERSED", "Câu " + (i + 1) + " có mốc thời gian không hợp lệ.");
            }
            if (seg.endTimeMs() / 1000.0 > limit) {
                throw new Rejected("BEYOND_MEDIA", "Câu " + (i + 1) + " kết thúc sau khi video đã hết.");
            }
            if (seg.startTimeMs() < prevStart) {
                throw new Rejected("SEGMENT_ORDER", "Câu " + (i + 1) + " nằm sai thứ tự thời gian.");
            }
            if (i > 0) {
                steps.add(seg.startTimeMs() - prevStart);
            }
            prevStart = seg.startTimeMs();

            List<WordTimestampDto> words = seg.words();
            if (words == null || words.isEmpty()) {
                throw new Rejected("WORDS_MISSING", "Câu " + (i + 1) + " không có danh sách từ.");
            }
            int segAligned = 0;
            Double lastEnd = null;
            for (WordTimestampDto w : words) {
                totalWords++;
                Double s = w.getStart();
                Double e = w.getEnd();
                if (s == null && e == null) {
                    continue;
                }
                if (s == null || e == null || s.isNaN() || e.isNaN() || s.isInfinite() || e.isInfinite()) {
                    throw new Rejected("WORD_MALFORMED", "Câu " + (i + 1) + " có mốc thời gian từ không hợp lệ.");
                }
                if (s < 0 || e <= s || e - s > MAX_WORD_SEC) {
                    throw new Rejected("WORD_REVERSED", "Câu " + (i + 1) + " có từ với thời lượng không hợp lệ.");
                }
                if (e > limit) {
                    throw new Rejected("BEYOND_MEDIA", "Câu " + (i + 1) + " có từ nằm sau khi video đã hết.");
                }
                if (lastEnd != null) {
                    if (s < lastEnd - 0.05) {
                        throw new Rejected("WORD_ORDER", "Câu " + (i + 1) + " có từ sai thứ tự thời gian.");
                    }
                    if (s - lastEnd > MAX_WORD_GAP_SEC) {
                        throw new Rejected("WORD_GAP", "Câu " + (i + 1) + " có khoảng trống bất thường giữa hai từ.");
                    }
                }
                lastEnd = e;
                segAligned++;
            }
            alignedWords += segAligned;
            if (segAligned < 0.5 * words.size()) {
                unalignedSegments++;
            }
            if (uniformSpacing(words)) {
                uniformSegments++;
            }
        }

        if (segments.size() >= 6 && steps.size() == 1) {
            throw new Rejected("SYNTHETIC_GRID", "Mốc thời gian có dấu hiệu bị tạo giả theo lưới cố định.");
        }
        if (uniformSegments > Math.max(1, 0.2 * segments.size())) {
            throw new Rejected("SYNTHETIC_UNIFORM", "Mốc thời gian từ có dấu hiệu bị chia đều giả tạo.");
        }
        double ratio = totalWords == 0 ? 0 : (double) alignedWords / totalWords;
        if (ratio < MIN_ALIGNED_WORD_RATIO || unalignedSegments > MAX_UNALIGNED_SEGMENT_RATIO * segments.size()) {
            throw new Rejected("ALIGNMENT_INSUFFICIENT",
                    "Không căn chỉnh được đủ từ với âm thanh thật của video, bài nghe không được tạo.");
        }
    }

    /** Every word the same length and touching the next one: the signature of an even split. */
    static boolean uniformSpacing(List<WordTimestampDto> words) {
        if (words.size() < 4) {
            return false;
        }
        double min = Double.MAX_VALUE;
        double max = -Double.MAX_VALUE;
        for (int i = 0; i < words.size(); i++) {
            WordTimestampDto w = words.get(i);
            if (w.getStart() == null || w.getEnd() == null) {
                return false;
            }
            double len = Math.round((w.getEnd() - w.getStart()) * 100.0) / 100.0;
            min = Math.min(min, len);
            max = Math.max(max, len);
            if (i > 0 && Math.abs(w.getStart() - words.get(i - 1).getEnd()) > 0.011) {
                return false;
            }
        }
        return max - min <= 0.011;
    }
}
