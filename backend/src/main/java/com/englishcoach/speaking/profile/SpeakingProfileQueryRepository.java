package com.englishcoach.speaking.profile;

import com.englishcoach.speaking.entity.SpeakingSession;
import com.englishcoach.speaking.entity.SpeakingTurn;
import jakarta.persistence.EntityManager;
import jakarta.persistence.PersistenceContext;
import jakarta.persistence.TypedQuery;
import org.springframework.stereotype.Repository;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.*;

/**
 * Principal-scoped read-only projections and batch aggregations for Speaking Profile endpoints.
 *
 * <p>All queries enforce {@code user.id = :userId} and {@code AGENTS.md §21} material visibility
 * ({@code (m.isSystem = true AND m.ownerUserId IS NULL) OR m.ownerUserId = :userId}), avoiding
 * {@code findAll()}, N+1 loops, and unnecessary {@code TEXT} JSON column reads on list/entry routes.
 */
@Repository
public class SpeakingProfileQueryRepository {

    @PersistenceContext
    private EntityManager em;

    public record ActiveShadowingHeader(
            Long sessionId,
            String status,
            String mode,
            String sourceType,
            Long sourceId,
            int currentUnitIndex,
            int completedUnitsCount,
            int totalUnitsCount,
            LocalDateTime createdAt,
            LocalDateTime updatedAt
    ) {
    }

    public record VisibleMaterialMeta(
            Long id,
            String title,
            String thumbnail,
            String youtubeVideoId,
            String cefrLevel
    ) {
    }

    public record SessionStatusModeRow(
            String status,
            String mode,
            long count
    ) {
    }

    public record ShadowingIssueMarkerRow(
            Long sessionId,
            String primaryIssueType,
            String targetWord
    ) {
    }

    public record FeedbackCorrectionMarkerRow(
            Long sessionId,
            String correctionsJson
    ) {
    }

    public record LifetimeAggregateStats(
            long shadowingAttemptsCount,
            long shadowingAttemptDurationSeconds,
            long completedShadowingSessionDurationSeconds,
            long roleplayLearnerTurnsCount,
            long roleplayLearnerDurationSeconds,
            long quickCheckAttemptsCount,
            long distinctTargetVocabCount,
            Double averageContentMatchScore
    ) {
    }

    public record ShadowingSessionBatchStats(
            Long sessionId,
            int attemptCount,
            int retryCount,
            int resolvedCount,
            Double avgPronunciationScore,
            Double avgAccuracyScore,
            int durationSeconds
    ) {
    }

    public record RoleplaySessionBatchStats(
            Long sessionId,
            int learnerTurnCount,
            Double avgPronunciationScore,
            int durationSeconds
    ) {
    }

    public record QuickCheckSessionBatchSummary(
            Long sessionId,
            String intendedTranscript,
            String whisperTranscript,
            Double overallScore,
            Double fluencyScore
    ) {
    }

    public Optional<ActiveShadowingHeader> findActiveShadowingHeader(Long userId) {
        List<Object[]> rows = em.createQuery(
                        "SELECT s.id, s.status, s.mode, s.sourceType, s.sourceId, " +
                        "COALESCE(s.currentUnitIndex, 0), COALESCE(s.completedUnitsCount, 0), COALESCE(s.totalUnitsCount, 0), " +
                        "s.createdAt, s.updatedAt " +
                        "FROM SpeakingSession s " +
                        "WHERE s.user.id = :userId AND s.mode = 'SHADOWING' AND s.status = 'ACTIVE' " +
                        "ORDER BY s.createdAt DESC, s.id DESC",
                        Object[].class)
                .setParameter("userId", userId)
                .setMaxResults(1)
                .getResultList();

        if (rows.isEmpty()) {
            return Optional.empty();
        }
        Object[] r = rows.getFirst();
        return Optional.of(new ActiveShadowingHeader(
                (Long) r[0],
                (String) r[1],
                (String) r[2],
                (String) r[3],
                (Long) r[4],
                ((Number) r[5]).intValue(),
                ((Number) r[6]).intValue(),
                ((Number) r[7]).intValue(),
                (LocalDateTime) r[8],
                (LocalDateTime) r[9]
        ));
    }

