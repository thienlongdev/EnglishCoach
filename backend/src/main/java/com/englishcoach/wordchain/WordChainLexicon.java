package com.englishcoach.wordchain;

import com.englishcoach.dictionary.provider.LocalEnViLexicalProvider;
import com.englishcoach.kingofenglish.KingCorpus;
import jakarta.annotation.PostConstruct;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;
import java.util.*;
import java.util.regex.Pattern;

/**
 * Word Chain word policy (owner brief 2026-10-29). One verdict per word for humans AND Echo: the bundled EN–VI
 * dictionary decides whether a word exists, its senses keep the entry's own order (the dictionary editor's primary
 * sense first — the old definition-id order surfaced shared rare senses such as "rear" = "hậu quân"), and
 * abbreviations / acronyms / proper names are refused. Echo's vocabulary is the approved King lexicon (CEFR-J
 * levels) with the dictionary only as a last resort for letters the lexicon barely covers. Local, read-only, no AI.
 */
@Service
public class WordChainLexicon {
    public record Sense(String pos, String meaning) {}
    public record Word(String normalizedWord, String displayWord, String ipa, String partOfSpeech,
                       String meaningVi, String cefr, List<Sense> senses) {}
    /** Exactly one of word / rejection is set. */
    public record Verdict(Word word, String rejection) {}
    /** tier 1 = CEFR A1–A2, 2 = B1, 3 = B2 or approved without a level, 4 = C1–C2, 5 = dictionary fallback. */
    public record BotWord(String word, int tier) {}

    static final Map<String, String> POS = Map.ofEntries(Map.entry("N", "noun"), Map.entry("V", "verb"),
            Map.entry("A", "adjective"), Map.entry("D", "adverb"), Map.entry("C", "conjunction"), Map.entry("P", "pronoun"),
            Map.entry("E", "preposition"), Map.entry("O", "interjection"), Map.entry("noun", "noun"), Map.entry("n", "noun"),
            Map.entry("verb", "verb"), Map.entry("adj", "adjective"), Map.entry("adv", "adverb"), Map.entry("pron", "pronoun"));
    private static final Pattern ABBREVIATION = Pattern.compile(
            "(?iU)(viết tắt\\)?\\s*(của|cho|từ)|chữ đầu|^\\W*như (?-i:[A-Z]{2,})\\W*$)");
    private static final Pattern LABEL_ONLY = Pattern.compile(
            "(?iU)^\\W*(nội động từ|ngoại động từ|danh từ|động từ|tính từ|trạng từ|phó từ|liên từ|giới từ|thán từ|đại từ)?\\W*$");
    private static final Pattern MARKED = Pattern.compile("^\\(\\s*(?!(như|thuộc)\\s*\\))[^)]{2,40}\\)");
    /** A register / field label anywhere in the sense ("Bộm (nhiếp ảnh)", "(từ lóng) …"): a real sense, never the primary one. */
    private static final Pattern FIELD = Pattern.compile("(?iU)\\(\\s*(từ |nghĩa |ngành |tiếng )?(cổ|hiếm|lóng|thông tục|đùa cợt|thơ ca|"
            + "văn học|kinh thánh|tôn giáo|quân sự|hàng hải|kỹ thuật|kĩ thuật|nhiếp ảnh|mỏ|đường sắt|điện|thể thao|thể dục|đánh bài|"
            + "đánh bạc|săn bắn|pháp lý|pháp luật|thương nghiệp|thương mại|tài chính|ngân hàng|kinh tế|tin học|máy tính|âm nhạc|kiến trúc|"
            + "nông nghiệp|Mỹ|Ê-cốt|Ai-len|địa phương|[^()]{1,24} học)(,[^()]*)?\\s*\\)");
    /** A sense that opens with an English phrase ("Holy Writ kinh thánh") glosses that phrase, not the word itself. */
    private static final Pattern PHRASE = Pattern.compile("^[A-Za-z]+(?: [A-Za-z']+)+ [^\\x00-\\x7F]");
    /** A proper-name sense (place, person, constellation…). Unlike the King board filter, "thần thánh" is not a name. */
    private static final Pattern PROPER = Pattern.compile("(?iU)proper|tên riêng|danh từ riêng|^\\s*(thủ đô|thành phố|tỉnh) (của|ở|thuộc)|"
            + "^\\s*tên (người|nước|gọi|của)|^\\s*chòm sao|^\\s*(vị |nữ )?thần (của|trong|Hy Lạp|La Mã)");
    private static final Pattern CROSS_REFERENCE = Pattern.compile("(?iU)^\\(?\\s*(như|xem)\\s*\\)?\\s");
    private static final Pattern VOWEL = Pattern.compile("[aeiouy]");
    private static final Pattern BOT_SHAPE = Pattern.compile("[a-z]{3,10}");
    /** Content suitability for words Echo chooses itself (same list as Hangman); humans are judged by the dictionary. */
    static final Set<String> UNSUITABLE = Set.of("fuck", "fucking", "shit", "shitty", "bitch", "bastard", "cunt",
            "cock", "dick", "penis", "vagina", "porn", "porno", "rape", "rapist", "nigger", "nigga", "faggot", "slut",
            "whore", "suicide", "sex", "sexy", "kill", "drug", "drugs");

