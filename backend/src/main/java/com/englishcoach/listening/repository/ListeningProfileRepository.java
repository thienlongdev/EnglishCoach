package com.englishcoach.listening.repository;

import com.englishcoach.listening.entity.ListeningProfile;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Optional;

public interface ListeningProfileRepository extends JpaRepository<ListeningProfile, Long> {
    Optional<ListeningProfile> findByUserId(Long userId);
}
