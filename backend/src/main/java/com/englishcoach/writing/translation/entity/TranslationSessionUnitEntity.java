package com.englishcoach.writing.translation.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.UpdateTimestamp;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "translation_session_units", schema = "public")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class TranslationSessionUnitEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    @Column(name = "id")
    private UUID id;

    @Column(name = "session_id", nullable = false)
    private UUID sessionId;

    @Column(name = "exercise_id", nullable = false)
    private UUID exerciseId;

    @Column(name = "unit_id", nullable = false)
    private UUID unitId;

    @Column(name = "unit_ordinal", nullable = false)
    private Short unitOrdinal;

    @Column(name = "draft_text", nullable = false, columnDefinition = "TEXT")
    @Builder.Default
    private String draftText = "";

    @Column(name = "draft_revision", nullable = false)
    @Builder.Default
    private Long draftRevision = 0L;

    @Column(name = "hint_level", nullable = false, length = 16)
    @Builder.Default
    private String hintLevel = "HIDDEN";

    @Column(name = "reference_revealed", nullable = false)
    @Builder.Default
    private Boolean referenceRevealed = false;

    @Column(name = "terminal_status", nullable = false, length = 24)
    @Builder.Default
    private String terminalStatus = "UNSEEN";

    @Column(name = "revealed_tokens_json", nullable = false, length = 512)
    @Builder.Default
    private String revealedTokensJson = "[]";

    @Column(name = "last_attempt_id")
    private UUID lastAttemptId;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    public boolean isReferenceRevealed() {
        return Boolean.TRUE.equals(referenceRevealed);
    }
}
