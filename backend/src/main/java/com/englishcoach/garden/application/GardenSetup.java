package com.englishcoach.garden.application;

import com.englishcoach.garden.infra.GardenRepository.Profile;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.Map;

/**
 * First-visit initialisation (GDD 03 §11.2, R3): the profile, the six starter plots and the starter pack through the
 * ledger. Runs under the caller's advisory lock; the profile insert is {@code ON CONFLICT DO NOTHING}, so only the
 * request that actually creates the garden grants the pack, and the partial unique index
 * {@code ux_garden_ledger_starter} rejects any second STARTER grant even if code paths change.
 */
@Service
public class GardenSetup {

    private final GardenContext ctx;
    private final LedgerService ledger;

    public GardenSetup(GardenContext ctx, LedgerService ledger) {
        this.ctx = ctx;
        this.ledger = ledger;
    }

    public Profile ensure(long userId, Instant now) {
        var repo = ctx.repo;
        // an existing garden needs no insert (the caller holds the garden lock): one write less on every request
        if (repo.profile(userId) == null && repo.createProfile(userId, now)) {
            var rules = ctx.engine().rules();
            var cells = rules.starter().plots();
            for (int i = 0; i < cells.size(); i++) repo.createPlot(userId, i + 1, cells.get(i).x(), cells.get(i).y(), now);
            String ref = "starter:" + userId;
            ledger.addCoins(userId, rules.starter().coins(), "STARTER", "STARTER", ref, null, now);
            for (Map.Entry<String, Integer> item : rules.starter().items().entrySet()) {
                ledger.addItem(userId, item.getKey(), "NA", item.getValue(), "STARTER", "STARTER", ref, null, now);
            }
            repo.log(userId, "GARDEN_CREATED", ctx.write(Map.of("coins", rules.starter().coins(), "items", rules.starter().items())), now);
        }
        return repo.profile(userId);
    }

    /** The {@link GardenContext#command} hook: commands may arrive before the first {@code GET /state}. */
    public java.util.function.Function<Instant, Void> ensurer(long userId) {
        return now -> {
            ensure(userId, now);
            return null;
        };
    }
}
