package com.englishcoach.ai.service;

import java.util.function.Consumer;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

/**
 * Releases validated text behind a safety lookahead while withholding ambiguous markup (`[ECHO_META]`, `<think>`) and
 * partial secret prefixes until final validation.
 * <ul>
 *   <li>{@link Mode#TEXT}: 40-char step + 80-char lookahead (exact contract for Markdown/tag text chat).</li>
 *   <li>{@link Mode#VOICE}: fast 32-char Clause-0 lookahead releasing as soon as a clean clause/sentence boundary
 *       (`. ? ! , ; : —`) is reached while guarding `[ECHO_META]` and secret/prompt prefixes.</li>
 * </ul>
 */
public final class EchoVisibleText {
    public enum Mode { TEXT, VOICE }

    private final Consumer<String> emit;
    private final String prompt;
    private final EchoPolicy.Intent intent;
    private final Mode mode;
    private int sent;
    private int checked;

    public EchoVisibleText(String prompt, EchoPolicy.Intent intent, Consumer<String> emit) {
        this(prompt, intent, Mode.TEXT, emit);
    }

    public EchoVisibleText(String prompt, EchoPolicy.Intent intent, Mode mode, Consumer<String> emit) {
        this.prompt = prompt;
        this.intent = intent;
        this.mode = mode == null ? Mode.TEXT : mode;
        this.emit = emit;
    }

    public int sent() { return sent; }

    public void advance(String raw) {
        if (raw == null || raw.isEmpty()) return;
        if (mode == Mode.VOICE) {
            advanceVoice(raw);
            return;
        }
        if (raw.length() - checked < 40) return;
        checked = raw.length();
        String safe = EchoPolicy.output(raw, prompt, intent);
        if (safe.equals(EchoPolicy.REFUSAL) || safe.equals(EchoPolicy.UNAVAILABLE)) throw new Filtered();
        safe = EchoPolicy.redactSecrets(safe);
        int end = Math.min(safe.length() - 80, holdMarkupLimit(safe));
        while (end > sent && !Character.isWhitespace(safe.charAt(end - 1))) end--;
        if (end - sent >= 24) send(safe, end);
    }

    private void advanceVoice(String raw) {
        int step = sent == 0 ? 4 : 12;
        if (raw.length() - checked < step) return;
        String stripped = EchoPolicy.stripEchoMeta(raw);
        if (stripped.isBlank()) return;
        checked = raw.length();
        String safe = EchoPolicy.output(raw, prompt, intent);
        if (safe.equals(EchoPolicy.REFUSAL) || safe.equals(EchoPolicy.UNAVAILABLE)) throw new Filtered();
        safe = EchoPolicy.redactSecrets(safe);

        int limit = holdMarkupLimit(safe);
        if (limit <= sent) return;

        int lookahead = sent == 0 ? 12 : 24;
        int lookaheadEnd = limit - lookahead;
        while (lookaheadEnd > sent && !Character.isWhitespace(safe.charAt(lookaheadEnd - 1))) lookaheadEnd--;

        // Sub-second Clause-0 release: emit as soon as >= 8 chars hit a clean clause/sentence boundary
        // (. ? ! , ; : — …) followed by whitespace, guarded against suspicious secret/markup tails.
        int clauseEnd = -1;
        if (sent == 0 && limit >= 12) {
            int scanEnd = Math.min(limit, sent + 56);
            for (int i = sent + 8; i <= scanEnd; i++) {
                if (Character.isWhitespace(safe.charAt(i - 1)) && i >= 2 && isClausePunctuation(safe, i - 2)) {
                    boolean sentenceEnd = isSentencePunctuation(safe.charAt(i - 2));
                    int minTail = sentenceEnd ? 4 : 6;
                    if (limit - i >= minTail) {
                        String tail = safe.substring(Math.max(0, i - 16));
                        if (!EchoPolicy.hasSuspiciousTail(tail, prompt)) {
                            clauseEnd = i;
                            break;
                        }
                    }
                }
            }
            // Soft word-boundary release if 28+ clean chars arrive without punctuation
            if (clauseEnd < 0 && limit >= 28) {
                int soft = limit - 12;
                while (soft > sent + 8 && !Character.isWhitespace(safe.charAt(soft - 1))) soft--;
                if (soft >= sent + 8 && !EchoPolicy.hasSuspiciousTail(safe.substring(Math.max(0, soft - 16)), prompt)) {
                    clauseEnd = soft;
                }
            }
        }

        int end = Math.max(lookaheadEnd, clauseEnd);
        if (end <= sent) return;
        String tailWindow = safe.substring(Math.max(0, end - 16));
        if (EchoPolicy.hasSuspiciousTail(tailWindow, prompt) && safe.length() - end < (sent == 0 ? 16 : 32)) return;
        int minChunk = sent == 0 ? 8 : 18;
        if (end - sent >= minChunk) send(safe, end);
    }

