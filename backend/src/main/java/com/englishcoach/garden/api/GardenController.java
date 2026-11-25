package com.englishcoach.garden.api;

import com.englishcoach.auth.service.LoginThrottleService;
import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.garden.application.CollectionService;
import com.englishcoach.garden.application.ContributionService;
import com.englishcoach.garden.application.CosmeticCheckoutService;
import com.englishcoach.garden.application.CosmeticService;
import com.englishcoach.garden.application.EstateService;
import com.englishcoach.garden.application.FarmEconomyService;
import com.englishcoach.garden.application.GardenAccessService;
import com.englishcoach.garden.application.GardenStateService;
import com.englishcoach.garden.application.HarvestService;
import com.englishcoach.garden.application.KnowledgeService;
import com.englishcoach.garden.application.MonumentService;
import com.englishcoach.garden.application.PestService;
import com.englishcoach.garden.application.PlantingService;
import com.englishcoach.garden.application.SellService;
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
 * Echo Garden API (Phase 1 farming loop + Phase 2 Knowledge Trees, Memory Forest and Forgotten Pests + Phase 3A market,
 * delivery board and bed expansion + Phase 3B crop skins and milestones; the monument, codex and Echo's hint are part of
 * {@code GET /state} + Phase 3C building upgrades, farmland regions, the compost bin and Echo Rewards; the estate and the
 * contribution record are part of {@code GET /state}). Authenticated by the existing security chain ({@code anyRequest()
 * .authenticated()}); the user id always comes from the principal. Every state-changing POST requires an
 * {@code Idempotency-Key} UUID header. Users without garden access get 404 everywhere except {@code GET /access}.
 */
@RestController
@RequestMapping("/api/v1/garden")
public class GardenController {

    private final GardenAccessService access;
    private final GardenStateService state;
    private final PlantingService planting;
    private final HarvestService harvest;
    private final SellService sell;
    private final KnowledgeService knowledge;
    private final PestService pests;
    private final FarmEconomyService economy;
    private final CollectionService collection;
    private final MonumentService monument;
    private final EstateService estate;
    private final ContributionService contribution;
    private final com.englishcoach.garden.application.FarmingService farming;
    private final CosmeticService cosmetics;
    private final CosmeticCheckoutService checkout;
    private final com.englishcoach.garden.application.GardenAdminQaService adminQa;
    private final LoginThrottleService throttle;

    public GardenController(GardenAccessService access, GardenStateService state, PlantingService planting,
                            HarvestService harvest, SellService sell, KnowledgeService knowledge, PestService pests,
                            FarmEconomyService economy, CollectionService collection, MonumentService monument,
                            EstateService estate, ContributionService contribution,
                            com.englishcoach.garden.application.FarmingService farming, CosmeticService cosmetics,
                            CosmeticCheckoutService checkout,
                            com.englishcoach.garden.application.GardenAdminQaService adminQa, LoginThrottleService throttle) {
        this.adminQa = adminQa;
        this.farming = farming;
        this.cosmetics = cosmetics;
        this.checkout = checkout;
        this.access = access;
        this.state = state;
        this.planting = planting;
        this.harvest = harvest;
        this.sell = sell;
        this.knowledge = knowledge;
        this.pests = pests;
        this.economy = economy;
        this.collection = collection;
        this.monument = monument;
        this.estate = estate;
        this.contribution = contribution;
        this.throttle = throttle;
    }

    @GetMapping("/access")
    public ResponseEntity<GardenDtos.Access> access(@AuthenticationPrincipal UserDetailsImpl user) {
        long id = owner(user);
        // Phase 4: the QA flag is decided here, by the server, and is true for the official administrator only. The role
        // of the principal (read from the database for this request) spares every ordinary player the identity lookup;
        // the identity service is still the authority for an account that carries the role.
        return ok(new GardenDtos.Access(access.allowed(id), adminRole(user) && adminQa.available(id)));
    }

    @GetMapping("/state")
    public ResponseEntity<GardenDtos.State> state(@AuthenticationPrincipal UserDetailsImpl user) {
        GardenDtos.State s = state.state(owner(user));
        // the guide is never offered to an administrator account by itself (Help still opens it)
        return ok(adminRole(user) && s.guide() != null ? s.withGuide(s.guide().withoutInvite()) : s);
    }

