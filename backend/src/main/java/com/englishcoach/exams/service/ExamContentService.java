package com.englishcoach.exams.service;

import com.englishcoach.exams.model.ExamContentRecords.*;
import com.englishcoach.exams.model.ExamTypes.*;
import com.englishcoach.exams.repository.ExamContentRepository;
import com.englishcoach.exams.validation.ExamContentValidationService;
import com.englishcoach.exams.validation.ExamFormValidationReport;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.*;

@Slf4j
@Service
public class ExamContentService {

    private final ExamContentRepository contentRepository;
    private final com.englishcoach.exams.config.ExamsProperties examsProperties;
    private final ExamContentValidationService validationService;
    private final ExamRightsService rightsService;

    @org.springframework.beans.factory.annotation.Autowired
    public ExamContentService(ExamContentRepository contentRepository, com.englishcoach.exams.config.ExamsProperties examsProperties,
                              ExamContentValidationService validationService, ExamRightsService rightsService) {
        this.contentRepository = contentRepository;
        this.examsProperties = examsProperties;
        this.validationService = validationService;
        this.rightsService = rightsService;
    }

    public ExamContentService(ExamContentRepository contentRepository, com.englishcoach.exams.config.ExamsProperties examsProperties,
                              ExamContentValidationService validationService) {
        this(contentRepository, examsProperties, validationService, null);
    }

    @Transactional(readOnly = true)
    public List<CatalogFormDto> getCatalog(ExamFamily family, String variant, String scope, int limit, int offset) {
        return getCatalog(family, variant, scope, limit, offset, !examsProperties.isStrictMode());
    }

    @Transactional(readOnly = true)
    public List<CatalogFormDto> getCatalog(ExamFamily family, String variant, String scope, int limit, int offset, boolean allowPilot) {
        int safeLimit = Math.min(Math.max(limit, 1), 50);
        int safeOffset = Math.max(offset, 0);
        return assembleCatalog(contentRepository.findPublishedCatalogForms(family, variant, scope, safeLimit, safeOffset, allowPilot));
    }

    /** Filters before the learner window. Legacy callers retain the original array/page contract. */
    @Transactional(readOnly = true)
    public CatalogWindow getCatalogWindow(ExamFamily family, String variant, String scope, int limit, int offset,
                                          boolean allowPilot, String availability, String query, UUID formId) {
        String mode = availability == null ? "USABLE" : availability.toUpperCase(Locale.ROOT);
        if (!Set.of("USABLE", "ALL", "SIMULATION", "PRACTICE", "BLOCKED").contains(mode))
            throw new org.springframework.web.server.ResponseStatusException(org.springframework.http.HttpStatus.BAD_REQUEST, "Invalid availability");
        String search = query == null ? "" : query.trim().toLowerCase(Locale.ROOT);
        if (search.length() > 200) throw new org.springframework.web.server.ResponseStatusException(org.springframework.http.HttpStatus.BAD_REQUEST, "Search too long");
        List<CatalogFormDto> matches = new ArrayList<>();
        Set<String> variants = new TreeSet<>();
        long began = System.nanoTime(), metadataNs = 0, availabilityNs = 0;
        // Exhaust metadata in bounded batches: no arbitrary cap can silently hide later usable/search matches.
        for (int cursor = 0; ; cursor += 128) {
            long phase = System.nanoTime();
            var metadata = contentRepository.findPublishedCatalogForms(family, null, scope, 128, cursor, allowPilot);
            metadataNs += System.nanoTime() - phase;
            for (var form : metadata) if (form.variant() != null) variants.add(form.variant());
            var candidates = metadata.stream().filter(f -> formId == null || formId.equals(f.id())).filter(f -> variant == null || variant.isBlank() || variant.equalsIgnoreCase(f.variant()))
                    .filter(f -> Arrays.stream(search.split("\\s+")).allMatch(token ->
                            (f.title() + " " + Objects.toString(f.collectionTitle(), "")).toLowerCase(Locale.ROOT).contains(token))).toList();
            phase = System.nanoTime();
            for (var form : assembleCatalog(candidates)) {
                boolean simulation = form.availableModes().contains("EXAM_SIMULATION");
                boolean practice = !form.practiceScopeCodes().isEmpty();
                boolean include = switch (mode) {
                    case "ALL" -> true;
                    case "SIMULATION" -> simulation;
                    case "PRACTICE" -> practice;
                    case "BLOCKED" -> !simulation && !practice;
                    default -> simulation || practice;
                };
                if (include) matches.add(form);
            }
            availabilityNs += System.nanoTime() - phase;
            if (metadata.size() < 128) break;
        }
        // Stable metadata order within the existing simulation/practice/blocked priority.
        matches.sort(Comparator.comparingInt(f -> f.availableModes().contains("EXAM_SIMULATION") ? 0 : !f.practiceScopeCodes().isEmpty() ? 1 : 2));
        int from = Math.min(Math.max(offset, 0), matches.size());
        int to = Math.min(from + Math.min(Math.max(limit, 1), 24), matches.size());
        if (System.nanoTime() - began >= 500_000_000L)
            log.info("[ExamsCatalogWindow] family={} metadataMs={} availabilityMs={} totalMs={} matched={} returned={}",
                    family, metadataNs / 1_000_000, availabilityNs / 1_000_000,
                    (System.nanoTime() - began) / 1_000_000, matches.size(), to - from);
        return new CatalogWindow(List.copyOf(matches.subList(from, to)), matches.size(), to < matches.size(), List.copyOf(variants),
                matches.stream().filter(f -> f.availableModes().contains("EXAM_SIMULATION")).count(),
                matches.stream().filter(f -> !f.practiceScopeCodes().isEmpty()).count());
    }

