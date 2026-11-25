package com.englishcoach.echocoach.service;

import com.englishcoach.echocoach.dto.CreateSessionRequest;
import com.englishcoach.echocoach.dto.EchoCoachMessageDto;
import com.englishcoach.echocoach.dto.EchoCoachSessionDto;
import com.englishcoach.echocoach.dto.SaveMessagePairRequest;

import java.util.List;

public interface EchoCoachService {

    List<EchoCoachSessionDto> getRecentSessions(Long userId);

    EchoCoachSessionDto createSession(Long userId, CreateSessionRequest request);

    List<EchoCoachMessageDto> getSessionMessages(Long userId, Long sessionId);

    List<EchoCoachMessageDto> saveMessages(Long userId, Long sessionId, SaveMessagePairRequest request);

    void deleteSession(Long userId, Long sessionId);

    default boolean truncateLatestAssistantMessage(Long userId, Long sessionId, String spokenText) {
        return false;
    }
}
