package com.englishcoach.garden.application;

import com.englishcoach.garden.domain.AnimalEngine;
import com.englishcoach.garden.domain.AnimalRules;
import com.englishcoach.garden.domain.SocialEngine.Guard;
import com.englishcoach.garden.infra.AnimalRepository;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.time.Instant;

/**
 * Phase 3H: what a garden's guardian pets change in the existing rules, read at the authoritative boundary of each rule.
 * <ul>
 *   <li><b>Dog</b> — {@link #guard} reports the island as guarded while its watch lasts; {@link #turnAway} is called by
 *   the take transaction for a take that would otherwise succeed and consumes the dog's watch (one visitor per
 *   cooldown, conditional update under both gardens' locks).</li>
 *   <li><b>Goose</b> — {@link #guard} lengthens the owner's head start on a freshly ripe crop.</li>
 *   <li><b>Cat</b> — {@link #pestRelief} keeps crop-pest places free when new Forgotten Pests are planned.</li>
 * </ul>
 * A guardian works only while it is fed. On a database without the animals rules everything here is neutral.
 */
@Component
public class GuardianWatch {

    private final GardenContext ctx;
    private final AnimalRepository repo;

    public GuardianWatch(GardenContext ctx, AnimalRepository repo) {
        this.ctx = ctx;
        this.repo = repo;
    }

    /** The guardian part of a take decision on {@code hostId}'s island right now. */
    public Guard guard(long hostId, Instant now) {
        AnimalEngine e = ctx.animals();
        if (e == null) return Guard.NONE;
        var dog = repo.guardian(hostId, AnimalRules.DOG);
        var goose = repo.guardian(hostId, AnimalRules.GOOSE);
        return new Guard(goose == null ? 0 : e.gooseGraceMinutes(goose.fedUntil(), now),
                dog == null ? null : e.dogShieldUntil(dog.guardAt(), now));
    }

    /**
     * The dog turns one visitor away, if it is fed and its cooldown has passed. Must run inside the take transaction
     * (both gardens locked).
     *
     * @return until when the island is guarded now, or null when no dog stepped in
     */
    public Instant turnAway(long hostId, Instant now) {
        AnimalEngine e = ctx.animals();
        if (e == null) return null;
        var dog = repo.guardian(hostId, AnimalRules.DOG);
        if (dog == null || !e.dogReady(dog.fedUntil(), dog.guardAt(), now)) return null;
        int cooldown = e.rules().guardians().get(AnimalRules.DOG).cooldownHours();
        if (!repo.markGuard(hostId, dog.id(), now, now.minus(Duration.ofHours(cooldown)))) return null;
        return e.dogShieldUntil(now, now);
    }

    /** Crop-pest places the cat keeps free now (0 without a fed cat). */
    public int pestRelief(long userId, Instant now, int maxCropPests) {
        AnimalEngine e = ctx.animals();
        if (e == null) return 0;
        var cat = repo.guardian(userId, AnimalRules.CAT);
        return cat == null ? 0 : e.catPestRelief(cat.fedUntil(), now, maxCropPests);
    }
}
