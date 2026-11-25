package com.englishcoach.garden.application;

import com.englishcoach.auth.policy.AdminIdentityService;
import com.englishcoach.garden.api.GardenDtos.AdminCommerceQueue;
import com.englishcoach.garden.api.GardenDtos.AdminIssueView;
import com.englishcoach.garden.api.GardenDtos.AdminRefundView;
import com.englishcoach.garden.api.GardenDtos.CosmeticCheckoutRequest;
import com.englishcoach.garden.api.GardenDtos.CosmeticCheckoutView;
import com.englishcoach.garden.api.GardenDtos.CosmeticOrdersView;
import com.englishcoach.garden.api.GardenException;
import com.englishcoach.garden.config.GardenProperties;
import com.englishcoach.garden.domain.CosmeticRules;
import com.englishcoach.garden.domain.CosmeticRules.Item;
import com.englishcoach.garden.infra.CommerceRepository;
import com.englishcoach.garden.infra.CommerceRepository.Issue;
import com.englishcoach.garden.infra.CommerceRepository.Payment;
import com.englishcoach.garden.infra.CommerceRepository.Refund;
import com.englishcoach.garden.infra.CosmeticRepository;
import com.englishcoach.garden.infra.CosmeticRepository.Order;
import com.englishcoach.garden.infra.CosmeticRepository.Sku;
import com.englishcoach.garden.infra.RewardRepository;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.function.LongConsumer;

/**
 * Cosmetics for VND through the existing SePay bank-transfer path (Phase 3F).
 *
 * <p><b>Open</b> only when all of these hold: the switch {@code app.garden.cosmetic-checkout-enabled} is on, the
 * payment gateway can take AND verify payments (merchant account and webhook secret configured), the catalogue and the
 * V87 commerce tables exist. Otherwise {@link #start} answers {@code CHECKOUT_DISABLED} and writes nothing; buying with
 * Echo Coins never depends on any of this.</p>
 *
 * <ul>
 *   <li><b>What is sold</b>: exactly the catalogue items that are sold for Echo Coins and carry an enabled SKU with the
 *   owner's fixed VND price (V87) — never an earned item, never an item the player already owns, never Echo Coins.</li>
 *   <li><b>An order</b> belongs to one player, one item and one amount and never changes them (database trigger). Its
 *   transfer reference is unique across every order of the payment module. It can be paid for
 *   {@code checkout.ttlMinutes}; the countdown on screen is only a display — {@link #settle} decides by server time.</li>
 *   <li><b>Delivery</b> happens only in {@link #settle}, which the payment module calls for a transfer it has verified
 *   (signature, replay guard, inbound, receiving account). The item is granted exactly once to the player the ORDER
 *   names, only when the order is open, in time and the amount is exact. Anything else — late, wrong amount, closed
 *   order, second payment, item meanwhile owned — grants nothing and opens a reconciliation issue for the
 *   administrator: verified money is never silently dropped and never guessed into a delivery.</li>
 *   <li><b>Refunds</b>: the buyer may ask within {@code refund.requestDays} for an item that was never worn, placed or
 *   planted; the administrator completes it after sending the bank transfer back by hand (SePay bank transfers cannot
 *   be reversed by API) and may open one for a delivery failure, duplicate charge, unauthorized payment, defect or
 *   charge-back. Completing takes back exactly what this order delivered; history rows stay.</li>
 * </ul>
 * Nothing here touches Premium, the AI quota or {@code payment_orders}.
 */
@Service
public class CosmeticCheckoutService {

    /** What {@link #settle} did with one verified transfer. {@code deliveredNow}: this call granted the item. */
    public record Settled(boolean delivered, boolean deliveredNow, long orderId, long userId, String productName, String outcome, String detail) {}

    private final GardenContext ctx;
    private final GardenAccessService access;
    private final GardenSetup setup;
    private final GardenProperties properties;
    private final CosmeticRepository repo;
    private final CommerceRepository commerce;
    private final RewardRepository rewards;
    private final CollectionService collection;
    private final Optional<CosmeticPaymentGateway> gateway;
    private final LongConsumer adminGuard;

    @Autowired
    public CosmeticCheckoutService(GardenContext ctx, GardenAccessService access, GardenSetup setup, GardenProperties properties,
                                   CosmeticRepository repo, CommerceRepository commerce, RewardRepository rewards,
                                   CollectionService collection, Optional<CosmeticPaymentGateway> gateway, AdminIdentityService admins) {
        this(ctx, access, setup, properties, repo, commerce, rewards, collection, gateway, admins::requireOfficialAdmin);
    }

