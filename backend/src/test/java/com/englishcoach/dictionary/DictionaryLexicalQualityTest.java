package com.englishcoach.dictionary;

import com.englishcoach.dictionary.dto.CanonicalDictionaryResponse;
import com.englishcoach.dictionary.entity.DictionaryEntry;
import com.englishcoach.dictionary.provider.*;
import com.englishcoach.dictionary.repository.DictionaryRepository;
import com.englishcoach.dictionary.service.DictionaryEngine;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.mockito.Mockito;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

/**
 * Dictionary correctness repair (owner brief 2026-10-24, audit 2026-10-19): Vietnamese senses come from the bundled
 * EN-VI dictionary and are never paired with an English definition by position; GTX gives the general meaning only;
 * Datamuse synonyms stay word-level; stored payloads of the old revision are rebuilt; a slow provider never holds a
 * click; unreviewed legacy rows are never rewritten. Uses the real bundled SQLite dictionary and Kaikki core store.
 */
class DictionaryLexicalQualityTest {

    private DictionaryRepository repository;
    private WiktionaryProvider wiktionary;
    private DictionaryApiDevProvider dictionaryApiDev;
    private DatamuseProvider datamuse;
    private GoogleGtxTranslationProvider gtx;
    private ObjectMapper objectMapper;
    private DictionaryEngine engine;

    @BeforeEach
    void setUp() {
        repository = mock(DictionaryRepository.class);
        OxfordProvider oxford = mock(OxfordProvider.class);
        CambridgeProvider cambridge = mock(CambridgeProvider.class);
        wiktionary = mock(WiktionaryProvider.class);
        dictionaryApiDev = mock(DictionaryApiDevProvider.class);
        datamuse = mock(DatamuseProvider.class);
        gtx = mock(GoogleGtxTranslationProvider.class);
        LocalEnViLexicalProvider local = new LocalEnViLexicalProvider();
        local.init();
        assertTrue(local.isAvailable(), "the bundled EN-VI dictionary must be readable in tests");
        objectMapper = new ObjectMapper();
        KaikkiLocalLexicalStore kaikki = new KaikkiLocalLexicalStore(objectMapper);
        kaikki.init();

        when(repository.findByWordIgnoreCase(anyString())).thenReturn(Optional.empty());
        when(oxford.isAvailable()).thenReturn(false);
        when(datamuse.getSynonyms(anyString())).thenReturn(List.of("exhilaration", "turmoil", "upheaval"));

        engine = new DictionaryEngine(repository, oxford, cambridge, wiktionary, dictionaryApiDev, datamuse, gtx,
                local, new PhraseProvider(), kaikki, objectMapper);
    }

    /** An English-only provider entry (what Wiktionary / dictionaryapi.dev return): no Vietnamese at all. */
    private static CanonicalDictionaryResponse english(String word, String pos, String... definitions) {
        List<CanonicalDictionaryResponse.SenseDto> senses = new ArrayList<>();
        int i = 1;
        for (String d : definitions) {
            senses.add(CanonicalDictionaryResponse.SenseDto.builder().id(String.valueOf(i++)).definitionEn(d)
                    .examples(new ArrayList<>()).build());
        }
        return CanonicalDictionaryResponse.builder()
                .query(word).normalizedQuery(word).headword(word).entryType("WORD").source("Wiktionary")
                .pronunciations(new ArrayList<>())
                .partsOfSpeech(new ArrayList<>(List.of(CanonicalDictionaryResponse.PartOfSpeechGroupDto.builder()
                        .partOfSpeech(pos).senses(senses).build())))
                .build();
    }

    private void englishProviderKnows(String word, String pos, String... definitions) {
        when(wiktionary.lookup(eq(word), anyString())).thenReturn(Optional.of(english(word, pos, definitions)));
    }

    private static List<String> meaningsOf(CanonicalDictionaryResponse r, String pos) {
        assertNotNull(r.getVietnameseSenses(), "the entry must carry the dictionary's Vietnamese senses");
        return r.getVietnameseSenses().stream().filter(g -> g.getPartOfSpeech().equals(pos))
                .findFirst().map(CanonicalDictionaryResponse.VietnameseSenseGroupDto::getMeanings).orElse(List.of());
    }

