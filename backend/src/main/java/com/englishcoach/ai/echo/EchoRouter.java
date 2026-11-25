package com.englishcoach.ai.echo;

import com.englishcoach.ai.echo.EchoSpeechActAnalyzer.SpeechActKind;
import com.englishcoach.ai.echo.EchoSpeechActAnalyzer.UtteranceAnalysis;
import com.englishcoach.ai.echo.camel.TurnProvenance;
import com.englishcoach.ai.service.EchoPolicy;
import com.englishcoach.ai.service.EchoPolicy.Intent;
import com.englishcoach.ai.voice.EchoVoiceFastPathMatcher;

import java.util.*;
import java.util.regex.Pattern;

/**
 * Pure, deterministic routing (no I/O, no model). Decides, from the learner's own latest words only:
 * - Route A (DIRECT): a request the product can answer without any inference: open a page that needs no parameter
 *   (delegated to the unified {@link EchoVoiceFastPathMatcher} Concept-Slot + Speech-Act engine so Text & Voice share
 *   100% parity), read the streak, the due-card count or today's Echo allowance.
 * - Route B (FAST) / Route C (STRONG): which model tier answers; STRONG only for multi-source diagnosis, multi-step
 *   planning, long corrections or an explicit request for depth, and only while the learner's daily strong budget lasts.
 * - Whether the learner's words authorise an automatic navigation or a memory write (a retrieved text never can).
 */
public final class EchoRouter {
    private EchoRouter() {}

    public enum Route { DIRECT, FAST, STRONG, GUARD }

    public enum IntelligenceTier {
        TIER_A_FAST_PATH,
        TIER_B_CONVERSATIONAL,
        TIER_C_DEEP_EDUCATIONAL,
        TIER_D_AGENTIC_TOOLS
    }

    public enum CommandType { IDENTITY, NAVIGATE, STREAK, DUE_CARDS, ALLOWANCE }

    public record Command(CommandType type, EchoDestinations.Dest dest, String family) {}

    private static final Pattern STREAK = Pattern.compile("\\b(chuoi (ngay )?hoc|streak|hoc lien tuc|bao nhieu ngay lien)\\b");
    private static final Pattern DUE = Pattern.compile("\\b((bao nhieu|may) the (den han|can on|phai on)|the den han (con )?bao nhieu|how many (cards|flashcards) (are )?due|due cards count)\\b");
    private static final Pattern ALLOWANCE = Pattern.compile("\\b((con|het) (bao nhieu|may) (tin nhan|luot)|tin nhan mien phi|luot ai (con|hom nay)|how many messages (do i have )?left|messages left)\\b");
    private static final Pattern DEEP = Pattern.compile("\\b(phan tich (ky|sau|chi tiet|toan dien)|giai thich (ky|sau|chi tiet)|chi tiet hon|that ky|in depth|in detail|detailed analysis|deep dive|thoroughly)\\b");
    private static final Pattern PLAN = Pattern.compile("\\b(ke hoach|lich hoc|thoi gian bieu|study plan|schedule|tuan toi|thang toi|next week|next month|trong \\d+ (tuan|thang|ngay)|in \\d+ (weeks|months|days))\\b");
    private static final Pattern ANALYTICAL_DNA = Pattern.compile("\\b(learner dna|ho so nang luc|danh gia nang luc|proficiency|strengths and weaknesses|diem manh (?:va )?diem yeu|lo hong kien thuc|analyze my|analyse my|assess my|danh gia chi tiet|phan tich ho so|phan tich nang luc|phan tich diem yeu|tai sao (?:minh|toi|em) yeu|why am i weak)\\b");
    private static final Pattern PERSONALIZED_OR_ENCOURAGEMENT = Pattern.compile(
            "\\b(for my (?:current )?(?:english )?level|suitable for me|what should i (?:practice|practise|study|focus on) next|my (?:recent )?(?:learning )?progress|is my [a-z]+ improving|am i improving|discouraged|frustrated|overwhelmed|unmotivated|losing motivation|feel(?:ing)? stuck|lack confidence|phu hop (?:voi )?trinh do (?:tieng anh )?(?:hien tai )?(?:cua )?(?:minh|toi|em)|nen (?:hoc|luyen) gi tiep|tien trinh hoc|co (?:cai thien|tien bo) khong|nan qua|chan hoc|mat dong luc|tu ti|ap luc)\\b");
    private static final Pattern PAGE = Pattern.compile("\\b(this|these|here|day|nay|o day|trang nay|bai nay|doan nay|cau nay|tu nay|chu diem nay|man hinh nay|cuon sach|sach nay|chuong nay|book|chapter|dang (doc|hoc|xem|nghe)|current (page|lesson|passage|book|chapter)|tren trang)\\b");

