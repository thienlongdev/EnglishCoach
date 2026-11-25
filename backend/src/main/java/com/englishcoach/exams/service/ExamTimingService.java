package com.englishcoach.exams.service;

import com.englishcoach.exams.model.ExamAttemptRecords.*;
import com.englishcoach.exams.model.ExamContentRecords.SectionRecord;
import com.englishcoach.exams.model.ExamTypes.*;
import com.englishcoach.exams.repository.ExamAttemptRepository;
import com.englishcoach.exams.repository.ExamContentRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.*;

@Slf4j
@Service
@RequiredArgsConstructor
public class ExamTimingService {

    private final ExamAttemptRepository attemptRepository;
    private final ExamContentRepository contentRepository;

    public int getEffectiveSectionDuration(SectionRecord sec) {
        if (sec.skill() == SkillType.LISTENING) {
            Integer totalAudioMs = contentRepository.findTotalAudioDurationMsBySectionId(sec.id());
            if (totalAudioMs != null && totalAudioMs > 0) {
                int audioSec = (int) Math.ceil(totalAudioMs / 1000.0);
                int requiredSec = audioSec + 120; // Official 120s final review
                return Math.max(sec.durationSeconds(), requiredSec);
            }
        }
        return sec.durationSeconds();
    }

    @Transactional
    public void initializeSchedule(AttemptRecord attempt) {
        Instant now = Instant.now();
        List<SectionRecord> allSections = contentRepository.findSectionsByFormId(attempt.formId());
        List<SectionRecord> sections = attempt.attemptMode() == ExamAttemptMode.EXAM_SIMULATION
                ? allSections
                : allSections.stream().filter(SectionRecord::isRunnable).toList();

        Object rawSelected = attempt.clientSessionMeta() != null ? attempt.clientSessionMeta().get("selectedSkills") : null;
        if (rawSelected instanceof List<?> list && !list.isEmpty()) {
            Set<String> selectedSkillNames = new HashSet<>();
            for (Object item : list) {
                if (item != null) {
                    selectedSkillNames.add(item.toString().trim().toUpperCase());
                }
            }
            if (!selectedSkillNames.isEmpty()) {
                sections = sections.stream()
                        .filter(sec -> selectedSkillNames.contains(sec.skill().name().toUpperCase()))
                        .toList();
            }
        }

        Instant cursor = now;
        boolean first = true;
        // Exams Phase 6: a practice scope (one part / passage / section / task) is UNTIMED — no official section time is
        // invented for a part, so no deadline, no auto-advance and no TIME_LIMIT submission.
        boolean untimed = attempt.attemptMode() == ExamAttemptMode.PRACTICE
                && com.englishcoach.exams.practice.ExamPracticeScope.isScoped(attempt.manifestSnapshot());

        for (SectionRecord sec : sections) {
            Instant sectionStart = cursor;
            int effectiveDuration = getEffectiveSectionDuration(sec);
            Instant sectionDeadline = untimed ? null : cursor.plus(effectiveDuration, ChronoUnit.SECONDS);

            AttemptSectionRecord asr = new AttemptSectionRecord(
                    null,
                    attempt.id(),
                    sec.id(),
                    first ? ExamSectionState.ACTIVE : ExamSectionState.PENDING,
                    "MAIN",
                    first ? sectionStart : null,
                    first ? sectionDeadline : null,
                    null,
                    sec.timingPolicy(),
                    now
            );
            attemptRepository.insertAttemptSection(asr);

            cursor = untimed ? cursor : sectionDeadline;
            first = false;
        }

        Instant scheduledEnd = untimed ? null : cursor;
        attemptRepository.updateAttemptSchedule(attempt.id(), now, scheduledEnd, ExamAttemptStatus.IN_PROGRESS, attempt.revision());
        log.info("Initialized schedule for attempt {}: start={}, end={}", attempt.id(), now, scheduledEnd);
    }

