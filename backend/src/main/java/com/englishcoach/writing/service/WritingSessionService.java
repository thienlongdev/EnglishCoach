package com.englishcoach.writing.service;

import com.englishcoach.writing.dto.*;
import com.englishcoach.writing.enums.WritingSessionStage;

import java.util.List;
import java.util.Map;

public interface WritingSessionService {
    WritingCapabilitiesDto getCapabilities();
    WritingProfileDto getProfile(Long userId);
    WritingProfileDto updateProfile(Long userId, WritingProfileDto dto);
    List<Map<String, Object>> getTasks(String category, String level);
    WritingSessionDto createSession(Long userId, CreateSessionRequest request);
    WritingSessionDto getSession(Long userId, String sessionId);
    WritingSessionDto updateWorkingCopy(Long userId, String sessionId, UpdateWorkingCopyRequest request);
    WritingSessionDto advanceStage(Long userId, String sessionId, AdvanceStageRequest request);
    List<WritingSessionDto> listSessions(Long userId, WritingSessionStage stage, Boolean completed);
    void deleteSession(Long userId, String sessionId);
    PlanOrganizationResultDto organizePlan(Long userId, String sessionId);
    DocumentAssessmentResultDto submitDraft(Long userId, String sessionId, Long expectedRevision, String clientMutationId);
    DocumentAssessmentResultDto getAssessment(Long userId, String sessionId, String assessmentId);
    DraftComparisonResultDto compareDrafts(Long userId, String sessionId, String draft1Id, String draft2Id);
    WritingSessionDto completeSession(Long userId, String sessionId, CompleteSessionRequest request);
    WritingSessionDto setFavorite(Long userId, String sessionId, boolean isFavorite);
    List<PortfolioSummaryItemDto> getPortfolio(Long userId, String stateFilter, Boolean favoriteOnly);
    WritingSessionDetailDto getSessionDetail(Long userId, String sessionId);
    ForYouDashboardDto getForYou(Long userId);
}
