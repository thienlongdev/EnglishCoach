package com.englishcoach.echolife;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.graalvm.polyglot.Context;
import org.graalvm.polyglot.Engine;
import org.graalvm.polyglot.PolyglotException;
import org.graalvm.polyglot.ResourceLimits;
import org.graalvm.polyglot.Source;
import org.springframework.core.io.ClassPathResource;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/** Runs only the packaged, content-pinned V2 rules. Callers supply data, never scripts. */
public final class EchoLifeWorkshop {
    private static final int POOL_SIZE = 2;
    private static final int MAX_USES_PER_CONTEXT = 250;
    private static final long BORROW_TIMEOUT_MS = 4000L;
    static final long STATEMENT_LIMIT = 200_000L;
    private static final ResourceLimits RESOURCE_LIMITS = ResourceLimits.newBuilder()
            .statementLimit(STATEMENT_LIMIT, null)
            .build();

    private static final Set<String> ACTIONS = Set.of("upgrade_object", "install_pc_part", "place_object",
            "rotate_object", "store_object", "customize_material", "buy_switch_property", "customize_vehicle",
            "undo_build", "redo_build", "apply_room_style", "select_vehicle", "job_step");
    private static final Set<String> STRINGS = Set.of("type","instanceId","upgradeId","slot","componentId","zoneId","finishId","propertyId","styleId","jobId","station","quality");
    private static final Set<String> SHIFT_QUALITIES = Set.of("ok", "great", "perfect");
    private static final Set<String> NUMBERS = Set.of("x","z","yaw","delta");

    public record Stats(long evaluations, long avgMs, long busyRejects, long recycles) {}

    private static final AtomicLong evalCount = new AtomicLong();
    private static final AtomicLong evalNanos = new AtomicLong();
    private static final AtomicLong busyRejects = new AtomicLong();
    private static final AtomicLong contextRecycles = new AtomicLong();

    public static Stats stats() {
        long count = evalCount.get();
        long avgMs = count == 0 ? 0 : (evalNanos.get() / count) / 1_000_000L;
        return new Stats(count, avgMs, busyRejects.get(), contextRecycles.get());
    }

    static void validate(JsonNode action) {
        if (action == null || !action.isObject() || !ACTIONS.contains(action.path("type").asText())) throw invalid();
        String actionType = action.path("type").asText();
        action.fields().forEachRemaining(e -> {
            String key=e.getKey();
            JsonNode v=e.getValue();
            if ("quality".equals(key)) {
                if ("job_step".equals(actionType) && v.isTextual() && SHIFT_QUALITIES.contains(v.asText())) return;
                throw invalid();
            }
            if (STRINGS.contains(key) && v.isTextual() && v.asText().matches("[a-z][a-z0-9_]{0,79}")
                    && !Set.of("prototype","constructor").contains(v.asText())) return;
            if (NUMBERS.contains(key) && v.isNumber() && Math.abs(v.asDouble()) <= 500) return;
            throw invalid();
        });
        if (actionType.equals("place_object") && !(action.has("zoneId") && action.has("x") && action.has("z"))) throw invalid();
    }

    private static EchoLifeException invalid() { return new EchoLifeException(400,"INVALID_PROGRESSION_ACTION"); }

    /**
     * Bounded pool of warm GraalJS contexts sharing one immutable compiled Engine/Source.
     * Both packaged entry points ({@code workshop} and {@code attendedRoomEvent}) are verified pure/stateless:
     * reusing warm contexts eliminates ~1,000 ms per-call 441 KB script re-evaluation and GC churn while bounding
     * native/heap memory to at most {@value #POOL_SIZE} contexts on the 2-vCPU VPS. Each context recycles after
     * {@value #MAX_USES_PER_CONTEXT} uses or any exception.
     */
    private static final class WarmContext implements AutoCloseable {
        final Context context;
        final org.graalvm.polyglot.Value workshopFn;
        final org.graalvm.polyglot.Value attendedEventFn;
        int uses;

