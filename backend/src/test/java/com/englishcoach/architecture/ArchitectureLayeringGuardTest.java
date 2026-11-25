package com.englishcoach.architecture;

import com.englishcoach.exams.model.ExamContentRecords.AnswerSpecRecord;
import com.englishcoach.exams.service.ExamResultService;
import com.englishcoach.speaking.controller.SpeakingController;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import java.io.IOException;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Zero-dependency JUnit 5 architecture guardrails enforcing Wave 3 layering, cycle-breaking,
 * transaction annotation correctness, and controller-to-repository isolation.
 */
class ArchitectureLayeringGuardTest {

    private static final Path MAIN = Path.of("src/main/java");
    private static final Path ROOT_PKG = MAIN.resolve("com/englishcoach");

    private static final List<String> REMEDIATED_CONTROLLERS = List.of(
            "com/englishcoach/community/controller/CommunityAdminController.java",
            "com/englishcoach/flashcard/pvp/controller/CardBlastPvPController.java",
            "com/englishcoach/speaking/controller/SpeakingController.java",
            "com/englishcoach/spelling/SpellingController.java",
            "com/englishcoach/wordchain/WordChainController.java",
            "com/englishcoach/mocktest/controller/MockTestController.java",
            "com/englishcoach/vocabulary/controller/VocabularyController.java",
            "com/englishcoach/exams/controller/ExamAdminController.java",
            "com/englishcoach/exams/controller/ExamContentAdminController.java",
            "com/englishcoach/exams/measurement/controller/ExamMeasurementController.java"
    );

    private static final Pattern REPO_FIELD_OR_PARAM = Pattern.compile(
            "\\b([A-Za-z0-9_]*Repository|SpellingResults|WordChainResults)\\b"
    );

    private static List<Path> javaFiles(Path root) throws IOException {
        try (Stream<Path> s = Files.walk(root)) {
            return s.filter(p -> p.toString().endsWith(".java")).sorted().toList();
        }
    }

    /** Strips block comments, line comments, and string/char literal bodies while preserving newlines. */
    private static String stripCommentsAndStrings(String src) {
        StringBuilder out = new StringBuilder(src.length());
        int n = src.length();
        boolean inBlock = false;
        boolean inLine = false;
        boolean inString = false;
        boolean inTextBlock = false;
        boolean inChar = false;
        for (int i = 0; i < n; i++) {
            char c = src.charAt(i);
            char next = (i + 1 < n) ? src.charAt(i + 1) : '\0';
            if (inLine) {
                if (c == '\n') {
                    inLine = false;
                    out.append('\n');
                }
                continue;
            }
            if (inBlock) {
                if (c == '*' && next == '/') {
                    inBlock = false;
                    i++;
                } else if (c == '\n') {
                    out.append('\n');
                }
                continue;
            }
            if (inTextBlock) {
                if (c == '"' && next == '"' && i + 2 < n && src.charAt(i + 2) == '"') {
                    inTextBlock = false;
                    i += 2;
                    out.append("\"\"");
                } else if (c == '\n') {
                    out.append('\n');
                }
                continue;
            }
            if (inString) {
                if (c == '\\' && i + 1 < n) {
                    i++;
                } else if (c == '"') {
                    inString = false;
                    out.append('"');
                }
                continue;
            }
            if (inChar) {
                if (c == '\\' && i + 1 < n) {
                    i++;
                } else if (c == '\'') {
                    inChar = false;
                    out.append('\'');
                }
                continue;
            }
            if (c == '/' && next == '/') {
                inLine = true;
                i++;
                continue;
            }
            if (c == '/' && next == '*') {
                inBlock = true;
                i++;
                continue;
            }
            if (c == '"' && next == '"' && i + 2 < n && src.charAt(i + 2) == '"') {
                inTextBlock = true;
                i += 2;
                out.append('"');
                continue;
            }
            if (c == '"') {
                inString = true;
                out.append('"');
                continue;
            }
            if (c == '\'') {
                inChar = true;
                out.append('\'');
                continue;
            }
            out.append(c);
        }
        return out.toString();
    }