    /** The voluntary Echo guide: the caller's own decision or progress (no target, no reward). */
    @PostMapping("/guide")
    public ResponseEntity<GardenDtos.GuideAck> guide(@AuthenticationPrincipal UserDetailsImpl user,
                                                     @RequestHeader(value = "Idempotency-Key", required = false) UUID key,
                                                     @Valid @RequestBody GardenDtos.GuideRequest request) {
        GardenDtos.GuideAck ack = state.guide(mutation(user, "GARDEN_COMMAND", 240), key, request);
        return ok(adminRole(user) ? new GardenDtos.GuideAck(ack.guide().withoutInvite(), ack.onboardingStep()) : ack);
    }

    @PostMapping("/onboarding")
    public ResponseEntity<GardenDtos.Ack> onboarding(@AuthenticationPrincipal UserDetailsImpl user,
                                                     @RequestHeader(value = "Idempotency-Key", required = false) UUID key,
                                                     @Valid @RequestBody GardenDtos.OnboardingRequest request) {
        return ok(state.onboarding(mutation(user, "GARDEN_COMMAND", 240), key, request));
    }

    @PostMapping("/rewards/seen")
    public ResponseEntity<GardenDtos.Ack> rewardsSeen(@AuthenticationPrincipal UserDetailsImpl user,
                                                      @RequestHeader(value = "Idempotency-Key", required = false) UUID key) {
        return ok(state.rewardsSeen(mutation(user, "GARDEN_COMMAND", 240), key));
    }

    @PostMapping("/plots/{plotId}/plant")
    public ResponseEntity<GardenDtos.PlantResult> plant(@AuthenticationPrincipal UserDetailsImpl user,
                                                        @RequestHeader(value = "Idempotency-Key", required = false) UUID key,
                                                        @PathVariable long plotId,
                                                        @Valid @RequestBody GardenDtos.PlantRequest request) {
        return ok(planting.plant(mutation(user, "GARDEN_COMMAND", 240), key, plotId, request));
    }

    @PostMapping("/plantings/{plantingId}/boost")
    public ResponseEntity<GardenDtos.BoostResult> boost(@AuthenticationPrincipal UserDetailsImpl user,
                                                        @RequestHeader(value = "Idempotency-Key", required = false) UUID key,
                                                        @PathVariable long plantingId,
                                                        @Valid @RequestBody GardenDtos.BoostRequest request) {
        return ok(planting.boost(mutation(user, "GARDEN_COMMAND", 240), key, plantingId, request));
    }

    @PostMapping("/harvest/start")
    public ResponseEntity<GardenDtos.HarvestChallenge> harvestStart(@AuthenticationPrincipal UserDetailsImpl user,
                                                                    @RequestHeader(value = "Idempotency-Key", required = false) UUID key,
                                                                    @Valid @RequestBody GardenDtos.HarvestStartRequest request) {
        return ok(harvest.start(mutation(user, "GARDEN_HARVEST_START", 10), key, request));
    }

    @PostMapping("/harvest/complete")
    public ResponseEntity<GardenDtos.HarvestResult> harvestComplete(@AuthenticationPrincipal UserDetailsImpl user,
                                                                    @RequestHeader(value = "Idempotency-Key", required = false) UUID key,
                                                                    @Valid @RequestBody GardenDtos.HarvestCompleteRequest request) {
        return ok(harvest.complete(mutation(user, "GARDEN_COMMAND", 240), key, request));
    }

    @PostMapping("/sell")
    public ResponseEntity<GardenDtos.SellResult> sell(@AuthenticationPrincipal UserDetailsImpl user,
                                                      @RequestHeader(value = "Idempotency-Key", required = false) UUID key,
                                                      @Valid @RequestBody GardenDtos.SellRequest request) {
        return ok(sell.sell(mutation(user, "GARDEN_COMMAND", 240), key, request));
    }

    // ------------------------------------------------------------------ Phase 2

    @GetMapping("/knowledge/candidates")
    public ResponseEntity<GardenDtos.CandidatesView> candidates(@AuthenticationPrincipal UserDetailsImpl user,
                                                                @RequestParam(value = "deckId", required = false) Long deckId,
                                                                @RequestParam(value = "q", required = false) String q) {
        String search = q == null ? null : (q.length() > 40 ? q.substring(0, 40) : q);
        return ok(knowledge.candidates(owner(user), deckId, search));
    }

    @PostMapping("/knowledge/plant")
    public ResponseEntity<GardenDtos.KnowledgeResult> plantTree(@AuthenticationPrincipal UserDetailsImpl user,
                                                                @RequestHeader(value = "Idempotency-Key", required = false) UUID key,
                                                                @Valid @RequestBody GardenDtos.KnowledgePlantRequest request) {
        return ok(knowledge.plant(mutation(user, "GARDEN_COMMAND", 240), key, request));
    }