    private final LocalEnViLexicalProvider local;
    private final ObjectProvider<KingCorpus> king;
    private final Map<String, String> kingCefr = new HashMap<>();
    private final Map<String, Set<String>> kingPos = new HashMap<>();
    private final Set<String> approved = new HashSet<>();
    private final Map<Character, List<BotWord>> botWords = new HashMap<>();
    private final Map<String, Verdict> cache = new LinkedHashMap<>(256, .75f, true) {
        protected boolean removeEldestEntry(Map.Entry<String, Verdict> e) { return size() > 6000; }
    };

    public WordChainLexicon(LocalEnViLexicalProvider local, ObjectProvider<KingCorpus> king) {
        this.local = local; this.king = king;
    }

    @PostConstruct public void init() {
        try {
            KingCorpus corpus = king.getIfAvailable();
            if (corpus != null) for (var w : corpus.vocabulary()) {
                approved.add(w.word());
                w.cefr().stream().sorted().findFirst().ifPresent(c -> kingCefr.put(w.word(), c));
                if (!w.partsOfSpeech().isEmpty()) kingPos.put(w.word(), Set.copyOf(w.partsOfSpeech()));
            }
        } catch (RuntimeException unavailable) { /* No approved snapshot here: Echo uses the dictionary pool. */ }
        for (String word : approved) if (BOT_SHAPE.matcher(word).matches() && !UNSUITABLE.contains(word))
            botWords.computeIfAbsent(word.charAt(0), k -> new ArrayList<>()).add(new BotWord(word, tier(kingCefr.get(word))));
        for (String word : local.localWordKeys()) if (!approved.contains(word) && BOT_SHAPE.matcher(word).matches()
                && !UNSUITABLE.contains(word))
            botWords.computeIfAbsent(word.charAt(0), k -> new ArrayList<>()).add(new BotWord(word, 5));
        botWords.replaceAll((k, v) -> List.copyOf(v));
    }

    static int tier(String cefr) {
        if (cefr == null) return 3;
        return switch (cefr) { case "A1", "A2" -> 1; case "B1" -> 2; case "B2" -> 3; default -> 4; };
    }

    public boolean available() { return local.isAvailable(); }
    public Map<Character, List<BotWord>> botWords() { return botWords; }
    /** In the approved learner lexicon (King, CEFR-J / OANC / SCOWL): ordinary vocabulary, not an abbreviation. */
    public boolean approved(String word) { return approved.contains(word); }

    public synchronized Verdict check(String word) {
        var hit = cache.get(word);
        if (hit != null) return hit;
        Verdict verdict = judge(word);
        cache.put(word, verdict);
        return verdict;
    }

