package com.englishcoach.garden.api;

import jakarta.validation.Valid;
import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Echo Garden REST contract ({@code /api/v1/garden}). Mirrored by {@code frontend/src/types/garden.ts}. Responses only
 * carry server facts; recall answers are revealed only after a challenge is completed.
 */
public final class GardenDtos {

    private GardenDtos() {}

    // ------------------------------------------------------------------ requests

    public record OnboardingRequest(@Min(0) @Max(8) int step) {}

    /**
     * The voluntary Echo guide: what the player decided or how far the starter guide came. {@code version} is the guide
     * this client knows (only 1 exists); {@code step} matters for PROGRESS only.
     */
    public record GuideRequest(@Min(1) @Max(1) int version,
                               @NotBlank @Pattern(regexp = "^(SHOWN|DECLINE|START|PROGRESS|EXIT|COMPLETE|SETTLE)$") String action,
                               @Min(0) @Max(7) int step) {}

    public record PlantRequest(@NotBlank @Size(max = 40) @Pattern(regexp = "^[A-Z_]+$") String cropCode) {}

    public record BoostRequest(@NotBlank @Size(max = 40) @Pattern(regexp = "^[A-Z_]+$") String itemCode) {}

    public record HarvestStartRequest(@NotEmpty @Size(max = 12) List<@NotNull Long> plantingIds) {}

    public record HarvestCompleteRequest(@NotNull UUID challengeId, @Size(max = 10) List<Integer> answers, boolean skip) {}

    public record SellLine(@NotBlank @Size(max = 40) String cropCode, @NotBlank @Size(max = 10) String tier,
                           @Min(1) @Max(9999) int qty) {}

    public record SellRequest(@NotEmpty @Size(max = 40) List<@Valid SellLine> lines) {}

    /** Phase 2: plant a Knowledge Tree in sacred spot {@code slot} with exactly five of the player's own cards. */
    public record KnowledgePlantRequest(@Min(1) @Max(3) int slot, @NotNull @Size(min = 1, max = 10) List<@NotNull Long> flashcardIds) {}

    public record GraduationCompleteRequest(@NotNull UUID challengeId, @Size(max = 10) List<Integer> answers) {}

    /** Phase 3A: buy {@code units} purchase units of one of today's market offers ({@code ITEM:…} or {@code PACK:…}). */
    public record MarketBuyRequest(@NotBlank @Size(max = 48) @Pattern(regexp = "^(ITEM|PACK):[A-Z_]+$") String offerCode,
                                   @Min(1) @Max(99) int units) {}

    /** A delivered or composted line: exactly which produce (crop + quality tier) and how many. */
    public record SupplyLine(@NotBlank @Size(max = 40) @Pattern(regexp = "^[A-Z_]+$") String cropCode,
                             @NotBlank @Size(max = 10) @Pattern(regexp = "^[A-Z]+$") String tier, @Min(1) @Max(999) int qty) {}

    public record OrderFillRequest(@NotNull @Size(min = 1, max = 12) List<@Valid @NotNull SupplyLine> lines) {}

    public record ExpandRequest(@Min(1) @Max(99) int slot, @NotNull @Size(max = 12) List<@Valid @NotNull SupplyLine> compost) {}

    /** Phase 3B: collect an earned skin or buy a coin skin (the catalogue decides which; the client only names it). */
    public record SkinAcquireRequest(@NotBlank @Size(max = 40) @Pattern(regexp = "^[A-Z_]+$") String skinCode) {}

    /** The skin future plantings of {@code cropCode} take; {@code skinCode} null = the base crop. */
    public record SkinEquipRequest(@NotBlank @Size(max = 40) @Pattern(regexp = "^[A-Z_]+$") String cropCode,
                                   @Size(max = 40) @Pattern(regexp = "^[A-Z_]+$") String skinCode) {}

    /** Phase 3E: buy (coin item) or claim (earned item) one unit of a cosmetic; the catalogue decides which. */
    public record CosmeticBuyRequest(@NotBlank @Size(max = 40) @Pattern(regexp = "^[A-Z_]+$") String code) {}

    /** Phase 3E: the appearance a slot shows; {@code code} null = the island's own look. */
    public record CosmeticEquipRequest(@NotBlank @Pattern(regexp = "^(HOUSE|TREE|SHRUB|FLOWER|MONUMENT|FENCE|PATH|BED)$") String slot,
                                       @Size(max = 40) @Pattern(regexp = "^[A-Z_]+$") String code) {}

    /** Phase 3E: stand a stored decoration at a point of a decoration region (grid cells on the placement grid). */
    public record DecorPlaceRequest(@NotBlank @Size(max = 40) @Pattern(regexp = "^[A-Z_]+$") String code,
                                    @NotNull @DecimalMin("0") @DecimalMax("30") Double gx,
                                    @NotNull @DecimalMin("0") @DecimalMax("30") Double gy) {}

    public record DecorMoveRequest(@NotNull @DecimalMin("0") @DecimalMax("30") Double gx,
                                   @NotNull @DecimalMin("0") @DecimalMax("30") Double gy) {}

    /** Phase 3E: start a direct purchase of one cosmetic (closed unless the owner enables checkout). */
    public record CosmeticCheckoutRequest(@NotBlank @Size(max = 40) @Pattern(regexp = "^[A-Z_]+$") String code,
                                          @Pattern(regexp = "^(COSMETIC|SKIN)$") String kind) {
        public CosmeticCheckoutRequest(String code) {
            this(code, "COSMETIC");
        }

        /** COSMETIC unless the client names a crop cultivar. */
        public String itemKind() {
            return kind == null ? "COSMETIC" : kind;
        }
    }

    /** Phase 3F: the buyer asks for a refund of a paid, unused cosmetic. */
    public record CosmeticRefundRequest(@NotBlank @Size(min = 5, max = 500) String reason) {}

    /** Phase 3F: Echo Coins for an AI voucher pack ({@code ONE} or {@code FIVE}). */
    public record VoucherBuyRequest(@NotBlank @Pattern(regexp = "^[A-Z]{1,12}$") String pack) {}

    /** Phase 3F (administrator): complete a refund after the bank transfer was sent back by hand. */
    public record AdminRefundDecision(@Size(max = 128) String bankReference, @Size(max = 500) String note) {}

    /** Phase 3F (administrator): open and complete a refund of a paid order for a reason other than the buyer's request. */
    public record AdminRefundOpen(@NotBlank @Pattern(regexp = "^(DELIVERY_FAILURE|DUPLICATE_CHARGE|UNAUTHORIZED|DEFECT|CHARGEBACK)$") String kind,
                                  @NotBlank @Size(min = 5, max = 500) String reason,
                                  @NotBlank @Size(max = 128) String bankReference) {}

