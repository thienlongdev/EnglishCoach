package com.englishcoach.dictionary.provider;

import com.englishcoach.dictionary.dto.CanonicalDictionaryResponse;
import com.englishcoach.dictionary.dto.CollocationsResponse;
import com.englishcoach.dictionary.entity.DictionaryEntry;
import com.englishcoach.dictionary.repository.DictionaryRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.Nullable;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestTemplate;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.*;

/**
 * Open deterministic provider for Collocations and Semantic Enrichment (Synonyms, Antonyms, Related Words).
 */
@Slf4j
@Component
public class DatamuseProvider {

    private final RestTemplate restTemplate;
    private final ObjectMapper objectMapper;

    // Common noise words to filter out from collocation phrases
    private static final Set<String> MODAL_AUXILIARIES = Set.of(
            "will", "would", "can", "could", "may", "might", "shall", "should", "must",
            "ought", "need", "dare", "do", "does", "did", "have", "has", "had", "be",
            "is", "am", "are", "was", "were", "been", "being"
    );

    private static final Set<String> PRONOUNS = Set.of(
            "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us", "them",
            "my", "your", "his", "its", "our", "their", "mine", "yours", "hers", "ours", "theirs",
            "who", "whom", "whose", "which", "what", "this", "that", "these", "those",
            "someone", "somebody", "something", "anyone", "anybody", "anything",
            "everyone", "everybody", "everything", "nobody", "no one", "nothing"
    );

    private static final Set<String> DETERMINERS = Set.of(
            "the", "a", "an", "all", "both", "each", "every", "some", "any", "no", "other", "another"
    );

    private static final Set<String> PREPOSITIONS_CONJUNCTIONS = Set.of(
            "to", "of", "in", "for", "with", "on", "at", "from", "by", "about", "into",
            "through", "during", "before", "after", "above", "below", "under", "between",
            "against", "among", "out", "off", "over", "and", "or", "but", "if", "because",
            "as", "until", "while", "not", "then", "so", "than", "too", "very", "also"
    );

    private static final Set<String> QUESTION_WORDS = Set.of(
            "who", "whom", "whose", "what", "which", "where", "when", "why", "how"
    );

    private static final Set<String> ALL_NOISE = new HashSet<>();
    static {
        ALL_NOISE.addAll(MODAL_AUXILIARIES);
        ALL_NOISE.addAll(PRONOUNS);
        ALL_NOISE.addAll(DETERMINERS);
        ALL_NOISE.addAll(PREPOSITIONS_CONJUNCTIONS);
        ALL_NOISE.addAll(QUESTION_WORDS);
    }

    private static final Set<String> NOUN_ADJUNCTS = Set.of(
            "fall", "spring", "summer", "winter", "school", "college", "university",
            "business", "market", "water", "blood", "air", "land", "gold", "data", "system", "life"
    );

