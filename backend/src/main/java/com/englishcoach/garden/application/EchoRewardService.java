package com.englishcoach.garden.application;

import com.englishcoach.avatarframe.service.GardenFrameCatalog;
import com.englishcoach.garden.api.GardenDtos.EchoRewardsView;
import com.englishcoach.garden.api.GardenDtos.FrameReceipt;
import com.englishcoach.garden.api.GardenDtos.FrameRequirementView;
import com.englishcoach.garden.api.GardenDtos.FrameShopView;
import com.englishcoach.garden.api.GardenDtos.GardenFrameView;
import com.englishcoach.garden.api.GardenDtos.PremiumRewardEntry;
import com.englishcoach.garden.api.GardenDtos.PremiumRewardReceipt;
import com.englishcoach.garden.api.GardenDtos.PremiumRewardView;
import com.englishcoach.garden.api.GardenDtos.VoucherBuyRequest;
import com.englishcoach.garden.api.GardenDtos.VoucherGrantView;
import com.englishcoach.garden.api.GardenDtos.VoucherPackView;
import com.englishcoach.garden.api.GardenDtos.VoucherReceipt;
import com.englishcoach.garden.api.GardenDtos.VoucherShopView;
import com.englishcoach.garden.api.GardenDtos.VoucherUseView;
import com.englishcoach.garden.api.GardenException;
import com.englishcoach.garden.config.GardenProperties;
import com.englishcoach.garden.infra.RewardRepository;
import com.englishcoach.garden.infra.RewardRepository.Pack;
import com.englishcoach.garden.infra.RewardRepository.PremiumReward;
import com.englishcoach.garden.infra.RewardRepository.Rules;
import com.englishcoach.premium.promo.PromoPremiumService;
import com.englishcoach.premium.service.PremiumEntitlementService;
import com.englishcoach.premium.voucher.AiVoucherService;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Echo Rewards for Echo Coins (Phase 3F): the Premium 7-day reward, AI voucher packs and the Echo Garden profile frames.
 *
 * <p>Each reward is delivered by the module that owns it, inside ONE transaction with the coin debit:</p>
 * <ul>
 *   <li><b>Premium</b> — {@link PromoPremiumService} writes a real 168-hour {@code premium_subscriptions} row (never a
 *   payment order). Rules (all from {@code garden_config.rewards3f}): the price, at most {@code maxPerWindow}
 *   redemptions in any rolling {@code windowDays}, the next one no sooner than {@code cooldownDays} after the previous
 *   reward ENDED, {@code learningDays} verified learning days among the last {@code learningWindowDays} Vietnam dates,
 *   and no Premium window (paid, granted or rewarded) active or still to come.</li>
 *   <li><b>AI vouchers</b> — {@link AiVoucherService} issues a grant in the account-wide wallet the AI quota
 *   interceptor spends from; at most {@code capCredits} bought credits in any rolling {@code capWindowDays}, valid
 *   {@code validDays}.</li>
 *   <li><b>Profile frames</b> — {@link GardenFrameCatalog} makes a coin-bought frame owned in the avatar-frame module;
 *   earned frames are unlocked by that module's own engine and are never sold.</li>
 * </ul>
 * Premium and vouchers cost real money to serve, so each is closed unless the owner switched it on AND configured its
 * monthly cap, unit cost and cost budget ({@link GardenProperties}); the budget is reserved with a guarded statement in
 * the same transaction, so a refused or failed redemption debits nothing and consumes no slot. Every command is
 * idempotent by its key (GardenContext) and serialised per player.
 */
@Service
public class EchoRewardService {

    static final ZoneId ZONE = ZoneId.of("Asia/Ho_Chi_Minh");
    static final String PLAN = "GARDEN_REWARD_7D";
    static final String PREMIUM_SOURCE = "GARDEN_REWARD";
    static final String VOUCHER_SOURCE = "GARDEN_COIN";
    private static final DateTimeFormatter PERIOD = DateTimeFormatter.ofPattern("yyyy-MM");

    private final GardenContext ctx;
    private final GardenAccessService access;
    private final GardenSetup setup;
    private final LedgerService ledger;
    private final GardenProperties properties;
    private final RewardRepository repo;
    private final PromoPremiumService premium;
    private final AiVoucherService vouchers;
    private final GardenFrameCatalog frames;
    private final GardenFrameFacts facts;

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private org.springframework.beans.factory.ObjectProvider<PremiumEntitlementService> entitlementService;

    public EchoRewardService(GardenContext ctx, GardenAccessService access, GardenSetup setup, LedgerService ledger,
                             GardenProperties properties, RewardRepository repo, PromoPremiumService premium,
                             AiVoucherService vouchers, GardenFrameCatalog frames, GardenFrameFacts facts) {
        this.ctx = ctx;
        this.access = access;
        this.setup = setup;
        this.ledger = ledger;
        this.properties = properties;
        this.repo = repo;
        this.premium = premium;
        this.vouchers = vouchers;
        this.frames = frames;
        this.facts = facts;
    }

