package com.englishcoach.exams.practice;

import com.englishcoach.exams.exception.ExamExceptionHandler.ExamNotFoundException;
import com.englishcoach.exams.model.ExamAttemptRecords.*;
import com.englishcoach.exams.model.ExamContentRecords.AnswerSpecRecord;
import com.englishcoach.exams.model.ExamContentRecords.FormVersionRecord;
import com.englishcoach.exams.model.ExamContentRecords.PublicAssetRefDto;
import com.englishcoach.exams.model.ExamTypes.*;
import com.englishcoach.exams.practice.ExamPracticeReadiness.ScopeReadiness;
import com.englishcoach.exams.practice.ExamPracticeRecords.*;
import com.englishcoach.exams.release.ExamRunnerCapabilities;
import com.englishcoach.exams.repository.ExamAttemptRepository;
import com.englishcoach.exams.repository.ExamContentRepository;
import com.englishcoach.exams.scoring.ExamAttemptSnapshotContent;
import com.englishcoach.exams.scoring.ExamObjectiveScorer;
import com.englishcoach.exams.scoring.ExamObjectiveScorer.ItemScoreResult;
import com.englishcoach.exams.service.ExamAttemptService;
import com.englishcoach.exams.service.ExamManifestService;
import com.englishcoach.exams.service.ExamRightsService;
import com.englishcoach.exams.validation.ExamContentTree;
import com.englishcoach.exams.validation.ExamContentValidationRepository;
import com.englishcoach.exams.validation.ExamContentValidationService;
import com.englishcoach.exams.validation.ExamFormValidationReport;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Duration;
import java.time.Instant;
import java.util.*;
import java.util.regex.Pattern;

/**
 * Exams Phase 6 — first-class PRACTICE over canonical scopes, built on the canonical attempt architecture (same
 * {@code exams.attempts} rows, same lifecycle endpoints, same snapshot / evidence-basis pinning, same scorer). A practice
 * attempt pins the scope-filtered content snapshot plus its {@link ExamPracticeScope}; the client names only a scope
 * code, never item ids. Practice is always {@code PRACTICE} mode ⇒ the pinned evidence basis grants no skill, so no
 * path (worker, reconciliation, backfill) can turn it into official evidence. Results are raw metrics; review is built
 * from the attempt snapshot and discloses keys only after submission, to the owner.
 */
@Slf4j
@Service
public class ExamPracticeService {

    public static final String SCOPE_UNAVAILABLE_CODE = "PRACTICE_SCOPE_UNAVAILABLE";
    public static final String SCOPE_UNAVAILABLE_MESSAGE_VI = "Phần luyện tập này hiện chưa khả dụng.";
    public static final String SOURCE_UNAVAILABLE_CODE = "PRACTICE_SOURCE_UNAVAILABLE";
    public static final String SOURCE_UNAVAILABLE_MESSAGE_VI =
            "Phiên bản đề của lần luyện trước hiện không còn khả dụng để luyện lại.";
    public static final String REVIEW_NOT_AVAILABLE_CODE = "REVIEW_NOT_AVAILABLE";
    public static final String IN_PROGRESS_CODE = "PRACTICE_ATTEMPT_IN_PROGRESS";
    static final String CREATE_OPERATION = "CREATE_PRACTICE_ATTEMPT";
    private static final Pattern SCOPE_CODE = Pattern.compile("^[A-Z0-9_]{3,48}$");

    private final ExamContentRepository contentRepository;
    private final ExamAttemptRepository attemptRepository;
    private final ExamContentValidationService validationService;
    private final ExamContentValidationRepository treeRepository;
    private final ExamRightsService rightsService;
    private final ExamManifestService manifestService;
    private final ExamObjectiveScorer objectiveScorer;
    private final ObjectMapper objectMapper;

    public ExamPracticeService(ExamContentRepository contentRepository, ExamAttemptRepository attemptRepository,
                               ExamContentValidationService validationService, ExamContentValidationRepository treeRepository,
                               ExamRightsService rightsService, ExamManifestService manifestService,
                               ExamObjectiveScorer objectiveScorer, ObjectMapper objectMapper) {
        this.contentRepository = contentRepository;
        this.attemptRepository = attemptRepository;
        this.validationService = validationService;
        this.treeRepository = treeRepository;
        this.rightsService = rightsService;
        this.manifestService = manifestService;
        this.objectiveScorer = objectiveScorer;
        this.objectMapper = objectMapper;
    }

