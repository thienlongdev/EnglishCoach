package com.englishcoach.garden.api;

import com.englishcoach.auth.service.LoginThrottleService;
import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.garden.application.AnimalService;
import com.englishcoach.garden.application.SellService;
import jakarta.validation.Valid;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.UUID;

/**
 * Echo Garden Phase 3H: livestock and guardian pets ({@code /api/v1/garden/animals}) and the sale of harvest portions.
 * Authenticated by the existing security chain; the acting user always comes from the principal and every command acts
 * on that user's own garden (no path or body names another player). Every POST requires an {@code Idempotency-Key} UUID
 * header and is throttled per user through the shared rate-limit store. The animals themselves are part of
 * {@code GET /state}. Users without garden access get 404 like everywhere else in the garden.
 */
@RestController
@RequestMapping("/api/v1/garden")
public class GardenAnimalController {

    private static final String CODE = "^[A-Z_]{1,24}$";

    private final AnimalService animals;
    private final SellService sell;
    private final LoginThrottleService throttle;

    public GardenAnimalController(AnimalService animals, SellService sell, LoginThrottleService throttle) {
        this.animals = animals;
        this.sell = sell;
        this.throttle = throttle;
    }

    @PostMapping("/animals/houses/{code}/build")
    public ResponseEntity<GardenDtos.AnimalReceipt> build(@AuthenticationPrincipal UserDetailsImpl user,
                                                          @RequestHeader(value = "Idempotency-Key", required = false) UUID key,
                                                          @PathVariable String code) {
        return ok(animals.buildHouse(mutation(user), key, code(code)));
    }

    @PostMapping("/animals/houses/{code}/feed")
    public ResponseEntity<GardenDtos.AnimalReceipt> feed(@AuthenticationPrincipal UserDetailsImpl user,
                                                         @RequestHeader(value = "Idempotency-Key", required = false) UUID key,
                                                         @PathVariable String code) {
        return ok(animals.feedHouse(mutation(user), key, code(code)));
    }

    @PostMapping("/animals/houses/{code}/water")
    public ResponseEntity<GardenDtos.AnimalReceipt> water(@AuthenticationPrincipal UserDetailsImpl user,
                                                          @RequestHeader(value = "Idempotency-Key", required = false) UUID key,
                                                          @PathVariable String code) {
        return ok(animals.water(mutation(user), key, code(code)));
    }

    @PostMapping("/animals/houses/{code}/collect")
    public ResponseEntity<GardenDtos.AnimalReceipt> collect(@AuthenticationPrincipal UserDetailsImpl user,
                                                            @RequestHeader(value = "Idempotency-Key", required = false) UUID key,
                                                            @PathVariable String code) {
        return ok(animals.collect(mutation(user), key, code(code)));
    }

    /** A young animal into its house, or the adoption of a guardian pet (the species decides). */
    @PostMapping("/animals/buy")
    public ResponseEntity<GardenDtos.AnimalReceipt> buy(@AuthenticationPrincipal UserDetailsImpl user,
                                                        @RequestHeader(value = "Idempotency-Key", required = false) UUID key,
                                                        @Valid @RequestBody GardenDtos.AnimalBuyRequest request) {
        return ok(animals.buy(mutation(user), key, request.species()));
    }

    @PostMapping("/animals/guardians/{species}/feed")
    public ResponseEntity<GardenDtos.AnimalReceipt> feedGuardian(@AuthenticationPrincipal UserDetailsImpl user,
                                                                 @RequestHeader(value = "Idempotency-Key", required = false) UUID key,
                                                                 @PathVariable String species) {
        return ok(animals.feedGuardian(mutation(user), key, code(species)));
    }

    @PostMapping("/animals/feed/mill")
    public ResponseEntity<GardenDtos.AnimalReceipt> mill(@AuthenticationPrincipal UserDetailsImpl user,
                                                         @RequestHeader(value = "Idempotency-Key", required = false) UUID key,
                                                         @Valid @RequestBody GardenDtos.FeedMillRequest request) {
        return ok(animals.mill(mutation(user), key, request));
    }

    @PostMapping("/animals/products/sell")
    public ResponseEntity<GardenDtos.AnimalReceipt> sellProducts(@AuthenticationPrincipal UserDetailsImpl user,
                                                                 @RequestHeader(value = "Idempotency-Key", required = false) UUID key,
                                                                 @Valid @RequestBody GardenDtos.ProductSellRequest request) {
        return ok(animals.sell(mutation(user), key, request));
    }

    @PostMapping("/animals/compost")
    public ResponseEntity<GardenDtos.AnimalReceipt> compost(@AuthenticationPrincipal UserDetailsImpl user,
                                                            @RequestHeader(value = "Idempotency-Key", required = false) UUID key,
                                                            @Valid @RequestBody GardenDtos.ManureCompostRequest request) {
        return ok(animals.compost(mutation(user), key, request.batches()));
    }

    /** Phase 3H: harvest portions (fragments of a produce unit) sold at their proportional value. */
    @PostMapping("/sell/shares")
    public ResponseEntity<GardenDtos.ShareSellResult> sellShares(@AuthenticationPrincipal UserDetailsImpl user,
                                                                 @RequestHeader(value = "Idempotency-Key", required = false) UUID key,
                                                                 @Valid @RequestBody GardenDtos.ShareSellRequest request) {
        return ok(sell.sellShares(mutation(user), key, request));
    }

    private static String code(String raw) {
        if (raw == null || !raw.matches(CODE)) throw new GardenException(404, "ANIMAL_NOT_FOUND");
        return raw;
    }

    private long mutation(UserDetailsImpl user) {
        if (user == null || user.getId() == null) throw new GardenException(401, "AUTH_REQUIRED");
        long id = user.getId();
        if (!throttle.countRequest("GARDEN_COMMAND", "user:" + id, 240, 1)) throw new GardenException(429, "RATE_LIMITED");
        return id;
    }

    private <T> ResponseEntity<T> ok(T body) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(body);
    }
}
