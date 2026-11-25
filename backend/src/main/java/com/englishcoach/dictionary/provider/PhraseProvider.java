package com.englishcoach.dictionary.provider;

import com.englishcoach.dictionary.dto.CanonicalDictionaryResponse;
import com.englishcoach.dictionary.dto.PhrasesResponse;
import com.englishcoach.dictionary.entity.DictionaryEntry;
import com.englishcoach.dictionary.repository.DictionaryRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.Nullable;
import jakarta.annotation.PostConstruct;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestTemplate;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

/**
 * Deterministic provider for Phrasal Verbs, Idioms, and Multi-Word Lexical Entries.
 * Discovers related usage from local lexical store, indexed database, and open lexical data.
 * Zero AI / LLM calls.
 */
@Slf4j
@Component
public class PhraseProvider {

    private final DictionaryRepository dictionaryRepository;
    private final KaikkiLocalLexicalStore kaikkiLocalLexicalStore;
    private final ObjectMapper objectMapper;
    private final RestTemplate restTemplate;

    public PhraseProvider() {
        this(null, null, null);
    }

    @Autowired
    public PhraseProvider(
            @Nullable DictionaryRepository dictionaryRepository,
            @Nullable KaikkiLocalLexicalStore kaikkiLocalLexicalStore,
            @Nullable ObjectMapper objectMapper) {
        this.dictionaryRepository = dictionaryRepository;
        this.kaikkiLocalLexicalStore = kaikkiLocalLexicalStore;
        this.objectMapper = objectMapper != null ? objectMapper : new ObjectMapper();
        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(1500);
        factory.setReadTimeout(2000);
        this.restTemplate = new RestTemplate(factory);
    }

    // Common verb particles that constitute phrasal verbs
    private static final Set<String> PARTICLES = Set.of(
            "off", "up", "on", "in", "out", "down", "away", "over", "back",
            "through", "into", "after", "about", "across", "along", "around", "by"
    );

    private static final Set<String> PREPOSITIONS = Set.of(
            "to", "for", "with", "from", "at", "of", "against"
    );

    private static final Set<String> STOPWORDS = Set.of(
            "a", "an", "the", "in", "on", "at", "to", "for", "with", "from", "by", "about",
            "into", "through", "during", "before", "after", "above", "below", "under", "between",
            "and", "or", "but", "if", "not", "one's", "someone's", "your", "my", "his", "her",
            "our", "their", "its", "it", "something", "someone", "somebody"
    );

    // Curated real phrasal verbs indexed by base verb (Last-resort fallback)
    private static final Map<String, List<CanonicalDictionaryResponse.PhrasalVerbDto>> PHRASAL_VERBS_BY_BASE = new HashMap<>();

    // Curated real idioms indexed by key words (Last-resort fallback)
    private static final Map<String, List<CanonicalDictionaryResponse.IdiomDto>> IDIOMS_BY_KEYWORD = new HashMap<>();

    // Direct multi-word lexical entries for direct search
    private static final Map<String, CanonicalDictionaryResponse> DIRECT_PHRASE_ENTRIES = new HashMap<>();

    // In-memory reverse index: content token -> Set of phrase keys
    private final Map<String, Set<String>> REVERSE_INDEX_BY_ANCHOR = new ConcurrentHashMap<>();

    private static final Pattern HTML_TAG_PATTERN = Pattern.compile("<[^>]+>");
    private static final Pattern MW_PARSER_PATTERN = Pattern.compile("\\.?mw-parser-output[^{]*\\{[^}]*\\}", Pattern.CASE_INSENSITIVE);

    @PostConstruct
    public void initReverseAnchorIndex() {
        for (Map.Entry<String, List<CanonicalDictionaryResponse.PhrasalVerbDto>> entry : PHRASAL_VERBS_BY_BASE.entrySet()) {
            String base = entry.getKey();
            for (CanonicalDictionaryResponse.PhrasalVerbDto pv : entry.getValue()) {
                indexAnchor(base, pv.getPhrase());
                String[] tokens = pv.getPhrase().toLowerCase().split("\\s+");
                for (String t : tokens) {
                    if (!STOPWORDS.contains(t) && t.length() > 2) {
                        indexAnchor(t, pv.getPhrase());
                    }
                }
            }
        }
        for (Map.Entry<String, List<CanonicalDictionaryResponse.IdiomDto>> entry : IDIOMS_BY_KEYWORD.entrySet()) {
            String keyword = entry.getKey();
            for (CanonicalDictionaryResponse.IdiomDto idm : entry.getValue()) {
                indexAnchor(keyword, idm.getPhrase());
                String[] tokens = idm.getPhrase().toLowerCase().split("\\s+");
                for (String t : tokens) {
                    if (!STOPWORDS.contains(t) && t.length() > 2) {
                        indexAnchor(t, idm.getPhrase());
                    }
                }
            }
        }
        for (Map.Entry<String, CanonicalDictionaryResponse> entry : DIRECT_PHRASE_ENTRIES.entrySet()) {
            String phrase = entry.getKey();
            String[] tokens = phrase.toLowerCase().split("\\s+");
            for (String t : tokens) {
                if (!STOPWORDS.contains(t) && t.length() > 2) {
                    indexAnchor(t, phrase);
                }
            }
        }
        if (kaikkiLocalLexicalStore != null) {
            for (CanonicalDictionaryResponse entry : kaikkiLocalLexicalStore.getAllCoreEntries()) {
                if (entry.getNormalizedQuery() != null && entry.getNormalizedQuery().contains(" ")) {
                    String phrase = entry.getNormalizedQuery();
                    String[] tokens = phrase.toLowerCase().split("\\s+");
                    for (String t : tokens) {
                        if (!STOPWORDS.contains(t) && t.length() > 2) {
                            indexAnchor(t, phrase);
                        }
                    }
                }
            }
        }
        log.info("[PHRASE_PROVIDER] Built reverse anchor index with {} anchor tokens", REVERSE_INDEX_BY_ANCHOR.size());

        // Idempotently seed DIRECT_PHRASE_ENTRIES into database
        if (dictionaryRepository != null) {
            try {
                for (Map.Entry<String, CanonicalDictionaryResponse> entry : DIRECT_PHRASE_ENTRIES.entrySet()) {
                    String word = entry.getKey();
                    if (dictionaryRepository.findByWordIgnoreCase(word).isEmpty()) {
                        CanonicalDictionaryResponse val = entry.getValue();
                        String json = objectMapper.writeValueAsString(val);
                        List<String> meanings = new ArrayList<>();
                        List<String> examples = new ArrayList<>();
                        if (val.getPartsOfSpeech() != null) {
                            for (CanonicalDictionaryResponse.PartOfSpeechGroupDto pos : val.getPartsOfSpeech()) {
                                if (pos.getSenses() != null) {
                                    for (CanonicalDictionaryResponse.SenseDto s : pos.getSenses()) {
                                        if (s.getDefinitionEn() != null) meanings.add(s.getDefinitionEn());
                                        if (s.getExamples() != null) examples.addAll(s.getExamples());
                                    }
                                }
                            }
                        }
                        DictionaryEntry de = DictionaryEntry.builder()
                                .word(word)
                                .entryType(val.getEntryType())
                                .dataJson(json)
                                .generalTranslationVi(val.getGeneralTranslationVi())
                                .meanings(meanings)
                                .examples(examples)
                                .updatedAt(java.time.LocalDateTime.now())
                                .build();
                        dictionaryRepository.save(de);
                    }
                }
            } catch (Exception e) {
                log.warn("[PHRASE_SEED] Direct phrase seed warning: {}", e.getMessage());
            }
        }
    }

    private void indexAnchor(String anchor, String phrase) {
        if (anchor == null || phrase == null) return;
        String cleanAnchor = anchor.trim().toLowerCase();
        String cleanPhrase = phrase.trim().toLowerCase();
        REVERSE_INDEX_BY_ANCHOR.computeIfAbsent(cleanAnchor, k -> ConcurrentHashMap.newKeySet()).add(cleanPhrase);
    }