    private Rules rules() {
        Rules r = repo.rules();
        if (r == null) throw GardenException.conflict("REWARDS_CLOSED");
        return r;
    }

    private static String period(Instant now) {
        return LocalDate.ofInstant(now, ZONE).format(PERIOD);
    }

    // ------------------------------------------------------------------ view

    public EchoRewardsView view(long userId) {
        access.require(userId);
        return ctx.read(userId, now -> {
            setup.ensure(userId, now);
            return view(userId, now);
        });
    }

    private EchoRewardsView view(long userId, Instant now) {
        Rules r = rules();
        long coins = ctx.repo.profile(userId).coins();
        return new EchoRewardsView(coins, premiumView(userId, r, coins, now), voucherView(userId, r, coins, now), frameView(userId, coins));
    }

    // ------------------------------------------------------------------ Premium 7 days

    /** Everything the redemption is checked against, in the order the checks run. */
    private record PremiumFacts(int learningDays, int redeemedInWindow, Instant activeUntil, Instant nextEligibleAt, String blocker) {}

    private PremiumFacts premiumFacts(long userId, Rules r, long coins, Instant now) {
        LocalDate today = LocalDate.ofInstant(now, ZONE);
        int days = repo.learningDays(userId, today.minusDays(r.premiumLearningWindowDays() - 1L), today);
        List<PremiumReward> history = repo.premiumRewards(userId);
        Instant windowStart = now.minus(Duration.ofDays(r.premiumWindowDays()));
        List<PremiumReward> inWindow = history.stream().filter(p -> p.createdAt().isAfter(windowStart)).toList();
        Instant activeUntil = history.stream().map(PremiumReward::expiresAt).filter(e -> e.isAfter(now)).max(Instant::compareTo).orElse(null);
        // the next redemption may start only cooldownDays after the latest reward ended, and only once fewer than
        // maxPerWindow redemptions lie inside the rolling window
        Instant next = null;
        if (!history.isEmpty()) next = history.getFirst().expiresAt().plus(Duration.ofDays(r.premiumCooldownDays()));
        if (inWindow.size() >= r.premiumMaxPerWindow()) {
            // newest first: a slot frees when the maxPerWindow-th newest redemption leaves the rolling window
            Instant frees = inWindow.get(r.premiumMaxPerWindow() - 1).createdAt().plus(Duration.ofDays(r.premiumWindowDays()));
            next = next == null || frees.isAfter(next) ? frees : next;
        }
        String blocker;
        if (!properties.premiumRewardOpen()) blocker = "CLOSED";
        else if (repo.issued("PREMIUM_7D", period(now)) >= properties.getPremiumRewardMonthlyCap()) blocker = "BUDGET_EXHAUSTED";
        else if (premium.hasActiveOrUpcomingEntitlement(userId, now)) blocker = "PREMIUM_ACTIVE";
        else if (inWindow.size() >= r.premiumMaxPerWindow()) blocker = "WINDOW_LIMIT";
        else if (next != null && now.isBefore(next)) blocker = "COOLDOWN";
        else if (days < r.premiumLearningDays()) blocker = "LEARNING_DAYS";
        else if (coins < r.premiumCoins()) blocker = "INSUFFICIENT_FUNDS";
        else blocker = null;
        return new PremiumFacts(days, inWindow.size(), activeUntil, next != null && next.isAfter(now) ? next : null, blocker);
    }

    private PremiumRewardView premiumView(long userId, Rules r, long coins, Instant now) {
        PremiumFacts f = premiumFacts(userId, r, coins, now);
        return new PremiumRewardView(properties.premiumRewardOpen(), f.blocker() == null ? "AVAILABLE" : f.blocker(), r.premiumCoins(),
                r.premiumHours(), f.learningDays(), r.premiumLearningDays(), r.premiumLearningWindowDays(), f.redeemedInWindow(),
                r.premiumMaxPerWindow(), r.premiumWindowDays(), r.premiumCooldownDays(), f.activeUntil(), f.nextEligibleAt(),
                repo.premiumRewards(userId).stream().map(p -> new PremiumRewardEntry(p.id(), p.coinsSpent(), p.startsAt(), p.expiresAt())).toList());
    }

