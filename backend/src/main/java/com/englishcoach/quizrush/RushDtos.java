package com.englishcoach.quizrush;

import jakarta.validation.constraints.*;
import java.util.*;

public final class RushDtos {
    public record Start(@NotNull UUID requestId,@Pattern(regexp="EASY|MEDIUM|HARD") @NotNull String difficulty,
                        @Pattern(regexp="MIXED|VOCABULARY|WORD_RELATIONS|SPELLING|GRAMMAR|WORD_USE|PHRASAL_VERBS|IDIOMS_EXPRESSIONS") @NotNull String topic,
                        @Min(3) @Max(20) int checkpoints) {}
    public record Answer(@NotNull UUID requestId,@NotNull UUID questionId,@NotNull UUID optionId) {}
    public record Option(UUID id,String label) {}
    public record Question(UUID id,String family,String prompt,String context,List<Option> options) {}
    public record Review(String family,String prompt,String context,String answer,String explanation,int mistakes,String sourceRefs) {}
    public record Session(UUID id,String status,String difficulty,String topic,int total,int checkpoint,
                          int correct,int incorrect,String startedAt,String finishedAt,long elapsedMs,
                          Question question,List<Review> review,String contentVersion,int courseVersion,double spacing,
                          List<Double> boundaries,int streak,int bestStreak,List<RushTrials.Hazard> hazards,List<Boolean> rising,
                          List<RushReforged.Wall> walls,List<RushReforged.Orb> orbs) {}
    public record Feedback(Session session,boolean correct,boolean repeated,String explanation) {}
    public record Config(boolean available,Map<String,Integer> eligible,Map<String,List<String>> topics,String attribution,String contentVersion) {}
    private RushDtos() {}
}
