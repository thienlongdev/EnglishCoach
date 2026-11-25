package com.englishcoach.garden.application;

import com.englishcoach.garden.api.GardenDtos.BranchView;
import com.englishcoach.garden.api.GardenDtos.CollectionView;
import com.englishcoach.garden.api.GardenDtos.EchoView;
import com.englishcoach.garden.api.GardenDtos.LivingView;
import com.englishcoach.garden.api.GardenDtos.MonumentView;
import com.englishcoach.garden.api.GardenDtos.State;
import com.englishcoach.garden.domain.EchoGuide;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.Comparator;

/**
 * The Phase 3B part of {@code GET /state}: the monument, the collection (codex, mastery, skins) and Echo's single
 * contextual hint. The hint is derived on read from the state that was just computed — the same facts the player sees —
 * so Echo can never point at something that is not there. No table, no timer, no AI call.
 */
@Service
public class LivingService {

    private final GardenContext ctx;
    private final MonumentService monument;
    private final CollectionService collection;

    public LivingService(GardenContext ctx, MonumentService monument, CollectionService collection) {
        this.ctx = ctx;
        this.monument = monument;
        this.collection = collection;
    }

    public LivingView view(long userId, Instant now, boolean qa, State base) {
        MonumentView m = monument.view(userId, now, base.knowledge() == null ? 0 : base.knowledge().forestCount());
        CollectionView c = collection.view(userId, now, qa);
        return new LivingView(m, c, echo(userId, base, m, c));
    }

    private EchoView echo(long userId, State s, MonumentView m, CollectionView c) {
        Integer graduationSlot = s.knowledge() == null ? null : s.knowledge().slots().stream()
                .filter(slot -> slot.tree() != null && slot.tree().graduation().eligible())
                .map(slot -> slot.slot()).findFirst().orElse(null);
        // Phase 3C: Echo points at the most damaged crop first (wilting before leaf damage before a warning)
        var waiting = s.pests() == null ? java.util.List.<com.englishcoach.garden.api.GardenDtos.PestView>of()
                : s.pests().stream().filter(p -> !p.reviewed())
                .sorted(Comparator.comparingInt((com.englishcoach.garden.api.GardenDtos.PestView p) -> -p.stage())).toList();
        int ready = (int) s.plots().stream().filter(p -> p.planting() != null && p.planting().ready()).count();
        var fillable = s.economy() == null ? java.util.List.<com.englishcoach.garden.api.GardenDtos.OrderView>of()
                : s.economy().board().slots().stream().map(slot -> slot.order())
                .filter(o -> o != null && "OPEN".equals(o.status()) && o.fillable()).toList();
        String claim = c.crops().stream().flatMap(crop -> crop.skins().stream())
                .filter(skin -> "AVAILABLE".equals(skin.status()) && !"COIN".equals(skin.unlockKind()))
                .map(skin -> skin.code()).findFirst().orElse(null);
        BranchView branch = m.branches().stream().filter(b -> b.enabled() && b.nextAt() != null)
                .min(Comparator.comparingInt((BranchView b) -> b.nextAt() - b.days())).orElse(null);
        var hint = ctx.living().echo().pick(new EchoGuide.Facts(graduationSlot,
                waiting.isEmpty() ? null : waiting.getFirst().id(), waiting.size(), ready,
                fillable.isEmpty() ? null : fillable.getFirst().id(), fillable.size(), m.unseen().size(), claim,
                ctx.repo.dueCount(userId), m.learnedToday(), branch == null ? null : branch.family(),
                branch == null ? 0 : branch.nextAt() - branch.days(), branch == null ? 0 : branch.tier() + 1,
                waiting.isEmpty() ? 0 : waiting.getFirst().stage()));
        return new EchoView(hint.code(), hint.params());
    }
}
