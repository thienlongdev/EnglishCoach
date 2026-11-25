package com.englishcoach.ai.echo;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.*;

/**
 * The only door from the model to the product. Holds the allow-listed tools, exposes their schemas in a fixed order (a
 * stable, cacheable prompt prefix) and executes a model's tool call after validating the name and every argument
 * against the declared schema. Unknown names, unknown properties, wrong types, too-long strings and values outside an
 * enum are refused before any service is touched. Errors are reported to the model as a neutral code, never a message.
 */
@Component
@Slf4j
public class EchoToolRegistry {
    static final int MAX_ARGS_CHARS = 4_000, MAX_RESULT_CHARS = 3_500;

    private final Map<String, EchoTool> tools = new LinkedHashMap<>();
    private final ObjectMapper mapper;
    private final ObjectProvider<PlatformTransactionManager> transactions;

    public EchoToolRegistry(List<EchoTool> all, ObjectMapper mapper, ObjectProvider<PlatformTransactionManager> transactions) {
        this.mapper = mapper;
        this.transactions = transactions;
        all.stream().sorted(Comparator.comparing(EchoTool::name)).forEach(t -> {
            if (!t.name().matches("[a-z_]{3,40}")) throw new IllegalStateException("bad Echo tool name " + t.name());
            if (tools.putIfAbsent(t.name(), t) != null) throw new IllegalStateException("duplicate Echo tool " + t.name());
            assertSafeSchema(t);
        });
    }

    public Set<String> names() { return Collections.unmodifiableSet(tools.keySet()); }

    public EchoTool tool(String name) { return tools.get(name); }

    /** OpenAI-compatible tool list in a fixed order (static across learners: part of the cached prefix). */
    public List<Map<String, Object>> schemas() {
        List<Map<String, Object>> out = new ArrayList<>();
        for (EchoTool t : tools.values()) {
            Map<String, Object> fn = new LinkedHashMap<>();
            fn.put("name", t.name());
            fn.put("description", t.description());
            fn.put("parameters", t.parameters());
            out.add(Map.of("type", "function", "function", fn));
        }
        return out;
    }

    /** Alias for {@link #schemas()} used by OpenAI-compatible cloud and local Qwen3-4B failover endpoints. */
    public List<Map<String, Object>> openAiTools() {
        return schemas();
    }

    /** Executes one model tool call for the turn's learner. Always returns JSON text (a result or a neutral error). */
    public String execute(EchoTurn turn, String name, String rawArgs) {
        EchoTool tool = tools.get(name);
        if (tool == null) return error("unknown_tool");
        if (!turn.spendToolCall()) return error("tool_budget_exhausted");
        JsonNode args;
        try {
            args = validate(tool, rawArgs);
        } catch (IllegalArgumentException invalid) {
            return error("invalid_arguments: " + invalid.getMessage());
        }
        turn.status(tool.status(turn.vi()));
        long started = System.nanoTime();
        try {
            String result = run(tool, turn, args);
            if (result == null) result = "{}";
            if (result.length() > MAX_RESULT_CHARS) result = truncate(result);
            return result;
        } catch (Exception e) {
            log.warn("Echo tool {} failed ({})", name, e.getClass().getSimpleName());
            return error("unavailable");
        } finally {
            long ms = (System.nanoTime() - started) / 1_000_000;
            if (ms > 1500) log.info("Echo tool {} took {} ms", name, ms);
        }
    }

    private String run(EchoTool tool, EchoTurn turn, JsonNode args) throws Exception {
        PlatformTransactionManager tm = transactions.getIfAvailable();
        if (tm == null) return tool.run(turn, args);
        TransactionTemplate template = new TransactionTemplate(tm);
        template.setReadOnly(tool.readOnlyTransaction());
        template.setTimeout(10);
        if (!tool.readOnlyTransaction() && tool.kind() != EchoTool.Kind.MEMORY) return tool.run(turn, args); // service-managed
        Object[] holder = new Object[1];
        Exception[] failure = new Exception[1];
        template.executeWithoutResult(status -> {
            try { holder[0] = tool.run(turn, args); }
            catch (Exception e) { failure[0] = e; status.setRollbackOnly(); }
        });
        if (failure[0] != null) throw failure[0];
        return (String) holder[0];
    }

