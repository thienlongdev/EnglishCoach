package com.englishcoach.exams.practice;

import com.englishcoach.exams.exception.ExamConcurrencyException;
import com.englishcoach.exams.exception.ExamExceptionHandler.ExamNotFoundException;
import com.englishcoach.exams.media.ExamMediaService;
import com.englishcoach.exams.media.ExamObjectStorage;
import com.englishcoach.exams.model.ExamAttemptRecords.*;
import com.englishcoach.exams.model.ExamContentRecords.FormVersionRecord;
import com.englishcoach.exams.model.ExamTypes.*;
import com.englishcoach.exams.practice.ExamPracticeRecords.*;
import com.englishcoach.exams.repository.ExamAttemptRepository;
import com.englishcoach.exams.repository.ExamContentRepository;
import com.englishcoach.exams.repository.ExamMediaRepository;
import com.englishcoach.exams.repository.ExamScoringRepository;
import com.englishcoach.exams.scoring.ExamAnswerNormalizer;
import com.englishcoach.exams.scoring.ExamAttemptSnapshotContent;
import com.englishcoach.exams.scoring.ExamObjectiveScorer;
import com.englishcoach.exams.service.ExamManifestService;
import com.englishcoach.exams.service.ExamResponseService;
import com.englishcoach.exams.service.ExamRightsService;
import com.englishcoach.exams.validation.*;
import com.englishcoach.exams.validation.ExamContentTree.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/**
 * Exams Phase 6 — Docker-free service-level Practice + Review over the synthetic canonical trees (real readiness,
 * real Phase 2 validator, real scorer, real response / grant guards; repositories in memory). Complements the
 * PostgreSQL 17 {@code ExamPracticePostgresTest} (staged corpus) with the same contract.
 */
class ExamPracticeServiceTest {

    static final ObjectMapper MAPPER = new ObjectMapper().findAndRegisterModules();
    static final long LEARNER = 101L, OTHER = 102L;

    final ExamContentRepository content = mock(ExamContentRepository.class);
    final ExamAttemptRepository attempts = mock(ExamAttemptRepository.class);
    final ExamContentValidationRepository trees = mock(ExamContentValidationRepository.class);
    final ExamContentValidationService validation = mock(ExamContentValidationService.class);
    final ExamRightsService rights = mock(ExamRightsService.class);
    final ExamManifestService manifests = mock(ExamManifestService.class);
    final Map<UUID, AttemptRecord> store = new LinkedHashMap<>();
    final Map<UUID, List<ResponseRecord>> answers = new HashMap<>();
    final Map<String, CommandReceiptRecord> receipts = new HashMap<>();
    ExamPracticeService practice;
    ExamContentTree tree;
    LifecycleState lifecycle = LifecycleState.PILOT;

    @BeforeEach
    void setUp() {
        practice = new ExamPracticeService(content, attempts, validation, trees, rights, manifests,
                new ExamObjectiveScorer(new ExamAnswerNormalizer()), MAPPER);
        when(rights.verifyFormRights(any())).thenReturn(true);
        when(content.findFormById(any())).thenAnswer(inv -> tree != null && tree.formId().equals(inv.getArgument(0))
                ? Optional.of(form()) : Optional.empty());
        when(trees.loadTree(any())).thenAnswer(inv -> Optional.ofNullable(tree));
        when(validation.evaluate(any())).thenAnswer(inv -> ExamFormValidator.validate(tree, MAPPER, Instant.now()));
        when(validation.revalidate(any(), any())).thenAnswer(inv -> ExamFormValidator.validate(tree, MAPPER, Instant.now()));
        when(manifests.serializeFormSnapshot(any())).thenAnswer(inv ->
                new ExamManifestService.FormSnapshotResult(snapshotOf(tree), "v4.0", "full-hash"));
        when(attempts.insertAttempt(any())).thenAnswer(inv -> {
            AttemptRecord a = inv.getArgument(0);
            UUID id = UUID.randomUUID();
            store.put(id, with(a, id, a.status(), null));
            return id;
        });
        when(attempts.findAttemptById(any())).thenAnswer(inv -> Optional.ofNullable(store.get((UUID) inv.getArgument(0))));
        when(attempts.findResponsesByAttemptId(any())).thenAnswer(inv -> answers.getOrDefault((UUID) inv.getArgument(0), List.of()));
        when(attempts.findCommandReceipt(anyLong(), anyString(), anyString())).thenAnswer(inv ->
                Optional.ofNullable(receipts.get(inv.getArgument(0) + "|" + inv.getArgument(1) + "|" + inv.getArgument(2))));
        doAnswer(inv -> {
            CommandReceiptRecord r = inv.getArgument(0);
            receipts.put(r.userId() + "|" + r.operation() + "|" + r.commandId(), r);
            return null;
        }).when(attempts).insertCommandReceipt(any());
    }