    /** Readiness of every canonical scope of one form (fail closed: no tree / no form ⇒ no scope). */
    public record FormPractice(FormVersionRecord form, ExamFormValidationReport report, List<ScopeReadiness> scopes) {}

    public FormPractice evaluateForm(UUID formId) {
        FormVersionRecord form = contentRepository.findFormById(formId)
                .orElseThrow(() -> new ExamNotFoundException("Form not found: " + formId));
        Optional<ExamContentTree> tree = treeRepository.loadTree(formId);
        if (tree.isEmpty()) return new FormPractice(form, null, List.of());
        if (!com.englishcoach.exams.service.ExamLearnerProductPolicy.allows(form.family(),
                tree.get().sections().stream().map(ExamContentTree.SectionNode::skill).toList())) {
            throw new ExamNotFoundException("Form not available in the learner product: " + formId);
        }
        ExamFormValidationReport report = validationService.evaluate(formId);
        if (report.contentFingerprint() == null || !report.contentFingerprint().equals(tree.get().fingerprint())) {
            // cached validation of older content: recompute once, never trust a stale result
            report = validationService.revalidate(formId, ExamContentValidationService.Trigger.LEARNER_READ);
        }
        boolean attemptable = form.lifecycleState() == LifecycleState.PUBLISHED || form.lifecycleState() == LifecycleState.PILOT;
        boolean rights = rightsService.verifyFormRights(formId);
        List<ScopeReadiness> scopes = ExamPracticeReadiness.evaluate(tree.get(), report, ExamRunnerCapabilities.CURRENT,
                new ExamPracticeReadiness.FormFacts(attemptable, rights), objectMapper);
        return new FormPractice(form, report, scopes);
    }

    /** Learner catalog of a form's practice scopes (no internal reason codes). */
    public PracticeCatalogDto getCatalog(UUID formId) {
        FormPractice fp = evaluateForm(formId);
        List<PracticeScopeDto> scopes = fp.scopes().stream().map(sr -> new PracticeScopeDto(
                sr.scope().scopeCode(), sr.scope().scopeType().name(), sr.scope().skill(), sr.scope().number(),
                sr.scope().itemCount(), sr.scope().objectiveScoring(), sr.scope().scoringMode(), ExamPracticeScope.TIMING_UNTIMED,
                sr.learnerState().name(), sr.ready(), sr.audioAssets() > 0, sr.imageAssets() > 0)).toList();
        return new PracticeCatalogDto(fp.form().id(), fp.form().family(), fp.form().title(), scopes);
    }

    /** Operator diagnostics (reason codes, ids, counts). */
    public List<PracticeScopeDiagnosticDto> getDiagnostics(UUID formId) {
        return evaluateForm(formId).scopes().stream().map(sr -> new PracticeScopeDiagnosticDto(
                sr.scope().scopeCode(), sr.scope().scopeType().name(), sr.scope().skill(), sr.scope().number(),
                sr.scope().sectionId(), sr.scope().partId(), sr.scope().partCode(), sr.scope().groupIds().size(),
                sr.scope().itemCount(), sr.scope().objectiveItemCount(), sr.audioAssets(), sr.imageAssets(), sr.ready(),
                sr.learnerState().name(), sr.reasonCodes(), ExamPracticeReadiness.READINESS_VERSION)).toList();
    }

    // ─── Attempt creation / Practice Again ────────────────────────────────────────────────────

    @Transactional
    public PracticeAttemptDto createPracticeAttempt(Long userId, CreatePracticeAttemptRequest req) {
        if (req == null || req.formId() == null) throw new IllegalArgumentException("PRACTICE_FORM_REQUIRED");
        return create(userId, req.formId(), req.scopeCode(), req.clientMutationId(), null);
    }

