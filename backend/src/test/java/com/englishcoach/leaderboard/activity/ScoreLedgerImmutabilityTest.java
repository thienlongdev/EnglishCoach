package com.englishcoach.leaderboard.activity;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Append-only ledger guard: no main source file issues UPDATE/DELETE against score_events and the
 * repository exposes only insert/select style methods. The V52 trigger enforces the same in the DB.
 */
class ScoreLedgerImmutabilityTest {

    private static final Pattern MUTATION = Pattern.compile(
            "(update\\s+(public\\.)?score_events)|(delete\\s+from\\s+(public\\.)?score_events)|(truncate\\s+(table\\s+)?(public\\.)?score_events)",
            Pattern.CASE_INSENSITIVE);

    @Test
    @DisplayName("No code path UPDATEs/DELETEs score_events")
    void noMutatingSqlInMainSources() throws IOException {
        Path root = Path.of("src/main/java");
        assertTrue(Files.isDirectory(root), "run from the backend module directory");
        List<String> offenders;
        try (Stream<Path> files = Files.walk(root)) {
            offenders = files.filter(p -> p.toString().endsWith(".java"))
                    .filter(p -> {
                        try {
                            return MUTATION.matcher(Files.readString(p)).find();
                        } catch (IOException e) {
                            throw new RuntimeException(e);
                        }
                    })
                    .map(Path::toString)
                    .toList();
        }
        assertEquals(List.of(), offenders);
    }

    @Test
    @DisplayName("ScoreEventRepository exposes only insert/select methods")
    void repositoryHasNoMutators() {
        Set<String> allowedPrefixes = Set.of("insert", "exists", "sum", "count", "find", "lock");
        List<String> publicMethods = Arrays.stream(ScoreEventRepository.class.getDeclaredMethods())
                .filter(m -> Modifier.isPublic(m.getModifiers()))
                .map(Method::getName)
                .toList();
        assertFalse(publicMethods.isEmpty());
        for (String name : publicMethods) {
            String lower = name.toLowerCase(Locale.ROOT);
            assertTrue(allowedPrefixes.stream().anyMatch(lower::startsWith), "unexpected ledger method: " + name);
            assertFalse(lower.contains("update") || lower.contains("delete") || lower.contains("remove"), name);
        }
    }
}
