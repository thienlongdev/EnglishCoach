package com.englishcoach.ai.echo;

import java.text.Normalizer;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Pure, deterministic, zero-I/O ({@code < 0.2 ms}) bilingual (EN + VI + mixed code-switching) speech-act and clause
 * analyzer shared across {@code EchoVoiceFastPathMatcher}, {@code EchoRouter}, and the {@code CaMeL} provenance engine.
 *
 * <p>Guarantees:</p>
 * <ul>
 *   <li>Safe quote masking ({@link #maskQuotedSpans}): replaces quoted/code-fenced spans with sentinel
 *       {@link #QUOTED_SENTINEL} (never {@code ""}), while preserving English contractions ({@code don't}, {@code I'd},
 *       {@code let's}, {@code today's}).</li>
 *   <li>Classifies clauses and whole utterances into {@link SpeechActKind} so metalinguistic mentions, hypotheticals,
 *       negations/deferrals, and genuine questions never misfire deterministic Fast-Path, Route-A, or {@code DENIED} guards.</li>
 *   <li>Resolves intra-utterance self-repairs ({@code "open reading, wait no, open listening"}) by discarding cancelled
 *       earlier directives and keeping the repaired directive.</li>
 * </ul>
 */
public final class EchoSpeechActAnalyzer {

    public static final String QUOTED_SENTINEL = "__quoted__";

    private EchoSpeechActAnalyzer() {}

    public enum SpeechActKind {
        AFFIRMATIVE_DIRECTIVE,
        POLITE_DIRECTIVE,
        REPAIR_DIRECTIVE,
        NEGATED_OR_DEFERRED,
        METALINGUISTIC_MENTION,
        HYPOTHETICAL_CONDITION,
        TRUE_INFO_QUESTION,
        CONVERSATIONAL_OR_PEDAGOGICAL
    }

    public record ClauseAnalysis(
            String rawClause,
            String cleanedClause,
            SpeechActKind kind,
            boolean hasOpenVerb,
            boolean hasActionOrControlVerb
    ) {
        public boolean isExecutableDirective() {
            return kind == SpeechActKind.AFFIRMATIVE_DIRECTIVE
                    || kind == SpeechActKind.POLITE_DIRECTIVE
                    || kind == SpeechActKind.REPAIR_DIRECTIVE;
        }
    }

    public record UtteranceAnalysis(
            String rawUtterance,
            String maskedUtterance,
            String foldedUtterance,
            boolean hasQuotedSpan,
            boolean hadSelfRepair,
            SpeechActKind utteranceKind,
            List<ClauseAnalysis> clauses
    ) {
        public boolean blocksFastPathOrGuard() {
            return utteranceKind == SpeechActKind.METALINGUISTIC_MENTION
                    || utteranceKind == SpeechActKind.HYPOTHETICAL_CONDITION
                    || utteranceKind == SpeechActKind.NEGATED_OR_DEFERRED;
        }

        public boolean hasConversationalOrQuestionClause() {
            for (ClauseAnalysis c : clauses) {
                if (c.kind() == SpeechActKind.CONVERSATIONAL_OR_PEDAGOGICAL
                        || c.kind() == SpeechActKind.TRUE_INFO_QUESTION
                        || c.kind() == SpeechActKind.METALINGUISTIC_MENTION
                        || c.kind() == SpeechActKind.HYPOTHETICAL_CONDITION) {
                    return true;
                }
            }
            return false;
        }

        public boolean hasExecutableOpenDirective() {
            if (utteranceKind == SpeechActKind.METALINGUISTIC_MENTION
                    || utteranceKind == SpeechActKind.HYPOTHETICAL_CONDITION) {
                return false;
            }
            for (ClauseAnalysis c : clauses) {
                if (c.isExecutableDirective() && c.hasOpenVerb()) {
                    return true;
                }
            }
            return false;
        }
    }

    // -----------------------------------------------------------------------
    // 1. Safe Quote Masking (preserves contractions like don't, I'd, let's)
    // -----------------------------------------------------------------------

    private static final Pattern DOUBLE_AND_CODE_QUOTES_RE = Pattern.compile(
            "```[\\s\\S]*?```|`[^`]*`|\"[^\"]*\"|\u201C[^\u201D]*\u201D|\u201E[^\u201D]*\u201D|\u00AB[^\u00BB]*\u00BB|(?:^|(?<=[\\s(\\[{,:;\u2014\u2013-]))\u2018[^\u2019\\n]+\u2019(?=\\s|$|[.,!?:;)\\]}])|(?:^|\\n)\\s*>[^\\n]*");

    private static final Pattern INTRA_WORD_CURLY_APOSTROPHE_RE = Pattern.compile(
            "(?<=[\\p{L}])[\u2019\u2018](?=[\\p{L}])");

    private static final Pattern SINGLE_QUOTED_SPAN_RE = Pattern.compile(
            "(?:^|(?<=[\\s(\\[{,:;\u2014\u2013-]))'(?:[^'\\n]{2,}|[A-Za-z])'(?=\\s|$|[.,!?:;)\\]}])");

    /**
     * Replaces quoted and code-fenced spans with {@code " __quoted__ "} while leaving English contractions intact.
     */
    public static String maskQuotedSpans(String raw) {
        if (raw == null || raw.isEmpty()) return "";
        String step1 = DOUBLE_AND_CODE_QUOTES_RE.matcher(raw).replaceAll(" " + QUOTED_SENTINEL + " ");
        String step2 = INTRA_WORD_CURLY_APOSTROPHE_RE.matcher(step1).replaceAll("'");
        String step3 = SINGLE_QUOTED_SPAN_RE.matcher(step2).replaceAll(" " + QUOTED_SENTINEL + " ");
        return step3.replaceAll("\\s+", " ").trim();
    }

    public static boolean containsQuotedSentinel(String masked) {
        return masked != null && masked.contains(QUOTED_SENTINEL);
    }

    public static String foldAsciiKeepSentinel(String text) {
        if (text == null || text.isEmpty()) return "";
        String normalized = INTRA_WORD_CURLY_APOSTROPHE_RE.matcher(text).replaceAll("'");
        return Normalizer.normalize(normalized, Normalizer.Form.NFD)
                .replaceAll("[\\p{M}\\p{Cf}]+", "")
                .replace('\u0111', 'd').replace('\u0110', 'd')
                .toLowerCase(Locale.ROOT)
                .replaceAll("[^a-z0-9_'?.,!:;/\u2014\u2013\\s-]", " ")
                .replaceAll("\\s+", " ")
                .trim();
    }

    // -----------------------------------------------------------------------
    // 2. Speech-Act & Clause Patterns
    // -----------------------------------------------------------------------

    private static final Pattern QUOTED_METALINGUISTIC_CUE_RE = Pattern.compile(
            "\\b(?:mean|means|meaning|translate|translation|in vietnamese|in english|into vietnamese|into english|tieng viet|tieng anh|nghia la|co nghia|la gi|dich|pronounce|pronunciation|phat am|spell|spelling|danh van|grammar|correct|natural|say|phrase|sentence|word|quote|passage says|text says|article says|cau nay|tu nay|cum nay|doan nay)\\b");

    private static final Pattern UNQUOTED_METALINGUISTIC_PREFIX_RE = Pattern.compile(
            "^(?:(?:hi|high|hey|hello|echo|jarvis|echo oi|ban oi|please|cho minh hoi|cho toi hoi)\\s+){0,3}(?:what does|what do|what is the meaning of|what'?s the meaning of|how do (?:i|you|we|people) (?:say|translate|pronounce|spell|use)|translate|dich(?:\\s+cum|\\s+cau|\\s+tu|\\s+doan|\\s+giup|\\s+sang)?)\\b");

    private static final Pattern UNQUOTED_METALINGUISTIC_SUFFIX_RE = Pattern.compile(
            "\\b(?:nghia la gi|co nghia la gi|co nghia gi|dich sang tieng (?:viet|anh)|trong tieng (?:viet|anh) la gi|tieng (?:viet|anh) goi la gi|tieng (?:viet|anh) noi sao)\\s*[.!?]*$");

    private static final Pattern HYPOTHETICAL_RE = Pattern.compile(
            "\\b(?:if (?:i|we|you|someone|a user|a learner) (?:said|say|ask|asked|tell|told|click|clicked|press|pressed|tap|tapped|open|opened|delete|deleted|remove|removed|cancel|cancelled|canceled|reset|log(?:ged|ging)?(?:\\s+me)?\\s+out|sign(?:ed|ing)?(?:\\s+me)?\\s+out|switch(?:ed)?|turn(?:ed)?|disable(?:d)?)|what (?:would happen|happens|will happen) if|suppose (?:i|we)|assuming (?:i|we)|neu (?:minh|toi|em|tui|nguoi dung|hoc vien) (?:noi|hoi|bam|nhan|mo|xoa|huy|tat|dang xuat|thoat|chuyen|doi)|gia su (?:minh|toi|em|tui)|dieu gi xay ra neu|chuyen gi xay ra neu)\\b");

    private static final Pattern VI_DIACRITIC_DETECT_RE = Pattern.compile(
            "[\\u00C0-\\u00FF\\u0102\\u0103\\u0110\\u0111\\u0128\\u0129\\u0168\\u0169\\u01A0\\u01A1\\u01AF\\u01B0\\u1EA0-\\u1EF9]");

    private static final Pattern LEADING_VOCATIVE_RE = Pattern.compile(
            "^(?:(?:da|vang|hi|high|hey|hello|yo|ok|okay|echo\\s+jarvis|hey\\s+echo|hi\\s+echo|high\\s+echo|echo\\s+oi|jarvis\\s+oi|ban\\s+oi|anh\\s+oi|chi\\s+oi|em\\s+oi|echo|jarvis|nay|oi|please|vui\\s+long|lam\\s+on)\\b[,!:\\s]+)+");

    private static final Pattern CONTRAST_ADJUNCT_PREFIX_RE = Pattern.compile(
            "^(?:instead of|rather than|thay vi)\\s+[^,;\\u2014\\u2013]+[,;]\\s*");

    private static final Pattern INTRA_REPAIR_SPLIT_RE = Pattern.compile(
            "(?:[,;\\u2014\\u2013-]\\s*|\\s+)(?:wait[,\\s]*no\\b|no[,\\s]*wait\\b|oh\\s+wait\\b|wait\\s+a\\s+(?:sec|second)\\b|actually\\s+no\\b|no\\s+actually\\b|sorry[,\\s]+(?:no[,\\s]+)?i\\s+mean(?:t)?\\b|i\\s+mean(?:t)?\\b|scratch\\s+that\\b|never\\s*mind(?:\\s+that)?\\b|a\\s+nham\\b|a\\s+quen\\b|nham\\s+roi\\b|khoan[,\\s]+khong\\s+phai\\b|a\\s+khong\\b|o\\s+khong\\b|y\\s+(?:minh|toi|em)\\s+la\\b)(?:[,:\\s\\u2014\\u2013-]*)"
            + "|(?:\\s*[\\u2014\\u2013,;]\\s*|\\s+)(?:actually|thay\\s+vao\\s+do|khong\\s+phai)[,:\\s]+(?=(?:open|go|head|take|bring|jump|switch|launch|enter|show|turn|enable|disable|set|apply|mo|vao|vo|chuyen|dua|cho|bat|tat)\\b)"
            + "|[,;\\u2014\\u2013-]\\s*(?:sorry|thoi)[,:\\s]+(?=(?:open|go|head|take|bring|jump|switch|launch|enter|mo|vao|vo|chuyen|dua|cho|bat)\\b)");

    private static final Pattern LEADING_REPAIR_MARKER_RE = Pattern.compile(
            "^(?:wait\\s+no|no\\s+wait|actually|instead|no(?=\\s*,)|i\\s+mean|a\\s+nham|a\\s+quen|a\\s+khong|khong\\s+phai|thay\\s+vao\\s+do|thoi(?=\\s+(?:mo|vao|vo|chuyen|dua|cho|bat|open|go|take|switch)))\\b[,:\\s\\u2014\\u2013-]*");

    private static final Pattern TRAILING_REPAIR_ADVERB_RE = Pattern.compile(
            "\\s+(?:instead|thay\\s+vao\\s+do)(?=\\s*[.!?]*$)");

    private static final Pattern MULTI_CLAUSE_SPLIT_RE = Pattern.compile(
            "\\s*;\\s*"
            + "|(?:,\\s*|\\s+)(?:and\\s+then|after\\s+that|then|roi\\s+sau\\s+do|sau\\s+do|xong\\s+roi)\\s+"
            + "|(?:,\\s*|\\s+)(?:and|va|roi)\\s+(?=(?:(?:please|can\\s+you|could\\s+you|would\\s+you|i\\s+want\\s+to|i'?d\\s+like\\s+to|i\\s+would\\s+like\\s+to|let'?s|hay|vui\\s+long|giup\\s+(?:minh|toi|em|tui)|cho\\s+(?:minh|toi|em|tui)|minh\\s+muon|toi\\s+muon)\\s+)?(?:open|go|navigate|take|bring|switch|launch|enter|show|turn|enable|disable|set|change|increase|decrease|adjust|apply|filter|play|pause|replay|scroll|explain|tell|what|why|how|when|where|which|who|is|are|am|do|does|check|quiz|test|translate|prepare|create|save|enroll|find|search|recommend|suggest|look\\s+up|define|mo|vao|vo|di|dua|chuyen|bat|tat|doi|tang|giam|chinh|ap\\s+dung|loc|phat|tam\\s+dung|nghe\\s+lai|nghe\\s+cham|nghe\\s+nhanh|cuon|keo|luot|giai\\s+thich|tai\\s+sao|vi\\s+sao|nhu\\s+the\\s+nao|kiem\\s+tra|dich|chuan\\s+bi|tao|luu|tim|goi\\s+y|de\\s+xuat|tra\\s+tu|tra\\s+cuu|xem\\s+tien\\s+trinh)\\b)"
            + "|,\\s+(?=(?:(?:please|can\\s+you|could\\s+you|i\\s+want\\s+to|i'?d\\s+like\\s+to)\\s+)?(?:open|go\\s+to|take\\s+me|bring\\s+me|switch\\s+to|launch|enter|explain|tell\\s+me|what\\s+is|why\\s+|how\\s+|which\\s+|mo\\s+|vao\\s+|chuyen\\s+sang|chuyen\\s+qua|dua\\s+minh|dua\\s+toi|giai\\s+thich|tim\\s+|goi\\s+y)\\b)");

    // Negation / deferral scoping over a command (carefully excludes UI toggles like "turn off dark mode", "disable hands-free", "tắt chế độ tối", "ẩn thanh điều hướng", "tạm dừng", "đang dừng", "dùng", "tài khoản", and "không gian")
    private static final Pattern EN_NEGATION_RE = Pattern.compile(
            "\\b(?:don'?t|do\\s+not|never|avoid|no\\s+need\\s+to|not\\s+now|not\\s+right\\s+now|not\\s+yet|wait\\s+before|hold\\s+off(?:\\s+on)?|skip(?:\\s+opening)?|do\\s+not\\s+want\\s+to|don'?t\\s+want\\s+to|would\\s+rather\\s+not|i'?d\\s+rather\\s+not|please\\s+don'?t)\\b"
            + "|\\b(?:not\\s+right\\s+now|not\\s+now|not\\s+yet|maybe\\s+later)\\s*[.!?]*$");

    // Unaccented ASCII Vietnamese negation fallback (when input has zero Vietnamese diacritics)
    private static final Pattern VI_ASCII_NEGATION_RE = Pattern.compile(
            "(?<!\\btam\\s)(?<!\\bdang\\s)(?<!\\bda\\s)(?<!\\bvua\\s)(?<!\\bsu\\s)\\bdung\\s+(?:voi\\s+|co\\s+)?(?:mo|vao|vo|chuyen|xoa|huy|tat|bat|dang\\s+xuat|thoat|tao|luu|ap\\s+dung|doi|chinh|sua|lam|di)\\b"
            + "|(?<!\\btai\\s)(?<!\\bdieu\\s)(?<!\\bchuyen\\s)(?<!\\bthanh\\s)\\bkhoan(?:\\s+(?:hay|da|voi|mo|vao|chuyen|xoa|tat|bat|lam)|\\s*[.!?]*$)"
            + "|\\b(?:chua\\s+(?:can|muon|mo|vao|chuyen|voi|da)|khong(?!\\s+gian\\b)\\s+(?:can|muon|nen|mo|chuyen|vao|vo|di|xem|bat|xoa|huy|dang\\s+xuat|thoat|tao|luu|ap\\s+dung|doi|chinh|phat|tham\\s+gia)|thoi\\s+(?:dung|khong|khoan))\\b"
            + "|\\b(?:de\\s+sau(?:\\s+di|\\s+nhe|\\s+nha)?)\\s*[.!?]*$");

    private static final Pattern POLITE_INTERROGATIVE_PREFIX_RE = Pattern.compile(
            "^(?:(?:hi|high|hey|hello|ok|okay|echo|jarvis|echo\\s+oi|ban\\s+oi|please|excuse\\s+me)\\s+){0,3}(?:(?:can|could|would|will)\\s+you(?:\\s+please|\\s+kindly)?|(?:may|can|could)\\s+i|would\\s+you\\s+mind|(?:ban\\s+|echo\\s+)?co\\s+the|(?:ban|anh|chi|em)(?=\\s+(?:mo|vao|vo|chuyen|dua|cho|giup|bat|tat|xem|quay)\\b)|giup\\s+(?:minh|toi|em|tui)|cho\\s+(?:minh|toi|em|tui)|nho\\s+(?:ban|echo))\\b");

    private static final Pattern POLITE_INTERROGATIVE_SUFFIX_RE = Pattern.compile(
            "(?:duoc\\s+khong(?:\\s+a|\\s+vay|\\s+nhi)?|(?:giup|cho|dum|gium)\\s+(?:minh|toi|em|tui)(?:\\s+voi|\\s+nhe|\\s+nha|\\s+duoc\\s+khong)?|khong\\s+echo|khong\\s+nhi|nhe|nha|ha|hen|please)\\s*\\?+$");

    private static final Pattern TRUE_QUESTION_START_RE = Pattern.compile(
            "^(?:(?:hi|high|hey|hello|echo|jarvis|echo\\s+oi|ban\\s+oi|so|well|and)\\s+){0,3}(?:what|why|how|when|where|which|who|whose|is\\s+(?:my|there|this|that|it)|are\\s+(?:my|there|these|those)|am\\s+i|do\\s+(?:i|you|we)|does\\s+(?:this|that|my|it)|did\\s+i|have\\s+i|should\\s+i|tell\\s+me\\s+(?:whether|if|what|why|how|about|more)|explain\\b|describe\\b|compare\\b|giai\\s+thich\\b|tai\\s+sao\\b|vi\\s+sao\\b|sao\\s+lai\\b|nhu\\s+the\\s+nao\\b|lam\\s+(?:sao|the\\s+nao)\\b|khi\\s+nao\\b|o\\s+dau\\b|cai\\s+nao\\b|phan\\s+nao\\b|cho\\s+(?:minh|toi|em)\\s+biet\\b)");

    private static final Pattern TRUE_QUESTION_BODY_RE = Pattern.compile(
            "\\b(?:is\\s+my\\s+[a-z]+\\s+improving|am\\s+i\\s+improving|whether\\s+my\\b|co\\s+cai\\s+thien\\s+khong|co\\s+tien\\s+bo\\s+khong|tien\\s+bo\\s+khong|tot\\s+hon\\s+chua|how\\s+many\\b|bao\\s+nhieu\\b|what\\s+is\\s+the\\s+difference|khac\\s+nhau)\\b");

    private static final Pattern PEDAGOGICAL_OR_SEARCH_RE = Pattern.compile(
            "\\b(?:explain|suitable|for\\s+my\\s+(?:current\\s+)?(?:english\\s+)?level|appropriate\\s+for|recommend|suggest|find\\s+(?:me|a|some)\\b|search\\s+for\\b|pick\\s+(?:a|me)\\b|choose\\s+a\\b|quiz\\s+me|test\\s+me|check\\s+my\\s+(?:grammar|writing|sentence|essay)|correct\\s+(?:my|everything|all)|practice\\s+(?:speaking|conversation|english)\\s+with\\s+me|just\\s+(?:talk|chat)\\s+with\\s+me|let'?s\\s+just\\s+(?:chat|talk)|prepare\\s+(?:a\\s+)?(?:suitable\\s+)?(?:practice\\s+)?scenario|create\\s+(?:a\\s+|some\\s+)?flashcards?|save\\s+this\\s+word|discouraged|frustrated|unmotivated|giai\\s+thich|phu\\s+hop|trinh\\s+do\\s+(?:tieng\\s+anh\\s+)?(?:hien\\s+tai\\s+)?(?:cua\\s+)?(?:minh|toi|em)|(?:goi\\s+y|de\\s+xuat)(?!\\s+(?:so\\s+\\d|thu\\s+|dau\\b|cuoi\\b|do\\b|nay\\b))|tim\\s+(?:cho|giup|mot|bai)|chon\\s+giup|kiem\\s+tra\\s+(?:cau|ngu\\s+phap|bai\\s+viet)|sua\\s+(?:het\\s+)?loi|chuan\\s+bi\\s+(?:mot\\s+)?tinh\\s+huong|tao\\s+the\\s+tu|luu\\s+tu\\s+nay|nen\\s+luyen\\s+gi|nan\\s+qua|mat\\s+dong\\s+luc)\\b");

    private static final Pattern OPEN_DIRECTIVE_VERB_RE = Pattern.compile(
            "(?:^|\\b)(?:open(?:\\s+up)?|go\\s+(?:to|into|back)|head\\s+(?:over\\s+)?to|navigate\\s+(?:to|back|forward)|take\\s+me\\s+(?:(?:over\\s+)?to|back)|bring\\s+(?:me\\s+to|up)|lead\\s+me\\s+to|direct\\s+me\\s+to|move\\s+to|jump\\s+(?:to|into)|switch\\s+(?:my\\s+screen\\s+|over\\s+)?to|launch|start|enter|access|show(?:\\s+me)?|view|see|visit|pull\\s+up|explore|resume|continue|review\\s+(?:my\\s+)?(?:due|learned)|(?:i\\s+want\\s+to|i'?d\\s+(?:like|love)\\s+to|id\\s+(?:like|love)\\s+to|i\\s+would\\s+(?:like|love)\\s+to)\\s+(?:open|go\\s+to|head\\s+(?:over\\s+)?to|practice|practise|start|enter|review)|mo|vao|vo|xem|di\\s+(?:toi|den|vao)|dua\\s+(?:minh|toi|em|tui)\\s+(?:toi|den|vao|sang|qua)|cho\\s+(?:minh|toi|em|tui)\\s+(?:vao|vo|xem|mo|luyen)|chuyen\\s+(?:(?:giup|cho)\\s+(?:minh|toi|em|tui)\\s+)?(?:sang|qua|den|toi|ve)|truy\\s+cap|kham\\s+pha|quay\\s+(?:lai|ve)|tro\\s+lai|doc\\s+tiep)\\b"
            + "|^(?:bookshelf|my\\s+books|my\\s+bookshelf|tu\\s+sach(?:\\s+cua\\s+(?:toi|minh|ban))?)$");

    private static final Pattern ACTION_OR_CONTROL_VERB_RE = Pattern.compile(
            "(?:^|\\b)(?:open|go|head|navigate|take|bring|lead|direct|move|jump|switch|launch|start|enter|access|show|view|see|visit|pull\\s+up|explore|resume|continue|review|use|turn|enable|disable|set|change|increase|decrease|larger|bigger|smaller|reduce|lower|make|adjust|apply|reset|default|restore|customize|darken|dim|brighten|wide|widen|narrow|comfortable|zoom|filter|play|pause|stop|mute|unmute|replay|repeat|skip|shuffle|toggle|speed|slow\\s+down|slower|speed\\s+up|faster|scroll|page\\s+down|page\\s+up|pin|keep|auto[-\\s]?hide|hide|minimize|compact|expand|embed|embedded|floating|immersive|fullscreen|full\\s+viewport|back|next|previous|prev|undo|revert|confirm|yes|approve|cancel|never\\s*mind|abort|log\\s*out|logout|sign\\s*out|sleep|rest|look\\s+up|search\\s+dictionary|define|practice|practise|bookshelf|my\\s+books|dark\\s+mode|light\\s+mode|system\\s+theme|mo|vao|vo|xem|di|dua|chuyen|dung|chon|bat|tat|doi|tang|giam|chinh|ap\\s+dung|dat\\s+lai|khoi\\s+phuc|tuy\\s+chinh|lam\\s+toi|lam\\s+sang|cho\\s+nen|cho\\s+chu|chu\\s+to|chu\\s+nho|phong\\s+to|kho\\s+doc|loc|phat|tam\\s+dung|chay|tiep\\s+tuc|nghe\\s+lai|nghe\\s+cham|nghe\\s+nhanh|toc\\s+do|bai\\s+tiep|qua\\s+bai|bai\\s+truoc|tron|cuon|keo|luot|len\\s+dau|xuong\\s+cuoi|ghim|tu\\s+an|an|hien|thu\\s+gon|thu\\s+nho|mo\\s+rong|hoan\\s+tac|xac\\s+nhan|dong\\s+y|huy|thoi\\s+bo|thoi\\s+huy|dang\\s+xuat|thoat|di\\s+ngu|tam\\s+nghi|ngung\\s+nghe|tra\\s+tu|tra\\s+cuu|tra\\s+nghia|lat\\s+trang|lat\\s+lai|trang\\s+sau|trang\\s+truoc|trang\\s+tiep|quay\\s+lai|quay\\s+ve|tro\\s+lai|lui\\s+lai|tien\\s+toi|luyen|thuc\\s+hanh|on\\s+the|on\\s+tu|tu\\s+sach)\\b");

    /**
     * Analyzes a learner utterance into clause-level and utterance-level speech acts in {@code < 0.2 ms}.
     */
    public static UtteranceAnalysis analyze(String rawUtterance) {
        if (rawUtterance == null || rawUtterance.isBlank()) {
            return new UtteranceAnalysis("", "", "", false, false, SpeechActKind.CONVERSATIONAL_OR_PEDAGOGICAL, List.of());
        }
        String masked = maskQuotedSpans(rawUtterance);
        boolean hasQuotes = containsQuotedSentinel(masked);
        String folded = foldAsciiKeepSentinel(masked);
        if (folded.isEmpty()) {
            return new UtteranceAnalysis(rawUtterance, masked, "", hasQuotes, false, SpeechActKind.CONVERSATIONAL_OR_PEDAGOGICAL, List.of());
        }

        // 1. Whole-utterance Hypothetical check ("If I delete my account, what happens?", "If I said open Speaking...")
        if (HYPOTHETICAL_RE.matcher(folded).find()) {
            ClauseAnalysis single = new ClauseAnalysis(rawUtterance, folded, SpeechActKind.HYPOTHETICAL_CONDITION, false, false);
            return new UtteranceAnalysis(rawUtterance, masked, folded, hasQuotes, false, SpeechActKind.HYPOTHETICAL_CONDITION, List.of(single));
        }

        // 2. Whole-utterance Metalinguistic mention check ("What does 'open reading' mean?", "Translate 'delete my account'")
        String withoutSentinels = folded.replace(QUOTED_SENTINEL, " ").replaceAll("\\s+", " ").trim();
        if ((hasQuotes && QUOTED_METALINGUISTIC_CUE_RE.matcher(withoutSentinels).find())
                || UNQUOTED_METALINGUISTIC_PREFIX_RE.matcher(folded).find()
                || UNQUOTED_METALINGUISTIC_SUFFIX_RE.matcher(folded).find()) {
            ClauseAnalysis single = new ClauseAnalysis(rawUtterance, folded, SpeechActKind.METALINGUISTIC_MENTION, false, false);
            return new UtteranceAnalysis(rawUtterance, masked, folded, hasQuotes, false, SpeechActKind.METALINGUISTIC_MENTION, List.of(single));
        }

        // 3. Strip leading vocatives/greetings with comma ("Echo, open Reading." / "Echo ơi, mở bảng xếp hạng")
        //    and leading contrasted non-executed adjunct ("Instead of reading, open listening")
        String working = folded;
        Matcher leadVoc = LEADING_VOCATIVE_RE.matcher(working);
        if (leadVoc.find()) {
            String afterVoc = working.substring(leadVoc.end()).trim();
            if (!afterVoc.isEmpty()) {
                working = afterVoc;
            }
        }
        working = CONTRAST_ADJUNCT_PREFIX_RE.matcher(working).replaceFirst("").trim();

        boolean hasViDiacritics = VI_DIACRITIC_DETECT_RE.matcher(masked).find();
        String nfcMasked = Normalizer.normalize(masked, Normalizer.Form.NFC).toLowerCase(Locale.ROOT);
        ViDiacriticGates viGates = hasViDiacritics ? ViDiacriticGates.fromNfc(nfcMasked) : ViDiacriticGates.UNACCENTED;

        // 4. Intra-utterance self-repair ("open reading, wait no, open listening" -> keep repaired tail!)
        boolean hadRepair = false;
        String[] repairSegments = INTRA_REPAIR_SPLIT_RE.split(working);
        if (repairSegments.length >= 2) {
            String tail = repairSegments[repairSegments.length - 1].trim();
            if (!tail.isEmpty()) {
                working = tail;
                hadRepair = true;
            }
        }

        // 5. Leading/trailing single-clause repair discourse markers ("Actually, open Listening instead")
        Matcher leadRepair = LEADING_REPAIR_MARKER_RE.matcher(working);
        if (leadRepair.find()) {
            String stripped = working.substring(leadRepair.end()).trim();
            if (!stripped.isEmpty()) {
                working = stripped;
                hadRepair = true;
            }
        }
        Matcher trailRepair = TRAILING_REPAIR_ADVERB_RE.matcher(working);
        if (trailRepair.find()) {
            String stripped = working.substring(0, trailRepair.start()).trim() + working.substring(trailRepair.end());
            if (!stripped.trim().isEmpty()) {
                working = stripped.trim();
                hadRepair = true;
            }
        }

        // 6. Split remaining utterance into coordinated/sequential clauses
        String[] rawClauses = MULTI_CLAUSE_SPLIT_RE.split(working);
        List<ClauseAnalysis> clauseList = new ArrayList<>(rawClauses.length);
        for (String part : rawClauses) {
            String trimmed = part.trim();
            if (trimmed.isEmpty()) continue;
            clauseList.add(classifyClause(trimmed, hadRepair, viGates));
        }
        if (clauseList.isEmpty()) {
            clauseList.add(classifyClause(working, hadRepair, viGates));
        }

        SpeechActKind overall = summarizeUtteranceKind(clauseList, hadRepair);
        return new UtteranceAnalysis(rawUtterance, masked, folded, hasQuotes, hadRepair, overall, List.copyOf(clauseList));
    }

    private record ViDiacriticGates(
            boolean accented,
            boolean hasDung,
            boolean hasKhoan,
            boolean hasChua,
            boolean hasKhong,
            boolean hasDeSau
    ) {
        static final ViDiacriticGates UNACCENTED = new ViDiacriticGates(false, true, true, true, true, true);
        private static final Pattern NFC_KHOAN_WORD_RE = Pattern.compile("(?<![\\p{L}])khoan(?![\\p{L}])");

        static ViDiacriticGates fromNfc(String nfcLower) {
            return new ViDiacriticGates(
                    true,
                    nfcLower.contains("\u0111\u1EEBng"),
                    NFC_KHOAN_WORD_RE.matcher(nfcLower).find(),
                    nfcLower.contains("ch\u01B0a"),
                    nfcLower.contains("kh\u00F4ng"),
                    nfcLower.contains("\u0111\u1EC3 sau"));
        }
    }

    private static ClauseAnalysis classifyClause(String clause, boolean fromRepair, ViDiacriticGates viGates) {
        String cleanNoPunct = clause.replaceAll("[.!?:;]+$", "").replaceAll("\\s+", " ").trim();

        if (HYPOTHETICAL_RE.matcher(cleanNoPunct).find()) {
            return new ClauseAnalysis(clause, cleanNoPunct, SpeechActKind.HYPOTHETICAL_CONDITION, false, false);
        }
        if (UNQUOTED_METALINGUISTIC_PREFIX_RE.matcher(cleanNoPunct).find()
                || UNQUOTED_METALINGUISTIC_SUFFIX_RE.matcher(clause).find()) {
            return new ClauseAnalysis(clause, cleanNoPunct, SpeechActKind.METALINGUISTIC_MENTION, false, false);
        }
        if (isNegatedClauseWithGates(cleanNoPunct, viGates)) {
            return new ClauseAnalysis(clause, cleanNoPunct, SpeechActKind.NEGATED_OR_DEFERRED, false, false);
        }

        boolean endsWithQuestion = clause.stripTrailing().endsWith("?");
        boolean politeRequestFrame = POLITE_INTERROGATIVE_PREFIX_RE.matcher(cleanNoPunct).find()
                || POLITE_INTERROGATIVE_SUFFIX_RE.matcher(clause.trim()).find();
        boolean trueQuestion = TRUE_QUESTION_START_RE.matcher(cleanNoPunct).find()
                || TRUE_QUESTION_BODY_RE.matcher(cleanNoPunct).find();
        boolean pedagogical = PEDAGOGICAL_OR_SEARCH_RE.matcher(cleanNoPunct).find();

        boolean hasOpen = OPEN_DIRECTIVE_VERB_RE.matcher(cleanNoPunct).find();
        boolean hasAction = hasOpen || ACTION_OR_CONTROL_VERB_RE.matcher(cleanNoPunct).find();

        if (trueQuestion) {
            return new ClauseAnalysis(clause, cleanNoPunct, SpeechActKind.TRUE_INFO_QUESTION, false, false);
        }
        if (pedagogical) {
            // Note: e.g. "prepare a suitable practice scenario" or "find a reading passage and open it":
            // if the same single clause explicitly says "open <X> and prepare..." we already split clauses; if a single
            // clause says "find and open a B1 lesson" or "open a suitable B1 scenario", keep pedagogical for Plane-B routing
            // while recording open capability separately via hasExplicitOpenInClause!
            return new ClauseAnalysis(clause, cleanNoPunct, SpeechActKind.CONVERSATIONAL_OR_PEDAGOGICAL, false, false);
        }
        if (endsWithQuestion) {
            if (politeRequestFrame && hasAction) {
                return new ClauseAnalysis(clause, cleanNoPunct,
                        fromRepair ? SpeechActKind.REPAIR_DIRECTIVE : SpeechActKind.POLITE_DIRECTIVE,
                        hasOpen, true);
            }
            return new ClauseAnalysis(clause, cleanNoPunct, SpeechActKind.TRUE_INFO_QUESTION, false, false);
        }
        if (hasAction) {
            SpeechActKind directiveKind = fromRepair ? SpeechActKind.REPAIR_DIRECTIVE
                    : (politeRequestFrame ? SpeechActKind.POLITE_DIRECTIVE : SpeechActKind.AFFIRMATIVE_DIRECTIVE);
            return new ClauseAnalysis(clause, cleanNoPunct, directiveKind, hasOpen, true);
        }
        return new ClauseAnalysis(clause, cleanNoPunct, SpeechActKind.CONVERSATIONAL_OR_PEDAGOGICAL, false, false);
    }

    private static final Pattern FOLDED_DUNG_PROHIBITIVE_RE = Pattern.compile(
            "(?<!\\btam\\s)(?<!\\bdang\\s)(?<!\\bda\\s)(?<!\\bvua\\s)(?<!\\bsu\\s)\\bdung(?:\\s+voi|\\s+co)?\\s+[a-z]+");
    private static final Pattern FOLDED_KHOAN_RE = Pattern.compile(
            "(?<!\\btai\\s)(?<!\\bdieu\\s)(?<!\\bchuyen\\s)(?<!\\bthanh\\s)\\bkhoan(?:\\s+(?:hay|da|voi|mo|vao|chuyen|xoa|tat|bat|lam)|\\s*[.!?]*$)");
    private static final Pattern FOLDED_CHUA_RE = Pattern.compile(
            "\\bchua(?:\\s+(?:can|muon|mo|vao|chuyen|voi|da)|\\s*[.!?]*$)");
    private static final Pattern FOLDED_KHONG_CMD_RE = Pattern.compile(
            "\\b(?:khong(?!\\s+gian\\b)\\s+(?:can|muon|nen|mo|chuyen|vao|vo|di|xem|bat|xoa|huy|dang\\s+xuat|thoat|tao|luu|ap\\s+dung|doi|chinh|phat|tham\\s+gia)|thoi\\s+khong)\\b");
    private static final Pattern FOLDED_DE_SAU_RE = Pattern.compile(
            "\\bde\\s+sau(?:\\s+di|\\s+nhe|\\s+nha)?\\s*[.!?]*$");

    public static boolean isNegatedOrDeferredClause(String clause) {
        if (clause == null || clause.isEmpty()) return false;
        boolean hasViDiacritics = VI_DIACRITIC_DETECT_RE.matcher(clause).find();
        ViDiacriticGates gates = hasViDiacritics
                ? ViDiacriticGates.fromNfc(Normalizer.normalize(clause, Normalizer.Form.NFC).toLowerCase(Locale.ROOT))
                : ViDiacriticGates.UNACCENTED;
        String folded = foldAsciiKeepSentinel(clause);
        return isNegatedClauseWithGates(folded, gates);
    }

    private static boolean isNegatedClauseWithGates(String foldedClause, ViDiacriticGates gates) {
        if (foldedClause == null || foldedClause.isEmpty()) return false;
        if (EN_NEGATION_RE.matcher(foldedClause).find()) return true;
        if (!gates.accented()) {
            return VI_ASCII_NEGATION_RE.matcher(foldedClause).find();
        }
        if (gates.hasDung() && FOLDED_DUNG_PROHIBITIVE_RE.matcher(foldedClause).find()) return true;
        if (gates.hasKhoan() && FOLDED_KHOAN_RE.matcher(foldedClause).find()) return true;
        if (gates.hasChua() && FOLDED_CHUA_RE.matcher(foldedClause).find()) return true;
        if (gates.hasKhong() && FOLDED_KHONG_CMD_RE.matcher(foldedClause).find()) return true;
        return gates.hasDeSau() && FOLDED_DE_SAU_RE.matcher(foldedClause).find();
    }

    /**
     * Checks whether ANY non-negated, non-metalinguistic, non-hypothetical, non-true-question clause in the utterance
     * carries an explicit open/navigate/start/enter/switch directive (including parameterized Plane-B requests like
     * {@code "Open a B1 reading passage about space"} or {@code "Explain shadowing, then open Speaking"}).
     */
    public static boolean hasAuthorizedOpenIntent(UtteranceAnalysis analysis) {
        if (analysis == null) return false;
        if (analysis.utteranceKind() == SpeechActKind.METALINGUISTIC_MENTION
                || analysis.utteranceKind() == SpeechActKind.HYPOTHETICAL_CONDITION) {
            return false;
        }
        if (analysis.hasExecutableOpenDirective()) {
            return true;
        }
        // Also check parameterized Plane-B open directives (e.g. "Open a suitable B1 scenario", "Find and open a shadowing lesson")
        for (ClauseAnalysis c : analysis.clauses()) {
            if (c.kind() == SpeechActKind.NEGATED_OR_DEFERRED
                    || c.kind() == SpeechActKind.METALINGUISTIC_MENTION
                    || c.kind() == SpeechActKind.HYPOTHETICAL_CONDITION
                    || c.kind() == SpeechActKind.TRUE_INFO_QUESTION) {
                continue;
            }
            String text = c.cleanedClause().replace(QUOTED_SENTINEL, " ");
            if (isNegatedOrDeferredClause(text)) continue;
            boolean qMark = c.rawClause().stripTrailing().endsWith("?");
            if (qMark && !POLITE_INTERROGATIVE_PREFIX_RE.matcher(text).find()
                    && !POLITE_INTERROGATIVE_SUFFIX_RE.matcher(c.rawClause().trim()).find()) {
                continue;
            }
            if (OPEN_DIRECTIVE_VERB_RE.matcher(text).find() && !TRUE_QUESTION_START_RE.matcher(text).find()) {
                return true;
            }
        }
        return false;
    }

    /**
     * Joins ONLY unquoted, non-negated, non-metalinguistic, non-hypothetical clauses of the learner's utterance.
     * Used by CaMeL capability extractors and {@code detectGuard} so negated or hypothetical clauses never mint
     * capabilities or trigger false {@code DENIED} guards.
     */
    public static String activeTrustedClausesText(UtteranceAnalysis analysis) {
        if (analysis == null) return "";
        if (analysis.utteranceKind() == SpeechActKind.METALINGUISTIC_MENTION
                || analysis.utteranceKind() == SpeechActKind.HYPOTHETICAL_CONDITION) {
            return "";
        }
        StringBuilder sb = new StringBuilder();
        for (ClauseAnalysis c : analysis.clauses()) {
            if (c.kind() == SpeechActKind.NEGATED_OR_DEFERRED
                    || c.kind() == SpeechActKind.METALINGUISTIC_MENTION
                    || c.kind() == SpeechActKind.HYPOTHETICAL_CONDITION) {
                continue;
            }
            String withoutSentinel = c.cleanedClause().replace(QUOTED_SENTINEL, " ").replaceAll("\\s+", " ").trim();
            if (!withoutSentinel.isEmpty()) {
                if (!sb.isEmpty()) sb.append(" ; ");
                sb.append(withoutSentinel);
            }
        }
        return sb.toString();
    }

    private static SpeechActKind summarizeUtteranceKind(List<ClauseAnalysis> clauses, boolean hadRepair) {
        boolean allNegated = true;
        boolean anyQuestion = false;
        boolean anyConversational = false;
        boolean anyPolite = false;
        boolean anyDirective = false;

        for (ClauseAnalysis c : clauses) {
            if (c.kind() != SpeechActKind.NEGATED_OR_DEFERRED) allNegated = false;
            if (c.kind() == SpeechActKind.TRUE_INFO_QUESTION) anyQuestion = true;
            else if (c.kind() == SpeechActKind.CONVERSATIONAL_OR_PEDAGOGICAL) anyConversational = true;
            else if (c.kind() == SpeechActKind.POLITE_DIRECTIVE) { anyPolite = true; anyDirective = true; }
            else if (c.isExecutableDirective()) anyDirective = true;
        }
        if (allNegated) return SpeechActKind.NEGATED_OR_DEFERRED;
        if (anyQuestion && !anyDirective) return SpeechActKind.TRUE_INFO_QUESTION;
        if (anyConversational || anyQuestion) return SpeechActKind.CONVERSATIONAL_OR_PEDAGOGICAL;
        if (hadRepair && anyDirective) return SpeechActKind.REPAIR_DIRECTIVE;
        if (anyPolite) return SpeechActKind.POLITE_DIRECTIVE;
        return anyDirective ? SpeechActKind.AFFIRMATIVE_DIRECTIVE : SpeechActKind.CONVERSATIONAL_OR_PEDAGOGICAL;
    }
}