    @PostMapping("/knowledge/{treeId}/essence")
    public ResponseEntity<GardenDtos.EssenceResult> claimEssence(@AuthenticationPrincipal UserDetailsImpl user,
                                                                 @RequestHeader(value = "Idempotency-Key", required = false) UUID key,
                                                                 @PathVariable long treeId) {
        return ok(knowledge.claimEssence(mutation(user, "GARDEN_COMMAND", 240), key, treeId));
    }

    @PostMapping("/knowledge/{treeId}/release")
    public ResponseEntity<GardenDtos.KnowledgeResult> releaseTree(@AuthenticationPrincipal UserDetailsImpl user,
                                                                  @RequestHeader(value = "Idempotency-Key", required = false) UUID key,
                                                                  @PathVariable long treeId) {
        return ok(knowledge.release(mutation(user, "GARDEN_COMMAND", 240), key, treeId));
    }

    @PostMapping("/knowledge/{treeId}/graduation/start")
    public ResponseEntity<GardenDtos.GraduationChallenge> graduationStart(@AuthenticationPrincipal UserDetailsImpl user,
                                                                          @RequestHeader(value = "Idempotency-Key", required = false) UUID key,
                                                                          @PathVariable long treeId) {
        return ok(knowledge.graduationStart(mutation(user, "GARDEN_HARVEST_START", 10), key, treeId));
    }

    @PostMapping("/knowledge/graduation/complete")
    public ResponseEntity<GardenDtos.GraduationResult> graduationComplete(@AuthenticationPrincipal UserDetailsImpl user,
                                                                          @RequestHeader(value = "Idempotency-Key", required = false) UUID key,
                                                                          @Valid @RequestBody GardenDtos.GraduationCompleteRequest request) {
        return ok(knowledge.graduationComplete(mutation(user, "GARDEN_COMMAND", 240), key, request));
    }

    @GetMapping("/forest")
    public ResponseEntity<GardenDtos.ForestPage> forest(@AuthenticationPrincipal UserDetailsImpl user,
                                                        @RequestParam(value = "before", required = false) Long before) {
        return ok(knowledge.forest(owner(user), before));
    }

    @PostMapping("/pests/{pestId}/spray")
    public ResponseEntity<GardenDtos.SprayResult> spray(@AuthenticationPrincipal UserDetailsImpl user,
                                                        @RequestHeader(value = "Idempotency-Key", required = false) UUID key,
                                                        @PathVariable long pestId) {
        return ok(pests.spray(mutation(user, "GARDEN_COMMAND", 240), key, pestId));
    }

    // ------------------------------------------------------------------ Phase 3A

    /** Phase 3D: apply one farming supply from the storehouse to a growing crop of the caller. */
    @PostMapping("/plantings/{plantingId}/treat")
    public ResponseEntity<GardenDtos.TreatResult> treat(@AuthenticationPrincipal UserDetailsImpl user,
                                                        @RequestHeader(value = "Idempotency-Key", required = false) UUID key,
                                                        @PathVariable long plantingId,
                                                        @Valid @RequestBody GardenDtos.TreatRequest request) {
        return ok(farming.treat(mutation(user, "GARDEN_COMMAND", 240), key, plantingId, request));
    }

    /** Phase 3D: the caller's lifetime farm records (harvests, what left the storehouse, coins by source). */
    @GetMapping("/records")
    public ResponseEntity<GardenDtos.RecordsView> records(@AuthenticationPrincipal UserDetailsImpl user) {
        return ok(farming.records(owner(user)));
    }

    @PostMapping("/market/buy")
    public ResponseEntity<GardenDtos.MarketReceipt> marketBuy(@AuthenticationPrincipal UserDetailsImpl user,
                                                              @RequestHeader(value = "Idempotency-Key", required = false) UUID key,
                                                              @Valid @RequestBody GardenDtos.MarketBuyRequest request) {
        return ok(economy.buy(mutation(user, "GARDEN_COMMAND", 240), key, request));
    }

    @PostMapping("/orders/{orderId}/fill")
    public ResponseEntity<GardenDtos.OrderReceipt> fillOrder(@AuthenticationPrincipal UserDetailsImpl user,
                                                             @RequestHeader(value = "Idempotency-Key", required = false) UUID key,
                                                             @PathVariable long orderId,
                                                             @Valid @RequestBody GardenDtos.OrderFillRequest request) {
        return ok(economy.fill(mutation(user, "GARDEN_COMMAND", 240), key, orderId, request));
    }

