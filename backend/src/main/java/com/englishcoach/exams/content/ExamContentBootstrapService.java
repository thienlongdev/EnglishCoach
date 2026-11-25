package com.englishcoach.exams.content;

import com.englishcoach.exams.config.ExamsProperties;
import com.englishcoach.exams.content.ExamContentPackage.ImportResult;
import com.englishcoach.exams.content.ExamContentPackage.ImportStatus;
import com.englishcoach.exams.content.ExamContentPackage.ValidationResult;
import com.englishcoach.exams.model.ExamTypes.LifecycleState;
import com.englishcoach.exams.repository.ExamContentRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.Builder;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.io.File;
import java.io.FileNotFoundException;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.*;

/**
 * Deterministic local content bootstrap service.
 * Imports canonical pilot content packages into PostgreSQL in canonical order.
 * Idempotent: re-running does not produce duplicate rows or data corruption.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ExamContentBootstrapService {

    public static final List<String> CANONICAL_PILOT_PACKAGES = List.of(
            // 1. Core IELTS skill components
            "IELTS/IELTS_SHARED_LISTENING_PILOT_001_V2.json",
            "IELTS/IELTS_ACAD_READING_PILOT_001_V2.json",
            "IELTS/IELTS_ACAD_WRITING_PILOT_001_V1.json",
            "IELTS/IELTS_GT_READING_PILOT_001_V1.json",
            "IELTS/IELTS_GT_WRITING_PILOT_001_V1.json",
            "IELTS/IELTS_SHARED_SPEAKING_PILOT_001_V1.json",

            // 2. Coordinated IELTS composite mocks (depend on the skill components)
            "IELTS/IELTS_ACAD_MOCK_PILOT_001_V1.json",
            "IELTS/IELTS_GT_MOCK_PILOT_001_V1.json",

            // 3. Core TOEIC skill components
            "TOEIC/TOEIC_LR_PILOT_001_V2.json",
            "TOEIC/TOEIC_SPEAKING_PILOT_001_V2.json",
            "TOEIC/TOEIC_WRITING_PILOT_001_V2.json",

            // 4. Coordinated TOEIC four-skill suite (depends on L&R, Speaking, Writing)
            "TOEIC/TOEIC_SUITE_PILOT_001_V1.json"
    );

    private final ExamContentRepository contentRepository;
    private final ExamContentPackageValidator validator;
    private final ExamContentPackageImporter importer;
    private final ExamsProperties examsProperties;
    private final ObjectMapper mapper;

    @Data
    @Builder
    public static class BootstrapSummary {
        private int totalPackages;
        private int newlyImported;
        private int alreadyImported;
        private int formsPromotedToPilot;
        private List<PackageBootstrapResult> results;
    }

    @Data
    @Builder
    public static class PackageBootstrapResult {
        private String packageFile;
        private String packageId;
        private int packageVersion;
        private String contentHash;
        private UUID formId;
        private ImportStatus status;
        private boolean idempotentReplay;
        private LifecycleState lifecycleState;
    }

    public BootstrapSummary bootstrapCanonicalPackages(Long actorId) throws Exception {
        Long effectiveActor = (actorId != null && actorId > 0) ? actorId : 10L; // Default EXAMS_AUTHOR
        Path contentDir = resolveContentDirectory();
        log.info("Starting deterministic exam content bootstrap from: {}", contentDir);

        List<PackageBootstrapResult> results = new ArrayList<>();
        int newlyImported = 0;
        int alreadyImported = 0;
        int promotedToPilot = 0;

        for (String relPath : CANONICAL_PILOT_PACKAGES) {
            File file = contentDir.resolve(relPath).toFile();
            if (!file.exists()) {
                throw new FileNotFoundException("Canonical package file missing: " + file.getAbsolutePath());
            }

            ExamContentPackage pkg = mapper.readValue(file, ExamContentPackage.class);
            log.info("Validating package: {} [id={}, ver={}, declaredHash={}]", relPath, pkg.manifest().packageId(), pkg.manifest().packageVersion(), pkg.manifest().contentHash());
            ValidationResult valResult = validator.validate(pkg);
            if (!valResult.valid()) {
                log.error("Package {} failed validation: {}", relPath, valResult.errors());
                throw new ExamContentPackageValidationException(valResult.errors());
            }

            ImportResult importResult = importer.importPackage(pkg, effectiveActor);
            if (importResult.status() == ImportStatus.IMPORTED) {
                newlyImported++;
                log.info("Imported package {} v{} (hash: {})", pkg.manifest().packageId(), pkg.manifest().packageVersion(), importResult.contentHash());
            } else {
                alreadyImported++;
                log.info("Package {} v{} already imported (idempotent replay, hash: {})", pkg.manifest().packageId(), pkg.manifest().packageVersion(), importResult.contentHash());
            }

            // In local/internal environment (non-strict mode), promote DRAFT to PILOT
            LifecycleState currentState = pkg.form().lifecycleState();
            if (!examsProperties.isStrictMode()) {
                contentRepository.updateFormLifecycle(pkg.form().id(), LifecycleState.PILOT, null, null);
                currentState = LifecycleState.PILOT;
                promotedToPilot++;
                contentRepository.insertAuditEvent(effectiveActor, "LOCAL_BOOTSTRAP_PILOT_PROMOTED", "FORM_VERSION",
                        pkg.form().id().toString(), null, pkg.form().contentHash(),
                        "Local bootstrap promoted form " + pkg.form().id() + " to PILOT for local simulation", null);
            }

            results.add(PackageBootstrapResult.builder()
                    .packageFile(relPath)
                    .packageId(pkg.manifest().packageId())
                    .packageVersion(pkg.manifest().packageVersion())
                    .contentHash(pkg.manifest().contentHash())
                    .formId(pkg.form().id())
                    .status(importResult.status())
                    .idempotentReplay(importResult.idempotentReplay())
                    .lifecycleState(currentState)
                    .build());
        }

        log.info("Deterministic bootstrap completed: {} total packages ({} new, {} existing, {} promoted to PILOT)",
                CANONICAL_PILOT_PACKAGES.size(), newlyImported, alreadyImported, promotedToPilot);

        return BootstrapSummary.builder()
                .totalPackages(CANONICAL_PILOT_PACKAGES.size())
                .newlyImported(newlyImported)
                .alreadyImported(alreadyImported)
                .formsPromotedToPilot(promotedToPilot)
                .results(results)
                .build();
    }

    public Path resolveContentDirectory() {
        String customDir = System.getProperty("EXAMS_CONTENT_DIR", System.getenv("EXAMS_CONTENT_DIR"));
        if (customDir != null && !customDir.isBlank()) {
            Path p = Paths.get(customDir);
            if (p.toFile().exists()) return p;
        }

        List<Path> candidates = List.of(
                Paths.get("..", "content", "exams", "original-pilot"),
                Paths.get("content", "exams", "original-pilot"),
                Paths.get("/app", "content", "exams", "original-pilot")
        );

        for (Path candidate : candidates) {
            if (candidate.toFile().exists()) {
                try {
                    return candidate.toRealPath();
                } catch (Exception e) {
                    return candidate.toAbsolutePath();
                }
            }
        }

        throw new IllegalStateException("Cannot resolve exam content directory from working directory: " + Paths.get(".").toAbsolutePath());
    }
}
