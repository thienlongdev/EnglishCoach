package com.englishcoach.dictionary.provider;

import com.englishcoach.dictionary.dto.CanonicalDictionaryResponse;
import com.englishcoach.dictionary.dto.CollocationsResponse;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.anyCollection;

/**
 * Collocations of the "Cụm từ liên quan" tab (owner brief 2026-10-24): only phrases attested in the corpus, told honestly.
 * Fixtures are Datamuse's real answers for "fall" (2026-10-24, trimmed).
 */
class DatamuseCollocationQualityTest {

    private static final String SP = "[{\"word\":\"fall\",\"score\":1,\"tags\":[\"n\",\"v\"]}]";
    private static final String JJB = "[{\"word\":\"last\",\"score\":1001,\"tags\":[\"adj\",\"adv\"]},"
            + "{\"word\":\"early\",\"score\":1000,\"tags\":[\"adj\"]},{\"word\":\"free\",\"score\":998,\"tags\":[\"adj\",\"n\"]}]";
    private static final String BGA = "[{\"word\":\"of\",\"score\":161726,\"tags\":[\"v\",\"n\"]},"
            + "{\"word\":\"asleep\",\"score\":12238,\"tags\":[\"adj\"]},{\"word\":\"short\",\"score\":11852,\"tags\":[\"adj\",\"adv\"]},"
            + "{\"word\":\"prey\",\"score\":3341,\"tags\":[\"n\",\"v\"]},{\"word\":\"victim\",\"score\":3227,\"tags\":[\"n\",\"v\"]},"
            + "{\"word\":\"again\",\"score\":2735,\"tags\":[\"adv\"]},{\"word\":\"like\",\"score\":2699,\"tags\":[\"v\",\"n\"]},"
            + "{\"word\":\"ill\",\"score\":2449,\"tags\":[\"adj\",\"adv\"]},{\"word\":\"statement\",\"score\":1500,\"tags\":[\"n\"]},"
            + "{\"word\":\"due\",\"score\":900,\"tags\":[\"adj\"]}]";
    private static final String TRG = "[{\"word\":\"semester\",\"score\":1420,\"tags\":[\"n\"]},{\"word\":\"love\",\"score\":1248,\"tags\":[\"n\",\"v\"]},"
            + "{\"word\":\"regime\",\"score\":1213,\"tags\":[\"n\"]},{\"word\":\"grace\",\"score\":1192,\"tags\":[\"n\",\"v\"]}]";

    private final List<String> urls = new ArrayList<>();
    private final List<Collection<String>> batches = new ArrayList<>();

    private DatamuseProvider provider() {
        PhraseProvider phrases = Mockito.mock(PhraseProvider.class);
        Mockito.when(phrases.directEntriesAmong(anyCollection())).thenAnswer(inv -> {
            Collection<String> asked = inv.getArgument(0);
            batches.add(asked);
            return Set.of("fall asleep");
        });
        return new DatamuseProvider(new ObjectMapper(), phrases, null, null) {
            @Override
            String fetch(String url) {
                urls.add(url);
                if (url.contains("sp=")) return SP;
                if (url.contains("rel_jjb=")) return JJB;
                if (url.contains("rel_bga=")) return BGA;
                if (url.contains("rel_trg=")) return TRG;
                return "[]";
            }
        };
    }

    @Test
    void neverJoinsAnAssociatedWordToTheHeadword() {
        List<String> phrases = provider().getCollocations("fall").stream().map(CanonicalDictionaryResponse.CollocationDto::getPhrase).toList();
        for (String invented : List.of("fall semester", "fall love", "fall regime", "fall grace")) {
            assertFalse(phrases.contains(invented), invented + " is not an attested phrase");
        }
        assertTrue(urls.stream().noneMatch(u -> u.contains("rel_trg")), "trigger words are not asked for");
        assertTrue(phrases.containsAll(List.of("fall asleep", "fall short", "fall prey", "fall victim", "fall ill", "last fall", "early fall")));
    }

    @Test
    void followersAreToldByPositionNotByAGuessedPattern() {
        CollocationsResponse grouped = provider().getCollocationsGrouped("fall");
        List<String> patterns = grouped.getGroups().stream().map(CollocationsResponse.CollocationPatternGroup::getPattern).toList();
        assertEquals(List.of("Adjective + Noun", DatamuseProvider.NEXT_WORD), patterns);
        assertFalse(patterns.contains("Verb + Noun"), "the head's role before a follower is unknown (fall semester / fall victim)");
    }

    @Test
    void freeModifiersAndWeakFollowersAreLeftOut() {
        List<String> phrases = provider().getCollocations("fall").stream().map(CanonicalDictionaryResponse.CollocationDto::getPhrase).toList();
        assertFalse(phrases.contains("fall again"));
        assertFalse(phrases.contains("fall like"));
        assertFalse(phrases.contains("fall of"), "a preposition alone is a fragment");
        assertFalse(phrases.contains("fall due"), "below the corpus-strength floor");
        assertTrue(phrases.contains("fall statement") && !phrases.contains("fall a statement"), "an attested bigram never gets an article inserted");
    }

    @Test
    void entryLinksComeFromOneBatchedCheck() {
        List<CanonicalDictionaryResponse.CollocationDto> all = provider().getCollocations("fall");
        assertEquals(1, batches.size(), "one check for every phrase (it was one database round trip per phrase)");
        assertTrue(all.stream().filter(c -> c.getPhrase().equals("fall asleep")).allMatch(c -> Boolean.TRUE.equals(c.getHasExactEntry())));
        assertTrue(all.stream().filter(c -> !c.getPhrase().equals("fall asleep")).allMatch(c -> Boolean.FALSE.equals(c.getHasExactEntry())));
    }
}