    public Map<Long, VisibleMaterialMeta> findVisibleMaterialsByIds(Long userId, Collection<Long> materialIds) {
        if (materialIds == null || materialIds.isEmpty()) {
            return Map.of();
        }
        List<Object[]> rows = em.createQuery(
                        "SELECT m.id, m.title, m.thumbnail, m.youtubeVideoId, m.cefrLevel " +
                        "FROM ListeningMaterial m " +
                        "WHERE m.id IN :ids AND ((m.isSystem = true AND m.ownerUserId IS NULL) OR m.ownerUserId = :userId)",
                        Object[].class)
                .setParameter("ids", materialIds)
                .setParameter("userId", userId)
                .getResultList();

        Map<Long, VisibleMaterialMeta> map = new HashMap<>(rows.size());
        for (Object[] r : rows) {
            Long id = (Long) r[0];
            map.put(id, new VisibleMaterialMeta(
                    id,
                    (String) r[1],
                    (String) r[2],
                    (String) r[3],
                    (String) r[4]
            ));
        }
        return map;
    }

    public Set<LocalDate> findDistinctActiveDates(Long userId) {
        Set<LocalDate> dates = new HashSet<>();

        List<LocalDateTime> sessionTimes = em.createQuery(
                        "SELECT s.createdAt FROM SpeakingSession s " +
                        "WHERE s.user.id = :userId AND s.status <> 'ABANDONED'",
                        LocalDateTime.class)
                .setParameter("userId", userId)
                .getResultList();
        for (LocalDateTime dt : sessionTimes) {
            if (dt != null) dates.add(dt.toLocalDate());
        }

        List<LocalDateTime> attemptTimes = em.createQuery(
                        "SELECT a.createdAt FROM SpeakingShadowingAttempt a " +
                        "WHERE a.user.id = :userId AND (a.isMocked IS NULL OR a.isMocked = false)",
                        LocalDateTime.class)
                .setParameter("userId", userId)
                .getResultList();
        for (LocalDateTime dt : attemptTimes) {
            if (dt != null) dates.add(dt.toLocalDate());
        }

        List<LocalDateTime> turnTimes = em.createQuery(
                        "SELECT t.createdAt FROM SpeakingTurn t " +
                        "WHERE t.session.user.id = :userId AND t.speaker = 'LEARNER' AND (t.isMocked IS NULL OR t.isMocked = false)",
                        LocalDateTime.class)
                .setParameter("userId", userId)
                .getResultList();
        for (LocalDateTime dt : turnTimes) {
            if (dt != null) dates.add(dt.toLocalDate());
        }

        List<LocalDateTime> qcTimes = em.createQuery(
                        "SELECT q.createdAt FROM SpeakingQuickCheck q " +
                        "WHERE q.user.id = :userId AND (q.isMocked IS NULL OR q.isMocked = false)",
                        LocalDateTime.class)
                .setParameter("userId", userId)
                .getResultList();
        for (LocalDateTime dt : qcTimes) {
            if (dt != null) dates.add(dt.toLocalDate());
        }

        return dates;
    }

    public List<ShadowingIssueMarkerRow> findShadowingIssueMarkersSince(Long userId, LocalDateTime since) {
        List<Object[]> rows = em.createQuery(
                        "SELECT a.session.id, a.primaryIssueType, a.targetWord " +
                        "FROM SpeakingShadowingAttempt a " +
                        "WHERE a.user.id = :userId AND a.createdAt >= :since " +
                        "AND (a.isMocked IS NULL OR a.isMocked = false) " +
                        "AND a.primaryIssueType IS NOT NULL",
                        Object[].class)
                .setParameter("userId", userId)
                .setParameter("since", since)
                .getResultList();

        List<ShadowingIssueMarkerRow> out = new ArrayList<>(rows.size());
        for (Object[] r : rows) {
            out.add(new ShadowingIssueMarkerRow((Long) r[0], (String) r[1], (String) r[2]));
        }
        return out;
    }

