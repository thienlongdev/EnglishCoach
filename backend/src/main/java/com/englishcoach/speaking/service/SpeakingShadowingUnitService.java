package com.englishcoach.speaking.service;

import com.englishcoach.dictionary.provider.GoogleGtxTranslationProvider;
import com.englishcoach.listening.entity.ListeningMaterial;
import com.englishcoach.listening.entity.TranscriptSegment;
import com.englishcoach.listening.repository.ListeningMaterialRepository;
import com.englishcoach.listening.repository.TranscriptSegmentRepository;
import com.englishcoach.speaking.config.SpeakingShadowingSchemaRepair;
import com.englishcoach.speaking.dto.ShadowingSegmentProgressDto;
import com.englishcoach.speaking.dto.SpeakingShadowingUnitDto;
import com.englishcoach.speaking.dto.UnitIpaDto;
import com.englishcoach.speaking.dto.UnitTranslationDto;
import com.englishcoach.speaking.entity.SpeakingShadowingUnit;
import com.englishcoach.speaking.repository.SpeakingShadowingAttemptRepository;
import com.englishcoach.speaking.repository.SpeakingShadowingUnitRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.server.ResponseStatusException;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;

@Service
@Slf4j
public class SpeakingShadowingUnitService {

    public static final int LATEST_GENERATION_VERSION = 3;

    private final SpeakingShadowingUnitRepository unitRepository;
    private final ListeningMaterialRepository materialRepository;
    private final TranscriptSegmentRepository segmentRepository;
    private final SpeakingShadowingAttemptRepository attemptRepository;
    private final CanonicalTranscriptReconstructor reconstructor;
    private final SpeakingShadowingSchemaRepair schemaRepair;
    private final GoogleGtxTranslationProvider googleGtxTranslationProvider;
    private final ObjectMapper objectMapper;

    @Value("${ai.base-url:http://localhost:8000}")
    private String aiBaseUrl;

    @Autowired(required = false)
    private PlatformTransactionManager transactionManager;

    private <T> T inTx(java.util.function.Supplier<T> work) {
        if (transactionManager == null) return work.get();
        return new TransactionTemplate(transactionManager).execute(s -> work.get());
    }

    private <T> T inReadTx(java.util.function.Supplier<T> work) {
        if (transactionManager == null) return work.get();
        TransactionTemplate tpl = new TransactionTemplate(transactionManager);
        tpl.setReadOnly(true);
        return tpl.execute(s -> work.get());
    }

    private record UnitsPrepared(
            List<SpeakingShadowingUnitDto> existingDtos,
            CanonicalTranscriptReconstructor.ReconstructionResult reconstruction,
            int segmentCount
    ) {}

    private record UnitTextPrepared(
            Long unitId,
            String text,
            UnitIpaDto existingIpa,
            UnitTranslationDto existingTranslation
    ) {}

    /**
     * The six-argument constructor below is retained for focused unit tests
     * that do not exercise lazy IPA/translation generation. Production must
     * use the fully wired constructor so those providers are never null.
     */
    @Autowired
    public SpeakingShadowingUnitService(
            SpeakingShadowingUnitRepository unitRepository,
            ListeningMaterialRepository materialRepository,
            TranscriptSegmentRepository segmentRepository,
            SpeakingShadowingAttemptRepository attemptRepository,
            CanonicalTranscriptReconstructor reconstructor,
            SpeakingShadowingSchemaRepair schemaRepair,
            GoogleGtxTranslationProvider googleGtxTranslationProvider,
            ObjectMapper objectMapper
    ) {
        this.unitRepository = unitRepository;
        this.materialRepository = materialRepository;
        this.segmentRepository = segmentRepository;
        this.attemptRepository = attemptRepository;
        this.reconstructor = reconstructor;
        this.schemaRepair = schemaRepair;
        this.googleGtxTranslationProvider = googleGtxTranslationProvider;
        this.objectMapper = objectMapper;
    }

    public SpeakingShadowingUnitService(
            SpeakingShadowingUnitRepository unitRepository,
            ListeningMaterialRepository materialRepository,
            TranscriptSegmentRepository segmentRepository,
            SpeakingShadowingAttemptRepository attemptRepository,
            CanonicalTranscriptReconstructor reconstructor,
            SpeakingShadowingSchemaRepair schemaRepair
    ) {
        this(unitRepository, materialRepository, segmentRepository, attemptRepository,
                reconstructor, schemaRepair, null, new ObjectMapper());
    }

