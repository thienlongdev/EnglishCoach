package com.englishcoach.garden.application;

import com.englishcoach.garden.infra.GardenScope;
import com.englishcoach.garden.api.GardenDtos.CodexCropView;
import com.englishcoach.garden.api.GardenDtos.CollectionView;
import com.englishcoach.garden.api.GardenDtos.FormView;
import com.englishcoach.garden.api.GardenDtos.MasteryView;
import com.englishcoach.garden.api.GardenDtos.NextStepView;
import com.englishcoach.garden.api.GardenDtos.SkinAcquireRequest;
import com.englishcoach.garden.api.GardenDtos.SkinEquipRequest;
import com.englishcoach.garden.api.GardenDtos.SkinEquipResult;
import com.englishcoach.garden.api.GardenDtos.SkinReceipt;
import com.englishcoach.garden.api.GardenDtos.SkinView;
import com.englishcoach.garden.api.GardenException;
import com.englishcoach.garden.domain.GardenRules.CropDef;
import com.englishcoach.garden.domain.GardenRules.QualityTier;
import com.englishcoach.garden.domain.GardenRules.Season;
import com.englishcoach.garden.domain.LivingRules.SkinDef;
import com.englishcoach.garden.domain.MasteryEngine.Facts;
import com.englishcoach.garden.infra.CollectionRepository;
import com.englishcoach.garden.infra.CollectionRepository.Form;
import com.englishcoach.garden.infra.CollectionRepository.MasteryRow;
import com.englishcoach.garden.infra.MonumentRepository;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Crop mastery, the codex and crop skins (Phase 3B, blueprint §7.2).
 *
 * <ul>
 *   <li><b>Mastery</b> counts only harvests the server closed: {@link #onHarvest} runs inside the harvest transaction
 *   right after a planting was closed exactly once ({@code markHarvested}), so a replayed or concurrent request can
 *   never count twice. A garden older than V82 is seeded once from its own harvest history. QA crops never count.</li>
 *   <li><b>Skins</b> are art only. The server owns eligibility, price, ownership and the equipped skin: an acquisition
 *   checks the catalogue entry and its requirements, takes the coins once (guarded balance + ledger), grants the skin
 *   once and keeps an idempotency receipt. A planting snapshots the skin equipped at planting time; changing the equipped
 *   skin never touches a growing or harvested planting.</li>
 * </ul>
 * Nothing here changes growth, quality, price, XP, mutation chance or any learning record.
 */
@Service
public class CollectionService {

    private final GardenContext ctx;
    private final GardenAccessService access;
    private final GardenSetup setup;
    private final LedgerService ledger;
    private final CollectionRepository repo;
    private final MonumentRepository monument;

    public CollectionService(GardenContext ctx, GardenAccessService access, GardenSetup setup, LedgerService ledger,
                             CollectionRepository repo, MonumentRepository monument) {
        this.ctx = ctx;
        this.access = access;
        this.setup = setup;
        this.ledger = ledger;
        this.repo = repo;
        this.monument = monument;
    }

    // ------------------------------------------------------------------ mastery

    private int tierRank(String tierCode) {
        var tiers = ctx.engine().rules().quality().tiers();
        for (int i = 0; i < tiers.size(); i++) if (tiers.get(i).code().equals(tierCode)) return i;
        return 0;
    }

    private int seasonBit(Instant at) {
        var e = ctx.engine();
        int i = e.rules().seasons().order().indexOf(e.calendar().theme(at));
        return i < 0 ? 0 : 1 << i;
    }

    /**
     * Seeds mastery from the garden's own closed harvests when it has never been seeded (a garden created before V82);
     * true when the seed ran now. Seeded milestones are stored as already seen: history is recorded, not celebrated.
     */
    public boolean ensureSeeded(long userId, Instant now) {
        monument.ensure(userId, now);
        if (monument.row(userId).masterySeededAt() != null) return false;
        var e = ctx.engine();
        record Agg(int harvests, int best, int seasons, Instant first, Instant last) {}
        Map<String, Agg> agg = new LinkedHashMap<>();
        for (var h : repo.harvestHistory(userId)) {
            CropDef crop = e.rules().crops().get(h.cropCode());
            if (crop == null || crop.qaOnly() || h.harvestedAt() == null) continue;
            int rank = tierRank(h.tier());
            int bit = seasonBit(h.harvestedAt());
            agg.merge(crop.code(), new Agg(1, rank, bit, h.harvestedAt(), h.harvestedAt()), (a, b) ->
                    new Agg(a.harvests() + 1, Math.max(a.best(), b.best()), a.seasons() | b.seasons(), a.first(), b.last()));
        }
        agg.forEach((code, a) -> repo.seed(userId, code, a.harvests(), a.best(), a.seasons(), a.first(), a.last()));
        monument.markMasterySeeded(userId, now);
        agg.keySet().forEach(code -> refreshTier(userId, e.rules().crop(code), now, true));
        return true;
    }

    /** One closed harvest (called once per planting, inside the harvest transaction, after its codex forms). */
    public void onHarvest(long userId, CropDef crop, QualityTier tier, Instant now) {
        if (crop.qaOnly()) return;
        // a seed that runs now already includes this harvest (the planting is closed in this transaction)
        if (!ensureSeeded(userId, now)) repo.addHarvest(userId, crop.code(), tierRank(tier.code()), seasonBit(now), now);
        refreshTier(userId, crop, now, false);
    }

    private void refreshTier(long userId, CropDef crop, Instant now, boolean seeded) {
        MasteryRow row = repo.masteryOf(userId, crop.code());
        if (row == null) return;
        int tier = ctx.living().mastery().tier(crop.rarity(), facts(row, repo.codexForms(userId, crop.code())));
        if (tier <= row.tier()) return;
        repo.raiseTier(userId, crop.code(), tier);
        for (int t = row.tier() + 1; t <= tier; t++) {
            if (monument.recordMilestone(userId, "MASTERY", crop.code(), t, now, seeded) && !seeded) {
                ctx.repo.log(userId, "CROP_MASTERY", ctx.write(Map.of("crop", crop.code(), "tier", t)), now);
            }
        }
    }

    private static Facts facts(MasteryRow row, int forms) {
        return row == null ? new Facts(0, 0, 0, forms) : new Facts(row.harvests(), row.bestTier(), Integer.bitCount(row.seasons()), forms);
    }

    // ------------------------------------------------------------------ view (codex)

    /** Quality tiers this crop can reach at all (a Common crop has no season bonus, so its top tier may be out of reach). */
    private List<String> possibleForms(CropDef crop) {
        var e = ctx.engine();
        var q = e.rules().quality();
        int max = e.rules().challenge().questions() * q.recallPerCorrect() + q.pestClean()
                + (crop.season() == Season.ALL ? q.seasonCommon() : q.seasonIn()) + q.cared() + q.fresh();
        List<String> forms = new ArrayList<>();
        q.tiers().stream().filter(t -> t.minScore() <= max).forEach(t -> forms.add(t.code()));
        forms.addAll(List.of("MOONLIT", "RAINBOW", "MUTATED"));
        return forms;
    }

    public CollectionView view(long userId, Instant now, boolean qa) {
        var e = ctx.engine();
        var living = ctx.living();
        GardenScope.prefetch(() -> ctx.repo.profile(userId), () -> monument.row(userId), () -> repo.mastery(userId),
                () -> repo.codex(userId), () -> repo.owned(userId), () -> repo.equipped(userId));
        var profile = ctx.repo.profile(userId);
        int level = e.levels().level(profile.totalXp());
        var monumentRow = monument.row(userId);
        int learningDays = monumentRow == null ? 0 : monumentRow.learningDays();
        Map<String, MasteryRow> mastery = repo.mastery(userId);
        Map<String, List<Form>> codex = repo.codex(userId);
        var owned = repo.owned(userId);
        Map<String, String> equipped = repo.equipped(userId);
        var tiers = e.rules().quality().tiers();
        var order = e.rules().seasons().order();

        List<CodexCropView> crops = new ArrayList<>();
        int formsFound = 0, formsTotal = 0, skinsOwned = 0, skinsTotal = 0, masterySum = 0;
        for (CropDef crop : e.rules().crops().values().stream().filter(c -> !c.qaOnly())
                .sorted(Comparator.comparingInt(CropDef::sortOrder)).toList()) {
            MasteryRow row = mastery.get(crop.code());
            List<Form> forms = codex.getOrDefault(crop.code(), List.of());
            List<String> possible = possibleForms(crop);
            Facts facts = facts(row, forms.size());
            int tier = row == null ? 0 : row.tier();
            List<String> seasons = new ArrayList<>();
            if (row != null) {
                for (int i = 0; i < order.size(); i++) if ((row.seasons() & (1 << i)) != 0) seasons.add(order.get(i).name());
            }
            NextStepView next = living.mastery().next(crop.rarity(), tier, facts)
                    .map(n -> new NextStepView(n.tier(), MonumentService.requirements(n.requirements()))).orElse(null);
            var masteryView = new MasteryView(tier, living.rules().mastery().maxTier(), facts.harvests(),
                    row == null ? null : tiers.get(Math.min(row.bestTier(), tiers.size() - 1)).code(), seasons, order.size(), next,
                    row == null ? null : row.firstAt(), row == null ? null : row.lastAt());
            List<SkinView> skins = new ArrayList<>();
            for (SkinDef s : living.rules().skins().values().stream().filter(s -> s.cropCode().equals(crop.code()))
                    .sorted(Comparator.comparingInt(SkinDef::sortOrder)).toList()) {
                var have = owned.get(s.code());
                var check = living.check(s, tier, learningDays, profile.coins());
                // Phase 3C: a REWARD cultivar is only ever delivered by an Echo Reward redemption (never collected here)
                String status = have != null ? "OWNED"
                        : !"REWARD".equals(s.unlockKind()) && check.masteryOk() && check.learningOk() ? "AVAILABLE" : "LOCKED";
                skins.add(new SkinView(s.code(), s.cropCode(), s.nameVi(), s.descriptionVi(), s.artKey(), s.unlockKind(),
                        s.coinPrice(), s.masteryTier(), s.learningDays(), status, check.masteryOk(), check.learningOk(),
                        check.coinsOk(), s.code().equals(equipped.get(crop.code())), have == null ? null : have.acquiredAt()));
                skinsTotal++;
                if (have != null) skinsOwned++;
            }
            formsFound += (int) forms.stream().filter(f -> possible.contains(f.form())).count();
            formsTotal += possible.size();
            masterySum += tier;
            crops.add(new CodexCropView(crop.code(), crop.nameVi(), crop.rarity().name(), crop.season().name(),
                    crop.unlockLevel(), crop.unlockLevel() <= level, row != null && row.harvests() > 0,
                    forms.stream().map(f -> new FormView(f.form(), f.firstAt())).toList(), possible, masteryView, skins,
                    equipped.get(crop.code())));
        }
        return new CollectionView(crops, formsFound, formsTotal, skinsOwned, skinsTotal, masterySum,
                crops.size() * living.rules().mastery().maxTier());
    }

    // ------------------------------------------------------------------ skins

    /** The skin a new planting of this crop takes: the equipped one, when it is (still) owned and of this crop. */
    public String skinForPlanting(long userId, String cropCode) {
        String code = repo.equippedFor(userId, cropCode);
        if (code == null) return null;
        SkinDef def = ctx.living().rules().skin(code);
        return def != null && def.cropCode().equals(cropCode) && repo.owns(userId, code) ? code : null;
    }

    /** "Nhận" (earned skin) or "Mua" (coin skin): the catalogue decides which; the client only names the skin. */
    public SkinReceipt acquire(long userId, UUID key, SkinAcquireRequest request) {
        access.require(userId);
        boolean qa = access.qa(userId);
        return ctx.command(userId, key, "SKIN_ACQUIRE", Map.of("skinCode", request.skinCode()), SkinReceipt.class,
                setup.ensurer(userId), (now, op) -> {
                    var living = ctx.living();
                    SkinDef skin = living.rules().skin(request.skinCode());
                    if (skin == null) throw new GardenException(404, "SKIN_NOT_FOUND");
                    if (repo.owns(userId, skin.code())) throw GardenException.conflict("SKIN_OWNED");
                    // Phase 3C: a reward cultivar has no price and no mastery gate, so it must never be collectable here
                    if ("REWARD".equals(skin.unlockKind())) throw GardenException.conflict("SKIN_LOCKED", Map.of("reason", "REWARD"));
                    ensureSeeded(userId, now);
                    MasteryRow row = repo.masteryOf(userId, skin.cropCode());
                    var m = monument.row(userId);
                    long coins = ctx.repo.profile(userId).coins();
                    var check = living.check(skin, row == null ? 0 : row.tier(), m == null ? 0 : m.learningDays(), coins);
                    if (!check.masteryOk()) {
                        throw GardenException.conflict("SKIN_LOCKED", Map.of("reason", "MASTERY", "tier", skin.masteryTier()));
                    }
                    if (!check.learningOk()) {
                        throw GardenException.conflict("SKIN_LOCKED", Map.of("reason", "LEARNING", "days", skin.learningDays()));
                    }
                    if (check.price() > 0 && !ledger.takeCoins(userId, check.price(), "SKIN_BUY", "SKIN", skin.code(), op, now)) {
                        throw GardenException.conflict("INSUFFICIENT_FUNDS", Map.of("missing", check.price() - coins));
                    }
                    if (!repo.grant(userId, skin.code(), skin.unlockKind(), check.price(), op, now)) {
                        throw GardenException.conflict("SKIN_OWNED");
                    }
                    monument.recordMilestone(userId, "SKIN", skin.code(), 1, now, true);
                    ctx.repo.log(userId, "SKIN_ACQUIRE", ctx.write(Map.of("skin", skin.code(), "kind", skin.unlockKind(),
                            "coins", check.price())), now);
                    return new SkinReceipt(skin.code(), skin.cropCode(), skin.unlockKind(), check.price(),
                            ctx.repo.profile(userId).coins(), view(userId, now, qa));
                });
    }

    /** Chooses the skin future plantings of a crop take ({@code skinCode} null = the base crop). */
    public SkinEquipResult equip(long userId, UUID key, SkinEquipRequest request) {
        access.require(userId);
        boolean qa = access.qa(userId);
        Map<String, Object> fingerprint = new LinkedHashMap<>();
        fingerprint.put("cropCode", request.cropCode());
        fingerprint.put("skinCode", request.skinCode());
        return ctx.command(userId, key, "SKIN_EQUIP", fingerprint, SkinEquipResult.class, setup.ensurer(userId), (now, op) -> {
            CropDef crop = ctx.engine().rules().crops().get(request.cropCode());
            if (crop == null || (crop.qaOnly() && !qa)) throw new GardenException(404, "CROP_NOT_FOUND");
            if (request.skinCode() == null) {
                repo.unequip(userId, crop.code());
            } else {
                SkinDef skin = ctx.living().rules().skin(request.skinCode());
                // an unknown skin and a skin the player does not own are indistinguishable: 404
                if (skin == null || !repo.owns(userId, skin.code())) throw new GardenException(404, "SKIN_NOT_FOUND");
                if (!skin.cropCode().equals(crop.code())) throw GardenException.conflict("SKIN_CROP_MISMATCH");
                repo.equip(userId, crop.code(), skin.code(), now);
            }
            ctx.repo.log(userId, "SKIN_EQUIP", ctx.write(Map.of("crop", crop.code(), "skin", request.skinCode() == null ? "" : request.skinCode())), now);
            return new SkinEquipResult(crop.code(), request.skinCode(), view(userId, now, qa));
        });
    }
}
