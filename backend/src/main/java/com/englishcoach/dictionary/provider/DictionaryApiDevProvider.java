package com.englishcoach.dictionary.provider;

import com.englishcoach.dictionary.dto.CanonicalDictionaryResponse;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestTemplate;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/**
 * Open deterministic lexical provider using structured dictionaryapi.dev data.
 */
@Slf4j
@Component
public class DictionaryApiDevProvider implements LexicalProvider {

    private final RestTemplate restTemplate;
    private final ObjectMapper objectMapper;
    private final PhraseProvider phraseProvider;

    public DictionaryApiDevProvider(ObjectMapper objectMapper, PhraseProvider phraseProvider) {
        this.objectMapper = objectMapper;
        this.phraseProvider = phraseProvider;
        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(1500);
        factory.setReadTimeout(2500);
        this.restTemplate = new RestTemplate(factory);
    }

    @Override
    public String getName() {
        return "DictionaryApiDev";
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
            String encodedWord = URLEncoder.encode(cleanWord, StandardCharsets.UTF_8);
            String url = "https://api.dictionaryapi.dev/api/v2/entries/en/" + encodedWord;

            String responseBody = restTemplate.getForObject(url, String.class);
            if (responseBody == null || responseBody.isBlank()) {
                return Optional.empty();
            }

            JsonNode root = objectMapper.readTree(responseBody);
            if (!root.isArray() || root.isEmpty()) {
                return Optional.empty();
            }

            JsonNode firstEntry = root.get(0);
            String headword = firstEntry.path("word").asText(cleanWord);

            // Pronunciations
            List<CanonicalDictionaryResponse.PronunciationDto> pronunciations = new ArrayList<>();
            JsonNode phonetics = firstEntry.path("phonetics");
            String defaultIpa = firstEntry.path("phonetic").asText(null);

            if (phonetics.isArray()) {
                for (JsonNode p : phonetics) {
                    String ipa = p.path("text").asText(null);
                    String audio = p.path("audio").asText(null);
                    if (audio != null && audio.isBlank()) audio = null;

                    String region = "General";
                    if (audio != null) {
                        String lowerAudio = audio.toLowerCase();
                        if (lowerAudio.contains("-uk.") || lowerAudio.contains("uk/")) {
                            region = "UK";
                        } else if (lowerAudio.contains("-us.") || lowerAudio.contains("us/")) {
                            region = "US";
                        } else if (lowerAudio.contains("-au.") || lowerAudio.contains("au/")) {
                            region = "AU";
                        }
                    }

                    if (ipa != null || audio != null) {
                        pronunciations.add(CanonicalDictionaryResponse.PronunciationDto.builder()
                                .ipa(ipa)
                                .region(region)
                                .audioUrl(audio)
                                .build());
                    }
                }
            }

            if (pronunciations.isEmpty() && defaultIpa != null) {
                pronunciations.add(CanonicalDictionaryResponse.PronunciationDto.builder()
                        .ipa(defaultIpa)
                        .region("General")
                        .build());
            }

            // Meanings & Senses
            List<CanonicalDictionaryResponse.PartOfSpeechGroupDto> posGroups = new ArrayList<>();
            JsonNode meanings = firstEntry.path("meanings");
            if (meanings.isArray()) {
                int senseCounter = 1;
                for (JsonNode m : meanings) {
                    String pos = m.path("partOfSpeech").asText("general");
                    List<CanonicalDictionaryResponse.SenseDto> senses = new ArrayList<>();

                    JsonNode defs = m.path("definitions");
                    if (defs.isArray()) {
                        for (JsonNode d : defs) {
                            String defText = d.path("definition").asText("").trim();
                            if (defText.isEmpty()) continue;

                            String example = d.path("example").asText("").trim();
                            List<String> examples = new ArrayList<>();
                            if (!example.isEmpty()) {
                                examples.add(example);
                            }

                            List<String> synonyms = new ArrayList<>();
                            JsonNode syns = d.path("synonyms");
                            if (syns.isArray()) {
                                for (JsonNode s : syns) {
                                    String syn = s.asText("").trim();
                                    if (!syn.isEmpty()) synonyms.add(syn);
                                }
                            }

                            List<String> antonyms = new ArrayList<>();
                            JsonNode ants = d.path("antonyms");
                            if (ants.isArray()) {
                                for (JsonNode a : ants) {
                                    String ant = a.asText("").trim();
                                    if (!ant.isEmpty()) antonyms.add(ant);
                                }
                            }

                            senses.add(CanonicalDictionaryResponse.SenseDto.builder()
                                    .id(String.valueOf(senseCounter++))
                                    .definitionEn(defText)
                                    .examples(examples)
                                    .synonyms(synonyms)
                                    .antonyms(antonyms)
                                    .build());
                        }
                    }

                    // POS-level synonyms / antonyms
                    List<String> posSyns = new ArrayList<>();
                    JsonNode pSyns = m.path("synonyms");
                    if (pSyns.isArray()) {
                        for (JsonNode s : pSyns) {
                            String syn = s.asText("").trim();
                            if (!syn.isEmpty()) posSyns.add(syn);
                        }
                    }

                    if (!senses.isEmpty()) {
                        if (!posSyns.isEmpty() && !senses.isEmpty()) {
                            // Supplement first sense with pos-level synonyms if empty
                            if (senses.get(0).getSynonyms() == null || senses.get(0).getSynonyms().isEmpty()) {
                                senses.get(0).setSynonyms(posSyns);
                            }
                        }
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
                    .normalizedQuery(cleanWord)
                    .entryType(phraseProvider.detectEntryType(cleanWord))
                    .headword(headword)
                    .source("DictionaryAPI.dev")
                    .pronunciations(pronunciations)
                    .partsOfSpeech(posGroups)
                    .build());

        } catch (Exception e) {
            log.warn("DictionaryApiDev lookup failed for '{}': {}", query, e.getMessage());
            return Optional.empty();
        }
    }
}