    /**
     * Holds streaming ONLY at an unclosed {@code [} or potential XML/ChatML {@code <tag} that could later complete into
     * stripped markup ({@code [ECHO_META]}, {@code [Module -> Action]}, {@code <think>}, {@code <tool_call>}, {@code <analysis>}).
     * Benign closed spans ({@code [rɪˈzɪliənt]}, {@code [1]}) and non-tag {@code <} ({@code 2 < 5}) never freeze streaming.
     */
    private static int holdMarkupLimit(String safe) {
        int len = safe.length();
        int limit = len;

        for (int b = safe.indexOf('['); b >= 0; b = safe.indexOf('[', b + 1)) {
            int rem = len - b;
            if (safe.regionMatches(true, b, "[ECHO_META", 0, Math.min(10, rem))) {
                limit = Math.min(limit, b);
                break;
            }
            int close = safe.indexOf(']', b + 1);
            int nl = safe.indexOf('\n', b + 1);
            if (close < 0 && nl < 0) {
                // Unclosed '[' on the active tail line: wait until ']' or newline resolves whether it is a stripped tag.
                limit = Math.min(limit, b);
                break;
            }
        }

        for (int a = safe.indexOf('<'); a >= 0; a = safe.indexOf('<', a + 1)) {
            if (a + 1 >= len) {
                limit = Math.min(limit, a);
                break;
            }
            char next = safe.charAt(a + 1);
            if (!(Character.isLetter(next) || next == '/' || next == '|' || next == '!')) {
                continue;
            }
            if (matchesTagPrefix(safe, a, "<think>")
                    || matchesTagPrefix(safe, a, "</think>")
                    || matchesTagPrefix(safe, a, "<analysis>")
                    || matchesTagPrefix(safe, a, "<tool_call>")
                    || matchesTagPrefix(safe, a, "</tool_call>")
                    || matchesTagPrefix(safe, a, "<|")) {
                limit = Math.min(limit, a);
                break;
            }
            int closeAngle = safe.indexOf('>', a + 1);
            int ws = findNextWhitespace(safe, a + 1);
            if (closeAngle < 0 && (ws < 0 || ws - a > 24) && len - a <= 24) {
                limit = Math.min(limit, a);
                break;
            }
        }

        return limit;
    }

    private static boolean matchesTagPrefix(String s, int offset, String tag) {
        int cmpLen = Math.min(tag.length(), s.length() - offset);
        return cmpLen > 0 && s.regionMatches(true, offset, tag, 0, cmpLen);
    }

    private static int findNextWhitespace(String s, int from) {
        for (int i = from; i < s.length(); i++) {
            if (Character.isWhitespace(s.charAt(i))) return i;
        }
        return -1;
    }

    private static boolean isSentencePunctuation(char c) {
        return c == '.' || c == '?' || c == '!' || c == '…';
    }

    private static boolean isClausePunctuation(String s, int idx) {
        if (idx < 0 || idx >= s.length()) return false;
        char c = s.charAt(idx);
        if (c == '.' && idx > 0 && idx + 1 < s.length() && Character.isDigit(s.charAt(idx - 1)) && Character.isDigit(s.charAt(idx + 1))) {
            return false;
        }
        return c == '.' || c == '?' || c == '!' || c == ',' || c == ';' || c == ':' || c == '—' || c == '…';
    }

    /** Flushes a completed intermediate tool-calling round's spoken preamble and resets offsets for the next round. */
    public void finishRound(String safeRoundText) {
        String clean = EchoPolicy.redactSecrets(safeRoundText);
        if (sent > 0 && (clean.equals(EchoPolicy.REFUSAL) || clean.equals(EchoPolicy.UNAVAILABLE) || clean.length() < sent)) {
            throw new Filtered();
        }
        if (!clean.isBlank()) {
            String withSpace = clean.endsWith(" ") ? clean : clean + " ";
            send(withSpace, withSpace.length());
        }
        sent = 0;
        checked = 0;
    }

    public void finish(String safe) {
        String clean = EchoPolicy.redactSecrets(safe);
        if (sent > 0 && (clean.equals(EchoPolicy.REFUSAL) || clean.equals(EchoPolicy.UNAVAILABLE) || clean.length() < sent)) {
            throw new Filtered();
        }
        send(clean, clean.length());
    }

    private void send(String safe, int end) {
        if (end > sent) { emit.accept(safe.substring(sent, end)); sent = end; }
    }

    static final class Filtered extends ResponseStatusException {
        Filtered() { super(HttpStatus.BAD_GATEWAY, "Filtered provider output"); }
    }
}
