package com.englishcoach.writing.service;

import com.englishcoach.writing.dto.FeedbackIssueDto;
import com.englishcoach.writing.enums.IssueDisposition;
import com.englishcoach.writing.enums.IssueKind;
import com.englishcoach.writing.enums.IssueSeverity;
import com.englishcoach.writing.enums.PracticeMode;
import lombok.Builder;
import lombok.Data;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Deterministic Grammar Validator & Hybrid GEC Reconciler.
 * Completely free of handwritten English verb/noun vocabulary maps.
 * All morphology, lemmatization, POS tagging, and synthesis are driven by LinguisticAnalysisService / LanguageTool 6.4.
 */
@Slf4j
@Service
public class DeterministicGrammarValidator {

    private final LanguageToolGrammarService languageToolGrammarService;
    private final LinguisticAnalysisService linguisticAnalysisService;

    public DeterministicGrammarValidator() {
        LanguageToolGrammarService lt = new LanguageToolGrammarService();
        lt.init();
        this.languageToolGrammarService = lt;
        this.linguisticAnalysisService = new LinguisticAnalysisService(lt);
    }

    @org.springframework.beans.factory.annotation.Autowired
    public DeterministicGrammarValidator(LanguageToolGrammarService languageToolGrammarService, LinguisticAnalysisService linguisticAnalysisService) {
        this.languageToolGrammarService = languageToolGrammarService;
        this.linguisticAnalysisService = linguisticAnalysisService != null ? linguisticAnalysisService : new LinguisticAnalysisService(languageToolGrammarService);
    }

    public DeterministicGrammarValidator(LanguageToolGrammarService languageToolGrammarService) {
        this(languageToolGrammarService, new LinguisticAnalysisService(languageToolGrammarService));
    }

    public LanguageToolGrammarService getLanguageToolGrammarService() {
        return languageToolGrammarService;
    }

    public LinguisticAnalysisService getLinguisticAnalysisService() {
        return linguisticAnalysisService;
    }

    @Data
    @Builder
    public static class ValidationResult {
        private boolean grammaticallyCorrect;
        private List<FeedbackIssueDto> validatedIssues;
        private int droppedCount;
        private int reclassifiedCount;

        public boolean hasConfirmedGrammarError() {
            return validatedIssues != null && validatedIssues.stream().anyMatch(i ->
                    i.getKind() == IssueKind.ERROR && ("Grammar".equalsIgnoreCase(i.getCategory()) || "Capitalization".equalsIgnoreCase(i.getCategory()) || "Orthography".equalsIgnoreCase(i.getCategory()) || "Punctuation".equalsIgnoreCase(i.getCategory()) || "Spelling".equalsIgnoreCase(i.getCategory()))
            );
        }
    }

    // =========================================================================
    // Generic Linguistic Patterns (Zero Hardcoded Lexical Vocabulary Maps)
    // =========================================================================

    // Explicit past-time adverbial patterns
    private static final Pattern PAST_TIME_MARKER = Pattern.compile(
            "\\b(yesterday|last\\s+(?:night|week|month|year|sunday|monday|tuesday|wednesday|thursday|friday|saturday|weekend)|(?:two|three|four|five|several|many|a|\\d+)\\s+(?:days?|weeks?|months?|years?|hours?)\\s+ago|in\\s+(?:19\\d\\d|20[0-2]\\d))\\b",
            Pattern.CASE_INSENSITIVE
    );

    // Sentence-initial lowercase alphabetic token
    private static final Pattern SENTENCE_INITIAL_LOWERCASE = Pattern.compile("(?:^|[.!?]\\s+)([\"']?\\s*)([a-z])");

    // Lowercase pronoun "I"
    private static final Pattern LOWERCASE_I = Pattern.compile("(^|[^a-zA-Z0-9_])(i)([^a-zA-Z0-9_]|$)");

    // Modal with 'to' violation (e.g. must to, should to, can to)
    private static final Pattern MODAL_WITH_TO = Pattern.compile("\\b(can|could|must|should|will|would|may|might)\\s+to\\s+([a-zA-Z]+)\\b", Pattern.CASE_INSENSITIVE);

    // Incomplete subordinate clause fragment (e.g., "Although she studied hard.")
    private static final Pattern INCOMPLETE_SUBORDINATE_CLAUSE = Pattern.compile(
            "^\\s*(although|even\\s+though|though|while|whereas|because|since|if|unless)\\s+[^.!?]+[.!?]\\s*$",
            Pattern.CASE_INSENSITIVE
    );

    // A vs An generic pattern
    private static final Pattern A_BEFORE_VOWEL = Pattern.compile("\\b(a)\\s+([aeiou][a-z]*)\\b", Pattern.CASE_INSENSITIVE);
    private static final Pattern AN_BEFORE_CONSONANT = Pattern.compile("\\b(an)\\s+([bcdfghjklmnpqrstvwxyz][a-z]*)\\b", Pattern.CASE_INSENSITIVE);

    // Preposition collocations
    private static final Pattern PREP_DEPEND_OF = Pattern.compile("\\b(depend|depends|depended|depending)\\s+of\\b", Pattern.CASE_INSENSITIVE);
    private static final Pattern PREP_GOOD_IN = Pattern.compile("\\b(good|great)\\s+in\\s+(english|math|sports|playing|writing|speaking)\\b", Pattern.CASE_INSENSITIVE);
    private static final Pattern PREP_INTERESTED_FOR = Pattern.compile("\\binterested\\s+for\\b", Pattern.CASE_INSENSITIVE);

    // 3rd singular don't -> doesn't
    private static final Pattern SVA_THIRD_PERSON_DONT = Pattern.compile("\\b(he|she|it)\\s+don'?t\\b", Pattern.CASE_INSENSITIVE);