        WarmContext(Engine engine, Source source) {
            this.context = Context.newBuilder("js")
                    .engine(engine)
                    .allowAllAccess(false)
                    .resourceLimits(RESOURCE_LIMITS)
                    .build();
            this.context.eval(source);
            this.context.resetLimits();
            var bindings = this.context.getBindings("js");
            this.workshopFn = bindings.getMember("workshop");
            this.attendedEventFn = bindings.getMember("attendedRoomEvent");
        }

        String execute(String rule, String payload) {
            this.context.resetLimits();
            var fn = "workshop".equals(rule) ? workshopFn : "attendedRoomEvent".equals(rule) ? attendedEventFn : context.getBindings("js").getMember(rule);
            uses++;
            return fn.execute(payload).asString();
        }

        @Override
        public void close() {
            try { context.close(true); } catch (RuntimeException ignored) { /* best-effort release */ }
        }
    }

    private static class Rules {
        static final Engine ENGINE = Engine.newBuilder("js").option("engine.WarnInterpreterOnly","false").build();
        static final Source SOURCE = load();
        static final ArrayBlockingQueue<WarmContext> POOL = new ArrayBlockingQueue<>(POOL_SIZE);
        static final AtomicInteger CREATED = new AtomicInteger(0);

        static Source load() {
            try (var in = new ClassPathResource("echo-life/rules.js").getInputStream()) {
                return Source.newBuilder("js",new String(in.readAllBytes(), StandardCharsets.UTF_8),"echo-life-rules.js").buildLiteral();
            } catch (IOException e) { throw new IllegalStateException("Missing packaged Echo Life rules", e); }
        }

        static WarmContext borrow() {
            WarmContext existing = POOL.poll();
            if (existing != null) return existing;
            while (true) {
                int current = CREATED.get();
                if (current < POOL_SIZE) {
                    if (CREATED.compareAndSet(current, current + 1)) {
                        try {
                            return new WarmContext(ENGINE, SOURCE);
                        } catch (RuntimeException e) {
                            CREATED.decrementAndGet();
                            throw e;
                        }
                    }
                    continue;
                }
                break;
            }
            try {
                WarmContext waited = POOL.poll(BORROW_TIMEOUT_MS, TimeUnit.MILLISECONDS);
                if (waited != null) return waited;
                busyRejects.incrementAndGet();
                throw new EchoLifeException(503, "ECHO_LIFE_BUSY");
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                busyRejects.incrementAndGet();
                throw new EchoLifeException(503, "ECHO_LIFE_BUSY");
            }
        }

        static void release(WarmContext ctx, boolean broken) {
            if (ctx == null) return;
            if (broken || ctx.uses >= MAX_USES_PER_CONTEXT) {
                ctx.close();
                contextRecycles.incrementAndGet();
                CREATED.decrementAndGet();
                return;
            }
            if (!POOL.offer(ctx)) {
                ctx.close();
                CREATED.decrementAndGet();
            }
        }
    }

    static JsonNode run(ObjectMapper json,ObjectNode input) {
        return evaluate(json,input,"workshop");
    }

    public static JsonNode attendedEvent(ObjectMapper json,ObjectNode input) {
        return evaluate(json,input,"attendedRoomEvent");
    }

    private static JsonNode evaluate(ObjectMapper json,ObjectNode input,String rule) {
        long started = System.nanoTime();
        WarmContext ctx = Rules.borrow();
        boolean broken = false;
        try {
            String reply = ctx.execute(rule, input.toString());
            return json.readTree(reply);
        } catch (IOException e) {
            broken = true;
            throw new IllegalStateException("Invalid packaged rules response", e);
        } catch (PolyglotException e) {
            broken = true;
            if (e.isResourceExhausted()) {
                throw new EchoLifeException(400, "INVALID_GAME");
            }
            throw e;
        } catch (RuntimeException e) {
            broken = true;
            throw e;
        } finally {
            Rules.release(ctx, broken);
            evalCount.incrementAndGet();
            evalNanos.addAndGet(System.nanoTime() - started);
        }
    }
}
