package com.englishcoach.content.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;

import java.time.Instant;

@Entity
@Table(name = "content_vocabulary", schema = "public")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class ContentVocabulary {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "content_type", nullable = false, length = 50)
    private String contentType;

    @Column(name = "content_id", nullable = false)
    private Long contentId;

    @Column(nullable = false, length = 100)
    private String word;

    @Column(length = 100)
    private String lemma;

    @Column(length = 100)
    private String phonetic;

    @Column(nullable = false, length = 500)
    private String meaning;

    @Column(name = "example_sentence", columnDefinition = "TEXT")
    private String exampleSentence;

    @Column
    @Builder.Default
    private Integer frequency = 1;

    @CreationTimestamp
    @Column(name = "created_at", insertable = false, updatable = false)
    private Instant createdAt;
}
