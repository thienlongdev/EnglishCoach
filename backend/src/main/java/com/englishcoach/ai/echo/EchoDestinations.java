package com.englishcoach.ai.echo;

import com.englishcoach.flashcard.service.FlashcardService;
import com.englishcoach.grammar.GrammarContent;
import com.englishcoach.listening.repository.ListeningMaterialRepository;
import com.englishcoach.reading.repository.ReadingMaterialRepository;
import com.englishcoach.speaking.repository.SpeakingScenarioRepository;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.support.StaticListableBeanFactory;
import org.springframework.stereotype.Component;

import java.util.*;

/**
 * The typed route registry Echo navigates by. Every href Echo can produce is built here from a fixed table and typed
 * parameters; an LLM never supplies a URL. Parameterised destinations are checked against the owning module before an
 * href exists: a grammar slug or activity id must be in the published catalog, a Reading / Listening / Roleplay / Deck id
 * must be visible to this learner (SYSTEM or own; quarantined and foreign rows resolve to nothing). Mirrors the frontend's
 * own routes ({@code lib/navigation/registry.ts}, {@code lib/learning-path/model.ts}); the client re-validates every href.
 */
@Component
public class EchoDestinations {

    public enum Dest {
        TODAY("/learning-path?view=list", "Nhiệm vụ hôm nay", "Today's tasks"),
        ODYSSEY("/learning-path?view=odyssey", "Echo Odyssey", "Echo Odyssey"),
        DASHBOARD("/dashboard", "Trang chủ", "Home"),
        PROGRESS("/progress", "Tiến trình học tập", "Learning progress"),
        PROFILE("/profile", "Hồ sơ cá nhân", "Profile"),
        GRAMMAR("/grammar", "Ngữ pháp", "Grammar"),
        GRAMMAR_LIBRARY("/grammar/library", "Thư viện ngữ pháp", "Grammar library"),
        GRAMMAR_TOPIC("/grammar/topics/{slug}", "Bài ngữ pháp", "Grammar lesson"),
        GRAMMAR_MISTAKES("/grammar/mistakes", "Lỗi ngữ pháp của bạn", "Your grammar mistakes"),
        GRAMMAR_PRACTICE("/grammar/practice", "Luyện ngữ pháp", "Grammar practice"),
        GRAMMAR_STORIES("/grammar/stories", "Truyện ngữ pháp", "Grammar stories"),
        GRAMMAR_STORY("/grammar/stories/{slug}", "Truyện ngữ pháp", "Grammar story"),
        GRAMMAR_LAB("/grammar/lab", "Phòng thí nghiệm ngữ pháp", "Grammar Lab"),
        GRAMMAR_LAB_ITEM("/grammar/lab/{slug}", "Thí nghiệm ngữ pháp", "Grammar Lab experiment"),
        GRAMMAR_DETECTIVE("/grammar/detective", "Thám tử ngữ pháp", "Grammar Detective"),
        GRAMMAR_DETECTIVE_CASE("/grammar/detective/{slug}", "Vụ án ngữ pháp", "Grammar Detective case"),
        GRAMMAR_IELTS("/grammar/ielts", "Ngữ pháp IELTS", "IELTS Grammar"),
        GRAMMAR_TOEIC("/grammar/toeic", "Ngữ pháp TOEIC", "TOEIC Grammar"),
        GRAMMAR_REAL_WORLD("/grammar/real-world", "Ngữ pháp thực tế", "Real-world Grammar"),
        FLASHCARDS("/flashcards", "Thẻ từ vựng", "Flashcards"),
        FLASHCARDS_REVIEW("/flashcards?review=due", "Ôn thẻ đến hạn", "Review due cards"),
        FLASHCARDS_LEARNED("/flashcards?review=learned", "Ôn thẻ đã học", "Review learned cards"),
        FLASHCARDS_DECK("/flashcards?deck={id}", "Bộ thẻ từ vựng", "Flashcard deck"),
        READING("/reading", "Đọc", "Reading"),
        READING_MATERIAL("/reading?materialId={id}", "Bài đọc", "Reading text"),
        READING_MYBOOKS("/reading?section=mybooks", "Tủ sách của bạn", "My Books"),
        READING_BILINGUAL("/reading?section=bilingual", "Đọc song ngữ", "Bilingual reading"),
        READING_SPEED("/reading?section=speed", "Đọc nhanh", "Speed reading"),
        LISTENING("/listening", "Nghe", "Listening"),
        LISTENING_DASHBOARD("/listening/dashboard", "Bảng phân tích nghe", "Listening dashboard"),
        LISTENING_LESSON("/listening/{id}", "Bài nghe", "Listening lesson"),
        DICTATION("/listening/{id}/practice", "Chép chính tả", "Dictation"),
        SPEAKING("/speaking", "Luyện nói", "Speaking"),
        SPEAKING_PROFILE("/speaking?view=profile", "Hồ sơ luyện nói", "Speaking profile"),
        SPEAKING_PRONUNCIATION("/speaking?view=profile&sub=pronunciation", "Phân tích phát âm", "Pronunciation analytics"),
        SPEAKING_HISTORY("/speaking?view=profile&sub=history", "Lịch sử luyện nói", "Speaking history"),
        SPEAKING_ARENA("/speaking/arena", "Đấu trường nói", "Speaking Arena"),
        SPEAKING_SHADOWING("/speaking?mode=shadowing", "Luyện phát âm Shadowing", "Shadowing practice"),
        SPEAKING_SHADOWING_LESSON("/speaking/shadowing/{id}", "Bài luyện Shadowing", "Shadowing lesson"),
        SPEAKING_ROLEPLAY_HUB("/speaking?mode=roleplay", "Nhập vai tình huống", "Roleplay scenarios"),
        SPEAKING_ROLEPLAY("/speaking/roleplay/{id}", "Tình huống nhập vai", "Roleplay scenario"),
        SPEAKING_QUICK_CHECK("/speaking?mode=assessment", "Kiểm tra nói nhanh", "Speaking quick check"),
        SPEAKING_TOPIC("/speaking?mode=topic", "Nói theo chủ đề", "Topic speaking"),
        WRITING("/writing", "Viết", "Writing"),
        WRITING_SENTENCE_LAB("/writing?w=sentence-lab", "Luyện đặt câu", "Sentence Lab"),
        WRITING_TRANSLATION("/writing?w=translation", "Luyện dịch câu", "Translation practice"),
        WRITING_PARAGRAPH("/writing?w=translation&mode=PARAGRAPH", "Luyện dịch đoạn văn", "Paragraph translation"),
        WRITING_SENTENCE_MISTAKES("/writing?w=sentence-lab&lab=mistakes", "Lỗi đặt câu thường gặp", "Recurring sentence mistakes"),
        WRITING_TYPING("/writing?w=typing", "Luyện gõ tiếng Anh", "Typing practice"),
        WRITING_COACH("/writing?w=coach", "Huấn luyện viết bài", "Writing Coach"),
        WRITING_PORTFOLIO("/writing?w=portfolio", "Hồ sơ bài viết", "Writing portfolio"),
        EXAMS("/exams", "Thi thử", "Exams"),
        EXAMS_FAMILY("/exams/{family}", "Thi thử", "Exams"),
        EXAMS_PROFILE("/exams/profile", "Hồ sơ đánh giá năng lực", "Assessment profile"),
        LEADERBOARD("/leaderboard", "Bảng xếp hạng", "Leaderboard"),
        COSMOS("/knowledge-universe", "Vũ trụ tri thức", "Knowledge Universe"),
        COSMOS_WORD("/knowledge-universe?word={word}", "Vũ trụ tri thức", "Knowledge Universe"),
        GAMES("/games", "Trò chơi", "Games"),
        GAME_WORD_CHAIN("/games/word-chain", "Nối từ", "Word Chain"),
        GAME_KING_OF_ENGLISH("/games/king-of-english", "Vua Tiếng Anh", "King of English"),
        GAME_HANGMAN("/games/hangman", "Đoán chữ Hangman", "Hangman"),
        GAME_ECHO_GARDEN("/games/echo-garden", "Khu vườn Echo", "Echo Garden"),
        GAME_QUIZ_RUSH("/games/echo-quiz-rush", "Đua tốc độ Quiz Rush", "Echo Quiz Rush"),
        GAME_SPELLING("/games/echo-spelling", "Đánh vần Echo Spelling", "Echo Spelling"),
        COMMUNITY("/community", "Cộng đồng", "Community"),
        COMMUNITY_MESSAGES("/community/messages", "Tin nhắn cộng đồng", "Community messages"),
        STUDY_SPACE("/study-space", "Không gian học tập", "Study Space"),
        STUDY_TIMER("/study-space/timer", "Đồng hồ tập trung", "Focus timer"),
        MUSIC("/music", "Âm nhạc", "Music"),
        PREMIUM("/premium", "Gói Premium", "Premium");

