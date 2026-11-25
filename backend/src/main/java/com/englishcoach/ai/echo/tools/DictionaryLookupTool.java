package com.englishcoach.ai.echo.tools;

import com.englishcoach.ai.echo.EchoTool;
import com.englishcoach.ai.echo.EchoToolRegistry;
import com.englishcoach.ai.echo.EchoTurn;
import com.englishcoach.dictionary.dto.CanonicalDictionaryResponse;
import com.englishcoach.dictionary.dto.CanonicalDictionaryResponse.*;
import com.englishcoach.dictionary.service.DictionaryEngine;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Grounded read-only Dictionary Lookup tool ({@code lookup_dictionary}) backed by {@link DictionaryEngine#lookup(String, String)}
 * ({@code 0} LLM calls). Returns authoritative headword, CEFR, IPA pronunciations, top 3 English senses, Vietnamese senses,
 * collocations, and idioms.
 */
@Component
public class DictionaryLookupTool implements EchoTool {

    private final ObjectProvider<DictionaryEngine> dictionary;
    private final ObjectMapper mapper;

    public DictionaryLookupTool(ObjectProvider<DictionaryEngine> dictionary, ObjectMapper mapper) {
        this.dictionary = dictionary;
        this.mapper = mapper;
    }

    @Override
    public String name() {
        return "lookup_dictionary";
    }

    @Override
    public String description() {
        return "Look up an English word, phrasal verb, or idiom in English Coach's authoritative Dictionary Engine "
                + "(returns headword, CEFR, IPA pronunciations, English definitions, Vietnamese meanings, collocations, and idioms).";
    }

    @Override
    public Map<String, Object> parameters() {
        Map<String, Object> props = new LinkedHashMap<>();
        props.put("word", EchoToolRegistry.str("English word, phrasal verb, or idiom to look up", 60));
        return EchoToolRegistry.schema(props, List.of("word"));
    }

    @Override
    public Kind kind() {
        return Kind.READ;
    }

    @Override
    public boolean readOnlyTransaction() {
        // DictionaryEngine coordinates L1/L2 caches and short internal transactions
        return false;
    }

    @Override
    public boolean parallelizableRead() {
        return true;
    }

    @Override
    public String status(boolean vi) {
        return vi ? "Echo đang tra cứu từ điển…" : "Echo is looking up the dictionary…";
    }

    @Override
    public String run(EchoTurn turn, JsonNode args) throws Exception {
        DictionaryEngine engine = dictionary.getIfAvailable();
        if (engine == null) return "{\"error\":\"unavailable\"}";

        String word = args.get("word").asText().trim();
        CanonicalDictionaryResponse entry;
        try {
            entry = engine.lookup(word, "en-en");
        } catch (IllegalArgumentException badQuery) {
            return mapper.writeValueAsString(Map.of("found", false, "word", word));
        }

        if (entry == null) {
            return mapper.writeValueAsString(Map.of(
                    "found", false,
                    "word", word,
                    "note", "Not found in local/authoritative dictionary store; explain carefully without inventing dictionary citations."));
        }

        ObjectNode out = mapper.createObjectNode();
        out.put("found", true);
        out.put("headword", entry.getHeadword() != null ? entry.getHeadword() : word);
        if (entry.getEntryType() != null) out.put("entryType", entry.getEntryType());
        if (entry.getCefr() != null) out.put("cefr", entry.getCefr());
        if (entry.getGeneralTranslationVi() != null && !entry.getGeneralTranslationVi().isBlank()) {
            out.put("generalTranslationVi", clip(entry.getGeneralTranslationVi(), 140));
        }
        if (entry.getInflectionNote() != null && !entry.getInflectionNote().isBlank()) {
            out.put("inflectionNote", clip(entry.getInflectionNote(), 100));
        }

        if (entry.getPronunciations() != null && !entry.getPronunciations().isEmpty()) {
            ArrayNode prons = out.putArray("pronunciations");
            int count = 0;
            for (PronunciationDto p : entry.getPronunciations()) {
                if (p == null || p.getIpa() == null || p.getIpa().isBlank()) continue;
                ObjectNode pn = prons.addObject().put("ipa", p.getIpa());
                if (p.getRegion() != null && !p.getRegion().isBlank()) pn.put("region", p.getRegion());
                if (++count >= 3) break;
            }
        }

        if (entry.getPartsOfSpeech() != null && !entry.getPartsOfSpeech().isEmpty()) {
            ArrayNode sensesArr = out.putArray("senses");
            int senseCount = 0;
            outer:
            for (PartOfSpeechGroupDto posGroup : entry.getPartsOfSpeech()) {
                if (posGroup == null || posGroup.getSenses() == null) continue;
                String pos = posGroup.getPartOfSpeech() == null ? "" : posGroup.getPartOfSpeech();
                for (SenseDto s : posGroup.getSenses()) {
                    if (s == null || (s.getDefinitionEn() == null && s.getTranslationVi() == null)) continue;
                    ObjectNode sn = sensesArr.addObject();
                    if (!pos.isEmpty()) sn.put("partOfSpeech", pos);
                    if (s.getDefinitionEn() != null) sn.put("definitionEn", clip(s.getDefinitionEn(), 220));
                    if (s.getTranslationVi() != null) sn.put("translationVi", clip(s.getTranslationVi(), 140));
                    if (s.getExamples() != null && !s.getExamples().isEmpty() && s.getExamples().get(0) != null) {
                        sn.put("example", clip(s.getExamples().get(0), 160));
                    }
                    if (++senseCount >= 3) break outer;
                }
            }
        }

        if (entry.getVietnameseSenses() != null && !entry.getVietnameseSenses().isEmpty()) {
            ArrayNode viArr = out.putArray("vietnameseSenses");
            int viGroups = 0;
            for (VietnameseSenseGroupDto vg : entry.getVietnameseSenses()) {
                if (vg == null || vg.getMeanings() == null || vg.getMeanings().isEmpty()) continue;
                ObjectNode vn = viArr.addObject();
                if (vg.getPartOfSpeech() != null) vn.put("partOfSpeech", vg.getPartOfSpeech());
                ArrayNode mArr = vn.putArray("meanings");
                vg.getMeanings().stream().filter(m -> m != null && !m.isBlank()).limit(4)
                        .forEach(m -> mArr.add(clip(m, 100)));
                if (++viGroups >= 3) break;
            }
        }

        if (entry.getCollocations() != null && !entry.getCollocations().isEmpty()) {
            ArrayNode collArr = out.putArray("collocations");
            entry.getCollocations().stream()
                    .filter(c -> c != null && c.getPhrase() != null && !c.getPhrase().isBlank())
                    .limit(3)
                    .forEach(c -> {
                        ObjectNode cn = collArr.addObject().put("phrase", clip(c.getPhrase(), 80));
                        if (c.getTranslationVi() != null) cn.put("translationVi", clip(c.getTranslationVi(), 100));
                        if (c.getExample() != null) cn.put("example", clip(c.getExample(), 140));
                    });
        }

        ArrayNode idiomsArr = mapper.createArrayNode();
        if (entry.getIdioms() != null) {
            for (IdiomDto id : entry.getIdioms()) {
                if (id == null || id.getPhrase() == null || idiomsArr.size() >= 3) continue;
                ObjectNode in = idiomsArr.addObject().put("phrase", clip(id.getPhrase(), 80));
                if (id.getShortMeaning() != null) in.put("meaningEn", clip(id.getShortMeaning(), 140));
                if (id.getTranslationVi() != null) in.put("translationVi", clip(id.getTranslationVi(), 120));
            }
        }
        if (entry.getExpressions() != null && idiomsArr.size() < 3) {
            for (IdiomDto ex : entry.getExpressions()) {
                if (ex == null || ex.getPhrase() == null || idiomsArr.size() >= 3) continue;
                ObjectNode in = idiomsArr.addObject().put("phrase", clip(ex.getPhrase(), 80));
                if (ex.getShortMeaning() != null) in.put("meaningEn", clip(ex.getShortMeaning(), 140));
                if (ex.getTranslationVi() != null) in.put("translationVi", clip(ex.getTranslationVi(), 120));
            }
        }
        if (!idiomsArr.isEmpty()) {
            out.set("idioms", idiomsArr);
        }

        return out.toString();
    }

    private static String clip(String s, int max) {
        return s == null ? "" : s.length() <= max ? s : s.substring(0, max - 1) + "…";
    }
}
