package com.englishcoach.vocabulary.entity;

import jakarta.persistence.*;
import lombok.*;

import java.util.ArrayList;
import java.util.List;

@Entity
@Table(name = "vocabulary_courses")
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class VocabularyCourse {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    private String title;

    private String description;

    private String cefrLevel; // e.g. B1, B2

    @Builder.Default
    @OneToMany(mappedBy = "course", cascade = CascadeType.ALL, orphanRemoval = true, fetch = FetchType.LAZY)
    private List<VocabularyCourseWord> words = new ArrayList<>();
}
