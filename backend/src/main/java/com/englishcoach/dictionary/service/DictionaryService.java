package com.englishcoach.dictionary.service;

import com.englishcoach.dictionary.dto.CanonicalDictionaryResponse;
import com.englishcoach.dictionary.dto.DictionaryResponse;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;

/**
 * Legacy adapter service delegating to the deterministic DictionaryEngine.
 * Normal lookup NEVER invokes an LLM.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class DictionaryService {

    private final DictionaryEngine dictionaryEngine;

    public DictionaryResponse lookupWord(String word) {
        CanonicalDictionaryResponse canonical = dictionaryEngine.lookup(word, "en-en");
        if (canonical == null) {
            return null;
        }

        List<String> meanings = new ArrayList<>();
        List<String> examples = new ArrayList<>();
        List<String> synonyms = new ArrayList<>();
        List<String> collocations = new ArrayList<>();

        if (canonical.getPartsOfSpeech() != null) {
            for (CanonicalDictionaryResponse.PartOfSpeechGroupDto posGroup : canonical.getPartsOfSpeech()) {
                if (posGroup.getSenses() != null) {
                    for (CanonicalDictionaryResponse.SenseDto sense : posGroup.getSenses()) {
                        if (sense.getDefinitionEn() != null) meanings.add(sense.getDefinitionEn());
                        if (sense.getExamples() != null) examples.addAll(sense.getExamples());
                        if (sense.getSynonyms() != null) synonyms.addAll(sense.getSynonyms());
                    }
                }
            }
        }

        if (canonical.getCollocations() != null) {
            for (CanonicalDictionaryResponse.CollocationDto c : canonical.getCollocations()) {
                collocations.add(c.getPhrase());
            }
        }

        String ipa = null;
        if (canonical.getPronunciations() != null && !canonical.getPronunciations().isEmpty()) {
            ipa = canonical.getPronunciations().get(0).getIpa();
        }

        return DictionaryResponse.builder()
                .word(canonical.getHeadword() != null ? canonical.getHeadword() : word)
                .ipa(ipa)
                .cefr(canonical.getCefr() != null ? canonical.getCefr() : "B2")
                .meanings(meanings)
                .examples(examples)
                .synonyms(synonyms)
                .collocations(collocations)
                .build();
    }
}
