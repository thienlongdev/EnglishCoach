package com.englishcoach.proficiency;

import com.englishcoach.common.event.DictationAttemptSubmittedEvent;
import com.englishcoach.common.event.ExamScoredEvent;
import com.englishcoach.common.event.RoleplayTurnRecordedEvent;
import com.englishcoach.proficiency.model.EvidenceRow;
import com.englishcoach.proficiency.model.ProficiencySkill;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.EnumSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

/**
 * Non-transactional orchestration: map → store (own tx) → recompute affected users (own tx).
 * Shared by the live listener, the nightly T1 reconciliation and the one-off backfill.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ProficiencyIngestService {

    private final ProficiencyProperties props;
    private final EvidenceMapper mapper;
    private final ProficiencyService service;
    private final ProficiencySourceReadRepository sources;

    public List<EvidenceRow> ingestDictation(DictationAttemptSubmittedEvent e) {
        return ingest(mapper.fromDictation(e).map(List::of).orElse(List.of()));
    }

    public List<EvidenceRow> ingestRoleplay(RoleplayTurnRecordedEvent e) {
        return ingest(mapper.fromRoleplay(e).map(List::of).orElse(List.of()));
    }

    /** Uses persisted artifact data; REVIEW_REQUIRED and rescore duplicates produce nothing. */
    public List<EvidenceRow> ingestExam(ExamScoredEvent e) {
        if (e.artifactId() == null || !"COMPLETED".equals(e.resultStatus())) {
            return List.of();
        }
        return ingest(mapper.fromExamArtifact(e.artifactId()));
    }

    /**
     * T1 reconciliation (§9): COMPLETED artifacts since {@code since} (null = all time, used by the
     * backfill), oldest first so the first COMPLETED result per (formId, skill) wins. Idempotent.
     * Returns the number of evidence rows newly inserted.
     */
    public int reconcileT1(Instant since) {
        int inserted = 0;
        for (ProficiencySourceReadRepository.ExamArtifact a : sources.completedArtifactsSince(since)) {
            try {
                inserted += ingest(mapper.fromExamArtifact(a.artifactId())).size();
            } catch (Exception ex) {
                log.warn("[Proficiency] reconciliation failed for artifact {}: {}", a.artifactId(), ex.getMessage());
            }
        }
        return inserted;
    }

    private List<EvidenceRow> ingest(List<EvidenceRow> rows) {
        if (!props.isEnabled() || rows.isEmpty()) {
            return List.of();
        }
        List<EvidenceRow> inserted = service.storeEvidence(rows);
        Map<Long, Set<ProficiencySkill>> byUser = new TreeMap<>();
        for (EvidenceRow r : inserted) {
            byUser.computeIfAbsent(r.userId(), k -> EnumSet.noneOf(ProficiencySkill.class)).add(r.skill());
        }
        Instant now = Instant.now();
        byUser.forEach((userId, skills) -> service.recompute(userId, skills, now));
        return inserted;
    }
}