        final String pattern, vi, en;
        Dest(String pattern, String vi, String en) { this.pattern = pattern; this.vi = vi; this.en = en; }
        public String label(boolean vi) { return vi ? this.vi : this.en; }
        /** The href of a destination without parameters (callers must use {@link #resolve} for parameterised ones). */
        public String pattern() {
            if (pattern.contains("{")) throw new IllegalStateException(name() + " needs parameters");
            return pattern;
        }
        public boolean parameterised() { return pattern.contains("{"); }
        boolean needs(String param) { return pattern.contains("{" + param + "}"); }
    }

    /** A resolved destination: a path that exists for this learner, or empty with a reason code. */
    public record Resolved(Dest dest, String href, String label, String reason) {
        public boolean ok() { return href != null; }
    }

    private final ObjectProvider<GrammarContent> grammar;
    private final ObjectProvider<ReadingMaterialRepository> reading;
    private final ObjectProvider<ListeningMaterialRepository> listening;
    private final ObjectProvider<SpeakingScenarioRepository> scenarios;
    private final ObjectProvider<FlashcardService> flashcards;

    public EchoDestinations(ObjectProvider<GrammarContent> grammar, ObjectProvider<ReadingMaterialRepository> reading,
                            ObjectProvider<ListeningMaterialRepository> listening) {
        this(grammar, reading, listening, emptyProvider(SpeakingScenarioRepository.class), emptyProvider(FlashcardService.class));
    }