    // High-value curated collocations for core headwords with examples and meanings
    private static final Map<String, List<CanonicalDictionaryResponse.CollocationDto>> CURATED_COLLOCATIONS = new HashMap<>();
    static {
        CURATED_COLLOCATIONS.put("take", List.of(
                CanonicalDictionaryResponse.CollocationDto.builder()
                        .phrase("take action")
                        .pattern("Verb + Noun")
                        .translationVi("hành động quyết liệt")
                        .example("The government must take action to address climate change.")
                        .score(1000)
                        .source("Curated")
                        .build(),
                CanonicalDictionaryResponse.CollocationDto.builder()
                        .phrase("take responsibility")
                        .pattern("Verb + Noun")
                        .translationVi("chịu trách nhiệm")
                        .example("The manager decided to take responsibility for the team's error.")
                        .score(980)
                        .source("Curated")
                        .build(),
                CanonicalDictionaryResponse.CollocationDto.builder()
                        .phrase("take a break")
                        .pattern("Verb + Noun")
                        .translationVi("nghỉ ngơi, giải lao")
                        .example("Let's take a break for fifteen minutes.")
                        .score(970)
                        .source("Curated")
                        .build(),
                CanonicalDictionaryResponse.CollocationDto.builder()
                        .phrase("take a look")
                        .pattern("Verb + Noun")
                        .translationVi("nhìn qua, xem xét")
                        .example("Can you take a look at my draft and give me some advice?")
                        .score(960)
                        .source("Curated")
                        .build(),
                CanonicalDictionaryResponse.CollocationDto.builder()
                        .phrase("take notes")
                        .pattern("Verb + Noun")
                        .translationVi("ghi chép, ghi chú")
                        .example("Students are encouraged to take notes during class.")
                        .score(950)
                        .source("Curated")
                        .build(),
                CanonicalDictionaryResponse.CollocationDto.builder()
                        .phrase("take care")
                        .pattern("Verb + Noun")
                        .translationVi("chăm sóc, cẩn thận")
                        .example("Please take care when walking on the icy pavement.")
                        .score(940)
                        .source("Curated")
                        .build(),
                CanonicalDictionaryResponse.CollocationDto.builder()
                        .phrase("take part")
                        .pattern("Verb + Noun")
                        .translationVi("tham gia")
                        .example("Many local residents took part in the community cleanup.")
                        .score(930)
                        .source("Curated")
                        .build(),
                CanonicalDictionaryResponse.CollocationDto.builder()
                        .phrase("take place")
                        .pattern("Verb + Noun")
                        .translationVi("diễn ra, xảy ra")
                        .example("The annual meeting will take place on Friday.")
                        .score(920)
                        .source("Curated")
                        .build(),
                CanonicalDictionaryResponse.CollocationDto.builder()
                        .phrase("take advantage")
                        .pattern("Verb + Noun")
                        .translationVi("tận dụng cơ hội, lợi dụng")
                        .example("You should take advantage of the free training sessions.")
                        .score(910)
                        .source("Curated")
                        .build(),
                CanonicalDictionaryResponse.CollocationDto.builder()
                        .phrase("take time")
                        .pattern("Verb + Noun")
                        .translationVi("dành thời gian, cần thời gian")
                        .example("Learning English well takes time and consistency.")
                        .score(905)
                        .source("Curated")
                        .build(),
                CanonicalDictionaryResponse.CollocationDto.builder()
                        .phrase("take seriously")
                        .pattern("Verb + Adverb")
                        .translationVi("coi trọng, nghiêm túc")
                        .example("We need to take this warning very seriously.")
                        .score(900)
                        .source("Curated")
                        .build()
        ));

        CURATED_COLLOCATIONS.put("decision", List.of(
                CanonicalDictionaryResponse.CollocationDto.builder()
                        .phrase("make a decision")
                        .pattern("Verb + Noun")
                        .translationVi("đưa ra quyết định")
                        .example("It took them weeks to make a decision.")
                        .score(1000)
                        .source("Curated")
                        .build(),
                CanonicalDictionaryResponse.CollocationDto.builder()
                        .phrase("reach a decision")
                        .pattern("Verb + Noun")
                        .translationVi("đi đến quyết định")
                        .example("The committee finally reached a decision after a long debate.")
                        .score(980)
                        .source("Curated")
                        .build(),
                CanonicalDictionaryResponse.CollocationDto.builder()
                        .phrase("important decision")
                        .pattern("Adjective + Noun")
                        .translationVi("quyết định quan trọng")
                        .example("Choosing a university is an important decision.")
                        .score(970)
                        .source("Curated")
                        .build(),
                CanonicalDictionaryResponse.CollocationDto.builder()
                        .phrase("difficult decision")
                        .pattern("Adjective + Noun")
                        .translationVi("quyết định khó khăn")
                        .example("He had to make a difficult decision regarding the company's future.")
                        .score(960)
                        .source("Curated")
                        .build(),
                CanonicalDictionaryResponse.CollocationDto.builder()
                        .phrase("final decision")
                        .pattern("Adjective + Noun")
                        .translationVi("quyết định cuối cùng")
                        .example("The manager will announce the final decision tomorrow.")
                        .score(950)
                        .source("Curated")
                        .build()
        ));
    }

    private static final Set<String> NON_NOUN_VERBS = Set.of(
            "bring", "give", "take", "make", "do", "get", "come", "go",
            "see", "hear", "tell", "say", "ask", "feel", "leave", "put",
            "keep", "let", "begin", "seem", "help", "show", "try"
    );

