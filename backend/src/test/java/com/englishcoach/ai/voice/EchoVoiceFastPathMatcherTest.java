package com.englishcoach.ai.voice;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Verifies 100% byte-for-byte parity between Java {@link EchoVoiceFastPathMatcher} and the shared
 * cross-language fixture {@code shared/echo-jarvis/fast-path-parity-fixtures.json} (also consumed by
 * frontend {@code test-echo-jarvis-intents.mjs}).
 */
class EchoVoiceFastPathMatcherTest {

    private final ObjectMapper mapper = new ObjectMapper();

    private static Path resolveFixturesPath() {
        List<Path> candidates = List.of(
                Path.of("..", "shared", "echo-jarvis", "fast-path-parity-fixtures.json"),
                Path.of("shared", "echo-jarvis", "fast-path-parity-fixtures.json"));
        for (Path p : candidates) {
            if (Files.isRegularFile(p)) return p.toAbsolutePath().normalize();
        }
        throw new IllegalStateException("Could not locate shared/echo-jarvis/fast-path-parity-fixtures.json");
    }

    @Test
    void matchesAllSharedCrossLanguageParityFixturesUnderOneMillisecond() throws Exception {
        Path path = resolveFixturesPath();
        JsonNode root = mapper.readTree(Files.readString(path));
        assertThat(root.isArray()).isTrue();
        assertThat(root.size()).isGreaterThanOrEqualTo(200);

        long startNs = System.nanoTime();
        List<String> failures = new ArrayList<>();
        for (JsonNode fixture : root) {
            String id = fixture.get("id").asText();
            String utterance = fixture.get("utterance").asText();
            String pathname = fixture.hasNonNull("pathname") ? fixture.get("pathname").asText() : "/dashboard";
            boolean hasPendingConfirm = fixture.path("hasPendingConfirmation").asBoolean(false);
            boolean hasStrictSentinel = fixture.path("hasActiveStrictSentinel").asBoolean(false);
            String expectedRoute = fixture.get("expectedRoute").asText();

            EchoVoiceFastPathMatcher.Outcome outcome = EchoVoiceFastPathMatcher.evaluate(
                    utterance, pathname, hasPendingConfirm, hasStrictSentinel);

            switch (expectedRoute) {
                case "GUARD" -> {
                    if (outcome.guard() == null || outcome.plan() != null) {
                        failures.add(id + ": expected GUARD, got " + outcome);
                    } else if (fixture.hasNonNull("expectedGuard")
                            && !fixture.get("expectedGuard").asText().equals(outcome.guard().decision())) {
                        failures.add(id + ": expected guard " + fixture.get("expectedGuard").asText() + ", got " + outcome.guard().decision());
                    }
                }
                case "PLANE_A" -> {
                    if (outcome.guard() != null || outcome.plan() == null) {
                        failures.add(id + ": expected PLANE_A, got " + outcome);
                        continue;
                    }
                    if (fixture.hasNonNull("expectedIntentKinds")) {
                        List<String> expectedKinds = new ArrayList<>();
                        fixture.get("expectedIntentKinds").forEach(k -> expectedKinds.add(k.asText()));
                        List<String> actualKinds = outcome.plan().intents().stream()
                                .map(i -> String.valueOf(i.get("kind")))
                                .toList();
                        if (!expectedKinds.equals(actualKinds)) {
                            failures.add(id + ": expected kinds " + expectedKinds + ", got " + actualKinds);
                        }
                    }
                    if (fixture.hasNonNull("expectedHref")) {
                        String expectedHref = fixture.get("expectedHref").asText();
                        String actualHref = outcome.plan().intents().stream()
                                .filter(i -> "navigate".equals(i.get("kind")))
                                .map(i -> String.valueOf(i.get("href")))
                                .findFirst().orElse(null);
                        if (!expectedHref.equals(actualHref)) {
                            failures.add(id + ": expected href " + expectedHref + ", got " + actualHref);
                        }
                    }
                }
                case "PLANE_B" -> {
                    if (outcome.guard() != null || outcome.plan() != null) {
                        failures.add(id + ": expected PLANE_B, got " + outcome);
                    }
                }
                default -> failures.add(id + ": unknown expectedRoute " + expectedRoute);
            }
        }
        assertThat(failures).as("All shared fixtures must match 100%").isEmpty();
        double avgMs = ((System.nanoTime() - startNs) / 1_000_000.0) / root.size();
        assertThat(avgMs).as("Average Plane-A compilation time must stay well under 1 ms").isLessThan(1.0);
    }
}
