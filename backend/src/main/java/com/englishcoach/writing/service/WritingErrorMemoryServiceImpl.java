package com.englishcoach.writing.service;

import com.englishcoach.writing.dto.ErrorMemoryDto;
import com.englishcoach.writing.dto.ErrorOccurrenceDto;
import com.englishcoach.writing.entity.WritingAssessmentEntity;
import com.englishcoach.writing.entity.WritingErrorMemoryEntity;
import com.englishcoach.writing.entity.WritingFeedbackIssueEntity;
import com.englishcoach.writing.entity.WritingLearningEvidenceEntity;
import com.englishcoach.writing.entity.WritingSubmissionEntity;
import com.englishcoach.writing.enums.EvidenceType;
import com.englishcoach.writing.enums.IssueDisposition;
import com.englishcoach.writing.exception.WritingNotFoundException;
import com.englishcoach.writing.repository.WritingAssessmentRepository;
import com.englishcoach.writing.repository.WritingErrorMemoryRepository;
import com.englishcoach.writing.repository.WritingFeedbackIssueRepository;
import com.englishcoach.writing.repository.WritingLearningEvidenceRepository;
import com.englishcoach.writing.repository.WritingSubmissionRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.*;

@Slf4j
@Service
public class WritingErrorMemoryServiceImpl implements WritingErrorMemoryService {

    private final WritingErrorMemoryRepository errorMemoryRepository;
    private final WritingLearningEvidenceRepository learningEvidenceRepository;
    private final WritingFeedbackIssueRepository issueRepository;
    private final WritingAssessmentRepository assessmentRepository;
    private final WritingSubmissionRepository submissionRepository;
    private final WritingCatalogService catalogService;

    @org.springframework.beans.factory.annotation.Autowired
    public WritingErrorMemoryServiceImpl(
            WritingErrorMemoryRepository errorMemoryRepository,
            WritingLearningEvidenceRepository learningEvidenceRepository,
            WritingFeedbackIssueRepository issueRepository,
            WritingAssessmentRepository assessmentRepository,
            WritingSubmissionRepository submissionRepository,
            WritingCatalogService catalogService) {
        this.errorMemoryRepository = errorMemoryRepository;
        this.learningEvidenceRepository = learningEvidenceRepository;
        this.issueRepository = issueRepository;
        this.assessmentRepository = assessmentRepository;
        this.submissionRepository = submissionRepository;
        this.catalogService = catalogService;
    }

    public WritingErrorMemoryServiceImpl(
            WritingErrorMemoryRepository errorMemoryRepository,
            WritingLearningEvidenceRepository learningEvidenceRepository,
            WritingFeedbackIssueRepository issueRepository,
            WritingCatalogService catalogService) {
        this(errorMemoryRepository, learningEvidenceRepository, issueRepository, null, null, catalogService);
    }

    @Override
    @Transactional
    public void recordMistakeObservation(Long userId, String sourceAssessmentId, String sourceIssueId, String patternCode, String contextId) {
        if (patternCode == null || patternCode.isBlank()) {
            return;
        }

        // Deduplicate: same assessment and pattern code must not increment occurrences multiple times
        if (sourceAssessmentId != null && learningEvidenceRepository.existsBySourceAssessmentIdAndPatternCode(sourceAssessmentId, patternCode)) {
            log.info("Skipping duplicate mistake observation for pattern {} in assessment {}", patternCode, sourceAssessmentId);
            return;
        }

        // 1. Record immutable evidence
        WritingLearningEvidenceEntity evidence = WritingLearningEvidenceEntity.builder()
                .id(UUID.randomUUID().toString())
                .userId(userId)
                .sourceAssessmentId(sourceAssessmentId)
                .sourceIssueId(sourceIssueId)
                .patternCode(patternCode)
                .evidenceType(EvidenceType.INDEPENDENT_CHECK)
                .isPositive(false)
                .weight(1.0)
                .contextId(contextId != null ? contextId : UUID.randomUUID().toString())
                .build();
        learningEvidenceRepository.save(evidence);

        // 2. Rebuild / update projection
        rebuildMemoryProjection(userId, patternCode);
    }

