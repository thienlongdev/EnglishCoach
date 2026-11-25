package com.englishcoach.echolife;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.echolife.EchoLifeGameDtos.*;
import jakarta.validation.Valid;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.*;

/**
 * Echo Life game (V130) — the signed-in learner's narrative save and authoritative economy ({@code anyRequest().authenticated()};
 * CSRF as every cookie-authenticated write). Scoped to the principal: no user-id parameter, no way to name another learner's
 * game, claims or purchases. No AI, no real money.
 */
@RestController
@org.springframework.boot.autoconfigure.condition.ConditionalOnProperty(name="app.echo-life.enabled",havingValue="true",matchIfMissing=true)
@Validated
@RequestMapping("/api/v1/echo-life/game")
public class EchoLifeGameController {

    private final EchoLifeGameService games;
    private final EchoLifeBulkhead bulkhead;

    public EchoLifeGameController(EchoLifeGameService games) {
        this(games, EchoLifeBulkhead.unbounded());
    }

    @org.springframework.beans.factory.annotation.Autowired
    public EchoLifeGameController(EchoLifeGameService games, org.springframework.beans.factory.ObjectProvider<EchoLifeBulkhead> bulkhead) {
        this(games, bulkhead.getIfAvailable(EchoLifeBulkhead::unbounded));
    }

    private EchoLifeGameController(EchoLifeGameService games, EchoLifeBulkhead bulkhead) {
        this.games = games;
        this.bulkhead = bulkhead;
    }

    @GetMapping
    public ResponseEntity<Game> get(@AuthenticationPrincipal UserDetailsImpl user) {
        long uid = owner(user);
        return ok(bulkhead.execute(() -> games.get(uid)));
    }

    @PutMapping
    public ResponseEntity<Game> save(@AuthenticationPrincipal UserDetailsImpl user, @Valid @RequestBody SaveGameRequest request) {
        long uid = owner(user);
        return ok(bulkhead.execute(() -> games.save(uid, request)));
    }

    @PostMapping("/claims")
    public ResponseEntity<ClaimResult> claim(@AuthenticationPrincipal UserDetailsImpl user, @Valid @RequestBody ClaimRequest request) {
        long uid = owner(user);
        return ok(bulkhead.execute(() -> games.claim(uid, request)));
    }

    @PostMapping("/purchases")
    public ResponseEntity<PurchaseResult> purchase(@AuthenticationPrincipal UserDetailsImpl user, @Valid @RequestBody PurchaseRequest request) {
        long uid = owner(user);
        return ok(bulkhead.execute(() -> games.purchase(uid, request)));
    }

    @PostMapping("/workshop")
    public ResponseEntity<WorkshopResult> configure(@AuthenticationPrincipal UserDetailsImpl user,@Valid @RequestBody WorkshopRequest request) {
        long uid = owner(user);
        return ok(bulkhead.execute(() -> games.configure(uid, request)));
    }

    @PostMapping("/sales")
    public ResponseEntity<SaleResult> sell(@AuthenticationPrincipal UserDetailsImpl user, @Valid @RequestBody SaleRequest request) {
        long uid = owner(user);
        return ok(bulkhead.execute(() -> games.sell(uid, request)));
    }

    private static long owner(UserDetailsImpl user) {
        if (user == null || user.getId() == null) throw new EchoLifeException(401, "AUTH_REQUIRED");
        return user.getId();
    }

    private static <T> ResponseEntity<T> ok(T body) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(body);
    }
}
