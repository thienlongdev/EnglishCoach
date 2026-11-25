package com.englishcoach.grammar;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.grammar.GrammarDtos.*;
import com.englishcoach.premium.interceptor.RequirePremiumAi;
import jakarta.validation.Valid;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.*;

import java.time.Duration;
import java.util.List;
import java.util.UUID;

/**
 * Echo Grammar Academy ("Ngữ pháp"). Signed-in learners only (the default rule); every learner call is scoped to the principal
 * and no endpoint takes a user id. Content GETs write nothing and revalidate by the catalog revision. No endpoint calls an AI
 * service except {@code /professor/ask}, an explicit question that draws on the shared AI allowance.
 */
@RestController
@Validated
@RequestMapping("/api/v1/grammar")
public class GrammarController {

    private static final CacheControl CONTENT = CacheControl.maxAge(Duration.ofMinutes(10)).cachePrivate().mustRevalidate();

    private final GrammarContent content;
    private final GrammarService service;
    private final GrammarProfessorFacade professor;

    public GrammarController(GrammarContent content, GrammarService service, GrammarProfessorFacade professor) {
        this.content = content;
        this.service = service;
        this.professor = professor;
    }

    @GetMapping(value = "/catalog", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<String> catalog(@RequestHeader(value = "If-None-Match", required = false) String tag) {
        return cached(content.catalogJson(), "\"g" + content.revision() + "\"", tag);
    }

    @GetMapping("/capabilities")
    public ResponseEntity<Capabilities> capabilities(@AuthenticationPrincipal UserDetailsImpl user) {
        owner(user);
        return ok(new Capabilities(professor.available()));
    }

    /** The lesson and its practice exercises, without answer keys. */
    @GetMapping(value = "/topics/{slug}", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<String> topic(@PathVariable String slug, @RequestHeader(value = "If-None-Match", required = false) String tag) {
        GrammarContent.Loaded loaded = content.load(slug);
        return cached(loaded.learnerJson(), loaded.etag(), tag);
    }

    @GetMapping(value = "/{kind:stories|lab|detective}/{id}", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<String> resource(@PathVariable String kind, @PathVariable String id, @RequestHeader(value = "If-None-Match", required = false) String tag) {
        String json = content.resource(kind, id).orElseThrow(() -> new GrammarException(404, "NOT_FOUND"));
        return cached(json, "\"g" + content.revision() + "-" + kind + "-" + id + "\"", tag);
    }

    @PostMapping("/topics/{slug}/open")
    public ResponseEntity<Void> open(@AuthenticationPrincipal UserDetailsImpl user, @PathVariable String slug) {
        service.open(owner(user), slug);
        return none();
    }

    @PostMapping("/topics/{slug}/studied")
    public ResponseEntity<Void> studied(@AuthenticationPrincipal UserDetailsImpl user, @PathVariable String slug) {
        service.studied(owner(user), slug);
        return none();
    }

    @GetMapping("/me")
    public ResponseEntity<MeView> me(@AuthenticationPrincipal UserDetailsImpl user) {
        return ok(service.me(owner(user)));
    }

    @PutMapping("/me/level")
    public ResponseEntity<Void> level(@AuthenticationPrincipal UserDetailsImpl user, @Valid @RequestBody LevelRequest request) {
        service.setLevel(owner(user), request.level());
        return none();
    }

    @PostMapping("/attempts")
    public ResponseEntity<VerdictView> attempt(@AuthenticationPrincipal UserDetailsImpl user, @Valid @RequestBody AttemptRequest request) {
        return ok(service.attempt(owner(user), request));
    }

    @GetMapping("/practice")
    public ResponseEntity<PracticeSet> practice(@AuthenticationPrincipal UserDetailsImpl user,
                                                @RequestParam(defaultValue = "mixed") String kind,
                                                @RequestParam(required = false) String domain,
                                                @RequestParam(required = false) String level,
                                                @RequestParam(required = false) String type,
                                                @RequestParam(defaultValue = "8") int size) {
        return ok(service.practice(owner(user), kind, domain, level, type, size));
    }

    @PostMapping("/checks")
    public ResponseEntity<CheckView> start(@AuthenticationPrincipal UserDetailsImpl user, @Valid @RequestBody CheckRequest request) {
        return ok(service.startCheck(owner(user), request));
    }

    @GetMapping("/checks")
    public ResponseEntity<List<CheckSummary>> history(@AuthenticationPrincipal UserDetailsImpl user) {
        return ok(service.history(owner(user)));
    }

    @GetMapping("/checks/{id}")
    public ResponseEntity<CheckView> check(@AuthenticationPrincipal UserDetailsImpl user, @PathVariable UUID id) {
        return ok(service.check(owner(user), id));
    }

    @PostMapping("/checks/{id}/submit")
    public ResponseEntity<CheckResult> submit(@AuthenticationPrincipal UserDetailsImpl user, @PathVariable UUID id, @Valid @RequestBody CheckSubmit submit) {
        return ok(service.submit(owner(user), id, submit));
    }

    @GetMapping("/mistakes")
    public ResponseEntity<MistakesView> mistakes(@AuthenticationPrincipal UserDetailsImpl user) {
        return ok(service.mistakes(owner(user)));
    }

    @PutMapping("/bookmarks/{slug}")
    public ResponseEntity<Void> bookmark(@AuthenticationPrincipal UserDetailsImpl user, @PathVariable String slug) {
        service.bookmark(owner(user), slug, true);
        return none();
    }

    @DeleteMapping("/bookmarks/{slug}")
    public ResponseEntity<Void> unbookmark(@AuthenticationPrincipal UserDetailsImpl user, @PathVariable String slug) {
        service.bookmark(owner(user), slug, false);
        return none();
    }

    @PostMapping("/reports")
    public ResponseEntity<Void> report(@AuthenticationPrincipal UserDetailsImpl user, @Valid @RequestBody ReportRequest request) {
        service.report(owner(user), request);
        return none();
    }

    @RequirePremiumAi(value = "GRAMMAR_PROFESSOR", serviceManagedReservation = true)
    @PostMapping("/professor/ask")
    public ResponseEntity<ProfessorAnswer> ask(@AuthenticationPrincipal UserDetailsImpl user, @Valid @RequestBody ProfessorRequest request,
                                              jakarta.servlet.http.HttpServletRequest http) {
        String id = null;
        for (String header : List.of("X-Client-Turn-Id", "X-Client-Attempt-Id", "X-Request-Id", "Idempotency-Key")) {
            String candidate = http.getHeader(header);
            if (candidate != null && !candidate.isBlank()) { id = candidate; break; }
        }
        return ok(professor.ask(owner(user), id, request));
    }

    private static ResponseEntity<String> cached(String body, String etag, String ifNoneMatch) {
        if (etag.equals(ifNoneMatch)) return ResponseEntity.status(304).eTag(etag).cacheControl(CONTENT).build();
        return ResponseEntity.ok().eTag(etag).cacheControl(CONTENT).contentType(MediaType.APPLICATION_JSON).body(body);
    }

    private static long owner(UserDetailsImpl user) {
        if (user == null || user.getId() == null) throw new GrammarException(401, "AUTH_REQUIRED");
        return user.getId();
    }

    private static <T> ResponseEntity<T> ok(T body) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(body);
    }

    private static ResponseEntity<Void> none() {
        return ResponseEntity.noContent().cacheControl(CacheControl.noStore()).build();
    }
}