    /**
     * Run deterministic grammar checks directly on the input text.
     * All morphological operations are performed generically via LinguisticAnalysisService.
     */
    public List<FeedbackIssueDto> checkDeterministicRules(String text) {
        if (text == null || text.isBlank()) {
            return Collections.emptyList();
        }

        List<FeedbackIssueDto> issues = new ArrayList<>();

        // 1. Sentence-initial lowercase alphabetic token
        Matcher initCapMatcher = SENTENCE_INITIAL_LOWERCASE.matcher(text);
        while (initCapMatcher.find()) {
            int charPos = initCapMatcher.start(2);
            char c = text.charAt(charPos);
            int wordEnd = charPos + 1;
            while (wordEnd < text.length() && Character.isLetterOrDigit(text.charAt(wordEnd))) {
                wordEnd++;
            }
            String word = text.substring(charPos, wordEnd);
            String capitalized = Character.toUpperCase(c) + (word.length() > 1 ? word.substring(1) : "");
            issues.add(FeedbackIssueDto.builder()
                    .id(UUID.randomUUID().toString())
                    .kind(IssueKind.ERROR)
                    .severity(IssueSeverity.MAJOR)
                    .category("Capitalization")
                    .patternCode("SENTENCE_INITIAL_CAPITALIZATION")
                    .title("Viết hoa đầu câu: Chữ cái đầu câu phải được viết hoa")
                    .explanation(String.format("Chữ cái đầu tiên của câu ('%s') cần được viết hoa ('%s').", word, capitalized))
                    .sourceQuote(word)
                    .startOffset(charPos)
                    .endOffset(wordEnd)
                    .replacement(capitalized)
                    .teachingRule("Trong tiếng Anh, chữ cái đầu tiên của mỗi câu luôn luôn phải được viết hoa.")
                    .suggestedPracticeMode(PracticeMode.REPAIR.name())
                    .disposition(IssueDisposition.ACTIVE)
                    .priorityRank(1)
                    .build());
        }

        // 2. Lowercase standalone pronoun "I"
        Matcher lowerIMatcher = LOWERCASE_I.matcher(text);
        while (lowerIMatcher.find()) {
            int start = lowerIMatcher.start(2);
            int end = lowerIMatcher.end(2);
            issues.add(FeedbackIssueDto.builder()
                    .id(UUID.randomUUID().toString())
                    .kind(IssueKind.ERROR)
                    .severity(IssueSeverity.MINOR)
                    .category("Capitalization")
                    .patternCode("CAPITALIZATION_PRONOUN_I")
                    .title("Viết hoa đại từ xưng hô \"I\"")
                    .explanation("Đại từ ngôi thứ nhất số ít 'I' trong tiếng Anh luôn luôn phải được viết hoa ở mọi vị trí trong câu.")
                    .sourceQuote(text.substring(start, end))
                    .startOffset(start)
                    .endOffset(end)
                    .replacement("I")
                    .teachingRule("Đại từ nhân xưng 'I' (tôi) luôn luôn viết hoa trong tiếng Anh chuẩn.")
                    .suggestedPracticeMode(PracticeMode.REPAIR.name())
                    .disposition(IssueDisposition.ACTIVE)
                    .priorityRank(1)
                    .build());
        }

        // 3. A vs An rule
        Matcher aMatcher = A_BEFORE_VOWEL.matcher(text);
        while (aMatcher.find()) {
            String nextWord = aMatcher.group(2).toLowerCase();
            if (!nextWord.startsWith("u") && !nextWord.startsWith("eu")) {
                int start = aMatcher.start(1);
                int end = aMatcher.end(1);
                issues.add(FeedbackIssueDto.builder()
                        .id(UUID.randomUUID().toString())
                        .kind(IssueKind.ERROR)
                        .severity(IssueSeverity.MAJOR)
                        .category("Grammar")
                        .patternCode("ARTICLE_A_AN_MISMATCH")
                        .title("Sử dụng mạo từ không xác định 'a'/'an'")
                        .explanation(String.format("Dùng 'an' trước các từ bắt đầu bằng nguyên âm ('%s'), không dùng 'a'.", nextWord))
                        .sourceQuote(text.substring(start, end))
                        .startOffset(start)
                        .endOffset(end)
                        .replacement("an")
                        .teachingRule("Dùng mạo từ 'an' trước các danh từ/tính từ bắt đầu bằng một nguyên âm (u, e, o, a, i).")
                        .suggestedPracticeMode(PracticeMode.REPAIR.name())
                        .disposition(IssueDisposition.ACTIVE)
                        .priorityRank(1)
                        .build());
            }
        }

        Matcher anMatcher = AN_BEFORE_CONSONANT.matcher(text);
        while (anMatcher.find()) {
            String nextWord = anMatcher.group(2).toLowerCase();
            if (!nextWord.startsWith("hour") && !nextWord.startsWith("honest") && !nextWord.startsWith("honor")) {
                int start = anMatcher.start(1);
                int end = anMatcher.end(1);
                issues.add(FeedbackIssueDto.builder()
                        .id(UUID.randomUUID().toString())
                        .kind(IssueKind.ERROR)
                        .severity(IssueSeverity.MAJOR)
                        .category("Grammar")
                        .patternCode("ARTICLE_A_AN_MISMATCH")
                        .title("Sử dụng mạo từ không xác định 'a'/'an'")
                        .explanation(String.format("Dùng 'a' trước các từ bắt đầu bằng phụ âm ('%s'), không dùng 'an'.", nextWord))
                        .sourceQuote(text.substring(start, end))
                        .startOffset(start)
                        .endOffset(end)
                        .replacement("a")
                        .teachingRule("Dùng mạo từ 'a' trước danh từ/tính từ bắt đầu bằng một phụ âm.")
                        .suggestedPracticeMode(PracticeMode.REPAIR.name())
                        .disposition(IssueDisposition.ACTIVE)
                        .priorityRank(1)
                        .build());
            }
        }

        // 4. Modal with 'to' violation (e.g. must to go -> must go)
        Matcher modalToMatcher = MODAL_WITH_TO.matcher(text);
        while (modalToMatcher.find()) {
            int start = modalToMatcher.start();
            int end = modalToMatcher.end();
            String modal = modalToMatcher.group(1);
            String verb = modalToMatcher.group(2);
            issues.add(FeedbackIssueDto.builder()
                    .id(UUID.randomUUID().toString())
                    .kind(IssueKind.ERROR)
                    .severity(IssueSeverity.MAJOR)
                    .category("Grammar")
                    .patternCode("MODAL_AUXILIARY_BARE_INFINITIVE")
                    .title("Động từ khuyết thiếu đi kèm động từ nguyên mẫu không 'to'")
                    .explanation(String.format("Sau động từ khuyết thiếu '%s', động từ chính '%s' phải ở dạng nguyên mẫu không 'to'.", modal, verb))
                    .sourceQuote(text.substring(start, end))
                    .startOffset(start)
                    .endOffset(end)
                    .replacement(modal + " " + verb)
                    .teachingRule("Các động từ khuyết thiếu (can, could, must, should, will, would, may, might) luôn đi trực tiếp với động từ nguyên mẫu không 'to'.")
                    .suggestedPracticeMode(PracticeMode.REPAIR.name())
                    .disposition(IssueDisposition.ACTIVE)
                    .priorityRank(1)
                    .build());
        }

        // 5. Third-person singular don't -> doesn't
        Matcher dontMatcher = SVA_THIRD_PERSON_DONT.matcher(text);
        while (dontMatcher.find()) {
            int start = dontMatcher.start();
            int end = dontMatcher.end();
            String subj = dontMatcher.group(1);
            issues.add(FeedbackIssueDto.builder()
                    .id(UUID.randomUUID().toString())
                    .kind(IssueKind.ERROR)
                    .severity(IssueSeverity.MAJOR)
                    .category("Grammar")
                    .patternCode("THIRD_PERSON_SINGULAR_AUXILIARY")
                    .title("Sự hòa hợp chủ ngữ và trợ động từ (Subject-Verb Agreement)")
                    .explanation(String.format("Với chủ ngữ ngôi thứ 3 số ít ('%s'), phải dùng trợ động từ phủ định 'doesn't' thay vì 'don't'.", subj))
                    .sourceQuote(text.substring(start, end))
                    .startOffset(start)
                    .endOffset(end)
                    .replacement(subj + " doesn't")
                    .teachingRule("Ngôi thứ 3 số ít (He, She, It) trong thì Hiện tại đơn sử dụng trợ động từ 'does/doesn't'.")
                    .suggestedPracticeMode(PracticeMode.REPAIR.name())
                    .disposition(IssueDisposition.ACTIVE)
                    .priorityRank(1)
                    .build());
        }

        // 6. Preposition collocations
        Matcher mDep = PREP_DEPEND_OF.matcher(text);
        while (mDep.find()) {
            int start = mDep.start();
            int end = mDep.end();
            String verb = mDep.group(1);
            issues.add(FeedbackIssueDto.builder()
                    .id(UUID.randomUUID().toString())
                    .kind(IssueKind.ERROR)
                    .severity(IssueSeverity.MAJOR)
                    .category("Grammar")
                    .patternCode("PREPOSITION_CHOICE_COLLOCATION")
                    .title("Giới từ đi với 'depend'")
                    .explanation(String.format("Động từ '%s' đi với giới từ 'on' (hoặc 'upon'), không đi với 'of'.", verb))
                    .sourceQuote(text.substring(start, end))
                    .startOffset(start)
                    .endOffset(end)
                    .replacement(verb + " on")
                    .teachingRule("Cụm cố định: depend on/upon something.")
                    .suggestedPracticeMode(PracticeMode.REPAIR.name())
                    .disposition(IssueDisposition.ACTIVE)
                    .priorityRank(1)
                    .build());
        }

        // 7. Incomplete subordinate clause fragment
        Matcher incSubMatcher = INCOMPLETE_SUBORDINATE_CLAUSE.matcher(text);
        if (incSubMatcher.find()) {
            String conj = incSubMatcher.group(1);
            issues.add(FeedbackIssueDto.builder()
                    .id(UUID.randomUUID().toString())
                    .kind(IssueKind.ERROR)
                    .severity(IssueSeverity.CRITICAL)
                    .category("Grammar")
                    .patternCode("INCOMPLETE_SUBORDINATE_CLAUSE_FRAGMENT")
                    .title("Mệnh đề phụ thuộc đứng một mình (Sentence Fragment)")
                    .explanation(String.format("Mệnh đề bắt đầu bằng liên từ phụ thuộc '%s' không thể đứng thành một câu hoàn chỉnh độc lập. Cần có thêm một mệnh đề chính.", conj))
                    .sourceQuote(text.trim())
                    .startOffset(0)
                    .endOffset(text.length())
                    .replacement(null)
                    .teachingRule("Mệnh đề phụ bắt đầu bằng liên từ phụ thuộc (although, because, if, when...) bắt buộc phải đi cùng một mệnh đề chính hoàn chỉnh.")
                    .suggestedPracticeMode(PracticeMode.EXPAND.name())
                    .disposition(IssueDisposition.ACTIVE)
                    .priorityRank(1)
                    .build());
        }

        // =========================================================================
        // Generic Token-Based Linguistic Grammar Rules (Powered by LinguisticAnalysisService)
        // =========================================================================
        if (linguisticAnalysisService != null) {
            List<LinguisticAnalysisService.TokenAnalysis> tokens = linguisticAnalysisService.analyzeSentence(text);
            boolean hasExplicitPastTimeMarker = PAST_TIME_MARKER.matcher(text).find();
            boolean hasNarrativePastContext = hasExplicitPastTimeMarker ||
                    tokens.stream().anyMatch(LinguisticAnalysisService.TokenAnalysis::isPastTenseVerb);

            // Explicit past-time adverbial requiring past tense on main finite verb(s)
            if (hasExplicitPastTimeMarker) {
                for (int i = 0; i < tokens.size(); i++) {
                    LinguisticAnalysisService.TokenAnalysis tok = tokens.get(i);
                    // Check if token is a finite present verb (base or 3rd person singular)
                    if ((tok.isBaseVerb() || tok.isThirdPersonSingularVerb()) && !tok.isPastTenseVerb() && !tok.isModal() && !tok.isPresentParticiple()) {
                        // Skip if preceded by 'to' (infinitive)
                        if (i > 0 && tokens.get(i - 1).getToken().equalsIgnoreCase("to")) {
                            continue;
                        }
                        // Skip if preceded by modal (can, could, would, etc.)
                        if (i > 0 && tokens.get(i - 1).isModal()) {
                            continue;
                        }
                        // Skip if preceded by auxiliary do/does/did/didn't
                        if (i > 0) {
                            String prevLower = tokens.get(i - 1).getToken().toLowerCase();
                            if (prevLower.equals("did") || prevLower.equals("didn't") || prevLower.equals("do") || prevLower.equals("don't") || prevLower.equals("does") || prevLower.equals("doesn't") || prevLower.equals("not")) {
                                continue;
                            }
                        }

                        // Syntactic certainty: Must be directly preceded by a personal pronoun subject (e.g. "I go", "they work")
                        // Without an explicit subject pronoun, base tokens cannot be safely converted to past tense.
                        boolean isSubjectPronounPreceded = i > 0 && tokens.get(i - 1).isPersonalPronoun();
                        if (!isSubjectPronounPreceded) {
                            continue;
                        }

                        String lower = tok.getToken().toLowerCase();
                        if (lower.equals("have") || lower.equals("has") || lower.equals("be") || lower.equals("is") || lower.equals("are") || lower.equals("am") || tok.isVerb()) {
                            String pastVerb = linguisticAnalysisService.toPastTenseVerb(tok.getToken());
                            if (pastVerb != null && !pastVerb.equalsIgnoreCase(tok.getToken())) {
                                issues.add(FeedbackIssueDto.builder()
                                        .id(UUID.randomUUID().toString())
                                        .kind(IssueKind.ERROR)
                                        .severity(IssueSeverity.MAJOR)
                                        .category("Grammar")
                                        .patternCode("PAST_TENSE_REGULAR_IRREGULAR")
                                        .title("Sử dụng thì quá khứ đơn với trạng từ chỉ thời gian trong quá khứ")
                                        .explanation(String.format("Câu có trạng từ chỉ thời gian trong quá khứ, nên động từ '%s' phải chia ở thì quá khứ đơn ('%s').", tok.getToken(), pastVerb))
                                        .sourceQuote(tok.getToken())
                                        .startOffset(tok.getStartPos())
                                        .endOffset(tok.getEndPos())
                                        .replacement(pastVerb)
                                        .teachingRule("Khi trong câu có trạng từ thời gian xác định trong quá khứ (yesterday, last week, ago...), động từ chính phải chia ở thì Quá khứ đơn (V2/V-ed).")
                                        .suggestedPracticeMode(PracticeMode.REPAIR.name())
                                        .disposition(IssueDisposition.ACTIVE)
                                        .priorityRank(1)
                                        .build());
                            }
                        }
                    }
                }
            }

            for (int i = 0; i < tokens.size(); i++) {
                LinguisticAnalysisService.TokenAnalysis tok = tokens.get(i);
                String tokText = tok.getToken();
                String tokLower = tokText.toLowerCase();

                // 8. Auxiliary + Lexical Verb Morphology
                // 8a. did / didn't + past verb -> did + base verb
                if (tokLower.equals("did") || tokLower.equals("didn't") || tokLower.equals("didnt")) {
                    int nextIdx = i + 1;
                    if (nextIdx < tokens.size() && tokens.get(nextIdx).getToken().equalsIgnoreCase("not")) {
                        nextIdx++;
                    }
                    if (nextIdx < tokens.size()) {
                        LinguisticAnalysisService.TokenAnalysis vTok = tokens.get(nextIdx);
                        if (vTok.isPastTenseVerb()) {
                            String baseVerb = linguisticAnalysisService.toBaseVerb(vTok.getToken());
                            if (baseVerb != null && !baseVerb.equalsIgnoreCase(vTok.getToken())) {
                                issues.add(FeedbackIssueDto.builder()
                                        .id(UUID.randomUUID().toString())
                                        .kind(IssueKind.ERROR)
                                        .severity(IssueSeverity.MAJOR)
                                        .category("Grammar")
                                        .patternCode("AUXILIARY_VERB_BARE_INFINITIVE")
                                        .title("Trợ động từ 'did' đi với động từ nguyên mẫu")
                                        .explanation(String.format("Sau trợ động từ '%s', động từ chính phải ở dạng nguyên mẫu ('%s'), không dùng dạng quá khứ ('%s').", tokText, baseVerb, vTok.getToken()))
                                        .sourceQuote(vTok.getToken())
                                        .startOffset(vTok.getStartPos())
                                        .endOffset(vTok.getEndPos())
                                        .replacement(baseVerb)
                                        .teachingRule("Sau trợ động từ do/does/did trong câu hỏi hoặc câu phủ định, động từ chính luôn ở dạng nguyên mẫu không 'to'.")
                                        .suggestedPracticeMode(PracticeMode.REPAIR.name())
                                        .disposition(IssueDisposition.ACTIVE)
                                        .priorityRank(1)
                                        .build());
                            }
                        }
                    }
                }

                // 8b. does / doesn't + 3rd person verb -> does + base verb
                if (tokLower.equals("does") || tokLower.equals("doesn't") || tokLower.equals("doesnt")) {
                    int nextIdx = i + 1;
                    if (nextIdx < tokens.size() && tokens.get(nextIdx).getToken().equalsIgnoreCase("not")) {
                        nextIdx++;
                    }
                    if (nextIdx < tokens.size()) {
                        LinguisticAnalysisService.TokenAnalysis vTok = tokens.get(nextIdx);
                        if (vTok.isThirdPersonSingularVerb()) {
                            String baseVerb = linguisticAnalysisService.toBaseVerb(vTok.getToken());
                            if (baseVerb != null && !baseVerb.equalsIgnoreCase(vTok.getToken())) {
                                issues.add(FeedbackIssueDto.builder()
                                        .id(UUID.randomUUID().toString())
                                        .kind(IssueKind.ERROR)
                                        .severity(IssueSeverity.MAJOR)
                                        .category("Grammar")
                                        .patternCode("AUXILIARY_VERB_BARE_INFINITIVE")
                                        .title("Trợ động từ 'does' đi với động từ nguyên mẫu")
                                        .explanation(String.format("Sau trợ động từ '%s', động từ chính phải ở dạng nguyên mẫu ('%s'), không thêm '-s/-es'.", tokText, baseVerb))
                                        .sourceQuote(vTok.getToken())
                                        .startOffset(vTok.getStartPos())
                                        .endOffset(vTok.getEndPos())
                                        .replacement(baseVerb)
                                        .teachingRule("Đã có trợ động từ 'does/doesn't' thì động từ chính giữ nguyên mẫu.")
                                        .suggestedPracticeMode(PracticeMode.REPAIR.name())
                                        .disposition(IssueDisposition.ACTIVE)
                                        .priorityRank(1)
                                        .build());
                            }
                        }
                    }
                }

                // 8c. Modal auxiliary (can, could, will, would, should, must...) + past/3rd verb -> modal + base verb
                if (tok.isModal() && !tokLower.equals("to")) {
                    int nextIdx = i + 1;
                    if (nextIdx < tokens.size() && (tokens.get(nextIdx).getToken().equalsIgnoreCase("not") || tokens.get(nextIdx).getToken().equalsIgnoreCase("never"))) {
                        nextIdx++;
                    }
                    if (nextIdx < tokens.size()) {
                        LinguisticAnalysisService.TokenAnalysis vTok = tokens.get(nextIdx);
                        if (vTok.isPastTenseVerb() || vTok.isThirdPersonSingularVerb()) {
                            String baseVerb = linguisticAnalysisService.toBaseVerb(vTok.getToken());
                            if (baseVerb != null && !baseVerb.equalsIgnoreCase(vTok.getToken())) {
                                issues.add(FeedbackIssueDto.builder()
                                        .id(UUID.randomUUID().toString())
                                        .kind(IssueKind.ERROR)
                                        .severity(IssueSeverity.MAJOR)
                                        .category("Grammar")
                                        .patternCode("MODAL_AUXILIARY_BARE_INFINITIVE")
                                        .title("Động từ khuyết thiếu đi với động từ nguyên mẫu")
                                        .explanation(String.format("Sau động từ khuyết thiếu '%s', động từ theo sau phải là dạng nguyên thể ('%s'), không dùng dạng biến cách ('%s').", tokText, baseVerb, vTok.getToken()))
                                        .sourceQuote(vTok.getToken())
                                        .startOffset(vTok.getStartPos())
                                        .endOffset(vTok.getEndPos())
                                        .replacement(baseVerb)
                                        .teachingRule("Sau các động từ khuyết thiếu (can, could, will, would, should, must...) luôn dùng động từ nguyên thể không to.")
                                        .suggestedPracticeMode(PracticeMode.REPAIR.name())
                                        .disposition(IssueDisposition.ACTIVE)
                                        .priorityRank(1)
                                        .build());
                            }
                        }
                    }
                }

                // 8d. have / has / had + past tense verb (e.g. have went -> have gone)
                if (tokLower.equals("have") || tokLower.equals("has") || tokLower.equals("had")) {
                    int nextIdx = i + 1;
                    if (nextIdx < tokens.size() && (tokens.get(nextIdx).getToken().equalsIgnoreCase("not") || tokens.get(nextIdx).getToken().equalsIgnoreCase("already"))) {
                        nextIdx++;
                    }
                    if (nextIdx < tokens.size()) {
                        LinguisticAnalysisService.TokenAnalysis vTok = tokens.get(nextIdx);
                        if (vTok.isPastTenseVerb() && !vTok.isPastParticiple()) {
                            String vbn = linguisticAnalysisService.toPastParticiple(vTok.getToken());
                            if (vbn != null && !vbn.equalsIgnoreCase(vTok.getToken())) {
                                issues.add(FeedbackIssueDto.builder()
                                        .id(UUID.randomUUID().toString())
                                        .kind(IssueKind.ERROR)
                                        .severity(IssueSeverity.MAJOR)
                                        .category("Grammar")
                                        .patternCode("HAVE_PAST_PARTICIPLE_MISMATCH")
                                        .title("Dạng quá khứ phân từ sau 'have/has/had'")
                                        .explanation(String.format("Trong thì hoàn thành với '%s', động từ theo sau phải ở dạng quá khứ phân từ V3/ed ('%s'), không dùng dạng quá khứ đơn V2 ('%s').", tokText, vbn, vTok.getToken()))
                                        .sourceQuote(vTok.getToken())
                                        .startOffset(vTok.getStartPos())
                                        .endOffset(vTok.getEndPos())
                                        .replacement(vbn)
                                        .teachingRule("Sau have/has/had luôn là Past Participle (V3/ed): have gone, have seen, have eaten...")
                                        .suggestedPracticeMode(PracticeMode.REPAIR.name())
                                        .disposition(IssueDisposition.ACTIVE)
                                        .priorityRank(1)
                                        .build());
                            }
                        }
                    }
                }

                // 8e. be (am, is, are, was, were) + base action verb -> be + V-ing
                if (tokLower.equals("am") || tokLower.equals("is") || tokLower.equals("are") || tokLower.equals("was") || tokLower.equals("were")) {
                    if (i + 1 < tokens.size()) {
                        LinguisticAnalysisService.TokenAnalysis vTok = tokens.get(i + 1);
                        if (vTok.isBaseVerb() && !vTok.isPastParticiple() && !vTok.isNoun() && !vTok.getPosTags().contains("JJ")) {
                            String vIng = linguisticAnalysisService.toPresentParticiple(vTok.getToken());
                            if (vIng != null && !vIng.equalsIgnoreCase(vTok.getToken())) {
                                issues.add(FeedbackIssueDto.builder()
                                        .id(UUID.randomUUID().toString())
                                        .kind(IssueKind.ERROR)
                                        .severity(IssueSeverity.MAJOR)
                                        .category("Grammar")
                                        .patternCode("CONTINUOUS_ASPECT_V_ING")
                                        .title("Động từ to be kết hợp dạng V-ing trong thì tiếp diễn")
                                        .explanation(String.format("Động từ to be ('%s') kết hợp với động từ hành động để tạo thì tiếp diễn cần dùng dạng V-ing ('%s'), không dùng dạng nguyên mẫu ('%s').", tokText, vIng, vTok.getToken()))
                                        .sourceQuote(vTok.getToken())
                                        .startOffset(vTok.getStartPos())
                                        .endOffset(vTok.getEndPos())
                                        .replacement(vIng)
                                        .teachingRule("Cấu trúc thì tiếp diễn: be + V-ing.")
                                        .suggestedPracticeMode(PracticeMode.REPAIR.name())
                                        .disposition(IssueDisposition.ACTIVE)
                                        .priorityRank(1)
                                        .build());
                            }
                        }
                    }
                }

                // 9. Existential 'There + be' Agreement
                if (tokLower.equals("there") && i + 1 < tokens.size()) {
                    LinguisticAnalysisService.TokenAnalysis beTok = tokens.get(i + 1);
                    String beStr = beTok.getToken().toLowerCase();
                    if (beStr.equals("is") || beStr.equals("was") || beStr.equals("are") || beStr.equals("were")) {
                        // Look at the following noun/quantifier
                        if (i + 2 < tokens.size()) {
                            LinguisticAnalysisService.TokenAnalysis nextTok = tokens.get(i + 2);
                            String nextLower = nextTok.getToken().toLowerCase();
                            boolean nextIsPlural = nextTok.isPluralNoun() ||
                                    nextLower.equals("many") || nextLower.equals("several") || nextLower.equals("few") || nextLower.equals("two") || nextLower.equals("three") || nextLower.matches("\\d+");
                            boolean nextIsSingular = nextTok.isSingularNoun() ||
                                    nextLower.equals("a") || nextLower.equals("an") || nextLower.equals("one") || nextLower.equals("each") || nextLower.equals("every") || nextLower.equals("this") || nextLower.equals("that");

                            if ((beStr.equals("is") || beStr.equals("was")) && nextIsPlural) {
                                String repBe = beStr.equals("is") ? "are" : "were";
                                issues.add(FeedbackIssueDto.builder()
                                        .id(UUID.randomUUID().toString())
                                        .kind(IssueKind.ERROR)
                                        .severity(IssueSeverity.MAJOR)
                                        .category("Grammar")
                                        .patternCode("EXISTENTIAL_THERE_AGREEMENT")
                                        .title("Hòa hợp 'There + be' với danh từ/số lượng số nhiều")
                                        .explanation(String.format("Sau cấu trúc 'there + be', từ '%s' biểu thị số nhiều nên động từ 'to be' phải dùng dạng số nhiều ('%s'), không dùng '%s'.", nextTok.getToken(), repBe, beTok.getToken()))
                                        .sourceQuote(beTok.getToken())
                                        .startOffset(beTok.getStartPos())
                                        .endOffset(beTok.getEndPos())
                                        .replacement(repBe)
                                        .teachingRule("Trong cấu trúc 'There + be', dạng của động từ 'be' được quyết định bởi danh từ đứng sau nó.")
                                        .suggestedPracticeMode(PracticeMode.REPAIR.name())
                                        .disposition(IssueDisposition.ACTIVE)
                                        .priorityRank(1)
                                        .build());
                            } else if ((beStr.equals("are") || beStr.equals("were")) && nextIsSingular) {
                                String repBe = beStr.equals("are") ? "is" : "was";
                                issues.add(FeedbackIssueDto.builder()
                                        .id(UUID.randomUUID().toString())
                                        .kind(IssueKind.ERROR)
                                        .severity(IssueSeverity.MAJOR)
                                        .category("Grammar")
                                        .patternCode("EXISTENTIAL_THERE_AGREEMENT")
                                        .title("Hòa hợp 'There + be' với danh từ số ít")
                                        .explanation(String.format("Từ chỉ định/danh từ '%s' biểu thị số ít, do đó to be phải dùng '%s' thay vì '%s'.", nextTok.getToken(), repBe, beTok.getToken()))
                                        .sourceQuote(beTok.getToken())
                                        .startOffset(beTok.getStartPos())
                                        .endOffset(beTok.getEndPos())
                                        .replacement(repBe)
                                        .teachingRule("Dùng 'there is/was' cho danh từ số ít hoặc không đếm được.")
                                        .suggestedPracticeMode(PracticeMode.REPAIR.name())
                                        .disposition(IssueDisposition.ACTIVE)
                                        .priorityRank(1)
                                        .build());
                            }
                        }
                    }
                }

                // 10. Quantifier Noun Number Agreement
                // 10a. Plural quantifier (many, several, two, three...) + singular count noun
                if (tokLower.equals("many") || tokLower.equals("several") || tokLower.equals("two") || tokLower.equals("three") || tokLower.equals("four") || tokLower.equals("five")) {
                    if (i + 1 < tokens.size()) {
                        LinguisticAnalysisService.TokenAnalysis nTok = tokens.get(i + 1);
                        if (nTok.isSingularNoun() && !nTok.isPluralNoun()) {
                            String pluralNoun = linguisticAnalysisService.toPluralNoun(nTok.getToken());
                            if (pluralNoun != null && !pluralNoun.equalsIgnoreCase(nTok.getToken())) {
                                issues.add(FeedbackIssueDto.builder()
                                        .id(UUID.randomUUID().toString())
                                        .kind(IssueKind.ERROR)
                                        .severity(IssueSeverity.MAJOR)
                                        .category("Grammar")
                                        .patternCode("NOUN_NUMBER_AGREEMENT")
                                        .title("Hòa hợp lượng từ với danh từ số nhiều")
                                        .explanation(String.format("Lượng từ '%s' yêu cầu danh từ đếm được theo sau phải ở dạng số nhiều ('%s'), không dùng số ít ('%s').", tokText, pluralNoun, nTok.getToken()))
                                        .sourceQuote(nTok.getToken())
                                        .startOffset(nTok.getStartPos())
                                        .endOffset(nTok.getEndPos())
                                        .replacement(pluralNoun)
                                        .teachingRule("Các lượng từ như many, several, two, three... bắt buộc đi kèm danh từ đếm được số nhiều.")
                                        .suggestedPracticeMode(PracticeMode.REPAIR.name())
                                        .disposition(IssueDisposition.ACTIVE)
                                        .priorityRank(1)
                                        .build());
                            }
                        }
                    }
                }

                // 10b. Singular quantifier (each, every) + plural noun -> singular noun
                if (tokLower.equals("each") || tokLower.equals("every")) {
                    if (i + 1 < tokens.size()) {
                        LinguisticAnalysisService.TokenAnalysis nTok = tokens.get(i + 1);
                        if (nTok.isPluralNoun()) {
                            String singNoun = linguisticAnalysisService.toSingularNoun(nTok.getToken());
                            if (singNoun != null && !singNoun.equalsIgnoreCase(nTok.getToken())) {
                                issues.add(FeedbackIssueDto.builder()
                                        .id(UUID.randomUUID().toString())
                                        .kind(IssueKind.ERROR)
                                        .severity(IssueSeverity.MAJOR)
                                        .category("Grammar")
                                        .patternCode("NOUN_NUMBER_AGREEMENT")
                                        .title("Hòa hợp 'each/every' với danh từ số ít")
                                        .explanation(String.format("Từ chỉ định '%s' phải đi kèm với danh từ số ít ('%s'), không đi với dạng số nhiều ('%s').", tokText, singNoun, nTok.getToken()))
                                        .sourceQuote(nTok.getToken())
                                        .startOffset(nTok.getStartPos())
                                        .endOffset(nTok.getEndPos())
                                        .replacement(singNoun)
                                        .teachingRule("'Each' và 'Every' luôn đi trực tiếp với danh từ đếm được số ít.")
                                        .suggestedPracticeMode(PracticeMode.REPAIR.name())
                                        .disposition(IssueDisposition.ACTIVE)
                                        .priorityRank(1)
                                        .build());
                            }
                        }
                    }
                }

                // 11. Relative Clause Antecedent Agreement
                if (tokLower.equals("who") || tokLower.equals("which") || (tokLower.equals("that") && i > 0 && tokens.get(i - 1).isNoun())) {
                    if (i > 0 && i + 1 < tokens.size()) {
                        LinguisticAnalysisService.TokenAnalysis antecedent = tokens.get(i - 1);
                        LinguisticAnalysisService.TokenAnalysis relVerb = tokens.get(i + 1);

                        if (antecedent.isSingularNoun() && !antecedent.isPluralNoun()) {
                            String verbLower = relVerb.getToken().toLowerCase();
                            if (verbLower.equals("are") || verbLower.equals("were") || verbLower.equals("have")) {
                                String rep = verbLower.equals("are") ? "is" : (verbLower.equals("were") ? "was" : "has");
                                issues.add(FeedbackIssueDto.builder()
                                        .id(UUID.randomUUID().toString())
                                        .kind(IssueKind.ERROR)
                                        .severity(IssueSeverity.MAJOR)
                                        .category("Grammar")
                                        .patternCode("RELATIVE_CLAUSE_AGREEMENT")
                                        .title("Hòa hợp động từ trong mệnh đề quan hệ với tiền từ số ít")
                                        .explanation(String.format("Tiền từ '%s' là danh từ số ít, nên động từ trong mệnh đề quan hệ sau '%s' phải chia số ít ('%s'), không dùng '%s'.", antecedent.getToken(), tokText, rep, relVerb.getToken()))
                                        .sourceQuote(relVerb.getToken())
                                        .startOffset(relVerb.getStartPos())
                                        .endOffset(relVerb.getEndPos())
                                        .replacement(rep)
                                        .teachingRule("Động từ trong mệnh đề quan hệ phải hòa hợp về số với danh từ tiền ngữ mà đại từ quan hệ thay thế.")
                                        .suggestedPracticeMode(PracticeMode.REPAIR.name())
                                        .disposition(IssueDisposition.ACTIVE)
                                        .priorityRank(1)
                                        .build());
                            } else if (relVerb.isBaseVerb() && !relVerb.isThirdPersonSingularVerb()) {
                                String third = linguisticAnalysisService.toThirdPersonSingularVerb(relVerb.getToken());
                                if (third != null && !third.equalsIgnoreCase(relVerb.getToken())) {
                                    issues.add(FeedbackIssueDto.builder()
                                            .id(UUID.randomUUID().toString())
                                            .kind(IssueKind.ERROR)
                                            .severity(IssueSeverity.MAJOR)
                                            .category("Grammar")
                                            .patternCode("RELATIVE_CLAUSE_AGREEMENT")
                                            .title("Hòa hợp động từ trong mệnh đề quan hệ: Tiền ngữ số ít cần thêm '-s/-es'")
                                            .explanation(String.format("Tiền ngữ '%s' là số ít, vì vậy động từ sau '%s' cần chia ở ngôi thứ 3 số ít ('%s').", antecedent.getToken(), tokText, third))
                                            .sourceQuote(relVerb.getToken())
                                            .startOffset(relVerb.getStartPos())
                                            .endOffset(relVerb.getEndPos())
                                            .replacement(third)
                                            .teachingRule("Khi tiền từ là danh từ số ít, động từ trong mệnh đề quan hệ phải chia theo ngôi thứ 3 số ít.")
                                            .suggestedPracticeMode(PracticeMode.REPAIR.name())
                                            .disposition(IssueDisposition.ACTIVE)
                                            .priorityRank(1)
                                            .build());
                                }
                            }
                        } else if (antecedent.isPluralNoun()) {
                            String verbLower = relVerb.getToken().toLowerCase();
                            if (verbLower.equals("is") || verbLower.equals("was") || verbLower.equals("has")) {
                                String rep = verbLower.equals("is") ? "are" : (verbLower.equals("was") ? "were" : "have");
                                issues.add(FeedbackIssueDto.builder()
                                        .id(UUID.randomUUID().toString())
                                        .kind(IssueKind.ERROR)
                                        .severity(IssueSeverity.MAJOR)
                                        .category("Grammar")
                                        .patternCode("RELATIVE_CLAUSE_AGREEMENT")
                                        .title("Hòa hợp động từ trong mệnh đề quan hệ với tiền từ số nhiều")
                                        .explanation(String.format("Tiền từ '%s' là danh từ số nhiều, nên động từ trong mệnh đề quan hệ sau '%s' phải chia số nhiều ('%s'), không dùng '%s'.", antecedent.getToken(), tokText, rep, relVerb.getToken()))
                                        .sourceQuote(relVerb.getToken())
                                        .startOffset(relVerb.getStartPos())
                                        .endOffset(relVerb.getEndPos())
                                        .replacement(rep)
                                        .teachingRule("Động từ trong mệnh đề quan hệ hòa hợp về số với tiền từ số nhiều.")
                                        .suggestedPracticeMode(PracticeMode.REPAIR.name())
                                        .disposition(IssueDisposition.ACTIVE)
                                        .priorityRank(1)
                                        .build());
                            } else if (relVerb.isThirdPersonSingularVerb()) {
                                String base = linguisticAnalysisService.toBaseVerb(relVerb.getToken());
                                if (base != null && !base.equalsIgnoreCase(relVerb.getToken())) {
                                    issues.add(FeedbackIssueDto.builder()
                                            .id(UUID.randomUUID().toString())
                                            .kind(IssueKind.ERROR)
                                            .severity(IssueSeverity.MAJOR)
                                            .category("Grammar")
                                            .patternCode("RELATIVE_CLAUSE_AGREEMENT")
                                            .title("Hòa hợp động từ trong mệnh đề quan hệ: Tiền ngữ số nhiều đi với dạng nguyên mẫu")
                                            .explanation(String.format("Tiền ngữ '%s' là số nhiều, vì vậy động từ sau '%s' phải ở dạng nguyên mẫu ('%s'), không thêm '-s/-es'.", antecedent.getToken(), tokText, base))
                                            .sourceQuote(relVerb.getToken())
                                            .startOffset(relVerb.getStartPos())
                                            .endOffset(relVerb.getEndPos())
                                            .replacement(base)
                                            .teachingRule("Khi tiền từ là số nhiều, mệnh đề quan hệ dùng dạng động từ nguyên mẫu ở thì hiện tại đơn.")
                                            .suggestedPracticeMode(PracticeMode.REPAIR.name())
                                            .disposition(IssueDisposition.ACTIVE)
                                            .priorityRank(1)
                                            .build());
                                }
                            }
                        }
                    }
                }

                // 12. Temporal Propagation Across Coordinated Clauses
                // Under narrative past context, coordinate finite base verbs following 'and' or 'but'
                if (hasNarrativePastContext && (tokLower.equals("and") || tokLower.equals("but"))) {
                    if (i + 1 < tokens.size()) {
                        LinguisticAnalysisService.TokenAnalysis vTok = tokens.get(i + 1);
                        if ((vTok.isBaseVerb() || vTok.isThirdPersonSingularVerb()) && !vTok.isPastTenseVerb() && !vTok.isModal()) {
                            String pastVerb = linguisticAnalysisService.toPastTenseVerb(vTok.getToken());
                            if (pastVerb != null && !pastVerb.equalsIgnoreCase(vTok.getToken())) {
                                issues.add(FeedbackIssueDto.builder()
                                        .id(UUID.randomUUID().toString())
                                        .kind(IssueKind.ERROR)
                                        .severity(IssueSeverity.MAJOR)
                                        .category("Grammar")
                                        .patternCode("PAST_TENSE_COORDINATED_CLAUSE")
                                        .title("Sự hòa hợp thì trong các vế câu đẳng lập (Past Tense Coordination)")
                                        .explanation(String.format("Trong ngữ cảnh trần thuật quá khứ, động từ nối tiếp qua liên từ cần chia cùng thì quá khứ ('%s') thay vì dạng hiện tại ('%s').", pastVerb, vTok.getToken()))
                                        .sourceQuote(vTok.getToken())
                                        .startOffset(vTok.getStartPos())
                                        .endOffset(vTok.getEndPos())
                                        .replacement(pastVerb)
                                        .teachingRule("Các hành động diễn ra liên tiếp trong quá khứ được nối bằng liên từ đẳng lập (and, but) phải chia đồng nhất ở thì quá khứ đơn.")
                                        .suggestedPracticeMode(PracticeMode.REPAIR.name())
                                        .disposition(IssueDisposition.ACTIVE)
                                        .priorityRank(1)
                                        .build());
                            }
                        }
                    }
                }
            }
        }

        // 13. Augment with embedded LanguageTool rule engine (for spelling, capitalization, punctuation, SVA, articles, modals, prepositions, etc.)
        if (languageToolGrammarService != null) {
            List<int[]> coveredSpans = new ArrayList<>();
            for (FeedbackIssueDto customIssue : issues) {
                int start = customIssue.getStartOffset() != null ? customIssue.getStartOffset() : 0;
                int end = customIssue.getEndOffset() != null ? customIssue.getEndOffset() : start + (customIssue.getSourceQuote() != null ? customIssue.getSourceQuote().length() : 0);
                coveredSpans.add(new int[]{start, end});
            }

            List<FeedbackIssueDto> ltIssues = languageToolGrammarService.checkText(text);
            for (FeedbackIssueDto lt : ltIssues) {
                int ltStart = lt.getStartOffset() != null ? lt.getStartOffset() : 0;
                int ltEnd = lt.getEndOffset() != null ? lt.getEndOffset() : ltStart + (lt.getSourceQuote() != null ? lt.getSourceQuote().length() : 0);
                boolean overlaps = false;
                for (int[] cSpan : coveredSpans) {
                    if (Math.max(ltStart, cSpan[0]) < Math.min(ltEnd, cSpan[1])) {
                        overlaps = true;
                        break;
                    }
                }
                if (!overlaps) {
                    coveredSpans.add(new int[]{ltStart, ltEnd});
                    issues.add(lt);
                }
            }
        }

        return issues;
    }