    /** {@code adminGuard} throws unless the id is the official administrator's. */
    public CosmeticCheckoutService(GardenContext ctx, GardenAccessService access, GardenSetup setup, GardenProperties properties,
                                   CosmeticRepository repo, CommerceRepository commerce, RewardRepository rewards,
                                   CollectionService collection, Optional<CosmeticPaymentGateway> gateway, LongConsumer adminGuard) {
        this.ctx = ctx;
        this.access = access;
        this.setup = setup;
        this.properties = properties;
        this.repo = repo;
        this.commerce = commerce;
        this.rewards = rewards;
        this.collection = collection;
        this.gateway = gateway;
        this.adminGuard = adminGuard;
    }

    /** Whether an order can be started at all. */
    public boolean open() {
        return properties.isCosmeticCheckoutEnabled() && gateway.isPresent() && gateway.get().available()
                && ctx.cosmetics() != null && commerce.present() && rewards.rules() != null;
    }

    private static UUID orderKey(long orderId) {
        return UUID.nameUUIDFromBytes(("order:" + orderId).getBytes());
    }

    // ------------------------------------------------------------------ the buyer

    /** Starts (or returns the open) order of a catalogue item the player may buy and does not own yet. */
    public CosmeticCheckoutView start(long userId, UUID key, CosmeticCheckoutRequest request) {
        access.require(userId);
        if (!open()) throw GardenException.conflict("CHECKOUT_DISABLED");
        CosmeticPaymentGateway pay = gateway.orElseThrow();
        boolean qa = access.qa(userId);
        String kind = request.itemKind();
        return ctx.command(userId, key, "COSMETIC_CHECKOUT", Map.of("kind", kind, "code", request.code()), CosmeticCheckoutView.class,
                setup.ensurer(userId), (now, op) -> {
                    String name = sellable(userId, kind, request.code(), now, qa);
                    Sku sku = repo.skuOf(kind, request.code());
                    if (sku == null || !sku.enabled() || sku.priceVnd() == null) throw GardenException.conflict("CHECKOUT_UNAVAILABLE");
                    Order open = repo.openOrder(userId, sku.skuCode());
                    if (open != null && !now.isBefore(commerce.payment(open.id()).expiresAt())) {
                        repo.advanceOrder(open.id(), "PENDING", "EXPIRED", now);   // its window is over: a new order, a new reference
                        open = null;
                    }
                    if (open == null) {
                        String ref = pay.createPayment(userId, sku.skuCode(), sku.priceVnd());
                        if (ref == null || ref.isBlank()) throw new GardenException(502, "CHECKOUT_PROVIDER_FAILED");
                        long id = repo.createOrder(userId, sku, pay.provider(), ref, now);
                        commerce.createPayment(id, userId, ref, now.plus(Duration.ofMinutes(rewards.rules().checkoutTtlMinutes())), now);
                        open = repo.orderById(id);
                        ctx.repo.log(userId, "COSMETIC_ORDER", ctx.write(Map.of("kind", kind, "code", request.code(), "order", id,
                                "amountVnd", open.amountVnd())), now);
                    }
                    return view(open, name, now);
                });
    }

    /** One of the player's own orders (the payment sheet polls this); another player's order is a 404. */
    public CosmeticCheckoutView order(long userId, long orderId) {
        access.require(userId);
        if (!commerce.present()) throw new GardenException(404, "ORDER_NOT_FOUND");
        return ctx.read(userId, now -> {
            Order o = mine(userId, orderId);
            if ("PENDING".equals(o.status())) {
                // the window is decided here, by server time; an item bought with Echo Coins meanwhile closes the order
                if (!now.isBefore(commerce.payment(o.id()).expiresAt())) repo.advanceOrder(o.id(), "PENDING", "EXPIRED", now);
                else if (owned(o)) repo.advanceOrder(o.id(), "PENDING", "CANCELLED", now);
                o = repo.orderById(orderId);
            }
            return view(o, productName(o), now);
        });
    }

    /** The player's latest orders, newest first. */
    public CosmeticOrdersView orders(long userId) {
        access.require(userId);
        if (!commerce.present()) return new CosmeticOrdersView(false, List.of());
        return ctx.read(userId, now -> {
            List<CosmeticCheckoutView> out = new ArrayList<>();
            for (Order o : repo.ordersOf(userId, 20)) out.add(view(o, productName(o), now));
            return new CosmeticOrdersView(open(), out);
        });
    }

