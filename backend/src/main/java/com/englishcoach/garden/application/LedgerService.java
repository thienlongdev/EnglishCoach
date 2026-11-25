package com.englishcoach.garden.application;

import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

/**
 * The only way Garden balances change (GDD 00 rule 2): each coin / XP / inventory movement is applied with a
 * conditional statement AND recorded in the append-only {@code garden_ledger} in the same transaction, so for every
 * user and asset {@code sum(delta) = current balance} (checked by GardenPersistenceTest).
 */
@Service
public class LedgerService {

    public record LevelStep(long totalXpBefore, long totalXpAfter, int levelBefore, int levelAfter) {}

    private final GardenContext ctx;

    public LedgerService(GardenContext ctx) {
        this.ctx = ctx;
    }

    public void addItem(long userId, String item, String tier, int qty, String reason, String refType, String refId,
                        UUID opKey, Instant now) {
        if (qty <= 0) return;
        ctx.repo.changeItem(userId, item, tier, qty);
        ctx.repo.ledger(userId, item, tier, qty, reason, refType, refId, opKey, now);
    }

    /** @return false when the user does not hold {@code qty} items (nothing changes). */
    public boolean takeItem(long userId, String item, String tier, int qty, String reason, String refType, String refId,
                            UUID opKey, Instant now) {
        if (!ctx.repo.changeItem(userId, item, tier, -qty)) return false;
        ctx.repo.ledger(userId, item, tier, -qty, reason, refType, refId, opKey, now);
        return true;
    }

    public void addCoins(long userId, long amount, String reason, String refType, String refId, UUID opKey, Instant now) {
        if (amount <= 0) return;
        ctx.repo.changeCoins(userId, amount);
        ctx.repo.ledger(userId, "COIN", "NA", amount, reason, refType, refId, opKey, now);
    }

    /** @return false when the balance is too low (the CHECK-protected conditional UPDATE changed nothing). */
    public boolean takeCoins(long userId, long amount, String reason, String refType, String refId, UUID opKey, Instant now) {
        if (amount <= 0) return true;
        if (!ctx.repo.changeCoins(userId, -amount)) return false;
        ctx.repo.ledger(userId, "COIN", "NA", -amount, reason, refType, refId, opKey, now);
        return true;
    }

    /** Memory Essence (Phase 2): {@code garden_profile.essence} + ledger asset {@code ESSENCE}. */
    public void addEssence(long userId, long amount, String reason, String refType, String refId, UUID opKey, Instant now) {
        if (amount <= 0) return;
        ctx.repo.changeEssence(userId, amount);
        ctx.repo.ledger(userId, "ESSENCE", "NA", amount, reason, refType, refId, opKey, now);
    }

    /** @return false when the essence balance is too low (nothing changes). */
    public boolean takeEssence(long userId, long amount, String reason, String refType, String refId, UUID opKey, Instant now) {
        if (amount <= 0) return true;
        if (!ctx.repo.changeEssence(userId, -amount)) return false;
        ctx.repo.ledger(userId, "ESSENCE", "NA", -amount, reason, refType, refId, opKey, now);
        return true;
    }

    /** Adds XP and reports the level change (LEVEL_UP is logged once per level reached). */
    public LevelStep addXp(long userId, long amount, String reason, String refType, String refId, UUID opKey, Instant now) {
        var levels = ctx.engine().levels();
        if (amount <= 0) {
            long total = ctx.repo.profile(userId).totalXp();
            int l = levels.level(total);
            return new LevelStep(total, total, l, l);
        }
        long after = ctx.repo.addXp(userId, amount);
        long before = after - amount;
        ctx.repo.ledger(userId, "XP", "NA", amount, reason, refType, refId, opKey, now);
        int lb = levels.level(before);
        int la = levels.level(after);
        for (int l = lb + 1; l <= la; l++) ctx.repo.log(userId, "LEVEL_UP", ctx.write(Map.of("level", l)), now);
        return new LevelStep(before, after, lb, la);
    }
}
