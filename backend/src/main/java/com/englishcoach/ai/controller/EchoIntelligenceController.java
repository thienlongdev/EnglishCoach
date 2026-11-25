package com.englishcoach.ai.controller;

import com.englishcoach.ai.echo.EchoConfirmations;
import com.englishcoach.ai.echo.EchoLearnerBrain;
import com.englishcoach.ai.echo.EchoMemoryService;
import com.englishcoach.ai.echo.EchoSuggestionService;
import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.echocoach.service.EchoCoachService;
import com.englishcoach.speaking.service.SpeakingTtsService;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.constraints.Pattern;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;
import java.io.OutputStream;
import java.util.List;
import java.util.Map;

/**
 * Echo's learner-owned surfaces next to the chat: what Echo remembers (list / delete), the single-use confirmation of a
 * prepared change, deterministic suggestions, zero-token Brain pre-warming (`/api/v1/ai/chat/warm`), barge-in heard-audio
 * truncation (`/api/v1/ai/chat/truncate`), and low-latency streaming 24 kHz PCM synthesis (`/api/v1/ai/chat/speech/stream`).
 * Every call is scoped strictly by the authenticated principal; no id of another learner is accepted or returned.
 */
@RestController
public class EchoIntelligenceController {
    private final EchoMemoryService memory;
    private final EchoLearnerBrain brain;
    private final EchoConfirmations confirmations;
    private final EchoSuggestionService suggestions;
    private EchoCoachService coachSessions;
    private SpeakingTtsService voices;

    public EchoIntelligenceController(EchoMemoryService memory, EchoLearnerBrain brain, EchoConfirmations confirmations,
                                      EchoSuggestionService suggestions) {
        this.memory = memory;
        this.brain = brain;
        this.confirmations = confirmations;
        this.suggestions = suggestions;
    }

    @Autowired
    public EchoIntelligenceController(EchoMemoryService memory, EchoLearnerBrain brain, EchoConfirmations confirmations,
                                      EchoSuggestionService suggestions,
                                      @Autowired(required = false) EchoCoachService coachSessions,
                                      @Autowired(required = false) SpeakingTtsService voices) {
        this(memory, brain, confirmations, suggestions);
        this.coachSessions = coachSessions;
        this.voices = voices;
    }

    public record DecisionRequest(@Pattern(regexp = "CONFIRM|CANCEL") String decision) {}
    public record TruncateRequest(Long sessionId, String spokenText) {}
    public record SpeechStreamRequest(String voiceId, String text) {}

    @GetMapping("/api/v1/echo/memory")
    public ResponseEntity<List<EchoMemoryService.Item>> memory(@AuthenticationPrincipal UserDetailsImpl user) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(memory.list(owner(user)));
    }

    @DeleteMapping("/api/v1/echo/memory/{id}")
    public ResponseEntity<Void> forget(@AuthenticationPrincipal UserDetailsImpl user, @PathVariable long id) {
        long userId = owner(user);
        if (!memory.delete(userId, id)) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "NOT_FOUND");
        brain.forget(userId);
        return ResponseEntity.noContent().build();
    }

    @DeleteMapping("/api/v1/echo/memory")
    public ResponseEntity<Map<String, Integer>> forgetAll(@AuthenticationPrincipal UserDetailsImpl user) {
        long userId = owner(user);
        int removed = memory.deleteAll(userId);
        brain.forget(userId);
        return ResponseEntity.ok(Map.of("removed", removed));
    }

    @PostMapping("/api/v1/echo/confirmations/{token}")
    public ResponseEntity<EchoConfirmations.Outcome> decide(@AuthenticationPrincipal UserDetailsImpl user, @PathVariable String token,
                                                            @RequestBody DecisionRequest request) {
        long userId = owner(user);
        boolean accept = request != null && "CONFIRM".equals(request.decision());
        var outcome = confirmations.decide(userId, token, accept);
        brain.forget(userId);
        return ResponseEntity.ok(outcome);
    }

    @GetMapping("/api/v1/echo/suggestions")
    public ResponseEntity<List<EchoSuggestionService.Suggestion>> suggestions(@AuthenticationPrincipal UserDetailsImpl user,
                                                                             @RequestParam(defaultValue = "vi") String locale) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(suggestions.suggestions(owner(user), !"en".equals(locale)));
    }

    /** Zero-token, zero-quota background pre-warmer for {@link EchoLearnerBrain} upon wake word or speech onset. */
    @PostMapping("/api/v1/ai/chat/warm")
    public ResponseEntity<Map<String, Boolean>> warm(@AuthenticationPrincipal UserDetailsImpl user) {
        long userId = owner(user);
        if (brain != null) {
            brain.warm(userId);
        }
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(Map.of("warm", true));
    }

    /** Truncates the latest stored assistant reply in an owned session to what the learner actually heard before barge-in. */
    @PostMapping("/api/v1/ai/chat/truncate")
    public ResponseEntity<Map<String, Boolean>> truncate(@AuthenticationPrincipal UserDetailsImpl user,
                                                         @RequestBody TruncateRequest request) {
        long userId = owner(user);
        if (request == null || request.sessionId() == null || request.sessionId() <= 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "sessionId is required");
        }
        if (coachSessions == null) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "UNAVAILABLE");
        }
        boolean truncated = coachSessions.truncateLatestAssistantMessage(userId, request.sessionId(), request.spokenText());
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(Map.of("truncated", truncated));
    }

    /** Authenticated streaming 24 kHz PCM16LE proxy (`X-Sample-Rate: 24000`, `Cache-Control: no-store`). */
    @PostMapping(value = "/api/v1/ai/chat/speech/stream", consumes = MediaType.APPLICATION_JSON_VALUE, produces = MediaType.APPLICATION_OCTET_STREAM_VALUE)
    public void streamSpeech(@AuthenticationPrincipal UserDetailsImpl user,
                             @RequestBody SpeechStreamRequest request,
                             HttpServletResponse response) throws IOException {
        long userId = owner(user);
        if (voices == null) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "UNAVAILABLE");
        }
        if (request == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid speech request");
        }
        boolean[] headersWritten = {false};
        OutputStream out = response.getOutputStream();
        voices.streamEchoSentence(userId, request.voiceId(), request.text(), chunk -> {
            if (chunk == null || chunk.length == 0) return;
            try {
                if (!headersWritten[0]) {
                    response.setStatus(HttpStatus.OK.value());
                    response.setContentType(MediaType.APPLICATION_OCTET_STREAM_VALUE);
                    response.setHeader(HttpHeaders.CACHE_CONTROL, "no-store");
                    response.setHeader("X-Accel-Buffering", "no");
                    response.setHeader("X-Sample-Rate", "24000");
                    headersWritten[0] = true;
                }
                out.write(chunk);
                out.flush();
            } catch (IOException io) {
                throw new java.io.UncheckedIOException(io);
            }
        });
    }

    private static long owner(UserDetailsImpl user) {
        if (user == null || user.getId() == null) throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "UNAUTHORIZED");
        return user.getId();
    }
}