    @Autowired
    public EchoDestinations(ObjectProvider<GrammarContent> grammar, ObjectProvider<ReadingMaterialRepository> reading,
                            ObjectProvider<ListeningMaterialRepository> listening,
                            ObjectProvider<SpeakingScenarioRepository> scenarios,
                            ObjectProvider<FlashcardService> flashcards) {
        this.grammar = grammar;
        this.reading = reading;
        this.listening = listening;
        this.scenarios = scenarios == null ? emptyProvider(SpeakingScenarioRepository.class) : scenarios;
        this.flashcards = flashcards == null ? emptyProvider(FlashcardService.class) : flashcards;
    }

    private static <T> ObjectProvider<T> emptyProvider(Class<T> type) {
        return new StaticListableBeanFactory().getBeanProvider(type);
    }

    public static List<String> names() { return Arrays.stream(Dest.values()).map(d -> d.name().toLowerCase(Locale.ROOT)).toList(); }

    public static Optional<Dest> parse(String name) {
        if (name == null) return Optional.empty();
        try { return Optional.of(Dest.valueOf(name.trim().toUpperCase(Locale.ROOT))); } catch (IllegalArgumentException e) { return Optional.empty(); }
    }

    /** Builds the href for {@code dest} after checking its parameters against the owning module for this learner. */
    public Resolved resolve(long userId, Dest dest, String slug, Long id, String word, String family, boolean vi) {
        String href = dest.pattern;
        String label = dest.label(vi);
        if (dest.needs("slug")) {
            GrammarContent content = grammar.getIfAvailable();
            if (slug == null || !slug.matches("[a-z0-9-]{1,80}")) return fail(dest, "missing_slug");
            switch (dest) {
                case GRAMMAR_TOPIC -> {
                    var meta = content == null ? Optional.<GrammarContent.TopicMeta>empty() : content.meta(slug);
                    if (meta.isEmpty()) return fail(dest, "unknown_grammar_topic");
                    href = href.replace("{slug}", slug);
                    label = (vi ? "Bài ngữ pháp: " : "Grammar: ") + topicTitle(content, slug, vi).orElse(slug);
                }
                case GRAMMAR_STORY -> {
                    Optional<String> title = grammarActivityTitle(content, "stories", slug);
                    if (title.isEmpty()) return fail(dest, "unknown_grammar_story");
                    href = href.replace("{slug}", slug);
                    label = dest.label(vi) + ": " + clip(title.get(), 60);
                }
                case GRAMMAR_LAB_ITEM -> {
                    Optional<String> title = grammarActivityTitle(content, "lab", slug);
                    if (title.isEmpty()) return fail(dest, "unknown_grammar_lab");
                    href = href.replace("{slug}", slug);
                    label = dest.label(vi) + ": " + clip(title.get(), 60);
                }
                case GRAMMAR_DETECTIVE_CASE -> {
                    Optional<String> title = grammarActivityTitle(content, "detective", slug);
                    if (title.isEmpty()) return fail(dest, "unknown_grammar_detective");
                    href = href.replace("{slug}", slug);
                    label = dest.label(vi) + ": " + clip(title.get(), 60);
                }
                default -> { return fail(dest, "unsupported_slug_destination"); }
            }
        }
        if (dest.needs("id")) {
            if (id == null || id <= 0) return fail(dest, "missing_id");
            Optional<String> title = switch (dest) {
                case READING_MATERIAL -> Optional.ofNullable(reading.getIfAvailable())
                        .flatMap(r -> r.findByIdAndVisibleToUser(id, userId)).map(m -> m.getTitle());
                case LISTENING_LESSON, DICTATION, SPEAKING_SHADOWING_LESSON -> Optional.ofNullable(listening.getIfAvailable())
                        .flatMap(r -> r.findByIdAndVisibleToUser(id, userId))
                        .filter(m -> dest != Dest.SPEAKING_SHADOWING_LESSON || !"DOCUMENT".equalsIgnoreCase(m.getSourceType()))
                        .map(m -> m.getTitle());
                case SPEAKING_ROLEPLAY -> Optional.ofNullable(scenarios.getIfAvailable())
                        .flatMap(r -> r.findByIdAndAccessible(id, userId)).map(s -> s.getTitle());
                case FLASHCARDS_DECK -> Optional.ofNullable(flashcards.getIfAvailable())
                        .flatMap(f -> f.getDecks(userId).stream()
                                .filter(d -> d.getId() != null && d.getId().equals(id))
                                .map(d -> d.getTitle())
                                .findFirst());
                default -> Optional.empty();
            };
            if (title.isEmpty()) return fail(dest, "not_found_or_not_visible");
            href = href.replace("{id}", String.valueOf(id));
            label = dest.label(vi) + ": " + clip(title.get(), 60);
        }
        if (dest.needs("family")) {
            if (family == null || !family.matches("(?i)ielts|toeic")) return fail(dest, "missing_family");
            href = href.replace("{family}", family.toLowerCase(Locale.ROOT));
            label = (vi ? "Thi thử " : "Exams ") + family.toUpperCase(Locale.ROOT);
        }
        if (dest.needs("word")) {
            if (word == null || !word.trim().matches("[A-Za-z][A-Za-z' -]{0,39}")) return fail(dest, "missing_word");
            String w = word.trim().toLowerCase(Locale.ROOT);
            href = href.replace("{word}", w.replace(" ", "%20").replace("'", "%27"));
            label = (vi ? "Xem trong vũ trụ: " : "See in the universe: ") + w;
        }
        return new Resolved(dest, href, label, null);
    }

