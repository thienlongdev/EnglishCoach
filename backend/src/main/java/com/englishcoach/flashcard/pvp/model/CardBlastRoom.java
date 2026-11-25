package com.englishcoach.flashcard.pvp.model;

import com.englishcoach.flashcard.pvp.config.CardBlastPvPConstants;
import com.fasterxml.jackson.annotation.JsonIgnore;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.ArrayList;
import java.util.List;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class CardBlastRoom {

    private String roomCode;
    private Long deckId;
    private String deckTitle;
    @Builder.Default
    private String direction = "VI_EN";
    @Builder.Default
    private RoomMode mode = RoomMode.HUMAN;
    @Builder.Default
    private BotLevel botLevel = BotLevel.NORMAL;
    @Builder.Default
    private RoomStatus status = RoomStatus.WAITING;

    private PlayerState host;
    private PlayerState guest;

    @Builder.Default
    private int speedLevel = 2;
    @Builder.Default
    private String hintLevel = "NORMAL";

    private long seed;
    @Builder.Default
    private List<ScheduledWord> schedule = new ArrayList<>();
    private Long matchStartServerMs;

    @Builder.Default
    private boolean suddenDeath = false;
    @Builder.Default
    private long nextGoldenTargetMs = CardBlastPvPConstants.FIRST_GOLDEN_WORD_MS;
    private ScheduledWord activeGoldenWord;
    private String goldenWordClaimedBy;

    @JsonIgnore
    @Builder.Default
    private java.util.Set<Long> usedGarbageWordIds = java.util.concurrent.ConcurrentHashMap.newKeySet();

    @JsonIgnore
    @Builder.Default
    private java.util.List<PendingAttack> pendingAttacks = new java.util.concurrent.CopyOnWriteArrayList<>();

    @JsonIgnore
    @Builder.Default
    private java.util.Map<Integer, ScheduledWord> activeGarbageWords = new java.util.concurrent.ConcurrentHashMap<>();

    @JsonIgnore
    @Builder.Default
    private java.util.concurrent.atomic.AtomicInteger nextSeqCounter = new java.util.concurrent.atomic.AtomicInteger(1000);

    @Builder.Default
    private long createdAt = System.currentTimeMillis();
    @Builder.Default
    private long lastActivityAt = System.currentTimeMillis();

    private String winnerId;
    private String endReason;
    @JsonIgnore
    private com.englishcoach.flashcard.pvp.dto.PvPRequests.MatchEndPayload finalResult;

    @JsonIgnore
    @Builder.Default
    private final Object roomLock = new Object();

    public int generateNextSeq() {
        return nextSeqCounter.incrementAndGet();
    }

    public boolean isParticipant(String userId) {
        if (userId == null) return false;
        return (host != null && (userId.equals(host.getUserId()) || userId.equals(host.getPrincipalName()))) ||
               (guest != null && (userId.equals(guest.getUserId()) || userId.equals(guest.getPrincipalName())));
    }

    public PlayerState getPlayer(String userId) {
        if (userId == null) return null;
        if (host != null && (userId.equals(host.getUserId()) || userId.equals(host.getPrincipalName()))) return host;
        if (guest != null && (userId.equals(guest.getUserId()) || userId.equals(guest.getPrincipalName()))) return guest;
        return null;
    }

    public PlayerState getOpponent(String userId) {
        if (userId == null) return null;
        if (host != null && (userId.equals(host.getUserId()) || userId.equals(host.getPrincipalName()))) return guest;
        if (guest != null && (userId.equals(guest.getUserId()) || userId.equals(guest.getPrincipalName()))) return host;
        return null;
    }

    public boolean isHost(String userId) {
        return userId != null && host != null && (userId.equals(host.getUserId()) || userId.equals(host.getPrincipalName()));
    }

    public boolean isGuest(String userId) {
        return userId != null && guest != null && (userId.equals(guest.getUserId()) || userId.equals(guest.getPrincipalName()));
    }

    public void touch() {
        this.lastActivityAt = System.currentTimeMillis();
    }

    public void resetForRematch() {
        this.status = RoomStatus.WAITING;
        this.winnerId = null;
        this.endReason = null;
        this.finalResult = null;
        this.matchStartServerMs = null;
        this.suddenDeath = false;
        this.nextGoldenTargetMs = CardBlastPvPConstants.FIRST_GOLDEN_WORD_MS;
        this.activeGoldenWord = null;
        this.goldenWordClaimedBy = null;
        this.usedGarbageWordIds.clear();
        this.pendingAttacks.clear();
        this.activeGarbageWords.clear();
        if (this.host != null) {
            this.host.resetForRematch();
        }
        if (this.guest != null) {
            this.guest.resetForRematch();
        }
        this.touch();
    }
}