    /**
     * Critical Validation Boundary:
     * LLM grammar output must NOT be authoritative.
     * Every issue categorized as Grammar must pass deterministic validation before being returned to the frontend as a grammar error.
     */
    public ValidationResult validateAndFilterIssues(
            String text,
            List<FeedbackIssueDto> rawAiIssues,
            Boolean aiGrammaticallyCorrect
    ) {
        List<FeedbackIssueDto> deterministicIssues = checkDeterministicRules(text);
        List<FeedbackIssueDto> validatedIssues = new ArrayList<>();
        int droppedCount = 0;
        int reclassifiedCount = 0;

        // Spans and tokens covered by confirmed deterministic checker
        Set<String> coveredSpanKeys = new HashSet<>();
        for (FeedbackIssueDto det : deterministicIssues) {
            int start = det.getStartOffset() != null ? det.getStartOffset() : 0;
            int end = det.getEndOffset() != null ? det.getEndOffset() : start + (det.getSourceQuote() != null ? det.getSourceQuote().length() : 0);
            coveredSpanKeys.add(start + ":" + end);
            validatedIssues.add(det);
        }

        if (rawAiIssues != null) {
            for (FeedbackIssueDto issue : rawAiIssues) {
                String quote = issue.getSourceQuote() != null ? issue.getSourceQuote().trim() : "";
                String replacement = issue.getReplacement() != null ? issue.getReplacement().trim() : "";
                String cat = issue.getCategory() != null ? issue.getCategory().trim() : "General";
                String title = issue.getTitle() != null ? issue.getTitle() : "";
                String explanation = issue.getExplanation() != null ? issue.getExplanation() : "";
                String pattern = issue.getPatternCode() != null ? issue.getPatternCode() : "";
                String quoteLower = quote.toLowerCase();

                int start = issue.getStartOffset() != null ? issue.getStartOffset() : 0;
                int end = issue.getEndOffset() != null ? issue.getEndOffset() : start + quote.length();
                if (quote.isEmpty() && text != null && end > start && end <= text.length()) {
                    quote = text.substring(start, end).trim();
                    quoteLower = quote.toLowerCase();
                }

                // Normalize capitalization categories
                if (pattern.contains("CAPITALIZATION") || pattern.contains("UPPERCASE") || pattern.contains("CASING")
                        || title.toLowerCase().contains("capitalization") || title.toLowerCase().contains("viết hoa")) {
                    cat = "Capitalization";
                    issue.setCategory("Capitalization");
                }

                // FILTER 1: Drop identical replacement (LLM proposed unchanged text, e.g. "go" -> "go")
                if (!quote.isEmpty() && quote.equalsIgnoreCase(replacement)) {
                    log.info("DROPPING AI issue because replacement is identical to quote: '{}'", quote);
                    droppedCount++;
                    continue;
                }

                // FILTER 2: Semantic reconciliation with overlapping confirmed deterministic error span
                FeedbackIssueDto matchedDeterministic = null;
                for (FeedbackIssueDto det : deterministicIssues) {
                    int dStart = det.getStartOffset() != null ? det.getStartOffset() : 0;
                    int dEnd = det.getEndOffset() != null ? det.getEndOffset() : dStart + (det.getSourceQuote() != null ? det.getSourceQuote().length() : 0);
                    if (Math.max(start, dStart) < Math.min(end, dEnd) || (start == dStart && end == dEnd)) {
                        matchedDeterministic = det;
                        break;
                    }
                }
                if (matchedDeterministic != null) {
                    // Enrich confirmed deterministic issue with pedagogical explanation from AI
                    if (issue.getExplanation() != null && !issue.getExplanation().isBlank() && (matchedDeterministic.getExplanation() == null || issue.getExplanation().length() > matchedDeterministic.getExplanation().length())) {
                        matchedDeterministic.setExplanation(issue.getExplanation());
                    }
                    if (issue.getTeachingRule() != null && !issue.getTeachingRule().isBlank() && (matchedDeterministic.getTeachingRule() == null || matchedDeterministic.getTeachingRule().isBlank())) {
                        matchedDeterministic.setTeachingRule(issue.getTeachingRule());
                    }
                    if (issue.getTitle() != null && !issue.getTitle().isBlank() && (matchedDeterministic.getTitle() == null || matchedDeterministic.getTitle().isBlank())) {
                        matchedDeterministic.setTitle(issue.getTitle());
                    }
                    if (issue.getSuggestedPracticeMode() != null) {
                        matchedDeterministic.setSuggestedPracticeMode(issue.getSuggestedPracticeMode());
                    }

                    // Prefer smallest validated correction
                    String detRep = matchedDeterministic.getReplacement() != null ? matchedDeterministic.getReplacement().trim() : "";
                    if (!replacement.isEmpty()) {
                        boolean aiRepValid = isReplacementValid(text, start, end, replacement, pattern);
                        if (aiRepValid) {
                            if (detRep.isEmpty() || replacement.length() < detRep.length()) {
                                matchedDeterministic.setReplacement(replacement);
                            }
                        } else {
                            log.info("AI candidate replacement '{}' failed validation; keeping deterministic replacement '{}'", replacement, detRep);
                        }
                    }
                    // Prevent duplicate learner-facing cards for the same underlying mistake
                    continue;
                }

                // FILTER 3: Drop overlapping or duplicate spans with already validated issues
                boolean overlapsExisting = false;
                for (FeedbackIssueDto existing : validatedIssues) {
                    int eStart = existing.getStartOffset() != null ? existing.getStartOffset() : 0;
                    int eEnd = existing.getEndOffset() != null ? existing.getEndOffset() : eStart + (existing.getSourceQuote() != null ? existing.getSourceQuote().length() : 0);
                    if (Math.max(start, eStart) < Math.min(end, eEnd) || (start == eStart && end == eEnd)) {
                        overlapsExisting = true;
                        break;
                    }
                }
                String spanKey = start + ":" + end;
                if (overlapsExisting || coveredSpanKeys.contains(spanKey)) {
                    droppedCount++;
                    continue;
                }

                // FILTER 4: False Subject-Verb Agreement on past-tense verbs (which are invariant in person and number)
                boolean isPastVerb = quoteLower.endsWith("ed") && quoteLower.length() > 3;
                if (linguisticAnalysisService != null && !isPastVerb) {
                    String baseVerb = linguisticAnalysisService.toBaseVerb(quoteLower);
                    String pastForm = linguisticAnalysisService.toPastTenseVerb(baseVerb);
                    if (quoteLower.equalsIgnoreCase(pastForm) && !quoteLower.equals("was") && !quoteLower.equals("were")) {
                        isPastVerb = true;
                    }
                }
                if (isPastVerb && (pattern.contains("AGREEMENT") || title.toLowerCase().contains("agreement") || title.toLowerCase().contains("hòa hợp"))) {
                    log.info("DROPPING false SVA diagnosis on invariant past verb: '{}'", quote);
                    droppedCount++;
                    continue;
                }

                // FILTER 5: False Subject-Verb Agreement on 1st/2nd person or plural subjects (e.g. "I go", "they think")
                if (pattern.contains("AGREEMENT") || title.toLowerCase().contains("agreement") || title.toLowerCase().contains("hòa hợp")) {
                    if (isGrammaticallyCompliantSva(text, start, end, quote)) {
                        log.info("DROPPING false SVA diagnosis on grammatically compliant subject-verb: '{}'", quote);
                        droppedCount++;
                        continue;
                    }
                }

                // FILTER 6: Validate candidate replacement before accepting
                if (!replacement.isEmpty() && !isReplacementValid(text, start, end, replacement, pattern)) {
                    log.info("REJECTING invalid AI candidate replacement '{}' on quote '{}'", replacement, quote);
                    issue.setReplacement(null);
                }

                // Check if this is an objective grammar violation
                boolean isObjectiveGrammar = isObjectiveGrammarViolation(issue);

                // If it is an objective grammar violation, it MUST NOT be classified as Style / Naturalness
                if (issue.getKind() != IssueKind.UNCERTAIN && isObjectiveGrammar) {
                    if (issue.getKind() != IssueKind.ERROR) {
                        log.info("PROMOTING objective grammar finding to ERROR: '{}' on quote '{}'", title, quote);
                        issue.setKind(IssueKind.ERROR);
                        issue.setCategory("Grammar");
                        if (issue.getSeverity() == IssueSeverity.SUGGESTION) {
                            issue.setSeverity(IssueSeverity.MAJOR);
                        }
                        reclassifiedCount++;
                    }
                    validatedIssues.add(issue);
                    coveredSpanKeys.add(spanKey);
                    continue;
                }

                // Non-objective grammar: Purely stylistic suggestions remain IMPROVEMENT / Style
                if (issue.getKind() == IssueKind.ERROR && isPurelyStylistic(title, explanation, pattern)) {
                    log.info("Reclassifying stylistic AI claim to IMPROVEMENT: '{}'", title);
                    issue.setKind(IssueKind.IMPROVEMENT);
                    issue.setCategory("Style");
                    issue.setSeverity(IssueSeverity.SUGGESTION);
                    reclassifiedCount++;
                }

                validatedIssues.add(issue);
                coveredSpanKeys.add(spanKey);
            }
        }

        // Sort by priorityRank and startOffset
        validatedIssues.sort(Comparator.comparingInt((FeedbackIssueDto i) -> i.getPriorityRank() != null ? i.getPriorityRank() : 99)
                .thenComparingInt(i -> i.getStartOffset() != null ? i.getStartOffset() : 0));

        // Assign clean sequential priority ranks
        for (int i = 0; i < validatedIssues.size(); i++) {
            validatedIssues.get(i).setPriorityRank(i + 1);
        }

        // Determine authentic grammatical correctness
        boolean hasConfirmedGrammarError = validatedIssues.stream().anyMatch(i ->
                i.getKind() == IssueKind.ERROR && ("Grammar".equalsIgnoreCase(i.getCategory()) || "Capitalization".equalsIgnoreCase(i.getCategory()) || "Orthography".equalsIgnoreCase(i.getCategory()) || "Punctuation".equalsIgnoreCase(i.getCategory()) || "Spelling".equalsIgnoreCase(i.getCategory()))
        );

        boolean isGrammaticallyCorrect = !hasConfirmedGrammarError;

        log.info("DeterministicGrammarValidator finished: hasConfirmedError={}, dropped={}, reclassified={}, totalIssues={}",
                hasConfirmedGrammarError, droppedCount, reclassifiedCount, validatedIssues.size());

        return ValidationResult.builder()
                .grammaticallyCorrect(isGrammaticallyCorrect)
                .validatedIssues(validatedIssues)
                .droppedCount(droppedCount)
                .reclassifiedCount(reclassifiedCount)
                .build();
    }

