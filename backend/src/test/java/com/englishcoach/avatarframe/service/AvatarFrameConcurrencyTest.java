package com.englishcoach.avatarframe.service;

import com.englishcoach.avatarframe.entity.AvatarFrame;
import com.englishcoach.avatarframe.entity.AvatarFrameSeries;
import com.englishcoach.avatarframe.entity.UserAvatarFrame;
import com.englishcoach.avatarframe.evaluator.PrestigeEvaluationEngine;
import com.englishcoach.avatarframe.repository.AvatarFrameRepository;
import com.englishcoach.avatarframe.repository.UserAvatarFrameRepository;
import com.englishcoach.notification.service.NotificationService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.web.server.ResponseStatusException;

import java.util.Optional;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class AvatarFrameConcurrencyTest {

    @Mock
    private AvatarFrameRepository avatarFrameRepository;

    @Mock
    private UserAvatarFrameRepository userAvatarFrameRepository;

    @Mock
    private PrestigeEvaluationEngine prestigeEvaluationEngine;

    @Mock
    private NotificationService notificationService;

    @InjectMocks
    private AvatarFrameServiceImpl avatarFrameService;

    @Test
    @DisplayName("Concurrency: Concurrent equips on thread pool ensure single-equipped invariant and handle conflicts safely")
    void testConcurrentEquips_singleEquippedInvariantMaintained() throws Exception {
        AvatarFrameSeries series = AvatarFrameSeries.builder().id(1L).slug("streak").name("Streak").lineage("ACHIEVEMENT").build();
        AvatarFrame frameA = AvatarFrame.builder().id(10L).series(series).slug("frame_a").name("Frame A").isActive(true).build();
        AvatarFrame frameB = AvatarFrame.builder().id(20L).series(series).slug("frame_b").name("Frame B").isActive(true).build();

        UserAvatarFrame uafA = UserAvatarFrame.builder().id(100L).userId(1L).frame(frameA).isEquipped(false).build();
        UserAvatarFrame uafB = UserAvatarFrame.builder().id(200L).userId(1L).frame(frameB).isEquipped(false).build();

        when(avatarFrameRepository.findBySlug("frame_a")).thenReturn(Optional.of(frameA));
        when(avatarFrameRepository.findBySlug("frame_b")).thenReturn(Optional.of(frameB));
        when(userAvatarFrameRepository.findByUserIdAndFrameId(1L, 10L)).thenReturn(Optional.of(uafA));
        when(userAvatarFrameRepository.findByUserIdAndFrameId(1L, 20L)).thenReturn(Optional.of(uafB));

        // Simulate database unique index constraint firing on concurrent collision
        AtomicInteger attemptCounter = new AtomicInteger(0);
        doAnswer(invocation -> {
            int attempt = attemptCounter.incrementAndGet();
            if (attempt > 1) {
                throw new DataIntegrityViolationException("duplicate key value violates unique constraint idx_user_avatar_frames_single_equipped");
            }
            return invocation.getArgument(0);
        }).when(userAvatarFrameRepository).saveAndFlush(any());

        int numThreads = 2;
        ExecutorService executor = Executors.newFixedThreadPool(numThreads);
        CountDownLatch startLatch = new CountDownLatch(1);
        CountDownLatch finishLatch = new CountDownLatch(numThreads);

        AtomicInteger successCount = new AtomicInteger(0);
        AtomicInteger conflictCount = new AtomicInteger(0);

        executor.submit(() -> {
            try {
                startLatch.await();
                avatarFrameService.equipFrame(1L, "frame_a");
                successCount.incrementAndGet();
            } catch (ResponseStatusException rse) {
                if (rse.getStatusCode().value() == 409) {
                    conflictCount.incrementAndGet();
                }
            } catch (Exception ignored) {
            } finally {
                finishLatch.countDown();
            }
        });

        executor.submit(() -> {
            try {
                startLatch.await();
                avatarFrameService.equipFrame(1L, "frame_b");
                successCount.incrementAndGet();
            } catch (ResponseStatusException rse) {
                if (rse.getStatusCode().value() == 409) {
                    conflictCount.incrementAndGet();
                }
            } catch (Exception ignored) {
            } finally {
                finishLatch.countDown();
            }
        });

        startLatch.countDown();
        boolean completed = finishLatch.await(5, TimeUnit.SECONDS);
        executor.shutdown();

        assertThat(completed).isTrue();
        // Exactly one equip operation succeeds and concurrent conflict is safely isolated as 409 Conflict
        assertThat(successCount.get()).isEqualTo(1);
        assertThat(conflictCount.get()).isEqualTo(1);
    }
}