    static {
        // --- TAKE ---
        List<CanonicalDictionaryResponse.PhrasalVerbDto> takePv = List.of(
                CanonicalDictionaryResponse.PhrasalVerbDto.builder()
                        .phrase("take off")
                        .shortMeaning("leave the ground; remove clothing; become successful rapidly")
                        .build(),
                CanonicalDictionaryResponse.PhrasalVerbDto.builder()
                        .phrase("take over")
                        .shortMeaning("assume control or responsibility of something")
                        .build(),
                CanonicalDictionaryResponse.PhrasalVerbDto.builder()
                        .phrase("take after")
                        .shortMeaning("resemble a parent or ancestor in appearance or character")
                        .build(),
                CanonicalDictionaryResponse.PhrasalVerbDto.builder()
                        .phrase("take up")
                        .shortMeaning("start a hobby or activity; occupy time or space")
                        .build(),
                CanonicalDictionaryResponse.PhrasalVerbDto.builder()
                        .phrase("take on")
                        .shortMeaning("acquire a new responsibility; hire an employee; challenge someone")
                        .build(),
                CanonicalDictionaryResponse.PhrasalVerbDto.builder()
                        .phrase("take in")
                        .shortMeaning("understand and absorb; deceive or cheat someone")
                        .build(),
                CanonicalDictionaryResponse.PhrasalVerbDto.builder()
                        .phrase("take back")
                        .shortMeaning("retract a statement; return something to a store")
                        .build()
        );
        PHRASAL_VERBS_BY_BASE.put("take", takePv);

        List<CanonicalDictionaryResponse.IdiomDto> takeIdioms = List.of(
                CanonicalDictionaryResponse.IdiomDto.builder()
                        .phrase("take it easy")
                        .shortMeaning("relax and avoid hard work or stress")
                        .translationVi("thư giãn, đừng quá căng thẳng")
                        .examples(List.of("You've been working too hard, just take it easy this weekend."))
                        .build(),
                CanonicalDictionaryResponse.IdiomDto.builder()
                        .phrase("take something for granted")
                        .shortMeaning("fail to properly appreciate someone or something")
                        .translationVi("coi điều gì là hiển nhiên")
                        .examples(List.of("Never take your health for granted."))
                        .build(),
                CanonicalDictionaryResponse.IdiomDto.builder()
                        .phrase("take your time")
                        .shortMeaning("do something without hurrying")
                        .translationVi("cứ từ từ, không vội")
                        .examples(List.of("Take your time reading the contract before signing."))
                        .build()
        );
        IDIOMS_BY_KEYWORD.put("take", takeIdioms);

        // --- BREAK ---
        List<CanonicalDictionaryResponse.PhrasalVerbDto> breakPv = List.of(
                CanonicalDictionaryResponse.PhrasalVerbDto.builder()
                        .phrase("break down")
                        .shortMeaning("stop functioning (machine); lose emotional control")
                        .build(),
                CanonicalDictionaryResponse.PhrasalVerbDto.builder()
                        .phrase("break into")
                        .shortMeaning("enter a building illegally; interrupt a conversation")
                        .build(),
                CanonicalDictionaryResponse.PhrasalVerbDto.builder()
                        .phrase("break out")
                        .shortMeaning("start suddenly (war, fire); escape from prison")
                        .build(),
                CanonicalDictionaryResponse.PhrasalVerbDto.builder()
                        .phrase("break up")
                        .shortMeaning("end a romantic relationship; disperse a crowd")
                        .build()
        );
        PHRASAL_VERBS_BY_BASE.put("break", breakPv);

        List<CanonicalDictionaryResponse.IdiomDto> breakIdioms = List.of(
                CanonicalDictionaryResponse.IdiomDto.builder()
                        .phrase("break the ice")
                        .shortMeaning("make people feel more comfortable in a social setting")
                        .translationVi("phá vỡ sự e dè, mở đầu cuộc trò chuyện")
                        .examples(List.of("He told a funny joke to break the ice at the meeting."))
                        .build(),
                CanonicalDictionaryResponse.IdiomDto.builder()
                        .phrase("break a leg")
                        .shortMeaning("good luck (traditionally said to performers before a show)")
                        .translationVi("chúc may mắn (trong biểu diễn nghệ thuật)")
                        .examples(List.of("Break a leg tonight! You'll be great."))
                        .build()
        );
        IDIOMS_BY_KEYWORD.put("break", breakIdioms);
        IDIOMS_BY_KEYWORD.put("ice", breakIdioms);

        // --- WEATHER / UNDER THE WEATHER ---
        List<CanonicalDictionaryResponse.IdiomDto> weatherIdioms = List.of(
                CanonicalDictionaryResponse.IdiomDto.builder()
                        .phrase("under the weather")
                        .shortMeaning("feeling slightly sick, unwell, or indisposed")
                        .translationVi("cảm thấy không khỏe, mệt mỏi trong người")
                        .examples(List.of("I'm feeling a bit under the weather today, so I won't be coming to work."))
                        .build()
        );
        IDIOMS_BY_KEYWORD.put("weather", weatherIdioms);

        // --- NAIL / HIT THE NAIL ON THE HEAD ---
        List<CanonicalDictionaryResponse.IdiomDto> nailIdioms = List.of(
                CanonicalDictionaryResponse.IdiomDto.builder()
                        .phrase("hit the nail on the head")
                        .shortMeaning("describe exactly what is causing a situation or problem")
                        .translationVi("nói hoàn toàn chính xác, trúng tim đen")
                        .examples(List.of("Her analysis hit the nail on the head."))
                        .build()
        );
        IDIOMS_BY_KEYWORD.put("nail", nailIdioms);
        IDIOMS_BY_KEYWORD.put("hit", nailIdioms);

        // --- DIRECT MULTI-WORD ENTRIES ---
        // 1. "take off"
        DIRECT_PHRASE_ENTRIES.put("take off", CanonicalDictionaryResponse.builder()
                .query("take off")
                .normalizedQuery("take off")
                .entryType("PHRASAL_VERB")
                .headword("take off")
                .generalTranslationVi("cất cánh, cởi ra, thành công nhanh chóng")
                .pronunciations(List.of(CanonicalDictionaryResponse.PronunciationDto.builder()
                        .ipa("/teɪk ɒf/")
                        .region("UK")
                        .build()))
                .partsOfSpeech(List.of(CanonicalDictionaryResponse.PartOfSpeechGroupDto.builder()
                        .partOfSpeech("verb")
                        .senses(List.of(
                                CanonicalDictionaryResponse.SenseDto.builder()
                                        .id("1")
                                        .definitionEn("(of an aircraft, bird, etc.) to leave the ground and begin flight")
                                        .translationVi("cất cánh (máy bay)")
                                        .examples(List.of("The plane took off at 6 a.m. despite the heavy rain."))
                                        .build(),
                                CanonicalDictionaryResponse.SenseDto.builder()
                                        .id("2")
                                        .definitionEn("to remove a piece of clothing or an item from one's body")
                                        .translationVi("cởi ra (quần áo, giày dép)")
                                        .examples(List.of("He took off his coat as soon as he entered the room."))
                                        .build(),
                                CanonicalDictionaryResponse.SenseDto.builder()
                                        .id("3")
                                        .definitionEn("to suddenly become very successful or popular")
                                        .translationVi("trở nên thành công vượt bậc trong thời gian ngắn")
                                        .examples(List.of("Her career really took off after she released her first novel."))
                                        .build(),
                                CanonicalDictionaryResponse.SenseDto.builder()
                                        .id("4")
                                        .definitionEn("to take time away from work or school")
                                        .translationVi("nghỉ phép, nghỉ làm một thời gian")
                                        .examples(List.of("I decided to take a few days off to visit my parents."))
                                        .build()
                        ))
                        .build()))
                .build());

        // 2. "under the weather"
        DIRECT_PHRASE_ENTRIES.put("under the weather", CanonicalDictionaryResponse.builder()
                .query("under the weather")
                .normalizedQuery("under the weather")
                .entryType("IDIOM")
                .headword("under the weather")
                .generalTranslationVi("cảm thấy mệt mỏi, ốm nhẹ")
                .pronunciations(List.of(CanonicalDictionaryResponse.PronunciationDto.builder()
                        .ipa("/ˈʌndə ðə ˈwɛðə/")
                        .region("UK")
                        .build()))
                .partsOfSpeech(List.of(CanonicalDictionaryResponse.PartOfSpeechGroupDto.builder()
                        .partOfSpeech("idiom")
                        .senses(List.of(
                                CanonicalDictionaryResponse.SenseDto.builder()
                                        .id("1")
                                        .definitionEn("feeling slightly unwell, sick, or exhausted")
                                        .translationVi("cảm thấy không được khỏe, hơi mệt mỏi hoặc bị ốm nhẹ")
                                        .examples(List.of("I was feeling a bit under the weather so I decided not to go to the party."))
                                        .build()
                        ))
                        .build()))
                .build());

        // 3. "break the ice"
        DIRECT_PHRASE_ENTRIES.put("break the ice", CanonicalDictionaryResponse.builder()
                .query("break the ice")
                .normalizedQuery("break the ice")
                .entryType("IDIOM")
                .headword("break the ice")
                .generalTranslationVi("phá vỡ không khí ngượng ngùng")
                .pronunciations(List.of(CanonicalDictionaryResponse.PronunciationDto.builder()
                        .ipa("/breɪk ði aɪs/")
                        .region("UK")
                        .build()))
                .partsOfSpeech(List.of(CanonicalDictionaryResponse.PartOfSpeechGroupDto.builder()
                        .partOfSpeech("idiom")
                        .senses(List.of(
                                CanonicalDictionaryResponse.SenseDto.builder()
                                        .id("1")
                                        .definitionEn("to relieve tension, shyness, or reserve at the start of a meeting or social gathering")
                                        .translationVi("phá vỡ không khí gượng gạo ban đầu, tạo sự cởi mở trong giao tiếp")
                                        .examples(List.of("The host cracked a joke to break the ice before starting the seminar."))
                                        .build()
                        ))
                        .build()))
                .build());

        // 4. "hit the nail on the head"
        DIRECT_PHRASE_ENTRIES.put("hit the nail on the head", CanonicalDictionaryResponse.builder()
                .query("hit the nail on the head")
                .normalizedQuery("hit the nail on the head")
                .entryType("IDIOM")
                .headword("hit the nail on the head")
                .generalTranslationVi("nói trúng phóc, hoàn toàn chính xác")
                .pronunciations(List.of(CanonicalDictionaryResponse.PronunciationDto.builder()
                        .ipa("/hɪt ðə neɪl ɒn ðə hɛd/")
                        .region("UK")
                        .build()))
                .partsOfSpeech(List.of(CanonicalDictionaryResponse.PartOfSpeechGroupDto.builder()
                        .partOfSpeech("idiom")
                        .senses(List.of(
                                CanonicalDictionaryResponse.SenseDto.builder()
                                        .id("1")
                                        .definitionEn("to say something that is completely true, accurate, or precisely right")
                                        .translationVi("nói hoàn toàn chính xác, tìm ra đúng trọng tâm của vấn đề")
                                        .examples(List.of("You've hit the nail on the head with that explanation."))
                                        .build()
                        ))
                        .build()))
                .build());
        // 5. "take it easy"
        DIRECT_PHRASE_ENTRIES.put("take it easy", CanonicalDictionaryResponse.builder()
                .query("take it easy")
                .normalizedQuery("take it easy")
                .entryType("IDIOM")
                .headword("take it easy")
                .generalTranslationVi("thư giãn, bình tĩnh, đừng quá lo lắng")
                .pronunciations(List.of(CanonicalDictionaryResponse.PronunciationDto.builder()
                        .ipa("/teɪk ɪt ˈiːzi/")
                        .region("UK")
                        .build()))
                .partsOfSpeech(List.of(CanonicalDictionaryResponse.PartOfSpeechGroupDto.builder()
                        .partOfSpeech("idiom")
                        .senses(List.of(
                                CanonicalDictionaryResponse.SenseDto.builder()
                                        .id("1")
                                        .definitionEn("to relax, avoid hard work or stress, and rest")
                                        .translationVi("thư giãn, nghỉ ngơi, không làm việc quá sức")
                                        .examples(List.of("You've been working hard all week, so just take it easy this weekend."))
                                        .build(),
                                CanonicalDictionaryResponse.SenseDto.builder()
                                        .id("2")
                                        .definitionEn("used to tell someone not to get angry, excited, or upset")
                                        .translationVi("bình tĩnh, đừng nóng nảy")
                                        .examples(List.of("Take it easy, calm down and tell me what happened."))
                                        .build()
                        ))
                        .build()))
                .build());

        // 6. "give and take" / "give-and-take"
        CanonicalDictionaryResponse giveAndTake = CanonicalDictionaryResponse.builder()
                .query("give and take")
                .normalizedQuery("give and take")
                .entryType("IDIOM")
                .headword("give and take")
                .generalTranslationVi("sự nhượng bộ lẫn nhau, cho và nhận")
                .pronunciations(List.of(CanonicalDictionaryResponse.PronunciationDto.builder()
                        .ipa("/ˌɡɪv ən ˈteɪk/")
                        .region("UK")
                        .build()))
                .partsOfSpeech(List.of(CanonicalDictionaryResponse.PartOfSpeechGroupDto.builder()
                        .partOfSpeech("idiom / noun")
                        .senses(List.of(
                                CanonicalDictionaryResponse.SenseDto.builder()
                                        .id("1")
                                        .definitionEn("mutual concessions in business, politics, or personal relationships; compromise")
                                        .translationVi("sự nhượng bộ qua lại, thỏa hiệp giữa các bên")
                                        .examples(List.of("Every good relationship requires a certain amount of give and take."))
                                        .build()
                        ))
                        .build()))
                .build();
        DIRECT_PHRASE_ENTRIES.put("give and take", giveAndTake);
        DIRECT_PHRASE_ENTRIES.put("give-and-take", CanonicalDictionaryResponse.builder()
                .query("give-and-take")
                .normalizedQuery("give-and-take")
                .entryType("IDIOM")
                .headword("give-and-take")
                .generalTranslationVi("sự nhượng bộ lẫn nhau, cho và nhận")
                .pronunciations(giveAndTake.getPronunciations())
                .partsOfSpeech(giveAndTake.getPartsOfSpeech())
                .build());

        // 7. "do a favor" / "do someone a favor"
        CanonicalDictionaryResponse doAFavor = CanonicalDictionaryResponse.builder()
                .query("do a favor")
                .normalizedQuery("do a favor")
                .entryType("COLLOCATION")
                .headword("do a favor")
                .generalTranslationVi("giúp đỡ, làm ơn giúp một việc")
                .pronunciations(List.of(
                        CanonicalDictionaryResponse.PronunciationDto.builder().ipa("/duː ə ˈfeɪvər/").region("US").build(),
                        CanonicalDictionaryResponse.PronunciationDto.builder().ipa("/duː ə ˈfeɪvə/").region("UK").build()
                ))
                .partsOfSpeech(List.of(CanonicalDictionaryResponse.PartOfSpeechGroupDto.builder()
                        .partOfSpeech("collocation / verb phrase")
                        .senses(List.of(
                                CanonicalDictionaryResponse.SenseDto.builder()
                                        .id("1")
                                        .definitionEn("to perform a kind, helpful, or charitable act for someone")
                                        .translationVi("làm ơn giúp đỡ ai một việc, làm điều tốt giúp người khác")
                                        .examples(List.of(
                                                "Could you do me a favor and watch my bag for a minute?",
                                                "He did her a great favor by introducing her to the hiring manager."
                                         ))
                                        .build()
                        ))
                        .build()))
                .build();
        DIRECT_PHRASE_ENTRIES.put("do a favor", doAFavor);
        DIRECT_PHRASE_ENTRIES.put("do a favour", doAFavor);
        DIRECT_PHRASE_ENTRIES.put("do someone a favor", CanonicalDictionaryResponse.builder()
                .query("do someone a favor")
                .normalizedQuery("do someone a favor")
                .entryType("EXPRESSION")
                .headword("do someone a favor")
                .generalTranslationVi("làm ơn giúp ai một việc")
                .pronunciations(doAFavor.getPronunciations())
                .partsOfSpeech(doAFavor.getPartsOfSpeech())
                .build());
        DIRECT_PHRASE_ENTRIES.put("do somebody a favor", CanonicalDictionaryResponse.builder()
                .query("do somebody a favor")
                .normalizedQuery("do somebody a favor")
                .entryType("EXPRESSION")
                .headword("do somebody a favor")
                .generalTranslationVi("làm ơn giúp ai một việc")
                .pronunciations(doAFavor.getPronunciations())
                .partsOfSpeech(doAFavor.getPartsOfSpeech())
                .build());

        // 8. "fall apart"
        DIRECT_PHRASE_ENTRIES.put("fall apart", CanonicalDictionaryResponse.builder()
                .query("fall apart")
                .normalizedQuery("fall apart")
                .entryType("PHRASAL_VERB")
                .headword("fall apart")
                .generalTranslationVi("tan vỡ, vỡ vụn, suy sụp tinh thần")
                .pronunciations(List.of(
                        CanonicalDictionaryResponse.PronunciationDto.builder().ipa("/fɔːl əˈpɑːrt/").region("US").build(),
                        CanonicalDictionaryResponse.PronunciationDto.builder().ipa("/fɔːl əˈpɑːt/").region("UK").build()
                ))
                .partsOfSpeech(List.of(CanonicalDictionaryResponse.PartOfSpeechGroupDto.builder()
                        .partOfSpeech("verb")
                        .senses(List.of(
                                CanonicalDictionaryResponse.SenseDto.builder()
                                        .id("1")
                                        .definitionEn("to break into pieces because of being old, weak, or damaged")
                                        .translationVi("vỡ vụn thành từng mảnh, rách nát (do cũ hoặc hỏng)")
                                        .examples(List.of("My old winter boots are starting to fall apart."))
                                        .build(),
                                CanonicalDictionaryResponse.SenseDto.builder()
                                        .id("2")
                                        .definitionEn("to experience severe emotional distress and become unable to cope")
                                        .translationVi("suy sụp tinh thần, không thể chịu đựng nổi")
                                        .examples(List.of("She completely fell apart after receiving the tragic news."))
                                        .build()
                        ))
                        .build()))
                .build());

        // 9. "bring about"
        DIRECT_PHRASE_ENTRIES.put("bring about", CanonicalDictionaryResponse.builder()
                .query("bring about")
                .normalizedQuery("bring about")
                .entryType("PHRASAL_VERB")
                .headword("bring about")
                .generalTranslationVi("gây ra, mang lại sự thay đổi")
                .pronunciations(List.of(CanonicalDictionaryResponse.PronunciationDto.builder().ipa("/brɪŋ əˈbaʊt/").region("General").build()))
                .partsOfSpeech(List.of(CanonicalDictionaryResponse.PartOfSpeechGroupDto.builder()
                        .partOfSpeech("verb")
                        .senses(List.of(
                                CanonicalDictionaryResponse.SenseDto.builder()
                                        .id("1")
                                        .definitionEn("to cause something to happen or bring about a significant change")
                                        .translationVi("gây ra hoặc tạo nên sự thay đổi đáng kể")
                                        .examples(List.of("The new government policy brought about significant improvements in healthcare."))
                                        .build()
                        ))
                        .build()))
                .build());

        // 10. "bring up"
        DIRECT_PHRASE_ENTRIES.put("bring up", CanonicalDictionaryResponse.builder()
                .query("bring up")
                .normalizedQuery("bring up")
                .entryType("PHRASAL_VERB")
                .headword("bring up")
                .generalTranslationVi("nuôi nấng; đề cập một chủ đề")
                .pronunciations(List.of(CanonicalDictionaryResponse.PronunciationDto.builder().ipa("/brɪŋ ʌp/").region("General").build()))
                .partsOfSpeech(List.of(CanonicalDictionaryResponse.PartOfSpeechGroupDto.builder()
                        .partOfSpeech("verb")
                        .senses(List.of(
                                CanonicalDictionaryResponse.SenseDto.builder()
                                        .id("1")
                                        .definitionEn("to care for and raise a child until adulthood")
                                        .translationVi("nuôi nấng, chăm sóc con cái đến khi trưởng thành")
                                        .examples(List.of("She was brought up by her grandparents in a small town."))
                                        .build(),
                                CanonicalDictionaryResponse.SenseDto.builder()
                                        .id("2")
                                        .definitionEn("to mention a subject or start talking about it")
                                        .translationVi("đưa ra, đề cập đến một vấn đề trong cuộc thảo luận")
                                        .examples(List.of("Why did you have to bring up that awkward topic during dinner?"))
                                        .build()
                        ))
                        .build()))
                .build());

        // 11. "bring back"
        DIRECT_PHRASE_ENTRIES.put("bring back", CanonicalDictionaryResponse.builder()
                .query("bring back")
                .normalizedQuery("bring back")
                .entryType("PHRASAL_VERB")
                .headword("bring back")
                .generalTranslationVi("mang trả lại; gợi nhớ kỷ niệm xưa")
                .pronunciations(List.of(CanonicalDictionaryResponse.PronunciationDto.builder().ipa("/brɪŋ bæk/").region("General").build()))
                .partsOfSpeech(List.of(CanonicalDictionaryResponse.PartOfSpeechGroupDto.builder()
                        .partOfSpeech("verb")
                        .senses(List.of(
                                CanonicalDictionaryResponse.SenseDto.builder()
                                        .id("1")
                                        .definitionEn("to return something to its owner or original place")
                                        .translationVi("trả lại cái gì cho chủ nhân")
                                        .examples(List.of("Please remember to bring back the tools when you're finished."))
                                        .build(),
                                CanonicalDictionaryResponse.SenseDto.builder()
                                        .id("2")
                                        .definitionEn("to cause memories or feelings from the past to return")
                                        .translationVi("gợi lại ký ức hoặc cảm xúc từ quá khứ")
                                        .examples(List.of("Looking at old photographs always brings back warm memories."))
                                        .build()
                        ))
                        .build()))
                .build());
    }

