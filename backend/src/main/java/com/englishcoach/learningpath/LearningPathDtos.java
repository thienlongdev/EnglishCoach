package com.englishcoach.learningpath;

import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;

import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;

/** Small, predictable payloads of the Learning Path endpoints. */
public final class LearningPathDtos {

    private LearningPathDtos() {}

    public record GoalRequest(@NotNull @Pattern(regexp = "GENERAL|COMMUNICATION|IELTS|TOEIC") String goal,
                              @NotNull Integer dailyMinutes,
                              @Pattern(regexp = "(?:[0-9.]{1,4}|A1|A2|B1|B2|C1)") String target) {}

    public record PlanView(String goal, int dailyMinutes, String target, String level, String levelBasis, int stage,
                           int version, Map<String, Double> focus, Instant focusUpdatedAt) {}

    /** Destination is derived on the client from kind + numeric target id / enumerated key only (no URL from data). */
    public record TaskView(long id, String kind, String skill, Long targetId, String targetKey, String title, int minutes,
                           int goalCount, int progress, String status, String reason, boolean carried, Integer resultPct,
                           String targetRef) {}

    public record StageView(int current, List<LearningPathEngine.Requirement> next, boolean assessmentNeeded) {}

    public record TodayView(PlanView plan, LocalDate day, List<TaskView> tasks, int done, int total, int minutes,
                            StageView stage) {
        public static TodayView none() { return new TodayView(null, null, List.of(), 0, 0, 0, null); }
    }

    public record SkillView(String skill, String band, int observations, Integer daysSinceLast) {}

    public record ProgressSummary(PlanView plan, StageView stage, List<SkillView> skills, int tasksDone, int tasksDone7d,
                                  int tasksDone30d) {}

    public record ChangeView(String skill, String direction, String reason) {}

    public record DnaFacts(long cardsForgetting, List<String> sounds, List<String> grammar, int listeningMistakes,
                           boolean speakingPauses) {}

    public record ProposalView(long id, int baseVersion, Instant dnaGeneratedAt, Instant expiresAt, List<ChangeView> changes,
                               DnaFacts facts) {}
}
