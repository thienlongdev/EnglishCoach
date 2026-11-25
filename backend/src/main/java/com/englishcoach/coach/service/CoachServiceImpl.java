package com.englishcoach.coach.service;

import com.englishcoach.coach.dto.CreateLearningPlanRequest;
import com.englishcoach.coach.dto.LearningPlanResponse;
import com.englishcoach.coach.entity.LearningPlan;
import com.englishcoach.coach.repository.LearningPlanRepository;
import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.UserRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.web.client.RestTemplate;

import java.util.List;
import java.util.Map;

@Service
@RequiredArgsConstructor
@Slf4j
public class CoachServiceImpl implements CoachService {
    private final LearningPlanRepository learningPlanRepository;
    private final UserRepository userRepository;
    // bounded like every other AI client (ai.timeout.* defaults): a stalled AI worker must not hold this request thread
    // and its pooled database connection forever (capacity release 2026-10; the library default has no timeout at all)
    private final RestTemplate restTemplate = boundedRestTemplate();

    @Value("${ai.base-url}")
    private String aiBaseUrl;

    @Override
    public LearningPlanResponse createPlan(Long userId, CreateLearningPlanRequest request) {
        User user = userRepository.findById(userId).orElseThrow();

        log.info("Forwarding chat request to FastAPI at {}/api/v1/coach/plan", aiBaseUrl);

        Map<String, Object> aiRequest = Map.of(
                "user_id", userId.toString(),
                "current_level", request.currentLevel(),
                "target", request.target(),
                "daily_minutes", request.dailyMinutes(),
                "weaknesses", List.of());

        Map<String, Object> aiResponse = restTemplate.postForObject(
                aiBaseUrl + "/api/v1/coach/plan",
                aiRequest,
                Map.class);

        String summary = aiResponse != null && aiResponse.get("summary") != null ? (String) aiResponse.get("summary")
                : "No summary generated";

        List<String> weeklyPlan = aiResponse != null && aiResponse.get("weekly_plan") != null
                ? (List<String>) aiResponse.get("weekly_plan")
                : List.of();

        LearningPlan plan = LearningPlan.builder()
                .user(user)
                .currentLevel(request.currentLevel())
                .targetLevel(request.target())
                .planDetails(summary)
                .build();

        learningPlanRepository.save(plan);
        return new LearningPlanResponse(plan.getId().toString(), summary, weeklyPlan);
    }

    private static RestTemplate boundedRestTemplate() {
        SimpleClientHttpRequestFactory factory = new com.englishcoach.common.ai.AiServiceRequestFactory();
        factory.setConnectTimeout(10_000);
        factory.setReadTimeout(120_000);
        return new RestTemplate(factory);
    }
}
