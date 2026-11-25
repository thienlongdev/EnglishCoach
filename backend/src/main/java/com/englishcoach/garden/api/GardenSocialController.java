package com.englishcoach.garden.api;

import com.englishcoach.auth.service.LoginThrottleService;
import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.garden.application.SocialService;
import jakarta.validation.Valid;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.UUID;

/**
 * Echo Garden Phase 3G: social islands ({@code /api/v1/garden/social}). Authenticated by the existing security chain;
 * the acting user always comes from the principal, another island is named only by its public handle, and no response
 * carries an account id, an e-mail or a login. Users without garden access get 404 like everywhere else in the garden.
 * Every state-changing POST requires an {@code Idempotency-Key} UUID header. Reads and commands are throttled per user
 * and minute through the shared rate-limit store.
 */
@RestController
@RequestMapping("/api/v1/garden/social")
public class GardenSocialController {

    private final SocialService social;
    private final LoginThrottleService throttle;

    public GardenSocialController(SocialService social, LoginThrottleService throttle) {
        this.social = social;
        this.throttle = throttle;
    }

    /** The caller's own social standing: handle, visibility, protection, what they may take, fragments, rules. */
    @GetMapping("/me")
    public ResponseEntity<GardenDtos.SocialMeView> me(@AuthenticationPrincipal UserDetailsImpl user) {
        return ok(social.me(limited(user, "GARDEN_SOCIAL_READ", 60)));
    }

    @PostMapping("/visibility")
    public ResponseEntity<GardenDtos.SocialMeView> visibility(@AuthenticationPrincipal UserDetailsImpl user,
                                                              @RequestHeader(value = "Idempotency-Key", required = false) UUID key,
                                                              @Valid @RequestBody GardenDtos.SocialVisibilityRequest request) {
        return ok(social.setVisibility(limited(user, "GARDEN_SOCIAL_COMMAND", 20), key, request.visibility()));
    }

    /** Open islands (keyset pages), or one bounded search page when {@code q} is given. */
    @GetMapping("/islands")
    public ResponseEntity<GardenDtos.DiscoverPage> islands(@AuthenticationPrincipal UserDetailsImpl user,
                                                           @RequestParam(value = "cursor", required = false) String cursor,
                                                           @RequestParam(value = "q", required = false) String q) {
        String query = q == null ? null : (q.length() > 40 ? q.substring(0, 40) : q);
        String page = cursor == null || cursor.length() > 40 ? null : cursor;
        return ok(social.discover(limited(user, "GARDEN_SOCIAL_DISCOVER", 30), page, query));
    }

    @GetMapping("/visited")
    public ResponseEntity<GardenDtos.DiscoverPage> visited(@AuthenticationPrincipal UserDetailsImpl user) {
        return ok(social.visited(limited(user, "GARDEN_SOCIAL_READ", 60)));
    }

    /** A read-only picture of an open island (records the visit). */
    @GetMapping("/islands/{handle}")
    public ResponseEntity<GardenDtos.IslandView> island(@AuthenticationPrincipal UserDetailsImpl user, @PathVariable String handle) {
        return ok(social.visit(limited(user, "GARDEN_SOCIAL_VISIT", 20), handle(handle)));
    }

    /** Take a little from one ripe crop of an open island; the server decides whether and how much. */
    @PostMapping("/islands/{handle}/take")
    public ResponseEntity<GardenDtos.TakeReceipt> take(@AuthenticationPrincipal UserDetailsImpl user,
                                                       @RequestHeader(value = "Idempotency-Key", required = false) UUID key,
                                                       @PathVariable String handle,
                                                       @Valid @RequestBody GardenDtos.SocialTakeRequest request) {
        return ok(social.take(limited(user, "GARDEN_SOCIAL_TAKE", 6), key, handle(handle), request.plantingId()));
    }

    @PostMapping("/islands/{handle}/react")
    public ResponseEntity<GardenDtos.ReactionReceipt> react(@AuthenticationPrincipal UserDetailsImpl user,
                                                            @RequestHeader(value = "Idempotency-Key", required = false) UUID key,
                                                            @PathVariable String handle,
                                                            @Valid @RequestBody GardenDtos.SocialReactRequest request) {
        return ok(social.react(limited(user, "GARDEN_SOCIAL_COMMAND", 20), key, handle(handle), request.code()));
    }

    /** The caller's own activity record (what was taken from their island and by whom, what they took). */
    @GetMapping("/activity")
    public ResponseEntity<GardenDtos.ActivityPage> activity(@AuthenticationPrincipal UserDetailsImpl user,
                                                            @RequestParam(value = "before", required = false) Long before) {
        return ok(social.activity(limited(user, "GARDEN_SOCIAL_READ", 60), before));
    }

    @PostMapping("/activity/seen")
    public ResponseEntity<GardenDtos.SocialAck> activitySeen(@AuthenticationPrincipal UserDetailsImpl user,
                                                             @RequestHeader(value = "Idempotency-Key", required = false) UUID key) {
        return ok(social.activitySeen(limited(user, "GARDEN_SOCIAL_COMMAND", 20), key));
    }

    /** A public island handle from the path (eight unambiguous characters); anything else is an unknown island. */
    private static String handle(String raw) {
        if (raw == null || !raw.matches("^[A-HJ-NP-Z2-9]{8}$")) throw new GardenException(404, "ISLAND_NOT_FOUND");
        return raw;
    }

    private long limited(UserDetailsImpl user, String kind, int perMinute) {
        if (user == null || user.getId() == null) throw new GardenException(401, "AUTH_REQUIRED");
        long id = user.getId();
        if (!throttle.countRequest(kind, "user:" + id, perMinute, 1)) throw new GardenException(429, "RATE_LIMITED");
        return id;
    }

    private <T> ResponseEntity<T> ok(T body) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(body);
    }
}
