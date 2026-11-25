package com.englishcoach.exams.service;

import com.englishcoach.exams.model.ExamAttemptRecords.*;
import com.englishcoach.exams.model.ExamContentRecords.*;
import com.englishcoach.exams.model.ExamTypes.*;
import com.englishcoach.exams.practice.ExamLearnerContentSanitizer;
import com.englishcoach.exams.practice.ExamPracticeScope;
import com.englishcoach.exams.repository.ExamAttemptRepository;
import com.englishcoach.exams.repository.ExamContentRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import java.util.*;

@Slf4j
@Service
@RequiredArgsConstructor
public class ExamManifestService {

    private final ExamContentRepository contentRepository;
    private final ExamAttemptRepository attemptRepository;

    public record FormSnapshotResult(
            Map<String, Object> snapshot,
            String version,
            String hash
    ) {}

    public FormSnapshotResult serializeFormSnapshot(FormVersionRecord form) {
        if (form == null || form.id() == null) {
            throw new IllegalArgumentException("Cannot snapshot null form");
        }

        List<SectionRecord> sections = contentRepository.findSectionsByFormId(form.id());
        if (sections == null || sections.isEmpty()) {
            throw new IllegalStateException("Cannot snapshot form with no sections: " + form.id());
        }

        Map<String, Object> snapshotMap = new LinkedHashMap<>();
        snapshotMap.put("version", "v4.0");

        Map<String, Object> formMeta = new LinkedHashMap<>();
        formMeta.put("id", form.id().toString());
        formMeta.put("logicalKey", form.logicalKey());
        formMeta.put("version", form.version());
        formMeta.put("title", form.title());
        formMeta.put("family", form.family().name());
        formMeta.put("variant", form.variant());
        formMeta.put("scope", form.scope());
        formMeta.put("contentHash", form.contentHash());
        if (form.catalogNodeId() != null) formMeta.put("catalogNodeId", form.catalogNodeId().toString());
        if (form.specificationId() != null) formMeta.put("specificationId", form.specificationId().toString());
        if (form.scoringSchemeId() != null) formMeta.put("scoringSchemeId", form.scoringSchemeId().toString());
        if (form.lifecycleState() != null) formMeta.put("lifecycleState", form.lifecycleState().name());
        snapshotMap.put("form", formMeta);

        List<Map<String, Object>> sectionsList = new ArrayList<>();
        for (SectionRecord sec : sections) {
            Map<String, Object> secMap = new LinkedHashMap<>();
            secMap.put("id", sec.id().toString());
            secMap.put("skill", sec.skill().name());
            secMap.put("ordinal", sec.ordinal());
            secMap.put("specSectionKey", sec.specSectionKey());
            secMap.put("durationSeconds", sec.durationSeconds());
            secMap.put("timingPolicy", sec.timingPolicy());
            secMap.put("isRunnable", sec.isRunnable());
            secMap.put("healthStatus", sec.healthStatus());

            List<PartRecord> parts = contentRepository.findPartsBySectionId(sec.id());
            List<Map<String, Object>> partsList = new ArrayList<>();
            for (PartRecord part : parts) {
                Map<String, Object> partMap = new LinkedHashMap<>();
                partMap.put("id", part.id().toString());
                partMap.put("partCode", part.partCode());
                partMap.put("ordinal", part.ordinal());
                partMap.put("instructions", part.instructions());
                partMap.put("timingPolicy", part.timingPolicy());

                List<GroupVersionRecord> groups = contentRepository.findGroupsByPartId(part.id());
                Map<UUID, ExamContentRepository.GroupPlacement> placements = contentRepository.findGroupPlacementsByPartId(part.id());
                List<Map<String, Object>> groupsList = new ArrayList<>();
                for (GroupVersionRecord grp : groups) {
                    Map<String, Object> grpMap = new LinkedHashMap<>();
                    grpMap.put("id", grp.id().toString());
                    grpMap.put("logicalGroupKey", grp.logicalGroupKey());
                    ExamContentRepository.GroupPlacement placement = placements != null ? placements.get(grp.id()) : null;
                    if (placement != null) {
                        grpMap.put("placementOrdinal", placement.ordinal());
                        if (placement.displayNumbering() != null) grpMap.put("displayNumbering", placement.displayNumbering());
                    }
                    grpMap.put("version", grp.version());
                    grpMap.put("questionType", grp.questionType());
                    grpMap.put("construct", grp.construct());
                    grpMap.put("skill", grp.skill().name());
                    grpMap.put("topic", grp.topic());
                    grpMap.put("difficultyEstimate", grp.difficultyEstimate());

                    List<StimulusVersionRecord> stimuli = contentRepository.findStimuliByGroupId(grp.id());
                    List<Map<String, Object>> stimuliList = new ArrayList<>();
                    for (StimulusVersionRecord stim : stimuli) {
                        Map<String, Object> stimMap = new LinkedHashMap<>();
                        stimMap.put("id", stim.id().toString());
                        stimMap.put("logicalStimulusKey", stim.logicalStimulusKey());
                        stimMap.put("version", stim.version());
                        stimMap.put("kind", stim.kind());
                        stimMap.put("title", stim.title());
                        stimMap.put("bodyPayload", stim.bodyPayload());

                        List<PublicAssetRefDto> assets = contentRepository.findAssetsByStimulusId(stim.id());
                        List<Map<String, Object>> assetsList = new ArrayList<>();
                        for (PublicAssetRefDto asset : assets) {
                            Map<String, Object> assetMap = new LinkedHashMap<>();
                            assetMap.put("assetId", asset.assetId() != null ? asset.assetId().toString() : null);
                            assetMap.put("role", asset.role());
                            assetMap.put("mimeType", asset.mimeType());
                            assetMap.put("durationMs", asset.durationMs());
                            assetsList.add(assetMap);
                        }
                        stimMap.put("assets", assetsList);
                        stimuliList.add(stimMap);
                    }
                    grpMap.put("stimuli", stimuliList);

                    List<ItemVersionRecord> items = contentRepository.findItemsByGroupId(grp.id());
                    List<Map<String, Object>> itemsList = new ArrayList<>();
                    for (ItemVersionRecord item : items) {
                        Map<String, Object> itemMap = new LinkedHashMap<>();
                        itemMap.put("id", item.id().toString());
                        itemMap.put("logicalItemKey", item.logicalItemKey());
                        itemMap.put("version", item.version());
                        itemMap.put("prompt", item.prompt());
                        itemMap.put("interactionType", item.interactionType());
                        var definitions = item.optionDefinitions();
                        if (sec.skill() == SkillType.SPEAKING && com.englishcoach.exams.content.ExamBankOriginalPractice.practiceOnly(form.id(), form.lifecycleState())) {
                            definitions = new LinkedHashMap<>(definitions == null ? Map.of() : definitions);
                            definitions.put("speakingPromptBasis", "PINNED_CORPUS_SOURCE");
                        }
                        itemMap.put("optionDefinitions", definitions);
                        itemMap.put("construct", item.construct());
                        itemMap.put("ordinal", item.ordinal());

                        Optional<AnswerSpecRecord> ansOpt = contentRepository.findAnswerSpecByItemId(item.id());
                        if (ansOpt.isPresent()) {
                            AnswerSpecRecord ans = ansOpt.get();
                            Map<String, Object> ansMap = new LinkedHashMap<>();
                            ansMap.put("id", ans.id().toString());
                            ansMap.put("acceptedAnswers", ans.acceptedAnswers());
                            ansMap.put("normalizationPolicy", ans.normalizationPolicy());
                            ansMap.put("cardinality", ans.cardinality());
                            ansMap.put("wordLimit", ans.wordLimit());
                            ansMap.put("creditUnits", ans.creditUnits());
                            ansMap.put("explanation", ans.explanation());
                            if (ans.rubricId() != null) ansMap.put("rubricId", ans.rubricId().toString());
                            itemMap.put("answerSpec", ansMap);
                        }
                        itemsList.add(itemMap);
                    }
                    grpMap.put("items", itemsList);
                    groupsList.add(grpMap);
                }
                partMap.put("groups", groupsList);
                partsList.add(partMap);
            }
            secMap.put("parts", partsList);
            sectionsList.add(secMap);
        }
        snapshotMap.put("sections", sectionsList);

        return new FormSnapshotResult(snapshotMap, "v4.0", canonicalHash(snapshotMap));
    }