    @Override
    @Transactional
    public void recordPracticeOutcome(Long userId, String practiceId, String patternCode, boolean isSuccess, boolean assisted, String contextId) {
        if (patternCode == null || patternCode.isBlank()) {
            return;
        }

        EvidenceType type = isSuccess
                ? (assisted ? EvidenceType.ASSISTED_REPAIR : EvidenceType.PRACTICE_SUCCESS)
                : EvidenceType.PRACTICE_FAILURE;

        double weight = isSuccess ? (assisted ? 0.5 : 1.0) : 1.0;

        WritingLearningEvidenceEntity evidence = WritingLearningEvidenceEntity.builder()
                .id(UUID.randomUUID().toString())
                .userId(userId)
                .sourcePracticeId(practiceId)
                .patternCode(patternCode)
                .evidenceType(type)
                .isPositive(isSuccess)
                .weight(weight)
                .contextId(contextId != null ? contextId : practiceId)
                .build();
        learningEvidenceRepository.save(evidence);

        rebuildMemoryProjection(userId, patternCode);
    }

    @Override
    @Transactional(readOnly = true)
    public List<ErrorMemoryDto> getMyMistakes(Long userId) {
        List<WritingErrorMemoryEntity> entities = errorMemoryRepository.findByUserIdOrderByLastSeenAtDesc(userId);
        if (entities.isEmpty()) {
            return Collections.emptyList();
        }

        // Fetch all learning evidence for this user once
        List<WritingLearningEvidenceEntity> allEvidence = learningEvidenceRepository.findByUserIdOrderByRecordedAtDesc(userId);

        // Group evidence by patternCode
        Map<String, List<WritingLearningEvidenceEntity>> evidenceByPattern = new LinkedHashMap<>();
        Set<String> allIssueIds = new HashSet<>();
        for (WritingLearningEvidenceEntity ev : allEvidence) {
            if (ev.getPatternCode() != null) {
                evidenceByPattern.computeIfAbsent(ev.getPatternCode(), k -> new ArrayList<>()).add(ev);
            }
            if (ev.getSourceIssueId() != null) {
                allIssueIds.add(ev.getSourceIssueId());
            }
        }

        // Batch fetch issues, assessments, submissions
        Map<String, WritingFeedbackIssueEntity> issueMap = new HashMap<>();
        Map<String, WritingAssessmentEntity> assessmentMap = new HashMap<>();
        Map<String, WritingSubmissionEntity> submissionMap = new HashMap<>();

        if (!allIssueIds.isEmpty() && issueRepository != null) {
            List<WritingFeedbackIssueEntity> issues = issueRepository.findAllById(allIssueIds);
            Set<String> assessmentIds = new HashSet<>();
            for (WritingFeedbackIssueEntity issue : issues) {
                issueMap.put(issue.getId(), issue);
                if (issue.getAssessmentId() != null) {
                    assessmentIds.add(issue.getAssessmentId());
                }
            }

            if (!assessmentIds.isEmpty() && assessmentRepository != null) {
                List<WritingAssessmentEntity> assessments = assessmentRepository.findAllById(assessmentIds);
                Set<String> submissionIds = new HashSet<>();
                for (WritingAssessmentEntity a : assessments) {
                    assessmentMap.put(a.getId(), a);
                    if (a.getSubmissionId() != null) {
                        submissionIds.add(a.getSubmissionId());
                    }
                }

                if (!submissionIds.isEmpty() && submissionRepository != null) {
                    List<WritingSubmissionEntity> submissions = submissionRepository.findAllById(submissionIds);
                    for (WritingSubmissionEntity s : submissions) {
                        submissionMap.put(s.getId(), s);
                    }
                }
            }
        }

        List<ErrorMemoryDto> dtos = new ArrayList<>();
        for (WritingErrorMemoryEntity e : entities) {
            List<WritingLearningEvidenceEntity> pEvidence = evidenceByPattern.getOrDefault(e.getPatternCode(), Collections.emptyList());
            List<ErrorOccurrenceDto> occurrences = buildOccurrences(pEvidence, issueMap, assessmentMap, submissionMap);
            ErrorMemoryDto dto = mapToDto(e);
            dto.setOccurrences(occurrences);
            dto.setTeachingRule(resolveTeachingRule(dto.getTeachingRule(), occurrences));
            dtos.add(dto);
        }
        return dtos;
    }

