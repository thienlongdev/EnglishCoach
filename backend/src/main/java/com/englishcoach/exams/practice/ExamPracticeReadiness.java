package com.englishcoach.exams.practice;

import com.englishcoach.exams.model.ExamTypes.ExamFamily;
import com.englishcoach.exams.model.ExamTypes.SkillType;
import com.englishcoach.exams.release.ExamRunnerCapabilities;
import com.englishcoach.exams.scoring.ExamObjectiveScorer;
import com.englishcoach.exams.validation.ExamBlueprints;
import com.englishcoach.exams.validation.ExamContentTree;
import com.englishcoach.exams.validation.ExamContentTree.*;
import com.englishcoach.exams.validation.ExamContentValidationStatus;
import com.englishcoach.exams.validation.ExamFormValidationReport;
import com.englishcoach.exams.validation.ExamValidationCode;
import com.englishcoach.exams.validation.ExamValidationDiagnostic;
import com.englishcoach.exams.validation.ExamValidationSeverity;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.util.*;

/**
 * Exams Phase 6 — scope-level PRACTICE readiness (pure, deterministic, fail closed). It is NOT the full-form Phase 2
 * validator and NOT the import gate: it never grants IMPORT_READY or a human approval, and it does not weaken
 * {@code ExamFormValidator}. It answers, for each canonical part of ONE form: does the scope exist, is its own content
 * structurally trustworthy (the authoritative Phase 2 findings located in the scope, plus part-specific practice rules),
 * does every objective item carry a key, is every required medium VALIDATED, does the declared runtime support every
 * interaction, and is the form attemptable with rights + provenance. A full form being blocked does not block a sound
 * scope; a structurally valid form does not make every scope ready.
 *
 * <p>Reason codes are internal (admin diagnostics); learners only see {@link LearnerState}.
 */
public final class ExamPracticeReadiness {

    public static final String READINESS_VERSION = "exam-practice-readiness-v2";

    private ExamPracticeReadiness() {}

    /** Learner-facing availability (Vietnamese UI maps it to "Có thể luyện" / "Đang hoàn thiện nội dung" / "Chưa khả dụng"). */
    public enum LearnerState { AVAILABLE, CONTENT_IN_PROGRESS, UNAVAILABLE }

    /** Form-level facts that are not in the content tree. */
    public record FormFacts(boolean attemptableLifecycle, boolean rightsVerified) {}

    public record ScopeReadiness(ExamPracticeScope scope, boolean ready, List<String> reasonCodes, LearnerState learnerState,
                                 int audioAssets, int imageAssets) {
        public ScopeReadiness {
            reasonCodes = reasonCodes == null ? List.of() : List.copyOf(reasonCodes);
        }
    }

    // reason codes (internal)
    static final String SCOPE_AMBIGUOUS = "SCOPE_AMBIGUOUS";
    static final String SCOPE_EMPTY = "SCOPE_EMPTY";
    static final String VALIDATION_UNAVAILABLE = "VALIDATION_UNAVAILABLE";
    static final String VALIDATION_STALE = "VALIDATION_STALE";
    static final String FORM_STRUCTURE_UNKNOWN = "FORM_STRUCTURE_UNKNOWN";
    static final String OPERATOR_RESTRICTED = "OPERATOR_RESTRICTED";
    static final String FORM_NOT_ATTEMPTABLE = "FORM_NOT_ATTEMPTABLE";
    static final String RIGHTS_OR_PROVENANCE_UNVERIFIED = "RIGHTS_OR_PROVENANCE_UNVERIFIED";
    static final String ANSWER_KEY_MISSING = "ANSWER_KEY_MISSING";
    static final String QUESTION_NUMBERING_UNPROVEN = "QUESTION_NUMBERING_UNPROVEN";
    static final String MEDIA_AUDIO_MISSING = "MEDIA_AUDIO_MISSING";
    static final String MEDIA_AUDIO_PENDING = "MEDIA_AUDIO_PENDING";
    static final String MEDIA_IMAGE_PENDING = "MEDIA_IMAGE_PENDING";
    static final String VISUAL_MISSING = "VISUAL_MISSING";
    static final String PASSAGE_MISSING = "PASSAGE_MISSING";
    static final String TOEIC_PART_SHAPE_INVALID = "TOEIC_PART_SHAPE_INVALID";
    static final String WRITING_TASK_INCOMPLETE = "WRITING_TASK_INCOMPLETE";
    static final String INTERACTION_UNSUPPORTED_PREFIX = "INTERACTION_UNSUPPORTED:";
    static final String VALIDATION_PREFIX = "VALIDATION_";