    private static final ObjectMapper CANONICAL_HASH_MAPPER = new ObjectMapper()
            .configure(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS, true);

    /** SHA-256 of the canonical (key-sorted) JSON of a snapshot map — the attempt's pinned manifest hash. */
    public static String canonicalHash(Map<String, Object> snapshot) {
        String canonicalJson;
        try {
            canonicalJson = CANONICAL_HASH_MAPPER.writeValueAsString(snapshot);
        } catch (Exception e) {
            throw new IllegalStateException("Failed to serialize form snapshot: " + e.getMessage(), e);
        }
        return sha256(canonicalJson);
    }

    @Transactional
    public PublicAttemptManifestDto compileAttemptManifest(AttemptRecord attempt) {
        if (attempt.snapshotState() == ExamSnapshotState.SNAPSHOTTED && attempt.manifestSnapshot() != null) {
            return compileManifestFromSnapshot(attempt);
        }
        return compileManifestFromCatalog(attempt);
    }

    @SuppressWarnings("unchecked")
    private PublicAttemptManifestDto compileManifestFromSnapshot(AttemptRecord attempt) {
        Map<String, Object> snapshot = attempt.manifestSnapshot();
        Map<String, Object> formMap = (Map<String, Object>) snapshot.get("form");
        if (formMap == null) {
            log.warn("Attempt {} has SNAPSHOTTED state but null form map; falling back to catalog", attempt.id());
            return compileManifestFromCatalog(attempt);
        }

        UUID formId = UUID.fromString((String) formMap.get("id"));
        String formTitle = (String) formMap.get("title");
        List<Map<String, Object>> sectionsList = (List<Map<String, Object>>) snapshot.get("sections");
        // Exams Phase 6: a practice-scoped attempt receives allowlisted learner content only (no source metadata)
        Optional<Map<String, Object>> practiceScope = ExamPracticeScope.pinned(snapshot);
        boolean scoped = practiceScope.isPresent();

        List<AttemptSectionRecord> attemptSections = attemptRepository.findSectionsByAttemptId(attempt.id());
        Map<UUID, ExamSectionState> sectionStateMap = new HashMap<>();
        for (AttemptSectionRecord asr : attemptSections) {
            sectionStateMap.put(asr.sectionId(), asr.state());
        }

        List<PublicSectionDto> publicSections = new ArrayList<>();
        if (sectionsList != null) {
            for (Map<String, Object> secMap : sectionsList) {
                UUID secId = UUID.fromString((String) secMap.get("id"));
                SkillType skill = SkillType.valueOf((String) secMap.get("skill"));
                int ordinal = ((Number) secMap.get("ordinal")).intValue();
                String specSectionKey = (String) secMap.get("specSectionKey");
                int durationSeconds = ((Number) secMap.get("durationSeconds")).intValue();
                Map<String, Object> timingPolicy = (Map<String, Object>) secMap.get("timingPolicy");

                if (attempt.clientSessionMeta() != null && attempt.clientSessionMeta().containsKey("selectedSkills")) {
                    Object rawSkills = attempt.clientSessionMeta().get("selectedSkills");
                    if (rawSkills instanceof List<?> list && !list.isEmpty()) {
                        boolean match = list.stream().anyMatch(item -> item != null && item.toString().equalsIgnoreCase(skill.name()));
                        if (!match) {
                            continue;
                        }
                    }
                }

                ExamSectionState secState = sectionStateMap.get(secId);
                if (attemptSections != null && !attemptSections.isEmpty() && secState == null) {
                    continue;
                }
                boolean isPreStartSimulation = attempt.status() == ExamAttemptStatus.CREATED
                        || attempt.status() == ExamAttemptStatus.READY;
                boolean isLockedFutureSection = (attempt.attemptMode() == ExamAttemptMode.EXAM_SIMULATION
                        && (isPreStartSimulation || secState == null || secState == ExamSectionState.PENDING));

                // Track Speaking cursor for prompt withholding
                int speakingCursor = 1;
                if (skill == SkillType.SPEAKING) {
                    for (AttemptSectionRecord asr : attemptSections) {
                        if (asr.sectionId().equals(secId)) {
                            speakingCursor = Math.max(1, asr.turnCursor());
                            break;
                        }
                    }
                }
                int speakingItemSeq = 1;

                List<Map<String, Object>> partsList = (List<Map<String, Object>>) secMap.get("parts");
                List<PublicPartDto> publicParts = new ArrayList<>();

                if (partsList != null) {
                    for (Map<String, Object> partMap : partsList) {
                        UUID partId = UUID.fromString((String) partMap.get("id"));
                        String partCode = (String) partMap.get("partCode");
                        int partOrdinal = ((Number) partMap.get("ordinal")).intValue();
                        String instructions = (String) partMap.get("instructions");

                        List<Map<String, Object>> groupsList = (List<Map<String, Object>>) partMap.get("groups");
                        List<PublicGroupDto> publicGroups = new ArrayList<>();

                        if (groupsList != null) {
                            for (Map<String, Object> grpMap : groupsList) {
                                UUID grpId = UUID.fromString((String) grpMap.get("id"));
                                String logicalGroupKey = (String) grpMap.get("logicalGroupKey");
                                String questionType = (String) grpMap.get("questionType");
                                SkillType grpSkill = SkillType.valueOf((String) grpMap.get("skill"));
                                String placementId = "p_" + partCode + "_g_" + logicalGroupKey;

                                List<Map<String, Object>> itemsList = (List<Map<String, Object>>) grpMap.get("items");
                                boolean hasVisibleItemInGroup = false;

                                List<PublicItemDto> publicItems = new ArrayList<>();
                                if (itemsList != null) {
                                    for (Map<String, Object> itemMap : itemsList) {
                                        UUID itemId = UUID.fromString((String) itemMap.get("id"));
                                        String logicalItemKey = (String) itemMap.get("logicalItemKey");
                                        int itemVersion = itemMap.get("version") != null ? ((Number) itemMap.get("version")).intValue() : 1;
                                        Integer itemOrdinal = itemMap.get("ordinal") != null ? ((Number) itemMap.get("ordinal")).intValue() : null;
                                        String itemPlacementId = placementId + "_i_" + (itemOrdinal != null ? itemOrdinal : (publicItems.size() + 1));

                                        boolean isSpeaking = (skill == SkillType.SPEAKING);
                                        boolean isFutureSpeakingTurn = isSpeaking && (isLockedFutureSection || speakingItemSeq > speakingCursor);
                                        boolean isCurrentSpeakingTurn = isSpeaking && !isLockedFutureSection && (speakingItemSeq == speakingCursor);

                                        String prompt = null;
                                        Map<String, Object> optionDefinitions = null;

                                        if (!isLockedFutureSection) {
                                            if (isSpeaking) {
                                                if (isCurrentSpeakingTurn) {
                                                    prompt = (String) itemMap.get("prompt");
                                                    optionDefinitions = (Map<String, Object>) itemMap.get("optionDefinitions");
                                                    hasVisibleItemInGroup = true;
                                                }
                                            } else {
                                                prompt = (String) itemMap.get("prompt");
                                                optionDefinitions = (Map<String, Object>) itemMap.get("optionDefinitions");
                                                hasVisibleItemInGroup = true;
                                            }
                                        }
                                        // Exams Phase 9B: ONE learner allowlist for every mode (practice AND simulation)
                                        optionDefinitions = ExamLearnerContentSanitizer.optionDefinitions(optionDefinitions);

                                        String interactionType = (String) itemMap.get("interactionType");
                                        Map<String, Object> snapSpec = itemMap.get("answerSpec") instanceof Map<?, ?> sm
                                                ? (Map<String, Object>) sm : null;
                                        Integer specCardinality = snapSpec != null && snapSpec.get("cardinality") instanceof Number c
                                                ? c.intValue() : null;
                                        Integer specWordLimit = snapSpec != null && snapSpec.get("wordLimit") instanceof Number w
                                                ? w.intValue() : null;

                                        publicItems.add(new PublicItemDto(
                                                itemId,
                                                itemPlacementId,
                                                logicalItemKey,
                                                prompt,
                                                interactionType,
                                                optionDefinitions,
                                                optionDefinitions != null ? learnerCardinality(optionDefinitions, specCardinality) : 1,
                                                optionDefinitions != null ? specWordLimit : null
                                        ));

                                        if (!isLockedFutureSection && (!isSpeaking || isCurrentSpeakingTurn)) {
                                            ExposureType expType = attempt.attemptMode() == ExamAttemptMode.EXAM_SIMULATION
                                                    ? ExposureType.SIMULATION : ExposureType.PRACTICE;
                                            attemptRepository.recordExposure(attempt.userId(), logicalItemKey, itemVersion, attempt.id(), expType);
                                        }

                                        if (isSpeaking) {
                                            speakingItemSeq++;
                                        }
                                    }
                                }

                                List<PublicStimulusDto> publicStimuli = new ArrayList<>();
                                List<Map<String, Object>> stimuliList = (List<Map<String, Object>>) grpMap.get("stimuli");
                                boolean allowStimuli = !isLockedFutureSection && (skill != SkillType.SPEAKING || hasVisibleItemInGroup);
                                if (allowStimuli && stimuliList != null) {
                                    for (Map<String, Object> stimMap : stimuliList) {
                                        UUID stimId = UUID.fromString((String) stimMap.get("id"));
                                        String logicalStimKey = (String) stimMap.get("logicalStimulusKey");
                                        String kind = (String) stimMap.get("kind");
                                        String stimTitle = (String) stimMap.get("title");
                                        Map<String, Object> bodyPayload = (Map<String, Object>) stimMap.get("bodyPayload");
                                        // Exams Phase 9B: extractor / OCR / QA / transcript metadata never reaches a learner,
                                        // whatever the mode (stored content is not modified)
                                        bodyPayload = ExamLearnerContentSanitizer.stimulusBody(kind, bodyPayload);

                                        List<PublicAssetRefDto> assets = new ArrayList<>();
                                        List<Map<String, Object>> assetList = (List<Map<String, Object>>) stimMap.get("assets");
                                        if (assetList != null) {
                                            for (Map<String, Object> aMap : assetList) {
                                                String assetIdStr = (String) aMap.get("assetId");
                                                assets.add(new PublicAssetRefDto(
                                                        assetIdStr != null ? UUID.fromString(assetIdStr) : null,
                                                        (String) aMap.get("role"),
                                                        (String) aMap.get("mimeType"),
                                                        aMap.get("durationMs") != null ? ((Number) aMap.get("durationMs")).intValue() : null
                                                ));
                                            }
                                        }
                                        publicStimuli.add(new PublicStimulusDto(
                                                stimId, logicalStimKey, kind, stimTitle, bodyPayload, assets
                                        ));
                                    }
                                }

                                Integer placementOrdinal = grpMap.get("placementOrdinal") instanceof Number po ? po.intValue() : null;
                                String displayNumbering = grpMap.get("displayNumbering") instanceof String dn ? dn : null;
                                publicGroups.add(new PublicGroupDto(
                                        grpId,
                                        placementId,
                                        logicalGroupKey,
                                        questionType,
                                        null,
                                        grpSkill,
                                        placementOrdinal != null ? placementOrdinal : partOrdinal,
                                        displayNumbering != null ? displayNumbering : partCode,
                                        publicStimuli,
                                        publicItems,
                                        groupPresentation(publicItems)
                                ));
                            }
                        }

                        publicParts.add(new PublicPartDto(
                                partId,
                                partCode,
                                partOrdinal,
                                instructions,
                                publicGroups
                        ));
                    }
                }

                publicSections.add(new PublicSectionDto(
                        secId,
                        skill,
                        ordinal,
                        specSectionKey,
                        durationSeconds,
                        timingPolicy,
                        publicParts
                ));
            }
        }

        String manifestHash = attempt.pinnedManifestHash();
        if (manifestHash == null || manifestHash.isBlank()) {
            manifestHash = sha256(formId + ":" + attempt.id());
        }

        String manifestScope = attempt.attemptMode() == ExamAttemptMode.EXAM_SIMULATION
                ? "EXAM_SIMULATION_CURRENT_SECTION" : scoped ? "PRACTICE_SCOPE" : "PRACTICE_MODE";
        Integer serverRevision = (int) attempt.revision();

        return new PublicAttemptManifestDto(
                attempt.id(),
                formId,
                attempt.family(),
                attempt.variant(),
                attempt.scope(),
                attempt.attemptMode(),
                formTitle,
                manifestHash,
                serverRevision,
                manifestScope,
                publicSections,
                practiceScope.map(ExamManifestService::learnerScopeSummary).orElse(null)
        );
    }

