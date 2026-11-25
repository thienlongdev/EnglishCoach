package com.englishcoach.garden.application;

import com.englishcoach.auth.policy.AdminIdentityService;
import com.englishcoach.garden.api.GardenDtos.AdminQaAnimalsReceipt;
import com.englishcoach.garden.api.GardenDtos.AdminQaCosmeticsReceipt;
import com.englishcoach.garden.api.GardenDtos.AdminQaStatus;
import com.englishcoach.garden.api.GardenException;
import com.englishcoach.garden.domain.AnimalEngine;
import com.englishcoach.garden.domain.AnimalEngine.Progress;
import com.englishcoach.garden.domain.AnimalRules;
import com.englishcoach.garden.domain.AnimalRules.Livestock;
import com.englishcoach.garden.infra.AdminQaRepository;
import com.englishcoach.garden.infra.AnimalRepository;
import com.englishcoach.garden.infra.AnimalRepository.Animal;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.LongPredicate;

/**
 * QA access of the ONE official administrator to the whole garden catalogue (Phase 4). An administrative exception, not
 * a game rule:
 * <ul>
 *   <li><b>Who.</b> Only the account {@link AdminIdentityService} confirms on every call (database role + the official
 *   e-mail policy). Nothing the client sends — a header, a JSON field, a user id — is read for that decision, and the
 *   commands take no target: they act on the caller's OWN garden only. Everyone else gets 403.</li>
 *   <li><b>Cosmetics.</b> "On" gives the administrator a QA ownership row for every item unit and every cultivar the
 *   garden does not hold yet ({@code source = ADMIN_QA}, no coins, no order, no achievement): the ordinary shop then
 *   equips, places and stores them like any owned item, and the selection survives a reload. "Off" takes exactly those
 *   QA rows back; whatever the account bought or earned stays. Prices, VND SKUs and unlock rules are not touched.</li>
 *   <li><b>Animals.</b> Provisioning builds the missing houses, fills their free places with young animals and adopts
 *   the missing guardians through the real tables ({@code source = ADMIN_QA}), inside the schema's own capacity and
 *   one-guardian-per-species rules, and tops care supplies up through the ledger (reason {@code ADMIN_QA}). No coin
 *   moves. Animals are never deleted (the schema forbids it), so provisioning is permanent for that garden.</li>
 *   <li><b>Time.</b> {@code advance} gives the administrator's own animals {@code hours} of cared-for time through the
 *   real engine (growth first, then production, with the engine's caps). The server clock, other gardens and every
 *   learning record are untouched.</li>
 * </ul>
 * Every command is an idempotent garden command (owner lock + receipt) and is written to the garden's event log.
 */
@Service
public class GardenAdminQaService {

    static final int FEED_STOCK = 60;
    static final int WATER_STOCK = 12;
    static final int MAX_ADVANCE_HOURS = 72;

    private final GardenContext ctx;
    private final GardenAccessService access;
    private final GardenSetup setup;
    private final LedgerService ledger;
    private final LearningIngestService ingest;
    private final AdminQaRepository qa;
    private final AnimalRepository animals;
    private final CosmeticService shop;
    private final AnimalService farm;
    private final LongPredicate officialAdmin;

    @Autowired
    public GardenAdminQaService(GardenContext ctx, GardenAccessService access, GardenSetup setup, LedgerService ledger,
                                LearningIngestService ingest, AdminQaRepository qa, AnimalRepository animals, CosmeticService shop,
                                AnimalService farm, AdminIdentityService admins) {
        this(ctx, access, setup, ledger, ingest, qa, animals, shop, farm, admins::isOfficialAdmin);
    }

    /** {@code officialAdmin}: true only for the official administrator's id. */
    public GardenAdminQaService(GardenContext ctx, GardenAccessService access, GardenSetup setup, LedgerService ledger,
                                LearningIngestService ingest, AdminQaRepository qa, AnimalRepository animals, CosmeticService shop,
                                AnimalService farm, LongPredicate officialAdmin) {
        this.ctx = ctx;
        this.access = access;
        this.setup = setup;
        this.ledger = ledger;
        this.ingest = ingest;
        this.qa = qa;
        this.animals = animals;
        this.shop = shop;
        this.farm = farm;
        this.officialAdmin = officialAdmin;
    }

