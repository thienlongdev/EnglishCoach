package com.englishcoach.dictionary;

import com.englishcoach.dictionary.dto.CanonicalDictionaryResponse;
import com.englishcoach.dictionary.dto.CollocationsResponse;
import com.englishcoach.dictionary.dto.PhrasesResponse;
import com.englishcoach.dictionary.provider.*;
import com.englishcoach.dictionary.repository.DictionaryRepository;
import com.englishcoach.dictionary.service.DictionaryEngine;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;

import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;

class DictionaryEngineTest {

    private DictionaryRepository dictionaryRepository;
    private OxfordProvider oxfordProvider;
    private CambridgeProvider cambridgeProvider;
    private WiktionaryProvider wiktionaryProvider;
    private DictionaryApiDevProvider dictionaryApiDevProvider;
    private DatamuseProvider datamuseProvider;
    private GoogleGtxTranslationProvider googleGtxTranslationProvider;
    private LocalEnViLexicalProvider localEnViLexicalProvider;
    private PhraseProvider phraseProvider;
    private ObjectMapper objectMapper;

    private DictionaryEngine dictionaryEngine;

    @BeforeEach
    void setUp() {
        dictionaryRepository = Mockito.mock(DictionaryRepository.class);
        oxfordProvider = Mockito.mock(OxfordProvider.class);
        cambridgeProvider = Mockito.mock(CambridgeProvider.class);
        wiktionaryProvider = Mockito.mock(WiktionaryProvider.class);
        dictionaryApiDevProvider = Mockito.mock(DictionaryApiDevProvider.class);
        datamuseProvider = Mockito.mock(DatamuseProvider.class);
        googleGtxTranslationProvider = Mockito.mock(GoogleGtxTranslationProvider.class);
        localEnViLexicalProvider = new LocalEnViLexicalProvider();
        localEnViLexicalProvider.init();
        phraseProvider = new PhraseProvider();
        objectMapper = new ObjectMapper();
        KaikkiLocalLexicalStore kaikkiLocalLexicalStore = new KaikkiLocalLexicalStore(objectMapper);
        kaikkiLocalLexicalStore.init();

        when(dictionaryRepository.findByWordIgnoreCase(anyString())).thenReturn(Optional.empty());
        when(oxfordProvider.isAvailable()).thenReturn(false);
        when(cambridgeProvider.isAvailable()).thenReturn(false);

        dictionaryEngine = new DictionaryEngine(
                dictionaryRepository,
                oxfordProvider,
                cambridgeProvider,
                wiktionaryProvider,
                dictionaryApiDevProvider,
                datamuseProvider,
                googleGtxTranslationProvider,
                localEnViLexicalProvider,
                phraseProvider,
                kaikkiLocalLexicalStore,
                objectMapper
        );
    }

    @Test
    void testLocalKaikkiLookup_bank() {
        CanonicalDictionaryResponse result = dictionaryEngine.lookup("bank", "en-en");

        assertNotNull(result);
        assertEquals("bank", result.getHeadword());
        assertTrue(result.getSource().contains("Kaikki"));
        assertFalse(result.getPartsOfSpeech().isEmpty());
        assertTrue(result.getPartsOfSpeech().get(0).getSenses().size() >= 3,
                "Local Kaikki entry for 'bank' must contain multiple distinct senses");
    }

    @Test
    void testLemmaResolution_took() {
        CanonicalDictionaryResponse result = dictionaryEngine.lookup("took", "en-en");

        assertNotNull(result);
        assertEquals("take", result.getHeadword(), "Headword for 'took' should be resolved to base lemma 'take'");
        assertEquals("took", result.getSearchedForm());
        assertNotNull(result.getInflectionNote());
        assertTrue(result.getInflectionNote().contains("take"));
    }

    @Test
    void testDirectPhraseLookup_takeOff() {
        CanonicalDictionaryResponse result = dictionaryEngine.lookup("take off", "en-en");

        assertNotNull(result);
        assertEquals("take off", result.getHeadword());
        assertEquals("PHRASAL_VERB", result.getEntryType());
        assertFalse(result.getPartsOfSpeech().isEmpty());
        assertTrue(result.getPartsOfSpeech().get(0).getSenses().size() >= 3,
                "Phrasal verb 'take off' must have multiple distinct senses");
    }

