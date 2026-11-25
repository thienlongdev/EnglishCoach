package com.englishcoach.dictionary.provider;

import com.englishcoach.dictionary.dto.CanonicalDictionaryResponse;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestTemplate;

import org.springframework.web.util.UriComponentsBuilder;

import java.net.URI;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.*;

/**
 * English-to-Vietnamese machine translation (Google GTX): a word's general meaning and whole sentences.
 * It never supplies sense-level meanings: its term lists are not aligned with any provider's English senses.
 */
@Slf4j
@Component
public class GoogleGtxTranslationProvider {

    private static final List<String> CLIENT_CANDIDATES = List.of("dict-chrome-ex", "gtx");

    private final RestTemplate restTemplate;
    /** Word lookups sit on a learner's click: shorter timeouts than sentence translation. */
    private final RestTemplate wordRestTemplate;
    private final ObjectMapper objectMapper;

    public GoogleGtxTranslationProvider(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(5000);
        factory.setReadTimeout(8000);
        RestTemplate rt = new RestTemplate(factory);
        rt.getInterceptors().add((request, body, execution) -> {
            request.getHeaders().set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");
            request.getHeaders().set("Accept", "*/*");
            request.getHeaders().set("Accept-Language", "vi,en-US;q=0.9,en;q=0.8");
            return execution.execute(request, body);
        });
        this.restTemplate = rt;

        SimpleClientHttpRequestFactory wordFactory = new SimpleClientHttpRequestFactory();
        wordFactory.setConnectTimeout(1500);
        wordFactory.setReadTimeout(2500);
        RestTemplate wordRt = new RestTemplate(wordFactory);
        wordRt.getInterceptors().addAll(rt.getInterceptors());
        this.wordRestTemplate = wordRt;
    }

