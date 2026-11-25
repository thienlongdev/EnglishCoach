package com.englishcoach.community.service;

import com.englishcoach.community.dto.SharedLearningEmbedDto;
import com.englishcoach.community.entity.SharedEntityType;
import com.englishcoach.exams.model.ExamScoringRecords.ExamResultDto;
import com.englishcoach.exams.service.ExamResultService;
import com.englishcoach.flashcard.entity.VocabDeck;
import com.englishcoach.flashcard.repository.VocabDeckRepository;
import com.englishcoach.listening.entity.ListeningMaterial;
import com.englishcoach.listening.repository.ListeningMaterialRepository;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.HashMap;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

@Service
@RequiredArgsConstructor
@Slf4j
public class CommunityLearningValidationService {

    private final ListeningMaterialRepository listeningMaterialRepository;
    private final VocabDeckRepository vocabDeckRepository;
    private final ExamResultService examResultService;
    private final ObjectMapper objectMapper;

    /**
     * Validates that the entity exists, the user has authorization to share it,
     * and returns a safe snapshot DTO.
     */
    public SharedLearningEmbedDto validateAndBuildEmbed(
            SharedEntityType type,
            String entityId,
            Long userId,
            boolean isAdmin
    ) {
        if (type == null || entityId == null || entityId.isBlank()) {
            return null;
        }

        switch (type) {
            case LISTENING_MATERIAL: {
                try {
                    Long materialId = Long.parseLong(entityId.trim());
                    Optional<ListeningMaterial> matOpt = listeningMaterialRepository.findById(materialId);
                    if (matOpt.isEmpty()) {
                        throw new IllegalArgumentException("Không tìm thấy bài nghe được chia sẻ");
                    }
                    ListeningMaterial mat = matOpt.get();
                    if (!mat.isSystem() && !isAdmin && (mat.getOwnerUserId() == null || !mat.getOwnerUserId().equals(userId))) {
                        throw new IllegalArgumentException("Bạn không có quyền chia sẻ bài nghe riêng tư này");
                    }

                    Map<String, Object> metrics = new HashMap<>();
                    if (mat.getDurationSeconds() != null) {
                        metrics.put("durationSeconds", mat.getDurationSeconds());
                    }
                    if (mat.getChannel() != null) {
                        metrics.put("channel", mat.getChannel());
                    }
                    if (mat.getCefrLevel() != null) {
                        metrics.put("cefrLevel", mat.getCefrLevel());
                    }

                    return SharedLearningEmbedDto.builder()
                            .type(SharedEntityType.LISTENING_MATERIAL)
                            .entityId(String.valueOf(mat.getId()))
                            .title(mat.getTitle())
                            .description(mat.getTopic() != null ? mat.getTopic() : "Luyện nghe tiếng Anh")
                            .thumbnail(mat.getThumbnail())
                            .badge("Nghe")
                            .metrics(metrics)
                            .actionUrl("/listening/" + mat.getId())
                            .actionLabel("Luyện nghe ngay")
                            .build();
                } catch (NumberFormatException e) {
                    throw new IllegalArgumentException("Mã bài nghe không hợp lệ");
                }
            }

            case FLASHCARD_DECK: {
                try {
                    Long deckId = Long.parseLong(entityId.trim());
                    Optional<VocabDeck> deckOpt = vocabDeckRepository.findById(deckId);
                    if (deckOpt.isEmpty()) {
                        throw new IllegalArgumentException("Không tìm thấy bộ thẻ từ vựng");
                    }
                    VocabDeck deck = deckOpt.get();

                    Map<String, Object> metrics = new HashMap<>();
                    metrics.put("totalWords", deck.getTotalWords());
                    metrics.put("category", deck.getCategory());
                    metrics.put("themeColor", deck.getThemeColor());
                    metrics.put("icon", deck.getIcon());

                    return SharedLearningEmbedDto.builder()
                            .type(SharedEntityType.FLASHCARD_DECK)
                            .entityId(String.valueOf(deck.getId()))
                            .title(deck.getTitle())
                            .description(deck.getDescription())
                            .thumbnail(null)
                            .badge("Bộ từ vựng")
                            .metrics(metrics)
                            .actionUrl("/flashcards?deckId=" + deck.getId())
                            .actionLabel("Học bộ thẻ này")
                            .build();
                } catch (NumberFormatException e) {
                    throw new IllegalArgumentException("Mã bộ thẻ không hợp lệ");
                }
            }

            case EXAM_RESULT: {
                try {
                    UUID attemptId = UUID.fromString(entityId.trim());
                    Optional<ExamResultDto> resultOpt = examResultService.getAttemptResult(attemptId, userId, isAdmin);
                    if (resultOpt.isEmpty()) {
                        throw new IllegalArgumentException("Không tìm thấy kết quả thi thử hoặc chưa hoàn thành");
                    }
                    ExamResultDto res = resultOpt.get();

                    Map<String, Object> metrics = new HashMap<>();
                    if (res.overallScore() != null) {
                        metrics.put("overallScore", res.overallScore());
                    }
                    if (res.family() != null) {
                        metrics.put("family", res.family().name());
                    }
                    if (res.skillScores() != null) {
                        metrics.put("skillScores", res.skillScores());
                    }

                    String title = (res.family() != null ? res.family().name() : "Bài thi") + " Result";
                    String desc = res.overallScore() != null ? "Overall Band / Score: " + res.overallScore() : "Đã hoàn thành bài thi";

                    return SharedLearningEmbedDto.builder()
                            .type(SharedEntityType.EXAM_RESULT)
                            .entityId(attemptId.toString())
                            .title(title)
                            .description(desc)
                            .thumbnail(null)
                            .badge("Thi thử")
                            .metrics(metrics)
                            .actionUrl("/exams")
                            .actionLabel("Xem chi tiết")
                            .build();
                } catch (IllegalArgumentException e) {
                    throw new IllegalArgumentException("Mã bài thi thử không hợp lệ: " + e.getMessage());
                }
            }

            default:
                throw new IllegalArgumentException("Loại tài liệu học tập không được hỗ trợ");
        }
    }

    public String serializeEmbed(SharedLearningEmbedDto dto) {
        if (dto == null) {
            return null;
        }
        try {
            return objectMapper.writeValueAsString(dto);
        } catch (Exception e) {
            log.error("Failed to serialize learning embed: {}", e.getMessage());
            return null;
        }
    }

    public SharedLearningEmbedDto deserializeEmbed(String json) {
        if (json == null || json.isBlank()) {
            return null;
        }
        try {
            return objectMapper.readValue(json, SharedLearningEmbedDto.class);
        } catch (Exception e) {
            log.warn("Failed to deserialize learning embed: {}", e.getMessage());
            return null;
        }
    }
}
