package com.englishcoach.avatarframe.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;

import java.time.Instant;

@Entity
@Table(name = "avatar_frame_series", schema = "public")
@Getter
@Setter
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class AvatarFrameSeries {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, unique = true, length = 64)
    private String slug;

    @Column(nullable = false, length = 100)
    private String name;

    @Column(nullable = false, length = 32)
    private String lineage;

    @Column(columnDefinition = "TEXT")
    private String description;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;
}