    /** Phase 3F (administrator): close a reconciliation issue — deliver a verified late payment, or record the manual refund. */
    public record AdminIssueResolution(@NotBlank @Pattern(regexp = "^(DELIVERED|REFUNDED_MANUALLY)$") String resolution,
                                       @Size(max = 128) String bankReference, @Size(max = 500) String note) {}

    public record MilestonesSeenRequest(@NotNull @Size(min = 1, max = 50) List<@NotNull Long> ids) {}

    /** Phase 3C: raise a building to {@code level} (must be its next level) with exactly the produce it asks for. */
    public record BuildingUpgradeRequest(@Min(1) @Max(9) int level, @NotNull @Size(max = 12) List<@Valid @NotNull SupplyLine> materials) {}

    /** Phase 3C: open the bed {@code slot} of a farmland region with exactly the produce it asks for. */
    public record LandBuyRequest(@Min(1) @Max(99) int slot, @NotNull @Size(max = 12) List<@Valid @NotNull SupplyLine> materials) {}

    /** Phase 3D: apply one farming supply from the storehouse to a growing crop. */
    public record TreatRequest(@NotBlank @Size(max = 40) @Pattern(regexp = "^[A-Z_]+$") String itemCode) {}

    /** Phase 3C: turn surplus produce into one fertilizer at the storehouse ({@code recipe} STANDARD or PREMIUM). */
    public record CompostRequest(@NotBlank @Pattern(regexp = "^(STANDARD|PREMIUM)$") String recipe,
                                 @NotNull @Size(min = 1, max = 16) List<@Valid @NotNull SupplyLine> lines) {}

    // ------------------------------------------------------------------ state

    /** {@code adminQa} (Phase 4): true only for the official administrator — the QA commands answer this account. */
    public record Access(boolean enabled, boolean adminQa) {}

    public record UnlockView(int level, String cropCode, String nameVi) {}

    public record ProfileView(int level, long xpIntoLevel, long xpToNext, long totalXp, long coins, UnlockView nextUnlock,
                              int essence) {}

    public record GoalView(boolean done, double effectiveUnits, double targetUnits, int reviews, int dueMinReviews,
                           Instant doneAt, double mixUnits, int mixSkills, int skillsToday) {}

    public record TodayView(LocalDate dayKey, GoalView goal, boolean blessing, double blessingMultiplier) {}

    /** A weather window: SUNNY, RAIN (snow in the winter theme, same rule) or RAINBOW. */
    public record WeatherView(String kind, Instant startsAt, Instant endsAt, String theme, double growthFactor) {}

    /**
     * Season = theme week (global, server time). {@code forecast}: the current window first, then the revealed ones (a
     * coming rainbow is never revealed).
     */
    public record WorldView(String theme, Instant themeEndsAt, String nextTheme, WeatherView weather,
                            List<WeatherView> forecast, double rainbowMutation) {}

    /**
     * {@code skinCode} / {@code skinArt}: the cosmetic skin this planting was planted with (null = the base crop).
     * {@code pestStage} (Phase 3C): the damage stage of the Forgotten Pest on this crop — 1 warning, 2 leaf damage,
     * 3 wilting, 0 resolved by a review; null = no pest.
     */
    public record PlantingView(long id, String cropCode, String nameVi, Instant plantedAt, int stage, double progress,
                               boolean ready, Instant readyAt, double requiredSeconds, double remainingSeconds,
                               double speed, int waterCount, int waterLimit, String fertilizer, double boostFraction,
                               double maxBoost, String seasonFit, boolean tutorial, Instant freshUntil, Long pestId,
                               String skinCode, String skinArt, Integer pestStage, SoilView soil,
                               List<ProtectionView> protections) {}

    public record PlotView(long id, int slot, int gridX, int gridY, boolean unlocked, PlantingView planting) {}

    public record SeedView(String cropCode, int qty) {}

    public record ProduceView(String cropCode, String tier, int qty, long unitPrice) {}

    /**
     * Phase 3H: harvest portions that do not make a whole unit ({@code unitPortions} portions = one unit). {@code value}:
     * what selling all {@code portions} pays now — the proportional share of the unit price, rounded down.
     */
    public record ShareStockView(String cropCode, String nameVi, String tier, int portions, int unitPortions, long unitPrice,
                                 long value) {}

    public record InventoryView(int water, int fertilizer, int fertilizerPremium, List<SeedView> seeds,
                                List<ProduceView> produce, List<ShareStockView> shares) {}

    /** {@code seedEssence}: essence also paid when an Epic seed is bought; Legendary seeds come only from graduation. */
    public record CropView(String code, String nameVi, String rarity, int baseSeconds, long seedPrice, int sellPrice,
                           String season, int unlockLevel, int harvestXp, boolean unlocked, boolean purchasable,
                           String seasonFitNow, long growSecondsNow, boolean qa, int seedEssence, double thirst,
                           int harvestBonus) {}

    public record BoostView(String code, String nameVi, String group, double fraction, int perPlanting) {}

    public record TierView(String code, int minScore, double sellMultiplier) {}

    public record RewardsView(boolean unseen, int reviews, long water, long xp, long fertilizer, int lessons) {}

    /** {@code stageThresholds}: progress fractions where visual stages 2 and 3 begin (client-side projection only). */
    public record State(Instant serverNow, ProfileView profile, TodayView today, WorldView world, List<PlotView> plots,
                        InventoryView inventory, List<CropView> crops, List<BoostView> boosts, List<TierView> tiers,
                        RewardsView rewards, int onboardingStep, List<Double> stageThresholds, KnowledgeView knowledge,
                        List<PestView> pests, LearningView learning, EconomyView economy, LivingView living,
                        EstateView estate, FarmingView farming, CosmeticStateView cosmetics, SocialBadgeView social,
                        AnimalsView animals, GuideView guide) {

        public State withLiving(LivingView l) {
            return new State(serverNow, profile, today, world, plots, inventory, crops, boosts, tiers, rewards, onboardingStep,
                    stageThresholds, knowledge, pests, learning, economy, l, estate, farming, cosmetics, social, animals, guide);
        }

        public State withEstate(EstateView x) {
            return new State(serverNow, profile, today, world, plots, inventory, crops, boosts, tiers, rewards, onboardingStep,
                    stageThresholds, knowledge, pests, learning, economy, living, x, farming, cosmetics, social, animals, guide);
        }

        public State withFarming(FarmingView f) {
            return new State(serverNow, profile, today, world, plots, inventory, crops, boosts, tiers, rewards, onboardingStep,
                    stageThresholds, knowledge, pests, learning, economy, living, estate, f, cosmetics, social, animals, guide);
        }

        public State withCosmetics(CosmeticStateView c) {
            return new State(serverNow, profile, today, world, plots, inventory, crops, boosts, tiers, rewards, onboardingStep,
                    stageThresholds, knowledge, pests, learning, economy, living, estate, farming, c, social, animals, guide);
        }

        public State withSocial(SocialBadgeView s) {
            return new State(serverNow, profile, today, world, plots, inventory, crops, boosts, tiers, rewards, onboardingStep,
                    stageThresholds, knowledge, pests, learning, economy, living, estate, farming, cosmetics, s, animals, guide);
        }

        public State withAnimals(AnimalsView a) {
            return new State(serverNow, profile, today, world, plots, inventory, crops, boosts, tiers, rewards, onboardingStep,
                    stageThresholds, knowledge, pests, learning, economy, living, estate, farming, cosmetics, social, a, guide);
        }

        public State withGuide(GuideView g) {
            return new State(serverNow, profile, today, world, plots, inventory, crops, boosts, tiers, rewards, onboardingStep,
                    stageThresholds, knowledge, pests, learning, economy, living, estate, farming, cosmetics, social, animals, g);
        }
    }