    /**
     * Pattern of a word attested right after the headword (Datamuse rel_bga). Told by position only: the headword's
     * own part of speech in that bigram is not known ("fall semester" vs "fall victim").
     */
    public static final String NEXT_WORD = "Next word";
    /** Free modifiers that follow almost any verb or noun: frequent neighbours, never collocations. */
    private static final Set<String> FREE_MODIFIERS = Set.of(
            "like", "more", "less", "just", "even", "still", "only", "such", "there", "here", "now", "again", "already",
            "yet", "ever", "never", "always", "often", "really", "quite"
    );

    private static final Set<String> NOISY_HISTORICAL_OR_PROPER = Set.of(
            "constantinople", "communism", "rome", "trojan", "babylon", "byzantine",
            "categories", "horizon", "soviet", "empire", "ottoman", "persian"
    );

    private final PhraseProvider phraseProvider;
    private final KaikkiLocalLexicalStore kaikkiLocalLexicalStore;
    private final DictionaryRepository dictionaryRepository;

    public DatamuseProvider(ObjectMapper objectMapper, PhraseProvider phraseProvider) {
        this(objectMapper, phraseProvider, null, null);
    }

    @Autowired
    public DatamuseProvider(
            ObjectMapper objectMapper,
            PhraseProvider phraseProvider,
            @Nullable KaikkiLocalLexicalStore kaikkiLocalLexicalStore,
            @Nullable DictionaryRepository dictionaryRepository) {
        this.objectMapper = objectMapper;
        this.phraseProvider = phraseProvider;
        this.kaikkiLocalLexicalStore = kaikkiLocalLexicalStore;
        this.dictionaryRepository = dictionaryRepository;
        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(1500);
        factory.setReadTimeout(2000);
        this.restTemplate = new RestTemplate(factory);
    }

    private Set<String> getWordPosTags(String word) {
        Set<String> tags = new HashSet<>();
        if (kaikkiLocalLexicalStore != null) {
            Optional<CanonicalDictionaryResponse> kOpt = kaikkiLocalLexicalStore.getEntry(word);
            if (kOpt.isPresent() && kOpt.get().getPartsOfSpeech() != null) {
                for (CanonicalDictionaryResponse.PartOfSpeechGroupDto posGroup : kOpt.get().getPartsOfSpeech()) {
                    String pos = posGroup.getPartOfSpeech();
                    if (pos != null) {
                        String p = pos.toLowerCase().trim();
                        if (p.contains("noun")) tags.add("n");
                        if (p.contains("verb")) tags.add("v");
                        if (p.contains("adj")) tags.add("adj");
                        if (p.contains("adv")) tags.add("adv");
                    }
                }
            }
        }
        if (tags.isEmpty() && dictionaryRepository != null) {
            try {
                Optional<DictionaryEntry> deOpt = dictionaryRepository.findByWordIgnoreCase(word);
                if (deOpt.isPresent() && deOpt.get().getDataJson() != null && !deOpt.get().getDataJson().isBlank()) {
                    CanonicalDictionaryResponse resp = objectMapper.readValue(deOpt.get().getDataJson(), CanonicalDictionaryResponse.class);
                    if (resp.getPartsOfSpeech() != null) {
                        for (CanonicalDictionaryResponse.PartOfSpeechGroupDto posGroup : resp.getPartsOfSpeech()) {
                            String pos = posGroup.getPartOfSpeech();
                            if (pos != null) {
                                String p = pos.toLowerCase().trim();
                                if (p.contains("noun")) tags.add("n");
                                if (p.contains("verb")) tags.add("v");
                                if (p.contains("adj")) tags.add("adj");
                                if (p.contains("adv")) tags.add("adv");
                            }
                        }
                    }
                }
            } catch (Exception ignored) {}
        }
        if (tags.isEmpty()) {
            try {
                String url = "https://api.datamuse.com/words?sp=" + URLEncoder.encode(word, StandardCharsets.UTF_8) + "&md=p&max=1";
                String res = fetch(url);
                if (res != null) {
                    JsonNode root = objectMapper.readTree(res);
                    if (root.isArray() && !root.isEmpty()) {
                        tags.addAll(extractTags(root.get(0)));
                    }
                }
            } catch (Exception ignored) {}
        }
        return tags;
    }