    public Optional<String> topicTitle(GrammarContent content, String slug, boolean vi) {
        if (content == null) return Optional.empty();
        for (var domain : content.catalog().path("domains"))
            for (var topic : domain.path("topics"))
                if (slug.equals(topic.path("slug").asText()))
                    return Optional.of(topic.path("title").path(vi ? "vi" : "en").asText(slug));
        return Optional.empty();
    }

    public Optional<String> grammarActivityTitle(GrammarContent content, String section, String id) {
        if (content == null || id == null) return Optional.empty();
        for (JsonNode item : content.catalog().path(section)) {
            if (id.equals(item.path("id").asText())) {
                if (content.resource(section, id).isEmpty()) return Optional.empty();
                return Optional.of(item.path("title").asText(id));
            }
        }
        return Optional.empty();
    }

    /** Client-side mirror pattern (documented in features/echo-coach.md); every href produced here must match it. */
    public static final String HREF_ALLOW = "^/("
            + "dashboard|progress|profile|leaderboard|music|premium"
            + "|games(/(word-chain|king-of-english|hangman|echo-garden|echo-quiz-rush|echo-spelling))?"
            + "|community(/messages)?"
            + "|study-space(/timer)?"
            + "|learning-path(\\?view=(list|odyssey))?"
            + "|grammar(/topics/[a-z0-9-]{1,80}|/(stories|lab|detective)(/[a-z0-9_-]{1,80})?|/(library|mistakes|practice|ielts|toeic|real-world))?"
            + "|flashcards(\\?(review=(due|learned)|deck=\\d{1,12}))?"
            + "|reading(\\?(materialId=\\d{1,12}|section=(library|mybooks|bilingual|speed)))?"
            + "|listening(/dashboard|/\\d{1,12}(/practice)?)?"
            + "|speaking(/arena|/(roleplay|shadowing)/\\d{1,12}|\\?(mode=(shadowing|roleplay|assessment|topic)|view=profile(&sub=(overview|pronunciation|history))?))?"
            + "|writing(\\?(view=sentence-lab|w=(translation(&mode=PARAGRAPH)?|sentence-lab(&lab=(check|mistakes))?|typing|coach|portfolio)))?"
            + "|exams(/(ielts|toeic|profile))?"
            + "|knowledge-universe(\\?word=[A-Za-z%0-9'-]{1,60})?"
            + ")$";

    private static final java.util.regex.Pattern HREF_ALLOW_PATTERN = java.util.regex.Pattern.compile(HREF_ALLOW);

    public static boolean isAllowedHref(String href) {
        return href != null && !href.isBlank() && href.length() <= 200 && HREF_ALLOW_PATTERN.matcher(href.trim()).matches();
    }

    private static Resolved fail(Dest dest, String reason) { return new Resolved(dest, null, null, reason); }

    static String clip(String s, int n) { return s == null ? "" : s.length() <= n ? s : s.substring(0, n - 1) + "…"; }
}
