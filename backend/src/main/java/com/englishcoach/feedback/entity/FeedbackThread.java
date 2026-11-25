package com.englishcoach.feedback.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;

import java.time.Instant;

@Entity
@Table(name = "feedback_threads", schema = "public")
@Getter
@Setter
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class FeedbackThread {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "user_id", nullable = false)
    private Long userId;

    @Column(name = "category", nullable = false, length = 30)
    @Builder.Default
    private String category = "OTHER";

    @Column(name = "subject", nullable = false, length = 120)
    private String subject;

    @Column(name = "status", nullable = false, length = 20)
    @Builder.Default
    private String status = "OPEN";

    @Column(name = "admin_unread", nullable = false)
    @Builder.Default
    private boolean adminUnread = true;

    @Column(name = "user_unread", nullable = false)
    @Builder.Default
    private boolean userUnread = false;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "last_message_at", nullable = false)
    private Instant lastMessageAt;
}