    @Override
    @Transactional(readOnly = true)
    public Optional<ErrorMemoryDto> findMistakeByPattern(Long userId, String patternCode) {
        return errorMemoryRepository.findByUserIdAndPatternCode(userId, patternCode)
                .map(entity -> {
                    ErrorMemoryDto dto = mapToDto(entity);
                    List<WritingLearningEvidenceEntity> evidenceList = learningEvidenceRepository.findByUserIdAndPatternCodeOrderByRecordedAtDesc(userId, patternCode);
                    Set<String> issueIds = new HashSet<>();
                    for (WritingLearningEvidenceEntity ev : evidenceList) {
                        if (ev.getSourceIssueId() != null) {
                            issueIds.add(ev.getSourceIssueId());
                        }
                    }
                    Map<String, WritingFeedbackIssueEntity> issueMap = new HashMap<>();
                    Map<String, WritingAssessmentEntity> assessmentMap = new HashMap<>();
                    Map<String, WritingSubmissionEntity> submissionMap = new HashMap<>();
                    if (!issueIds.isEmpty() && issueRepository != null) {
                        List<WritingFeedbackIssueEntity> issues = issueRepository.findAllById(issueIds);
                        Set<String> assessmentIds = new HashSet<>();
                        for (WritingFeedbackIssueEntity issue : issues) {
                            issueMap.put(issue.getId(), issue);
                            if (issue.getAssessmentId() != null) {
                                assessmentIds.add(issue.getAssessmentId());
                            }
                        }
                        if (!assessmentIds.isEmpty() && assessmentRepository != null) {
                            List<WritingAssessmentEntity> assessments = assessmentRepository.findAllById(assessmentIds);
                            Set<String> submissionIds = new HashSet<>();
                            for (WritingAssessmentEntity a : assessments) {
                                assessmentMap.put(a.getId(), a);
                                if (a.getSubmissionId() != null) {
                                    submissionIds.add(a.getSubmissionId());
                                }
                            }
                            if (!submissionIds.isEmpty() && submissionRepository != null) {
                                List<WritingSubmissionEntity> submissions = submissionRepository.findAllById(submissionIds);
                                for (WritingSubmissionEntity s : submissions) {
                                    submissionMap.put(s.getId(), s);
                                }
                            }
                        }
                    }
                    List<ErrorOccurrenceDto> occurrences = buildOccurrences(evidenceList, issueMap, assessmentMap, submissionMap);
                    dto.setOccurrences(occurrences);
                    dto.setTeachingRule(resolveTeachingRule(dto.getTeachingRule(), occurrences));
                    return dto;
                });
    }

    @Override
    @Transactional(readOnly = true)
    public ErrorMemoryDto getMistakeByPattern(Long userId, String patternCode) {
        return findMistakeByPattern(userId, patternCode)
                .orElseThrow(() -> new WritingNotFoundException("Error memory not found for pattern: " + patternCode));
    }

    @Override
    @Transactional
    public void setMuted(Long userId, String patternCode, boolean isMuted) {
        WritingErrorMemoryEntity entity = errorMemoryRepository.findByUserIdAndPatternCode(userId, patternCode)
                .orElseThrow(() -> new WritingNotFoundException("Error memory not found for pattern: " + patternCode));
        entity.setIsMuted(isMuted);
        errorMemoryRepository.save(entity);
    }

