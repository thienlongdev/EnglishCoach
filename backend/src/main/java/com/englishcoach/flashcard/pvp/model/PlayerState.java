package com.englishcoach.flashcard.pvp.model;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class PlayerState {

    private String userId;
    @com.fasterxml.jackson.annotation.JsonIgnore
    private String principalName;
    @com.fasterxml.jackson.annotation.JsonIgnore
    private String sessionId;
    private String displayName;
    /** Echo Sentinel attempt of this player's ranked match (server memory only; never serialized). */
    @com.fasterxml.jackson.annotation.JsonIgnore
    private transient com.englishcoach.sentinel.SentinelAttempt sentinel;
    private String avatar;
    private boolean ready;
    private boolean connected;
    private Long disconnectDeadlineMs;
    @Builder.Default
    private int hp = 100;
    @Builder.Default
    private int score = 0;
    @Builder.Default
    private int streak = 0;
    @Builder.Default
    private int bestStreak = 0;
    @Builder.Default
    private int hits = 0;
    @Builder.Default
    private int misses = 0;
    @Builder.Default
    private Set<Integer> resolvedSeqs = ConcurrentHashMap.newKeySet();
    @Builder.Default
    private boolean rematchRequested = false;
    @Builder.Default
    private boolean lastStand = false;
    @Builder.Default
    private boolean lastStandTriggered = false;
    @Builder.Default
    private long lastReactionTimeMs = 0L;
    @Builder.Default
    private Set<Long> missedWordIds = ConcurrentHashMap.newKeySet();

    @Builder.Default
    private int mana = 0;
    @Builder.Default
    private java.util.List<String> skills = new java.util.ArrayList<>(java.util.List.of("ECHO_CHAIN", "SLOW_MO", "EMP_BLAST"));
    @Builder.Default
    private int skillsUsed = 0;
    @Builder.Default
    private int attacksSent = 0;
    @Builder.Default
    private int attacksReceived = 0;
    @Builder.Default
    private int attacksDeflected = 0;
    @Builder.Default
    private int goldenCaptured = 0;
    @Builder.Default
    private long totalReactionTimeMs = 0L;
    @Builder.Default
    private int reactionCount = 0;
    @Builder.Default
    private Long shieldActiveUntilMs = null;
    @Builder.Default
    private Long fogActiveUntilMs = null;
    @Builder.Default
    private long deadlineBonusMs = 0L;
    @Builder.Default
    private boolean echoChainArmed = false;
    @Builder.Default
    private long lastSkillCastMs = 0L;

    public void resetForRematch() {
        this.ready = false;
        this.hp = 100;
        this.score = 0;
        this.streak = 0;
        this.bestStreak = 0;
        this.hits = 0;
        this.misses = 0;
        this.mana = 0;
        this.skillsUsed = 0;
        this.attacksSent = 0;
        this.attacksReceived = 0;
        this.attacksDeflected = 0;
        this.goldenCaptured = 0;
        this.totalReactionTimeMs = 0L;
        this.reactionCount = 0;
        this.shieldActiveUntilMs = null;
        this.fogActiveUntilMs = null;
        this.deadlineBonusMs = 0L;
        this.echoChainArmed = false;
        this.lastSkillCastMs = 0L;
        this.resolvedSeqs = ConcurrentHashMap.newKeySet();
        this.rematchRequested = false;
        this.disconnectDeadlineMs = null;
        this.lastStand = false;
        this.lastStandTriggered = false;
        this.lastReactionTimeMs = 0L;
        this.missedWordIds = ConcurrentHashMap.newKeySet();
    }
}