    /**
     * A NEW attempt over the SAME pinned form version and scope code (deterministic: never silently switched to a
     * successor version). If that version / scope can no longer be practised, the request is refused with
     * {@link #SOURCE_UNAVAILABLE_CODE}; the historical attempt is never touched.
     */
    @Transactional
    public PracticeAttemptDto practiceAgain(Long userId, UUID attemptId, String clientMutationId) {
        AttemptRecord previous = ownedScopedAttempt(userId, attemptId);
        if (previous.status() == ExamAttemptStatus.CREATED || previous.status() == ExamAttemptStatus.READY
                || previous.status() == ExamAttemptStatus.IN_PROGRESS) {
            throw new IllegalStateException(IN_PROGRESS_CODE + ": submit the current practice attempt first");
        }
        Map<String, Object> scope = ExamPracticeScope.pinned(previous.manifestSnapshot()).orElseThrow();
        UUID sourceFormId = UUID.fromString(String.valueOf(scope.get("sourceFormId")));
        String scopeCode = String.valueOf(scope.get("scopeCode"));
        // Exams Phase 9D: rapid repeated "Practice Again" clicks (each carrying a fresh client mutation id) never create
        // several attempts: serialized per learner, and an unfinished retry of THIS attempt is resumed instead.
        attemptRepository.acquireUserPracticeLock(userId);
        Optional<AttemptRecord> unfinished = attemptRepository.findUnfinishedPracticeAgain(userId, previous.id());
        if (unfinished.isPresent()) {
            AttemptRecord again = unfinished.get();
            return new PracticeAttemptDto(again.id(), again.formId(), scopeCode, again.status().name(), true, previous.id());
        }
        try {
            return create(userId, sourceFormId, scopeCode, clientMutationId, previous.id());
        } catch (ExamNotFoundException | ScopeUnavailableException e) {
            throw new IllegalStateException(SOURCE_UNAVAILABLE_CODE + ": " + e.getMessage());
        }
    }

    /** Internal signal: the requested scope exists but is not practice-ready (mapped to 409 by the handler). */
    public static final class ScopeUnavailableException extends IllegalStateException {
        public ScopeUnavailableException(String detail) {
            super(SCOPE_UNAVAILABLE_CODE + ": " + detail);
        }
    }

    private PracticeAttemptDto create(Long userId, UUID formId, String scopeCode, String clientMutationId, UUID practiceAgainOf) {
        if (userId == null) throw new IllegalArgumentException("USER_REQUIRED");
        if (scopeCode == null || !SCOPE_CODE.matcher(scopeCode.trim()).matches()) {
            throw new IllegalArgumentException("PRACTICE_SCOPE_INVALID");
        }
        String code = scopeCode.trim();
        String cmd = clientMutationId != null && !clientMutationId.isBlank() ? clientMutationId.trim() : null;
        if (cmd != null) {
            Optional<CommandReceiptRecord> replay = attemptRepository.findCommandReceipt(userId, CREATE_OPERATION, cmd);
            if (replay.isPresent() && replay.get().resultReference() != null) {
                UUID existingId = UUID.fromString(replay.get().resultReference());
                AttemptRecord existing = attemptRepository.findAttemptById(existingId)
                        .filter(a -> userId.equals(a.userId()))
                        .orElseThrow(() -> new ExamNotFoundException("Attempt not found: " + existingId));
                return new PracticeAttemptDto(existing.id(), existing.formId(), code, existing.status().name(), true, practiceAgainOf);
            }
        }

        FormPractice fp = evaluateForm(formId);
        ScopeReadiness sr = fp.scopes().stream().filter(s -> s.scope().scopeCode().equals(code)).findFirst()
                .orElseThrow(() -> new ExamNotFoundException("Practice scope not found: " + code));
        if (!sr.ready()) {
            log.info("[ExamsPractice] scope {} of form {} refused: {}", code, formId, sr.reasonCodes());
            throw new ScopeUnavailableException(code);
        }
        ExamPracticeScope scope = sr.scope();
        FormVersionRecord form = fp.form();

        ExamManifestService.FormSnapshotResult full = manifestService.serializeFormSnapshot(form);
        Map<String, Object> scoped = scope.filterSnapshot(full.snapshot())
                .orElseThrow(() -> new IllegalStateException("SNAPSHOT_CREATION_FAILED: scope does not match the form snapshot"));
        scoped.put(ExamPracticeScope.SNAPSHOT_KEY, scope.toSnapshotMap(form.logicalKey(), form.version(), practiceAgainOf));
        ExamManifestService.FormSnapshotResult scopedSnapshot =
                new ExamManifestService.FormSnapshotResult(scoped, full.version(), ExamManifestService.canonicalHash(scoped));
        // PRACTICE ⇒ the pinned evidence basis carries NO evidence skill (ExamAttemptEvidenceBasis#pin)
        Map<String, Object> pinned = ExamAttemptService.pinEvidenceBasis(scopedSnapshot, fp.report(), form,
                ExamAttemptMode.PRACTICE, EnumSet.of(scope.skill()));

        Map<String, Object> meta = new LinkedHashMap<>();
        meta.put("initialClientMutationId", cmd != null ? cmd : "");
        meta.put("selectedSkills", List.of(scope.skill().name()));
        meta.put("practiceScopeCode", code);
        Instant now = Instant.now();
        AttemptRecord attempt = new AttemptRecord(null, userId, form.id(), form.family(), form.variant(),
                scope.scopeType().name(), ExamAttemptMode.PRACTICE, null, null, ExamAttemptStatus.CREATED, 1L, 1L,
                null, null, scopedSnapshot.hash(), meta, null, null, null, null, null, List.of(), now, now,
                pinned, scopedSnapshot.version(), ExamSnapshotState.SNAPSHOTTED);
        UUID attemptId = attemptRepository.insertAttempt(attempt);
        if (cmd != null) {
            attemptRepository.insertCommandReceipt(new CommandReceiptRecord(null, userId, attemptId, cmd, CREATE_OPERATION,
                    ExamManifestService.canonicalHash(Map.of("formId", formId.toString(), "scopeCode", code)),
                    attemptId.toString(), "SUCCESS", now));
        }
        log.info("[ExamsPractice] created practice attempt {} user {} form {} scope {}", attemptId, userId, formId, code);
        return new PracticeAttemptDto(attemptId, form.id(), code, ExamAttemptStatus.CREATED.name(), false, practiceAgainOf);
    }