    /** In-scope STANDARD findings that still make a practice scope untrustworthy (incomplete / flattened / unordered part). */
    private static final Set<ExamValidationCode> PRACTICE_BLOCKING_STANDARD = EnumSet.of(
            ExamValidationCode.TOEIC_PART_MISSING, ExamValidationCode.TOEIC_PART_ITEM_COUNT,
            ExamValidationCode.TOEIC_PART_GROUP_COUNT, ExamValidationCode.TOEIC_GROUP_SIZE,
            ExamValidationCode.TOEIC_MULTI_PASSAGE_MISSING, ExamValidationCode.TOEIC_PART_AUDIO_MISSING,
            ExamValidationCode.IELTS_LISTENING_PART_AUDIO_MISSING, ExamValidationCode.UNVALIDATED_MEDIA,
            ExamValidationCode.ITEM_ORDER_INVALID, ExamValidationCode.DUPLICATE_ITEM_KEY,
            ExamValidationCode.WORD_LIMIT_MISSING, ExamValidationCode.OPERATOR_REVIEW_REQUIRED);

    /** Reason codes that only mean "a medium still awaits technical / human validation". */
    private static final Set<String> MEDIA_PENDING = Set.of(MEDIA_AUDIO_PENDING, MEDIA_IMAGE_PENDING);

    /** Every canonical practice scope of the form with its readiness, in form order. */
    public static List<ScopeReadiness> evaluate(ExamContentTree tree, ExamFormValidationReport report,
                                                ExamRunnerCapabilities.Capabilities caps, FormFacts facts,
                                                ObjectMapper mapper) {
        ObjectMapper json = mapper != null ? mapper : new ObjectMapper();
        List<ScopeReadiness> out = new ArrayList<>();
        if (tree == null) return out;

        Map<String, List<Object[]>> byCode = new LinkedHashMap<>();
        List<SectionNode> sections = new ArrayList<>(tree.sections());
        sections.sort(Comparator.comparingInt(SectionNode::ordinal));
        for (SectionNode s : sections) {
            List<PartNode> parts = new ArrayList<>(s.parts());
            parts.sort(Comparator.comparingInt(PartNode::ordinal));
            for (PartNode p : parts) {
                // Older IELTS Writing packages store both tasks in one unnumbered part.
                // Use explicit printed placement labels, never ordinal/key/minimum-word guesses.
                if (tree.family() == ExamFamily.IELTS && s.skill() == SkillType.WRITING
                        && ExamPracticeScopeType.resolve(tree.family(), s.skill(), p.partCode()).isEmpty()) {
                    for (GroupNode g : p.groups()) {
                        String label = g.displayNumbering() == null ? "" : g.displayNumbering().trim();
                        if (!label.matches("(?i)Task [12]")) continue;
                        int task = Integer.parseInt(label.substring(label.length() - 1));
                        var r = new ExamPracticeScopeType.Resolved(ExamPracticeScopeType.IELTS_WRITING_TASK, task, "IELTS_WRITING_TASK_" + task);
                        byCode.computeIfAbsent(r.scopeCode(), k -> new ArrayList<>()).add(new Object[]{r, s,
                                new PartNode(p.id(), p.partCode(), p.ordinal(), List.of(g))});
                    }
                    continue;
                }
                ExamPracticeScopeType.resolve(tree.family(), s.skill(), p.partCode())
                        .ifPresent(r -> byCode.computeIfAbsent(r.scopeCode(), k -> new ArrayList<>()).add(new Object[]{r, s, p}));
            }
        }
        // The canonical tree is immutable during this pure evaluation; hash it once, not once per part.
        String fingerprint = report != null && report.status() != ExamContentValidationStatus.UNKNOWN
                && report.contentFingerprint() != null ? tree.fingerprint() : null;
        for (Map.Entry<String, List<Object[]>> e : byCode.entrySet()) {
            Object[] first = e.getValue().get(0);
            ExamPracticeScopeType.Resolved r = (ExamPracticeScopeType.Resolved) first[0];
            SectionNode s = (SectionNode) first[1];
            PartNode p = (PartNode) first[2];
            ExamPracticeScope scope = scopeOf(tree, r, s, p, json);
            Set<String> reasons = new TreeSet<>();
            int[] media = new int[2];
            if (e.getValue().size() > 1) {
                // two stored parts claim the same printed scope: never guess which one the learner meant
                reasons.add(SCOPE_AMBIGUOUS);
            } else {
                check(tree, report, caps, facts, json, r, s, p, reasons, media, fingerprint);
            }
            boolean ready = reasons.isEmpty();
            LearnerState state = ready ? LearnerState.AVAILABLE
                    : MEDIA_PENDING.containsAll(reasons) ? LearnerState.CONTENT_IN_PROGRESS : LearnerState.UNAVAILABLE;
            out.add(new ScopeReadiness(scope, ready, List.copyOf(reasons), state, media[0], media[1]));
        }
        return out;
    }

