package com.englishcoach.learningpath;

import jakarta.validation.constraints.*;
import java.time.*;
import java.util.*;

public final class OdysseyDtos {
    private OdysseyDtos() {}
    public record ExploreRequest(@NotBlank @Size(max=40) String regionId, boolean activateBeacon) {}
    public record NavigateRequest(@NotBlank @Size(max=40) String regionId, @Size(max=120) String stationId,
                                  @NotBlank @Pattern(regexp="ATLAS|REGION|LIST") String viewMode) {}
    public record LaunchRequest(@NotNull UUID requestId,@NotBlank @Size(max=120) String stationId,
                                @NotBlank @Pattern(regexp="LEARN|CHECK|REVIEW|ADVANCE") String mode) {}
    public record PreferencesRequest(LocalDate targetDate,@Min(15) @Max(2520) Integer weeklyMinutes,
        @Pattern(regexp="ACADEMIC|GENERAL_TRAINING|LISTENING_READING") String examVariant) {}
    public record Exploration(String regionId,Instant discoveredAt,Instant beaconAt) {}
    public record Navigation(String regionId,String stationId,String viewMode,LocalDate targetDate,Integer weeklyMinutes,String examVariant,long revision) {}
    public record Launch(UUID requestId,String stationId,String regionId,String mode,Long taskId,String topicSlug,UUID checkId,Instant createdAt) {}
    public record LaunchView(Launch launch,String href) {}
    public record Reward(String sourceKind,String sourceRef,String regionId,Instant grantedAt) {}
    public record Gate(String state,List<String> required,List<String> missing,String evidenceBasis,String remediation) {}
    public record Station(String id,String regionId,OdysseyCatalog.Words title,String kind,String skill,String level,
                          String domain,String status,Gate gate,boolean checkAvailable,String learningRole,List<String> prerequisites,
                          LearningPathDtos.TaskView task,Instant reviewedAt) {}
    public record RegionView(OdysseyCatalog.Region region,int stations,int passed,int reviewDue) {}
    public record SkillEvidence(String skill,String status,String cefr,boolean currentVerified) {}
    public record World(String version,String grammarRevision,List<RegionView> regions,List<Exploration> explored,
                        Navigation navigation,List<Reward> journal,int rewardCount,List<Reward> newlyGranted,
                        LearningPathDtos.TodayView today,LearningPathDtos.ProgressSummary progress,
                        List<Station> recommendations,List<SkillEvidence> evidence,Launch activeLaunch) {}
    public record RegionDetail(String version,OdysseyCatalog.Region region,List<Station> stations) {}
}