    /** The buyer abandons an unpaid order: it closes and grants nothing (a paid or closed order is left as it is). */
    public CosmeticCheckoutView cancel(long userId, UUID key, long orderId) {
        access.require(userId);
        if (!commerce.present()) throw new GardenException(404, "ORDER_NOT_FOUND");
        return ctx.command(userId, key, "COSMETIC_ORDER_CANCEL", Map.of("order", orderId), CosmeticCheckoutView.class, setup.ensurer(userId), (now, op) -> {
            Order o = mine(userId, orderId);
            repo.advanceOrder(o.id(), "PENDING", "CANCELLED", now);
            return view(repo.orderById(orderId), productName(o), now);
        });
    }

    /** The buyer asks for a refund: only a delivered order, inside the policy window, whose item was never used. */
    public CosmeticCheckoutView requestRefund(long userId, UUID key, long orderId, String reason) {
        access.require(userId);
        if (!commerce.present()) throw new GardenException(404, "ORDER_NOT_FOUND");
        String why = reason == null ? "" : reason.trim();
        return ctx.command(userId, key, "COSMETIC_REFUND_REQUEST", Map.of("order", orderId, "reason", why), CosmeticCheckoutView.class,
                setup.ensurer(userId), (now, op) -> {
                    Order o = mine(userId, orderId);
                    if (!"FULFILLED".equals(o.status())) throw GardenException.conflict("REFUND_NOT_PAID");
                    if (commerce.refundOfOrder(o.id()) != null) throw GardenException.conflict("REFUND_EXISTS");
                    Payment p = commerce.payment(o.id());
                    if (now.isAfter(refundDeadline(p))) throw GardenException.conflict("REFUND_WINDOW_OVER");
                    if (commerce.usedSince(userId, o.itemKind(), o.itemCode(), p.paidAt())) throw GardenException.conflict("REFUND_ITEM_USED");
                    commerce.openRefund(o.id(), userId, "CUSTOMER_REQUEST", why, o.amountVnd(), now);
                    ctx.repo.log(userId, "COSMETIC_REFUND_REQUEST", ctx.write(Map.of("order", o.id(), "code", o.itemCode())), now);
                    return view(o, productName(o), now);
                });
    }

    // ------------------------------------------------------------------ a verified transfer (payment module only)

    public boolean ownsTransferCode(String transferCode) {
        return transferCode != null && commerce.present() && commerce.codeExists(transferCode);
    }

    /**
     * Settles ONE transfer the payment module has verified. Idempotent per provider transaction. Grants only to the
     * player the order names, only for an open order paid in time with the exact amount; every other case grants
     * nothing and is recorded as a reconciliation issue.
     */
    public Settled settle(String provider, String providerTransactionId, String transferCode, long paidAmountVnd) {
        Payment found = commerce.paymentByCode(transferCode);
        if (found == null) return new Settled(false, false, 0, 0, null, "ORDER_NOT_FOUND", null);
        return ctx.read(found.userId(), now -> {
            Order o = repo.orderById(found.orderId());
            Payment p = commerce.payment(o.id());
            String name = productName(o);
            if (providerTransactionId.equals(p.providerTransactionId())) {   // the transaction that paid this order, delivered again
                return new Settled(true, false, o.id(), o.userId(), name, "ALREADY_SETTLED", null);
            }
            Issue known = commerce.issueByTransaction(providerTransactionId);
            if (known != null) return new Settled(false, false, o.id(), o.userId(), name, known.kind(), "issue #" + known.id());

            String problem = null;
            if (!provider.equals(o.provider())) problem = "ORDER_CLOSED";
            else if ("FULFILLED".equals(o.status()) || "REFUNDED".equals(o.status())) problem = "DUPLICATE_PAYMENT";
            else if ("CANCELLED".equals(o.status())) problem = "ORDER_CLOSED";
            else if ("EXPIRED".equals(o.status())) problem = "LATE_PAYMENT";
            else if (now.isAfter(p.expiresAt().plusSeconds(rewards.rules().checkoutGraceSeconds()))) {
                repo.advanceOrder(o.id(), "PENDING", "EXPIRED", now);
                problem = "LATE_PAYMENT";
            }
            if (problem == null && paidAmountVnd != o.amountVnd()) problem = "AMOUNT_MISMATCH";
            if (problem == null && !deliverable(o)) problem = "UNAVAILABLE";
            if (problem == null && owned(o)) {
                repo.advanceOrder(o.id(), "PENDING", "CANCELLED", now);   // bought with Echo Coins meanwhile: nothing to deliver
                problem = "ALREADY_OWNED";
            }
            if (problem != null) {
                long issue = commerce.openIssue(problem, o.id(), o.userId(), providerTransactionId, paidAmountVnd, now);
                ctx.repo.log(o.userId(), "COSMETIC_PAYMENT_ISSUE", ctx.write(Map.of("order", o.id(), "kind", problem, "issue", issue,
                        "paid", paidAmountVnd, "amountVnd", o.amountVnd())), now);
                return new Settled(false, false, o.id(), o.userId(), name, problem, "issue #" + issue);
            }
            if (!repo.advanceOrder(o.id(), "PENDING", "FULFILLED", now)) {
                throw new IllegalStateException("cosmetic order " + o.id() + " changed while it was being settled");
            }
            deliver(o, providerTransactionId, now);
            return new Settled(true, true, o.id(), o.userId(), name, "FULFILLED", null);
        });
    }

