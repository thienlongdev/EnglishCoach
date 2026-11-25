package com.englishcoach.dictionary.service;
import com.englishcoach.dictionary.provider.*;
import org.junit.jupiter.api.Test;
import java.util.*;
import java.util.concurrent.atomic.AtomicLong;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
class LocalGameLexiconConquestCacheTest {
    @Test void missesExpireBoundedLruAndWordChainIndependent()throws Exception {
        var local=mock(LocalEnViLexicalProvider.class);var core=mock(KaikkiLocalLexicalStore.class);var time=new AtomicLong(1);
        when(local.lookupExactLocal(anyString())).thenReturn(Optional.empty());
        var game=new LocalGameLexicon(local,core,time::get);
        assertTrue(game.lookupConquest("cat").isEmpty());assertTrue(game.lookupConquest("cat").isEmpty());verify(local,times(1)).lookupExactLocal("cat");
        time.addAndGet(LocalGameLexicon.CONQUEST_CACHE_TTL_NANOS);game.lookupConquest("cat");verify(local,times(2)).lookupExactLocal("cat");
        game.lookup("cat");verify(local,times(3)).lookupExactLocal("cat");
        for(int n=0;n<3001;n++){String word="z"+((char)('a'+n/676))+((char)('a'+n/26%26))+((char)('a'+n%26));game.lookupConquest(word);}
        var field=LocalGameLexicon.class.getDeclaredField("conquestCache");field.setAccessible(true);var cache=(Map<?,?>)field.get(game);
        assertEquals(3000,cache.size());assertFalse(cache.containsKey("cat"));game.lookupConquest("cat");verify(local,times(4)).lookupExactLocal("cat");
        game.lookupConquest("CAT");game.lookupConquest("!bad");assertFalse(cache.containsKey("CAT"));
    }
}