    /**
     * The voluntary guide of this garden: {@code status} null = never asked, else INVITED / DECLINED / STARTED / EXITED /
     * COMPLETED; {@code step} = starter milestones finished (0-7); {@code invite} = the server says this is a genuinely
     * new garden that may be offered the guide once (never true again after any answer, and never for the administrator).
     */
    public record GuideView(String status, int step, int version, boolean invite) {

        public GuideView withoutInvite() {
            return invite ? new GuideView(status, step, version, false) : this;
        }
    }

    public record GuideAck(GuideView guide, int onboardingStep) {}

    // ------------------------------------------------------------------ Phase 3G: social islands

    // ------------------------------------------------------------------ Phase 3H: livestock and guardian pets

    public record AnimalBuyRequest(@NotBlank @Pattern(regexp = "^[A-Z_]{1,16}$") String species) {}

    /** Mill produce of one crop and quality into animal feed (the server decides how much feed a unit gives). */
    public record FeedMillRequest(@NotBlank @Size(max = 40) @Pattern(regexp = "^[A-Z_]+$") String cropCode,
                                  @NotBlank @Size(max = 10) @Pattern(regexp = "^[A-Z_]+$") String tier,
                                  @Min(1) @Max(999) int qty) {}

    public record ProductSellRequest(@NotBlank @Pattern(regexp = "^[A-Z_]{1,24}$") String code, @Min(1) @Max(9999) int qty) {}

    public record ManureCompostRequest(@Min(1) @Max(9) int batches) {}

    /** Sell harvest portions (fragments of a unit) at their proportional value. */
    public record ShareSellLine(@NotBlank @Size(max = 40) @Pattern(regexp = "^[A-Z_]+$") String cropCode,
                                @NotBlank @Size(max = 10) @Pattern(regexp = "^[A-Z_]+$") String tier,
                                @Min(1) @Max(9999) int portions) {}

    public record ShareSellRequest(@NotEmpty @Size(max = 40) List<@Valid ShareSellLine> lines) {}

    /**
     * One animal as its owner sees it. {@code stage}: BABY / YOUNG / ADULT; {@code growth}: 0–1 toward adulthood;
     * {@code cared}: it has food and water now (a guardian: food); {@code ready}: products waiting to be collected (at
     * most {@code storeCap}); {@code nextProductAt} / {@code adultAt}: under the care it has now, null when care ends first.
     */
    public record AnimalView(long id, String species, String nameVi, String stage, int place, double growth, Instant adultAt,
                             boolean cared, Instant fedUntil, boolean canFeed, int ready, int storeCap, Instant nextProductAt) {}

    /**
     * An animal house. Not {@code built}: {@code minLevel} / {@code coins} to build it. Built: the trough
     * ({@code wateredUntil}, {@code canRefill}), its animals, {@code feedNeeded} = feed units one feeding of every animal
     * that can eat now costs, {@code ready} = products waiting in the house.
     */
    public record AnimalHouseView(String code, String nameVi, String species, String animalNameVi, String babyNameVi, boolean built,
                                  int minLevel, long coins, boolean levelOk, boolean coinsOk, int capacity, long animalCoins,
                                  boolean animalCoinsOk, Instant wateredUntil, boolean watered, boolean canRefill, int feedNeeded,
                                  int rationFeed, int rationHours, int growHours, String product, String productNameVi,
                                  int productHours, int ready, List<AnimalView> animals) {}

    /**
     * A guardian pet. {@code status}: LOCKED (level), AVAILABLE (can be adopted), HUNGRY (owned, off duty), ON_DUTY,
     * and for the dog READY (will turn the next visitor away), GUARDING (the island is guarded until {@code until}) or
     * COOLDOWN (ready again at {@code until}).
     */
    public record GuardianView(String species, String nameVi, boolean owned, int minLevel, long coins, boolean levelOk,
                               boolean coinsOk, String status, Instant fedUntil, boolean canFeed, int rationFeed, int rationHours,
                               Instant until, int cooldownHours, int shieldHours, int graceMinutes, int pestCapReduction) {}

    public record ProductStockView(String code, String nameVi, int qty, long unitPrice) {}

    /** Produce the owner holds that can be milled into feed ({@code feedPerUnit} feed for one unit of any quality). */
    public record MillOptionView(String cropCode, String nameVi, String tier, int held, int feedPerUnit) {}

    public record ManureCompostView(String product, int manure, String gives, int dailyCap, int usedToday, int held) {}

    /**
     * The animals part of the owner's {@code GET /state} (null on a garden without animals rules). {@code feed} /
     * {@code water}: stock of the feed and trough-water items; {@code learnedToday}: a ration given now lasts
     * {@code learningBonusPercent} % longer.
     */
    public record AnimalsView(List<AnimalHouseView> houses, List<GuardianView> guardians, int feed, int water, String waterItem,
                              int waterHours, int feedMaxHours, boolean learnedToday, int learningBonusPercent,
                              List<ProductStockView> products, List<MillOptionView> mill, ManureCompostView compost,
                              int livestock, int livestockCapacity) {}

    /** {@code gained}: item code → units this command added (feed, products, fertilizer). */
    public record AnimalReceipt(String action, long coinsDelta, long coins, Map<String, Integer> gained, AnimalsView animals) {}

    public record ShareSellResult(long coinsGained, long coins, boolean blessing, List<SellLineResult> lines) {}

    /** An animal of a visited island: what stands there, never its food, products or timers. */
    public record IslandAnimalView(String species, String kind, String stage, Integer place, boolean woolly) {}

    public record IslandAnimalsView(List<String> houses, List<IslandAnimalView> animals) {}

    public record SocialVisibilityRequest(@NotBlank @Pattern(regexp = "^(PUBLIC|PRIVATE)$") String visibility) {}

