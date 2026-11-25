package com.englishcoach.dictionary.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.BatchSize;

import java.util.List;

@Entity
@Table(name = "dictionary_entries")
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@BatchSize(size = 100)
public class DictionaryEntry {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    /** Unique among shared rows, and per owner among private rows (V102 partial indexes). */
    @Column(nullable = false)
    private String word;

    /**
     * NULL = shared dictionary data (every learner may read it). Set = a learner's PRIVATE entry, created when they saved
     * a Flashcard for a word the shared dictionary did not know; reachable only through that learner's own card
     * (V102). Never serialised.
     */
    @com.fasterxml.jackson.annotation.JsonIgnore
    @Column(name = "owner_user_id")
    private Long ownerUserId;

    private String ipa;

    private String cefr;

    @Column(name = "entry_type")
    private String entryType;

    @Column(name = "data_json", columnDefinition = "TEXT")
    private String dataJson;

    @Column(name = "general_translation_vi", columnDefinition = "TEXT")
    private String generalTranslationVi;

    @Column(name = "updated_at")
    private java.time.LocalDateTime updatedAt;

    @BatchSize(size = 100)
    @ElementCollection(fetch = FetchType.EAGER)
    @CollectionTable(name = "dictionary_meanings", joinColumns = @JoinColumn(name = "dictionary_entry_id"))
    @Column(name = "meaning", columnDefinition = "TEXT")
    private List<String> meanings;

    @BatchSize(size = 100)
    @ElementCollection(fetch = FetchType.EAGER)
    @CollectionTable(name = "dictionary_examples", joinColumns = @JoinColumn(name = "dictionary_entry_id"))
    @Column(name = "example", columnDefinition = "TEXT")
    private List<String> examples;

    @BatchSize(size = 100)
    @ElementCollection(fetch = FetchType.LAZY)
    @CollectionTable(name = "dictionary_synonyms", joinColumns = @JoinColumn(name = "dictionary_entry_id"))
    @Column(name = "synonym", columnDefinition = "TEXT")
    private List<String> synonyms;

    @BatchSize(size = 100)
    @ElementCollection(fetch = FetchType.LAZY)
    @CollectionTable(name = "dictionary_collocations", joinColumns = @JoinColumn(name = "dictionary_entry_id"))
    @Column(name = "collocation", columnDefinition = "TEXT")
    private List<String> collocations;
}

