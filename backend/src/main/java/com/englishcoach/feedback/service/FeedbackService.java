package com.englishcoach.feedback.service;

import com.englishcoach.feedback.dto.*;

import java.util.List;

public interface FeedbackService {

    FeedbackThreadDto createThread(Long userId, CreateFeedbackRequest request);

    List<FeedbackThreadDto> getMyThreads(Long userId);

    FeedbackUnreadCountDto getMyUnreadCount(Long userId);

    FeedbackMessageDto userFollowUp(Long userId, Long threadId, FeedbackMessageRequest request);

    List<FeedbackThreadDto> getAdminInbox();

    FeedbackUnreadCountDto getAdminUnreadCount();

    FeedbackMessageDto adminReply(Long adminUserId, Long threadId, FeedbackMessageRequest request);

    FeedbackThreadDto closeThread(Long threadId);

    List<FeedbackMessageDto> getThreadMessages(Long userId, boolean isAdmin, Long threadId);
}