    @Override
    @Transactional
    public void disputeIssue(Long userId, String issueId, String reason) {
        WritingFeedbackIssueEntity issue = issueRepository.findById(issueId)
                .orElseThrow(() -> new WritingNotFoundException("Issue not found: " + issueId));

        boolean ownerVerified = false;
        var evidenceOpt = learningEvidenceRepository.findFirstBySourceIssueId(issueId);
        if (evidenceOpt.isPresent()) {
            if (evidenceOpt.get().getUserId().equals(userId)) {
                ownerVerified = true;
            }
        } else if (issue.getAssessmentId() != null) {
            var assessmentOpt = assessmentRepository.findById(issue.getAssessmentId());
            if (assessmentOpt.isPresent()) {
                var subOpt = submissionRepository.findById(assessmentOpt.get().getSubmissionId());
                if (subOpt.isPresent() && subOpt.get().getUserId().equals(userId)) {
                    ownerVerified = true;
                }
            }
        }

        if (!ownerVerified) {
            throw new WritingNotFoundException("Issue not found: " + issueId);
        }

        issue.setDisposition(IssueDisposition.DISPUTED);
        issueRepository.save(issue);

        // Record dispute retraction evidence
        if (issue.getPatternCode() != null) {
            WritingLearningEvidenceEntity retraction = WritingLearningEvidenceEntity.builder()
                    .id(UUID.randomUUID().toString())
                    .userId(userId)
                    .sourceIssueId(issueId)
                    .sourceAssessmentId(issue.getAssessmentId())
                    .patternCode(issue.getPatternCode())
                    .evidenceType(EvidenceType.RETRACTION)
                    .isPositive(true)
                    .weight(1.0)
                    .contextId(issue.getAssessmentId())
                    .build();
            learningEvidenceRepository.save(retraction);

            rebuildMemoryProjection(userId, issue.getPatternCode());
        }
    }

    private void rebuildMemoryProjection(Long userId, String patternCode) {
        List<WritingLearningEvidenceEntity> evidenceList = learningEvidenceRepository.findByUserIdAndPatternCodeOrderByRecordedAtDesc(userId, patternCode);

        // Filter out retracted evidence
        Set<String> retractedIssueIds = new HashSet<>();
        for (WritingLearningEvidenceEntity ev : evidenceList) {
            if (ev.getEvidenceType() == EvidenceType.RETRACTION && ev.getSourceIssueId() != null) {
                retractedIssueIds.add(ev.getSourceIssueId());
            }
        }

        int occurrenceCount = 0;
        Set<String> distinctContexts = new HashSet<>();
        double weightedSuccesses = 0.0;
        double weightedFailures = 0.0;
        Instant lastSeen = Instant.EPOCH;

        for (WritingLearningEvidenceEntity ev : evidenceList) {
            if (ev.getSourceIssueId() != null) {
                if (retractedIssueIds.contains(ev.getSourceIssueId())) {
                    continue; // Skip disputed observation
                }
                Optional<WritingFeedbackIssueEntity> issueOpt = issueRepository.findById(ev.getSourceIssueId());
                if (issueOpt.isEmpty() || issueOpt.get().getKind() != com.englishcoach.writing.enums.IssueKind.ERROR) {
                    continue; // Skip legacy issues that are not confirmed errors or lack provenance
                }
            } else if (!Boolean.TRUE.equals(ev.getIsPositive())) {
                // Negative evidence without a verified source issue lacks provenance; exclude from trusted mastery
                continue;
            }

            if (ev.getRecordedAt().isAfter(lastSeen)) {
                lastSeen = ev.getRecordedAt();
            }

            distinctContexts.add(ev.getContextId());

            if (Boolean.TRUE.equals(ev.getIsPositive())) {
                weightedSuccesses += ev.getWeight();
            } else {
                weightedFailures += ev.getWeight();
                occurrenceCount++;
            }
        }

        int contextCount = distinctContexts.size();
        boolean hasSufficient = occurrenceCount >= 3 && contextCount >= 2 || (weightedSuccesses + weightedFailures >= 3);

        // Mastery calculation: 100 * (1 + successes) / (2 + successes + failures)
        int estimatedMastery = (int) Math.round(100.0 * (1.0 + weightedSuccesses) / (2.0 + weightedSuccesses + weightedFailures));
        estimatedMastery = Math.min(100, Math.max(0, estimatedMastery));

        // Adaptive interval calculation
        Instant nextDue;
        if (weightedSuccesses > weightedFailures) {
            long days = Math.min(30, (long) Math.pow(2, Math.min(5, (int) weightedSuccesses)));
            nextDue = Instant.now().plus(days, ChronoUnit.DAYS);
        } else {
            nextDue = Instant.now().plus(1, ChronoUnit.DAYS);
        }

        boolean dueForPractice = nextDue.isBefore(Instant.now().plusSeconds(60));

        // Lookup catalog metadata
        Map<String, Object> patternMeta = catalogService.getErrorPatternByCode(patternCode).orElse(Collections.emptyMap());
        String category = (String) patternMeta.getOrDefault("category", "Grammar");
        if (patternCode.toUpperCase().contains("CAPITALIZATION")) {
            category = "Capitalization";
        }
        String title = (String) patternMeta.getOrDefault("title", patternCode);

        WritingErrorMemoryEntity entity = errorMemoryRepository.findByUserIdAndPatternCode(userId, patternCode)
                .orElse(WritingErrorMemoryEntity.builder()
                        .id(UUID.randomUUID().toString())
                        .userId(userId)
                        .patternCode(patternCode)
                        .category(category)
                        .title(title)
                        .build());

        entity.setCategory(category);
        entity.setTitle(title);
        entity.setOccurrenceCount(occurrenceCount);
        entity.setContextCount(contextCount);
        entity.setLastSeenAt(lastSeen.isAfter(Instant.EPOCH) ? lastSeen : Instant.now());
        entity.setEstimatedMastery(estimatedMastery);
        entity.setHasSufficientEvidence(hasSufficient);
        entity.setDueForPractice(dueForPractice);
        entity.setNextPracticeDueAt(nextDue);

        errorMemoryRepository.save(entity);
        log.info("Rebuilt error memory for user {} pattern {}: mastery={}, occurrences={}", userId, patternCode, estimatedMastery, occurrenceCount);
    }