    FormVersionRecord form() {
        return new FormVersionRecord(tree.formId(), "SYNTHETIC-" + tree.family(), 1, "synthetic form", tree.family(), tree.variant(),
                tree.scope(), null, null, null, lifecycle, UUID.randomUUID(), null, "h", null, null, Instant.now());
    }

    static AttemptRecord with(AttemptRecord a, UUID id, ExamAttemptStatus status, Instant submittedAt) {
        return new AttemptRecord(id, a.userId(), a.formId(), a.family(), a.variant(), a.scope(), a.attemptMode(), null, null, status,
                a.revision(), a.writerEpoch(), null, null, a.pinnedManifestHash(), a.clientSessionMeta(), null,
                submittedAt != null ? submittedAt.minusSeconds(300) : null, null, submittedAt, null, List.of(), a.createdAt(),
                Instant.now(), a.manifestSnapshot(), a.manifestSnapshotVersion(), a.snapshotState());
    }

    /** Same shape as ExamManifestService#serializeFormSnapshot (form → sections → parts → groups → stimuli / items + spec). */
    @SuppressWarnings("unchecked")
    static Map<String, Object> snapshotOf(ExamContentTree t) {
        List<Object> sections = new ArrayList<>();
        for (SectionNode s : t.sections()) {
            List<Object> parts = new ArrayList<>();
            for (PartNode p : s.parts()) {
                List<Object> groups = new ArrayList<>();
                for (GroupNode g : p.groups()) {
                    List<Object> stimuli = new ArrayList<>();
                    for (StimulusNode st : g.stimuli()) {
                        List<Object> assets = new ArrayList<>();
                        for (AssetNode a : st.assets()) {
                            assets.add(new LinkedHashMap<>(Map.of("assetId", a.id().toString(), "role", "VISIBLE_MEDIA",
                                    "mimeType", a.mimeType())));
                        }
                        Map<String, Object> body = new LinkedHashMap<>(Map.of("text", "synthetic passage", "sourcePages", List.of(3)));
                        stimuli.add(new LinkedHashMap<>(Map.of("id", st.id().toString(), "kind", st.kind(), "title", "synthetic",
                                "bodyPayload", body, "assets", assets)));
                    }
                    List<Object> items = new ArrayList<>();
                    for (ItemNode i : g.items()) {
                        Map<String, Object> item = new LinkedHashMap<>();
                        item.put("id", i.id().toString());
                        item.put("logicalItemKey", i.logicalKey());
                        item.put("version", 1);
                        item.put("prompt", i.prompt());
                        item.put("interactionType", i.interactionType());
                        item.put("optionDefinitions", read(i.optionDefinitionsJson()));
                        item.put("ordinal", i.ordinal());
                        if (i.answer() != null) {
                            Map<String, Object> spec = new LinkedHashMap<>();
                            spec.put("id", i.answer().id().toString());
                            spec.put("acceptedAnswers", read(i.answer().acceptedAnswersJson()));
                            spec.put("normalizationPolicy", Map.of());
                            spec.put("cardinality", i.answer().cardinality());
                            spec.put("wordLimit", i.answer().wordLimit());
                            spec.put("creditUnits", 1.0);
                            item.put("answerSpec", spec);
                        }
                        items.add(item);
                    }
                    Map<String, Object> grp = new LinkedHashMap<>();
                    grp.put("id", g.groupId().toString());
                    grp.put("logicalGroupKey", "lg" + g.groupId().toString().substring(0, 8));
                    grp.put("placementOrdinal", g.ordinal());
                    grp.put("questionType", "SYNTHETIC");
                    grp.put("skill", s.skill().name());
                    grp.put("stimuli", stimuli);
                    grp.put("items", items);
                    groups.add(grp);
                }
                Map<String, Object> part = new LinkedHashMap<>(Map.of("id", p.id().toString(), "partCode", p.partCode(), "ordinal", p.ordinal()));
                part.put("groups", groups);
                parts.add(part);
            }
            Map<String, Object> sec = new LinkedHashMap<>(Map.of("id", s.id().toString(), "skill", s.skill().name(), "ordinal", s.ordinal(),
                    "durationSeconds", s.durationSeconds()));
            sec.put("parts", parts);
            sections.add(sec);
        }
        Map<String, Object> snap = new LinkedHashMap<>();
        snap.put("version", "v4.0");
        snap.put("form", new LinkedHashMap<>(Map.of("id", t.formId().toString(), "title", "synthetic form", "family", t.family().name())));
        snap.put("sections", sections);
        return snap;
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> read(String json) {
        try {
            return json == null ? null : MAPPER.readValue(json, Map.class);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    PracticeAttemptDto create(String code) {
        return practice.createPracticeAttempt(LEARNER, new CreatePracticeAttemptRequest(tree.formId(), code, null));
    }

    void answer(UUID attemptId, Map<UUID, String> byItem) {
        List<ResponseRecord> list = new ArrayList<>();
        byItem.forEach((item, v) -> list.add(new ResponseRecord(UUID.randomUUID(), attemptId, null, "p", item, Map.of("value", v), v, null,
                false, 1, null, Instant.now())));
        answers.put(attemptId, list);
    }

    void submit(UUID attemptId) {
        AttemptRecord a = store.get(attemptId);
        store.put(attemptId, with(a, attemptId, ExamAttemptStatus.SUBMITTED, Instant.now()));
    }

    static List<ExamAttemptSnapshotContent.SnapshotItem> items(AttemptRecord a) {
        return ExamAttemptSnapshotContent.parse(a.manifestSnapshot()).orElseThrow().allItems();
    }

    @SuppressWarnings("unchecked")
    static String key(ExamAttemptSnapshotContent.SnapshotItem it) {
        return ExamObjectiveScorer.nonBlankAccepted(it.answerSpec().acceptedAnswers()).get(0);
    }

    // ─── tests ─────────────────────────────────────────────────────────────────────────────

    @Test
    @DisplayName("01–09/17: each TOEIC part creates a PRACTICE attempt pinning ONLY that part (groups kept whole), no evidence skill")
    @SuppressWarnings("unchecked")
    void toeicScopedAttempts() {
        tree = new PracticeTreeFixtures.Toeic().build();
        Map<String, Integer> expectedGroups = Map.of("TOEIC_PART_1", 6, "TOEIC_PART_2", 1, "TOEIC_PART_3", 13, "TOEIC_PART_4", 10,
                "TOEIC_PART_5", 1, "TOEIC_PART_6", 4, "TOEIC_PART_7", 15);
        for (Map.Entry<String, Integer> e : expectedGroups.entrySet()) {
            PracticeAttemptDto dto = create(e.getKey());
            AttemptRecord a = store.get(dto.attemptId());
            assertEquals(ExamAttemptMode.PRACTICE, a.attemptMode());
            assertEquals("TOEIC_PART", a.scope());
            List<Map<String, Object>> secs = (List<Map<String, Object>>) a.manifestSnapshot().get("sections");
            assertEquals(1, secs.size());
            List<Map<String, Object>> parts = (List<Map<String, Object>>) secs.get(0).get("parts");
            assertEquals(1, parts.size());
            assertEquals(e.getValue(), ((List<?>) parts.get(0).get("groups")).size(), e.getKey());
            assertEquals(List.of(), ((Map<String, Object>) a.manifestSnapshot().get("evidenceBasis")).get("evidenceSkills"));
            assertEquals(List.of(secs.get(0).get("skill")), a.clientSessionMeta().get("selectedSkills"));
            assertEquals(ExamManifestService.canonicalHash(new LinkedHashMap<>(a.manifestSnapshot()) {{ remove("evidenceBasis"); }}),
                    a.pinnedManifestHash());
        }
        Map<String, Object> p2scope = ExamPracticeScope.pinned(store.values().stream()
                .filter(a -> "TOEIC_PART_2".equals(a.clientSessionMeta().get("practiceScopeCode"))).findFirst().orElseThrow()
                .manifestSnapshot()).orElseThrow();
        assertEquals(25, p2scope.get("itemCount"));
        long multiDoc = ((List<Map<String, Object>>) ((List<Map<String, Object>>) ((List<Map<String, Object>>) store.values().stream()
                .filter(a -> "TOEIC_PART_7".equals(a.clientSessionMeta().get("practiceScopeCode"))).findFirst().orElseThrow()
                .manifestSnapshot().get("sections")).get(0).get("parts")).get(0).get("groups")).stream()
                .filter(g -> ((List<Map<String, Object>>) g.get("stimuli")).stream().anyMatch(s -> "MULTI_DOC".equals(s.get("kind")))).count();
        assertEquals(5, multiDoc, "double + triple passage sets stay whole");
    }

    @Test
    @DisplayName("14/15/16: unavailable, source-blocked, unknown and malformed scopes are refused; nothing is persisted")
    void refusals() {
        PracticeTreeFixtures.Toeic f = new PracticeTreeFixtures.Toeic();
        f.part1ImageState = "PENDING";
        tree = f.build();
        assertThrows(ExamPracticeService.ScopeUnavailableException.class, () -> create("TOEIC_PART_1"));
        assertThrows(ExamNotFoundException.class, () -> create("TOEIC_PART_8"));
        assertThrows(IllegalArgumentException.class, () -> create("TOEIC_PART_5 OR 1=1"));
        PracticeTreeFixtures.Toeic blocked = new PracticeTreeFixtures.Toeic();
        blocked.keyed = false;
        tree = blocked.build();
        assertThrows(ExamPracticeService.ScopeUnavailableException.class, () -> create("TOEIC_PART_5"));
        assertTrue(store.isEmpty(), "no attempt row for a refused scope");
        PracticeCatalogDto cat = practice.getCatalog(tree.formId());
        assertTrue(cat.scopes().stream().allMatch(s -> "UNAVAILABLE".equals(s.availability()) && !s.reviewAvailable()));
    }

    @Test
    @DisplayName("16/31: autosave and submit accept ONLY placements of the pinned scope")
    void placementGuard() {
        tree = new PracticeTreeFixtures.Toeic().build();
        UUID id = create("TOEIC_PART_5").attemptId();
        AttemptRecord a = store.get(id);
        AttemptRecord running = new AttemptRecord(id, LEARNER, a.formId(), a.family(), a.variant(), a.scope(), a.attemptMode(), null,
                null, ExamAttemptStatus.IN_PROGRESS, 4, 1, null, null, a.pinnedManifestHash(), a.clientSessionMeta(), null,
                Instant.now(), null, null, null, List.of(), a.createdAt(), Instant.now(), a.manifestSnapshot(), "v4.0",
                ExamSnapshotState.SNAPSHOTTED);
        ExamAttemptRepository repo = mock(ExamAttemptRepository.class);
        when(repo.findAttemptByIdForUpdate(id)).thenReturn(Optional.of(running));
        UUID section = UUID.fromString(String.valueOf(ExamPracticeScope.pinned(a.manifestSnapshot()).orElseThrow().get("sectionId")));
        when(repo.findSectionsByAttemptId(id)).thenReturn(List.of(new AttemptSectionRecord(UUID.randomUUID(), id, section,
                ExamSectionState.ACTIVE, "MAIN", Instant.now(), null, null, Map.of(), Instant.now())));
        ExamResponseService responses = new ExamResponseService(repo, mock(ExamScoringRepository.class), content, null);
        String own = ExamPracticeScope.placementIdsOf(a.manifestSnapshot()).iterator().next();
        String foreign = own.replace("READING_PART_5", "READING_PART_6");
        for (String bad : List.of(foreign, "p_anything_i_1")) {
            ExamConcurrencyException ex = assertThrows(ExamConcurrencyException.class, () -> responses.saveResponseBatch(LEARNER, id,
                    new SaveResponseBatchRequest(null, 4, List.of(new ResponseItemCommand(bad, UUID.randomUUID(), Map.of("value", "A"), "A",
                            null, false, null)))));
            assertEquals("PLACEMENT_NOT_IN_SCOPE", ex.getCode());
        }
        assertEquals("PLACEMENT_NOT_IN_SCOPE", assertThrows(ExamConcurrencyException.class, () -> responses.submitAttempt(LEARNER, id,
                new SubmitAttemptRequest("s", 4, SubmissionReason.MANUAL, List.of(new ResponseItemCommand(foreign, null, Map.of("value", "A"),
                        "A", null, false, null))))).getCode());
        verify(repo, never()).upsertResponse(any(), any(), any(), any(), any(), any(), any(), anyBoolean(), any(), any());
        verify(repo, never()).insertSubmission(any());
        assertEquals(30, ExamPracticeScope.placementIdsOf(a.manifestSnapshot()).size());
    }

    @Test
    @DisplayName("20–24/29–35: raw result, review only after submission, owner only, from the snapshot")
    void resultAndReview() throws Exception {
        tree = new PracticeTreeFixtures.Ielts().build();
        UUID id = create("IELTS_LISTENING_SECTION_3").attemptId();
        List<ExamAttemptSnapshotContent.SnapshotItem> its = items(store.get(id));
        Map<UUID, String> given = new LinkedHashMap<>();
        for (int i = 0; i < 6; i++) given.put(its.get(i).itemId(), i < 4 ? key(its.get(i)) : "wrong" + i);
        answer(id, given);

        PracticeResultDto open = practice.getResult(LEARNER, id);
        assertNull(open.correct(), "no metrics before submission");
        assertFalse(open.reviewAvailable());
        assertTrue(assertThrows(IllegalStateException.class, () -> practice.getReview(LEARNER, id)).getMessage()
                .startsWith(ExamPracticeService.REVIEW_NOT_AVAILABLE_CODE));

        submit(id);
        PracticeResultDto r = practice.getResult(LEARNER, id);
        assertEquals(4, r.correct());
        assertEquals(2, r.incorrect());
        assertEquals(4, r.unanswered());
        assertEquals(10, r.total());
        assertEquals(40.0, r.rawAccuracyPercent());
        assertEquals(300L, r.timeSpentSeconds());
        assertFalse(r.standardizedScoreAvailable(), "10 listening items are never an IELTS band");

        PracticeReviewDto review = practice.getReview(LEARNER, id);
        String before = MAPPER.writeValueAsString(review);
        assertFalse(before.contains("sourcePages") || before.contains("keySource"), "no source metadata in review");
        List<ReviewItemDto> reviewItems = review.groups().stream().flatMap(g -> g.items().stream()).toList();
        assertEquals(List.of("CORRECT", "CORRECT", "CORRECT", "CORRECT", "INCORRECT", "INCORRECT", "UNANSWERED", "UNANSWERED",
                "UNANSWERED", "UNANSWERED"), reviewItems.stream().map(ReviewItemDto::status).toList());
        assertEquals("wrong4", reviewItems.get(4).learnerAnswer());
        assertEquals(List.of(key(its.get(4))), reviewItems.get(4).correctAnswers());
        assertFalse(reviewItems.get(4).explanationAvailable(), "no explanation is invented");
        assertFalse(reviewItems.get(4).sourceEvidenceAvailable(), "listening: no transcript disclosed");

        // content changed after the attempt (new tree): review = the attempt snapshot, unchanged
        PracticeTreeFixtures.Ielts changed = new PracticeTreeFixtures.Ielts();
        changed.numberingGapPart1 = true;
        tree = changed.build();
        assertEquals(before, MAPPER.writeValueAsString(practice.getReview(LEARNER, id)));

        assertThrows(ExamNotFoundException.class, () -> practice.getReview(OTHER, id));
        assertThrows(ExamNotFoundException.class, () -> practice.getResult(OTHER, id));
    }

    @Test
    @DisplayName("11: reading passage review carries the passage as source evidence")
    void readingEvidence() {
        tree = new PracticeTreeFixtures.Ielts().build();
        UUID id = create("IELTS_READING_PASSAGE_1").attemptId();
        submit(id);
        PracticeReviewDto review = practice.getReview(LEARNER, id);
        assertEquals(13, review.summary().total());
        assertTrue(review.groups().get(0).items().get(0).sourceEvidenceAvailable());
        assertEquals("synthetic passage", review.groups().get(0).stimuli().get(0).bodyPayload().get("text"));
        assertFalse(review.groups().get(0).stimuli().get(0).bodyPayload().containsKey("sourcePages"));
    }

    @Test
    @DisplayName("12/13: writing task practice — response kept, word count, NOT_SCORED, no key")
    void writing() {
        tree = new PracticeTreeFixtures.Ielts().build();
        UUID id = create("IELTS_WRITING_TASK_1").attemptId();
        UUID task = items(store.get(id)).get(0).itemId();
        answer(id, Map.of(task, "one two three four five"));
        submit(id);
        PracticeResultDto r = practice.getResult(LEARNER, id);
        assertEquals(5, r.wordCount());
        assertEquals(150, r.minimumWords());
        assertEquals("NOT_SCORED", r.writingAssessment());
        assertNull(r.total());
        ReviewItemDto item = practice.getReview(LEARNER, id).groups().get(0).items().get(0);
        assertEquals("NOT_SCORED", item.status());
        assertTrue(item.correctAnswers().isEmpty());
        assertTrue(practice.getReview(LEARNER, id).groups().get(0).stimuli().stream().anyMatch(s -> "CHART".equals(s.kind())
                && !s.assets().isEmpty()), "Task 1 visual travels with the review (grant)");
    }

    @Test
    @DisplayName("36/37 + idempotency: Practice Again = new attempt on the same pinned version; old attempt untouched")
    void practiceAgain() {
        tree = new PracticeTreeFixtures.Ielts().build();
        UUID old = create("IELTS_READING_PASSAGE_2").attemptId();
        assertTrue(assertThrows(IllegalStateException.class, () -> practice.practiceAgain(LEARNER, old, null)).getMessage()
                .startsWith(ExamPracticeService.IN_PROGRESS_CODE));
        submit(old);
        AttemptRecord before = store.get(old);
        PracticeAttemptDto next = practice.practiceAgain(LEARNER, old, "cmd-1");
        assertNotEquals(old, next.attemptId());
        assertEquals(before.formId(), next.formId());
        assertEquals(old, next.practiceAgainOf());
        assertTrue(practice.practiceAgain(LEARNER, old, "cmd-1").resumedExisting(), "same mutation id ⇒ same attempt");
        assertEquals(before, store.get(old), "historical attempt never mutated");
        assertThrows(ExamNotFoundException.class, () -> practice.practiceAgain(OTHER, old, null));

        lifecycle = LifecycleState.RETIRED;
        assertTrue(assertThrows(IllegalStateException.class, () -> practice.practiceAgain(LEARNER, old, null)).getMessage()
                .startsWith(ExamPracticeService.SOURCE_UNAVAILABLE_CODE), "never silently switched to another version");
    }

    @Test
    @DisplayName("38: playback grants of a practice attempt are limited to its own scope's assets")
    void scopedGrants() {
        tree = new PracticeTreeFixtures.Ielts().build();
        UUID s1 = create("IELTS_LISTENING_SECTION_1").attemptId();
        UUID s2 = create("IELTS_LISTENING_SECTION_2").attemptId();
        UUID own = UUID.fromString(String.valueOf(((List<?>) ExamPracticeScope.pinned(store.get(s1).manifestSnapshot()).orElseThrow()
                .get("mediaAssetIds")).get(0)));
        UUID other = UUID.fromString(String.valueOf(((List<?>) ExamPracticeScope.pinned(store.get(s2).manifestSnapshot()).orElseThrow()
                .get("mediaAssetIds")).get(0)));
        ExamRightsService grantRights = mock(ExamRightsService.class);
        when(grantRights.isAssetAccessible(any(), any())).thenReturn(true);
        ExamMediaService media = new ExamMediaService(mock(ExamMediaRepository.class), attempts, grantRights, mock(ExamObjectStorage.class));
        assertNotNull(media.createPlaybackGrant(LEARNER, s1, own, MediaPurpose.SIMULATION_LISTENING));
        assertTrue(assertThrows(IllegalStateException.class,
                () -> media.createPlaybackGrant(LEARNER, s1, other, MediaPurpose.SIMULATION_LISTENING)).getMessage()
                .startsWith("ASSET_NOT_IN_ATTEMPT_SCOPE"));
        assertThrows(IllegalArgumentException.class, () -> media.createPlaybackGrant(OTHER, s1, own, MediaPurpose.SIMULATION_LISTENING));
    }

    @Test
    @DisplayName("48–53: LABEL_ASSIGNMENT practice — assignments scored per target, reuse allowed by the canonical spec, review")
    void labelAssignmentScoring() {
        PracticeTreeFixtures.Ielts f = new PracticeTreeFixtures.Ielts();
        f.labelAssignmentPart2 = true;
        tree = f.build();
        UUID id = create("IELTS_LISTENING_SECTION_2").attemptId();
        List<ExamAttemptSnapshotContent.SnapshotItem> labels = items(store.get(id)).stream()
                .filter(i -> "LABEL_ASSIGNMENT".equals(i.interactionType())).toList();
        assertEquals(6, labels.size());
        Map<UUID, String> given = new LinkedHashMap<>();
        given.put(labels.get(0).itemId(), key(labels.get(0)));        // A — correct
        given.put(labels.get(1).itemId(), key(labels.get(0)));        // A reused on B's target — wrong, still stored
        given.put(labels.get(2).itemId(), key(labels.get(2)));        // correct
        answer(id, given);
        submit(id);
        List<ReviewItemDto> review = practice.getReview(LEARNER, id).groups().get(0).items();
        assertEquals(List.of("CORRECT", "INCORRECT", "CORRECT", "UNANSWERED", "UNANSWERED", "UNANSWERED"),
                review.stream().map(ReviewItemDto::status).toList());
        assertEquals(key(labels.get(0)), review.get(1).learnerAnswer());
        assertEquals(List.of(key(labels.get(1))), review.get(1).correctAnswers());
        assertEquals(8, ((List<?>) review.get(0).optionDefinitions().get("options")).size(), "canonical option pool");
        assertTrue(practice.getReview(LEARNER, id).groups().get(0).stimuli().stream().anyMatch(s -> "MAP".equals(s.kind())),
                "figure survives review");
    }
}