    public boolean isDirectPhrase(String phrase) {
        String clean = phrase.trim().toLowerCase();
        return DIRECT_PHRASE_ENTRIES.containsKey(clean);
    }

    public Optional<CanonicalDictionaryResponse> getDirectPhraseEntry(String phrase) {
        String clean = phrase.trim().toLowerCase();
        CanonicalDictionaryResponse entry = DIRECT_PHRASE_ENTRIES.get(clean);
        if (entry != null) {
            return Optional.of(entry);
        }
        return Optional.empty();
    }

    /**
     * General resolver for multi-word lexical entries (Phrasal Verbs and Idioms).
     * Builds full CanonicalDictionaryResponse with senses, definitions, translations and examples.
     */
    public Optional<CanonicalDictionaryResponse> resolveMultiWordEntry(String query) {
        if (query == null || query.isBlank()) return Optional.empty();
        String clean = query.trim().toLowerCase();

        // 1. Direct curated entry
        if (DIRECT_PHRASE_ENTRIES.containsKey(clean)) {
            return Optional.of(DIRECT_PHRASE_ENTRIES.get(clean));
        }

        // 2. Check Phrasal Verbs
        for (List<CanonicalDictionaryResponse.PhrasalVerbDto> list : PHRASAL_VERBS_BY_BASE.values()) {
            for (CanonicalDictionaryResponse.PhrasalVerbDto pv : list) {
                if (pv.getPhrase() != null && pv.getPhrase().equalsIgnoreCase(clean)) {
                    List<CanonicalDictionaryResponse.SenseDto> senses = new ArrayList<>();
                    if (pv.getSenses() != null && !pv.getSenses().isEmpty()) {
                        senses.addAll(pv.getSenses());
                    } else if (pv.getShortMeaning() != null && !pv.getShortMeaning().isBlank()) {
                        senses.add(CanonicalDictionaryResponse.SenseDto.builder()
                                .id("1")
                                .definitionEn(pv.getShortMeaning())
                                .translationVi(pv.getTranslationVi())
                                .examples(pv.getExamples() != null ? pv.getExamples() : new ArrayList<>())
                                .build());
                    }
                    if (!senses.isEmpty()) {
                        return Optional.of(CanonicalDictionaryResponse.builder()
                                .query(query.trim())
                                .normalizedQuery(clean)
                                .entryType("PHRASAL_VERB")
                                .headword(pv.getPhrase())
                                .generalTranslationVi(pv.getTranslationVi())
                                .partsOfSpeech(List.of(CanonicalDictionaryResponse.PartOfSpeechGroupDto.builder()
                                        .partOfSpeech("verb")
                                        .senses(senses)
                                        .build()))
                                .source("English Coach Lexical Engine")
                                .build());
                    }
                }
            }
        }

        // 3. Check Idioms
        for (List<CanonicalDictionaryResponse.IdiomDto> list : IDIOMS_BY_KEYWORD.values()) {
            for (CanonicalDictionaryResponse.IdiomDto idm : list) {
                if (idm.getPhrase() != null && idm.getPhrase().equalsIgnoreCase(clean)) {
                    List<CanonicalDictionaryResponse.SenseDto> senses = new ArrayList<>();
                    if (idm.getShortMeaning() != null && !idm.getShortMeaning().isBlank()) {
                        senses.add(CanonicalDictionaryResponse.SenseDto.builder()
                                .id("1")
                                .definitionEn(idm.getShortMeaning())
                                .translationVi(idm.getTranslationVi())
                                .examples(idm.getExamples() != null ? idm.getExamples() : new ArrayList<>())
                                .build());
                    }
                    if (!senses.isEmpty()) {
                        return Optional.of(CanonicalDictionaryResponse.builder()
                                .query(query.trim())
                                .normalizedQuery(clean)
                                .entryType("IDIOM")
                                .headword(idm.getPhrase())
                                .generalTranslationVi(idm.getTranslationVi())
                                .partsOfSpeech(List.of(CanonicalDictionaryResponse.PartOfSpeechGroupDto.builder()
                                        .partOfSpeech("idiom")
                                        .senses(senses)
                                        .build()))
                                .source("English Coach Lexical Engine")
                                .build());
                    }
                }
            }
        }

        return Optional.empty();
    }