    private ErrorMemoryDto mapToDto(WritingErrorMemoryEntity entity) {
        Map<String, Object> meta = catalogService.getErrorPatternByCode(entity.getPatternCode()).orElse(Collections.emptyMap());
        String rule = (String) meta.getOrDefault("teachingRule", "");
        String defaultMode = (String) meta.getOrDefault("defaultPracticeMode", "REPAIR");
        String title = (String) meta.getOrDefault("title", entity.getTitle());
        title = resolveFriendlyTitle(entity.getPatternCode(), title);

        return ErrorMemoryDto.builder()
                .id(entity.getId())
                .patternCode(entity.getPatternCode())
                .category(entity.getCategory())
                .title(title)
                .occurrenceCount(entity.getOccurrenceCount())
                .contextCount(entity.getContextCount())
                .lastSeenAt(entity.getLastSeenAt())
                .estimatedMastery(entity.getEstimatedMastery())
                .hasSufficientEvidence(entity.getHasSufficientEvidence())
                .dueForPractice(entity.getDueForPractice())
                .nextPracticeDueAt(entity.getNextPracticeDueAt())
                .isMuted(entity.getIsMuted())
                .teachingRule(rule)
                .defaultPracticeMode(defaultMode)
                .build();
    }

    private String resolveFriendlyTitle(String patternCode, String rawTitle) {
        if (rawTitle != null && !rawTitle.isBlank() && !rawTitle.equalsIgnoreCase(patternCode)) {
            return rawTitle;
        }
        if (patternCode == null || patternCode.isBlank()) {
            return "Lỗi ngữ pháp cần lưu ý";
        }
        String lower = patternCode.toLowerCase().replace('_', ' ');
        return Character.toUpperCase(lower.charAt(0)) + lower.substring(1);
    }

    private String resolveTeachingRule(String catalogRule, List<ErrorOccurrenceDto> occurrences) {
        if (catalogRule != null && !catalogRule.isBlank()) {
            return catalogRule;
        }
        if (occurrences != null) {
            for (ErrorOccurrenceDto occ : occurrences) {
                if (occ.getTeachingRule() != null && !occ.getTeachingRule().isBlank()) {
                    return occ.getTeachingRule();
                }
            }
        }
        return "Cần chú ý đối chiếu ngữ pháp và ngữ cảnh câu khi viết.";
    }

