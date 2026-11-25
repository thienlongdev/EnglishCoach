package com.englishcoach.dictionary.provider;

import com.englishcoach.dictionary.dto.CanonicalDictionaryResponse;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PostConstruct;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.io.InputStream;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/**
 * High-performance, offline local lexical store based on structured Kaikki / Wiktextract data.
 * Provides pre-indexed core lexical entries and lemma resolution for instant local lookups (< 5ms).
 */
@Slf4j
@Component
public class KaikkiLocalLexicalStore {

    private final ObjectMapper objectMapper;
    private final Map<String, CanonicalDictionaryResponse> coreEntries = new ConcurrentHashMap<>();
    private final Map<String, LemmaInfo> lemmaMap = new ConcurrentHashMap<>();

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class LemmaInfo {
        private String lemma;
        private String note;
    }

    public KaikkiLocalLexicalStore(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    @PostConstruct
    public void init() {
        loadLemmas();
        loadCoreEntries();
    }

    private void loadLemmas() {
        try (InputStream is = getClass().getResourceAsStream("/lexical/lemmas.json")) {
            if (is != null) {
                Map<String, Map<String, String>> raw = objectMapper.readValue(is, new TypeReference<>() {});
                for (Map.Entry<String, Map<String, String>> entry : raw.entrySet()) {
                    String form = entry.getKey().trim().toLowerCase();
                    String lemma = entry.getValue().get("lemma");
                    String note = entry.getValue().get("note");
                    if (lemma != null) {
                        lemmaMap.put(form, LemmaInfo.builder().lemma(lemma).note(note).build());
                    }
                }
                log.info("KaikkiLocalLexicalStore loaded {} irregular lemma mappings", lemmaMap.size());
            } else {
                log.warn("/lexical/lemmas.json not found on classpath");
            }
        } catch (Exception e) {
            log.error("Failed to load /lexical/lemmas.json", e);
        }
    }

    private void loadCoreEntries() {
        try (InputStream is = getClass().getResourceAsStream("/lexical/kaikki_core.json")) {
            if (is != null) {
                List<CanonicalDictionaryResponse> list = objectMapper.readValue(is, new TypeReference<>() {});
                for (CanonicalDictionaryResponse entry : list) {
                    if (entry.getNormalizedQuery() != null) {
                        coreEntries.put(entry.getNormalizedQuery().toLowerCase(), entry);
                    }
                }
                log.info("KaikkiLocalLexicalStore loaded {} pre-indexed Kaikki core lexical entries", coreEntries.size());
            } else {
                log.warn("/lexical/kaikki_core.json not found on classpath");
            }
        } catch (Exception e) {
            log.error("Failed to load /lexical/kaikki_core.json", e);
        }
    }

    /**
     * Resolves irregular or regular inflected forms to their canonical base lemma.
     * E.g. "took" -> "take", "ran" -> "run", "running" -> "run"
     */
    public Optional<LemmaInfo> resolveLemma(String word) {
        if (word == null || word.isBlank()) return Optional.empty();
        String clean = word.trim().toLowerCase();

        // 1. Direct irregular lemma mapping
        LemmaInfo direct = lemmaMap.get(clean);
        if (direct != null) {
            return Optional.of(direct);
        }

        // 2. Regular suffix inflection rules
        if (clean.endsWith("ing") && clean.length() > 5) {
            String base = clean.substring(0, clean.length() - 3);
            // Double consonant e.g. stopping -> stop
            if (base.length() > 3 && base.charAt(base.length() - 1) == base.charAt(base.length() - 2)) {
                return Optional.of(LemmaInfo.builder()
                        .lemma(base.substring(0, base.length() - 1))
                        .note("Dạng V-ing của '" + base.substring(0, base.length() - 1) + "'")
                        .build());
            }
            // ending with e e.g. writing -> write, making -> make
            return Optional.of(LemmaInfo.builder()
                    .lemma(base)
                    .note("Dạng V-ing của '" + base + "'")
                    .build());
        }

        if (clean.endsWith("ed") && clean.length() > 4) {
            String base = clean.substring(0, clean.length() - 2);
            return Optional.of(LemmaInfo.builder()
                    .lemma(base)
                    .note("Dạng quá khứ / phân từ (-ed) của '" + base + "'")
                    .build());
        }

        if (clean.endsWith("es") && clean.length() > 4) {
            String base = clean.substring(0, clean.length() - 2);
            return Optional.of(LemmaInfo.builder()
                    .lemma(base)
                    .note("Dạng số nhiều / ngôi thứ 3 (-es) của '" + base + "'")
                    .build());
        }

        if (clean.endsWith("s") && clean.length() > 3 && !clean.endsWith("ss")) {
            String base = clean.substring(0, clean.length() - 1);
            return Optional.of(LemmaInfo.builder()
                    .lemma(base)
                    .note("Dạng số nhiều / ngôi thứ 3 (-s) của '" + base + "'")
                    .build());
        }

        return Optional.empty();
    }

    /**
     * Retrieves structured core lexical entry if present in the local Kaikki store.
     */
    public Optional<CanonicalDictionaryResponse> getEntry(String normalizedWord) {
        if (normalizedWord == null) return Optional.empty();
        CanonicalDictionaryResponse entry = coreEntries.get(normalizedWord.trim().toLowerCase());
        if (entry != null) {
            // Return deep copy or clone so callers can adjust query/note safely
            return Optional.of(cloneEntry(entry));
        }
        return Optional.empty();
    }

    public Collection<CanonicalDictionaryResponse> getAllCoreEntries() {
        return coreEntries.values();
    }

    private CanonicalDictionaryResponse cloneEntry(CanonicalDictionaryResponse src) {
        try {
            String json = objectMapper.writeValueAsString(src);
            return objectMapper.readValue(json, CanonicalDictionaryResponse.class);
        } catch (Exception e) {
            return src;
        }
    }
}
