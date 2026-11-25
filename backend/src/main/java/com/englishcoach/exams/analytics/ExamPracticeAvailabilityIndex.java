package com.englishcoach.exams.analytics;

import com.englishcoach.exams.analytics.ExamLearnerAnalytics.AvailableScope;
import com.englishcoach.exams.model.ExamContentRecords.CatalogFormDto;
import com.englishcoach.exams.model.ExamTypes.ExamFamily;
import com.englishcoach.exams.practice.ExamPracticeRecords.PracticeCatalogDto;
import com.englishcoach.exams.practice.ExamPracticeRecords.PracticeScopeDto;
import com.englishcoach.exams.practice.ExamPracticeReadiness;
import com.englishcoach.exams.practice.ExamPracticeService;
import com.englishcoach.exams.service.ExamContentService;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Exams Phase 8 — which canonical practice scopes are AVAILABLE right now, per family. Server readiness is the only
 * authority: the learner catalog (Phase 2 validation decides PRACTICE mode) and then {@link ExamPracticeService#getCatalog}
 * per form (Phase 6 {@code ExamPracticeReadiness}, fail closed, rights + media + keys). CONTENT_IN_PROGRESS and
 * UNAVAILABLE scopes never enter the index, so a recommendation can never point at them.
 *
 * <p>Bounded: at most {@value #MAX_CATALOG_PAGES} catalog pages and {@value #MAX_FORMS} practice-capable forms per family;
 * per-form readiness is cached for {@link #TTL} (the same horizon as the validation cache). A form whose readiness cannot
 * be evaluated contributes nothing (fail closed). Read-only; no AI.
 */
@Slf4j
@Component
public class ExamPracticeAvailabilityIndex implements ExamLearnerAnalyticsService.AvailabilitySource {

    static final Duration TTL = Duration.ofMinutes(5);
    static final int MAX_FORMS = 40;
    static final int MAX_CATALOG_PAGES = 3;
    static final int PAGE_SIZE = 50;

    private final ExamContentService contentService;
    private final ExamPracticeService practiceService;
    private final Clock clock;
    private final Map<UUID, Cached> cache = new ConcurrentHashMap<>();

    private record Cached(Instant at, List<PracticeScopeDto> scopes) {}

    @org.springframework.beans.factory.annotation.Autowired
    public ExamPracticeAvailabilityIndex(ExamContentService contentService, ExamPracticeService practiceService) {
        this(contentService, practiceService, Clock.systemUTC());
    }

    ExamPracticeAvailabilityIndex(ExamContentService contentService, ExamPracticeService practiceService, Clock clock) {
        this.contentService = contentService;
        this.practiceService = practiceService;
        this.clock = clock;
    }

    @Override
    public List<AvailableScope> availableScopes(ExamFamily family) {
        List<CatalogFormDto> forms = new ArrayList<>();
        for (int page = 0; page < MAX_CATALOG_PAGES; page++) {
            List<CatalogFormDto> batch = contentService.getCatalog(family, null, null, PAGE_SIZE, page * PAGE_SIZE);
            forms.addAll(batch);
            if (batch.size() < PAGE_SIZE) break;
        }
        // Exact ready scopes must receive the bounded readiness budget before legacy whole-form practice.
        // The catalog summary is only a priority hint: getCatalog below still rechecks current scope readiness.
        forms.sort(Comparator.comparing((CatalogFormDto f) ->
                f.practiceScopeCodes() == null || f.practiceScopeCodes().isEmpty()));
        List<AvailableScope> out = new ArrayList<>();
        int evaluated = 0;
        for (CatalogFormDto form : forms) {
            if ((form.practiceScopeCodes() == null || form.practiceScopeCodes().isEmpty())
                    && (form.availableModes() == null || !form.availableModes().contains("PRACTICE"))) continue;
            if (evaluated++ >= MAX_FORMS) break;
            for (PracticeScopeDto s : scopes(form.id())) {
                if (!ExamPracticeReadiness.LearnerState.AVAILABLE.name().equals(s.availability())) continue;
                out.add(new AvailableScope(s.scopeCode(), s.scopeType(), s.skill(), s.number(), form.id(), form.title(),
                        s.objectiveScoring()));
            }
        }
        return out;
    }

    private List<PracticeScopeDto> scopes(UUID formId) {
        Instant now = clock.instant();
        Cached c = cache.get(formId);
        if (c != null && c.at().plus(TTL).isAfter(now)) return c.scopes();
        List<PracticeScopeDto> scopes;
        try {
            PracticeCatalogDto cat = practiceService.getCatalog(formId);
            scopes = cat == null || cat.scopes() == null ? List.of() : List.copyOf(cat.scopes());
        } catch (RuntimeException e) {
            log.warn("[ExamsAnalytics] practice readiness unavailable for form {}: {}", formId, e.getMessage());
            scopes = List.of();
        }
        cache.put(formId, new Cached(now, scopes));
        return scopes;
    }
}