    @Test
    @DisplayName("Zero com.englishcoach.proficiency -> com.englishcoach.leaderboard imports or references")
    void proficiencyHasZeroLeaderboardDependencies() throws IOException {
        Path proficiencyDir = ROOT_PKG.resolve("proficiency");
        List<String> violations = new ArrayList<>();
        for (Path file : javaFiles(proficiencyDir)) {
            String code = stripCommentsAndStrings(Files.readString(file));
            if (code.contains("com.englishcoach.leaderboard.")) {
                violations.add(MAIN.relativize(file).toString());
            }
        }
        assertTrue(violations.isEmpty(),
                "com.englishcoach.proficiency must have 0 dependencies on com.englishcoach.leaderboard, found in: " + violations);
    }

    @Test
    @DisplayName("Zero com.englishcoach.learningpath -> com.englishcoach.ai imports or references")
    void learningPathHasZeroAiDependencies() throws IOException {
        Path learningPathDir = ROOT_PKG.resolve("learningpath");
        List<String> violations = new ArrayList<>();
        for (Path file : javaFiles(learningPathDir)) {
            String code = stripCommentsAndStrings(Files.readString(file));
            if (code.contains("com.englishcoach.ai.")) {
                violations.add(MAIN.relativize(file).toString());
            }
        }
        assertTrue(violations.isEmpty(),
                "com.englishcoach.learningpath must have 0 dependencies on com.englishcoach.ai, found in: " + violations);
    }

    @Test
    @DisplayName("Zero PremiumSubscriptionService -> PremiumEntitlementService dependency")
    void premiumSubscriptionServiceDoesNotDependOnEntitlementService() throws IOException {
        Path subService = ROOT_PKG.resolve("premium/service/PremiumSubscriptionService.java");
        String code = stripCommentsAndStrings(Files.readString(subService));
        assertFalse(code.contains("PremiumEntitlementService"),
                "PremiumSubscriptionService must not reference PremiumEntitlementService (must use leaf PremiumEntitlementCache)");
    }

    @Test
    @DisplayName("Zero @Transactional annotations placed on static methods across src/main/java")
    void noTransactionalOnStaticMethods() throws IOException {
        List<String> violations = new ArrayList<>();
        Pattern transactionalPattern = Pattern.compile("@(?:org\\.springframework\\.transaction\\.annotation\\.)?Transactional\\b");

        for (Path file : javaFiles(MAIN)) {
            String raw = Files.readString(file);
            if (!raw.contains("Transactional")) {
                continue;
            }
            String code = stripCommentsAndStrings(raw);
            Matcher m = transactionalPattern.matcher(code);
            while (m.find()) {
                int idx = m.end();
                // Skip optional annotation argument list: @Transactional(...)
                while (idx < code.length() && Character.isWhitespace(code.charAt(idx))) idx++;
                if (idx < code.length() && code.charAt(idx) == '(') {
                    int depth = 0;
                    while (idx < code.length()) {
                        char ch = code.charAt(idx++);
                        if (ch == '(') depth++;
                        else if (ch == ')') {
                            depth--;
                            if (depth == 0) break;
                        }
                    }
                }
                // Scan subsequent annotations and modifiers up to '{', ';', or '(' (method parameter list)
                StringBuilder header = new StringBuilder();
                while (idx < code.length()) {
                    char ch = code.charAt(idx++);
                    if (ch == '{' || ch == ';') {
                        header.setLength(0);
                        break;
                    }
                    if (ch == '(') {
                        // Distinguish another annotation's (...) from the method parameter list
                        String soFar = header.toString().trim();
                        if (soFar.matches("(?s).*@[A-Za-z0-9_$.]+$")) {
                            int depth = 1;
                            while (idx < code.length() && depth > 0) {
                                char inner = code.charAt(idx++);
                                if (inner == '(') depth++;
                                else if (inner == ')') depth--;
                            }
                            header.append(' ');
                            continue;
                        }
                        break;
                    }
                    header.append(ch);
                }
                String decl = header.toString();
                if (!decl.isBlank()
                        && !decl.matches("(?s).*\\b(class|interface|enum|record)\\b.*")
                        && decl.matches("(?s).*\\bstatic\\b.*")) {
                    violations.add(MAIN.relativize(file) + " -> " + decl.trim().replaceAll("\\s+", " "));
                }
            }
        }
        assertTrue(violations.isEmpty(),
                "@Transactional must never be placed on static methods, found: " + violations);

        // Explicit regression check for BV-003 on ExamResultService
        try {
            Method staticHelper = ExamResultService.class.getDeclaredMethod("learnerCorrectAnswers", AnswerSpecRecord.class);
            assertTrue(Modifier.isStatic(staticHelper.getModifiers()));
            assertFalse(staticHelper.isAnnotationPresent(Transactional.class),
                    "ExamResultService.learnerCorrectAnswers must not carry @Transactional");

            Method rescore = ExamResultService.class.getDeclaredMethod(
                    "rescoreArtifact", UUID.class, Long.class, String.class, List.class);
            assertTrue(rescore.isAnnotationPresent(Transactional.class),
                    "ExamResultService.rescoreArtifact must carry @Transactional");
        } catch (NoSuchMethodException e) {
            fail("Expected ExamResultService methods missing: " + e.getMessage());
        }
    }