    private static void assertNoSenseTextPairedByPosition(CanonicalDictionaryResponse r) {
        for (var group : r.getPartsOfSpeech()) {
            for (var sense : group.getSenses()) {
                assertNull(sense.getTranslationVi(), "no Vietnamese text may sit under an English sense it was not written for: "
                        + sense.getDefinitionEn() + " => " + sense.getTranslationVi());
                assertTrue(sense.getSynonyms() == null || sense.getSynonyms().isEmpty(),
                        "word-level synonyms never sit on one sense");
            }
        }
    }

    @Test
    void excitement_generalMeaningAndDictionarySenses_neverDiscomfort() {
        englishProviderKnows("excitement", "noun", "The state of feeling or showing happiness and enthusiasm.");
        when(gtx.translateWordGeneral("excitement")).thenReturn("sự phấn khích");

        CanonicalDictionaryResponse r = engine.lookup("excitement", "en-vi");

        assertEquals("sự phấn khích", r.getGeneralTranslationVi());
        assertNoSenseTextPairedByPosition(r);
        List<String> noun = meaningsOf(r, "noun");
        assertTrue(noun.get(0).startsWith("Sự kích thích, sự kích động"), noun.toString());
        assertTrue(noun.stream().noneMatch(m -> m.contains("khó chịu")), noun.toString());
        assertEquals(List.of("exhilaration", "turmoil", "upheaval"), r.getSynonyms());
        assertEquals(DictionaryEngine.LEXICON_REVISION, r.getLexiconRevision());
        assertNotNull(r.getVietnameseSource());
        verify(gtx, never()).enrichWithVietnamese(any());
    }

    @Test
    void polysemousWords_keepTheirDistinctVietnameseSenses() {
        englishProviderKnows("interest", "noun", "A feeling of wanting to learn more about something.");
        englishProviderKnows("address", "noun", "The particulars of the place where someone lives.");
        englishProviderKnows("engaged", "adjective", "Having agreed to marry someone.");
        englishProviderKnows("charge", "noun", "The price asked for goods or services.");

        CanonicalDictionaryResponse interest = engine.lookup("interest", "en-vi");
        List<String> interestNoun = meaningsOf(interest, "noun");
        assertTrue(interestNoun.get(0).contains("quan tâm"), "curiosity first: " + interestNoun);
        assertTrue(interestNoun.stream().anyMatch(m -> m.contains("tiền lãi")), "finance kept as its own sense");
        assertFalse(meaningsOf(interest, "verb").isEmpty());
        assertNoSenseTextPairedByPosition(interest);

        CanonicalDictionaryResponse address = engine.lookup("address", "en-vi");
        List<String> addressNoun = meaningsOf(address, "noun");
        assertTrue(addressNoun.get(0).startsWith("Địa chỉ"), addressNoun.toString());
        assertTrue(addressNoun.stream().anyMatch(m -> m.contains("diễn văn")), "speech kept as its own sense");
        assertNoSenseTextPairedByPosition(address);

        CanonicalDictionaryResponse engaged = engine.lookup("engaged", "en-vi");
        List<String> engagedAdj = meaningsOf(engaged, "adjective");
        assertTrue(engagedAdj.stream().anyMatch(m -> m.contains("hứa hôn")), engagedAdj.toString());
        assertTrue(engagedAdj.stream().anyMatch(m -> m.contains("bận rộn")), engagedAdj.toString());
        assertNoSenseTextPairedByPosition(engaged);

        CanonicalDictionaryResponse charge = engine.lookup("charge", "en-vi");
        List<String> chargeNoun = meaningsOf(charge, "noun");
        assertTrue(chargeNoun.stream().anyMatch(m -> m.contains("giá tiền")), "fee: " + chargeNoun);
        assertTrue(chargeNoun.stream().anyMatch(m -> m.contains("buộc tội")), "accusation: " + chargeNoun);
        assertTrue(meaningsOf(charge, "verb").stream().anyMatch(m -> m.contains("Buộc tội")));
        assertNoSenseTextPairedByPosition(charge);
        // English sense text is untouched
        assertEquals("The price asked for goods or services.", charge.getPartsOfSpeech().get(0).getSenses().get(0).getDefinitionEn());
    }