    /** Take a little from one ripe crop of the visited island (the server decides whether and how much). */
    public record SocialTakeRequest(@NotNull @Min(1) Long plantingId) {}

    public record SocialReactRequest(@NotBlank @Pattern(regexp = "^[A-Z_]{1,24}$") String code) {}

    /**
     * The social part of the owner's own {@code GET /state} (null on a garden without the social islands):
     * {@code unread}: takes from this island and reactions left on it since the activity record was last opened;
     * {@code taken}: planting id → portions a visitor took from a crop that is still on its bed ({@code unitPortions}
     * portions make one produce unit).
     */
    public record SocialBadgeView(String visibility, int unread, Map<Long, Integer> taken, int unitPortions,
                                  boolean visibilityChosen) {}

    /**
     * An island as others see it: the owner's public name and handle (never an account id, an e-mail or a login) and
     * stored progression facts. {@code visitedAt}: when the READER last visited it (null = never).
     */
    public record IslandCardView(String handle, String name, int level, int beds, int monumentEra, int forestTrees,
                                 Instant visitedAt) {}

    /** {@code nextCursor}: opaque, null on the last page; a search is one bounded page ({@code search} true). */
    public record DiscoverPage(List<IslandCardView> islands, String nextCursor, boolean search) {}

    /** The numbers the "take a little" explanation is worded from. */
    public record SocialRulesView(int unitPortions, int fractionBp, int windowHours, int thiefCap, int pairCap, int victimCap,
                                  int shieldHours, int introHours, int reopenHours, int ripeGraceMinutes) {}

    /**
     * Whether the reader may take from other islands now. {@code reason} null when {@code canTake}; otherwise
     * THIEF_PRIVATE / THIEF_NEW / THIEF_REOPENED / THIEF_LIMIT with {@code availableAt} when it ends by itself.
     */
    public record StandingView(boolean canTake, String reason, Instant availableAt, int takesUsed, int takesLeft) {}

    /**
     * Whether an island is protected as a whole. {@code reason}: PRIVATE (closed by its owner), ISLAND_NEW,
     * ISLAND_SHIELD or VICTIM_LIMIT; {@code until}: when the protection ends by itself (null for PRIVATE).
     */
    public record IslandProtectionView(boolean active, String reason, Instant until) {}

    /** Harvest portions of one crop and quality that do not make a whole produce unit yet. */
    public record ShareView(String cropCode, String nameVi, String tier, int portions, int unitPortions) {}

    public record SocialMeView(String handle, String name, String visibility, Instant visibilityChangedAt, StandingView standing,
                               IslandProtectionView protection, List<ShareView> shares, int unread, SocialRulesView rules,
                               List<String> reactions) {}

    /**
     * What the reader may do with one crop of the visited island. {@code reason} null when {@code eligible}; otherwise
     * the first rule in the way (the reader's standing, the island's protection, then the crop: CROP_EXCLUDED,
     * NOT_READY, CROP_FRESH, CROP_TAKEN, NOT_ENOUGH_YIELD). {@code portions}: what a take would carry now.
     */
    public record TakeView(long plantingId, int slot, boolean eligible, String reason, int portions, Instant availableAt) {}

    /** {@code ornaments}: ornament tier of every skill family (lower-case key) and {@code memory}. */
    public record IslandMonumentView(int era, Map<String, Integer> ornaments) {}

    public record IslandTreeView(long id, int slot, String species, int stage) {}

    public record IslandForestTreeView(long id, String species) {}

    /**
     * A read-only picture of another player's island for the existing scene: beds and crops as they stand now, building
     * levels, what the island wears, the monument, the grove and the forest. No balance, inventory, order, learning
     * record, word or pest of the owner is part of it. {@code takes}: one entry per planted bed.
     */
    public record IslandView(Instant serverNow, IslandCardView owner, List<PlotView> plots, List<Double> stageThresholds,
                             Map<String, Integer> buildings, CosmeticStateView cosmetics, IslandMonumentView monument,
                             List<IslandTreeView> grove, List<IslandForestTreeView> forest, List<TakeView> takes,
                             StandingView standing, IslandProtectionView protection, int unitPortions, String myReaction,
                             Instant reactionAvailableAt, IslandAnimalsView animals) {}

    /**
     * A recorded take. {@code portions} of {@code unitPortions} went to the taker as fragments of quality {@code tier};
     * {@code sharesNow}: the taker's fragments of this crop afterwards; {@code unitsMerged}: whole units they completed.
     */
    public record TakeReceipt(long takeId, String handle, String ownerName, long plantingId, String cropCode, String nameVi,
                              int portions, int unitPortions, String tier, int sharesNow, int unitsMerged, StandingView standing,
                              IslandProtectionView protection, boolean guarded) {}

    public record ReactionReceipt(String code, Instant at, Instant nextAt) {}

    /** {@code kind}: TAKEN_FROM_ME (someone took from the reader's island) or I_TOOK. {@code otherHandle} null = closed island. */
    public record ActivityEntryView(long id, String kind, String otherName, String otherHandle, String cropCode, String nameVi,
                                    int portions, int unitPortions, Instant at, boolean unread) {}

    public record ReactionEntryView(String visitorName, String visitorHandle, String code, Instant at, boolean unread) {}

    public record ActivityPage(List<ActivityEntryView> entries, Long nextBefore, List<ReactionEntryView> reactions, int unread,
                               Instant seenAt) {}

    public record SocialAck(boolean ok, int unread) {}

    // ------------------------------------------------------------------ Phase 3E: cosmetics

    /** A decoration standing on the island ({@code footprint}: radius in tiles it keeps free). */
    public record DecorView(long id, String code, String artKey, String region, double gx, double gy, double footprint) {}

    public record DecorRegionView(String code, String nameVi, double x0, double y0, double x1, double y1) {}

    /**
     * What the island wears (part of {@code GET /state}; null on a garden without the cosmetic catalogue).
     * {@code equipped}: slot → art key of the equipped appearance (a slot without an entry shows the island's own look);
     * {@code equippedCodes}: slot → item code; {@code decor}: the decorations that stand; {@code regions}: where one may stand.
     */
    public record CosmeticStateView(Map<String, String> equipped, Map<String, String> equippedCodes, List<DecorView> decor,
                                    List<DecorRegionView> regions, int maxPlaced, double snap) {}

    /**
     * One shop entry. {@code status}: OWNED (every unit held) / AVAILABLE (may be bought or claimed now) / LOCKED;
     * {@code progress} / {@code requirement}: the earned path ({@code unlockKind} LEARNING / HARVESTS / GRADUATIONS);
     * {@code owned} / {@code maxOwned} / {@code placed}: units held, allowed and standing (decorations).
     */
    public record CosmeticItemView(String code, String category, String family, String collection, String nameVi,
                                   String descriptionVi, String artKey, String unlockKind, long coinPrice, int requirement,
                                   int progress, boolean requirementOk, boolean coinsOk, int maxOwned, int owned, int placed,
                                   boolean equipped, String status, double footprint, Long priceVnd, Long pendingOrderId) {}