    // ─── Result / Review (attempt snapshot only) ──────────────────────────────────────────────

    public PracticeResultDto getResult(Long userId, UUID attemptId) {
        AttemptRecord attempt = ownedScopedAttempt(userId, attemptId);
        return result(attempt, scoreScope(attempt));
    }

    public PracticeReviewDto getReview(Long userId, UUID attemptId) {
        AttemptRecord attempt = ownedScopedAttempt(userId, attemptId);
        if (attempt.submittedAt() == null || attempt.status() != ExamAttemptStatus.SUBMITTED) {
            // answers are disclosed only after submission
            throw new IllegalStateException(REVIEW_NOT_AVAILABLE_CODE + ": submit the practice attempt first");
        }
        ScopeScore score = scoreScope(attempt);
        return review(attempt, score);
    }

    /** The owner's practice-scoped attempt; a missing, foreign or non-scoped attempt is indistinguishable (404). */
    AttemptRecord ownedScopedAttempt(Long userId, UUID attemptId) {
        AttemptRecord attempt = attemptId == null ? null : attemptRepository.findAttemptById(attemptId).orElse(null);
        if (attempt == null || userId == null || !userId.equals(attempt.userId())
                || attempt.attemptMode() != ExamAttemptMode.PRACTICE
                || attempt.snapshotState() != ExamSnapshotState.SNAPSHOTTED
                || !ExamPracticeScope.isScoped(attempt.manifestSnapshot())) {
            throw new ExamNotFoundException("Practice attempt not found: " + attemptId);
        }
        return attempt;
    }

    /** Snapshot items + learner responses scored with the same set-aware scorer the worker uses. */
    record ScopeScore(ExamAttemptSnapshotContent content, Map<UUID, ResponseRecord> responses, Map<UUID, ItemScoreResult> results,
                      Map<String, Object> scope) {}

    ScopeScore scoreScope(AttemptRecord attempt) {
        Map<String, Object> scope = ExamPracticeScope.pinned(attempt.manifestSnapshot()).orElseThrow();
        ExamAttemptSnapshotContent content = ExamAttemptSnapshotContent.parse(attempt.manifestSnapshot())
                .orElseThrow(() -> new IllegalStateException("SNAPSHOT_INVALID: practice attempt " + attempt.id()));
        Map<UUID, ResponseRecord> responses = new HashMap<>();
        for (ResponseRecord r : attemptRepository.findResponsesByAttemptId(attempt.id())) {
            if (r.itemId() != null) responses.put(r.itemId(), r);
        }
        Map<UUID, ItemScoreResult> results = new HashMap<>();
        if (ExamPracticeScope.SCORING_OBJECTIVE_RAW.equals(scope.get("scoringMode"))) {
            List<ExamObjectiveScorer.ObjectiveItemInput> inputs = new ArrayList<>();
            for (ExamAttemptSnapshotContent.SnapshotItem it : content.allItems()) {
                if (it.answerSpec() == null) continue;
                inputs.add(new ExamObjectiveScorer.ObjectiveItemInput(it.itemId(), it.questionNumber(),
                        learnerAnswer(responses.get(it.itemId())), it.answerSpec(), it.numbersExempt()));
            }
            for (ItemScoreResult r : objectiveScorer.scoreItems(inputs)) results.put(r.itemId(), r);
        }
        return new ScopeScore(content, responses, results, scope);
    }