    public List<FeedbackCorrectionMarkerRow> findFeedbackCorrectionMarkersSince(Long userId, LocalDateTime since) {
        List<Object[]> rows = em.createQuery(
                        "SELECT s.id, f.correctionsJson " +
                        "FROM SpeakingTurnFeedback f JOIN f.turn t JOIN t.session s " +
                        "WHERE s.user.id = :userId AND f.createdAt >= :since " +
                        "AND (f.isMocked IS NULL OR f.isMocked = false) " +
                        "AND f.correctionsJson IS NOT NULL",
                        Object[].class)
                .setParameter("userId", userId)
                .setParameter("since", since)
                .getResultList();

        List<FeedbackCorrectionMarkerRow> out = new ArrayList<>(rows.size());
        for (Object[] r : rows) {
            out.add(new FeedbackCorrectionMarkerRow((Long) r[0], (String) r[1]));
        }
        return out;
    }

    public List<SessionStatusModeRow> getSessionStatusAndModeCounts(Long userId) {
        List<Object[]> rows = em.createQuery(
                        "SELECT UPPER(s.status), UPPER(s.mode), COUNT(s.id) " +
                        "FROM SpeakingSession s " +
                        "WHERE s.user.id = :userId " +
                        "GROUP BY UPPER(s.status), UPPER(s.mode)",
                        Object[].class)
                .setParameter("userId", userId)
                .getResultList();

        List<SessionStatusModeRow> out = new ArrayList<>(rows.size());
        for (Object[] r : rows) {
            out.add(new SessionStatusModeRow(
                    r[0] != null ? String.valueOf(r[0]) : "UNKNOWN",
                    r[1] != null ? String.valueOf(r[1]) : "SHADOWING",
                    ((Number) r[2]).longValue()
            ));
        }
        return out;
    }

    public LifetimeAggregateStats getLifetimeAggregateStats(Long userId) {
        Object[] attRow = em.createQuery(
                        "SELECT COUNT(a.id), COALESCE(SUM(a.durationSeconds), 0), AVG(a.accuracyScore), COUNT(a.accuracyScore) " +
                        "FROM SpeakingShadowingAttempt a " +
                        "WHERE a.user.id = :userId AND (a.isMocked IS NULL OR a.isMocked = false)",
                        Object[].class)
                .setParameter("userId", userId)
                .getSingleResult();

        long shadowingAttempts = attRow[0] != null ? ((Number) attRow[0]).longValue() : 0L;
        long shadowingAttemptSec = attRow[1] != null ? ((Number) attRow[1]).longValue() : 0L;
        Double shadowingAvgAcc = attRow[2] != null ? ((Number) attRow[2]).doubleValue() : null;
        long shadowingAccCount = attRow[3] != null ? ((Number) attRow[3]).longValue() : 0L;

        Long completedShadowingSessionSec = em.createQuery(
                        "SELECT COALESCE(SUM(s.durationSeconds), 0) FROM SpeakingSession s " +
                        "WHERE s.user.id = :userId AND s.mode = 'SHADOWING' AND s.status = 'COMPLETED'",
                        Long.class)
                .setParameter("userId", userId)
                .getSingleResult();

        Object[] turnRow = em.createQuery(
                        "SELECT COUNT(t.id), COALESCE(SUM(t.durationSeconds), 0) " +
                        "FROM SpeakingTurn t " +
                        "WHERE t.session.user.id = :userId AND t.speaker = 'LEARNER' AND (t.isMocked IS NULL OR t.isMocked = false)",
                        Object[].class)
                .setParameter("userId", userId)
                .getSingleResult();

        long roleplayTurns = turnRow[0] != null ? ((Number) turnRow[0]).longValue() : 0L;
        long roleplaySec = turnRow[1] != null ? ((Number) turnRow[1]).longValue() : 0L;

        Long distinctVocab = em.createQuery(
                        "SELECT COUNT(DISTINCT v) FROM SpeakingTurn t JOIN t.detectedVocabulary v " +
                        "WHERE t.session.user.id = :userId AND t.speaker = 'LEARNER' AND (t.isMocked IS NULL OR t.isMocked = false)",
                        Long.class)
                .setParameter("userId", userId)
                .getSingleResult();

        Long qcCount = em.createQuery(
                        "SELECT COUNT(q.id) FROM SpeakingQuickCheck q " +
                        "WHERE q.user.id = :userId AND (q.isMocked IS NULL OR q.isMocked = false)",
                        Long.class)
                .setParameter("userId", userId)
                .getSingleResult();

        Double resolvedAvgAccuracy = null;
        if (shadowingAccCount > 0 && shadowingAvgAcc != null) {
            resolvedAvgAccuracy = Math.round(shadowingAvgAcc * 10.0) / 10.0;
        } else {
            Double legacyAvg = em.createQuery(
                            "SELECT AVG(r.accuracyScore) FROM SpeakingResult r " +
                            "WHERE r.user.id = :userId AND r.accuracyScore IS NOT NULL",
                            Double.class)
                    .setParameter("userId", userId)
                    .getSingleResult();
            if (legacyAvg != null) {
                resolvedAvgAccuracy = Math.round(legacyAvg * 10.0) / 10.0;
            }
        }

        return new LifetimeAggregateStats(
                shadowingAttempts,
                shadowingAttemptSec,
                completedShadowingSessionSec != null ? completedShadowingSessionSec : 0L,
                roleplayTurns,
                roleplaySec,
                qcCount != null ? qcCount : 0L,
                distinctVocab != null ? distinctVocab : 0L,
                resolvedAvgAccuracy
        );
    }