    /** A crop cultivar of a collection (its codex page keeps the full requirements; the shop links there). */
    public record CosmeticSkinView(String code, String cropCode, String cropNameVi, String collection, String nameVi,
                                   String descriptionVi, String artKey, String unlockKind, long coinPrice, int masteryTier,
                                   int learningDays, boolean masteryOk, boolean learningOk, boolean coinsOk, String status,
                                   boolean equipped, Long priceVnd, Long pendingOrderId) {}

    public record CosmeticCollectionView(String code, String nameVi, String descriptionVi, int items, int owned) {}

    /** {@code checkoutEnabled}: direct purchase with real money is open (false unless the owner enables it). */
    public record CosmeticShopView(long coins, List<CosmeticCollectionView> collections, List<CosmeticItemView> items,
                                   List<CosmeticSkinView> skins, CosmeticStateView state, int itemsOwned, int itemsTotal,
                                   boolean checkoutEnabled) {}

    public record CosmeticReceipt(String code, int quantity, String source, long coinsPaid, long coins, CosmeticShopView shop) {}

    public record CosmeticEquipResult(String slot, String code, CosmeticStateView state) {}

    /** {@code decor} null = the decoration went back into storage. */
    public record DecorResult(DecorView decor, CosmeticStateView state) {}

    /**
     * A cosmetic order paid by bank transfer through the existing SePay path — everything the payment sheet shows.
     * {@code status}: PENDING (waiting for the transfer) / FULFILLED (verified payment, item delivered) / EXPIRED /
     * CANCELLED / REFUNDED. {@code transferCode} is the transfer content; bank details and the QR come from the payment
     * module's configuration (never from the client). {@code review}: a verified transfer arrived but could not be
     * delivered automatically (its kind) and waits for the administrator. {@code refundStatus}: REQUESTED / COMPLETED /
     * REJECTED or null; {@code refundable}: the buyer may ask now (paid within the policy window and never used).
     */
    public record CosmeticCheckoutView(long orderId, String kind, String code, String productName, long amountVnd, String currency,
                                       String status, String transferCode, String bankCode, String accountNumber, String accountName,
                                       String qrImageUrl, Instant createdAt, Instant expiresAt, Instant paidAt, String review,
                                       String refundStatus, boolean refundable, Instant refundDeadline) {}

    public record CosmeticOrdersView(boolean checkoutEnabled, List<CosmeticCheckoutView> orders) {}

    // ------------------------------------------------------------------ Phase 3F: Premium reward, AI vouchers, profile frames

    /**
     * The Premium 7-day reward as this player stands. {@code status}: AVAILABLE, or the first thing in the way —
     * CLOSED (not offered / no budget configured), BUDGET_EXHAUSTED, PREMIUM_ACTIVE, COOLDOWN, WINDOW_LIMIT,
     * LEARNING_DAYS, INSUFFICIENT_FUNDS. Every number is a server fact.
     */
    public record PremiumRewardView(boolean open, String status, long coinsCost, int hours, int learningDays, int learningDaysNeeded,
                                    int learningWindowDays, int redeemedInWindow, int maxPerWindow, int windowDays, int cooldownDays,
                                    Instant activeUntil, Instant nextEligibleAt, List<PremiumRewardEntry> history) {}

    public record PremiumRewardEntry(long id, long coinsSpent, Instant startsAt, Instant expiresAt) {}

    public record PremiumRewardReceipt(long rewardId, long coinsPaid, long coins, Instant startsAt, Instant expiresAt, EchoRewardsView rewards) {}

    public record VoucherPackView(String code, int credits, long coins, boolean coinsOk, boolean withinCap) {}

    public record VoucherGrantView(int credits, int remaining, Instant issuedAt, Instant expiresAt) {}

    public record VoucherUseView(String featureKey, String status, Instant at) {}

    /** {@code open}: vouchers can be bought now; the wallet itself is always shown. */
    public record VoucherShopView(boolean open, String status, int balance, Instant nextExpiry, int boughtInWindow, int capCredits,
                                  int capWindowDays, int validDays, List<VoucherPackView> packs, List<VoucherGrantView> grants,
                                  List<VoucherUseView> recent, List<String> eligibleFeatures) {}

    public record VoucherReceipt(String pack, int credits, long coinsPaid, long coins, EchoRewardsView rewards) {}

    public record FrameRequirementView(String metric, long target, long progress, boolean ok) {}

    /**
     * One Echo Garden profile frame. {@code unlockKind}: COIN (bought once for {@code coinPrice}) or EARNED (unlocked by
     * the frame module from the stored facts in {@code requirements}; never sold). {@code status}: OWNED / AVAILABLE
     * (can be bought, or the requirements are met and the frame can be claimed) / LOCKED.
     */
    public record GardenFrameView(String slug, String name, String tier, String asset, String collection, String collectionName,
                                  String unlockKind, long coinPrice, boolean coinsOk, List<FrameRequirementView> requirements,
                                  String status, boolean owned, boolean equipped) {}

    public record FrameShopView(boolean open, List<GardenFrameView> frames, int owned, int total) {}

    public record FrameReceipt(String slug, long coinsPaid, long coins, EchoRewardsView rewards) {}

    public record EchoRewardsView(long coins, PremiumRewardView premium, VoucherShopView vouchers, FrameShopView frames) {}

    // ------------------------------------------------------------------ Phase 3F: administrator's commerce queue

    public record AdminRefundView(long id, long orderId, long userId, String kind, String status, String reason, long amountVnd,
                                  Instant requestedAt, String itemKind, String itemCode, String orderStatus, String transferCode) {}

    public record AdminIssueView(long id, String kind, long orderId, long userId, String providerTransactionId, long paidAmountVnd,
                                 long orderAmountVnd, String itemKind, String itemCode, String orderStatus, Instant createdAt) {}

    public record AdminCommerceQueue(boolean checkoutEnabled, List<AdminRefundView> refunds, List<AdminIssueView> issues) {}

    // ------------------------------------------------------------------ Phase 3D: soil, supplies, harvest bonus, records

    /** A supply still working on a planting. {@code expiresAt} null = until harvest. */
    public record ProtectionView(String itemCode, String effect, Instant appliedAt, Instant expiresAt) {}