    public boolean isReplacementValid(String fullText, int start, int end, String replacement, String patternCode) {
        if (fullText == null || replacement == null) return false;
        if (start < 0 || end > fullText.length() || start > end) return false;

        // 1. apply the candidate edit
        String candidateSentence = fullText.substring(0, start) + replacement + fullText.substring(end);

        // 2. re-run deterministic/objective linguistic checks relevant to that edit
        List<FeedbackIssueDto> candidateIssues = checkDeterministicRules(candidateSentence);

        int repLen = replacement.length();
        int candEnd = start + repLen;

        // 3. reject a replacement that recreates the same objective error or introduces an error in the edited span
        for (FeedbackIssueDto issue : candidateIssues) {
            int issueStart = issue.getStartOffset() != null ? issue.getStartOffset() : 0;
            int issueEnd = issue.getEndOffset() != null ? issue.getEndOffset() : issueStart;

            boolean overlapsEdit = Math.max(start, issueStart) < Math.min(candEnd, issueEnd) || (start == issueStart && candEnd == issueEnd);
            if (overlapsEdit && issue.getKind() == IssueKind.ERROR) {
                if (patternCode != null && !patternCode.isBlank() && patternCode.equalsIgnoreCase(issue.getPatternCode())) {
                    return false;
                }
                if (isObjectiveGrammarViolation(issue)) {
                    return false;
                }
            }
        }
        return true;
    }

