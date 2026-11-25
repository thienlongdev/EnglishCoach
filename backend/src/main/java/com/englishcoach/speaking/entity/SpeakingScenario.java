package com.englishcoach.speaking.entity;

import com.englishcoach.speaking.entity.enums.CefrLevel;
import com.englishcoach.speaking.entity.enums.ScenarioCategory;
import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.UpdateTimestamp;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;

@Entity
@Table(name = "speaking_scenarios")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class SpeakingScenario {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private String title;

    @Column(columnDefinition = "TEXT")
    private String description;

    @Enumerated(EnumType.STRING)
    @Column(name = "cefr_level", length = 20)
    private CefrLevel cefrLevel;

    @Enumerated(EnumType.STRING)
    @Column(length = 50)
    private ScenarioCategory category;

    @Column(name = "learner_role")
    private String learnerRole;

    @Column(name = "ai_role")
    private String aiRole;

    @Column(name = "learner_goal", columnDefinition = "TEXT")
    private String learnerGoal;

    @ElementCollection(fetch = FetchType.LAZY)
    @CollectionTable(name = "speaking_scenario_vocabularies", joinColumns = @JoinColumn(name = "scenario_id"))
    @Column(name = "word")
    @Builder.Default
    private List<String> targetVocabulary = new ArrayList<>();

    @ElementCollection(fetch = FetchType.LAZY)
    @CollectionTable(name = "speaking_scenario_grammars", joinColumns = @JoinColumn(name = "scenario_id"))
    @Column(name = "grammar")
    @Builder.Default
    private List<String> targetGrammar = new ArrayList<>();

    @Column(name = "initial_ai_message", columnDefinition = "TEXT")
    private String initialAiMessage;

    @ElementCollection(fetch = FetchType.LAZY)
    @CollectionTable(name = "speaking_scenario_success_criteria", joinColumns = @JoinColumn(name = "scenario_id"))
    @Column(name = "criterion", columnDefinition = "TEXT")
    @Builder.Default
    private List<String> successCriteria = new ArrayList<>();

    @Column(name = "completion_conditions", columnDefinition = "TEXT")
    private String completionConditions;

    @Column(name = "evaluation_rubric", columnDefinition = "TEXT")
    private String evaluationRubric;

    @ElementCollection(fetch = FetchType.LAZY)
    @CollectionTable(name = "speaking_scenario_hints", joinColumns = @JoinColumn(name = "scenario_id"))
    @Column(name = "hint", columnDefinition = "TEXT")
    @Builder.Default
    private List<String> optionalHints = new ArrayList<>();

    @Column(name = "estimated_minutes")
    private Integer estimatedMinutes;

    @Column(name = "owner_user_id")
    private Long ownerUserId;

    @Column(name = "is_system", nullable = false)
    @Builder.Default
    private Boolean isSystem = true;

    @Column(name = "default_voice_id", length = 50)
    @Builder.Default
    private String defaultVoiceId = "us_female";

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private LocalDateTime createdAt;

    @UpdateTimestamp
    @Column(name = "updated_at")
    private LocalDateTime updatedAt;
}