    @Transactional
    public SyncTimingResponseDto syncTiming(AttemptRecord attempt, long sessionEpoch) {
        // Exams Phase 9C: serialize with autosave / submit (same attempt row lock) so a section is never sealed while an
        // answer write for it is in flight.
        attempt = attemptRepository.findAttemptByIdForUpdate(attempt.id()).orElse(attempt);
        Instant serverTime = Instant.now();
        List<AttemptSectionRecord> sections = attemptRepository.findSectionsByAttemptId(attempt.id());

        AttemptSectionRecord activeSection = null;
        Map<UUID, Instant> sectionDeadlines = new HashMap<>();

        for (AttemptSectionRecord sec : sections) {
            if (sec.deadlineAt() != null) {
                sectionDeadlines.put(sec.sectionId(), sec.deadlineAt());
            }
            if (sec.state() == ExamSectionState.ACTIVE) {
                activeSection = sec;
            }
        }

        Long remainingSeconds = null;
        UUID activeSectionId = null;

        if (activeSection != null) {
            activeSectionId = activeSection.sectionId();
            if (activeSection.deadlineAt() != null) {
                long rem = Duration.between(serverTime, activeSection.deadlineAt()).getSeconds();
                remainingSeconds = Math.max(0, rem);

                // Auto-advance or check deadline. Exams Phase 9C: a simulation section closes only after the server
                // write grace (in-flight answers of the last seconds are still accepted by autosave); other modes unchanged.
                boolean closed = ExamDeadlinePolicy.enforced(attempt)
                        ? ExamDeadlinePolicy.sectionClosed(attempt, activeSection, serverTime)
                        : rem <= 0;
                if (closed) {
                    log.info("Section {} deadline reached for attempt {}", activeSection.sectionId(), attempt.id());
                    advanceSectionDeadline(attempt.id(), activeSection.sectionId(), sections);
                }
            }
        }

        return new SyncTimingResponseDto(
                serverTime,
                sessionEpoch,
                activeSectionId,
                remainingSeconds,
                sectionDeadlines,
                attempt.status()
        );
    }

    private void advanceSectionDeadline(UUID attemptId, UUID activeSectionId, List<AttemptSectionRecord> sections) {
        Instant now = Instant.now();
        // Seal current section
        attemptRepository.updateAttemptSection(attemptId, activeSectionId, ExamSectionState.COMPLETED, null, null, now);

        // Find next pending section
        boolean foundCurrent = false;
        AttemptSectionRecord nextSection = null;
        for (AttemptSectionRecord s : sections) {
            if (foundCurrent && s.state() == ExamSectionState.PENDING) {
                nextSection = s;
                break;
            }
            if (s.sectionId().equals(activeSectionId)) {
                foundCurrent = true;
            }
        }

        Optional<AttemptRecord> attemptOpt = attemptRepository.findAttemptById(attemptId);
        if (attemptOpt.isEmpty()) return;
        AttemptRecord attempt = attemptOpt.get();

        if (nextSection != null) {
            final UUID nextSecId = nextSection.sectionId();
            Optional<SectionRecord> secOpt = contentRepository.findSectionsByFormId(attempt.formId()).stream()
                    .filter(sec -> sec.id().equals(nextSecId))
                    .findFirst();
            int durationSec = secOpt.map(this::getEffectiveSectionDuration).orElse(1800);
            // Exams Phase 9C: never past the simulation's hard end (time lost while away is not given back)
            Instant nextDeadline = ExamDeadlinePolicy.capNextDeadline(attempt, now.plus(durationSec, ChronoUnit.SECONDS));
            attemptRepository.updateAttemptSection(attemptId, nextSecId, ExamSectionState.ACTIVE, now, nextDeadline, null);
            log.info("Auto-advanced to next section {} with deadline {}", nextSecId, nextDeadline);
        } else {
            log.info("All sections completed for attempt {}", attemptId);
        }
    }
}