    static String dequote(String text) {
        return EchoSpeechActAnalyzer.maskQuotedSpans(text);
    }

    /** Route A: a command the product answers without inference, or empty. */
    public static Optional<Command> direct(String query) {
        if (query == null || query.isBlank()) return Optional.empty();
        UtteranceAnalysis sa = EchoSpeechActAnalyzer.analyze(query);
        if (sa.hasQuotedSpan()
                || sa.utteranceKind() == SpeechActKind.METALINGUISTIC_MENTION
                || sa.utteranceKind() == SpeechActKind.HYPOTHETICAL_CONDITION
                || sa.utteranceKind() == SpeechActKind.NEGATED_OR_DEFERRED) {
            return Optional.empty();
        }

        // Single-clause direct DB/identity queries (IDENTITY, STREAK, DUE_CARDS, ALLOWANCE)
        String n = EchoPolicy.normalize(query);
        if (!n.isBlank() && n.length() <= 140 && sa.clauses().size() <= 1) {
            if (n.matches("(?:(?:echo oi|hey echo|hi echo|echo jarvis) )?(?:(?:may|ban|echo|cau) la ai|who are you)")) {
                return Optional.of(new Command(CommandType.IDENTITY, null, null));
            }
            if (STREAK.matcher(n).find() && !n.contains("tai sao") && !n.contains("why")
                    && !DUE.matcher(n).find() && !ALLOWANCE.matcher(n).find()) {
                return Optional.of(new Command(CommandType.STREAK, null, null));
            }
            if (DUE.matcher(n).find() && !STREAK.matcher(n).find() && !ALLOWANCE.matcher(n).find()) {
                return Optional.of(new Command(CommandType.DUE_CARDS, null, null));
            }
            if (ALLOWANCE.matcher(n).find() && !STREAK.matcher(n).find() && !DUE.matcher(n).find()) {
                return Optional.of(new Command(CommandType.ALLOWANCE, null, null));
            }
        }

        // Unified Concept-Slot + Speech-Act navigation resolution (100% parity with EchoVoiceFastPathMatcher)
        return EchoVoiceFastPathMatcher.resolveDirectNavigation(query);
    }

    /** Model tier for an inference turn. */
    public static Route route(Intent intent, String query, boolean voice, boolean strongAvailable) {
        if (!strongAvailable) return Route.FAST;
        String n = EchoPolicy.normalize(query);
        boolean deep = DEEP.matcher(n).find();
        if (voice) {
            if (intent == Intent.LEARNING_PLAN && PLAN.matcher(n).find()) return Route.STRONG;
            if (ANALYTICAL_DNA.matcher(n).find()) return Route.STRONG;
            if (deep && query != null && query.length() > 40 && !directTeaching(intent, query)) return Route.STRONG;
            return Route.FAST;
        }
        if (intent == Intent.WEAKNESS_ANALYSIS) return Route.STRONG;
        if (intent == Intent.PROGRESS_REVIEW && deep) return Route.STRONG;
        if (intent == Intent.LEARNING_PLAN && PLAN.matcher(n).find()) return Route.STRONG;
        if (intent == Intent.CORRECTION && query != null && query.length() > 350) return Route.STRONG;
        if (deep && query != null && query.length() > 40 && !directTeaching(intent, query)) return Route.STRONG;
        return Route.FAST;
    }

