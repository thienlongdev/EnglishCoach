package com.englishcoach.garden.domain;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Echo Whale as navigator (Phase 3B, blueprint §7.3): ONE contextual hint at a time, chosen by a fixed, transparent
 * priority from facts the server already holds. Pure and deterministic: no table, no timer, no AI. A hint is only ever
 * produced for something that is true right now, so Echo never invents a task or points at an unavailable action.
 *
 * <p>Priority: 1 a Knowledge Tree can graduate → 2 a forgotten word waits for a review → 3 crops are ripe → 4 an order
 * can be filled from stock → 5 a milestone has not been seen → 6 an earned skin waits to be collected → 7 cards are due
 * and today is not yet a verified learning day → 8 the branch closest to its next tier → 9 nothing (idle).
 */
public final class EchoGuide {

    /**
     * {@code graduationSlot}: grove slot of an eligible tree (null = none); {@code rescuePestId}: an unreviewed pest (null =
     * none) of {@code pests}; {@code fillableOrderId}: an order the stock covers (null = none); {@code claimSkin}: an
     * earned, uncollected skin (null = none); {@code branch}: the skill family closest to its next tier with
     * {@code branchDaysLeft} verified days to go (null = every branch is complete); {@code worstPestStage}: the most
     * advanced damage stage among the unreviewed pests (Phase 3C; 0 = unknown / a plain reminder).
     */
    public record Facts(Integer graduationSlot, Long rescuePestId, int pests, int readyCrops, Long fillableOrderId,
                        int fillableOrders, int unseenMilestones, String claimSkin, long dueCards, boolean learnedToday,
                        String branch, int branchDaysLeft, int branchNextTier, int worstPestStage) {

        /** Phase 3B shape (no damage stage: the pest is a plain reminder). */
        public Facts(Integer graduationSlot, Long rescuePestId, int pests, int readyCrops, Long fillableOrderId,
                     int fillableOrders, int unseenMilestones, String claimSkin, long dueCards, boolean learnedToday,
                     String branch, int branchDaysLeft, int branchNextTier) {
            this(graduationSlot, rescuePestId, pests, readyCrops, fillableOrderId, fillableOrders, unseenMilestones, claimSkin,
                    dueCards, learnedToday, branch, branchDaysLeft, branchNextTier, 0);
        }
    }

    public record Hint(String code, Map<String, Object> params) {}

    public Hint pick(Facts f) {
        Map<String, Object> p = new LinkedHashMap<>();
        if (f.graduationSlot() != null) {
            p.put("slot", f.graduationSlot());
            return new Hint("GRADUATE", p);
        }
        if (f.rescuePestId() != null) {
            p.put("pestId", f.rescuePestId());
            p.put("count", f.pests());
            // Phase 3C: the damage stage of the pest Echo points at (2 leaf damage, 3 wilting), so the advice fits it
            if (f.worstPestStage() > 0) p.put("stage", f.worstPestStage());
            return new Hint("RESCUE", p);
        }
        if (f.readyCrops() > 0) {
            p.put("count", f.readyCrops());
            return new Hint("HARVEST", p);
        }
        if (f.fillableOrderId() != null) {
            p.put("orderId", f.fillableOrderId());
            p.put("count", f.fillableOrders());
            return new Hint("DELIVER", p);
        }
        if (f.unseenMilestones() > 0) {
            p.put("count", f.unseenMilestones());
            return new Hint("MILESTONE", p);
        }
        if (f.claimSkin() != null) {
            p.put("skinCode", f.claimSkin());
            return new Hint("CLAIM_SKIN", p);
        }
        if (f.dueCards() > 0 && !f.learnedToday()) {
            p.put("due", f.dueCards());
            return new Hint("REVIEW_DUE", p);
        }
        if (f.branch() != null && !f.learnedToday()) {
            p.put("family", f.branch());
            p.put("daysLeft", f.branchDaysLeft());
            p.put("tier", f.branchNextTier());
            return new Hint("BRANCH", p);
        }
        return new Hint("IDLE", p);
    }
}
