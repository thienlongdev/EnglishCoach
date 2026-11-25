package com.englishcoach.writing.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.UpdateTimestamp;

import java.time.Instant;

@Entity
@Table(name = "writing_profiles")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class WritingProfileEntity {

    @Id
    @Column(name = "user_id")
    private Long userId;

    @Column(name = "cefr_level", nullable = false, length = 10)
    @Builder.Default
    private String cefrLevel = "B1";

    @Column(name = "preferred_register", length = 50)
    @Builder.Default
    private String preferredRegister = "neutral";

    @Column(name = "goals", columnDefinition = "TEXT")
    private String goals;

    @Column(name = "interests", columnDefinition = "TEXT")
    private String interests;

    @Column(name = "explanation_locale", nullable = false, length = 10)
    @Builder.Default
    private String explanationLocale = "en";

    @Column(name = "provenance", nullable = false, length = 50)
    @Builder.Default
    private String provenance = "INITIAL_CHOICE";

    @Column(name = "version", nullable = false)
    @Builder.Default
    private Long version = 1L;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;
}
