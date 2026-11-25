package com.englishcoach.garden.api;

import com.englishcoach.auth.service.LoginThrottleService;
import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.garden.application.CosmeticCheckoutService;
import com.englishcoach.garden.application.EchoRewardService;
import jakarta.validation.Valid;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

import java.util.UUID;

/**
 * Echo Garden Phase 3F REST surface: Echo Rewards for Echo Coins (Premium 7 days, AI voucher packs, profile frames) and
 * the player's own cosmetic orders paid by bank transfer. Same conventions as {@link GardenController}: authenticated by
 * the existing security chain, the principal supplies ownership, every response is no-store, every mutation needs the
 * {@code Idempotency-Key} UUID header and shares the garden's rate-limit store; users without garden access get 404.
 *
 * <p>The administrator's reconciliation queue lives under {@code /api/v1/admin/garden/commerce} (URL rule + method
 * security + the service re-checking the official administrator).</p>
 */
@RestController
public class GardenRewardController {

    private final EchoRewardService rewards;
    private final CosmeticCheckoutService checkout;
    private final LoginThrottleService throttle;

    public GardenRewardController(EchoRewardService rewards, CosmeticCheckoutService checkout, LoginThrottleService throttle) {
        this.rewards = rewards;
        this.checkout = checkout;
        this.throttle = throttle;
    }

    // ------------------------------------------------------------------ Echo Rewards

    @GetMapping("/api/v1/garden/rewards/echo")
    public ResponseEntity<GardenDtos.EchoRewardsView> echoRewards(@AuthenticationPrincipal UserDetailsImpl user) {
        return ok(rewards.view(owner(user)));
    }

    @PostMapping("/api/v1/garden/rewards/premium/redeem")
    public ResponseEntity<GardenDtos.PremiumRewardReceipt> redeemPremium(@AuthenticationPrincipal UserDetailsImpl user,
                                                                         @RequestHeader(value = "Idempotency-Key", required = false) UUID key) {
        return ok(rewards.redeemPremium(mutation(user), key));
    }

    @PostMapping("/api/v1/garden/rewards/vouchers/buy")
    public ResponseEntity<GardenDtos.VoucherReceipt> buyVouchers(@AuthenticationPrincipal UserDetailsImpl user,
                                                                 @RequestHeader(value = "Idempotency-Key", required = false) UUID key,
                                                                 @Valid @RequestBody GardenDtos.VoucherBuyRequest request) {
        return ok(rewards.buyVouchers(mutation(user), key, request));
    }

    @PostMapping("/api/v1/garden/frames/{slug}/buy")
    public ResponseEntity<GardenDtos.FrameReceipt> buyFrame(@AuthenticationPrincipal UserDetailsImpl user,
                                                            @RequestHeader(value = "Idempotency-Key", required = false) UUID key,
                                                            @PathVariable String slug) {
        if (slug == null || !slug.matches("^[a-z0-9_]{1,64}$")) throw new GardenException(404, "FRAME_NOT_FOUND");
        return ok(rewards.buyFrame(mutation(user), key, slug));
    }

    // ------------------------------------------------------------------ the player's cosmetic orders

    @GetMapping("/api/v1/garden/cosmetics/orders")
    public ResponseEntity<GardenDtos.CosmeticOrdersView> orders(@AuthenticationPrincipal UserDetailsImpl user) {
        return ok(checkout.orders(owner(user)));
    }

    /** Polled by the payment sheet: the order as the server sees it (the countdown on screen decides nothing). */
    @GetMapping("/api/v1/garden/cosmetics/orders/{orderId}")
    public ResponseEntity<GardenDtos.CosmeticCheckoutView> order(@AuthenticationPrincipal UserDetailsImpl user, @PathVariable long orderId) {
        return ok(checkout.order(owner(user), orderId));
    }

    @PostMapping("/api/v1/garden/cosmetics/orders/{orderId}/cancel")
    public ResponseEntity<GardenDtos.CosmeticCheckoutView> cancel(@AuthenticationPrincipal UserDetailsImpl user,
                                                                  @RequestHeader(value = "Idempotency-Key", required = false) UUID key,
                                                                  @PathVariable long orderId) {
        return ok(checkout.cancel(mutation(user), key, orderId));
    }