    private Verdict judge(String word) {
        if (!VOWEL.matcher(word.replaceAll("[^a-z]", "")).find()) return new Verdict(null, "ABBREVIATION");
        var entry = local.lookupEntryExactLocal(word);
        if (entry.isEmpty()) return new Verdict(null, "UNKNOWN_WORD");
        boolean ordinary = approved.contains(word);
        List<Sense> plain = new ArrayList<>(), marked = new ArrayList<>(), references = new ArrayList<>(), clipped = new ArrayList<>();
        boolean abbreviation = false, initialism = false, proper = false;
        for (var d : entry.get().getDefinitions()) {
            String pos = Objects.toString(d.getPos(), "");
            String raw = Objects.toString(d.getDefinition(), "").strip();
            String text = clean(raw);
            if ("X".equals(pos)) { abbreviation = true; initialism = true; continue; }
            if ("name".equals(pos) || PROPER.matcher(Objects.toString(d.getSubPos(), "") + " " + raw).find()) { proper = true; continue; }
            if (ABBREVIATION.matcher(raw).find()) {
                abbreviation = true;
                if (raw.toLowerCase(Locale.ROOT).contains("chữ đầu")) initialism = true;
                if (POS.containsKey(pos)) clipped.add(new Sense(POS.get(pos), shortened(text)));
                continue;
            }
            if (!POS.containsKey(pos) || text.isEmpty() || LABEL_ONLY.matcher(text).matches()) continue;
            var sense = new Sense(POS.get(pos), text);
            if (CROSS_REFERENCE.matcher(text).find()) references.add(sense);
            else if (MARKED.matcher(text).find() || FIELD.matcher(text).find() || PHRASE.matcher(text).find()) marked.add(sense);
            else plain.add(sense);
        }
        // An acronym / initialism (RAC, NATO, DNA) is never ordinary vocabulary, even with an extra common-noun sense.
        if (initialism && !ordinary) return new Verdict(null, "ABBREVIATION");
        // A very short entry marked as a shortened form (op, ad, pe) is an abbreviation unless the learner lexicon lists it.
        if (abbreviation && !ordinary && word.length() <= 3) return new Verdict(null, "ABBREVIATION");
        List<Sense> usable = new ArrayList<>(plain); usable.addAll(marked); usable.addAll(references);
        if (usable.isEmpty()) {
            // A clipping is accepted only when the approved learner lexicon lists it as a word in its own right (exam, bike).
            if (abbreviation && ordinary && !clipped.isEmpty()) usable.addAll(clipped);
            else return new Verdict(null, abbreviation ? "ABBREVIATION" : proper ? "PROPER_NOUN" : "UNKNOWN_WORD");
        }
        // The primary sense is the entry's first unmarked sense — of the word's CEFR-J part of speech when the learner
        // lexicon knows it (abandon is a verb before it is "Bộm (nhiếp ảnh)"); every other sense stays one tap away.
        Set<String> learnerPos = kingPos.getOrDefault(word, Set.of());
        Sense first = usable.stream().filter(s -> plain.contains(s) && learnerPos.contains(s.pos())).findFirst().orElse(usable.getFirst());
        usable.remove(first); usable.addFirst(first);
        List<Sense> senses = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (Sense s : usable) if (senses.size() < 8 && seen.add(s.pos() + "|" + s.meaning())) senses.add(s);
        return new Verdict(new Word(word, word, entry.get().getIpa(), first.pos(), first.meaning(), kingCefr.get(word), List.copyOf(senses)), null);
    }

    static String clean(String text) {
        if (text == null) return "";
        String t = text.strip().replaceAll("^[,;.:\\s]+", "").replaceAll("[\\s.]+$", "").replaceAll("\\s+", " ");
        return t.length() > 160 ? t.substring(0, 157).strip() + "…" : t;
    }

    /** "(viết tắt) của examination" ⇒ "Dạng rút gọn của examination" (source text kept, label made plain). */
    static String shortened(String text) {
        return text.replaceFirst("(?iU)^\\W*\\(?\\s*viết tắt\\s*\\)?\\s*(của|cho)\\s*", "Dạng rút gọn của ")
                .replaceAll("[()]+", "").strip();
    }
}