    private static ExamPracticeScope scopeOf(ExamContentTree tree, ExamPracticeScopeType.Resolved r, SectionNode s, PartNode p,
                                             ObjectMapper json) {
        List<GroupNode> groups = new ArrayList<>(p.groups());
        groups.sort(Comparator.comparingInt(GroupNode::ordinal));
        List<UUID> placements = new ArrayList<>();
        List<UUID> groupIds = new ArrayList<>();
        Set<UUID> assets = new LinkedHashSet<>();
        int items = 0, objective = 0;
        for (GroupNode g : groups) {
            placements.add(g.placementId());
            groupIds.add(g.groupId());
            for (StimulusNode st : g.stimuli()) for (AssetNode a : st.assets()) if (a.id() != null) assets.add(a.id());
            for (ItemNode i : g.items()) {
                items++;
                if (!ExamRunnerCapabilities.PRODUCTIVE_INTERACTIONS.contains(norm(i.interactionType()))) objective++;
            }
        }
        String scoring = r.type().objective() ? ExamPracticeScope.SCORING_OBJECTIVE_RAW : ExamPracticeScope.SCORING_RESPONSE_ONLY;
        return new ExamPracticeScope(r.scopeCode(), r.type(), tree.family(), s.skill(), r.number(), tree.formId(), s.id(), p.id(),
                p.partCode(), placements, groupIds, items, objective, scoring, List.copyOf(assets));
    }