    private RestTemplate createIpaRestTemplate() {
        SimpleClientHttpRequestFactory factory = new com.englishcoach.common.ai.AiServiceRequestFactory();
        factory.setConnectTimeout(5000);
        factory.setReadTimeout(15000);
        return new RestTemplate(factory);
    }

    public List<SpeakingShadowingUnitDto> getOrGenerateUnits(Long materialId, Long userId) {
        if (materialId == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Material ID is required");
        }
        schemaRepair.ensureReady();

        // Phase 1a (short read TX): check visibility and return immediately if active units already exist (no lock)
        List<SpeakingShadowingUnitDto> fastHit = inReadTx(() -> {
            materialRepository.findByIdAndVisibleToUser(materialId, userId)
                    .orElseThrow(() -> notFound(materialId));
            List<SpeakingShadowingUnit> units = findActiveUnits(materialId);
            return units.isEmpty() ? null : attachProgress(units, materialId, userId);
        });
        if (fastHit != null) {
            return fastHit;
        }

        // Phase 1b (short lock-check TX): re-check under material lock and reconstruct segments locally (ZERO HTTP!)
        // Releases FOR UPDATE lock + DB connection BEFORE external Google Translate loop!
        UnitsPrepared prepared = inTx(() -> {
            ListeningMaterial locked = materialRepository.findByIdForShadowingGeneration(materialId)
                    .orElseThrow(() -> notFound(materialId));
            List<SpeakingShadowingUnit> existing = findActiveUnits(materialId);
            if (!existing.isEmpty()) {
                return new UnitsPrepared(attachProgress(existing, materialId, userId), null, 0);
            }
            List<TranscriptSegment> segments = segmentRepository
                    .findByListeningMaterialIdOrderByStartTimeMsAsc(locked.getId());
            CanonicalTranscriptReconstructor.ReconstructionResult reconstruction = reconstructor.reconstruct(
                    segments,
                    locked.getDurationSeconds()
            );
            return new UnitsPrepared(null, reconstruction, segments.size());
        });

        if (prepared.existingDtos() != null) {
            return prepared.existingDtos();
        }
        CanonicalTranscriptReconstructor.ReconstructionResult reconstruction = prepared.reconstruction();
        if (reconstruction == null || reconstruction.units().isEmpty()) {
            return List.of();
        }

        // External Google Translate HTTP loop completely OUTSIDE any DB transaction and lock
        List<String> translations = new ArrayList<>(reconstruction.units().size());
        for (CanonicalTranscriptReconstructor.ReconstructedUnit reconstructed : reconstruction.units()) {
            String translation = null;
            if (googleGtxTranslationProvider != null) {
                try {
                    translation = googleGtxTranslationProvider.translateSentenceToVietnamese(reconstructed.displayText());
                } catch (Exception ignored) {}
            }
            translations.add(translation);
        }

        // Phase 2 (short atomic commit TX): acquire PESSIMISTIC_WRITE lock, re-check if another thread won, batch-insert atomically
        final int segmentCount = prepared.segmentCount();
        return inTx(() -> {
            ListeningMaterial material = materialRepository.findByIdForShadowingGeneration(materialId)
                    .orElseThrow(() -> notFound(materialId));
            List<SpeakingShadowingUnit> alreadyCreated = findActiveUnits(materialId);
            if (!alreadyCreated.isEmpty()) {
                return attachProgress(alreadyCreated, materialId, userId);
            }
            List<SpeakingShadowingUnit> saved = persistReconstructedUnits(material, reconstruction, translations, segmentCount);
            return attachProgress(saved, materialId, userId);
        });
    }

    /**
     * The unit, for a caller who may see the material it belongs to (their own, or SYSTEM content). A unit of
     * another learner's private material answers exactly like a unit that does not exist: 404, nothing about it.
     */
    @Transactional(readOnly = true)
    public String visibleReference(Long unitId, Long userId) {
        return visibleUnit(unitId, userId).getDisplayText();
    }

    private SpeakingShadowingUnit visibleUnit(Long unitId, Long userId) {
        if (unitId == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Unit ID is required");
        }
        ResponseStatusException notFound =
                new ResponseStatusException(HttpStatus.NOT_FOUND, "Shadowing unit not found: " + unitId);
        SpeakingShadowingUnit unit = unitRepository.findById(unitId).orElseThrow(() -> notFound);
        Long materialId = unit.getMaterial() != null ? unit.getMaterial().getId() : null;
        if (userId == null || materialId == null
                || materialRepository.findByIdAndVisibleToUser(materialId, userId).isEmpty()) {
            throw notFound;
        }
        return unit;
    }

