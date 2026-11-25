package com.englishcoach.flashcard.service;

import com.englishcoach.dictionary.repository.DictionaryRepository;
import com.englishcoach.flashcard.entity.VocabDeck;
import com.englishcoach.flashcard.repository.VocabDeckRepository;
import org.junit.jupiter.api.Test;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.DefaultApplicationArguments;
import org.springframework.boot.test.context.ConfigDataApplicationContextInitializer;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowCallbackHandler;

import java.sql.ResultSet;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

class VocabDeckSeederActivationTest {
    private final VocabDeckRepository decks = mock(VocabDeckRepository.class);
    private final DictionaryRepository dictionary = mock(DictionaryRepository.class);
    private final JdbcTemplate jdbc = mock(JdbcTemplate.class);
    private final VocabDeckCache cache = mock(VocabDeckCache.class);
    private final ApplicationContextRunner context = new ApplicationContextRunner()
            .withBean(VocabDeckRepository.class, () -> decks)
            .withBean(DictionaryRepository.class, () -> dictionary)
            .withBean(JdbcTemplate.class, () -> jdbc)
            .withBean(VocabDeckCache.class, () -> cache)
            .withUserConfiguration(VocabDeckSeeder.class);

    private void assertDisabled(ApplicationContextRunner runner) {
        runner.run(ctx -> {
            assertThat(ctx).doesNotHaveBean(VocabDeckSeeder.class);
            assertThat(ctx.getBeansOfType(ApplicationRunner.class)).isEmpty();
            verifyNoInteractions(decks, dictionary, cache);
            verify(jdbc).afterPropertiesSet(); // Spring initializes the mock bean; this is not a DB operation.
            verifyNoMoreInteractions(jdbc);
        });
    }

    @Test void absentFlagDoesNotCreateStartupRunnerOrTouchDatabase() {
        assertDisabled(context);
    }

    @Test void falseFlagDoesNotCreateStartupRunnerOrTouchDatabase() {
        assertDisabled(context.withPropertyValues("app.vocab-deck-seed.enabled=false"));
    }

    @Test void blankFlagDoesNotCreateStartupRunnerOrTouchDatabase() {
        assertDisabled(context.withPropertyValues("app.vocab-deck-seed.enabled="));
    }

    @Test void nonTrueFlagDoesNotCreateStartupRunnerOrTouchDatabase() {
        assertDisabled(context.withPropertyValues("app.vocab-deck-seed.enabled=yes"));
    }

    @Test void productionConfigurationDefaultsToDisabled() {
        context.withInitializer(new ConfigDataApplicationContextInitializer())
                .withPropertyValues("spring.profiles.active=prod")
                .run(ctx -> {
                    assertThat(ctx.getEnvironment().getProperty("app.vocab-deck-seed.enabled")).isEqualTo("false");
                    assertThat(ctx).doesNotHaveBean(VocabDeckSeeder.class);
                    verifyNoInteractions(decks, dictionary, cache);
            verify(jdbc).afterPropertiesSet(); // Spring initializes the mock bean; this is not a DB operation.
            verifyNoMoreInteractions(jdbc);
                });
    }

    @Test void explicitTrueExecutesExistingDeckDictionaryAndLinkSeedPathsUsingMocks() {
        when(decks.save(any(VocabDeck.class))).thenAnswer(call -> {
            VocabDeck deck = call.getArgument(0);
            deck.setId(1L);
            return deck;
        });
        doAnswer(call -> {
            Object[] words = call.getArgument(1);
            RowCallbackHandler callback = call.getArgument(2);
            for (Object word : words) {
                ResultSet row = mock(ResultSet.class);
                when(row.getString(2)).thenReturn(word.toString());
                when(row.getLong(1)).thenReturn(2L);
                callback.processRow(row);
            }
            return null;
        }).when(jdbc).query(anyString(), any(Object[].class), any(RowCallbackHandler.class));
        when(jdbc.queryForObject(anyString(), eq(Integer.class), anyLong())).thenReturn(1);
        context.withPropertyValues("app.vocab-deck-seed.enabled=true").run(ctx -> {
            assertThat(ctx).hasSingleBean(VocabDeckSeeder.class);
            ctx.getBean(VocabDeckSeeder.class).run(new DefaultApplicationArguments());
            verify(decks, atLeastOnce()).save(any(VocabDeck.class));
            verify(jdbc, atLeastOnce()).batchUpdate(startsWith("INSERT INTO public.dictionary_entries"), anyList());
            verify(jdbc, atLeastOnce()).batchUpdate(startsWith("INSERT INTO public.deck_dictionary_entries"), anyList());
            verify(jdbc, atLeastOnce()).batchUpdate(startsWith("INSERT INTO public.dictionary_meanings"), anyList());
            verify(jdbc, atLeastOnce()).batchUpdate(startsWith("INSERT INTO public.dictionary_examples"), anyList());
            verify(jdbc, atLeastOnce()).update(startsWith("DELETE FROM public.deck_dictionary_entries"), any(Object[].class));
            verify(cache).evictAll();
        });
    }
}
