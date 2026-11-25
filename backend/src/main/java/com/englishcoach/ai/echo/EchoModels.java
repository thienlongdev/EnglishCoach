package com.englishcoach.ai.echo;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Model tiers of Echo (cost-aware routing + multi-provider fallback chains).
 * FAST answers ordinary tutoring and conversational turns (`reasoning.effort = "none"`),
 * Tier C Deep Educational turns preserve analytical reasoning (`deepReasoningEffort` / `strongReasoningEffort`),
 * and STRONG handles multi-source diagnosis / multi-step planning / long corrections within per-learner budgets.
 * Each tier falls back across independent provider families (OpenAI -> Anthropic -> Google Gemini) on relay/outage errors.
 * Ids are configuration (env), never request data.
 */
@Component
public class EchoModels {
    @Value("${echo.models.fast:openai/gpt-6-luna}") private String fast = "openai/gpt-6-luna";
    @Value("${echo.models.fast-fallback:anthropic/claude-haiku-5.5}") private String fastFallback = "anthropic/claude-haiku-5.5";
    @Value("${echo.models.fast-fallbacks:google/gemini-2.5-flash,openai/gpt-4.1-mini,anthropic/claude-haiku-4.5}")
    private String fastFallbacks = "google/gemini-2.5-flash,openai/gpt-4.1-mini,anthropic/claude-haiku-4.5";
    @Value("${echo.models.voice-fast:}") private String voiceFast = "";
    @Value("${echo.models.voice-fast-fallback:}") private String voiceFastFallback = "";
    @Value("${echo.models.voice-fast-fallbacks:}") private String voiceFastFallbacks = "";
    @Value("${echo.models.strong:openai/gpt-6.1-terra}") private String strong = "openai/gpt-6.1-terra";
    @Value("${echo.models.strong-fallback:openai/gpt-6-luna}") private String strongFallback = "openai/gpt-6-luna";
    @Value("${echo.models.strong-fallbacks:google/gemini-2.5-flash,anthropic/claude-haiku-5.5,openai/gpt-4.1-mini}")
    private String strongFallbacks = "google/gemini-2.5-flash,anthropic/claude-haiku-5.5,openai/gpt-4.1-mini";
    @Value("${echo.models.reasoning-effort:none}") private String reasoningEffort = "none";
    @Value("${echo.models.deep-reasoning-effort:low}") private String deepReasoningEffort = "low";
    @Value("${echo.models.strong-reasoning-effort:medium}") private String strongReasoningEffort = "medium";
    @Value("${echo.models.provider-sort:latency}") private String providerSort = "latency";
    /** Deep-analysis (STRONG) turns, inside the message allowance: Free 1 a day; Premium 3 a day and 40 a month (owner 2026-11-20). */
    @Value("${echo.strong.free-per-day:1}") private int strongFreePerDay = 1;
    @Value("${echo.strong.premium-per-day:3}") private int strongPremiumPerDay = 3;
    @Value("${echo.strong.premium-per-month:40}") private int strongPremiumPerMonth = 40;
    @Value("${echo.max-tokens.fast:900}") private int fastMaxTokens = 900;
    @Value("${echo.max-tokens.strong:1400}") private int strongMaxTokens = 1400;
    @Value("${echo.max-tokens.voice:900}") private int voiceMaxTokens = 900;
    /** Operational switch for Route A (deterministic answers); off => every turn goes to a model (also the benchmark's unoptimized variant). */
    @Value("${echo.direct.enabled:true}") private boolean directEnabled = true;

    public EchoModels() {}

    public boolean directEnabled() { return directEnabled; }