    @PostMapping("/plots/expand")
    public ResponseEntity<GardenDtos.ExpansionReceipt> expand(@AuthenticationPrincipal UserDetailsImpl user,
                                                              @RequestHeader(value = "Idempotency-Key", required = false) UUID key,
                                                              @Valid @RequestBody GardenDtos.ExpandRequest request) {
        return ok(economy.expand(mutation(user, "GARDEN_COMMAND", 240), key, request));
    }

    // ------------------------------------------------------------------ Phase 3E: cosmetics

    /** The cosmetic shop: collections, every item with the player's ownership / eligibility, cultivars by collection. */
    @GetMapping("/cosmetics")
    public ResponseEntity<GardenDtos.CosmeticShopView> cosmetics(@AuthenticationPrincipal UserDetailsImpl user) {
        return ok(cosmetics.shop(owner(user)));
    }

    @PostMapping("/cosmetics/buy")
    public ResponseEntity<GardenDtos.CosmeticReceipt> buyCosmetic(@AuthenticationPrincipal UserDetailsImpl user,
                                                                  @RequestHeader(value = "Idempotency-Key", required = false) UUID key,
                                                                  @Valid @RequestBody GardenDtos.CosmeticBuyRequest request) {
        return ok(cosmetics.buy(mutation(user, "GARDEN_COMMAND", 240), key, request));
    }

    @PostMapping("/cosmetics/equip")
    public ResponseEntity<GardenDtos.CosmeticEquipResult> equipCosmetic(@AuthenticationPrincipal UserDetailsImpl user,
                                                                        @RequestHeader(value = "Idempotency-Key", required = false) UUID key,
                                                                        @Valid @RequestBody GardenDtos.CosmeticEquipRequest request) {
        return ok(cosmetics.equip(mutation(user, "GARDEN_COMMAND", 240), key, request));
    }

    @PostMapping("/decor/place")
    public ResponseEntity<GardenDtos.DecorResult> placeDecor(@AuthenticationPrincipal UserDetailsImpl user,
                                                             @RequestHeader(value = "Idempotency-Key", required = false) UUID key,
                                                             @Valid @RequestBody GardenDtos.DecorPlaceRequest request) {
        return ok(cosmetics.place(mutation(user, "GARDEN_COMMAND", 240), key, request));
    }

    @PostMapping("/decor/{id}/move")
    public ResponseEntity<GardenDtos.DecorResult> moveDecor(@AuthenticationPrincipal UserDetailsImpl user,
                                                            @RequestHeader(value = "Idempotency-Key", required = false) UUID key,
                                                            @PathVariable("id") long id,
                                                            @Valid @RequestBody GardenDtos.DecorMoveRequest request) {
        return ok(cosmetics.move(mutation(user, "GARDEN_COMMAND", 240), key, id, request));
    }

    @PostMapping("/decor/{id}/store")
    public ResponseEntity<GardenDtos.DecorResult> storeDecor(@AuthenticationPrincipal UserDetailsImpl user,
                                                             @RequestHeader(value = "Idempotency-Key", required = false) UUID key,
                                                             @PathVariable("id") long id) {
        return ok(cosmetics.store(mutation(user, "GARDEN_COMMAND", 240), key, id));
    }

    /** Direct purchase with real money: answers 409 CHECKOUT_DISABLED unless the owner enabled and wired checkout. */
    @PostMapping("/cosmetics/checkout")
    public ResponseEntity<GardenDtos.CosmeticCheckoutView> checkoutCosmetic(@AuthenticationPrincipal UserDetailsImpl user,
                                                                            @RequestHeader(value = "Idempotency-Key", required = false) UUID key,
                                                                            @Valid @RequestBody GardenDtos.CosmeticCheckoutRequest request) {
        return ok(checkout.start(mutation(user, "GARDEN_COMMAND", 240), key, request));
    }

    // ------------------------------------------------------------------ Phase 3B

    @PostMapping("/skins/acquire")
    public ResponseEntity<GardenDtos.SkinReceipt> acquireSkin(@AuthenticationPrincipal UserDetailsImpl user,
                                                              @RequestHeader(value = "Idempotency-Key", required = false) UUID key,
                                                              @Valid @RequestBody GardenDtos.SkinAcquireRequest request) {
        return ok(collection.acquire(mutation(user, "GARDEN_COMMAND", 240), key, request));
    }

