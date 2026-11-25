package com.englishcoach.ai.service;

import com.englishcoach.common.contract.LearningPlanSummarySource;
import com.englishcoach.ai.dto.*;
import com.englishcoach.ai.echo.*;
import com.englishcoach.ai.echo.EchoRouter.Route;
import com.englishcoach.ai.echo.camel.CaMeLPolicyEngine;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PreDestroy;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.*;
import org.springframework.http.*;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Service;
import org.springframework.web.client.*;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Echo's single brain (Echo Intelligence 7.0 + JARVIS Real-Time Streaming). One orchestrator for text and voice:
 * <ol>
 * <li>guard: validation, per-account throttle, extraction refusal, out-of-domain redirect (no provider, no allowance);</li>
 * <li>Route A (DIRECT): navigation without parameters, streak, due cards, allowance answered from the owning services
 *     with zero tokens and one answered message;</li>
 * <li>Route B / C (FAST / STRONG model): the evidence-labelled learner profile ({@link EchoLearnerBrain}), the resolved page
 *     context and the allow-listed typed tools ({@link EchoToolRegistry}) in at most three provider rounds; Round-0 text
 *     streams live even when tools are attached ({@code tool_choice: "auto"}), and {@code cards} / {@code actions} emit
 *     immediately as soon as Round-0 tools complete;</li>
 * <li>accounting: the free daily Echo allowance is reserved before the first provider call and charged once a provider
 *     answered; one {@code echo_ai_turns} row per answered turn with tokens, provider cost and latency.</li>
 * </ol>
 * Without the intelligence beans (slim unit tests) it behaves exactly as the previous single-call Echo.
 */
@Service
@Slf4j
public class OpenRouterChatServiceImpl implements AiChatService {
    @Value("${openrouter.api-key:}") private String apiKey;
    @Value("${openrouter.base-url:https://openrouter.ai/api/v1}") private String baseUrl;
    @Value("${openrouter.default-model:google/gemini-2.5-flash}") private String defaultModel;
    @Value("${echo.secondary-provider.base-url:}") private String secondaryBaseUrl = "";
    @Value("${echo.secondary-provider.api-key:}") private String secondaryApiKey = "";
    @Value("${echo.secondary-provider.fast-model:}") private String secondaryFastModel = "";
    @Value("${echo.secondary-provider.strong-model:}") private String secondaryStrongModel = "";
    @Value("${app.echo.local-llm-enabled:true}") private boolean localLlmEnabled = true;
    @Value("${app.echo.local-llm-url:${ai.service.url:}}") private String localLlmBaseUrl = "";
    @Value("${ai.service-key:}") private String aiServiceKey = "";
    @Value("${app.echo.local-llm-model:echo-local-instruct}") private String localLlmModel = "echo-local-instruct";
    @Value("${app.echo.openrouter-breaker-cooldown-ms:180000}") private long openRouterBreakerCooldownMs = 180_000L;
    @Value("${app.echo.local-llm-warmup:true}") private boolean localLlmWarmupEnabled = true;
    private volatile long openRouterCircuitOpenUntilMs = 0L;
    private final AtomicInteger consecutiveOpenRouterTrips = new AtomicInteger(0);
    private final java.util.concurrent.atomic.AtomicBoolean openRouterHalfOpenProbe = new java.util.concurrent.atomic.AtomicBoolean(false);
    private final RestTemplate restTemplate;
    private final LearnerDnaAggregatorService learnerDnaAggregatorService;
    private final ObjectMapper objectMapper;
    @Autowired(required = false) private LearningPlanSummarySource learningPlan;
    @Autowired(required = false) private com.englishcoach.exams.repository.ExamProfileRepository examProfiles;
    /** Free daily Echo Coach allowance (absent in slim unit tests: then unmetered, exactly as before). */
    @Autowired(required = false) private com.englishcoach.premium.service.PremiumUsageService usage;
    @Autowired(required = false) private com.englishcoach.premium.service.PremiumEntitlementService entitlement;
    // Echo Intelligence 7.0 collaborators (absent in slim unit tests)
    @Autowired(required = false) private EchoModels models;
    @Autowired(required = false) private EchoToolRegistry tools;
    @Autowired(required = false) private EchoLearnerBrain brain;
    @Autowired(required = false) private EchoMemoryService memoryService;
    @Autowired(required = false) private EchoPageContextResolver pages;
    @Autowired(required = false) private EchoUsageLedger ledger;
    @Autowired(required = false) private EchoDestinations destinations;
    @Autowired(required = false) private com.englishcoach.premium.interceptor.AiRequestBulkhead bulkhead;
    @Autowired(required = false) private com.englishcoach.flashcard.service.FlashcardService flashcards;
    @Autowired(required = false) private com.englishcoach.progress.service.UnifiedProgressService progress;

    static final int MAX_ROUNDS = 3, MAX_CALLS_PER_ROUND = 4;
    static final long INITIAL_TURN_BUDGET_MS = 45_000L;
    static final long PROGRESS_EXTENSION_MS = 30_000L;
    static final long MAX_TURN_BUDGET_MS = 95_000L;
    static final long TURN_BUDGET_MS = INITIAL_TURN_BUDGET_MS;
    private static final Set<String> DB_VALID_OUTCOMES = Set.of("ANSWERED", "FILTERED", "FAILED", "REFUSED");
    private static final java.util.regex.Pattern SPEAKING_PROFILE_TARGET_RE = java.util.regex.Pattern.compile(
            "\\b(?:speaking\\s+(?:profile|analytics|stats|statistics|report|summary|scores?|trends?|history)|pronunciation\\s+(?:profile|analytics|stats|statistics|report|summary|scores?|trends?|accuracy|issues)|recurring\\s+pronunciation|ho\\s+so\\s+(?:luyen\\s+noi|noi|phat\\s+am)|thong\\s+ke\\s+(?:luyen\\s+noi|phat\\s+am))\\b");
    private static final java.util.regex.Pattern SPEAKING_PROFILE_INSPECT_CUE_RE = java.util.regex.Pattern.compile(
            "\\b(?:check|review|inspect|analyze|analyse|assess|evaluate|summarize|summarise|summary|tell\\s+me|look\\s+at|read|what|how|which|is\\s+my|are\\s+my|am\\s+i|scores?|trends?|issues?|weak|weakness(?:es)?|accuracy|improv(?:e|ing)|progress|kiem\\s+tra|phan\\s+tich|danh\\s+gia|tom\\s+tat|nhan\\s+xet|cho\\s+(?:minh|toi|em)\\s+biet|xem\\s+giup|co\\s+gi|the\\s+nao|nhu\\s+the\\s+nao|ra\\s+sao|diem|loi|xu\\s+huong|tien\\s+bo|cai\\s+thien)\\b");

    /** Progress-aware sliding turn watchdog: 45s initial pre-output budget, +30s per forward progress step, 95s hard ceiling. */
    static final class TurnWatchdog {
        private final java.util.function.LongSupplier clockNano;
        private final long startedNano;
        private final long hardCeilingNano;
        private volatile long deadlineNano;

        TurnWatchdog() {
            this(System::nanoTime);
        }

        TurnWatchdog(java.util.function.LongSupplier clockNano) {
            this.clockNano = clockNano;
            this.startedNano = clockNano.getAsLong();
            this.hardCeilingNano = this.startedNano + TimeUnit.MILLISECONDS.toNanos(MAX_TURN_BUDGET_MS);
            this.deadlineNano = this.startedNano + TimeUnit.MILLISECONDS.toNanos(INITIAL_TURN_BUDGET_MS);
        }

        synchronized void recordProgress() {
            long now = clockNano.getAsLong();
            long candidate = Math.min(hardCeilingNano, now + TimeUnit.MILLISECONDS.toNanos(PROGRESS_EXTENSION_MS));
            if (candidate > deadlineNano) {
                deadlineNano = candidate;
            }
        }

        boolean isExpired() {
            return clockNano.getAsLong() >= deadlineNano;
        }

        long remainingMs() {
            return Math.max(0L, TimeUnit.NANOSECONDS.toMillis(deadlineNano - clockNano.getAsLong()));
        }

        long budgetFromStartMs() {
            return TimeUnit.NANOSECONDS.toMillis(deadlineNano - startedNano);
        }
    }
    /** Bounded worker pool for streamed turns: a request thread (and its pooled connection) never waits for the provider. */
    private final ThreadPoolExecutor streams = new ThreadPoolExecutor(4, 16, 60, TimeUnit.SECONDS, new ArrayBlockingQueue<>(32), daemon("echo-turn-"));
    /** Bounded worker pool for parallel Kind.READ tool calls and parallel brain+page prompt assembly. */
    private final ThreadPoolExecutor toolPool = new ThreadPoolExecutor(4, 8, 60, TimeUnit.SECONDS, new LinkedBlockingQueue<>(64), daemon("echo-tool-"), new ThreadPoolExecutor.CallerRunsPolicy());

    void useQuota(com.englishcoach.premium.service.PremiumUsageService usage,
                  com.englishcoach.premium.service.PremiumEntitlementService entitlement) {
        this.usage = usage; this.entitlement = entitlement;
    }
    void useIntelligence(EchoModels models, EchoToolRegistry tools, EchoLearnerBrain brain, EchoUsageLedger ledger, EchoDestinations destinations) {
        this.models = models; this.tools = tools; this.brain = brain; this.ledger = ledger; this.destinations = destinations;
    }
    void useMemoryService(EchoMemoryService memoryService) {
        this.memoryService = memoryService;
    }
    void useSecondaryProvider(String baseUrl, String apiKey, String fastModel, String strongModel) {
        this.secondaryBaseUrl = baseUrl == null ? "" : baseUrl;
        this.secondaryApiKey = apiKey == null ? "" : apiKey;
        this.secondaryFastModel = fastModel == null ? "" : fastModel;
        this.secondaryStrongModel = strongModel == null ? "" : strongModel;
    }
    void useLocalLlmFallback(String localUrl, String serviceKey, String model, long breakerCooldownMs) {
        this.localLlmEnabled = localUrl != null && !localUrl.isBlank();
        this.localLlmBaseUrl = localUrl == null ? "" : localUrl;
        this.aiServiceKey = serviceKey == null ? "" : serviceKey;
        if (model != null && !model.isBlank()) this.localLlmModel = model;
        if (breakerCooldownMs > 0) this.openRouterBreakerCooldownMs = breakerCooldownMs;
        this.openRouterCircuitOpenUntilMs = 0L;
        this.consecutiveOpenRouterTrips.set(0);
        this.openRouterHalfOpenProbe.set(false);
    }
    boolean isOpenRouterCircuitOpen() {
        return System.currentTimeMillis() < openRouterCircuitOpenUntilMs;
    }
    public OpenRouterChatServiceImpl() { this(null, new ObjectMapper()); }
    void useLearningPlan(LearningPlanSummarySource source) { learningPlan = source; }
    @Autowired
    public OpenRouterChatServiceImpl(LearnerDnaAggregatorService dna, ObjectMapper mapper) {
        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(10000); factory.setReadTimeout(30000);
        restTemplate = new RestTemplate(factory); learnerDnaAggregatorService = dna; objectMapper = mapper;
    }
    public OpenRouterChatServiceImpl(RestTemplate client, String key, String url, String model) {
        this(client, key, url, model, null, new ObjectMapper());
    }
    public OpenRouterChatServiceImpl(RestTemplate client, String key, String url, String model,
            LearnerDnaAggregatorService dna, ObjectMapper mapper) {
        restTemplate = client; apiKey = key; baseUrl = url; defaultModel = model;
        learnerDnaAggregatorService = dna; objectMapper = mapper == null ? new ObjectMapper() : mapper;
    }

    private record ActiveTurn(long owner, String id) {}
    private final ConcurrentMap<ActiveTurn,EchoProviderStream.Control> active = new ConcurrentHashMap<>();
    private final ScheduledExecutorService heartbeat = Executors.newScheduledThreadPool(2, daemon("echo-heartbeat-"));
    @PreDestroy void stop() {
        active.values().forEach(EchoProviderStream.Control::cancel);
        heartbeat.shutdownNow(); streams.shutdownNow(); toolPool.shutdownNow();
    }
    @Override public void cancelStream(Long owner, String id) {
        if (owner == null) throw new ResponseStatusException(HttpStatus.UNAUTHORIZED);
        var control = active.get(new ActiveTurn(owner,id));
        if (control != null) control.cancel();
    }