    private List<ErrorOccurrenceDto> buildOccurrences(
            List<WritingLearningEvidenceEntity> evidenceList,
            Map<String, WritingFeedbackIssueEntity> issueMap,
            Map<String, WritingAssessmentEntity> assessmentMap,
            Map<String, WritingSubmissionEntity> submissionMap
    ) {
        List<ErrorOccurrenceDto> occurrences = new ArrayList<>();
        Set<String> seenIssueIds = new HashSet<>();

        for (WritingLearningEvidenceEntity ev : evidenceList) {
            if (ev.getEvidenceType() == EvidenceType.RETRACTION) {
                continue; // Skip retracted / disputed observations
            }
            if (Boolean.TRUE.equals(ev.getIsPositive())) {
                continue; // Only confirmed errors / negative evidence belong in error occurrences
            }

            if (ev.getSourceIssueId() != null) {
                if (seenIssueIds.contains(ev.getSourceIssueId())) {
                    continue; // Deduplicate within occurrence ledger
                }
                seenIssueIds.add(ev.getSourceIssueId());

                WritingFeedbackIssueEntity issue = issueMap != null ? issueMap.get(ev.getSourceIssueId()) : null;
                if (issue == null || issue.getKind() != com.englishcoach.writing.enums.IssueKind.ERROR) {
                    continue; // Only confirmed canonical errors
                }
                if (issue.getDisposition() == IssueDisposition.DISPUTED) {
                    continue; // Skip disputed issues
                }

                WritingAssessmentEntity assessment = (issue.getAssessmentId() != null && assessmentMap != null)
                        ? assessmentMap.get(issue.getAssessmentId())
                        : null;
                WritingSubmissionEntity submission = (assessment != null && assessment.getSubmissionId() != null && submissionMap != null)
                        ? submissionMap.get(assessment.getSubmissionId())
                        : null;

                String sourceFeature = "Sentence Lab";
                if (assessment != null && assessment.getOperation() != null) {
                    if (assessment.getOperation() == com.englishcoach.writing.enums.AssessmentOperation.SENTENCE_CHECK) {
                        sourceFeature = "Sentence Lab";
                    } else {
                        sourceFeature = "Writing Coach";
                    }
                }

                String originalText = (submission != null) ? submission.getContent() : null;
                String wrongSpan = issue.getSourceQuote();
                Integer startOffset = issue.getStartOffset();
                Integer endOffset = issue.getEndOffset();
                String replacement = issue.getReplacement();
                String correctedSentence = null;

                if (originalText != null && replacement != null && startOffset != null && endOffset != null
                        && startOffset >= 0 && endOffset <= originalText.length() && startOffset <= endOffset) {
                    correctedSentence = originalText.substring(0, startOffset) + replacement + originalText.substring(endOffset);
                } else if (originalText != null && replacement != null && wrongSpan != null && !wrongSpan.isBlank() && originalText.contains(wrongSpan)) {
                    correctedSentence = originalText.replace(wrongSpan, replacement);
                }

                occurrences.add(ErrorOccurrenceDto.builder()
                        .id(ev.getId())
                        .issueId(issue.getId())
                        .assessmentId(assessment != null ? assessment.getId() : null)
                        .submissionId(submission != null ? submission.getId() : null)
                        .patternCode(ev.getPatternCode())
                        .title(issue.getTitle())
                        .sourceFeature(sourceFeature)
                        .originalText(originalText)
                        .wrongSpan(wrongSpan)
                        .startOffset(startOffset)
                        .endOffset(endOffset)
                        .replacement(replacement)
                        .correctedSentence(correctedSentence)
                        .explanation(issue.getExplanation())
                        .teachingRule(issue.getTeachingRule())
                        .category(issue.getCategory())
                        .severity(issue.getSeverity() != null ? issue.getSeverity().name() : null)
                        .recordedAt(ev.getRecordedAt() != null ? ev.getRecordedAt() : issue.getCreatedAt())
                        .build());
            } else {
                // Historical / legacy observation without detailed issue
                occurrences.add(ErrorOccurrenceDto.builder()
                        .id(ev.getId())
                        .patternCode(ev.getPatternCode())
                        .sourceFeature("Writing")
                        .recordedAt(ev.getRecordedAt())
                        .build());
            }
        }
        return occurrences;
    }
}