    @Test
    @DisplayName("Zero direct Repository injection in remediated controllers and no @Transactional on SpeakingController")
    void remediatedControllersHaveZeroRepositoryInjection() throws Exception {
        List<String> violations = new ArrayList<>();

        for (String relPath : REMEDIATED_CONTROLLERS) {
            Path file = MAIN.resolve(relPath);
            assertTrue(Files.exists(file), "Expected controller file missing: " + relPath);
            String code = stripCommentsAndStrings(Files.readString(file));

            // Source-level check: no repository imports or Repository / Results-repo type references
            for (String line : code.split("\n")) {
                String trimmed = line.trim();
                if (trimmed.startsWith("import ") && trimmed.contains(".repository.")) {
                    violations.add(relPath + " imports repository: " + trimmed);
                }
                if (REPO_FIELD_OR_PARAM.matcher(trimmed).find()) {
                    violations.add(relPath + " references repository/DAO type: " + trimmed);
                }
            }

            // Reflection-level check: no injected fields or constructor params of Repository types
            String className = relPath.replace('/', '.').replace(".java", "");
            Class<?> controllerClass = Class.forName(className);
            for (Field f : controllerClass.getDeclaredFields()) {
                Class<?> t = f.getType();
                if (isRepositoryType(t)) {
                    violations.add(className + " field " + f.getName() + " injects " + t.getName());
                }
            }
            for (Constructor<?> ctor : controllerClass.getDeclaredConstructors()) {
                for (Class<?> paramType : ctor.getParameterTypes()) {
                    if (isRepositoryType(paramType)) {
                        violations.add(className + " constructor injects " + paramType.getName());
                    }
                }
            }
        }

        // Also ensure SpeakingController no longer carries @Transactional directly (class or method)
        if (SpeakingController.class.isAnnotationPresent(Transactional.class)) {
            violations.add("SpeakingController class must not be annotated @Transactional");
        }
        for (Method m : SpeakingController.class.getDeclaredMethods()) {
            if (m.isAnnotationPresent(Transactional.class)) {
                violations.add("SpeakingController." + m.getName() + " must not be annotated @Transactional");
            }
        }

        assertTrue(violations.isEmpty(),
                "Remediated controllers must not directly inject repositories:\n - " + String.join("\n - ", violations));
    }

    private static boolean isRepositoryType(Class<?> type) {
        if (type.isAnnotationPresent(Repository.class)) {
            return true;
        }
        String simple = type.getSimpleName();
        return simple.endsWith("Repository")
                || simple.equals("SpellingResults")
                || simple.equals("WordChainResults")
                || org.springframework.data.repository.Repository.class.isAssignableFrom(type);
    }
}
