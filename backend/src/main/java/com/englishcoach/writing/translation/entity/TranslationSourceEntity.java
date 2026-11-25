package com.englishcoach.writing.translation.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "translation_sources", schema = "public")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class TranslationSourceEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    @Column(name = "id")
    private UUID id;

    @Column(name = "source_code", nullable = false, length = 80)
    private String sourceCode;

    @Column(name = "official_url", nullable = false, columnDefinition = "TEXT")
    private String officialUrl;

    @Column(name = "release_version", nullable = false, length = 120)
    private String releaseVersion;

    @Column(name = "license_name", nullable = false, length = 120)
    private String licenseName;

    @Column(name = "license_url", nullable = false, columnDefinition = "TEXT")
    private String licenseUrl;

    @Column(name = "license_class", nullable = false, length = 32)
    private String licenseClass;

    @Column(name = "attribution_text", columnDefinition = "TEXT")
    private String attributionText;

    @Column(name = "commercial_use_allowed", nullable = false)
    private Boolean commercialUseAllowed;

    @Column(name = "redistribution_allowed", nullable = false)
    private Boolean redistributionAllowed;

    @Column(name = "checksum_sha256", nullable = false, length = 64)
    private String checksumSha256;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "manifest_json", nullable = false, columnDefinition = "jsonb")
    @Builder.Default
    private String manifestJson = "{}";

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;
}