    JsonNode validate(EchoTool tool, String rawArgs) {
        String text = rawArgs == null || rawArgs.isBlank() ? "{}" : rawArgs;
        if (text.length() > MAX_ARGS_CHARS) throw new IllegalArgumentException("too_long");
        JsonNode node;
        try { node = mapper.readTree(text); } catch (Exception e) { throw new IllegalArgumentException("not_json"); }
        if (node == null || node.isNull()) node = mapper.createObjectNode();
        if (!node.isObject()) throw new IllegalArgumentException("not_object");
        @SuppressWarnings("unchecked")
        Map<String, Object> props = (Map<String, Object>) tool.parameters().getOrDefault("properties", Map.of());
        @SuppressWarnings("unchecked")
        List<String> required = (List<String>) tool.parameters().getOrDefault("required", List.of());
        ObjectNode clean = mapper.createObjectNode();
        for (Iterator<Map.Entry<String, JsonNode>> it = node.fields(); it.hasNext(); ) {
            var field = it.next();
            if (!props.containsKey(field.getKey())) throw new IllegalArgumentException("unknown_property " + field.getKey());
            if (field.getValue().isNull()) continue;
            @SuppressWarnings("unchecked")
            Map<String, Object> spec = (Map<String, Object>) props.get(field.getKey());
            clean.set(field.getKey(), checkValue(field.getKey(), field.getValue(), spec));
        }
        for (String r : required) if (!clean.has(r)) throw new IllegalArgumentException("missing " + r);
        return clean;
    }

    private JsonNode checkValue(String key, JsonNode value, Map<String, Object> spec) {
        String type = String.valueOf(spec.get("type"));
        switch (type) {
            case "string" -> {
                if (!value.isTextual()) throw new IllegalArgumentException(key + "_not_string");
                String v = value.asText().strip();
                int max = spec.get("maxLength") instanceof Number n ? n.intValue() : 80;
                if (v.isEmpty() || v.length() > max) throw new IllegalArgumentException(key + "_length");
                if (v.chars().anyMatch(c -> c < 0x20)) throw new IllegalArgumentException(key + "_control");
                if (spec.get("enum") instanceof List<?> allowed && !allowed.contains(v)) throw new IllegalArgumentException(key + "_not_allowed");
                if (spec.get("pattern") instanceof String p && !v.matches(p)) throw new IllegalArgumentException(key + "_pattern");
                return mapper.getNodeFactory().textNode(v);
            }
            case "integer" -> {
                if (!value.canConvertToLong() || (value.isTextual() && !value.asText().matches("-?\\d{1,9}")))
                    throw new IllegalArgumentException(key + "_not_integer");
                long v = value.asLong();
                long min = spec.get("minimum") instanceof Number n ? n.longValue() : 0;
                long max = spec.get("maximum") instanceof Number n ? n.longValue() : Integer.MAX_VALUE;
                if (v < min || v > max) throw new IllegalArgumentException(key + "_range");
                return mapper.getNodeFactory().numberNode(v);
            }
            case "boolean" -> {
                if (!value.isBoolean()) throw new IllegalArgumentException(key + "_not_boolean");
                return value;
            }
            case "array" -> {
                if (!value.isArray()) throw new IllegalArgumentException(key + "_not_array");
                int minItems = spec.get("minItems") instanceof Number n ? n.intValue() : 0;
                int maxItems = spec.get("maxItems") instanceof Number n ? n.intValue() : 8;
                if (value.size() < minItems || value.size() > maxItems) {
                    throw new IllegalArgumentException(key + "_size");
                }
                @SuppressWarnings("unchecked")
                Map<String, Object> itemSpec = (Map<String, Object>) spec.get("items");
                if (itemSpec == null) throw new IllegalArgumentException(key + "_items");
                var cleanArr = mapper.createArrayNode();
                for (int idx = 0; idx < value.size(); idx++) {
                    cleanArr.add(checkValue(key + "_" + idx, value.get(idx), itemSpec));
                }
                return cleanArr;
            }
            case "object" -> {
                if (!value.isObject()) throw new IllegalArgumentException(key + "_not_object");
                @SuppressWarnings("unchecked")
                Map<String, Object> nestedProps = (Map<String, Object>) spec.getOrDefault("properties", Map.of());
                @SuppressWarnings("unchecked")
                List<String> nestedReq = (List<String>) spec.getOrDefault("required", List.of());
                ObjectNode cleanObj = mapper.createObjectNode();
                for (Iterator<Map.Entry<String, JsonNode>> it = value.fields(); it.hasNext(); ) {
                    var f = it.next();
                    if (!nestedProps.containsKey(f.getKey())) throw new IllegalArgumentException("unknown_property " + f.getKey());
                    if (f.getValue().isNull()) continue;
                    @SuppressWarnings("unchecked")
                    Map<String, Object> subSpec = (Map<String, Object>) nestedProps.get(f.getKey());
                    cleanObj.set(f.getKey(), checkValue(f.getKey(), f.getValue(), subSpec));
                }
                for (String r : nestedReq) if (!cleanObj.has(r)) throw new IllegalArgumentException("missing " + r);
                return cleanObj;
            }
            default -> throw new IllegalArgumentException(key + "_type");
        }
    }