    @Test
    void testDirectPhraseLookup_underTheWeather() {
        CanonicalDictionaryResponse result = dictionaryEngine.lookup("under the weather", "en-vi");

        assertNotNull(result);
        assertEquals("under the weather", result.getHeadword());
        assertEquals("IDIOM", result.getEntryType());
        assertFalse(result.getPartsOfSpeech().isEmpty());
        assertEquals("idiom", result.getPartsOfSpeech().get(0).getPartOfSpeech());
        assertNotNull(result.getPartsOfSpeech().get(0).getSenses().get(0).getExamples());
    }

    @Test
    void testPhrasesForTake() {
        PhrasesResponse phrases = dictionaryEngine.getPhrases("take");

        assertNotNull(phrases);
        assertNotNull(phrases.getPhrasalVerbs());
        assertFalse(phrases.getPhrasalVerbs().isEmpty());
        assertTrue(phrases.getPhrasalVerbs().stream().anyMatch(p -> p.getPhrase().equals("take off")));
        assertTrue(phrases.getPhrasalVerbs().stream().anyMatch(p -> p.getPhrase().equals("take over")));

        assertNotNull(phrases.getIdioms());
        assertFalse(phrases.getIdioms().isEmpty());
        assertTrue(phrases.getIdioms().stream().anyMatch(i -> i.getPhrase().equals("take it easy")));
    }

    @Test
    void testCollocationsGrouped() {
        when(datamuseProvider.getCollocationsGrouped("decision")).thenReturn(
                CollocationsResponse.builder()
                        .word("decision")
                        .groups(List.of(
                                CollocationsResponse.CollocationPatternGroup.builder()
                                        .pattern("Verb + Noun")
                                        .items(List.of(
                                                CanonicalDictionaryResponse.CollocationDto.builder()
                                                        .phrase("make a decision")
                                                        .pattern("verb + noun")
                                                        .build(),
                                                CanonicalDictionaryResponse.CollocationDto.builder()
                                                        .phrase("reach a decision")
                                                        .pattern("verb + noun")
                                                        .build()
                                        ))
                                        .build(),
                                CollocationsResponse.CollocationPatternGroup.builder()
                                        .pattern("Adjective + Noun")
                                        .items(List.of(
                                                CanonicalDictionaryResponse.CollocationDto.builder()
                                                        .phrase("important decision")
                                                        .pattern("adjective + noun")
                                                        .build()
                                        ))
                                        .build()
                        ))
                        .build()
        );

        CollocationsResponse res = dictionaryEngine.getCollocations("decision");
        assertNotNull(res);
        assertEquals("decision", res.getWord());
        assertEquals(2, res.getGroups().size());
        assertEquals("Verb + Noun", res.getGroups().get(0).getPattern());
    }

    @Test
    void collocationAnswersAreBuiltOncePerWord() {
        when(datamuseProvider.getCollocationsGrouped("decision")).thenReturn(
                CollocationsResponse.builder().word("decision").groups(List.of(
                        CollocationsResponse.CollocationPatternGroup.builder().pattern("Adjective + Noun").items(List.of(
                                CanonicalDictionaryResponse.CollocationDto.builder().phrase("final decision").build())).build()))
                        .build());

        CollocationsResponse first = dictionaryEngine.getCollocations("decision");
        CollocationsResponse second = dictionaryEngine.getCollocations("  Decision ");
        assertSame(first, second, "the second request is served from the usage cache");
        Mockito.verify(datamuseProvider, Mockito.times(1)).getCollocationsGrouped("decision");
    }

    @Test
    void anEmptyCollocationAnswerIsNotKept() {
        when(datamuseProvider.getCollocationsGrouped("decision")).thenReturn(
                CollocationsResponse.builder().word("decision").groups(List.of()).build());
        dictionaryEngine.getCollocations("decision");
        dictionaryEngine.getCollocations("decision");
        Mockito.verify(datamuseProvider, Mockito.times(2)).getCollocationsGrouped("decision");
    }