    /** Marks the order paid by this transaction and grants its item; any failure rolls the whole settlement back. */
    private void deliver(Order o, String providerTransactionId, Instant now) {
        if (!commerce.markPaid(o.id(), providerTransactionId, now)) throw new IllegalStateException("cosmetic order " + o.id() + " is already paid");
        boolean granted = "SKIN".equals(o.itemKind())
                ? commerce.grantSkin(o.userId(), o.itemCode(), orderKey(o.id()), now)
                : repo.grantUnit(o.userId(), o.itemCode(), 1, "MONEY", 0, o.id(), orderKey(o.id()), now);
        if (!granted) throw new IllegalStateException("cosmetic order " + o.id() + " could not be delivered");
        ctx.repo.log(o.userId(), "COSMETIC_ACQUIRE", ctx.write(Map.of("code", o.itemCode(), "unit", 1, "kind", "MONEY", "order", o.id())), now);
    }

    // ------------------------------------------------------------------ the administrator

    public AdminCommerceQueue queue(long adminId) {
        adminGuard.accept(adminId);
        if (!commerce.present()) return new AdminCommerceQueue(false, List.of(), List.of());
        List<AdminRefundView> refunds = new ArrayList<>();
        for (Refund r : commerce.refunds("REQUESTED", 100)) {
            Order o = repo.orderById(r.orderId());
            refunds.add(new AdminRefundView(r.id(), r.orderId(), r.userId(), r.kind(), r.status(), r.reason(), r.amountVnd(), r.requestedAt(),
                    o.itemKind(), o.itemCode(), o.status(), o.providerRef()));
        }
        List<AdminIssueView> issues = new ArrayList<>();
        for (Issue i : commerce.issues("OPEN", 100)) {
            Order o = repo.orderById(i.orderId());
            issues.add(new AdminIssueView(i.id(), i.kind(), i.orderId(), i.userId(), i.providerTransactionId(), i.paidAmountVnd(), o.amountVnd(),
                    o.itemKind(), o.itemCode(), o.status(), i.createdAt()));
        }
        return new AdminCommerceQueue(open(), refunds, issues);
    }

    /**
     * Completes a requested refund AFTER the administrator sent the money back by bank transfer ({@code bankReference}
     * names that transfer): the order becomes REFUNDED and exactly what it delivered is taken back.
     */
    public AdminCommerceQueue completeRefund(long adminId, long refundId, String bankReference, String note) {
        adminGuard.accept(adminId);
        if (bankReference == null || bankReference.isBlank()) throw new GardenException(400, "BANK_REFERENCE_REQUIRED");
        Refund r = refundOrThrow(refundId);
        ctx.read(r.userId(), now -> {
            Order o = repo.orderById(r.orderId());
            if (!commerce.decideRefund(refundId, "COMPLETED", adminId, bankReference.trim(), note, now)) throw GardenException.conflict("REFUND_DECIDED");
            if (!repo.advanceOrder(o.id(), "FULFILLED", "REFUNDED", now)) throw GardenException.conflict("ORDER_CLOSED");
            boolean revoked = "SKIN".equals(o.itemKind())
                    ? commerce.revokeSkin(o.userId(), o.itemCode(), orderKey(o.id()))
                    : repo.revokeOrderGrant(o.userId(), o.itemCode(), o.id(), now);
            ctx.repo.log(o.userId(), "COSMETIC_REFUND", ctx.write(Map.of("order", o.id(), "code", o.itemCode(), "revoked", revoked,
                    "refund", refundId, "kind", r.kind())), now);
            return null;
        });
        return queue(adminId);
    }

