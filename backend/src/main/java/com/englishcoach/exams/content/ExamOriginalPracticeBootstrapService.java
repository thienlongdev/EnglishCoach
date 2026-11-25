package com.englishcoach.exams.content;

import com.englishcoach.exams.config.ExamsProperties;
import com.englishcoach.exams.model.ExamTypes.LifecycleState;
import com.englishcoach.exams.practice.ExamPracticeReadiness;
import com.englishcoach.exams.practice.ExamPracticeService;
import com.englishcoach.exams.release.ExamRunnerCapabilities;
import com.englishcoach.exams.repository.ExamContentRepository;
import com.englishcoach.exams.validation.ExamContentTree;
import com.englishcoach.exams.validation.ExamFormValidator;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.*;

/** Fixed original pilot bank through the canonical importer; never publisher publication or a QA approval. */
@Service
@RequiredArgsConstructor
public class ExamOriginalPracticeBootstrapService {
    public static final List<String> PACKAGES = List.of("EC_ORIGINAL_IELTS_ACADEMIC_WRITING_20261006",
            "EC_ORIGINAL_IELTS_GT_WRITING_20261006", "EC_ORIGINAL_IELTS_SPEAKING_20261006",
            "EC_ORIGINAL_IELTS_LISTENING_20261006", "EC_ORIGINAL_IELTS_READING_20261006",
            "EC_ORIGINAL_TOEIC_LR_PRACTICE_20261006_V2");
    private final ObjectMapper mapper;
    private final ExamContentPackageImporter importer;
    private final ExamContentRepository repository;
    private final ExamPracticeService practice;
    private final ExamsProperties properties;

    public record BankPracticeReceipt(String packageId, UUID formId, String contentHash, List<String> scopes, boolean replay) {}

    @Transactional
    public BankPracticeReceipt releaseBankPractice(UUID formId, long actor) {
        if (properties.isStrictMode() || properties.getRuntimePolicy() != ExamsProperties.ExamRuntimePolicy.LOCAL_PRIVATE)
            throw new IllegalStateException("ORIGINAL_PILOT_POLICY_UNAVAILABLE");
        var edition = ExamBankOriginalPractice.require(formId);
        repository.lockPackageIdentity(edition.packageId(), 1);
        var imported = importer.findImport(edition.packageId(), 1).orElseThrow();
        if (!formId.equals(imported.formId()) || !edition.hash().equals(imported.contentHash()) || !"IMPORTED".equals(imported.status()))
            throw new IllegalStateException("BANK_PRACTICE_IMPORT_MISMATCH");
        var form = repository.findFormById(formId).orElseThrow();
        boolean replay = form.lifecycleState() == LifecycleState.PILOT;
        if (!replay) {
            if (form.lifecycleState() != LifecycleState.DRAFT) throw new IllegalStateException("BANK_PRACTICE_LIFECYCLE_INVALID");
            repository.updateFormLifecycle(formId, LifecycleState.PILOT, null, null);
            repository.insertAuditEvent(actor, "ORIGINAL_BANK_PRACTICE_RELEASED", "FORM_VERSION", formId.toString(),
                    null, form.contentHash(), "Owner Practice decision for snapshot 75da24d337c2; original English Coach content", null);
        }
        var scopes = practice.evaluateForm(formId).scopes().stream().filter(ExamPracticeReadiness.ScopeReadiness::ready)
                .map(scope -> scope.scope().scopeCode()).sorted().toList();
        if (scopes.isEmpty())
            throw new IllegalStateException("ORIGINAL_PRACTICE_RIGHTS_OR_RUNTIME_UNAVAILABLE");
        return new BankPracticeReceipt(edition.packageId(), formId, edition.hash(), scopes, replay);
    }

    @Transactional
    public List<ExamContentPackage.ImportResult> bootstrap(Long actor) throws Exception {
        if (actor == null || actor <= 0) throw new IllegalArgumentException("CONTENT_IMPORT_ACTOR_REQUIRED");
        // Preserve the existing pilot policy. This operation cannot enable a policy,
        // approve a licence or turn a pilot into a published simulation.
        if (properties.isStrictMode() || properties.getRuntimePolicy() != ExamsProperties.ExamRuntimePolicy.LOCAL_PRIVATE)
            throw new IllegalStateException("ORIGINAL_PILOT_POLICY_UNAVAILABLE");
        List<ExamContentPackage.ImportResult> results = new ArrayList<>();
        for (String key : PACKAGES) {
            ExamContentPackage pkg;
            try (var input = new ClassPathResource("exams/original-practice/" + key + ".json").getInputStream()) {
                pkg = mapper.readValue(input, ExamContentPackage.class);
            }
            if (pkg.sources().stream().anyMatch(s -> !"INTERNAL_ORIGINAL".equals(s.sourceType()))
                    || pkg.licenses().stream().anyMatch(l -> !"ORIGINAL".equals(l.provenanceCategory().name())))
                throw new IllegalStateException("ORIGINAL_CLOSURE_REQUIRED");
            var tree = ExamContentTree.fromPackage(pkg, mapper);
            var report = ExamFormValidator.validate(tree, mapper, Instant.now());
            var scopes = ExamPracticeReadiness.evaluate(tree, report, ExamRunnerCapabilities.CURRENT,
                    new ExamPracticeReadiness.FormFacts(true, true), mapper);
            if (scopes.isEmpty() || scopes.stream().anyMatch(s -> !s.ready()))
                throw new IllegalStateException("ORIGINAL_PRACTICE_CONTENT_UNAVAILABLE");
            var result = importer.importPackage(pkg, actor);
            var form = repository.findFormById(result.formId()).orElseThrow();
            if (form.lifecycleState() == LifecycleState.DRAFT) {
                repository.updateFormLifecycle(form.id(), LifecycleState.PILOT, null, null);
                repository.insertAuditEvent(actor, "ORIGINAL_PRACTICE_PILOT_PROMOTED", "FORM_VERSION",
                        form.id().toString(), null, form.contentHash(),
                        "Owner-authorized EnglishCoach Original practice pilot; no human QA or publisher approval claimed", null);
            }
            if (practice.evaluateForm(form.id()).scopes().stream().anyMatch(s -> !s.ready()))
                throw new IllegalStateException("ORIGINAL_PRACTICE_RIGHTS_OR_RUNTIME_UNAVAILABLE");
            results.add(result);
        }
        // This fixed correction supersedes only the exact original closure. Existing
        // attempts retain their immutable form and snapshots.
        ExamContentPackage previous;
        try (var input = new ClassPathResource("exams/original-practice/EC_ORIGINAL_TOEIC_LR_PRACTICE_20261006.json").getInputStream()) {
            previous = mapper.readValue(input, ExamContentPackage.class);
        }
        var old = repository.findFormById(previous.form().id());
        if (old.isPresent() && old.get().lifecycleState() != LifecycleState.RETIRED) {
            if (!Objects.equals(old.get().contentHash(), previous.form().contentHash())
                    || old.get().lifecycleState() != LifecycleState.PILOT)
                throw new IllegalStateException("ORIGINAL_SUCCESSOR_PREDECESSOR_MISMATCH");
            repository.updateFormLifecycle(old.get().id(), LifecycleState.RETIRED, null, Instant.now());
            repository.insertAuditEvent(actor, "ORIGINAL_PRACTICE_SUPERSEDED", "FORM_VERSION", old.get().id().toString(),
                    old.get().contentHash(), null, "Parking passage restored from original source after exact question, option and key agreement; immutable attempts preserved", null);
        }
        return List.copyOf(results);
    }
}
