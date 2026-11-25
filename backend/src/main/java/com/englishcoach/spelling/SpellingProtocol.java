package com.englishcoach.spelling;

import java.util.*;
import static com.englishcoach.spelling.SpellingRules.*;

/** Public projections deliberately contain no current or upcoming canonical word. */
public final class SpellingProtocol {
    private SpellingProtocol() {}
    public record Command(UUID requestId, UUID roomId, UUID turnId, Mode mode, Difficulty difficulty,
                          String code, String hero, String look, String text, String sentinel,
                          Long sequence, Double x, Double z, Double yaw, Boolean value, Integer capacity) {}
    public record Player(String id, long userId, String name, String hero, String look, boolean online,
                         boolean ready, boolean eliminated, boolean spectator, boolean returning, double x, double z, double yaw,
                         long sequence, long sampledAt, long jumpAt, double jumpFloor, int score, int correct,
                         int wrong, int streak, int maxStreak, double highestWpm, String integrity) {}
    public record Review(String player, String answer, String typed, boolean correct, String reason,
                         double wpm, int earned, int tier, long at) {}
    public record Turn(UUID id, String player, int tier, String audioUrl, long audioDurationMs,
                       long openedAt, long deadline, String typed, int repeats, int audioRevision) {}
    public record State(UUID roomId, UUID matchId, String code, Mode mode, Difficulty difficulty, Phase phase,
                        String host, String self, long revision, long serverTime, long deadline, int round,
                        int capacity, boolean publicMatch, long startedAt, long sprintDeadline, String winner,
                        String reason, List<Player> players, Turn turn, Review result, List<Review> review,
                        boolean saved, List<String> newRecords) {}
    public record Event(String type, UUID requestId, String code, State state) {}
    public record Best(String mode, String difficulty, int highestScore, int longestStreak, int mostCorrect,
                       double highestWpm, double bestAccuracy, long bestSurvivalMs, long attempts, long wins) {}
    public record Run(UUID matchId, String mode, String difficulty, int score, int correct, int wrong,
                      int maxStreak, double highestWpm, double accuracy, long durationMs, boolean won,
                      String integrity, String finishedAt, List<Review> review) {}
    public record Records(List<Best> best, List<Run> recent) {}
}
