package com.englishcoach.reading.entity;

import com.englishcoach.auth.entity.User;
import jakarta.persistence.*;
import lombok.*;

import java.time.LocalDateTime;

@Entity
@Table(name = "document_highlights")
@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class DocumentHighlight {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "user_id")
    private User user;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "reading_material_id")
    private ReadingMaterial readingMaterial;

    @Column(columnDefinition = "TEXT")
    private String highlightedText;

    @Column
    private String colorCode;

    @Column(columnDefinition = "TEXT")
    private String userNote;

    @Column
    private LocalDateTime createdAt;
}
