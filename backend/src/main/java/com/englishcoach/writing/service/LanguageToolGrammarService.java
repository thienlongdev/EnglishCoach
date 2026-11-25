package com.englishcoach.writing.service;

import com.englishcoach.writing.dto.FeedbackIssueDto;
import com.englishcoach.writing.enums.IssueDisposition;
import com.englishcoach.writing.enums.IssueKind;
import com.englishcoach.writing.enums.IssueSeverity;
import com.englishcoach.writing.enums.PracticeMode;
import jakarta.annotation.PostConstruct;
import lombok.extern.slf4j.Slf4j;
import org.languagetool.JLanguageTool;
import org.languagetool.language.AmericanEnglish;
import org.languagetool.rules.Rule;
import org.languagetool.rules.RuleMatch;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.util.*;

/**
 * Embedded LanguageTool Rule-Based English Grammar & Spell Checker.
 * Operates completely in-process with zero external API calls or network costs.
 */
@Slf4j
@Service
public class LanguageToolGrammarService {

    private JLanguageTool languageTool;

    @PostConstruct
    public synchronized void init() {
        // Keep critical warmup before readiness; repeated lifecycle calls reuse it.
        if (languageTool != null) return;
        long started = System.nanoTime();
        try {
            log.info("[LanguageTool] Initializing embedded LanguageTool English engine...");
            System.setProperty("jdk.xml.totalEntitySizeLimit", "0");
            JLanguageTool engine = createEngine();
            // Pre-warm the rule engine to eliminate cold-start latency for user requests
            engine.check("She don't like apples.");
            this.languageTool = engine;
            log.info("[LanguageTool] Engine pre-warmed successfully in {} ms.",
                    (System.nanoTime() - started) / 1_000_000);
        } catch (Exception e) {
            // A partially initialized grammar engine must never count as core-ready.
            throw new IllegalStateException("LanguageTool critical warmup failed", e);
        }
    }

    protected JLanguageTool createEngine() {
        return new JLanguageTool(new AmericanEnglish());
    }

    public synchronized JLanguageTool getLanguageTool() {
        return languageTool;
    }

    public synchronized org.languagetool.AnalyzedSentence getAnalyzedSentence(String text) throws IOException {
        if (languageTool == null || text == null) return null;
        return languageTool.getAnalyzedSentence(text);
    }

    /**
     * Checks sentence text deterministically using LanguageTool rules.
     * Thread-safe synchronized execution.
     */
    public synchronized List<FeedbackIssueDto> checkText(String text) {
        if (text == null || text.isBlank() || languageTool == null) {
            return Collections.emptyList();
        }

        List<FeedbackIssueDto> issues = new ArrayList<>();
        try {
            List<RuleMatch> matches = languageTool.check(text);
            int rank = 1;

            for (RuleMatch match : matches) {
                int from = match.getFromPos();
                int to = match.getToPos();

                if (from < 0 || to > text.length() || from >= to) {
                    continue;
                }

                String sourceQuote = text.substring(from, to).trim();
                if (sourceQuote.isEmpty()) {
                    continue;
                }

                Rule rule = match.getRule();
                String ruleId = rule != null ? rule.getId() : "GRAMMAR_RULE";
                String categoryName = (rule != null && rule.getCategory() != null)
                        ? rule.getCategory().getName()
                        : "Grammar";

                List<String> replacements = match.getSuggestedReplacements();
                String replacement = (replacements != null && !replacements.isEmpty()) ? replacements.get(0) : "";

                // Skip matches where replacement is identical to source quote
                if (!replacement.isEmpty() && replacement.equalsIgnoreCase(sourceQuote)) {
                    continue;
                }

                LinguisticClassification classification = classifyRule(ruleId, categoryName, match.getMessage(), sourceQuote, replacement);

                FeedbackIssueDto issue = FeedbackIssueDto.builder()
                        .id(UUID.randomUUID().toString())
                        .kind(classification.kind)
                        .severity(classification.severity)
                        .category(classification.category)
                        .patternCode(classification.patternCode)
                        .title(classification.titleVi)
                        .explanation(classification.explanationVi)
                        .teachingRule(classification.ruleVi)
                        .sourceQuote(sourceQuote)
                        .startOffset(from)
                        .endOffset(to)
                        .replacement(replacement.isEmpty() ? null : replacement)
                        .suggestedPracticeMode(classification.practiceMode)
                        .disposition(IssueDisposition.ACTIVE)
                        .priorityRank(rank++)
                        .build();

                issues.add(issue);
            }
        } catch (IOException e) {
            log.error("[LanguageTool] Error running grammar check: {}", e.getMessage(), e);
        }

        return issues;
    }