    /** Whether this account may use the QA commands at all (server decision; false for everyone but the administrator). */
    public boolean available(long userId) {
        return access.allowed(userId) && officialAdmin.test(userId) && qa.ready();
    }

    /** 403 for everyone but the official administrator — checked on EVERY call, before anything is read or locked. */
    private void require(long userId) {
        if (!officialAdmin.test(userId)) throw new GardenException(403, "ADMIN_QA_FORBIDDEN");
        access.require(userId);
        if (!qa.ready()) throw GardenException.conflict("ADMIN_QA_CLOSED");
    }

    public AdminQaStatus status(long userId) {
        require(userId);
        return ctx.read(userId, now -> {
            setup.ensure(userId, now);
            return statusView(userId);
        });
    }

    private AdminQaStatus statusView(long userId) {
        return new AdminQaStatus(true, qa.qaUnits(userId), qa.qaSkins(userId).size(), MAX_ADVANCE_HOURS);
    }

    // ------------------------------------------------------------------ cosmetics

    /** QA on: every catalogue item unit and every cultivar the garden does not hold yet, as QA ownership. */
    public AdminQaCosmeticsReceipt unlockCosmetics(long userId, UUID key) {
        require(userId);
        boolean gardenQa = access.qa(userId);
        return ctx.command(userId, key, "ADMIN_QA_UNLOCK", Map.of(), AdminQaCosmeticsReceipt.class, setup.ensurer(userId), (now, op) -> {
            if (ctx.cosmetics() == null) throw GardenException.conflict("COSMETICS_CLOSED");
            int units = qa.grantUnits(userId, op, now);
            int cultivars = qa.grantSkins(userId, op, now);
            ctx.repo.log(userId, "ADMIN_QA_UNLOCK", ctx.write(Map.of("units", units, "skins", cultivars)), now);
            return new AdminQaCosmeticsReceipt("UNLOCK", units, cultivars, statusView(userId), shop.shopView(userId, now, gardenQa));
        });
    }

    /** QA off: exactly the QA ownership goes; what the account bought or earned stays as it is. */
    public AdminQaCosmeticsReceipt revokeCosmetics(long userId, UUID key) {
        require(userId);
        boolean gardenQa = access.qa(userId);
        return ctx.command(userId, key, "ADMIN_QA_REVOKE", Map.of(), AdminQaCosmeticsReceipt.class, setup.ensurer(userId), (now, op) -> {
            if (ctx.cosmetics() == null) throw GardenException.conflict("COSMETICS_CLOSED");
            int units = qa.revokeUnits(userId, now);
            int cultivars = qa.revokeSkins(userId);
            ctx.repo.log(userId, "ADMIN_QA_REVOKE", ctx.write(Map.of("units", units, "skins", cultivars)), now);
            return new AdminQaCosmeticsReceipt("REVOKE", units, cultivars, statusView(userId), shop.shopView(userId, now, gardenQa));
        });
    }

    // ------------------------------------------------------------------ animals

    private static UUID unitKey(UUID op, String what) {
        return UUID.nameUUIDFromBytes((op + ":" + what).getBytes(StandardCharsets.UTF_8));
    }

