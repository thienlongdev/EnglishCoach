package com.englishcoach.exams.service;

import com.englishcoach.exams.model.ExamProfileRecords.ProfileEvidenceRecord;
import com.englishcoach.exams.model.ExamProfileRecords.RecommendationDto;
import com.englishcoach.exams.model.ExamProfileRecords.RecommendationRecord;
import com.englishcoach.exams.model.ExamTypes.TrainingModule;
import com.englishcoach.exams.repository.ExamProfileRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.*;

@Slf4j
@Service
@RequiredArgsConstructor
public class ExamRecommendationService {

    private final ExamProfileRepository profileRepository;

    /**
     * Retrieve active recommendations for learner.
     * Maps training module enum to the application route (e.g. /listening).
     */
    public List<RecommendationDto> getUserRecommendations(Long userId) {
        List<RecommendationRecord> records = profileRepository.findRecommendationsByUserId(userId, 10);
        List<RecommendationDto> dtos = new ArrayList<>();

        for (RecommendationRecord r : records) {
            String handoffUrl = resolveHandoffUrl(r.trainingModule());
            dtos.add(new RecommendationDto(
                    r.id(),
                    r.evidenceId(),
                    r.diagnosticCode(),
                    r.trainingModule(),
                    r.targetId(),
                    r.reason(),
                    handoffUrl,
                    r.status(),
                    r.createdAt()
            ));
        }

        return dtos;
    }

    /**
     * Generate diagnostic recommendations from an attempt's profile evidence.
     * Architectural invariant:
     * - Recommendations are outbound suggestions to training modules.
     * - Training modules never write exam scores.
     * - Exams never read training scores as exam evidence.
     */
    public void generateDiagnostics(Long userId, List<ProfileEvidenceRecord> evidenceList) {
        if (evidenceList == null || evidenceList.isEmpty()) return;

        for (ProfileEvidenceRecord ev : evidenceList) {
            String metric = ev.metric();
            double score = ev.scoreValue();

            TrainingModule module = null;
            String diagnosticCode = null;
            String reason = null;

            if ("LISTENING".equalsIgnoreCase(metric) && score < 6.5) {
                module = TrainingModule.LISTENING;
                diagnosticCode = "IELTS_LISTENING_DETAIL";
                reason = "Targeted listening comprehension and dictation practice recommended to improve audio retention.";
            } else if ("READING".equalsIgnoreCase(metric) && score < 6.5) {
                module = TrainingModule.READING;
                diagnosticCode = "IELTS_READING_INFERENCE";
                reason = "Structured reading speed and paragraph inference drills recommended in Reading lab.";
            } else if ("WRITING".equalsIgnoreCase(metric) && score < 6.5) {
                module = TrainingModule.WRITING;
                diagnosticCode = "IELTS_WRITING_COHESION";
                reason = "Sentence framing and paragraph coherence exercises recommended in Writing Sentence Lab.";
            } else if ("SPEAKING".equalsIgnoreCase(metric) && score < 6.5) {
                module = TrainingModule.SPEAKING;
                diagnosticCode = "IELTS_SPEAKING_FLUENCY";
                reason = "Shadowing and pronunciation practice recommended in Speaking roleplay lab.";
            }

            if (module != null) {
                RecommendationRecord rec = new RecommendationRecord(
                        UUID.randomUUID(),
                        userId,
                        ev.id(),
                        diagnosticCode,
                        "v1",
                        module,
                        module.name().toLowerCase(),
                        reason,
                        "ACTIVE",
                        Instant.now()
                );
                profileRepository.insertRecommendation(rec);
            }
        }
    }

    private String resolveHandoffUrl(TrainingModule module) {
        if (module == null) return "/";
        return switch (module) {
            case LISTENING -> "/listening";
            case READING -> "/reading";
            case WRITING -> "/writing";
            case SPEAKING -> "/speaking";
        };
    }
}