    public List<SpeakingSession> findSessionsSince(Long userId, LocalDateTime since) {
        return em.createQuery(
                        "SELECT s FROM SpeakingSession s LEFT JOIN FETCH s.scenario " +
                        "WHERE s.user.id = :userId AND s.createdAt >= :since " +
                        "ORDER BY s.createdAt DESC, s.id DESC",
                        SpeakingSession.class)
                .setParameter("userId", userId)
                .setParameter("since", since)
                .getResultList();
    }

    public List<SpeakingTurn> findLearnerTurnsSince(Long userId, LocalDateTime since) {
        return em.createQuery(
                        "SELECT t FROM SpeakingTurn t JOIN FETCH t.session s LEFT JOIN FETCH s.scenario " +
                        "WHERE s.user.id = :userId AND t.speaker = 'LEARNER' " +
                        "AND (t.isMocked IS NULL OR t.isMocked = false) " +
                        "AND t.createdAt >= :since " +
                        "ORDER BY t.createdAt ASC, t.id ASC",
                        SpeakingTurn.class)
                .setParameter("userId", userId)
                .setParameter("since", since)
                .getResultList();
    }

    public List<SpeakingSession> findPaginatedSessions(
            Long userId,
            String modeFilter,
            String statusFilter,
            int page,
            int size
    ) {
        StringBuilder jpql = new StringBuilder(
                "SELECT s FROM SpeakingSession s LEFT JOIN FETCH s.scenario WHERE s.user.id = :userId");
        boolean filterMode = modeFilter != null && !"ALL".equalsIgnoreCase(modeFilter);
        boolean filterStatus = statusFilter != null && !"ALL".equalsIgnoreCase(statusFilter);
        if (filterMode) {
            jpql.append(" AND UPPER(s.mode) = :mode");
        }
        if (filterStatus) {
            jpql.append(" AND UPPER(s.status) = :status");
        }
        jpql.append(" ORDER BY s.createdAt DESC, s.id DESC");

        TypedQuery<SpeakingSession> query = em.createQuery(jpql.toString(), SpeakingSession.class)
                .setParameter("userId", userId)
                .setFirstResult(Math.max(0, page) * size)
                .setMaxResults(size);

        if (filterMode) {
            query.setParameter("mode", modeFilter.toUpperCase(Locale.ROOT));
        }
        if (filterStatus) {
            query.setParameter("status", statusFilter.toUpperCase(Locale.ROOT));
        }
        return query.getResultList();
    }