    PracticeResultDto result(AttemptRecord attempt, ScopeScore s) {
        Map<String, Object> scope = s.scope();
        boolean submitted = attempt.submittedAt() != null && attempt.status() == ExamAttemptStatus.SUBMITTED;
        boolean objective = ExamPracticeScope.SCORING_OBJECTIVE_RAW.equals(scope.get("scoringMode"));
        Integer correct = null, incorrect = null, unanswered = null, answered = null, total = null, wordCount = null, minWords = null;
        Double accuracy = null, avg = null;
        String writing = null;
        Long spent = attempt.startedAt() != null && attempt.submittedAt() != null
                ? Math.max(0, Duration.between(attempt.startedAt(), attempt.submittedAt()).getSeconds()) : null;
        if (submitted && objective) {
            int c = 0, i = 0, u = 0, t = 0;
            for (ExamAttemptSnapshotContent.SnapshotItem it : s.content().allItems()) {
                ItemScoreResult r = s.results().get(it.itemId());
                if (r == null || ExamObjectiveScorer.OUTCOME_UNKEYED.equals(r.outcome())) continue;
                t++;
                if (r.isCorrect()) c++;
                else if (ExamObjectiveScorer.OUTCOME_BLANK.equals(r.outcome())) u++;
                else i++;
            }
            correct = c;
            incorrect = i;
            unanswered = u;
            answered = c + i;
            total = t;
            accuracy = t > 0 ? Math.round(c * 1000.0 / t) / 10.0 : 0.0;
            avg = spent != null && t > 0 ? Math.round(spent * 10.0 / t) / 10.0 : null;
        } else if (!objective && !"SPEAKING".equals(scope.get("skill"))) {
            ExamAttemptSnapshotContent.SnapshotItem task = s.content().allItems().isEmpty() ? null : s.content().allItems().get(0);
            if (task != null) {
                wordCount = countEssayWords(text(s.responses().get(task.itemId())));
                minWords = minimumWords(task);
            }
            writing = "NOT_SCORED";
        }
        return new PracticeResultDto(attempt.id(), ExamAttemptMode.PRACTICE.name(), attempt.family(),
                String.valueOf(scope.get("scopeCode")), String.valueOf(scope.get("scopeType")),
                SkillType.valueOf(String.valueOf(scope.get("skill"))), intOf(scope.get("number")),
                formTitle(attempt), UUID.fromString(String.valueOf(scope.get("sourceFormId"))), intOrNull(scope.get("sourceFormVersion")),
                submitted ? "SUBMITTED" : attempt.status().name(), String.valueOf(scope.get("scoringMode")),
                correct, incorrect, unanswered, answered, total, accuracy, submitted ? spent : null, avg, wordCount, minWords,
                writing, false, submitted, attempt.submittedAt());
    }