    /**
     * Checks if a phrase is known as a phrasal verb, idiom, or expression for deduplication from collocations.
     */
    public boolean isKnownPhrase(String phrase) {
        if (phrase == null || phrase.isBlank()) return false;
        String clean = phrase.trim().toLowerCase();
        if (DIRECT_PHRASE_ENTRIES.containsKey(clean)) {
            String type = DIRECT_PHRASE_ENTRIES.get(clean).getEntryType();
            return !"COLLOCATION".equalsIgnoreCase(type);
        }
        for (List<CanonicalDictionaryResponse.PhrasalVerbDto> list : PHRASAL_VERBS_BY_BASE.values()) {
            for (CanonicalDictionaryResponse.PhrasalVerbDto pv : list) {
                if (pv.getPhrase() != null && pv.getPhrase().equalsIgnoreCase(clean)) return true;
            }
        }
        for (List<CanonicalDictionaryResponse.IdiomDto> list : IDIOMS_BY_KEYWORD.values()) {
            for (CanonicalDictionaryResponse.IdiomDto idm : list) {
                if (idm.getPhrase() != null && idm.getPhrase().equalsIgnoreCase(clean)) return true;
            }
        }
        // Deduplicate verb + particle combinations from collocations
        String[] tokens = clean.split("\\s+");
        if (tokens.length == 2 && PARTICLES.contains(tokens[1])) {
            return true;
        }
        if (tokens.length == 3 && PARTICLES.contains(tokens[1]) && PREPOSITIONS.contains(tokens[2])) {
            return true;
        }
        if (kaikkiLocalLexicalStore != null) {
            Optional<CanonicalDictionaryResponse> kOpt = kaikkiLocalLexicalStore.getEntry(clean);
            if (kOpt.isPresent()) {
                String type = kOpt.get().getEntryType();
                if ("PHRASAL_VERB".equalsIgnoreCase(type) || "IDIOM".equalsIgnoreCase(type) || "EXPRESSION".equalsIgnoreCase(type)) {
                    return true;
                }
            }
        }
        if (dictionaryRepository != null) {
            try {
                Optional<DictionaryEntry> deOpt = dictionaryRepository.findByWordIgnoreCase(clean);
                if (deOpt.isPresent()) {
                    String type = deOpt.get().getEntryType();
                    return "PHRASAL_VERB".equalsIgnoreCase(type) || "IDIOM".equalsIgnoreCase(type) || "EXPRESSION".equalsIgnoreCase(type);
                }
            } catch (Exception ignored) {}
        }
        return false;
    }

