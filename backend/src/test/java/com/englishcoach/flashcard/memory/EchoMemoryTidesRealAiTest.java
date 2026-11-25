package com.englishcoach.flashcard.memory;

import com.englishcoach.reading.service.ContextTranslationService;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.springframework.test.util.ReflectionTestUtils;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Echo Memory Tides — REAL AI validation (release-candidate pass, 2026-11-12). Opt-in only: it calls the configured OpenRouter
 * models through the production {@link ContextTranslationService#completeJson} with the production prompts and validators
 * (CardStudio, MemoryAi), on controlled non-sensitive inputs. It never runs in the normal suite and never prints the key.
 *
 * <pre>
 *   OPENROUTER_API_KEY=... mvn -Dtides.realAi=true -Dtest=EchoMemoryTidesRealAiTest test
 *   (optional -Dtides.model=... -Dtides.fallbackModel=...; defaults = application.yml defaults)
 * </pre>
 * Report: target/memory-tides-real-ai.json (raw answers, parsed drafts, every check and its result). Expected senses below are a
 * small human reference table for the controlled passages, not generated data.
 */
@EnabledIfSystemProperty(named = "tides.realAi", matches = "true")
@EnabledIfEnvironmentVariable(named = "OPENROUTER_API_KEY", matches = ".+")
class EchoMemoryTidesRealAiTest {

    private final ObjectMapper mapper = new ObjectMapper();
    private final List<Map<String, Object>> report = new ArrayList<>();
    private int failures = 0;

    private ContextTranslationService ai() {
        ContextTranslationService s = new ContextTranslationService(mapper);
        ReflectionTestUtils.setField(s, "apiKey", System.getenv("OPENROUTER_API_KEY"));
        // the application's own variable names (application.yml openrouter.* / app.reading.context-ai.*), then its defaults
        ReflectionTestUtils.setField(s, "baseUrl", setting("tides.baseUrl", "OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"));
        ReflectionTestUtils.setField(s, "model", model());
        ReflectionTestUtils.setField(s, "fallbackModel", setting("tides.fallbackModel", "READING_CONTEXT_FALLBACK_MODEL", "anthropic/claude-sonnet-5.5"));
        ReflectionTestUtils.setField(s, "reasoningEffort", "low");
        ReflectionTestUtils.setField(s, "maxTokens", 1800);
        return s;
    }

    private static String setting(String property, String env, String fallback) {
        String p = System.getProperty(property);
        if (p != null && !p.isBlank()) return p.trim();
        String e = System.getenv(env);
        return e != null && !e.isBlank() ? e.trim() : fallback;
    }

    private static String model() {
        return setting("tides.model", "READING_CONTEXT_MODEL", "openai/gpt-6.1-sol");
    }

    /** Nothing key-shaped ever reaches the report, whatever a provider error echoes. */
    static String redact(String text) {
        String key = System.getenv("OPENROUTER_API_KEY");
        String out = text.replaceAll("sk-or-[A-Za-z0-9_-]{8,}", "[redacted]").replaceAll("(?i)bearer\\s+[A-Za-z0-9._-]{8,}", "Bearer [redacted]");
        return key != null && key.length() >= 8 ? out.replace(key, "[redacted]") : out;
    }

    private static final Pattern IPA = Pattern.compile("/[^/\\s]{2,}/|\\[[^\\]]*[ˈˌəɪʊæɑɔʃʒθð][^\\]]*]");
    private static final Pattern CEFR = Pattern.compile("\\b(?:CEFR|[ABC][12])\\b");

    private void check(Map<String, Object> entry, String name, boolean ok, String detail) {
        @SuppressWarnings("unchecked") List<Map<String, Object>> checks = (List<Map<String, Object>>) entry.computeIfAbsent("checks", k -> new ArrayList<>());
        checks.add(Map.of("check", name, "ok", ok, "detail", detail == null ? "" : detail));
        if (!ok) failures++;
    }

    /** Human reference: term → acceptable Vietnamese stems for the sense used in the controlled passage. */
    private static final Map<String, List<String>> SENSES = Map.of(
            "bank", List.of("bờ"),
            "run", List.of("điều hành", "quản lý", "kinh doanh", "vận hành"),
            "look into", List.of("điều tra", "xem xét", "tìm hiểu"),
            "put off", List.of("hoãn", "trì hoãn", "dời"),
            "heavy rain", List.of("mưa lớn", "mưa to", "mưa nặng hạt"),
            "make a decision", List.of("quyết định"),
            "cope with", List.of("đối phó", "đương đầu", "xoay xở"),
            "struggle", List.of("vật lộn", "chật vật", "khó khăn", "đấu tranh"));

    private void studio(ContextTranslationService ai, String label, String passage, String level, int count) throws Exception {
        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("case", "studio:" + label);
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("passage", passage);
        payload.put("learnerLevel", level);
        payload.put("count", count);
        long t0 = System.nanoTime();
        String answer;
        try {
            answer = ai.completeJson(CardStudio.SYSTEM, mapper.writeValueAsString(payload), Math.min(4000, 400 + count * 260));
        } catch (RuntimeException ex) {
            entry.put("error", ex.getClass().getSimpleName() + ": " + ex.getMessage());
            check(entry, "provider answered", false, ex.getMessage());
            report.add(entry);
            return;
        }
        entry.put("latencyMs", (System.nanoTime() - t0) / 1_000_000);
        entry.put("raw", answer);
        CardStudio.Parsed parsed;
        try {
            parsed = CardStudio.parse(mapper, answer, WordForms.normalize(passage), Set.of(), count);
        } catch (IllegalStateException ex) {
            check(entry, "answer is usable JSON", false, ex.getMessage());
            report.add(entry);
            return;
        }
        entry.put("drafts", parsed.drafts());
        entry.put("dropped", parsed.dropped());
        check(entry, "at least one grounded draft", !parsed.drafts().isEmpty(), parsed.drafts().size() + " kept, " + parsed.dropped() + " dropped");
        for (CardStudio.Draft d : parsed.drafts()) {
            String key = d.term().toLowerCase(Locale.ROOT);
            check(entry, "no pronunciation / level invented: " + key,
                    !IPA.matcher(String.valueOf(d.meaningVi()) + " " + d.definitionEn()).find() && !CEFR.matcher(String.valueOf(d.definitionEn())).find(),
                    d.meaningVi() + " | " + d.definitionEn());
            List<String> stems = SENSES.get(key);
            if (stems == null) {
                String base = key.endsWith("s") ? key.substring(0, key.length() - 1) : key;
                stems = SENSES.get(base);
            }
            if (stems != null) {
                String m = d.meaningVi().toLowerCase(Locale.ROOT);
                check(entry, "contextual sense of '" + key + "'", stems.stream().anyMatch(m::contains), d.meaningVi() + " (expected one of " + stems + ")");
            }
        }
        report.add(entry);
    }

    private void forge(ContextTranslationService ai, String mode, String word, String meaning, String example) throws Exception {
        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("case", "forge:" + mode + ":" + word);
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("mode", mode);
        payload.put("word", word);
        payload.put("storedMeaning", meaning);
        payload.put("example", example);
        payload.put("interest", "football");
        try {
            String answer = ai.completeJson(MemoryAi.FORGE_SYSTEM, mapper.writeValueAsString(payload), 900);
            entry.put("raw", answer);
            MemoryAi.Forge f = MemoryAi.parseForge(mapper, answer);
            entry.put("parsed", f);
            String all = String.join(" ", f.paragraphs()) + " " + f.prompts();
            check(entry, "no pronunciation / CEFR invented", !IPA.matcher(all).find() && !CEFR.matcher(all).find(), "");
            if ("EXAMPLE".equals(mode)) check(entry, "examples use the word", WordForms.uses(all, word), "");
        } catch (RuntimeException ex) {
            check(entry, "usable answer", false, ex.getMessage());
        }
        report.add(entry);
    }

    private void fusion(ContextTranslationService ai, String first, String second, String sentence, boolean expectAccepted) throws Exception {
        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("case", "fusion:" + sentence);
        try {
            String answer = ai.completeJson(MemoryAi.FUSION_SYSTEM, mapper.writeValueAsString(Map.of("first", first, "second", second, "sentence", sentence)), 700);
            entry.put("raw", answer);
            MemoryAi.FusionVerdict v = MemoryAi.parseFusion(mapper, answer, sentence, first, second);
            entry.put("verdict", v);
            if (expectAccepted) {
                // a correct sentence may honestly be UNCERTAIN; it must never be refused as wrong
                check(entry, "correct sentence not marked NEEDS_WORK", !"NEEDS_WORK".equals(v.verdict()), v.verdict() + " · " + v.feedbackVi());
            } else {
                check(entry, "faulty sentence not accepted", !v.accepted(), v.verdict() + " · " + v.feedbackVi());
            }
        } catch (RuntimeException ex) {
            check(entry, "usable answer", false, ex.getMessage());
        }
        report.add(entry);
    }

    /** -Dtides.only=studio,forge,fusion,fallback limits a rerun to the groups a fix touched (cost control); default: all. */
    private static boolean want(String group) {
        String only = System.getProperty("tides.only", "");
        return only.isBlank() || List.of(only.split(",")).contains(group);
    }

    /** Provider fallback and total failure, live: an unknown primary model is refused by the provider (no charge). */
    private void fallback() throws Exception {
        ContextTranslationService broken = ai();
        ReflectionTestUtils.setField(broken, "model", "invalid-provider/echo-tides-no-such-model");
        studio(broken, "fallback-served", "The council will look into the delays before the meeting on Friday.", "B1", 2);
        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("case", "both-models-fail");
        ContextTranslationService dead = ai();
        ReflectionTestUtils.setField(dead, "model", "invalid-provider/echo-tides-no-such-model");
        ReflectionTestUtils.setField(dead, "fallbackModel", "invalid-provider/echo-tides-no-such-fallback");
        try {
            dead.completeJson(MemoryAi.FUSION_SYSTEM, "{\"first\":\"cope\",\"second\":\"flood\",\"sentence\":\"We cope with the flood.\"}", 300);
            check(entry, "refused with a controlled 503", false, "an answer came back from unknown models");
        } catch (org.springframework.web.server.ResponseStatusException ex) {
            check(entry, "refused with a controlled 503", ex.getStatusCode().value() == 503, ex.getStatusCode() + " " + ex.getReason());
        }
        report.add(entry);
    }

    @Test
    void realAiQualityReport() throws Exception {
        ContextTranslationService ai = ai();
        if (want("studio")) {
        studio(ai, "short-multi-sense",
                "After the heavy rain, we sat on the bank of the river. My aunt runs a small bakery near the bridge. "
                        + "The council will look into the delays, but the meeting was put off until Friday.", "B1", 6);
        studio(ai, "inflections-collocations",
                "The children struggled to make a decision. Their teachers had coped with worse storms, yet nobody expected the roads to flood so quickly.",
                "A2", 5);
        StringBuilder longText = new StringBuilder();
        String[] sentences = {
                "Coral reefs cover less than one percent of the ocean floor, yet they support about a quarter of all marine species.",
                "Rising sea temperatures cause corals to expel the algae living in their tissues, a process known as bleaching.",
                "Bleached corals are not dead, but they are more vulnerable to disease and starvation.",
                "Scientists are experimenting with heat-tolerant coral strains that could help damaged reefs recover.",
                "Local communities depend on healthy reefs for fishing, tourism and protection from storm surges.",
                "Reducing pollution and overfishing gives reefs a better chance to withstand warmer water.",
        };
        while (longText.length() < 2400) for (String s : sentences) longText.append(s).append(' ');
        studio(ai, "long-passage", longText.toString().trim(), "B2", 10);
        }

        if (want("forge")) {
            String meaning = "đối phó, xoay xở (với một khó khăn)";
            for (String mode : List.of("EXPLAIN", "EXAMPLE", "MNEMONIC", "BREAKDOWN")) forge(ai, mode, "cope", meaning, "The city struggled to cope with the flood.");
        }
        if (want("mnemonic")) {
            forge(ai, "MNEMONIC", "cope", "đối phó, xoay xở (với một khó khăn)", "The city struggled to cope with the flood.");
            forge(ai, "MNEMONIC", "withstand", "chống chịu, chịu đựng được", "Reefs need a chance to withstand warmer water.");
        }

        if (want("fusion")) {
            fusion(ai, "cope", "flood", "The small town learned to cope with the yearly flood.", true);
            fusion(ai, "decision", "struggle", "She struggled for weeks before making the decision to move abroad.", true);
            fusion(ai, "cope", "flood", "The flood coped the town very happily yesterday.", false);
            fusion(ai, "cope", "flood", "Flood cope me with yesterday the.", false);
            fusion(ai, "cope", "flood", "We had to cope with the storm.", false); // second word missing: overruled without trusting the AI
        }
        if (want("fallback")) fallback();

        // malformed / failed answers are covered offline by EchoMemoryTidesLogicTest; a provider failure here would be listed
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("model", model());
        out.put("fallbackModel", setting("tides.fallbackModel", "READING_CONTEXT_FALLBACK_MODEL", "anthropic/claude-sonnet-5.5"));
        out.put("failures", failures);
        out.put("cases", report);
        Path file = Path.of("target", "memory-tides-real-ai.json");
        Files.createDirectories(file.getParent());
        Files.writeString(file, redact(mapper.copy().enable(SerializationFeature.INDENT_OUTPUT).writeValueAsString(out)));
        System.out.println("[MEMORY_TIDES_REAL_AI] report " + file.toAbsolutePath() + " · failed checks: " + failures);
    }
}
