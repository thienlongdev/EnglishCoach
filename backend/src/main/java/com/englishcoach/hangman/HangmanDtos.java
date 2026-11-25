package com.englishcoach.hangman;

import jakarta.validation.constraints.*;
import java.util.*;

public final class HangmanDtos {
    private HangmanDtos() {}
    public record StartRequest(@NotNull HangmanRules.Difficulty difficulty,@Min(1) @Max(1000) Integer levelNumber,@NotNull UUID requestId) {}
    public record GuessRequest(@NotNull @Pattern(regexp="[a-zA-Z]") String letter,@NotNull UUID requestId,@NotNull @Min(0) Integer expectedVersion) {}
    public record HintRequest(@NotNull UUID requestId,@NotNull @Min(0) Integer expectedVersion) {}
    public record RetryRequest(@NotNull UUID requestId) {}
    public record Track(HangmanRules.Difficulty difficulty,int startingBalloons,int prefillCount,int highestUnlocked,int lastPlayedLevel,int publishedLevels,UUID currentRoundId,boolean catalogCompleted,int eligibleWordCount) {}
    public record Bootstrap(String catalogVersion,List<Track> tracks,String wordAttribution,String wordSource,int sourceWordCount) {}
    public record Round(UUID roundId,HangmanRules.Difficulty difficulty,int levelNumber,String category,List<String> pattern,List<String> prefilledLetters,List<String> correctLetters,List<String> wrongLetters,List<String> hintedLetters,int initialBalloons,int remainingBalloons,int hintsRemaining,HangmanRules.Status status,int version,Integer score,String answer,boolean nextLevelAvailable,boolean catalogCompleted) {}
}
