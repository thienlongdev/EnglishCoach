package com.englishcoach.dictionary.provider;

import com.englishcoach.dictionary.dto.CanonicalDictionaryResponse;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
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

/**
 * Oxford Dictionaries API provider adapter.
 * Only active when legitimate licensed Oxford credentials are configured.
 * Does NOT scrape Oxford web pages.
 */
@Slf4j
@Component
public class OxfordProvider implements LexicalProvider {

    @Value("${dictionary.oxford.enabled:false}")
    private boolean enabled;

    @Value("${dictionary.oxford.app-id:}")
    private String appId;

    @Value("${dictionary.oxford.app-key:}")
    private String appKey;

    @Value("${dictionary.oxford.base-url:https://od-api-sandbox.oxforddictionaries.com/api/v2}")
    private String baseUrl;

    private final RestTemplate restTemplate;
    private final ObjectMapper objectMapper;
    private final PhraseProvider phraseProvider;

    public OxfordProvider(ObjectMapper objectMapper, PhraseProvider phraseProvider) {
        this.objectMapper = objectMapper;
        this.phraseProvider = phraseProvider;
        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(1500);
        factory.setReadTimeout(2500);
        this.restTemplate = new RestTemplate(factory);
    }

    @Override
    public String getName() {
        return "Oxford";
    }

    @Override
    public boolean isAvailable() {
        return enabled && appId != null && !appId.isBlank() && appKey != null && !appKey.isBlank();
    }

    @Override
    public Optional<CanonicalDictionaryResponse> lookup(String query, String mode) {
        if (!isAvailable()) {
            return Optional.empty();
        }

        try {
            String encodedWord = URLEncoder.encode(query.trim().toLowerCase(), StandardCharsets.UTF_8);
            String url = baseUrl + "/entries/en-gb/" + encodedWord + "?fields=definitions,examples,pronunciations";

            HttpHeaders headers = new HttpHeaders();
            headers.set("app_id", appId.trim());
            headers.set("app_key", appKey.trim());
            HttpEntity<Void> entity = new HttpEntity<>(headers);

            ResponseEntity<String> response = restTemplate.exchange(url, HttpMethod.GET, entity, String.class);
            if (!response.getStatusCode().is2xxSuccessful() || response.getBody() == null) {
                return Optional.empty();
            }

            JsonNode root = objectMapper.readTree(response.getBody());
            JsonNode results = root.path("results");
            if (!results.isArray() || results.isEmpty()) {
                return Optional.empty();
            }

            JsonNode firstResult = results.get(0);
            String headword = firstResult.path("word").asText(query);
            List<CanonicalDictionaryResponse.PronunciationDto> pronunciations = new ArrayList<>();
            List<CanonicalDictionaryResponse.PartOfSpeechGroupDto> posGroups = new ArrayList<>();

            JsonNode lexicalEntries = firstResult.path("lexicalEntries");
            if (lexicalEntries.isArray()) {
                for (JsonNode lexEntry : lexicalEntries) {
                    String pos = lexEntry.path("lexicalCategory").path("text").asText("general");
                    List<CanonicalDictionaryResponse.SenseDto> senses = new ArrayList<>();

                    JsonNode entries = lexEntry.path("entries");
                    if (entries.isArray()) {
                        for (JsonNode entry : entries) {
                            // Pronunciations
                            JsonNode prons = entry.path("pronunciations");
                            if (prons.isArray()) {
                                for (JsonNode p : prons) {
                                    String ipa = p.path("phoneticSpelling").asText(null);
                                    String audio = p.path("audioFile").asText(null);
                                    String region = "UK";
                                    if (p.has("dialects") && p.path("dialects").isArray() && !p.path("dialects").isEmpty()) {
                                        region = p.path("dialects").get(0).asText("UK");
                                    }
                                    if (ipa != null || audio != null) {
                                        pronunciations.add(CanonicalDictionaryResponse.PronunciationDto.builder()
                                                .ipa(ipa != null ? "/" + ipa + "/" : null)
                                                .region(region)
                                                .audioUrl(audio)
                                                .build());
                                    }
                                }
                            }

                            // Senses
                            JsonNode rawSenses = entry.path("senses");
                            if (rawSenses.isArray()) {
                                for (JsonNode s : rawSenses) {
                                    String id = s.path("id").asText(String.valueOf(senses.size() + 1));
                                    String def = null;
                                    JsonNode defsNode = s.path("definitions");
                                    if (defsNode.isArray() && !defsNode.isEmpty()) {
                                        def = defsNode.get(0).asText();
                                    }

                                    List<String> examples = new ArrayList<>();
                                    JsonNode exNode = s.path("examples");
                                    if (exNode.isArray()) {
                                        for (JsonNode ex : exNode) {
                                            String text = ex.path("text").asText(null);
                                            if (text != null && !text.isBlank()) examples.add(text);
                                        }
                                    }

                                    if (def != null && !def.isBlank()) {
                                        senses.add(CanonicalDictionaryResponse.SenseDto.builder()
                                                .id(id)
                                                .definitionEn(def)
                                                .examples(examples)
                                                .build());
                                    }
                                }
                            }
                        }
                    }

                    if (!senses.isEmpty()) {
                        posGroups.add(CanonicalDictionaryResponse.PartOfSpeechGroupDto.builder()
                                .partOfSpeech(pos)
                                .senses(senses)
                                .build());
                    }
                }
            }

            if (posGroups.isEmpty()) {
                return Optional.empty();
            }

            return Optional.of(CanonicalDictionaryResponse.builder()
                    .query(query)
                    .normalizedQuery(query.trim().toLowerCase())
                    .entryType(phraseProvider.detectEntryType(query))
                    .headword(headword)
                    .source("Oxford Dictionaries API (Licensed)")
                    .pronunciations(pronunciations)
                    .partsOfSpeech(posGroups)
                    .build());

        } catch (Exception e) {
            log.warn("Oxford lookup failed for query '{}': {}", query, e.getMessage());
            return Optional.empty();
        }
    }
}