    @Test
    void recordPresentIssue_keepEveryPartOfSpeech_andBankKeepsItsCuratedSenses() {
        englishProviderKnows("record", "noun", "A thing constituting a piece of evidence about the past.");
        englishProviderKnows("present", "adjective", "Existing or occurring now.");
        englishProviderKnows("issue", "noun", "An important topic or problem for debate or discussion.");

        CanonicalDictionaryResponse record = engine.lookup("record", "en-vi");
        assertTrue(meaningsOf(record, "noun").stream().anyMatch(m -> m.contains("Kỷ lục")));
        assertTrue(meaningsOf(record, "verb").stream().anyMatch(m -> m.contains("ghi chép")));

        CanonicalDictionaryResponse present = engine.lookup("present", "en-vi");
        assertTrue(meaningsOf(present, "adjective").stream().anyMatch(m -> m.contains("Hiện tại")));
        assertTrue(meaningsOf(present, "noun").stream().anyMatch(m -> m.contains("Quà biếu")));
        assertTrue(meaningsOf(present, "verb").stream().anyMatch(m -> m.contains("trình bày")));

        CanonicalDictionaryResponse issue = engine.lookup("issue", "en-vi");
        assertTrue(meaningsOf(issue, "noun").stream().anyMatch(m -> m.contains("Vấn đề")));
        assertTrue(meaningsOf(issue, "noun").stream().anyMatch(m -> m.contains("Số báo")));

        // curated, sense-aligned entry: its own sense translations stay on their senses
        CanonicalDictionaryResponse bank = engine.lookup("bank", "en-vi");
        var senses = bank.getPartsOfSpeech().get(0).getSenses();
        assertTrue(senses.get(0).getDefinitionEn().startsWith("A financial institution"));
        assertTrue(senses.get(0).getTranslationVi().startsWith("Ngân hàng"));
        assertTrue(senses.get(1).getTranslationVi().startsWith("Bờ sông"));
        assertTrue(meaningsOf(bank, "noun").stream().anyMatch(m -> m.contains("Nhà ngân hàng")));
    }

    @Test
    void localWord_unknownToEnglishProviders_answersFromTheLocalDictionary_neverStored() {
        // no English provider knows it: the local dictionary still answers, with its own senses only
        CanonicalDictionaryResponse r = engine.lookup("excitement", "en-vi");

        assertNotNull(r);
        assertEquals("excitement", r.getHeadword());
        assertTrue(r.getGeneralTranslationVi().startsWith("Sự kích thích"));
        assertTrue(r.getPartsOfSpeech().stream().flatMap(g -> g.getSenses().stream())
                .allMatch(s -> s.getDefinitionEn() == null && s.getTranslationVi() != null), "no English text is invented");
        assertFalse(DictionaryEngine.canPersistLexicalEntry(r));
        verify(repository, never()).save(any());
        assertEquals("/ɪkˈsaɪtmənt/", r.getPronunciations().get(0).getIpa());
    }

    @Test
    void slowGeneralTranslation_neverHoldsTheClick_localMeaningStandsIn() {
        englishProviderKnows("excitement", "noun", "The state of feeling or showing happiness and enthusiasm.");
        when(gtx.translateWordGeneral("excitement")).thenAnswer(inv -> {
            Thread.sleep(6000);
            return "sự phấn khích";
        });

        long start = System.nanoTime();
        CanonicalDictionaryResponse r = engine.lookup("excitement", "en-vi");
        long ms = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);

