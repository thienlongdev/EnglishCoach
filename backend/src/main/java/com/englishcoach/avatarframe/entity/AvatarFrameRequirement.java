package com.englishcoach.avatarframe.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;

import java.time.Instant;

@Entity
@Table(name = "avatar_frame_requirements", schema = "public")
@Getter
@Setter
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class AvatarFrameRequirement {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "frame_id", nullable = false)
    private AvatarFrame frame;

    @Column(name = "metric_type", nullable = false, length = 64)
    private String metricType;

    @Column(nullable = false, length = 16)
    private String operator;

    @Column(name = "target_value", nullable = false, length = 64)
    private String targetValue;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;
}