    public Map<Long, ShadowingSessionBatchStats> aggregateShadowingStatsBySessionIds(Collection<Long> sessionIds) {
        if (sessionIds == null || sessionIds.isEmpty()) {
            return Map.of();
        }
        List<Object[]> rows = em.createQuery(
                        "SELECT a.session.id, COUNT(a.id), " +
                        "COALESCE(SUM(CASE WHEN a.retryIndex IS NOT NULL AND a.retryIndex > 0 THEN 1 ELSE 0 END), 0), " +
                        "COALESCE(SUM(CASE WHEN a.resolvedThisSession = true THEN 1 ELSE 0 END), 0), " +
                        "AVG(a.pronunciationScore), AVG(a.accuracyScore), COALESCE(SUM(a.durationSeconds), 0) " +
                        "FROM SpeakingShadowingAttempt a " +
                        "WHERE a.session.id IN :sessionIds AND (a.isMocked IS NULL OR a.isMocked = false) " +
                        "GROUP BY a.session.id",
                        Object[].class)
                .setParameter("sessionIds", sessionIds)
                .getResultList();

        Map<Long, ShadowingSessionBatchStats> map = new HashMap<>(rows.size());
        for (Object[] r : rows) {
            Long sid = (Long) r[0];
            map.put(sid, new ShadowingSessionBatchStats(
                    sid,
                    ((Number) r[1]).intValue(),
                    ((Number) r[2]).intValue(),
                    ((Number) r[3]).intValue(),
                    r[4] != null ? round1(((Number) r[4]).doubleValue()) : null,
                    r[5] != null ? round1(((Number) r[5]).doubleValue()) : null,
                    ((Number) r[6]).intValue()
            ));
        }
        return map;
    }

    public Map<Long, RoleplaySessionBatchStats> aggregateRoleplayStatsBySessionIds(Collection<Long> sessionIds) {
        if (sessionIds == null || sessionIds.isEmpty()) {
            return Map.of();
        }
        List<Object[]> rows = em.createQuery(
                        "SELECT t.session.id, COUNT(t.id), AVG(t.pronunciationScore), COALESCE(SUM(t.durationSeconds), 0) " +
                        "FROM SpeakingTurn t " +
                        "WHERE t.session.id IN :sessionIds AND t.speaker = 'LEARNER' AND (t.isMocked IS NULL OR t.isMocked = false) " +
                        "GROUP BY t.session.id",
                        Object[].class)
                .setParameter("sessionIds", sessionIds)
                .getResultList();

        Map<Long, RoleplaySessionBatchStats> map = new HashMap<>(rows.size());
        for (Object[] r : rows) {
            Long sid = (Long) r[0];
            map.put(sid, new RoleplaySessionBatchStats(
                    sid,
                    ((Number) r[1]).intValue(),
                    r[2] != null ? round1(((Number) r[2]).doubleValue()) : null,
                    ((Number) r[3]).intValue()
            ));
        }
        return map;
    }

    public Map<Long, QuickCheckSessionBatchSummary> findQuickCheckSummariesBySessionIds(Collection<Long> sessionIds) {
        if (sessionIds == null || sessionIds.isEmpty()) {
            return Map.of();
        }
        List<Object[]> rows = em.createQuery(
                        "SELECT q.session.id, q.intendedTranscript, q.whisperTranscript, q.overallScore, q.fluencyScore " +
                        "FROM SpeakingQuickCheck q " +
                        "WHERE q.session.id IN :sessionIds AND (q.isMocked IS NULL OR q.isMocked = false)",
                        Object[].class)
                .setParameter("sessionIds", sessionIds)
                .getResultList();

        Map<Long, QuickCheckSessionBatchSummary> map = new HashMap<>(rows.size());
        for (Object[] r : rows) {
            Long sid = (Long) r[0];
            if (sid != null) {
                map.put(sid, new QuickCheckSessionBatchSummary(
                        sid,
                        (String) r[1],
                        (String) r[2],
                        r[3] != null ? round1(((Number) r[3]).doubleValue()) : null,
                        r[4] != null ? round1(((Number) r[4]).doubleValue()) : null
                ));
            }
        }
        return map;
    }

    private static double round1(double v) {
        return Math.round(v * 10.0) / 10.0;
    }
}