    @PostMapping("/skins/equip")
    public ResponseEntity<GardenDtos.SkinEquipResult> equipSkin(@AuthenticationPrincipal UserDetailsImpl user,
                                                                @RequestHeader(value = "Idempotency-Key", required = false) UUID key,
                                                                @Valid @RequestBody GardenDtos.SkinEquipRequest request) {
        return ok(collection.equip(mutation(user, "GARDEN_COMMAND", 240), key, request));
    }

    @GetMapping("/milestones")
    public ResponseEntity<GardenDtos.MilestonesPage> milestones(@AuthenticationPrincipal UserDetailsImpl user,
                                                                @RequestParam(value = "before", required = false) Long before) {
        return ok(monument.milestones(owner(user), before));
    }

    @PostMapping("/milestones/seen")
    public ResponseEntity<GardenDtos.MilestonesSeen> milestonesSeen(@AuthenticationPrincipal UserDetailsImpl user,
                                                                    @RequestHeader(value = "Idempotency-Key", required = false) UUID key,
                                                                    @Valid @RequestBody GardenDtos.MilestonesSeenRequest request) {
        return ok(monument.seen(mutation(user, "GARDEN_COMMAND", 240), key, request));
    }

    // ------------------------------------------------------------------ Phase 3C

    @PostMapping("/buildings/{code}/upgrade")
    public ResponseEntity<GardenDtos.BuildingReceipt> upgradeBuilding(@AuthenticationPrincipal UserDetailsImpl user,
                                                                      @RequestHeader(value = "Idempotency-Key", required = false) UUID key,
                                                                      @PathVariable String code,
                                                                      @Valid @RequestBody GardenDtos.BuildingUpgradeRequest request) {
        return ok(estate.upgrade(mutation(user, "GARDEN_COMMAND", 240), key, code(code), request));
    }

    @PostMapping("/land/buy")
    public ResponseEntity<GardenDtos.LandReceipt> buyLand(@AuthenticationPrincipal UserDetailsImpl user,
                                                          @RequestHeader(value = "Idempotency-Key", required = false) UUID key,
                                                          @Valid @RequestBody GardenDtos.LandBuyRequest request) {
        return ok(estate.buyLand(mutation(user, "GARDEN_COMMAND", 240), key, request));
    }

    @PostMapping("/warehouse/compost")
    public ResponseEntity<GardenDtos.CompostReceipt> compost(@AuthenticationPrincipal UserDetailsImpl user,
                                                             @RequestHeader(value = "Idempotency-Key", required = false) UUID key,
                                                             @Valid @RequestBody GardenDtos.CompostRequest request) {
        return ok(estate.compost(mutation(user, "GARDEN_COMMAND", 240), key, request));
    }

    @PostMapping("/rewards/{code}/redeem")
    public ResponseEntity<GardenDtos.RewardReceipt> redeemReward(@AuthenticationPrincipal UserDetailsImpl user,
                                                                 @RequestHeader(value = "Idempotency-Key", required = false) UUID key,
                                                                 @PathVariable String code) {
        return ok(contribution.redeem(mutation(user, "GARDEN_COMMAND", 240), key, code(code)));
    }

    @GetMapping("/contribution/history")
    public ResponseEntity<GardenDtos.ContributionPage> contributionHistory(@AuthenticationPrincipal UserDetailsImpl user,
                                                                           @RequestParam(value = "before", required = false) Long before) {
        return ok(contribution.history(owner(user), before));
    }

    /** A catalogue code from the path: upper-case letters, digits and underscores only (anything else is unknown). */
    private static String code(String raw) {
        if (raw == null || !raw.matches("^[A-Z0-9_]{1,40}$")) throw new GardenException(404, "GARDEN_NOT_FOUND");
        return raw;
    }

    private static boolean adminRole(UserDetailsImpl user) {
        return user != null && user.getAuthorities().stream().anyMatch(a -> "ROLE_ADMIN".equals(a.getAuthority()));
    }

    private long owner(UserDetailsImpl user) {
        if (user == null || user.getId() == null) throw new GardenException(401, "AUTH_REQUIRED");
        return user.getId();
    }

    /** Shared rate-limit store (no second limiter): per user and minute. */
    private long mutation(UserDetailsImpl user, String kind, int perMinute) {
        long id = owner(user);
        if (!throttle.countRequest(kind, "user:" + id, perMinute, 1)) throw new GardenException(429, "RATE_LIMITED");
        return id;
    }

    private <T> ResponseEntity<T> ok(T body) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(body);
    }
}