    @SuppressWarnings("unchecked")
    PracticeReviewDto review(AttemptRecord attempt, ScopeScore s) {
        Map<String, Object> scope = s.scope();
        boolean objective = ExamPracticeScope.SCORING_OBJECTIVE_RAW.equals(scope.get("scoringMode"));
        SkillType skill = SkillType.valueOf(String.valueOf(scope.get("skill")));
        String partInstructions = null;
        List<ReviewGroupDto> groups = new ArrayList<>();
        for (Map<String, Object> sec : maps(attempt.manifestSnapshot().get("sections"))) {
            for (Map<String, Object> part : maps(sec.get("parts"))) {
                if (partInstructions == null && part.get("instructions") instanceof String pi && !pi.isBlank()) partInstructions = pi;
                String partCode = String.valueOf(part.get("partCode"));
                for (Map<String, Object> grp : maps(part.get("groups"))) {
                    List<ReviewStimulusDto> stimuli = new ArrayList<>();
                    boolean evidence = false;
                    for (Map<String, Object> st : maps(grp.get("stimuli"))) {
                        String kind = st.get("kind") == null ? "" : String.valueOf(st.get("kind"));
                        Map<String, Object> body = ExamLearnerContentSanitizer.stimulusBody(kind,
                                st.get("bodyPayload") instanceof Map<?, ?> b ? (Map<String, Object>) b : null);
                        if (skill == SkillType.READING && (body.containsKey("text") || body.containsKey("paragraphs")
                                || body.containsKey("documents"))) evidence = true;
                        List<PublicAssetRefDto> assets = new ArrayList<>();
                        for (Map<String, Object> a : maps(st.get("assets"))) {
                            if (a.get("assetId") == null) continue;
                            assets.add(new PublicAssetRefDto(UUID.fromString(String.valueOf(a.get("assetId"))),
                                    (String) a.get("role"), (String) a.get("mimeType"),
                                    a.get("durationMs") instanceof Number n ? n.intValue() : null));
                        }
                        stimuli.add(new ReviewStimulusDto(st.get("id") == null ? null : UUID.fromString(String.valueOf(st.get("id"))),
                                kind, (String) st.get("title"), body, assets));
                    }
                    String base = "p_" + partCode + "_g_" + grp.get("logicalGroupKey");
                    List<ReviewItemDto> items = new ArrayList<>();
                    Map<String, Object> presentation = null;
                    int position = 0;
                    for (Map<String, Object> im : maps(grp.get("items"))) {
                        position++;
                        UUID itemId = UUID.fromString(String.valueOf(im.get("id")));
                        Integer ordinal = intOrNull(im.get("ordinal"));
                        Map<String, Object> defs = im.get("optionDefinitions") instanceof Map<?, ?> d ? (Map<String, Object>) d : null;
                        Map<String, Object> safeDefs = ExamLearnerContentSanitizer.optionDefinitions(defs);
                        if (presentation == null && safeDefs != null && safeDefs.get("group") instanceof Map<?, ?> g) {
                            presentation = new LinkedHashMap<>((Map<String, Object>) g);
                            if (safeDefs.get("selection") != null) presentation.put("selection", safeDefs.get("selection"));
                        }
                        Integer qn = defs != null && defs.get("questionNumber") instanceof Number n ? n.intValue() : ordinal;
                        ResponseRecord resp = s.responses().get(itemId);
                        ExamAttemptSnapshotContent.SnapshotItem snapItem = s.content().allItems().stream()
                                .filter(x -> x.itemId().equals(itemId)).findFirst().orElse(null);
                        if (objective) {
                            ItemScoreResult r = s.results().get(itemId);
                            String status = r == null || ExamObjectiveScorer.OUTCOME_UNKEYED.equals(r.outcome()) ? "NOT_SCORED"
                                    : r.isCorrect() ? "CORRECT"
                                    : ExamObjectiveScorer.OUTCOME_BLANK.equals(r.outcome()) ? "UNANSWERED" : "INCORRECT";
                            AnswerSpecRecord spec = snapItem == null ? null : snapItem.answerSpec();
                            List<String> correctAnswers = correctAnswers(spec);
                            String explanation = spec != null && spec.explanation() != null && !spec.explanation().isBlank()
                                    ? spec.explanation() : null;
                            items.add(new ReviewItemDto(itemId, base + "_i_" + (ordinal != null ? ordinal : position),
                                    (String) im.get("logicalItemKey"), intOf(im.get("version")), qn, (String) im.get("prompt"),
                                    (String) im.get("interactionType"), safeDefs, displayAnswer(resp), correctAnswers, status,
                                    r == null ? null : r.outcome(), !correctAnswers.isEmpty(), explanation != null, explanation,
                                    evidence, false, null, null));
                        } else {
                            String text = text(resp);
                            items.add(new ReviewItemDto(itemId, base + "_i_" + (ordinal != null ? ordinal : position),
                                    (String) im.get("logicalItemKey"), intOf(im.get("version")), qn, (String) im.get("prompt"),
                                    (String) im.get("interactionType"), safeDefs, text, List.of(), "NOT_SCORED", null, false,
                                    false, null, false, false, countEssayWords(text), snapItem == null ? null : minimumWords(snapItem)));
                        }
                    }
                    groups.add(new ReviewGroupDto(UUID.fromString(String.valueOf(grp.get("id"))),
                            grp.get("displayNumbering") instanceof String dn ? dn : null, (String) grp.get("questionType"),
                            presentation, stimuli, items));
                }
            }
        }
        return new PracticeReviewDto(attempt.id(), attempt.family(), String.valueOf(scope.get("scopeCode")),
                String.valueOf(scope.get("scopeType")), skill, intOf(scope.get("number")), formTitle(attempt),
                UUID.fromString(String.valueOf(scope.get("sourceFormId"))), intOrNull(scope.get("sourceFormVersion")),
                attempt.submittedAt(), "ATTEMPT_SNAPSHOT", result(attempt, s), partInstructions, groups);
    }

