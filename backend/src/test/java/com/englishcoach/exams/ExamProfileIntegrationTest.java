package com.englishcoach.exams;

import com.englishcoach.exams.model.ExamProfileRecords.IeltsProfileDto;
import com.englishcoach.exams.model.ExamProfileRecords.ProfileEvidenceRecord;
import com.englishcoach.exams.model.ExamProfileRecords.ToeicProfileDto;
import com.englishcoach.exams.model.ExamTypes.ExamFamily;
import com.englishcoach.exams.model.ExamTypes.ScoreMetric;
import com.englishcoach.exams.repository.ExamProfileRepository;
import com.englishcoach.exams.service.ExamProfileService;
import com.englishcoach.exams.service.ExamRecommendationService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/**
 * STEP-102: ExamProfileIntegrationTest
 * Tests Competency Profile assembly, family isolation, and evidence eligibility.
 */
@ExtendWith(MockitoExtension.class)
public class ExamProfileIntegrationTest {

    @Mock
    private ExamProfileRepository profileRepository;

    @Mock
    private ExamRecommendationService recommendationService;

    private ExamProfileService profileService;

    @BeforeEach
    void setUp() {
        profileService = new ExamProfileService(profileRepository, recommendationService);
    }

    private ProfileEvidenceRecord createEvidence(Long userId, ExamFamily family, ScoreMetric metric, double score) {
        return new ProfileEvidenceRecord(
                UUID.randomUUID(),
                userId,
                UUID.randomUUID(),
                UUID.randomUUID(),
                UUID.randomUUID(),
                family,
                metric.name(),
                "FULL",
                family.name() + "_ACADEMIC",
                Instant.now(),
                score,
                "FIRST_EXPOSURE",
                Map.of("confidence", "HIGH"),
                "ACCEPTED",
                Instant.now()
        );
    }

    @Test
    @DisplayName("Profile Invariant: IELTS and TOEIC evidence are strictly isolated")
    void testIeltsAndToeicIsolation() {
        Long userId = 1L;
        ProfileEvidenceRecord ieltsEv = createEvidence(userId, ExamFamily.IELTS, ScoreMetric.FULL_OVERALL, 7.5);

        when(profileRepository.findLatestEvidence(userId, ExamFamily.IELTS, ScoreMetric.FULL_OVERALL.name()))
                .thenReturn(Optional.of(ieltsEv));
        when(profileRepository.findBestEvidence(userId, ExamFamily.IELTS, ScoreMetric.FULL_OVERALL.name()))
                .thenReturn(Optional.of(ieltsEv));
        when(profileRepository.findEvidenceByUserAndMetric(userId, ExamFamily.IELTS, ScoreMetric.FULL_OVERALL.name()))
                .thenReturn(List.of(ieltsEv));
        when(profileRepository.findEvidenceByUserAndMetric(userId, ExamFamily.IELTS, ScoreMetric.LISTENING.name()))
                .thenReturn(List.of());
        when(profileRepository.findEvidenceByUserAndMetric(userId, ExamFamily.IELTS, ScoreMetric.READING.name()))
                .thenReturn(List.of());
        when(profileRepository.findEvidenceByUserAndMetric(userId, ExamFamily.IELTS, ScoreMetric.WRITING.name()))
                .thenReturn(List.of());
        when(profileRepository.findEvidenceByUserAndMetric(userId, ExamFamily.IELTS, ScoreMetric.SPEAKING.name()))
                .thenReturn(List.of());

        IeltsProfileDto ieltsProfile = profileService.getIeltsProfile(userId);
        assertNotNull(ieltsProfile);
        assertEquals(7.5, ieltsProfile.overall().latest());

        // IELTS profile queries only IELTS metrics, never TOEIC
        verify(profileRepository, never()).findEvidenceByUserAndMetric(userId, ExamFamily.TOEIC, ScoreMetric.LR_TOTAL.name());
    }

    @Test
    @DisplayName("Profile Invariant: TOEIC Profile has NO 4-skill Overall metric")
    void testToeicProfileHasNoFourSkillOverall() {
        Long userId = 1L;
        ProfileEvidenceRecord toeicLr = createEvidence(userId, ExamFamily.TOEIC, ScoreMetric.LR_TOTAL, 850.0);

        when(profileRepository.findLatestEvidence(userId, ExamFamily.TOEIC, ScoreMetric.LR_TOTAL.name()))
                .thenReturn(Optional.of(toeicLr));
        when(profileRepository.findBestEvidence(userId, ExamFamily.TOEIC, ScoreMetric.LR_TOTAL.name()))
                .thenReturn(Optional.of(toeicLr));
        when(profileRepository.findEvidenceByUserAndMetric(userId, ExamFamily.TOEIC, ScoreMetric.LR_TOTAL.name()))
                .thenReturn(List.of(toeicLr));
        when(profileRepository.findEvidenceByUserAndMetric(userId, ExamFamily.TOEIC, ScoreMetric.LISTENING.name()))
                .thenReturn(List.of());
        when(profileRepository.findEvidenceByUserAndMetric(userId, ExamFamily.TOEIC, ScoreMetric.READING.name()))
                .thenReturn(List.of());
        when(profileRepository.findEvidenceByUserAndMetric(userId, ExamFamily.TOEIC, ScoreMetric.SPEAKING.name()))
                .thenReturn(List.of());
        when(profileRepository.findEvidenceByUserAndMetric(userId, ExamFamily.TOEIC, ScoreMetric.WRITING.name()))
                .thenReturn(List.of());

        ToeicProfileDto toeicProfile = profileService.getToeicProfile(userId);
        assertNotNull(toeicProfile);
        assertEquals(850.0, toeicProfile.lrTotal().latest());

        // Invariant: Verify never queried FULL_OVERALL for TOEIC
        verify(profileRepository, never()).findEvidenceByUserAndMetric(userId, ExamFamily.TOEIC, ScoreMetric.FULL_OVERALL.name());
    }
}
