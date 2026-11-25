package com.englishcoach.writing;

import com.englishcoach.writing.service.LanguageToolGrammarService;
import org.junit.jupiter.api.Test;
import org.languagetool.JLanguageTool;
import java.io.IOException;
import java.util.List;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

class LanguageToolLifecycleTest {
    @Test void concurrentLifecycleAndFirstRequestsReuseOneWarmedEngine() throws Exception {
        JLanguageTool engine = mock(JLanguageTool.class);
        when(engine.check(anyString())).thenReturn(List.of());
        AtomicInteger created = new AtomicInteger();
        LanguageToolGrammarService service = new LanguageToolGrammarService() {
            @Override protected JLanguageTool createEngine() { created.incrementAndGet(); return engine; }
        };
        try (ExecutorService workers = Executors.newFixedThreadPool(8)) {
            var starts = new java.util.ArrayList<Future<?>>();
            for (int i = 0; i < 8; i++) starts.add(workers.submit(service::init));
            for (var start : starts) start.get(10, TimeUnit.SECONDS);
            var requests = new java.util.ArrayList<Future<?>>();
            for (int i = 0; i < 8; i++) requests.add(workers.submit(() -> service.checkText("A correct sentence.")));
            for (var request : requests) request.get(10, TimeUnit.SECONDS);
        }
        assertThat(created.get()).isEqualTo(1);
        assertThat(service.getLanguageTool()).isSameAs(engine);
        verify(engine, times(1)).check("She don't like apples.");
        verify(engine, times(8)).check("A correct sentence.");
    }

    @Test void failedWarmupDoesNotPublishPartialEngineAndCanRecover() throws Exception {
        JLanguageTool engine = mock(JLanguageTool.class);
        when(engine.check(anyString())).thenThrow(new IOException("test failure")).thenReturn(List.of());
        LanguageToolGrammarService service = new LanguageToolGrammarService() {
            @Override protected JLanguageTool createEngine() { return engine; }
        };
        assertThatThrownBy(service::init).isInstanceOf(IllegalStateException.class);
        assertThat(service.getLanguageTool()).isNull();
        service.init();
        assertThat(service.getLanguageTool()).isSameAs(engine);
        service.init();
        verify(engine, times(2)).check("She don't like apples.");
    }

    @Test void realWarmupMakesFirstAndRepeatedGrammarRequestsAvailable() {
        LanguageToolGrammarService service = new LanguageToolGrammarService();
        service.init();
        JLanguageTool engine = service.getLanguageTool();
        long start = System.nanoTime();
        var first = service.checkText("She don't like apples.");
        long firstMs = (System.nanoTime() - start) / 1_000_000;
        start = System.nanoTime();
        var warm = service.checkText("She don't like apples.");
        long warmMs = (System.nanoTime() - start) / 1_000_000;
        assertThat(first).isNotEmpty();
        assertThat(warm).hasSameSizeAs(first);
        service.init();
        assertThat(service.getLanguageTool()).isSameAs(engine);
        System.out.println("LANGUAGETOOL_FIRST_MS=" + firstMs + " WARM_MS=" + warmMs);
    }
}