    public void verifyMaterialVisible(Long materialId, Long userId) {
        materialRepository.findByIdAndVisibleToUser(materialId, userId)
                .orElseThrow(() -> notFound(materialId));
    }

    /** Explicit regeneration is idempotent for the current generation. */
    public List<SpeakingShadowingUnitDto> regenerateUnits(Long materialId) {
        return getOrGenerateUnits(materialId, null);
    }

    public boolean isActiveUnit(SpeakingShadowingUnit unit) {
        return unit != null
                && Integer.valueOf(LATEST_GENERATION_VERSION).equals(unit.getGenerationVersion());
    }

    private List<SpeakingShadowingUnit> findActiveUnits(Long materialId) {
        return unitRepository.findByMaterialIdAndGenerationVersionOrderBySequenceNumberAsc(
                materialId,
                LATEST_GENERATION_VERSION
        );
    }

    private List<SpeakingShadowingUnitDto> attachProgress(
            List<SpeakingShadowingUnit> units,
            Long materialId,
            Long userId
    ) {
        Map<Long, ShadowingSegmentProgressDto> progressMap = new HashMap<>();
        if (userId != null && !units.isEmpty()) {
            for (ShadowingSegmentProgressDto progress : attemptRepository.getUnitProgressByMaterial(
                    userId,
                    materialId,
                    LATEST_GENERATION_VERSION
            )) {
                if (progress.unitId() != null) {
                    progressMap.put(progress.unitId(), progress);
                }
            }
        }
        return units.stream().map(unit -> toDto(unit, progressMap.get(unit.getId()))).toList();
    }

    private List<SpeakingShadowingUnit> persistReconstructedUnits(
            ListeningMaterial material,
            CanonicalTranscriptReconstructor.ReconstructionResult reconstruction,
            List<String> translations,
            int segmentCount
    ) {
        List<SpeakingShadowingUnit> historicalUnits = unitRepository
                .findByMaterialIdOrderBySequenceNumberAsc(material.getId());
        List<SpeakingShadowingUnit> priorGeneration = latestPriorGeneration(historicalUnits);

        List<SpeakingShadowingUnit> generatedUnits = new ArrayList<>(reconstruction.units().size());
        int sequence = 1;
        for (int i = 0; i < reconstruction.units().size(); i++) {
            CanonicalTranscriptReconstructor.ReconstructedUnit reconstructed = reconstruction.units().get(i);
            String translation = i < translations.size() ? translations.get(i) : null;

            generatedUnits.add(SpeakingShadowingUnit.builder()
                    .material(material)
                    .sequenceNumber(sequence++)
                    .startTimeMs(reconstructed.startTimeMs())
                    .endTimeMs(reconstructed.endTimeMs())
                    .displayText(reconstructed.displayText())
                    .generationVersion(LATEST_GENERATION_VERSION)
                    .timingQuality(reconstructed.timingQuality())
                    .timingStrategy(reconstructed.timingStrategy())
                    .translation(translation)
                    .build());
        }

        List<SpeakingShadowingUnit> saved = unitRepository.saveAllAndFlush(generatedUnits);
        int remappedAttempts = remapExactAttempts(priorGeneration, saved);
        logTimingDiagnostics(material.getId(), reconstruction.units());
        log.info(
                "Shadowing generation={} material={} segments={} inputTokens={} overlapTokensRemoved={} " +
                        "canonicalTokens={} units={} wordTimingQuality={} remappedAttempts={}",
                LATEST_GENERATION_VERSION,
                material.getId(),
                segmentCount,
                reconstruction.inputTokenCount(),
                reconstruction.removedOverlapTokenCount(),
                reconstruction.canonicalTokenCount(),
                saved.size(),
                reconstruction.timingQualityCounts(),
                remappedAttempts
        );
        return saved;
    }

