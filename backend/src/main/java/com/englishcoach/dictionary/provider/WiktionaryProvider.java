package com.englishcoach.dictionary.provider;

import com.englishcoach.dictionary.dto.CanonicalDictionaryResponse;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestTemplate;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.regex.Pattern;

/**
 * Open lexical provider extracting structured senses from Wiktionary REST API.
 * Cleans wiki HTML tags into clean, human-readable definitions and real examples.
 */
@Slf4j
@Component
public class WiktionaryProvider implements LexicalProvider {

    private static final Pattern STYLE_TAG_PATTERN = Pattern.compile("<style[^>]*>.*?</style>", Pattern.CASE_INSENSITIVE | Pattern.DOTALL);
    private static final Pattern SCRIPT_TAG_PATTERN = Pattern.compile("<script[^>]*>.*?</script>", Pattern.CASE_INSENSITIVE | Pattern.DOTALL);
    private static final Pattern MW_PARSER_PATTERN = Pattern.compile("\\.?mw-parser-output[^{]*\\{[^}]*\\}", Pattern.CASE_INSENSITIVE);
    private static final Pattern CSS_SELECTOR_PATTERN = Pattern.compile("\\.[a-zA-Z0-9_-]+\\s*\\{[^}]*\\}");
    private static final Pattern HTML_TAG_PATTERN = Pattern.compile("<[^>]+>");
    private static final Pattern MULTI_SPACE_PATTERN = Pattern.compile("\\s+");

    private final RestTemplate restTemplate;
    private final ObjectMapper objectMapper;
    private final PhraseProvider phraseProvider;

    public WiktionaryProvider(ObjectMapper objectMapper, PhraseProvider phraseProvider) {
        this.objectMapper = objectMapper;
        this.phraseProvider = phraseProvider;
        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(1500);
        factory.setReadTimeout(2500);
        this.restTemplate = new RestTemplate(factory);
    }

    @Override
    public String getName() {
        return "Wiktionary";
    }

    @Override
    public boolean isAvailable() {
        return true;
    }

    @Override
    public Optional<CanonicalDictionaryResponse> lookup(String query, String mode) {
        String cleanWord = query.trim().toLowerCase();
        if (cleanWord.isEmpty()) return Optional.empty();

        try {
            String encodedWord = URLEncoder.encode(cleanWord.replace(" ", "_"), StandardCharsets.UTF_8);
            String url = "https://en.wiktionary.org/api/rest_v1/page/definition/" + encodedWord;

            HttpHeaders headers = new HttpHeaders();
            headers.set("User-Agent", "EnglishCoachApp/2.0 (contact: admin@englishcoach.io.vn)");
            HttpEntity<Void> entity = new HttpEntity<>(headers);

            ResponseEntity<String> response = restTemplate.exchange(url, HttpMethod.GET, entity, String.class);
            if (!response.getStatusCode().is2xxSuccessful() || response.getBody() == null) {
                return Optional.empty();
            }

            JsonNode root = objectMapper.readTree(response.getBody());
            JsonNode enArray = root.path("en");
            if (!enArray.isArray() || enArray.isEmpty()) {
                return Optional.empty();
            }

            List<CanonicalDictionaryResponse.PartOfSpeechGroupDto> posGroups = new ArrayList<>();
            int senseCounter = 1;

            for (JsonNode posNode : enArray) {
                String pos = posNode.path("partOfSpeech").asText("general").toLowerCase();
                List<CanonicalDictionaryResponse.SenseDto> senses = new ArrayList<>();

                JsonNode defsNode = posNode.path("definitions");
                if (defsNode.isArray()) {
                    for (JsonNode defNode : defsNode) {
                        String rawDef = defNode.path("definition").asText("").trim();
                        String cleanDef = stripHtml(rawDef);
                        if (cleanDef.isEmpty() || cleanDef.length() < 3) continue;

                        List<String> examples = new ArrayList<>();
                        JsonNode exArray = defNode.path("examples");
                        if (exArray.isArray()) {
                            for (JsonNode ex : exArray) {
                                String cleanEx = stripHtml(ex.asText(""));
                                if (!cleanEx.isEmpty() && cleanEx.length() > 5) {
                                    examples.add(cleanEx);
                                }
                            }
                        }

                        senses.add(CanonicalDictionaryResponse.SenseDto.builder()
                                .id(String.valueOf(senseCounter++))
                                .definitionEn(cleanDef)
                                .examples(examples)
                                .build());
                    }
                }

                if (!senses.isEmpty()) {
                    posGroups.add(CanonicalDictionaryResponse.PartOfSpeechGroupDto.builder()
                            .partOfSpeech(pos)
                            .senses(senses)
                            .build());
                }
            }

            if (posGroups.isEmpty()) {
                return Optional.empty();
            }

            return Optional.of(CanonicalDictionaryResponse.builder()
                    .query(query)
                    .normalizedQuery(cleanWord)
                    .entryType(phraseProvider.detectEntryType(cleanWord))
                    .headword(query.trim())
                    .source("Wiktionary Structured Lexical Data")
                    .pronunciations(new ArrayList<>())
                    .partsOfSpeech(posGroups)
                    .build());

        } catch (Exception e) {
            log.warn("Wiktionary lookup failed for '{}': {}", query, e.getMessage());
            return Optional.empty();
        }
    }

    public static String stripHtml(String html) {
        if (html == null || html.isBlank()) return "";
        // Strip <style>...</style> and <script>...</script> blocks completely before tag stripping
        String s = STYLE_TAG_PATTERN.matcher(html).replaceAll(" ");
        s = SCRIPT_TAG_PATTERN.matcher(s).replaceAll(" ");
        // Strip HTML tags
        s = HTML_TAG_PATTERN.matcher(s).replaceAll(" ");
        // Strip residual .mw-parser-output CSS declaration blocks and class rules
        s = MW_PARSER_PATTERN.matcher(s).replaceAll(" ");
        s = CSS_SELECTOR_PATTERN.matcher(s).replaceAll(" ");
        if (s.contains("mw-parser-output")) {
            s = s.replaceAll("\\.?mw-parser-output[\\w-]*", " ");
        }
        return MULTI_SPACE_PATTERN.matcher(s).replaceAll(" ").trim();
    }
}
