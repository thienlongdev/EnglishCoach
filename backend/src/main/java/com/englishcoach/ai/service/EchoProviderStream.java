package com.englishcoach.ai.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatusCode;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.HttpServerErrorException;
import org.springframework.web.client.ResourceAccessException;

import java.io.*;
import java.net.URI;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.Consumer;

/** One cancellable exchange per round. Only the content channel enters the visible-output gate. */
final class EchoProviderStream {
    static final HttpClient HTTP = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(6))
            .followRedirects(HttpClient.Redirect.NEVER)
            .build();
    static final long FIRST_BYTE_TIMEOUT_SECONDS = 15L;
    static final long STREAM_REQUEST_TIMEOUT_SECONDS = 75L;
    static final int MAX_TOOL_ARGS_CHARS = 4_000;

    /** Thrown when the upstream stream fails BEFORE emitting a single content or tool_call delta (safe to fall back). */
    static final class PreOutputStreamException extends ResourceAccessException {
        PreOutputStreamException(String msg, IOException cause) {
            super(msg, cause);
        }
    }

    static final class Control {
        private boolean cancelled;
        private boolean timedOut;
        private CompletableFuture<?> request;
        private InputStream body;
        synchronized void check() { if (cancelled) throw new CancellationException(timedOut ? "turn_timeout" : "cancelled"); }
        synchronized boolean isCancelled() { return cancelled; }
        synchronized boolean isTimedOut() { return timedOut; }
        synchronized void attach(CompletableFuture<?> pending) {
            if (cancelled) pending.cancel(true);
            check(); request = pending;
        }
        synchronized void attach(InputStream in) throws IOException {
            if (cancelled) in.close();
            check(); body = in;
        }
        synchronized void cancel() {
            cancelled = true;
            if (request != null) request.cancel(true);
            if (body != null) try { body.close(); } catch (IOException ignored) { }
        }
        synchronized void cancelByTimeout() {
            if (!cancelled) {
                timedOut = true;
            }
            cancel();
        }
        synchronized void clear() { body = null; request = null; }
    }

    static Map<?, ?> post(String endpoint, String key, Map<String,Object> payload, ObjectMapper mapper,
                          Control control, Consumer<String> content, Consumer<Map<?,?>> usage, Runnable accepted) {
        return post(endpoint, key, payload, mapper, control, content, usage, accepted, false);
    }

    static Map<?, ?> post(String endpoint, String key, Map<String,Object> payload, ObjectMapper mapper,
                          Control control, Consumer<String> content, Consumer<Map<?,?>> usage, Runnable accepted,
                          boolean allowToolsWithOutput) {
        return post(endpoint, key, null, payload, mapper, control, content, usage, accepted, allowToolsWithOutput);
    }

    static Map<?, ?> post(String endpoint, String key, String internalServiceKey, Map<String,Object> payload, ObjectMapper mapper,
                          Control control, Consumer<String> content, Consumer<Map<?,?>> usage, Runnable accepted,
                          boolean allowToolsWithOutput) {
        control.check();
        boolean[] anyAccepted = {false};
        Runnable trackedAccepted = () -> {
            anyAccepted[0] = true;
            if (accepted != null) accepted.run();
        };
        try {
            Map<String, Object> streamPayload = new LinkedHashMap<>(payload);
            streamPayload.put("stream", true);
            if (!Boolean.FALSE.equals(streamPayload.remove("_omit_stream_options"))) {
                streamPayload.put("stream_options", Map.of("include_usage", true));
            }
            var builder = HttpRequest.newBuilder(URI.create(endpoint)).timeout(Duration.ofSeconds(STREAM_REQUEST_TIMEOUT_SECONDS))
                    .header("Content-Type","application/json").header("Accept","text/event-stream")
                    .header("User-Agent","EnglishCoach/1.0")
                    .header("HTTP-Referer","https://englishcoach.io.vn")
                    .header("X-Title","English Coach");
            if (endpoint.startsWith("http://")) {
                builder.version(HttpClient.Version.HTTP_1_1);
            }
            if (key != null && !key.isBlank()) {
                builder.header("Authorization", "Bearer " + key);
            }
            if (internalServiceKey != null && !internalServiceKey.isBlank()) {
                builder.header("X-EC-Service-Key", internalServiceKey);
            }
            var request = builder.POST(HttpRequest.BodyPublishers.ofByteArray(mapper.writeValueAsBytes(streamPayload))).build();
            var pending = HTTP.sendAsync(request, HttpResponse.BodyHandlers.ofInputStream())
                    .orTimeout(FIRST_BYTE_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            control.attach(pending);
            var response = pending.join();
            try (var in = response.body()) {
                control.attach(in);
                int status = response.statusCode();
                if (status != 200) {
                    byte[] rawErr = in == null ? new byte[0] : in.readNBytes(4096);
                    String safeBody = EchoPolicy.redactSecrets(new String(rawErr, StandardCharsets.UTF_8));
                    byte[] safeBytes = safeBody.getBytes(StandardCharsets.UTF_8);
                    HttpStatusCode statusCode = HttpStatusCode.valueOf(status);
                    if (status >= 500) {
                        throw HttpServerErrorException.create(statusCode, "Provider error", HttpHeaders.EMPTY, safeBytes, StandardCharsets.UTF_8);
                    }
                    throw HttpClientErrorException.create(statusCode, "Provider error", HttpHeaders.EMPTY, safeBytes, StandardCharsets.UTF_8);
                }
                if (!response.headers().firstValue("Content-Type").orElse("").split(";")[0].strip().equalsIgnoreCase("text/event-stream"))
                    throw new PreOutputStreamException("Unexpected provider media type", new IOException("Unexpected provider media type"));
                return parse(in, mapper, control, content, usage, trackedAccepted, allowToolsWithOutput);
            }
        } catch (CompletionException e) {
            control.check();
            Throwable cause = e.getCause();
            if (cause instanceof TimeoutException) {
                throw new PreOutputStreamException("Provider first-byte timeout", new HttpConnectTimeoutException("Provider first-byte timeout"));
            }
            IOException io = cause instanceof IOException c ? c : new IOException("Provider handshake failed");
            if (!anyAccepted[0]) {
                throw new PreOutputStreamException("Echo provider transport failed before output", io);
            }
            throw new ResourceAccessException("Echo provider transport failed", io);
        } catch (PreOutputStreamException pre) {
            control.check();
            throw pre;
        } catch (IOException e) {
            control.check();
            if (!anyAccepted[0]) {
                throw new PreOutputStreamException("Echo provider failed before output", new IOException("Provider stream failed before first token"));
            }
            throw new ResourceAccessException("Echo provider stream interrupted", new IOException("Incomplete provider exchange"));
        } finally { control.clear(); }
    }

    /** Cancellable non-streaming JSON POST attached to {@link Control} so barge-in / turn-merge aborts in-flight HTTP immediately. */
    static Map<?, ?> postJson(String endpoint, String key, String internalServiceKey, Map<String, Object> payload,
                              ObjectMapper mapper, Control control) {
        control.check();
        try {
            var builder = HttpRequest.newBuilder(URI.create(endpoint)).timeout(Duration.ofSeconds(30))
                    .header("Content-Type", "application/json")
                    .header("Accept", "application/json")
                    .header("User-Agent", "EnglishCoach/1.0")
                    .header("HTTP-Referer", "https://englishcoach.io.vn")
                    .header("X-Title", "English Coach");
            if (endpoint.startsWith("http://")) {
                builder.version(HttpClient.Version.HTTP_1_1);
            }
            if (key != null && !key.isBlank()) {
                builder.header("Authorization", "Bearer " + key);
            }
            if (internalServiceKey != null && !internalServiceKey.isBlank()) {
                builder.header("X-EC-Service-Key", internalServiceKey);
            }
            var request = builder.POST(HttpRequest.BodyPublishers.ofByteArray(mapper.writeValueAsBytes(payload))).build();
            var pending = HTTP.sendAsync(request, HttpResponse.BodyHandlers.ofByteArray())
                    .orTimeout(30, TimeUnit.SECONDS);
            control.attach(pending);
            var response = pending.join();
            int status = response.statusCode();
            byte[] rawBody = response.body() == null ? new byte[0] : response.body();
            if (status < 200 || status >= 300) {
                byte[] clipped = rawBody.length > 4096 ? Arrays.copyOf(rawBody, 4096) : rawBody;
                String safeBody = EchoPolicy.redactSecrets(new String(clipped, StandardCharsets.UTF_8));
                byte[] safeBytes = safeBody.getBytes(StandardCharsets.UTF_8);
                HttpStatusCode statusCode = HttpStatusCode.valueOf(status);
                if (status >= 500) {
                    throw HttpServerErrorException.create(statusCode, "Provider error", HttpHeaders.EMPTY, safeBytes, StandardCharsets.UTF_8);
                }
                throw HttpClientErrorException.create(statusCode, "Provider error", HttpHeaders.EMPTY, safeBytes, StandardCharsets.UTF_8);
            }
            if (rawBody.length == 0) {
                throw new HttpServerErrorException(org.springframework.http.HttpStatus.BAD_GATEWAY);
            }
            Map<?, ?> parsed = mapper.readValue(rawBody, Map.class);
            if (parsed == null) {
                throw new HttpServerErrorException(org.springframework.http.HttpStatus.BAD_GATEWAY);
            }
            return parsed;
        } catch (CompletionException e) {
            control.check();
            Throwable cause = e.getCause();
            if (cause instanceof TimeoutException) {
                throw new ResourceAccessException("Echo provider timeout", new java.net.SocketTimeoutException("Read timed out"));
            }
            IOException io = cause instanceof IOException c ? c : new IOException("Provider transport failed");
            throw new ResourceAccessException("Echo provider transport failed", io);
        } catch (IOException e) {
            control.check();
            throw new ResourceAccessException("Echo provider JSON parse failed", e);
        } finally {
            control.clear();
        }
    }

    private static final class Call {
        String id = "";
        final StringBuilder name = new StringBuilder(), arguments = new StringBuilder();
        Map<String,Object> finish(int index) throws IOException {
            String cleanId = id == null || id.isBlank() ? ("call_" + index) : id.trim();
            if (!cleanId.matches("[A-Za-z0-9_.:-]{1,128}") || !name.toString().matches("[a-z_]{3,40}")) throw invalid();
            return Map.of("id",cleanId,"type","function","function",Map.of("name",name.toString(),"arguments",arguments.toString()));
        }
    }

    static Map<?,?> parse(InputStream in, ObjectMapper mapper, Control control, Consumer<String> output,
                          Consumer<Map<?,?>> usage, Runnable accepted) throws IOException {
        return parse(in, mapper, control, output, usage, accepted, false);
    }

    static Map<?,?> parse(InputStream in, ObjectMapper mapper, Control control, Consumer<String> output,
                          Consumer<Map<?,?>> usage, Runnable accepted, boolean allowToolsWithOutput) throws IOException {
        var answer = new StringBuilder();
        var calls = new TreeMap<Integer,Call>();
        String finish = null;
        var lineBytes = new ByteArrayOutputStream(256);
        var frame = new StringBuilder();
        int total = 0;
        boolean sawDone = false;
        for (int b; ; ) {
            b = in.read();
            boolean eof = (b == -1);
            if (!eof) {
                if (++total > 2_000_000 || lineBytes.size() > 131_072 || frame.length() > 65_536) throw invalid();
                if (b != '\n') { lineBytes.write(b); continue; }
            } else if (lineBytes.size() > 0) {
                String tailLine = lineBytes.toString(StandardCharsets.UTF_8);
                lineBytes.reset();
                if (tailLine.endsWith("\r")) tailLine = tailLine.substring(0, tailLine.length() - 1);
                if (tailLine.startsWith("data:")) frame.append(tailLine.substring(5).stripLeading()).append('\n');
            }
            control.check();
            if (!eof) {
                String s = lineBytes.toString(StandardCharsets.UTF_8);
                lineBytes.reset();
                if (s.endsWith("\r")) s = s.substring(0,s.length()-1);
                if (!s.isEmpty()) {
                    if (s.startsWith("data:")) frame.append(s.substring(5).stripLeading()).append('\n');
                    continue;
                }
            }
            if (frame.isEmpty()) {
                if (eof) break;
                continue;
            }
            String data = frame.toString().stripTrailing(); frame.setLength(0);
            if (data.equals("[DONE]")) {
                sawDone = true;
                break;
            }
            var chunk = mapper.readTree(data);
            if (chunk == null || !chunk.isObject() || chunk.hasNonNull("error")) throw invalid();
            if (chunk.path("usage").isObject()) usage.accept(mapper.convertValue(chunk.get("usage"), Map.class));
            var choices = chunk.path("choices");
            if (!choices.isArray() || choices.size() > 1) throw invalid();
            if (choices.isEmpty()) {
                if (eof) break;
                continue;
            }
            var choice = choices.get(0);
            if (choice.path("index").asInt(0) != 0) throw invalid();
            var delta = choice.path("delta");
            if (!delta.isObject()) throw invalid();
            if (delta.hasNonNull("role")) {
                String role = delta.path("role").asText("").trim();
                if (!role.isEmpty() && !"assistant".equals(role)) throw invalid();
            }
            boolean hasToolCallsArray = delta.hasNonNull("tool_calls")
                    && (!delta.get("tool_calls").isArray() || !delta.get("tool_calls").isEmpty());
            // OpenRouter / OpenAI / Anthropic / Gemini may emit trailing usage or empty chunks after finish_reason.
            if (finish != null) {
                String trailingFinish = choice.hasNonNull("finish_reason") ? normalizeFinishReason(choice.path("finish_reason").asText("")) : "";
                boolean emptyDelta = delta.path("content").asText("").isEmpty() && !hasToolCallsArray;
                if (emptyDelta && (trailingFinish.isEmpty() || finish.equals(trailingFinish))) {
                    if (eof) break;
                    continue;
                }
                throw invalid();
            }
            if (delta.hasNonNull("content")) {
                var field = delta.get("content");
                if (!field.isTextual() || answer.length()+field.textValue().length()>12000) throw invalid();
                if (!field.textValue().isEmpty()) {
                    accepted.run();
                    answer.append(field.textValue());
                    if (output != null && calls.isEmpty()) output.accept(answer.toString());
                }
            }
            if (hasToolCallsArray) {
                if ((output != null && !allowToolsWithOutput) || !delta.get("tool_calls").isArray()) throw invalid();
                for (JsonNode part : delta.get("tool_calls")) {
                    int index = part.path("index").asInt(0);
                    if (index < 0 || index >= 4) throw invalid();
                    accepted.run();
                    Call call = calls.computeIfAbsent(index, i -> new Call());
                    if (part.hasNonNull("id")) {
                        String id = part.path("id").asText("").trim();
                        if (!id.isEmpty()) {
                            if (!call.id.isEmpty() && !call.id.equals(id)) throw invalid();
                            call.id = id;
                        }
                    }
                    var fn = part.path("function");
                    call.name.append(fn.path("name").asText(""));
                    call.arguments.append(fn.path("arguments").asText(""));
                    if (call.name.length()>40 || call.arguments.length()>MAX_TOOL_ARGS_CHARS) throw invalid();
                }
            }
            if (choice.hasNonNull("finish_reason")) {
                String normFinish = normalizeFinishReason(choice.path("finish_reason").asText(""));
                if (!normFinish.isEmpty()) {
                    if (!Set.of("stop","tool_calls","length").contains(normFinish)) throw invalid();
                    finish = normFinish;
                }
            }
            if (eof) break;
        }
        if ("length".equals(finish))
            throw new org.springframework.web.server.ResponseStatusException(org.springframework.http.HttpStatus.UNPROCESSABLE_ENTITY, "Echo output limit");
        if (!sawDone || finish == null) throw invalid();
        if (calls.isEmpty() && !"stop".equals(finish)) throw invalid();
        if (!calls.isEmpty() && !"tool_calls".equals(finish) && !(allowToolsWithOutput && "stop".equals(finish))) throw invalid();
        List<Map<String,Object>> complete = new ArrayList<>();
        for (var entry : calls.entrySet()) complete.add(entry.getValue().finish(entry.getKey()));
        return Map.of("choices",List.of(Map.of("message",Map.of("content",answer.toString(),"tool_calls",complete))));
    }

    private static String normalizeFinishReason(String raw) {
        if (raw == null) return "";
        String f = raw.trim().toLowerCase(Locale.ROOT);
        if (f.isEmpty() || "null".equals(f)) return "";
        return switch (f) {
            case "end_turn" -> "stop";
            case "function_call" -> "tool_calls";
            case "max_tokens" -> "length";
            default -> f;
        };
    }

    private static IOException invalid() { return new IOException("Incomplete or invalid provider stream"); }
}