        assertTrue(ms < 3500, "a slow provider must not hold the lookup: " + ms + " ms");
        assertEquals("Sự kích thích, sự kích động; tình trạng bị kích thích, tình trạng bị kích động", r.getGeneralTranslationVi());
        assertNoSenseTextPairedByPosition(r);
    }

    @Test
    void slowEnglishProvider_localDictionaryAnswersFirst_fullEntryFollows() throws Exception {
        CountDownLatch release = new CountDownLatch(1);
        when(wiktionary.lookup(eq("interest"), anyString())).thenAnswer(inv -> {
            release.await(10, TimeUnit.SECONDS);
            return Optional.of(english("interest", "noun", "A feeling of wanting to learn more about something."));
        });
        when(gtx.translateWordGeneral("interest")).thenReturn("quan tâm");

        long start = System.nanoTime();
        CanonicalDictionaryResponse first = engine.lookup("interest", "en-vi");
        long ms = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);
        assertTrue(ms < 6000, ms + " ms");
        assertTrue(first.getPartsOfSpeech().get(0).getSenses().get(0).getDefinitionEn() == null, "local stand-in first");

        release.countDown();
        CanonicalDictionaryResponse later = null;
        for (int i = 0; i < 50 && (later == null || later.getPartsOfSpeech().get(0).getSenses().get(0).getDefinitionEn() == null); i++) {
            Thread.sleep(100);
            later = engine.lookup("interest", "en-vi");
        }
        assertNotNull(later.getPartsOfSpeech().get(0).getSenses().get(0).getDefinitionEn(), "the finished build replaces the stand-in");
        assertEquals("quan tâm", later.getGeneralTranslationVi());
    }

    @Test
    void concurrentClicksOnOneWord_shareOneBuild() throws Exception {
        when(wiktionary.lookup(eq("charge"), anyString())).thenAnswer(inv -> {
            Thread.sleep(300);
            return Optional.of(english("charge", "noun", "The price asked for goods or services."));
        });
        ExecutorService clicks = Executors.newFixedThreadPool(4);
        List<Future<CanonicalDictionaryResponse>> results = new ArrayList<>();
        for (int i = 0; i < 4; i++) results.add(clicks.submit(() -> engine.lookup("charge", "en-vi")));
        for (Future<CanonicalDictionaryResponse> f : results) assertNotNull(f.get(10, TimeUnit.SECONDS));
        clicks.shutdown();
        verify(wiktionary, times(1)).lookup(eq("charge"), anyString());
    }

    @Test
    void storedPayloadOfOldRevision_isRebuilt_positionalTextAndSenseSynonymsDropped() throws Exception {
        // what revision 1 stored for "excitement" in production (audit 2026-10-19)
        CanonicalDictionaryResponse old = english("excitement", "general", "the state of feeling or showing happiness and enthusiasm.");
        old.setSource("English Coach Lexical Cache");
        old.setGeneralTranslationVi("sự phấn khích");
        old.getPartsOfSpeech().get(0).getSenses().get(0).setTranslationVi("khó chịu");
        old.getPartsOfSpeech().get(0).getSenses().get(0).setSynonyms(List.of("exhilaration", "turmoil", "upheaval"));
        old.setCollocations(List.of(CanonicalDictionaryResponse.CollocationDto.builder().phrase("great excitement").build()));
        DictionaryEntry row = DictionaryEntry.builder().id(7854L).word("excitement")
                .dataJson(objectMapper.writeValueAsString(old)).generalTranslationVi("sự phấn khích")
                .meanings(new ArrayList<>(List.of("the state of feeling or showing happiness and enthusiasm.", "khó chịu")))
                .examples(new ArrayList<>()).build();
        when(repository.findByWordIgnoreCase("excitement")).thenReturn(Optional.of(row));
        when(repository.findSharedPayload("excitement")).thenReturn(row.getDataJson());

        CanonicalDictionaryResponse r = engine.lookup("excitement", "en-vi");

        assertNoSenseTextPairedByPosition(r);
        assertEquals("sự phấn khích", r.getGeneralTranslationVi());
        assertEquals(List.of("exhilaration", "turmoil", "upheaval"), r.getSynonyms(), "moved to the word");
        assertTrue(meaningsOf(r, "noun").get(0).startsWith("Sự kích thích"));
        assertEquals(DictionaryEngine.LEXICON_REVISION, r.getLexiconRevision());
        verify(gtx, never()).translateWordGeneral(anyString()); // nothing remote needed for a rebuild
        verify(datamuse, never()).getCollocations(anyString());

        ArgumentCaptor<DictionaryEntry> saved = ArgumentCaptor.forClass(DictionaryEntry.class);
        verify(repository).save(saved.capture());
        assertTrue(saved.getValue().getDataJson().contains("\"lexiconRevision\":" + DictionaryEngine.LEXICON_REVISION));
        assertFalse(saved.getValue().getDataJson().contains("khó chịu"));
        assertFalse(saved.getValue().getMeanings().contains("khó chịu"), "legacy meanings hold English definitions only");
        assertNull(saved.getValue().getOwnerUserId(), "a shared row stays shared");
    }

    @Test
    void storedPayloadOfCurrentRevision_isServedWithoutAnyProviderCall() throws Exception {
        englishProviderKnows("address", "noun", "The particulars of the place where someone lives.");
        when(gtx.translateWordGeneral("address")).thenReturn("Địa chỉ");
        CanonicalDictionaryResponse built = engine.lookup("address", "en-vi");
        String json = objectMapper.writeValueAsString(built);

        DictionaryEngine fresh = new DictionaryEngine(repository, mock(OxfordProvider.class), mock(CambridgeProvider.class),
                wiktionary, dictionaryApiDev, datamuse, gtx, new LocalEnViLexicalProvider(), new PhraseProvider(),
                new KaikkiLocalLexicalStore(objectMapper), objectMapper);
        when(repository.findSharedPayload("address")).thenReturn(json);
        clearInvocations(wiktionary, gtx, datamuse);

        CanonicalDictionaryResponse served = fresh.lookup("address", "en-vi");
        assertEquals("Địa chỉ", served.getGeneralTranslationVi());
        assertFalse(meaningsOf(served, "noun").isEmpty());
        verifyNoInteractions(wiktionary, gtx, datamuse);
    }

    @Test
    void unreviewedLegacyRow_isNeverRewritten_systemDeckRowIs() {
        DictionaryEntry legacy = DictionaryEntry.builder().id(42L).word("engaged")
                .meanings(new ArrayList<>(List.of("having agreed to marry somebody.")))
                .examples(new ArrayList<>()).build();
        when(repository.findByWordIgnoreCase("engaged")).thenReturn(Optional.of(legacy));
        when(repository.isInSystemDeck(42L)).thenReturn(false);

        CanonicalDictionaryResponse r = engine.lookup("engaged", "en-vi");
        assertNotNull(r);
        assertTrue(meaningsOf(r, "adjective").stream().anyMatch(m -> m.contains("hứa hôn")));
        verify(repository, never()).save(any());

        DictionaryEntry deckRow = DictionaryEntry.builder().id(43L).word("record")
                .meanings(new ArrayList<>(List.of("a written account of something that is kept."))).examples(new ArrayList<>()).build();
        when(repository.findByWordIgnoreCase("record")).thenReturn(Optional.of(deckRow));
        when(repository.isInSystemDeck(43L)).thenReturn(true);
        engine.lookup("record", "en-vi");
        verify(repository).save(argThat(e -> e.getId() == 43L && e.getDataJson() != null && e.getOwnerUserId() == null));
        verify(repository, never()).save(argThat(e -> e.getId() != null && e.getId() == 42L));
    }

    @Test
    void unicodeAndCasing_oneFormForTextAndQueries() {
        // production stored GTX terms decomposed ("la" + U+0303 + "i"): every provider text leaves the engine in NFC
        assertEquals("lãi", DictionaryEngine.cleanParserArtifacts("lãi"));
        englishProviderKnows("café", "noun", "A small restaurant selling light meals and drinks.");
        CanonicalDictionaryResponse composed = engine.lookup("  CAFÉ ", "en-vi");
        assertNotNull(composed);
        assertSame(composed, engine.lookup("café", "en-vi"), "decomposed / upper-case query reaches the same cache entry");
    }

    @Test
    void commonPhrase_keepsItsLocalMeaning_unknownWordStaysNotFound() {
        CanonicalDictionaryResponse takeOff = engine.lookup("take off", "en-vi");
        assertNotNull(takeOff.getGeneralTranslationVi());
        verify(gtx, never()).translateWordGeneral(anyString());
        assertNull(engine.lookup("qzxwvbnmplk", "en-vi"));
        assertNull(engine.lookup("  QZXWVBNMPLK  ", "en-en"), "casing / spacing normalised");
    }
}