    /** Redeems the Premium 7-day reward: every rule, the budget, the coin debit and the entitlement in one transaction. */
    public PremiumRewardReceipt redeemPremium(long userId, UUID key) {
        access.require(userId);
        return ctx.command(userId, key, "PREMIUM_REWARD", Map.of("reward", "PREMIUM_7D"), PremiumRewardReceipt.class, setup.ensurer(userId), (now, op) -> {
            Rules r = rules();
            long coins = ctx.repo.profile(userId).coins();
            PremiumFacts f = premiumFacts(userId, r, coins, now);
            if (f.blocker() != null) {
                throw switch (f.blocker()) {
                    case "CLOSED" -> GardenException.conflict("REWARD_CLOSED");
                    case "BUDGET_EXHAUSTED" -> GardenException.conflict("REWARD_BUDGET_EXHAUSTED");
                    case "PREMIUM_ACTIVE" -> GardenException.conflict("PREMIUM_ACTIVE");
                    case "WINDOW_LIMIT" -> GardenException.conflict("REWARD_WINDOW_LIMIT", Map.of("max", r.premiumMaxPerWindow()));
                    case "COOLDOWN" -> GardenException.conflict("REWARD_COOLDOWN");
                    case "LEARNING_DAYS" -> GardenException.conflict("REWARD_LEARNING_DAYS", Map.of("need", r.premiumLearningDays(), "have", f.learningDays()));
                    default -> GardenException.conflict("INSUFFICIENT_FUNDS", Map.of("missing", r.premiumCoins() - coins));
                };
            }
            String period = period(now);
            if (!repo.reserveBudget("PREMIUM_7D", period, 1, properties.getPremiumRewardMonthlyCap(),
                    properties.getPremiumRewardUnitCostVnd(), properties.getPremiumRewardMonthlyBudgetVnd())) {
                throw GardenException.conflict("REWARD_BUDGET_EXHAUSTED");
            }
            if (!ledger.takeCoins(userId, r.premiumCoins(), "PREMIUM_REWARD", "REWARD", "PREMIUM_7D", op, now)) {
                throw GardenException.conflict("INSUFFICIENT_FUNDS", Map.of("missing", r.premiumCoins() - coins));
            }
            long subscription = premium.grant(userId, PLAN, PREMIUM_SOURCE, now, r.premiumHours());
            if (entitlementService != null) {
                PremiumEntitlementService ent = entitlementService.getIfAvailable();
                if (ent != null) ent.invalidatePremiumCache(userId);
            }
            Instant expires = now.plus(Duration.ofHours(r.premiumHours()));
            long id = repo.recordPremiumReward(userId, subscription, r.premiumCoins(), f.learningDays(), now, expires, period, op, now);
            ctx.repo.log(userId, "PREMIUM_REWARD", ctx.write(Map.of("reward", id, "subscription", subscription, "coins", r.premiumCoins())), now);
            return new PremiumRewardReceipt(id, r.premiumCoins(), ctx.repo.profile(userId).coins(), now, expires, view(userId, now));
        });
    }

    // ------------------------------------------------------------------ AI vouchers

    private VoucherShopView voucherView(long userId, Rules r, long coins, Instant now) {
        var wallet = vouchers.wallet(userId);
        int bought = vouchers.issuedSince(userId, VOUCHER_SOURCE, now.minus(Duration.ofDays(r.voucherCapWindowDays())));
        boolean open = properties.aiVoucherOpen();
        String status = !open ? "CLOSED"
                : repo.issued("AI_VOUCHER", period(now)) >= properties.getAiVoucherMonthlyCreditCap() ? "BUDGET_EXHAUSTED"
                : bought >= r.voucherCapCredits() ? "CAP_REACHED" : "AVAILABLE";
        List<VoucherPackView> packs = r.packs().stream()
                .map(p -> new VoucherPackView(p.code(), p.credits(), p.coins(), coins >= p.coins(), bought + p.credits() <= r.voucherCapCredits())).toList();
        return new VoucherShopView(open, status, wallet.balance(), wallet.nextExpiry(), bought, r.voucherCapCredits(), r.voucherCapWindowDays(),
                r.voucherValidDays(), packs,
                wallet.grants().stream().map(g -> new VoucherGrantView(g.credits(), g.remaining(), g.issuedAt(), g.expiresAt())).toList(),
                wallet.recent().stream().map(u -> new VoucherUseView(u.featureKey(), u.status(), u.completedAt() == null ? u.createdAt() : u.completedAt())).toList(),
                wallet.eligibleFeatures());
    }