    private static void assertSafeSchema(EchoTool t) {
        assertSafeObjectSchema(t.name(), t.parameters());
    }

    private static void assertSafeObjectSchema(String toolName, Map<?, ?> schema) {
        if (!Boolean.FALSE.equals(schema.get("additionalProperties")))
            throw new IllegalStateException("Echo tool " + toolName + " must forbid additional properties");
        Object props = schema.get("properties");
        if (props instanceof Map<?, ?> m) {
            for (var entry : m.entrySet()) {
                String name = String.valueOf(entry.getKey()).toLowerCase(Locale.ROOT);
                for (String forbidden : List.of("user", "owner", "account", "email", "sql", "url", "href", "command", "query_sql"))
                    if (name.contains(forbidden)) throw new IllegalStateException("Echo tool " + toolName + " exposes a forbidden parameter: " + name);
                if (entry.getValue() instanceof Map<?, ?> spec) {
                    if ("object".equals(spec.get("type"))) {
                        assertSafeObjectSchema(toolName, spec);
                    } else if ("array".equals(spec.get("type")) && spec.get("items") instanceof Map<?, ?> itemSpec && "object".equals(itemSpec.get("type"))) {
                        assertSafeObjectSchema(toolName, itemSpec);
                    }
                }
            }
        }
    }

    private String truncate(String json) {
        // keep it valid JSON for the model: wrap a cut copy as a string field
        try { return mapper.writeValueAsString(Map.of("truncated", true, "partial", json.substring(0, MAX_RESULT_CHARS - 200))); }
        catch (Exception e) { return error("too_large"); }
    }

    private String error(String code) {
        try { return mapper.writeValueAsString(Map.of("error", code)); } catch (Exception e) { return "{\"error\":\"unavailable\"}"; }
    }

    // ── helpers for tool implementations ─────────────────────────────────────────────────────────

    public static Map<String, Object> schema(Map<String, Object> properties, List<String> required) {
        Map<String, Object> s = new LinkedHashMap<>();
        s.put("type", "object");
        s.put("properties", properties);
        s.put("required", required);
        s.put("additionalProperties", false);
        return s;
    }

    public static Map<String, Object> str(String description, int maxLength) {
        return new LinkedHashMap<>(Map.of("type", "string", "description", description, "maxLength", maxLength));
    }

    public static Map<String, Object> enumOf(String description, List<String> values) {
        return new LinkedHashMap<>(Map.of("type", "string", "description", description, "enum", values));
    }

    public static Map<String, Object> integer(String description, int min, int max) {
        return new LinkedHashMap<>(Map.of("type", "integer", "description", description, "minimum", min, "maximum", max));
    }
}