    /** Test constructor (preserves exact 2-step primary + fallback behavior unless extra fallbacks are configured). */
    public EchoModels(String fast, String fastFallback, String strong, String strongFallback, int strongFreePerDay) {
        this.fast = fast; this.fastFallback = fastFallback; this.strong = strong; this.strongFallback = strongFallback;
        this.fastFallbacks = ""; this.voiceFast = ""; this.voiceFastFallback = ""; this.voiceFastFallbacks = "";
        this.strongFallbacks = "";
        this.reasoningEffort = "none"; this.deepReasoningEffort = "low"; this.strongReasoningEffort = "medium";
        this.providerSort = "latency";
        this.strongFreePerDay = strongFreePerDay; this.strongPremiumPerDay = 3; this.strongPremiumPerMonth = 40;
        this.fastMaxTokens = 900; this.strongMaxTokens = 1400; this.voiceMaxTokens = 900;
    }

    public EchoModels withFallbackChains(String fastChain, String strongChain) {
        this.fastFallbacks = fastChain == null ? "" : fastChain;
        this.strongFallbacks = strongChain == null ? "" : strongChain;
        return this;
    }

    public String fast() { return normalizeModelId(fast); }
    public String fastFallback() { return normalizeModelId(fastFallback); }
    public String voiceFast() { return voiceFast != null && !voiceFast.isBlank() ? normalizeModelId(voiceFast) : fast(); }
    public String voiceFastFallback() {
        return voiceFastFallback != null && !voiceFastFallback.isBlank() ? normalizeModelId(voiceFastFallback) : fastFallback();
    }
    public String strong() { return normalizeModelId(strong); }
    public String strongFallback() { return normalizeModelId(strongFallback); }
    public String reasoningEffort() { return cleanEffort(reasoningEffort, "none"); }
    public String deepReasoningEffort() { return cleanEffort(deepReasoningEffort, "low"); }
    public String strongReasoningEffort() { return cleanEffort(strongReasoningEffort, "medium"); }

    /**
     * Adaptive reasoning effort:
     * - Tier B / fast conversational & tool turns (`!tierCDeep`): `"none"` for sub-second TTFT.
     * - Tier C Deep Educational Intelligence (`tierCDeep == true`): `"low"` on voice (responsive + analytical)
     *   and `"medium"` on text `STRONG` (`"low"` when text `STRONG` downgraded to `FAST`). Never `"none"`.
     */
    public String reasoningEffortFor(EchoRouter.Route route, boolean voice, boolean tierCDeep) {
        if (!tierCDeep) return reasoningEffort();
        if (voice) {
            String deep = deepReasoningEffort();
            return "none".equals(deep) ? "low" : deep;
        }
        if (route == EchoRouter.Route.STRONG) {
            String strongEff = strongReasoningEffort();
            return "none".equals(strongEff) ? "medium" : strongEff;
        }
        String deep = deepReasoningEffort();
        return "none".equals(deep) ? "low" : deep;
    }

    public String providerSort() {
        return providerSort == null || providerSort.isBlank() ? "latency" : providerSort.trim().toLowerCase(Locale.ROOT);
    }

    /** Ordered, deduplicated multi-model candidate chain for the turn's route and channel. */
    public List<String> candidates(EchoRouter.Route route, boolean voice) {
        Set<String> ordered = new LinkedHashSet<>();
        if (route == EchoRouter.Route.STRONG) {
            addModel(ordered, strong());
            addModel(ordered, strongFallback());
            addCsvModels(ordered, strongFallbacks);
        } else if (voice) {
            addModel(ordered, voiceFast());
            addModel(ordered, voiceFastFallback());
            String chain = (voiceFastFallbacks != null && !voiceFastFallbacks.isBlank()) ? voiceFastFallbacks : fastFallbacks;
            addCsvModels(ordered, chain);
        } else {
            addModel(ordered, fast());
            addModel(ordered, fastFallback());
            addCsvModels(ordered, fastFallbacks);
        }
        return List.copyOf(new ArrayList<>(ordered));
    }

    /**
     * Models in OpenRouter's catalogue whose upstream endpoints reject {@code temperature} (reasoning-native families).
     * Standard chat models and unit-test model ids accept {@code temperature}.
     */
    public static boolean supportsTemperature(String model) {
        if (model == null || model.isBlank()) return true;
        String m = model.trim().toLowerCase(Locale.ROOT);
        if (m.startsWith("openai/gpt-6") || m.startsWith("openai/gpt-5")
                || m.startsWith("openai/o1") || m.startsWith("openai/o3") || m.startsWith("openai/o4")) {
            return false;
        }
        return !m.equals("anthropic/claude-haiku-5.5") && !m.equals("anthropic/claude-sonnet-5.5");
    }