    /**
     * Checks whether an exact dictionary entry exists for a collocation / phrase.
     */
    /**
     * The phrases (lower case) among {@code phrases} that have their own entry — {@link #hasDirectEntry} for many at
     * once: the curated table and the local store first, then ONE shared-rows query for the rest (never one database
     * round trip per phrase).
     */
    public Set<String> directEntriesAmong(Collection<String> phrases) {
        Set<String> found = new HashSet<>();
        List<String> rest = new ArrayList<>();
        for (String phrase : phrases) {
            if (phrase == null || phrase.isBlank()) continue;
            String clean = phrase.trim().toLowerCase();
            if (DIRECT_PHRASE_ENTRIES.containsKey(clean)
                    || (kaikkiLocalLexicalStore != null && kaikkiLocalLexicalStore.getEntry(clean).isPresent())) {
                found.add(clean);
            } else {
                rest.add(clean);
            }
        }
        if (!rest.isEmpty() && dictionaryRepository != null) {
            try {
                found.addAll(dictionaryRepository.findSharedWordsAmong(rest));
            } catch (Exception e) {
                log.debug("Batched entry check failed: {}", e.getMessage());
            }
        }
        return found;
    }

    public boolean hasDirectEntry(String phrase) {
        if (phrase == null || phrase.isBlank()) return false;
        String clean = phrase.trim().toLowerCase();
        if (DIRECT_PHRASE_ENTRIES.containsKey(clean)) return true;
        if (kaikkiLocalLexicalStore != null && kaikkiLocalLexicalStore.getEntry(clean).isPresent()) return true;
        if (dictionaryRepository != null) {
            try {
                return dictionaryRepository.findByWordIgnoreCase(clean).isPresent();
            } catch (Exception e) {
                return false;
            }
        }
        return false;
    }

    /**
     * Generic, metadata-grounded lexical classifier adhering to Section 8 priority:
     * 1. explicit source lexical type
     * 2. source tags / categories / labels
     * 3. source POS + multi-word metadata
     * 4. safe deterministic fallback
     * 5. otherwise EXPRESSION / WORD
     */
    public String classifyLexicalEntry(String word, String sourceEntryType, List<String> posList, List<String> labels, List<String> definitions) {
        if (word == null || word.isBlank()) return "WORD";
        String clean = word.toLowerCase().trim();

        // 1. Explicit source lexical type
        if (sourceEntryType != null && !sourceEntryType.isBlank()) {
            String norm = sourceEntryType.toUpperCase().trim();
            if (norm.contains("PHRASAL_VERB") || norm.contains("VERB_PARTICLE")) return "PHRASAL_VERB";
            if (norm.contains("IDIOM")) return "IDIOM";
            if (norm.contains("COLLOCATION")) return "COLLOCATION";
            if (norm.contains("EXPRESSION")) return "EXPRESSION";
        }

        // 2. Source tags / categories / labels
        if (labels != null) {
            for (String lbl : labels) {
                if (lbl == null) continue;
                String l = lbl.toLowerCase().trim();
                if (l.contains("phrasal verb") || l.contains("verb particle") || l.contains("prepositional verb")) return "PHRASAL_VERB";
                if (l.contains("idiom") || l.contains("idiomatic") || l.contains("proverb") || l.contains("saying")) return "IDIOM";
                if (l.contains("collocation")) return "COLLOCATION";
                if (l.contains("expression") || l.contains("fixed phrase") || l.contains("set phrase")) return "EXPRESSION";
            }
        }

        // 3. Source POS + multi-word metadata
        if (posList != null && !posList.isEmpty()) {
            for (String pos : posList) {
                if (pos == null) continue;
                String p = pos.toLowerCase().trim();
                if (p.contains("phrasal verb") || p.contains("phrasal-verb")) return "PHRASAL_VERB";
                if (p.contains("idiom")) return "IDIOM";
            }
            boolean isVerb = posList.stream().anyMatch(p -> p != null && (p.equalsIgnoreCase("verb") || p.equalsIgnoreCase("v")));
            if (isVerb && clean.contains(" ")) {
                String[] tokens = clean.split("\\s+");
                if (tokens.length == 2 && PARTICLES.contains(tokens[1])) return "PHRASAL_VERB";
                if (tokens.length == 3 && PARTICLES.contains(tokens[1]) && PREPOSITIONS.contains(tokens[2])) return "PHRASAL_VERB";
            }
        }

        // 4. Safe deterministic fallback
        if (DIRECT_PHRASE_ENTRIES.containsKey(clean)) {
            return DIRECT_PHRASE_ENTRIES.get(clean).getEntryType();
        }
        if (definitions != null) {
            for (String def : definitions) {
                if (def == null) continue;
                String d = def.toLowerCase();
                if (d.contains("idiomatic") || d.contains("figuratively") || d.contains("proverb")) return "IDIOM";
                if (d.contains("phrasal verb") || d.contains("verb particle")) return "PHRASAL_VERB";
            }
        }

        String[] tokens = clean.split("[\\s-]+");
        if (tokens.length == 2 && PARTICLES.contains(tokens[1])) {
            return "PHRASAL_VERB";
        }
        if (tokens.length > 1) {
            return "EXPRESSION";
        }
        return "WORD";
    }