    public static boolean isMultiWordUnit(CanonicalDictionaryResponse entry) {
        if (entry == null) return false;
        String type = entry.getEntryType();
        if (type != null) {
            String norm = type.toUpperCase().trim();
            if (norm.contains("IDIOM") || norm.contains("PHRASAL") || norm.contains("EXPRESSION") || norm.contains("COLLOCATION") || norm.contains("FIXED")) {
                return true;
            }
        }
        String q = entry.getNormalizedQuery() != null ? entry.getNormalizedQuery() : entry.getHeadword();
        if (q != null && (q.trim().contains(" ") || q.trim().contains("-"))) {
            return true;
        }
        if (entry.getPartsOfSpeech() != null) {
            for (CanonicalDictionaryResponse.PartOfSpeechGroupDto pos : entry.getPartsOfSpeech()) {
                if (pos.getPartOfSpeech() != null) {
                    String p = pos.getPartOfSpeech().toLowerCase().trim();
                    if (p.contains("idiom") || p.contains("phrasal") || p.contains("expression") || p.contains("phrase")) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    public void enrichWithVietnamese(CanonicalDictionaryResponse entry) {
        if (entry == null) return;
        String query = entry.getNormalizedQuery();
        if (query == null || query.isBlank()) query = entry.getQuery();
        if (query == null || query.isBlank()) return;

        // Multi-word lexical unit safety (IDIOM, PHRASAL_VERB, EXPRESSION):
        // NEVER assume a generic/literal phrase translation is a valid sense translation.
        // Source-backed sense translations are preserved. If no trustworthy Vietnamese meaning exists, omit it.
        if (isMultiWordUnit(entry)) {
            return;
        }

        for (String client : CLIENT_CANDIDATES) {
            try {
                URI uri = UriComponentsBuilder.fromHttpUrl("https://translate.googleapis.com/translate_a/single")
                        .queryParam("client", client)
                        .queryParam("sl", "en")
                        .queryParam("tl", "vi")
                        .queryParam("dt", "t")
                        .queryParam("dt", "bd")
                        .queryParam("dt", "rm")
                        .queryParam("q", query)
                        .build()
                        .toUri();

                String res = restTemplate.getForObject(uri, String.class);
                if (res == null || res.isBlank()) continue;

                JsonNode root = objectMapper.readTree(res);
                if (!root.isArray() || root.isEmpty()) continue;

                // 1. Extract General Translation (dt=t)
                String generalTranslation = null;
                JsonNode sentences = root.get(0);
                if (sentences.isArray() && !sentences.isEmpty() && sentences.get(0).isArray() && !sentences.get(0).isEmpty()) {
                    generalTranslation = sentences.get(0).get(0).asText("").trim();
                    if (!generalTranslation.isEmpty()) {
                        if (entry.getGeneralTranslationVi() == null || entry.getGeneralTranslationVi().isBlank()) {
                            entry.setGeneralTranslationVi(generalTranslation);
                        }
                    }
                }

                // 2. Extract IPA from romanization / transcription if missing
                if (entry.getPronunciations() == null || entry.getPronunciations().isEmpty()) {
                    String ipaCandidate = null;
                    if (sentences.isArray() && sentences.size() > 1 && sentences.get(1).isArray() && sentences.get(1).size() > 3) {
                        ipaCandidate = sentences.get(1).get(3).asText(null);
                    } else if (sentences.isArray() && !sentences.isEmpty() && sentences.get(0).isArray() && sentences.get(0).size() > 3) {
                        ipaCandidate = sentences.get(0).get(3).asText(null);
                    }
                    if (ipaCandidate != null && !ipaCandidate.isBlank()) {
                        List<CanonicalDictionaryResponse.PronunciationDto> prons = new ArrayList<>();
                        prons.add(CanonicalDictionaryResponse.PronunciationDto.builder()
                                .ipa("/" + ipaCandidate.trim() + "/")
                                .region("General")
                                .build());
                        entry.setPronunciations(prons);
                    }
                }

                // 3. No sense-level text from GTX (owner brief 2026-10-24). Its bilingual terms (dt=bd) are not aligned
                // with the English senses of any other provider: assigning term i to sense i paired "the state of feeling
                // happiness and enthusiasm" with "khó chịu". Vietnamese senses come from the local dictionary instead.

                // If general translation or senses were enriched, finish
                if ((entry.getGeneralTranslationVi() != null && !entry.getGeneralTranslationVi().isBlank())
                        || (entry.getPartsOfSpeech() != null && !entry.getPartsOfSpeech().isEmpty())) {
                    break;
                }
            } catch (Exception e) {
                log.warn("EN-VI enrichment failed with client '{}' for '{}': {}", client, query, e.getMessage());
            }
        }
    }

    /**
     * The general Vietnamese meaning of one English word (dt=t only: the translation of the word itself, never a
     * sense). Short timeouts: a dictionary lookup waits for it at most its enrichment deadline. Null on any failure.
     */
    public String translateWordGeneral(String word) {
        if (word == null || word.isBlank()) return null;
        String clean = word.trim();
        for (String client : CLIENT_CANDIDATES) {
            try {
                URI uri = UriComponentsBuilder.fromHttpUrl("https://translate.googleapis.com/translate_a/single")
                        .queryParam("client", client)
                        .queryParam("sl", "en")
                        .queryParam("tl", "vi")
                        .queryParam("dt", "t")
                        .queryParam("q", clean)
                        .build()
                        .toUri();
                String res = wordRestTemplate.getForObject(uri, String.class);
                if (res == null || res.isBlank()) continue;
                JsonNode root = objectMapper.readTree(res);
                JsonNode sentences = root.isArray() && !root.isEmpty() ? root.get(0) : null;
                if (sentences != null && sentences.isArray() && !sentences.isEmpty()
                        && sentences.get(0).isArray() && !sentences.get(0).isEmpty()) {
                    String general = sentences.get(0).get(0).asText("").trim();
                    // an untranslated echo of the word is not a meaning
                    if (!general.isEmpty() && !general.equalsIgnoreCase(clean)) return general;
                    if (!general.isEmpty()) return null;
                }
            } catch (Exception e) {
                log.debug("General word translation failed with client '{}' for '{}': {}", client, clean, e.getMessage());
            }
        }
        return null;
    }

    /**
     * Translates a complete English sentence into natural Vietnamese.
     * Uses whitelisted client candidates with proper URI encoding to avoid rate-limiting/429
     * and prevent character encoding corruption on contractions, apostrophes, and punctuation.
     * Returns null on failure to allow caller retry/fallback instead of caching bad values.
     */
    public String translateSentenceToVietnamese(String text) {
        if (text == null || text.isBlank()) {
            return null;
        }
        String cleanText = text.trim();
        for (String client : CLIENT_CANDIDATES) {
            try {
                URI uri = UriComponentsBuilder.fromHttpUrl("https://translate.googleapis.com/translate_a/single")
                        .queryParam("client", client)
                        .queryParam("sl", "auto")
                        .queryParam("tl", "vi")
                        .queryParam("dt", "t")
                        .queryParam("q", cleanText)
                        .build()
                        .toUri();

                String res = restTemplate.getForObject(uri, String.class);
                if (res == null || res.isBlank()) {
                    continue;
                }
                JsonNode root = objectMapper.readTree(res);
                if (!root.isArray() || root.isEmpty()) {
                    continue;
                }
                JsonNode sentences = root.get(0);
                if (sentences != null && sentences.isArray()) {
                    StringBuilder sb = new StringBuilder();
                    for (JsonNode s : sentences) {
                        if (s.isArray() && !s.isEmpty()) {
                            sb.append(s.get(0).asText(""));
                        }
                    }
                    String trans = sb.toString().trim();
                    if (!trans.isEmpty()) {
                        return trans;
                    }
                }
            } catch (Exception e) {
                log.warn("Translation attempt with client '{}' failed for text '{}': {}", client, cleanText, e.getMessage());
            }
        }
        return null;
    }
}