    /** Intents whose answer is primarily an ordinary explanation/drill (retained for max_tokens & tier heuristics). */
    public static boolean directTeaching(Intent intent, String query) {
        String words = EchoPolicy.normalize(query);
        boolean vocabularyTutoring = intent == Intent.GENERAL_ENGLISH_CONTEXT
                && words.matches("(?:huong dan|day|cho|teach|give|explain)\\b.*\\b(?:tu vung|vocabulary|words)\\b.*");
        if (intent != Intent.GRAMMAR && intent != Intent.EXPLANATION && intent != Intent.CORRECTION
                && !vocabularyTutoring && !conversationDrill(intent, query)) return false;
        if (words.startsWith("giai thich ") || words.startsWith("explain "))
            words = words.replace("bai tap", "exercises");
        return !words.matches(".*\\b(my|mine|lesson|lessons|topic|find|search|open|review|progress|weak|recommend|remember|shadowing|profile|bai|mo|tim|goi y|ghi nho|cua minh|cua toi|cua em|da hoc|the cua|tien bo|ho so)\\b.*");
    }

    public static boolean conversationDrill(Intent intent, String query) {
        if (intent != Intent.PRACTICE && intent != Intent.GENERAL_ENGLISH_CONTEXT && intent != Intent.EXPLANATION) return false;
        String words = EchoPolicy.normalize(query);
        if (words.matches(".*\\b(lesson|resource|open|find|search|progress|level|memory|bai|mo|tim|tien bo|trinh do|cua toi|cua minh|ket qua)\\b.*")) return false;
        return words.matches(".*\\b(hoi (toi|minh|em) mot cau|ask me (a|one)|luyen noi tieng anh|practise speaking|practice speaking|let s practice|let us practise|roleplay|role play)\\b.*");
    }

    public static boolean toolsUseful(Intent intent) {
        return intent != Intent.OUT_OF_DOMAIN;
    }

    /**
     * Full learner profile (rolling 7-day Learner DNA, practice estimates, recurring grammar/vocabulary error tags)
     * loaded ONLY when the learner asks about progress, level, weaknesses, study plan, personalized recommendations,
     * or study encouragement — NEVER dumped into navigation, workspace control, idiom questions, or casual chat.
     */
    public static boolean fullProfile(Intent intent) {
        return EchoPolicy.planAware(intent);
    }

    public static boolean fullProfile(Intent intent, String query) {
        if (fullProfile(intent)) return true;
        String n = EchoPolicy.normalize(query);
        return ANALYTICAL_DNA.matcher(n).find() || PERSONALIZED_OR_ENCOURAGEMENT.matcher(n).find();
    }

    /**
     * Tier C Deep Educational Intelligence: complex Learner DNA diagnosis, proficiency assessment, multi-step study plans,
     * weakness root-cause analysis, and explicit in-depth analytical explanations. Never forced to {@code effort: "none"}.
     */
    public static boolean tierCDeepReasoning(Intent intent, String query, Route route) {
        if (route == Route.STRONG) return true;
        String n = EchoPolicy.normalize(query);
        if (intent == Intent.WEAKNESS_ANALYSIS) return true;
        if (intent == Intent.LEARNING_PLAN && PLAN.matcher(n).find()) return true;
        if (intent == Intent.PROGRESS_REVIEW && DEEP.matcher(n).find()) return true;
        if (ANALYTICAL_DNA.matcher(n).find()) return true;
        return DEEP.matcher(n).find() && query != null && query.length() > 40 && !directTeaching(intent, query);
    }

    public static IntelligenceTier classifyTier(Intent intent, String query, Route route, boolean hasTools) {
        if (route == Route.DIRECT) return IntelligenceTier.TIER_A_FAST_PATH;
        if (tierCDeepReasoning(intent, query, route)) return IntelligenceTier.TIER_C_DEEP_EDUCATIONAL;
        if (hasTools && !directTeaching(intent, query)) return IntelligenceTier.TIER_D_AGENTIC_TOOLS;
        return IntelligenceTier.TIER_B_CONVERSATIONAL;
    }

