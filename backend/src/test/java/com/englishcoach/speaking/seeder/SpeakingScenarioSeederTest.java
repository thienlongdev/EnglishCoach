package com.englishcoach.speaking.seeder;

import com.englishcoach.speaking.entity.SpeakingScenario;
import com.englishcoach.speaking.repository.SpeakingScenarioRepository;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class SpeakingScenarioSeederTest {

    @Mock
    private SpeakingScenarioRepository speakingScenarioRepository;

    @InjectMocks
    private SpeakingScenarioSeeder speakingScenarioSeeder;

    @Test
    @DisplayName("Seeder should insert default scenarios with full instructional contract when table is empty")
    void testSeederRunsWhenEmpty() {
        when(speakingScenarioRepository.count()).thenReturn(0L);

        speakingScenarioSeeder.run();

        @SuppressWarnings("unchecked")
        ArgumentCaptor<List<SpeakingScenario>> captor = ArgumentCaptor.forClass(List.class);
        verify(speakingScenarioRepository, times(1)).saveAll(captor.capture());

        List<SpeakingScenario> seeded = captor.getValue();
        assertThat(seeded).hasSize(4);

        SpeakingScenario hotel = seeded.get(0);
        assertThat(hotel.getTitle()).isEqualTo("Hotel Check-in & Room Preferences");
        assertThat(hotel.getSuccessCriteria()).isNotEmpty();
        assertThat(hotel.getCompletionConditions()).isNotBlank();
        assertThat(hotel.getEvaluationRubric()).isNotBlank();
        assertThat(hotel.getOptionalHints()).isNotEmpty();
    }

    @Test
    @DisplayName("Seeder should do nothing when table already has data")
    void testSeederSkipsWhenNotEmpty() {
        when(speakingScenarioRepository.count()).thenReturn(5L);

        speakingScenarioSeeder.run();

        verify(speakingScenarioRepository, never()).saveAll(any());
    }
}
