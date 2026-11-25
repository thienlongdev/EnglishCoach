package com.englishcoach.auth.entity;

import jakarta.persistence.*;
import lombok.*;

import java.io.Serializable;
import java.time.Instant;

@Entity
@Table(name = "auth_rate_limit_buckets", schema = "public")
@IdClass(AuthRateLimitBucket.RateLimitId.class)
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class AuthRateLimitBucket {

    @Id
    @Column(nullable = false, length = 64)
    private String kind;

    @Id
    @Column(name = "bucket_key", nullable = false, length = 128)
    private String bucketKey;

    @Id
    @Column(name = "window_start", nullable = false)
    private Instant windowStart;

    @Builder.Default
    @Column(name = "request_count", nullable = false)
    private Integer requestCount = 1;

    @Column(name = "expires_at", nullable = false)
    private Instant expiresAt;

    @Data
    @NoArgsConstructor
    @AllArgsConstructor
    public static class RateLimitId implements Serializable {
        private String kind;
        private String bucketKey;
        private Instant windowStart;
    }
}
