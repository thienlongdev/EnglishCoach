package com.englishcoach.speaking.topic;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.speaking.topic.TopicDtos.*;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Pattern;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.*;

/**
 * "Nói theo chủ đề" — topic speaking practice inside Speaking. Signed-in learners only ({@code /api/v1/speaking/**} rule);
 * every learner-data call is scoped to the principal. Nothing here calls an AI service or consumes a Premium quota.
 */
@RestController
@Validated
@RequestMapping("/api/v1/speaking/topics")
public class TopicController {

    private final TopicService topics;

    public TopicController(TopicService topics) {
        this.topics = topics;
    }

    @GetMapping("/catalog")
    public ResponseEntity<Catalog> catalog() {
        return ok(topics.catalog());
    }

    @GetMapping("/items/{itemId}")
    public ResponseEntity<ItemView> item(@PathVariable @Pattern(regexp = "[A-Z0-9-]{3,24}") String itemId) {
        return ok(topics.item(itemId));
    }

    @PostMapping("/draws")
    public ResponseEntity<DrawResponse> draw(@AuthenticationPrincipal UserDetailsImpl user, @Valid @RequestBody DrawRequest request) {
        return ok(topics.draw(owner(user), request));
    }

    @PostMapping("/draws/{drawId}/start")
    public ResponseEntity<RoundView> start(@AuthenticationPrincipal UserDetailsImpl user, @PathVariable long drawId,
                                           @Valid @RequestBody StartRequest request) {
        return ok(topics.start(owner(user), drawId, request));
    }

    @PostMapping("/draws/{drawId}/finish")
    public ResponseEntity<RoundView> finish(@AuthenticationPrincipal UserDetailsImpl user, @PathVariable long drawId,
                                            @Valid @RequestBody FinishRequest request) {
        return ok(topics.finish(owner(user), drawId, request));
    }

    @GetMapping("/summary")
    public ResponseEntity<Summary> summary(@AuthenticationPrincipal UserDetailsImpl user) {
        return ok(topics.summary(owner(user)));
    }

    @PutMapping("/favorites/{itemId}")
    public ResponseEntity<Void> addFavorite(@AuthenticationPrincipal UserDetailsImpl user,
                                            @PathVariable @Pattern(regexp = "[A-Z0-9-]{3,24}") String itemId) {
        topics.favorite(owner(user), itemId, true);
        return ResponseEntity.noContent().cacheControl(CacheControl.noStore()).build();
    }

    @DeleteMapping("/favorites/{itemId}")
    public ResponseEntity<Void> removeFavorite(@AuthenticationPrincipal UserDetailsImpl user,
                                               @PathVariable @Pattern(regexp = "[A-Z0-9-]{3,24}") String itemId) {
        topics.favorite(owner(user), itemId, false);
        return ResponseEntity.noContent().cacheControl(CacheControl.noStore()).build();
    }

    private static long owner(UserDetailsImpl user) {
        if (user == null || user.getId() == null) throw new TopicException(401, "AUTH_REQUIRED");
        return user.getId();
    }

    private static <T> ResponseEntity<T> ok(T body) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(body);
    }
}