    public record CatalogWindow(List<CatalogFormDto> forms, int total, boolean hasMore, List<String> variants, long simulationCount, long practiceCount) {}

    private List<CatalogFormDto> assembleCatalog(List<CatalogFormDto> forms) {
        var ids = forms.stream().map(CatalogFormDto::id).toList();
        long began = System.nanoTime();
        var summaries = validationService.catalogSummaries(ids);
        long summaryAt = System.nanoTime();
        var scopeCandidates = ids.stream().filter(id -> summaries.containsKey(id)
                && !summaries.get(id).practiceScopeCodes().isEmpty()).toList();
        var rights = rightsService == null || scopeCandidates.isEmpty() ? Map.<UUID, Boolean>of() : rightsService.verifyFormRightsBatch(scopeCandidates);
        if (System.nanoTime() - began >= 500_000_000L)
            log.info("[ExamsCatalogAssembly] forms={} structuralMs={} rightsMs={}", ids.size(),
                    (summaryAt - began) / 1_000_000, (System.nanoTime() - summaryAt) / 1_000_000);
        return forms.stream().map(f -> {
            var summary = summaries.get(f.id());
            if (summary == null) return f.withValidation(List.of(), List.of(), false, true, List.of(), "UNKNOWN")
                    .withPracticeScopes(List.of());
            return f.withValidation(summary.practiceSkills(), summary.simulationSkills(), summary.fullSimulationEligible(),
                    summary.contentReviewRequired(), summary.availableModes(), summary.validationStatus())
                    .withPracticeScopes(Boolean.TRUE.equals(rights.get(f.id()))
                            && (f.state() == LifecycleState.PUBLISHED || f.state() == LifecycleState.PILOT)
                            ? summary.practiceScopeCodes() : List.of());
        }).toList();
    }

    /**
     * Exams Phase 2: runnable skills, full-simulation availability, available modes and the review flag all
     * come from the authoritative ExamContentValidationService (unknown ⇒ nothing runnable). The form stays
     * listed (pagination is SQL-side) so the UI can explain why. Diagnostics never reach learners.
     */
    CatalogFormDto applyValidation(CatalogFormDto dto) {
        return applyValidation(dto, rightsService != null && rightsService.verifyFormRights(dto.id()));
    }

    private CatalogFormDto applyValidation(CatalogFormDto dto, boolean rights) {
        ExamFormValidationReport report = validationService.evaluate(dto.id());
        return dto.withValidation(
                ExamFormValidationReport.skillNames(report.practiceSkills()),
                ExamFormValidationReport.skillNames(report.simulationSkills()),
                report.fullSimulationEligible(),
                report.contentReviewRequired(),
                report.availableModes(),
                report.status().name()).withPracticeScopes(validationService.practiceScopes(dto.id(),
                        new com.englishcoach.exams.practice.ExamPracticeReadiness.FormFacts(
                                dto.state() == LifecycleState.PUBLISHED || dto.state() == LifecycleState.PILOT,
                                rights))
                        .stream().filter(com.englishcoach.exams.practice.ExamPracticeReadiness.ScopeReadiness::ready)
                        .map(s -> s.scope().scopeCode()).toList());
    }