    /**
     * Non-reasoning legacy/chat models that reject {@code reasoning: { effort: ... }} with HTTP 400 on strict endpoints.
     */
    public static boolean supportsReasoningParam(String model) {
        if (model == null || model.isBlank()) return false;
        String m = model.trim().toLowerCase(Locale.ROOT);
        if (m.startsWith("openai/gpt-4o") || m.startsWith("openai/gpt-4.1") || m.startsWith("openai/gpt-3.5")
                || m.startsWith("meta-llama/") || m.startsWith("google/gemini-2.0")) {
            return false;
        }
        return true;
    }

    public int strongPerDay(boolean premium) { return premium ? strongPremiumPerDay : strongFreePerDay; }
    public int strongPremiumPerMonth() { return strongPremiumPerMonth; }
    public int maxTokens(EchoRouter.Route route, boolean voice) {
        if (voice) {
            return route == EchoRouter.Route.STRONG ? Math.max(voiceMaxTokens, Math.min(strongMaxTokens, 1100)) : voiceMaxTokens;
        }
        return route == EchoRouter.Route.STRONG ? strongMaxTokens : fastMaxTokens;
    }

    private static String cleanEffort(String raw, String fallback) {
        if (raw == null || raw.isBlank()) return fallback;
        String v = raw.trim().toLowerCase(Locale.ROOT);
        return Set.of("none", "minimal", "low", "medium", "high").contains(v) ? v : fallback;
    }

    /** Remaps retired OpenRouter slugs (e.g. {@code google/gemini-2.0-flash-001}) to live equivalents. */
    public static String normalizeModelId(String raw) {
        if (raw == null) return "";
        String clean = raw.trim();
        if ("google/gemini-2.0-flash-001".equalsIgnoreCase(clean)) {
            return "google/gemini-2.5-flash";
        }
        return clean;
    }

    private static void addModel(Set<String> set, String raw) {
        String clean = normalizeModelId(raw);
        if (!clean.isEmpty()) set.add(clean);
    }

    private static void addCsvModels(Set<String> set, String csv) {
        if (csv == null || csv.isBlank()) return;
        for (String part : csv.split(",")) {
            addModel(set, part);
        }
    }

    /**
     * USD per million tokens {prompt, completion, cached prompt} read from the OpenRouter catalogue. Used only
     * when the provider response carries no {@code usage.cost}; the provider's own figure always wins.
     */
    static final Map<String, double[]> PRICES = Map.of(
            "openai/gpt-6-luna", new double[]{0.10, 0.50, 0.01},
            "anthropic/claude-haiku-5.5", new double[]{0.10, 0.50, 0.01},
            "anthropic/claude-haiku-4.5", new double[]{1.00, 5.00, 0.10},
            "google/gemini-2.5-flash", new double[]{0.30, 2.50, 0.03},
            "google/gemini-2.5-flash-lite", new double[]{0.10, 0.40, 0.01},
            "openai/gpt-4.1-mini", new double[]{0.40, 1.60, 0.10},
            "openai/gpt-6.1-terra", new double[]{1.00, 5.00, 0.05},
            "openai/gpt-6.1-sol", new double[]{2.00, 10.00, 0.10},
            "deepseek/deepseek-v3.2", new double[]{0.26, 0.38, 0.07},
            "meta-llama/llama-3.3-70b-instruct", new double[]{0.71, 0.71, 0.71});

    public static double estimate(String model, int prompt, int completion, int cached) {
        double[] p = PRICES.get(model);
        if (p == null) return 0;
        int uncached = Math.max(0, prompt - cached);
        return (uncached * p[0] + completion * p[1] + cached * p[2]) / 1_000_000d;
    }
}