    public String detectEntryType(String query) {
        return classifyLexicalEntry(query, null, Collections.emptyList(), Collections.emptyList(), Collections.emptyList());
    }

    /**
     * Resolves related usage across four independent pipelines (Sections 2, 3, 4, 6, 8, 9, 12, 19, 20):
     * 1. Lemma normalization
     * 2. Direct lexical relations
     * 3. Reverse lexical lookup via indexed DB queries
     * 4. Reverse anchor index
     * 5. Dynamic open-lexical discovery for productive verbs
     * 6. Last-resort curated baseline
     */
    public PhrasesResponse getPhrasesForWord(String word) {
        if (word == null || word.isBlank()) {
            return PhrasesResponse.builder()
                    .word("")
                    .phrasalVerbs(Collections.emptyList())
                    .idioms(Collections.emptyList())
                    .expressions(Collections.emptyList())
                    .build();
        }

        String clean = word.trim().toLowerCase();
        String baseLemma = clean;
        if (kaikkiLocalLexicalStore != null) {
            Optional<KaikkiLocalLexicalStore.LemmaInfo> lemmaOpt = kaikkiLocalLexicalStore.resolveLemma(clean);
            if (lemmaOpt.isPresent() && lemmaOpt.get().getLemma() != null) {
                baseLemma = lemmaOpt.get().getLemma().toLowerCase().trim();
            }
        }

        Set<String> seenPhrases = new HashSet<>();
        List<CanonicalDictionaryResponse.PhrasalVerbDto> pvs = new ArrayList<>();
        List<CanonicalDictionaryResponse.IdiomDto> idioms = new ArrayList<>();
        List<CanonicalDictionaryResponse.IdiomDto> expressions = new ArrayList<>();

        // 1. Direct lexical relations from base entry
        resolveDirectRelations(baseLemma, seenPhrases, pvs, idioms, expressions);

        // 2. Reverse lexical lookup from indexed database & anchors
        resolveReverseRelations(baseLemma, seenPhrases, pvs, idioms, expressions);

        // 3. Dynamic candidate discovery for productive verbs if DB has fewer than 4 phrasal verbs
        if (pvs.size() < 4) {
            discoverDynamicPhrasalVerbs(baseLemma, seenPhrases, pvs);
        }

        // 4. Last-resort curated fallback (original baseline only, if collections are still empty)
        if (pvs.isEmpty()) {
            List<CanonicalDictionaryResponse.PhrasalVerbDto> basePvs = PHRASAL_VERBS_BY_BASE.get(baseLemma);
            if (basePvs != null) {
                for (CanonicalDictionaryResponse.PhrasalVerbDto pv : basePvs) {
                    if (pv.getPhrase() != null && seenPhrases.add(pv.getPhrase().toLowerCase())) {
                        pvs.add(pv);
                    }
                }
            }
        }
        if (idioms.isEmpty()) {
            List<CanonicalDictionaryResponse.IdiomDto> baseIdioms = IDIOMS_BY_KEYWORD.get(baseLemma);
            if (baseIdioms != null) {
                for (CanonicalDictionaryResponse.IdiomDto idm : baseIdioms) {
                    if (idm.getPhrase() != null && seenPhrases.add(idm.getPhrase().toLowerCase())) {
                        idioms.add(idm);
                    }
                }
            }
        }

        return PhrasesResponse.builder()
                .word(word)
                .phrasalVerbs(pvs)
                .idioms(idioms)
                .expressions(expressions)
                .build();
    }

    private void resolveDirectRelations(
            String baseLemma,
            Set<String> seenPhrases,
            List<CanonicalDictionaryResponse.PhrasalVerbDto> pvs,
            List<CanonicalDictionaryResponse.IdiomDto> idioms,
            List<CanonicalDictionaryResponse.IdiomDto> expressions) {

        if (DIRECT_PHRASE_ENTRIES.containsKey(baseLemma)) {
            CanonicalDictionaryResponse dir = DIRECT_PHRASE_ENTRIES.get(baseLemma);
            if (dir.getPhrasalVerbs() != null) {
                for (CanonicalDictionaryResponse.PhrasalVerbDto pv : dir.getPhrasalVerbs()) {
                    if (pv.getPhrase() != null && seenPhrases.add(pv.getPhrase().toLowerCase())) pvs.add(pv);
                }
            }
            if (dir.getIdioms() != null) {
                for (CanonicalDictionaryResponse.IdiomDto idm : dir.getIdioms()) {
                    if (idm.getPhrase() != null && seenPhrases.add(idm.getPhrase().toLowerCase())) idioms.add(idm);
                }
            }
            if (dir.getExpressions() != null) {
                for (CanonicalDictionaryResponse.IdiomDto exp : dir.getExpressions()) {
                    if (exp.getPhrase() != null && seenPhrases.add(exp.getPhrase().toLowerCase())) expressions.add(exp);
                }
            }
        }

        if (kaikkiLocalLexicalStore != null) {
            Optional<CanonicalDictionaryResponse> kOpt = kaikkiLocalLexicalStore.getEntry(baseLemma);
            if (kOpt.isPresent()) {
                CanonicalDictionaryResponse kEntry = kOpt.get();
                if (kEntry.getPhrasalVerbs() != null) {
                    for (CanonicalDictionaryResponse.PhrasalVerbDto pv : kEntry.getPhrasalVerbs()) {
                        if (pv.getPhrase() != null && seenPhrases.add(pv.getPhrase().toLowerCase())) pvs.add(pv);
                    }
                }
                if (kEntry.getIdioms() != null) {
                    for (CanonicalDictionaryResponse.IdiomDto idm : kEntry.getIdioms()) {
                        if (idm.getPhrase() != null && seenPhrases.add(idm.getPhrase().toLowerCase())) idioms.add(idm);
                    }
                }
                if (kEntry.getExpressions() != null) {
                    for (CanonicalDictionaryResponse.IdiomDto exp : kEntry.getExpressions()) {
                        if (exp.getPhrase() != null && seenPhrases.add(exp.getPhrase().toLowerCase())) expressions.add(exp);
                    }
                }
            }
        }

        if (dictionaryRepository != null) {
            try {
                Optional<DictionaryEntry> dbOpt = dictionaryRepository.findByWordIgnoreCase(baseLemma);
                if (dbOpt.isPresent() && dbOpt.get().getDataJson() != null && !dbOpt.get().getDataJson().isBlank()) {
                    CanonicalDictionaryResponse dbEntry = objectMapper.readValue(dbOpt.get().getDataJson(), CanonicalDictionaryResponse.class);
                    if (dbEntry.getPhrasalVerbs() != null) {
                        for (CanonicalDictionaryResponse.PhrasalVerbDto pv : dbEntry.getPhrasalVerbs()) {
                            if (pv.getPhrase() != null && seenPhrases.add(pv.getPhrase().toLowerCase())) pvs.add(pv);
                        }
                    }
                    if (dbEntry.getIdioms() != null) {
                        for (CanonicalDictionaryResponse.IdiomDto idm : dbEntry.getIdioms()) {
                            if (idm.getPhrase() != null && seenPhrases.add(idm.getPhrase().toLowerCase())) idioms.add(idm);
                        }
                    }
                    if (dbEntry.getExpressions() != null) {
                        for (CanonicalDictionaryResponse.IdiomDto exp : dbEntry.getExpressions()) {
                            if (exp.getPhrase() != null && seenPhrases.add(exp.getPhrase().toLowerCase())) expressions.add(exp);
                        }
                    }
                }
            } catch (Exception ignored) {}
        }
    }