    /**
     * The soil of a growing crop (growth model 2; null for a crop planted under the earlier rules). {@code status} OK /
     * DRY / WET; {@code slowing}: the soil is slowing growth right now; {@code stressShare}: share of the growing time
     * spent thirsty or waterlogged and {@code careFactor} the factor it gives the harvest care points;
     * {@code nextChangeAt} / {@code nextStatus}: the next expected change by the known forecast. A ripe crop shows the
     * soil it ripened with (it no longer needs care).
     */
    public record SoilView(double moisture, String status, boolean slowing, double stressShare, double careFactor,
                           Instant nextChangeAt, String nextStatus, double thirst, boolean toned, String tierCap) {}

    /**
     * A farming supply of the catalogue. {@code effect} / {@code hours} / {@code value}: what it does (the client only
     * words it); {@code price} / {@code unlockLevel}: its market listing (null price = not sold); {@code owned}: units in
     * this player's storehouse.
     */
    public record SupplyItemView(String code, String nameVi, String category, String effect, double hours, double value,
                                 Long price, int unlockLevel, boolean locked, int owned) {}

    public record SoilRulesView(double dryBelow, double wetAbove, double waterGain, double dryFactor, double wetFactor,
                                double maxStressHours, double severeShare, String severeTierCap) {}

    /** Phase 3D catalogue and counters. {@code harvestBonusPaid} / {@code harvestBonusCap}: today's harvest coins. */
    public record FarmingView(List<SupplyItemView> items, SoilRulesView soil, int harvestBonusPaid, int harvestBonusCap) {}

    public record TreatResult(PlotView plot, String itemCode, int itemQty, Instant expiresAt) {}

    /**
     * Lifetime record of one crop. {@code harvested}: every harvest this garden ever closed (never lowered by selling);
     * {@code inStock}: what is in the storehouse now; {@code sold} / {@code delivered} / {@code composted} / {@code used}:
     * produce that left through a sale, a delivery order, the compost bin or an expansion / building / land purchase.
     */
    public record CropRecordView(String cropCode, String nameVi, int harvested, int masteryTier, int inStock, long sold,
                                 long delivered, long composted, long used) {}

    /** The farm's lifetime records: per crop and the coin totals by source (all read from stored facts). */
    public record RecordsView(List<CropRecordView> crops, long harvestedTotal, long soldUnits, long deliveredUnits,
                              long compostedUnits, long usedUnits, long saleCoins, long orderCoins,
                              long harvestBonusCoins) {}

    // ------------------------------------------------------------------ Phase 3C: buildings, land, contribution, rewards

    /** One effect of a building level (code + number); the client only words it. */
    public record EffectView(String code, double value) {}

    public record BuildingLevelView(int level, int minLevel, long coins, List<CompostLineView> materials, List<EffectView> effects) {}

    /**
     * A building of the farm. {@code level} 0 = not built yet; {@code effects}: what the current level does; {@code next}:
     * the next level and whether the player meets it ({@code preview}: the default produce, lowest tiers first).
     */
    public record BuildingView(String code, String nameVi, int level, int maxLevel, List<EffectView> effects,
                               BuildingLevelView next, boolean levelOk, boolean coinsOk, boolean materialsOk,
                               List<SupplyView> preview, List<BuildingLevelView> levels) {}

    /** A compost recipe of the storehouse: today's batches against the storehouse level's cap. */
    public record RecipeView(String code, int units, String minTier, String gives, int dailyCap, int usedToday, int remaining,
                             int held, List<SupplyView> preview) {}

    /**
     * A bed of a farmland region. {@code coins}: what it costs this player now (learning discount applied);
     * {@code basePrice}: the listed price. {@code status} OWNED / NEXT (buyable in order once the region is open) / LATER.
     */
    public record LandPlotView(int slot, int gx, int gy, long coins, long basePrice, List<CompostLineView> materials,
                               String status, boolean coinsOk, boolean materialsOk, List<SupplyView> preview) {}

    /** A region: its gate (every requirement with what the player has) and its beds. */
    public record RegionView(String code, String nameVi, String field, boolean open, List<RequirementView> gate,
                             List<LandPlotView> plots, int owned, int total) {}

    /**
     * Farmland beyond the first ten beds. {@code discount}: share of every coin price waived for this learner's verified
     * learning days ({@code nextDiscountAt} days give {@code nextDiscount}); learning is never a requirement.
     */
    public record LandView(List<RegionView> regions, int plotsOwned, int maxPlots, double discount, int learningDays,
                           Integer nextDiscountAt, Double nextDiscount) {}

    /** One credited fact (or a redemption, points below 0). {@code nominal} above {@code points}: a cap left part unpaid. */
    public record ContributionEntryView(long id, String source, String ref, int points, int nominal, LocalDate day, Instant at) {}

    /** Echo Contribution: a capped record, not a currency. Cap usage is for today / this week / this month (Vietnam time). */
    public record ContributionView(int balance, int earned, int spent, int dayPoints, int dayCap, int weekPoints, int weekCap,
                                   int monthPoints, int monthCap, List<ContributionEntryView> recent) {}

    /**
     * A reward of the catalogue. {@code status}: OPEN (can be redeemed now), LOCKED (a requirement is unmet), OWNED (this
     * player's limit is reached), SOLD_OUT, CLOSED (the reward counter is not open) or UNAVAILABLE (no delivery exists
     * yet: the reward is planned, never redeemable). {@code cost} is null for an UNAVAILABLE reward.
     */
    public record RewardView(String code, String kind, String nameVi, String descriptionVi, Integer cost, String status,
                             List<RequirementView> requirements, int redeemed, int perUserLimit) {}

    public record RedemptionView(long id, String rewardCode, String nameVi, int cost, String status, Instant at) {}

    public record RewardShopView(boolean open, List<RewardView> rewards, List<RedemptionView> history) {}

    public record EstateView(List<BuildingView> buildings, List<RecipeView> compost, LandView land,
                             ContributionView contribution, RewardShopView rewards) {}

    public record BuildingReceipt(String code, int level, long coinsPaid, List<SupplyView> consumed, long coins,
                                  EstateView estate, EconomyView economy) {}

    public record LandReceipt(int slot, String region, long coinsPaid, double discount, List<SupplyView> consumed,
                              PlotView plot, long coins, EstateView estate) {}

    public record CompostReceipt(String recipe, String item, int itemQty, List<SupplyView> consumed, int usedToday,
                                 int remaining, EstateView estate) {}

    public record RewardReceipt(long redemptionId, String rewardCode, int cost, int balance, String delivery,
                                String deliveryRef, ContributionView contribution, RewardShopView rewards,
                                CollectionView collection) {}

    public record ContributionPage(List<ContributionEntryView> entries, Long nextBefore) {}

    // ------------------------------------------------------------------ Phase 3B: monument, codex, skins, Echo

    /** One requirement of a next step: what the player has ({@code have}, not capped) against what is needed. */
    public record RequirementView(String code, int have, int need, boolean met) {}

    /** The next era of the monument or the next mastery tier of a crop, with its requirements. */
    public record NextStepView(int tier, List<RequirementView> requirements) {}