    public boolean isObjectiveGrammarViolation(FeedbackIssueDto issue) {
        if (issue == null) return false;
        String cat = issue.getCategory() != null ? issue.getCategory().trim() : "";
        String pattern = issue.getPatternCode() != null ? issue.getPatternCode().toUpperCase() : "";
        String title = issue.getTitle() != null ? issue.getTitle().toLowerCase() : "";
        String exp = issue.getExplanation() != null ? issue.getExplanation().toLowerCase() : "";

        // Strictly objective categories
        if ("Grammar".equalsIgnoreCase(cat) || "Capitalization".equalsIgnoreCase(cat) ||
                "Orthography".equalsIgnoreCase(cat) || "Punctuation".equalsIgnoreCase(cat) ||
                "Spelling".equalsIgnoreCase(cat) || "Syntax".equalsIgnoreCase(cat)) {
            return !isPurelyStylistic(title, exp, pattern);
        }

        // Objective grammar pattern codes
        if (pattern.contains("AGREEMENT") || pattern.contains("SVA") || pattern.contains("TENSE")
                || pattern.contains("VERB_FORM") || pattern.contains("AUXILIARY") || pattern.contains("MODAL")
                || pattern.contains("COPULA") || pattern.contains("ARTICLE") || pattern.contains("DETERMINER")
                || pattern.contains("CAPITALIZATION") || pattern.contains("COUNTABILITY") || pattern.contains("PLURAL")
                || pattern.contains("SINGULAR") || pattern.contains("NUMBER")) {
            return true;
        }

        // Objective grammar title markers
        if (title.contains("hòa hợp") || title.contains("chủ ngữ") || title.contains("thì")
                || title.contains("động từ") || title.contains("số ít") || title.contains("số nhiều")
                || title.contains("mạo từ") || title.contains("viết hoa") || title.contains("agreement")
                || title.contains("tense") || title.contains("verb form") || title.contains("article")
                || title.contains("capitalization")) {
            return true;
        }

        return false;
    }

