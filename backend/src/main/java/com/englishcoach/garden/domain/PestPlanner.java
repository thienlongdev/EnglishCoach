package com.englishcoach.garden.domain;

import com.englishcoach.garden.domain.GardenRules.PestRules;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Forgotten Pests (Phase 2), pure rules. A pest is the visible form of ONE real flashcard whose scheduler due date is
 * overdue by more than the grace period (the caller's SQL uses the Flashcard module's own due predicate; MASTERED
 * cards never come due, so they never host a pest). Pests appear only when the player is present ({@code now} of a
 * state read) and never retroactively; at most one per card, one per crop, {@code maxCropPests} on crops in total.
 *
 * <ul>
 *   <li>A card bound to an active Knowledge Tree becomes a pest ON that tree (it marks the word needing care).</li>
 *   <li>Other overdue cards may settle on crops (growing or already ripe) that are not tutorial crops and are older
 *   than the protection period, oldest planting first. On a ripe crop the pest only matters for quality: the player
 *   chooses between harvesting now or reviewing the word first.</li>
 *   <li>What a crop pest costs (the staged slowdown and the harvest's pest score) is decided by
 *   {@code EstateEngine} since Phase 3C; the flat Phase 2 slowdown, the clean-harvest check and the Java copy of the
 *   overdue predicate that used to live here had no caller left and were removed in Phase 4.</li>
 * </ul>
 */
public final class PestPlanner {

    public enum Host { CROP, TREE }

    /** A stored pest (active or historical) of one planting / tree. */
    public record PestFacts(long id, long flashcardId, Host host, Long plantingId, Long treeId, Instant spawnedAt,
                            Instant reviewedAt, Instant clearedAt) {}

    /** A growing crop that could host a pest. */
    public record CropHost(long plantingId, Instant plantedAt, boolean tutorial, boolean ready) {}

    /** An overdue card (already ordered by the caller: most overdue first). */
    public record OverdueCard(long flashcardId, String word, Long treeId) {}

    public record Spawn(long flashcardId, String word, Host host, Long plantingId, Long treeId) {}

    private final PestRules rules;

    public PestPlanner(GardenRules rules) {
        this.rules = rules.pests();
    }

    public List<Spawn> plan(List<OverdueCard> overdue, Set<Long> cardsWithActivePest, List<CropHost> crops,
                            Set<Long> plantingsWithActivePest, int activeCropPests, Instant now) {
        List<Spawn> out = new ArrayList<>();
        Set<Long> usedCards = new HashSet<>(cardsWithActivePest);
        Set<Long> usedPlantings = new HashSet<>(plantingsWithActivePest);
        int cropPests = activeCropPests;
        List<CropHost> hosts = crops.stream()
                .filter(c -> !c.tutorial()
                        && !now.isBefore(c.plantedAt().plus(Duration.ofMinutes(rules.protectMinutes()))))
                .sorted((a, b) -> a.plantedAt().compareTo(b.plantedAt()) != 0
                        ? a.plantedAt().compareTo(b.plantedAt()) : Long.compare(a.plantingId(), b.plantingId()))
                .toList();
        for (OverdueCard card : overdue) {
            if (!usedCards.add(card.flashcardId())) continue;
            if (card.treeId() != null) {
                out.add(new Spawn(card.flashcardId(), card.word(), Host.TREE, null, card.treeId()));
                continue;
            }
            if (cropPests >= rules.maxCropPests()) continue;
            CropHost host = hosts.stream().filter(h -> !usedPlantings.contains(h.plantingId())).findFirst().orElse(null);
            if (host == null) {
                usedCards.remove(card.flashcardId());
                continue;
            }
            usedPlantings.add(host.plantingId());
            cropPests++;
            out.add(new Spawn(card.flashcardId(), card.word(), Host.CROP, host.plantingId(), null));
        }
        return out;
    }

    /** Groups pests by planting id (crop pests only). */
    public static Map<Long, List<PestFacts>> byPlanting(List<PestFacts> pests) {
        Map<Long, List<PestFacts>> out = new LinkedHashMap<>();
        for (PestFacts p : pests) {
            if (p.host() == Host.CROP && p.plantingId() != null) out.computeIfAbsent(p.plantingId(), k -> new ArrayList<>()).add(p);
        }
        return out;
    }
}