    private static void check(ExamContentTree tree, ExamFormValidationReport report, ExamRunnerCapabilities.Capabilities caps,
                              FormFacts facts, ObjectMapper json, ExamPracticeScopeType.Resolved r, SectionNode s, PartNode p,
                              Set<String> reasons, int[] media, String fingerprint) {
        if (facts == null || !facts.attemptableLifecycle()) reasons.add(FORM_NOT_ATTEMPTABLE);
        if (facts == null || !facts.rightsVerified()) reasons.add(RIGHTS_OR_PROVENANCE_UNVERIFIED);

        // authoritative Phase 2 findings, localized to this scope
        if (report == null || report.status() == ExamContentValidationStatus.UNKNOWN) {
            reasons.add(VALIDATION_UNAVAILABLE);
        } else {
            if (report.contentFingerprint() == null || !report.contentFingerprint().equals(fingerprint)) {
                reasons.add(VALIDATION_STALE);
            }
            for (ExamValidationDiagnostic d : report.formDiagnostics()) {
                if (d.code() == ExamValidationCode.FORM_SCOPE_UNKNOWN) reasons.add(FORM_STRUCTURE_UNKNOWN);
                else if (d.severity() == ExamValidationSeverity.BLOCKING) reasons.add(VALIDATION_PREFIX + d.code().name());
                // FORM_SKILL_MISSING / SCORING_SCHEME_MISSING concern other skills / standardized scales, not a raw scope
            }
            for (ExamFormValidationReport.SectionValidation sv : report.sections()) {
                if (!s.id().equals(sv.sectionId())) continue;
                for (ExamValidationDiagnostic d : sv.diagnostics()) {
                    boolean inScope = d.partCode() != null && d.partCode().equals(p.partCode());
                    boolean sectionWide = d.partCode() == null && d.groupId() == null;
                    if (sectionWide) {
                        if (d.code() == ExamValidationCode.OPERATOR_FORM_DISABLED || d.code() == ExamValidationCode.OPERATOR_SECTION_DISABLED
                                || d.code() == ExamValidationCode.OPERATOR_REVIEW_REQUIRED) {
                            reasons.add(OPERATOR_RESTRICTED);
                        } else if (d.severity() == ExamValidationSeverity.BLOCKING
                                && d.code() != ExamValidationCode.REQUIRED_AUDIO_MISSING
                                && d.code() != ExamValidationCode.SECTION_TIMING_MISSING) {
                            // whole-section blockers (empty / unknown section); audio is judged per scope below and an
                            // untimed practice part does not depend on the section's official duration
                            reasons.add(VALIDATION_PREFIX + d.code().name());
                        }
                        continue;
                    }
                    if (!inScope) continue;
                    if (d.groupId() != null && p.groups().stream().noneMatch(g -> d.groupId().equals(g.groupId()))) continue;
                    if (d.groupId() == null && (d.code() == ExamValidationCode.TOEIC_PART_ITEM_COUNT
                            || d.code() == ExamValidationCode.TOEIC_PART_GROUP_COUNT
                            || d.code() == ExamValidationCode.TOEIC_MULTI_PASSAGE_MISSING)
                            && com.englishcoach.exams.content.ToeicPackagePublication.exactPartSet(
                                tree.formId(), p.partCode(), p.groups().stream().mapToInt(g -> g.items().size()).sum())) continue;
                    if (d.severity() == ExamValidationSeverity.BLOCKING
                            || (d.severity() == ExamValidationSeverity.STANDARD && PRACTICE_BLOCKING_STANDARD.contains(d.code()))) {
                        reasons.add(VALIDATION_PREFIX + d.code().name());
                    }
                }
            }
        }

        List<GroupNode> groups = p.groups();
        List<ItemNode> items = new ArrayList<>();
        for (GroupNode g : groups) items.addAll(g.items());
        if (groups.isEmpty() || items.isEmpty()) {
            reasons.add(SCOPE_EMPTY);
            return;
        }

        // declared runtime: every interaction must be SUPPORTED (and objectively scorable when objective)
        for (ItemNode i : items) {
            String it = norm(i.interactionType());
            boolean productive = ExamRunnerCapabilities.PRODUCTIVE_INTERACTIONS.contains(it);
            boolean supported = caps.interactions().get(it) == ExamRunnerCapabilities.Support.SUPPORTED
                    && (productive || caps.objectiveScorerInteractions().contains(it));
            if (!supported || productive != !r.type().objective()) reasons.add(INTERACTION_UNSUPPORTED_PREFIX + (it.isEmpty() ? "BLANK" : it));
        }

        // label the map / plan / diagram: the figure must be deliverable, otherwise the targets are meaningless
        for (GroupNode g : groups) {
            boolean labels = g.items().stream().anyMatch(i -> "LABEL_ASSIGNMENT".equals(norm(i.interactionType())));
            if (labels && g.stimuli().stream().noneMatch(ExamPracticeReadiness::isVisualWithAsset)) reasons.add(VISUAL_MISSING);
        }

        mediaChecks(r, s, groups, reasons, media);
        if (r.type().objective()) {
            for (ItemNode i : items) if (!hasKey(i, json)) reasons.add(ANSWER_KEY_MISSING);
            if (!numberingContiguous(items, json)) reasons.add(QUESTION_NUMBERING_UNPROVEN);
        }
        switch (r.type()) {
            case TOEIC_PART -> toeicShape(r.number(), groups, json, reasons);
            case IELTS_READING_PASSAGE -> {
                if (groups.stream().noneMatch(ExamPracticeReadiness::hasPassage)) reasons.add(PASSAGE_MISSING);
            }
            case IELTS_WRITING_TASK -> writingTask(tree, r.number(), groups, items, json, reasons);
            case IELTS_LISTENING_SECTION -> { /* audio + numbering + Phase 2 findings above */ }
            case IELTS_SPEAKING_PART -> {
                if (items.stream().anyMatch(i -> i.prompt() == null || i.prompt().isBlank())) reasons.add(SCOPE_EMPTY);
            }
        }
    }

