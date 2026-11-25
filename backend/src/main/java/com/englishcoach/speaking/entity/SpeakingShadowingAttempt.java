package com.englishcoach.speaking.entity;

import com.englishcoach.auth.entity.User;
import com.englishcoach.listening.entity.TranscriptSegment;
import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;

import java.time.LocalDateTime;

@Entity
@Table(name = "speaking_shadowing_attempts", uniqueConstraints = {
        @UniqueConstraint(name = "uk_shadowing_attempt_session_client_id", columnNames = {"session_id", "client_attempt_id"})
}, indexes = {
        @Index(name = "idx_shadowing_attempt_user_unit", columnList = "user_id, shadowing_unit_id"),
        @Index(name = "idx_shadowing_attempt_user_segment", columnList = "user_id, segment_id"),
        @Index(name = "idx_shadowing_attempt_session_created", columnList = "session_id, created_at")
})
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class SpeakingShadowingAttempt {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "user_id", nullable = false)
    private User user;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "session_id", nullable = false)
    private SpeakingSession session;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "shadowing_unit_id")
    private SpeakingShadowingUnit shadowingUnit;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "segment_id", nullable = true)
    private TranscriptSegment segment;

    @Column(name = "client_attempt_id", nullable = false, length = 100)
    private String clientAttemptId;

    @Column(name = "learner_transcript", columnDefinition = "TEXT")
    private String learnerTranscript;

    @Column(name = "accuracy_score")
    private Double accuracyScore;

    @Column(name = "pronunciation_score")
    private Double pronunciationScore;

    @Column(name = "fluency_score")
    private Double fluencyScore;

    @Column(name = "duration_seconds")
    private Integer durationSeconds;

    @Column(name = "audio_ref", length = 255)
    private String audioRef;

    @Column(name = "audio_sha256", length = 64)
    private String audioSha256;

    @Column(name = "is_mocked")
    @Builder.Default
    private Boolean isMocked = false;

    @Column(name = "parent_attempt_id", length = 100)
    private String parentAttemptId;

    @Column(name = "retry_index")
    @Builder.Default
    private Integer retryIndex = 0;

    @Column(name = "active_target_id", length = 100)
    private String activeTargetId;

    @Column(name = "primary_issue_type", length = 100)
    private String primaryIssueType;

    @Column(name = "target_word", length = 100)
    private String targetWord;

    @Column(name = "retry_comparison_state", length = 50)
    private String retryComparisonState;

    @Column(name = "resolved_this_session")
    @Builder.Default
    private Boolean resolvedThisSession = false;

    @Column(name = "analysis_status", length = 50)
    @Builder.Default
    private String analysisStatus = "COMPLETED";

    @Column(name = "product_safe_result_json", columnDefinition = "TEXT")
    private String productSafeResultJson;

    @Column(name = "product_contract_version", length = 50)
    private String productContractVersion;

    @Column(name = "artifact_set_id", length = 100)
    private String artifactSetId;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private LocalDateTime createdAt;
}