    // ─── helpers ───────────────────────────────────────────────────────────────────────────

    /** Correct answers the learner may see after submission: accepted values (or the choose-N key set), nothing else. */
    @SuppressWarnings("unchecked")
    public static List<String> correctAnswers(AnswerSpecRecord spec) {
        if (spec == null || spec.acceptedAnswers() == null) return List.of();
        Map<String, Object> accepted = spec.acceptedAnswers();
        if (accepted.get("unorderedSet") instanceof Map<?, ?> set && set.get("values") instanceof List<?> l) {
            List<String> out = new ArrayList<>();
            for (Object o : l) if (o != null && !o.toString().isBlank()) out.add(o.toString());
            return out;
        }
        List<String> values = ExamObjectiveScorer.nonBlankAccepted(accepted);
        if (!values.isEmpty()) return values;
        if (accepted.get("matching") instanceof Map<?, ?> m) {
            List<String> out = new ArrayList<>();
            for (Map.Entry<?, ?> e : m.entrySet()) if (e.getValue() != null) out.add(e.getKey() + "=" + e.getValue());
            return out;
        }
        return List.of();
    }

    static Object learnerAnswer(ResponseRecord resp) {
        if (resp == null) return null;
        return resp.answerPayload() != null ? resp.answerPayload() : resp.textResponse();
    }

    /** The learner's stored answer in display form ({value} unwrapped, else the text). */
    static Object displayAnswer(ResponseRecord resp) {
        if (resp == null) return null;
        Map<String, Object> p = resp.answerPayload();
        if (p != null) {
            for (String k : List.of("value", "text", "selectedOption", "choiceId", "answer", "selected")) {
                if (p.get(k) != null) return p.get(k);
            }
        }
        return resp.textResponse();
    }

    static String text(ResponseRecord resp) {
        if (resp == null) return null;
        if (resp.textResponse() != null && !resp.textResponse().isBlank()) return resp.textResponse();
        Object v = displayAnswer(resp);
        return v instanceof String s ? s : null;
    }

    public static Integer countEssayWords(String text) {
        if (text == null || text.isBlank()) return 0;
        int n = 0;
        for (String token : text.trim().split("\\s+")) if (token.codePoints().anyMatch(Character::isLetterOrDigit)) n++;
        return n;
    }

    public static Integer minimumWords(ExamAttemptSnapshotContent.SnapshotItem item) {
        if (item.answerSpec() != null && item.answerSpec().wordLimit() != null && item.answerSpec().wordLimit() > 0) {
            return item.answerSpec().wordLimit();
        }
        if (item.optionDefinitions() != null && item.optionDefinitions().get("minimumWords") instanceof Number n) return n.intValue();
        if (item.answerSpec() != null && item.answerSpec().acceptedAnswers() != null
                && item.answerSpec().acceptedAnswers().get("minimumWords") instanceof Number n) return n.intValue();
        return null;
    }

    @SuppressWarnings("unchecked")
    static String formTitle(AttemptRecord attempt) {
        Object form = attempt.manifestSnapshot() == null ? null : attempt.manifestSnapshot().get("form");
        return form instanceof Map<?, ?> m && m.get("title") != null ? String.valueOf(((Map<String, Object>) m).get("title")) : null;
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> maps(Object o) {
        if (!(o instanceof List<?> l)) return List.of();
        List<Map<String, Object>> out = new ArrayList<>();
        for (Object e : l) if (e instanceof Map<?, ?> m) out.add((Map<String, Object>) m);
        return out;
    }

    private static int intOf(Object o) {
        return o instanceof Number n ? n.intValue() : 0;
    }

    private static Integer intOrNull(Object o) {
        return o instanceof Number n ? n.intValue() : null;
    }
}
