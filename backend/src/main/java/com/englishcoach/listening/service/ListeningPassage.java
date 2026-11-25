package com.englishcoach.listening.service;

import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;
import java.text.BreakIterator;
import java.util.*;
import java.security.MessageDigest;
import java.nio.charset.StandardCharsets;

/** Confirmed text stays authoritative; no rewriting or invented word alignment. */
public final class ListeningPassage {
    public static final int MAX_TEXT = 3000, MAX_CHUNK = 500, MAX_SEGMENTS = 16;
    private ListeningPassage() {}

    public static String validate(String value) {
        if (value == null || value.length() > MAX_TEXT) throw bad("Chọn đoạn văn tối đa 3.000 ký tự.");
        String text = value.replace("\r\n", "\n").replace('\r', '\n').trim();
        if (text.isBlank() || text.codePoints().anyMatch(c -> Character.isISOControl(c) && c != '\n' && c != '\t'))
            throw bad("Nội dung văn bản không hợp lệ.");
        long letters = text.codePoints().filter(Character::isLetter).count();
        long latin = text.codePoints().filter(c -> c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z').count();
        if (latin < 10 || latin < letters * .8) throw bad("Vui lòng chọn đoạn văn tiếng Anh.");
        segments(text); // reject oversized sentences rather than split words arbitrarily
        return text;
    }

    public static List<String> segments(String text) {
        List<String> result = new ArrayList<>();
        for (String paragraph : text.split("\\n+")) {
            BreakIterator sentences = BreakIterator.getSentenceInstance(Locale.US);
            sentences.setText(paragraph);
            int start = sentences.first();
            String pending = "";
            for (int end = sentences.next(); end != BreakIterator.DONE; start = end, end = sentences.next()) {
                String sentence = paragraph.substring(start, end).trim();
                if (sentence.isEmpty()) continue;
                sentence = pending.isEmpty() ? sentence : pending + " " + sentence;
                if (sentence.length() > MAX_CHUNK) throw bad("Câu quá dài. Chọn đoạn có câu tối đa 500 ký tự.");
                if (sentence.matches("(?s).*\\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|[A-Z])\\.$") && end < paragraph.length()) {
                    pending = sentence; continue;
                }
                result.add(sentence);
                pending = "";
            }
            if (!pending.isEmpty()) result.add(pending);
        }
        if (result.isEmpty() || result.size() > MAX_SEGMENTS) throw bad("Chọn đoạn văn có từ 1 đến 16 câu.");
        return List.copyOf(result);
    }

    public static String fingerprint(String voice, String text) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(("listening-document-v1:" + voice + ":" + text).getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) { throw new IllegalStateException(e); }
    }
    static ResponseStatusException bad(String reason) { return new ResponseStatusException(HttpStatus.BAD_REQUEST, reason); }
}
