package com.englishcoach.learningpath;

import com.englishcoach.exams.model.ExamContentRecords.CatalogFormDto;
import com.englishcoach.exams.model.ExamTypes.ExamFamily;
import com.englishcoach.exams.practice.ExamPracticeRecords.PracticeResultDto;
import com.englishcoach.exams.practice.ExamPracticeService;
import com.englishcoach.exams.service.ExamContentService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.*;

/** {@link LearningExamPractice} over the Exams module's own learner catalog and practice result services. */
@Component
public class ExamPracticeAdapter implements LearningExamPractice {

    private static final Logger log = LoggerFactory.getLogger(ExamPracticeAdapter.class);
    /** The catalog answers at most 50 forms per page; two pages cover the published corpus of a family. */
    private static final int PAGE = 50, PAGES = 2;

    private final ExamContentService catalog;
    private final ExamPracticeService practice;

    private final com.englishcoach.exams.analytics.ExamLearnerAnalyticsService analytics;

    private final com.englishcoach.exams.repository.ExamProfileRepository profiles;

    public ExamPracticeAdapter(ExamContentService catalog, ExamPracticeService practice,
                               com.englishcoach.exams.analytics.ExamLearnerAnalyticsService analytics,
                               com.englishcoach.exams.repository.ExamProfileRepository profiles) {
        this.profiles = profiles;
        this.analytics = analytics;
        this.catalog = catalog;
        this.practice = practice;
    }

    @Override
    public List<Focus> recommendedFocus(long userId, String family) {
        if (!Set.of("IELTS", "TOEIC").contains(family)) return List.of();
        return focus(analytics.getAnalytics(userId, ExamFamily.fromString(family)).families().get(0));
    }

    private List<Focus> focus(com.englishcoach.exams.analytics.ExamAnalyticsRecords.FamilyAnalyticsDto data) {
        return data.recommendations().items().stream().filter(r -> "FOCUS".equals(r.kind()))
                .filter(r -> r.sampleAttempts() != null && r.sampleQuestions() != null)
                .map(r -> new Focus(r.scopeCode(), r.skill().name(), r.sampleAttempts(), r.sampleQuestions(), r.signal()))
                .limit(3).toList();
    }

    @Override
    public Signals signals(long userId, String family) {
        if (!Set.of("IELTS", "TOEIC").contains(family)) return LearningExamPractice.super.signals(userId, family);
        ExamFamily selected = ExamFamily.fromString(family);
        var data = analytics.getAnalytics(userId, selected).families().get(0);
        var recent = data.simulation().attempts();
        Map<String, Double> estimates = new LinkedHashMap<>();
        profiles.latestByMetric(userId, selected).forEach(row -> estimates.put(row.metric(), row.scoreValue()));
        return new Signals(focus(data), recent.isEmpty() ? null : recent.get(0).resultStatus(), estimates);
    }

    @Override
    public List<Scope> practiceScopes(String family) {
        ExamFamily fam;
        try {
            fam = ExamFamily.fromString(family);
        } catch (RuntimeException e) {
            return List.of();
        }
        List<Scope> out = new ArrayList<>();
        try {
            for (int page = 0; page < PAGES; page++) {
                List<CatalogFormDto> forms = catalog.getCatalog(fam, null, null, PAGE, page * PAGE);
                for (CatalogFormDto f : forms) {
                    if (f.practiceScopeCodes() == null || f.availableModes() == null || !f.availableModes().contains("PRACTICE")) continue;
                    for (String code : f.practiceScopeCodes()) out.add(new Scope(f.id(), fam.name(), code, f.title()));
                }
                if (forms.size() < PAGE) break;
            }
        } catch (RuntimeException e) {
            // no exam task today rather than a broken day plan
            log.warn("[LearningPath] exam practice catalog unavailable: {}", e.getClass().getSimpleName());
            return List.of();
        }
        return out;
    }

    @Override
    public Optional<Outcome> outcome(long userId, UUID attemptId) {
        try {
            PracticeResultDto r = practice.getResult(userId, attemptId);
            if (!"SUBMITTED".equals(r.completionStatus()) || r.total() == null || r.answered() == null) return Optional.empty();
            Integer pct = r.rawAccuracyPercent() == null ? null : (int) Math.round(r.rawAccuracyPercent());
            return Optional.of(new Outcome(r.answered(), r.total(), pct));
        } catch (RuntimeException e) {
            return Optional.empty();
        }
    }
}
