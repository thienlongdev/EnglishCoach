package com.englishcoach.ai.service;

import com.englishcoach.ai.dto.AiChatRequest;
import com.englishcoach.ai.dto.AiChatResponse;
import com.englishcoach.ai.dto.EchoAction;
import com.englishcoach.ai.dto.EchoCard;

import java.time.Instant;
import java.util.List;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

public interface AiChatService {
    AiChatResponse chat(Long userId, AiChatRequest request);
    void cancelStream(Long owner, String turnId);
    SseEmitter streamChat(Long userId, AiChatRequest request);

    interface VoiceStreamCallbacks {
        default void onStatus(String status) {}
        void onDelta(String delta);
        default void onCards(List<EchoCard> cards) {}
        default void onActions(List<EchoAction> actions) {}
        default void onComplete(AiChatResponse response) {}
        default void onError(int status, String code, String limitKind, Instant resetsAt) {}
    }

    default Runnable streamVoiceTurn(Long userId, AiChatRequest request, VoiceStreamCallbacks callbacks) {
        throw new UnsupportedOperationException("Voice stream not supported");
    }
}