    @Transactional(readOnly = true)
    public Optional<FormDetailDto> getFormDetails(UUID formId) {
        Optional<FormVersionRecord> formOpt = contentRepository.findFormById(formId);
        if (formOpt.isEmpty()) {
            return Optional.empty();
        }

        FormVersionRecord form = formOpt.get();
        if (!ExamLearnerProductPolicy.allows(form.family(), contentRepository.findSkillsByFormId(formId).stream()
                .map(SkillType::valueOf).toList())) return Optional.empty();
        boolean allowPilot = !examsProperties.isStrictMode();
        if (form.lifecycleState() != LifecycleState.PUBLISHED && (!allowPilot || form.lifecycleState() != LifecycleState.PILOT)) {
            log.warn("Attempt to access unpublished form: {}", formId);
            return Optional.empty();
        }

        List<SectionRecord> sections = contentRepository.findSectionsByFormId(formId);
        Map<UUID, Integer> sectionItemCounts = sections.isEmpty()
                ? Map.of()
                : contentRepository.findSectionItemCountsByFormId(formId);
        List<SectionSummaryDto> sectionSummaries = new ArrayList<>(sections.size());
        int totalDurationMinutes = 0;

        for (SectionRecord sec : sections) {
            int itemCount = sectionItemCounts.getOrDefault(sec.id(), 0);
            int secMinutes = sec.durationSeconds() / 60;
            totalDurationMinutes += secMinutes;
            sectionSummaries.add(new SectionSummaryDto(
                    sec.id(),
                    sec.skill(),
                    sec.ordinal(),
                    sec.specSectionKey(),
                    secMinutes,
                    itemCount
            ));
        }

        Optional<SpecificationVersionRecord> specOpt = contentRepository.findSpecificationById(form.specificationId());
        Map<String, Object> timingPolicy = specOpt.map(SpecificationVersionRecord::timingPolicy).orElse(Map.of());
        Map<String, Object> blueprint = specOpt.map(SpecificationVersionRecord::blueprint).orElse(Map.of());

        return Optional.of(new FormDetailDto(
                form.id(),
                form.logicalKey(),
                form.version(),
                form.title(),
                form.family(),
                form.variant(),
                form.scope(),
                form.logicalKey().startsWith("EC_ORIGINAL_") ? "EnglishCoach Original Practice" : "Practice Bank",
                totalDurationMinutes,
                sectionSummaries,
                timingPolicy,
                blueprint,
                true,
                form.logicalKey().startsWith("EC_ORIGINAL_") ? "EnglishCoach Original Practice - not an official exam" : "English Coach Practice Content"
        ));
    }

    @Transactional(readOnly = true)
    public Optional<FormVersionRecord> getFormById(UUID formId) {
        return contentRepository.findFormById(formId);
    }

    @Transactional(readOnly = true)
    public List<SectionRecord> getSectionsByFormId(UUID formId) {
        return contentRepository.findSectionsByFormId(formId);
    }

    @Transactional(readOnly = true)
    public List<PartRecord> getPartsBySectionId(UUID sectionId) {
        return contentRepository.findPartsBySectionId(sectionId);
    }

    @Transactional(readOnly = true)
    public List<GroupVersionRecord> getGroupsByPartId(UUID partId) {
        return contentRepository.findGroupsByPartId(partId);
    }

    @Transactional(readOnly = true)
    public List<ItemVersionRecord> getItemsByGroupId(UUID groupId) {
        return contentRepository.findItemsByGroupId(groupId);
    }

    @Transactional(readOnly = true)
    public List<StimulusVersionRecord> getStimuliByGroupId(UUID groupId) {
        return contentRepository.findStimuliByGroupId(groupId);
    }

    @Transactional(readOnly = true)
    public Optional<AnswerSpecRecord> getAnswerSpecByItemId(UUID itemId) {
        return contentRepository.findAnswerSpecByItemId(itemId);
    }

    @Transactional(readOnly = true)
    public Map<UUID, AnswerSpecRecord> getAnswerSpecsByFormId(UUID formId) {
        return contentRepository.findAnswerSpecsByFormId(formId);
    }

    @Transactional(readOnly = true)
    public Optional<SpecificationVersionRecord> getSpecificationById(UUID specId) {
        return contentRepository.findSpecificationById(specId);
    }

    @Transactional(readOnly = true)
    public Optional<ScoringSchemeVersionRecord> getScoringSchemeById(UUID schemeId) {
        return contentRepository.findScoringSchemeById(schemeId);
    }

    @Transactional(readOnly = true)
    public List<com.englishcoach.exams.content.ExamContentPackage.AdminFormSummary> getAdminFormSummaries(
            ExamFamily family, String lifecycleState, int limit, int offset) {
        return contentRepository.findAdminFormSummaries(family, lifecycleState, limit, offset);
    }

    @Transactional(readOnly = true)
    public List<com.englishcoach.exams.content.ExamContentPackage.AdminSourceSummary> getAdminSourceSummaries(
            int limit, int offset) {
        return contentRepository.findAdminSourceSummaries(limit, offset);
    }
}
