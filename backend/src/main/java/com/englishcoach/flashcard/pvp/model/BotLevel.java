package com.englishcoach.flashcard.pvp.model;

public enum BotLevel {
    EASY(0.55),
    NORMAL(0.78),
    HARD(0.92);

    private final double hitProbability;

    BotLevel(double hitProbability) {
        this.hitProbability = hitProbability;
    }

    public double getHitProbability() {
        return hitProbability;
    }
}