    private void resolveReverseRelations(
            String baseLemma,
            Set<String> seenPhrases,
            List<CanonicalDictionaryResponse.PhrasalVerbDto> pvs,
            List<CanonicalDictionaryResponse.IdiomDto> idioms,
            List<CanonicalDictionaryResponse.IdiomDto> expressions) {

        // A. Reverse Database Lookup via indexed prefix query
        if (dictionaryRepository != null) {
            try {
                // Prefix query on indexed word column (e.g. "make %", "bring %", "fall %")
                List<DictionaryEntry> prefixEntries = dictionaryRepository.findByWordStartingWithIgnoreCase(baseLemma + " ");
                for (DictionaryEntry de : prefixEntries) {
                    processDbEntry(de, seenPhrases, pvs, idioms, expressions);
                }
                // Suffix query for phrases ending with baseLemma (e.g. "% weather")
                List<DictionaryEntry> suffixEntries = dictionaryRepository.findByWordEndingWithIgnoreCase(" " + baseLemma);
                for (DictionaryEntry de : suffixEntries) {
                    processDbEntry(de, seenPhrases, pvs, idioms, expressions);
                }
                // Infix query for phrases containing baseLemma (e.g. "% take %")
                List<DictionaryEntry> infixEntries = dictionaryRepository.findByWordContainingIgnoreCase(" " + baseLemma + " ");
                for (DictionaryEntry de : infixEntries) {
                    processDbEntry(de, seenPhrases, pvs, idioms, expressions);
                }
            } catch (Exception e) {
                log.debug("Reverse DB phrase lookup failed for '{}': {}", baseLemma, e.getMessage());
            }
        }

        // B. Reverse Anchor Index lookup (e.g. "weather" -> "under the weather", "ice" -> "break the ice")
        Set<String> anchoredPhrases = REVERSE_INDEX_BY_ANCHOR.get(baseLemma);
        if (anchoredPhrases != null) {
            for (String phraseKey : anchoredPhrases) {
                if (seenPhrases.contains(phraseKey)) continue;

                CanonicalDictionaryResponse entry = DIRECT_PHRASE_ENTRIES.get(phraseKey);
                if (entry == null && kaikkiLocalLexicalStore != null) {
                    entry = kaikkiLocalLexicalStore.getEntry(phraseKey).orElse(null);
                }
                if (entry == null && dictionaryRepository != null) {
                    try {
                        Optional<DictionaryEntry> deOpt = dictionaryRepository.findByWordIgnoreCase(phraseKey);
                        if (deOpt.isPresent() && deOpt.get().getDataJson() != null && !deOpt.get().getDataJson().isBlank()) {
                            entry = objectMapper.readValue(deOpt.get().getDataJson(), CanonicalDictionaryResponse.class);
                        }
                    } catch (Exception ignored) {}
                }

                if (entry != null) {
                    String classifiedType = classifyLexicalEntry(
                            phraseKey,
                            entry.getEntryType(),
                            extractPos(entry),
                            extractLabels(entry),
                            extractDefinitions(entry));

                    if ("PHRASAL_VERB".equalsIgnoreCase(classifiedType)) {
                        if (seenPhrases.add(phraseKey)) {
                            pvs.add(toPhrasalVerbDto(entry));
                        }
                    } else if ("IDIOM".equalsIgnoreCase(classifiedType)) {
                        if (seenPhrases.add(phraseKey)) {
                            idioms.add(toIdiomDto(entry));
                        }
                    } else if ("EXPRESSION".equalsIgnoreCase(classifiedType)) {
                        if (seenPhrases.add(phraseKey)) {
                            expressions.add(toIdiomDto(entry));
                        }
                    }
                }
            }
        }
    }

    private void processDbEntry(
            DictionaryEntry dbEntry,
            Set<String> seenPhrases,
            List<CanonicalDictionaryResponse.PhrasalVerbDto> pvs,
            List<CanonicalDictionaryResponse.IdiomDto> idioms,
            List<CanonicalDictionaryResponse.IdiomDto> expressions) {
        String dbWord = dbEntry.getWord().toLowerCase().trim();
        if (seenPhrases.contains(dbWord)) return;

        List<String> posList = new ArrayList<>();
        List<String> labels = new ArrayList<>();
        List<String> defs = new ArrayList<>();

        if (dbEntry.getDataJson() != null && !dbEntry.getDataJson().isBlank()) {
            try {
                CanonicalDictionaryResponse resp = objectMapper.readValue(dbEntry.getDataJson(), CanonicalDictionaryResponse.class);
                if (resp.getPartsOfSpeech() != null) {
                    for (CanonicalDictionaryResponse.PartOfSpeechGroupDto pg : resp.getPartsOfSpeech()) {
                        if (pg.getPartOfSpeech() != null) posList.add(pg.getPartOfSpeech());
                        if (pg.getSenses() != null) {
                            for (CanonicalDictionaryResponse.SenseDto s : pg.getSenses()) {
                                if (s.getDefinitionEn() != null) defs.add(s.getDefinitionEn());
                                if (s.getLabels() != null) labels.addAll(s.getLabels());
                            }
                        }
                    }
                }
            } catch (Exception ignored) {}
        }
        if (defs.isEmpty() && dbEntry.getMeanings() != null) {
            defs.addAll(dbEntry.getMeanings());
        }

        String classifiedType = classifyLexicalEntry(dbWord, dbEntry.getEntryType(), posList, labels, defs);
        String shortMeaning = !defs.isEmpty() ? defs.get(0) : null;

        if ("PHRASAL_VERB".equalsIgnoreCase(classifiedType)) {
            if (seenPhrases.add(dbWord)) {
                pvs.add(CanonicalDictionaryResponse.PhrasalVerbDto.builder()
                        .phrase(dbEntry.getWord())
                        .shortMeaning(shortMeaning)
                        .translationVi(dbEntry.getGeneralTranslationVi())
                        .examples(dbEntry.getExamples())
                        .build());
            }
        } else if ("IDIOM".equalsIgnoreCase(classifiedType)) {
            if (seenPhrases.add(dbWord)) {
                idioms.add(CanonicalDictionaryResponse.IdiomDto.builder()
                        .phrase(dbEntry.getWord())
                        .shortMeaning(shortMeaning)
                        .translationVi(dbEntry.getGeneralTranslationVi())
                        .examples(dbEntry.getExamples())
                        .build());
            }
        } else if ("EXPRESSION".equalsIgnoreCase(classifiedType)) {
            if (seenPhrases.add(dbWord)) {
                expressions.add(CanonicalDictionaryResponse.IdiomDto.builder()
                        .phrase(dbEntry.getWord())
                        .shortMeaning(shortMeaning)
                        .translationVi(dbEntry.getGeneralTranslationVi())
                        .examples(dbEntry.getExamples())
                        .build());
            }
        }
    }