    public List<CanonicalDictionaryResponse.CollocationDto> getCollocations(String word) {
        String cleanWord = word.trim().toLowerCase();
        if (cleanWord.isEmpty() || cleanWord.contains(" ")) {
            return Collections.emptyList();
        }

        List<CanonicalDictionaryResponse.CollocationDto> results = new ArrayList<>();
        Set<String> seen = new HashSet<>();

        // 0. Seed with curated high-value collocations if available
        List<CanonicalDictionaryResponse.CollocationDto> curated = CURATED_COLLOCATIONS.get(cleanWord);
        if (curated != null) {
            for (CanonicalDictionaryResponse.CollocationDto c : curated) {
                if (seen.add(c.getPhrase().toLowerCase())) {
                    // a copy: the batched entry check below writes to it, never to the shared curated table
                    results.add(CanonicalDictionaryResponse.CollocationDto.builder().phrase(c.getPhrase()).pattern(c.getPattern())
                            .score(c.getScore()).source(c.getSource()).example(c.getExample()).translationVi(c.getTranslationVi()).build());
                }
            }
        }

        Set<String> headTags = getWordPosTags(cleanWord);
        boolean canBeNoun = headTags.contains("n") || (!NON_NOUN_VERBS.contains(cleanWord) && !headTags.contains("v"));

        // 1. Adjective collocations: rel_jjb (adjectives describing this noun) with POS metadata
        if (canBeNoun) {
            try {
                String url = "https://api.datamuse.com/words?rel_jjb=" + URLEncoder.encode(cleanWord, StandardCharsets.UTF_8) + "&md=p&max=15";
                String res = fetch(url);
                if (res != null) {
                    JsonNode items = objectMapper.readTree(res);
                    if (items.isArray()) {
                        for (JsonNode item : items) {
                            String adj = item.path("word").asText("").trim().toLowerCase();
                            int score = item.path("score").asInt(0);
                            List<String> tags = extractTags(item);
                            if (isValidWord(adj) && !ALL_NOISE.contains(adj) && tags.contains("adj")) {
                                String phrase = adj + " " + cleanWord;
                                if (seen.add(phrase) && !isNoisyPhrase(phrase, cleanWord)) {
                                    results.add(CanonicalDictionaryResponse.CollocationDto.builder()
                                            .phrase(phrase)
                                            .pattern("Adjective + Noun")
                                            .score(score)
                                            .source("Datamuse")
                                            .build());
                                }
                            }
                        }
                    }
                }
            } catch (Exception e) {
                log.debug("Datamuse rel_jjb failed for '{}': {}", cleanWord, e.getMessage());
            }
        }

        // 2. Following words: rel_bga = words attested IMMEDIATELY after the headword in the corpus (fall asleep, fall
        // short, fall victim). Trigger words (rel_trg) are only associated somewhere nearby; joining one to the
        // headword invented phrases nobody says ("fall love", "fall regime", "bank banco"), so they are never used.
        // The headword's own role before a follower is often unknown ("fall semester" = noun, "fall victim" = verb),
        // so these are told only by position (NEXT_WORD), never as a guessed "Verb + Noun".
        try {
            String url = "https://api.datamuse.com/words?rel_bga=" + URLEncoder.encode(cleanWord, StandardCharsets.UTF_8) + "&md=p&max=50";
            String res = fetch(url);
            if (res != null) {
                JsonNode items = objectMapper.readTree(res);
                if (items.isArray()) {
                    for (JsonNode item : items) {
                        String follow = item.path("word").asText("").trim().toLowerCase();
                        int score = item.path("score").asInt(0);
                        List<String> tags = extractTags(item);
                        if (isValidWord(follow) && !ALL_NOISE.contains(follow) && !FREE_MODIFIERS.contains(follow)
                                && !tags.contains("prop") && score > 1000) {
                            // the corpus saw the two words side by side: never insert an article ("bank a statement")
                            String phrase = cleanWord + " " + follow;
                            if (seen.add(phrase) && !isNoisyPhrase(phrase, cleanWord)) {
                                results.add(CanonicalDictionaryResponse.CollocationDto.builder()
                                        .phrase(phrase)
                                        .pattern(NEXT_WORD)
                                        .score(score)
                                        .source("Datamuse")
                                        .build());
                            }
                        }
                    }
                }
            }
        } catch (Exception e) {
            log.debug("Datamuse rel_bga failed for '{}': {}", cleanWord, e.getMessage());
        }

        // whether a phrase has its own dictionary entry: one batched check (it was one database round trip per phrase,
        // ≈ 90 ms each in production — most of the endpoint's 3–7 s)
        Set<String> exact = phraseProvider == null ? Set.of()
                : phraseProvider.directEntriesAmong(results.stream().map(CanonicalDictionaryResponse.CollocationDto::getPhrase).toList());
        for (CanonicalDictionaryResponse.CollocationDto c : results) {
            if (c.getHasExactEntry() == null || !c.getHasExactEntry()) {
                c.setHasExactEntry(exact.contains(c.getPhrase().toLowerCase()));
            }
        }
        return results;
    }

