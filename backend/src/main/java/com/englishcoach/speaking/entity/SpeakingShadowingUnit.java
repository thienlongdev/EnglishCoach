package com.englishcoach.speaking.entity;

import com.englishcoach.listening.entity.ListeningMaterial;
import jakarta.persistence.*;
import lombok.*;

@Entity
@Table(name = "speaking_shadowing_units", uniqueConstraints = {
        @UniqueConstraint(
                name = "uk_shadowing_unit_material_gen_seq",
                columnNames = {"material_id", "generation_version", "sequence_number"}
        )
}, indexes = {
        @Index(name = "idx_shadowing_unit_material_gen_seq", columnList = "material_id, generation_version, sequence_number"),
        @Index(name = "idx_shadowing_unit_material_gen_start", columnList = "material_id, generation_version, start_time_ms")
})
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class SpeakingShadowingUnit {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "material_id", nullable = false)
    private ListeningMaterial material;

    @Column(name = "sequence_number", nullable = false)
    private Integer sequenceNumber;

    @Column(name = "start_time_ms", nullable = false)
    private Integer startTimeMs;

    @Column(name = "end_time_ms", nullable = false)
    private Integer endTimeMs;

    @Column(name = "display_text", columnDefinition = "TEXT", nullable = false)
    private String displayText;

    /**
     * Schema repair backfills legacy rows before enforcing physical non-nullability.
     */
    @Column(name = "generation_version")
    @Builder.Default
    private Integer generationVersion = 3;

    @Enumerated(EnumType.STRING)
    @Column(name = "timing_quality")
    private ShadowingTimingQuality timingQuality;

    @Enumerated(EnumType.STRING)
    @Column(name = "timing_strategy")
    private ShadowingTimingStrategy timingStrategy;

    @Column(name = "ipa", columnDefinition = "TEXT")
    private String ipa;

    @Column(name = "word_ipa_json", columnDefinition = "TEXT")
    private String wordIpaJson;

    @Column(name = "translation", columnDefinition = "TEXT")
    private String translation;
}