    /** Learner summary of a pinned practice scope (no ids beyond the scope code, no content). */
    static Map<String, Object> learnerScopeSummary(Map<String, Object> scope) {
        Map<String, Object> out = new LinkedHashMap<>();
        for (String k : List.of("scopeCode", "scopeType", "skill", "number", "itemCount", "scoringMode", "timingMode",
                "reviewPolicy", "sourceFormVersion")) {
            if (scope.get(k) != null) out.put(k, scope.get(k));
        }
        return out;
    }

    private PublicAttemptManifestDto compileManifestFromCatalog(AttemptRecord attempt) {
        UUID formId = attempt.formId();
        Optional<FormVersionRecord> formOpt = contentRepository.findFormById(formId);
        if (formOpt.isEmpty()) {
            throw new IllegalArgumentException("Form not found: " + formId);
        }
        FormVersionRecord form = formOpt.get();

        List<SectionRecord> sections = contentRepository.findSectionsByFormId(formId);
        List<PublicSectionDto> publicSections = new ArrayList<>();

        StringBuilder hashBuilder = new StringBuilder();
        hashBuilder.append(form.logicalKey()).append(":v").append(form.version());

        List<AttemptSectionRecord> attemptSections = attemptRepository.findSectionsByAttemptId(attempt.id());
        Map<UUID, ExamSectionState> sectionStateMap = new HashMap<>();
        for (AttemptSectionRecord asr : attemptSections) {
            sectionStateMap.put(asr.sectionId(), asr.state());
        }

        for (SectionRecord sec : sections) {
            if (attempt.clientSessionMeta() != null && attempt.clientSessionMeta().containsKey("selectedSkills")) {
                Object rawSkills = attempt.clientSessionMeta().get("selectedSkills");
                if (rawSkills instanceof List<?> list && !list.isEmpty()) {
                    boolean match = list.stream().anyMatch(item -> item != null && item.toString().equalsIgnoreCase(sec.skill().name()));
                    if (!match) {
                        continue;
                    }
                }
            }

            ExamSectionState secState = sectionStateMap.get(sec.id());
            if (attemptSections != null && !attemptSections.isEmpty() && secState == null) {
                continue;
            }
            boolean isPreStartSimulation = attempt.status() == ExamAttemptStatus.CREATED
                    || attempt.status() == ExamAttemptStatus.READY;
            boolean isLockedFutureSection = (attempt.attemptMode() == ExamAttemptMode.EXAM_SIMULATION
                    && (isPreStartSimulation || secState == null || secState == ExamSectionState.PENDING));

            // Track Speaking cursor for prompt withholding
            int speakingCursor = 1;
            if (sec.skill() == SkillType.SPEAKING) {
                for (AttemptSectionRecord asr : attemptSections) {
                    if (asr.sectionId().equals(sec.id())) {
                        speakingCursor = Math.max(1, asr.turnCursor());
                        break;
                    }
                }
            }
            int speakingItemSeq = 1;

            List<PartRecord> parts = contentRepository.findPartsBySectionId(sec.id());
            List<PublicPartDto> publicParts = new ArrayList<>();
            Map<UUID, AnswerSpecRecord> sectionSpecs = contentRepository.findAnswerSpecsBySectionId(sec.id());
            if (sectionSpecs == null) sectionSpecs = Map.of();

            for (PartRecord part : parts) {
                List<GroupVersionRecord> groups = contentRepository.findGroupsByPartId(part.id());
                Map<UUID, ExamContentRepository.GroupPlacement> placements = contentRepository.findGroupPlacementsByPartId(part.id());
                List<PublicGroupDto> publicGroups = new ArrayList<>();

                for (GroupVersionRecord group : groups) {
                    String placementId = "p_" + part.partCode() + "_g_" + group.logicalGroupKey();

                    List<ItemVersionRecord> items = contentRepository.findItemsByGroupId(group.id());
                    boolean hasVisibleItemInGroup = false;

                    List<PublicItemDto> publicItems = new ArrayList<>();
                    for (ItemVersionRecord item : items) {
                        String itemPlacementId = placementId + "_i_" + (item.ordinal() != null ? item.ordinal() : publicItems.size() + 1);

                        boolean isSpeaking = (sec.skill() == SkillType.SPEAKING);
                        boolean isFutureSpeakingTurn = isSpeaking && (isLockedFutureSection || speakingItemSeq > speakingCursor);
                        boolean isCurrentSpeakingTurn = isSpeaking && !isLockedFutureSection && (speakingItemSeq == speakingCursor);

                        String prompt = null;
                        Map<String, Object> optionDefinitions = null;

                        if (!isLockedFutureSection) {
                            if (isSpeaking) {
                                if (isCurrentSpeakingTurn) {
                                    prompt = item.prompt();
                                    optionDefinitions = item.optionDefinitions();
                                    hasVisibleItemInGroup = true;
                                }
                            } else {
                                prompt = item.prompt();
                                optionDefinitions = item.optionDefinitions();
                                hasVisibleItemInGroup = true;
                            }
                        }

                        // Exams Phase 9B: same learner allowlist on the legacy (unsnapshotted) catalog path
                        optionDefinitions = ExamLearnerContentSanitizer.optionDefinitions(optionDefinitions);
                        AnswerSpecRecord liveSpec = sectionSpecs.get(item.id());
                        publicItems.add(new PublicItemDto(
                                item.id(),
                                itemPlacementId,
                                item.logicalItemKey(),
                                prompt,
                                item.interactionType(),
                                optionDefinitions,
                                optionDefinitions != null
                                        ? learnerCardinality(optionDefinitions, liveSpec != null ? liveSpec.cardinality() : null) : 1,
                                optionDefinitions != null && liveSpec != null ? liveSpec.wordLimit() : null
                        ));

                        if (!isLockedFutureSection && (!isSpeaking || isCurrentSpeakingTurn)) {
                            ExposureType expType = attempt.attemptMode() == ExamAttemptMode.EXAM_SIMULATION
                                    ? ExposureType.SIMULATION : ExposureType.PRACTICE;
                            attemptRepository.recordExposure(attempt.userId(), item.logicalItemKey(), item.version(), attempt.id(), expType);
                            hashBuilder.append("|").append(item.logicalItemKey());
                        }

                        if (isSpeaking) {
                            speakingItemSeq++;
                        }
                    }

                    List<PublicStimulusDto> publicStimuli = new ArrayList<>();
                    boolean allowStimuli = !isLockedFutureSection && (sec.skill() != SkillType.SPEAKING || hasVisibleItemInGroup);
                    if (allowStimuli) {
                        List<StimulusVersionRecord> stimuli = contentRepository.findStimuliByGroupId(group.id());
                        for (StimulusVersionRecord stim : stimuli) {
                            List<PublicAssetRefDto> assets = contentRepository.findAssetsByStimulusId(stim.id());
                            publicStimuli.add(new PublicStimulusDto(
                                    stim.id(),
                                    stim.logicalStimulusKey(),
                                    stim.kind(),
                                    stim.title(),
                                    ExamLearnerContentSanitizer.stimulusBody(stim.kind(), stim.bodyPayload()),
                                    assets
                            ));
                        }
                    }

                    ExamContentRepository.GroupPlacement placement = placements != null ? placements.get(group.id()) : null;
                    publicGroups.add(new PublicGroupDto(
                            group.id(),
                            placementId,
                            group.logicalGroupKey(),
                            group.questionType(),
                            null,
                            group.skill(),
                            placement != null ? placement.ordinal() : part.ordinal(),
                            placement != null && placement.displayNumbering() != null ? placement.displayNumbering() : part.partCode(),
                            publicStimuli,
                            publicItems,
                            groupPresentation(publicItems)
                    ));
                }

                publicParts.add(new PublicPartDto(
                        part.id(),
                        part.partCode(),
                        part.ordinal(),
                        part.instructions(),
                        publicGroups
                ));
            }

            publicSections.add(new PublicSectionDto(
                    sec.id(),
                    sec.skill(),
                    sec.ordinal(),
                    sec.specSectionKey(),
                    sec.durationSeconds(),
                    sec.timingPolicy(),
                    publicParts
            ));
        }

        String manifestHash = sha256(hashBuilder.toString());

        String manifestScope = attempt.attemptMode() == ExamAttemptMode.EXAM_SIMULATION
                ? "EXAM_SIMULATION_CURRENT_SECTION" : "PRACTICE_MODE";
        Integer serverRevision = (int) attempt.revision();

        return new PublicAttemptManifestDto(
                attempt.id(),
                form.id(),
                attempt.family(),
                attempt.variant(),
                attempt.scope(),
                attempt.attemptMode(),
                form.title(),
                manifestHash,
                serverRevision,
                manifestScope,
                publicSections
        );
    }