    public AdminCommerceQueue rejectRefund(long adminId, long refundId, String note) {
        adminGuard.accept(adminId);
        if (note == null || note.isBlank()) throw new GardenException(400, "NOTE_REQUIRED");
        Refund r = refundOrThrow(refundId);
        ctx.read(r.userId(), now -> {
            if (!commerce.decideRefund(refundId, "REJECTED", adminId, null, note.trim(), now)) throw GardenException.conflict("REFUND_DECIDED");
            ctx.repo.log(r.userId(), "COSMETIC_REFUND_REJECTED", ctx.write(Map.of("order", r.orderId(), "refund", refundId)), now);
            return null;
        });
        return queue(adminId);
    }

    /** A refund the administrator opens and completes: delivery failure, duplicate charge, unauthorized payment, defect, charge-back. */
    public AdminCommerceQueue openRefund(long adminId, long orderId, String kind, String reason, String bankReference) {
        adminGuard.accept(adminId);
        if (!commerce.present()) throw new GardenException(404, "ORDER_NOT_FOUND");
        Order o = repo.orderById(orderId);
        if (o == null) throw new GardenException(404, "ORDER_NOT_FOUND");
        long refundId = ctx.read(o.userId(), now -> {
            if (!"FULFILLED".equals(repo.orderById(orderId).status())) throw GardenException.conflict("REFUND_NOT_PAID");
            long id = commerce.openRefund(orderId, o.userId(), kind, reason.trim(), o.amountVnd(), now);
            if (id == 0) throw GardenException.conflict("REFUND_EXISTS");
            return id;
        });
        return completeRefund(adminId, refundId, bankReference, kind);
    }

    /**
     * Closes a reconciliation issue. DELIVERED is allowed only for a verified late payment of the exact amount whose
     * item the buyer still does not own: the expired order is fulfilled by that transaction. REFUNDED_MANUALLY records
     * the bank transfer the administrator sent back; nothing is granted.
     */
    public AdminCommerceQueue resolveIssue(long adminId, long issueId, String resolution, String bankReference, String note) {
        adminGuard.accept(adminId);
        if (!commerce.present()) throw new GardenException(404, "ISSUE_NOT_FOUND");
        Issue i = commerce.issue(issueId);
        if (i == null) throw new GardenException(404, "ISSUE_NOT_FOUND");
        ctx.read(i.userId(), now -> {
            Issue issue = commerce.issue(issueId);
            if (!"OPEN".equals(issue.status())) throw GardenException.conflict("ISSUE_RESOLVED");
            Order o = repo.orderById(issue.orderId());
            if ("DELIVERED".equals(resolution)) {
                if (!"LATE_PAYMENT".equals(issue.kind()) || !"EXPIRED".equals(o.status()) || issue.paidAmountVnd() != o.amountVnd()
                        || !deliverable(o) || owned(o)) {
                    throw GardenException.conflict("ISSUE_NOT_DELIVERABLE");
                }
                if (!repo.advanceOrder(o.id(), "EXPIRED", "FULFILLED", now)) throw GardenException.conflict("ORDER_CLOSED");
                deliver(o, issue.providerTransactionId(), now);
            } else if ("REFUNDED_MANUALLY".equals(resolution)) {
                if (bankReference == null || bankReference.isBlank()) throw new GardenException(400, "BANK_REFERENCE_REQUIRED");
            } else {
                throw new GardenException(400, "RESOLUTION_INVALID");
            }
            commerce.resolveIssue(issueId, resolution, adminId, bankReference == null ? null : bankReference.trim(), note, now);
            ctx.repo.log(issue.userId(), "COSMETIC_ISSUE_RESOLVED", ctx.write(Map.of("order", o.id(), "issue", issueId,
                    "resolution", resolution)), now);
            return null;
        });
        return queue(adminId);
    }

    // ------------------------------------------------------------------ helpers

    private Refund refundOrThrow(long refundId) {
        Refund r = commerce.present() ? commerce.refund(refundId) : null;
        if (r == null) throw new GardenException(404, "REFUND_NOT_FOUND");
        return r;
    }

