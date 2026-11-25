package com.englishcoach.mocktest.entity;

import jakarta.persistence.*;
import lombok.*;

@Entity
@Table(name = "exams")
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class Exam {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    private String title;

    private int durationMinutes;

    @Column(columnDefinition = "TEXT")
    private String examDataJson;
}