    public UnitIpaDto getOrGenerateUnitIpa(Long unitId, Long userId) {
        // Phase 1 (short read TX): verify visibility & return cached IPA if present
        UnitTextPrepared prepared = inReadTx(() -> {
            SpeakingShadowingUnit unit = visibleUnit(unitId, userId);
            if (unit.getIpa() != null && !unit.getIpa().isBlank()) {
                return new UnitTextPrepared(unit.getId(), null, new UnitIpaDto(unit.getId(), unit.getIpa(), unit.getWordIpaJson()), null);
            }
            String text = unit.getDisplayText();
            if (text == null || text.isBlank()) {
                return new UnitTextPrepared(unit.getId(), null, new UnitIpaDto(unit.getId(), null, null), null);
            }
            return new UnitTextPrepared(unit.getId(), text, null, null);
        });
        if (prepared.existingIpa() != null) {
            return prepared.existingIpa();
        }

        // External IPA HTTP call completely OUTSIDE any DB transaction
        String sentenceIpa = null;
        String wordIpaJson = null;
        try {
            RestTemplate rt = createIpaRestTemplate();
            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.APPLICATION_JSON);
            Map<String, String> reqBody = Map.of("text", prepared.text());
            HttpEntity<Map<String, String>> requestEntity = new HttpEntity<>(reqBody, headers);

            String url = aiBaseUrl + "/api/v1/speaking/ipa/process";
            ResponseEntity<String> response = rt.postForEntity(url, requestEntity, String.class);
            if (response.getStatusCode().is2xxSuccessful() && response.getBody() != null) {
                JsonNode root = objectMapper.readTree(response.getBody());
                sentenceIpa = root.path("sentenceIpa").asText(null);
                JsonNode wordsNode = root.path("words");
                wordIpaJson = wordsNode.isArray() ? objectMapper.writeValueAsString(wordsNode) : null;
            }
        } catch (Exception e) {
            log.warn("Failed to generate IPA for unit {}: {}", unitId, e.getMessage());
            return new UnitIpaDto(prepared.unitId(), null, null);
        }

        if (sentenceIpa == null || sentenceIpa.isBlank()) {
            return new UnitIpaDto(prepared.unitId(), null, null);
        }