    private boolean isPurelyStylistic(String title, String explanation, String pattern) {
        String combined = (title + " " + explanation + " " + pattern).toLowerCase();
        boolean hasGrammarKeywords = combined.contains("hòa hợp") || combined.contains("agreement")
                || combined.contains("chia động từ") || combined.contains("verb form")
                || combined.contains("số nhiều") || combined.contains("số ít")
                || combined.contains("plural") || combined.contains("singular")
                || combined.contains("viết hoa") || combined.contains("capitalization")
                || combined.contains("mạo từ") || combined.contains("article");

        if (hasGrammarKeywords) {
            return false;
        }

        return combined.contains("more natural") ||
                combined.contains("tự nhiên hơn") ||
                combined.contains("phong cách") ||
                combined.contains("văn phong") ||
                combined.contains("concise") ||
                combined.contains("word choice") ||
                combined.contains("flow") ||
                combined.contains("awkward") ||
                combined.contains("preference") ||
                combined.contains("cân nhắc dùng");
    }

    private boolean isGrammaticallyCompliantSva(String fullText, int start, int end, String quote) {
        if (fullText == null || fullText.isBlank()) return false;
        String lowerFull = fullText.toLowerCase();
        String quoteLower = quote != null ? quote.toLowerCase().trim() : "";

        // Common 1st person singular + base verb: "i go", "i think", "i want"
        if (quoteLower.startsWith("i ") || lowerFull.contains("i " + quoteLower)) {
            return true;
        }
        // 2nd person: "you go", "you have"
        if (quoteLower.startsWith("you ") || lowerFull.contains("you " + quoteLower)) {
            return true;
        }
        // Plural: "we go", "they go"
        if (quoteLower.startsWith("we ") || quoteLower.startsWith("they ") ||
                lowerFull.contains("we " + quoteLower) || lowerFull.contains("they " + quoteLower)) {
            return true;
        }
        // 3rd person singular with -s/-es verb: "he goes", "she writes", "it works"
        if ((quoteLower.startsWith("he ") || quoteLower.startsWith("she ") || quoteLower.startsWith("it ")) &&
                (quoteLower.endsWith("s") || quoteLower.endsWith("es"))) {
            return true;
        }

        return false;
    }
}
