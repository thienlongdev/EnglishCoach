package com.englishcoach.flashcard.pvp.dto;

import com.englishcoach.flashcard.pvp.model.BotLevel;
import com.englishcoach.flashcard.pvp.model.PlayerState;
import com.englishcoach.flashcard.pvp.model.RoomMode;
import com.englishcoach.flashcard.pvp.model.RoomStatus;
import com.englishcoach.flashcard.pvp.model.ScheduledWord;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

public final class PvPRequests {

    private PvPRequests() {}

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class CreateRoomRequest {
        private Long deckId;
        private String deckSlug;
        private String deckTitle;
        private String direction; // "VI_EN" or "EN_VI"
        private RoomMode mode;    // HUMAN or BOT
        private BotLevel botLevel; // EASY, NORMAL, HARD
        @Builder.Default
        private Integer speedLevel = 2; // 1-5
        @Builder.Default
        private String hintLevel = "NORMAL"; // EASY, NORMAL, HARD
        private String avatar;
    }

    @Data
    @NoArgsConstructor
    @AllArgsConstructor
    public static class JoinRoomRequest {
        private String roomCode;
        private String avatar;

        public String getRoomCode() {
            return com.englishcoach.flashcard.pvp.util.RoomCodeGenerator.sanitize(roomCode);
        }

        public void setRoomCode(String roomCode) {
            this.roomCode = com.englishcoach.flashcard.pvp.util.RoomCodeGenerator.sanitize(roomCode);
        }
    }

    @Data
    @NoArgsConstructor
    @AllArgsConstructor
    public static class LeaveRoomRequest {
        private String roomCode;
    }

    @Data
    @NoArgsConstructor
    @AllArgsConstructor
    public static class ReadyRoomRequest {
        private String roomCode;
        private Boolean ready;
        private List<String> skills;
        /** Echo Sentinel attempt handle ("id.secret") of a ranked (human) match; page memory only. */
        private String sentinel;
    }

    @Data
    @NoArgsConstructor
    @AllArgsConstructor
    public static class SkillRequest {
        private String roomCode;
        private String skillId;
    }

    @Data
    @NoArgsConstructor
    @AllArgsConstructor
    public static class RejoinRoomRequest {
        private String roomCode;
    }

    @Data
    @NoArgsConstructor
    @AllArgsConstructor
    public static class HitRequest {
        private String roomCode;
        private int seq;
        @com.fasterxml.jackson.annotation.JsonProperty("tMs")
        @com.fasterxml.jackson.annotation.JsonAlias({"tMs", "tms", "TMS", "t_ms", "clientTimeMs"})
        private long tMs;
    }

    @Data
    @NoArgsConstructor
    @AllArgsConstructor
    public static class RematchRequest {
        private String roomCode;
    }

    @Data
    @NoArgsConstructor
    @AllArgsConstructor
    public static class PingRequest {
        private long clientTimeMs;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class PongResponse {
        private long clientTimeMs;
        private long serverTimeMs;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class RoomStatePayload {
        private String roomCode;
        private Long deckId;
        private String deckTitle;
        private String direction;
        private RoomMode mode;
        private BotLevel botLevel;
        private RoomStatus status;
        private PlayerState host;
        private PlayerState guest;
        private Long matchStartServerMs;
        private String winnerId;
        private String endReason;
        private Integer speedLevel;
        private String hintLevel;
        private boolean suddenDeath;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class StartCountdownPayload {
        private String roomCode;
        private long matchStartServerMs;
        private long seed;
        private List<ScheduledWord> schedule;
        private PlayerState host;
        private PlayerState guest;
        private Integer speedLevel;
        private String hintLevel;
        private boolean suddenDeath;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class LiveStatePayload {
        private String roomCode;
        private PlayerState host;
        private PlayerState guest;
        private LastHitInfo lastHit;
        private long matchNowMs;
        private boolean suddenDeath;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class LastHitInfo {
        private String userId;
        private int seq;
        @com.fasterxml.jackson.annotation.JsonProperty("tMs")
        @com.fasterxml.jackson.annotation.JsonAlias({"tMs", "tms", "TMS", "t_ms", "clientTimeMs"})
        private long tMs;
        private int earnedScore;
    }

    @Data
    @NoArgsConstructor
    @AllArgsConstructor
    public static class GameOverRequest {
        private String roomCode;
        private String reason;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class MatchEndPayload {
        private String roomCode;
        private String winnerId; // userId or "DRAW"
        private String loserId;  // userId or null
        private String reason;   // "KO", "WORDS_EXHAUSTED", "FORFEIT", "OPPONENT_DISCONNECTED"
        private PlayerMatchStats hostStats;
        private PlayerMatchStats guestStats;
        private boolean isRanked;
        private Long matchId;
        private long durationMs;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class PlayerMatchStats {
        private String userId;
        private String displayName;
        private int score;
        private int accuracy;
        private int maxStreak;
        private int hits;
        private int misses;
        private int remainingHp;
        private int avgReactionMs;
        private int goldenCaptured;
        private int attacksSent;
        private int attacksDeflected;
        private int attacksReceived;
        private int skillsUsed;
        private Integer ratingChange; // +/- Elo for ranked matches
        private Integer ratingDelta;  // alias
        private List<MissedWordDetail> missedWords;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class MissedWordDetail {
        private long wordId;
        private String word;
        private String vietnamese;
        private String ipa;
        private List<String> meanings;
    }

    @Data
    @NoArgsConstructor
    @AllArgsConstructor
    public static class ReactRequest {
        private String roomCode;
        private String reactionId; // GG, NICE, OOPS, FIRE
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class IncomingAttackPayload {
        private String attackId;
        private String fromUserId;
        private String fromName;
        private String targetPlayerId;
        private String targetUserId;
        private long telegraphMs;

        public String getTargetUserId() {
            return targetUserId != null ? targetUserId : targetPlayerId;
        }

        public String getTargetPlayerId() {
            return targetPlayerId != null ? targetPlayerId : targetUserId;
        }
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class AttackParriedPayload {
        private String attackId;
        private String parriedBy;
        private String parriedByName;
        private String targetPlayerId;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class SpawnGarbagePayload {
        private String attackId;
        private String targetPlayerId;
        private ScheduledWord scheduledWord;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class GoldenWordPayload {
        private ScheduledWord scheduledWord;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class GoldenTakenPayload {
        private int seq;
        private String winnerId;
        private String winnerName;
        private String word;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class LastStandPayload {
        private String playerId;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class SuddenDeathPayload {
        private String roomCode;
        private long matchNowMs;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class ReactionPayload {
        private String playerId;
        private String reactionId;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class ShieldAbsorbedPayload {
        private String attackId;
        private String targetPlayerId;
        private String attackerId;
        private String fromUserId;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class DeadlineUpdatePayload {
        private String userId;
        private long bonusMs;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class EmpBlastPayload {
        private String userId;
        private List<Integer> clearedSeqs;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class FogAppliedPayload {
        private String userId;
        private long durationMs;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class ShieldActivatedPayload {
        private String userId;
        private long durationMs;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class EchoChainDetonatedPayload {
        private String userId;
        private int detonatedSeq;
        private String word;
        private int earnedScore;
    }
}