    /**
     * Learner-facing selection size of an item (Exams Phase 4B.5): a "Choose TWO" pair carries
     * {@code optionDefinitions.selection.count}; otherwise the answer spec cardinality (default 1). Each item of a
     * choose-N set still stores exactly ONE option id; the runner renders the set once and keeps the ids unique.
     */
    static int learnerCardinality(Map<String, Object> optionDefinitions, Integer specCardinality) {
        if (optionDefinitions != null && optionDefinitions.get("selection") instanceof Map<?, ?> sel
                && sel.get("count") instanceof Number n && n.intValue() > 1) {
            return n.intValue();
        }
        return specCardinality != null && specCardinality > 0 ? specCardinality : 1;
    }

    /** Printed group-level fields carried once per group (no keys); null when no item of the group is visible. */
    private static final List<String> PRESENTATION_KEYS =
            List.of("kind", "questions", "instructions", "stem", "layout", "wordLimitRule");

    @SuppressWarnings("unchecked")
    static Map<String, Object> groupPresentation(List<PublicItemDto> items) {
        Map<String, Object> out = null;
        for (PublicItemDto item : items) {
            Map<String, Object> defs = item.options();
            if (defs == null) continue;
            if (out == null) out = new LinkedHashMap<>();
            if (defs.get("group") instanceof Map<?, ?> g) {
                for (String key : PRESENTATION_KEYS) {
                    Object v = ((Map<String, Object>) g).get(key);
                    if (v != null && !out.containsKey(key)) out.put(key, v);
                }
            }
            if (defs.get("selection") instanceof Map<?, ?> sel && !out.containsKey("selection")) {
                Map<String, Object> s = new LinkedHashMap<>();
                s.put("count", sel.get("count"));
                s.put("questions", sel.get("questions"));
                out.put("selection", s);
            }
            if (item.wordLimit() != null && !out.containsKey("wordLimit")) out.put("wordLimit", item.wordLimit());
        }
        return out == null || out.isEmpty() ? null : out;
    }

    private static String sha256(String text) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(text.getBytes(StandardCharsets.UTF_8));
            StringBuilder hexString = new StringBuilder();
            for (byte b : hash) {
                String hex = Integer.toHexString(0xff & b);
                if (hex.length() == 1) hexString.append('0');
                hexString.append(hex);
            }
            return hexString.toString();
        } catch (Exception e) {
            return "sha256_mock_hash";
        }
    }
}