    /** The player's own order, or 404 (another player's order and an unknown one are indistinguishable). */
    private Order mine(long userId, long orderId) {
        Order o = repo.orderById(orderId);
        if (o == null || o.userId() != userId || commerce.payment(orderId) == null) throw new GardenException(404, "ORDER_NOT_FOUND");
        return o;
    }

    private Instant refundDeadline(Payment p) {
        return p.paidAt() == null ? null : p.paidAt().plus(Duration.ofDays(rewards.rules().refundRequestDays()));
    }

    /**
     * Checks that this player may buy the item for VND now and returns its display name: the item is sold for Echo
     * Coins (an earned item never is), its own gate is met (a cultivar needs its crop grown once) and it is not owned.
     */
    private String sellable(long userId, String kind, String code, Instant now, boolean qa) {
        CosmeticRules r = ctx.cosmetics();
        if ("SKIN".equals(kind)) {
            if (r.skinCollections().get(code) == null) throw new GardenException(404, "COSMETIC_NOT_FOUND");
            for (var crop : collection.view(userId, now, qa).crops()) {
                for (var s : crop.skins()) {
                    if (!s.code().equals(code)) continue;
                    if ("OWNED".equals(s.status())) throw GardenException.conflict("COSMETIC_OWNED");
                    if (!"COIN".equals(s.unlockKind())) throw GardenException.conflict("CHECKOUT_UNAVAILABLE");
                    if (!s.masteryOk() || !s.learningOk()) throw GardenException.conflict("COSMETIC_LOCKED");
                    return s.nameVi();
                }
            }
            throw new GardenException(404, "COSMETIC_NOT_FOUND");
        }
        Item item = r.item(code);
        if (item == null) throw new GardenException(404, "COSMETIC_NOT_FOUND");
        if (!item.coin()) throw GardenException.conflict("CHECKOUT_UNAVAILABLE");
        // a decoration's further units are bought with Echo Coins; money buys an item the player does not hold at all
        if (repo.quantity(userId, item.code()) >= 1) throw GardenException.conflict("COSMETIC_OWNED");
        return item.nameVi();
    }

    /** The catalogue still knows the order's item (an order is only ever created for a sellable one). */
    private boolean deliverable(Order o) {
        CosmeticRules r = ctx.cosmetics();
        if (r == null) return false;
        return "SKIN".equals(o.itemKind()) ? r.skinCollections().containsKey(o.itemCode()) : r.item(o.itemCode()) != null;
    }

    private boolean owned(Order o) {
        return "SKIN".equals(o.itemKind()) ? commerce.ownsSkin(o.userId(), o.itemCode()) : repo.quantity(o.userId(), o.itemCode()) >= 1;
    }

    private String productName(Order o) {
        CosmeticRules r = ctx.cosmetics();
        if (r != null && !"SKIN".equals(o.itemKind())) {
            Item item = r.item(o.itemCode());
            if (item != null) return item.nameVi();
        }
        if ("SKIN".equals(o.itemKind())) {
            String name = commerce.skinName(o.itemCode());
            if (name != null) return name;
        }
        return o.itemCode();
    }

    private CosmeticCheckoutView view(Order o, String name, Instant now) {
        Payment p = commerce.payment(o.id());
        CosmeticPaymentGateway.Instructions how = "PENDING".equals(o.status()) && gateway.isPresent()
                ? gateway.get().instructions(p.transferCode(), o.amountVnd()) : null;
        Refund refund = commerce.refundOfOrder(o.id());
        Issue issue = commerce.openIssueOfOrder(o.id());
        Instant deadline = refundDeadline(p);
        boolean refundable = "FULFILLED".equals(o.status()) && refund == null && deadline != null && !now.isAfter(deadline)
                && !commerce.usedSince(o.userId(), o.itemKind(), o.itemCode(), p.paidAt());
        return new CosmeticCheckoutView(o.id(), o.itemKind(), o.itemCode(), name, o.amountVnd(), "VND", o.status(), p.transferCode(),
                how == null ? null : how.bankCode(), how == null ? null : how.accountNumber(), how == null ? null : how.accountName(),
                how == null ? null : how.qrImageUrl(), o.createdAt(), p.expiresAt(), p.paidAt(), issue == null ? null : issue.kind(),
                refund == null ? null : refund.status(), refundable, "FULFILLED".equals(o.status()) ? deadline : null);
    }
}