    private record LinguisticClassification(
            IssueKind kind,
            IssueSeverity severity,
            String category,
            String patternCode,
            String titleVi,
            String explanationVi,
            String ruleVi,
            String practiceMode
    ) {}

    private LinguisticClassification classifyRule(
            String ruleId,
            String categoryName,
            String englishMessage,
            String quote,
            String replacement
    ) {
        String rUpper = ruleId.toUpperCase();
        String cUpper = categoryName.toUpperCase();

        // 1. Spelling / Typo
        if (cUpper.contains("TYPO") || rUpper.contains("SPELL") || rUpper.contains("MORFOLOGIK")) {
            return new LinguisticClassification(
                    IssueKind.ERROR,
                    IssueSeverity.MINOR,
                    "Spelling",
                    "SPELLING_TYPO",
                    "Lỗi chính tả: '" + quote + "'",
                    "Từ '" + quote + "' có vẻ chưa đúng chính tả trong tiếng Anh chuẩn" + (!replacement.isEmpty() ? ". Gợi ý từ đúng: '" + replacement + "'." : "."),
                    "Hãy kiểm tra và viết đúng chính tả theo từ điển tiếng Anh chuẩn mực.",
                    PracticeMode.REPAIR.name()
            );
        }

        // 2. Capitalization
        if (cUpper.contains("CASING") || rUpper.contains("CAPITALIZATION") || rUpper.contains("UPPERCASE")) {
            return new LinguisticClassification(
                    IssueKind.ERROR,
                    IssueSeverity.MINOR,
                    "Capitalization",
                    "CAPITALIZATION_RULE",
                    "Quy tắc viết hoa",
                    "Cần viết hoa đầu câu, danh từ riêng hoặc đại từ 'I' trong trường hợp này ('" + quote + "').",
                    "Đầu câu, tên riêng và đại từ nhân xưng 'I' luôn phải viết hoa.",
                    PracticeMode.REPAIR.name()
            );
        }

        // 3. Subject-Verb Agreement
        if (rUpper.contains("AGREEMENT") || rUpper.contains("SVA") || rUpper.contains("SINGULAR_VERB") || rUpper.contains("PLURAL_VERB")) {
            return new LinguisticClassification(
                    IssueKind.ERROR,
                    IssueSeverity.MAJOR,
                    "Grammar",
                    "SUBJECT_VERB_AGREEMENT",
                    "Hòa hợp Chủ ngữ - Động từ",
                    "Động từ chưa hòa hợp về số ít/số nhiều với chủ ngữ trong câu ('" + quote + "').",
                    "Chủ ngữ số ít đi với động từ số ít; chủ ngữ số nhiều đi với động từ số nhiều.",
                    PracticeMode.REPAIR.name()
            );
        }

        // 4. Articles / Determiners (a/an, the)
        if (rUpper.contains("EN_A_VS_AN") || rUpper.contains("ARTICLE") || rUpper.contains("DETERMINER")) {
            return new LinguisticClassification(
                    IssueKind.ERROR,
                    IssueSeverity.MAJOR,
                    "Grammar",
                    "ARTICLE_USAGE_A_AN_THE",
                    "Sử dụng mạo từ (a / an / the)",
                    "Mạo từ đi kèm danh từ chưa chuẩn xác ('" + quote + "')" + (!replacement.isEmpty() ? ". Dạng chuẩn là '" + replacement + "'." : "."),
                    "Dùng 'an' trước nguyên âm phát âm (a, e, i, o, u); dùng 'a' trước phụ âm phát âm.",
                    PracticeMode.REPAIR.name()
            );
        }

        // 5. Modal verbs (can, must, should, etc.)
        if (rUpper.contains("MODAL") || rUpper.contains("CAN_TO") || rUpper.contains("MUST_TO")) {
            return new LinguisticClassification(
                    IssueKind.ERROR,
                    IssueSeverity.MAJOR,
                    "Grammar",
                    "MODAL_AUXILIARY_BARE_INFINITIVE",
                    "Động từ khuyết thiếu",
                    "Sau động từ khuyết thiếu (can, could, must, should...), động từ theo sau phải ở dạng nguyên mẫu không 'to'.",
                    "Cấu trúc: Modal verb + V-infinitive (không có 'to').",
                    PracticeMode.REPAIR.name()
            );
        }

        // 6. Preposition choice
        if (rUpper.contains("PREPOSITION") || rUpper.contains("PREP_")) {
            return new LinguisticClassification(
                    IssueKind.ERROR,
                    IssueSeverity.MAJOR,
                    "Grammar",
                    "PREPOSITION_CHOICE_COLLOCATION",
                    "Giới từ & Cụm từ cố định",
                    "Giới từ đi kèm chưa chính xác ('" + quote + "')" + (!replacement.isEmpty() ? ". Gợi ý chuẩn: '" + replacement + "'." : "."),
                    "Sử dụng đúng giới từ đi kèm động từ/tính từ theo thói quen bản ngữ.",
                    PracticeMode.REPAIR.name()
            );
        }

        // 7. Duplicate words
        if (rUpper.contains("DUPLICATE") || rUpper.contains("REPETITION")) {
            return new LinguisticClassification(
                    IssueKind.ERROR,
                    IssueSeverity.MINOR,
                    "Punctuation",
                    "DUPLICATE_WORDS",
                    "Lặp từ không cần thiết",
                    "Từ '" + quote + "' bị lặp lại liên tiếp trong câu.",
                    "Tránh viết lặp lại cùng một từ liền kề nhau.",
                    PracticeMode.REPAIR.name()
            );
        }

        // 8. Style / Redundancy
        if (cUpper.contains("STYLE") || cUpper.contains("REDUNDANCY") || rUpper.contains("CLICHE") || rUpper.contains("PLAIN_ENGLISH")) {
            return new LinguisticClassification(
                    IssueKind.IMPROVEMENT,
                    IssueSeverity.SUGGESTION,
                    "Style",
                    "STYLE_NATURALNESS_SUGGESTION",
                    "Gợi ý diễn đạt tự nhiên hơn",
                    englishMessage != null && !englishMessage.isBlank()
                            ? "Diễn đạt có thể được trau chuốt để câu văn tự nhiên và rõ nghĩa hơn: " + englishMessage
                            : "Cách diễn đạt này có thể trau chuốt lại cho tự nhiên hơn.",
                    "Lựa chọn từ ngữ súc tích, mạch lạc và tự nhiên trong ngữ cảnh.",
                    PracticeMode.REWRITE_NATURALLY.name()
            );
        }

        // Default: Confirmed Grammar Error
        return new LinguisticClassification(
                IssueKind.ERROR,
                IssueSeverity.MAJOR,
                "Grammar",
                "GRAMMAR_SYNTACTIC_ACCURACY",
                "Quy tắc ngữ pháp",
                englishMessage != null && !englishMessage.isBlank()
                        ? "Phát hiện điểm ngữ pháp chưa chuẩn xác ('" + quote + "'): " + englishMessage
                        : "Cấu trúc hoặc dạng từ chưa chuẩn xác ('" + quote + "').",
                "Đảm bảo tuân thủ cú pháp và quy tắc chia từ trong tiếng Anh chuẩn.",
                PracticeMode.REPAIR.name()
        );
    }
}
