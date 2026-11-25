package com.englishcoach.coach.entity;

import com.englishcoach.auth.entity.User;
import jakarta.persistence.*;
import lombok.*;
import org.springframework.data.annotation.CreatedDate;
import org.springframework.data.jpa.domain.support.AuditingEntityListener;

import java.time.LocalDateTime;
import java.util.List;

@Entity
@Table(name = "learning_plans")
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@EntityListeners(AuditingEntityListener.class)
public class LearningPlan {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @OneToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "user_id", nullable = false)
    private User user;

    private String currentLevel;

    private String targetLevel;

    private String examGoal;

    @Column(length = 2000)
    private String planDetails;

    @ElementCollection
    @CollectionTable(name = "learning_weaknesses", joinColumns = @JoinColumn(name = "plan_id"))
    @Column(name = "weakness")
    private List<String> weaknesses;

    @CreatedDate
    @Column(nullable = false, updatable = false)
    private LocalDateTime createdAt;
}