    /** One GET to Datamuse (a test seam: tests answer it without the network). */
    String fetch(String url) {
        return restTemplate.getForObject(url, String.class);
    }

    private static final int MAX_PER_GROUP = 12;

    public CollocationsResponse getCollocationsGrouped(String word) {
        List<CanonicalDictionaryResponse.CollocationDto> all = getCollocations(word);

        Map<String, List<CanonicalDictionaryResponse.CollocationDto>> grouped = new LinkedHashMap<>();
        grouped.put("Verb + Noun", new ArrayList<>());
        grouped.put("Verb + Adjective", new ArrayList<>());
        grouped.put("Adjective + Noun", new ArrayList<>());
        grouped.put("Noun + Noun", new ArrayList<>());
        grouped.put("Verb + Adverb", new ArrayList<>());
        grouped.put("Adverb + Adjective", new ArrayList<>());
        grouped.put(NEXT_WORD, new ArrayList<>());

        for (CanonicalDictionaryResponse.CollocationDto c : all) {
            String pattern = c.getPattern() != null ? c.getPattern().trim() : "";
            if ("verb + noun".equalsIgnoreCase(pattern)) {
                grouped.get("Verb + Noun").add(c);
            } else if ("verb + adjective".equalsIgnoreCase(pattern)) {
                grouped.get("Verb + Adjective").add(c);
            } else if ("adjective + noun".equalsIgnoreCase(pattern)) {
                grouped.get("Adjective + Noun").add(c);
            } else if ("noun + noun".equalsIgnoreCase(pattern)) {
                grouped.get("Noun + Noun").add(c);
            } else if ("verb + adverb".equalsIgnoreCase(pattern)) {
                grouped.get("Verb + Adverb").add(c);
            } else if ("adverb + adjective".equalsIgnoreCase(pattern)) {
                grouped.get("Adverb + Adjective").add(c);
            } else if (NEXT_WORD.equalsIgnoreCase(pattern)) {
                grouped.get(NEXT_WORD).add(c);
            }
        }

        List<CollocationsResponse.CollocationPatternGroup> groupList = new ArrayList<>();
        for (Map.Entry<String, List<CanonicalDictionaryResponse.CollocationDto>> entry : grouped.entrySet()) {
            List<CanonicalDictionaryResponse.CollocationDto> items = entry.getValue();
            if (!items.isEmpty()) {
                // the strongest learner-useful items per group (provider order = corpus strength)
                List<CanonicalDictionaryResponse.CollocationDto> limited = items.size() > MAX_PER_GROUP ? items.subList(0, MAX_PER_GROUP) : items;
                groupList.add(CollocationsResponse.CollocationPatternGroup.builder()
                        .pattern(entry.getKey())
                        .items(limited)
                        .build());
            }
        }

        return CollocationsResponse.builder()
                .word(word)
                .groups(groupList)
                .build();
    }