    /**
     * A skill branch of the monument: verified learning days of its family, its ornament tier, the days the next tier
     * needs ({@code nextAt}, null at the top tier) and whether today already counts. {@code enabled} false = the module
     * stores no trustworthy completion record yet.
     */
    public record BranchView(String family, boolean enabled, int days, int tier, int maxTier, Integer nextAt, boolean today) {}

    /** A permanent milestone: ERA / BRANCH (code = family) / MEMORY / RING / MASTERY (code = crop) / SKIN (code = skin). */
    public record MilestoneView(long id, String kind, String code, int tier, Instant reachedAt, boolean seen) {}

    /**
     * The monumental Knowledge Tree: lifetime verified learning (participation, never proficiency). {@code graduations}:
     * graduated trees credited to the monument (a tree counts when at least {@code minNewWords} of its words are new);
     * {@code forestCount}: every graduated tree. {@code cardsToday} / {@code minCardReviews}: different cards reviewed
     * today against what a verified vocabulary day needs. {@code rings}: after the final era, one per further block of
     * verified days. {@code unseen}: milestones not celebrated yet.
     */
    public record MonumentView(int era, int maxEra, int learningDays, boolean learnedToday, List<BranchView> branches,
                               int branchTiers, int graduations, int forestCount, int memoryTier, int memoryMaxTier,
                               Integer nextMemoryAt, NextStepView next, int rings, Integer daysToNextRing,
                               int minCardReviews, int cardsToday, int minNewWords, Instant since,
                               List<MilestoneView> recent, List<MilestoneView> unseen) {}

    /** A crop's mastery from its recorded harvests only. {@code bestTier}: best quality tier reached (null = none yet). */
    public record MasteryView(int tier, int maxTier, int harvests, String bestTier, List<String> seasons, int seasonsTotal,
                              NextStepView next, Instant firstAt, Instant lastAt) {}

    public record FormView(String form, Instant firstAt) {}

    /**
     * A cosmetic skin. {@code status} OWNED / AVAILABLE (its requirements are met: collect it, or buy it when
     * {@code unlockKind} is COIN) / LOCKED. A skin never changes growth, quality, price, XP or chance.
     */
    public record SkinView(String code, String cropCode, String nameVi, String descriptionVi, String artKey,
                           String unlockKind, long coinPrice, int masteryTier, int learningDays, String status,
                           boolean masteryOk, boolean learningOk, boolean coinsOk, boolean equipped, Instant acquiredAt) {}

    /** One codex page: discovered forms against the forms this crop can produce, its mastery and its skins. */
    public record CodexCropView(String cropCode, String nameVi, String rarity, String season, int unlockLevel,
                                boolean unlocked, boolean discovered, List<FormView> forms, List<String> possibleForms,
                                MasteryView mastery, List<SkinView> skins, String equippedSkin) {}

    public record CollectionView(List<CodexCropView> crops, int formsFound, int formsTotal, int skinsOwned, int skinsTotal,
                                 int masteryTiers, int masteryMax) {}

    /** Echo's single contextual hint (code + facts); the client only words it and links to a real route. */
    public record EchoView(String code, Map<String, Object> params) {}

    public record LivingView(MonumentView monument, CollectionView collection, EchoView echo) {}

    public record SkinReceipt(String skinCode, String cropCode, String source, long coinsPaid, long coins,
                              CollectionView collection) {}

    public record SkinEquipResult(String cropCode, String skinCode, CollectionView collection) {}

    public record MilestonesPage(List<MilestoneView> milestones, Long nextBefore) {}

    public record MilestonesSeen(int marked) {}

    // ------------------------------------------------------------------ Phase 3A: market, delivery board, expansion

    /** A supplied line in a preview or a receipt. */
    public record SupplyView(String cropCode, String tier, int qty) {}

    /**
     * One market offer of today: {@code unitQty} items per purchase unit at {@code price} coins, {@code bought} /
     * {@code remaining} of today's cap for this player; {@code locked} until {@code unlockLevel}.
     */
    public record OfferView(String code, String kind, String item, String cropCode, String nameVi, int unitQty, long price,
                            int dailyCap, int bought, int remaining, int unlockLevel, boolean locked, String category) {}

    /** Today's stall (Vietnam day) and when it restocks (next local midnight). */
    public record MarketView(LocalDate dayKey, Instant restockAt, int maxPerPurchase, List<OfferView> offers) {}

    /** {@code held}: units of this crop the player holds at an accepted tier. */
    public record OrderLineView(String cropCode, String nameVi, int qty, String minTier, int held) {}

    /**
     * A delivery order. {@code status} OPEN / FILLED / EXPIRED (derived from server time); {@code payoutNow}: coins a
     * delivery would pay right now (blessing included); {@code preview}: the default delivery (lowest accepted tiers
     * first), null when the stock does not cover it.
     */
    public record OrderView(long id, int slot, String kind, String status, List<OrderLineView> lines, long baseCoins,
                            long payoutNow, Map<String, Integer> bonus, Instant createdAt, Instant expiresAt,
                            Instant filledAt, Long paidCoins, Boolean blessing, List<SupplyView> delivered,
                            List<SupplyView> preview, boolean fillable) {}

    /** One board slot: its order of the current period, or none yet (locked by level, or nothing fits before {@code nextAt}). */
    public record BoardSlotView(int slot, String kind, int minLevel, boolean locked, OrderView order, Instant nextAt) {}

    public record BoardView(List<BoardSlotView> slots, Map<String, Integer> deliveryRecord, int filledTotal,
                            double coinMultiplier, double blessingMultiplier, boolean blessing) {}

    public record CompostLineView(String cropCode, String nameVi, int qty, int held) {}

    /**
     * A purchasable bed. {@code status} OWNED / NEXT (the one that can be bought now, sequential) / LATER;
     * {@code preview}: the default compost (lowest tiers first) when the stock covers it.
     */
    public record ExpansionPlotView(int slot, int gx, int gy, String field, int level, long coins,
                                    List<CompostLineView> compost, String status, boolean levelOk, boolean coinsOk,
                                    boolean compostOk, List<SupplyView> preview) {}

    public record ExpansionView(List<ExpansionPlotView> plots, int owned, int total) {}

    public record EconomyView(MarketView market, BoardView board, ExpansionView expansion) {}

    public record MarketReceipt(String offerCode, String item, int units, int itemsGained, long coinsPaid, long coins,
                                int boughtToday, int remainingToday, int itemQty, EconomyView economy) {}

    public record OrderReceipt(long orderId, long coinsPaid, boolean blessing, Map<String, Integer> bonus,
                               List<SupplyView> delivered, long coins, EconomyView economy) {}

    public record ExpansionReceipt(int slot, long coinsPaid, List<SupplyView> composted, PlotView plot, long coins,
                                   EconomyView economy) {}