    @PostMapping("/api/v1/garden/cosmetics/orders/{orderId}/refund")
    public ResponseEntity<GardenDtos.CosmeticCheckoutView> requestRefund(@AuthenticationPrincipal UserDetailsImpl user,
                                                                         @RequestHeader(value = "Idempotency-Key", required = false) UUID key,
                                                                         @PathVariable long orderId,
                                                                         @Valid @RequestBody GardenDtos.CosmeticRefundRequest request) {
        return ok(checkout.requestRefund(mutation(user), key, orderId, request.reason()));
    }

    // ------------------------------------------------------------------ the administrator's queue

    @GetMapping("/api/v1/admin/garden/commerce")
    @PreAuthorize("hasRole('ADMIN')")
    public ResponseEntity<GardenDtos.AdminCommerceQueue> queue(@AuthenticationPrincipal UserDetailsImpl user) {
        return ok(checkout.queue(owner(user)));
    }

    @com.englishcoach.auth.mfa.RequireStepUp
    @PostMapping("/api/v1/admin/garden/commerce/refunds/{refundId}/complete")
    @PreAuthorize("hasRole('ADMIN')")
    public ResponseEntity<GardenDtos.AdminCommerceQueue> completeRefund(@AuthenticationPrincipal UserDetailsImpl user, @PathVariable long refundId,
                                                                        @Valid @RequestBody GardenDtos.AdminRefundDecision decision) {
        return ok(checkout.completeRefund(owner(user), refundId, decision.bankReference(), decision.note()));
    }

    @com.englishcoach.auth.mfa.RequireStepUp
    @PostMapping("/api/v1/admin/garden/commerce/refunds/{refundId}/reject")
    @PreAuthorize("hasRole('ADMIN')")
    public ResponseEntity<GardenDtos.AdminCommerceQueue> rejectRefund(@AuthenticationPrincipal UserDetailsImpl user, @PathVariable long refundId,
                                                                      @Valid @RequestBody GardenDtos.AdminRefundDecision decision) {
        return ok(checkout.rejectRefund(owner(user), refundId, decision.note()));
    }

    @com.englishcoach.auth.mfa.RequireStepUp
    @PostMapping("/api/v1/admin/garden/commerce/orders/{orderId}/refund")
    @PreAuthorize("hasRole('ADMIN')")
    public ResponseEntity<GardenDtos.AdminCommerceQueue> openRefund(@AuthenticationPrincipal UserDetailsImpl user, @PathVariable long orderId,
                                                                    @Valid @RequestBody GardenDtos.AdminRefundOpen request) {
        return ok(checkout.openRefund(owner(user), orderId, request.kind(), request.reason(), request.bankReference()));
    }

    @com.englishcoach.auth.mfa.RequireStepUp
    @PostMapping("/api/v1/admin/garden/commerce/issues/{issueId}/resolve")
    @PreAuthorize("hasRole('ADMIN')")
    public ResponseEntity<GardenDtos.AdminCommerceQueue> resolveIssue(@AuthenticationPrincipal UserDetailsImpl user, @PathVariable long issueId,
                                                                      @Valid @RequestBody GardenDtos.AdminIssueResolution request) {
        return ok(checkout.resolveIssue(owner(user), issueId, request.resolution(), request.bankReference(), request.note()));
    }

    // ------------------------------------------------------------------ helpers

    private long owner(UserDetailsImpl user) {
        if (user == null || user.getId() == null) throw new GardenException(401, "AUTH_REQUIRED");
        return user.getId();
    }

    /** Shared rate-limit store (no second limiter): per user and minute, the garden's own command budget. */
    private long mutation(UserDetailsImpl user) {
        long id = owner(user);
        if (!throttle.countRequest("GARDEN_COMMAND", "user:" + id, 240, 1)) throw new GardenException(429, "RATE_LIMITED");
        return id;
    }

    private <T> ResponseEntity<T> ok(T body) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(body);
    }
}
