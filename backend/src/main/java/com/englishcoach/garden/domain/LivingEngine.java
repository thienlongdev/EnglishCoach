package com.englishcoach.garden.domain;

import com.englishcoach.garden.domain.LivingRules.SkinDef;

/**
 * The Phase 3B rule set plus the pure calculators built on it (one instance per loaded configuration), kept beside
 * {@link GardenEngine} so the Phase 1–3A engine and its tests are untouched.
 */
public record LivingEngine(LivingRules rules, MonumentEngine monument, MasteryEngine mastery, EchoGuide echo) {

    /** Who may acquire a cultivar: {@code price} = coins the acquisition costs now (0 for an earned skin). */
    public record SkinCheck(boolean masteryOk, boolean learningOk, boolean coinsOk, long price) {

        public boolean ok() {
            return masteryOk && learningOk && coinsOk;
        }
    }

    public static LivingEngine of(LivingRules rules) {
        return new LivingEngine(rules, new MonumentEngine(rules), new MasteryEngine(rules), new EchoGuide());
    }

    /** A skin is art only: nothing that reads a skin touches growth, quality, price, XP or chance. */
    public SkinCheck check(SkinDef skin, int masteryTier, int learningDays, long coins) {
        long price = "COIN".equals(skin.unlockKind()) ? skin.coinPrice() : 0;
        return new SkinCheck(masteryTier >= skin.masteryTier(), learningDays >= skin.learningDays(), coins >= price, price);
    }
}