    private static void mediaChecks(ExamPracticeScopeType.Resolved r, SectionNode s, List<GroupNode> groups, Set<String> reasons,
                                    int[] media) {
        int validatedAudio = 0;
        for (GroupNode g : groups) {
            for (StimulusNode st : g.stimuli()) {
                boolean audio = "AUDIO".equals(st.normalizedKind()) || st.assets().stream().anyMatch(AssetNode::isAudio);
                for (AssetNode a : st.assets()) {
                    if (a.isAudio()) media[0]++;
                    else media[1]++;
                }
                if (audio) {
                    long ok = st.assets().stream().filter(a -> a.isAudio() && a.isValidated()).count();
                    validatedAudio += (int) ok;
                    if (st.assets().isEmpty()) reasons.add(MEDIA_AUDIO_MISSING);
                    else if (ok == 0 || st.assets().stream().anyMatch(a -> a.isAudio() && !a.isValidated())) reasons.add(MEDIA_AUDIO_PENDING);
                } else if (st.assets().stream().anyMatch(a -> !a.isValidated())) {
                    // a grant refuses a non-VALIDATED image: the learner would see a broken figure
                    reasons.add(MEDIA_IMAGE_PENDING);
                }
            }
        }
        if (s.skill() == SkillType.LISTENING && validatedAudio == 0 && !reasons.contains(MEDIA_AUDIO_PENDING)) {
            reasons.add(MEDIA_AUDIO_MISSING);
        }
    }

    private static void toeicShape(int part, List<GroupNode> groups, ObjectMapper json, Set<String> reasons) {
        for (GroupNode g : groups) {
            int size = g.items().size();
            boolean visual = g.stimuli().stream().anyMatch(ExamPracticeReadiness::isVisualWithAsset);
            switch (part) {
                case 1 -> {
                    if (size != 1) reasons.add(TOEIC_PART_SHAPE_INVALID);
                    if (!visual) reasons.add(VISUAL_MISSING);
                }
                case 2 -> {
                    // printed TOEIC Part 2 offers three responses (A–C): never forced to four
                    for (ItemNode i : g.items()) if (optionCount(i, json) != 3) reasons.add(TOEIC_PART_SHAPE_INVALID);
                }
                case 3, 4 -> {
                    if (size != 3) reasons.add(TOEIC_PART_SHAPE_INVALID);
                }
                case 6 -> {
                    if (size < 3 || size > 4) reasons.add(TOEIC_PART_SHAPE_INVALID);
                    if (!hasPassage(g)) reasons.add(PASSAGE_MISSING);
                }
                case 7 -> {
                    if (!hasPassage(g)) reasons.add(PASSAGE_MISSING);
                }
                default -> { /* Part 5: standalone sentences */ }
            }
        }
    }

    private static void writingTask(ExamContentTree tree, int task, List<GroupNode> groups, List<ItemNode> items, ObjectMapper json,
                                    Set<String> reasons) {
        if (items.size() != 1) {
            reasons.add(WRITING_TASK_INCOMPLETE);
            return;
        }
        ItemNode i = items.get(0);
        if (i.prompt() == null || i.prompt().isBlank() || minimumWords(i, json) == null) reasons.add(WRITING_TASK_INCOMPLETE);
        boolean academic = "ACADEMIC".equalsIgnoreCase(tree.variant() == null ? "" : tree.variant().trim());
        if (tree.family() == ExamFamily.IELTS && academic && task == 1) {
            boolean visual = groups.stream().flatMap(g -> g.stimuli().stream()).anyMatch(ExamPracticeReadiness::isVisualWithAsset);
            if (!visual) reasons.add(VISUAL_MISSING);
        }
    }