    // ------------------------------------------------------------------ Phase 2: memory, pests, learning

    /** One bound word of a tree, with the Flashcard module's CURRENT facts and the tree's evidence of it. */
    public record TreeCardView(long flashcardId, String word, String meaningVi, boolean present, String status,
                               boolean due, boolean overdue, int reviewDays, int evidence, boolean needsAttention,
                               boolean qualifies, boolean reviewedToday) {}

    public record EssenceView(int available, double accrued, double perDay, double store, Instant fullAt, boolean claimable) {}

    public record NextStageView(int stage, int evidenceMissing, Instant reachableAt, int cardsBelowMinimum) {}

    public record GraduationView(boolean eligible, List<String> blockers, Instant ageReachedAt, Instant retryAt,
                                 int attempts, int questions, int pass) {}

    public record TreeView(long id, int slot, String species, Instant plantedAt, long ageDays, int stage, int evidence,
                           int maxEvidence, String health, int attention, List<TreeCardView> cards, EssenceView essence,
                           GraduationView graduation, NextStageView next, List<Long> pestIds) {}

    public record SlotView(int slot, int unlockLevel, boolean unlocked, TreeView tree) {}

    public record ForestTreeView(long id, String species, Instant plantedAt, Instant graduatedAt, List<String> words) {}

    public record KnowledgeView(List<SlotView> slots, int forestCount, Map<String, Integer> forestSpecies,
                                List<ForestTreeView> forestRecent) {}

    /**
     * {@code host} CROP (plotSlot / plantingId set) or TREE (treeId set); {@code reviewed}: the word was genuinely reviewed.
     * Phase 3C, crop pests: {@code stage} 1 warning (no effect), 2 leaf damage, 3 wilting, 0 resolved by a review (tree
     * pests are always 1 or 0); {@code nextStageAt}: when the damage worsens if the word stays unreviewed;
     * {@code effectEndsAt}: when the growth penalty ends whatever happens; {@code tended}: the crop was watered or
     * fertilized after the pest appeared.
     */
    public record PestView(long id, long flashcardId, String word, String meaningVi, String ipa, String host,
                           Long plantingId, Integer plotSlot, Long treeId, Instant spawnedAt, boolean reviewed,
                           Instant reviewedAt, boolean slowing, int stage, Instant nextStageAt, Instant effectEndsAt,
                           boolean tended) {}

    public record SourceView(String code, String category, boolean enabled) {}

    public record LearningView(int skillsToday, int skillCap, int skillXp, int fertilizerFirst, int gamesToday, int gameCap,
                               int gameXp, int pestCuresToday, int pestCureCap, List<SourceView> sources,
                               double harvestXpRawToday, double harvestFullUntil) {}

    public record DeckView(Long deckId, String title, int cards) {}

    public record CandidateView(long flashcardId, String word, String meaningVi, String ipa, String status, Long deckId,
                                String deckTitle, boolean overdue, boolean bound) {}

    public record CandidatesView(List<DeckView> decks, List<CandidateView> cards, int limit) {}

    public record KnowledgeResult(KnowledgeView knowledge, int essence, long treeId) {}

    public record EssenceResult(long treeId, int claimed, int essence, KnowledgeView knowledge) {}

    public record GraduationChallenge(UUID challengeId, Instant expiresAt, long treeId, List<QuestionView> questions, int pass) {}

    public record GraduationResult(UUID challengeId, long treeId, boolean passed, RecallView recall, int pass, long xpGained,
                                   int essenceGained, Map<String, Integer> items, LevelChange level, Instant retryAt,
                                   KnowledgeView knowledge) {}

    public record ForestPage(List<ForestTreeView> trees, int total, Long nextBefore) {}

    public record SprayResult(long pestId, int xp, boolean rewarded, long totalXp) {}

    // ------------------------------------------------------------------ command results

    public record PlantResult(PlotView plot, long coins, int seedsLeft, long coinsPaid, boolean tutorial) {}

    public record BoostResult(PlotView plot, String itemCode, int itemLeft) {}

    public record QuestionView(int index, String direction, String prompt, String ipa, List<String> options) {}

    public record HarvestChallenge(UUID challengeId, Instant expiresAt, List<Long> plantingIds,
                                   List<QuestionView> questions) {}

    public record AnswerView(int index, Integer chosen, int correctIndex, boolean correct) {}

    public record RecallView(int correct, int total, boolean skipped, List<AnswerView> answers) {}

    public record ComponentsView(int recall, int pest, int season, int care, int fresh) {}

    /**
     * {@code sharePortions} (Phase 3G): 0 = the harvest paid the whole produce unit; otherwise a visitor had taken a
     * little and the harvest paid this many portions of the unit instead ({@code shareUnit} portions make one unit).
     */
    public record HarvestLine(long plantingId, long plotId, String cropCode, String tier, int score,
                              ComponentsView components, boolean mutated, boolean moonlit, int xp,
                              List<String> newForms, boolean rainbow, int coins, int sharePortions, int shareUnit) {}

    public record LevelChange(int before, int after, List<UnlockView> unlocked) {}

    /** {@code coinsGained} (Phase 3D): the small harvest bonus of this harvest; {@code coins}: the balance after it. */
    public record HarvestResult(UUID challengeId, RecallView recall, List<HarvestLine> harvests, long xpGained,
                                LevelChange level, long coinsGained, long coins) {}

    public record SellLineResult(String cropCode, String tier, int qty, long unitPrice, long total) {}

    public record SellResult(long coinsGained, long coins, boolean blessing, List<SellLineResult> lines) {}

    public record Ack(boolean ok, int onboardingStep) {}

    // ------------------------------------------------------------------ Phase 4: the official administrator's QA access
    // Sent only to the official administrator (403 for every other account). `source` of every row behind these
    // receipts is ADMIN_QA: nothing here is a purchase, a payment or an achievement.

    /** {@code qaUnits} / {@code qaSkins}: what the garden currently holds only through QA (0 = QA is off). */
    public record AdminQaStatus(boolean admin, int qaUnits, int qaSkins, int maxAdvanceHours) {}

    /** {@code action}: UNLOCK or REVOKE; {@code units} / {@code skins}: what this command granted or took back. */
    public record AdminQaCosmeticsReceipt(String action, int units, int skins, AdminQaStatus status, CosmeticShopView shop) {}

    /** {@code action}: PROVISION (houses / livestock / guardians created, supplies added) or ADVANCE ({@code hours}). */
    public record AdminQaAnimalsReceipt(String action, int houses, int livestock, int guardians, Map<String, Integer> supplies,
                                        int hours, AnimalsView animals) {}

    public record AdminQaAdvanceRequest(@Min(1) @Max(72) int hours) {}
}
