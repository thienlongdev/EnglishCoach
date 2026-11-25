package com.englishcoach.wordchain;

import org.junit.jupiter.api.Test;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import static com.englishcoach.wordchain.WordChainRules.*;

class WordChainRulesTest {
    @Test void normalizationPreservesIdentity() {
        assertEquals("energy", normalize("  ENERGY  "));
        assertEquals("can't", normalize("can’t"));
        assertEquals("well-being",normalize("Well-being"));
        assertNotEquals(normalize("run"),normalize("running"));
        for(String bad:List.of("a","new york","abc2","e.g.","word!","-word","word-","écho","a--b","", "x".repeat(81)))
            assertThrows(Rejection.class,()->normalize(bad),bad);
    }
    @Test void exactPerPlayerDuplicateAndMetadataSemantics() {
        var lex=mock(WordChainLexicon.class);
        var energy=new WordChainLexicon.Word("energy","energy",null,"noun","năng lượng",null,List.of());
        when(lex.check("energy")).thenReturn(new WordChainLexicon.Verdict(energy,null));
        Set<String> a=new HashSet<>(), b=new HashSet<>(); Map<String,WordChainLexicon.Word> metadata=new HashMap<>();
        // Required letter is set by intervening chain moves in the real game, not by duplicate identity.
        var first=validate(" ENERGY ","e",a,metadata,lex);a.add(first.normalizedWord());metadata.put("energy",first);
        var second=validate("energy","e",b,metadata,lex);b.add(second.normalizedWord());
        assertEquals(energy,second);
        assertEquals("SELF_DUPLICATE",assertThrows(Rejection.class,()->validate("energy","e",a,metadata,lex)).code);
        assertEquals("SELF_DUPLICATE",assertThrows(Rejection.class,()->validate("ENERGY","e",b,metadata,lex)).code);
        verify(lex,times(1)).check("energy");
    }
    @Test void rejectionDoesNotMutateAndChecksBeforeLookup() {
        var lex=mock(WordChainLexicon.class);Set<String> used=new HashSet<>();Map<String,WordChainLexicon.Word> metadata=new HashMap<>();
        assertEquals("WRONG_LETTER",assertThrows(Rejection.class,()->validate("energy","y",used,metadata,lex)).code);
        verifyNoInteractions(lex);
        when(lex.check("gibberishword")).thenReturn(new WordChainLexicon.Verdict(null,"UNKNOWN_WORD"));
        when(lex.check("rac")).thenReturn(new WordChainLexicon.Verdict(null,"ABBREVIATION"));
        assertEquals("ABBREVIATION",assertThrows(Rejection.class,()->validate("RAC","r",used,metadata,lex)).code);
        assertEquals("UNKNOWN_WORD",assertThrows(Rejection.class,()->validate("gibberishword","g",used,metadata,lex)).code);
        assertTrue(used.isEmpty());assertTrue(metadata.isEmpty());
    }
}