    /**
     * Dynamically discovers verb particles from open, structured lexical data (Wiktionary REST API)
     * and persists discovered entries into the database index.
     * Zero AI / LLM calls.
     */
    private void discoverDynamicPhrasalVerbs(
            String baseLemma,
            Set<String> seenPhrases,
            List<CanonicalDictionaryResponse.PhrasalVerbDto> pvs) {
        if (baseLemma == null || baseLemma.isBlank() || baseLemma.contains(" ")) return;

        List<String> candidateParticles = List.of(
                "up", "out", "off", "on", "down", "in", "away", "back", "over", "through", "into", "after"
        );

        List<CompletableFuture<Optional<CanonicalDictionaryResponse.PhrasalVerbDto>>> futures = new ArrayList<>();
        for (String particle : candidateParticles) {
            String candidate = baseLemma + " " + particle;
            if (seenPhrases.contains(candidate)) continue;
            futures.add(CompletableFuture.supplyAsync(() -> fetchOpenPhrasalVerb(candidate, baseLemma, particle)));
        }

        for (CompletableFuture<Optional<CanonicalDictionaryResponse.PhrasalVerbDto>> future : futures) {
            try {
                Optional<CanonicalDictionaryResponse.PhrasalVerbDto> opt = future.get(800, java.util.concurrent.TimeUnit.MILLISECONDS);
                if (opt.isPresent()) {
                    CanonicalDictionaryResponse.PhrasalVerbDto pv = opt.get();
                    if (seenPhrases.add(pv.getPhrase().toLowerCase())) {
                        pvs.add(pv);
                    }
                }
            } catch (Exception ignored) {}
        }
    }

    private Optional<CanonicalDictionaryResponse.PhrasalVerbDto> fetchOpenPhrasalVerb(String candidate, String baseLemma, String particle) {
        try {
            String encoded = URLEncoder.encode(candidate.replace(" ", "_"), StandardCharsets.UTF_8);
            String url = "https://en.wiktionary.org/api/rest_v1/page/definition/" + encoded;
            HttpHeaders headers = new HttpHeaders();
            headers.set("User-Agent", "EnglishCoachApp/2.0 (contact: admin@englishcoach.io.vn)");
            HttpEntity<Void> entity = new HttpEntity<>(headers);
            ResponseEntity<String> response = restTemplate.exchange(url, HttpMethod.GET, entity, String.class);
            if (!response.getStatusCode().is2xxSuccessful() || response.getBody() == null) {
                return Optional.empty();
            }

            JsonNode root = objectMapper.readTree(response.getBody());
            JsonNode enArray = root.path("en");
            if (!enArray.isArray() || enArray.isEmpty()) return Optional.empty();

            for (JsonNode posNode : enArray) {
                String pos = posNode.path("partOfSpeech").asText("").toLowerCase();
                if ("verb".equalsIgnoreCase(pos) || pos.contains("phrasal verb")) {
                    JsonNode defsNode = posNode.path("definitions");
                    if (defsNode.isArray() && !defsNode.isEmpty()) {
                        String rawDef = defsNode.get(0).path("definition").asText("").trim();
                        String cleanDef = stripHtml(rawDef);
                        if (cleanDef.isEmpty() || cleanDef.length() < 3) continue;

                        List<String> examples = new ArrayList<>();
                        JsonNode exArray = defsNode.get(0).path("examples");
                        if (exArray.isArray()) {
                            for (JsonNode ex : exArray) {
                                String cleanEx = stripHtml(ex.asText(""));
                                if (!cleanEx.isEmpty() && cleanEx.length() > 5) {
                                    examples.add(cleanEx);
                                }
                            }
                        }

                        CanonicalDictionaryResponse.PhrasalVerbDto dto = CanonicalDictionaryResponse.PhrasalVerbDto.builder()
                                .phrase(candidate)
                                .shortMeaning(cleanDef)
                                .examples(examples)
                                .build();

                        // Persist to database so subsequent lookups are instant indexed DB queries
                        if (dictionaryRepository != null) {
                            try {
                                if (dictionaryRepository.findByWordIgnoreCase(candidate).isEmpty()) {
                                    DictionaryEntry de = DictionaryEntry.builder()
                                            .word(candidate)
                                            .entryType("PHRASAL_VERB")
                                            .meanings(List.of(cleanDef))
                                            .examples(examples)
                                            .updatedAt(java.time.LocalDateTime.now())
                                            .build();
                                    dictionaryRepository.save(de);
                                }
                            } catch (Exception ignored) {}
                        }

                        return Optional.of(dto);
                    }
                }
            }
        } catch (Exception ignored) {}
        return Optional.empty();
    }

    private String stripHtml(String text) {
        if (text == null || text.isBlank()) return "";
        String s = text.replaceAll("<style[^>]*>.*?</style>", "")
                .replaceAll("<script[^>]*>.*?</script>", "");
        s = MW_PARSER_PATTERN.matcher(s).replaceAll("");
        s = HTML_TAG_PATTERN.matcher(s).replaceAll("");
        return s.replaceAll("\\s+", " ").trim();
    }

    private List<String> extractPos(CanonicalDictionaryResponse entry) {
        List<String> list = new ArrayList<>();
        if (entry.getPartsOfSpeech() != null) {
            for (CanonicalDictionaryResponse.PartOfSpeechGroupDto pg : entry.getPartsOfSpeech()) {
                if (pg.getPartOfSpeech() != null) list.add(pg.getPartOfSpeech());
            }
        }
        return list;
    }

    private List<String> extractLabels(CanonicalDictionaryResponse entry) {
        List<String> list = new ArrayList<>();
        if (entry.getPartsOfSpeech() != null) {
            for (CanonicalDictionaryResponse.PartOfSpeechGroupDto pg : entry.getPartsOfSpeech()) {
                if (pg.getSenses() != null) {
                    for (CanonicalDictionaryResponse.SenseDto s : pg.getSenses()) {
                        if (s.getLabels() != null) list.addAll(s.getLabels());
                    }
                }
            }
        }
        return list;
    }

    private List<String> extractDefinitions(CanonicalDictionaryResponse entry) {
        List<String> list = new ArrayList<>();
        if (entry.getPartsOfSpeech() != null) {
            for (CanonicalDictionaryResponse.PartOfSpeechGroupDto pg : entry.getPartsOfSpeech()) {
                if (pg.getSenses() != null) {
                    for (CanonicalDictionaryResponse.SenseDto s : pg.getSenses()) {
                        if (s.getDefinitionEn() != null) list.add(s.getDefinitionEn());
                    }
                }
            }
        }
        return list;
    }

    private CanonicalDictionaryResponse.PhrasalVerbDto toPhrasalVerbDto(CanonicalDictionaryResponse entry) {
        String def = null;
        String vi = entry.getGeneralTranslationVi();
        List<String> examples = new ArrayList<>();
        if (entry.getPartsOfSpeech() != null && !entry.getPartsOfSpeech().isEmpty()) {
            CanonicalDictionaryResponse.PartOfSpeechGroupDto pos = entry.getPartsOfSpeech().get(0);
            if (pos.getSenses() != null && !pos.getSenses().isEmpty()) {
                def = pos.getSenses().get(0).getDefinitionEn();
                if ((vi == null || vi.isBlank()) && pos.getSenses().get(0).getTranslationVi() != null) {
                    vi = pos.getSenses().get(0).getTranslationVi();
                }
                if (pos.getSenses().get(0).getExamples() != null) {
                    examples.addAll(pos.getSenses().get(0).getExamples());
                }
            }
        }
        return CanonicalDictionaryResponse.PhrasalVerbDto.builder()
                .phrase(entry.getHeadword() != null ? entry.getHeadword() : entry.getQuery())
                .shortMeaning(def)
                .translationVi(vi)
                .examples(examples)
                .build();
    }

    private CanonicalDictionaryResponse.IdiomDto toIdiomDto(CanonicalDictionaryResponse entry) {
        String def = null;
        String vi = entry.getGeneralTranslationVi();
        List<String> examples = new ArrayList<>();
        if (entry.getPartsOfSpeech() != null && !entry.getPartsOfSpeech().isEmpty()) {
            CanonicalDictionaryResponse.PartOfSpeechGroupDto pos = entry.getPartsOfSpeech().get(0);
            if (pos.getSenses() != null && !pos.getSenses().isEmpty()) {
                def = pos.getSenses().get(0).getDefinitionEn();
                if ((vi == null || vi.isBlank()) && pos.getSenses().get(0).getTranslationVi() != null) {
                    vi = pos.getSenses().get(0).getTranslationVi();
                }
                if (pos.getSenses().get(0).getExamples() != null) {
                    examples.addAll(pos.getSenses().get(0).getExamples());
                }
            }
        }
        return CanonicalDictionaryResponse.IdiomDto.builder()
                .phrase(entry.getHeadword() != null ? entry.getHeadword() : entry.getQuery())
                .shortMeaning(def)
                .translationVi(vi)
                .examples(examples)
                .build();
    }
}