    /** Every house, every free place and every guardian the garden lacks, plus care supplies. No coin moves. */
    public AdminQaAnimalsReceipt provisionAnimals(long userId, UUID key) {
        require(userId);
        return ctx.command(userId, key, "ADMIN_QA_ANIMALS", Map.of(), AdminQaAnimalsReceipt.class, setup.ensurer(userId), (now, op) -> {
            AnimalEngine e = ctx.animals();
            if (e == null) throw GardenException.conflict("ANIMALS_CLOSED");
            AnimalRules r = e.rules();
            int houses = 0, livestock = 0, guardians = 0;
            List<Animal> existing = animals.animals(userId);
            for (AnimalRules.House h : r.houses().values()) {
                if (qa.buildHouse(userId, h.code(), now)) houses++;
                for (int place = 1; place <= h.capacity(); place++) {
                    int at = place;
                    if (existing.stream().anyMatch(a -> h.code().equals(a.houseCode()) && a.place() != null && a.place() == at)) continue;
                    if (qa.insertLivestock(userId, h.species(), h.code(), place, now, unitKey(op, h.code() + ":" + place))) livestock++;
                }
            }
            for (AnimalRules.Guardian g : r.guardians().values()) {
                if (existing.stream().anyMatch(a -> a.guardian() && a.species().equals(g.species()))) continue;
                if (qa.insertGuardian(userId, g.species(), now, unitKey(op, g.species()))) guardians++;
            }
            Map<String, Integer> supplies = new LinkedHashMap<>();
            topUp(userId, r.feed().item(), FEED_STOCK, op, now, supplies);
            topUp(userId, r.water().item(), WATER_STOCK, op, now, supplies);
            ctx.repo.log(userId, "ADMIN_QA_ANIMALS", ctx.write(Map.of("houses", houses, "livestock", livestock, "guardians", guardians,
                    "supplies", supplies)), now);
            return new AdminQaAnimalsReceipt("PROVISION", houses, livestock, guardians, supplies, 0,
                    farm.view(userId, now, ingest.blessing(userId, now)));
        });
    }

    private void topUp(long userId, String item, int target, UUID op, Instant now, Map<String, Integer> out) {
        int missing = target - ctx.repo.itemQty(userId, item, "NA");
        if (missing <= 0) return;
        ledger.addItem(userId, item, "NA", missing, AdminQaRepository.SOURCE, "ADMIN_QA", "supplies", op, now);
        out.put(item, missing);
    }

    /**
     * Gives the administrator's own livestock {@code hours} of cared-for time, exactly as the engine counts real care
     * (growth to adulthood first, then production up to the animal's small store), and moves a guardian dog's last watch
     * back by the same span. Stored instants of food and water are not changed.
     */
    public AdminQaAnimalsReceipt advanceAnimals(long userId, UUID key, int hours) {
        require(userId);
        if (hours < 1 || hours > MAX_ADVANCE_HOURS) throw new GardenException(400, "ADMIN_QA_HOURS", Map.of("max", MAX_ADVANCE_HOURS));
        return ctx.command(userId, key, "ADMIN_QA_ADVANCE", Map.of("hours", hours), AdminQaAnimalsReceipt.class, setup.ensurer(userId), (now, op) -> {
            AnimalEngine e = ctx.animals();
            if (e == null) throw GardenException.conflict("ANIMALS_CLOSED");
            Map<String, AnimalRepository.House> houses = new HashMap<>();
            animals.houses(userId).forEach(h -> houses.put(h.code(), h));
            Duration span = Duration.ofHours(hours);
            int moved = 0;
            for (Animal a : animals.animals(userId)) {
                Livestock def = a.guardian() ? null : e.rules().livestock().get(a.species());
                var house = a.houseCode() == null ? null : houses.get(a.houseCode());
                if (def == null || house == null) continue;
                // real time first (what any command does), then the QA span as fully cared-for time
                Progress real = e.advance(def, new Progress(a.progressAt(), a.growthSeconds(), a.productSeconds()), a.fedUntil(),
                        house.wateredUntil(), now);
                Progress fast = e.advance(def, new Progress(now.minus(span), real.growthSeconds(), real.productSeconds()), now, now, now);
                animals.saveProgress(userId, a.id(), real.progressAt(), fast.growthSeconds(), fast.productSeconds());
                moved++;
            }
            qa.shiftGuard(userId, span.getSeconds());
            ctx.repo.log(userId, "ADMIN_QA_ADVANCE", ctx.write(Map.of("hours", hours, "animals", moved)), now);
            return new AdminQaAnimalsReceipt("ADVANCE", 0, moved, 0, Map.of(), hours, farm.view(userId, now, ingest.blessing(userId, now)));
        });
    }
}
