package com.englishcoach.speaking.arena;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.http.HttpStatus;
import java.net.URI;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.time.*;
import java.util.*;

/** LiveKit Cloud only: strict token revocation is a Cloud security guarantee, not a self-hosted assumption. */
@Component
public final class LiveKitArenaVoice implements ArenaVoice {
    private final boolean enabled;
    private final String endpoint, key, secret;
    private final ObjectMapper json;
    @Value("${SPEAKING_ARENA_MAX_PARTICIPANTS:16}") private int maxParticipants = 16;
    private final Object admissionsLock = new Object();
    private final Map<String, Set<String>> admissions = new HashMap<>();
    private final HttpClient http;

    @Autowired
    public LiveKitArenaVoice(@Value("${SPEAKING_ARENA_ENABLED:false}") boolean enabled,
            @Value("${LIVEKIT_URL:}") String endpoint, @Value("${LIVEKIT_API_KEY:}") String key,
            @Value("${LIVEKIT_API_SECRET:}") String secret, ObjectMapper json) {
        this(enabled, endpoint, key, secret, json, 16, HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3))
                .followRedirects(HttpClient.Redirect.NEVER).build());
    }

    LiveKitArenaVoice(boolean enabled, String endpoint, String key, String secret, ObjectMapper json, int maxParticipants, HttpClient http) {
        this.enabled = enabled;
        this.endpoint = endpoint;
        this.key = key;
        this.secret = secret;
        this.json = json;
        this.maxParticipants = maxParticipants;
        this.http = http;
        if (enabled && !valid()) throw new IllegalStateException("Speaking Arena requires valid LiveKit Cloud configuration");
    }

    private boolean valid() {
        try {
            URI u = URI.create(endpoint);
            return "wss".equals(u.getScheme()) && u.getHost() != null && u.getHost().endsWith(".livekit.cloud")
                    && u.getUserInfo() == null && u.getPort() == -1 && (u.getPath().isEmpty() || u.getPath().equals("/"))
                    && u.getQuery() == null && u.getFragment() == null && !key.isBlank() && secret.getBytes(StandardCharsets.UTF_8).length >= 32;
        } catch (Exception ignored) { return false; }
    }

    public boolean available() { return enabled && valid(); }
    public String url() { return endpoint; }

    private String jwt(String identity, Map<String, Object> grants) {
        Instant now = Instant.now();
        return Jwts.builder().issuer(key).subject(identity).issuedAt(Date.from(now))
                .notBefore(Date.from(now.minusSeconds(1))).expiration(Date.from(now.plusSeconds(120)))
                .claim("video", grants).signWith(Keys.hmacShaKeyFor(secret.getBytes(StandardCharsets.UTF_8)), Jwts.SIG.HS256).compact();
    }

    private int totalAdmissionsLocked() {
        int total = 0;
        for (Set<String> members : admissions.values()) total += members.size();
        return total;
    }

    int admittedCount() {
        synchronized (admissionsLock) {
            return totalAdmissionsLocked();
        }
    }

    int admittedRoomCount() {
        synchronized (admissionsLock) {
            return admissions.size();
        }
    }

    @Override
    public String token(String room, String identity, boolean publish) {
        if (!available()) throw unavailable();
        boolean added = false;
        synchronized (admissionsLock) {
            Set<String> members = admissions.get(room);
            if (members == null || !members.contains(identity)) {
                if (totalAdmissionsLocked() >= Math.max(2, Math.min(64, maxParticipants))) {
                    throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS, "VOICE_PROVIDER_LIMIT");
                }
                admissions.computeIfAbsent(room, k -> new HashSet<>()).add(identity);
                added = true;
            }
        }
        try {
            return jwt(identity, Map.of("room", room, "roomJoin", true, "canSubscribe", true,
                    "canPublish", publish, "canPublishData", false, "canPublishSources", List.of("microphone"),
                    "canUpdateOwnMetadata", false));
        } catch (RuntimeException e) {
            if (added) evictIdentity(room, identity);
            throw e;
        }
    }

    private int call(String method, String room, Map<String, Object> body, boolean createGrant) {
        if (!available()) throw unavailable();
        try {
            var grants = createGrant ? Map.<String, Object>of("roomCreate", true) : Map.<String, Object>of("room", room, "roomAdmin", true);
            URI uri = URI.create(endpoint.replaceFirst("^wss:", "https:").replaceAll("/$", "") + "/twirp/livekit.RoomService/" + method);
            var request = HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(4))
                    .header("Authorization", "Bearer " + jwt("", grants)).header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body))).build();
            var response = http.send(request, HttpResponse.BodyHandlers.discarding());
            int status = response.statusCode();
            if (status == 402) throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS, "VOICE_QUOTA_EXHAUSTED");
            if (status == 429) throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS, "VOICE_PROVIDER_LIMIT");
            if (status != 200 && !((method.equals("DeleteRoom") || method.equals("RemoveParticipant")) && status == 404)) throw unavailable();
            return status;
        } catch (InterruptedException e) { Thread.currentThread().interrupt(); throw unavailable(); }
        catch (ResponseStatusException e) { throw e; }
        catch (Exception e) { throw unavailable(); } // never return provider bodies, headers or credentials
    }

    /** The provider's own list: the only source of how long a connection lasted. Null on anything but a clean answer, so that a failure never reads as "nobody there". */
    @Override
    public Map<String, Long> participants(String room) {
        if (!available()) return null;
        try {
            URI uri = URI.create(endpoint.replaceFirst("^wss:", "https:").replaceAll("/$", "") + "/twirp/livekit.RoomService/ListParticipants");
            var request = HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(4))
                    .header("Authorization", "Bearer " + jwt("", Map.of("room", room, "roomAdmin", true))).header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(Map.of("room", room)))).build();
            var response = http.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() == 404) return Map.of();
            if (response.statusCode() != 200) return null;
            return present(json.readTree(response.body()));
        } catch (InterruptedException e) { Thread.currentThread().interrupt(); return null; }
        catch (Exception e) { return null; } // never return provider bodies, headers or credentials
    }

    /** Who the provider says is connected, and since when. A real server answers state "ACTIVE" and joined_at as a string of seconds (checked against livekit-server 1.9.0). */
    static Map<String, Long> present(com.fasterxml.jackson.databind.JsonNode answer) {
        Map<String, Long> out = new HashMap<>();
        for (var p : answer.path("participants")) {
            String identity = p.path("identity").asText("");
            var state = p.path("state");
            if (identity.isEmpty() || "DISCONNECTED".equals(state.asText()) || (state.isNumber() && state.asInt() == 3)) continue;
            var at = p.has("joined_at") ? p.path("joined_at") : p.path("joinedAt");
            long seconds = at.isNumber() ? at.asLong() : at.isTextual() && !at.asText("").isBlank() ? Long.parseLong(at.asText()) : 0;
            out.put(identity, seconds * 1000);
        }
        return out;
    }

    @Override
    public void create(String room, int capacity) {
        call("CreateRoom", room, Map.of("name", room, "max_participants", capacity, "empty_timeout", 60, "departure_timeout", 20), true);
    }

    @Override
    public boolean remove(String room, String identity) {
        // Explicit cutoff closes Cloud's default one-minute revocation buffer, including a same-second SDK refresh.
        int status = call("RemoveParticipant", room, Map.of("room", room, "identity", identity, "revoke_token_ts", Instant.now().getEpochSecond() + 1), false);
        evictIdentity(room, identity);
        return status == 200;
    }

    @Override
    public void close(String room) {
        call("DeleteRoom", room, Map.of("room", room), true);
        synchronized (admissionsLock) {
            admissions.remove(room);
        }
    }

    @Override
    public void evictIdentity(String mediaRoom, String identity) {
        if (mediaRoom == null || identity == null) return;
        synchronized (admissionsLock) {
            Set<String> members = admissions.get(mediaRoom);
            if (members != null) {
                members.remove(identity);
                if (members.isEmpty()) admissions.remove(mediaRoom);
            }
        }
    }

    @Override
    public void reconcileRoom(String mediaRoom, Set<String> activeIdentities) {
        if (mediaRoom == null || activeIdentities == null) return;
        synchronized (admissionsLock) {
            Set<String> members = admissions.get(mediaRoom);
            if (members == null) return;
            members.retainAll(activeIdentities);
            if (members.isEmpty()) admissions.remove(mediaRoom);
        }
    }

    private static ResponseStatusException unavailable() { return new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "VOICE_UNAVAILABLE"); }
}