    @Test
    void testL1CacheHitReturnsInstantly() {
        CanonicalDictionaryResponse first = dictionaryEngine.lookup("take off", "en-en");
        long start = System.nanoTime();
        CanonicalDictionaryResponse second = dictionaryEngine.lookup("take off", "en-en");
        long durationMs = (System.nanoTime() - start) / 1_000_000;

        assertSame(first, second, "L1 cache should return the same object reference");
        assertTrue(durationMs < 5, "Cached lookup should return effectively instant (< 5ms)");
    }

    @Test
    void testUnknownWord_returnsNull_noFakeEntry() {
        CanonicalDictionaryResponse res = dictionaryEngine.lookup("xyznonexistentword123", "en-en");
        assertNull(res, "Unknown non-lexical word must return null without fabricating entry");
    }

    @Test
    void testUnknownWord_collocationsBlocked() {
        CollocationsResponse res = dictionaryEngine.getCollocations("xyznonexistentword123");
        assertNotNull(res);
        assertTrue(res.getGroups() == null || res.getGroups().isEmpty(),
                "Collocations must not run or return groups for unknown word");
    }

    @Test
    void testUnknownWord_phrasesBlocked() {
        PhrasesResponse res = dictionaryEngine.getPhrases("xyznonexistentword123");
        assertNotNull(res);
        assertTrue(res.getPhrasalVerbs() == null || res.getPhrasalVerbs().isEmpty(),
                "Phrases must not return phrasal verbs for unknown word");
        assertTrue(res.getIdioms() == null || res.getIdioms().isEmpty(),
                "Phrases must not return idioms for unknown word");
    }

    @Test
    void testStaleInvalidCache_bypassed() {
        // Return a stale empty shell from dictionaryRepository
        com.englishcoach.dictionary.entity.DictionaryEntry staleEntry =
                new com.englishcoach.dictionary.entity.DictionaryEntry();
        staleEntry.setWord("invalidword");
        staleEntry.setDataJson("{\"headword\":\"invalidword\",\"partsOfSpeech\":[]}");

        when(dictionaryRepository.findByWordIgnoreCase("invalidword")).thenReturn(Optional.of(staleEntry));

        CanonicalDictionaryResponse res = dictionaryEngine.lookup("invalidword", "en-en");
        assertNull(res, "Stale cached shell with empty senses must be bypassed");
    }

    @Test
    void testSingleWord_enVi_curatedEntryKeepsItsGeneralMeaning_noGtx() {
        // "bank" is a curated Kaikki entry: it already has a general meaning and sense-aligned translations
        CanonicalDictionaryResponse res = dictionaryEngine.lookup("bank", "en-vi");
        assertNotNull(res);
        assertEquals("bank", res.getHeadword());
        assertNotNull(res.getGeneralTranslationVi());
        Mockito.verify(googleGtxTranslationProvider, Mockito.never()).translateWordGeneral(anyString());
        Mockito.verify(googleGtxTranslationProvider, Mockito.never()).enrichWithVietnamese(any(CanonicalDictionaryResponse.class));
        assertTrue(res.getPartsOfSpeech().get(0).getSenses().get(0).getTranslationVi().contains("Ngân hàng"));
    }

    @Test
    void testMultiWord_enVi_neverCallsGtx_usesLocalSQLiteProvider() {
        CanonicalDictionaryResponse res = dictionaryEngine.lookup("take off", "en-vi");
        assertNotNull(res);
        assertEquals("take off", res.getHeadword());

        // GTX must NEVER be invoked for multi-word lexical entries
        Mockito.verify(googleGtxTranslationProvider, Mockito.never())
                .enrichWithVietnamese(any(CanonicalDictionaryResponse.class));
        Mockito.verify(googleGtxTranslationProvider, Mockito.never()).translateWordGeneral(anyString());

        // Vietnamese translation must come from local lexical provider
        assertNotNull(res.getGeneralTranslationVi(), "Multi-word entry should have Vietnamese meaning from local SQLite provider");
        assertTrue(res.getGeneralTranslationVi().contains("cất cánh") || !res.getGeneralTranslationVi().isBlank());
    }
}

