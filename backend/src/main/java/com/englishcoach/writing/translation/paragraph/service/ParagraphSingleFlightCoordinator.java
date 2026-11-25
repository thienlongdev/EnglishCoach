package com.englishcoach.writing.translation.paragraph.service;

import com.englishcoach.writing.translation.paragraph.entity.TranslationParagraphInFlightEntity;
import com.englishcoach.writing.translation.paragraph.repository.TranslationParagraphInFlightRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Optional;
import java.util.UUID;

@Slf4j
@Service
@RequiredArgsConstructor
public class ParagraphSingleFlightCoordinator {

    private final TranslationParagraphInFlightRepository inFlightRepository;

    /**
     * Tries to acquire lease for the flight key in a separate transaction.
     * @return true if acquired (LEADER), false if another execution is in-flight (FOLLOWER).
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public boolean tryAcquire(String flightKey, Long userId, UUID sessionId) {
        Instant now = Instant.now();
        // Clean up any stale expired records first
        try {
            inFlightRepository.deleteExpired(now);
        } catch (Exception ignored) {
        }

        Optional<TranslationParagraphInFlightEntity> existing = inFlightRepository.findByFlightKey(flightKey);
        if (existing.isPresent()) {
            if (existing.get().getExpiresAt().isAfter(now)) {
                log.info("Single-flight duplicate detected for flightKey {}. Follower waiting.", flightKey);
                return false;
            } else {
                inFlightRepository.deleteByFlightKey(flightKey);
            }
        }

        try {
            TranslationParagraphInFlightEntity entity = TranslationParagraphInFlightEntity.builder()
                    .flightKey(flightKey)
                    .userId(userId)
                    .sessionId(sessionId)
                    .expiresAt(now.plus(60, ChronoUnit.SECONDS))
                    .build();
            inFlightRepository.saveAndFlush(entity);
            log.info("Acquired single-flight lease for flightKey {}", flightKey);
            return true;
        } catch (DataIntegrityViolationException e) {
            log.info("Concurrent collision on single-flight lease for flightKey {}", flightKey);
            return false;
        } catch (Exception e) {
            log.warn("Error acquiring single-flight lease: {}", e.getMessage());
            return true; // Fall through on infrastructure issue
        }
    }

    /**
     * Releases lease on completion.
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void release(String flightKey) {
        try {
            inFlightRepository.deleteByFlightKey(flightKey);
            log.info("Released single-flight lease for flightKey {}", flightKey);
        } catch (Exception e) {
            log.warn("Failed to release single-flight lease for flightKey {}: {}", flightKey, e.getMessage());
        }
    }
}