    /** Buys one voucher pack: the rolling purchase cap, the budget, the coin debit and the grant in one transaction. */
    public VoucherReceipt buyVouchers(long userId, UUID key, VoucherBuyRequest request) {
        access.require(userId);
        return ctx.command(userId, key, "AI_VOUCHER_BUY", Map.of("pack", request.pack()), VoucherReceipt.class, setup.ensurer(userId), (now, op) -> {
            Rules r = rules();
            Pack pack = r.pack(request.pack());
            if (pack == null) throw new GardenException(404, "VOUCHER_PACK_NOT_FOUND");
            if (!properties.aiVoucherOpen()) throw GardenException.conflict("REWARD_CLOSED");
            int bought = vouchers.issuedSince(userId, VOUCHER_SOURCE, now.minus(Duration.ofDays(r.voucherCapWindowDays())));
            if (bought + pack.credits() > r.voucherCapCredits()) {
                throw GardenException.conflict("VOUCHER_CAP", Map.of("cap", r.voucherCapCredits(), "bought", bought));
            }
            if (!repo.reserveBudget("AI_VOUCHER", period(now), pack.credits(), properties.getAiVoucherMonthlyCreditCap(),
                    properties.getAiVoucherUnitCostVnd(), properties.getAiVoucherMonthlyBudgetVnd())) {
                throw GardenException.conflict("REWARD_BUDGET_EXHAUSTED");
            }
            long coins = ctx.repo.profile(userId).coins();
            if (!ledger.takeCoins(userId, pack.coins(), "AI_VOUCHER_BUY", "REWARD", "AI_VOUCHER_" + pack.code(), op, now)) {
                throw GardenException.conflict("INSUFFICIENT_FUNDS", Map.of("missing", pack.coins() - coins));
            }
            long grant = vouchers.issue(userId, pack.credits(), VOUCHER_SOURCE, op.toString(), now, Duration.ofDays(r.voucherValidDays()));
            ctx.repo.log(userId, "AI_VOUCHER_BUY", ctx.write(Map.of("pack", pack.code(), "credits", pack.credits(), "coins", pack.coins(), "grant", grant)), now);
            return new VoucherReceipt(pack.code(), pack.credits(), pack.coins(), ctx.repo.profile(userId).coins(), view(userId, now));
        });
    }

    // ------------------------------------------------------------------ profile frames

    private FrameShopView frameView(long userId, long coins) {
        if (!properties.isFramesEnabled()) return new FrameShopView(false, List.of(), 0, 0);
        var owned = frames.owned(userId);
        List<GardenFrameView> out = new ArrayList<>();
        for (var f : frames.frames()) {
            var mine = owned.get(f.slug());
            List<FrameRequirementView> reqs = f.requirements().stream().map(q -> {
                long have = facts.value(userId, q.metric());
                return new FrameRequirementView(q.metric(), q.target(), Math.min(have, q.target()), have >= q.target());
            }).toList();
            boolean met = f.coin() || reqs.stream().allMatch(FrameRequirementView::ok);
            String status = mine != null ? "OWNED" : met ? "AVAILABLE" : "LOCKED";
            out.add(new GardenFrameView(f.slug(), f.name(), f.tier(), f.asset(), f.seriesSlug(), f.seriesName(), f.coin() ? "COIN" : "EARNED",
                    f.coinPrice(), !f.coin() || coins >= f.coinPrice(), reqs, status, mine != null, mine != null && mine.equipped()));
        }
        return new FrameShopView(true, out, (int) out.stream().filter(GardenFrameView::owned).count(), out.size());
    }

    /** Buys a coin frame once: the coin debit, the purchase record and the frame module's ownership row in one transaction. */
    public FrameReceipt buyFrame(long userId, UUID key, String slug) {
        access.require(userId);
        return ctx.command(userId, key, "FRAME_BUY", Map.of("slug", slug), FrameReceipt.class, setup.ensurer(userId), (now, op) -> {
            rules();
            if (!properties.isFramesEnabled()) throw GardenException.conflict("REWARD_CLOSED");
            var frame = frames.frame(slug);
            if (frame == null) throw new GardenException(404, "FRAME_NOT_FOUND");
            // an earned frame has no price: it cannot be bought to skip its requirement
            if (!frame.coin() || frame.coinPrice() <= 0) throw GardenException.conflict("FRAME_NOT_FOR_SALE");
            if (frames.owned(userId).containsKey(slug)) throw GardenException.conflict("FRAME_OWNED");
            long coins = ctx.repo.profile(userId).coins();
            if (!ledger.takeCoins(userId, frame.coinPrice(), "FRAME_BUY", "FRAME", slug, op, now)) {
                throw GardenException.conflict("INSUFFICIENT_FUNDS", Map.of("missing", frame.coinPrice() - coins));
            }
            if (!repo.recordFramePurchase(userId, slug, frame.coinPrice(), op, now) || !frames.grantPurchased(userId, slug, now)) {
                throw GardenException.conflict("FRAME_OWNED");
            }
            ctx.repo.log(userId, "FRAME_BUY", ctx.write(Map.of("slug", slug, "coins", frame.coinPrice())), now);
            return new FrameReceipt(slug, frame.coinPrice(), ctx.repo.profile(userId).coins(), view(userId, now));
        });
    }
}
