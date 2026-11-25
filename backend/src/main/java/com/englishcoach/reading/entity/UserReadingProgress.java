package com.englishcoach.reading.entity;

import com.englishcoach.auth.entity.User;
import jakarta.persistence.*;
import lombok.*;

import java.time.LocalDateTime;

@Entity
@Table(name = "user_reading_progress")
@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class UserReadingProgress {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "user_id")
    private User user;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "reading_material_id")
    private ReadingMaterial readingMaterial;

    @Column
    private Integer scrollPercentage;

    @Column
    private LocalDateTime lastReadAt;
}
