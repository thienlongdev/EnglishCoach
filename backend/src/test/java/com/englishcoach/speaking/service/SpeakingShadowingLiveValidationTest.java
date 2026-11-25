package com.englishcoach.speaking.service;

import com.englishcoach.speaking.dto.SpeakingShadowingUnitDto;
import com.englishcoach.speaking.repository.SpeakingShadowingUnitRepository;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest
@EnabledIfEnvironmentVariable(named = "RUN_LIVE_SHADOWING_VALIDATION", matches = "true")
class SpeakingShadowingLiveValidationTest {

    @Autowired private SpeakingShadowingUnitService unitService;
    @Autowired private SpeakingShadowingUnitRepository unitRepository;

    @Test
    void concurrentlyGeneratesIndependentMaterialsExactlyOnce() throws Exception {
        assertThat(unitRepository.findByMaterialIdAndGenerationVersionOrderBySequenceNumberAsc(11L, 3)).isEmpty();
        assertThat(unitRepository.findByMaterialIdAndGenerationVersionOrderBySequenceNumberAsc(12L, 3)).isEmpty();

        ExecutorService executor = Executors.newFixedThreadPool(3);
        CountDownLatch ready = new CountDownLatch(3);
        CountDownLatch start = new CountDownLatch(1);
        try {
            Callable<List<SpeakingShadowingUnitDto>> material12 = () -> {
                ready.countDown();
                start.await();
                return unitService.getOrGenerateUnits(12L, null);
            };
            Callable<List<SpeakingShadowingUnitDto>> material13 = () -> {
                ready.countDown();
                start.await();
                return unitService.getOrGenerateUnits(13L, null);
            };

            Future<List<SpeakingShadowingUnitDto>> request12A = executor.submit(material12);
            Future<List<SpeakingShadowingUnitDto>> request12B = executor.submit(material12);
            Future<List<SpeakingShadowingUnitDto>> request13 = executor.submit(material13);
            ready.await();
            start.countDown();

            List<SpeakingShadowingUnitDto> units12A = request12A.get();
            List<SpeakingShadowingUnitDto> units12B = request12B.get();
            List<SpeakingShadowingUnitDto> units13 = request13.get();

            assertThat(units12A).isNotEmpty();
            assertThat(units12B).extracting(SpeakingShadowingUnitDto::id)
                    .containsExactlyElementsOf(units12A.stream().map(SpeakingShadowingUnitDto::id).toList());
            assertThat(unitRepository.findByMaterialIdAndGenerationVersionOrderBySequenceNumberAsc(12L, 3))
                    .hasSameSizeAs(units12A);
            assertThat(units13).hasSize(198);
            int material13Tokens = units13.stream()
                    .mapToInt(unit -> unit.displayText().trim().split("\\s+").length)
                    .sum();
            assertThat(material13Tokens).isEqualTo(2_516);
            assertThat(unitRepository.findByMaterialIdAndGenerationVersionOrderBySequenceNumberAsc(11L, 3)).isEmpty();
        } finally {
            executor.shutdownNow();
        }
    }
}
