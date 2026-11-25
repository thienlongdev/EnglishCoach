package com.englishcoach.garden.api;

import com.englishcoach.auth.service.LoginThrottleService;
import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.garden.application.GardenAdminQaService;
import jakarta.validation.Valid;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.UUID;

/**
 * Echo Garden Phase 4: the official administrator's QA access to every cosmetic and every animal, on the
 * administrator's OWN garden. Three independent gates: the {@code /api/v1/admin/**} URL rule, method security, and
 * {@link GardenAdminQaService} re-checking the official administrator on every call. No endpoint takes a user id, a
 * handle or any other target; the acting garden is always the principal's. Same conventions as the other garden
 * controllers: no-store responses, the {@code Idempotency-Key} UUID header on every mutation, the shared rate-limit
 * store.
 */
@RestController
@RequestMapping("/api/v1/admin/garden/qa")
@PreAuthorize("hasRole('ADMIN')")
public class GardenAdminQaController {

    private final GardenAdminQaService qa;
    private final LoginThrottleService throttle;

    public GardenAdminQaController(GardenAdminQaService qa, LoginThrottleService throttle) {
        this.qa = qa;
        this.throttle = throttle;
    }

    @GetMapping
    public ResponseEntity<GardenDtos.AdminQaStatus> status(@AuthenticationPrincipal UserDetailsImpl user) {
        return ok(qa.status(owner(user)));
    }

    @PostMapping("/cosmetics/unlock")
    public ResponseEntity<GardenDtos.AdminQaCosmeticsReceipt> unlock(@AuthenticationPrincipal UserDetailsImpl user,
                                                                     @RequestHeader(value = "Idempotency-Key", required = false) UUID key) {
        return ok(qa.unlockCosmetics(mutation(user), key));
    }

    @PostMapping("/cosmetics/revoke")
    public ResponseEntity<GardenDtos.AdminQaCosmeticsReceipt> revoke(@AuthenticationPrincipal UserDetailsImpl user,
                                                                     @RequestHeader(value = "Idempotency-Key", required = false) UUID key) {
        return ok(qa.revokeCosmetics(mutation(user), key));
    }

    @PostMapping("/animals/provision")
    public ResponseEntity<GardenDtos.AdminQaAnimalsReceipt> provision(@AuthenticationPrincipal UserDetailsImpl user,
                                                                      @RequestHeader(value = "Idempotency-Key", required = false) UUID key) {
        return ok(qa.provisionAnimals(mutation(user), key));
    }

    @PostMapping("/animals/advance")
    public ResponseEntity<GardenDtos.AdminQaAnimalsReceipt> advance(@AuthenticationPrincipal UserDetailsImpl user,
                                                                    @RequestHeader(value = "Idempotency-Key", required = false) UUID key,
                                                                    @Valid @RequestBody GardenDtos.AdminQaAdvanceRequest request) {
        return ok(qa.advanceAnimals(mutation(user), key, request.hours()));
    }

    private long owner(UserDetailsImpl user) {
        if (user == null || user.getId() == null) throw new GardenException(401, "AUTH_REQUIRED");
        return user.getId();
    }

    private long mutation(UserDetailsImpl user) {
        long id = owner(user);
        if (!throttle.countRequest("GARDEN_ADMIN_QA", "user:" + id, 30, 1)) throw new GardenException(429, "RATE_LIMITED");
        return id;
    }

    private <T> ResponseEntity<T> ok(T body) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(body);
    }
}