    private static boolean isValidWord(String w) {
        if (w == null || w.length() < 3) return false;
        for (int i = 0; i < w.length(); i++) {
            char c = w.charAt(i);
            if (!Character.isLetter(c)) return false;
        }
        return true;
    }

    private boolean isNoisyPhrase(String phrase) {
        return isNoisyPhrase(phrase, null);
    }

    private boolean isNoisyPhrase(String phrase, String headword) {
        if (phrase == null || phrase.isBlank()) return true;
        String lower = phrase.toLowerCase().trim();
        if (phraseProvider != null && phraseProvider.isKnownPhrase(lower)) {
            return true;
        }
        String[] tokens = lower.split("\\s+");
        if (tokens.length < 2) return true;

        for (String t : tokens) {
            if (NOISY_HISTORICAL_OR_PROPER.contains(t)) {
                return true;
            }
        }

        // Reject modal + article + word (e.g. will a take, can a take)
        if (tokens.length == 3 && MODAL_AUXILIARIES.contains(tokens[0]) && DETERMINERS.contains(tokens[1])) {
            return true;
        }
        // Reject pronoun + article + word (e.g. you a take, who a take)
        if (tokens.length == 3 && PRONOUNS.contains(tokens[0]) && DETERMINERS.contains(tokens[1])) {
            return true;
        }
        // Reject question word + article + word
        if (tokens.length == 3 && QUESTION_WORDS.contains(tokens[0]) && DETERMINERS.contains(tokens[1])) {
            return true;
        }
        // Reject starting with modal (unless it IS the headword itself, e.g. "do"), pronoun, or question word
        String h = headword != null ? headword.toLowerCase().trim() : "";
        if ((MODAL_AUXILIARIES.contains(tokens[0]) && !tokens[0].equals(h))
                || PRONOUNS.contains(tokens[0])
                || QUESTION_WORDS.contains(tokens[0])) {
            return true;
        }
        // Reject two adjacent non-noun verbs (e.g. give take, take give, bring make)
        if (tokens.length == 2 && NON_NOUN_VERBS.contains(tokens[0]) && NON_NOUN_VERBS.contains(tokens[1])) {
            return true;
        }
        // Reject ending with preposition or determiner (incomplete fragment)
        if (DETERMINERS.contains(tokens[tokens.length - 1]) || PREPOSITIONS_CONJUNCTIONS.contains(tokens[tokens.length - 1])) {
            return true;
        }
        return false;
    }

    private static List<String> extractTags(JsonNode item) {
        List<String> list = new ArrayList<>();
        JsonNode tags = item.path("tags");
        if (tags.isArray()) {
            for (JsonNode t : tags) {
                list.add(t.asText("").toLowerCase());
            }
        }
        return list;
    }

    public List<String> getSynonyms(String word) {
        return fetchWords("rel_syn", word, 10);
    }

    public List<String> getAntonyms(String word) {
        return fetchWords("rel_ant", word, 8);
    }

    public List<String> getRelatedWords(String word) {
        return fetchWords("rel_trg", word, 8);
    }

    private List<String> fetchWords(String relParam, String word, int max) {
        String cleanWord = word.trim().toLowerCase();
        if (cleanWord.isEmpty() || cleanWord.contains(" ")) {
            return Collections.emptyList();
        }

        try {
            String url = "https://api.datamuse.com/words?" + relParam + "=" + URLEncoder.encode(cleanWord, StandardCharsets.UTF_8) + "&max=" + max;
            String res = restTemplate.getForObject(url, String.class);
            if (res == null) return Collections.emptyList();

            JsonNode root = objectMapper.readTree(res);
            List<String> words = new ArrayList<>();
            if (root.isArray()) {
                for (JsonNode item : root) {
                    String w = item.path("word").asText("").trim().toLowerCase();
                    if (!w.isEmpty() && !w.equals(cleanWord) && !w.contains(" ")) {
                        words.add(w);
                    }
                }
            }
            return words;
        } catch (Exception e) {
            log.debug("Datamuse {} failed for '{}': {}", relParam, cleanWord, e.getMessage());
            return Collections.emptyList();
        }
    }
}