    private record Bucket(long minute, int minuteCount, long day, int dayCount) {}
    private final Map<Long, Bucket> buckets = new HashMap<>();
    private synchronized void admit(Long userId) {
        if (userId == null) throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Bạn cần đăng nhập để trò chuyện.");
        long now = System.currentTimeMillis(), minute = now / 60000, day = now / 86400000;
        buckets.entrySet().removeIf(e -> e.getValue().day() != day);
        Bucket previous = buckets.getOrDefault(userId, new Bucket(minute, 0, day, 0));
        int count = previous.minute() == minute ? previous.minuteCount() : 0;
        if (count >= 12 || previous.dayCount() >= 120 || (buckets.size() >= 10000 && !buckets.containsKey(userId)))
            throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS, "Mình cần nghỉ một chút. Bạn thử lại sau nhé.");
        buckets.put(userId, new Bucket(minute, count + 1, day, previous.dayCount() + 1));
    }

    private synchronized void refundAdmit(Long userId) {
        if (userId == null) return;
        Bucket cur = buckets.get(userId);
        if (cur == null) return;
        long now = System.currentTimeMillis(), minute = now / 60000, day = now / 86400000;
        if (cur.day() != day) return;
        int nextMin = cur.minute() == minute ? Math.max(0, cur.minuteCount() - 1) : 0;
        int nextDay = Math.max(0, cur.dayCount() - 1);
        buckets.put(userId, new Bucket(cur.minute(), nextMin, day, nextDay));
    }

    private boolean intelligent() { return tools != null && models != null; }

    // ── one turn: prepare (synchronous checks, allowance) then complete (provider rounds) ──────────────────────────

    /** Everything decided before the provider: either a finished answer, or a job holding the reserved allowance. */
    private record Prepared(AiChatResponse done, Job job) {}

    private final class Job {
        final long userId; final AiChatRequest request; final EchoPolicy.Intent intent; final EchoTurn turn;
        final Route route; final boolean tierCDeep; String model; final String fallback; final List<String> candidates;
        final Long reservation; final boolean holdsBulkhead; final long started = System.nanoTime();
        final TurnWatchdog watchdog = new TurnWatchdog();
        final java.util.concurrent.atomic.AtomicBoolean reservationSettled = new java.util.concurrent.atomic.AtomicBoolean(false);
        final java.util.concurrent.atomic.AtomicBoolean admitRefunded = new java.util.concurrent.atomic.AtomicBoolean(false);
        volatile EchoVisibleText visible;
        volatile boolean stickyFallback = false;
        Job(long userId, AiChatRequest request, EchoPolicy.Intent intent, EchoTurn turn, Route route, boolean tierCDeep,
            String model, String fallback, List<String> candidates, Long reservation, boolean holdsBulkhead) {
            this.userId = userId; this.request = request; this.intent = intent; this.turn = turn; this.route = route;
            this.tierCDeep = tierCDeep; this.model = model; this.fallback = fallback;
            this.candidates = (candidates == null || candidates.isEmpty()) ? List.of(model) : List.copyOf(candidates);
            this.reservation = reservation; this.holdsBulkhead = holdsBulkhead;
        }
    }

    private void settleJobReservationOnce(Job job, boolean charge) {
        if (job == null || !job.reservationSettled.compareAndSet(false, true)) return;
        settleMessage(job.reservation, charge);
    }

    private void cancelAndReleasePreOutputIfUnanswered(Job job, EchoProviderStream.Control control) {
        control.cancel();
        if (job != null && !job.reservationSettled.get()) {
            EchoVisibleText vis = job.visible;
            if (vis == null || vis.sent() == 0) {
                settleJobReservationOnce(job, false);
                if (job.admitRefunded.compareAndSet(false, true)) {
                    refundAdmit(job.userId);
                }
            }
        }
    }

    @Override
    public AiChatResponse chat(Long userId, AiChatRequest request) {
        Prepared prepared = prepare(userId, request, null);
        return prepared.done() != null ? prepared.done() : complete(prepared.job(), null, null);
    }

    private Prepared prepare(Long userId, AiChatRequest request, java.util.function.Consumer<String> status) {
        validateRequest(request); admit(userId);
        long started = System.nanoTime();
        String query = request.messages().get(request.messages().size() - 1).content();
        boolean voice = request.voice(), vi = !request.english();
        if (EchoPolicy.extraction(query)) {
            record(userId, voice, Route.GUARD, "EXTRACTION", null, EchoUsageLedger.Usage.none(), started, "REFUSED");
            return new Prepared(new AiChatResponse(EchoPolicy.REFUSAL, "echo"), null);
        }
        EchoTurn turn = new EchoTurn(userId, vi, voice, query, request.pageContext(), request.salientResources(), status);
        if (intelligent() && destinations != null && models.directEnabled()) {
            Optional<EchoRouter.Command> command = EchoRouter.direct(query);
            if (command.isPresent()) {
                // Zero-quota parity on pure NAVIGATE commands (matching WS Plane A); non-navigation direct DB answers keep quota accounting.
                boolean isPureNav = command.get().type() == EchoRouter.CommandType.NAVIGATE;
                Long directReservation = isPureNav ? null : reserveMessage(userId);
                AiChatResponse direct = null;
                try { direct = direct(turn, command.get()); }
                finally { if (direct == null) settleMessage(directReservation, false); }
                if (direct != null) {
                    settleMessage(directReservation, true);
                    record(userId, voice, Route.DIRECT, command.get().type().name(), null, EchoUsageLedger.Usage.none(), started, "ANSWERED");
                    return new Prepared(direct, null);
                }
            } else if (!turn.salientResources().isEmpty()) {
                String currentPathname = turn.page() != null && turn.page().pathname() != null ? turn.page().pathname() : "/dashboard";
                var fp = com.englishcoach.ai.voice.EchoVoiceFastPathMatcher.evaluate(
                        query, currentPathname, false, false, turn.salientResources());
                if (fp.guard() == null && fp.plan() != null && fp.plan().clauses().size() == 1 && fp.plan().intents().size() == 1) {
                    Map<String, Object> firstIntent = fp.plan().intents().get(0);
                    if ("navigate".equals(firstIntent.get("kind"))
                            && firstIntent.get("href") instanceof String href
                            && EchoDestinations.isAllowedHref(href)) {
                        String label = firstIntent.get("label") instanceof String l && !l.isBlank() ? l : href;
                        AiChatResponse salientNav = directReply(
                                fp.plan().spokenAck(),
                                List.of(),
                                List.of(EchoAction.navigate(href, label, true)));
                        record(userId, voice, Route.DIRECT, "SALIENT_NAVIGATE", null, EchoUsageLedger.Usage.none(), started, "ANSWERED");
                        return new Prepared(salientNav, null);
                    }
                }
            }
        }
        EchoPolicy.Intent intent = EchoPolicy.intent(query);
        if (intent == EchoPolicy.Intent.OUT_OF_DOMAIN) return new Prepared(new AiChatResponse(EchoPolicy.REDIRECT, "echo"), null);
        String activeKey = apiKey == null ? "" : apiKey.trim();
        boolean openRouterKeyValid = !activeKey.isBlank() && !activeKey.startsWith("your_");
        if (!openRouterKeyValid && !hasAnyFallbackProvider()) {
            if (status != null) throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Echo inference unavailable");
            return new Prepared(new AiChatResponse(EchoPolicy.UNAVAILABLE, "echo-unavailable"), null);
        }
        Route route = Route.FAST;
        String rawDefault = defaultModel == null || defaultModel.isBlank() ? "google/gemini-2.5-flash" : defaultModel.trim();
        String model = intelligent() ? EchoModels.normalizeModelId(rawDefault) : rawDefault, fallback = null;
        List<String> candidates = List.of(model);
        boolean tierCDeep = false;
        boolean premium = entitlement != null && entitlement.isUserPremium(userId);
        if (intelligent()) {
            route = EchoRouter.route(intent, query, voice, true);
            if (route == Route.STRONG && ledger != null) {
                if (ledger.strongToday(userId) >= models.strongPerDay(premium)
                        || (premium && ledger.strongThisMonth(userId) >= models.strongPremiumPerMonth())) {
                    route = Route.FAST;
                }
            }
            tierCDeep = EchoRouter.tierCDeepReasoning(intent, query, route);
            candidates = models.candidates(route, voice);
            if (route == Route.STRONG) {
                model = models.strong();
                fallback = models.strongFallback();
            } else if (voice) {
                model = models.voiceFast();
                fallback = models.voiceFastFallback();
            } else {
                model = models.fast();
                fallback = models.fastFallback();
            }
            if (candidates.isEmpty()) {
                candidates = fallback != null && !fallback.isBlank() && !fallback.equals(model)
                        ? List.of(model, fallback) : List.of(model);
            }
        }
        // Allowance reserved before any provider call (both Free daily and Premium daily/monthly).
        Long reservation = reserveMessage(userId);
        boolean held = false;
        if (bulkhead != null && intelligent()) {
            held = bulkhead.tryEnter();
            if (!held) {
                settleMessage(reservation, false);
                throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Echo đang bận một chút. Bạn thử lại sau vài giây nhé.");
            }
        }
        log.info("Echo timings turn={} prepareMs={}", request.turnId(), elapsedMs(started));
        return new Prepared(null, new Job(userId, request, intent, turn, route, tierCDeep, model, fallback, candidates, reservation, held));
    }

    private AiChatResponse complete(Job job, EchoProviderStream.Control control, java.util.function.Consumer<String> sendToken) {
        return complete(job, control, sendToken, null);
    }

    private AiChatResponse complete(Job job, EchoProviderStream.Control control,
                                    java.util.function.Consumer<String> sendToken,
                                    Runnable onRoundToolsComplete) {
        boolean[] readTimedOut = {false};
        boolean[] cancelledAfterVisibleOutput = {false};
        EchoUsageLedger.Usage spent = EchoUsageLedger.Usage.none();
        boolean[] generated = {false};
        Map<?,?>[] roundUsage = {null};
        boolean[] roundCounted = {false};
        EchoVisibleText[] visibleRef = {null};
        String outcome = "FAILED";
        try {
            if (control != null) control.check();
            job.turn.status(job.turn.t("Echo đang chuẩn bị câu trả lời…", "Echo is preparing your answer…"));
            String query = job.turn.userText();
            String prompt = intelligent() ? professorPrompt(job.userId, job.intent, query, job.request, job.turn)
                    : legacyPrompt(job.userId, job.intent, query);
            log.info("Echo timings turn={} contextReadyMs={}", job.request.turnId(), elapsedMs(job.started));
            EchoVisibleText.Mode visMode = job.turn.voice() ? EchoVisibleText.Mode.VOICE : EchoVisibleText.Mode.TEXT;
            java.util.function.Consumer<String> progressSendToken = sendToken == null ? null : token -> {
                job.watchdog.recordProgress();
                sendToken.accept(token);
            };
            var visible = progressSendToken == null ? null : new EchoVisibleText(prompt, job.intent, visMode, progressSendToken);
            visibleRef[0] = visible;
            job.visible = visible;
            List<Map<String, Object>> messages = new ArrayList<>();
            messages.add(new LinkedHashMap<>(Map.of("role", "system", "content", prompt)));
            int start = Math.max(0, job.request.messages().size() - 15);
            for (AiChatMessageDto message : job.request.messages().subList(start, job.request.messages().size())) {
                if (!EchoPolicy.extraction(message.content()))
                    messages.add(new LinkedHashMap<>(Map.of("role", message.role().toLowerCase(Locale.ROOT), "content", message.content().strip())));
            }
            String reply = null;
            StringBuilder streamedPreamble = new StringBuilder();
            int rounds = intelligent() ? MAX_ROUNDS : 1;
            for (int round = 0; round < rounds; round++) {
                boolean last = round == rounds - 1 || job.watchdog.remainingMs() < 20_000L;
                Map<String, Object> body = body(job, round, messages, last);
                if (control != null) {
                    control.check();
                }
                // Keep tool_choice="auto" and expose=true across Rounds 0 and 1 so the model can stream spoken text
                // AND invoke multiple read/navigation/workspace tools in parallel or across Round 0 -> Round 1.
                boolean forcedToolChoice = body.get("tool_choice") instanceof Map<?, ?>;
                boolean expose = !forcedToolChoice;
                boolean allowToolsWithOutput = body.containsKey("tools") && !"none".equals(body.get("tool_choice"));
                roundUsage[0] = null; roundCounted[0] = false; generated[0] = false;
                long roundStart = System.nanoTime();
                int roundNumber = round + 1;
                Map<?, ?> response = call(job, round, body, control, expose && visible != null ? visible::advance : null,
                        u -> roundUsage[0] = u, () -> {
                            if (!generated[0]) log.info("Echo timings turn={} round={} upstreamFirstFrameMs={}",
                                    job.request.turnId(), roundNumber, elapsedMs(roundStart));
                            generated[0] = true;
                        }, allowToolsWithOutput, onRoundToolsComplete);
                if (control != null) control.check();
                spent = account(spent, job.model, roundUsage[0] == null ? response : Map.of("usage",roundUsage[0]));
                roundCounted[0] = true;
                Map<?, ?> message = firstMessage(response);
                List<?> calls = message == null ? List.of() : message.get("tool_calls") instanceof List<?> l ? l : List.of();
                if (!calls.isEmpty() && tools != null && !last) {
                    String roundContent = message.get("content") instanceof String c ? c : "";
                    if (visible != null && visible.sent() > 0 && !roundContent.isBlank()) {
                        String safePreamble = EchoPolicy.output(roundContent, prompt, job.intent);
                        if (!safePreamble.equals(EchoPolicy.REFUSAL) && !safePreamble.equals(EchoPolicy.UNAVAILABLE)) {
                            visible.finishRound(safePreamble);
                            if (streamedPreamble.length() > 0) streamedPreamble.append(' ');
                            streamedPreamble.append(safePreamble);
                        }
                    }
                    Map<String, Object> assistant = new LinkedHashMap<>();
                    assistant.put("role", "assistant");
                    assistant.put("content", roundContent);
                    assistant.put("tool_calls", calls);
                    messages.add(assistant);
                    record ParsedToolCall(String id, String name, String args, boolean overLimit, boolean parallelRead) {}
                    List<ParsedToolCall> parsed = new ArrayList<>();
                    int n = 0;
                    for (Object raw : calls) {
                        if (!(raw instanceof Map<?, ?> call) || !(call.get("function") instanceof Map<?, ?> fn)) continue;
                        String id = String.valueOf(call.get("id"));
                        String name = String.valueOf(fn.get("name"));
                        String argStr = fn.get("arguments") instanceof String a ? a : "{}";
                        boolean over = ++n > MAX_CALLS_PER_ROUND;
                        EchoTool resolved = over ? null : tools.tool(name);
                        boolean parallelRead = !over && resolved != null && resolved.parallelizableRead();
                        parsed.add(new ParsedToolCall(id, name, argStr, over, parallelRead));
                    }
                    long readCount = parsed.stream().filter(ParsedToolCall::parallelRead).count();
                    if (readCount >= 2) {
                        // Execute independent Kind.READ tools concurrently while preserving exact tool_call_id response order.
                        Map<Integer, CompletableFuture<String>> futures = new LinkedHashMap<>();
                        for (int idx = 0; idx < parsed.size(); idx++) {
                            ParsedToolCall pc = parsed.get(idx);
                            if (pc.parallelRead()) {
                                futures.put(idx, CompletableFuture.supplyAsync(
                                        () -> tools.execute(job.turn, pc.name(), pc.args()), toolPool));
                            }
                        }
                        for (int idx = 0; idx < parsed.size(); idx++) {
                            if (control != null) control.check();
                            ParsedToolCall pc = parsed.get(idx);
                            String result;
                            if (pc.overLimit()) {
                                result = "{\"error\":\"too_many_calls\"}";
                            } else if (futures.containsKey(idx)) {
                                try {
                                    result = futures.get(idx).get(12, TimeUnit.SECONDS);
                                } catch (Exception ex) {
                                    futures.get(idx).cancel(true);
                                    result = "{\"error\":\"unavailable\"}";
                                }
                            } else {
                                result = tools.execute(job.turn, pc.name(), pc.args());
                            }
                            job.watchdog.recordProgress();
                            messages.add(new LinkedHashMap<>(Map.of("role", "tool", "tool_call_id", pc.id(), "content", result)));
                        }
                    } else {
                        for (ParsedToolCall pc : parsed) {
                            if (control != null) control.check();
                            String result = pc.overLimit() ? "{\"error\":\"too_many_calls\"}"
                                    : tools.execute(job.turn, pc.name(), pc.args());
                            job.watchdog.recordProgress();
                            messages.add(new LinkedHashMap<>(Map.of("role", "tool", "tool_call_id", pc.id(), "content", result)));
                        }
                    }
                    job.watchdog.recordProgress();
                    // Emit actions and cards immediately when Round-0 tools finish executing (parallel action + speech!)
                    if (onRoundToolsComplete != null) {
                        if (control != null) control.check();
                        onRoundToolsComplete.run();
                    }
                    continue;
                }
                reply = message != null && message.get("content") instanceof String content ? content : null;
                break;
            }
            String safe = EchoPolicy.output(reply, prompt, job.intent);
            if ((safe.equals(EchoPolicy.UNAVAILABLE) || reply == null || reply.isBlank()) && streamedPreamble.length() > 0) {
                safe = streamedPreamble.toString();
            } else if (!safe.equals(EchoPolicy.REFUSAL) && !safe.equals(EchoPolicy.UNAVAILABLE)) {
                safe = EchoPolicy.redactSecrets(safe);
                if (control != null && visible != null && reply != null && !reply.isBlank()) {
                    control.check();
                    visible.finish(safe);
                }
                if (streamedPreamble.length() > 0) {
                    safe = streamedPreamble + " " + safe;
                }
            }
            outcome = safe.equals(EchoPolicy.REFUSAL) && reply != null ? "FILTERED" : safe.equals(EchoPolicy.UNAVAILABLE) ? "FAILED" : "ANSWERED";
            if (control != null && "FAILED".equals(outcome)) throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "Empty provider answer");
            if (control != null && visible != null && "FILTERED".equals(outcome)) {
                control.check();
                visible.finish(safe);
            }
            boolean keepStructured = "ANSWERED".equals(outcome);
            if (keepStructured && intelligent() && memoryService != null && (control == null || !control.isCancelled())) {
                Optional<EchoPolicy.CoachingMode> persistentMode = EchoPolicy.detectPersistentCoachingMode(query);
                if (persistentMode.isPresent()) {
                    try {
                        memoryService.rememberCoachingMode(job.userId, query, persistentMode.get());
                        if (brain != null) brain.forget(job.userId);
                    } catch (RuntimeException ignored) { }
                }
            }
            return new AiChatResponse(safe, job.model, intelligent() ? job.route.name() : null,
                    keepStructured ? job.turn.cards() : List.of(), keepStructured ? job.turn.actions() : List.of());
        } catch (CancellationException ex) {
            boolean timedOut = control != null && control.isTimedOut();
            outcome = "FAILED";
            cancelledAfterVisibleOutput[0] = !timedOut && visibleRef[0] != null && visibleRef[0].sent() > 0;
            log.info("Echo stream {} (timedOut={}); final provider accounting available={}",
                    timedOut ? "TIMEOUT" : "CANCELLED", timedOut, roundUsage[0] != null);
            throw ex;
        } catch (EchoVisibleText.Filtered ex) {
            outcome = "FILTERED"; throw ex;
        } catch (HttpStatusCodeException ex) {
            log.warn("Echo provider HTTP failure: status={}", ex.getStatusCode().value());
            throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, EchoPolicy.UNAVAILABLE);
        } catch (RestClientException ex) {
            // a read time-out means a paid cloud provider may have generated (and billed) an answer; $0 local CPU tier never charges on failure
            String configuredLocalModel = (localLlmModel == null || localLlmModel.isBlank()) ? "echo-local-instruct" : localLlmModel.trim();
            boolean failedOnLocalTier = hasLocalLlmFallback() && Objects.equals(job.model, configuredLocalModel);
            readTimedOut[0] = !failedOnLocalTier && readTimeout(ex);
            log.warn("Echo provider connection failed");
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, EchoPolicy.UNAVAILABLE);
        } finally {
            if (!roundCounted[0] && (roundUsage[0] != null || generated[0]))
                spent = account(spent, job.model, roundUsage[0] == null ? Map.of() : Map.of("usage",roundUsage[0]));
            boolean shouldChargeAllowance = "ANSWERED".equals(outcome)
                    || "FILTERED".equals(outcome)
                    || readTimedOut[0]
                    || cancelledAfterVisibleOutput[0];
            settleJobReservationOnce(job, shouldChargeAllowance);
            if (job.holdsBulkhead) bulkhead.leave();
            record(job.userId, job.turn.voice(), job.route, job.intent.name(), job.model, spent.withTools(job.turn.toolCalls()), job.started,
                    outcome);
        }
    }

    private Map<String, Object> body(Job job, int round, List<Map<String, Object>> messages, boolean last) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("model", job.model);
        body.put("messages", messages);
        if (!intelligent()) {
            body.put("temperature", 0.5); body.put("max_tokens", 1600);
            return body;
        }
        if (EchoModels.supportsTemperature(job.model)) {
            body.put("temperature", 0.4);
        }
        body.put("max_tokens", models.maxTokens(job.route, job.turn.voice()));
        if (!job.turn.voice() && EchoRouter.directTeaching(job.intent, job.turn.userText())
                && EchoPolicy.normalize(job.turn.userText()).matches(".*\\b(chi tiet|in detail|detailed)\\b.*"))
            body.put("max_tokens", Math.max(models.maxTokens(job.route, false), models.maxTokens(Route.STRONG, false)));
        body.put("usage", Map.of("include", true));
        body.put("provider", Map.of("sort", models.providerSort()));
        if (EchoModels.supportsReasoningParam(job.model)) {
            body.put("reasoning", Map.of("effort", models.reasoningEffortFor(job.route, job.turn.voice(), job.tierCDeep)));
        }
        body.put("tools", tools.openAiTools()); // fixed order: a cacheable prefix shared by every learner
        if (last) {
            body.put("tool_choice", "none");
        } else if (round == 0 && tools.tool("get_speaking_profile") != null
                && requestsSpeakingProfileCheck(job.turn.userText())) {
            body.put("tool_choice", Map.of("type", "function", "function", Map.of("name", "get_speaking_profile")));
        } else {
            body.put("tool_choice", "auto");
        }
        return body;
    }

    private static final java.util.regex.Pattern SPEAKING_PROFILE_HYPOTHETICAL_RE = java.util.regex.Pattern.compile(
            "\\b(?:if\\s+(?:i|we|you|someone|a\\s+user|a\\s+learner)\\b|what\\s+(?:would\\s+happen|happens|will\\s+happen)\\s+if\\b|suppose\\s+(?:i|we)\\b|assuming\\s+(?:i|we)\\b|neu\\s+(?:minh|toi|em|tui|nguoi\\s+dung|hoc\\s+vien)\\b|gia\\s+su\\b|(?:dieu|chuyen)\\s+gi\\s+xay\\s+ra\\s+neu\\b)");

    static boolean requestsSpeakingProfileCheck(String query) {
        if (query == null || query.isBlank()) return false;
        EchoSpeechActAnalyzer.UtteranceAnalysis sa = EchoSpeechActAnalyzer.analyze(query);
        if (sa.blocksFastPathOrGuard() || sa.hasQuotedSpan()) {
            // Allow polite quotes only when trusted clauses remain AND no hypothetical condition exists
            if (sa.blocksFastPathOrGuard()) return false;
        }
        String trusted = EchoPolicy.normalize(EchoSpeechActAnalyzer.activeTrustedClausesText(sa));
        if (trusted.isBlank()) return false;
        if (SPEAKING_PROFILE_HYPOTHETICAL_RE.matcher(trusted).find()) return false;
        return SPEAKING_PROFILE_TARGET_RE.matcher(trusted).find()
                && SPEAKING_PROFILE_INSPECT_CUE_RE.matcher(trusted).find();
    }

    private void adaptBodyForCandidate(Job job, Map<String, Object> body, String candidateModel) {
        body.put("model", candidateModel);
        if (!intelligent()) return;
        if (EchoModels.supportsTemperature(candidateModel)) {
            body.putIfAbsent("temperature", 0.4);
        } else {
            body.remove("temperature");
        }
        if (EchoModels.supportsReasoningParam(candidateModel)) {
            body.put("reasoning", Map.of("effort", models.reasoningEffortFor(job.route, job.turn.voice(), job.tierCDeep)));
        } else {
            body.remove("reasoning");
        }
    }

    private static Map<String, Object> sanitizeOptionalProviderFields(Map<String, Object> source) {
        Map<String, Object> clean = new LinkedHashMap<>(source);
        clean.remove("reasoning");
        clean.remove("provider");
        clean.remove("usage");
        clean.remove("temperature");
        clean.put("_omit_stream_options", Boolean.FALSE);
        if ("none".equals(clean.get("tool_choice"))) {
            clean.remove("tools");
            clean.remove("tool_choice");
        }
        return clean;
    }

    private static boolean hasOptionalProviderFields(Map<String, Object> body) {
        return body.containsKey("reasoning") || body.containsKey("provider") || body.containsKey("usage")
                || body.containsKey("temperature")
                || ("none".equals(body.get("tool_choice")) && body.containsKey("tools"));
    }

    private static boolean isRelayOrProxyRejection(int code, String rawBody) {
        if (code != 400 && code != 422 && code != 502 && code != 503) return false;
        if (rawBody == null || rawBody.isBlank()) return false;
        String lower = rawBody.toLowerCase(Locale.ROOT);
        return lower.contains("request path cannot be relayed")
                || lower.contains("cannot be relayed")
                || lower.contains("cloudflare")
                || lower.contains("bad gateway");
    }

    private static boolean isPermanentlyMalformedRequest(int code, String rawBody) {
        if (code != 400 && code != 422) return false;
        if (rawBody == null || rawBody.isBlank()) return false;
        String lower = rawBody.toLowerCase(Locale.ROOT);
        if (lower.contains("unsupported") || lower.contains("unknown parameter") || lower.contains("unrecognized")
                || lower.contains("no endpoints") || lower.contains("not a valid model") || lower.contains("model")) {
            return false;
        }
        return lower.contains("invalid json")
                || lower.contains("messages list")
                || lower.contains("messages must be")
                || lower.contains("maximum context length")
                || lower.contains("context_length_exceeded")
                || lower.contains("prompt is too long");
    }

    private static boolean isModelOutageOrUnsupported(int code) {
        // 401/402/403 are account-level rejections handled directly; 400/404/408/409/422/425/429/5xx are model/provider-level failures.
        return code == 400 || code == 404 || code == 408
                || code == 409 || code == 422 || code == 425 || code == 429 || code >= 500;
    }

    private boolean canAdvanceCandidate(Job job, int currentIdx, boolean roundGeneratedAny) {
        return !roundGeneratedAny
                && currentIdx + 1 < job.candidates.size()
                && job.watchdog.remainingMs() >= 11_000L;
    }

    /**
     * Resilient 3-tier provider exchange:
     * <ol>
     *   <li>Primary: OpenRouter ({@code FAST}/{@code STRONG} multi-model cascade + parameter-sanitized retry + cancellable non-streaming
     *       JSON relay bridge + {@code 180s -> 600s -> 1800s} half-open circuit breaker on OpenRouter ingress/account failure);</li>
     *   <li>Secondary: Optional external OpenAI-compatible backup ({@code SECONDARY_LLM_BASE_URL} + {@code SECONDARY_LLM_API_KEY});</li>
     *   <li>Tertiary: Built-in GPU host local instruct failover ({@code ${app.echo.local-llm-url}/api/v1/coach/chat/completions}
     *       authenticated with {@code X-EC-Service-Key}), sticky across multi-round tool calls in {@code 0 ms} with zero
     *       non-streaming retry stampedes.</li>
     * </ol>
     */
    private Map<?, ?> call(Job job, int round, Map<String, Object> body, EchoProviderStream.Control control,
                           java.util.function.Consumer<String> content, java.util.function.Consumer<Map<?,?>> usageSink,
                           Runnable accepted, boolean allowToolsWithOutput, Runnable onRoundToolsComplete) {
        String endpoint = (baseUrl == null ? "https://openrouter.ai/api/v1" : baseUrl).replaceAll("/+$", "") + "/chat/completions";
        RuntimeException lastFailure = null;
        boolean[] openRouterIngressFailed = {false};
        boolean circuitTrippedThisCall = false;
        boolean openRouterSucceeded = false;
        boolean wasHalfOpenProbe = openRouterCircuitOpenUntilMs > 0L;
        java.util.function.Consumer<String> cleanStreamContent = content == null ? null : raw -> {
            String stripped = stripCumulativeThink(raw);
            if (!stripped.isEmpty()) content.accept(stripped);
        };

        if (shouldTryOpenRouter(job, round)) {
            try {
                for (int idx = 0; idx < job.candidates.size(); idx++) {
                    if (control != null) control.check();
                    String candidate = job.candidates.get(idx);
                    job.model = candidate;
                    Map<String, Object> attemptBody = new LinkedHashMap<>(body);
                    adaptBodyForCandidate(job, attemptBody, candidate);

                    boolean[] roundGenerated = {false};
                    Runnable trackedAccepted = () -> {
                        roundGenerated[0] = true;
                        if (accepted != null) accepted.run();
                    };
                    java.util.function.Function<Map<String, Object>, Map<?, ?>> exchange = payload -> {
                        Map<String, Object> wire = new LinkedHashMap<>(payload);
                        if (control == null) {
                            wire.remove("_omit_stream_options");
                            return sanitizeThinkResponse(post(wire));
                        }
                        return sanitizeThinkResponse(EchoProviderStream.post(endpoint, apiKey.trim(), wire, objectMapper, control,
                                cleanStreamContent, usageSink, trackedAccepted, allowToolsWithOutput));
                    };

                    try {
                        Map<?, ?> ok = exchange.apply(attemptBody);
                        openRouterSucceeded = true;
                        recordOpenRouterSuccess();
                        return ok;
                    } catch (CancellationException cancelled) {
                        throw cancelled;
                    } catch (HttpStatusCodeException ex) {
                        int code = ex.getStatusCode().value();
                        String errBody = ex.getResponseBodyAsString();

                        // Account-level rejections (401 invalid/expired key, 402 credits exhausted, 403 account/geo blocked):
                        // never retry other OpenRouter models with the same key; trip breaker and fail over when Tier 2/3 exists.
                        if (code == 401 || code == 402 || code == 403) {
                            lastFailure = ex;
                            if (!roundGenerated[0] && hasAnyFallbackProvider()) {
                                log.warn("Echo OpenRouter account rejection ({}) on {}: {}", code, candidate, providerErrorSnippet(errBody));
                                tripOpenRouterCircuit("account_" + code);
                                circuitTrippedThisCall = true;
                                break;
                            }
                            throw ex;
                        }

                        boolean relayBlocked = isRelayOrProxyRejection(code, errBody);
                        // Fast-trip when fallback exists: 1 request (~50-150 ms) instead of 3 doomed requests!
                        if (relayBlocked && !roundGenerated[0] && hasAnyFallbackProvider()) {
                            lastFailure = ex;
                            log.warn("Echo OpenRouter refused {} with {}: {}", candidate, code, providerErrorSnippet(errBody));
                            tripOpenRouterCircuit("relay_" + code);
                            circuitTrippedThisCall = true;
                            break;
                        }

                        // Skip Steps 1-2 when relayBlocked is already proven (go straight to Step 3 non-stream check)
                        // or when the request payload itself is permanently malformed.
                        boolean malformedRequest = !relayBlocked && isPermanentlyMalformedRequest(code, errBody);
                        if (!relayBlocked && !malformedRequest) {
                            // Step 1: If model rejected tools + tool_choice="none" with 400, strip tools and retry on same model
                            if ((code == 400 || code == 422) && !roundGenerated[0]
                                    && "none".equals(attemptBody.get("tool_choice")) && attemptBody.containsKey("tools")) {
                                log.warn("Echo model {} rejected tools with tool_choice=none ({}), retrying without tools", candidate, code);
                                attemptBody.remove("tools");
                                attemptBody.remove("tool_choice");
                                try {
                                    Map<?, ?> ok = exchange.apply(attemptBody);
                                    openRouterSucceeded = true;
                                    recordOpenRouterSuccess();
                                    return ok;
                                } catch (CancellationException c) {
                                    throw c;
                                } catch (HttpStatusCodeException retryEx) {
                                    ex = retryEx;
                                    code = retryEx.getStatusCode().value();
                                    errBody = retryEx.getResponseBodyAsString();
                                    if (code == 401 || code == 402 || code == 403) {
                                        lastFailure = retryEx;
                                        if (!roundGenerated[0] && hasAnyFallbackProvider()) {
                                            tripOpenRouterCircuit("account_" + code);
                                            circuitTrippedThisCall = true;
                                            break;
                                        }
                                        throw retryEx;
                                    }
                                    relayBlocked = isRelayOrProxyRejection(code, errBody);
                                    malformedRequest = !relayBlocked && isPermanentlyMalformedRequest(code, errBody);
                                } catch (EchoProviderStream.PreOutputStreamException preEx) {
                                    lastFailure = preEx;
                                    openRouterIngressFailed[0] = true;
                                    if (canAdvanceCandidate(job, idx, roundGenerated[0])) continue;
                                    break;
                                }
                            }

                            // Step 2: Parameter-sanitized retry when provider rejects optional reasoning/provider/temperature/usage fields
                            if (!relayBlocked && !malformedRequest && (code == 400 || code == 422)
                                    && !roundGenerated[0] && hasOptionalProviderFields(attemptBody)) {
                                Map<String, Object> sanitized = sanitizeOptionalProviderFields(attemptBody);
                                log.warn("Echo model {} returned {}, retrying with sanitized core parameters", candidate, code);
                                try {
                                    Map<?, ?> ok = exchange.apply(sanitized);
                                    openRouterSucceeded = true;
                                    recordOpenRouterSuccess();
                                    return ok;
                                } catch (CancellationException c) {
                                    throw c;
                                } catch (HttpStatusCodeException sanEx) {
                                    ex = sanEx;
                                    code = sanEx.getStatusCode().value();
                                    errBody = sanEx.getResponseBodyAsString();
                                    if (code == 401 || code == 402 || code == 403) {
                                        lastFailure = sanEx;
                                        if (!roundGenerated[0] && hasAnyFallbackProvider()) {
                                            tripOpenRouterCircuit("account_" + code);
                                            circuitTrippedThisCall = true;
                                            break;
                                        }
                                        throw sanEx;
                                    }
                                    relayBlocked = isRelayOrProxyRejection(code, errBody);
                                    malformedRequest = !relayBlocked && isPermanentlyMalformedRequest(code, errBody);
                                } catch (EchoProviderStream.PreOutputStreamException preEx) {
                                    lastFailure = preEx;
                                    openRouterIngressFailed[0] = true;
                                    if (canAdvanceCandidate(job, idx, roundGenerated[0])) continue;
                                    break;
                                }
                            }
                        }

                        // Step 3: If edge proxy blocked SSE relay ("Request path cannot be relayed") and no external fallback
                        // short-circuited above, attempt a single cancellable non-streaming JSON bridge
                        if (control != null && !roundGenerated[0] && relayBlocked) {
                            Map<String, Object> nonStreamBody = sanitizeOptionalProviderFields(attemptBody);
                            nonStreamBody.remove("_omit_stream_options");
                            nonStreamBody.remove("stream");
                            nonStreamBody.remove("stream_options");
                            try {
                                log.warn("Echo SSE relay rejected ({}) on {}, attempting non-streaming JSON fallback", code, candidate);
                                Map<?, ?> ok = sanitizeThinkResponse(postWithStreamBridge(
                                        nonStreamBody, control, cleanStreamContent, usageSink, trackedAccepted, allowToolsWithOutput));
                                openRouterSucceeded = true;
                                recordOpenRouterSuccess();
                                return ok;
                            } catch (CancellationException c) {
                                throw c;
                            } catch (RuntimeException bridgeEx) {
                                lastFailure = bridgeEx;
                            }
                        }

                        lastFailure = ex;
                        if (relayBlocked || code == 429 || code >= 500) openRouterIngressFailed[0] = true;
                        if (relayBlocked && !roundGenerated[0] && hasAnyFallbackProvider()) {
                            log.warn("Echo OpenRouter refused {} with {}: {}", candidate, code, providerErrorSnippet(errBody));
                            tripOpenRouterCircuit("relay_" + code);
                            circuitTrippedThisCall = true;
                            break;
                        }
                        if (malformedRequest || !isModelOutageOrUnsupported(code) || !canAdvanceCandidate(job, idx, roundGenerated[0])) {
                            if (roundGenerated[0] || !hasAnyFallbackProvider()) throw ex;
                            break;
                        }
                        log.warn("Echo model {} unavailable ({}), advancing to fallback {}", candidate, code, job.candidates.get(idx + 1));
                    } catch (EchoProviderStream.PreOutputStreamException pre) {
                        if (control != null) control.check();
                        if (control != null && !roundGenerated[0] && pre.getMessage() != null && pre.getMessage().contains("media type")) {
                            Map<String, Object> nonStreamBody = sanitizeOptionalProviderFields(attemptBody);
                            nonStreamBody.remove("_omit_stream_options");
                            try {
                                Map<?, ?> ok = sanitizeThinkResponse(postWithStreamBridge(
                                        nonStreamBody, control, cleanStreamContent, usageSink, trackedAccepted, allowToolsWithOutput));
                                openRouterSucceeded = true;
                                recordOpenRouterSuccess();
                                return ok;
                            } catch (CancellationException c) {
                                throw c;
                            } catch (RuntimeException ignored) { }
                        }
                        lastFailure = pre;
                        openRouterIngressFailed[0] = true;
                        if (!canAdvanceCandidate(job, idx, roundGenerated[0])) {
                            if (roundGenerated[0] || !hasAnyFallbackProvider()) throw pre;
                            break;
                        }
                        log.warn("Echo model {} stream failed before first token, advancing to fallback {}", candidate, job.candidates.get(idx + 1));
                    } catch (RestClientException ex) {
                        boolean beforeConnection = ex.getCause() instanceof java.net.ConnectException
                                || ex.getCause() instanceof java.net.UnknownHostException
                                || ex.getCause() instanceof java.net.http.HttpConnectTimeoutException;
                        lastFailure = ex;
                        if (beforeConnection) openRouterIngressFailed[0] = true;
                        if ((control != null && !beforeConnection) || readTimeout(ex) || !canAdvanceCandidate(job, idx, roundGenerated[0])) {
                            if (readTimeout(ex) || (control != null && !beforeConnection) || !hasAnyFallbackProvider()) throw ex;
                            break;
                        }
                        log.warn("Echo model {} unreachable, advancing to fallback {}", candidate, job.candidates.get(idx + 1));
                    }
                }
                if (!circuitTrippedThisCall && openRouterIngressFailed[0] && hasAnyFallbackProvider()) {
                    tripOpenRouterCircuit("cascade_exhausted");
                }
            } finally {
                if (wasHalfOpenProbe && !openRouterSucceeded && openRouterCircuitOpenUntilMs <= System.currentTimeMillis()) {
                    long holdOff = Math.min(30_000L, Math.max(5_000L, openRouterBreakerCooldownMs));
                    openRouterCircuitOpenUntilMs = System.currentTimeMillis() + holdOff;
                }
                openRouterHalfOpenProbe.set(false);
            }
        }

        if (hasAnyFallbackProvider()) {
            // Tier 2 Secondary: Optional configured cloud OpenAI-compatible backup
            if (hasSecondaryProvider()) {
                try {
                    Map<?, ?> secRes = callSecondaryProvider(job, body, control, content, usageSink, accepted, allowToolsWithOutput);
                    job.stickyFallback = true;
                    return secRes;
                } catch (CancellationException c) {
                    throw c;
                } catch (RuntimeException secEx) {
                    log.warn("Echo secondary provider failover failed ({})", secEx.getClass().getSimpleName());
                    if (lastFailure == null) lastFailure = secEx;
                }
            }

            // Tier 3 Tertiary: Automatic built-in GPU host local instruct failover (/api/v1/coach/chat/completions + X-EC-Service-Key)
            if (hasLocalLlmFallback()) {
                try {
                    Map<?, ?> localRes = callLocalLlmProvider(job, body, control, content, usageSink, accepted, allowToolsWithOutput);
                    job.stickyFallback = true;
                    return localRes;
                } catch (CancellationException c) {
                    throw c;
                } catch (RuntimeException localEx) {
                    if (localEx instanceof HttpStatusCodeException localHttp) {
                        log.warn("Echo tertiary local LLM failover failed ({} {}: {})", localEx.getClass().getSimpleName(),
                                localHttp.getStatusCode().value(), providerErrorSnippet(localHttp.getResponseBodyAsString()));
                    } else {
                        log.warn("Echo tertiary local LLM failover failed ({})", localEx.getClass().getSimpleName());
                    }
                    if (lastFailure == null) lastFailure = localEx;
                }
            }
        }

        throw lastFailure != null ? lastFailure : new HttpServerErrorException(HttpStatus.BAD_GATEWAY);
    }

    private boolean hasSecondaryProvider() {
        return secondaryBaseUrl != null && !secondaryBaseUrl.isBlank()
                && secondaryApiKey != null && !secondaryApiKey.isBlank();
    }

    private boolean hasLocalLlmFallback() {
        return localLlmEnabled
                && localLlmBaseUrl != null && !localLlmBaseUrl.isBlank()
                && aiServiceKey != null && !aiServiceKey.isBlank();
    }

    private boolean hasAnyFallbackProvider() {
        return hasSecondaryProvider() || hasLocalLlmFallback();
    }

    private boolean shouldTryOpenRouter(Job job, int round) {
        if (job != null && job.stickyFallback) return false;
        String activeKey = apiKey == null ? "" : apiKey.trim();
        if (activeKey.isBlank() || activeKey.startsWith("your_")) {
            return !hasAnyFallbackProvider();
        }
        if (!hasAnyFallbackProvider()) return true;
        long until = openRouterCircuitOpenUntilMs;
        if (until <= 0L) return true;
        long now = System.currentTimeMillis();
        if (now < until) return false;
        if (round > 0) return false;
        // Half-open: allow one Round-0 probe turn through to test whether OpenRouter has healed
        return openRouterHalfOpenProbe.compareAndSet(false, true);
    }

    private void recordOpenRouterSuccess() {
        openRouterCircuitOpenUntilMs = 0L;
        consecutiveOpenRouterTrips.set(0);
        openRouterHalfOpenProbe.set(false);
    }

    private void tripOpenRouterCircuit(String reason) {
        int trips = consecutiveOpenRouterTrips.incrementAndGet();
        long base = Math.max(5_000L, openRouterBreakerCooldownMs);
        long cooldown;
        if (trips <= 1) {
            cooldown = base;
        } else if (trips == 2) {
            cooldown = base == 180_000L ? 600_000L : Math.min(1_800_000L, base * 3L);
        } else {
            cooldown = base == 180_000L ? 1_800_000L : Math.min(1_800_000L, base * 10L);
        }
        openRouterCircuitOpenUntilMs = System.currentTimeMillis() + cooldown;
        openRouterHalfOpenProbe.set(false);
        log.warn("Echo OpenRouter circuit breaker OPEN for {} ms (trip={}, reason={})", cooldown, trips, reason);
    }

    /** First 160 characters of a provider error body, secrets redacted (provider messages carry no learner text). */
    static String providerErrorSnippet(String body) {
        if (body == null || body.isBlank()) return "(empty)";
        String clean = EchoPolicy.redactSecrets(body).replaceAll("\\s+", " ").trim();
        return clean.length() > 160 ? clean.substring(0, 160) + "…" : clean;
    }

    /**
     * Primes the local tier's static prompt prefix ([PROFESSOR policy] + [tool schemas], ~3,500 tokens) once after start-up,
     * so the first learner turn that needs the CPU fallback does not pay the ~40 s cold prefill (incident 2026-11-25:
     * OpenRouter refused all inference from production and the local tier became the only answering tier). Best effort,
     * one request, never blocks start-up; disabled with {@code app.echo.local-llm-warmup=false}.
     */
    @org.springframework.context.event.EventListener(org.springframework.boot.context.event.ApplicationReadyEvent.class)
    public void warmLocalLlmPrefix() {
        if (!localLlmWarmupEnabled || !hasLocalLlmFallback() || tools == null) return;
        Thread warm = new Thread(() -> {
            long started = System.nanoTime();
            try {
                Map<String, Object> payload = new LinkedHashMap<>();
                payload.put("model", localLlmModel);
                payload.put("messages", List.of(
                        Map.of("role", "system", "content", EchoPolicy.professorPrompt("{}", null, true, true,
                                EchoPolicy.CoachingMode.DEFAULT, List.of(), objectMapper)),
                        Map.of("role", "user", "content", "Hi")));
                payload.put("tools", tools.openAiTools());
                payload.put("tool_choice", "auto");
                payload.put("max_tokens", 1);
                payload.put("temperature", 0.0);
                payload.put("stream", false);
                String warmEndpoint = resolveLocalLlmEndpoint(localLlmBaseUrl);
                var reqBuilder = java.net.http.HttpRequest.newBuilder(java.net.URI.create(warmEndpoint))
                        .timeout(java.time.Duration.ofSeconds(180))
                        .header("Content-Type", "application/json")
                        .header("X-EC-Service-Key", aiServiceKey.trim())
                        .header("X-EC-Warmup", "1");
                if (warmEndpoint.startsWith("http://")) {
                    reqBuilder.version(java.net.http.HttpClient.Version.HTTP_1_1);
                }
                var request = reqBuilder
                        .POST(java.net.http.HttpRequest.BodyPublishers.ofByteArray(objectMapper.writeValueAsBytes(payload)))
                        .build();
                var response = EchoProviderStream.HTTP.send(request, java.net.http.HttpResponse.BodyHandlers.ofString());
                log.info("Echo local LLM prefix warm-up finished: status={} ms={}", response.statusCode(), elapsedMs(started));
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
            } catch (Exception ex) {
                log.info("Echo local LLM prefix warm-up skipped ({}) after {} ms", ex.getClass().getSimpleName(), elapsedMs(started));
            }
        }, "echo-local-llm-warmup");
        warm.setDaemon(true);
        warm.start();
    }

    static String resolveLocalLlmEndpoint(String rawBase) {
        String clean = (rawBase == null ? "http://localhost:8000" : rawBase.trim()).replaceAll("/+$", "");
        if (clean.endsWith("/chat/completions")) return clean;
        if (clean.endsWith("/api/v1/coach")) return clean + "/chat/completions";
        if (clean.endsWith("/api/v1")) return clean + "/coach/chat/completions";
        return clean + "/api/v1/coach/chat/completions";
    }

    private Map<?, ?> callSecondaryProvider(Job job, Map<String, Object> body, EchoProviderStream.Control control,
                                            java.util.function.Consumer<String> content,
                                            java.util.function.Consumer<Map<?, ?>> usageSink,
                                            Runnable accepted, boolean allowToolsWithOutput) {
        if (control != null) control.check();
        String secEndpoint = secondaryBaseUrl.trim().replaceAll("/+$", "") + "/chat/completions";
        String secModel = (job.route == Route.STRONG && secondaryStrongModel != null && !secondaryStrongModel.isBlank())
                ? EchoModels.normalizeModelId(secondaryStrongModel)
                : (secondaryFastModel != null && !secondaryFastModel.isBlank()
                ? EchoModels.normalizeModelId(secondaryFastModel)
                : EchoModels.normalizeModelId(defaultModel == null || defaultModel.isBlank() ? "google/gemini-2.5-flash" : defaultModel));
        job.model = secModel;
        Map<String, Object> secBody = sanitizeOptionalProviderFields(body);
        secBody.remove("_omit_stream_options");
        secBody.put("model", secModel);
        secBody.put("temperature", 0.35);
        log.warn("Echo primary ingress unavailable; failing over to secondary provider model {}", secModel);
        String bearer = secondaryApiKey.trim();
        java.util.function.Consumer<String> cleanContent = content == null ? null : raw -> {
            String stripped = stripCumulativeThink(raw);
            if (!stripped.isEmpty()) content.accept(stripped);
        };
        if (control == null) {
            return sanitizeThinkResponse(postToEndpoint(secEndpoint, bearer, "", secBody));
        }
        try {
            Map<?, ?> res = EchoProviderStream.post(secEndpoint, bearer, "", secBody, objectMapper, control,
                    cleanContent, usageSink, accepted, allowToolsWithOutput);
            return sanitizeThinkResponse(res);
        } catch (HttpStatusCodeException | EchoProviderStream.PreOutputStreamException secStreamErr) {
            control.check();
            Map<?, ?> res = postWithStreamBridgeToEndpoint(secEndpoint, bearer, "", secBody, control,
                    cleanContent, usageSink, accepted, allowToolsWithOutput);
            return sanitizeThinkResponse(res);
        }
    }

    private Map<?, ?> callLocalLlmProvider(Job job, Map<String, Object> body, EchoProviderStream.Control control,
                                           java.util.function.Consumer<String> content,
                                           java.util.function.Consumer<Map<?, ?>> usageSink,
                                           Runnable accepted, boolean allowToolsWithOutput) {
        if (control != null) control.check();
        String localEndpoint = resolveLocalLlmEndpoint(localLlmBaseUrl);
        String modelId = (localLlmModel == null || localLlmModel.isBlank()) ? "echo-local-instruct" : localLlmModel.trim();
        job.model = modelId;
        Map<String, Object> localBody = buildLocalLlmPayload(job, body, modelId);
        boolean localAllowTools = localBody.containsKey("tools")
                && !"none".equals(localBody.get("tool_choice"))
                && allowToolsWithOutput;
        String svcKey = aiServiceKey.trim();
        log.info("Echo routing turn={} to local instruct failover {} (toolChoice={})",
                job.request.turnId(), modelId, localBody.get("tool_choice"));
        java.util.function.Consumer<String> cleanContent = content == null ? null : raw -> {
            String stripped = stripCumulativeThink(raw);
            if (!stripped.isEmpty()) content.accept(stripped);
        };
        if (control == null) {
            return sanitizeThinkResponse(postToEndpoint(localEndpoint, "", svcKey, localBody));
        }
        try {
            Map<?, ?> res = EchoProviderStream.post(localEndpoint, "", svcKey, localBody, objectMapper, control,
                    cleanContent, usageSink, accepted, localAllowTools);
            return sanitizeThinkResponse(res);
        } catch (EchoProviderStream.PreOutputStreamException localPreErr) {
            control.check();
            // Only bridge non-SSE media types (e.g. JSON mock servers); NEVER fire a second non-streaming request on 4xx/5xx/timeouts!
            if (localPreErr.getMessage() != null && localPreErr.getMessage().contains("media type")) {
                Map<?, ?> res = postWithStreamBridgeToEndpoint(localEndpoint, "", svcKey, localBody, control,
                        cleanContent, usageSink, accepted, localAllowTools);
                return sanitizeThinkResponse(res);
            }
            throw localPreErr;
        }
    }

    /**
     * Full multi-round tool-parity payload for local {@code Qwen3-4B-Instruct} failover:
     * preserves the exact static {@code [PROFESSOR + tools]} prefix (for KV-cache hit in {@code echo_local_llm.py}),
     * full multi-round {@code messages} (including Round-0 {@code assistant} {@code tool_calls} and {@code role: "tool"}
     * JSON results), {@code tool_choice} ({@code "auto"} or forced function {@link Map} on Round 0, {@code "none"} on
     * final synthesis round), and tightened voice {@code max_tokens} ({@code 520/210/170} when tools active,
     * {@code 180/135} on synthesis).
     */
    private Map<String, Object> buildLocalLlmPayload(Job job, Map<String, Object> originalBody, String modelId) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("model", modelId);
        payload.put("messages", originalBody.get("messages"));
        payload.put("temperature", 0.3);
        if (tools != null && originalBody.containsKey("tools")) {
            Object rawToolChoice = originalBody.get("tool_choice");
            Object toolChoice = "none".equals(rawToolChoice)
                    ? "none"
                    : (rawToolChoice instanceof Map<?, ?> ? rawToolChoice : "auto");
            boolean allowTools = !"none".equals(toolChoice);
            payload.put("tools", tools.openAiTools());
            payload.put("tool_choice", toolChoice);
            payload.put("max_tokens", job.turn.voice()
                    ? resolveLocalVoiceMaxTokens(job, allowTools)
                    : (allowTools ? 640 : 560));
        } else {
            payload.put("max_tokens", job.turn.voice() ? resolveLocalVoiceMaxTokens(job, false) : 560);
        }
        return payload;
    }

    private static int resolveLocalVoiceMaxTokens(Job job, boolean allowTools) {
        boolean richTeachingOrDeep = job.tierCDeep
                || job.route == Route.STRONG
                || EchoRouter.directTeaching(job.intent, job.turn.userText());
        if (allowTools) {
            if (job.turn.provenance().hasFlashcardSaveCue()) return 520;
            if (richTeachingOrDeep) return 210;
            return 170;
        }
        return richTeachingOrDeep ? 180 : 135;
    }

    /** Strips completed/unclosed {@code <think>} spans and holds trailing partial {@code <think>} prefixes on cumulative streams. */
    static String stripCumulativeThink(String cumulativeRaw) {
        if (cumulativeRaw == null || cumulativeRaw.isEmpty()) return "";
        String cleaned = stripThinkBlocks(cumulativeRaw);
        int maxHold = Math.min(cleaned.length(), 6);
        String tag = "<think>";
        for (int len = maxHold; len >= 1; len--) {
            if (cleaned.regionMatches(true, cleaned.length() - len, tag, 0, len)) {
                return cleaned.substring(0, cleaned.length() - len);
            }
        }
        return cleaned;
    }

    static String stripThinkBlocks(String text) {
        if (text == null || text.isEmpty()) return text;
        if (!text.contains("<think>") && !text.contains("</think>")) return text;
        return text.replaceAll("(?s)<think>.*?</think>\\s*", "")
                .replaceAll("(?s)<think>.*$", "")
                .replace("</think>", "")
                .stripLeading();
    }

    @SuppressWarnings("unchecked")
    private static Map<?, ?> sanitizeThinkResponse(Map<?, ?> response) {
        if (response == null || !(response.get("choices") instanceof List<?> choices) || choices.isEmpty()) return response;
        if (!(choices.get(0) instanceof Map<?, ?> first) || !(first.get("message") instanceof Map<?, ?> msg)) return response;
        if (!(msg.get("content") instanceof String content) || (!content.contains("<think>") && !content.contains("</think>"))) {
            return response;
        }
        Map<String, Object> cleanMsg = new LinkedHashMap<>((Map<String, Object>) msg);
        cleanMsg.put("content", stripThinkBlocks(content));
        Map<String, Object> cleanFirst = new LinkedHashMap<>((Map<String, Object>) first);
        cleanFirst.put("message", cleanMsg);
        Map<String, Object> cleanRoot = new LinkedHashMap<>((Map<String, Object>) response);
        List<Object> cleanChoices = new ArrayList<>(choices);
        cleanChoices.set(0, cleanFirst);
        cleanRoot.put("choices", cleanChoices);
        return cleanRoot;
    }

    /** Streaming state machine stripping {@code <think>...</think>} across arbitrary SSE token chunk boundaries. */
    static final class ThinkTagStripper {
        private final java.util.function.Consumer<String> downstream;
        private final StringBuilder pending = new StringBuilder();
        private boolean insideThink = false;

        ThinkTagStripper(java.util.function.Consumer<String> downstream) {
            this.downstream = downstream;
        }

        void accept(String delta) {
            if (downstream == null || delta == null || delta.isEmpty()) return;
            pending.append(delta);
            drain(false);
        }

        void flush() {
            if (downstream == null || pending.isEmpty()) return;
            drain(true);
        }

        private void drain(boolean eof) {
            while (!pending.isEmpty()) {
                if (insideThink) {
                    int end = pending.indexOf("</think>");
                    if (end >= 0) {
                        pending.delete(0, end + 8);
                        while (!pending.isEmpty() && Character.isWhitespace(pending.charAt(0))) {
                            pending.deleteCharAt(0);
                        }
                        insideThink = false;
                        continue;
                    }
                    if (eof) {
                        pending.setLength(0);
                    } else if (pending.length() > 7) {
                        pending.delete(0, pending.length() - 7);
                    }
                    return;
                }
                int start = pending.indexOf("<think>");
                if (start >= 0) {
                    if (start > 0) downstream.accept(pending.substring(0, start));
                    pending.delete(0, start + 7);
                    insideThink = true;
                    continue;
                }
                int hold = eof ? 0 : partialTagSuffixLength(pending, "<think>");
                int emitLen = pending.length() - hold;
                if (emitLen > 0) {
                    downstream.accept(pending.substring(0, emitLen));
                    pending.delete(0, emitLen);
                }
                return;
            }
        }

        private static int partialTagSuffixLength(StringBuilder sb, String tag) {
            int max = Math.min(sb.length(), tag.length() - 1);
            for (int len = max; len >= 1; len--) {
                if (sb.substring(sb.length() - len).equals(tag.substring(0, len))) return len;
            }
            return 0;
        }
    }

    private Map<?, ?> postWithStreamBridge(Map<String, Object> body, EchoProviderStream.Control control,
                                           java.util.function.Consumer<String> content,
                                           java.util.function.Consumer<Map<?, ?>> usageSink,
                                           Runnable accepted, boolean allowToolsWithOutput) {
        String endpoint = (baseUrl == null ? "https://openrouter.ai/api/v1" : baseUrl).replaceAll("/+$", "") + "/chat/completions";
        return postWithStreamBridgeToEndpoint(endpoint, apiKey == null ? "" : apiKey.trim(), "", body, control, content, usageSink, accepted, allowToolsWithOutput);
    }

    private Map<?, ?> postWithStreamBridgeToEndpoint(String endpoint, String bearer, String svcKey,
                                                     Map<String, Object> body, EchoProviderStream.Control control,
                                                     java.util.function.Consumer<String> content,
                                                     java.util.function.Consumer<Map<?, ?>> usageSink,
                                                     Runnable accepted, boolean allowToolsWithOutput) {
        control.check();
        Map<?, ?> response = EchoProviderStream.postJson(endpoint, bearer, svcKey, body, objectMapper, control);
        control.check();
        if (response.get("usage") instanceof Map<?, ?> u && usageSink != null) {
            usageSink.accept(u);
        }
        Map<?, ?> msg = firstMessage(response);
        if (msg != null) {
            List<?> toolCalls = msg.get("tool_calls") instanceof List<?> l ? l : List.of();
            String text = msg.get("content") instanceof String s ? s : "";
            if (!text.isEmpty() || !toolCalls.isEmpty()) {
                accepted.run();
            }
            if (!text.isEmpty() && content != null && (toolCalls.isEmpty() || allowToolsWithOutput)) {
                content.accept(text);
            }
        }
        return response;
    }

    private Map<?, ?> postToEndpoint(String endpoint, String bearer, String svcKey, Map<String, Object> body) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.set("User-Agent", "EnglishCoach/1.0");
        if (bearer != null && !bearer.isBlank()) headers.setBearerAuth(bearer);
        if (svcKey != null && !svcKey.isBlank()) headers.set("X-EC-Service-Key", svcKey);
        headers.set("HTTP-Referer", "https://englishcoach.io.vn");
        headers.set("X-Title", "English Coach");
        ResponseEntity<Map> result = restTemplate.postForEntity(endpoint, new HttpEntity<>(body, headers), Map.class);
        if (!result.getStatusCode().is2xxSuccessful() || result.getBody() == null)
            throw new HttpServerErrorException(HttpStatus.BAD_GATEWAY);
        return result.getBody();
    }

    private Map<?, ?> post(Map<String, Object> body) {
        HttpHeaders headers = new HttpHeaders(); headers.setContentType(MediaType.APPLICATION_JSON);
        headers.setBearerAuth(apiKey.trim()); // Transport only; never part of model messages or output validation.
        headers.set("HTTP-Referer", "https://englishcoach.io.vn"); headers.set("X-Title", "English Coach");
        String endpoint = (baseUrl == null ? "https://openrouter.ai/api/v1" : baseUrl).replaceAll("/+$", "") + "/chat/completions";
        ResponseEntity<Map> result = restTemplate.postForEntity(endpoint, new HttpEntity<>(body, headers), Map.class);
        if (!result.getStatusCode().is2xxSuccessful() || result.getBody() == null)
            throw new HttpServerErrorException(HttpStatus.BAD_GATEWAY);
        return result.getBody();
    }

    private static Map<?, ?> firstMessage(Map<?, ?> response) {
        if (response.get("choices") instanceof List<?> list && !list.isEmpty() && list.get(0) instanceof Map<?, ?> first
                && first.get("message") instanceof Map<?, ?> message) return message;
        return null;
    }

    private static EchoUsageLedger.Usage account(EchoUsageLedger.Usage spent, String model, Map<?, ?> response) {
        if (!(response.get("usage") instanceof Map<?, ?> u)) return spent.plus(0, 0, 0, 0);
        int prompt = number(u.get("prompt_tokens")), completion = number(u.get("completion_tokens"));
        int cached = u.get("prompt_tokens_details") instanceof Map<?, ?> d ? number(d.get("cached_tokens")) : 0;
        double cost = u.get("cost") instanceof Number c && Double.isFinite(c.doubleValue()) && c.doubleValue() >= 0 ? c.doubleValue()
                : EchoModels.estimate(model, prompt, completion, cached);
        return spent.plus(prompt, completion, cached, cost);
    }

    private static int number(Object o) { return o instanceof Number n ? (int) Math.max(0, Math.min(Integer.MAX_VALUE, n.longValue())) : 0; }

    private static boolean readTimeout(RestClientException ex) {
        if (ex.getCause() instanceof java.net.http.HttpTimeoutException)
            return !(ex.getCause() instanceof java.net.http.HttpConnectTimeoutException);
        return ex.getCause() instanceof java.net.SocketTimeoutException timeout
                && timeout.getMessage() != null && timeout.getMessage().toLowerCase(Locale.ROOT).contains("read");
    }

    private static long elapsedMs(long started) { return (System.nanoTime() - started) / 1_000_000; }

    // ── context ──────────────────────────────────────────────────────────────────────────────────────────

    private String professorPrompt(long userId, EchoPolicy.Intent intent, String query, AiChatRequest request, EchoTurn turn) {
        boolean vi = turn.vi();
        boolean voice = turn.voice();

        String learner = "{}";
        String page = null;
        boolean needPage = pages != null && request.pageContext() != null;
        boolean detailed = needPage && (EchoRouter.pageReferenced(query)
                || (request.pageContext().selection() != null && !request.pageContext().selection().isBlank()));
        EchoPageContextDto effectivePageContext = !needPage ? null
                : (detailed ? request.pageContext() : request.pageContext().withoutOnDemandExcerpts());
        CompletableFuture<String> pageFuture = null;
        if (needPage && brain != null) {
            pageFuture = CompletableFuture.supplyAsync(() -> {
                try { return pages.resolve(userId, effectivePageContext, detailed, vi); }
                catch (RuntimeException e) { return "{\"available\":false}"; }
            }, toolPool);
        }
        if (brain != null) {
            try {
                boolean fullProf = EchoRouter.fullProfile(intent, query);
                boolean exampleLevel = !fullProf
                        && EchoRouter.directTeaching(intent, query)
                        && EchoPolicy.normalize(query).matches(".*\\b[abc][12]\\b.*");
                learner = !fullProf && (exampleLevel || EchoRouter.conversationDrill(intent, query))
                        ? brain.teachingPreferences(userId)
                        : brain.snapshot(userId, fullProf, EchoRouter.examPracticeFocus(query)).json();
            }
            catch (RuntimeException e) { log.warn("Echo learner profile unavailable ({})", e.getClass().getSimpleName()); }
        }
        if (pageFuture != null) {
            try { page = pageFuture.get(6, TimeUnit.SECONDS); }
            catch (Exception e) { pageFuture.cancel(true); page = "{\"available\":false}"; }
        } else if (needPage) {
            try { page = pages.resolve(userId, effectivePageContext, detailed, vi); } catch (RuntimeException e) { page = "{\"available\":false}"; }
        }
        EchoPolicy.CoachingMode coachingMode = EchoPolicy.resolveEffectiveCoachingMode(request.messages(), learner, objectMapper);
        return EchoPolicy.professorPrompt(learner, page, voice, vi, coachingMode, turn.salientResources(), objectMapper);
    }

    /** The previous single-call context (kept for the no-tools configuration). */
    private String legacyPrompt(long userId, EchoPolicy.Intent intent, String query) {
        String dna = learnerDnaAggregatorService != null ? learnerDnaAggregatorService.getLearnerDnaJson(userId) : "{}";
        String minimal = EchoPolicy.context(dna, intent, objectMapper);
        // Stored Learning Path summary (read-only, no plan generation) only for planning / progress questions.
        if (learningPlan != null && EchoPolicy.planAware(intent)) {
            try { minimal = EchoPolicy.withPlan(minimal, learningPlan.planSummary(userId), objectMapper); }
            catch (Exception e) { log.warn("Echo learning-path summary unavailable"); }
        }
        var family = EchoPolicy.requestedProfile(query);
        if (examProfiles != null && family != null) {
            try {
                var context = (com.fasterxml.jackson.databind.node.ObjectNode) objectMapper.readTree(minimal);
                var profile = context.putObject("recordedExamProfile");
                profile.put("family", family.name());
                var scores = profile.putObject("scores");
                for (var row : examProfiles.latestByMetric(userId, family)) {
                    if (Set.of("READING", "LISTENING", "WRITING", "SPEAKING", "FULL_OVERALL", "LR_TOTAL").contains(row.metric())
                            && Double.isFinite(row.scoreValue())) scores.put(row.metric(), row.scoreValue());
                }
                minimal = objectMapper.writeValueAsString(context);
            } catch (Exception e) { log.warn("Echo exam profile unavailable"); }
        }
        return EchoPolicy.prompt(minimal, intent);
    }

    // ── Route A: answers without inference ──────────────────────────────────────────────────────────────

    private AiChatResponse direct(EchoTurn turn, EchoRouter.Command command) {
        try {
            switch (command.type()) {
                case IDENTITY -> {
                    return directReply(turn.t("Mình là Echo — người bạn đồng hành AI và trợ lý học tiếng Anh của bạn trên English Coach.",
                            "I'm Echo — your AI companion and English learning copilot inside English Coach."), List.of(), List.of());
                }
                case NAVIGATE -> {
                    var resolved = destinations.resolve(turn.userId(), command.dest(), null, null, null, command.family(), turn.vi());
                    if (!resolved.ok()) return null;
                    if (CaMeLPolicyEngine.isWorkRoute(turn.page(), resolved.href())) {
                        return directReply(
                                turn.t("Bạn đang làm dở bài luyện tập. Xác nhận nếu bạn muốn chuyển sang " + resolved.label() + " nhé.",
                                        "You have active practice open. Please confirm if you want to switch to " + resolved.label() + "."),
                                List.of(),
                                List.of(EchoAction.navigate(resolved.href(), resolved.label(), true)));
                    }
                    return directReply(turn.t("Mình mở " + resolved.label() + " cho bạn nhé.", "Opening " + resolved.label() + " for you."),
                            List.of(), List.of(EchoAction.navigate(resolved.href(), resolved.label(), true)));
                }
                case STREAK -> {
                    if (progress == null) return null;
                    var s = progress.getStreak(turn.userId());
                    String text = turn.t("Chuỗi ngày học hiện tại của bạn là " + s.currentStreakDays() + " ngày (dài nhất " + s.longestStreakDays()
                                    + " ngày). " + (s.activeToday() ? "Hôm nay bạn đã học rồi, giữ nhịp nhé!" : "Hôm nay bạn chưa có hoạt động học nào được ghi nhận."),
                            "Your current study streak is " + s.currentStreakDays() + " days (longest " + s.longestStreakDays() + "). "
                                    + (s.activeToday() ? "You have studied today, keep it going!" : "No study activity is recorded for today yet."));
                    return directReply(text, List.of(), List.of(EchoAction.navigate(EchoDestinations.Dest.PROGRESS.pattern(), EchoDestinations.Dest.PROGRESS.label(turn.vi()), false)));
                }
                case DUE_CARDS -> {
                    if (flashcards == null) return null;
                    long due = flashcards.countReviewDue(turn.userId());
                    String text = due == 0 ? turn.t("Hiện chưa có thẻ nào đến hạn ôn. Bạn có thể học thêm từ mới nhé.", "No cards are due right now. You could learn some new words.")
                            : turn.t("Bạn có " + due + " thẻ từ vựng đến hạn ôn theo lịch của Flashcards.", "You have " + due + " flashcards due for review.");
                    return directReply(text, List.of(), due == 0 ? List.of() : List.of(EchoAction.navigate(EchoDestinations.Dest.FLASHCARDS_REVIEW.pattern(),
                            EchoDestinations.Dest.FLASHCARDS_REVIEW.label(turn.vi()), false)));
                }
                case ALLOWANCE -> {
                    if (usage == null || entitlement == null) return null;
                    boolean premium = safePremium(turn.userId());
                    var all = usage.dailyAllowances(turn.userId(), premium);
                    if (premium) {
                        var day = all.get(com.englishcoach.premium.service.PremiumUsageService.Pool.COACH);
                        int monthLimit = usage.premiumMonthlyLimit(com.englishcoach.premium.service.PremiumUsageService.COACH_CHAT), monthUsed = 0;
                        try {
                            monthUsed = usage.getMonthlyPremiumUsedByFeature(turn.userId(), usage.getCurrentBillingCycleMonth())
                                    .getOrDefault(com.englishcoach.premium.service.PremiumUsageService.COACH_CHAT, 0);
                        } catch (RuntimeException ignored) { }
                        int monthLeft = Math.max(0, monthLimit - monthUsed);
                        return directReply(turn.t("Gói Premium: hôm nay bạn còn " + day.remaining() + "/" + day.limit() + " tin nhắn Echo, tháng này còn "
                                        + monthLeft + "/" + monthLimit + ". Lượt theo ngày làm mới vào 0:00.",
                                "Premium: " + day.remaining() + "/" + day.limit() + " Echo messages left today and " + monthLeft + "/" + monthLimit
                                        + " this month. The daily allowance renews at midnight."),
                                List.of(), List.of(EchoAction.navigate(EchoDestinations.Dest.PREMIUM.pattern(), EchoDestinations.Dest.PREMIUM.label(turn.vi()), false)));
                    }
                    var coach = all.get(com.englishcoach.premium.service.PremiumUsageService.Pool.COACH);
                    var ai = all.get(com.englishcoach.premium.service.PremiumUsageService.Pool.AI);
                    if (coach == null) return null;
                    String text = turn.t("Hôm nay bạn còn " + coach.remaining() + "/" + coach.limit() + " tin nhắn Echo miễn phí"
                                    + (ai == null ? "" : " và " + ai.remaining() + "/" + ai.limit() + " lượt AI cho các tính năng khác") + ". Lượt mới có vào 0:00.",
                            "Today you have " + coach.remaining() + "/" + coach.limit() + " free Echo messages left"
                                    + (ai == null ? "" : " and " + ai.remaining() + "/" + ai.limit() + " AI uses for other features") + ". They renew at midnight.");
                    return directReply(text, List.of(), List.of(EchoAction.navigate(EchoDestinations.Dest.PREMIUM.pattern(), EchoDestinations.Dest.PREMIUM.label(turn.vi()), false)));
                }
            }
        } catch (RuntimeException e) {
            log.warn("Echo direct answer unavailable ({})", e.getClass().getSimpleName());
        }
        return null;
    }

    private static AiChatResponse directReply(String text, List<EchoCard> cards, List<EchoAction> actions) {
        return new AiChatResponse(text, "echo-direct", Route.DIRECT.name(), cards, actions);
    }

    private boolean safePremium(long userId) {
        try { return entitlement.isUserPremium(userId); } catch (RuntimeException e) { return false; }
    }

    static String normalizeLedgerOutcome(String outcome) {
        return outcome != null && DB_VALID_OUTCOMES.contains(outcome) ? outcome : "FAILED";
    }

    private void record(long userId, boolean voice, Route route, String intent, String model, EchoUsageLedger.Usage spent, long started, String outcome) {
        if (ledger != null) ledger.record(userId, voice, route, intent, model, spent, elapsedMs(started), normalizeLedgerOutcome(outcome));
    }

    private Long reserveMessage(Long userId) {
        return reserveMessage(userId, entitlement != null && entitlement.isUserPremium(userId));
    }

    private Long reserveMessage(Long userId, boolean premium) {
        if (usage == null || entitlement == null) return null;
        try {
            return usage.reserveUsage(userId, com.englishcoach.premium.service.PremiumUsageService.COACH_CHAT, null, premium);
        } catch (com.englishcoach.premium.exception.PremiumRequiredException exhausted) {
            throw new CoachDailyLimitException(usage.dailyLimit(com.englishcoach.premium.service.PremiumUsageService.Pool.COACH),
                    exhausted.getResetsAt());
        } catch (com.englishcoach.premium.exception.PremiumDailyLimitReachedException premiumDay) {
            throw new CoachDailyLimitException(premiumDay.getDailyLimit(), premiumDay.getResetsAt(), CoachDailyLimitException.PREMIUM_DAILY);
        } catch (com.englishcoach.premium.exception.PremiumLimitReachedException premiumMonth) {
            java.time.ZoneId zone = java.time.ZoneId.of("Asia/Ho_Chi_Minh");
            java.time.Instant nextMonth = java.time.LocalDate.now(zone).withDayOfMonth(1).plusMonths(1).atStartOfDay(zone).toInstant();
            throw new CoachDailyLimitException(premiumMonth.getMonthlyLimit(), nextMonth, CoachDailyLimitException.PREMIUM_MONTHLY);
        }
    }

    private void settleMessage(Long reservation, boolean charge) {
        if (reservation == null || usage == null) return;
        try {
            if (charge) usage.commitReservation(reservation); else usage.releaseReservation(reservation);
        } catch (RuntimeException e) {
            log.warn("Echo message allowance could not be settled ({})", e.getClass().getSimpleName());
        }
    }

    // ── streaming: status events, mid-turn parallel actions/cards, and validated token deltas ─────────────────────

    @Override
    public SseEmitter streamChat(Long userId, AiChatRequest request) {
        SseEmitter emitter = new SseEmitter(MAX_TURN_BUDGET_MS + 5_000L);
        AtomicInteger open = new AtomicInteger(1);
        var control = new EchoProviderStream.Control();
        var key = request != null && request.turnId() != null && userId != null ? new ActiveTurn(userId, request.turnId()) : null;
        if (key != null && active.putIfAbsent(key, control) != null) throw new ResponseStatusException(HttpStatus.CONFLICT);
        Job[] jobRef = {null};
        Runnable close = () -> {
            open.set(0);
            cancelAndReleasePreOutputIfUnanswered(jobRef[0], control);
            if (key != null) active.remove(key, control);
        };
        Prepared prepared;
        try {
            prepared = prepare(userId, request, text -> {
                event(emitter, open, Map.of("status", text));
                if (open.get() == 0) control.cancel();
                control.check();
            });
        } catch (RuntimeException ex) { close.run(); throw ex; }
        if (prepared.done() != null) { deliver(emitter, open, prepared.done(), true, 0, 0); close.run(); return emitter; }
        Job job = prepared.job();
        jobRef[0] = job;
        emitter.onTimeout(close);
        emitter.onCompletion(close);
        emitter.onError(err -> close.run());
        var pulse = heartbeat.scheduleWithFixedDelay(() -> {
            if (open.get() == 0) return;
            try {
                if (job.watchdog.isExpired()) { control.cancelByTimeout(); return; }
                emitter.send(SseEmitter.event().comment("ping"));
            } catch (Exception ex) { close.run(); }
        }, 1, 2, TimeUnit.SECONDS);
        int[] emittedCards = {0};
        int[] emittedActions = {0};
        Runnable flushStructured = () -> {
            var cards = job.turn.cards();
            if (cards.size() > emittedCards[0]) {
                event(emitter, open, Map.of("cards", List.copyOf(cards.subList(emittedCards[0], cards.size()))));
                emittedCards[0] = cards.size();
            }
            var actions = job.turn.actions();
            if (actions.size() > emittedActions[0]) {
                event(emitter, open, Map.of("actions", List.copyOf(actions.subList(emittedActions[0], actions.size()))));
                emittedActions[0] = actions.size();
            }
        };
        Runnable work = () -> {
            try {
                var result = complete(job, control, token -> {
                    control.check(); event(emitter, open, Map.of("token",token));
                    if (open.get() == 0) { control.cancel(); control.check(); }
                }, flushStructured);
                control.check(); deliver(emitter, open, result, false, emittedCards[0], emittedActions[0]);
            } catch (CancellationException ex) { fail(emitter, open, control.isTimedOut() ? 504 : 503); }
            catch (ResponseStatusException e) { fail(emitter, open, e.getStatusCode().value()); }
            catch (RuntimeException e) { log.warn("Echo turn failed ({})", e.getClass().getSimpleName()); fail(emitter, open, 500); }
            finally { pulse.cancel(false); close.run(); }
        };
        try { streams.execute(work); }
        catch (RejectedExecutionException busy) {
            pulse.cancel(false); settleJobReservationOnce(job, false); close.run();
            if (job.holdsBulkhead) bulkhead.leave();
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE);
        }
        return emitter;
    }

    @Override
    public Runnable streamVoiceTurn(Long userId, AiChatRequest request, VoiceStreamCallbacks callbacks) {
        var control = new EchoProviderStream.Control();
        var key = request != null && request.turnId() != null && userId != null ? new ActiveTurn(userId, request.turnId()) : null;
        if (key != null && active.putIfAbsent(key, control) != null) throw new ResponseStatusException(HttpStatus.CONFLICT);
        Job[] jobRef = {null};
        Runnable close = () -> {
            cancelAndReleasePreOutputIfUnanswered(jobRef[0], control);
            if (key != null) active.remove(key, control);
        };
        Prepared prepared;
        try {
            prepared = prepare(userId, request, text -> {
                control.check();
                callbacks.onStatus(text);
            });
        } catch (CoachDailyLimitException limit) {
            close.run();
            String kind = limit.kind();
            callbacks.onError(429, "daily", kind, limit.resetsAt());
            return () -> {};
        } catch (ResponseStatusException rse) {
            close.run();
            int status = rse.getStatusCode().value();
            callbacks.onError(status, classifyVoiceErrorCode(status), null, null);
            return () -> {};
        } catch (RuntimeException ex) {
            close.run();
            callbacks.onError(503, "service_busy", null, null);
            return () -> {};
        }
        if (prepared.done() != null) {
            AiChatResponse done = prepared.done();
            if (done.actions() != null && !done.actions().isEmpty()) callbacks.onActions(done.actions());
            if (done.cards() != null && !done.cards().isEmpty()) callbacks.onCards(done.cards());
            if (done.reply() != null && !done.reply().isEmpty()) callbacks.onDelta(done.reply());
            callbacks.onComplete(done);
            close.run();
            return () -> {};
        }
        Job job = prepared.job();
        jobRef[0] = job;
        var timeoutGuard = heartbeat.scheduleWithFixedDelay(() -> {
            if (control.isCancelled()) return;
            if (job.watchdog.isExpired()) {
                control.cancelByTimeout();
            }
        }, 1_000L, 1_000L, TimeUnit.MILLISECONDS);
        int[] emittedCards = {0};
        int[] emittedActions = {0};
        Runnable flushStructured = () -> {
            var actions = job.turn.actions();
            if (actions.size() > emittedActions[0]) {
                callbacks.onActions(List.copyOf(actions.subList(emittedActions[0], actions.size())));
                emittedActions[0] = actions.size();
            }
            var cards = job.turn.cards();
            if (cards.size() > emittedCards[0]) {
                callbacks.onCards(List.copyOf(cards.subList(emittedCards[0], cards.size())));
                emittedCards[0] = cards.size();
            }
        };
        Runnable work = () -> {
            try {
                var result = complete(job, control, token -> {
                    control.check();
                    callbacks.onDelta(token);
                }, flushStructured);
                control.check();
                if (result.actions() != null && result.actions().size() > emittedActions[0]) {
                    callbacks.onActions(List.copyOf(result.actions().subList(emittedActions[0], result.actions().size())));
                }
                if (result.cards() != null && result.cards().size() > emittedCards[0]) {
                    callbacks.onCards(List.copyOf(result.cards().subList(emittedCards[0], result.cards().size())));
                }
                callbacks.onComplete(result);
            } catch (CancellationException cancelled) {
                if (control.isTimedOut()) {
                    callbacks.onError(504, "turn_timeout", null, null);
                } else {
                    callbacks.onError(499, "cancelled", null, null);
                }
            } catch (ResponseStatusException e) {
                int code = e.getStatusCode().value();
                callbacks.onError(code, classifyVoiceErrorCode(code), null, null);
            } catch (RuntimeException e) {
                log.warn("Echo voice turn failed ({})", e.getClass().getSimpleName());
                callbacks.onError(503, "service_busy", null, null);
            } finally {
                timeoutGuard.cancel(false);
                close.run();
            }
        };
        try {
            streams.execute(work);
        } catch (RejectedExecutionException busy) {
            timeoutGuard.cancel(false);
            settleJobReservationOnce(job, false);
            close.run();
            if (job.holdsBulkhead) bulkhead.leave();
            callbacks.onError(503, "service_busy", null, null);
        }
        return close;
    }

    static String classifyVoiceErrorCode(int status) {
        return switch (status) {
            case 422 -> "length";
            case 429 -> "rate_limited";
            case 400 -> "invalid_request";
            case 401, 403 -> "unauthorized";
            case 504 -> "turn_timeout";
            default -> "service_busy";
        };
    }

    private void deliver(SseEmitter emitter, AtomicInteger open, AiChatResponse reply, boolean sendText, int alreadySentCards, int alreadySentActions) {
        if (sendText) event(emitter, open, Map.of("token", reply.reply()));
        if (reply.cards() != null && reply.cards().size() > alreadySentCards) {
            event(emitter, open, Map.of("cards", List.copyOf(reply.cards().subList(alreadySentCards, reply.cards().size()))));
        }
        if (reply.actions() != null && reply.actions().size() > alreadySentActions) {
            event(emitter, open, Map.of("actions", List.copyOf(reply.actions().subList(alreadySentActions, reply.actions().size()))));
        }
        if (reply.route() != null) event(emitter, open, Map.of("meta", Map.of("route", reply.route())));
        event(emitter, open, Map.of("done", true));
        try { emitter.complete(); } catch (RuntimeException ignored) { }
    }

    private void fail(SseEmitter emitter, AtomicInteger open, int status) {
        String sseError = status == 422 ? "length" : status == 429 ? "rate_limited" : "unavailable";
        String code = classifyVoiceErrorCode(status);
        event(emitter, open, Map.of(
                "error", sseError,
                "code", code,
                "status", status,
                "message", EchoPolicy.localizedErrorMessage(code, true),
                "messageVi", EchoPolicy.localizedErrorMessage(code, true),
                "messageEn", EchoPolicy.localizedErrorMessage(code, false)));
        event(emitter, open, Map.of("done", true));
        try { emitter.complete(); } catch (RuntimeException ignored) { }
    }

    private static void event(SseEmitter emitter, AtomicInteger open, Object data) {
        if (open.get() == 0) return;
        try { emitter.send(SseEmitter.event().data(data)); } catch (Exception e) { open.set(0); }
    }

    private static ThreadFactory daemon(String prefix) {
        AtomicInteger n = new AtomicInteger();
        return r -> { Thread t = new Thread(r, prefix + n.incrementAndGet()); t.setDaemon(true); return t; };
    }

    private void validateRequest(AiChatRequest request) {
        if (request == null || request.messages() == null || request.messages().isEmpty())
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Messages list must not be empty");
        if (request.messages().size() > 30) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Conversation is too long");
        int total = 0;
        for (AiChatMessageDto message : request.messages()) {
            if (message == null || message.content() == null || message.content().isBlank() || message.content().length() > 4000
                    || message.role() == null || !Set.of("user", "assistant").contains(message.role().toLowerCase(Locale.ROOT)))
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid conversation message");
            total += message.content().length();
        }
        if (total > 24000 || !"user".equalsIgnoreCase(request.messages().get(request.messages().size() - 1).role()))
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Conversation exceeds the supported limits");
        var page = request.pageContext();
        if (page != null && page.selection() != null && page.selection().length() > 600)
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Selection is too long");
        if (page != null && page.clientVisibleExcerpt() != null && page.clientVisibleExcerpt().length() > 2800)
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Visible excerpt is too long");
    }
}