    public static boolean examPracticeFocus(String query) {
        String q = EchoPolicy.normalize(query);
        return q.matches(".*\\b(ielts|toeic|exam|thi thu)\\b.*")
                && q.matches(".*\\b(part|passage|practice|practise|luyen thi|luyen phan|phan nao|readiness)\\b.*");
    }

    /** A concrete catalog search was explicitly requested. */
    public static String requestedLessonSearch(String query) {
        UtteranceAnalysis sa = EchoSpeechActAnalyzer.analyze(query);
        String words = EchoPolicy.normalize(EchoSpeechActAnalyzer.activeTrustedClausesText(sa));
        if (!words.matches(".*\\b(tim|goi y|de xuat|chuan bi|find|recommend|suggest|prepare)\\b.*")) return null;
        boolean grammar = words.matches(".*\\b(bai ngu phap|chu diem ngu phap|grammar lessons?|grammar topics?)\\b.*");
        boolean shadowing = words.matches(".*\\b(shadowing|nhai giong)\\b.*");
        boolean material = !shadowing && words.matches(".*\\b(bai doc|bai nghe|doc song ngu|bilingual|reading (?:lessons?|passages?|texts?|articles?)|listening lessons?)\\b.*");
        boolean speakingScenario = words.matches(".*\\b(speaking|roleplay|practice|luyen noi|nhap vai)\\b.*")
                && words.matches(".*\\b(scenarios?|tinh huong)\\b.*");
        int hits = (grammar ? 1 : 0) + (shadowing ? 1 : 0) + (material ? 1 : 0) + (speakingScenario ? 1 : 0);
        if (hits != 1) return null;
        if (grammar) return "search_grammar_topics";
        if (shadowing) return "search_shadowing_lessons";
        if (material) return "search_lessons";
        return "search_speaking_scenarios";
    }

    /**
     * Checks whether ANY surviving non-negated, non-metalinguistic, non-hypothetical clause in {@code query}
     * carries an explicit open/go/show/launch/start/enter/switch/resume directive (including Clause 2 of mixed-intent
     * utterances like "Explain X, then open Speaking" and desideratives like "I want to open...").
     */
    public static boolean explicitOpen(String query) {
        return EchoSpeechActAnalyzer.hasAuthorizedOpenIntent(EchoSpeechActAnalyzer.analyze(query));
    }

    /** The learner refers to what is on the page ("this passage", "câu này"): attach the resolved page context. */
    public static boolean pageReferenced(String query) {
        return PAGE.matcher(EchoPolicy.normalize(query)).find();
    }

    /** The learner's own unquoted, non-negated, non-hypothetical words ask Echo to remember something. */
    public static boolean memoryCue(String query) {
        return TurnProvenance.analyze(query, List.of()).hasMemoryCue();
    }

    /** CaMeL trusted-utterance predicate: learner's own unquoted words asked to create/save flashcards. */
    public static boolean flashcardSaveCue(String query) {
        return TurnProvenance.analyze(query, List.of()).hasFlashcardSaveCue();
    }

    /** CaMeL trusted-utterance predicate: learner's own unquoted words asked to enroll in a deck. */
    public static boolean deckEnrollCue(String query) {
        return TurnProvenance.analyze(query, List.of()).hasDeckEnrollCue();
    }

    /** CaMeL trusted-utterance predicate: learner's own unquoted words asked for a UI/workspace control. */
    public static boolean workspaceControlCue(String query) {
        return TurnProvenance.analyze(query, List.of()).hasWorkspaceControlCue();
    }

    /** True when the utterance contains quoted/code-fenced untrusted spans (potential indirect prompt injection). */
    public static boolean hasQuotedUntrustedSpan(String query) {
        return EchoSpeechActAnalyzer.containsQuotedSentinel(EchoSpeechActAnalyzer.maskQuotedSpans(query));
    }
}