        // Phase 2 (short commit TX): re-verify visibility and persist generated IPA
        final String finalIpa = sentenceIpa;
        final String finalWordIpaJson = wordIpaJson;
        return inTx(() -> {
            SpeakingShadowingUnit unit = visibleUnit(unitId, userId);
            if (unit.getIpa() == null || unit.getIpa().isBlank()) {
                unit.setIpa(finalIpa);
                unit.setWordIpaJson(finalWordIpaJson);
                unitRepository.save(unit);
                log.info("Persisted lazy-generated IPA for unit {}: {}", unitId, finalIpa);
            }
            return new UnitIpaDto(unit.getId(), unit.getIpa(), unit.getWordIpaJson());
        });
    }

    private final ConcurrentHashMap<Long, Object> unitLocks = new ConcurrentHashMap<>();

    public UnitTranslationDto getOrGenerateUnitTranslation(Long unitId, Long userId) {
        // Phase 1 (short read TX): verify visibility & return cached translation if present
        UnitTextPrepared prepared = inReadTx(() -> {
            SpeakingShadowingUnit unit = visibleUnit(unitId, userId);
            if (unit.getTranslation() != null && !unit.getTranslation().isBlank()) {
                return new UnitTextPrepared(unit.getId(), null, null, new UnitTranslationDto(unit.getId(), unit.getTranslation()));
            }
            String text = unit.getDisplayText();
            if (text == null || text.isBlank()) {
                return new UnitTextPrepared(unit.getId(), null, null, new UnitTranslationDto(unit.getId(), null));
            }
            return new UnitTextPrepared(unit.getId(), text, null, null);
        });
        if (prepared.existingTranslation() != null) {
            return prepared.existingTranslation();
        }

        Object lock = unitLocks.computeIfAbsent(unitId, k -> new Object());
        synchronized (lock) {
            try {
                // Re-check in short read TX under per-unit lock (never holds DB TX across HTTP!)
                UnitTranslationDto existingUnderLock = inReadTx(() -> {
                    SpeakingShadowingUnit current = visibleUnit(unitId, userId);
                    if (current.getTranslation() != null && !current.getTranslation().isBlank()) {
                        return new UnitTranslationDto(current.getId(), current.getTranslation());
                    }
                    return null;
                });
                if (existingUnderLock != null) {
                    return existingUnderLock;
                }

                // External Google Translate HTTP completely OUTSIDE any DB transaction
                String trans = googleGtxTranslationProvider != null
                        ? googleGtxTranslationProvider.translateSentenceToVietnamese(prepared.text())
                        : null;
                if (trans != null && !trans.isBlank()) {
                    final String finalTrans = trans;
                    return inTx(() -> {
                        SpeakingShadowingUnit currentUnit = visibleUnit(unitId, userId);
                        if (currentUnit.getTranslation() == null || currentUnit.getTranslation().isBlank()) {
                            currentUnit.setTranslation(finalTrans);
                            unitRepository.saveAndFlush(currentUnit);
                            log.info("Persisted lazy-generated translation for unit {}", unitId);
                        }
                        return new UnitTranslationDto(currentUnit.getId(), currentUnit.getTranslation());
                    });
                }
            } catch (Exception e) {
                log.warn("Failed to translate unit {}: {}", unitId, e.getMessage());
            } finally {
                unitLocks.remove(unitId, lock);
            }
        }

        return new UnitTranslationDto(prepared.unitId(), null);
    }

    private List<SpeakingShadowingUnit> latestPriorGeneration(List<SpeakingShadowingUnit> historicalUnits) {
        int priorVersion = historicalUnits.stream()
                .map(SpeakingShadowingUnit::getGenerationVersion)
                .filter(Objects::nonNull)
                .filter(version -> version < LATEST_GENERATION_VERSION)
                .max(Integer::compareTo)
                .orElse(-1);
        if (priorVersion < 0) {
            return List.of();
        }
        return historicalUnits.stream()
                .filter(unit -> Integer.valueOf(priorVersion).equals(unit.getGenerationVersion()))
                .sorted(Comparator.comparing(SpeakingShadowingUnit::getSequenceNumber))
                .toList();
    }

    private int remapExactAttempts(
            List<SpeakingShadowingUnit> priorGeneration,
            List<SpeakingShadowingUnit> newGeneration
    ) {
        Map<Integer, SpeakingShadowingUnit> oldBySequence = new HashMap<>();
        priorGeneration.forEach(unit -> oldBySequence.put(unit.getSequenceNumber(), unit));
        int remapped = 0;
        for (SpeakingShadowingUnit current : newGeneration) {
            SpeakingShadowingUnit previous = oldBySequence.get(current.getSequenceNumber());
            if (previous != null && Objects.equals(previous.getDisplayText(), current.getDisplayText())) {
                remapped += attemptRepository.remapUnitAttempts(previous, current);
            }
        }
        return remapped;
    }

    private void logTimingDiagnostics(
            Long materialId,
            List<CanonicalTranscriptReconstructor.ReconstructedUnit> units
    ) {
        List<CanonicalTranscriptReconstructor.ReconstructedUnit> anomalies = units.stream()
                .filter(CanonicalTranscriptReconstructor.ReconstructedUnit::wpmAnomaly)
                .toList();
        for (int index = 0; index < units.size(); index++) {
            CanonicalTranscriptReconstructor.ReconstructedUnit unit = units.get(index);
            if (unit.wpmAnomaly()) {
                log.warn(
                        "Shadowing timing anomaly material={} sequence={} words={} durationMs={} wpm={} quality={} strategy={}",
                        materialId,
                        index + 1,
                        unit.lexicalWordCount(),
                        unit.endTimeMs() - unit.startTimeMs(),
                        Math.round(unit.referenceWpm() * 10.0) / 10.0,
                        unit.timingQuality(),
                        unit.timingStrategy()
                );
            }
        }
        if (!anomalies.isEmpty()) {
            double maximum = anomalies.stream()
                    .mapToDouble(CanonicalTranscriptReconstructor.ReconstructedUnit::referenceWpm)
                    .max()
                    .orElse(0.0);
            List<Integer> samples = new ArrayList<>();
            for (int index = 0; index < units.size() && samples.size() < 5; index++) {
                if (units.get(index).wpmAnomaly()) {
                    samples.add(index + 1);
                }
            }
            log.warn(
                    "Shadowing timing diagnostic summary material={} anomalyCount={} maxWpm={} sampleSequences={}",
                    materialId,
                    anomalies.size(),
                    Math.round(maximum * 10.0) / 10.0,
                    samples
            );
        }
    }

    private SpeakingShadowingUnitDto toDto(
            SpeakingShadowingUnit unit,
            ShadowingSegmentProgressDto progress
    ) {
        long attempts = progress != null && progress.attemptCount() != null ? progress.attemptCount() : 0L;
        Double bestAccuracy = progress != null ? progress.bestAccuracy() : null;
        return new SpeakingShadowingUnitDto(
                unit.getId(),
                unit.getMaterial().getId(),
                unit.getSequenceNumber(),
                unit.getStartTimeMs(),
                unit.getEndTimeMs(),
                unit.getDisplayText(),
                unit.getGenerationVersion(),
                unit.getTimingQuality(),
                unit.getTimingStrategy(),
                attempts,
                bestAccuracy,
                attempts > 0,
                unit.getIpa(),
                unit.getWordIpaJson(),
                unit.getTranslation()
        );
    }

    private ResponseStatusException notFound(Long materialId) {
        return new ResponseStatusException(HttpStatus.NOT_FOUND, "Listening material not found: " + materialId);
    }
}
