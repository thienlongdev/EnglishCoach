package com.englishcoach.wordchain;

import com.englishcoach.dictionary.provider.*;
import com.englishcoach.dictionary.service.LocalGameLexicon;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class LocalGameLexiconTest {
    @Test void realCanonicalCorpusHasGlobalWordsAndRejectsAbbreviation() {
        var local=new LocalEnViLexicalProvider();local.init();assertTrue(local.isAvailable());
        var core=new KaikkiLocalLexicalStore(new ObjectMapper());core.init();
        var lex=new LocalGameLexicon(local,core);
        for(String word:java.util.List.of("energy","yesterday","yellow","echo","run","running","apple","orange"))
            assertTrue(lex.lookup(word).isPresent(),word);
        assertTrue(lex.lookup("usa").isEmpty());assertTrue(lex.lookup("zzzznotaword").isEmpty());
        assertNotNull(lex.lookup("energy").orElseThrow().meaningVi());
        assertNotNull(lex.lookup("hello").orElseThrow().ipa());
        assertTrue(lex.candidateKeys().size()>10000);
        long start=System.nanoTime();for(int i=0;i<10000;i++) lex.lookup("energy");
        System.out.println("Word Chain: 10000 cached local lookups took "+((System.nanoTime()-start)/1000000)+" ms (single-thread test).");
    }
    @Test void repeatedMissUsesBoundedCacheWithoutAnotherQuery() {
        var local=mock(LocalEnViLexicalProvider.class);var core=mock(KaikkiLocalLexicalStore.class);
        var lex=new LocalGameLexicon(local,core);lex.lookup("unknown");lex.lookup("unknown");
        verify(local,times(1)).lookupExactLocal("unknown");verify(core,times(1)).getEntry("unknown");
    }
}
