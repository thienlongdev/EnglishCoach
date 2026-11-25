package com.englishcoach.listening.entity;

import com.englishcoach.auth.entity.User;
import jakarta.persistence.*;
import lombok.*;

import java.util.ArrayList;
import java.util.List;

@Entity
@Table(name = "listening_profiles")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class ListeningProfile {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @OneToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "user_id", unique = true, nullable = false)
    private User user;

    private Long totalListeningTimeSeconds;

    private Double overallAccuracy;

    @Builder.Default
    @ElementCollection(fetch = FetchType.LAZY)
    @CollectionTable(name = "listening_error_dna", joinColumns = @JoinColumn(name = "profile_id"))
    private List<ErrorDNA> errorDnaList = new ArrayList<>();
}
