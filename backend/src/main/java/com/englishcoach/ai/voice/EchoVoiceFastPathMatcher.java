package com.englishcoach.ai.voice;

import com.englishcoach.ai.dto.EchoSalientResourceDto;
import com.englishcoach.ai.echo.EchoDestinations;
import com.englishcoach.ai.echo.EchoRouter;
import com.englishcoach.ai.echo.EchoSpeechActAnalyzer;
import com.englishcoach.ai.echo.EchoSpeechActAnalyzer.ClauseAnalysis;
import com.englishcoach.ai.echo.EchoSpeechActAnalyzer.SpeechActKind;
import com.englishcoach.ai.echo.EchoSpeechActAnalyzer.UtteranceAnalysis;
import com.englishcoach.ai.echo.camel.TurnProvenance;

import java.text.Normalizer;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Pure, deterministic {@code < 1 ms} bilingual Concept-Slot + Speech-Act Fast-Path engine shared by WS Voice Plane A
 * and HTTP/SSE {@link EchoRouter#direct(String)} (zero split-brain).
 *
 * <p>Verified against {@code shared/echo-jarvis/fast-path-parity-fixtures.json} so server-side WS ASR finals
 * immediately emit {@code action.client_plan} or {@code action.guard} with ZERO LLM latency while delegating every
 * pedagogical, analytical, mixed-intent, metalinguistic, negated, or hypothetical utterance cleanly to Plane B.</p>
 */
public final class EchoVoiceFastPathMatcher {

    private EchoVoiceFastPathMatcher() {}

    public record Guard(String decision, String reason, String promptEn, String promptVi) {}

    public record FastPathPlan(
            String language,
            String spokenAck,
            List<Map<String, Object>> intents,
            List<String> clauses) {}

    public record Outcome(Guard guard, FastPathPlan plan) {}

    private record CompiledClause(List<Map<String, Object>> intents, String ackEn, String ackVi) {}

    private record BgPreset(String id, String enName, String viName, List<String> patterns) {}

    private record NavEntry(List<String> phrases, String href, String en, String vi, List<Map<String, Object>> extraIntents) {}

    private static final Pattern ACTIVE_EXAM_SIM_RE = Pattern.compile("^/exams/[^/]+/attempts/[^/]+");
    private static final Pattern ACTIVE_GRAMMAR_CHECK_RE = Pattern.compile("^/grammar/check/[^/]+");

    private static final Pattern PROMPT_INJECTION_RE = Pattern.compile(
            "\\b(ignore (?:all |previous |prior |system )?(?:instructions|rules|guards|prompts)|system override|developer mode|jailbreak|bo qua (?:moi |tat ca )?(?:quy tac|huong dan|lenh))\\b");
    private static final Pattern SRS_AUTO_RATE_RE = Pattern.compile(
            "\\b(auto[- ]?rate|rate all (?:my )?(?:cards|flashcards)|mark all (?:cards|flashcards) (?:easy|good)|tu dong cham (?:the|flashcard)|cham tat ca the (?:de|tot)|auto review (?:all )?cards)\\b");
    private static final Pattern PAYMENT_MUTATION_RE = Pattern.compile(
            "\\b((?:execute|submit|complete|make|create|place) (?:a )?(?:payment|bank transfer|order|checkout)|charge my card|buy premium automatically|cancel (?:my )?(?:premium |pro )?subscription|(?:grant|give|activate|unlock) (?:me )?(?:free )?premium|free premium|bypass (?:quota|limit|paywall)|thanh toan (?:ngay|tu dong|don hang)|chuyen khoan mua goi|huy goi (?:dang ky )?premium|(?:cap|tang|kich hoat) (?:goi )?premium(?: mien phi)?|vuot gioi han luot)\\b");
    private static final Pattern SECURITY_ADMIN_RE = Pattern.compile(
            "\\b(change (?:my )?password|reset (?:my )?password to|disable (?:mfa|2fa|two factor)|remove (?:totp|passkey|webauthn)|open admin (?:panel|console)|grant admin|(?:delete|remove|close|wipe) (?:my )?account|log(?:ging)? (?:me )?out|doi mat khau|tat (?:mfa|2fa|xac thuc hai lop)|xoa passkey|xoa (?:vinh vien )?tai khoan|vao trang admin|quyen admin)\\b");
    private static final Pattern FOREIGN_USER_DATA_RE = Pattern.compile(
            "\\b((?:read|show|get|open|view|fetch|dump) (?:other|another) (?:user|learner|student|person)(?:\\s+s|'s|s)? (?:private )?(?:data|profile|email|messages|sessions|history|score)|xem (?:du lieu|tin nhan|ho so|email|diem) (?:cua )?(?:nguoi dung khac|hoc vien khac|nguoi khac)|doc tin nhan nguoi khac)\\b");
    private static final Pattern GRAMMAR_CHECK_SOLVE_RE = Pattern.compile(
            "\\b((?:give|tell|show) me the (?:answer|solution)|solve (?:this|the) (?:question|item|check|test)|which option is correct|dap an (?:cau nay|bai kiem tra)|giai giup cau nay|chon dap an nao)\\b");
    private static final Pattern EXTERNAL_UNSUPPORTED_RE = Pattern.compile(
            "\\b(?:(?:open|go to|navigate to|launch|visit|mo|vao|truy cap)\\s+(?:https?://\\S+|www\\.\\S+|[a-z0-9-]+\\.(?:com|org|net|io|edu|gov|vn)\\b|(?:spotify|discord|telegram|whatsapp|notepad|calculator|finder|explorer|cmd|powershell|terminal)\\b)|(?:shut\\s*down|restart|reboot)\\s+(?:my\\s+)?(?:computer|pc|laptop|may tinh)|upload\\s+(?:file|folder)\\s+from\\s+(?:my\\s+)?(?:desktop|disk|c:))\\b");

    private static final Pattern VI_DIACRITIC_RE = Pattern.compile(
            "[\\u00C0-\\u00FF\\u0102\\u0103\\u0110\\u0111\\u0128\\u0129\\u0168\\u0169\\u01A0\\u01A1\\u01AF\\u01B0\\u1EA0-\\u1EF9]");
    private static final Pattern VI_LEXICAL_CUE_RE = Pattern.compile(
            "\\b(mo|bat|tat|chuyen|doi|tang|giam|cuon|keo|luot|sach|tu dien|tra tu|tra cuu|ngu phap|the tu|on the|xac nhan|dong y|huy|dang xuat|cua toi|gan nhat|che do|giao dien|tieng viet|tieng anh|bai nghe|bai doc|am nhac|di ngu|quay lai|tro lai|thanh ben|co chu|phu de|chep chinh ta|luyen noi|luyen viet|luyen nghe|luyen doc|thi thu|bang xep hang|cong dong|khong gian hoc|hoan tac|ho so|phat am|lich su|nhai giong|giup toi|giup minh|cho toi|cho minh)\\b");

    private static final Pattern BRAIN_DELEGATION_RE = Pattern.compile(
            "\\b(suitable(?:\\s+for|\\s+practice|\\s+scenario|\\s+reading|\\s+passage)?|for my (?:current )?(?:english )?level|appropriate for|recommend|suggest|find (?:me|a|some)\\b|search for\\b|pick (?:a|me)|choose a\\b|explain|why\\b|how do (?:i|you|we)|how can i improve|what does\\b|what is the difference|difference between|translate\\b|correct (?:my|everything|all)\\b|check my (?:grammar|writing|sentence|essay)|quiz me|test me on|practice (?:speaking|conversation) with me|how many (?:cards|flashcards|days|messages|words)|my streak|my (?:ielts|toeic) (?:band|score)|study plan|create (?:a |some )?flashcards?|save this word|recent learning progress|what i should practice|phu hop|trinh do (?:tieng anh )?(?:hien tai )?(?:cua )?(?:minh|toi|em)|goi y|tim cho (?:minh|toi|em|tui)|tim giup|chon giup|giai thich|tai sao|vi sao|khac nhau|nghia la gi|(?<!luyen )dich (?:cau|doan|sang|giup)|sua (?:het )?loi|kiem tra cau|bao nhieu (?:the|ngay|tin nhan|luot)|chuoi ngay hoc|diem (?:ielts|toeic)|ke hoach hoc|tao the tu|nen luyen gi|chuan bi (?:mot )?tinh huong)\\b");

    private static final Pattern POLITE_PREFIX_RE = Pattern.compile(
            "^(?:(?:da|vang|hi|high|hey|hello|ok|okay|yo|echo|jarvis|echo jarvis|echo oi|jarvis oi|ban oi|anh oi|chi oi|em oi|nay|e|oi)\\b[,!:\\s]+){0,4}"
            + "(?:(?:please|can you|could you|would you|will you|can i|could i|may i|would you mind|kindly|help me(?: to)?|i want to|i would (?:like|love) to|i'd (?:like|love) to|i d (?:like|love) to|id (?:like|love) to|i need to|let me|let's|let s|lets|hay|vui long|lam on|(?:ban |echo )?co the|(?:ban|anh|chi|em)(?=\\s+(?:mo|vao|vo|chuyen|dua|cho|giup|bat|tat|xem|quay|cuon|luyen)\\b)|nho (?:ban|echo)|giup (?:minh|toi|em|tui)|gium (?:minh|toi|tui)|dum (?:minh|toi|tui)|cho (?:minh|toi|em|tui)(?!\\s+(?:vao|vo|xem|mo|luyen)\\b)|(?:minh|toi|em|tui) (?:muon|can|thich))\\b[,!:\\s]+){0,3}");

    private static final Pattern PLATFORM_LOCATIVE_SUFFIX_RE = Pattern.compile(
            "\\s+(?:(?:in|on|inside|within|from|at|into|across)\\s+(?:(?:my|this|the|our)\\s+)?(?:english\\s+coach(?:\\s+[a-z]+)?|website|web\\s*app|app|application|platform|portal|site|workspace|system)|(?:tren|trong|o|tai)\\s+(?:trang\\s+web|website|web|ung\\s+dung|app|nen\\s+tang|he\\s+thong|english\\s+coach)(?:\\s+cua\\s+(?:toi|minh|em|tui|chung\\s+ta))?)$");

    private static final Pattern NAV_SECTION_LOCATIVE_SUFFIX_RE = Pattern.compile(
            "\\s+(?:in|on|inside|within|from|at|into)\\s+(?:(?:my|the|this|our)\\s+)?(?:[a-z]+\\s+section|profile)$");

    private static final Pattern POLITE_SUFFIX_RE = Pattern.compile(
            "(?:,\\s*(?:echo(?:\\s+oi)?|jarvis)|\\s+(?:please|now|right now|for me|for us|thanks|thank you|echo\\s+oi|jarvis\\s+oi|duoc khong(?: a| vay| nhi)?|duoc chu|khong a|(?:di|nhe|nha|voi|please)\\s+(?:echo|jarvis)(?:\\s+oi)?|nhe|nha|nha ban|nghen|hen|ha|voi nhe|voi nha|voi|cho (?:minh|toi|em|tui) xem|(?:giup|cho|dum|gium) (?:minh|toi|em|tui)|dum|gium|luon|ngay|di))$");

    private static final Pattern SAFE_DICT_TAIL_QUOTE_RE = Pattern.compile(
            "^([^\"'`\u201C\u201D\u2018\u2019\u00AB\u00BB?]+?)\\s+[\"\u201C\u2018']([A-Za-z][A-Za-z0-9' -]{0,48})[\"\u201D\u2019'](?:\\s+(?:(?:in|from|on|inside|into|using|at)\\s+(?:(?:the|my|our|your|english)\\s+)?dictionary|(?:trong|o|\u1EDF|tren|tr\u00EAn|bang|b\u1EB1ng)\\s+(?:cuon\\s+|cu\u1ED1n\\s+)?(?:tu\\s+dien|t\u1EEB\\s+\u0111i\u1EC3n)|for\\s+(?:me|us)|please|right\\s+now|now|(?:giup|gi\u00FAp|cho|dum|d\u00F9m|gium|gi\u00F9m)\\s+(?:minh|m\u00ECnh|toi|t\u00F4i|em|tui)|nhe|nh\u00E9|nha|voi|v\u1EDBi|di|\u0111i)+)*\\s*[.!]?$",
            Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);
    private static final Pattern SAFE_DICT_PREFIX_FOLDED_RE = Pattern.compile(
            "\\b(?:look up(?: (?:the |a |an )?(?:word|vocabulary|vocab|term|phrase|idiom))?|define(?: (?:the |a |an )?(?:word|vocabulary|vocab|term|phrase|idiom))?|dictionary for|tra(?:\\s+cuu)?(?:\\s+nghia(?:\\s+cua)?)?(?:\\s+(?:tu(?:\\s+vung)?|cum\\s+tu|thanh\\s+ngu))?)$");
    private static final Pattern DICT_COMMAND_PREFIX_RE = Pattern.compile(
            "^(?:open (?:the |my )?dictionary (?:and |to )?(?:look up|search(?: for)?|find|check)|search (?:(?:in|the|my) )?dictionary for|check (?:(?:in|the|my) )?dictionary for|look up|define|mo tu dien(?:\\s+va)?\\s+(?:tra(?:\\s+cuu)?|tim)|tra cuu(?:\\s+nghia(?:\\s+cua)?)?|tra nghia(?:\\s+cua)?|tra tu dien|tra tu vung|tra cum tu|tra thanh ngu|tra tu)\\s+(.+)$");
    private static final Pattern DICT_LEADING_LABEL_RE = Pattern.compile(
            "^(?:(?:the\\s+)?meaning\\s+of(?:\\s+(?:the|a|an|this))?|(?:(?:the|a|an|this)\\s+)?(?:word|vocabulary|vocab|term|phrase|idiom|expression)\\b|(?:nghia\\s+cua\\s+)?(?:tu\\s+vung|cum\\s+tu|thanh\\s+ngu|tu)\\b)\\s+");
    private static final Pattern DICT_TRAILING_LOCATIVE_OR_POLITE_RE = Pattern.compile(
            "\\s+(?:(?:in|from|on|inside|into|using|at|via|with)\\s+(?:(?:the|a|an|my|our|your|this|english|built[- ]?in|echo)\\s+){0,2}dictionary\\b.*|(?:trong|o|tren|bang|vao|tai)\\s+(?:cuon\\s+|bo\\s+)?tu\\s+dien\\b.*|(?:for\\s+(?:me|us)|please|right\\s+now|thanks|thank\\s+you|(?:giup|gium|dum|cho)\\s+(?:minh|toi|em|tui)(?:\\s+(?:voi|nhe|nha))?|duoc\\s+khong|nhe|nha)\\b.*)$");

    private static final Pattern COMPOUND_SPLIT_RE = Pattern.compile(
            "\\s*;\\s*|\\s+(?:and then|after that|then|and|r\u1ED3i sau \u0111\u00F3|sau \u0111\u00F3|xong r\u1ED3i|r\u1ED3i|v\u00E0|roi sau do|sau do|xong roi|roi|va)\\s+",
            Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);

    private static final Pattern NAV_VERB_RE = Pattern.compile(
            "^(?:open(?: up)?|go (?:to|into)|head (?:over )?to|navigate to|take me (?:over )?to|bring (?:me to|up)|lead me to|direct me to|switch (?:my screen |over )?to|move to|jump (?:to|into)|launch|start|enter|access|show me|show|view|visit|pull up|review(?=\\s+(?:my\\s+)?(?:due|learned)\\b)|mo(?: (?:giup|cho|dum|gium)(?: (?:minh|toi|em|tui))?)?|vao|vo|xem|di (?:toi|den|vao)|dua (?:minh|toi|em|tui) (?:toi|den|sang|qua|vao|vo)|cho (?:minh|toi|em|tui) (?:vao|vo|xem|mo)|chuyen (?:(?:giup|cho) (?:minh|toi|em|tui) )?(?:sang|qua|den|toi|ve)|bat|truy cap)\\s+(.+)$");

    private static final Pattern RELATIVE_PRACTICE_UNWRAP_RE = Pattern.compile(
            "^(?:the\\s+)?(?:section|page|area|module|place|room|part|hub|screen|tab|studio|zone|space|phan|muc|khu(?:\\s+vuc)?|cho|trang|noi|goc)\\s+(?:where\\s+(?:i|we|you)\\s+(?:can\\s+)?(?:practice|practise|study|learn|train|do|work\\s+on)|for\\s+(?:practicing|practising|studying|learning)|to\\s+(?:practice|practise|study|learn)|(?:ma\\s+)?(?:minh|toi|em|tui)?\\s*(?:co\\s+the\\s+)?(?:de\\s+)?(?:luyen(?:\\s+tap)?|hoc(?:\\s+tap)?|thuc\\s+hanh|tap))\\s+(.+)$");

    private static final Pattern PRACTICE_STUDIO_ENTRY_RE = Pattern.compile(
            "^(?:practice|practise|start practicing|start practising|cho (?:minh|toi|em|tui) luyen(?: tap)?|luyen(?: tap)?|thuc hanh)\\s+(.+)$");

    private static final Set<String> NAV_FILLER_WORDS = Set.of(
            "the", "a", "an", "my", "page", "screen", "tab", "module", "section", "hub", "room", "area", "place", "studio",
            "world", "game", "rankings", "fullscreen", "immersive",
            "trang", "muc", "phan", "man", "hinh", "khu", "vuc", "phong", "cho", "ky", "nang");

    private static final Set<String> CONCEPT_CONTAINER_FILLER_TOKENS = Set.of(
            "the", "a", "an", "my", "me", "our", "this", "page", "screen", "tab", "module", "section", "hub",
            "room", "area", "place", "zone", "studio", "part", "view", "portal", "center", "centre", "feature",
            "world", "game", "rankings", "home", "fullscreen", "immersive",
            "in", "of", "for", "on", "to", "into", "at", "practice", "practise", "practicing", "practising",
            "trang", "muc", "phan", "man", "hinh", "khu", "vuc", "phong", "cho", "noi", "goc", "ky", "nang",
            "trong", "o", "cua", "toi", "minh", "em", "tui", "ban", "luyen", "tap", "hoc");

    private static final List<BgPreset> BG_PRESETS = List.of(
            new BgPreset("pearlescent-abyss", "Pearlescent Abyss", "V\u1EF1c S\u00E2u Ng\u1ECDc Trai", List.of("pearlescent abyss", "pearl abyss", "vuc sau ngoc trai", "ngoc trai")),
            new BgPreset("aurora-flow", "Aurora Flow", "D\u1EA3i C\u1EF1c Quang", List.of("aurora flow", "dai cuc quang", "cuc quang", "aurora")),
            new BgPreset("oceanic-glow", "Oceanic Glow", "\u00C1nh S\u00E1ng \u0110\u1EA1i D\u01B0\u01A1ng", List.of("oceanic glow", "anh sang dai duong", "ocean glow")),
            new BgPreset("liquid-mesh", "Liquid Mesh", "L\u1EE5a S\u1EAFc L\u01B0u Chuy\u1EC3n", List.of("liquid mesh", "lua sac luu chuyen", "lua sac")),
            new BgPreset("nebula-atmosphere", "Nebula Atmosphere", "Kh\u00ED Quy\u1EC3n Tinh V\u00E2n", List.of("nebula atmosphere", "khi quyen tinh van", "tinh van", "nebula")),
            new BgPreset("midnight-sapphire", "Midnight Sapphire", "Lam Ng\u1ECDc N\u1EEDa \u0110\u00EAm", List.of("midnight sapphire", "lam ngoc nua dem", "lam ngoc", "sapphire")),
            new BgPreset("violet-dream", "Violet Dream", "Gi\u1EA5c M\u01A1 T\u1EED \u0110inh H\u01B0\u01A1ng", List.of("violet dream", "giac mo tu dinh huong", "tu dinh huong")),
            new BgPreset("rose-quartz", "Rose Quartz", "Th\u1EA1ch Anh H\u1ED3ng", List.of("rose quartz", "thach anh hong")),
            new BgPreset("emerald-depth", "Emerald Depth", "L\u1EE5c B\u1EA3o S\u00E2u Th\u1EB3m", List.of("emerald depth", "luc bao sau tham", "luc bao")),
            new BgPreset("arctic-crystal", "Arctic Crystal", "Tinh Th\u1EC3 B\u1EAFc C\u1EF1c", List.of("arctic crystal", "tinh the bac cuc"))
    );

    private static final List<NavEntry> NAV_ENTRIES = List.of(
            new NavEntry(List.of("echo odyssey", "odyssey world", "odyssey", "the gioi odyssey", "hanh trinh odyssey"), "/learning-path?view=odyssey", "Echo Odyssey", "Echo Odyssey", List.of()),
            new NavEntry(List.of("todays learning path tasks", "today's learning path tasks", "today s learning path tasks", "learning path tasks", "todays tasks", "today tasks", "today s tasks", "today's tasks", "today plan", "learning path", "nhiem vu lo trinh hoc hom nay", "nhiem vu lo trinh hom nay", "nhiem vu hom nay", "lo trinh hom nay", "lo trinh hoc hom nay", "lo trinh hoc tap", "lo trinh hoc", "lo trinh"), "/learning-path?view=list", "Today's tasks", "Nhi\u1EC7m v\u1EE5 h\u00F4m nay", List.of()),
            new NavEntry(List.of("my books", "bookshelf", "books shelf", "my bookshelf", "sach cua toi", "sach cua minh", "ke sach cua toi", "tu sach cua toi", "tu sach cua minh", "tu sach cua ban", "tu sach"), "/reading?section=mybooks", "My Books", "T\u1EE7 s\u00E1ch c\u1EE7a b\u1EA1n", List.of(intent("reading_control", "tab", "mybooks"))),
            new NavEntry(List.of("bilingual reading", "doc song ngu", "bai doc song ngu"), "/reading?section=bilingual", "Bilingual Reading", "\u0110\u1ECDc song ng\u1EEF", List.of(intent("reading_control", "tab", "bilingual"))),
            new NavEntry(List.of("speed reading", "speed reader", "doc nhanh", "luyen doc nhanh"), "/reading?section=speed", "Speed Reading", "\u0110\u1ECDc nhanh", List.of(intent("reading_control", "tab", "speed"))),
            new NavEntry(List.of("speaking arena", "echo archipelago", "dau truong noi", "dau truong luyen noi", "dao luyen noi", "arena"), "/speaking/arena", "Speaking Arena", "\u0110\u1EA5u tr\u01B0\u1EDDng luy\u1EC7n n\u00F3i", List.of()),
            new NavEntry(List.of("pronunciation analytics", "pronunciation profile", "pronunciation stats", "speaking pronunciation", "phan tich phat am", "phan tich phat am cua toi", "phan tich phat am cua minh", "ho so phat am", "thong ke phat am", "chi so phat am"), "/speaking?view=profile&sub=pronunciation", "Pronunciation Analytics", "Ph\u00E2n t\u00EDch ph\u00E1t \u00E2m", List.of(intent("speaking_control", "view", "profile", "sub", "pronunciation"))),
            new NavEntry(List.of("speaking history", "speaking session history", "speaking sessions", "lich su luyen noi", "lich su luyen noi cua toi", "lich su luyen noi cua minh", "lich su phien noi"), "/speaking?view=profile&sub=history", "Speaking History", "L\u1ECBch s\u1EED luy\u1EC7n n\u00F3i", List.of(intent("speaking_control", "view", "profile", "sub", "history"))),
            new NavEntry(List.of("speaking profile", "speaking analytics", "speaking progress", "speaking stats", "speaking statistics", "speaking overview", "ho so luyen noi", "ho so luyen noi cua toi", "ho so luyen noi cua minh", "phan tich luyen noi", "thong ke luyen noi", "tong quan luyen noi"), "/speaking?view=profile", "Speaking Profile", "H\u1ED3 s\u01A1 luy\u1EC7n n\u00F3i", List.of(intent("speaking_control", "view", "profile"))),
            new NavEntry(List.of("shadowing studio", "shadowing practice", "speaking shadowing", "shadowing", "luyen phat am shadowing", "luyen noi shadowing", "che do shadowing", "luyen nhai giong", "nhai giong"), "/speaking?mode=shadowing", "Shadowing Studio", "Luy\u1EC7n ph\u00E1t \u00E2m Shadowing", List.of()),
            new NavEntry(List.of("speaking quick check", "pronunciation check", "quick check", "kiem tra noi nhanh", "kiem tra phat am"), "/speaking?mode=assessment", "Speaking Quick Check", "Ki\u1EC3m tra n\u00F3i nhanh", List.of()),
            new NavEntry(List.of("roleplay scenarios", "roleplay studio", "speaking roleplay", "roleplay", "nhap vai giao tiep", "luyen hoi thoai nhap vai", "nhap vai"), "/speaking?mode=roleplay", "Speaking Roleplay", "H\u1ED9i tho\u1EA1i nh\u1EADp vai", List.of()),
            new NavEntry(List.of("topic speaking", "speak by topic", "noi theo chu de"), "/speaking?mode=topic", "Topic Speaking", "N\u00F3i theo ch\u1EE7 \u0111\u1EC1", List.of()),
            new NavEntry(List.of("paragraph translation", "dich doan van", "luyen dich doan", "luyen dich doan van"), "/writing?w=translation&mode=PARAGRAPH", "Paragraph Translation", "Luy\u1EC7n d\u1ECBch \u0111o\u1EA1n v\u0103n", List.of()),
            new NavEntry(List.of("sentence mistakes", "writing mistakes", "loi dat cau", "loi viet thuong gap"), "/writing?w=sentence-lab&lab=mistakes", "Recurring Sentence Mistakes", "L\u1ED7i \u0111\u1EB7t c\u00E2u th\u01B0\u1EDDng g\u1EB7p", List.of()),
            new NavEntry(List.of("writing sentence lab", "sentence lab", "sentence check", "phong luyen dat cau", "luyen dat cau", "kiem tra dat cau"), "/writing?w=sentence-lab", "Sentence Lab", "Ph\u00F2ng luy\u1EC7n \u0111\u1EB7t c\u00E2u", List.of()),
            new NavEntry(List.of("typing practice", "writing typing", "luyen go tieng anh", "luyen danh may", "luyen go"), "/writing?w=typing", "Typing Practice", "Luy\u1EC7n g\u00F5 ti\u1EBFng Anh", List.of()),
            new NavEntry(List.of("writing coach", "essay studio", "essay coach", "phong viet luan", "luyen viet luan", "huan luyen viet"), "/writing?w=coach", "Writing Coach", "Ph\u00F2ng luy\u1EC7n vi\u1EBFt lu\u1EADn", List.of()),
            new NavEntry(List.of("writing portfolio", "essay portfolio", "portfolio", "bo suu tap bai viet", "ho so bai viet"), "/writing?w=portfolio", "Writing Portfolio", "B\u1ED9 s\u01B0u t\u1EADp b\u00E0i vi\u1EBFt", List.of()),
            new NavEntry(List.of("translation studio", "translation practice", "luyen dich cau", "luyen dich"), "/writing?w=translation", "Translation Practice", "Luy\u1EC7n d\u1ECBch", List.of()),
            new NavEntry(List.of("grammar mistakes", "loi ngu phap cua ban", "loi ngu phap"), "/grammar/mistakes", "Grammar Mistakes", "L\u1ED7i ng\u1EEF ph\u00E1p c\u1EE7a b\u1EA1n", List.of()),
            new NavEntry(List.of("grammar practice", "luyen tap ngu phap", "luyen ngu phap", "bai tap ngu phap"), "/grammar/practice", "Grammar Practice", "Luy\u1EC7n ng\u1EEF ph\u00E1p", List.of()),
            new NavEntry(List.of("grammar library", "thu vien ngu phap"), "/grammar/library", "Grammar Library", "Th\u01B0 vi\u1EC7n ng\u1EEF ph\u00E1p", List.of()),
            new NavEntry(List.of("grammar stories", "cau chuyen ngu phap", "truyen ngu phap"), "/grammar/stories", "Grammar Stories", "C\u00E2u chuy\u1EC7n ng\u1EEF ph\u00E1p", List.of()),
            new NavEntry(List.of("grammar lab", "phong thi nghiem ngu phap"), "/grammar/lab", "Grammar Lab", "Ph\u00F2ng th\u00ED nghi\u1EC7m ng\u1EEF ph\u00E1p", List.of()),
            new NavEntry(List.of("grammar detective", "tham tu ngu phap"), "/grammar/detective", "Grammar Detective", "Th\u00E1m t\u1EED ng\u1EEF ph\u00E1p", List.of()),
            new NavEntry(List.of("ielts grammar", "grammar for ielts", "ngu phap ielts"), "/grammar/ielts", "IELTS Grammar", "Ng\u1EEF ph\u00E1p IELTS", List.of()),
            new NavEntry(List.of("toeic grammar", "grammar for toeic", "ngu phap toeic"), "/grammar/toeic", "TOEIC Grammar", "Ng\u1EEF ph\u00E1p TOEIC", List.of()),
            new NavEntry(List.of("real world grammar", "real-world grammar", "ngu phap thuc te", "ngu phap doi song"), "/grammar/real-world", "Real-World Grammar", "Ng\u1EEF ph\u00E1p th\u1EF1c t\u1EBF", List.of()),
            new NavEntry(List.of("learned cards", "learned flashcards", "review learned cards", "review learned flashcards", "on the da hoc", "the da hoc"), "/flashcards?review=learned", "Review Learned Cards", "\u00D4n th\u1EBB \u0111\u00E3 h\u1ECDc", List.of()),
            new NavEntry(List.of("due cards", "due flashcards", "review due cards", "review due flashcards", "review cards", "the den han", "on the den han", "on tu vung ngay", "on tu vung", "on the"), "/flashcards?review=due", "Review Due Cards", "\u00D4n th\u1EBB \u0111\u1EBFn h\u1EA1n", List.of()),
            new NavEntry(List.of("listening dashboard", "listening analytics", "thong ke nghe", "thong ke luyen nghe", "bang thong ke nghe", "bang phan tich nghe"), "/listening/dashboard", "Listening Analytics", "Th\u1ED1ng k\u00EA luy\u1EC7n nghe", List.of()),
            new NavEntry(List.of("assessment profile", "exam profile", "ho so danh gia nang luc", "ho so danh gia"), "/exams/profile", "Assessment Profile", "H\u1ED3 s\u01A1 \u0111\u00E1nh gi\u00E1 n\u0103ng l\u1EF1c", List.of()),
            new NavEntry(List.of("ielts exams", "ielts mock test", "ielts tests", "ielts exam", "thi thu ielts", "de thi ielts"), "/exams/ielts", "IELTS Mock Exams", "Thi th\u1EED IELTS", List.of()),
            new NavEntry(List.of("toeic exams", "toeic mock test", "toeic tests", "toeic exam", "thi thu toeic", "de thi toeic"), "/exams/toeic", "TOEIC Mock Exams", "Thi th\u1EED TOEIC", List.of()),
            new NavEntry(List.of("word chain", "game noi tu", "tro choi noi tu", "noi tu"), "/games/word-chain", "Word Chain", "Tr\u00F2 ch\u01A1i N\u1ED1i t\u1EEB", List.of()),
            new NavEntry(List.of("king of english", "soan ngoi", "vua tieng anh"), "/games/king-of-english", "King of English", "Vua Ti\u1EBFng Anh", List.of()),
            new NavEntry(List.of("hangman", "doan tu", "doan chu", "tro choi doan tu"), "/games/hangman", "Hangman", "Tr\u00F2 ch\u01A1i \u0110o\u00E1n t\u1EEB", List.of()),
            new NavEntry(List.of("echo garden", "vuon echo", "khu vuon echo"), "/games/echo-garden", "Echo Garden", "Khu v\u01B0\u1EDDn Echo", List.of()),
            new NavEntry(List.of("echo quiz rush", "quiz rush", "dua toc do tu vung"), "/games/echo-quiz-rush", "Echo Quiz Rush", "Echo Quiz Rush", List.of()),
            new NavEntry(List.of("echo spelling", "spelling bee", "danh van tieng anh", "thi danh van", "danh van"), "/games/echo-spelling", "Echo Spelling", "Echo Spelling", List.of()),
            new NavEntry(List.of("study timer", "pomodoro timer", "focus timer", "dong ho pomodoro", "hen gio hoc tap", "dong ho tap trung"), "/study-space/timer", "Study Timer", "\u0110\u1ED3ng h\u1ED3 t\u1EADp trung", List.of()),
            new NavEntry(List.of("community messages", "echo messenger", "messenger", "tin nhan cong dong", "hop thu tin nhan", "tin nhan"), "/community/messages", "Messages", "Tin nh\u1EAFn c\u1ED9ng \u0111\u1ED3ng", List.of()),
            new NavEntry(List.of("home dashboard", "dashboard", "home page", "home", "trang chu", "bang dieu khien"), "/dashboard", "Dashboard", "Trang ch\u1EE7", List.of()),
            new NavEntry(List.of("learning progress", "my progress", "progress", "tien trinh hoc tap", "tien trinh", "thong ke tien do"), "/progress", "Progress", "Ti\u1EBFn tr\u00ECnh h\u1ECDc t\u1EADp", List.of()),
            new NavEntry(List.of("my profile", "account profile", "profile", "ho so ca nhan", "trang ca nhan"), "/profile", "Profile", "H\u1ED3 s\u01A1 c\u00E1 nh\u00E2n", List.of()),
            new NavEntry(List.of("leaderboard", "rankings", "bang xep hang", "xep hang"), "/leaderboard", "Leaderboard", "B\u1EA3ng x\u1EBFp h\u1EA1ng", List.of()),
            new NavEntry(List.of("knowledge universe", "cosmos", "vu tru tri thuc"), "/knowledge-universe", "Knowledge Universe", "V\u0169 tr\u1EE5 tri th\u1EE9c", List.of()),
            new NavEntry(List.of("study space", "echo life", "studyspace", "khong gian hoc tap"), "/study-space", "Study Space", "Kh\u00F4ng gian h\u1ECDc t\u1EADp", List.of()),
            new NavEntry(List.of("echo music", "music hub", "music page", "music", "trang am nhac", "phong am nhac", "am nhac", "nhac"), "/music", "Echo Music", "\u00C2m nh\u1EA1c", List.of()),
            new NavEntry(List.of("premium plans", "premium page", "premium", "goi premium", "nang cap premium"), "/premium", "Premium", "G\u00F3i Premium", List.of()),
            new NavEntry(List.of("community", "cong dong"), "/community", "Community", "C\u1ED9ng \u0111\u1ED3ng", List.of()),
            new NavEntry(List.of("games hub", "games", "game", "tro choi", "khu tro choi"), "/games", "Games", "Tr\u00F2 ch\u01A1i", List.of()),
            new NavEntry(List.of("flashcards", "flashcard", "vocabulary cards", "the tu vung", "tu vung"), "/flashcards", "Flashcards", "Th\u1EBB t\u1EEB v\u1EF1ng", List.of()),
            new NavEntry(List.of("reading library", "reading", "luyen doc", "phan doc", "muc doc", "bai doc", "doc"), "/reading", "Reading", "\u0110\u1ECDc", List.of()),
            new NavEntry(List.of("listening library", "listening", "luyen nghe", "phan nghe", "muc nghe", "nghe"), "/listening", "Listening", "Nghe", List.of()),
            new NavEntry(List.of("speaking studio", "speaking", "luyen noi", "phan luyen noi", "phan noi", "muc noi", "noi"), "/speaking", "Speaking", "Luy\u1EC7n n\u00F3i", List.of()),
            new NavEntry(List.of("writing studio", "writing", "luyen viet", "phan viet", "muc viet", "viet"), "/writing", "Writing", "Vi\u1EBFt", List.of()),
            new NavEntry(List.of("grammar academy", "grammar", "ngu phap", "phan ngu phap", "hoc ngu phap"), "/grammar", "Grammar", "Ng\u1EEF ph\u00E1p", List.of()),
            new NavEntry(List.of("mock exams", "exams", "exam hub", "exam", "thi thu", "phong thi thu"), "/exams", "Mock Exams", "Thi th\u1EED", List.of())
    );

    private static final List<NavEntry> PRACTICE_STUDIO_ENTRIES = List.of(
            new NavEntry(List.of("shadowing", "shadowing studio", "nhai giong", "phat am shadowing", "noi shadowing"), "/speaking?mode=shadowing", "Shadowing Studio", "Luy\u1EC7n ph\u00E1t \u00E2m Shadowing", List.of()),
            new NavEntry(List.of("roleplay", "speaking roleplay", "nhap vai", "hoi thoai nhap vai", "nhap vai giao tiep"), "/speaking?mode=roleplay", "Speaking Roleplay", "H\u1ED9i tho\u1EA1i nh\u1EADp vai", List.of()),
            new NavEntry(List.of("quick check", "speaking quick check", "kiem tra noi nhanh"), "/speaking?mode=assessment", "Speaking Quick Check", "Ki\u1EC3m tra n\u00F3i nhanh", List.of()),
            new NavEntry(List.of("paragraph translation", "dich doan van", "dich doan"), "/writing?w=translation&mode=PARAGRAPH", "Paragraph Translation", "Luy\u1EC7n d\u1ECBch \u0111o\u1EA1n v\u0103n", List.of()),
            new NavEntry(List.of("sentence lab", "writing sentence lab", "dat cau"), "/writing?w=sentence-lab", "Sentence Lab", "Ph\u00F2ng luy\u1EC7n \u0111\u1EB7t c\u00E2u", List.of()),
            new NavEntry(List.of("typing", "english typing", "go tieng anh", "danh may"), "/writing?w=typing", "Typing Practice", "Luy\u1EC7n g\u00F5 ti\u1EBFng Anh", List.of()),
            new NavEntry(List.of("speed reading", "doc nhanh"), "/reading?section=speed", "Speed Reading", "\u0110\u1ECDc nhanh", List.of(intent("reading_control", "tab", "speed"))),
            new NavEntry(List.of("bilingual reading", "doc song ngu"), "/reading?section=bilingual", "Bilingual Reading", "\u0110\u1ECDc song ng\u1EEF", List.of(intent("reading_control", "tab", "bilingual")))
    );

    private static final Map<String, EchoDestinations.Dest> HREF_TO_DEST = buildHrefToDestMap();

    private static Map<String, EchoDestinations.Dest> buildHrefToDestMap() {
        Map<String, EchoDestinations.Dest> m = new HashMap<>();
        for (EchoDestinations.Dest d : EchoDestinations.Dest.values()) {
            if (!d.parameterised()) {
                m.put(d.pattern(), d);
            }
        }
        return Map.copyOf(m);
    }

    public static Outcome evaluate(String rawUtterance, String pathname, boolean hasPendingConfirmation) {
        return evaluate(rawUtterance, pathname, hasPendingConfirmation, false, List.of());
    }

    public static Outcome evaluate(String rawUtterance, String pathname, boolean hasPendingConfirmation, boolean hasActiveStrictSentinel) {
        return evaluate(rawUtterance, pathname, hasPendingConfirmation, hasActiveStrictSentinel, List.of());
    }

    public static Outcome evaluate(String rawUtterance, String pathname, boolean hasPendingConfirmation, List<EchoSalientResourceDto> salientResources) {
        return evaluate(rawUtterance, pathname, hasPendingConfirmation, false, salientResources);
    }

    public static Outcome evaluate(String rawUtterance, String pathname, boolean hasPendingConfirmation,
                                   boolean hasActiveStrictSentinel, List<EchoSalientResourceDto> salientResources) {
        String path = pathname == null ? "/dashboard" : pathname.trim();
        Guard guard = detectGuard(rawUtterance, path, hasActiveStrictSentinel);
        if (guard != null) {
            return new Outcome(guard, null);
        }
        if (rawUtterance == null || rawUtterance.isBlank() || rawUtterance.length() > 320) {
            return new Outcome(null, null);
        }

        List<EchoSalientResourceDto> validSalient = TurnProvenance.sanitizeSalientResources(salientResources);
        String lang = detectLanguage(rawUtterance);

        // Pending vocal confirmation/cancellation checked before general negation blocking ("do not apply" cancels pending card, while "không hủy" NEVER cancels!)
        if (hasPendingConfirmation) {
            String decision = matchPendingConfirmationDecision(rawUtterance);
            if ("confirm".equals(decision)) {
                CompiledClause c = new CompiledClause(List.of(intent("voice_confirm", "decision", "confirm")), "Confirmed.", "\u0110\u00E3 x\u00E1c nh\u1EADn.");
                return new Outcome(null, new FastPathPlan(lang, joinAcks(List.of(c), lang), c.intents(), List.of(rawUtterance.trim())));
            }
            if ("cancel".equals(decision)) {
                CompiledClause c = new CompiledClause(List.of(intent("voice_confirm", "decision", "cancel")), "Cancelled.", "\u0110\u00E3 h\u1EE7y thao t\u00E1c.");
                return new Outcome(null, new FastPathPlan(lang, joinAcks(List.of(c), lang), c.intents(), List.of(rawUtterance.trim())));
            }
        }

        UtteranceAnalysis sa = EchoSpeechActAnalyzer.analyze(rawUtterance);
        if (sa.blocksFastPathOrGuard() || sa.hasConversationalOrQuestionClause()) {
            return new Outcome(null, null);
        }

        // Safe dictionary lookup of a single tail-quoted word/idiom: Look up "break the ice"
        String unwrappedDict = unwrapSafeDictTailQuote(rawUtterance);
        if (unwrappedDict != null) {
            CompiledClause dictClause = compileSingleClause(unwrappedDict, hasPendingConfirmation, path, validSalient);
            if (dictClause != null) {
                return new Outcome(null, new FastPathPlan(lang, joinAcks(List.of(dictClause), lang), dictClause.intents(), List.of(unwrappedDict)));
            }
        }

        // If quoted sentinel remains anywhere in the utterance, never execute Fast-Path ("Open 'anything' reading" -> PLANE_B)
        if (sa.hasQuotedSpan()) {
            return new Outcome(null, null);
        }

        // Collect surviving executable directive clauses (after intra-utterance self-repair & negation filtering)
        List<ClauseAnalysis> executableClauses = sa.clauses().stream()
                .filter(ClauseAnalysis::isExecutableDirective)
                .toList();
        if (executableClauses.isEmpty()) {
            return new Outcome(null, null);
        }

        // Try atomic single-clause compilation first (when no self-repair split or single repaired clause, and no partial negation)
        if (executableClauses.size() == sa.clauses().size()) {
            String candidateFull = sa.hadSelfRepair() && executableClauses.size() == 1
                    ? executableClauses.get(0).cleanedClause()
                    : sa.maskedUtterance();
            CompiledClause single = compileSingleClause(candidateFull, hasPendingConfirmation, path, validSalient);
            if (single != null) {
                return new Outcome(null, new FastPathPlan(lang, joinAcks(List.of(single), lang), single.intents(), List.of(candidateFull)));
            }
        }

        // Multi-clause deterministic execution (either from EchoSpeechActAnalyzer clauses or COMPOUND_SPLIT_RE)
        List<String> partsToCompile;
        if (executableClauses.size() >= 2) {
            partsToCompile = executableClauses.stream().map(ClauseAnalysis::cleanedClause).filter(s -> !s.isEmpty()).toList();
        } else if (executableClauses.size() == 1 && executableClauses.size() < sa.clauses().size()) {
            String only = executableClauses.get(0).cleanedClause();
            CompiledClause c = compileSingleClause(only, hasPendingConfirmation, path, validSalient);
            if (c != null) {
                return new Outcome(null, new FastPathPlan(lang, joinAcks(List.of(c), lang), c.intents(), List.of(only)));
            }
            return new Outcome(null, null);
        } else {
            String base = sa.hadSelfRepair() ? executableClauses.get(0).cleanedClause() : sa.maskedUtterance();
            partsToCompile = Arrays.stream(COMPOUND_SPLIT_RE.split(base))
                    .map(String::trim)
                    .filter(s -> !s.isEmpty())
                    .toList();
        }

        if (partsToCompile.size() >= 2 && partsToCompile.size() <= 5) {
            List<CompiledClause> compiled = new ArrayList<>();
            String simulatedPath = path;
            for (String part : partsToCompile) {
                if (EchoSpeechActAnalyzer.isNegatedOrDeferredClause(EchoSpeechActAnalyzer.foldAsciiKeepSentinel(part))) {
                    return new Outcome(null, null);
                }
                CompiledClause c = compileSingleClause(part, hasPendingConfirmation, simulatedPath, validSalient);
                if (c == null) {
                    return new Outcome(null, null);
                }
                compiled.add(c);
                for (Map<String, Object> i : c.intents()) {
                    Object k = i.get("kind");
                    if ("navigate".equals(k) && i.get("href") instanceof String href) {
                        int q = href.indexOf('?');
                        simulatedPath = q >= 0 ? href.substring(0, q) : href;
                    } else if ("mybooks_open_last".equals(k)) {
                        simulatedPath = "/reading";
                    }
                }
            }
            List<Map<String, Object>> allIntents = new ArrayList<>();
            for (CompiledClause c : compiled) allIntents.addAll(c.intents());
            return new Outcome(null, new FastPathPlan(lang, joinAcks(compiled, lang), allIntents, partsToCompile));
        }

        return new Outcome(null, null);
    }

    /**
     * Shared bridge for {@link EchoRouter#direct(String)}: resolves a single-destination navigation utterance using the
     * exact same Speech-Act + Concept-Slot engine as WS Voice Plane A, guaranteeing zero split-brain between Text and Voice.
     */
    public static Optional<EchoRouter.Command> resolveDirectNavigation(String rawUtterance) {
        Outcome outcome = evaluate(rawUtterance, "/dashboard", false, false, List.of());
        if (outcome.guard() != null || outcome.plan() == null) {
            return Optional.empty();
        }
        FastPathPlan plan = outcome.plan();
        if (plan.clauses().size() != 1) {
            return Optional.empty();
        }
        String navHref = null;
        for (Map<String, Object> i : plan.intents()) {
            String kind = String.valueOf(i.get("kind"));
            if ("navigate".equals(kind) && i.get("href") instanceof String h) {
                navHref = h;
            } else if (!"reading_control".equals(kind) && !"speaking_control".equals(kind)) {
                // Non-navigation UI command (e.g. dark mode, scroll, dictionary): not an EchoRouter.Command(NAVIGATE)
                return Optional.empty();
            }
        }
        if (navHref == null) return Optional.empty();
        if ("/exams/ielts".equals(navHref)) {
            return Optional.of(new EchoRouter.Command(EchoRouter.CommandType.NAVIGATE, EchoDestinations.Dest.EXAMS_FAMILY, "ielts"));
        }
        if ("/exams/toeic".equals(navHref)) {
            return Optional.of(new EchoRouter.Command(EchoRouter.CommandType.NAVIGATE, EchoDestinations.Dest.EXAMS_FAMILY, "toeic"));
        }
        EchoDestinations.Dest dest = HREF_TO_DEST.get(navHref);
        if (dest != null) {
            return Optional.of(new EchoRouter.Command(EchoRouter.CommandType.NAVIGATE, dest, null));
        }
        return Optional.empty();
    }

    public static Guard detectGuard(String rawUtterance, String pathname, boolean hasActiveStrictSentinel) {
        if (hasActiveStrictSentinel) {
            return new Guard("DENIED", "strict_sentinel_lockdown",
                    "Echo is paused while a strict-focus contest or exam simulation is active.",
                    "Echo t\u1EA1m kh\u00F3a trong su\u1ED1t phi\u00EAn thi ho\u1EB7c l\u01B0\u1EE3t \u0111\u1EA5u ch\u1EBF \u0111\u1ED9 nghi\u00EAm ng\u1EB7t.");
        }
        if (pathname != null && ACTIVE_EXAM_SIM_RE.matcher(pathname).find()) {
            return new Guard("DENIED", "active_exam_simulation",
                    "Echo cannot run or assist during an active exam simulation.",
                    "Echo kh\u00F4ng th\u1EC3 ho\u1EA1t \u0111\u1ED9ng ho\u1EB7c h\u1ED7 tr\u1EE3 trong l\u00FAc b\u1EA1n \u0111ang l\u00E0m b\u00E0i thi th\u1EED.");
        }
        if (rawUtterance == null || rawUtterance.isBlank()) return null;

        UtteranceAnalysis sa = EchoSpeechActAnalyzer.analyze(rawUtterance);
        if (sa.utteranceKind() == SpeechActKind.METALINGUISTIC_MENTION
                || sa.utteranceKind() == SpeechActKind.HYPOTHETICAL_CONDITION) {
            return null;
        }

        String unquotedFolded = normalizeAsciiFold(
                sa.maskedUtterance().replace(EchoSpeechActAnalyzer.QUOTED_SENTINEL, " "));
        if (unquotedFolded.isEmpty()) return null;

        if (PROMPT_INJECTION_RE.matcher(unquotedFolded).find()) {
            return new Guard("DENIED", "prompt_injection_blocked",
                    "That instruction conflicts with Echo safety boundaries and was blocked.",
                    "Y\u00EAu c\u1EA7u n\u00E0y vi ph\u1EA1m quy t\u1EAFc an to\u00E0n c\u1EE7a Echo n\u00EAn \u0111\u00E3 b\u1ECB ch\u1EB7n.");
        }

        // Negation-aware guard evaluation: "Don't delete my account" / "Đừng xóa tài khoản" is NOT a mutation attempt!
        if (sa.utteranceKind() == SpeechActKind.NEGATED_OR_DEFERRED) {
            return null;
        }
        String activeTrusted = normalizeAsciiFold(EchoSpeechActAnalyzer.activeTrustedClausesText(sa));
        if (activeTrusted.isEmpty()) return null;

        if (pathname != null && ACTIVE_GRAMMAR_CHECK_RE.matcher(pathname).find() && GRAMMAR_CHECK_SOLVE_RE.matcher(activeTrusted).find()) {
            return new Guard("DENIED", "active_grammar_mastery_check",
                    "Echo cannot solve items during an active Grammar Mastery Check.",
                    "Echo kh\u00F4ng th\u1EC3 gi\u1EA3i \u0111\u00E1p \u00E1n trong l\u00FAc ki\u1EC3m tra th\u00E0nh th\u1EA1o Ng\u1EEF ph\u00E1p.");
        }
        if (SRS_AUTO_RATE_RE.matcher(activeTrusted).find()) {
            return new Guard("DENIED", "srs_auto_rate_forbidden",
                    "Flashcard recall ratings belong to your own memory check, so Echo never auto-rates cards.",
                    "M\u1EE9c \u0111\u1ED9 nh\u1EDB th\u1EBB t\u1EEB v\u1EF1ng c\u1EA7n do ch\u00EDnh b\u1EA1n t\u1EF1 \u0111\u00E1nh gi\u00E1 n\u00EAn Echo kh\u00F4ng t\u1EF1 \u0111\u1ED9ng ch\u1EA5m th\u1EBB.");
        }
        if (PAYMENT_MUTATION_RE.matcher(activeTrusted).find()) {
            return new Guard("DENIED", "payment_or_quota_mutation_forbidden",
                    "Echo cannot execute payments or modify quotas. I can open the Premium page for you.",
                    "Echo kh\u00F4ng th\u1EC3 th\u1EF1c hi\u1EC7n thanh to\u00E1n hay thay \u0111\u1ED5i h\u1EA1n m\u1EE9c.");
        }
        if (SECURITY_ADMIN_RE.matcher(activeTrusted).find()) {
            return new Guard("DENIED", "security_or_admin_mutation_forbidden",
                    "Password, two-factor authentication, and administrator actions must be performed manually by you.",
                    "\u0110\u1ED5i m\u1EADt kh\u1EA9u, x\u00E1c th\u1EF1c hai l\u1EDBp v\u00E0 thao t\u00E1c qu\u1EA3n tr\u1ECB c\u1EA7n \u0111\u01B0\u1EE3c b\u1EA1n th\u1EF1c hi\u1EC7n tr\u1EF1c ti\u1EBFp.");
        }
        if (FOREIGN_USER_DATA_RE.matcher(activeTrusted).find()) {
            return new Guard("DENIED", "foreign_user_data_forbidden",
                    "Echo can only access your own learning profile and records.",
                    "Echo ch\u1EC9 \u0111\u01B0\u1EE3c ph\u00E9p truy c\u1EADp h\u1ED3 s\u01A1 v\u00E0 d\u1EEF li\u1EC7u h\u1ECDc t\u1EADp c\u1EE7a ri\u00EAng b\u1EA1n.");
        }
        if (EXTERNAL_UNSUPPORTED_RE.matcher(activeTrusted).find()) {
            return new Guard("UNSUPPORTED", "outside_platform_sandbox",
                    "Echo can control screens and tools inside English Coach, not external websites or operating system apps.",
                    "Echo ch\u1EC9 \u0111i\u1EC1u khi\u1EC3n c\u00E1c t\u00EDnh n\u0103ng b\u00EAn trong English Coach, kh\u00F4ng m\u1EDF trang web ngo\u00E0i hay \u1EE9ng d\u1EE5ng h\u1EC7 \u0111i\u1EC1u h\u00E0nh.");
        }
        return null;
    }

    private static CompiledClause compileSingleClause(String rawClause, boolean hasPendingConfirm,
                                                      String currentPathname, List<EchoSalientResourceDto> salientResources) {
        String cleaned = cleanClause(rawClause);
        if (cleaned.isEmpty() || cleaned.length() > 180 || cleaned.contains(EchoSpeechActAnalyzer.QUOTED_SENTINEL)) {
            return null;
        }

        // 1. Vocal confirm/cancel (ONLY when confirmation token is pending; "không hủy" NEVER cancels!)
        if (hasPendingConfirm) {
            String decision = matchPendingConfirmationDecision(rawClause);
            if ("confirm".equals(decision)) {
                return new CompiledClause(List.of(intent("voice_confirm", "decision", "confirm")), "Confirmed.", "\u0110\u00E3 x\u00E1c nh\u1EADn.");
            }
            if ("cancel".equals(decision)) {
                return new CompiledClause(List.of(intent("voice_confirm", "decision", "cancel")), "Cancelled.", "\u0110\u00E3 h\u1EE7y thao t\u00E1c.");
            }
        }
        if (cleaned.matches("^(?:confirm|yes|yes confirm|yes apply|yes apply it|apply it|go ahead|do it|approve|xac nhan|dong y|ap dung|ap dung di|u xac nhan|vang xac nhan|ok xac nhan|cancel|no cancel|never mind|nevermind|abort|do not apply|dont apply|don't apply|huy|huy bo|thoi bo|thoi huy)$")) {
            return null;
        }

        // 1b. Salience Anaphora Resolution evaluated before BRAIN_DELEGATION_RE so "mở gợi ý số 2" / "open suggestion 2" resolves cleanly
        if (salientResources != null && !salientResources.isEmpty()) {
            CompiledClause anaphora = resolveSalientAnaphora(cleaned, salientResources);
            if (anaphora != null) {
                return anaphora;
            }
        }

        // Delegate pedagogical / analytical / catalog-search utterances to Plane B
        if (BRAIN_DELEGATION_RE.matcher(cleaned).find()) {
            return null;
        }

        // 2. Undo last UI action
        if (cleaned.matches("^(?:undo|undo that|undo last action|revert that|hoan tac|hoan tac thao tac(?: vua roi)?|quay lai thao tac truoc)$")) {
            return new CompiledClause(List.of(intent("undo_last_action")), "Undid the last action.", "\u0110\u00E3 ho\u00E0n t\u00E1c thao t\u00E1c v\u1EEBa r\u1ED3i.");
        }

        // 3. Voice controls (including "disable hands-free" / "turn off hands-free")
        if (cleaned.matches("^(?:go to sleep|sleep|sleep mode|stop listening|rest now|(?:turn off|disable) hands[- ]?free|di ngu|di ngu di|tam nghi|tam nghi di|ngung nghe|tat (?:che do )?ranh tay)$")) {
            return new CompiledClause(List.of(intent("voice_control", "command", "sleep")),
                    "Going to sleep. Say Hey Echo whenever you need me.",
                    "M\u00ECnh t\u1EA1m ngh\u1EC9 nh\u00E9. G\u1ECDi Hey Echo b\u1EA5t c\u1EE9 khi n\u00E0o b\u1EA1n c\u1EA7n.");
        }
        if (cleaned.matches("^(?:mute|mute mic|mute microphone|tat mic|tat micro)$")) {
            return new CompiledClause(List.of(intent("voice_control", "command", "mute")), "Microphone muted.", "\u0110\u00E3 t\u1EAFt micro.");
        }
        if (cleaned.matches("^(?:unmute|unmute mic|unmute microphone|bat mic|mo mic|bat micro)$")) {
            return new CompiledClause(List.of(intent("voice_control", "command", "unmute")), "Microphone active.", "\u0110\u00E3 b\u1EADt micro.");
        }
        if (cleaned.matches("^(?:compact mode|minimize echo|minimize chat|thu gon echo|thu nho khung chat|che do thu gon)$")) {
            return new CompiledClause(List.of(intent("voice_control", "command", "compact")), "Switched to compact mode.", "\u0110\u00E3 chuy\u1EC3n sang ch\u1EBF \u0111\u1ED9 thu g\u1ECDn.");
        }
        if (cleaned.matches("^(?:expand chat|expand echo|expanded mode|mo rong echo|mo rong khung chat)$")) {
            return new CompiledClause(List.of(intent("voice_control", "command", "expand")), "Expanded Echo chat.", "\u0110\u00E3 m\u1EDF r\u1ED9ng khung tr\u00F2 chuy\u1EC7n.");
        }
        if (cleaned.matches("^(?:open echo workspace|immersive workspace|full echo workspace|khong gian echo toan man hinh|mo khong gian echo)$")) {
            return new CompiledClause(List.of(intent("voice_control", "command", "workspace")), "Opened Echo workspace.", "\u0110\u00E3 m\u1EDF kh\u00F4ng gian Echo to\u00E0n m\u00E0n h\u00ECnh.");
        }

        // 4. Logout (CONFIRM_REQUIRED on client PermissionEngine)
        if (cleaned.matches("^(?:log out|logout|sign out|sign me out|log me out|dang xuat|thoat tai khoan)$")) {
            return new CompiledClause(List.of(intent("request_logout")),
                    "Please confirm if you want to sign out.",
                    "Vui l\u00F2ng x\u00E1c nh\u1EADn n\u1EBFu b\u1EA1n mu\u1ED1n \u0111\u0103ng xu\u1EA5t.");
        }

        // 5. History back / forward (including anaphoric "take me back there" / "quay lại trang trước")
        if (cleaned.matches("^(?:go back(?: there)?|take me back(?: there)?|back|back to (?:the )?previous (?:screen|page)|previous (?:screen|page)|navigate back|(?:quay lai|tro lai|lui lai|quay ve|ve)(?: trang truoc| man hinh truoc| cho nay| cho vua nay)?|trang truoc)$")) {
            return new CompiledClause(List.of(intent("history_back")), "Going back.", "\u0110ang quay l\u1EA1i trang tr\u01B0\u1EDBc.");
        }
        if (cleaned.matches("^(?:go forward|navigate forward|tien toi|chuyen tiep trang)$")) {
            return new CompiledClause(List.of(intent("history_forward")), "Going forward.", "\u0110ang ti\u1EBFn t\u1EDBi.");
        }

        // 6. Scroll
        if (cleaned.matches("^(?:scroll to (?:the )?top|back to top|go to top|cuon len dau trang|len dau trang|ve dau trang)$")) {
            return new CompiledClause(List.of(intent("scroll", "target", "top")), "Scrolled to the top.", "\u0110\u00E3 cu\u1ED9n l\u00EAn \u0111\u1EA7u trang.");
        }
        if (cleaned.matches("^(?:scroll to (?:the )?bottom|go to bottom|cuon xuong cuoi trang|xuong cuoi trang|ve cuoi trang)$")) {
            return new CompiledClause(List.of(intent("scroll", "target", "bottom")), "Scrolled to the bottom.", "\u0110\u00E3 cu\u1ED9n xu\u1ED1ng cu\u1ED1i trang.");
        }
        if (cleaned.matches("^(?:scroll down|page down|move down|(?:cuon|keo|luot) xuong(?: duoi)?)$")) {
            return new CompiledClause(List.of(intent("scroll", "target", "down")), "Scrolled down.", "\u0110\u00E3 cu\u1ED9n xu\u1ED1ng.");
        }
        if (cleaned.matches("^(?:scroll up|page up|move up|(?:cuon|keo|luot) len(?: tren)?)$")) {
            return new CompiledClause(List.of(intent("scroll", "target", "up")), "Scrolled up.", "\u0110\u00E3 cu\u1ED9n l\u00EAn.");
        }

        // 7. Theme Mode (including UI toggle-off "turn off dark mode" / "tắt chế độ tối")
        if (cleaned.matches("^(?:(?:switch to|turn on|enable|use|set|chuyen sang|chuyen qua|bat|doi sang|dung)\\s+)?(?:dark mode|dark theme|night mode|che do toi|nen toi|giao dien toi)$")) {
            return new CompiledClause(List.of(intent("theme_mode", "mode", "dark")), "Switched to dark mode.", "\u0110\u00E3 chuy\u1EC3n sang ch\u1EBF \u0111\u1ED9 t\u1ED1i.");
        }
        if (cleaned.matches("^(?:(?:switch to|turn on|enable|use|set|chuyen sang|chuyen qua|bat|doi sang|dung)\\s+)?(?:light mode|light theme|day mode|che do sang|nen sang|giao dien sang)$")
                || cleaned.matches("^(?:turn off|disable|exit|tat)\\s+(?:dark mode|dark theme|night mode|che do toi|nen toi|giao dien toi)$")) {
            return new CompiledClause(List.of(intent("theme_mode", "mode", "light")), "Switched to light mode.", "\u0110\u00E3 chuy\u1EC3n sang ch\u1EBF \u0111\u1ED9 s\u00E1ng.");
        }
        if (cleaned.matches("^(?:(?:switch to|use|set|chuyen sang|doi sang|dung)\\s+)?(?:system theme|system mode|auto theme|giao dien he thong|theo he thong)$")) {
            return new CompiledClause(List.of(intent("theme_mode", "mode", "system")), "Set theme to match your system.", "\u0110\u00E3 \u0111\u1EB7t giao di\u1EC7n theo h\u1EC7 th\u1ED1ng.");
        }

        // 8. UI Locale
        if (cleaned.matches("^(?:switch (?:ui |interface |app |language )?to vietnamese|change language to vietnamese|vietnamese interface|chuyen (?:giao dien |ngon ngu )?(?:sang |qua )?tieng viet|doi (?:giao dien )?sang tieng viet|dung tieng viet)$")) {
            return new CompiledClause(List.of(intent("ui_locale", "locale", "vi")), "Switched interface language to Vietnamese.", "\u0110\u00E3 chuy\u1EC3n ng\u00F4n ng\u1EEF giao di\u1EC7n sang ti\u1EBFng Vi\u1EC7t.");
        }
        if (cleaned.matches("^(?:switch (?:ui |interface |app |language )?to english|change language to english|english interface|chuyen (?:giao dien |ngon ngu )?(?:sang |qua )?tieng anh|doi (?:giao dien )?sang tieng anh)$")) {
            return new CompiledClause(List.of(intent("ui_locale", "locale", "en")), "Switched interface language to English.", "\u0110\u00E3 chuy\u1EC3n ng\u00F4n ng\u1EEF giao di\u1EC7n sang ti\u1EBFng Anh.");
        }

        // 9. Navigation Layout & Visibility (including "hide navigation" / "ẩn thanh điều hướng")
        if (cleaned.matches("^(?:(?:switch to|use|enable|show|chuyen sang|chuyen qua|dung|bat)\\s+)?(?:macos dock|dock layout|dock navigation|dock mode|horizontal navigation|thanh dock|che do dock|giao dien dock)$")) {
            return new CompiledClause(List.of(intent("nav_layout", "layout", "dock")), "Switched navigation to the Dock.", "\u0110\u00E3 chuy\u1EC3n thanh \u0111i\u1EC1u h\u01B0\u1EDBng sang d\u1EA1ng Dock.");
        }
        if (cleaned.matches("^(?:(?:switch to|use|enable|show|chuyen sang|chuyen qua|dung|bat)\\s+)?(?:sidebar|sidebar layout|sidebar navigation|vertical navigation|thanh ben|che do thanh ben)$")) {
            return new CompiledClause(List.of(intent("nav_layout", "layout", "sidebar")), "Switched navigation to the sidebar.", "\u0110\u00E3 chuy\u1EC3n v\u1EC1 thanh \u0111i\u1EC1u h\u01B0\u1EDBng b\u00EAn c\u1EA1nh.");
        }
        if (cleaned.matches("^(?:(?:auto[- ]?hide|hide) (?:the )?(?:sidebar|dock|navigation(?: bar)?|menu)|(?:tu an|an) (?:thanh ben|thanh dieu huong|dock|menu))$")) {
            return new CompiledClause(List.of(intent("nav_visibility", "visibility", "autohide")), "Enabled auto-hide for navigation.", "\u0110\u00E3 b\u1EADt ch\u1EBF \u0111\u1ED9 t\u1EF1 \u1EA9n thanh \u0111i\u1EC1u h\u01B0\u1EDBng.");
        }
        if (cleaned.matches("^(?:(?:pin|show) (?:the )?(?:sidebar|dock|navigation(?: bar)?|menu)|keep (?:sidebar|navigation) visible|(?:ghim|hien) (?:thanh ben|thanh dieu huong|dock|menu))$")) {
            return new CompiledClause(List.of(intent("nav_visibility", "visibility", "pinned")), "Pinned the navigation bar.", "\u0110\u00E3 ghim c\u1ED1 \u0111\u1ECBnh thanh \u0111i\u1EC1u h\u01B0\u1EDBng.");
        }

        // 10. World Display (strictly odyssey | cosmos; Study Space & Speaking Arena map to navigate!)
        if (cleaned.matches("^(?:embed|embedded mode for|floating mode for|thu nho khung)\\s+(?:echo\\s+)?(odyssey|cosmos|knowledge universe|vu tru tri thuc)$")) {
            String world = resolveWorldId(cleaned);
            return new CompiledClause(List.of(intent("world_display", "world", world, "display", "embedded")),
                    "Switched world view to embedded workspace mode.", "\u0110\u00E3 chuy\u1EC3n sang ch\u1EBF \u0111\u1ED9 hi\u1EC3n th\u1ECB trong khung l\u00E0m vi\u1EC7c.");
        }
        if (cleaned.matches("^(?:immersive mode for|fullscreen mode for|full viewport)\\s+(?:echo\\s+)?(odyssey|cosmos|knowledge universe|vu tru tri thuc)$")) {
            String world = resolveWorldId(cleaned);
            return new CompiledClause(List.of(intent("world_display", "world", world, "display", "immersive")),
                    "Switched world view to immersive mode.", "\u0110\u00E3 chuy\u1EC3n sang ch\u1EBF \u0111\u1ED9 tr\u00E0n vi\u1EC1n.");
        }
        if (cleaned.matches("^(?:(?:open|enter|launch|immersive mode for|fullscreen mode for|full viewport)\\s+)?(?:study space|echo life)(?:\\s+(?:in\\s+)?(?:fullscreen|immersive(?:\\s+mode)?))?$")
                && (cleaned.contains("fullscreen") || cleaned.contains("immersive") || cleaned.contains("full viewport"))) {
            return buildNavClause(Objects.requireNonNull(findNavByHref("/study-space")));
        }
        if (cleaned.matches("^(?:(?:open|enter|launch|immersive mode for|fullscreen mode for|full viewport)\\s+)?(?:speaking arena|echo archipelago|arena)(?:\\s+(?:in\\s+)?(?:fullscreen|immersive(?:\\s+mode)?))?$")
                && (cleaned.contains("fullscreen") || cleaned.contains("immersive") || cleaned.contains("full viewport"))) {
            return buildNavClause(Objects.requireNonNull(findNavByHref("/speaking/arena")));
        }

        // 11. Guide
        if (cleaned.matches("^(?:open (?:echo )?guide|show guide|app tour|mo huong dan|xem huong dan su dung)$")) {
            return new CompiledClause(List.of(intent("open_guide")), "Opened Echo Guide.", "\u0110\u00E3 m\u1EDF b\u1EA3ng h\u01B0\u1EDBng d\u1EABn Echo.");
        }

        // 12. Background & Appearance Studio (including 'worlds' and 'navigation' rooms)
        for (BgPreset preset : BG_PRESETS) {
            for (String phrase : preset.patterns()) {
                if (cleaned.equals(phrase)
                        || cleaned.equals(phrase + " background")
                        || cleaned.equals(phrase + " theme")
                        || cleaned.matches("^(?:apply|set|use|switch|change|enable|doi|chuyen|chon|ap dung|bat)(?:\\s+(?:background|theme|wallpaper|nen|hinh nen|giao dien|mau nen))?(?:\\s+(?:to|sang|qua|thanh))?\\s+" + Pattern.quote(phrase) + "(?:\\s+(?:background|theme|preset))?$")) {
                    return new CompiledClause(List.of(intent("apply_bg_preset", "presetId", preset.id())),
                            "Applied the " + preset.enName() + " background.",
                            "\u0110\u00E3 \u0111\u1ED5i n\u1EC1n sang " + preset.viName() + ".");
                }
            }
        }
        if (cleaned.matches("^(?:darken (?:the )?background|dim (?:the )?background|make (?:the )?background darker|lower background brightness|lam toi nen|giam do sang nen|cho nen toi hon)$")) {
            return new CompiledClause(List.of(intent("adjust_bg_brightness", "delta", -15)), "Darkened the background.", "\u0110\u00E3 gi\u1EA3m \u0111\u1ED9 s\u00E1ng n\u1EC1n.");
        }
        if (cleaned.matches("^(?:brighten (?:the )?background|make (?:the )?background brighter|increase background brightness|lam sang nen|tang do sang nen|cho nen sang hon)$")) {
            return new CompiledClause(List.of(intent("adjust_bg_brightness", "delta", 15)), "Brightened the background.", "\u0110\u00E3 t\u0103ng \u0111\u1ED9 s\u00E1ng n\u1EC1n.");
        }
        if (cleaned.matches("^(?:reset (?:the )?(?:appearance|background|wallpaper)(?: to (?:default|echo ocean))?|default (?:appearance|background)|restore default (?:look|appearance|background)|dat lai (?:nen|giao dien)(?: mac dinh)?|khoi phuc (?:nen|giao dien) mac dinh|ve (?:nen|giao dien) mac dinh)$")) {
            return new CompiledClause(List.of(intent("reset_appearance")), "Restored the default Echo Ocean appearance.", "\u0110\u00E3 kh\u00F4i ph\u1EE5c giao di\u1EC7n Echo Ocean m\u1EB7c \u0111\u1ECBnh.");
        }
        if (cleaned.matches("^(?:open (?:appearance|background|wallpaper|media|spatial|theme|worlds?|world display|navigation)(?: studio)?(?: settings| room)?|open (?:appearance|background|wallpaper|media|spatial|worlds?|navigation) studio|open appearance studio (?:background|media|worlds|spatial|navigation)|customize (?:background|appearance|wallpaper|worlds?|navigation)|mo (?:cai dat )?(?:giao dien|hinh nen|thanh dieu huong|the gioi(?: 3d)?)|mo (?:background|worlds|navigation) studio|mo studio hinh nen|tuy chinh (?:hinh nen|thanh dieu huong|giao dien))$")) {
            Map<String, Object> i = intent("open_appearance_studio");
            if (cleaned.contains("navigation") || cleaned.contains("thanh dieu huong")) i.put("room", "navigation");
            else if (cleaned.contains("world") || cleaned.contains("the gioi")) i.put("room", "worlds");
            else if (cleaned.contains("background")) i.put("room", "background");
            else if (cleaned.contains("spatial")) i.put("room", "spatial");
            else if (cleaned.contains("wallpaper") || cleaned.contains("media") || cleaned.contains("hinh nen")) i.put("room", "media");
            return new CompiledClause(List.of(i), "Opened Appearance Studio.", "\u0110\u00E3 m\u1EDF b\u1EA3ng t\u00F9y ch\u1EC9nh Giao di\u1EC7n.");
        }

        // 13. Dictionary lookup
        if (cleaned.matches("^(?:open (?:the |my )?dictionary|launch (?:the )?dictionary|mo tu dien|bat tu dien)$")) {
            return new CompiledClause(List.of(intent("dictionary_lookup", "word", "")), "Opened the dictionary.", "\u0110\u00E3 m\u1EDF t\u1EEB \u0111i\u1EC3n.");
        }
        String dictWord = extractDictionaryHeadword(cleaned);
        if (dictWord != null) {
            return new CompiledClause(List.of(intent("dictionary_lookup", "word", dictWord)),
                    "Looking up \"" + dictWord + "\" in the dictionary.",
                    "\u0110ang tra t\u1EEB \"" + dictWord + "\" trong t\u1EEB \u0111i\u1EC3n.");
        }

        // 14. My Books (including Benchmark #3 atomic compound: "open my last book and continue where I stopped")
        if (cleaned.matches("^(?:open (?:my )?(?:last|latest|recent|most recent|current) book(?:\\s+(?:and|then)\\s+(?:continue|resume)(?:\\s+reading)?(?:\\s+(?:where|from where)\\s+(?:i|we)\\s+(?:stopped|left off))?)?|continue (?:reading )?(?:my )?(?:last |recent )?book(?:\\s+(?:where|from where)\\s+(?:i|we)\\s+(?:stopped|left off))?|resume my book|mo (?:cuon )?sach (?:doc )?gan (?:day )?nhat(?:\\s+(?:va|roi)\\s+(?:doc tiep|tiep tuc)(?:\\s+(?:cho|doan|trang)\\s+(?:dang dung|da dung|vua dung))?)?|mo sach dang doc(?: do)?|doc tiep sach(?: cua toi| cua minh)?(?:\\s+(?:cho|doan)\\s+dang dung)?)$")) {
            return new CompiledClause(List.of(intent("mybooks_open_last")),
                    "Opening your most recent book where you left off.",
                    "\u0110ang m\u1EDF cu\u1ED1n s\u00E1ch b\u1EA1n \u0111\u1ECDc g\u1EA7n nh\u1EA5t t\u1EA1i ch\u1ED7 \u0111ang d\u1EEBng.");
        }

        Matcher bookTheme = Pattern.compile("^(?:(?:switch|set|change|use|doi|chuyen)(?:\\s+(?:reader|book|sach|trang sach))?(?:\\s+(?:theme|background|mode|nen|che do))?(?:\\s+(?:to|sang|qua))?\\s+)(paper|sepia|white|oled|giay|giay vang|trang|den oled)(?:\\s+(?:theme|mode|reader))?$").matcher(cleaned);
        if (bookTheme.matches()) {
            String rawT = bookTheme.group(1);
            String theme = "paper", labelEn = "paper", labelVi = "gi\u1EA5y \u1EA5m";
            if ("white".equals(rawT) || "trang".equals(rawT)) { theme = "white"; labelEn = "white"; labelVi = "tr\u1EAFng s\u00E1ng"; }
            else if ("oled".equals(rawT) || "den oled".equals(rawT)) { theme = "oled"; labelEn = "OLED dark"; labelVi = "\u0111en OLED"; }
            return new CompiledClause(List.of(intent("mybooks_reader", "theme", theme)),
                    "Switched reader theme to " + labelEn + ".",
                    "\u0110\u00E3 \u0111\u1ED5i n\u1EC1n \u0111\u1ECDc s\u00E1ch sang " + labelVi + ".");
        }
        if (cleaned.matches("^(?:next page|turn (?:the )?page|flip page|trang sau|trang tiep theo|lat trang(?: tiep(?: theo)?)?)$")) {
            return new CompiledClause(List.of(intent("mybooks_reader", "page", "next")), "Turned to the next page.", "\u0110\u00E3 l\u1EADt sang trang ti\u1EBFp theo.");
        }
        if (cleaned.matches("^(?:previous page|prev page|turn back (?:a )?page|trang truoc|lat lai trang truoc)$")) {
            return new CompiledClause(List.of(intent("mybooks_reader", "page", "prev")), "Turned to the previous page.", "\u0110\u00E3 quay l\u1EA1i trang tr\u01B0\u1EDBc.");
        }

        // 15. Font size & Reading controls
        if (cleaned.matches("^(?:increase (?:the )?(?:font|text) size|make (?:the )?(?:font|text) (?:larger|bigger)|larger (?:font|text)|bigger (?:font|text)|zoom in text|(?:tang co chu|cho chu to|chu to|phong to chu)(?: len| hon)?(?: mot chut| xiu| ti)?)$")) {
            return new CompiledClause(List.of(
                    intent("ui_font_scale", "delta", 0.08),
                    intent("reading_control", "fontDelta", 2),
                    intent("mybooks_reader", "fontDelta", 2)),
                    "Increased the font size.", "\u0110\u00E3 t\u0103ng c\u1EE1 ch\u1EEF.");
        }
        if (cleaned.matches("^(?:decrease (?:the )?(?:font|text) size|make (?:the )?(?:font|text) smaller|smaller (?:font|text)|reduce font size|(?:giam co chu|cho chu nho|chu nho|thu nho chu)(?: xuong| lai| hon| di)?(?: mot chut| xiu| ti)?)$")) {
            return new CompiledClause(List.of(
                    intent("ui_font_scale", "delta", -0.08),
                    intent("reading_control", "fontDelta", -2),
                    intent("mybooks_reader", "fontDelta", -2)),
                    "Decreased the font size.", "\u0110\u00E3 gi\u1EA3m c\u1EE1 ch\u1EEF.");
        }
        if (cleaned.matches("^(?:wide (?:reading )?(?:width|layout|column)|widen reading column|kho doc rong|mo rong kho doc)$")) {
            return new CompiledClause(List.of(intent("reading_control", "width", "wide")), "Set reading width to wide.", "\u0110\u00E3 chuy\u1EC3n sang kh\u1ED5 \u0111\u1ECDc r\u1ED9ng.");
        }
        if (cleaned.matches("^(?:narrow (?:reading )?(?:width|layout|column)|kho doc hep|thu hep kho doc)$")) {
            return new CompiledClause(List.of(intent("reading_control", "width", "narrow")), "Set reading width to narrow.", "\u0110\u00E3 chuy\u1EC3n sang kh\u1ED5 \u0111\u1ECDc h\u1EB9p.");
        }
        if (cleaned.matches("^(?:comfortable (?:reading )?(?:width|layout)|default reading width|kho doc vua|kho doc tieu chuan)$")) {
            return new CompiledClause(List.of(intent("reading_control", "width", "comfortable")), "Set reading width to comfortable.", "\u0110\u00E3 \u0111\u1EB7t kh\u1ED5 \u0111\u1ECDc ti\u00EAu chu\u1EA9n.");
        }
        Matcher filterLevel = Pattern.compile("^(?:filter (?:reading )?(?:by )?(?:level )?|loc (?:bai doc )?(?:theo )?(?:trinh do |cap do )?)(a1|a2|b1|b2|c1|c2)$").matcher(cleaned);
        if (filterLevel.matches()) {
            String lvl = filterLevel.group(1).toUpperCase(Locale.ROOT);
            return new CompiledClause(List.of(intent("reading_control", "filterLevel", lvl)),
                    "Filtered Reading by level " + lvl + ".",
                    "\u0110\u00E3 l\u1ECDc b\u00E0i \u0111\u1ECDc theo tr\u00ECnh \u0111\u1ED9 " + lvl + ".");
        }
        Matcher switchTab = Pattern.compile("^(?:switch to |open )?(library|my books|bilingual|speed) tab$").matcher(cleaned);
        if (!switchTab.matches()) {
            switchTab = Pattern.compile("^(?:chuyen sang |mo )?tab (thu vien|sach cua toi|song ngu|doc nhanh)$").matcher(cleaned);
        }
        if (switchTab.matches()) {
            String rawTab = switchTab.group(1);
            String tab = "library";
            if ("my books".equals(rawTab) || "sach cua toi".equals(rawTab)) tab = "mybooks";
            else if ("bilingual".equals(rawTab) || "song ngu".equals(rawTab)) tab = "bilingual";
            else if ("speed".equals(rawTab) || "doc nhanh".equals(rawTab)) tab = "speed";
            List<Map<String, Object>> list = new ArrayList<>();
            if (!"/reading".equals(currentPathname)) {
                list.add(intent("navigate", "href", "library".equals(tab) ? "/reading" : "/reading?section=" + tab));
            }
            list.add(intent("reading_control", "tab", tab));
            return new CompiledClause(list, "Switched Reading to " + tab + ".", "\u0110\u00E3 chuy\u1EC3n tab trong m\u1EE5c \u0110\u1ECDc.");
        }

        // 16. Music controls
        if (cleaned.matches("^(?:play music|start music|resume music|phat nhac|bat nhac|mo nhac nghe|tiep tuc nhac)$")) {
            return new CompiledClause(List.of(intent("music_control", "command", "play")), "Playing Echo Music.", "\u0110ang ph\u00E1t nh\u1EA1c.");
        }
        if (cleaned.matches("^(?:pause music|stop music|mute music|tam dung nhac|dung nhac|tat nhac)$")) {
            return new CompiledClause(List.of(intent("music_control", "command", "pause")), "Paused music.", "\u0110\u00E3 t\u1EA1m d\u1EEBng nh\u1EA1c.");
        }
        if (cleaned.matches("^(?:next song|next track|skip song|skip track|bai tiep theo|qua bai|chuyen bai nhac)$")) {
            return new CompiledClause(List.of(intent("music_control", "command", "next")), "Skipped to the next track.", "\u0110\u00E3 chuy\u1EC3n sang b\u00E0i ti\u1EBFp theo.");
        }
        if (cleaned.matches("^(?:previous song|previous track|prev track|bai truoc|quay lai bai truoc)$")) {
            return new CompiledClause(List.of(intent("music_control", "command", "prev")), "Went back to the previous track.", "\u0110\u00E3 quay l\u1EA1i b\u00E0i nh\u1EA1c tr\u01B0\u1EDBc.");
        }
        if (cleaned.matches("^(?:music louder|increase music volume|turn up (?:the )?music|tang am luong nhac|cho nhac to len)$")) {
            return new CompiledClause(List.of(intent("music_control", "command", "volume_up")), "Turned up the music volume.", "\u0110\u00E3 t\u0103ng \u00E2m l\u01B0\u1EE3ng nh\u1EA1c.");
        }
        if (cleaned.matches("^(?:music quieter|decrease music volume|turn down (?:the )?music|giam am luong nhac|cho nhac nho xuong)$")) {
            return new CompiledClause(List.of(intent("music_control", "command", "volume_down")), "Lowered the music volume.", "\u0110\u00E3 gi\u1EA3m \u00E2m l\u01B0\u1EE3ng nh\u1EA1c.");
        }
        if (cleaned.matches("^(?:shuffle music|toggle shuffle|tron bai|phat ngau nhien)$")) {
            return new CompiledClause(List.of(intent("music_control", "command", "shuffle")), "Toggled music shuffle.", "\u0110\u00E3 b\u1EADt t\u1EAFt ch\u1EBF \u0111\u1ED9 ph\u00E1t ng\u1EABu nhi\u00EAn.");
        }

        // 17. Listening workspace player controls
        if (cleaned.matches("^(?:play (?:the )?(?:lesson|audio)|resume (?:the )?(?:lesson|audio)|phat bai nghe|tiep tuc bai nghe|chay bai nghe)$")) {
            return new CompiledClause(List.of(intent("listening_player", "command", "play")), "Playing the listening audio.", "\u0110ang ph\u00E1t b\u00E0i nghe.");
        }
        if (cleaned.matches("^(?:pause (?:the )?(?:lesson|audio)|stop (?:the )?(?:lesson|audio)|tam dung bai nghe|dung bai nghe)$")) {
            return new CompiledClause(List.of(intent("listening_player", "command", "pause")), "Paused the listening audio.", "\u0110\u00E3 t\u1EA1m d\u1EEBng b\u00E0i nghe.");
        }
        if (cleaned.matches("^(?:replay(?: sentence| segment)?|repeat sentence|play that sentence again|nghe lai(?: cau nay)?|phat lai cau(?: nay)?)$")) {
            return new CompiledClause(List.of(intent("listening_player", "command", "replay")), "Replaying the current sentence.", "\u0110ang ph\u00E1t l\u1EA1i c\u00E2u hi\u1EC7n t\u1EA1i.");
        }
        if (cleaned.matches("^(?:(?:toggle|hide|show) transcript|(?:an|hien|bat tat) (?:phu de|loi thoai|transcript))$")) {
            return new CompiledClause(List.of(intent("listening_player", "command", "toggle_transcript")), "Toggled the lesson transcript.", "\u0110\u00E3 b\u1EADt t\u1EAFt ph\u1EE5 \u0111\u1EC1 b\u00E0i nghe.");
        }
        if (cleaned.matches("^(?:switch to dictation|start dictation|open dictation mode|chuyen sang chep chinh ta|bat chep chinh ta)$")) {
            return new CompiledClause(List.of(intent("listening_player", "command", "switch_dictation")), "Switched to Dictation view.", "\u0110\u00E3 chuy\u1EC3n sang ch\u1EBF \u0111\u1ED9 ch\u00E9p ch\u00EDnh t\u1EA3.");
        }
        if (cleaned.matches("^(?:switch to overview|lesson overview|chuyen ve tong quan bai nghe|xem tong quan bai nghe)$")) {
            return new CompiledClause(List.of(intent("listening_player", "command", "switch_overview")), "Switched to Lesson Overview.", "\u0110\u00E3 chuy\u1EC3n v\u1EC1 t\u1ED5ng quan b\u00E0i nghe.");
        }
        Matcher speedNum = Pattern.compile("^(?:(?:set )?(?:playback |audio |listening )?speed(?: to)?|toc do(?: nghe| phat)?)\\s*(0\\.5|0\\.75|1(?:\\.0)?|1\\.25|1\\.5|1\\.75|2(?:\\.0)?)x?$").matcher(cleaned);
        if (speedNum.matches()) {
            double speed = Double.parseDouble(speedNum.group(1));
            return new CompiledClause(List.of(intent("listening_player", "command", "speed", "speed", speed)),
                    "Set playback speed to " + speed + "x.", "\u0110\u00E3 \u0111\u1EB7t t\u1ED1c \u0111\u1ED9 ph\u00E1t " + speed + "x.");
        }
        if (cleaned.matches("^(?:slow down (?:the )?audio|slower playback|nghe cham lai|giam toc do nghe)$")) {
            return new CompiledClause(List.of(intent("listening_player", "command", "speed", "speed", 0.75)), "Set playback speed to 0.75x.", "\u0110\u00E3 gi\u1EA3m t\u1ED1c \u0111\u1ED9 nghe xu\u1ED1ng 0.75x.");
        }
        if (cleaned.matches("^(?:speed up (?:the )?audio|faster playback|nghe nhanh hon|tang toc do nghe)$")) {
            return new CompiledClause(List.of(intent("listening_player", "command", "speed", "speed", 1.25)), "Set playback speed to 1.25x.", "\u0110\u00E3 t\u0103ng t\u1ED1c \u0111\u1ED9 nghe l\u00EAn 1.25x.");
        }

        // 18. Knowledge Universe Word Deep-Link
        Matcher cosmos = Pattern.compile("^(?:open|show|explore|see|mo|xem|kham pha)\\s+([a-z][a-z' -]{0,36})\\s+in (?:the )?(?:knowledge universe|cosmos)$").matcher(cleaned);
        if (!cosmos.matches()) {
            cosmos = Pattern.compile("^(?:xem|mo|kham pha)\\s+tu\\s+([a-z][a-z' -]{0,36})\\s+trong vu tru tri thuc$").matcher(cleaned);
        }
        if (cosmos.matches()) {
            String w = cosmos.group(1).trim().toLowerCase(Locale.ROOT);
            String encoded = w.replace(" ", "%20").replace("'", "%27");
            return new CompiledClause(List.of(intent("navigate", "href", "/knowledge-universe?word=" + encoded, "label", "Knowledge Universe: " + w)),
                    "Opening \"" + w + "\" in the Knowledge Universe.",
                    "\u0110ang m\u1EDF t\u1EEB \"" + w + "\" trong V\u0169 tr\u1EE5 tri th\u1EE9c.");
        }

        // 19. Bare bookshelf / tủ sách shortcut & Desiderative / direct sub-module studio practice
        if (cleaned.matches("^(?:bookshelf|my books|my bookshelf|tu sach(?: cua toi| cua minh)?|sach cua toi|sach cua minh)$")) {
            return buildNavClause(Objects.requireNonNull(findNavByHref("/reading?section=mybooks")));
        }

        Matcher studioPractice = PRACTICE_STUDIO_ENTRY_RE.matcher(cleaned);
        if (studioPractice.matches()) {
            String rawStudioTarget = studioPractice.group(1).trim();
            NavEntry studioMatch = matchConceptSlotEntry(rawStudioTarget, PRACTICE_STUDIO_ENTRIES);
            if (studioMatch != null) {
                return buildNavClause(studioMatch);
            }
        }

        // 21. Explicit + Concept-Slot Navigation across all 66+ module routes
        Matcher nav = NAV_VERB_RE.matcher(cleaned);
        if (nav.matches()) {
            String rawTarget = nav.group(1).trim();
            Matcher relUnwrap = RELATIVE_PRACTICE_UNWRAP_RE.matcher(rawTarget);
            String unwrapped = relUnwrap.matches() ? relUnwrap.group(1).trim() : rawTarget;

            String strippedRaw = stripNavTargetFillers(rawTarget);
            String strippedUnwrapped = stripNavTargetFillers(unwrapped);
            Set<String> exactCandidates = new LinkedHashSet<>(List.of(rawTarget, unwrapped, strippedRaw, strippedUnwrapped));
            for (String candidate : exactCandidates) {
                for (NavEntry entry : NAV_ENTRIES) {
                    for (String phrase : entry.phrases()) {
                        if (candidate.equals(phrase)) {
                            return buildNavClause(entry);
                        }
                    }
                }
            }

            // Compositional multi-slot rules (checked BEFORE stripping "in my profile" / "in speaking section"!)
            NavEntry compositional = matchCompositionalNavSlot(unwrapped);
            if (compositional != null) {
                return buildNavClause(compositional);
            }

            // Peel redundant module-locative suffix ("shadowing in the speaking section" -> "shadowing")
            String peeledLocative = NAV_SECTION_LOCATIVE_SUFFIX_RE.matcher(unwrapped).replaceFirst("").trim();

            // General Concept-Slot set-cover over NAV_ENTRIES (zero unaccounted tokens!)
            NavEntry slotMatch = matchConceptSlotEntry(unwrapped, NAV_ENTRIES);
            if (slotMatch == null && !peeledLocative.equals(unwrapped) && !peeledLocative.isEmpty()) {
                slotMatch = matchConceptSlotEntry(peeledLocative, NAV_ENTRIES);
            }
            if (slotMatch != null) {
                return buildNavClause(slotMatch);
            }
        }
        return null;
    }

    private static CompiledClause buildNavClause(NavEntry entry) {
        List<Map<String, Object>> list = new ArrayList<>();
        list.add(intent("navigate", "href", entry.href(), "label", entry.en()));
        list.addAll(entry.extraIntents());
        return new CompiledClause(list, "Opening " + entry.en() + ".", "\u0110ang m\u1EDF " + entry.vi() + ".");
    }

    private static NavEntry matchCompositionalNavSlot(String target) {
        List<String> tokens = Arrays.stream(target.split(" ")).filter(t -> !t.isEmpty()).toList();
        if (tokens.isEmpty()) return null;
        Set<String> tokSet = new HashSet<>(tokens);

        // Speaking Profile -> Pronunciation sub-tab ("pronunciation section of my profile", "phần phát âm trong hồ sơ luyện nói của tôi")
        boolean hasPron = tokSet.contains("pronunciation") || containsBigram(tokens, "phat", "am");
        boolean hasProfile = tokSet.contains("profile") || tokSet.contains("analytics") || tokSet.contains("stats")
                || containsBigram(tokens, "ho", "so") || containsBigram(tokens, "thong", "ke") || containsBigram(tokens, "phan", "tich");
        if (hasPron && hasProfile) {
            Set<String> allowed = new HashSet<>(CONCEPT_CONTAINER_FILLER_TOKENS);
            allowed.addAll(List.of("pronunciation", "profile", "analytics", "stats", "speaking", "phat", "am", "ho", "so", "thong", "ke", "phan", "tich", "noi"));
            if (allowed.containsAll(tokSet)) {
                return findNavByHref("/speaking?view=profile&sub=pronunciation");
            }
        }

        // Speaking Profile -> History sub-tab ("history section of my speaking profile", "mục lịch sử trong hồ sơ luyện nói")
        boolean hasHist = tokSet.contains("history") || tokSet.contains("sessions") || containsBigram(tokens, "lich", "su");
        boolean hasSpeak = tokSet.contains("speaking") || tokSet.contains("noi");
        if (hasHist && (hasSpeak || hasProfile)) {
            Set<String> allowed = new HashSet<>(CONCEPT_CONTAINER_FILLER_TOKENS);
            allowed.addAll(List.of("history", "sessions", "session", "speaking", "profile", "lich", "su", "phien", "ho", "so", "noi"));
            if (allowed.containsAll(tokSet)) {
                return findNavByHref("/speaking?view=profile&sub=history");
            }
        }

        // Speaking Profile Overview ("overview of my speaking profile", "hồ sơ luyện nói của tôi")
        if (hasProfile && hasSpeak && !hasPron && !hasHist) {
            Set<String> allowed = new HashSet<>(CONCEPT_CONTAINER_FILLER_TOKENS);
            allowed.addAll(List.of("profile", "overview", "analytics", "stats", "statistics", "speaking", "ho", "so", "tong", "quan", "thong", "ke", "phan", "tich", "noi"));
            if (allowed.containsAll(tokSet)) {
                return findNavByHref("/speaking?view=profile");
            }
        }

        // Today's Learning Path Tasks ("today's learning path tasks", "nhiệm vụ lộ trình học hôm nay")
        boolean hasLearningPath = containsBigram(tokens, "learning", "path") || containsBigram(tokens, "lo", "trinh");
        boolean hasTasksOrToday = tokSet.contains("tasks") || tokSet.contains("task") || tokSet.contains("todays")
                || tokSet.contains("today") || tokSet.contains("today's") || containsBigram(tokens, "nhiem", "vu")
                || containsBigram(tokens, "hom", "nay");
        if (hasLearningPath && hasTasksOrToday && !tokSet.contains("odyssey")) {
            Set<String> allowed = new HashSet<>(CONCEPT_CONTAINER_FILLER_TOKENS);
            allowed.addAll(List.of("learning", "path", "tasks", "task", "todays", "today", "today's", "s", "plan", "list",
                    "lo", "trinh", "nhiem", "vu", "hom", "nay"));
            if (allowed.containsAll(tokSet)) {
                return findNavByHref("/learning-path?view=list");
            }
        }

        // IELTS / TOEIC Mock Exams ("ielts", "thi ielts", "ielts mock", "toeic")
        if ((tokSet.contains("ielts") || tokSet.contains("toeic"))
                && !tokSet.contains("grammar") && !containsBigram(tokens, "ngu", "phap")
                && !containsBigram(tokens, "ho", "so") && !tokSet.contains("profile")) {
            String fam = tokSet.contains("ielts") ? "ielts" : "toeic";
            Set<String> allowed = new HashSet<>(CONCEPT_CONTAINER_FILLER_TOKENS);
            allowed.addAll(List.of(fam, "exam", "exams", "mock", "test", "tests", "thi", "thu", "de"));
            if (allowed.containsAll(tokSet)) {
                return findNavByHref("/exams/" + fam);
            }
        }
        return null;
    }

    private static NavEntry matchConceptSlotEntry(String target, List<NavEntry> entries) {
        String padded = " " + target + " ";
        for (NavEntry entry : entries) {
            for (String phrase : entry.phrases()) {
                String paddedPhrase = " " + phrase + " ";
                int idx = padded.indexOf(paddedPhrase);
                if (idx < 0) continue;
                String remainder = (padded.substring(0, idx) + " " + padded.substring(idx + paddedPhrase.length())).trim();
                if (remainder.isEmpty()) {
                    return entry;
                }
                boolean allFillers = true;
                for (String remTok : remainder.split("\\s+")) {
                    if (!remTok.isEmpty() && !CONCEPT_CONTAINER_FILLER_TOKENS.contains(remTok)) {
                        allFillers = false;
                        break;
                    }
                }
                if (allFillers) {
                    return entry;
                }
            }
        }
        return null;
    }

    private static final Pattern SINGULAR_ANAPHORA_RE = Pattern.compile(
            "^(?:(?:open|go to|start|try|launch|show(?: me)?|view|pick|choose|select)\\s+(?:it|that|that one|this one|that (?:lesson|passage|item|card|scenario|exercise))|(?:mo|vao|vo|chon|xem|hoc|luyen|bat(?: dau)?)\\s+(?:no|cai do|cai nay|bai do|bai nay|muc do|goi y do|phan do))$");

    private static final Pattern EN_ORDINAL_ANAPHORA_RE = Pattern.compile(
            "^(?:open|go to|start|try|launch|show(?: me)?|view|pick|choose|select|take me to)\\s+(?:(?:the\\s+)?(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|sixth|6th|seventh|7th|eighth|8th|ninth|9th|tenth|10th|eleventh|11th|twelfth|12th|last|final)(?:\\s+(?:one|item|lesson|passage|article|card|option|choice|suggestion|recommendation|scenario|topic|exercise))?|(?:option|item|number|suggestion|recommendation|choice|lesson|passage|card|exercise)(?:\\s+number)?\\s+#?(1[0-2]|[1-9]|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve))$");

    private static final Pattern VI_ORDINAL_ANAPHORA_RE = Pattern.compile(
            "^(?:mo|vao|vo|chon|xem|hoc|luyen|bat(?: dau)?|di toi|chuyen sang|chuyen qua)\\s+(?:(?:bai(?:\\s+(?:hoc|doc|nghe|tap))?|cai|goi y|lua chon|muc|phan|ket qua|de xuat)\\s+)?(dau tien|dau|thu nhat|thu hai|thu ba|thu tu|thu bon|thu nam|cuoi cung|cuoi|(?:thu|so)\\s+(?:1[0-2]|[1-9]|mot|hai|ba|bon|tu|nam|sau|bay|tam|chin|muoi(?:\\s+(?:mot|hai))?))$");

    private static final Map<String, Integer> ORDINAL_TOKEN_MAP = buildOrdinalTokenMap();

    private static Map<String, Integer> buildOrdinalTokenMap() {
        Map<String, Integer> m = new HashMap<>();
        String[][] pairs = {
                {"first", "1"}, {"1st", "1"}, {"one", "1"}, {"1", "1"}, {"dau tien", "1"}, {"dau", "1"}, {"thu nhat", "1"}, {"thu 1", "1"}, {"so 1", "1"}, {"thu mot", "1"}, {"so mot", "1"},
                {"second", "2"}, {"2nd", "2"}, {"two", "2"}, {"2", "2"}, {"thu hai", "2"}, {"thu 2", "2"}, {"so 2", "2"}, {"so hai", "2"},
                {"third", "3"}, {"3rd", "3"}, {"three", "3"}, {"3", "3"}, {"thu ba", "3"}, {"thu 3", "3"}, {"so 3", "3"}, {"so ba", "3"},
                {"fourth", "4"}, {"4th", "4"}, {"four", "4"}, {"4", "4"}, {"thu tu", "4"}, {"thu bon", "4"}, {"thu 4", "4"}, {"so 4", "4"}, {"so bon", "4"}, {"so tu", "4"},
                {"fifth", "5"}, {"5th", "5"}, {"five", "5"}, {"5", "5"}, {"thu nam", "5"}, {"thu 5", "5"}, {"so 5", "5"}, {"so nam", "5"},
                {"sixth", "6"}, {"6th", "6"}, {"six", "6"}, {"6", "6"}, {"thu 6", "6"}, {"so 6", "6"}, {"thu sau", "6"}, {"so sau", "6"},
                {"seventh", "7"}, {"7th", "7"}, {"seven", "7"}, {"7", "7"}, {"thu 7", "7"}, {"so 7", "7"}, {"thu bay", "7"}, {"so bay", "7"},
                {"eighth", "8"}, {"8th", "8"}, {"eight", "8"}, {"8", "8"}, {"thu 8", "8"}, {"so 8", "8"}, {"thu tam", "8"}, {"so tam", "8"},
                {"ninth", "9"}, {"9th", "9"}, {"nine", "9"}, {"9", "9"}, {"thu 9", "9"}, {"so 9", "9"}, {"thu chin", "9"}, {"so chin", "9"},
                {"tenth", "10"}, {"10th", "10"}, {"ten", "10"}, {"10", "10"}, {"thu 10", "10"}, {"so 10", "10"}, {"thu muoi", "10"}, {"so muoi", "10"},
                {"eleventh", "11"}, {"11th", "11"}, {"eleven", "11"}, {"11", "11"}, {"thu 11", "11"}, {"so 11", "11"}, {"thu muoi mot", "11"}, {"so muoi mot", "11"},
                {"twelfth", "12"}, {"12th", "12"}, {"twelve", "12"}, {"12", "12"}, {"thu 12", "12"}, {"so 12", "12"}, {"thu muoi hai", "12"}, {"so muoi hai", "12"},
                {"last", "-1"}, {"final", "-1"}, {"cuoi", "-1"}, {"cuoi cung", "-1"}
        };
        for (String[] p : pairs) m.put(p[0], Integer.parseInt(p[1]));
        return Map.copyOf(m);
    }

    private static CompiledClause resolveSalientAnaphora(String cleaned, List<EchoSalientResourceDto> salient) {
        if (salient == null || salient.isEmpty()) return null;

        // Singular anaphora ("open it", "open that one", "mở bài đó") requires unambiguous salient.size() == 1!
        if (SINGULAR_ANAPHORA_RE.matcher(cleaned).matches()) {
            if (salient.size() != 1) return null;
            return buildSalientNavClause(salient.get(0));
        }

        Integer selector = null;
        Matcher enOrd = EN_ORDINAL_ANAPHORA_RE.matcher(cleaned);
        if (enOrd.matches()) {
            String tok = (enOrd.group(1) != null ? enOrd.group(1) : enOrd.group(2)).trim();
            selector = ORDINAL_TOKEN_MAP.get(tok);
        } else {
            Matcher viOrd = VI_ORDINAL_ANAPHORA_RE.matcher(cleaned);
            if (viOrd.matches()) {
                selector = ORDINAL_TOKEN_MAP.get(viOrd.group(1).trim());
            }
        }
        if (selector == null) return null;

        EchoSalientResourceDto chosen = null;
        if (selector == -1) {
            chosen = salient.get(salient.size() - 1);
        } else if (selector >= 1 && selector <= 12) {
            final int targetOneBased = selector;
            chosen = salient.stream()
                    .filter(r -> r.index() == targetOneBased)
                    .findFirst()
                    .orElse(targetOneBased - 1 < salient.size() ? salient.get(targetOneBased - 1) : null);
        }
        return chosen == null ? null : buildSalientNavClause(chosen);
    }

    private static CompiledClause buildSalientNavClause(EchoSalientResourceDto chosen) {
        if (chosen == null || !EchoDestinations.isAllowedHref(chosen.href())) {
            return null;
        }
        String label = (chosen.title() == null || chosen.title().isBlank()) ? "Selected item" : chosen.title();
        return new CompiledClause(
                List.of(intent("navigate", "href", chosen.href(), "label", label)),
                "Opening \"" + label + "\".",
                "\u0110ang m\u1EDF \"" + label + "\".");
    }

    private static String matchPendingConfirmationDecision(String rawUtterance) {
        if (rawUtterance == null || rawUtterance.isBlank()) return null;
        String trimmed = rawUtterance.trim();
        if (VI_DIACRITIC_RE.matcher(trimmed).find()) {
            String nfc = Normalizer.normalize(trimmed, Normalizer.Form.NFC).toLowerCase(Locale.ROOT)
                    .replaceAll("[.!?]+$", "").replaceAll("\\s+", " ").trim();
            if (nfc.matches("^(?:\u0111\u00FAng|\u0111\u00FAng r\u1ED3i|\u1EEB \u0111\u00FAng|v\u00E2ng \u0111\u00FAng)$")) return "confirm";
            if (nfc.matches("^(?:\u0111\u1EEBng|\u0111\u1EEBng l\u00E0m|th\u00F4i \u0111\u1EEBng|d\u1EEBng|d\u1EEBng l\u1EA1i)$")) return "cancel";
        }
        String folded = normalizeAsciiFold(trimmed).replaceAll("[.!?]+$", "").trim();
        folded = folded.replaceFirst("^(?:(?:hi|high|hey|hello|echo|jarvis|echo jarvis|echo oi|jarvis oi)\\s+){1,3}", "").trim();
        if (folded.matches(".*\\bkhong\\s+huy\\b.*")) {
            return null;
        }
        String confirmRe = "^(?:yes|yep|yeah|sure|ok|okay|confirm|confirmed|go ahead|do it|approve|yes confirm|yes apply|yes apply it|apply it|dong y|xac nhan|ok luon|duoc|duoc luon|u|vang|da|ap dung|ap dung di|u xac nhan|vang xac nhan|ok xac nhan)$";
        String cancelRe = "^(?:no|nope|cancel|no cancel|stop|don'?t|don t|dont|do not|do not apply|dont apply|don t apply|never mind|nevermind|abort|stay here|keep working|khong|huy|huy bo|thoi|thoi bo|thoi huy|khoan|khoan da|o lai)$";
        if (folded.matches(confirmRe)) return "confirm";
        if (folded.matches(cancelRe)) return "cancel";
        if (!VI_DIACRITIC_RE.matcher(trimmed).find() && "dung".equals(folded)) return "cancel";
        String strippedTail = folded.replaceFirst("\\s+(?:please|now|echo|jarvis|nhe|nha|di|luon)$", "").trim();
        if (strippedTail.matches(confirmRe)) return "confirm";
        if (strippedTail.matches(cancelRe)) return "cancel";
        if (!VI_DIACRITIC_RE.matcher(trimmed).find() && "dung".equals(strippedTail)) return "cancel";
        return null;
    }

    private static NavEntry findNavByHref(String href) {
        for (NavEntry e : NAV_ENTRIES) {
            if (href.equals(e.href())) return e;
        }
        return null;
    }

    private static boolean containsBigram(List<String> tokens, String first, String second) {
        for (int i = 0; i + 1 < tokens.size(); i++) {
            if (first.equals(tokens.get(i)) && second.equals(tokens.get(i + 1))) return true;
        }
        return false;
    }

    private static String resolveWorldId(String cleaned) {
        if (cleaned.contains("odyssey")) return "odyssey";
        return "cosmos";
    }

    private static String extractDictionaryHeadword(String cleaned) {
        Matcher m = DICT_COMMAND_PREFIX_RE.matcher(cleaned);
        if (!m.matches()) return null;
        String slot = m.group(1).replaceAll("^['\"\u201C\u201D\u2018\u2019`]+|['\"\u201C\u201D\u2018\u2019`]+$", "").trim();
        boolean hadExplicitWordLabel = false;
        String prev = "";
        while (!slot.isEmpty() && !slot.equals(prev)) {
            prev = slot;
            String strippedLead = DICT_LEADING_LABEL_RE.matcher(slot).replaceFirst("").trim();
            if (!strippedLead.isEmpty() && !strippedLead.equals(slot)) {
                hadExplicitWordLabel = true;
                slot = strippedLead;
            }
        }
        prev = "";
        while (!slot.isEmpty() && !slot.equals(prev)) {
            prev = slot;
            slot = DICT_TRAILING_LOCATIVE_OR_POLITE_RE.matcher(slot).replaceFirst("").trim();
        }
        slot = slot.replaceAll("^['\"\u201C\u201D\u2018\u2019`]+|['\"\u201C\u201D\u2018\u2019`]+$", "")
                .replaceAll("\\s+", " ")
                .trim();
        if (slot.isEmpty() || slot.length() > 48 || !slot.matches("^[a-z][a-z0-9' -]*$")) {
            return null;
        }
        if (!hadExplicitWordLabel && slot.matches("^(?:(?:the|my|english)\\s+)?dictionary$|^tu\\s+dien$")) {
            return null;
        }
        if (BRAIN_DELEGATION_RE.matcher(slot).find()) {
            return null;
        }
        return slot;
    }

    private static String unwrapSafeDictTailQuote(String raw) {
        if (raw == null) return null;
        String trimmed = raw.trim();
        Matcher tailQuoted = SAFE_DICT_TAIL_QUOTE_RE.matcher(trimmed);
        if (tailQuoted.matches() && SAFE_DICT_PREFIX_FOLDED_RE.matcher(normalizeAsciiFold(tailQuoted.group(1))).find()) {
            return tailQuoted.group(1) + " " + tailQuoted.group(2);
        }
        return null;
    }

    static String dequote(String raw) {
        return EchoSpeechActAnalyzer.maskQuotedSpans(raw);
    }

    static String normalizeAsciiFold(String input) {
        if (input == null || input.isEmpty()) return "";
        String normalizedApostrophe = input.replace('\u2019', '\'').replace('\u2018', '\'');
        return Normalizer.normalize(normalizedApostrophe, Normalizer.Form.NFD)
                .replaceAll("\\p{M}+", "")
                .replace('\u0111', 'd').replace('\u0110', 'd')
                .toLowerCase(Locale.ROOT)
                .replaceAll("[^a-z0-9_'\\s.:/?=-]", " ")
                .replaceAll("\\s+", " ")
                .trim();
    }

    static String detectLanguage(String raw) {
        if (raw == null) return "en";
        if (VI_DIACRITIC_RE.matcher(raw).find()) return "vi";
        if (VI_LEXICAL_CUE_RE.matcher(normalizeAsciiFold(raw)).find()) return "vi";
        return "en";
    }

    private static String cleanClause(String raw) {
        if (raw == null || raw.isEmpty()) return "";
        String withCommas = Normalizer.normalize(raw.replace('\u2019', '\'').replace('\u2018', '\''), Normalizer.Form.NFD)
                .replaceAll("\\p{M}+", "")
                .replace('\u0111', 'd').replace('\u0110', 'd')
                .toLowerCase(Locale.ROOT)
                .replaceAll("[^a-z0-9_,'\\s.:/?=-]", " ")
                .replaceAll("[.!?:;]+$", "")
                .replaceAll("\\s+", " ")
                .trim();
        String s = POLITE_PREFIX_RE.matcher(withCommas).replaceFirst("").trim();
        String prev = "";
        while (!s.isEmpty() && !s.equals(prev)) {
            prev = s;
            s = PLATFORM_LOCATIVE_SUFFIX_RE.matcher(s).replaceFirst("").trim();
            s = POLITE_SUFFIX_RE.matcher(s).replaceFirst("").trim();
        }
        return s.replace(',', ' ').replaceAll("\\s+", " ").trim();
    }

    private static String stripNavTargetFillers(String rawTarget) {
        List<String> words = new ArrayList<>(Arrays.stream(rawTarget.split(" ")).filter(w -> !w.isEmpty()).toList());
        while (words.size() > 1 && NAV_FILLER_WORDS.contains(words.get(0))) words.remove(0);
        while (words.size() > 1 && NAV_FILLER_WORDS.contains(words.get(words.size() - 1))) words.remove(words.size() - 1);
        return String.join(" ", words);
    }

    private static String joinAcks(List<CompiledClause> clauses, String lang) {
        if (clauses.size() == 1) {
            return "vi".equals(lang) ? clauses.get(0).ackVi() : clauses.get(0).ackEn();
        }
        List<String> parts = new ArrayList<>();
        for (CompiledClause c : clauses) {
            String raw = "vi".equals(lang) ? c.ackVi() : c.ackEn();
            parts.add(raw.replaceAll("[.!]+$", "").trim());
        }
        return "vi".equals(lang) ? String.join(" v\u00E0 ", parts) + "." : String.join(" and ", parts) + ".";
    }

    private static Map<String, Object> intent(String kind, Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kind", kind);
        for (int i = 0; i + 1 < kv.length; i += 2) {
            m.put(String.valueOf(kv[i]), kv[i + 1]);
        }
        return m;
    }
}