    // ─── helpers ───────────────────────────────────────────────────────────────────────────

    /** A figure the learner can actually see: a visual stimulus with an image asset (delivered by grant). */
    static boolean isVisualWithAsset(StimulusNode st) {
        return ExamBlueprints.VISUAL_KINDS.contains(st.normalizedKind()) && !st.assets().isEmpty();
    }

    static boolean hasPassage(GroupNode g) {
        return g.stimuli().stream().anyMatch(st -> ExamBlueprints.PASSAGE_KINDS.contains(st.normalizedKind()) && st.hasPayload());
    }

    @SuppressWarnings("unchecked")
    static boolean hasKey(ItemNode i, ObjectMapper json) {
        if (i.answer() == null || i.answer().acceptedAnswersJson() == null) return false;
        try {
            Map<String, Object> accepted = json.readValue(i.answer().acceptedAnswersJson(), Map.class);
            if (!ExamObjectiveScorer.nonBlankAccepted(accepted).isEmpty()) return true;
            if (accepted.get("unorderedSet") instanceof Map<?, ?> set && set.get("values") instanceof List<?> l) {
                return l.stream().anyMatch(o -> o != null && !o.toString().isBlank());
            }
            return accepted.get("matching") instanceof Map<?, ?> m && !m.isEmpty()
                    && m.values().stream().allMatch(v -> v != null && !v.toString().isBlank());
        } catch (Exception e) {
            return false;
        }
    }

    /** Printed question numbers of the scope are present, unique and contiguous (an omitted group leaves a gap). */
    static boolean numberingContiguous(List<ItemNode> items, ObjectMapper json) {
        List<Integer> numbers = new ArrayList<>();
        for (ItemNode i : items) {
            Integer n = questionNumber(i, json);
            if (n == null) return false;
            numbers.add(n);
        }
        Collections.sort(numbers);
        for (int k = 1; k < numbers.size(); k++) if (numbers.get(k) != numbers.get(k - 1) + 1) return false;
        return true;
    }

    static Integer questionNumber(ItemNode i, ObjectMapper json) {
        JsonNode defs = parse(i.optionDefinitionsJson(), json);
        if (defs != null && defs.get("questionNumber") != null && defs.get("questionNumber").canConvertToInt()) {
            return defs.get("questionNumber").asInt();
        }
        return null;
    }

    static int optionCount(ItemNode i, ObjectMapper json) {
        JsonNode defs = parse(i.optionDefinitionsJson(), json);
        JsonNode options = defs == null ? null : defs.isArray() ? defs : defs.has("options") ? defs.get("options") : defs.get("choices");
        return options != null && options.isArray() ? options.size() : 0;
    }

    static Integer minimumWords(ItemNode i, ObjectMapper json) {
        if (i.answer() != null && i.answer().wordLimit() != null && i.answer().wordLimit() > 0) return i.answer().wordLimit();
        for (String text : new String[]{i.optionDefinitionsJson(), i.answer() == null ? null : i.answer().acceptedAnswersJson()}) {
            JsonNode root = parse(text, json);
            if (root != null && root.isObject()) {
                for (String f : List.of("minimumWords", "minWords", "wordLimit")) {
                    JsonNode n = root.get(f);
                    if (n != null && n.canConvertToInt() && n.asInt() > 0) return n.asInt();
                }
            }
        }
        return null;
    }

    private static JsonNode parse(String text, ObjectMapper json) {
        if (text == null || text.isBlank()) return null;
        try {
            return json.readTree(text);
        } catch (Exception e) {
            return null;
        }
    }

    static String norm(String v) {
        return v == null ? "" : v.trim().toUpperCase(Locale.ROOT);
    }
}
